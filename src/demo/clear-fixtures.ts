/**
 * 臨時 SQLite：示範 seed 可以清走，真實 wamid／28car／唔喺清單嘅 id 會留低。
 * 正式環境拒絕再寫示範留言。
 */
import fs from "fs";
import os from "os";
import path from "path";
import { insertReturningId, translateSql } from "../db/sql-compat";

const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) {
    const line = detail ? `${name} — ${detail}` : name;
    failures.push(line);
    console.error(`FAIL ${line}`);
    return;
  }
  console.log(`OK   ${name}`);
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-clear-"));
  const dbFile = path.join(tmp, "inbox.db");
  const previousNodeEnv = process.env.NODE_ENV;
  delete process.env.ALLOW_DEMO_SEED;
  delete process.env.NODE_ENV;
  process.env.INBOX_DB = "sqlite";
  process.env.DATABASE_PATH = dbFile;

  try {
    check(
      "SQL ? 轉 $n，字串入面嘅問號唔轉",
      translateSql("SELECT 'it''s ?', a = ? AND b = ?") === "SELECT 'it''s ?', a = $1 AND b = $2"
    );
    check(
      "datetime('now') 轉做 UTC 文字",
      translateSql("UPDATE t SET updated_at = datetime('now') WHERE id = ?").includes("HH24:MI:SS") &&
        translateSql("UPDATE t SET updated_at = datetime('now') WHERE id = ?").includes("$1")
    );
    const messageKeyInsert = `INSERT INTO comment_message_keys (source, external_id, comment_id, reply_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (source, external_id) DO UPDATE SET
       comment_id = excluded.comment_id,
       reply_id = COALESCE(excluded.reply_id, comment_message_keys.reply_id)`;
    check(
      "INSERT 補 RETURNING id，冇 id 欄嘅表唔補",
      insertReturningId("INSERT INTO staff (username) VALUES (?)").endsWith("RETURNING id") &&
        insertReturningId("INSERT INTO comment_replies (comment_id, body) VALUES (?, ?)").endsWith("RETURNING id") &&
        insertReturningId("INSERT INTO car_sync_state (source) VALUES (?)") ===
          "INSERT INTO car_sync_state (source) VALUES (?)" &&
        insertReturningId(messageKeyInsert) === messageKeyInsert &&
        !/\breturning\s+id\b/i.test(translateSql(insertReturningId(messageKeyInsert)))
    );

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as typeof import("../db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const seedMod = require("../db/seed") as typeof import("../db/seed");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const clearMod = require("../db/clear-demo") as typeof import("../db/clear-demo");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const assignMod = require("../services/assign") as typeof import("../services/assign");
    const appDb = dbMod.db;

    check("未設定 DATABASE_URL 時用 SQLite", dbMod.usingPostgres === false);
    await seedMod.seed();
    const demoFb = appDb
      .prepare(`SELECT id FROM comments WHERE source = 'facebook' AND external_id = 'fb-3001'`)
      .get() as { id: number } | undefined;
    check("seed 有示範 Facebook", !!demoFb);
    const beforeHash = (
      appDb.prepare(`SELECT password_hash AS h FROM staff WHERE username = 'wing'`).get() as { h: string }
    ).h;
    appDb.prepare(`UPDATE staff SET password_hash = 'kept-hash' WHERE username = 'wing'`).run();
    seedMod.seedStaff();
    const afterHash = (
      appDb.prepare(`SELECT password_hash AS h FROM staff WHERE username = 'wing'`).get() as { h: string }
    ).h;
    check("seed:staff 唔覆寫已有密碼", afterHash === "kept-hash" && afterHash !== beforeHash);
    const commentsAfterStaff = (
      appDb.prepare(`SELECT COUNT(*) AS n FROM comments`).get() as { n: number }
    ).n;
    check("seed:staff 唔再插入示範留言", commentsAfterStaff >= 1 && !!demoFb);

    appDb
      .prepare(
        `INSERT INTO comments (
           source, external_id, author_name, body, status, intake_kind, origin_site, wa_from_phone, wa_to_phone
         ) VALUES ('whatsapp', 'wamid.LIVE123', '真實客', '真實 WhatsApp', 'open', 'whatsapp_click', NULL, '85290001111', '85221740001')`
      )
      .run();
    appDb
      .prepare(
        `INSERT INTO comments (
           source, external_id, author_name, body, status, intake_kind, entry_path
         ) VALUES ('28car', '28car:s9990001:buyer-77', '真實買家', '留言板真實帖', 'open', 'site_comment', '28car_board')`
      )
      .run();
    appDb
      .prepare(
        `INSERT INTO comments (
           source, external_id, author_name, body, status, intake_kind
         ) VALUES ('facebook', 'fb-not-a-fixture', '真實 FB', '唔好因為 fb- 前綴被刪', 'open', 'site_comment')`
      )
      .run();

    const cleared = clearMod.clearDemoFixtures();
    check("清走至少一則示範留言", cleared.comments_deleted > 0);
    check(
      "示範 fb-3001 已刪",
      !appDb.prepare(`SELECT id FROM comments WHERE external_id = 'fb-3001'`).get()
    );
    check(
      "wamid 留低",
      !!appDb.prepare(`SELECT id FROM comments WHERE external_id = 'wamid.LIVE123'`).get()
    );
    check(
      "真實 28car 留言板留低",
      !!appDb.prepare(`SELECT id FROM comments WHERE external_id = '28car:s9990001:buyer-77'`).get()
    );
    check(
      "唔喺 seed 清單嘅 fb- id 留低",
      !!appDb.prepare(`SELECT id FROM comments WHERE external_id = 'fb-not-a-fixture'`).get()
    );
    const staffLeft = (appDb.prepare(`SELECT COUNT(*) AS n FROM staff`).get() as { n: number }).n;
    check("同事帳號留低", staffLeft >= 4);
    const line = appDb
      .prepare(`SELECT phone_e164 FROM whatsapp_lines WHERE phone_e164 = '85221740001'`)
      .get() as { phone_e164: string } | undefined;
    check("公司總機留低", line?.phone_e164 === "85221740001");
    const observed = (
      appDb.prepare(`SELECT COUNT(*) AS n FROM car_listings WHERE sync_origin = 'observed'`).get() as { n: number }
    ).n;
    check("觀察車盤已刪", observed === 0, String(observed));

    const tony = appDb.prepare(`SELECT id FROM staff WHERE username = 'tony'`).get() as { id: number };
    const benjamin = appDb.prepare(`SELECT id FROM staff WHERE username = 'benjamin'`).get() as { id: number };
    const vivian = appDb.prepare(`SELECT id FROM staff WHERE username = 'vivian'`).get() as { id: number };
    const ken = appDb.prepare(`SELECT id FROM staff WHERE username = 'ken'`).get() as { id: number };
    const picked = assignMod.pickNextAutoAssignStaffId();
    check(
      "自動派單唔係 Tony、Benjamin、Vivian 或 Ken",
      picked != null && picked !== tony.id && picked !== benjamin.id && picked !== vivian.id && picked !== ken.id,
      String(picked)
    );

    process.env.NODE_ENV = "production";
    let refused = false;
    try {
      await seedMod.seed();
    } catch (err) {
      refused = err instanceof Error && err.message.includes("拒絕寫入示範留言");
    }
    delete process.env.NODE_ENV;
    check("production 拒絕 npm run seed", refused);
    check(
      "拒絕之後都唔會寫返 fb-3001",
      !appDb.prepare(`SELECT id FROM comments WHERE external_id = 'fb-3001'`).get()
    );

    if (failures.length) {
      console.error(`\n${failures.length} 項失敗`);
      return 1;
    }
    console.log("\n清除示範資料示範通過");
    return 0;
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const dbMod = require("../db") as typeof import("../db");
      dbMod.shutdownDatabase();
      dbMod.db.close();
    } catch {
      // already closed
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
