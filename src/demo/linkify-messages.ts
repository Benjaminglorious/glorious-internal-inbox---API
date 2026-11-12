/**
 * 訊息入面嘅 http(s) 網址喺顯示時先變成連結。
 * 資料庫仍然存原文。javascript:、data: 同 HTML 唔會變成可執行內容。
 * 用臨時 SQLite，唔會郁到正式 data/inbox.db。
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type Database from "better-sqlite3";
import { clipMessagePreview, linkifyMessageHtml } from "../linkify";

const failures: string[] = [];
const DEMO_PASSWORD = "Glorious2026!";
const CAR = "https://www.glorious.hk/cn2/car_detail?cid=19242997";

function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) {
    const line = detail ? `${name} — ${detail}` : name;
    failures.push(line);
    console.error(`FAIL ${line}`);
    return;
  }
  console.log(`OK   ${name}`);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function linked(url: string): string {
  const safe = escapeHtml(url);
  return `<a class="msg-link" href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>`;
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

function contentPreview(row: string): string {
  const match = row.match(/<span class="content-preview">([\s\S]*?)<\/span>/);
  return match?.[1] ?? "";
}

function bubbleBodies(html: string): string[] {
  const out: string[] = [];
  const re = /<div class="bubble-body">([\s\S]*?)<\/div>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) out.push(match[1] ?? "");
  return out;
}

function unexpectedTags(html: string): string[] {
  const tags = html.match(/<\/?[A-Za-z][^>]*>/g) ?? [];
  return tags.filter((tag) => !/^<a\s/i.test(tag) && !/^<\/a>$/i.test(tag));
}

function unitCases(): void {
  const plain = `價錢 & 折扣 <未定> "好" '呀'`;
  check("冇網址時只做 HTML 跳脫", linkifyMessageHtml(plain) === escapeHtml(plain));
  check("空字串保持空白", linkifyMessageHtml("") === "");

  const mid = `請睇${CAR}多謝`;
  check(
    "句中 glorious.hk 車盤網址可撳，後面中文唔會吞入去",
    linkifyMessageHtml(mid) === `請睇${linked(CAR)}多謝`,
    linkifyMessageHtml(mid)
  );

  const spaced = `客戶話 ${CAR} 可以睇。`;
  check("網址前後有空格仍然可撳", linkifyMessageHtml(spaced) === `客戶話 ${linked(CAR)} 可以睇。`);

  const many = `先睇 ${CAR}，再睇 http://example.com/staff.`;
  check(
    "同一句多個 http 同 https，句號同逗號留喺外面",
    linkifyMessageHtml(many) === `先睇 ${linked(CAR)}，再睇 ${linked("http://example.com/staff")}.`
  );

  const wrapped = `(${CAR}).`;
  check(
    "未配對嘅右括號同句號唔屬於網址",
    linkifyMessageHtml(wrapped) === `(${linked(CAR)}).`
  );

  const balanced = "https://en.wikipedia.org/wiki/Foo_(bar).";
  check(
    "網址自己嘅括號會保留，後面句號唔會",
    linkifyMessageHtml(balanced) === `${linked("https://en.wikipedia.org/wiki/Foo_(bar)")}.`
  );

  const query = "https://www.glorious.hk/cn2/car_detail?cid=19242997&ref=1";
  check(
    "query 入面嘅 & 會跳脫，撳開仍然係原本網址",
    linkifyMessageHtml(`連結 ${query} 呀`) === `連結 ${linked(query)} 呀`
  );

  const upper = "HTTP://Example.COM/Path";
  check("大階 scheme 仍然可撳，顯示原本大細階", linkifyMessageHtml(upper) === linked(upper));

  const hostile = `<script>alert("x")</script> javascript:alert(1) data:text/html,hi ${CAR}`;
  const hostileHtml = linkifyMessageHtml(hostile);
  check("javascript: 同 data: 唔會變連結", !/href\s*=\s*["']\s*(?:javascript|data):/i.test(hostileHtml), hostileHtml);
  check("客戶 HTML 保持跳脫", hostileHtml.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"), hostileHtml);
  check("惡意字串入面嘅 https 仍然可撳", hostileHtml.includes(linked(CAR)));
  check("連結以外冇其他標籤", unexpectedTags(hostileHtml).length === 0, unexpectedTags(hostileHtml).join(" | "));

  check("www 冇 scheme 唔當連結", !linkifyMessageHtml("www.glorious.hk/cn2/car_detail?cid=19242997").includes("<a"));
  check("檔案 scheme 唔當連結", !linkifyMessageHtml("file:///etc/passwd").includes("<a"));
  check("字入面嘅 http 唔會誤認", !linkifyMessageHtml("nothttp://example.com/secret").includes("<a"));
  check(
    "百分號編碼嘅路徑保留",
    linkifyMessageHtml("https://example.com/%E8%BB%8A") === linked("https://example.com/%E8%BB%8A")
  );
  check(
    "換行兩邊嘅字保留",
    linkifyMessageHtml(`上\n${CAR}\n下`) === `上\n${linked(CAR)}\n下`
  );

  const long = "甲".repeat(90);
  check("普通長句仍然 80 字加省略號", clipMessagePreview(long) === `${"甲".repeat(80)}…`);
  check("短句唔加省略號", clipMessagePreview("一句") === "一句");
  const clippedUrl = clipMessagePreview(`回覆 ${CAR} 後面仲有好長嘅字${"呀".repeat(40)}`);
  check(
    "預覽唔好切斷車盤網址",
    clippedUrl.includes(CAR) && clippedUrl.endsWith("…") && !clippedUrl.includes(`${CAR.slice(0, 20)}…`),
    clippedUrl
  );
  const huge = `看 https://example.com/${"a".repeat(400)} 完`;
  check("超長網址唔留下半截", clipMessagePreview(huge) === "看…", clipMessagePreview(huge));
  const hugeEnding = `看 https://example.com/${"b".repeat(400)}`;
  check("收到尾嘅超長網址都唔整段放出預覽", clipMessagePreview(hugeEnding) === "看…", clipMessagePreview(hugeEnding));
}

async function pageCases(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-linkify-"));
  const dbFile = path.join(tmp, "inbox.db");
  let appDb: Database.Database | undefined;
  let server: Server | undefined;

  const customerBody = `${CAR} 同 https://example.com/a. <script>alert("x")</script> javascript:alert(1) data:text/html,hi`;
  const staffBody = `同事回覆 (${CAR}), 請睇 https://staff.example/p.`;

  try {
    process.env.INBOX_DB = "sqlite";
    process.env.DATABASE_PATH = dbFile;
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.META_PAGE_ACCESS_TOKEN;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as typeof import("../db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const passwords = require("../auth/passwords") as typeof import("../auth/passwords");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const repliesApi = require("../services/replies") as typeof import("../services/replies");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wa = require("../services/whatsapp") as typeof import("../services/whatsapp");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const express = require("express") as typeof import("express");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const session = require("express-session") as typeof import("express-session");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pageRoutes = require("../routes/pages") as typeof import("../routes/pages");

    appDb = dbMod.db;
    const hash = passwords.hashPassword(DEMO_PASSWORD);
    const staff = appDb
      .prepare(
        `INSERT INTO staff (username, display_name, password_hash, is_admin, active)
         VALUES ('tony', 'Tony Chan', ?, 1, 1)`
      )
      .run(hash);
    const staffId = Number(staff.lastInsertRowid);
    wa.ensureCompanyWhatsAppLine();

    const inbound = wa.routeWhatsAppInbound({
      toPhone: "85221740001",
      fromPhone: "85290006621",
      body: customerBody,
      externalId: "wamid.LINKIFY-1",
      authorName: "陳生",
    });
    check("客戶訊息入庫", inbound.ok === true);
    if (!inbound.ok) return;
    const commentId = inbound.comment.id;

    const reply = await repliesApi.createStaffReply({
      commentId,
      staffId,
      body: staffBody,
    });
    check("同事回覆入庫", reply.ok === true, reply.ok ? "" : reply.error);
    if (!reply.ok) return;

    const stored = appDb.prepare(`SELECT body FROM comments WHERE id = ?`).get(commentId) as { body: string };
    const storedReply = appDb.prepare(`SELECT body FROM comment_replies WHERE comment_id = ?`).get(commentId) as {
      body: string;
    };
    check("資料庫客戶原文冇被改成 HTML", stored.body === customerBody, stored.body);
    check("資料庫同事原文冇被改成 HTML", storedReply.body === staffBody, storedReply.body);

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use(
      session({
        secret: "linkify-demo",
        resave: false,
        saveUninitialized: false,
      })
    );
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
      body: new URLSearchParams({ username: "tony", password: DEMO_PASSWORD }),
    });
    const cookie = cookieHeader(login);
    check("Tony 可以登入", login.status === 302 && cookie.includes("connect.sid="));

    const detail = await fetch(`${base}/comments/${commentId}`, { headers: { cookie } });
    const detailHtml = await detail.text();
    const bubbles = bubbleBodies(detailHtml);
    check("詳情頁有客戶同同事兩段訊息", detail.status === 200 && bubbles.length === 2, `status=${detail.status} bubbles=${bubbles.length}`);
    check("客戶訊息顯示時先連結", bubbles[0] === linkifyMessageHtml(customerBody), bubbles[0]);
    check("同事回覆顯示時先連結", bubbles[1] === linkifyMessageHtml(staffBody), bubbles[1]);
    check(
      "詳情頁網址用新分頁開啟",
      bubbles.every((body) => !body.includes("<a ") || (body.includes('target="_blank"') && body.includes('rel="noopener noreferrer"')))
    );
    check("詳情頁訊息冇 javascript 或 data 連結", !/href\s*=\s*["']\s*(?:javascript|data):/i.test(bubbles.join("\n")));
    check("詳情頁訊息冇未跳脫嘅 script", bubbles.every((body) => unexpectedTags(body).length === 0), bubbles.join("\n"));

    const inbox = await fetch(`${base}/`, { headers: { cookie } });
    const inboxHtml = await inbox.text();
    const preview = contentPreview(rowHtml(inboxHtml, commentId));
    check("列表預覽包含完整車盤連結", preview.includes(linked(CAR)) && preview.includes(linked("https://example.com/a")), preview);
    check("列表預覽唔會吞尾句號", preview.includes(`${linked("https://example.com/a")}.`) || preview.endsWith("."), preview);
    const replyPreview = rowHtml(inboxHtml, commentId);
    check("列表回覆預覽都有車盤連結", replyPreview.includes(`class="reply-preview"`) && replyPreview.includes(linked(CAR)), replyPreview);
    check(
      "列表回覆預覽唔好把同事網址切成錯誤網域",
      replyPreview.includes(linked("https://staff.example/p")) && !replyPreview.includes("https://staff.exa<"),
      replyPreview
    );

    const css = fs.readFileSync(path.join(process.cwd(), "public", "styles.css"), "utf8");
    check("訊息連結有底線同顏色", css.includes("a.msg-link") && css.includes("text-decoration: underline") && css.includes("#0b4a7a"));
  } finally {
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
}

async function main(): Promise<number> {
  unitCases();
  await pageCases();
  if (failures.length) {
    console.error(`\n${failures.length} 項失敗`);
    return 1;
  }
  console.log("\n訊息網址連結通過");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
