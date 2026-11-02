import fs from "fs";
import path from "path";
import { Worker } from "worker_threads";
import { postgresSslMode, type PostgresSslMode } from "./pg-config";
import { insertReturningId, translateSql } from "./sql-compat";
import type { RunResult, SqlDatabase, SqlStatement } from "./sql-database";

const ST_REQ = 1;
const ST_RES = 2;
const ST_DEAD = 3;
const DATA_OFFSET = 8;
const CALL_TIMEOUT_MS = 60_000;

interface WorkerResponse {
  ok: boolean;
  result?: { rows?: Array<Record<string, unknown>>; rowCount?: number; depth?: number };
  message?: string;
  code?: string | null;
}

function resolveWorkerScript(): string {
  const candidates = [
    path.join(__dirname, "pg-worker.cjs"),
    path.join(process.cwd(), "src", "db", "pg-worker.cjs"),
    path.join(process.cwd(), "dist", "db", "pg-worker.cjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("找不到 PostgreSQL worker（src/db/pg-worker.cjs）");
}

class PgStatement implements SqlStatement {
  constructor(
    private readonly sql: string,
    private readonly call: (sql: string, params: unknown[]) => { rows: Array<Record<string, unknown>>; rowCount: number }
  ) {}

  get(...params: unknown[]): unknown {
    const packet = this.call(translateSql(this.sql), params);
    return packet.rows[0];
  }

  all(...params: unknown[]): unknown[] {
    return this.call(translateSql(this.sql), params).rows;
  }

  run(...params: unknown[]): RunResult {
    const packet = this.call(translateSql(insertReturningId(this.sql)), params);
    const id = packet.rows[0]?.id;
    return {
      changes: packet.rowCount,
      lastInsertRowid: id == null ? 0 : Number(id),
    };
  }
}

export interface PgSyncHandle {
  db: SqlDatabase;
  shutdown: () => void;
}

/**
 * Synchronous Postgres access for the existing better-sqlite3 call style.
 * Queries run on a worker thread so the main thread can block without stalling libpq.
 * One process serializes statements the same way SQLite already did.
 */
export function createPgSyncDatabase(connectionString: string): PgSyncHandle {
  const sab = new SharedArrayBuffer(16 * 1024 * 1024);
  const meta = new Int32Array(sab, 0, 2);
  const maxBytes = sab.byteLength - DATA_OFFSET;
  const sslMode: PostgresSslMode = postgresSslMode(connectionString);
  let fatal: Error | null = null;
  let stopping = false;

  const worker = new Worker(resolveWorkerScript(), {
    execArgv: [],
    workerData: { sab, databaseUrl: connectionString, sslMode },
  });
  worker.unref();
  worker.on("error", (err) => {
    fatal = err instanceof Error ? err : new Error(String(err));
    Atomics.store(meta, 0, ST_DEAD);
    Atomics.notify(meta, 0, 1);
  });
  worker.on("exit", (code) => {
    if (stopping) return;
    fatal = new Error(`PostgreSQL worker 已退出 (${code})`);
    Atomics.store(meta, 0, ST_DEAD);
    Atomics.notify(meta, 0, 1);
  });

  const call = (msg: { op: string; sql?: string; params?: unknown[] }): WorkerResponse["result"] => {
    if (fatal) throw fatal;
    const safeParams = (msg.params ?? []).map((value) => (value === undefined ? null : value));
    const bytes = Buffer.from(JSON.stringify({ ...msg, params: safeParams }));
    if (bytes.length > maxBytes) throw new Error("PostgreSQL 請求過大");
    worker.ref();
    try {
      new Uint8Array(sab, DATA_OFFSET, bytes.length).set(bytes);
      Atomics.store(meta, 1, bytes.length);
      Atomics.store(meta, 0, ST_REQ);
      Atomics.notify(meta, 0, 1);
      const deadline = Date.now() + CALL_TIMEOUT_MS;
      let state = Atomics.load(meta, 0);
      while (state === ST_REQ && Date.now() < deadline) {
        if (fatal) throw fatal;
        Atomics.wait(meta, 0, ST_REQ, 200);
        state = Atomics.load(meta, 0);
      }
      if (fatal) throw fatal;
      if (state === ST_REQ) throw new Error("PostgreSQL 查詢逾時");
      if (state === ST_DEAD) throw fatal ?? new Error("PostgreSQL worker 已退出");
      if (state !== ST_RES) throw new Error(`PostgreSQL worker 狀態異常 (${state})`);
      const len = Atomics.load(meta, 1);
      const raw = Buffer.from(new Uint8Array(sab, DATA_OFFSET, len)).toString("utf8");
      Atomics.store(meta, 0, 0);
      const parsed = JSON.parse(raw) as WorkerResponse;
      if (!parsed.ok) {
        const error = new Error(parsed.message || "PostgreSQL 查詢失敗");
        if (parsed.code) (error as Error & { code?: string }).code = parsed.code;
        throw error;
      }
      return parsed.result ?? { rows: [], rowCount: 0 };
    } finally {
      worker.unref();
    }
  };

  const query = (sql: string, params: unknown[] = []) => {
    const result = call({ op: "query", sql, params });
    return {
      rows: result?.rows ?? [],
      rowCount: result?.rowCount ?? 0,
    };
  };

  const db: SqlDatabase = {
    prepare(sql: string): SqlStatement {
      return new PgStatement(sql, query);
    },
    exec(sql: string): void {
      call({ op: "exec", sql: translateSql(sql), params: [] });
    },
    transaction<T>(fn: () => T): () => T {
      return () => {
        call({ op: "begin" });
        try {
          const result = fn();
          call({ op: "commit" });
          return result;
        } catch (err) {
          try {
            call({ op: "rollback" });
          } catch (rollbackErr) {
            const message = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
            console.error("[db] rollback 失敗", message);
          }
          throw err;
        }
      };
    },
    close(): void {
      stopping = true;
      void worker.terminate();
    },
  };

  return {
    db,
    shutdown() {
      db.close();
    },
  };
}
