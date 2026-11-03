import { Pool } from "pg";
import { db, getPostgresUrl, usingPostgres } from "./index";
import { postgresSslMode, sslOptionFromMode } from "./pg-config";

/**
 * 媒體 bytes 唔經 Postgres sync driver。
 * 嗰條通道用 JSON，大約 16MB 就會截斷，相片同影片放唔落。
 * SQLite 直接寫 BLOB。Postgres 用獨立連線寫 BYTEA。
 */

let pool: Pool | null = null;

function mediaPool(): Pool {
  const url = getPostgresUrl();
  if (!url) throw new Error("PostgreSQL 未設定");
  if (!pool) {
    const mode = postgresSslMode(url);
    pool = new Pool({
      connectionString: url,
      max: 2,
      connectionTimeoutMillis: 10000,
      statement_timeout: 60000,
      application_name: "glorious-internal-inbox-media",
      ssl: mode ? sslOptionFromMode(mode) : undefined,
    });
  }
  return pool;
}

export async function writeMediaBytes(id: number, bytes: Buffer): Promise<void> {
  if (!usingPostgres) {
    db.prepare(`UPDATE message_media SET data = ? WHERE id = ?`).run(bytes, id);
    return;
  }
  await mediaPool().query(`UPDATE message_media SET data = $1 WHERE id = $2`, [bytes, id]);
}

export async function readMediaBytes(id: number): Promise<Buffer | null> {
  if (!usingPostgres) {
    const row = db.prepare(`SELECT data FROM message_media WHERE id = ?`).get(id) as
      | { data: Buffer | Uint8Array | null }
      | undefined;
    if (!row || row.data == null) return null;
    return Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
  }
  const result = await mediaPool().query<{ data: Buffer | null }>(
    `SELECT data FROM message_media WHERE id = $1`,
    [id]
  );
  const value = result.rows[0]?.data;
  if (!value) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}
