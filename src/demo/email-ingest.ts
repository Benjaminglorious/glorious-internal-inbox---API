/**
 * 公司電郵：只入庫同車有關嘅信，其餘唔入。
 * 同一電郵地址未完成共用一個 ID。回覆由公司郵箱寄出，畫面寫明這是email的留言。
 * 用臨時 SQLite，唔會郁到正式 data/inbox.db，亦唔會連接 Gmail。
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import Database from "better-sqlite3";
import type { OutboundEmailMessage } from "../adapters/email";

const failures: string[] = [];
const DEMO_PASSWORD = "Glorious2026!";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const MP4 = Buffer.alloc(16);
MP4.write("ftyp", 4, "ascii");
MP4.write("isom", 8, "ascii");

function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) {
    const line = detail ? `${name} — ${detail}` : name;
    failures.push(line);
    console.error(`FAIL ${line}`);
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

function rowHtml(html: string, id: number): string {
  const needle = `href="/comments/${id}"`;
  return html.split("<tr>").find((part) => part.includes(needle)) ?? "";
}

function outsideDetails(html: string): string {
  return html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, "");
}

function writePreviousSchema(dbFile: string): void {
  const legacy = new Database(dbFile);
  legacy.exec(`
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK (source IN ('28car', 'glorious_web', 'facebook', 'instagram', 'whatsapp')),
      external_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      body TEXT NOT NULL,
      vehicle_ref TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done')),
      assignee_staff_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      intake_kind TEXT NOT NULL DEFAULT 'site_comment' CHECK (intake_kind IN ('site_comment', 'whatsapp_click')),
      origin_site TEXT CHECK (origin_site IS NULL OR origin_site IN ('28car', 'glorious_web', 'facebook', 'instagram')),
      wa_from_phone TEXT,
      wa_to_phone TEXT,
      entry_path TEXT,
      meta_sender_id TEXT,
      meta_surface TEXT,
      meta_post_id TEXT,
      meta_post_permalink TEXT,
      meta_post_caption TEXT,
      commenter_key TEXT,
      UNIQUE (source, external_id)
    );
    INSERT INTO comments (
      source, external_id, author_name, body, status, intake_kind, wa_from_phone, wa_to_phone, commenter_key
    ) VALUES (
      'whatsapp', 'wamid.KEEP', '舊客', '遷移前 WhatsApp', 'open', 'whatsapp_click',
      '85290001111', '85221740001', 'wa:85290001111'
    );
    INSERT INTO comments (
      source, external_id, author_name, body, status, intake_kind, commenter_key
    ) VALUES (
      '28car', 'legacy-28', '舊網站客', '遷移前 28car', 'open', 'site_comment', 'name:舊網站客'
    );
  `);
  legacy.close();
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-email-"));
  const dbFile = path.join(tmp, "inbox.db");
  let server: Server | undefined;
  let appDb: Database.Database | undefined;

  const filter = require("../services/email-filter") as typeof import("../services/email-filter");
  const cases: Array<{ name: string; from: string; subject: string; text: string; flags?: { listUnsubscribe?: boolean; autoSubmitted?: boolean; bulk?: boolean }; ingest: boolean; hard?: boolean; ref?: string | null; reason?: string }> = [
    { name: "Alphard 現貨", from: "chan@example.com", subject: "想問 Alphard 現貨", text: "星期日可唔可以試車", ingest: true, ref: "alphard" },
    { name: "買 Toyota", from: "a@example.com", subject: "Inquiry", text: "I want to buy a Toyota Alphard, please quote", ingest: true, ref: "alphard" },
    { name: "BMW 報價", from: "a@example.com", subject: "BMW 520i 報價", text: "想買", ingest: true, ref: "bmw" },
    { name: "車牌", from: "a@example.com", subject: "車牌 AB1234", text: "想睇呢部車", ingest: true, ref: "AB1234" },
    { name: "以舊換新", from: "a@example.com", subject: "以舊換新", text: "我架舊車想換七人車", ingest: true },
    { name: "車盤編號", from: "dealer@example.com", subject: "Re: 車盤 s2806213 麥拿倫", text: "可唔可以再報價", ingest: true, ref: "s2806213" },
    { name: "試車", from: "a@example.com", subject: "星期日試車", text: "想預約", ingest: true },
    { name: "供車", from: "a@example.com", subject: "想問供車", text: "部 Alphard 可唔可以分期", ingest: true, ref: "alphard" },
    { name: "主旨已有車型嘅短覆", from: "a@example.com", subject: "Re: 想問 Alphard 現貨", text: "OK 星期六", ingest: true, ref: "alphard" },
    { name: "買車", from: "a@example.com", subject: "Hello", text: "I want to buy a car", ingest: true },
    { name: "引用入面先有車", from: "a@example.com", subject: "OK", text: "收到\n> Alphard 現貨", ingest: false, hard: false },
    { name: "淨係報價", from: "a@example.com", subject: "報價", text: "幾多錢", ingest: false, hard: false },
    { name: "日常問候", from: "a@example.com", subject: "Hello", text: "how are you", ingest: false, hard: false },
    { name: "停車場", from: "a@example.com", subject: "停車場月票", text: "請續費", ingest: false, hard: false },
    { name: "車厘子", from: "a@example.com", subject: "我想訂車厘子", text: "兩斤", ingest: false, hard: false },
    { name: "訂車", from: "a@example.com", subject: "想訂車", text: "下星期可唔可以", ingest: true },
    { name: "汽車保險", from: "a@example.com", subject: "汽車保險到期", text: "請續保", ingest: false, hard: false },
    { name: "內部 IT", from: "it@example.com", subject: "伺服器磁碟滿了", text: "請同事睇下", ingest: false, hard: false },
    { name: "驗證碼", from: "a@example.com", subject: "驗證碼 482193", text: "請輸入驗證碼登入", ingest: false, hard: true },
    { name: "重設密碼", from: "a@example.com", subject: "Password reset", text: "click here", ingest: false, hard: true },
    { name: "Facebook 通知", from: "notify@facebookmail.com", subject: "Chan commented", text: "your Alphard photo", ingest: false, hard: true },
    { name: "Instagram 通知", from: "security@instagram.com", subject: "Instagram", text: "new login", ingest: false, hard: true },
    { name: "銀行", from: "alerts@hsbc.com.hk", subject: "汽車貸款月結單", text: "請查閱", ingest: false, hard: true },
    { name: "電子報", from: "news@dealer.example", subject: "本週車盤", text: "Alphard 優惠", flags: { listUnsubscribe: true }, ingest: false, hard: true },
    { name: "大量發送", from: "person@example.com", subject: "Alphard", text: "現貨", flags: { bulk: true }, ingest: false, hard: true },
    { name: "noreply 車盤", from: "noreply@dealer.example", subject: "Alphard 現貨", text: "立即選購", ingest: false, hard: true },
    { name: "廣告", from: "promo@example.com", subject: "限時優惠 Alphard 五折", text: "退訂", ingest: false, hard: true },
    { name: "客戶問優惠", from: "chan@example.com", subject: "我想問 Alphard 有冇優惠", text: "可唔可以試車", ingest: true, ref: "alphard" },
    { name: "咖啡收據", from: "shop@example.com", subject: "Your receipt", text: "order confirmation coffee", ingest: false, hard: true },
    { name: "唔係查車嘅 Alphard 發票", from: "shop@example.com", subject: "發票", text: "Alphard 手機座", ingest: false, hard: true },
    { name: "查訂金收據", from: "chan@example.com", subject: "Alphard", text: "我想問訂金收據點計", ingest: true, ref: "alphard" },
    { name: "中獎", from: "luck@example.com", subject: "Congratulations", text: "you have won a car", ingest: false, hard: true },
    { name: "自動回覆", from: "chan@example.com", subject: "Alphard", text: "現貨", flags: { autoSubmitted: true }, ingest: false, hard: true },
    { name: "公司主旨 Ltd", from: "accounts@example.com", subject: "Glorious Motors Ltd", text: "please call the office", ingest: true, reason: "company-subject" },
    { name: "公司主旨 Limited", from: "accounts@example.com", subject: "glorious motors limited", text: "meeting notes, not a car", ingest: true, reason: "company-subject" },
    { name: "公司主旨標點同空格", from: "accounts@example.com", subject: "Re:  GLORIOUS   MOTORS, LTD.", text: "lunch", ingest: true, reason: "company-subject" },
    { name: "公司主旨連字號", from: "accounts@example.com", subject: "Fwd: Glorious-Motors Limited", text: "contract", ingest: true, reason: "company-subject" },
    { name: "公司主旨蓋過電子報", from: "news@dealer.example", subject: "Glorious Motors Ltd", text: "unsubscribe", flags: { listUnsubscribe: true }, ingest: true, reason: "company-subject" },
    { name: "冇 Ltd", from: "accounts@example.com", subject: "Glorious Motors", text: "see you", ingest: false, hard: false },
    { name: "公司名只喺正文", from: "accounts@example.com", subject: "Hello", text: "Glorious Motors Ltd office", ingest: false, hard: false },
  ];
  for (const item of cases) {
    const result = filter.classifyCompanyEmail({
      fromAddress: item.from,
      subject: item.subject,
      text: item.text,
      ...item.flags,
    });
    check(
      `篩選 ${item.name}`,
      result.ingest === item.ingest &&
        (item.hard == null || result.hardReject === item.hard) &&
        (item.ref == null || result.vehicleRef === item.ref) &&
        (item.reason == null || result.reason === item.reason),
      `ingest=${result.ingest} hard=${result.hardReject} ref=${result.vehicleRef} reason=${result.reason}`
    );
  }
  try {
    writePreviousSchema(dbFile);
    process.env.INBOX_DB = "sqlite";
    process.env.DATABASE_PATH = dbFile;
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.GLORIOUS_EMAIL_APP_PASSWORD;
    delete process.env.GLORIOUS_EMAIL_OAUTH_CLIENT_ID;
    delete process.env.GLORIOUS_EMAIL_OAUTH_CLIENT_SECRET;
    delete process.env.GLORIOUS_EMAIL_OAUTH_REFRESH_TOKEN;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.META_PAGE_ACCESS_TOKEN;

    const sync = require("../services/email-sync") as typeof import("../services/email-sync");
    check(
      "UID n:* 唔會重覆處理最後一封",
      sync.uidsNewerThan([5, 5], 5).length === 0 && sync.uidsNewerThan([1, 2, 5], 0).join(",") === "1,2,5"
    );
    const same = sync.emailFetchPlan({
      cursor: { uidValidity: "9", lastUid: 40 },
      mailboxUidValidity: "9",
      lookbackDays: 14,
      now: new Date("2026-11-10T00:00:00Z"),
    });
    const fresh = sync.emailFetchPlan({
      cursor: null,
      mailboxUidValidity: "9",
      lookbackDays: 14,
      now: new Date("2026-11-10T00:00:00Z"),
    });
    const rebuilt = sync.emailFetchPlan({
      cursor: { uidValidity: "1", lastUid: 40 },
      mailboxUidValidity: "9",
      lookbackDays: 14,
      now: new Date("2026-11-10T00:00:00Z"),
    });
    check("同一 UIDVALIDITY 只取更新 UID", same.since == null && same.lastUid === 40);
    check("未有游標就按日數補", fresh.since != null && fresh.lastUid === 0);
    check("UIDVALIDITY 變咗就重新補", rebuilt.since != null && rebuilt.lastUid === 0);

    const dbMod = require("../db") as typeof import("../db");
    const passwords = require("../auth/passwords") as typeof import("../auth/passwords");
    const email = require("../services/email-inbox") as typeof import("../services/email-inbox");
    const parse = require("../services/email-parse") as typeof import("../services/email-parse");
    const comments = require("../services/comments") as typeof import("../services/comments");
    const replies = require("../services/replies") as typeof import("../services/replies");
    const labels = require("../labels") as typeof import("../labels");
    const adapter = require("../adapters/email") as typeof import("../adapters/email");
    const express = require("express") as typeof import("express");
    const session = require("express-session") as typeof import("express-session");
    const apiRoutes = require("../routes/api") as typeof import("../routes/api");
    const pageRoutes = require("../routes/pages") as typeof import("../routes/pages");
    appDb = dbMod.db;

    const ddl = appDb.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comments'`).get() as { sql: string };
    const keptWa = appDb.prepare(`SELECT body, wa_from_phone FROM comments WHERE external_id = 'wamid.KEEP'`).get() as {
      body: string;
      wa_from_phone: string;
    };
    const keptCar = appDb.prepare(`SELECT body, intake_kind FROM comments WHERE external_id = 'legacy-28'`).get() as {
      body: string;
      intake_kind: string;
    };
    check("舊庫遷移之後仍然有 email 來源", ddl.sql.includes("'email'"));
    check("遷移保留 WhatsApp 內文同客戶電話", keptWa?.body === "遷移前 WhatsApp" && keptWa.wa_from_phone === "85290001111");
    check("遷移保留 28car 網站留言", keptCar?.body === "遷移前 28car" && keptCar.intake_kind === "site_comment");

    const hash = passwords.hashPassword(DEMO_PASSWORD);
    const insertStaff = appDb.prepare(
      `INSERT INTO staff (username, display_name, password_hash, is_admin, active) VALUES (?, ?, ?, ?, 1)`
    );
    insertStaff.run("tony", "Tony Chan", hash, 1);
    insertStaff.run("benjamin", "Benjamin", hash, 1);
    insertStaff.run("vivian", "Vivian", hash, 1);
    insertStaff.run("jason", "Jason Cheng", hash, 0);
    insertStaff.run("wing", "Wing Cheng", hash, 0);
    const eddieId = Number(insertStaff.run("eddie", "Eddie Lau", hash, 1).lastInsertRowid);

    const raw = Buffer.from(
      [
        "From: Chan Tai Man <Chan@Example.com>",
        "To: Glorious <gloriousinformation@gmail.com>",
        "Subject: 想問 Alphard 現貨",
        "Message-ID: <raw-alphard@example.com>",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "星期日可唔可以試車",
      ].join("\r\n"),
      "utf8"
    );
    const parsed = await parse.parseRawEmail(raw, "fallback-id");
    check(
      "原始信解析到寄件人同主旨",
      parsed?.fromAddress === "chan@example.com" && parsed.fromName === "Chan Tai Man" && parsed.subject.includes("Alphard") && parsed.messageId === "raw-alphard@example.com"
    );
    if (!parsed) return 1;
    const first = await email.ingestCompanyEmail({
      mailbox: "gloriousinformation@gmail.com",
      ...parsed,
      attachments: [
        { filename: "car.png", contentType: "image/png", content: PNG },
        { filename: "quote.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4\ntrailer\n%%EOF\n") },
      ],
    });
    check("車務信入庫", first.ok && first.outcome === "created");
    if (!first.ok || first.outcome === "ignored") return 1;
    const eddie = appDb.prepare(`SELECT username FROM staff WHERE id = ?`).get(first.assigneeStaffId) as { username: string } | undefined;
    const stored = comments.getComment(first.commentId);
    check("新電郵派給 Eddie，唔係 Tony", eddie?.username === "eddie" && stored?.assignee_staff_id === eddieId);
    check(
      "來源係 email 留言，唔係 WhatsApp 或網站",
      stored?.source === "email" && stored.intake_kind === "email" && stored.origin_site == null && stored.email_from === "chan@example.com"
    );
    const commenter = appDb.prepare(`SELECT commenter_key FROM comments WHERE id = ?`).get(first.commentId) as {
      commenter_key: string | null;
    };
    check("同一地址用 email: 做留言者", commenter.commenter_key === "email:chan@example.com");
    check("正文有主旨同 PDF 未收入", !!stored && stored.body.includes("主旨：") && stored.body.includes("附件未收入：quote.pdf") && stored.vehicle_ref === "alphard");
    const media = appDb.prepare(`SELECT kind, reply_id FROM message_media WHERE comment_id = ?`).all(first.commentId) as Array<{
      kind: string;
      reply_id: number | null;
    }>;
    check("相片用現有媒體，PDF 冇入", media.length === 1 && media[0]?.kind === "image" && media[0].reply_id == null);

    const beforeJunk = Number((appDb.prepare(`SELECT COUNT(*) AS n FROM comments`).get() as { n: number }).n);
    const junk = [
      { messageId: "otp-1@example.com", fromAddress: "accounts@facebookmail.com", subject: "Your security code", text: "482193" },
      { messageId: "bank-1@example.com", fromAddress: "alerts@hsbc.com.hk", subject: "月結單", text: "汽車貸款" },
      { messageId: "news-1@example.com", fromAddress: "news@cars.example", subject: "本週 Alphard", text: "退訂", listUnsubscribe: true },
      { messageId: "park-1@example.com", fromAddress: "lot@example.com", subject: "停車場", text: "月票" },
      { messageId: "hi-1@example.com", fromAddress: "friend@example.com", subject: "Hello", text: "lunch tomorrow" },
    ];
    for (const item of junk) {
      const ignored = await email.ingestCompanyEmail({ mailbox: "gloriousinformation@gmail.com", ...item });
      check(`唔入庫 ${item.messageId}`, ignored.ok && ignored.outcome === "ignored");
    }
    const afterJunk = Number((appDb.prepare(`SELECT COUNT(*) AS n FROM comments`).get() as { n: number }).n);
    check("非車務信冇新增留言", afterJunk === beforeJunk);

    const follow = await email.ingestCompanyEmail({
      mailbox: "gloriousinformation@gmail.com",
      messageId: "follow-1@example.com",
      fromAddress: "CHAN@example.com",
      fromName: "陳先生",
      subject: "你好",
      text: "星期六 OK UNIQUE-FOLLOW",
      attachments: [{ filename: "clip.mp4", contentType: "video/mp4", content: MP4 }],
    });
    check("同一電郵未完成共用 ID", follow.ok && follow.outcome === "appended" && follow.commentId === first.commentId);
    const followMedia = appDb
      .prepare(`SELECT kind, reply_id FROM message_media WHERE comment_id = ? AND kind = 'video'`)
      .get(first.commentId) as { kind: string; reply_id: number | null } | undefined;
    check("跟進影片貼喺再留言", followMedia?.kind === "video" && followMedia.reply_id != null);
    const otp = await email.ingestCompanyEmail({
      mailbox: "gloriousinformation@gmail.com",
      messageId: "otp-customer@example.com",
      fromAddress: "chan@example.com",
      subject: "驗證碼",
      text: "123456",
    });
    check("驗證碼唔會附加到未完成對話", otp.ok && otp.outcome === "ignored");
    const own = await email.ingestCompanyEmail({
      mailbox: "gloriousinformation@gmail.com",
      messageId: "own-1@example.com",
      fromAddress: "gloriousinformation@gmail.com",
      subject: "Alphard",
      text: "自己寄出",
    });
    check("公司郵箱自己寄出嘅信唔入庫", own.ok && own.outcome === "ignored" && own.reason === "own-mailbox");

    const other = await email.ingestCompanyEmail({
      mailbox: "gloriousinformation@gmail.com",
      messageId: "other-1@example.com",
      fromAddress: "other@example.com",
      fromName: "陳先生",
      subject: "想賣車",
      text: "七人車放盤",
    });
    check("另一個電郵地址係新 ID", other.ok && other.outcome === "created" && other.commentId !== first.commentId);
    const wing = other.ok && other.outcome === "created"
      ? (appDb.prepare(`SELECT username FROM staff WHERE id = ?`).get(other.assigneeStaffId) as { username: string } | undefined)
      : undefined;
    check("第二個新對話派給 Wing", wing?.username === "wing");
    const preview = comments.getComment(first.commentId);
    check(
      "列表內容用客戶最新一句",
      !!preview && comments.latestCustomerMessageText(preview).includes("UNIQUE-FOLLOW") && !comments.latestCustomerMessageText(preview).includes("同事回覆")
    );
    check("提示文字係電郵留言", labels.intakeSummary(preview!) === "這是email的留言");

    const failed = await replies.createStaffReply({ commentId: first.commentId, staffId: eddieId, body: "未設定密碼" });
    check(
      "未設定憑證嘅回覆標失敗",
      failed.ok && failed.reply.delivery_status === "failed" && (failed.reply.delivery_error || "").includes("GLORIOUS_EMAIL_APP_PASSWORD")
    );

    const sent: OutboundEmailMessage[] = [];
    adapter.setEmailTransportForTests(async (message) => {
      sent.push(message);
    });
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use(session({ secret: "email-demo", resave: false, saveUninitialized: false }));
    app.use("/api", apiRoutes.apiRouter);
    app.use(pageRoutes.pagesRouter);
    server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "eddie", password: DEMO_PASSWORD }),
    });
    const eddieCookie = cookieHeader(login);
    check("Eddie 可以登入", login.status === 302 && eddieCookie.includes("connect.sid="));
    const inbox = await fetch(`${base}/`, { headers: { cookie: eddieCookie } });
    const inboxHtml = await inbox.text();
    const emailRow = rowHtml(inboxHtml, first.commentId);
    const emailActions = emailRow.match(/<td class="actions-cell">([\s\S]*?)<\/td>/)?.[1] ?? "";
    const contentPreview = emailRow.match(/<span class="content-preview">([\s\S]*?)<\/span>/)?.[1] ?? "";
    check(
      "列表標明這是email的留言，而且只展開回覆",
      emailRow.includes("這是email的留言") &&
        emailRow.includes("email 留言") &&
        contentPreview.includes("UNIQUE-FOLLOW") &&
        emailActions.startsWith(`<a class="btn primary" href="/comments/${first.commentId}#reply">回覆</a>`) &&
        !outsideDetails(emailActions).includes("發送電郵") &&
        !outsideDetails(emailActions).includes("WhatsApp"),
      `preview=${contentPreview.slice(0, 120)} actions=${outsideDetails(emailActions).slice(0, 180)} row=${emailRow.slice(0, 180)}`
    );
    const detail = await fetch(`${base}/comments/${first.commentId}`, { headers: { cookie: eddieCookie } });
    const detailHtml = await detail.text();
    const detailVisible = outsideDetails(detailHtml);
    check(
      "留言頁同回覆框都寫明這是email的留言",
      detail.status === 200 &&
        detailVisible.includes("這是email的留言") &&
        detailVisible.includes("chan@example.com") &&
        detailVisible.includes("gloriousinformation@gmail.com") &&
        detailVisible.includes('action="/comments/' + first.commentId + '/replies"') &&
        detailVisible.includes("發送回覆") &&
        detailVisible.includes("HKT") &&
        detailHtml.includes("<img ") &&
        !detailVisible.includes(">用我嘅 WhatsApp 發送畀客戶<")
    );
    const posted = await fetch(`${base}/comments/${first.commentId}/replies`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: eddieCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ body: "好，下午見" }),
    });
    check("回覆仍然走現有回覆路徑", posted.status === 302 && (posted.headers.get("location") || "").includes("delivery=sent"));
    const outbound = sent[0];
    check(
      "回覆由公司郵箱寄給原寄件人，並且接上同一串",
      !!outbound &&
        outbound.from.includes("gloriousinformation@gmail.com") &&
        outbound.to === "chan@example.com" &&
        outbound.subject === "Re: 想問 Alphard 現貨" &&
        outbound.text === "好，下午見" &&
        !outbound.text.includes("這是email的留言") &&
        outbound.inReplyTo === "<follow-1@example.com>"
    );
    const after = await fetch(`${base}/comments/${first.commentId}`, { headers: { cookie: eddieCookie } });
    const afterHtml = await after.text();
    check(
      "發送之後對話仍然標明這是email的留言",
      afterHtml.includes("已經以 email 發送") && afterHtml.includes("這是email的留言") && afterHtml.includes("好，下午見")
    );

    const wingLogin = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "wing", password: DEMO_PASSWORD }),
    });
    const wingCookie = cookieHeader(wingLogin);
    const hidden = await fetch(`${base}/comments/${first.commentId}`, { headers: { cookie: wingCookie } });
    const ownThread = other.ok && other.outcome === "created"
      ? await fetch(`${base}/comments/${other.commentId}`, { headers: { cookie: wingCookie } })
      : null;
    check("Wing 睇唔到 Eddie 嘅電郵，睇到派給自己嘅", hidden.status === 404 && ownThread?.status === 200);

    const api = await fetch(`${base}/api/comments/${first.commentId}`, { headers: { cookie: eddieCookie } });
    const apiJson = (await api.json()) as { comment?: { source?: string; intake_kind?: string; created_at?: string; email_from?: string } };
    check(
      "API 時間係香港時間，來源係 email",
      apiJson.comment?.source === "email" &&
        apiJson.comment.intake_kind === "email" &&
        apiJson.comment.email_from === "chan@example.com" &&
        (apiJson.comment.created_at || "").includes("HKT")
    );

    comments.updateStatus(first.commentId, "done");
    const softAfterDone = await email.ingestCompanyEmail({
      mailbox: "gloriousinformation@gmail.com",
      messageId: "after-done-soft@example.com",
      fromAddress: "chan@example.com",
      subject: "你好",
      text: "星期六 OK",
    });
    check("已完成之後，唔係車嘅信唔再開單", softAfterDone.ok && softAfterDone.outcome === "ignored");
    const again = await email.ingestCompanyEmail({
      mailbox: "gloriousinformation@gmail.com",
      messageId: "after-done-car@example.com",
      fromAddress: "chan@example.com",
      subject: "再問 Vellfire 現貨",
      text: "想試車",
    });
    check("已完成之後，新的車務信先開新 ID", again.ok && again.outcome === "created" && again.commentId !== first.commentId);
    const jason = again.ok && again.outcome === "created"
      ? (appDb.prepare(`SELECT username FROM staff WHERE id = ?`).get(again.assigneeStaffId) as { username: string } | undefined)
      : undefined;
    check("第三個新對話派給 Jason", jason?.username === "jason");
    const excluded = appDb
      .prepare(
        `SELECT s.username FROM comments c JOIN staff s ON s.id = c.assignee_staff_id WHERE c.source = 'email'`
      )
      .all() as Array<{ username: string }>;
    check(
      "自動派單冇派給 Tony、Benjamin、Vivian",
      excluded.length > 0 && excluded.every((row) => !["tony", "benjamin", "vivian"].includes(row.username))
    );

    const companyMail = await email.ingestCompanyEmail({
      mailbox: "gloriousinformation@gmail.com",
      messageId: "company-subject-1@example.com",
      fromAddress: "accounts@example.com",
      fromName: "Accounts",
      subject: "Re: Glorious Motors Ltd.",
      text: "Please call the office about the invoice.",
    });
    const companyRow = companyMail.ok && companyMail.outcome === "created" ? comments.getComment(companyMail.commentId) : null;
    check(
      "公司主旨唔係車都寫入現有收件箱",
      companyMail.ok &&
        companyMail.outcome === "created" &&
        companyRow?.source === "email" &&
        companyRow.intake_kind === "email" &&
        companyRow.body.includes("Please call the office") &&
        !companyRow.body.toLowerCase().includes("alphard")
    );
  } finally {
    try {
      const adapter = require("../adapters/email") as typeof import("../adapters/email");
      adapter.setEmailTransportForTests(null);
    } catch {
      // 未載入資料庫就失敗時，唔好再打開另一個庫。
    }
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    try {
      appDb?.close();
    } catch {
      // 檔案清理失敗唔影響斷言。
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`\n${failures.length} 項失敗`);
    return 1;
  }
  console.log("\n公司電郵入庫同回覆通過");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
