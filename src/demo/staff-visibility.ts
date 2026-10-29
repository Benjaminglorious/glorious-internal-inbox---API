/**
 * 同事角色同留言可見範圍煙霧測試。
 * 用臨時 SQLite，唔會郁到正式 data/inbox.db。
 *
 * 覆蓋：seed 姓名／角色／收藏、自動派單只計 active=1、
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
    if (staffCount.n === 0) seedMod.seed();

    appDb.prepare(`UPDATE staff SET display_name = '陳東榮', is_admin = 0, active = 0 WHERE username = 'tony'`).run();
    appDb.prepare(`UPDATE staff SET display_name = 'Temp', is_admin = 1, active = 1 WHERE username = 'kaixin'`).run();
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
    expectRow("eddie", "Eddie Lau", 1, 1);
    expectRow("wing", "Wing Cheng", 0, 1);
    expectRow("jason", "Jason Cheng", 0, 1);
    for (const username of ["kaixin", "ming", "mei", "ho", "yan", "chun", "sze", "kit", "yuki"]) {
      const row = byName.get(username);
      check(`${username} 收藏 active=0`, !!row && row.active === 0 && row.is_admin === 0);
    }

    const tony = byName.get("tony")!;
    const wing = byName.get("wing")!;
    const jason = byName.get("jason")!;
    const kaixin = byName.get("kaixin")!;

    const picked = assignApi.pickLeastLoadedStaffId();
    const pickedRow = staff.find((row) => row.id === picked);
    check(
      "自動派單只計 active=1（收藏即使未完成數係 0 都唔會被揀）",
      !!pickedRow && pickedRow.active === 1,
      pickedRow ? pickedRow.username : "沒有人選"
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
      !pushApi.notificationVisibleTo({ id: kaixin.id, is_admin: 0, active: 0 }, kaixin.id)
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
    const eddieLogin = await login(base, "eddie");
    const jasonLogin = await login(base, "jason");
    const kaixinLogin = await login(base, "kaixin");
    check("Wing 可以登入", wingLogin.status === 302 && wingLogin.cookie.includes("connect.sid="));
    check("Tony 可以登入", tonyLogin.status === 302 && tonyLogin.cookie.includes("connect.sid="));
    check("Eddie 可以登入", eddieLogin.status === 302 && eddieLogin.cookie.includes("connect.sid="));
    check("收藏帳號 kaixin 登入唔到", kaixinLogin.status === 302 && kaixinLogin.location.includes("error") && !kaixinLogin.cookie);

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
    const replyCount = appDb.prepare(`SELECT COUNT(*) AS n FROM comment_replies WHERE comment_id = ?`).get(jasonId) as {
      n: number;
    };
    check("API：Wing 回覆唔到其他人", wingReply.status === 404 && replyCount.n === 0);

    const ownReply = await fetch(`${base}/api/comments/${wingComment.id}/replies`, {
      method: "POST",
      headers: { ...wingHeaders, "content-type": "application/json" },
      body: JSON.stringify({ body: "Wing 回覆自己負責嘅留言" }),
    });
    check("API：Wing 可以回覆自己嘅留言", ownReply.status === 201);

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
