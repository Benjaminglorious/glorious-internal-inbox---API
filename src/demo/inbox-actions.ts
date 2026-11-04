/**
 * 留言操作只展開「回覆」。其餘掣收喺未打開嘅「更多」。
 * 用臨時 SQLite，唔會郁到正式 data/inbox.db。
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type Database from "better-sqlite3";

const failures: string[] = [];
const DEMO_PASSWORD = "Glorious2026!";

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

function actionsCell(row: string): string {
  const match = row.match(/<td class="actions-cell">([\s\S]*?)<\/td>/);
  return match?.[1] ?? "";
}

function outsideDetails(html: string): string {
  return html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, "");
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-actions-"));
  const dbFile = path.join(tmp, "inbox.db");
  let appDb: Database.Database | undefined;
  let server: Server | undefined;

  try {
    process.env.INBOX_DB = "sqlite";
    process.env.DATABASE_PATH = dbFile;
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.META_PAGE_ACCESS_TOKEN;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as typeof import("../db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const passwords = require("../auth/passwords") as typeof import("../auth/passwords");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wa = require("../services/whatsapp") as typeof import("../services/whatsapp");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const comments = require("../services/comments") as typeof import("../services/comments");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const site = require("../services/site-comments") as typeof import("../services/site-comments");
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
    const staff = appDb
      .prepare(
        `INSERT INTO staff (username, display_name, password_hash, is_admin, active)
         VALUES ('tony', 'Tony Chan', ?, 1, 1)`
      )
      .run(hash);
    const staffId = Number(staff.lastInsertRowid);
    wa.ensureCompanyWhatsAppLine();
    const line = wa.addStaffWhatsAppLine({ staffId, phone: "85261113333", displayLabel: "Tony 個人" });
    check("Tony 有個人 WhatsApp", line.ok);

    const inbound = wa.routeWhatsAppInbound({
      toPhone: "85221740001",
      fromPhone: "85290008801",
      body: "想問車",
      externalId: "wamid.ACTIONS-1",
      authorName: "陳生",
    });
    const board = site.upsertSiteComment({
      source: "28car",
      external_id: "actions-board-1",
      author_name: "車盤客",
      body: "留言板一句",
      entry_path: "28car_board",
    });
    check("有 WhatsApp 同留言板各一條", inbound.ok && board.ok && inbound.comment.id !== board.comment.id);
    if (!inbound.ok || !board.ok) return 1;
    const assigned = comments.reassign(inbound.comment.id, staffId);
    check("WhatsApp 留言派咗畀 Tony，先至有同事 WhatsApp", assigned?.assignee_staff_id === staffId);

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use(session({ secret: "actions-demo", resave: false, saveUninitialized: false }));
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
      body: new URLSearchParams({ username: "tony", password: DEMO_PASSWORD }),
    });
    const cookie = cookieHeader(login);
    check("Tony 可以登入", login.status === 302 && cookie.includes("connect.sid="));

    const inbox = await fetch(`${base}/`, { headers: { cookie } });
    const inboxHtml = await inbox.text();
    const waCell = actionsCell(rowHtml(inboxHtml, inbound.comment.id));
    const boardCell = actionsCell(rowHtml(inboxHtml, board.comment.id));
    const waVisible = outsideDetails(waCell);
    check(
      "列表只展開回覆",
      waCell.startsWith(`<a class="btn primary" href="/comments/${inbound.comment.id}#reply">回覆</a>`) &&
        waVisible.includes("回覆") &&
        !waVisible.includes("回覆客戶") &&
        !waVisible.includes("WhatsApp") &&
        !/<details\b[^>]*\sopen\b/.test(waCell),
      waVisible
    );
    check(
      "列表其他掣收喺更多",
      waCell.includes('<details class="more-actions"><summary>更多</summary>') &&
        waCell.includes("回覆客戶") &&
        waCell.includes(">WhatsApp</a>") &&
        waCell.includes("同事 WhatsApp")
    );
    check(
      "留言板列同樣只展開回覆，公司 WhatsApp 喺更多",
      boardCell.startsWith(`<a class="btn primary" href="/comments/${board.comment.id}#reply">回覆</a>`) &&
        !outsideDetails(boardCell).includes("WhatsApp") &&
        boardCell.includes(">WhatsApp</a>") &&
        !boardCell.includes("回覆客戶")
    );
    check(
      "狀態徽章同負責人仍然喺列上，篩選仍然喺頁面",
      rowHtml(inboxHtml, inbound.comment.id).includes("badge status-") &&
        rowHtml(inboxHtml, inbound.comment.id).includes("Tony Chan") &&
        outsideDetails(inboxHtml).includes("擱置／未處理")
    );

    const detail = await fetch(`${base}/comments/${inbound.comment.id}`, { headers: { cookie } });
    const detailHtml = await detail.text();
    const detailVisible = outsideDetails(detailHtml);
    const more = detailHtml.match(/<details class="more-actions page-more">[\s\S]*<\/details>/);
    check(
      "留言頁外面只得系統內回覆",
      detail.status === 200 &&
        detailVisible.includes('id="reply"') &&
        detailVisible.includes("發送回覆") &&
        !detailVisible.includes("儲存狀態") &&
        !detailVisible.includes("<h2>改派同事</h2>") &&
        !detailVisible.includes("改派只限管理員") &&
        !detailVisible.includes("傳送相片、影片或語音") &&
        !detailVisible.includes('class="btn whatsapp own"') &&
        !detailVisible.includes(">WhatsApp</a>")
    );
    check(
      "留言頁更多未展開，入面有狀態、改派、媒體同 WhatsApp",
      !!more &&
        !/<details class="more-actions page-more"[^>]*\sopen\b/.test(detailHtml) &&
        more[0].includes("儲存狀態") &&
        more[0].includes("/assign") &&
        more[0].includes("傳送相片、影片或語音") &&
        more[0].includes("用我嘅 WhatsApp 發送畀客戶") &&
        more[0].includes(">WhatsApp</a>") &&
        more[0].includes("同事 WhatsApp"),
      more ? "more" : "missing details"
    );
    check("回覆表格唔喺更多入面", !more?.[0].includes('id="reply"'));
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

  if (failures.length) {
    console.error(`\n${failures.length} 項失敗`);
    return 1;
  }
  console.log("\n留言操作收起通過");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
