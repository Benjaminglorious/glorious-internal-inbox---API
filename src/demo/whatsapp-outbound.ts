/**
 * 公司 WhatsApp Cloud API 出站（mock fetch）。
 * 覆蓋：成功、缺 token、Graph 錯誤、同事線路唔打 Graph、冇客戶號碼。
 * 先放一個未有 sent／wa_from_phone 嘅舊庫，順便確認遷移同 wa:{to}:{from} 回填。
 */
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { COMPANY_WHATSAPP_PHONE, DEFAULT_WHATSAPP_PHONE_NUMBER_ID } from "../config";

const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) {
    const line = detail ? `${name} — ${detail}` : name;
    failures.push(line);
    console.error(`FAIL ${line}`);
    return;
  }
  console.log(`OK   ${name}`);
}

interface CapturedCall {
  url: string;
  method: string;
  authorization: string;
  body: Record<string, unknown> | null;
}

function readCall(input: unknown, init?: { method?: string; headers?: unknown; body?: unknown }): CapturedCall {
  const headers =
    init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)
      ? (init.headers as Record<string, string>)
      : {};
  let body: Record<string, unknown> | null = null;
  if (typeof init?.body === "string") {
    try {
      const parsed = JSON.parse(init.body) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  return {
    url: String(input),
    method: init?.method ?? "",
    authorization: headers.Authorization ?? headers.authorization ?? "",
    body,
  };
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-wa-out-"));
  const dbFile = path.join(tmp, "inbox.db");
  const saved = {
    DATABASE_PATH: process.env.DATABASE_PATH,
    WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_GRAPH_VERSION: process.env.WHATSAPP_GRAPH_VERSION,
    META_PAGE_ACCESS_TOKEN: process.env.META_PAGE_ACCESS_TOKEN,
  };
  const originalFetch = globalThis.fetch;
  let appDb: Database.Database | undefined;
  const calls: CapturedCall[] = [];
  let fetchMode: "count" | "ok" | "graph-error" = "count";

  const installFetch = (): void => {
    globalThis.fetch = (async (input: unknown, init?: { method?: string; headers?: unknown; body?: unknown }) => {
      calls.push(readCall(input, init));
      if (fetchMode === "graph-error") {
        return new Response(
          JSON.stringify({ error: { message: "Recipient not allowed", type: "OAuthException", code: 131030 } }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      if (fetchMode === "ok") {
        return new Response(JSON.stringify({ messages: [{ id: "wamid.OUT1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected fetch", { status: 500 });
    }) as typeof fetch;
  };

  try {
    const legacy = new Database(dbFile);
    legacy.exec(`
      CREATE TABLE staff (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL CHECK (source IN ('28car', 'glorious_web', 'facebook', 'instagram', 'whatsapp')),
        external_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        body TEXT NOT NULL,
        vehicle_ref TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done')),
        assignee_staff_id INTEGER REFERENCES staff(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        intake_kind TEXT NOT NULL DEFAULT 'site_comment' CHECK (intake_kind IN ('site_comment', 'whatsapp_click')),
        origin_site TEXT CHECK (origin_site IS NULL OR origin_site IN ('28car', 'glorious_web', 'facebook', 'instagram')),
        UNIQUE (source, external_id)
      );
      CREATE TABLE comment_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        staff_id INTEGER REFERENCES staff(id),
        direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
        body TEXT NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'stub' CHECK (delivery_status IN ('stored', 'stub', 'failed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO staff (username, display_name, password_hash, is_admin, active)
      VALUES ('wing', 'Wing', 'x', 0, 1);
      INSERT INTO comments (
        source, external_id, author_name, body, status, assignee_staff_id, intake_kind
      ) VALUES (
        'whatsapp', 'wa:${COMPANY_WHATSAPP_PHONE}:85298880000', '舊客', '舊訊息', 'open', 1, 'whatsapp_click'
      );
      INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status)
      VALUES (1, 1, 'outbound', '舊回覆', 'stub');
    `);
    legacy.close();

    process.env.DATABASE_PATH = dbFile;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_GRAPH_VERSION;
    process.env.META_PAGE_ACCESS_TOKEN = "page-token-should-not-be-used";

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as typeof import("../db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wa = require("../services/whatsapp") as typeof import("../services/whatsapp");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const replies = require("../services/replies") as typeof import("../services/replies");
    appDb = dbMod.db;
    wa.ensureCompanyWhatsAppLine();
    installFetch();

    const replyDdl = appDb
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comment_replies'`)
      .get() as { sql: string };
    const oldReply = appDb
      .prepare(`SELECT body, delivery_status, delivery_error FROM comment_replies WHERE body = '舊回覆'`)
      .get() as { body: string; delivery_status: string; delivery_error: string | null };
    check("回覆表遷移後有 sent 同 delivery_error", replyDdl.sql.includes("'sent'") && replyDdl.sql.includes("delivery_error"));
    check("舊回覆遷移後仍係 stub", oldReply.delivery_status === "stub" && oldReply.delivery_error == null);

    const backfilled = appDb
      .prepare(`SELECT wa_from_phone, wa_to_phone FROM comments WHERE external_id = ?`)
      .get(`wa:${COMPANY_WHATSAPP_PHONE}:85298880000`) as { wa_from_phone: string | null; wa_to_phone: string | null };
    check(
      "wa:{收件}:{寄件} 回填客戶號碼",
      backfilled.wa_from_phone === "85298880000" && backfilled.wa_to_phone === COMPANY_WHATSAPP_PHONE
    );

    const staffId = 1;
    const missingInbound = wa.routeWhatsAppInbound({
      toPhone: COMPANY_WHATSAPP_PHONE,
      fromPhone: "85290001111",
      body: "公司線",
      externalId: "wamid.NEEDTOKEN",
      authorName: "陳生",
    });
    check(
      "新入站寫入客戶 wa_id 同公司線路",
      missingInbound.ok &&
        missingInbound.comment.wa_from_phone === "85290001111" &&
        missingInbound.comment.wa_to_phone === COMPANY_WHATSAPP_PHONE &&
        missingInbound.outcome === "company"
    );

    calls.length = 0;
    fetchMode = "ok";
    const missing = missingInbound.ok
      ? await replies.createStaffReply({
          commentId: missingInbound.comment.id,
          staffId,
          body: "未設定 token",
        })
      : null;
    check(
      "缺 token 標失敗而且唔呼叫 Graph",
      !!missing?.ok &&
        missing.reply.delivery_status === "failed" &&
        (missing.reply.delivery_error || "").includes("WHATSAPP_ACCESS_TOKEN") &&
        calls.length === 0,
      missing?.ok ? missing.reply.delivery_error || "" : missing?.error
    );

    process.env.WHATSAPP_ACCESS_TOKEN = "test-whatsapp-token";
    const backfillId = appDb
      .prepare(`SELECT id FROM comments WHERE external_id = ?`)
      .get(`wa:${COMPANY_WHATSAPP_PHONE}:85298880000`) as { id: number };
    calls.length = 0;
    fetchMode = "ok";
    const sent = await replies.createStaffReply({
      commentId: backfillId.id,
      staffId,
      body: "星期六可以睇車",
    });
    const sentCall = calls[0];
    const text = sentCall?.body?.text as { body?: string; preview_url?: boolean } | undefined;
    check(
      "成功就打 Graph messages 並標 sent",
      sent.ok &&
        sent.reply.delivery_status === "sent" &&
        sent.reply.delivery_error == null &&
        calls.length === 1 &&
        sentCall?.method === "POST" &&
        sentCall.url ===
          `https://graph.facebook.com/v21.0/${DEFAULT_WHATSAPP_PHONE_NUMBER_ID}/messages` &&
        sentCall.authorization === "Bearer test-whatsapp-token" &&
        sentCall.body?.messaging_product === "whatsapp" &&
        sentCall.body?.to === "85298880000" &&
        sentCall.body?.type === "text" &&
        text?.body === "星期六可以睇車" &&
        text?.preview_url === false,
      sent.ok ? `${sent.reply.delivery_status} ${sentCall?.url || ""}` : sent.error
    );

    const graphInbound = wa.routeWhatsAppInbound({
      toPhone: `+${COMPANY_WHATSAPP_PHONE}`,
      fromPhone: "+852 9333-0000",
      body: "再問一次",
      externalId: "wamid.GRAPHERR",
    });
    process.env.WHATSAPP_PHONE_NUMBER_ID = "555001";
    calls.length = 0;
    fetchMode = "graph-error";
    const graphFailed = graphInbound.ok
      ? await replies.createStaffReply({
          commentId: graphInbound.comment.id,
          staffId,
          body: "呢句唔應該當成功",
        })
      : null;
    check(
      "Graph 錯誤標失敗並保留原因",
      !!graphFailed?.ok &&
        graphFailed.reply.delivery_status === "failed" &&
        (graphFailed.reply.delivery_error || "").includes("Recipient not allowed") &&
        (graphFailed.reply.delivery_error || "").includes("131030") &&
        calls.length === 1 &&
        calls[0]?.url === "https://graph.facebook.com/v21.0/555001/messages" &&
        calls[0]?.body?.to === "85293330000",
      graphFailed?.ok ? graphFailed.reply.delivery_error || "" : graphFailed?.error
    );

    const bound = wa.addStaffWhatsAppLine({ staffId, phone: "85261112222", displayLabel: "同事個人" });
    const staffInbound = wa.routeWhatsAppInbound({
      toPhone: "85261112222",
      fromPhone: "85297770000",
      body: "打去同事",
      externalId: "wamid.STAFF",
    });
    calls.length = 0;
    fetchMode = "ok";
    const staffReply = staffInbound.ok
      ? await replies.createStaffReply({
          commentId: staffInbound.comment.id,
          staffId,
          body: "個人線路唔經 Cloud API",
        })
      : null;
    check(
      "同事個人線路維持 stub，唔打 Graph",
      bound.ok &&
        !!staffReply?.ok &&
        staffInbound.ok &&
        staffInbound.comment.wa_to_phone === "85261112222" &&
        staffReply.reply.delivery_status === "stub" &&
        calls.length === 0,
      staffReply?.ok ? staffReply.reply.delivery_status : staffReply?.error
    );

    const noPhone = appDb
      .prepare(
        `INSERT INTO comments (
           source, external_id, author_name, body, status, assignee_staff_id, intake_kind, wa_to_phone
         ) VALUES ('whatsapp', 'wamid.NOPHONE', '無名', '冇號碼', 'open', ?, 'whatsapp_click', ?)`
      )
      .run(staffId, COMPANY_WHATSAPP_PHONE);
    calls.length = 0;
    const noPhoneReply = await replies.createStaffReply({
      commentId: Number(noPhone.lastInsertRowid),
      staffId,
      body: "冇 wa_id",
    });
    check(
      "公司線冇客戶號碼就失敗，唔假裝成功",
      noPhoneReply.ok &&
        noPhoneReply.reply.delivery_status === "failed" &&
        (noPhoneReply.reply.delivery_error || "").includes("沒有客戶 WhatsApp 號碼") &&
        calls.length === 0,
      noPhoneReply.ok ? noPhoneReply.reply.delivery_error || "" : noPhoneReply.error
    );

    process.env.WHATSAPP_PHONE_NUMBER_ID = "not-an-id";
    calls.length = 0;
    const badId = await replies.createStaffReply({
      commentId: backfillId.id,
      staffId,
      body: "phone number id 唔啱",
    });
    check(
      "PHONE_NUMBER_ID 格式錯就失敗，唔打 Graph",
      badId.ok &&
        badId.reply.delivery_status === "failed" &&
        (badId.reply.delivery_error || "").includes("WHATSAPP_PHONE_NUMBER_ID") &&
        calls.length === 0,
      badId.ok ? badId.reply.delivery_error || "" : badId.error
    );

    if (failures.length) {
      console.error(`\n${failures.length} 項失敗`);
      return 1;
    }
    console.log("\nWhatsApp Cloud 出站示範通過");
    return 0;
  } finally {
    globalThis.fetch = originalFetch;
    const restore = (key: keyof typeof saved): void => {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("DATABASE_PATH");
    restore("WHATSAPP_ACCESS_TOKEN");
    restore("WHATSAPP_PHONE_NUMBER_ID");
    restore("WHATSAPP_GRAPH_VERSION");
    restore("META_PAGE_ACCESS_TOKEN");
    appDb?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
