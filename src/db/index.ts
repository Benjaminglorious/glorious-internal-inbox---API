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

export function getDbPath(): string {
  return dbPath;
}
