import Database, { type Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";
import { SCHEMA_SQL } from "./schema";

const defaultPath = path.join(process.cwd(), "data", "inbox.db");
const dbPath = process.env.DATABASE_PATH || defaultPath;

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db: DatabaseType = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);
migrateCommentsForWhatsappSource();

/**
 * 舊資料庫嘅 comments.source 只有 28car／glorious_web／facebook。
 * SQLite 改唔到 CHECK，所以重建表。新庫嘅 CREATE TABLE 已經包含 whatsapp，會直接跳過。
 */
function migrateCommentsForWhatsappSource(): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comments'`)
    .get() as { sql: string | null } | undefined;
  if (!row?.sql || row.sql.includes("whatsapp")) return;

  db.pragma("foreign_keys = OFF");
  try {
    const tx = db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS comments_new;
        CREATE TABLE comments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL CHECK (source IN ('28car', 'glorious_web', 'facebook', 'whatsapp')),
          external_id TEXT NOT NULL,
          author_name TEXT NOT NULL,
          body TEXT NOT NULL,
          vehicle_ref TEXT,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done')),
          assignee_staff_id INTEGER REFERENCES staff(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (source, external_id)
        );
        INSERT INTO comments_new (
          id, source, external_id, author_name, body, vehicle_ref, status,
          assignee_staff_id, created_at, updated_at
        )
        SELECT
          id, source, external_id, author_name, body, vehicle_ref, status,
          assignee_staff_id, created_at, updated_at
        FROM comments;
        DROP TABLE comments;
        ALTER TABLE comments_new RENAME TO comments;
        CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
        CREATE INDEX IF NOT EXISTS idx_comments_source ON comments(source);
        CREATE INDEX IF NOT EXISTS idx_comments_assignee ON comments(assignee_staff_id);
      `);
    });
    tx();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

export function getDbPath(): string {
  return dbPath;
}
