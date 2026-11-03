/**
 * 同事用自己 WhatsApp 回覆客戶，以及收件箱相片／影片／語音。
 * 臨時 SQLite。Graph 用 mock fetch，唔會打去 Meta。
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type Database from "better-sqlite3";
import { COMPANY_WHATSAPP_PHONE } from "../config";
import { remuxWebmOpusToOgg } from "../services/ogg-opus";

const failures: string[] = [];
const DEMO_PASSWORD = "Glorious2026!";
const CUSTOMER = "85297770000";
const STAFF_PHONE = "85261112222";
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0xff, 0xd9,
]);

function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) {
    failures.push(detail ? `${name} — ${detail}` : name);
    console.error(`FAIL ${detail ? `${name} — ${detail}` : name}`);
    return;
  }
  console.log(`OK   ${name}`);
}

function cookieHeader(res: Response): string {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return raw
    .map((item) => item.split(";")[0])
    .filter((item) => item.startsWith("connect.sid="))
    .join("; ");
}

function sizeVint(size: number): Buffer {
  if (size < 127) return Buffer.from([0x80 | size]);
  if (size < 0x3fff) return Buffer.from([0x40 | ((size >> 8) & 0x3f), size & 0xff]);
  throw new Error(`element too big ${size}`);
}

function el(id: Buffer, data: Buffer): Buffer {
  return Buffer.concat([id, sizeVint(data.length), data]);
}

function sampleWebm(): Buffer {
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "ascii");
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(48000, 12);
  const track = el(
    Buffer.from([0xae]),
    Buffer.concat([
      el(Buffer.from([0xd7]), Buffer.from([0x01])),
      el(Buffer.from([0x83]), Buffer.from([0x02])),
      el(Buffer.from([0x86]), Buffer.from("A_OPUS")),
      el(Buffer.from([0x63, 0xa2]), head),
    ])
  );
  const block = Buffer.concat([
    Buffer.from([0x81, 0x00, 0x00, 0x80, 0xf8, 0x11, 0x22, 0x33]),
  ]);
  const cluster = el(Buffer.from([0x1f, 0x43, 0xb6, 0x75]), el(Buffer.from([0xa3]), block));
  const tracks = el(Buffer.from([0x16, 0x54, 0xae, 0x6b]), track);
  const segment = el(Buffer.from([0x18, 0x53, 0x80, 0x67]), Buffer.concat([tracks, cluster]));
  const ebml = el(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), el(Buffer.from([0x42, 0x86]), Buffer.from([0x01])));
  return Buffer.concat([ebml, segment]);
}

function bodyBuffer(body: unknown): Buffer {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  return Buffer.alloc(0);
}

async function main(): Promise<number> {

  const synthetic = sampleWebm();
  const ogg = remuxWebmOpusToOgg(synthetic);
  check(
    "WebM Opus 轉成 Ogg",
    ogg.toString("ascii", 0, 4) === "OggS" && ogg.includes(Buffer.from("OpusHead")) && ogg.includes(Buffer.from([0xf8, 0x11, 0x22, 0x33]))
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-media-"));
  try {
    const webmPath = path.join(tmp, "tone.webm");
    const oggPath = path.join(tmp, "tone.ogg");
    execFileSync(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.25", "-c:a", "libopus", "-b:a", "24k", "-f", "webm", webmPath],
      { stdio: "ignore" }
    );
    const realOgg = remuxWebmOpusToOgg(fs.readFileSync(webmPath));
    fs.writeFileSync(oggPath, realOgg);
    const codec = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", oggPath],
      { encoding: "utf8" }
    ).trim();
    check("ffmpeg WebM 轉出嘅 Ogg 係 Opus", codec === "opus", codec);
  } catch (err) {
    check("ffmpeg WebM 轉出嘅 Ogg 係 Opus", false, err instanceof Error ? err.message : String(err));
  }

  const dbFile = path.join(tmp, "inbox.db");
  let appDb: Database.Database | undefined;
  let server: Server | undefined;
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; contentType: string; body: Buffer }> = [];

  try {
    process.env.INBOX_DB = "sqlite";
    process.env.DATABASE_PATH = dbFile;
    process.env.WHATSAPP_ACCESS_TOKEN = "wa-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "555001";
    delete process.env.META_PAGE_ACCESS_TOKEN;
    delete process.env.VAPID_PUBLIC_KEY;

    globalThis.fetch = (async (input: unknown, init?: { method?: string; headers?: unknown; body?: unknown }) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
        return (originalFetch as (input: unknown, init?: unknown) => Promise<Response>)(input, init);
      }
      const headers =
        init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)
          ? (init.headers as Record<string, string>)
          : {};
      const method = init?.method || "GET";
      const body = bodyBuffer(init?.body);
      calls.push({
        url,
        method,
        contentType: headers["Content-Type"] || headers["content-type"] || "",
        body,
      });
      if (url.startsWith("https://lookaside.fbsbx.com/")) {
        return new Response(new Uint8Array(JPEG), { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      if (method === "GET" && url.startsWith("https://graph.facebook.com/")) {
        return new Response(
          JSON.stringify({
            url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1",
            mime_type: "image/jpeg",
            file_size: JPEG.length,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (method === "POST" && url.endsWith("/media")) {
        return new Response(JSON.stringify({ id: "uploaded-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && (url.endsWith("/messages") || url.includes("/message_attachments"))) {
        return new Response(JSON.stringify({ messages: [{ id: "wamid.MEDIAOUT" }], attachment_id: "att-1", id: "m_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as typeof import("../db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const passwords = require("../auth/passwords") as typeof import("../auth/passwords");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wa = require("../services/whatsapp") as typeof import("../services/whatsapp");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mediaFetch = require("../services/media-fetch") as typeof import("../services/media-fetch");

    check("拒絕把公司總機當客戶", wa.resolveWhatsAppCustomerPhone({
      source: "whatsapp",
      externalId: `wa:${COMPANY_WHATSAPP_PHONE}:${CUSTOMER}`,
      waFromPhone: COMPANY_WHATSAPP_PHONE,
      waToPhone: COMPANY_WHATSAPP_PHONE,
    }) === CUSTOMER);
    check(
      "同事線路客戶號碼唔係同事號碼",
      wa.resolveWhatsAppCustomerPhone({
        source: "whatsapp",
        externalId: "wamid.X",
        waFromPhone: CUSTOMER,
        waToPhone: STAFF_PHONE,
      }) === CUSTOMER
    );
    check(
      "Facebook 留言唔組 WhatsApp 客戶連結",
      wa.resolveWhatsAppCustomerPhone({
        source: "facebook",
        externalId: "1",
        waFromPhone: CUSTOMER,
        waToPhone: null,
      }) == null
    );
    const customerUrl = wa.staffToCustomerWhatsAppUrl(CUSTOMER, "你好");
    check(
      "深連結指向客戶而且預填文字",
      customerUrl === `https://api.whatsapp.com/send?phone=${CUSTOMER}&text=${encodeURIComponent("你好")}`
    );
    check("公司總機唔可以做深連結目標", wa.staffToCustomerWhatsAppUrl(COMPANY_WHATSAPP_PHONE) == null);
    check(
      "localhost 唔係媒體網域",
      !mediaFetch.isMediaHostAllowed("127.0.0.1") && !mediaFetch.isMediaHostAllowed("169.254.169.254")
    );
    check(
      "Meta CDN 先可以下載",
      mediaFetch.isMediaHostAllowed("lookaside.fbsbx.com") && !mediaFetch.isMediaHostAllowed("evil.com")
    );
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const replies = require("../services/replies") as typeof import("../services/replies");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const express = require("express") as typeof import("express");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const session = require("express-session") as typeof import("express-session");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const apiRoutes = require("../routes/api") as typeof import("../routes/api");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pageRoutes = require("../routes/pages") as typeof import("../routes/pages");

    appDb = dbMod.db;
    const hash = passwords.hashPassword(DEMO_PASSWORD);
    const insertStaff = appDb.prepare(
      `INSERT INTO staff (username, display_name, password_hash, is_admin, active) VALUES (?, ?, ?, ?, 1)`
    );
    const wingId = Number(insertStaff.run("wing", "Wing Cheng", hash, 0).lastInsertRowid);
    const jasonId = Number(insertStaff.run("jason", "Jason Cheng", hash, 0).lastInsertRowid);
    wa.ensureCompanyWhatsAppLine();
    const bound = wa.addStaffWhatsAppLine({ staffId: wingId, phone: STAFF_PHONE, displayLabel: "Wing WhatsApp" });
    check("綁定 Wing 個人號", bound.ok);
    const voiceParsed = wa.parseWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: COMPANY_WHATSAPP_PHONE },
                messages: [
                  {
                    from: CUSTOMER,
                    id: "wamid.VOICE",
                    type: "audio",
                    audio: { id: "123456789000009", mime_type: "audio/ogg; codecs=opus", voice: true },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    check(
      "客戶語音訊息會標成可播放語音",
      voiceParsed.messages.length === 1 &&
        voiceParsed.messages[0]?.body === "［語音］" &&
        voiceParsed.messages[0]?.media?.isVoice === true
    );

    const staffInbound = wa.routeWhatsAppInbound({
      toPhone: STAFF_PHONE,
      fromPhone: CUSTOMER,
      body: "Wing 我想問車",
      externalId: "wamid.STAFFCUST",
      authorName: "陳先生",
    });
    const companyInbound = wa.routeWhatsAppInbound({
      toPhone: COMPANY_WHATSAPP_PHONE,
      fromPhone: "85296660000",
      body: "總機想搵同事",
      externalId: "wamid.COMPANYCUST",
      authorName: "李先生",
    });
    if (companyInbound.ok && companyInbound.comment.assignee_staff_id !== wingId) {
      appDb.prepare(`UPDATE comments SET assignee_staff_id = ? WHERE id = ?`).run(wingId, companyInbound.comment.id);
    }
    const imageInbound = wa.routeWhatsAppInbound({
      toPhone: COMPANY_WHATSAPP_PHONE,
      fromPhone: "85295550000",
      body: "［圖片］",
      externalId: "wamid.PHOTO",
      authorName: "相片客",
      media: {
        kind: "image",
        graphMediaId: "123456789012345",
        mimeType: "image/jpeg",
        isVoice: false,
        sha256: null,
      },
    });
    if (imageInbound.ok) {
      await mediaFetch.ingestWhatsAppGraphMedia(imageInbound.comment.id, imageInbound.comment && {
        kind: "image",
        graphMediaId: "123456789012345",
        mimeType: "image/jpeg",
        isVoice: false,
        sha256: null,
      });
      if (imageInbound.comment.assignee_staff_id !== wingId) {
        appDb.prepare(`UPDATE comments SET assignee_staff_id = ? WHERE id = ?`).run(wingId, imageInbound.comment.id);
      }
    }
    const beforeRemote = calls.length;
    if (imageInbound.ok) {
      await mediaFetch.ingestRemoteAttachments(imageInbound.comment.id, [
        { kind: "image", url: "http://127.0.0.1/secret", isVoice: false },
      ]);
    }
    check("內網媒體連結唔會下載", calls.length === beforeRemote);

    const fbInfo = appDb
      .prepare(
        `INSERT INTO comments (source, external_id, author_name, body, status, assignee_staff_id, intake_kind, meta_surface)
         VALUES ('facebook', '123456789012345', 'FB客', '公開留言', 'open', ?, 'site_comment', 'comment')`
      )
      .run(wingId);

    check("客戶圖片已入庫", imageInbound.ok && calls.some((call) => call.url.startsWith("https://lookaside.fbsbx.com/")));

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json({ limit: "8mb" }));
    app.use(session({ secret: "media-demo", resave: false, saveUninitialized: false }));
    app.use("/api", apiRoutes.apiRouter);
    app.use(pageRoutes.pagesRouter);
    server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const login = async (username: string) => {
      const res = await fetch(`${base}/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username, password: DEMO_PASSWORD }),
      });
      return cookieHeader(res);
    };
    const wingCookie = await login("wing");
    const jasonCookie = await login("jason");
    check("Wing 同 Jason 都登入到", wingCookie.includes("connect.sid") && jasonCookie.includes("connect.sid"));

    const staffPage = await fetch(`${base}/comments/${staffInbound.ok ? staffInbound.comment.id : 0}`, {
      headers: { cookie: wingCookie },
    });
    const staffHtml = await staffPage.text();
    check(
      "Wing 見到用自己 WhatsApp 發畀客戶",
      staffPage.status === 200 &&
        staffHtml.includes("用我嘅 WhatsApp 發送畀客戶") &&
        staffHtml.includes(`value="${CUSTOMER}"`) &&
        staffHtml.includes("https://api.whatsapp.com/send") &&
        staffHtml.includes(formatExpect(STAFF_PHONE)),
      staffPage.status === 200 ? "缺連結或號碼" : String(staffPage.status)
    );
    const jasonStaff = await fetch(`${base}/comments/${staffInbound.ok ? staffInbound.comment.id : 0}`, {
      headers: { cookie: jasonCookie },
    });
    const jasonHtml = await jasonStaff.text();
    check("Jason 睇唔到 Wing 客戶", jasonStaff.status === 404 && !jasonHtml.includes(CUSTOMER));

    const photoPage = await fetch(`${base}/comments/${imageInbound.ok ? imageInbound.comment.id : 0}`, {
      headers: { cookie: wingCookie },
    });
    const photoHtml = await photoPage.text();
    const mediaMatch = photoHtml.match(/\/media\/(\d+)/);
    check("留言頁有客戶圖片", photoPage.status === 200 && !!mediaMatch, photoHtml.includes("未能") ? "有錯誤提示" : "無媒體");
    const mediaId = mediaMatch ? Number(mediaMatch[1]) : 0;
    const wingMedia = await fetch(`${base}/media/${mediaId}`, { headers: { cookie: wingCookie } });
    const wingBytes = Buffer.from(await wingMedia.arrayBuffer());
    check(
      "登入同事先至攞到圖片 bytes",
      wingMedia.status === 200 &&
        wingMedia.headers.get("content-type") === "image/jpeg" &&
        wingMedia.headers.get("x-content-type-options") === "nosniff" &&
        wingBytes.equals(JPEG)
    );
    const jasonMedia = await fetch(`${base}/api/media/${mediaId}`, {
      headers: { cookie: jasonCookie, accept: "application/json" },
    });
    check("其他同事攞唔到媒體", jasonMedia.status === 404);
    const anonMedia = await fetch(`${base}/api/media/${mediaId}`, { headers: { accept: "application/json" } });
    check("未登入媒體 401", anonMedia.status === 401);

    const fbPage = await fetch(`${base}/comments/${Number(fbInfo.lastInsertRowid)}`, { headers: { cookie: wingCookie } });
    const fbHtml = await fbPage.text();
    check(
      "Facebook 公開留言冇同事 WhatsApp 深連結",
      fbPage.status === 200 && !fbHtml.includes("用我嘅 WhatsApp 發送畀客戶") && fbHtml.includes("傳送相片、影片或語音")
    );

    if (!companyInbound.ok || !imageInbound.ok) {
      check("入站樣本成功", false);
    } else {
      calls.length = 0;
      const textReply = await replies.createStaffReply({
        commentId: companyInbound.comment.id,
        staffId: wingId,
        body: "公司文字回覆",
        viewer: { staffId: wingId, isAdmin: false },
      });
      const textCall = calls[0];
      let textJson: Record<string, unknown> | null = null;
      try {
        textJson = JSON.parse(textCall?.body.toString("utf8") || "null") as Record<string, unknown>;
      } catch {
        textJson = null;
      }
      check(
        "公司文字回覆仍然係 Cloud API 文字",
        textReply.ok &&
          textReply.reply.delivery_status === "sent" &&
          calls.length === 1 &&
          textCall?.contentType.includes("application/json") &&
          textJson?.type === "text" &&
          textJson?.to === "85296660000",
        textReply.ok ? `${textReply.reply.delivery_status} ${textCall?.url || ""}` : textReply.error
      );

      calls.length = 0;
      const photoReply = await fetch(`${base}/api/comments/${companyInbound.comment.id}/media-replies`, {
        method: "POST",
        headers: { cookie: wingCookie, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          caption: "車相",
          mime_type: "image/jpeg",
          is_voice: false,
          data_base64: JPEG.toString("base64"),
        }),
      });
      const photoJson = (await photoReply.json()) as { reply?: { delivery_status?: string }; error?: string };
      const upload = calls.find((call) => call.url.endsWith("/media"));
      const sent = calls.find((call) => call.url.endsWith("/messages"));
      let sentJson: Record<string, unknown> | null = null;
      try {
        sentJson = JSON.parse(sent?.body.toString("utf8") || "null") as Record<string, unknown>;
      } catch {
        sentJson = null;
      }
      const imagePayload = sentJson?.image as { id?: string; caption?: string } | undefined;
      check(
        "公司總機可以代發相片",
        photoReply.status === 201 &&
          photoJson.reply?.delivery_status === "sent" &&
          !!upload?.contentType.includes("multipart/form-data") &&
          upload.body.includes(JPEG) &&
          imagePayload?.id === "uploaded-1" &&
          imagePayload?.caption === "車相" &&
          sentJson?.type === "image",
        photoJson.error || photoJson.reply?.delivery_status || String(photoReply.status)
      );

      calls.length = 0;
      const voiceReply = await fetch(`${base}/api/comments/${companyInbound.comment.id}/media-replies`, {
        method: "POST",
        headers: { cookie: wingCookie, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          mime_type: "audio/webm",
          is_voice: true,
          data_base64: synthetic.toString("base64"),
        }),
      });
      const voiceJson = (await voiceReply.json()) as {
        reply?: { delivery_status?: string; id?: number };
        media?: Array<{ url?: string | null; mime_type?: string; is_voice?: boolean }>;
        error?: string;
      };
      const voiceUpload = calls.find((call) => call.url.endsWith("/media"));
      check(
        "WebM 語音轉成 Ogg 先至發送，收件箱保留原本檔",
        voiceReply.status === 201 &&
          voiceJson.reply?.delivery_status === "sent" &&
          !!voiceUpload?.body.includes(Buffer.from("OggS")) &&
          !!voiceUpload.body.includes(Buffer.from("OpusHead")),
        voiceJson.error || voiceJson.reply?.delivery_status || ""
      );
      const storedVoice = (voiceJson.media || []).find((item) => item.is_voice && item.mime_type === "audio/webm");
      const voiceRes = storedVoice?.url
        ? await fetch(`${base}${storedVoice.url}`, { headers: { cookie: wingCookie } })
        : null;
      const voiceBytes = voiceRes ? Buffer.from(await voiceRes.arrayBuffer()) : Buffer.alloc(0);
      check(
        "同事可以喺 API 播放自己錄嘅語音",
        voiceRes?.status === 200 && voiceRes.headers.get("content-type") === "audio/webm" && voiceBytes.subarray(0, 4).equals(synthetic.subarray(0, 4))
      );

      calls.length = 0;
      const personal = await replies.createStaffMediaReply({
        commentId: staffInbound.ok ? staffInbound.comment.id : 0,
        staffId: wingId,
        mimeType: "image/jpeg",
        dataBase64: JPEG.toString("base64"),
        viewer: { staffId: wingId, isAdmin: false },
      });
      check(
        "同事個人線路媒體唔打 Cloud API",
        personal.ok && personal.reply.delivery_status === "stub" && calls.length === 0,
        personal.ok ? personal.reply.delivery_status : personal.error
      );

      calls.length = 0;
      const publicComment = await replies.createStaffMediaReply({
        commentId: Number(fbInfo.lastInsertRowid),
        staffId: wingId,
        mimeType: "audio/ogg",
        isVoice: true,
        dataBase64: ogg.toString("base64"),
        viewer: { staffId: wingId, isAdmin: false },
      });
      check(
        "公開留言唔代發語音，文字路徑冇被呼叫",
        publicComment.ok &&
          publicComment.reply.delivery_status === "failed" &&
          (publicComment.reply.delivery_error || "").includes("公開留言") &&
          calls.length === 0,
        publicComment.ok ? publicComment.reply.delivery_error || "" : publicComment.error
      );
    }

    if (failures.length) {
      console.error(`\n${failures.length} 項失敗`);
      return 1;
    }
    console.log("\n同事 WhatsApp 同媒體示範通過");
    return 0;
  } finally {
    globalThis.fetch = originalFetch;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
      });
    }
    appDb?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function formatExpect(digits: string): string {
  return `+852 ${digits.slice(3, 7)} ${digits.slice(7)}`;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
