/**
 * 同事見到嘅時間係香港時間（Asia/Hong_Kong）。
 * 資料庫 created_at 仍然係 UTC 文字。28car 頁面抓返嚟嘅鐘面唔再加 8 小時。
 * 用臨時 SQLite，唔會郁到正式 data/inbox.db。
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type Database from "better-sqlite3";
import { formatStaffTimestamp, parseStoredTimestamp, relativeStaffLabel } from "../time";
import { translateSql } from "../db/sql-compat";

const failures: string[] = [];
const DEMO_PASSWORD = "Glorious2026!";
const STORED_UTC = "2026-11-03 02:00:00";
const EXPECT_HKT = "2026-11-03 10:00:00 HKT";
const REPLY_UTC = "2026-11-02 16:30:00";
const REPLY_HKT = "2026-11-03 00:30:00 HKT";
const BOARD_WALL = "2026-10-23 18:02:11";
const LISTING_DATE = "2026-10-23";

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

function clockCases(): void {
  check(
    "UTC 文字加 8 小時變成香港鐘面",
    formatStaffTimestamp(STORED_UTC, "utc") === EXPECT_HKT,
    formatStaffTimestamp(STORED_UTC, "utc")
  );
  check(
    "跨日：UTC 16:00 係香港翌日 00:00，唔係 24:00",
    formatStaffTimestamp("2026-11-03 16:00:00", "utc") === "2026-11-04 00:00:00 HKT"
  );
  check(
    "ISO Z 同樣轉做香港時間",
    formatStaffTimestamp("2026-11-03T02:00:00Z", "utc") === EXPECT_HKT
  );
  check(
    "已經帶 +08:00 嘅瞬間唔會再加 8 小時",
    formatStaffTimestamp("2026-11-03T10:00:00+08:00", "utc") === EXPECT_HKT
  );
  check(
    "28car 留言時間係香港鐘面，維持 18:02",
    formatStaffTimestamp(BOARD_WALL, "hkt") === `${BOARD_WALL} HKT`,
    formatStaffTimestamp(BOARD_WALL, "hkt")
  );
  check(
    "28car 車盤日期只有年月日，唔會變成 08:00",
    formatStaffTimestamp(LISTING_DATE, "hkt") === LISTING_DATE
  );
  check("認唔到嘅字串原樣返回", formatStaffTimestamp("下晝三點", "utc") === "下晝三點");

  const instant = parseStoredTimestamp(STORED_UTC, "utc");
  check("可以解析 UTC 儲存", instant != null);
  if (instant) {
    const justNow = new Date(instant.getTime() + 10_000);
    check("十秒內係剛剛", relativeStaffLabel(instant, justNow) === "剛剛");
    const halfHour = new Date(instant.getTime() + 30 * 60_000);
    check("三十分鐘係分鐘前", relativeStaffLabel(instant, halfHour) === "30 分鐘前");
    const sameAfternoon = new Date(instant.getTime() + 3 * 60 * 60_000);
    check(
      "同一個香港日係小時前",
      formatStaffTimestamp(STORED_UTC, "utc", { relative: true, now: sameAfternoon }) ===
        `${EXPECT_HKT}（3 小時前）`
    );
    const hkYesterday = parseStoredTimestamp("2026-11-02 15:00:00", "utc");
    const hkAfterMidnight = parseStoredTimestamp("2026-11-02 17:30:00", "utc");
    check(
      "跨過香港午夜係昨天，唔係按 UTC 日",
      !!hkYesterday &&
        !!hkAfterMidnight &&
        relativeStaffLabel(hkYesterday, hkAfterMidnight) === "昨天",
      hkYesterday && hkAfterMidnight ? relativeStaffLabel(hkYesterday, hkAfterMidnight) : "parse"
    );
  }

  const sql = translateSql("UPDATE comments SET updated_at = datetime('now') WHERE id = ?");
  check(
    "資料庫 SQL 仍然寫 UTC 文字，唔係香港時間",
    sql.includes("AT TIME ZONE 'UTC'") && sql.includes("HH24:MI:SS") && !sql.includes("Asia/Hong_Kong")
  );
}

async function pageCases(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-hkt-"));
  const dbFile = path.join(tmp, "inbox.db");
  let appDb: Database.Database | undefined;
  let server: Server | undefined;

  try {
    process.env.INBOX_DB = "sqlite";
    process.env.DATABASE_PATH = dbFile;
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as typeof import("../db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const passwords = require("../auth/passwords") as typeof import("../auth/passwords");
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
    const comment = appDb
      .prepare(
        `INSERT INTO comments (
           source, external_id, author_name, body, status, assignee_staff_id, intake_kind,
           created_at, updated_at
         ) VALUES ('28car', 'hkt-demo', '陳先生', '想問 Alphard 星期六', 'open', ?, 'site_comment', ?, ?)`
      )
      .run(staffId, STORED_UTC, STORED_UTC);
    const commentId = Number(comment.lastInsertRowid);
    appDb
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
         VALUES (?, ?, 'outbound', '星期六可以嚟睇', 'stub', ?)`
      )
      .run(commentId, staffId, REPLY_UTC);
    appDb
      .prepare(
        `INSERT INTO car_listings (
           stock_id, account_username, title, listing_updated_at, last_synced_at, active
         ) VALUES ('s2806213', 'demo', 'Alphard', ?, ?, 1)`
      )
      .run(LISTING_DATE, STORED_UTC);
    appDb
      .prepare(
        `INSERT INTO car_listing_messages (stock_id, external_id, author_name, body, is_seller, posted_at)
         VALUES ('s2806213', 'board-1', '買家', '可唔可以睇車', 0, ?)`
      )
      .run(BOARD_WALL);

    const stored = appDb.prepare(`SELECT created_at, updated_at FROM comments WHERE id = ?`).get(commentId) as {
      created_at: string;
      updated_at: string;
    };
    check("入庫之後 created_at 仍然係 UTC", stored.created_at === STORED_UTC && stored.updated_at === STORED_UTC);

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use(
      session({
        secret: "hkt-demo",
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
    check(
      "留言箱顯示香港時間，唔顯示 UTC 儲存",
      inbox.status === 200 &&
        inboxHtml.includes("時間（HKT）") &&
        inboxHtml.includes(EXPECT_HKT) &&
        inboxHtml.includes(`datetime="2026-11-03T10:00:00+08:00"`) &&
        !inboxHtml.includes(STORED_UTC),
      inbox.status === 200 ? "html" : String(inbox.status)
    );
    check(
      "留言箱相對時間用香港鐘",
      /2026-11-03 10:00:00 HKT（(?:剛剛|\d+ 分鐘前|\d+ 小時前|昨天)）/.test(inboxHtml)
    );

    const detail = await fetch(`${base}/comments/${commentId}`, { headers: { cookie } });
    const detailHtml = await detail.text();
    check(
      "留言詳情建立同回覆都係香港時間",
      detail.status === 200 &&
        detailHtml.includes(EXPECT_HKT) &&
        detailHtml.includes(REPLY_HKT) &&
        detailHtml.includes(`datetime="2026-11-03T00:30:00+08:00"`) &&
        !detailHtml.includes(STORED_UTC) &&
        !detailHtml.includes(REPLY_UTC)
    );

    const listingPage = await fetch(`${base}/28car/s2806213`, { headers: { cookie } });
    const listingHtml = await listingPage.text();
    check(
      "28car 留言板時間唔再加 8 小時",
      listingPage.status === 200 &&
        listingHtml.includes(`${BOARD_WALL} HKT`) &&
        listingHtml.includes(LISTING_DATE) &&
        !listingHtml.includes("2026-10-24 02:02:11")
    );

    const api = await fetch(`${base}/api/comments/${commentId}`, { headers: { cookie, accept: "application/json" } });
    const body = (await api.json()) as {
      time_zone?: string;
      comment?: { created_at?: string; updated_at?: string };
      replies?: Array<{ created_at?: string }>;
    };
    check(
      "API 留言時間係香港鐘面，而且標明時區",
      api.status === 200 &&
        body.time_zone === "Asia/Hong_Kong" &&
        body.comment?.created_at === EXPECT_HKT &&
        body.comment?.updated_at === EXPECT_HKT &&
        body.replies?.[0]?.created_at === REPLY_HKT
    );

    const board = await fetch(`${base}/api/28car/listings/s2806213`, {
      headers: { cookie, accept: "application/json" },
    });
    const boardJson = (await board.json()) as {
      listing?: { listing_updated_at?: string; last_synced_at?: string };
      messages?: Array<{ posted_at?: string }>;
    };
    check(
      "API 28car：同步時間轉 HKT，留言板鐘面唔加 8 小時",
      board.status === 200 &&
        boardJson.listing?.listing_updated_at === LISTING_DATE &&
        boardJson.listing?.last_synced_at === EXPECT_HKT &&
        boardJson.messages?.[0]?.posted_at === `${BOARD_WALL} HKT`
    );

    const after = appDb.prepare(`SELECT created_at FROM comments WHERE id = ?`).get(commentId) as { created_at: string };
    check("睇完頁面之後資料庫仍然係 UTC", after.created_at === STORED_UTC);
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
}

async function main(): Promise<number> {
  clockCases();
  await pageCases();
  if (failures.length) {
    console.error(`\n${failures.length} 項失敗`);
    return 1;
  }
  console.log("\n香港時間顯示通過");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
