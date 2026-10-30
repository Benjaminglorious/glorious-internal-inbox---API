/**
 * 示範 routeWhatsAppInbound：
 * 公司總機用最少未完成、同數則較細 staff id；
 * 同事個人線路派畀綁定同事；未知線路入庫但未派。
 *
 * 先整一個舊 schema（source 冇 whatsapp）再載入 app，順便確認遷移。
 */
import fs from "fs";
import os from "os";
import path from "path";
import { createHmac } from "crypto";
import type { Server } from "http";
import type { AddressInfo } from "net";
import Database from "better-sqlite3";
import { COMPANY_WHATSAPP_PHONE } from "../config";

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

const WEBHOOK_TOKEN = "demo-webhook-token";

/** Meta messages webhook reference 嘅 Incoming text message 形狀；收件號用公司總機。 */
function metaIncomingSample(messageId: string, messages?: unknown[]): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "102290129340398",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: COMPANY_WHATSAPP_PHONE,
                phone_number_id: "106540352242922",
              },
              contacts: [
                {
                  profile: { name: "Sheena Nelson" },
                  wa_id: "16505551234",
                },
              ],
              messages: messages ?? [
                {
                  from: "16505551234",
                  id: messageId,
                  timestamp: "1749416383",
                  type: "text",
                  text: { body: "Does it come in another color?" },
                },
              ],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

function signBody(secret: string, raw: string): string {
  return "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
}

