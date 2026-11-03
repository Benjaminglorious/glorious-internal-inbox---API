/**
 * 留言箱搜尋同 Facebook／Instagram 帖文顯示。
 * 用臨時 SQLite。同事只搜到自己負責嘅留言；管理員搜到未派同其他人。
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type Database from "better-sqlite3";

const failures: string[] = [];
const PASSWORD = "SearchDemo1!";

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

async function login(base: string, username: string): Promise<string> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password: PASSWORD }),
  });
  return cookieHeader(res);
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-search-"));
  const dbFile = path.join(tmp, "inbox.db");
  let appDb: Database.Database | undefined;
  let server: Server | undefined;

  try {
    process.env.INBOX_DB = "sqlite";
    process.env.DATABASE_PATH = dbFile;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    delete process.env.META_PAGE_ACCESS_TOKEN;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as typeof import("../db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const passwords = require("../auth/passwords") as typeof import("../auth/passwords");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const express = require("express") as typeof import("express");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const session = require("express-session") as typeof import("express-session");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const apiRoutes = require("../routes/api") as typeof import("../routes/api");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pageRoutes = require("../routes/pages") as typeof import("../routes/pages");

    appDb = dbMod.db;
    const hash = await passwords.hashPassword(PASSWORD);
    const insertStaff = appDb.prepare(
      `INSERT INTO staff (username, display_name, password_hash, is_admin, active)
       VALUES (?, ?, ?, ?, 1)`
    );
    const tonyId = Number(insertStaff.run("tony", "Tony Chan", hash, 1).lastInsertRowid);
    const wingId = Number(insertStaff.run("wing", "Wing Cheng", hash, 0).lastInsertRowid);
    const jasonId = Number(insertStaff.run("jason", "Jason Cheng", hash, 0).lastInsertRowid);

    const insert = appDb.prepare(
      `INSERT INTO comments (
         source, external_id, author_name, body, vehicle_ref, status, assignee_staff_id,
         intake_kind, origin_site, wa_from_phone, meta_surface, meta_post_id, meta_post_permalink, meta_post_caption
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const alphardId = Number(
      insert.run(
        "glorious_web",
        "search-alphard",
        "陳大文",
        "想睇 Alphard",
        "ALPHARD-1",
        "done",
        wingId,
        "site_comment",
        null,
        null,
        null,
        null,
        null,
        null
      ).lastInsertRowid
    );
    const jasonCommentId = Number(
      insert.run(
        "facebook",
        "1555555555_9001",
        "李小姐",
        "JASON-SECRET-BODY",
        null,
        "open",
        jasonId,
        "site_comment",
        null,
        null,
        "comment",
        "1555555555_1666666666",
        "https://www.facebook.com/GloriousMotors/posts/1666666666",
        "黑色 720S 帖文"
      ).lastInsertRowid
    );
    insert.run(
      "28car",
      "search-unassigned",
      "未派客",
      "UNASSIGNED-SECRET",
      null,
      "open",
      null,
      "site_comment",
      null,
      null,
      null,
      null,
      null,
      null
    );
    insert.run(
      "whatsapp",
      "search-wa-ig",
      "WhatsApp客",
      "可議價",
      null,
      "open",
      wingId,
      "whatsapp_click",
      "instagram",
      "85291234567",
      null,
      null,
      null,
      null
    );
    insert.run(
      "glorious_web",
      "search-percent",
      "折扣客",
      "折扣 100% 真",
      null,
      "open",
      wingId,
      "site_comment",
      null,
      null,
      null,
      null,
      null,
      null
    );
    insert.run(
      "facebook",
      "search-ig-dm",
      "私訊客",
      "IG 私訊內容 A_B code",
      null,
      "open",
      wingId,
      "site_comment",
      null,
      null,
      "message",
      null,
      null,
      null
    );
    appDb
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status)
         VALUES (?, ?, 'outbound', ?, 'stub')`
      )
      .run(alphardId, wingId, "回覆關鍵字 星期日交車");

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use(
      session({
        secret: "search-demo",
        resave: false,
        saveUninitialized: false,
      })
    );
    app.use("/api", apiRoutes.apiRouter);
    app.use(pageRoutes.pagesRouter);
    server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const wingCookie = await login(base, "wing");
    const tonyCookie = await login(base, "tony");
    check("Wing 同 Tony 都登入到", wingCookie.includes("connect.sid=") && tonyCookie.includes("connect.sid="));

    async function apiComments(cookie: string, query: string): Promise<{ status: number; comments: Array<{ id: number; body: string }> }> {
      const res = await fetch(`${base}/api/comments${query}`, {
        headers: { cookie, accept: "application/json" },
      });
      const json = (await res.json()) as { comments?: Array<{ id: number; body: string }> };
      return { status: res.status, comments: json.comments || [] };
    }

    const wingAlphard = await apiComments(wingCookie, "?q=" + encodeURIComponent("Alphard"));
    check(
      "API：Wing 搵到自己嘅 Alphard",
      wingAlphard.status === 200 && wingAlphard.comments.length === 1 && wingAlphard.comments[0]?.id === alphardId
    );
    const wingSecret = await apiComments(wingCookie, "?q=" + encodeURIComponent("JASON-SECRET-BODY"));
    check("API：Wing 搵唔到 Jason 嘅留言", wingSecret.status === 200 && wingSecret.comments.length === 0);
    const wingReply = await apiComments(wingCookie, "?q=" + encodeURIComponent("星期日交車"));
    check("API：回覆內容搵到原留言", wingReply.comments.length === 1 && wingReply.comments[0]?.id === alphardId);
    const wingPhone = await apiComments(wingCookie, "?q=" + encodeURIComponent("9123 4567"));
    check(
      "API：電話可以有空格",
      wingPhone.comments.length === 1 && wingPhone.comments[0]?.body === "可議價"
    );
    const wingOrigin = await apiComments(wingCookie, "?q=" + encodeURIComponent("東榮 IG"));
    check(
      "API：來源標籤搵到來自 IG 嘅 WhatsApp",
      wingOrigin.comments.length === 1 && wingOrigin.comments[0]?.body === "可議價"
    );
    const wingPercent = await apiComments(wingCookie, "?q=" + encodeURIComponent("%"));
    check(
      "API：% 係字面字，唔會搵晒全部",
      wingPercent.comments.length === 1 && wingPercent.comments[0]?.body === "折扣 100% 真"
    );
    const wingUnderscore = await apiComments(wingCookie, "?q=" + encodeURIComponent("_"));
    const underscoreBodies = wingUnderscore.comments.map((row) => row.body);
    check(
      "API：_ 係字面字，唔會當任何一個字",
      underscoreBodies.includes("IG 私訊內容 A_B code") &&
        underscoreBodies.includes("想睇 Alphard") &&
        !underscoreBodies.includes("可議價"),
      underscoreBodies.join(" | ")
    );
    const wingDone = await apiComments(wingCookie, "?q=" + encodeURIComponent("Alphard") + "&status=open");
    check("API：搜尋同狀態篩選一齊用", wingDone.comments.length === 0);
    const tonySecret = await apiComments(tonyCookie, "?q=" + encodeURIComponent("JASON-SECRET-BODY"));
    check("API：Tony 搵到其他人嘅留言", tonySecret.comments.length === 1 && tonySecret.comments[0]?.id === jasonCommentId);
    const tonyUnassigned = await apiComments(tonyCookie, "?q=" + encodeURIComponent("UNASSIGNED-SECRET"));
    check("API：Tony 搵到未派", tonyUnassigned.comments.length === 1);
    const tonyPost = await apiComments(tonyCookie, "?q=" + encodeURIComponent("黑色 720S"));
    check("API：帖文內容可以搜", tonyPost.comments.length === 1 && tonyPost.comments[0]?.id === jasonCommentId);
    const wingPost = await apiComments(wingCookie, "?q=" + encodeURIComponent("黑色 720S"));
    check("API：Wing 搵唔到睇唔到嘅帖文", wingPost.comments.length === 0);
    const anon = await fetch(`${base}/api/comments?q=Alphard`);
    check("未登入搜尋 401", anon.status === 401);

    const wingPage = await fetch(`${base}/?q=` + encodeURIComponent("沒有呢個字zzzz"), { headers: { cookie: wingCookie } });
    const wingHtml = await wingPage.text();
    check(
      "網頁：冇結果有空狀態",
      wingPage.status === 200 &&
        wingHtml.includes("搵唔到同「沒有呢個字zzzz」相符嘅留言") &&
        wingHtml.includes("搜尋") &&
        wingHtml.includes('name="q"')
    );
    const tonyPage = await fetch(`${base}/?q=` + encodeURIComponent("黑色 720S"), { headers: { cookie: tonyCookie } });
    const tonyHtml = await tonyPage.text();
    check(
      "網頁：搜尋結果顯示帖文摘要",
      tonyPage.status === 200 && tonyHtml.includes("帖文：黑色 720S 帖文") && tonyHtml.includes("搵到 1 條")
    );
    const nasty = await fetch(`${base}/?q=` + encodeURIComponent(`"><script>`), { headers: { cookie: wingCookie } });
    const nastyHtml = await nasty.text();
    check(
      "網頁：搜尋字會跳脫",
      nasty.status === 200 && !nastyHtml.includes(`value=""><script>`) && nastyHtml.includes("&quot;&gt;&lt;script&gt;")
    );

    const tonyDetail = await fetch(`${base}/comments/${jasonCommentId}`, { headers: { cookie: tonyCookie } });
    const detailHtml = await tonyDetail.text();
    check(
      "網頁：留言頁顯示所屬 Facebook 帖文",
      tonyDetail.status === 200 &&
        detailHtml.includes("所屬Facebook帖文") &&
        detailHtml.includes("黑色 720S 帖文") &&
        detailHtml.includes("1555555555_1666666666") &&
        detailHtml.includes("開啟Facebook原帖") &&
        detailHtml.includes("https://www.facebook.com/GloriousMotors/posts/1666666666")
    );
    const wingDetail = await fetch(`${base}/comments/${jasonCommentId}`, { headers: { cookie: wingCookie } });
    const wingDetailHtml = await wingDetail.text();
    check(
      "網頁：Wing 開唔到其他人嘅帖文留言",
      wingDetail.status === 404 && !wingDetailHtml.includes("黑色 720S 帖文")
    );
    const dm = await apiComments(wingCookie, "?q=" + encodeURIComponent("A_B code"));
    const dmPage = dm.comments[0] ? await fetch(`${base}/comments/${dm.comments[0].id}`, { headers: { cookie: wingCookie } }) : null;
    const dmHtml = dmPage ? await dmPage.text() : "";
    check("網頁：私訊寫明唔係帖文留言", dmHtml.includes("呢則係Facebook私訊，唔係公開帖文留言。"));

    if (failures.length) {
      console.error(`\n${failures.length} 項失敗`);
      return 1;
    }
    console.log("\n留言箱搜尋示範通過");
    return 0;
  } finally {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
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
