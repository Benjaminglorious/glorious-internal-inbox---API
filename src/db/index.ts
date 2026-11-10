import Database, { type Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";
import { postgresSslMode, readPostgresUrl } from "./pg-config";
import { createPgSyncDatabase } from "./pg-sync";
import { postgresBootstrapSql } from "./schema.pg";
import { COMMENT_INDEX_SQL, COMMENTS_CREATE_COLUMNS, SCHEMA_SQL } from "./schema";
import type { SqlDatabase } from "./sql-database";

const defaultPath = path.join(process.cwd(), "data", "inbox.db");
const sqlitePath = process.env.DATABASE_PATH || defaultPath;
const pgUrl = readPostgresUrl();

let shutdownPg: (() => void) | null = null;
const database = openDatabase();

// Typed as better-sqlite3 so existing call sites stay unchanged.
// When DATABASE_URL is set, the object is the Postgres sync driver (prepare / exec / transaction / close).
export const db = database as DatabaseType;
export const usingPostgres = pgUrl != null;

function openDatabase(): SqlDatabase {
  if (pgUrl) {
    const opened = createPgSyncDatabase(pgUrl);
    shutdownPg = opened.shutdown;
    try {
      opened.db.exec(postgresBootstrapSql());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opened.shutdown();
      throw new Error(
        `[db] PostgreSQL schema 失敗：${message.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://***")}`
      );
    }
    console.log("[db] PostgreSQL schema ready");
    return opened.db;
  }

  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const sqlite = new Database(sqlitePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(SCHEMA_SQL);
  migrateCommentsTable(sqlite);
  ensureWhatsAppPhoneColumns(sqlite);
  ensureEntryPathColumn(sqlite);
  ensureMetaReplyColumns(sqlite);
  ensureMetaPostColumns(sqlite);
  backfillWhatsAppThreadPhones(sqlite);
  migrateCommentReplies(sqlite);
  return sqlite;
}

function columnNames(sqlite: DatabaseType, table: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/**
 * 舊庫可能未有 whatsapp、instagram，或者未有 intake_kind／origin_site。
 * SQLite 改唔到 CHECK，所以重建 comments。留言 id 同內容會保留。
 * 已係新結構就跳過。
 */
function migrateCommentsTable(sqlite: DatabaseType): void {
  const cols = columnNames(sqlite, "comments");
  const row = sqlite
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comments'`)
    .get() as { sql: string | null } | undefined;
  const ddl = row?.sql ?? "";
  const current =
    cols.has("intake_kind") &&
    cols.has("origin_site") &&
    cols.has("email_from") &&
    ddl.includes("'instagram'") &&
    ddl.includes("'email'");
  if (current) {
    sqlite.exec(COMMENT_INDEX_SQL);
    return;
  }

  const col = (name: string, fallback: string) => (cols.has(name) ? name : fallback);
  const intakeExpr = cols.has("intake_kind")
    ? `CASE
         WHEN source = 'whatsapp' THEN 'whatsapp_click'
         WHEN source = 'email' THEN 'email'
         WHEN intake_kind IN ('site_comment', 'whatsapp_click', 'email') THEN intake_kind
         ELSE 'site_comment'
       END`
    : `CASE WHEN source = 'whatsapp' THEN 'whatsapp_click' WHEN source = 'email' THEN 'email' ELSE 'site_comment' END`;
  const originExpr = cols.has("origin_site")
    ? `CASE WHEN source = 'whatsapp' AND origin_site IN ('28car', 'glorious_web', 'facebook', 'instagram') THEN origin_site ELSE NULL END`
    : `NULL`;
  const entryExpr = cols.has("entry_path")
    ? `CASE WHEN entry_path IN ('28car_board', '28car_wa_link') THEN entry_path ELSE NULL END`
    : `NULL`;
  const surfaceExpr = cols.has("meta_surface")
    ? `CASE WHEN meta_surface IN ('comment', 'message') THEN meta_surface ELSE NULL END`
    : `NULL`;

  sqlite.pragma("foreign_keys = OFF");
  try {
    const tx = sqlite.transaction(() => {
      sqlite.exec(`DROP TABLE IF EXISTS comments_new;`);
      sqlite.exec(`CREATE TABLE comments_new (${COMMENTS_CREATE_COLUMNS});`);
      sqlite.exec(`
        INSERT INTO comments_new (
          id, source, external_id, author_name, body, vehicle_ref, status,
          assignee_staff_id, created_at, updated_at, intake_kind, origin_site,
          wa_from_phone, wa_to_phone, entry_path, meta_sender_id, meta_surface,
          meta_post_id, meta_post_permalink, meta_post_caption, commenter_key,
          email_from, email_subject, email_message_id, email_references
        )
        SELECT
          id, source, external_id, author_name, body, vehicle_ref, status,
          assignee_staff_id, created_at, updated_at,
          ${intakeExpr},
          ${originExpr},
          ${col("wa_from_phone", "NULL")},
          ${col("wa_to_phone", "NULL")},
          ${entryExpr},
          ${col("meta_sender_id", "NULL")},
          ${surfaceExpr},
          ${col("meta_post_id", "NULL")},
          ${col("meta_post_permalink", "NULL")},
          ${col("meta_post_caption", "NULL")},
          ${col("commenter_key", "NULL")},
          ${col("email_from", "NULL")},
          ${col("email_subject", "NULL")},
          ${col("email_message_id", "NULL")},
          ${col("email_references", "NULL")}
        FROM comments;
      `);
      sqlite.exec(`DROP TABLE comments;`);
      sqlite.exec(`ALTER TABLE comments_new RENAME TO comments;`);
      sqlite.exec(COMMENT_INDEX_SQL);
    });
    tx();
    console.log("[db] 已遷移 comments（來源加入 email；原有留言、電話同負責人保留）");
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
}

/** 28car 留言板對比留言區 WhatsApp 連結。舊庫只加欄。 */
function ensureEntryPathColumn(sqlite: DatabaseType): void {
  const cols = columnNames(sqlite, "comments");
  if (!cols.has("entry_path")) sqlite.exec(`ALTER TABLE comments ADD COLUMN entry_path TEXT`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_comments_entry_path ON comments(entry_path)`);
}

/**
 * Facebook／Instagram 出站要嘅客戶 id 同表面（留言定私訊）。
 * 只加欄。舊列留空，出站再睇 external_id。
 */
function ensureMetaReplyColumns(sqlite: DatabaseType): void {
  const cols = columnNames(sqlite, "comments");
  if (!cols.has("meta_sender_id")) sqlite.exec(`ALTER TABLE comments ADD COLUMN meta_sender_id TEXT`);
  if (!cols.has("meta_surface")) sqlite.exec(`ALTER TABLE comments ADD COLUMN meta_surface TEXT`);
}

/** Facebook／Instagram 公開留言所屬帖文。只加欄，舊列留空。 */
function ensureMetaPostColumns(sqlite: DatabaseType): void {
  const cols = columnNames(sqlite, "comments");
  if (!cols.has("meta_post_id")) sqlite.exec(`ALTER TABLE comments ADD COLUMN meta_post_id TEXT`);
  if (!cols.has("meta_post_permalink")) sqlite.exec(`ALTER TABLE comments ADD COLUMN meta_post_permalink TEXT`);
  if (!cols.has("meta_post_caption")) sqlite.exec(`ALTER TABLE comments ADD COLUMN meta_post_caption TEXT`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_comments_meta_post ON comments(meta_post_id)`);
}

/** 舊庫加客戶 wa_id 同收件線路。只加欄，唔改派單、唔改號碼。 */
function ensureWhatsAppPhoneColumns(sqlite: DatabaseType): void {
  const cols = columnNames(sqlite, "comments");
  if (!cols.has("wa_from_phone")) sqlite.exec(`ALTER TABLE comments ADD COLUMN wa_from_phone TEXT`);
  if (!cols.has("wa_to_phone")) sqlite.exec(`ALTER TABLE comments ADD COLUMN wa_to_phone TEXT`);
}

/** 舊對話如果 external_id 係 wa:{收件}:{寄件}，把已經入庫嘅號碼抄去新欄。 */
function backfillWhatsAppThreadPhones(sqlite: DatabaseType): void {
  const threadId = /^wa:(\d{8,15}):(\d{8,15})$/;
  const rows = sqlite
    .prepare(
      `SELECT id, external_id FROM comments
       WHERE source = 'whatsapp'
         AND external_id LIKE 'wa:%'
         AND (wa_from_phone IS NULL OR wa_to_phone IS NULL)`
    )
    .all() as Array<{ id: number; external_id: string }>;
  if (rows.length === 0) return;
  const update = sqlite.prepare(
    `UPDATE comments
     SET wa_from_phone = COALESCE(wa_from_phone, ?),
         wa_to_phone = COALESCE(wa_to_phone, ?)
     WHERE id = ?`
  );
  const tx = sqlite.transaction(() => {
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
function migrateCommentReplies(sqlite: DatabaseType): void {
  const cols = columnNames(sqlite, "comment_replies");
  if (cols.size === 0) return;
  const row = sqlite
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comment_replies'`)
    .get() as { sql: string | null } | undefined;
  const ddl = row?.sql ?? "";
  if (cols.has("delivery_error") && ddl.includes("'sent'")) return;

  const errorExpr = cols.has("delivery_error") ? "delivery_error" : "NULL";
  sqlite.pragma("foreign_keys = OFF");
  try {
    const tx = sqlite.transaction(() => {
      sqlite.exec(`DROP TABLE IF EXISTS comment_replies_new;`);
      sqlite.exec(`
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
      sqlite.exec(`
        INSERT INTO comment_replies_new (
          id, comment_id, staff_id, direction, body, delivery_status, delivery_error, created_at
        )
        SELECT id, comment_id, staff_id, direction, body, delivery_status, ${errorExpr}, created_at
        FROM comment_replies;
      `);
      sqlite.exec(`DROP TABLE comment_replies;`);
      sqlite.exec(`ALTER TABLE comment_replies_new RENAME TO comment_replies;`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_comment_replies_comment ON comment_replies(comment_id, id);`);
    });
    tx();
    console.log("[db] 已遷移 comment_replies（delivery_status 加入 sent；delivery_error）");
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
}

export function getDbPath(): string {
  if (usingPostgres) return "postgresql://(DATABASE_URL)";
  return sqlitePath;
}

export function getPostgresUrl(): string | null {
  return pgUrl;
}

export function getPostgresSslMode(): ReturnType<typeof postgresSslMode> | null {
  return pgUrl ? postgresSslMode(pgUrl) : null;
}

export function shutdownDatabase(): void {
  if (!shutdownPg) return;
  const close = shutdownPg;
  shutdownPg = null;
  close();
}

function ensureCommenterKeyColumn(sqlite: DatabaseType): void {
  const cols = columnNames(sqlite, "comments");
  if (!cols.has("commenter_key")) sqlite.exec(`ALTER TABLE comments ADD COLUMN commenter_key TEXT`);
}

if (!usingPostgres) ensureCommenterKeyColumn(database as DatabaseType);

// 表同欄先齊，先至合併未完成嘅同一留言者。循環引用：呢度先 require。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const commenterThreads = require("../services/commenter-thread") as typeof import("../services/commenter-thread");
commenterThreads.unifyOpenCommenterThreads();
