import Database, { type Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";
import { COMMENT_INDEX_SQL, COMMENTS_CREATE_COLUMNS, SCHEMA_SQL } from "./schema";

const defaultPath = path.join(process.cwd(), "data", "inbox.db");
const dbPath = process.env.DATABASE_PATH || defaultPath;

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db: DatabaseType = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);
migrateCommentsTable();
ensureWhatsAppPhoneColumns();
backfillWhatsAppThreadPhones();
migrateCommentReplies();

function columnNames(table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/**
 * 舊庫可能未有 whatsapp、instagram，或者未有 intake_kind／origin_site。
 * SQLite 改唔到 CHECK，所以重建 comments。留言 id 同內容會保留。
 * 已係新結構就跳過。
 */
function migrateCommentsTable(): void {
  const cols = columnNames("comments");
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comments'`)
    .get() as { sql: string | null } | undefined;
  const ddl = row?.sql ?? "";
  const current = cols.has("intake_kind") && cols.has("origin_site") && ddl.includes("'instagram'");
  if (current) {
    db.exec(COMMENT_INDEX_SQL);
    return;
  }

  const originExpr = cols.has("origin_site")
    ? `CASE WHEN source = 'whatsapp' AND origin_site IN ('28car', 'glorious_web', 'facebook', 'instagram') THEN origin_site ELSE NULL END`
    : `NULL`;
  const intakeExpr = `CASE WHEN source = 'whatsapp' THEN 'whatsapp_click' ELSE 'site_comment' END`;

  db.pragma("foreign_keys = OFF");
  try {
    const tx = db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS comments_new;`);
      db.exec(`CREATE TABLE comments_new (${COMMENTS_CREATE_COLUMNS});`);
      db.exec(`
        INSERT INTO comments_new (
          id, source, external_id, author_name, body, vehicle_ref, status,
          assignee_staff_id, created_at, updated_at, intake_kind, origin_site
        )
        SELECT
          id, source, external_id, author_name, body, vehicle_ref, status,
          assignee_staff_id, created_at, updated_at,
          ${intakeExpr},
          ${originExpr}
        FROM comments;
      `);
      db.exec(`DROP TABLE comments;`);
      db.exec(`ALTER TABLE comments_new RENAME TO comments;`);
      db.exec(COMMENT_INDEX_SQL);
    });
    tx();
    console.log("[db] 已遷移 comments（來源加入 instagram；intake_kind／origin_site）");
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/** 舊庫加客戶 wa_id 同收件線路。只加欄，唔改派單、唔改號碼。 */
function ensureWhatsAppPhoneColumns(): void {
  const cols = columnNames("comments");
  if (!cols.has("wa_from_phone")) db.exec(`ALTER TABLE comments ADD COLUMN wa_from_phone TEXT`);
  if (!cols.has("wa_to_phone")) db.exec(`ALTER TABLE comments ADD COLUMN wa_to_phone TEXT`);
}

/** 舊對話如果 external_id 係 wa:{收件}:{寄件}，把已經入庫嘅號碼抄去新欄。 */
function backfillWhatsAppThreadPhones(): void {
  const threadId = /^wa:(\d{8,15}):(\d{8,15})$/;
  const rows = db
    .prepare(
      `SELECT id, external_id FROM comments
       WHERE source = 'whatsapp'
         AND external_id LIKE 'wa:%'
         AND (wa_from_phone IS NULL OR wa_to_phone IS NULL)`
    )
    .all() as Array<{ id: number; external_id: string }>;
  if (rows.length === 0) return;
  const update = db.prepare(
    `UPDATE comments
     SET wa_from_phone = COALESCE(wa_from_phone, ?),
         wa_to_phone = COALESCE(wa_to_phone, ?)
     WHERE id = ?`
  );
  const tx = db.transaction(() => {
    for (const row of rows) {
      const match = threadId.exec(row.external_id);
      if (!match) continue;
      update.run(match[2], match[1], row.id);
    }
  });
  tx();
}

/**
 * 舊 comment_replies 嘅 CHECK 未有 sent，亦未有 delivery_error。
 * SQLite 改唔到 CHECK，所以重建表。原有回覆 id 同內容會保留。
 */
function migrateCommentReplies(): void {
  const cols = columnNames("comment_replies");
  if (cols.size === 0) return;
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comment_replies'`)
    .get() as { sql: string | null } | undefined;
  const ddl = row?.sql ?? "";
  if (cols.has("delivery_error") && ddl.includes("'sent'")) return;

  const errorExpr = cols.has("delivery_error") ? "delivery_error" : "NULL";
  db.pragma("foreign_keys = OFF");
  try {
    const tx = db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS comment_replies_new;`);
      db.exec(`
        CREATE TABLE comment_replies_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
          staff_id INTEGER REFERENCES staff(id),
          direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
          body TEXT NOT NULL,
          delivery_status TEXT NOT NULL DEFAULT 'stub' CHECK (delivery_status IN ('stored', 'stub', 'failed', 'sent')),
          delivery_error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (
            (direction = 'outbound' AND staff_id IS NOT NULL) OR
            (direction = 'inbound')
          )
        );
      `);
      db.exec(`
        INSERT INTO comment_replies_new (
          id, comment_id, staff_id, direction, body, delivery_status, delivery_error, created_at
        )
        SELECT id, comment_id, staff_id, direction, body, delivery_status, ${errorExpr}, created_at
        FROM comment_replies;
      `);
      db.exec(`DROP TABLE comment_replies;`);
      db.exec(`ALTER TABLE comment_replies_new RENAME TO comment_replies;`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_comment_replies_comment ON comment_replies(comment_id, id);`);
    });
    tx();
    console.log("[db] 已遷移 comment_replies（delivery_status 加入 sent；delivery_error）");
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

export function getDbPath(): string {
  return dbPath;
}
