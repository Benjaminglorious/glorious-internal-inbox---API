/**
 * 留言箱「內容」顯示客戶最新一句，唔係第一句，亦唔係同事回覆。
 * 同一個未完成留言者仍然共用一個 ID。用臨時 SQLite。
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type Database from "better-sqlite3";

const failures: string[] = [];
const DEMO_PASSWORD = "Glorious2026!";
const FIXED_CREATED = "2026-11-03 02:00:00";
const FIXED_CREATED_HKT = "2026-11-03 10:00:00 HKT";
const FIXED_INBOUND = "2026-11-03 06:00:00";
const FIXED_INBOUND_HKT = "2026-11-03 14:00:00 HKT";
const FIXED_STAFF = "2026-11-03 07:00:00";
const OLDER_CREATED = "2026-11-03 04:00:00";
const OLDER_CREATED_HKT = "2026-11-03 12:00:00 HKT";
const OLDER_INBOUND = "2026-11-03 03:00:00";
const OLDER_INBOUND_HKT = "2026-11-03 11:00:00 HKT";

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

function rowHtml(html: string, id: number): string {
  const needle = `href="/comments/${id}"`;
  return html.split("<tr>").find((part) => part.includes(needle)) ?? "";
}

function contentPreview(row: string): string {
  const match = row.match(/<span class="content-preview">([\s\S]*?)<\/span>/);
  return match?.[1] ?? "";
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-preview-"));
  const dbFile = path.join(tmp, "inbox.db");
  let appDb: Database.Database | undefined;
  let server: Server | undefined;

  try {
    process.env.INBOX_DB = "sqlite";
    process.env.DATABASE_PATH = dbFile;
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.META_PAGE_ACCESS_TOKEN;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as typeof import("../db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const passwords = require("../auth/passwords") as typeof import("../auth/passwords");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const comments = require("../services/comments") as typeof import("../services/comments");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const repliesApi = require("../services/replies") as typeof import("../services/replies");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wa = require("../services/whatsapp") as typeof import("../services/whatsapp");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const site = require("../services/site-comments") as typeof import("../services/site-comments");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const express = require("express") as typeof import("express");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const session = require("express-session") as typeof import("express-session");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const apiRoutes = require("../routes/api") as typeof import("../routes/api");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pageRoutes = require("../routes/pages") as typeof import("../routes/pages");

    appDb = dbMod.db;
    const hash = passwords.hashPassword(DEMO_PASSWORD);
    const staff = appDb
      .prepare(
        `INSERT INTO staff (username, display_name, password_hash, is_admin, active)
         VALUES ('tony', 'Tony Chan', ?, 1, 1)`
      )
      .run(hash);
    const staffId = Number(staff.lastInsertRowid);
    wa.ensureCompanyWhatsAppLine();

    const first = wa.routeWhatsAppInbound({
      toPhone: "85221740001",
      fromPhone: "85290007701",
      body: "WA 第一句",
      externalId: "wamid.PREVIEW-1",
      authorName: "陳生",
    });
    const second = wa.routeWhatsAppInbound({
      toPhone: "85221740001",
      fromPhone: "85290007701",
      body: "WA 客戶第二句",
      externalId: "wamid.PREVIEW-2",
      authorName: "陳生",
    });
    check("WhatsApp 跟進仍然係同一個 ID", first.ok && second.ok && second.created === false && second.appended === true && second.comment.id === first.comment.id);
    if (!first.ok || !second.ok) return 1;
    const waId = first.comment.id;

    const staffReply = await repliesApi.createStaffReply({
      commentId: waId,
      staffId,
      body: "同事回覆唔應該做標題",
    });
    const third = wa.routeWhatsAppInbound({
      toPhone: "85221740001",
      fromPhone: "85290007701",
      body: "WA 客戶最新一句",
      externalId: "wamid.PREVIEW-3",
      authorName: "陳生",
    });
    const staffLast = await repliesApi.createStaffReply({
      commentId: waId,
      staffId,
      body: "同事最後回覆",
    });
    check(
      "同事回覆之後客戶再留言仍然同一個 ID",
      staffReply.ok && third.ok && third.comment.id === waId && third.appended === true && staffLast.ok
    );

    const waRow = comments.getComment(waId);
    check(
      "列表資料：內容係客戶最新一句，第一句同同事回覆留喺原位",
      !!waRow &&
        comments.latestCustomerMessageText(waRow) === "WA 客戶最新一句" &&
        waRow.body === "WA 第一句" &&
        waRow.latest_inbound_body === "WA 客戶最新一句" &&
        waRow.last_reply_direction === "outbound" &&
        (waRow.last_reply_body || "").includes("同事最後回覆"),
      waRow ? `preview=${comments.latestCustomerMessageText(waRow)} last=${waRow.last_reply_body}` : "missing"
    );

    const fb1 = site.upsertSiteComment({
      source: "facebook",
      external_id: "fb-preview-1",
      author_name: "FB Preview",
      body: "FB 第一句文字",
      meta_sender_id: "psid-preview-1",
      meta_surface: "message",
    });
    const fb2 = site.upsertSiteComment({
      source: "facebook",
      external_id: "fb-preview-2",
      author_name: "FB Preview",
      body: "［語音］",
      meta_sender_id: "psid-preview-1",
      meta_surface: "message",
    });
    check(
      "Facebook 語音跟進用同一個 ID，內容係［語音］",
      fb1.ok && fb2.ok && fb2.comment.id === fb1.comment.id && fb2.appended === true && comments.latestCustomerMessageText(fb2.comment) === "［語音］"
    );

    const ig1 = site.upsertSiteComment({
      source: "instagram",
      external_id: "ig-preview-1",
      author_name: "IG Preview",
      body: "IG 第一句",
      meta_sender_id: "igsid-preview-1",
      meta_surface: "message",
    });
    const ig2 = site.upsertSiteComment({
      source: "instagram",
      external_id: "ig-preview-2",
      author_name: "IG Preview",
      body: "IG 客戶最新私訊",
      meta_sender_id: "igsid-preview-1",
      meta_surface: "message",
    });
    check(
      "Instagram 跟進用同一個 ID，內容係最新私訊",
      ig1.ok && ig2.ok && ig2.comment.id === ig1.comment.id && comments.latestCustomerMessageText(ig2.comment) === "IG 客戶最新私訊"
    );

    const web1 = site.upsertSiteComment({
      source: "glorious_web",
      external_id: "gw-preview-1",
      author_name: "官網客",
      body: "官網第一句",
    });
    const web2 = site.upsertSiteComment({
      source: "glorious_web",
      external_id: "gw-preview-2",
      author_name: "官網客",
      body: "官網客戶最新一句",
    });
    check(
      "官網跟進用同一個 ID，內容係最新一句",
      web1.ok && web2.ok && web2.comment.id === web1.comment.id && comments.latestCustomerMessageText(web2.comment) === "官網客戶最新一句"
    );

    const only = site.upsertSiteComment({
      source: "28car",
      external_id: "car-preview-1",
      author_name: "車盤客",
      body: "28 只有第一句",
      entry_path: "28car_board",
    });
    check(
      "未有再留言就顯示原本那句",
      only.ok && only.created === true && comments.latestCustomerMessageText(only.comment) === "28 只有第一句" && only.comment.latest_inbound_body == null
    );

    const longBody = `最新長句${"甲".repeat(90)}`;
    const long1 = site.upsertSiteComment({
      source: "28car",
      external_id: "car-long-1",
      author_name: "長文客",
      body: "短句開頭",
      entry_path: "28car_board",
    });
    const long2 = site.upsertSiteComment({
      source: "28car",
      external_id: "car-long-2",
      author_name: "長文客",
      body: longBody,
      entry_path: "28car_board",
    });
    const longPreview = comments.latestCustomerMessageText(long2.ok ? long2.comment : { body: "", created_at: "", latest_inbound_body: null, latest_inbound_at: null });
    check(
      "最新長句全文仍然係客戶再留言，截斷只發生喺列表",
      long1.ok && long2.ok && long2.comment.id === long1.comment.id && longPreview === longBody,
      longPreview.slice(0, 20)
    );

    const fixed = appDb
      .prepare(
        `INSERT INTO comments (
           source, external_id, author_name, body, status, assignee_staff_id, intake_kind,
           created_at, updated_at
         ) VALUES ('glorious_web', 'fixed-preview', '固定客', '固定第一句', 'open', ?, 'site_comment', ?, ?)`
      )
      .run(staffId, FIXED_CREATED, FIXED_CREATED);
    const fixedId = Number(fixed.lastInsertRowid);
    appDb
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
         VALUES (?, NULL, 'inbound', '固定客戶最新', 'stored', ?)`
      )
      .run(fixedId, FIXED_INBOUND);
    appDb
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
         VALUES (?, ?, 'outbound', '固定同事回覆', 'stub', ?)`
      )
      .run(fixedId, staffId, FIXED_STAFF);
    const fixedRow = comments.getComment(fixedId);
    check(
      "同事係最後活動時，內容仍然係客戶最新一句",
      !!fixedRow && comments.latestCustomerMessageText(fixedRow) === "固定客戶最新" && fixedRow.last_reply_body === "固定同事回覆"
    );

    const older = appDb
      .prepare(
        `INSERT INTO comments (
           source, external_id, author_name, body, status, assignee_staff_id, intake_kind,
           created_at, updated_at
         ) VALUES ('glorious_web', 'older-inbound', '舊句客', '較新嘅客戶句', 'open', ?, 'site_comment', ?, ?)`
      )
      .run(staffId, OLDER_CREATED, OLDER_CREATED);
    const olderId = Number(older.lastInsertRowid);
    appDb
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
         VALUES (?, NULL, 'inbound', '較舊嘅再留言', 'stored', ?)`
      )
      .run(olderId, OLDER_INBOUND);
    const olderRow = comments.getComment(olderId);
    check(
      "再留言比原本那句舊，內容用較新嘅客戶句",
      !!olderRow && comments.latestCustomerMessageText(olderRow) === "較新嘅客戶句"
    );

    const tied = appDb
      .prepare(
        `INSERT INTO comments (
           source, external_id, author_name, body, status, assignee_staff_id, intake_kind,
           created_at, updated_at
         ) VALUES ('glorious_web', 'tie-preview', '同秒客', '主體句', 'open', ?, 'site_comment', '2026-11-03 01:00:00', '2026-11-03 01:00:00')`
      )
      .run(staffId);
    const tiedId = Number(tied.lastInsertRowid);
    const tieAt = "2026-11-03 02:00:00";
    appDb
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
         VALUES (?, NULL, 'inbound', '同一秒先寫', 'stored', ?)`
      )
      .run(tiedId, tieAt);
    appDb
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
         VALUES (?, NULL, 'inbound', '同一秒後寫', 'stored', ?)`
      )
      .run(tiedId, tieAt);
    const tiedRow = comments.getComment(tiedId);
    check("同一秒兩句再留言，用較後寫入嗰句", !!tiedRow && tiedRow.latest_inbound_body === "同一秒後寫");

    const listed = comments.listComments();
    const listedIds = listed.map((row) => row.id);
    check("列表冇因為再留言而重複 ID", new Set(listedIds).size === listedIds.length && listedIds.includes(waId));

    comments.updateStatus(waId, "done");
    const afterDone = wa.routeWhatsAppInbound({
      toPhone: "85221740001",
      fromPhone: "85290007701",
      body: "完成之後新查詢",
      externalId: "wamid.PREVIEW-4",
      authorName: "陳生",
    });
    const doneRow = comments.getComment(waId);
    check(
      "已完成之後先開新 ID，舊內容仍然係完成前客戶最新一句",
      afterDone.ok &&
        afterDone.created === true &&
        afterDone.comment.id !== waId &&
        doneRow?.status === "done" &&
        comments.latestCustomerMessageText(doneRow) === "WA 客戶最新一句" &&
        comments.latestCustomerMessageText(afterDone.comment) === "完成之後新查詢"
    );

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use(
      session({
        secret: "preview-demo",
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
    const login = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "tony", password: DEMO_PASSWORD }),
    });
    const cookie = cookieHeader(login);
    check("Tony 可以登入", login.status === 302 && cookie.includes("connect.sid="));

    const inbox = await fetch(`${base}/`, { headers: { cookie } });
    const inboxHtml = await inbox.text();
    const fixedHtml = rowHtml(inboxHtml, fixedId);
    const fixedTitle = contentPreview(fixedHtml);
    check(
      "留言箱列標題係客戶最新一句，唔係同事回覆",
      inbox.status === 200 && fixedTitle === "固定客戶最新" && fixedHtml.includes("固定同事回覆") && fixedHtml.includes("最新回覆"),
      fixedTitle || `status=${inbox.status}`
    );
    check(
      "時間欄仍然係香港時間，唔顯示 UTC 儲存",
      fixedHtml.includes(FIXED_CREATED_HKT) &&
        fixedHtml.includes(`datetime="2026-11-03T10:00:00+08:00"`) &&
        !inboxHtml.includes(FIXED_CREATED) &&
        !inboxHtml.includes(FIXED_INBOUND) &&
        !inboxHtml.includes(FIXED_STAFF)
    );

    const fbHtml = fb1.ok ? rowHtml(inboxHtml, fb1.comment.id) : "";
    check("Facebook 列標題跟最新語音", contentPreview(fbHtml) === "［語音］" && !contentPreview(fbHtml).includes("FB 第一句文字"));
    const igHtml = ig1.ok ? rowHtml(inboxHtml, ig1.comment.id) : "";
    check("Instagram 列標題跟最新私訊", contentPreview(igHtml) === "IG 客戶最新私訊");
    const webHtml = web1.ok ? rowHtml(inboxHtml, web1.comment.id) : "";
    check("官網列標題跟最新一句", contentPreview(webHtml) === "官網客戶最新一句");
    const onlyHtml = only.ok ? rowHtml(inboxHtml, only.comment.id) : "";
    check("只有一句時列標題係嗰句", contentPreview(onlyHtml) === "28 只有第一句");
    const longHtml = long1.ok ? rowHtml(inboxHtml, long1.comment.id) : "";
    check(
      "列標題長句截斷",
      contentPreview(longHtml) === `${longBody.slice(0, 80)}…` && !contentPreview(longHtml).includes("短句開頭")
    );
    const olderHtml = rowHtml(inboxHtml, olderId);
    check(
      "較舊再留言唔會蓋過較新嘅客戶句，時間仍係建立時間",
      contentPreview(olderHtml) === "較新嘅客戶句" && olderHtml.includes(OLDER_CREATED_HKT)
    );
    const waHtml = rowHtml(inboxHtml, waId);
    check("WhatsApp 列標題係客戶最新一句", contentPreview(waHtml) === "WA 客戶最新一句" && waHtml.includes(`>#${waId}<`));
    check(
      "同一個 WhatsApp 客人完成前只有一個列",
      inboxHtml.split("<tr>").filter((part) => part.includes(`href="/comments/${waId}"`)).length === 1
    );

    const api = await fetch(`${base}/api/comments`, { headers: { cookie, accept: "application/json" } });
    const body = (await api.json()) as {
      time_zone?: string;
      comments?: Array<{
        id: number;
        created_at?: string;
        latest_inbound_at?: string | null;
        latest_inbound_body?: string | null;
        body?: string;
      }>;
    };
    const apiFixed = body.comments?.find((row) => row.id === fixedId);
    const apiOlder = body.comments?.find((row) => row.id === olderId);
    check(
      "API 列表時間係香港鐘面，客戶最新一句同第一句分開",
      api.status === 200 &&
        body.time_zone === "Asia/Hong_Kong" &&
        apiFixed?.created_at === FIXED_CREATED_HKT &&
        apiFixed?.latest_inbound_at === FIXED_INBOUND_HKT &&
        apiFixed?.latest_inbound_body === "固定客戶最新" &&
        apiFixed?.body === "固定第一句" &&
        apiOlder?.created_at === OLDER_CREATED_HKT &&
        apiOlder?.latest_inbound_at === OLDER_INBOUND_HKT
    );
  } finally {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    try {
      appDb?.close();
    } catch {
      // 檔案清理失敗唔影響斷言。
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`\n${failures.length} 項失敗`);
    return 1;
  }
  console.log("\n留言箱客戶最新內容通過");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
