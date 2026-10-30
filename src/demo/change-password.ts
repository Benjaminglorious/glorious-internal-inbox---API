/**
 * 改密碼煙霧測試。用臨時 SQLite，唔會郁到正式 data/inbox.db。
 *
 * 覆蓋：登入後頁頂有「改密碼」、同事同管理員只改到自己、
 * 現有密碼不符／太短／唔一致／同舊密碼一樣會留喺頁面並顯示中文錯誤、
 * 成功之後維持登入、舊密碼失效、新密碼可以登入、
 * JSON API 同一套規則、收藏同事唔會被改、
 * 再跑 seed 唔會覆寫已經改過嘅 password_hash，
 * 最後把測試帳號恢復做 DEMO_PASSWORD。
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type Database from "better-sqlite3";

const failures: string[] = [];
const DEMO_PASSWORD = "Glorious2026!";
const WING_PAGE_PASSWORD = "Abcd1234";
const WING_API_PASSWORD = "WingApi2026!";
const TONY_PASSWORD = "TonyNew2026!";
const YUKI_PASSWORD = "YukiOnly2026!";

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

async function login(
  base: string,
  username: string,
  password: string
): Promise<{ status: number; cookie: string; location: string }> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }),
  });
  return {
    status: res.status,
    cookie: cookieHeader(res),
    location: res.headers.get("location") || "",
  };
}

async function postForm(
  base: string,
  cookie: string,
  fields: Record<string, string>
): Promise<{ status: number; location: string }> {
  const res = await fetch(`${base}/password`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
  });
  return { status: res.status, location: res.headers.get("location") || "" };
}

function passwordHash(appDb: Database.Database, username: string): string {
  const row = appDb.prepare(`SELECT password_hash FROM staff WHERE username = ?`).get(username) as
    | { password_hash: string }
    | undefined;
  if (!row) throw new Error(`找不到同事 ${username}`);
  return row.password_hash;
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-password-"));
  const dbFile = path.join(tmp, "inbox.db");
  let appDb: Database.Database | undefined;
  let server: Server | undefined;

  try {
    process.env.DATABASE_PATH = dbFile;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as typeof import("../db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const seedMod = require("../db/seed") as typeof import("../db/seed");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const passwords = require("../auth/passwords") as typeof import("../auth/passwords");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const changeApi = require("../auth/change-password") as typeof import("../auth/change-password");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const express = require("express") as typeof import("express");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const session = require("express-session") as typeof import("express-session");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const apiRoutes = require("../routes/api") as typeof import("../routes/api");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const authRoutes = require("../routes/auth") as typeof import("../routes/auth");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pageRoutes = require("../routes/pages") as typeof import("../routes/pages");

    appDb = dbMod.db;
    const staffCount = appDb.prepare(`SELECT COUNT(*) AS n FROM staff`).get() as { n: number };
    if (staffCount.n === 0) await seedMod.seed();

    const verify = (username: string, plain: string): boolean =>
      passwords.verifyPassword(plain, passwordHash(appDb!, username));

    check("新 seed：Wing 可以用示範密碼", verify("wing", DEMO_PASSWORD));
    check("新 seed：收藏 yuki 都係示範密碼", verify("yuki", DEMO_PASSWORD));

    const wingRow = appDb.prepare(`SELECT id FROM staff WHERE username = 'wing'`).get() as { id: number };
    const tonyRow = appDb.prepare(`SELECT id FROM staff WHERE username = 'tony'`).get() as { id: number };
    const yukiRow = appDb.prepare(`SELECT id FROM staff WHERE username = 'yuki'`).get() as { id: number };
    const eddieHashAtStart = passwordHash(appDb, "eddie");
    const wingComment = appDb
      .prepare(`SELECT id FROM comments WHERE assignee_staff_id = ? ORDER BY id ASC LIMIT 1`)
      .get(wingRow.id) as { id: number };

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use(
      session({
        secret: "change-password-demo",
        resave: false,
        saveUninitialized: false,
      })
    );
    app.use("/api/auth", authRoutes.authRouter);
    app.use("/api", apiRoutes.apiRouter);
    app.use(pageRoutes.pagesRouter);

    server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const anonPage = await fetch(`${base}/password`, { redirect: "manual" });
    check(
      "未登入開改密碼頁會去登入",
      anonPage.status === 302 && (anonPage.headers.get("location") || "").includes("/login")
    );
    const loginPage = await fetch(`${base}/login`);
    const loginHtml = await loginPage.text();
    check("登入頁冇改密碼連結", loginPage.status === 200 && !loginHtml.includes('href="/password"'));

    const anonApi = await fetch(`${base}/api/auth/password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        current_password: DEMO_PASSWORD,
        new_password: WING_PAGE_PASSWORD,
        confirm_password: WING_PAGE_PASSWORD,
        username: "wing",
      }),
    });
    const anonApiBody = (await anonApi.json()) as { error?: string };
    check(
      "未登入 API 改密碼 401",
      anonApi.status === 401 && anonApiBody.error === "未登入" && verify("wing", DEMO_PASSWORD)
    );

    const wingLogin = await login(base, "wing", DEMO_PASSWORD);
    const tonyLogin = await login(base, "tony", DEMO_PASSWORD);
    check("Wing 可以登入", wingLogin.status === 302 && wingLogin.location === "/" && wingLogin.cookie.includes("connect.sid="));
    check("Tony 可以登入", tonyLogin.status === 302 && tonyLogin.cookie.includes("connect.sid="));

    const wingHeaders = { cookie: wingLogin.cookie };
    const tonyHeaders = { cookie: tonyLogin.cookie };

    const wingHome = await fetch(`${base}/`, { headers: wingHeaders });
    const wingHomeHtml = await wingHome.text();
    const wingStaff = await fetch(`${base}/staff`, { headers: wingHeaders });
    const wingStaffHtml = await wingStaff.text();
    const wingDetail = await fetch(`${base}/comments/${wingComment.id}`, { headers: wingHeaders });
    const wingDetailHtml = await wingDetail.text();
    const tonyLines = await fetch(`${base}/whatsapp-lines`, { headers: tonyHeaders });
    const tonyLinesHtml = await tonyLines.text();
    const wingDenied = await fetch(`${base}/whatsapp-lines`, { headers: wingHeaders });
    const wingDeniedHtml = await wingDenied.text();
    const hasPasswordLink = (html: string): boolean => html.includes('href="/password"') && html.includes("改密碼");
    check("留言箱有改密碼", wingHome.status === 200 && hasPasswordLink(wingHomeHtml) && !wingHomeHtml.includes("WhatsApp 線路"));
    check("同事頁有改密碼", wingStaff.status === 200 && hasPasswordLink(wingStaffHtml));
    check("留言詳情有改密碼", wingDetail.status === 200 && hasPasswordLink(wingDetailHtml));
    check("管理員 WhatsApp 頁有改密碼", tonyLines.status === 200 && hasPasswordLink(tonyLinesHtml));
    check("同事被拒嘅頁面都有改密碼", wingDenied.status === 403 && hasPasswordLink(wingDeniedHtml));

    const passwordPage = await fetch(`${base}/password`, { headers: wingHeaders });
    const passwordHtml = await passwordPage.text();
    check(
      "改密碼頁有三個欄位，而且改唔到其他人",
      passwordPage.status === 200 &&
        passwordHtml.includes("而家嘅密碼") &&
        passwordHtml.includes('name="current_password"') &&
        passwordHtml.includes('name="new_password"') &&
        passwordHtml.includes('name="confirm_password"') &&
        passwordHtml.includes("只會改你自己嘅登入密碼") &&
        !passwordHtml.includes('name="username"') &&
        !passwordHtml.includes('name="staff_id"') &&
        passwordHtml.includes('href="/password" class="active"')
    );

    const hashBeforeFail = passwordHash(appDb, "wing");
    const mismatch = await postForm(base, wingLogin.cookie, {
      current_password: DEMO_PASSWORD,
      new_password: WING_PAGE_PASSWORD,
      confirm_password: "Different1",
    });
    const mismatchPage = await fetch(`${base}${mismatch.location}`, { headers: wingHeaders });
    const mismatchHtml = await mismatchPage.text();
    check(
      "新密碼同確認唔一致",
      mismatch.status === 302 &&
        mismatchHtml.includes("新密碼同確認密碼唔一致") &&
        passwordHash(appDb, "wing") === hashBeforeFail
    );

    const tooShort = await postForm(base, wingLogin.cookie, {
      current_password: DEMO_PASSWORD,
      new_password: "Abcd123",
      confirm_password: "Abcd123",
    });
    const tooShortPage = await fetch(`${base}${tooShort.location}`, { headers: wingHeaders });
    check(
      "新密碼太短",
      tooShort.status === 302 &&
        (await tooShortPage.text()).includes("新密碼至少要 8 個字") &&
        passwordHash(appDb, "wing") === hashBeforeFail
    );

    const same = await postForm(base, wingLogin.cookie, {
      current_password: DEMO_PASSWORD,
      new_password: DEMO_PASSWORD,
      confirm_password: DEMO_PASSWORD,
    });
    const samePage = await fetch(`${base}${same.location}`, { headers: wingHeaders });
    check(
      "新密碼唔可以同而家一樣",
      same.status === 302 &&
        (await samePage.text()).includes("新密碼唔可以同而家嘅密碼一樣") &&
        passwordHash(appDb, "wing") === hashBeforeFail
    );

    const wrong = await postForm(base, wingLogin.cookie, {
      current_password: "wrongpass",
      new_password: "wrongpass",
      confirm_password: "wrongpass",
    });
    const wrongPage = await fetch(`${base}${wrong.location}`, { headers: wingHeaders });
    check(
      "而家嘅密碼唔正確（唔好話成新舊相同）",
      wrong.status === 302 &&
        (await wrongPage.text()).includes("而家嘅密碼唔正確") &&
        passwordHash(appDb, "wing") === hashBeforeFail
    );

    const missing = await postForm(base, wingLogin.cookie, {
      current_password: DEMO_PASSWORD,
      new_password: WING_PAGE_PASSWORD,
    });
    const missingPage = await fetch(`${base}${missing.location}`, { headers: wingHeaders });
    check(
      "漏填確認密碼",
      missing.status === 302 &&
        (await missingPage.text()).includes("請填寫而家嘅密碼、新密碼同確認新密碼") &&
        passwordHash(appDb, "wing") === hashBeforeFail
    );

    const changed = await postForm(base, wingLogin.cookie, {
      current_password: DEMO_PASSWORD,
      new_password: WING_PAGE_PASSWORD,
      confirm_password: WING_PAGE_PASSWORD,
    });
    const changedPage = await fetch(`${base}${changed.location}`, { headers: wingHeaders });
    const changedHtml = await changedPage.text();
    const stillHome = await fetch(`${base}/`, { headers: wingHeaders });
    check(
      "網頁改密碼成功而且維持登入",
      changed.status === 302 &&
        changed.location.includes("ok=1") &&
        changedPage.status === 200 &&
        changedHtml.includes(changeApi.PASSWORD_CHANGED_MESSAGE) &&
        stillHome.status === 200 &&
        verify("wing", WING_PAGE_PASSWORD) &&
        !verify("wing", DEMO_PASSWORD)
    );

    const oldLogin = await login(base, "wing", DEMO_PASSWORD);
    const newLogin = await login(base, "wing", WING_PAGE_PASSWORD);
    check("舊密碼登入失敗", oldLogin.status === 302 && oldLogin.location.includes("error") && !oldLogin.cookie);
    check("新密碼登入成功", newLogin.status === 302 && newLogin.location === "/" && newLogin.cookie.includes("connect.sid="));

    const apiShort = await fetch(`${base}/api/auth/password`, {
      method: "POST",
      headers: { ...wingHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        current_password: WING_PAGE_PASSWORD,
        new_password: "short",
        confirm_password: "short",
        staff_id: tonyRow.id,
        username: "tony",
      }),
    });
    const apiShortBody = (await apiShort.json()) as { error?: string };
    check(
      "API 太短唔會改到任何人",
      apiShort.status === 400 &&
        apiShortBody.error === "新密碼至少要 8 個字" &&
        verify("wing", WING_PAGE_PASSWORD) &&
        verify("tony", DEMO_PASSWORD)
    );

    const apiChange = await fetch(`${base}/api/auth/password`, {
      method: "POST",
      headers: { ...wingHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        current_password: WING_PAGE_PASSWORD,
        new_password: WING_API_PASSWORD,
        confirm_password: WING_API_PASSWORD,
        staff_id: tonyRow.id,
        username: "tony",
      }),
    });
    const apiChangeBody = (await apiChange.json()) as { ok?: boolean };
    const wingAfterApi = await fetch(`${base}/`, { headers: wingHeaders });
    check(
      "API 只改自己，session 仍然有效",
      apiChange.status === 200 &&
        apiChangeBody.ok === true &&
        wingAfterApi.status === 200 &&
        verify("wing", WING_API_PASSWORD) &&
        !verify("wing", WING_PAGE_PASSWORD) &&
        verify("tony", DEMO_PASSWORD)
    );

    const wingApiLoginOld = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "wing", password: WING_PAGE_PASSWORD }),
    });
    const wingApiLoginNew = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "wing", password: WING_API_PASSWORD }),
    });
    check("API 舊密碼登入失敗", wingApiLoginOld.status === 401);
    check("API 新密碼登入成功", wingApiLoginNew.status === 200);

    const tonyApi = await fetch(`${base}/api/auth/password`, {
      method: "POST",
      headers: { ...tonyHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        current_password: DEMO_PASSWORD,
        new_password: TONY_PASSWORD,
        confirm_password: TONY_PASSWORD,
        staff_id: wingRow.id,
        username: "wing",
      }),
    });
    const tonyApiBody = (await tonyApi.json()) as { ok?: boolean };
    const tonyStill = await fetch(`${base}/`, { headers: tonyHeaders });
    check(
      "管理員都只改到自己",
      tonyApi.status === 200 &&
        tonyApiBody.ok === true &&
        tonyStill.status === 200 &&
        verify("tony", TONY_PASSWORD) &&
        !verify("tony", DEMO_PASSWORD) &&
        verify("wing", WING_API_PASSWORD)
    );

    const wingHashCustom = passwordHash(appDb, "wing");
    const tonyHashCustom = passwordHash(appDb, "tony");
    appDb.prepare(`UPDATE staff SET display_name = '已改名', is_admin = 1, active = 0 WHERE username = 'wing'`).run();
    appDb.prepare(`UPDATE staff SET password_hash = ?, display_name = '已改收藏' WHERE username = 'yuki'`).run(
      passwords.hashPassword(YUKI_PASSWORD)
    );
    const yukiCustomHash = passwordHash(appDb, "yuki");
    seedMod.applySeedStaff();

    const wingAfterSeed = appDb
      .prepare(`SELECT display_name, is_admin, active, password_hash FROM staff WHERE username = 'wing'`)
      .get() as { display_name: string; is_admin: number; active: number; password_hash: string };
    const yukiAfterSeed = appDb
      .prepare(`SELECT display_name, is_admin, active, password_hash FROM staff WHERE username = 'yuki'`)
      .get() as { display_name: string; is_admin: number; active: number; password_hash: string };
    check(
      "再 seed：Wing 姓名角色在職恢復，密碼唔變",
      wingAfterSeed.display_name === "Wing Cheng" &&
        wingAfterSeed.is_admin === 0 &&
        wingAfterSeed.active === 1 &&
        wingAfterSeed.password_hash === wingHashCustom &&
        verify("wing", WING_API_PASSWORD) &&
        !verify("wing", DEMO_PASSWORD)
    );
    check(
      "再 seed：收藏同事密碼唔被重設",
      yukiAfterSeed.display_name === "趙雪兒" &&
        yukiAfterSeed.active === 0 &&
        yukiAfterSeed.is_admin === 0 &&
        yukiAfterSeed.password_hash === yukiCustomHash &&
        verify("yuki", YUKI_PASSWORD) &&
        !verify("yuki", DEMO_PASSWORD)
    );
    check("再 seed：Tony 自訂密碼唔變", passwordHash(appDb, "tony") === tonyHashCustom);
    check("再 seed：Eddie 未改過嘅密碼唔變", passwordHash(appDb, "eddie") === eddieHashAtStart);

    const inactiveAttempt = changeApi.changeOwnPassword(yukiRow.id, {
      current_password: YUKI_PASSWORD,
      new_password: "ShouldNot1",
      confirm_password: "ShouldNot1",
    });
    check(
      "收藏同事唔可以改密碼",
      inactiveAttempt.ok === false &&
        inactiveAttempt.status === 401 &&
        passwordHash(appDb, "yuki") === yukiCustomHash
    );

    appDb.prepare(`UPDATE comments SET assignee_staff_id = NULL WHERE assignee_staff_id = ?`).run(yukiRow.id);
    appDb.prepare(`DELETE FROM comment_replies WHERE staff_id = ?`).run(yukiRow.id);
    appDb.prepare(`DELETE FROM push_subscriptions WHERE staff_id = ?`).run(yukiRow.id);
    appDb.prepare(`DELETE FROM whatsapp_lines WHERE staff_id = ?`).run(yukiRow.id);
    appDb.prepare(`DELETE FROM staff WHERE username = 'yuki'`).run();
    seedMod.applySeedStaff();
    const yukiReinserted = appDb.prepare(`SELECT id, active FROM staff WHERE username = 'yuki'`).get() as {
      id: number;
      active: number;
    };
    check(
      "新插入先至寫示範密碼",
      yukiReinserted.active === 0 &&
        yukiReinserted.id !== yukiRow.id &&
        verify("yuki", DEMO_PASSWORD) &&
        !verify("yuki", YUKI_PASSWORD)
    );

    const wingRestored = changeApi.changeOwnPassword(wingRow.id, {
      current_password: WING_API_PASSWORD,
      new_password: DEMO_PASSWORD,
      confirm_password: DEMO_PASSWORD,
    });
    const tonyRestored = changeApi.changeOwnPassword(tonyRow.id, {
      current_password: TONY_PASSWORD,
      new_password: DEMO_PASSWORD,
      confirm_password: DEMO_PASSWORD,
    });
    const wingRestoredHash = passwordHash(appDb, "wing");
    const tonyRestoredHash = passwordHash(appDb, "tony");
    seedMod.applySeedStaff();
    check(
      "恢復示範密碼之後再 seed 仍然唔覆寫",
      wingRestored.ok === true &&
        tonyRestored.ok === true &&
        passwordHash(appDb, "wing") === wingRestoredHash &&
        passwordHash(appDb, "tony") === tonyRestoredHash &&
        verify("wing", DEMO_PASSWORD) &&
        verify("tony", DEMO_PASSWORD)
    );

    const wingDemo = await login(base, "wing", DEMO_PASSWORD);
    const tonyDemo = await login(base, "tony", DEMO_PASSWORD);
    check("Wing 恢復後可以用示範密碼登入", wingDemo.status === 302 && wingDemo.location === "/");
    check("Tony 恢復後可以用示範密碼登入", tonyDemo.status === 302 && tonyDemo.location === "/");

    if (failures.length) {
      console.error(`\n${failures.length} 項失敗`);
      return 1;
    }
    console.log("\n改密碼示範通過");
    return 0;
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
      });
    }
    appDb?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
