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

export function getDbPath(): string {
  return dbPath;
}
