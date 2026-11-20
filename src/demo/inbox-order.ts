/**
 * 留言箱：未處理同處理中排喺已完成上面，組內按客戶最新活動。
 * 同事回覆唔會抬上去。對話頁由舊到新。
 * 用臨時 SQLite，唔會郁到正式 data/inbox.db。
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

function sameIds(actual: number[], expected: number[], label: string): void {
  check(label, actual.length === expected.length && actual.every((id, index) => id === expected[index]), actual.join(","));
}

function listedIds(html: string): number[] {
  const body = html.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
  const ids: number[] = [];
  const seen = new Set<number>();
  const re = /href="\/comments\/(\d+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const id = Number(match[1]);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function bubbleBodies(html: string): string[] {
  const out: string[] = [];
  const re = /<div class="bubble-body">([\s\S]*?)<\/div>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) out.push(match[1] ?? "");
  return out;
}

function rowHtml(html: string, id: number): string {
  const needle = `href="/comments/${id}"`;
  return html.split("<tr>").find((part) => part.includes(needle)) ?? "";
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-order-"));
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

    const insert = appDb.prepare(
      `INSERT INTO comments (
         source, external_id, author_name, body, status, assignee_staff_id, intake_kind,
         created_at, updated_at
       ) VALUES ('glorious_web', ?, ?, ?, ?, ?, 'site_comment', ?, ?)`
    );
    const openOldId = Number(
      insert.run("order-open-old", "舊客", "ORDERKEY 未處理舊", "open", staffId, "2026-11-01 01:00:00", "2026-11-01 01:00:00")
        .lastInsertRowid
    );
    const openNewId = Number(
      insert.run("order-open-new", "新客", "ORDERKEY 未處理新", "open", staffId, "2026-11-01 03:00:00", "2026-11-01 01:00:00")
        .lastInsertRowid
    );
    const repliedId = Number(
      insert.run(
        "order-replied",
        "回覆客",
        "ORDERKEY 舊建立",
        "in_progress",
        staffId,
        "2026-11-01 00:00:00",
        "2026-11-01 00:00:00"
      ).lastInsertRowid
    );
    const doneId = Number(
      insert.run("order-done", "完成客", "ORDERKEY 已完成", "done", staffId, "2026-11-01 00:30:00", "2026-11-01 00:30:00")
        .lastInsertRowid
    );
    const olderInboundId = Number(
      insert.run(
        "order-older-inbound",
        "舊再留言客",
        "ORDERKEY 再留言較舊",
        "open",
        staffId,
        "2026-11-01 03:30:00",
        "2026-11-01 03:00:00"
      ).lastInsertRowid
    );
    appDb
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
         VALUES (?, ?, 'outbound', '同事新回覆', 'stub', '2026-11-01 05:00:00')`
      )
      .run(repliedId, staffId);
    appDb
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
         VALUES (?, ?, 'outbound', '已完成同事回覆', 'stub', '2026-11-01 04:00:00')`
      )
      .run(doneId, staffId);
    appDb
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
         VALUES (?, NULL, 'inbound', '比主體更舊嘅再留言', 'stored', '2026-11-01 03:00:00')`
      )
      .run(olderInboundId);

    const activeThenDone = [olderInboundId, openNewId, openOldId, repliedId, doneId];
    sameIds(
      comments.listComments().map((row) => row.id),
      activeThenDone,
      "未處理同處理中按客戶活動排喺已完成上面；同事回覆唔會抬上去"
    );
    sameIds(
      comments.listComments({ q: "ORDERKEY" }).map((row) => row.id),
      activeThenDone,
      "搜尋用同一把次序"
    );
    sameIds(
      comments.listComments({ status: "open" }).map((row) => row.id),
      [olderInboundId, openNewId, openOldId],
      "未處理篩選仍然只出未處理，而且跟客戶活動時間"
    );
    const repliedBeforeBump = comments.getComment(repliedId);
    check(
      "處理中唔會因為狀態而排喺較新嘅未處理上面",
      repliedBeforeBump?.status === "in_progress" && activeThenDone.indexOf(repliedId) > activeThenDone.indexOf(openOldId)
    );

    const repliedRow = comments.getComment(repliedId);
    check(
      "列標題仍然係客戶那句，唔係同事回覆",
      !!repliedRow && comments.latestCustomerMessageText(repliedRow) === "ORDERKEY 舊建立" && repliedRow.last_reply_body === "同事新回覆"
    );
    const olderRow = comments.getComment(olderInboundId);
    check(
      "再留言比原句舊時，活動時間用原句，唔會被 inbound 拉後",
      !!olderRow &&
        comments.latestCustomerMessageText(olderRow) === "ORDERKEY 再留言較舊" &&
        (olderRow.latest_inbound_at ?? "") < olderRow.created_at
    );

    appDb
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
         VALUES (?, ?, 'outbound', '同事更遲回覆', 'stub', '2026-11-01 08:00:00')`
      )
      .run(openOldId, staffId);
    sameIds(
      comments.listComments({ q: "ORDERKEY" }).map((row) => row.id),
      activeThenDone,
      "同事回覆唔會把未處理抬到最上面"
    );

    appDb.prepare(`INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
      VALUES (?, NULL, 'inbound', '客戶新訊息', 'stored', '2026-11-01 06:00:00')`).run(openOldId);
    const afterCustomer = [openOldId, olderInboundId, openNewId, repliedId, doneId];
    sameIds(
      comments.listComments({ q: "ORDERKEY" }).map((row) => row.id),
      afterCustomer,
      "客戶新訊息把舊建立嘅未處理抬到未完成組最上面"
    );

    comments.updateStatus(repliedId, "done");
    appDb.prepare(`UPDATE comments SET updated_at = '2026-11-01 09:00:00' WHERE id = ?`).run(openNewId);
    const afterMarkedDone = [openOldId, olderInboundId, openNewId, doneId, repliedId];
    sameIds(
      comments.listComments({ q: "ORDERKEY" }).map((row) => row.id),
      afterMarkedDone,
      "標已完成會沉到已完成組，組內仍按客戶活動；只改 updated_at 唔當新訊息"
    );
    comments.reassign(openNewId, staffId);
    sameIds(
      comments.listComments({ q: "ORDERKEY" }).map((row) => row.id),
      afterMarkedDone,
      "只改負責人唔會改次序"
    );

    comments.updateStatus(repliedId, "in_progress");
    sameIds(
      comments.listComments({ q: "ORDERKEY" }).map((row) => row.id),
      afterCustomer,
      "重開做處理中會按客戶活動放返未完成組，唔會因為改狀態而跳到最頂"
    );

    comments.updateStatus(repliedId, "done");
    appDb.prepare(`INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
      VALUES (?, NULL, 'inbound', '已完成之後客戶再留言', 'stored', '2026-11-01 07:00:00')`).run(repliedId);
    const doneAfterCustomer = comments.getComment(repliedId);
    const doneStaysBottom = [openOldId, olderInboundId, openNewId, repliedId, doneId];
    sameIds(
      comments.listComments({ q: "ORDERKEY" }).map((row) => row.id),
      doneStaysBottom,
      "已完成收到客戶再留言仍然留喺已完成組，只係組內按客戶活動排前"
    );
    check(
      "已完成收到客戶再留言時，呢次寫入唔會自動改狀態",
      doneAfterCustomer?.status === "done" && doneAfterCustomer.latest_inbound_body === "已完成之後客戶再留言"
    );

    const freshId = Number(
      insert
        .run("order-fresh", "新開客", "ORDERKEY 全新未回覆", "open", staffId, "2026-11-01 11:00:00", "2026-11-01 11:00:00")
        .lastInsertRowid
    );
    const withFresh = [freshId, openOldId, olderInboundId, openNewId, repliedId, doneId];
    sameIds(
      comments.listComments({ q: "ORDERKEY" }).map((row) => row.id),
      withFresh,
      "未有回覆嘅新留言排喺未完成組最上面"
    );
    const allIds = comments.listComments().map((row) => row.id);
    const searchIds = comments.listComments({ q: "ORDERKEY" }).map((row) => row.id);
    const searchSet = new Set(searchIds);
    sameIds(
      allIds.filter((id) => searchSet.has(id)),
      searchIds,
      "主列表入面相符留言嘅相對次序同搜尋一樣"
    );

    const tieLowId = Number(
      insert.run("order-tie-low", "同秒甲", "TIEKEY 先寫", "open", staffId, "2026-11-04 01:00:00", "2026-11-04 01:00:00")
        .lastInsertRowid
    );
    const tieHighId = Number(
      insert.run("order-tie-high", "同秒乙", "TIEKEY 後寫", "open", staffId, "2026-11-04 01:00:00", "2026-11-04 01:00:00")
        .lastInsertRowid
    );
    sameIds(
      comments.listComments({ q: "TIEKEY" }).map((row) => row.id),
      [tieHighId, tieLowId],
      "活動時間相同時，較後建立嘅留言先"
    );

    const threadId = Number(
      insert.run("order-thread", "對話客", "主體句", "in_progress", staffId, "2026-11-02 01:00:00", "2026-11-02 01:00:00")
        .lastInsertRowid
    );
    const replyInsert = appDb.prepare(
      `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
       VALUES (?, ?, ?, ?, 'stored', ?)`
    );
    replyInsert.run(threadId, null, "inbound", "比主體更舊", "2026-11-02 00:30:00");
    replyInsert.run(threadId, null, "inbound", "客戶再留言", "2026-11-02 02:00:00");
    replyInsert.run(threadId, staffId, "outbound", "同事最新", "2026-11-02 03:00:00");
    replyInsert.run(threadId, staffId, "outbound", "同一秒先寫", "2026-11-02 04:00:00");
    replyInsert.run(threadId, staffId, "outbound", "同一秒後寫", "2026-11-02 04:00:00");

    const apiReplies = repliesApi.listReplies(threadId).map((row) => row.body);
    check(
      "API 回覆陣列由舊到新",
      apiReplies.join("|") === ["比主體更舊", "客戶再留言", "同事最新", "同一秒先寫", "同一秒後寫"].join("|"),
      apiReplies.join("|")
    );

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use(
      session({
        secret: "order-demo",
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

    const inbox = await fetch(`${base}/?q=` + encodeURIComponent("ORDERKEY"), { headers: { cookie } });
    const inboxHtml = await inbox.text();
    sameIds(listedIds(inboxHtml), withFresh, "留言箱網頁搜尋結果跟主列表次序");
    check(
      "留言箱說明未完成排前，同事回覆唔會抬上去，對話由舊到新",
      inboxHtml.includes("未處理同處理中排喺已完成上面") &&
        inboxHtml.includes("同事回覆唔會") &&
        inboxHtml.includes("由舊到新，第一句喺對話最上面") &&
        !inboxHtml.includes("同事新回覆都會放到最上面") &&
        !inboxHtml.includes("最新一句喺對話最上面")
    );
    const repliedHtml = rowHtml(inboxHtml, repliedId);
    const whenCell = repliedHtml.match(/<td class="when">([\s\S]*?)<\/td>/)?.[1] ?? "";
    const preview = repliedHtml.match(/<span class="content-preview">([\s\S]*?)<\/span>/)?.[1] ?? "";
    check(
      "時間欄仍然係建立時間，唔係同事回覆或客戶再留言時間",
      whenCell.includes(`datetime="2026-11-01T08:00:00+08:00"`) &&
        !whenCell.includes("13:00:00") &&
        !whenCell.includes("15:00:00") &&
        !whenCell.includes("16:00:00"),
      whenCell
    );
    check(
      "網頁列標題仍然係客戶最新一句，唔係同事回覆",
      preview === "已完成之後客戶再留言" && !repliedHtml.includes("同事新回覆") && !repliedHtml.includes("同事更遲回覆"),
      preview
    );
    const freshHtml = rowHtml(inboxHtml, freshId);
    const freshWhen = freshHtml.match(/<td class="when">([\s\S]*?)<\/td>/)?.[1] ?? "";
    const freshPreview = freshHtml.match(/<span class="content-preview">([\s\S]*?)<\/span>/)?.[1] ?? "";
    check(
      "新留言時間欄係建立時間，內容係客戶原句",
      freshWhen.includes(`datetime="2026-11-01T19:00:00+08:00"`) && freshPreview === "ORDERKEY 全新未回覆",
      `${freshWhen} ${freshPreview}`
    );

    const home = await fetch(`${base}/`, { headers: { cookie } });
    const homeHtml = await home.text();
    const homeOrderKey = listedIds(homeHtml).filter((id) => withFresh.includes(id));
    sameIds(homeOrderKey, withFresh, "主列表入面相符留言嘅相對次序同搜尋頁一樣");

    const detail = await fetch(`${base}/comments/${threadId}`, { headers: { cookie } });
    const detailHtml = await detail.text();
    const bubbles = bubbleBodies(detailHtml);
    check(
      "對話頁由舊到新，原句喺最上面，同一秒較先寫入先",
      detail.status === 200 &&
        bubbles.join("|") === ["主體句", "比主體更舊", "客戶再留言", "同事最新", "同一秒先寫", "同一秒後寫"].join("|"),
      bubbles.join("|")
    );
    check("有回覆時唔再寫未有同事回覆", !detailHtml.includes("未有同事回覆"));

    const quiet = await fetch(`${base}/comments/${openNewId}`, { headers: { cookie } });
    const quietHtml = await quiet.text();
    const quietBubbles = bubbleBodies(quietHtml);
    check(
      "未有回覆時仍然顯示原句，並寫未有同事回覆",
      quiet.status === 200 && quietBubbles.join("|") === "ORDERKEY 未處理新" && quietHtml.includes("未有同事回覆"),
      quietBubbles.join("|")
    );

    const apiList = await fetch(`${base}/api/comments?q=` + encodeURIComponent("ORDERKEY"), {
      headers: { cookie, accept: "application/json" },
    });
    const apiJson = (await apiList.json()) as { comments?: Array<{ id: number }> };
    sameIds(
      (apiJson.comments ?? []).map((row) => row.id),
      withFresh,
      "API 留言列表跟主列表次序"
    );

    const apiThread = await fetch(`${base}/api/comments/${threadId}/replies`, {
      headers: { cookie, accept: "application/json" },
    });
    const apiThreadJson = (await apiThread.json()) as { replies?: Array<{ body?: string }> };
    const apiBodies = (apiThreadJson.replies ?? []).map((row) => row.body ?? "");
    check(
      "留言 API 回覆仍然由舊到新",
      apiThread.status === 200 &&
        apiBodies.join("|") === ["比主體更舊", "客戶再留言", "同事最新", "同一秒先寫", "同一秒後寫"].join("|"),
      apiBodies.join("|")
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
  console.log("\n留言箱次序通過");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