async function postWhatsApp(
  base: string,
  payload: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  const raw = JSON.stringify(payload);
  const res = await fetch(`${base}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw,
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

async function checkLiveWhatsAppWebhook(appDb: Database.Database): Promise<void> {
  process.env.WEBHOOK_VERIFY_TOKEN = WEBHOOK_TOKEN;
  delete process.env.META_APP_SECRET;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const express = require("express") as typeof import("express");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { whatsappWebhookRouter } = require("../routes/webhooks") as typeof import("../routes/webhooks");
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as import("express").Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    })
  );
  app.use("/api/webhooks/whatsapp", whatsappWebhookRouter);

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });

  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const company = appDb
      .prepare(`SELECT id FROM whatsapp_lines WHERE phone_e164 = ? AND kind = 'company' AND is_active = 1`)
      .get(COMPANY_WHATSAPP_PHONE) as { id: number } | undefined;

    const verify = await fetch(
      `${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(WEBHOOK_TOKEN)}&hub.challenge=challenge-ok`
    );
    check(
      "GET hub.verify 回 challenge",
      verify.status === 200 && (await verify.text()) === "challenge-ok"
    );
    const badVerify = await fetch(
      `${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=challenge-ok`
    );
    check("GET hub.verify token 唔啱回 403", badVerify.status === 403);

    const sampleId = "wamid.HTTP-SAMPLE";
    const sample = metaIncomingSample(sampleId);
    const open = await postWhatsApp(base, sample);
    const openResult = Array.isArray(open.json.results) ? (open.json.results[0] as Record<string, unknown>) : undefined;
    const stored = appDb
      .prepare(
        `SELECT source, intake_kind, origin_site, author_name, body, assignee_staff_id
         FROM comments WHERE external_id = ?`
      )
      .get(sampleId) as
      | {
          source: string;
          intake_kind: string;
          origin_site: string | null;
          author_name: string;
          body: string;
          assignee_staff_id: number | null;
        }
      | undefined;
    check(
      "Meta 樣本冇 X-Webhook-Token 入公司總機",
      open.status === 200 &&
        open.json.ok === true &&
        openResult?.outcome === "company" &&
        openResult?.created === true &&
        openResult?.line_id === company?.id &&
        openResult?.intake_kind === "whatsapp_click" &&
        stored?.source === "whatsapp" &&
        stored?.intake_kind === "whatsapp_click" &&
        stored?.origin_site == null &&
        stored?.author_name === "Sheena Nelson" &&
        stored?.body === "Does it come in another color?" &&
        stored?.assignee_staff_id != null,
      `status=${open.status} body=${JSON.stringify(open.json)}`
    );

    const wrongToken = await postWhatsApp(base, sample, { "x-webhook-token": "nope" });
    check(
      "帶咗錯 X-Webhook-Token 回 401",
      wrongToken.status === 401 && wrongToken.json.error === "webhook token 不正確"
    );
    const wrongBearer = await postWhatsApp(base, sample, { authorization: "Bearer nope" });
    check(
      "帶咗錯 Bearer 回 401",
      wrongBearer.status === 401 && wrongBearer.json.error === "webhook token 不正確"
    );

    const stub = await postWhatsApp(
      base,
      {
        to: COMPANY_WHATSAPP_PHONE,
        from: "85290001111",
        body: "想問 Alphard 有冇現貨",
        external_id: "stub-token-1",
      },
      { "x-webhook-token": WEBHOOK_TOKEN }
    );
    const stubResult = Array.isArray(stub.json.results) ? (stub.json.results[0] as Record<string, unknown>) : undefined;
    check(
      "stub 帶 X-Webhook-Token 仍然入公司總機",
      stub.status === 200 && stub.json.ok === true && stubResult?.outcome === "company" && stubResult?.created === true
    );
    const bearer = await postWhatsApp(
      base,
      {
        to: COMPANY_WHATSAPP_PHONE,
        from: "85290001112",
        body: "Bearer stub",
        external_id: "stub-bearer-1",
      },
      { authorization: `Bearer ${WEBHOOK_TOKEN}` }
    );
    check("stub 帶 Bearer 仍然成功", bearer.status === 200 && bearer.json.ok === true);

    const secret = "test-meta-app-secret";
    process.env.META_APP_SECRET = secret;
    const unsigned = await postWhatsApp(base, metaIncomingSample("wamid.UNSIGNED"));
    check(
      "有 secret 但冇簽名回 401",
      unsigned.status === 401 && unsigned.json.error === "缺少或無效 X-Hub-Signature-256"
    );
    const rawBad = JSON.stringify(metaIncomingSample("wamid.BADSIG"));
    const badSig = await fetch(`${base}/api/webhooks/whatsapp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body: rawBad,
    });
    const badSigJson = (await badSig.json()) as { error?: string };
    check(
      "簽名錯誤回 401",
      badSig.status === 401 && badSigJson.error === "X-Hub-Signature-256 不正確"
    );

    const signedId = "wamid.SIGNED";
    const signedPayload = metaIncomingSample(signedId);
    const signedRaw = JSON.stringify(signedPayload);
    const signed = await fetch(`${base}/api/webhooks/whatsapp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signBody(secret, signedRaw),
      },
      body: signedRaw,
    });
    const signedJson = (await signed.json()) as { ok?: boolean; results?: Array<{ outcome?: string; created?: boolean }> };
    check(
      "簽名正確且冇自訂 token 入庫",
      signed.status === 200 &&
        signedJson.ok === true &&
        signedJson.results?.[0]?.outcome === "company" &&
        signedJson.results?.[0]?.created === true
    );
    const signedWrongToken = await fetch(`${base}/api/webhooks/whatsapp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signBody(secret, signedRaw),
        "x-webhook-token": "nope",
      },
      body: signedRaw,
    });
    check("簽名啱但 token 錯仍回 401", signedWrongToken.status === 401);
    const signedGoodToken = await fetch(`${base}/api/webhooks/whatsapp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signBody(secret, signedRaw),
        "x-webhook-token": WEBHOOK_TOKEN,
      },
      body: signedRaw,
    });
    const signedGoodJson = (await signedGoodToken.json()) as { ok?: boolean; results?: Array<{ created?: boolean }> };
    check(
      "簽名同 token 都啱仍然成功",
      signedGoodToken.status === 200 && signedGoodJson.ok === true && signedGoodJson.results?.[0]?.created === false
    );
    delete process.env.META_APP_SECRET;

    const statuses = await postWhatsApp(base, {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "102290129340398",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: COMPANY_WHATSAPP_PHONE,
                  phone_number_id: "106540352242922",
                },
                statuses: [
                  {
                    id: "wamid.STATUS",
                    status: "delivered",
                    timestamp: "1749416400",
                    recipient_id: "16505551234",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    check(
      "狀態回呼忽略",
      statuses.status === 200 && statuses.json.ok === true && statuses.json.ignored === true
    );

    const imageOnly = await postWhatsApp(
      base,
      metaIncomingSample("wamid.IMAGE-ONLY", [
        {
          from: "85290008881",
          id: "wamid.IMAGE-ONLY",
          timestamp: "1749416383",
          type: "image",
          image: { mime_type: "image/jpeg", sha256: "abc", id: "media-1" },
        },
      ])
    );
    const imageRow = appDb.prepare(`SELECT id FROM comments WHERE external_id = 'wamid.IMAGE-ONLY'`).get();
    check(
      "純媒體訊息忽略（唔下載）",
      imageOnly.status === 200 && imageOnly.json.ok === true && imageOnly.json.ignored === true && imageRow == null
    );

    const mixedId = "wamid.MIX-TEXT";
    const mixed = await postWhatsApp(
      base,
      metaIncomingSample(mixedId, [
        {
          from: "85290008882",
          id: mixedId,
          timestamp: "1749416383",
          type: "text",
          text: { body: "文字同圖" },
        },
        {
          from: "85290008882",
          id: "wamid.MIX-IMG",
          timestamp: "1749416384",
          type: "image",
          image: { mime_type: "image/jpeg", sha256: "def", id: "media-2" },
        },
      ])
    );
    const mixedText = appDb.prepare(`SELECT body FROM comments WHERE external_id = ?`).get(mixedId) as
      | { body: string }
      | undefined;
    const mixedImage = appDb.prepare(`SELECT id FROM comments WHERE external_id = 'wamid.MIX-IMG'`).get();
    const mixedResults = Array.isArray(mixed.json.results) ? mixed.json.results : [];
    check(
      "文字加圖片只入文字",
      mixed.status === 200 &&
        mixed.json.ok === true &&
        mixedResults.length === 1 &&
        mixedText?.body === "文字同圖" &&
        mixedImage == null
    );

    delete process.env.WEBHOOK_VERIFY_TOKEN;
    const missingEnv = await postWhatsApp(base, sample);
    check(
      "未設 WEBHOOK_VERIFY_TOKEN 回 503",
      missingEnv.status === 503 && missingEnv.json.error === "WEBHOOK_VERIFY_TOKEN 未設定"
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    process.env.WEBHOOK_VERIFY_TOKEN = WEBHOOK_TOKEN;
    delete process.env.META_APP_SECRET;
  }
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-wa-"));
  const dbFile = path.join(tmp, "inbox.db");
  let appDb: Database.Database | undefined;

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
        source TEXT NOT NULL CHECK (source IN ('28car', 'glorious_web', 'facebook')),
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
      INSERT INTO staff (username, display_name, password_hash, is_admin, active)
      VALUES ('loaded', '同事甲', 'x', 0, 1);
      INSERT INTO comments (source, external_id, author_name, body, vehicle_ref, status, assignee_staff_id)
      VALUES ('28car', 'legacy-1', '舊客', '遷移前留言', NULL, 'open', 1);
    `);
    legacy.close();

    process.env.DATABASE_PATH = dbFile;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as typeof import("../db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wa = require("../services/whatsapp") as typeof import("../services/whatsapp");
    appDb = dbMod.db;

    const ddl = appDb
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comments'`)
      .get() as { sql: string };
    const commentCount = appDb.prepare(`SELECT COUNT(*) AS n FROM comments`).get() as { n: number };
    check("舊留言遷移後仍在", commentCount.n === 1);
    check("comments.source 包含 whatsapp", ddl.sql.includes("whatsapp"));
    check("comments.source 包含 instagram", ddl.sql.includes("'instagram'"));
    check("comments 有 intake_kind", ddl.sql.includes("intake_kind"));

    const survived = appDb.prepare(`SELECT body, assignee_staff_id FROM comments WHERE id = 1`).get() as {
      body: string;
      assignee_staff_id: number;
    };
    check("遷移保留內容同負責人", survived.body === "遷移前留言" && survived.assignee_staff_id === 1);
    const legacyKind = appDb
      .prepare(`SELECT intake_kind, origin_site FROM comments WHERE external_id = 'legacy-1'`)
      .get() as { intake_kind: string; origin_site: string | null };
    check(
      "舊 28car 留言係網站留言",
      legacyKind.intake_kind === "site_comment" && legacyKind.origin_site == null
    );

    const staffB = appDb
      .prepare(
        `INSERT INTO staff (username, display_name, password_hash, is_admin, active)
         VALUES ('free', '同事乙', 'x', 0, 1)`
      )
      .run();
    const staffAId = 1;
    const staffBId = Number(staffB.lastInsertRowid);

    wa.ensureCompanyWhatsAppLine();
    const company = wa.listWhatsAppLines().find((line) => line.phone_e164 === COMPANY_WHATSAPP_PHONE);
    check(
      "seed 公司總機 85221740001／東榮總機",
      !!company && company.kind === "company" && company.staff_id == null && company.display_label === "東榮總機"
    );

    const staffPhone = "85261111111";
    const bound = wa.addStaffWhatsAppLine({ staffId: staffAId, phone: "+852 6111-1111", displayLabel: "同事甲個人" });
    check("綁定同事甲個人線路", bound.ok && bound.ok && bound.line.staff_id === staffAId);
    check("拒絕重複綁定", !wa.addStaffWhatsAppLine({ staffId: staffBId, phone: staffPhone }).ok);
    check(
      "拒絕將總機綁成個人線路",
      !wa.addStaffWhatsAppLine({ staffId: staffBId, phone: "85221740001" }).ok
    );

    let staffCheckFailed = false;
    try {
      appDb
        .prepare(
          `INSERT INTO whatsapp_lines (phone_e164, display_label, kind, staff_id, is_active)
           VALUES ('85269999999', 'bad', 'staff', NULL, 1)`
        )
        .run();
    } catch {
      staffCheckFailed = true;
    }
    check("staff 線路必須有 staff_id", staffCheckFailed);

    const company1 = wa.routeWhatsAppInbound({
      toPhone: "+852 2174 0001",
      fromPhone: "85290000001",
      body: "總機第一則",
      externalId: "m-company-1",
    });
    check(
      "總機第一則派畀未完成較少嘅同事乙",
      company1.ok && company1.outcome === "company" && company1.assigneeStaffId === staffBId,
      company1.ok ? `assignee=${company1.assigneeStaffId} outcome=${company1.outcome}` : company1.error
    );

    const staffMsg = wa.routeWhatsAppInbound({
      toPhone: staffPhone,
      fromPhone: "85290000002",
      body: "打去同事甲",
      externalId: "m-staff-1",
      authorName: "陳生",
    });
    check(
      "個人線路派畀同事甲（即使未完成較多）",
      staffMsg.ok && staffMsg.outcome === "staff" && staffMsg.assigneeStaffId === staffAId && staffMsg.comment.author_name === "陳生",
      staffMsg.ok ? `assignee=${staffMsg.assigneeStaffId}` : staffMsg.error
    );

    const company2 = wa.routeWhatsAppInbound({
      toPhone: COMPANY_WHATSAPP_PHONE,
      fromPhone: "85290000003",
      body: "總機第二則",
      externalId: "m-company-2",
    });
    check(
      "總機第二則仍派同事乙（甲已有舊單加個人線路）",
      company2.ok && company2.assigneeStaffId === staffBId,
      company2.ok ? `assignee=${company2.assigneeStaffId}` : company2.error
    );

    const company3 = wa.routeWhatsAppInbound({
      toPhone: "0085221740001",
      fromPhone: "85290000004",
      body: "總機第三則（同數取較細 id）",
      externalId: "m-company-3",
    });
    check(
      "未完成同數時派 staff id 較細嘅同事甲",
      company3.ok && company3.outcome === "company" && company3.assigneeStaffId === staffAId,
      company3.ok ? `assignee=${company3.assigneeStaffId} A=${staffAId} B=${staffBId}` : company3.error
    );

    const retry = wa.routeWhatsAppInbound({
      toPhone: COMPANY_WHATSAPP_PHONE,
      fromPhone: "85290000001",
      body: "總機第一則",
      externalId: "m-company-1",
    });
    check(
      "同一 externalId 冪等、唔改派",
      retry.ok &&
        company1.ok &&
        retry.created === false &&
        retry.comment.id === company1.comment.id &&
        retry.assigneeStaffId === staffBId &&
        retry.comment.body === "總機第一則",
      retry.ok ? `id=${retry.comment.id} created=${retry.created}` : retry.error
    );

    const unknown = wa.routeWhatsAppInbound({
      toPhone: "85269998888",
      fromPhone: "85290000005",
      body: "打去未綁定號碼",
      externalId: "m-unknown-1",
    });
    check(
      "未知線路入庫但未派",
      unknown.ok && unknown.outcome === "unassigned_unknown_line" && unknown.assigneeStaffId == null,
      unknown.ok ? `outcome=${unknown.outcome} assignee=${unknown.assigneeStaffId}` : unknown.error
    );

    const thread1 = wa.routeWhatsAppInbound({
      toPhone: staffPhone,
      fromPhone: "85292220000",
      body: "第一句",
    });
    const thread2 = wa.routeWhatsAppInbound({
      toPhone: staffPhone,
      fromPhone: "85292220000",
      body: "第二句",
    });
    check(
      "冇 externalId 時同一客人合成對話並維持同事甲",
      thread1.ok &&
        thread2.ok &&
        thread2.created === false &&
        thread2.comment.id === thread1.comment.id &&
        thread2.comment.body.includes("第一句") &&
        thread2.comment.body.includes("第二句") &&
        thread2.assigneeStaffId === staffAId
    );

    if (bound.ok) {
      const deactivated = wa.deactivateWhatsAppLine(bound.line.id);
      check("停用同事線路", deactivated.ok && deactivated.line.is_active === false);
    }
    const afterOff = wa.routeWhatsAppInbound({
      toPhone: staffPhone,
      fromPhone: "85290000006",
      body: "線路已停用",
      externalId: "m-staff-off",
    });
    check(
      "已停用線路當未知線路",
      afterOff.ok && afterOff.outcome === "unassigned_unknown_line" && afterOff.assigneeStaffId == null
    );

    const rebound = wa.addStaffWhatsAppLine({ staffId: staffAId, phone: staffPhone });
    check("重新綁定已停用號碼", rebound.ok && rebound.line.is_active);
    appDb.prepare(`UPDATE staff SET active = 0 WHERE id = ?`).run(staffAId);
    const inactiveStaff = wa.routeWhatsAppInbound({
      toPhone: staffPhone,
      fromPhone: "85290000007",
      body: "同事已停用",
      externalId: "m-staff-inactive",
    });
    check(
      "綁定同事已停用則未派",
      inactiveStaff.ok &&
        inactiveStaff.outcome === "unassigned_inactive_staff" &&
        inactiveStaff.assigneeStaffId == null
    );

    const meta = wa.parseWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: "+852 2174 0001" },
                contacts: [{ wa_id: "85293330000", profile: { name: "阿強" } }],
                messages: [
                  {
                    from: "85293330000",
                    id: "wamid.DEMO",
                    type: "text",
                    text: { body: "Alphard 幾多錢？" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    check("Meta payload 解析到一則文字", meta.messages.length === 1 && meta.messages[0]?.authorName === "阿強");
    const official = wa.parseWhatsAppWebhookPayload(metaIncomingSample("wamid.OFFICIAL-SAMPLE"));
    check(
      "Meta Incoming Message 樣本用 display_phone_number 對公司總機",
      official.messages.length === 1 &&
        official.messages[0]?.toPhone === COMPANY_WHATSAPP_PHONE &&
        official.messages[0]?.fromPhone === "16505551234" &&
        official.messages[0]?.authorName === "Sheena Nelson" &&
        official.messages[0]?.body === "Does it come in another color?" &&
        !official.error
    );
    const officialRouted = official.messages[0] ? wa.routeWhatsAppInbound(official.messages[0]) : null;
    check(
      "樣本訊息派去公司總機",
      !!officialRouted?.ok &&
        officialRouted.outcome === "company" &&
        officialRouted.line?.phone_e164 === COMPANY_WHATSAPP_PHONE &&
        officialRouted.comment.source === "whatsapp" &&
        officialRouted.comment.intake_kind === "whatsapp_click"
    );
    const metaRouted = meta.messages[0] ? wa.routeWhatsAppInbound(meta.messages[0]) : null;
    check(
      "Meta 總機訊息入庫",
      !!metaRouted?.ok && metaRouted.outcome === "company" && metaRouted.comment.author_name === "阿強" && metaRouted.comment.source === "whatsapp"
    );

    const statusOnly = wa.parseWhatsAppWebhookPayload({
      entry: [{ changes: [{ value: { statuses: [{ id: "wamid.x", status: "delivered" }] } }] }],
    });
    check("Meta 狀態回呼忽略", statusOnly.ignored && statusOnly.messages.length === 0 && !statusOnly.error);

    const bad = wa.parseWhatsAppWebhookPayload({ foo: 1 });
    check("認唔到嘅 JSON 回報錯誤", !!bad.error && bad.messages.length === 0);

    const fromIg = wa.routeWhatsAppInbound({
      toPhone: COMPANY_WHATSAPP_PHONE,
      fromPhone: "85296660001",
      body: "IG 別名",
      externalId: "m-ig-1",
      originSite: "ig",
    });
    check(
      "origin ig 正規化成 instagram，來源仍然係 whatsapp",
      fromIg.ok &&
        fromIg.comment.source === "whatsapp" &&
        fromIg.comment.intake_kind === "whatsapp_click" &&
        fromIg.comment.origin_site === "instagram",
      fromIg.ok ? `origin=${fromIg.comment.origin_site}` : fromIg.error
    );
    const retryOrigin = wa.routeWhatsAppInbound({
      toPhone: COMPANY_WHATSAPP_PHONE,
      fromPhone: "85296660001",
      body: "IG 別名",
      externalId: "m-ig-1",
      originSite: "facebook",
    });
    check(
      "已有來源唔會被後續 webhook 改走",
      retryOrigin.ok && retryOrigin.created === false && retryOrigin.comment.origin_site === "instagram"
    );

    const bioUrl = "http://glorious.hk/?utm_source=ig&utm_medium=social&utm_content=link_in_bio";
    const parsedIg = wa.parseWhatsAppWebhookPayload({
      to: COMPANY_WHATSAPP_PHONE,
      from: "85296660002",
      body: "link in bio",
      external_id: "m-ig-utm",
      referral: { source_url: bioUrl },
    });
    check(
      "glorious.hk?utm_source=ig 係 Instagram 而唔係官網",
      !parsedIg.error && parsedIg.messages[0]?.originSite === "instagram"
    );
    const routedIg = parsedIg.messages[0] ? wa.routeWhatsAppInbound(parsedIg.messages[0]) : null;
    check(
      "bio link 入庫係 whatsapp + origin instagram",
      !!routedIg?.ok && routedIg.comment.origin_site === "instagram" && routedIg.comment.source === "whatsapp"
    );

    const wrapped =
      "https://l.instagram.com/?u=" +
      encodeURIComponent("http://glorious.hk/?utm_source=ig&utm_medium=social&utm_content=link_in_bio");
    const wrappedParsed = wa.parseWhatsAppWebhookPayload({
      to: COMPANY_WHATSAPP_PHONE,
      from: "85296660003",
      body: "wrapped bio",
      external_id: "m-ig-wrap",
      referral: { source_url: wrapped },
    });
    check("l.instagram.com 展開後仍係 Instagram", wrappedParsed.messages[0]?.originSite === "instagram");

    const webOnly = wa.parseWhatsAppWebhookPayload({
      to: COMPANY_WHATSAPP_PHONE,
      from: "85296660004",
      body: "官網掣",
      external_id: "m-web-1",
      referral: { source_url: "https://glorious.hk/cn2/" },
    });
    check("冇 utm 嘅官網連結仍然係 glorious_web", webOnly.messages[0]?.originSite === "glorious_web");

    const bioContentOnly = wa.parseWhatsAppWebhookPayload({
      to: COMPANY_WHATSAPP_PHONE,
      from: "85296660005",
      body: "只有 link_in_bio",
      external_id: "m-ig-content",
      referral: { source_url: "http://glorious.hk/?utm_medium=social&utm_content=link_in_bio" },
    });
    check("utm_content=link_in_bio 亦當 Instagram", bioContentOnly.messages[0]?.originSite === "instagram");

    const badOrigin = wa.routeWhatsAppInbound({
      toPhone: COMPANY_WHATSAPP_PHONE,
      fromPhone: "85296660009",
      body: "bad origin",
      externalId: "m-bad-origin",
      originSite: "craigslist",
    });
    check("拒絕未知 origin_site", !badOrigin.ok);

    let rejectedKind = false;
    try {
      appDb
        .prepare(
          `INSERT INTO comments (source, external_id, author_name, body, intake_kind)
           VALUES ('whatsapp', 'bad-kind', 'x', 'y', 'site_comment')`
        )
        .run();
    } catch {
      rejectedKind = true;
    }
    check("whatsapp 唔可以係網站留言", rejectedKind);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const replies = require("../services/replies") as typeof import("../services/replies");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const commentsApi = require("../services/comments") as typeof import("../services/comments");
    if (routedIg?.ok) {
      const sent = replies.createStaffReply({
        commentId: routedIg.comment.id,
        staffId: staffBId,
        body: "系統內回覆 IG WhatsApp",
      });
      check(
        "WhatsApp 回覆標為 stub 並改處理中",
        sent.ok &&
          sent.reply.delivery_status === "stub" &&
          sent.reply.direction === "outbound" &&
          sent.comment.status === "in_progress" &&
          sent.comment.reply_count === 1,
        sent.ok ? `status=${sent.comment.status}` : sent.error
      );
      const pending = commentsApi.listComments({ status: "pending" });
      check(
        "回覆後仍喺擱置／未處理",
        sent.ok && pending.some((row) => row.id === sent.comment.id && (row.last_reply_body || "").includes("系統內回覆"))
      );
      const openOnly = commentsApi.listComments({ status: "open" });
      check("已回覆唔再標未處理", sent.ok && !openOnly.some((row) => row.id === sent.comment.id));
      const igOrigin = commentsApi.listComments({ origin: "instagram", intake: "whatsapp_click" });
      check(
        "篩選來自 IG 的 WhatsApp",
        igOrigin.some((row) => row.id === routedIg.comment.id)
      );
      const asWeb = commentsApi.listComments({ source: "glorious_web" });
      check(
        "IG bio 唔出現喺官網來源",
        !asWeb.some((row) => row.id === routedIg.comment.id)
      );
    } else {
      check("有 IG bio 留言先至測回覆", false);
    }

    const igInsert = appDb
      .prepare(
        `INSERT INTO comments (
           source, external_id, author_name, body, intake_kind, origin_site, status, assignee_staff_id
         ) VALUES ('instagram', 'ig-demo', 'IG用戶', '帖文留言', 'site_comment', NULL, 'open', ?)`
      )
      .run(staffBId);
    const igReply = replies.createStaffReply({
      commentId: Number(igInsert.lastInsertRowid),
      staffId: staffBId,
      body: "IG 留言回覆",
    });
    check(
      "東榮 IG 留言可喺系統內回覆",
      igReply.ok &&
        igReply.comment.source === "instagram" &&
        igReply.comment.intake_kind === "site_comment" &&
        igReply.comment.origin_site == null &&
        igReply.reply.delivery_status === "stub" &&
        igReply.comment.status === "in_progress",
      igReply.ok ? `source=${igReply.comment.source}` : igReply.error
    );
    const igList = commentsApi.listComments({ source: "instagram", intake: "site_comment" });
    check(
      "IG 留言篩選",
      igReply.ok && igList.some((row) => row.id === igReply.comment.id)
    );
    const emptyReply = replies.createStaffReply({
      commentId: Number(igInsert.lastInsertRowid),
      staffId: staffBId,
      body: "   ",
    });
    check("空回覆拒絕", !emptyReply.ok);
    if (igReply.ok) {
      commentsApi.updateStatus(igReply.comment.id, "done");
      const afterDone = replies.createStaffReply({
        commentId: igReply.comment.id,
        staffId: staffBId,
        body: "完成後再補一句",
      });
      check(
        "已完成唔會因為回覆重新打開",
        afterDone.ok && afterDone.comment.status === "done" && afterDone.comment.reply_count === 2
      );
    }

    const openCounts = appDb
      .prepare(
        `SELECT assignee_staff_id AS id, COUNT(*) AS n
         FROM comments
         WHERE status IN ('open', 'in_progress') AND assignee_staff_id IS NOT NULL
         GROUP BY assignee_staff_id
         ORDER BY id`
      )
      .all();
    console.log("未完成分佈：", openCounts);

    await checkLiveWhatsAppWebhook(appDb);

    if (failures.length) {
      console.error(`\n${failures.length} 項失敗`);
      return 1;
    }
    console.log("\nrouteWhatsAppInbound 示範通過");
    return 0;
  } finally {
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
