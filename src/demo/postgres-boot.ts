/**
 * 對本地或測試 Postgres 跑一次啟動路徑。
 * 資料庫名必須包含 smoke 或 test。冇 DATABASE_URL 就跳過。
 * 唔好指住 Render 正式庫。
 */
import { readPostgresUrl } from "../db/pg-config";

function databaseName(url: string): string {
  const path = url.split("?")[0].split("/").pop() || "";
  return decodeURIComponent(path);
}

async function main(): Promise<number> {
  const url = readPostgresUrl();
  if (!url) {
    console.log("skip postgres boot demo: DATABASE_URL / POSTGRES_URL 未設定");
    return 0;
  }
  const name = databaseName(url);
  if (!/smoke|test/i.test(name)) {
    console.error(`拒絕：postgres smoke 只可以對資料庫名包含 smoke 或 test 嘅庫執行（而家係 ${name || "未知"}）`);
    return 1;
  }
  if (/render\.com|dpg-/i.test(url)) {
    console.error("拒絕：呢個示範唔連接 Render Postgres");
    return 1;
  }

  const { Client } = require("pg") as typeof import("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await client.end();

  process.env.INBOX_DB = "postgres";
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dbMod = require("../db") as typeof import("../db");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const seedMod = require("../db/seed") as typeof import("../db/seed");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const clearMod = require("../db/clear-demo") as typeof import("../db/clear-demo");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wa = require("../services/whatsapp") as typeof import("../services/whatsapp");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const assignMod = require("../services/assign") as typeof import("../services/assign");
  const appDb = dbMod.db;
  const failures: string[] = [];
  const check = (label: string, cond: boolean, detail?: string): void => {
    if (!cond) {
      failures.push(detail ? `${label} — ${detail}` : label);
      console.error(`FAIL ${label}`, detail ?? "");
      return;
    }
    console.log(`OK   ${label}`);
  };

  try {
    check("driver 係 postgres", dbMod.usingPostgres === true);
    const tables = appDb
      .prepare(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'comments'`
      )
      .all() as Array<{ table_name: string }>;
    check("comments 表已建立", tables.length === 1);

    delete process.env.NODE_ENV;
    delete process.env.ALLOW_DEMO_SEED;
    seedMod.seedStaff();
    const staffN = Number((appDb.prepare(`SELECT COUNT(*) AS n FROM staff`).get() as { n: number }).n);
    const commentN = Number((appDb.prepare(`SELECT COUNT(*) AS n FROM comments`).get() as { n: number }).n);
    check("空庫 seed:staff 有同事", staffN >= 4, String(staffN));
    check("空庫 seed:staff 冇留言", commentN === 0, String(commentN));
    const line = appDb
      .prepare(`SELECT phone_e164, kind FROM whatsapp_lines WHERE phone_e164 = '85221740001'`)
      .get() as { phone_e164: string; kind: string } | undefined;
    check("公司總機 85221740001", !!line && line.kind === "company");

    appDb.prepare(`UPDATE staff SET password_hash = 'kept-hash' WHERE username = 'eddie'`).run();
    seedMod.seedStaff();
    const eddie = appDb.prepare(`SELECT password_hash AS h FROM staff WHERE username = 'eddie'`).get() as { h: string };
    check("再 seed:staff 唔覆寫密碼", eddie.h === "kept-hash");

    appDb.prepare(`DELETE FROM staff WHERE username = 'benjamin'`).run();
    appDb
      .prepare(
        `INSERT INTO staff (username, display_name, password_hash, is_admin, active)
         VALUES ('Benjamin', 'Benjamin', 'kept-ben-hash', 0, 0)`
      )
      .run();
    const commentsBeforeBoot = Number((appDb.prepare(`SELECT COUNT(*) AS n FROM comments`).get() as { n: number }).n);
    seedMod.syncStaffOnBoot();
    const benjamin = appDb
      .prepare(`SELECT username, display_name, is_admin, active, password_hash FROM staff WHERE lower(username) = 'benjamin'`)
      .all() as Array<{
      username: string;
      display_name: string;
      is_admin: number;
      active: number;
      password_hash: string;
    }>;
    const tonyRow = appDb.prepare(`SELECT is_admin, active FROM staff WHERE username = 'tony'`).get() as {
      is_admin: number;
      active: number;
    };
    const eddieAfter = appDb.prepare(`SELECT password_hash AS h FROM staff WHERE username = 'eddie'`).get() as { h: string };
    check(
      "已有庫啟動會把 Benjamin 升做管理員，唔會重複",
      benjamin.length === 1 &&
        benjamin[0].username === "benjamin" &&
        benjamin[0].display_name === "Benjamin" &&
        benjamin[0].is_admin === 1 &&
        benjamin[0].active === 1 &&
        benjamin[0].password_hash === "kept-ben-hash"
    );
    check("啟動對齊唔寫留言", Number((appDb.prepare(`SELECT COUNT(*) AS n FROM comments`).get() as { n: number }).n) === commentsBeforeBoot);
    check("啟動對齊唔降 Tony", tonyRow.is_admin === 1 && tonyRow.active === 1);
    check("啟動對齊唔覆寫其他人密碼", eddieAfter.h === "kept-hash");
    check(
      "再 seed:staff 仍然冇留言",
      Number((appDb.prepare(`SELECT COUNT(*) AS n FROM comments`).get() as { n: number }).n) === 0
    );

    await seedMod.seed();
    check(
      "本地 Postgres 可以 seed 示範留言",
      Number((appDb.prepare(`SELECT COUNT(*) AS n FROM comments WHERE external_id = 'fb-3001'`).get() as { n: number }).n) ===
        1
    );

    const live = wa.routeWhatsAppInbound({
      toPhone: "85221740001",
      fromPhone: "85290001122",
      body: "真實客戶問 Alphard",
      externalId: "wamid.HBgLOTE4Mja",
    });
    check("WhatsApp 入站 wamid 寫入", live.ok && live.created, live.ok ? live.comment.external_id : live.error);
    appDb
      .prepare(
        `INSERT INTO comments (
           source, external_id, author_name, body, status, intake_kind, entry_path
         ) VALUES ('28car', '28car:s9990001:buyer-77', '真實買家', '留言板', 'open', 'site_comment', '28car_board')`
      )
      .run();

    const tony = appDb.prepare(`SELECT id FROM staff WHERE username = 'tony'`).get() as { id: number };
    const benjaminStaff = appDb.prepare(`SELECT id FROM staff WHERE username = 'benjamin'`).get() as { id: number };
    const picked = assignMod.pickLeastLoadedStaffId();
    check(
      "自動派單跳過 Tony 同 Benjamin",
      picked != null && picked !== tony.id && picked !== benjaminStaff.id,
      String(picked)
    );
    if (live.ok) {
      check(
        "新 WhatsApp 都唔派 Tony 或 Benjamin",
        live.assigneeStaffId !== tony.id && live.assigneeStaffId !== benjaminStaff.id,
        String(live.assigneeStaffId)
      );
    }

    const cleared = clearMod.clearDemoFixtures();
    check("clear:demo 刪到示範列", cleared.comments_deleted > 0, String(cleared.comments_deleted));
    check(
      "wamid 留低",
      Number(
        (appDb.prepare(`SELECT COUNT(*) AS n FROM comments WHERE external_id = 'wamid.HBgLOTE4Mja'`).get() as { n: number })
          .n
      ) === 1
    );
    check(
      "真實 28car 留低",
      Number(
        (
          appDb.prepare(`SELECT COUNT(*) AS n FROM comments WHERE external_id = '28car:s9990001:buyer-77'`).get() as {
            n: number;
          }
        ).n
      ) === 1
    );
    check(
      "fb-3001 已刪",
      Number((appDb.prepare(`SELECT COUNT(*) AS n FROM comments WHERE external_id = 'fb-3001'`).get() as { n: number }).n) ===
        0
    );

    process.env.NODE_ENV = "production";
    let refused = false;
    try {
      await seedMod.seed();
    } catch (err) {
      refused = err instanceof Error && err.message.includes("拒絕寫入示範留言");
    }
    check("production seed 被拒絕", refused);

    const keyColumns = appDb
      .prepare(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'comment_message_keys'
         ORDER BY ordinal_position`
      )
      .all() as Array<{ column_name: string }>;
    const keyColumnNames = keyColumns.map((row) => row.column_name);
    check(
      "comment_message_keys 主鍵唔係 id",
      keyColumnNames.includes("source") &&
        keyColumnNames.includes("external_id") &&
        keyColumnNames.includes("comment_id") &&
        !keyColumnNames.includes("id"),
      keyColumnNames.join(",")
    );

    appDb.exec(`DROP INDEX IF EXISTS idx_comments_one_open_commenter`);
    const insertOpen = appDb.prepare(
      `INSERT INTO comments (
         source, external_id, author_name, body, status, intake_kind,
         wa_from_phone, wa_to_phone, commenter_key
       ) VALUES ('whatsapp', ?, '舊客', ?, 'open', 'whatsapp_click', '85291110000', '85221740001', 'wa:85291110000')`
    );
    const foldA = Number(insertOpen.run("wamid.FOLD-A", "舊第一句").lastInsertRowid);
    const foldB = Number(insertOpen.run("wamid.FOLD-B", "舊第二句").lastInsertRowid);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const threads = require("../services/commenter-thread") as typeof import("../services/commenter-thread");
    let foldError = "";
    let merged = 0;
    try {
      merged = threads.unifyOpenCommenterThreads();
    } catch (err) {
      foldError = err instanceof Error ? err.message : String(err);
    }
    const kept = appDb.prepare(`SELECT id, status FROM comments WHERE id = ?`).get(foldA) as
      | { id: number; status: string }
      | undefined;
    const gone = appDb.prepare(`SELECT id FROM comments WHERE id = ?`).get(foldB) as { id: number } | undefined;
    const mapped = appDb
      .prepare(
        `SELECT comment_id, reply_id FROM comment_message_keys WHERE source = 'whatsapp' AND external_id = 'wamid.FOLD-B'`
      )
      .get() as { comment_id: number; reply_id: number | null } | undefined;
    const stillOpen = Number(
      (
        appDb
          .prepare(
            `SELECT COUNT(*) AS n FROM comments
             WHERE source = 'whatsapp' AND commenter_key = 'wa:85291110000' AND status <> 'done'`
          )
          .get() as { n: number }
      ).n
    );
    check(
      "Postgres 啟動合併唔會因為 comment_message_keys 冇 id 而崩潰",
      foldError === "" &&
        merged >= 1 &&
        !!kept &&
        kept.status !== "done" &&
        gone == null &&
        mapped?.comment_id === foldA &&
        stillOpen === 1,
      foldError ||
        `merged=${merged} kept=${kept?.id ?? "none"} gone=${gone?.id ?? "none"} mapped=${mapped?.comment_id ?? "none"} open=${stillOpen}`
    );

    if (failures.length) {
      console.error(`\n${failures.length} 項失敗`);
      return 1;
    }
    console.log("\nPostgres 啟動路徑通過");
    return 0;
  } finally {
    dbMod.shutdownDatabase();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
