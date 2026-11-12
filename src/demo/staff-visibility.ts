/**
 * 同事角色同留言可見範圍煙霧測試。
 * 用臨時 SQLite，唔會郁到正式 data/inbox.db。
 *
 * 覆蓋：seed 姓名／角色、Ken 同 Vivian 一樣係管理員而且唔自動派單、
 * 正式庫形狀嘅 staff.id 5–13 會刪、受保護同事喺呢個範圍就唔刪、
 * 自動派單只計 active=1、
 * 在職同事唔可以經 API 或網頁睇／回覆／改狀態其他人或未派留言、
 * 管理員可以、改派只限管理員、新留言輪詢唔會漏出其他人內容。
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type Database from "better-sqlite3";

const failures: string[] = [];
const DEMO_PASSWORD = "Glorious2026!";

function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) {
    const line = detail ? `${name} — ${detail}` : name;
    failures.push(line);
    console.error(`FAIL ${line}`);
    return;
  }
  console.log(`OK   ${name}`);
}

function cookieHeader(res: Response): string {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return raw
    .map((item) => item.split(";")[0])
    .filter((item) => item.startsWith("connect.sid="))
    .join("; ");
}

async function login(base: string, username: string): Promise<{ status: number; cookie: string; location: string }> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password: DEMO_PASSWORD }),
  });
  return {
    status: res.status,
    cookie: cookieHeader(res),
    location: res.headers.get("location") || "",
  };
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-visibility-"));
  const dbFile = path.join(tmp, "inbox.db");
  let appDb: Database.Database | undefined;
  let server: Server | undefined;

  try {
    process.env.INBOX_DB = "sqlite";
    process.env.DATABASE_PATH = dbFile;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as typeof import("../db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const seedMod = require("../db/seed") as typeof import("../db/seed");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const commentsApi = require("../services/comments") as typeof import("../services/comments");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const assignApi = require("../services/assign") as typeof import("../services/assign");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pushApi = require("../services/push") as typeof import("../services/push");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const express = require("express") as typeof import("express");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const session = require("express-session") as typeof import("express-session");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const apiRoutes = require("../routes/api") as typeof import("../routes/api");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pageRoutes = require("../routes/pages") as typeof import("../routes/pages");

    appDb = dbMod.db;
    const staffCount = appDb.prepare(`SELECT COUNT(*) AS n FROM staff`).get() as { n: number };
    if (staffCount.n === 0) await seedMod.seed();

    appDb.prepare(`UPDATE staff SET display_name = '陳東榮', is_admin = 0, active = 0 WHERE username = 'tony'`).run();
    appDb.prepare(`UPDATE staff SET display_name = 'Temp Ken', is_admin = 0, active = 0 WHERE username = 'ken'`).run();
    appDb.prepare(`UPDATE staff SET display_name = 'Temp Ben', is_admin = 0, active = 0 WHERE username = 'benjamin'`).run();
    appDb.prepare(`UPDATE staff SET display_name = 'Temp Viv', is_admin = 0, active = 0 WHERE username = 'vivian'`).run();
    seedMod.applySeedStaff();

    const staff = appDb
      .prepare(`SELECT id, username, display_name, is_admin, active FROM staff ORDER BY id ASC`)
      .all() as Array<{
      id: number;
      username: string;
      display_name: string;
      is_admin: number;
      active: number;
    }>;
    const byName = new Map(staff.map((row) => [row.username, row]));
    const expectRow = (
      username: string,
      displayName: string,
      isAdmin: number,
      active: number
    ): void => {
      const row = byName.get(username);
      check(
        `${username} → ${displayName}`,
        !!row && row.display_name === displayName && row.is_admin === isAdmin && row.active === active,
        row ? `${row.display_name} admin=${row.is_admin} active=${row.active}` : "缺少列"
      );
    };
    expectRow("tony", "Tony Chan", 1, 1);
    expectRow("benjamin", "Benjamin", 1, 1);
    expectRow("vivian", "Vivian", 1, 1);
    expectRow("ken", "Ken Kan", 1, 1);
    expectRow("eddie", "Eddie Lau", 1, 1);
    expectRow("wing", "Wing Cheng", 0, 1);
    expectRow("jason", "Jason Cheng", 0, 1);
    for (const username of ["kaixin", "ming", "mei", "ho", "yan", "chun", "sze", "kit", "yuki"]) {
      check(`${username} 唔再喺同事名單`, !byName.has(username));
    }
    const freshGuard = seedMod.removeRetiredStaffById();
    const protectedIds = appDb
      .prepare(`SELECT username FROM staff WHERE id BETWEEN 5 AND 13 ORDER BY id ASC`)
      .all() as Array<{ username: string }>;
    check(
      "全新 seed 嘅 id 5–13 係 Benjamin、Vivian、Ken，所以唔刪",
      freshGuard.skipped === true &&
        freshGuard.removed.length === 0 &&
        freshGuard.withheld.length === 0 &&
        protectedIds.map((row) => row.username).join(",") === "benjamin,vivian,ken"
    );

    const tony = byName.get("tony")!;
    const benjamin = byName.get("benjamin")!;
    const vivian = byName.get("vivian")!;
    const ken = byName.get("ken")!;
    const eddie = byName.get("eddie")!;
    const wing = byName.get("wing")!;
    const jason = byName.get("jason")!;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const passwordsEarly = require("../auth/passwords") as typeof import("../auth/passwords");
    const archiveId = Number(
      appDb
        .prepare(
          `INSERT INTO staff (username, display_name, password_hash, is_admin, active)
           VALUES ('archive', '收藏測試', ?, 0, 0)`
        )
        .run(passwordsEarly.hashPassword("ArchiveOnly1")).lastInsertRowid
    );

    const picked = assignApi.pickNextAutoAssignStaffId();
    const pickedRow = staff.find((row) => row.id === picked);
    check(
      "自動派單只計 active=1，而且唔會揀 Tony、Benjamin、Vivian 或 Ken",
      !!pickedRow &&
        pickedRow.active === 1 &&
        pickedRow.username !== "tony" &&
        pickedRow.username !== "benjamin" &&
        pickedRow.username !== "vivian" &&
        pickedRow.username !== "ken",
      pickedRow ? pickedRow.username : "沒有人選"
    );
    check(
      "Ken 同 Vivian、Benjamin、Tony 一樣係在職管理員",
      ken.is_admin === 1 &&
        ken.active === 1 &&
        ken.display_name === "Ken Kan" &&
        vivian.is_admin === 1 &&
        vivian.active === 1 &&
        benjamin.is_admin === 1 &&
        benjamin.active === 1 &&
        tony.is_admin === 1 &&
        tony.active === 1 &&
        eddie.is_admin === 1 &&
        eddie.active === 1
    );

    check(
      "推送：管理員見到未派",
      pushApi.notificationVisibleTo({ id: tony.id, is_admin: 1, active: 1 }, null)
    );
    check(
      "推送：在職同事見唔到未派",
      !pushApi.notificationVisibleTo({ id: wing.id, is_admin: 0, active: 1 }, null)
    );
    check(
      "推送：在職同事只見到自己",
      pushApi.notificationVisibleTo({ id: wing.id, is_admin: 0, active: 1 }, wing.id) &&
        !pushApi.notificationVisibleTo({ id: wing.id, is_admin: 0, active: 1 }, jason.id)
    );
    check(
      "推送：收藏同事收唔到",
      !pushApi.notificationVisibleTo({ id: archiveId, is_admin: 0, active: 0 }, archiveId)
    );

    const before = appDb.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM comments`).get() as { id: number };
    const unassigned = appDb
      .prepare(
        `INSERT INTO comments (
           source, external_id, author_name, body, status, assignee_staff_id, intake_kind, origin_site
         ) VALUES ('28car', 'vis-unassigned', '未派客', 'UNASSIGNED-ONLY-ADMIN', 'open', NULL, 'site_comment', NULL)`
      )
      .run();
    const jasonSecret = appDb
      .prepare(
        `INSERT INTO comments (
           source, external_id, author_name, body, status, assignee_staff_id, intake_kind, origin_site
         ) VALUES ('facebook', 'vis-jason', 'FB客', 'JASON-POLL-SECRET', 'open', ?, 'site_comment', NULL)`
      )
      .run(jason.id);
    const unassignedId = Number(unassigned.lastInsertRowid);
    const jasonId = Number(jasonSecret.lastInsertRowid);
    const wingComment = appDb
      .prepare(
        `SELECT id, body, status FROM comments WHERE assignee_staff_id = ? ORDER BY id ASC LIMIT 1`
      )
      .get(wing.id) as { id: number; body: string; status: string };
    const wingSnippet = wingComment.body.slice(0, 24);

    const wingView = { staffId: wing.id, isAdmin: false };
    const adminView = { staffId: tony.id, isAdmin: true };
    const wingList = commentsApi.listComments({ viewer: wingView });
    const adminList = commentsApi.listComments({ viewer: adminView });
    check(
      "列表：同事只得自己負責嘅留言",
      wingList.length > 0 && wingList.every((row) => row.assignee_staff_id === wing.id)
    );
    check(
      "列表：管理員見到未派同其他同事",
      adminList.some((row) => row.id === unassignedId) && adminList.some((row) => row.id === jasonId)
    );
    const wingUpdates = commentsApi.listCommentUpdates(before.id, 30, wingView);
    const adminUpdates = commentsApi.listCommentUpdates(before.id, 30, adminView);
    const wingUpdateText = JSON.stringify(wingUpdates);
    const adminUpdateText = JSON.stringify(adminUpdates);
    check(
      "輪詢：同事唔會收到其他人或者未派",
      !wingUpdateText.includes("JASON-POLL-SECRET") && !wingUpdateText.includes("UNASSIGNED-ONLY-ADMIN")
    );
    check(
      "輪詢：管理員收到未派同其他同事",
      adminUpdateText.includes("JASON-POLL-SECRET") && adminUpdateText.includes("UNASSIGNED-ONLY-ADMIN")
    );

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use(
      session({
        secret: "visibility-demo",
        resave: false,
        saveUninitialized: false,
      })
    );
    app.use("/api", apiRoutes.apiRouter);
    app.use(pageRoutes.pagesRouter);

    server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const wingLogin = await login(base, "wing");
    const tonyLogin = await login(base, "tony");
    const benjaminLogin = await login(base, "benjamin");
    const vivianLogin = await login(base, "vivian");
    const eddieLogin = await login(base, "eddie");
    const jasonLogin = await login(base, "jason");
    const kenLogin = await login(base, "ken");
    const archiveLogin = await login(base, "archive");
    check("Wing 可以登入", wingLogin.status === 302 && wingLogin.cookie.includes("connect.sid="));
    check("Tony 可以登入", tonyLogin.status === 302 && tonyLogin.cookie.includes("connect.sid="));
    check("Benjamin 可以登入", benjaminLogin.status === 302 && benjaminLogin.cookie.includes("connect.sid="));
    check("Vivian 可以登入", vivianLogin.status === 302 && vivianLogin.cookie.includes("connect.sid="));
    check("Ken 可以登入", kenLogin.status === 302 && kenLogin.cookie.includes("connect.sid="));
    check("Eddie 可以登入", eddieLogin.status === 302 && eddieLogin.cookie.includes("connect.sid="));
    check("收藏帳號 archive 登入唔到", archiveLogin.status === 302 && archiveLogin.location.includes("error") && !archiveLogin.cookie);

    const linesPage = await fetch(`${base}/whatsapp-lines`, { headers: { cookie: tonyLogin.cookie } });
    const linesHtml = await linesPage.text();
    check(
      "WhatsApp 線路頁寫明 Tony、Benjamin、Vivian、Ken 唔參與自動派單",
      linesPage.status === 200 &&
        linesHtml.includes("Tony、Benjamin、Vivian、Ken 唔參與自動派單") &&
        linesHtml.includes("Eddie → Wing → Jason")
    );

    const wingHeaders = { cookie: wingLogin.cookie, accept: "application/json" };
    const tonyHeaders = { cookie: tonyLogin.cookie, accept: "application/json" };
    const eddieHeaders = { cookie: eddieLogin.cookie, accept: "application/json" };

    const anon = await fetch(`${base}/api/comments`);
    check("未登入 API 401", anon.status === 401);

    const wingApi = await fetch(`${base}/api/comments`, { headers: wingHeaders });
    const wingApiBody = (await wingApi.json()) as { comments: Array<{ assignee_staff_id: number | null; body: string }> };
    check(
      "API 列表：Wing 只見自己",
      wingApi.status === 200 &&
        wingApiBody.comments.length > 0 &&
        wingApiBody.comments.every((row) => row.assignee_staff_id === wing.id) &&
        !JSON.stringify(wingApiBody).includes("JASON-POLL-SECRET") &&
        !JSON.stringify(wingApiBody).includes("UNASSIGNED-ONLY-ADMIN")
    );

    const wingOther = await fetch(`${base}/api/comments/${jasonId}`, { headers: wingHeaders });
    const wingUnassigned = await fetch(`${base}/api/comments/${unassignedId}`, { headers: wingHeaders });
    check("API：Wing 開唔到 Jason 嘅留言", wingOther.status === 404);
    check("API：Wing 開唔到未派", wingUnassigned.status === 404);

    const eddieUnassigned = await fetch(`${base}/api/comments/${unassignedId}`, { headers: eddieHeaders });
    const eddieJson = (await eddieUnassigned.json()) as { comment?: { body?: string } };
    check(
      "API：Eddie 見到未派",
      eddieUnassigned.status === 200 && eddieJson.comment?.body === "UNASSIGNED-ONLY-ADMIN"
    );

    const wingUpdatesHttp = await fetch(`${base}/api/comments/updates?since_id=${before.id}`, { headers: wingHeaders });
    const tonyUpdatesHttp = await fetch(`${base}/api/comments/updates?since_id=${before.id}`, { headers: tonyHeaders });
    const wingUpdatesJson = await wingUpdatesHttp.text();
    const tonyUpdatesJson = await tonyUpdatesHttp.text();
    check(
      "API 輪詢：Wing 冇其他人內容",
      wingUpdatesHttp.status === 200 &&
        !wingUpdatesJson.includes("JASON-POLL-SECRET") &&
        !wingUpdatesJson.includes("UNASSIGNED-ONLY-ADMIN")
    );
    check(
      "API 輪詢：Tony 見到全部新留言",
      tonyUpdatesHttp.status === 200 &&
        tonyUpdatesJson.includes("JASON-POLL-SECRET") &&
        tonyUpdatesJson.includes("UNASSIGNED-ONLY-ADMIN")
    );

    const wingReplies = await fetch(`${base}/api/comments/${jasonId}/replies`, { headers: wingHeaders });
    check("API：Wing 讀唔到其他人回覆", wingReplies.status === 404);

    const statusBefore = appDb.prepare(`SELECT status FROM comments WHERE id = ?`).get(jasonId) as { status: string };
    const wingStatus = await fetch(`${base}/api/comments/${jasonId}/status`, {
      method: "POST",
      headers: { ...wingHeaders, "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    const statusAfter = appDb.prepare(`SELECT status FROM comments WHERE id = ?`).get(jasonId) as { status: string };
    check("API：Wing 改唔到其他人狀態", wingStatus.status === 404 && statusAfter.status === statusBefore.status);

    const wingReply = await fetch(`${base}/api/comments/${jasonId}/replies`, {
      method: "POST",
      headers: { ...wingHeaders, "content-type": "application/json" },
      body: JSON.stringify({ body: "唔應該寫到" }),
    });
    const wingReplyJson = (await wingReply.json()) as { error?: string };
    const replyCount = appDb.prepare(`SELECT COUNT(*) AS n FROM comment_replies WHERE comment_id = ?`).get(jasonId) as {
      n: number;
    };
    check(
      "API：Wing 回覆唔到其他人",
      wingReply.status === 403 &&
        replyCount.n === 0 &&
        wingReplyJson.error === "呢則留言已改派畀其他同事，請刷新頁面",
      `status=${wingReply.status} ${wingReplyJson.error || ""}`
    );

    const ownReply = await fetch(`${base}/api/comments/${wingComment.id}/replies`, {
      method: "POST",
      headers: { ...wingHeaders, "content-type": "application/json" },
      body: JSON.stringify({ body: "Wing 回覆自己負責嘅留言" }),
    });
    check("API：Wing 可以回覆自己嘅留言", ownReply.status === 201);

    const repliesBeforeMove = (
      appDb.prepare(`SELECT COUNT(*) AS n FROM comment_replies WHERE comment_id = ?`).get(wingComment.id) as { n: number }
    ).n;
    const moved = await fetch(`${base}/api/comments/${wingComment.id}/assign`, {
      method: "POST",
      headers: { ...tonyHeaders, "content-type": "application/json" },
      body: JSON.stringify({ staff_id: jason.id }),
    });
    check("管理員可以改派 Wing 嘅留言", moved.status === 200);
    const staleReply = await fetch(`${base}/api/comments/${wingComment.id}/replies`, {
      method: "POST",
      headers: { ...wingHeaders, "content-type": "application/json" },
      body: JSON.stringify({ body: "舊頁面唔應該送出" }),
    });
    const staleJson = (await staleReply.json()) as { error?: string };
    const afterStaleReply = (
      appDb.prepare(`SELECT COUNT(*) AS n FROM comment_replies WHERE comment_id = ?`).get(wingComment.id) as { n: number }
    ).n;
    check(
      "改派之後舊負責人 API 回覆被拒，而且冇寫入",
      staleReply.status === 403 &&
        staleJson.error === "呢則留言已改派畀其他同事，請刷新頁面" &&
        afterStaleReply === repliesBeforeMove,
      `status=${staleReply.status} n=${afterStaleReply} err=${staleJson.error || ""}`
    );
    const stalePage = await fetch(`${base}/comments/${wingComment.id}/replies`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: wingLogin.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ body: "舊頁面表格唔應該送出" }),
    });
    const stalePageHtml = await stalePage.text();
    const afterStalePage = (
      appDb.prepare(`SELECT COUNT(*) AS n FROM comment_replies WHERE comment_id = ?`).get(wingComment.id) as { n: number }
    ).n;
    check(
      "改派之後舊負責人網頁回覆被拒",
      stalePage.status === 403 &&
        stalePageHtml.includes("呢則留言已改派畀其他同事，請刷新頁面") &&
        afterStalePage === repliesBeforeMove,
      `status=${stalePage.status}`
    );
    const staleMedia = await fetch(`${base}/api/comments/${wingComment.id}/media-replies`, {
      method: "POST",
      headers: { ...wingHeaders, "content-type": "application/json" },
      body: JSON.stringify({ data_base64: "", mime_type: "image/png", is_voice: false }),
    });
    const staleMediaJson = (await staleMedia.json()) as { error?: string };
    const afterStaleMedia = (
      appDb.prepare(`SELECT COUNT(*) AS n FROM comment_replies WHERE comment_id = ?`).get(wingComment.id) as { n: number }
    ).n;
    check(
      "改派之後舊負責人媒體回覆被拒，而且冇寫入",
      staleMedia.status === 403 &&
        staleMediaJson.error === "呢則留言已改派畀其他同事，請刷新頁面" &&
        afterStaleMedia === repliesBeforeMove,
      `status=${staleMedia.status} err=${staleMediaJson.error || ""}`
    );
    const jasonHeaders = { cookie: jasonLogin.cookie, accept: "application/json", "content-type": "application/json" };
    const newAssigneeReply = await fetch(`${base}/api/comments/${wingComment.id}/replies`, {
      method: "POST",
      headers: jasonHeaders,
      body: JSON.stringify({ body: "新負責人可以即刻回覆" }),
    });
    check("新負責人可以即刻回覆", newAssigneeReply.status === 201, String(newAssigneeReply.status));
    const adminReply = await fetch(`${base}/api/comments/${wingComment.id}/replies`, {
      method: "POST",
      headers: { ...tonyHeaders, "content-type": "application/json" },
      body: JSON.stringify({ body: "管理員改派後仍然可以回覆" }),
    });
    check("管理員改派後仍然可以回覆", adminReply.status === 201, String(adminReply.status));
    const restored = await fetch(`${base}/api/comments/${wingComment.id}/assign`, {
      method: "POST",
      headers: { ...tonyHeaders, "content-type": "application/json" },
      body: JSON.stringify({ staff_id: wing.id }),
    });
    check("改派測試後交還 Wing", restored.status === 200);

    const assigneeBefore = appDb.prepare(`SELECT assignee_staff_id AS id FROM comments WHERE id = ?`).get(jasonId) as {
      id: number;
    };
    const wingAssign = await fetch(`${base}/api/comments/${jasonId}/assign`, {
      method: "POST",
      headers: { ...wingHeaders, "content-type": "application/json" },
      body: JSON.stringify({ staff_id: wing.id }),
    });
    const assigneeAfterDeny = appDb.prepare(`SELECT assignee_staff_id AS id FROM comments WHERE id = ?`).get(jasonId) as {
      id: number;
    };
    check(
      "API：Wing 改派 403",
      wingAssign.status === 403 && assigneeAfterDeny.id === assigneeBefore.id
    );

    const tonyAssign = await fetch(`${base}/api/comments/${jasonId}/assign`, {
      method: "POST",
      headers: { ...tonyHeaders, "content-type": "application/json" },
      body: JSON.stringify({ staff_id: wing.id }),
    });
    const assigneeAfter = appDb.prepare(`SELECT assignee_staff_id AS id FROM comments WHERE id = ?`).get(jasonId) as {
      id: number;
    };
    check("API：Tony 可以改派", tonyAssign.status === 200 && assigneeAfter.id === wing.id);

    const wingNow = await fetch(`${base}/api/comments/${jasonId}`, { headers: wingHeaders });
    const jasonSees = await fetch(`${base}/api/comments/${jasonId}`, {
      headers: { cookie: jasonLogin.cookie, accept: "application/json" },
    });
    check("改派之後 Wing 見得到", wingNow.status === 200);
    check("改派之後 Jason 見唔到", jasonSees.status === 404);
    await fetch(`${base}/api/comments/${jasonId}/assign`, {
      method: "POST",
      headers: { ...tonyHeaders, "content-type": "application/json" },
      body: JSON.stringify({ staff_id: jason.id }),
    });

    const wingPage = await fetch(`${base}/`, { headers: { cookie: wingLogin.cookie } });
    const wingHtml = await wingPage.text();
    const tonyPage = await fetch(`${base}/`, { headers: { cookie: tonyLogin.cookie } });
    const tonyHtml = await tonyPage.text();
    check(
      "網頁：Wing 留言箱冇其他人內容",
      wingPage.status === 200 &&
        wingHtml.includes("你只會見到派咗畀你嘅留言") &&
        !wingHtml.includes("只睇我嘅") &&
        !wingHtml.includes("JASON-POLL-SECRET") &&
        !wingHtml.includes("UNASSIGNED-ONLY-ADMIN") &&
        wingHtml.includes(wingSnippet)
    );
    check(
      "網頁：Tony 留言箱見到未派同 Jason",
      tonyPage.status === 200 &&
        tonyHtml.includes("只睇我嘅") &&
        tonyHtml.includes("JASON-POLL-SECRET") &&
        tonyHtml.includes("UNASSIGNED-ONLY-ADMIN")
    );

    const wingDetail = await fetch(`${base}/comments/${wingComment.id}`, { headers: { cookie: wingLogin.cookie } });
    const wingDetailHtml = await wingDetail.text();
    const tonyDetail = await fetch(`${base}/comments/${jasonId}`, { headers: { cookie: tonyLogin.cookie } });
    const tonyDetailHtml = await tonyDetail.text();
    const wingForbidden = await fetch(`${base}/comments/${jasonId}`, { headers: { cookie: wingLogin.cookie } });
    const wingForbiddenHtml = await wingForbidden.text();
    check(
      "網頁：Wing 自己嘅留言冇改派表單",
      wingDetail.status === 200 &&
        wingDetailHtml.includes("改派只限管理員") &&
        !wingDetailHtml.includes("/assign") &&
        wingDetailHtml.includes("更新狀態")
    );
    check(
      "網頁：Tony 可以開其他人留言並見到改派",
      tonyDetail.status === 200 && tonyDetailHtml.includes("/assign") && tonyDetailHtml.includes("JASON-POLL-SECRET")
    );
    check(
      "網頁：Wing 開唔到 Jason 嘅留言",
      wingForbidden.status === 404 && !wingForbiddenHtml.includes("JASON-POLL-SECRET")
    );

    const wingPageStatus = await fetch(`${base}/comments/${jasonId}/status`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: wingLogin.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ status: "done" }),
    });
    const wingPageAssign = await fetch(`${base}/comments/${jasonId}/assign`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: wingLogin.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ staff_id: String(wing.id) }),
    });
    const stillJason = appDb.prepare(`SELECT assignee_staff_id AS id, status FROM comments WHERE id = ?`).get(jasonId) as {
      id: number;
      status: string;
    };
    check("網頁：Wing 改狀態被拒", wingPageStatus.status === 404 && stillJason.status === "open");
    check(
      "網頁：Wing 改派被拒",
      wingPageAssign.status === 403 && wingPageAssign && stillJason.id === jason.id
    );

    const tonyStatus = await fetch(`${base}/api/comments/${unassignedId}/status`, {
      method: "POST",
      headers: { ...tonyHeaders, "content-type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });
    const unassignedStatus = appDb.prepare(`SELECT status FROM comments WHERE id = ?`).get(unassignedId) as {
      status: string;
    };
    check("API：Tony 可以改未派留言狀態", tonyStatus.status === 200 && unassignedStatus.status === "in_progress");

    const benjaminHeaders = { cookie: benjaminLogin.cookie, accept: "application/json" };
    const benjaminPage = await fetch(`${base}/`, { headers: { cookie: benjaminLogin.cookie } });
    const benjaminHtml = await benjaminPage.text();
    check(
      "網頁：Benjamin 同 Tony 一樣見到未派",
      benjaminPage.status === 200 &&
        benjaminHtml.includes("只睇我嘅") &&
        benjaminHtml.includes("· 管理員") &&
        benjaminHtml.includes("UNASSIGNED-ONLY-ADMIN")
    );
    const benjaminDetail = await fetch(`${base}/comments/${unassignedId}`, {
      headers: { cookie: benjaminLogin.cookie },
    });
    const benjaminDetailHtml = await benjaminDetail.text();
    check(
      "網頁：Benjamin 可以開未派並見到改派",
      benjaminDetail.status === 200 &&
        benjaminDetailHtml.includes("/assign") &&
        benjaminDetailHtml.includes("UNASSIGNED-ONLY-ADMIN")
    );
    const benjaminLines = await fetch(`${base}/whatsapp-lines`, { headers: { cookie: benjaminLogin.cookie } });
    check("Benjamin 可以開 WhatsApp 線路頁", benjaminLines.status === 200);
    const benjaminAssign = await fetch(`${base}/api/comments/${jasonId}/assign`, {
      method: "POST",
      headers: { ...benjaminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ staff_id: jason.id }),
    });
    check("API：Benjamin 可以改派", benjaminAssign.status === 200);

    const vivianHeaders = { cookie: vivianLogin.cookie, accept: "application/json" };
    const vivianPage = await fetch(`${base}/`, { headers: { cookie: vivianLogin.cookie } });
    const vivianHtml = await vivianPage.text();
    check(
      "網頁：Vivian 同 Benjamin 一樣見到未派",
      vivianPage.status === 200 &&
        vivianHtml.includes("只睇我嘅") &&
        vivianHtml.includes("· 管理員") &&
        vivianHtml.includes("UNASSIGNED-ONLY-ADMIN")
    );
    const vivianDetail = await fetch(`${base}/comments/${unassignedId}`, {
      headers: { cookie: vivianLogin.cookie },
    });
    const vivianDetailHtml = await vivianDetail.text();
    check(
      "網頁：Vivian 可以開未派並見到改派",
      vivianDetail.status === 200 &&
        vivianDetailHtml.includes("/assign") &&
        vivianDetailHtml.includes("UNASSIGNED-ONLY-ADMIN")
    );
    const vivianLines = await fetch(`${base}/whatsapp-lines`, { headers: { cookie: vivianLogin.cookie } });
    check("Vivian 可以開 WhatsApp 線路頁", vivianLines.status === 200);
    const staffPage = await fetch(`${base}/staff`, { headers: { cookie: vivianLogin.cookie } });
    const staffHtml = await staffPage.text();
    check(
      "Vivian 同 Ken 可以開同事名單，而且自己係管理員／啟用；舊收藏種子唔喺表",
      staffPage.status === 200 &&
        /<code>vivian<\/code><\/td>\s*<td>管理員<\/td>\s*<td>啟用<\/td>/.test(staffHtml) &&
        /<code>ken<\/code><\/td>\s*<td>管理員<\/td>\s*<td>啟用<\/td>/.test(staffHtml) &&
        !staffHtml.includes("kaixin") &&
        !staffHtml.includes("yuki")
    );
    const vivianAssign = await fetch(`${base}/api/comments/${jasonId}/assign`, {
      method: "POST",
      headers: { ...vivianHeaders, "content-type": "application/json" },
      body: JSON.stringify({ staff_id: jason.id }),
    });
    check("API：Vivian 可以改派", vivianAssign.status === 200);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const passwords = require("../auth/passwords") as typeof import("../auth/passwords");
    appDb
      .prepare(
        `UPDATE staff SET username = 'Benjamin', display_name = 'Benjamin', is_admin = 0, active = 0, password_hash = 'kept-ben-hash' WHERE username = 'benjamin'`
      )
      .run();
    seedMod.applySeedStaff();
    const adoptedCase = appDb
      .prepare(
        `SELECT username, display_name, is_admin, active, password_hash
         FROM staff
         WHERE lower(username) = 'benjamin' OR lower(display_name) LIKE 'benjamin%'`
      )
      .all() as Array<{
      username: string;
      display_name: string;
      is_admin: number;
      active: number;
      password_hash: string;
    }>;
    check(
      "用戶名 Benjamin 會升級成 benjamin 管理員，唔會重複",
      adoptedCase.length === 1 &&
        adoptedCase[0].username === "benjamin" &&
        adoptedCase[0].display_name === "Benjamin" &&
        adoptedCase[0].is_admin === 1 &&
        adoptedCase[0].active === 1 &&
        adoptedCase[0].password_hash === "kept-ben-hash"
    );

    appDb
      .prepare(
        `UPDATE staff SET username = 'bchan', display_name = 'Benjamin', is_admin = 0, active = 0, password_hash = 'kept-ben-hash' WHERE username = 'benjamin'`
      )
      .run();
    seedMod.ensureBenjaminAdmin();
    const adoptedName = appDb
      .prepare(
        `SELECT username, display_name, is_admin, active, password_hash
         FROM staff
         WHERE lower(username) IN ('benjamin', 'bchan') OR lower(trim(display_name)) = 'benjamin'`
      )
      .all() as Array<{
      username: string;
      display_name: string;
      is_admin: number;
      active: number;
      password_hash: string;
    }>;
    check(
      "顯示名 Benjamin 會升級同一列，唔會另開帳號",
      adoptedName.length === 1 &&
        adoptedName[0].username === "benjamin" &&
        adoptedName[0].is_admin === 1 &&
        adoptedName[0].active === 1 &&
        adoptedName[0].password_hash === "kept-ben-hash"
    );

    appDb
      .prepare(
        `UPDATE staff SET username = 'Vivian', display_name = 'Vivian', is_admin = 0, active = 0, password_hash = 'kept-viv-hash' WHERE username = 'vivian'`
      )
      .run();
    seedMod.applySeedStaff();
    const adoptedVivianCase = appDb
      .prepare(
        `SELECT username, display_name, is_admin, active, password_hash
         FROM staff
         WHERE lower(username) = 'vivian' OR lower(display_name) LIKE 'vivian%'`
      )
      .all() as Array<{
      username: string;
      display_name: string;
      is_admin: number;
      active: number;
      password_hash: string;
    }>;
    check(
      "用戶名 Vivian 會升級成 vivian 管理員，唔會重複",
      adoptedVivianCase.length === 1 &&
        adoptedVivianCase[0].username === "vivian" &&
        adoptedVivianCase[0].display_name === "Vivian" &&
        adoptedVivianCase[0].is_admin === 1 &&
        adoptedVivianCase[0].active === 1 &&
        adoptedVivianCase[0].password_hash === "kept-viv-hash"
    );

    appDb
      .prepare(
        `UPDATE staff SET username = 'vchan', display_name = 'Vivian Chan', is_admin = 0, active = 0, password_hash = 'kept-viv-hash' WHERE username = 'vivian'`
      )
      .run();
    seedMod.ensureVivianAdmin();
    const adoptedVivianName = appDb
      .prepare(
        `SELECT username, display_name, is_admin, active, password_hash
         FROM staff
         WHERE lower(username) IN ('vivian', 'vchan') OR lower(trim(display_name)) = 'vivian' OR lower(trim(display_name)) LIKE 'vivian %'`
      )
      .all() as Array<{
      username: string;
      display_name: string;
      is_admin: number;
      active: number;
      password_hash: string;
    }>;
    check(
      "顯示名 Vivian … 會升級同一列，唔會另開帳號",
      adoptedVivianName.length === 1 &&
        adoptedVivianName[0].username === "vivian" &&
        adoptedVivianName[0].display_name === "Vivian" &&
        adoptedVivianName[0].is_admin === 1 &&
        adoptedVivianName[0].active === 1 &&
        adoptedVivianName[0].password_hash === "kept-viv-hash"
    );

    appDb
      .prepare(
        `UPDATE staff SET username = 'Ken', display_name = 'Ken Kan', is_admin = 0, active = 0, password_hash = 'kept-ken-hash' WHERE username = 'ken'`
      )
      .run();
    seedMod.applySeedStaff();
    const adoptedKenCase = appDb
      .prepare(
        `SELECT username, display_name, is_admin, active, password_hash
         FROM staff
         WHERE lower(username) = 'ken' OR lower(display_name) LIKE 'ken kan%'`
      )
      .all() as Array<{
      username: string;
      display_name: string;
      is_admin: number;
      active: number;
      password_hash: string;
    }>;
    check(
      "用戶名 Ken 會升級成 ken 管理員，唔會重複",
      adoptedKenCase.length === 1 &&
        adoptedKenCase[0].username === "ken" &&
        adoptedKenCase[0].display_name === "Ken Kan" &&
        adoptedKenCase[0].is_admin === 1 &&
        adoptedKenCase[0].active === 1 &&
        adoptedKenCase[0].password_hash === "kept-ken-hash"
    );

    appDb
      .prepare(
        `UPDATE staff SET username = 'kchan', display_name = 'Ken Kan', is_admin = 0, active = 0, password_hash = 'kept-ken-hash' WHERE username = 'ken'`
      )
      .run();
    seedMod.ensureKenAdmin();
    const adoptedKenName = appDb
      .prepare(
        `SELECT username, display_name, is_admin, active, password_hash
         FROM staff
         WHERE lower(username) IN ('ken', 'kchan') OR lower(trim(display_name)) = 'ken kan' OR lower(trim(display_name)) LIKE 'ken kan %'`
      )
      .all() as Array<{
      username: string;
      display_name: string;
      is_admin: number;
      active: number;
      password_hash: string;
    }>;
    check(
      "顯示名 Ken Kan 會升級同一列，唔會另開帳號",
      adoptedKenName.length === 1 &&
        adoptedKenName[0].username === "ken" &&
        adoptedKenName[0].display_name === "Ken Kan" &&
        adoptedKenName[0].is_admin === 1 &&
        adoptedKenName[0].active === 1 &&
        adoptedKenName[0].password_hash === "kept-ken-hash"
    );

    const tonyStill = appDb.prepare(`SELECT is_admin, active FROM staff WHERE username = 'tony'`).get() as {
      is_admin: number;
      active: number;
    };
    const eddieStill = appDb.prepare(`SELECT is_admin, active, password_hash FROM staff WHERE username = 'eddie'`).get() as {
      is_admin: number;
      active: number;
      password_hash: string;
    };
    const benjaminStill = appDb.prepare(`SELECT is_admin, active, password_hash FROM staff WHERE username = 'benjamin'`).get() as {
      is_admin: number;
      active: number;
      password_hash: string;
    };
    appDb.prepare(`UPDATE staff SET is_admin = 0, active = 0 WHERE username = 'benjamin'`).run();
    appDb.prepare(`DELETE FROM staff WHERE username = 'vivian'`).run();
    appDb.prepare(`DELETE FROM staff WHERE username = 'ken'`).run();
    const commentsBefore = (appDb.prepare(`SELECT COUNT(*) AS n FROM comments`).get() as { n: number }).n;
    seedMod.syncStaffOnBoot();
    const commentsAfter = (appDb.prepare(`SELECT COUNT(*) AS n FROM comments`).get() as { n: number }).n;
    const inserted = appDb
      .prepare(`SELECT display_name, is_admin, active, password_hash FROM staff WHERE username = 'vivian'`)
      .get() as { display_name: string; is_admin: number; active: number; password_hash: string };
    const insertedKen = appDb
      .prepare(`SELECT display_name, is_admin, active, password_hash FROM staff WHERE username = 'ken'`)
      .get() as { display_name: string; is_admin: number; active: number; password_hash: string };
    const benjaminAfterBoot = appDb
      .prepare(`SELECT is_admin, active, password_hash FROM staff WHERE username = 'benjamin'`)
      .get() as { is_admin: number; active: number; password_hash: string };
    const tonyAfterBoot = appDb.prepare(`SELECT is_admin, active FROM staff WHERE username = 'tony'`).get() as {
      is_admin: number;
      active: number;
    };
    const eddieAfterBoot = appDb
      .prepare(`SELECT is_admin, active, password_hash FROM staff WHERE username = 'eddie'`)
      .get() as { is_admin: number; active: number; password_hash: string };
    check(
      "已有同事嘅庫啟動會補 Vivian 管理員",
      inserted.display_name === "Vivian" &&
        inserted.is_admin === 1 &&
        inserted.active === 1 &&
        passwords.verifyPassword(DEMO_PASSWORD, inserted.password_hash)
    );
    check(
      "已有同事嘅庫啟動會補 Ken Kan 管理員",
      insertedKen.display_name === "Ken Kan" &&
        insertedKen.is_admin === 1 &&
        insertedKen.active === 1 &&
        passwords.verifyPassword(DEMO_PASSWORD, insertedKen.password_hash)
    );
    check("啟動對齊唔寫新留言", commentsAfter === commentsBefore);
    check(
      "啟動仍然確保 Benjamin 係管理員，而且唔改佢密碼",
      benjaminStill.password_hash.length > 0 &&
        benjaminAfterBoot.is_admin === 1 &&
        benjaminAfterBoot.active === 1 &&
        benjaminAfterBoot.password_hash === benjaminStill.password_hash
    );
    check(
      "補 Vivian 唔會降 Tony 或 Eddie，亦唔改 Eddie 密碼",
      tonyStill.is_admin === 1 &&
        tonyStill.active === 1 &&
        tonyAfterBoot.is_admin === 1 &&
        tonyAfterBoot.active === 1 &&
        eddieStill.is_admin === 1 &&
        eddieStill.active === 1 &&
        eddieAfterBoot.is_admin === 1 &&
        eddieAfterBoot.active === 1 &&
        eddieAfterBoot.password_hash === eddieStill.password_hash
    );

    const detachIds = (appDb.prepare(`SELECT id FROM staff`).all() as Array<{ id: number }>).map((row) => row.id);
    if (detachIds.length) {
      const marks = detachIds.map(() => "?").join(", ");
      appDb.prepare(`UPDATE comments SET assignee_staff_id = NULL WHERE assignee_staff_id IN (${marks})`).run(...detachIds);
      appDb
        .prepare(
          `DELETE FROM message_media WHERE reply_id IN (SELECT id FROM comment_replies WHERE staff_id IN (${marks}))`
        )
        .run(...detachIds);
      appDb
        .prepare(
          `UPDATE comment_message_keys SET reply_id = NULL WHERE reply_id IN (SELECT id FROM comment_replies WHERE staff_id IN (${marks}))`
        )
        .run(...detachIds);
      appDb.prepare(`DELETE FROM comment_replies WHERE staff_id IN (${marks})`).run(...detachIds);
      appDb.prepare(`DELETE FROM push_subscriptions WHERE staff_id IN (${marks})`).run(...detachIds);
      appDb.prepare(`DELETE FROM whatsapp_lines WHERE staff_id IN (${marks})`).run(...detachIds);
      appDb.prepare(`DELETE FROM staff WHERE id IN (${marks})`).run(...detachIds);
    }
    const roster: Array<[number, string, string, number, number]> = [
      [1, "eddie", "Eddie Lau", 1, 1],
      [2, "wing", "Wing Cheng", 0, 1],
      [3, "jason", "Jason Cheng", 0, 1],
      [4, "tony", "Tony Chan", 1, 1],
      [5, "kaixin", "張嘉欣", 0, 0],
      [6, "ming", "王明軒", 0, 0],
      [7, "mei", "陳美玲", 0, 0],
      [8, "ho", "何志豪", 0, 0],
      [9, "yan", "林雅雯", 0, 0],
      [10, "chun", "黃俊傑", 0, 0],
      [11, "sze", "鄭詩敏", 0, 0],
      [12, "kit", "吳家傑", 0, 0],
      [13, "yuki", "趙雪兒", 0, 0],
      [14, "benjamin", "Benjamin", 1, 1],
      [23, "vivian", "Vivian", 1, 1],
    ];
    const insertRoster = appDb.prepare(
      `INSERT INTO staff (id, username, display_name, password_hash, is_admin, active) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const [id, username, displayName, isAdmin, active] of roster) {
      insertRoster.run(id, username, displayName, "kept-live-hash", isAdmin, active);
    }
    const wingCommentId = Number(
      appDb
        .prepare(
          `INSERT INTO comments (
             source, external_id, author_name, body, status, assignee_staff_id, intake_kind
           ) VALUES ('28car', 'live-shape-wing', '客人', '留給 Wing', 'open', 2, 'site_comment')`
        )
        .run().lastInsertRowid
    );
    const retiredCommentId = Number(
      appDb
        .prepare(
          `INSERT INTO comments (
             source, external_id, author_name, body, status, assignee_staff_id, intake_kind
           ) VALUES ('28car', 'live-shape-ho', '客人', '舊收藏負責人', 'open', 8, 'site_comment')`
        )
        .run().lastInsertRowid
    );
    const retiredReplyId = Number(
      appDb
        .prepare(
          `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status)
           VALUES (?, 8, 'outbound', '舊回覆', 'stored')`
        )
        .run(retiredCommentId).lastInsertRowid
    );
    appDb
      .prepare(`INSERT INTO message_media (comment_id, reply_id, kind, mime_type, byte_size) VALUES (?, ?, 'image', 'image/png', 1)`)
      .run(retiredCommentId, retiredReplyId);
    appDb
      .prepare(
        `INSERT INTO comment_message_keys (source, external_id, comment_id, reply_id) VALUES ('28car', 'live-shape-ho-key', ?, ?)`
      )
      .run(retiredCommentId, retiredReplyId);
    appDb
      .prepare(
        `INSERT INTO push_subscriptions (staff_id, endpoint, p256dh, auth) VALUES (8, 'https://push.example/ho', 'p256', 'auth')`
      )
      .run();
    appDb
      .prepare(
        `INSERT INTO whatsapp_lines (phone_e164, display_label, kind, staff_id, is_active)
         VALUES ('85260000008', '何志豪', 'staff', 8, 0)`
      )
      .run();
    appDb.prepare(`UPDATE sqlite_sequence SET seq = 23 WHERE name = 'staff'`).run();

    seedMod.syncStaffOnBoot();
    const liveStaff = appDb
      .prepare(`SELECT id, username, display_name, is_admin, active, password_hash FROM staff ORDER BY id ASC`)
      .all() as Array<{
      id: number;
      username: string;
      display_name: string;
      is_admin: number;
      active: number;
      password_hash: string;
    }>;
    const liveNames = liveStaff.map((row) => `${row.id}:${row.username}`).join(",");
    const kenLive = liveStaff.find((row) => row.username === "ken");
    const retiredLeft = liveStaff.filter((row) => row.id >= 5 && row.id <= 13);
    const wingStill = appDb.prepare(`SELECT assignee_staff_id FROM comments WHERE id = ?`).get(wingCommentId) as {
      assignee_staff_id: number | null;
    };
    const hoNow = appDb.prepare(`SELECT assignee_staff_id FROM comments WHERE id = ?`).get(retiredCommentId) as {
      assignee_staff_id: number | null;
    };
    const replyLeft = appDb.prepare(`SELECT id FROM comment_replies WHERE id = ?`).get(retiredReplyId);
    const pushLeft = appDb.prepare(`SELECT id FROM push_subscriptions WHERE staff_id = 8`).get();
    const lineLeft = appDb.prepare(`SELECT id FROM whatsapp_lines WHERE staff_id = 8`).get();
    const keyNow = appDb
      .prepare(`SELECT reply_id FROM comment_message_keys WHERE external_id = 'live-shape-ho-key'`)
      .get() as { reply_id: number | null };
    check(
      "正式庫形狀：刪走 id 5–13 收藏種子，Ken 用示範密碼補做管理員，受保護同事留低",
      retiredLeft.length === 0 &&
        !!kenLive &&
        kenLive.id > 13 &&
        kenLive.display_name === "Ken Kan" &&
        kenLive.is_admin === 1 &&
        kenLive.active === 1 &&
        passwords.verifyPassword(DEMO_PASSWORD, kenLive.password_hash) &&
        liveStaff.some((row) => row.id === 1 && row.username === "eddie" && row.password_hash === "kept-live-hash") &&
        liveStaff.some((row) => row.id === 2 && row.username === "wing") &&
        liveStaff.some((row) => row.id === 3 && row.username === "jason") &&
        liveStaff.some((row) => row.id === 4 && row.username === "tony" && row.is_admin === 1) &&
        liveStaff.some((row) => row.id === 14 && row.username === "benjamin" && row.is_admin === 1 && row.password_hash === "kept-live-hash") &&
        liveStaff.some((row) => row.id === 23 && row.username === "vivian" && row.is_admin === 1 && row.password_hash === "kept-live-hash") &&
        wingStill.assignee_staff_id === 2 &&
        hoNow.assignee_staff_id == null &&
        replyLeft == null &&
        pushLeft == null &&
        lineLeft == null &&
        keyNow.reply_id == null,
      liveNames
    );
    const afterLivePick = assignApi.pickNextAutoAssignStaffId();
    check(
      "正式庫形狀：自動派單唔會派 Ken，亦唔會派已刪嘅 id 5–13",
      afterLivePick != null &&
        afterLivePick !== kenLive?.id &&
        (afterLivePick < 5 || afterLivePick > 13) &&
        ![14, 23].includes(afterLivePick),
      String(afterLivePick)
    );

    appDb.prepare(`DELETE FROM staff WHERE username = 'ken'`).run();
    appDb
      .prepare(
        `INSERT INTO staff (id, username, display_name, password_hash, is_admin, active)
         VALUES (5, 'ken', 'Ken Kan', 'kept-ken', 1, 1)`
      )
      .run();
    appDb
      .prepare(
        `INSERT INTO staff (id, username, display_name, password_hash, is_admin, active)
         VALUES (6, 'kaixin', '張嘉欣', 'kept-kaixin', 0, 0)`
      )
      .run();
    const blocked = seedMod.removeRetiredStaffById();
    const kenBlocked = appDb.prepare(`SELECT id, username, password_hash FROM staff WHERE username = 'ken'`).get() as {
      id: number;
      username: string;
      password_hash: string;
    };
    const kaixinLeft = appDb.prepare(`SELECT id, username FROM staff WHERE username = 'kaixin'`).get() as {
      id: number;
      username: string;
    };
    check(
      "id 5 係 Ken 時唔刪範圍內任何人，包括收藏種子",
      blocked.skipped === true &&
        blocked.removed.length === 0 &&
        blocked.blocked.some((row) => row.username === "ken" && row.id === 5) &&
        blocked.withheld.some((row) => row.username === "kaixin") &&
        kenBlocked.id === 5 &&
        kenBlocked.password_hash === "kept-ken" &&
        kaixinLeft.id === 6 &&
        kaixinLeft.username === "kaixin",
      `skipped=${blocked.skipped} withheld=${blocked.withheld.map((row) => row.username).join(",")}`
    );

    if (failures.length) {
      console.error(`\n${failures.length} 項失敗`);
      return 1;
    }
    console.log("\n同事可見範圍示範通過");
    return 0;
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
      });
    }
    appDb?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
