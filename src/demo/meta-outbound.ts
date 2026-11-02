/**
 * Facebook Page／Instagram Graph 出站（mock fetch）。
 * 覆蓋：成功、缺 token、缺 Page id、缺 PSID、Graph 錯誤、私訊長度、
 * WhatsApp 仍然唔用 Page token。
 * 先放一個未有 meta_sender_id 嘅庫，確認只加欄。
 */
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { COMPANY_WHATSAPP_PHONE, DEFAULT_META_GRAPH_VERSION } from "../config";
import type { OutboundReplyRequest } from "../adapters/outbound";

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

function replyInput(overrides: Partial<OutboundReplyRequest> & Pick<OutboundReplyRequest, "source" | "externalId">): OutboundReplyRequest {
  return {
    commentId: 1,
    intakeKind: "site_comment",
    originSite: null,
    body: "星期六可以睇車",
    staffId: 1,
    waFromPhone: null,
    waToPhone: null,
    metaSenderId: null,
    metaSurface: null,
    ...overrides,
  };
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-meta-out-"));
  const dbFile = path.join(tmp, "inbox.db");
  const saved = {
    DATABASE_PATH: process.env.DATABASE_PATH,
    INBOX_DB: process.env.INBOX_DB,
    WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
    META_PAGE_ACCESS_TOKEN: process.env.META_PAGE_ACCESS_TOKEN,
    META_PAGE_ID: process.env.META_PAGE_ID,
    META_IG_BUSINESS_ACCOUNT_ID: process.env.META_IG_BUSINESS_ACCOUNT_ID,
    META_GRAPH_VERSION: process.env.META_GRAPH_VERSION,
  };
  const originalFetch = globalThis.fetch;
  let appDb: Database.Database | undefined;
  const calls: CapturedCall[] = [];
  let fetchMode: "ok-comment" | "ok-message" | "graph-error" | "no-id" | "throw" | "leak" = "ok-comment";
  const pageToken = "page-token-demo";
  const pageId = "123456789012345";

  const installFetch = (): void => {
    globalThis.fetch = (async (input: unknown, init?: { method?: string; headers?: unknown; body?: unknown }) => {
      calls.push(readCall(input, init));
      if (fetchMode === "throw") throw new Error("connect ECONNREFUSED");
      if (fetchMode === "graph-error") {
        return new Response(
          JSON.stringify({ error: { message: "Permissions error", type: "OAuthException", code: 200 } }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      if (fetchMode === "leak") {
        return new Response(
          JSON.stringify({ error: { message: `token ${pageToken} rejected`, code: 190 } }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      if (fetchMode === "no-id") {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (fetchMode === "ok-message") {
        return new Response(JSON.stringify({ recipient_id: "999", message_id: "m_out_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: "comment_out_1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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
        wa_from_phone TEXT,
        wa_to_phone TEXT,
        entry_path TEXT,
        UNIQUE (source, external_id)
      );
      CREATE TABLE comment_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        staff_id INTEGER REFERENCES staff(id),
        direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
        body TEXT NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'stub' CHECK (delivery_status IN ('stored', 'stub', 'failed', 'sent')),
        delivery_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO staff (username, display_name, password_hash, is_admin, active)
      VALUES ('wing', 'Wing', 'x', 0, 1);
    `);
    legacy.close();

    process.env.INBOX_DB = "sqlite";
    process.env.DATABASE_PATH = dbFile;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.META_PAGE_ACCESS_TOKEN;
    delete process.env.META_PAGE_ID;
    delete process.env.META_IG_BUSINESS_ACCOUNT_ID;
    delete process.env.META_GRAPH_VERSION;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as typeof import("../db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const replies = require("../services/replies") as typeof import("../services/replies");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const adapters = require("../adapters") as typeof import("../adapters");
    appDb = dbMod.db;
    installFetch();

    const cols = new Set(
      (appDb.prepare(`PRAGMA table_info(comments)`).all() as Array<{ name: string }>).map((row) => row.name)
    );
    check("舊庫加咗 meta_sender_id 同 meta_surface", cols.has("meta_sender_id") && cols.has("meta_surface"));

    calls.length = 0;
    const missingFb = await adapters.queueOutboundReply(
      replyInput({ source: "facebook", externalId: "178900000000001_9001", commentId: 11 })
    );
    const missingIg = await adapters.queueOutboundReply(
      replyInput({ source: "instagram", externalId: "178900000000002", commentId: 12 })
    );
    check(
      "缺 Page token 標失敗而且唔呼叫 Graph",
      missingFb.delivery_status === "failed" &&
        (missingFb.error || "").includes("META_PAGE_ACCESS_TOKEN") &&
        missingIg.delivery_status === "failed" &&
        (missingIg.error || "").includes("META_PAGE_ACCESS_TOKEN") &&
        calls.length === 0,
      `${missingFb.error || ""} | ${missingIg.error || ""}`
    );

    process.env.META_PAGE_ACCESS_TOKEN = pageToken;
    process.env.META_PAGE_ID = pageId;
    fetchMode = "ok-comment";
    calls.length = 0;
    const fbComment = await adapters.queueOutboundReply(
      replyInput({ source: "facebook", externalId: "178900000000001_9001", metaSurface: "comment", commentId: 21 })
    );
    const fbCall = calls[0];
    check(
      "Facebook 留言打 POST /{comment-id}/comments",
      fbComment.delivery_status === "sent" &&
        fbComment.provider === "facebook_graph" &&
        calls.length === 1 &&
        fbCall?.method === "POST" &&
        fbCall.url === `https://graph.facebook.com/${DEFAULT_META_GRAPH_VERSION}/178900000000001_9001/comments` &&
        fbCall.authorization === `Bearer ${pageToken}` &&
        fbCall.body?.message === "星期六可以睇車",
      `${fbComment.delivery_status} ${fbCall?.url || ""}`
    );

    calls.length = 0;
    const igComment = await adapters.queueOutboundReply(
      replyInput({
        source: "instagram",
        externalId: "178900000000002",
        metaSurface: "comment",
        metaSenderId: "178111111111111",
        commentId: 22,
        body: "IG 回覆",
      })
    );
    const igCall = calls[0];
    check(
      "Instagram 留言打 POST /{comment-id}/replies",
      igComment.delivery_status === "sent" &&
        igComment.provider === "instagram_graph" &&
        calls.length === 1 &&
        igCall?.url === `https://graph.facebook.com/${DEFAULT_META_GRAPH_VERSION}/178900000000002/replies` &&
        igCall.authorization === `Bearer ${pageToken}` &&
        igCall.body?.message === "IG 回覆",
      `${igComment.delivery_status} ${igCall?.url || ""}`
    );

    fetchMode = "ok-message";
    calls.length = 0;
    const messenger = await adapters.queueOutboundReply(
      replyInput({
        source: "facebook",
        externalId: "mid.IN1",
        metaSurface: "message",
        metaSenderId: "178222222222222",
        commentId: 23,
        body: "Messenger 回覆",
      })
    );
    const msgCall = calls[0];
    const recipient = msgCall?.body?.recipient as { id?: string } | undefined;
    const message = msgCall?.body?.message as { text?: string } | undefined;
    check(
      "Messenger 打 POST /{page-id}/messages",
      messenger.delivery_status === "sent" &&
        calls.length === 1 &&
        msgCall?.url === `https://graph.facebook.com/${DEFAULT_META_GRAPH_VERSION}/${pageId}/messages` &&
        msgCall.authorization === `Bearer ${pageToken}` &&
        recipient?.id === "178222222222222" &&
        msgCall?.body?.messaging_type === "RESPONSE" &&
        message?.text === "Messenger 回覆",
      `${messenger.delivery_status} ${msgCall?.url || ""}`
    );

    calls.length = 0;
    const igDm = await adapters.queueOutboundReply(
      replyInput({
        source: "instagram",
        externalId: "aWdfZAG1faXRlbTox",
        metaSurface: "message",
        metaSenderId: "178333333333333",
        commentId: 24,
        body: "IG 私訊",
      })
    );
    const igDmCall = calls[0];
    const igRecipient = igDmCall?.body?.recipient as { id?: string } | undefined;
    check(
      "Instagram 私訊用 Page messages，唔帶 messaging_type",
      igDm.delivery_status === "sent" &&
        calls.length === 1 &&
        igDmCall?.url === `https://graph.facebook.com/${DEFAULT_META_GRAPH_VERSION}/${pageId}/messages` &&
        igRecipient?.id === "178333333333333" &&
        igDmCall?.body?.messaging_type == null &&
        (igDmCall?.body?.message as { text?: string } | undefined)?.text === "IG 私訊",
      `${igDm.delivery_status} ${JSON.stringify(igDmCall?.body || {})}`
    );

    calls.length = 0;
    const fromPrefix = await adapters.queueOutboundReply(
      replyInput({
        source: "facebook",
        externalId: "msg:178444444444444:你好",
        commentId: 25,
        body: "舊格式私訊",
      })
    );
    check(
      "舊 msg:{psid} 可以還原收件人",
      fromPrefix.delivery_status === "sent" &&
        calls.length === 1 &&
        (calls[0]?.body?.recipient as { id?: string } | undefined)?.id === "178444444444444",
      fromPrefix.error || calls[0]?.url || ""
    );

    calls.length = 0;
    const fakeId = await adapters.queueOutboundReply(
      replyInput({ source: "facebook", externalId: "fb-3001", metaSurface: "comment", commentId: 39 })
    );
    check(
      "示範 external_id 唔當 Graph comment id，唔打網絡",
      fakeId.delivery_status === "failed" && (fakeId.error || "").includes("Graph comment id") && calls.length === 0,
      fakeId.error || ""
    );

    calls.length = 0;
    const noPsid = await adapters.queueOutboundReply(
      replyInput({ source: "facebook", externalId: "mid.NOUSER", metaSurface: "message", commentId: 26 })
    );
    check(
      "私訊冇 PSID 就失敗，唔打 Graph",
      noPsid.delivery_status === "failed" && (noPsid.error || "").includes("PSID") && calls.length === 0,
      noPsid.error || ""
    );

    delete process.env.META_PAGE_ID;
    calls.length = 0;
    const noPage = await adapters.queueOutboundReply(
      replyInput({
        source: "instagram",
        externalId: "mid.IG",
        metaSurface: "message",
        metaSenderId: "178333333333333",
        commentId: 27,
      })
    );
    check(
      "私訊缺 META_PAGE_ID 就失敗，唔打 Graph",
      noPage.delivery_status === "failed" && (noPage.error || "").includes("META_PAGE_ID") && calls.length === 0,
      noPage.error || ""
    );

    process.env.META_PAGE_ID = "not-a-page";
    calls.length = 0;
    const badPage = await adapters.queueOutboundReply(
      replyInput({
        source: "facebook",
        externalId: "mid.BAD",
        metaSurface: "message",
        metaSenderId: "178222222222222",
        commentId: 28,
      })
    );
    check(
      "META_PAGE_ID 格式錯就失敗，唔打 Graph",
      badPage.delivery_status === "failed" && (badPage.error || "").includes("META_PAGE_ID") && calls.length === 0,
      badPage.error || ""
    );
    process.env.META_PAGE_ID = pageId;

    calls.length = 0;
    const tooLong = await adapters.queueOutboundReply(
      replyInput({
        source: "instagram",
        externalId: "mid.LONG",
        metaSurface: "message",
        metaSenderId: "178333333333333",
        commentId: 29,
        body: "長".repeat(1001),
      })
    );
    check(
      "IG 私訊超過 1000 字就失敗，唔打 Graph",
      tooLong.delivery_status === "failed" && (tooLong.error || "").includes("1000") && calls.length === 0,
      tooLong.error || ""
    );

    fetchMode = "graph-error";
    calls.length = 0;
    const graphFailed = await adapters.queueOutboundReply(
      replyInput({ source: "facebook", externalId: "178900000000001_9001", metaSurface: "comment", commentId: 30 })
    );
    check(
      "Graph 錯誤標失敗並保留原因",
      graphFailed.delivery_status === "failed" &&
        (graphFailed.error || "").includes("Permissions error") &&
        (graphFailed.error || "").includes("200") &&
        calls.length === 1,
      graphFailed.error || ""
    );

    fetchMode = "leak";
    calls.length = 0;
    const leaked = await adapters.queueOutboundReply(
      replyInput({ source: "instagram", externalId: "178900000000002", metaSurface: "comment", commentId: 31 })
    );
    check(
      "錯誤訊息唔會帶 Page token",
      leaked.delivery_status === "failed" &&
        (leaked.error || "").includes("[redacted]") &&
        !(leaked.error || "").includes(pageToken),
      leaked.error || ""
    );

    fetchMode = "throw";
    calls.length = 0;
    const thrown = await adapters.queueOutboundReply(
      replyInput({ source: "facebook", externalId: "178900000000001_9001", commentId: 32 })
    );
    check(
      "網絡錯誤標失敗，唔拋出",
      thrown.delivery_status === "failed" && (thrown.error || "").includes("ECONNREFUSED"),
      thrown.error || ""
    );

    fetchMode = "no-id";
    calls.length = 0;
    const noId = await adapters.queueOutboundReply(
      replyInput({ source: "facebook", externalId: "178900000000001_9001", commentId: 33 })
    );
    check(
      "Graph 200 但冇 id 唔當成功",
      noId.delivery_status === "failed" && (noId.error || "").includes("缺少 id"),
      noId.error || ""
    );

    process.env.META_GRAPH_VERSION = "v22.0";
    fetchMode = "ok-comment";
    calls.length = 0;
    const versioned = await adapters.queueOutboundReply(
      replyInput({ source: "instagram", externalId: "178900000000002", metaSurface: "comment", commentId: 34 })
    );
    check(
      "META_GRAPH_VERSION 會用喺 URL",
      versioned.delivery_status === "sent" && calls[0]?.url === "https://graph.facebook.com/v22.0/178900000000002/replies",
      calls[0]?.url || versioned.error || ""
    );

    process.env.META_GRAPH_VERSION = "latest";
    calls.length = 0;
    const badVersion = await adapters.queueOutboundReply(
      replyInput({ source: "facebook", externalId: "178900000000001_9001", commentId: 35 })
    );
    check(
      "META_GRAPH_VERSION 格式錯就失敗，唔打 Graph",
      badVersion.delivery_status === "failed" && (badVersion.error || "").includes("META_GRAPH_VERSION") && calls.length === 0,
      badVersion.error || ""
    );
    delete process.env.META_GRAPH_VERSION;

    calls.length = 0;
    const whatsapp = await adapters.queueOutboundReply(
      replyInput({
        source: "whatsapp",
        intakeKind: "whatsapp_click",
        originSite: "instagram",
        externalId: `wa:${COMPANY_WHATSAPP_PHONE}:85290001111`,
        waFromPhone: "85290001111",
        waToPhone: COMPANY_WHATSAPP_PHONE,
        commentId: 36,
      })
    );
    check(
      "WhatsApp 唔用 Page token",
      whatsapp.delivery_status === "failed" &&
        (whatsapp.error || "").includes("WHATSAPP_ACCESS_TOKEN") &&
        calls.length === 0,
      whatsapp.error || ""
    );

    calls.length = 0;
    const clickPref = await adapters.queueOutboundReply(
      replyInput({
        source: "instagram",
        intakeKind: "whatsapp_click",
        originSite: "instagram",
        externalId: "178900000000002",
        commentId: 37,
      })
    );
    check(
      "intakeKind=whatsapp_click 唔會打去 Instagram Graph",
      clickPref.delivery_status === "stub" && calls.length === 0,
      clickPref.delivery_status
    );

    calls.length = 0;
    const web = await adapters.queueOutboundReply(
      replyInput({ source: "glorious_web", externalId: "web-1", commentId: 38 })
    );
    check("官網出站仍然係 stub", web.delivery_status === "stub" && calls.length === 0, web.delivery_status);

    const info = appDb
      .prepare(
        `INSERT INTO comments (
           source, external_id, author_name, body, status, assignee_staff_id, intake_kind, meta_sender_id, meta_surface
         ) VALUES ('facebook', '178900000000001_9001', 'Cindy', '想問價錢', 'open', 1, 'site_comment', '178555555555555', 'comment')`
      )
      .run();
    fetchMode = "ok-comment";
    calls.length = 0;
    const stored = await replies.createStaffReply({
      commentId: Number(info.lastInsertRowid),
      staffId: 1,
      body: "系統內回覆會打 Graph",
    });
    const storedRow = appDb
      .prepare(`SELECT delivery_status, delivery_error FROM comment_replies WHERE comment_id = ?`)
      .get(Number(info.lastInsertRowid)) as { delivery_status: string; delivery_error: string | null };
    check(
      "createStaffReply 成功寫 sent，路由唔會拋出",
      stored.ok &&
        stored.reply.delivery_status === "sent" &&
        stored.reply.delivery_error == null &&
        stored.comment.status === "in_progress" &&
        storedRow.delivery_status === "sent" &&
        storedRow.delivery_error == null &&
        calls.length === 1 &&
        calls[0]?.url.endsWith("/178900000000001_9001/comments") &&
        calls[0]?.body?.message === "系統內回覆會打 Graph",
      stored.ok ? `${stored.reply.delivery_status} ${stored.reply.delivery_error || ""}` : stored.error
    );

    if (failures.length) {
      console.error(`\n${failures.length} 項失敗`);
      return 1;
    }
    console.log("\nFacebook／Instagram Graph 出站示範通過");
    return 0;
  } finally {
    globalThis.fetch = originalFetch;
    const restore = (key: keyof typeof saved): void => {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("DATABASE_PATH");
    restore("INBOX_DB");
    restore("WHATSAPP_ACCESS_TOKEN");
    restore("META_PAGE_ACCESS_TOKEN");
    restore("META_PAGE_ID");
    restore("META_IG_BUSINESS_ACCOUNT_ID");
    restore("META_GRAPH_VERSION");
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
