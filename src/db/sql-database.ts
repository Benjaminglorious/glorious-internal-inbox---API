export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqlStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
}

/** Subset of better-sqlite3 used by the inbox. Postgres implements the same calls. */
export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): unknown;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}
