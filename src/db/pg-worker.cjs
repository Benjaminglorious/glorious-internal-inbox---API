"use strict";

const { workerData } = require("worker_threads");
const { Pool, types } = require("pg");

types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(21, (value) => Number(value));
types.setTypeParser(23, (value) => Number(value));

const ST_REQ = 1;
const ST_RES = 2;
const DATA_OFFSET = 8;

const { sab, databaseUrl, sslMode } = workerData;
if (!sab || !databaseUrl) {
  console.error("[db] PostgreSQL worker 缺少連線設定");
  process.exit(1);
}

const meta = new Int32Array(sab, 0, 2);
const maxBytes = sab.byteLength - DATA_OFFSET;

function sslOption() {
  if (sslMode === "disable") return false;
  if (sslMode === "relaxed") return { rejectUnauthorized: false };
  return undefined;
}

let pool = null;
let txClient = null;
let depth = 0;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 10000,
      statement_timeout: 25000,
      application_name: "glorious-internal-inbox",
      ssl: sslOption(),
    });
    pool.on("error", (err) => {
      console.error("[db] postgres pool", err && err.message ? err.message : "error");
    });
  }
  return pool;
}

function waitForRequest() {
  for (;;) {
    const cur = Atomics.load(meta, 0);
    if (cur === ST_REQ) return;
    Atomics.wait(meta, 0, cur, 1000);
  }
}

function readRequest() {
  const len = Atomics.load(meta, 1);
  if (len < 0 || len > maxBytes) throw new Error("PostgreSQL 請求過大");
  const raw = Buffer.from(new Uint8Array(sab, DATA_OFFSET, len)).toString("utf8");
  return JSON.parse(raw);
}

function writeResponse(payload) {
  const bytes = Buffer.from(JSON.stringify(payload));
  if (bytes.length > maxBytes) {
    const fallback = Buffer.from(
      JSON.stringify({ ok: false, message: "PostgreSQL 回應過大", code: null })
    );
    new Uint8Array(sab, DATA_OFFSET, fallback.length).set(fallback);
    Atomics.store(meta, 1, fallback.length);
  } else {
    new Uint8Array(sab, DATA_OFFSET, bytes.length).set(bytes);
    Atomics.store(meta, 1, bytes.length);
  }
  Atomics.store(meta, 0, ST_RES);
  Atomics.notify(meta, 0, 1);
}

async function query(sql, params) {
  const values = Array.isArray(params) ? params : [];
  const client = txClient || getPool();
  // No placeholders: simple query protocol, so schema scripts can contain many statements.
  const result = values.length > 0 ? await client.query(sql, values) : await client.query(sql);
  const packet = Array.isArray(result) ? result[result.length - 1] : result;
  return {
    rows: packet && packet.rows ? packet.rows : [],
    rowCount: packet && packet.rowCount != null ? packet.rowCount : 0,
  };
}

async function begin() {
  if (depth === 0) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
    } catch (err) {
      client.release();
      throw err;
    }
    txClient = client;
  } else {
    await txClient.query(`SAVEPOINT sp_${depth}`);
  }
  depth += 1;
  return { depth };
}

async function commit() {
  if (depth <= 0 || !txClient) throw new Error("沒有進行中嘅 transaction");
  if (depth === 1) {
    depth = 0;
    try {
      await txClient.query("COMMIT");
    } finally {
      txClient.release();
      txClient = null;
    }
    return { depth: 0 };
  }
  depth -= 1;
  await txClient.query(`RELEASE SAVEPOINT sp_${depth}`);
  return { depth };
}

async function rollback() {
  if (!txClient || depth <= 0) {
    depth = 0;
    return { depth: 0 };
  }
  if (depth === 1) {
    depth = 0;
    try {
      await txClient.query("ROLLBACK");
    } finally {
      txClient.release();
      txClient = null;
    }
    return { depth: 0 };
  }
  depth -= 1;
  await txClient.query(`ROLLBACK TO SAVEPOINT sp_${depth}`);
  return { depth };
}

async function dispatch(msg) {
  if (!msg || typeof msg !== "object") throw new Error("無效資料庫請求");
  if (msg.op === "query" || msg.op === "exec") return query(msg.sql, msg.params || []);
  if (msg.op === "begin") return begin();
  if (msg.op === "commit") return commit();
  if (msg.op === "rollback") return rollback();
  throw new Error(`未知資料庫操作 ${msg.op}`);
}

async function loop() {
  for (;;) {
    waitForRequest();
    let response;
    try {
      const msg = readRequest();
      const result = await dispatch(msg);
      response = { ok: true, result };
    } catch (err) {
      response = {
        ok: false,
        message: err && err.message ? String(err.message) : "PostgreSQL 查詢失敗",
        code: err && err.code ? String(err.code) : null,
      };
    }
    writeResponse(response);
  }
}

loop().catch((err) => {
  console.error("[db] PostgreSQL worker", err && err.message ? err.message : err);
  process.exit(1);
});
