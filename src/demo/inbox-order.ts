/**
 * 留言箱：未處理，同埋處理中但有未覆客戶新回覆嘅，排最上面。
 * 其他處理中居中。已完成沉底，唔會因為客戶再留言而重開或標「新回覆」。
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
  const needle = new RegExp(`href="/comments/${id}(?:#|")`);
  const part = html.split("<tr>").find((item) => needle.test(item)) ?? "";
  const end = part.indexOf("</tr>");
  return end === -1 ? part : part.slice(0, end);
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
    check("未處理即使有客戶新訊息都唔標新回覆", comments.getComment(openOldId)?.new_customer_reply === false);

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
    check(
      "處理中但未有客戶再留言唔標新回覆",
      comments.getComment(repliedId)?.status === "in_progress" && comments.getComment(repliedId)?.new_customer_reply === false
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
    check("已完成有客戶再留言都唔標新回覆", doneAfterCustomer?.new_customer_reply === false);

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
    check("同事已覆客戶再留言嘅處理中唔標新回覆", comments.getComment(threadId)?.new_customer_reply === false);

    const wing = appDb
      .prepare(
        `INSERT INTO staff (username, display_name, password_hash, is_admin, active)
         VALUES ('wing', 'Wing Chan', ?, 0, 1)`
      )
      .run(hash);
    const wingId = Number(wing.lastInsertRowid);
    const attn = appDb.prepare(
      `INSERT INTO comments (
         source, external_id, author_name, body, status, assignee_staff_id, intake_kind,
         created_at, updated_at
       ) VALUES ('glorious_web', ?, ?, ?, ?, ?, 'site_comment', ?, ?)`
    );
    const followId = Number(
      attn
        .run("attn-follow", "舊處理中客", "ATTNKEY 舊處理中", "in_progress", wingId, "2026-10-01 00:00:00", "2026-10-01 00:00:00")
        .lastInsertRowid
    );
    const openQuietId = Number(
      attn
        .run("attn-open", "未處理舊客", "ATTNKEY 未處理舊", "open", wingId, "2026-10-15 00:00:00", "2026-10-15 00:00:00")
        .lastInsertRowid
    );
    const answeredRecentId = Number(
      attn
        .run(
          "attn-answered",
          "已覆客",
          "ATTNKEY 已覆處理中",
          "in_progress",
          wingId,
          "2026-11-06 01:00:00",
          "2026-11-06 01:00:00"
        )
        .lastInsertRowid
    );
    const doneFollowId = Number(
      attn
        .run(
          "attn-done",
          "完成再留言客",
          "ATTNKEY 已完成再留言",
          "done",
          wingId,
          "2026-10-02 00:00:00",
          "2026-10-02 00:00:00"
        )
        .lastInsertRowid
    );
    const tieWaitingId = Number(
      attn
        .run(
          "attn-tie-wait",
          "同秒未覆客",
          "ATTNKEY 同秒未覆",
          "in_progress",
          wingId,
          "2026-09-01 00:00:00",
          "2026-09-01 00:00:00"
        )
        .lastInsertRowid
    );
    const tieAnsweredId = Number(
      attn
        .run(
          "attn-tie-done",
          "同秒已覆客",
          "ATTNKEY 同秒已覆",
          "in_progress",
          wingId,
          "2026-09-01 01:00:00",
          "2026-09-01 01:00:00"
        )
        .lastInsertRowid
    );
    const replyAt = appDb.prepare(
      `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
       VALUES (?, ?, ?, ?, 'stored', ?)`
    );
    replyAt.run(followId, wingId, "outbound", "舊同事回覆", "2026-10-01 01:00:00");
    replyAt.run(followId, null, "inbound", "ATTNKEY 客戶新回覆", "2026-11-05 02:00:00");
    replyAt.run(answeredRecentId, wingId, "outbound", "已覆同事回覆", "2026-11-06 03:00:00");
    replyAt.run(doneFollowId, wingId, "outbound", "完成同事回覆", "2026-10-02 01:00:00");
    replyAt.run(doneFollowId, null, "inbound", "ATTNKEY 已完成客戶再留言", "2026-11-07 01:00:00");
    replyAt.run(tieWaitingId, wingId, "outbound", "同秒同事先寫", "2026-09-02 04:00:00");
    replyAt.run(tieWaitingId, null, "inbound", "ATTNKEY 同秒客戶後寫", "2026-09-02 04:00:00");
    replyAt.run(tieAnsweredId, null, "inbound", "ATTNKEY 同秒客戶先寫", "2026-09-03 04:00:00");
    replyAt.run(tieAnsweredId, wingId, "outbound", "同秒同事後寫", "2026-09-03 04:00:00");

    const attnWaiting = [followId, openQuietId, tieWaitingId, answeredRecentId, tieAnsweredId, doneFollowId];
    sameIds(
      comments.listComments({ q: "ATTNKEY" }).map((row) => row.id),
      attnWaiting,
      "未處理同有新回覆嘅處理中排最前；已覆處理中居中；已完成沉底"
    );
    sameIds(
      comments.listComments({ q: "ATTNKEY", status: "in_progress" }).map((row) => row.id),
      [followId, tieWaitingId, answeredRecentId, tieAnsweredId],
      "只睇處理中時，有新回覆嘅仍然排喺已覆處理中上面"
    );
    sameIds(
      comments.listComments({ q: "ATTNKEY", status: "pending" }).map((row) => row.id),
      [followId, openQuietId, tieWaitingId, answeredRecentId, tieAnsweredId],
      "擱置／未處理篩選用同一把次序，已完成唔出現"
    );
    check(
      "處理中有未覆客戶再留言先標新回覆",
      comments.getComment(followId)?.new_customer_reply === true &&
        comments.getComment(tieWaitingId)?.new_customer_reply === true
    );
    const doneFollowRow = comments.getComment(doneFollowId);
    check(
      "未處理、已覆處理中、同秒已覆、已完成都唔標新回覆",
      comments.getComment(openQuietId)?.new_customer_reply === false &&
        comments.getComment(answeredRecentId)?.new_customer_reply === false &&
        comments.getComment(tieAnsweredId)?.new_customer_reply === false &&
        doneFollowRow?.status === "done" &&
        doneFollowRow.new_customer_reply === false &&
        doneFollowRow.latest_inbound_body === "ATTNKEY 已完成客戶再留言"
    );
    check(
      "已覆處理中即使客戶活動較新，都唔會插到未處理或新回覆上面",
      attnWaiting.indexOf(answeredRecentId) > attnWaiting.indexOf(openQuietId) &&
        attnWaiting.indexOf(answeredRecentId) > attnWaiting.indexOf(followId)
    );

    replyAt.run(followId, wingId, "outbound", "同事覆完新回覆", "2026-11-05 03:00:00");
    const attnAnswered = [openQuietId, tieWaitingId, answeredRecentId, followId, tieAnsweredId, doneFollowId];
    sameIds(
      comments.listComments({ q: "ATTNKEY" }).map((row) => row.id),
      attnAnswered,
      "同事覆完客戶最新一句之後，新回覆收起並排返其他處理中"
    );
    check("同事回覆之後唔再標新回覆", comments.getComment(followId)?.new_customer_reply === false);

    replyAt.run(followId, null, "inbound", "ATTNKEY 客戶再問", "2026-11-08 01:00:00");
    sameIds(
      comments.listComments({ q: "ATTNKEY" }).map((row) => row.id),
      attnWaiting,
      "客戶再留言會再標新回覆，並返回最上面"
    );
    check("客戶再留言之後新回覆再出現", comments.getComment(followId)?.new_customer_reply === true);

    comments.updateStatus(followId, "done");
    sameIds(
      comments.listComments({ q: "ATTNKEY" }).map((row) => row.id),
      [openQuietId, tieWaitingId, answeredRecentId, tieAnsweredId, followId, doneFollowId],
      "標已完成會收起新回覆並沉到已完成組，即使客戶最新一句未覆"
    );
    check("改做已完成之後唔再標新回覆", comments.getComment(followId)?.new_customer_reply === false);

    comments.updateStatus(followId, "in_progress");
    sameIds(
      comments.listComments({ q: "ATTNKEY" }).map((row) => row.id),
      attnWaiting,
      "手動改回處理中，客戶最新一句仍未覆就再標新回覆並返回最上面"
    );
    const wingIds = comments
      .listComments({ viewer: { staffId: wingId, isAdmin: false } })
      .map((row) => row.id);
    sameIds(wingIds, attnWaiting, "同事只見到自己嘅留言，次序同管理員一樣");

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
      "留言箱說明需要處理嘅排前，新回覆標記會收起，對話由舊到新",
      inboxHtml.includes("未處理，同埋處理中但有未覆客戶新回覆嘅，排喺最上面") &&
        inboxHtml.includes("其他處理中排喺中間") &&
        inboxHtml.includes("已完成排喺最下面") &&
        inboxHtml.includes("唔會標「新回覆」或抬上去") &&
        inboxHtml.includes("同事回覆本身唔會把留言抬上去") &&
        inboxHtml.includes("由舊到新，第一句喺對話最上面") &&
        !inboxHtml.includes("未處理同處理中排喺已完成上面") &&
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
    check("同事已覆最新客戶一句嘅處理中，詳情頁唔標新回覆", !detailHtml.includes("新回覆"));

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

    const attnPage = await fetch(`${base}/?q=` + encodeURIComponent("ATTNKEY"), { headers: { cookie } });
    const attnHtml = await attnPage.text();
    sameIds(listedIds(attnHtml), attnWaiting, "管理員留言箱搜尋跟新回覆次序");
    const followHtml = rowHtml(attnHtml, followId);
    const followWhen = followHtml.match(/<td class="when">([\s\S]*?)<\/td>/)?.[1] ?? "";
    const followPreview = followHtml.match(/<span class="content-preview">([\s\S]*?)<\/span>/)?.[1] ?? "";
    check(
      "有新回覆嘅處理中喺狀態旁邊標新回覆",
      followHtml.includes("處理中") && followHtml.includes(`class="badge new-reply"`) && followHtml.includes("新回覆"),
      followHtml
    );
    check(
      "新回覆列嘅時間欄仍然係建立時間，內容係客戶最新一句",
      followWhen.includes(`datetime="2026-10-01T08:00:00+08:00"`) && followPreview === "ATTNKEY 客戶再問",
      `${followWhen} ${followPreview}`
    );
    check("同秒未覆嘅處理中都標新回覆", rowHtml(attnHtml, tieWaitingId).includes(`class="badge new-reply"`));
    check("未處理列唔標新回覆", !rowHtml(attnHtml, openQuietId).includes("新回覆"));
    check("已覆處理中列唔標新回覆", !rowHtml(attnHtml, answeredRecentId).includes(`class="badge new-reply"`));
    check("同秒已覆嘅處理中列唔標新回覆", !rowHtml(attnHtml, tieAnsweredId).includes(`class="badge new-reply"`));
    check("已完成有客戶再留言都唔喺列表標新回覆", !rowHtml(attnHtml, doneFollowId).includes(`class="badge new-reply"`));

    const followDetail = await fetch(`${base}/comments/${followId}`, { headers: { cookie } });
    const followDetailHtml = await followDetail.text();
    check(
      "留言詳情同樣標新回覆",
      followDetail.status === 200 && followDetailHtml.includes(`class="badge new-reply"`) && followDetailHtml.includes("新回覆")
    );
    const doneDetail = await fetch(`${base}/comments/${doneFollowId}`, { headers: { cookie } });
    const doneDetailHtml = await doneDetail.text();
    check("已完成詳情唔標新回覆", doneDetail.status === 200 && !doneDetailHtml.includes("新回覆"));

    const attnApi = await fetch(`${base}/api/comments?q=` + encodeURIComponent("ATTNKEY"), {
      headers: { cookie, accept: "application/json" },
    });
    const attnApiJson = (await attnApi.json()) as {
      comments?: Array<{ id: number; new_customer_reply?: boolean }>;
    };
    const attnApiRows = attnApiJson.comments ?? [];
    sameIds(
      attnApiRows.map((row) => row.id),
      attnWaiting,
      "API 搜尋跟新回覆次序"
    );
    const apiFollow = attnApiRows.find((row) => row.id === followId);
    const apiDone = attnApiRows.find((row) => row.id === doneFollowId);
    check(
      "API 只對未覆嘅處理中標新回覆",
      apiFollow?.new_customer_reply === true && apiDone?.new_customer_reply === false
    );

    const wingLogin = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "wing", password: DEMO_PASSWORD }),
    });
    const wingCookie = cookieHeader(wingLogin);
    check("同事可以登入", wingLogin.status === 302 && wingCookie.includes("connect.sid="));
    const wingPage = await fetch(`${base}/`, { headers: { cookie: wingCookie } });
    const wingHtml = await wingPage.text();
    sameIds(listedIds(wingHtml), attnWaiting, "同事嘅留言箱用同一把次序");
    check(
      "同事見到同一個新回覆標記，而且只係自己嘅留言",
      wingHtml.includes("你只會見到派咗畀你嘅留言") &&
        rowHtml(wingHtml, followId).includes(`class="badge new-reply"`) &&
        !rowHtml(wingHtml, doneFollowId).includes(`class="badge new-reply"`) &&
        !wingHtml.includes("ORDERKEY")
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
