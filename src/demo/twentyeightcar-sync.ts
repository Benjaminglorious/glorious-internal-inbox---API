/**
 * 28car 車盤、留言板、路徑標籤同代理輪換。用臨時 SQLite，唔會打去 28car。
 */
import fs from "fs";
import http from "http";
import https from "https";
import net from "net";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { allocateLease, resetEgressSequenceForTests } from "../adapters/twentyeightcar-egress";
import { defaultProxyRequest } from "../adapters/twentyeightcar-http";
import { readAccounts, readEgress, twentyeightcarStatus } from "../adapters/twentyeightcar-config";
import { buildOwnerReplyBody } from "../adapters/twentyeightcar-http";
import { parseBoardHtml, parseReplyForm, parseSellListHtml } from "../adapters/twentyeightcar-parse";

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

function finish(): number {
  if (failures.length) {
    console.error(`\n${failures.length} 項失敗`);
    return 1;
  }
  console.log("\n28car 煙霧測試通過");
  return 0;
}

interface Captured {
  proxyUrl: string;
  url: string;
  method: string;
  body?: string;
}

function formMap(body: string | undefined): Map<string, string> {
  return new Map(body ? new URLSearchParams(body) : []);
}

async function listen(server: http.Server | https.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function testLocalProxy(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-28car-tls-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key], { stdio: "pipe" });
  execFileSync("openssl", ["req", "-new", "-x509", "-key", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1"], {
    stdio: "pipe",
  });
  let hits = 0;
  const web = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    hits += 1;
    res.end(`ok ${req.url}`);
  });
  const webPort = await listen(web);
  const connects: string[] = [];
  const proxy = http.createServer((_req, res) => {
    res.statusCode = 405;
    res.end();
  });
  proxy.on("connect", (req, clientSocket, head) => {
    connects.push(req.url || "");
    const [host, portRaw] = String(req.url || "").split(":");
    const upstream = net.connect(Number(portRaw || 443), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  const response = await defaultProxyRequest({
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    url: `https://127.0.0.1:${webPort}/ping`,
    method: "GET",
    headers: { host: `127.0.0.1:${webPort}` },
    timeoutMs: 5000,
    rejectUnauthorized: false,
  });
  check("經 HTTP 代理 CONNECT 先至到達 HTTPS", response.status === 200 && response.body.includes("/ping"));
  check("代理收到 CONNECT", connects.some((item) => item.includes(String(webPort))));
  check("目標收到一則請求", hits === 1);
  proxy.closeAllConnections?.();
  web.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    proxy.close(() => web.close(() => resolve()));
    setTimeout(resolve, 300);
  });
}

async function main(): Promise<number> {
  const sellHtml = fs.readFileSync(path.join(__dirname, "../fixtures/28car/mbr-sell.html"), "utf8");
  const detailHtml = fs.readFileSync(path.join(__dirname, "../fixtures/28car/sell-dsp.html"), "utf8");
  const listings = parseSellListHtml(sellHtml);
  check("賣車列表四個車盤", listings.length === 4);
  check(
    "庫存編號同 vid 分開",
    listings[0]?.stockId === "s2806213" && listings[0]?.vid === "673498740" && listings[0]?.commentCount === 1
  );
  check("留言欄數量唔會變成留言正文", listings.every((item) => item.commentCount === 1));
  check("標題包含年份", listings[0]?.title.includes("麥拿倫") && listings[0]?.title.includes("2017"));

  const board = parseBoardHtml(detailHtml);
  check("簡評唔係留言", !!board.blurb && board.blurb.includes("車況良好") && board.messages.every((item) => !item.body.includes("車況良好")));
  check("留言板有賣家同買家", board.messages.length === 2 && board.messages[0]?.isSeller === true && board.messages[1]?.isSeller === false);
  check("買家正文保留", board.messages[1]?.body.includes("星期六") === true);
  const form = parseReplyForm(detailHtml);
  check("form1 有一次性 token", !!form && form.hT === "fresh-token-t" && form.hK === "fresh-token-k");
  const posted = form ? buildOwnerReplyBody(form, "673498740", "星期六可以睇車") : null;
  check(
    "代發用 h_mode=add、h_type=o，唔用刪除表單",
    !!posted &&
      posted.get("h_mode") === "add" &&
      posted.get("h_type") === "o" &&
      posted.get("h_t") === "fresh-token-t" &&
      posted.get("b_submit") === "  留言  " &&
      !posted.get("h_msgid") &&
      ![...posted.values()].some((value) => value.includes("del-token"))
  );

  delete process.env.TWENTYEIGHT_CAR_PROXY_URLS;
  process.env.TWENTYEIGHT_CAR_PROXY_URL = "http://user:pass@proxy.example:8000";
  check("單一個固定代理唔可以出網", readEgress().canRotate === false);
  process.env.TWENTYEIGHT_CAR_PROXY_URL = "http://user-{session}:pass@gate.example:8000";
  resetEgressSequenceForTests();
  const sessionA = allocateLease("sell_list", null);
  const sessionB = allocateLease("sell_dsp", "lease" in sessionA ? sessionA.lease.leaseId : null);
  check(
    "{session} 每次動作唔同",
    "lease" in sessionA &&
      "lease" in sessionB &&
      sessionA.lease.proxyUrl !== sessionB.lease.proxyUrl &&
      sessionA.lease.proxyUrl.includes("user-") &&
      !sessionA.lease.proxyUrl.includes("{session}")
  );

  delete process.env.TWENTYEIGHT_CAR_PROXY_URL;
  process.env.TWENTYEIGHT_CAR_PROXY_URLS = "http://127.0.0.1:4101,http://127.0.0.1:4102";
  const first = allocateLease("one", null);
  const second = allocateLease("two", "lease" in first ? first.lease.leaseId : null);
  const third = allocateLease("three", "lease" in second ? second.lease.leaseId : null);
  check(
    "代理清單輪流而且唔重複上一次",
    "lease" in first &&
      "lease" in second &&
      "lease" in third &&
      first.lease.proxyUrl !== second.lease.proxyUrl &&
      second.lease.proxyUrl !== third.lease.proxyUrl &&
      third.lease.proxyUrl === first.lease.proxyUrl
  );

  const secret = "SuperSecret123";
  process.env.TWENTYEIGHT_CAR_ACCOUNTS_JSON = `[{"username":"a@example.com","password":"${secret}"`;
  const broken = readAccounts();
  check("壞 JSON 嘅錯誤唔包含密碼", !!broken.error && !broken.error.includes(secret) && !JSON.stringify(twentyeightcarStatus(true)).includes(secret));
  const many = Array.from({ length: 11 }, (_, index) => ({
    username: `gmld${index}@hotmail.com`,
    password: "replace-me",
    display_name: "東榮汽車",
  }));
  process.env.TWENTYEIGHT_CAR_ACCOUNTS_JSON = JSON.stringify(many);
  const capped = readAccounts();
  check("最多 10 個帳號", capped.accounts.length === 10 && capped.truncated);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-28car-"));
  process.env.DATABASE_PATH = path.join(tmp, "inbox.db");
  process.env.TWENTYEIGHT_CAR_SYNC_ENABLED = "0";
  process.env.TWENTYEIGHT_CAR_REPLY_POST_ENABLED = "0";
  delete process.env.TWENTYEIGHT_CAR_LOGIN_FORM_JSON;
  process.env.TWENTYEIGHT_CAR_ACCOUNTS_JSON = JSON.stringify([
    { username: "gmld28013@hotmail.com", password: secret, display_name: "東榮汽車" },
    { username: "gmld28022@hotmail.com", password: secret, display_name: "東榮汽車" },
  ]);
  process.env.TWENTYEIGHT_CAR_PROXY_URLS = "http://127.0.0.1:4101,http://127.0.0.1:4102";
  process.env.TWENTYEIGHT_CAR_MAX_ACCOUNTS_PER_RUN = "1";
  process.env.TWENTYEIGHT_CAR_MAX_DETAIL_FETCHES = "1";
  process.env.TWENTYEIGHT_CAR_REQUEST_GAP_MS = "0";

  const calls: Captured[] = [];
  const sleeps: number[] = [];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const httpMod = require("../adapters/twentyeightcar-http") as typeof import("../adapters/twentyeightcar-http");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const service = require("../services/twentyeightcar") as typeof import("../services/twentyeightcar");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const replies = require("../services/replies") as typeof import("../services/replies");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wa = require("../services/whatsapp") as typeof import("../services/whatsapp");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dbMod = require("../db") as typeof import("../db");

  httpMod.setTwentyeightcarProxyRequestForTests(async (input) => {
    calls.push({ proxyUrl: input.proxyUrl, url: input.url, method: input.method, body: input.body });
    if (input.method === "POST" && input.url.includes("mbr_login")) {
      return {
        status: 302,
        url: input.url,
        body: "",
        contentType: "text/html",
        setCookies: ["sid=abc"],
        location: "https://org.28car.com/index.htm",
      };
    }
    if (input.url.includes("index.htm")) {
      return { status: 200, url: input.url, body: "登出", contentType: "text/html", setCookies: [], location: null };
    }
    if (input.url.includes("sell_dsp.php")) {
      if (input.method === "GET") {
        return { status: 200, url: input.url, body: detailHtml, contentType: "text/html; charset=utf-8", setCookies: [], location: null };
      }
      const message = formMap(input.body).get("h_msg") || "";
      return { status: 200, url: input.url, body: `已刊登 ${message}`, contentType: "text/html", setCookies: [], location: null };
    }
    if (input.url.includes("mbr_sell.php")) {
      return { status: 200, url: input.url, body: sellHtml, contentType: "text/html; charset=utf-8", setCookies: [], location: null };
    }
    return { status: 500, url: input.url, body: "unexpected", contentType: "text/html", setCookies: [], location: null };
  });
  service.setTwentyeightcarSleepForTests(async (ms) => {
    sleeps.push(ms);
  });

  dbMod.db.prepare(`INSERT INTO staff (username, display_name, password_hash, is_admin, active) VALUES ('wing', 'Wing', 'x', 0, 1)`).run();

  const disabled = await service.syncTwentyeightcar();
  check("同步旗標關閉時零網絡", disabled.network === false && disabled.mode === "disabled" && calls.length === 0);

  process.env.TWENTYEIGHT_CAR_SYNC_ENABLED = "1";
  delete process.env.TWENTYEIGHT_CAR_PROXY_URLS;
  delete process.env.TWENTYEIGHT_CAR_PROXY_URL;
  const noProxy = await service.syncTwentyeightcar();
  check("零個代理時拒絕直連", noProxy.mode === "proxy_required" && noProxy.network === false && calls.length === 0);

  process.env.TWENTYEIGHT_CAR_PROXY_URLS = "http://127.0.0.1:4101";
  const oneProxy = await service.syncTwentyeightcar();
  check(
    "剛好一個代理時仍然拒絕出網",
    oneProxy.mode === "proxy_required" && oneProxy.network === false && calls.length === 0 && readEgress().canRotate === false
  );

  process.env.TWENTYEIGHT_CAR_PROXY_URLS = "http://127.0.0.1:4101,http://127.0.0.1:4102";
  const synced = await service.syncTwentyeightcar();
  check("同步走代理", synced.network && calls.length > 0 && calls.every((call) => call.proxyUrl.startsWith("http://127.0.0.1:")));
  const listCall = calls.find((call) => call.url.includes("mbr_sell.php"));
  const detailCall = calls.find((call) => call.method === "GET" && call.url.includes("sell_dsp.php"));
  check("列表同留言板用唔同代理", !!listCall && !!detailCall && listCall.proxyUrl !== detailCall.proxyUrl);
  check("動作之間有最少 1 秒間隔", sleeps.some((ms) => ms >= 1000));
  const loginBody = formMap(calls.find((call) => call.method === "POST" && call.url.includes("mbr_login.php"))?.body);
  check(
    "登入 POST 用 h_username、h_password、h_mode=login",
    loginBody.get("h_username") === "gmld28013@hotmail.com" &&
      loginBody.get("h_password") === secret &&
      loginBody.get("h_mode") === "login" &&
      loginBody.get("h_url_login_src") === "" &&
      loginBody.get("h_url_src") === "" &&
      !loginBody.has("h_t") &&
      !loginBody.has("h_k")
  );
  check("登入正文有密碼，留言頁 GET 冇密碼", calls.some((call) => (call.body || "").includes(secret)) && !(detailCall?.url || "").includes(secret));
  const detailGets = calls.filter((call) => call.method === "GET" && call.url.includes("sell_dsp.php"));
  check("詳情抓取受上限限制", detailGets.length === 1);
  check("今次運行只登入上限內嘅帳號", calls.filter((call) => call.method === "POST" && call.url.includes("mbr_login")).length === 2);

  const listing = service.getListing("s2806213");
  check(
    "車盤有庫存編號、vid 同公開連結",
    !!listing &&
      listing.vid === "673498740" &&
      listing.public_url === "https://www.28car.com/sell_dsp.php?h_vid=673498740&h_vw=y" &&
      listing.account_username === "gmld28013@hotmail.com",
    JSON.stringify({
      mode: synced.mode,
      upserted: synced.listings_upserted,
      stopped: synced.stopped,
      accounts: synced.accounts_attempted,
      listing,
    })
  );
  const messages = service.listListingMessages("s2806213");
  check("留言板賣家同買家都入庫", messages.some((item) => item.is_seller) && messages.some((item) => !item.is_seller));
  const buyer = dbMod.db
    .prepare(`SELECT entry_path, source, intake_kind, author_name FROM comments WHERE entry_path = '28car_board'`)
    .get() as { entry_path: string; source: string; intake_kind: string; author_name: string } | undefined;
  check("買家留言出現喺收件箱 API 欄位", buyer?.source === "28car" && buyer.intake_kind === "site_comment" && buyer.author_name === "陳先生");
  const sellerInInbox = dbMod.db
    .prepare(`SELECT COUNT(*) AS n FROM comments WHERE body LIKE '%api.whatsapp.com/send%'`)
    .get() as { n: number };
  check("賣家 WhatsApp 附註唔當客戶工單", sellerInInbox.n === 0);
  const dbText = fs.readFileSync(process.env.DATABASE_PATH);
  check("資料庫檔案冇密碼", !dbText.includes(Buffer.from(secret)));

  const staff = dbMod.db.prepare(`SELECT id FROM staff WHERE username = 'wing'`).get() as { id: number };
  const buyerRow = dbMod.db.prepare(`SELECT id FROM comments WHERE entry_path = '28car_board'`).get() as { id: number };
  process.env.TWENTYEIGHT_CAR_REPLY_POST_ENABLED = "0";
  const beforeHold = calls.length;
  const held = await replies.createStaffReply({ commentId: buyerRow.id, staffId: staff.id, body: "星期六可以嚟睇車" });
  check("旗標關閉只排隊", held.ok && held.reply.delivery_status === "stored" && calls.length === beforeHold);

  process.env.TWENTYEIGHT_CAR_REPLY_POST_ENABLED = "1";
  const previousProxy = calls[calls.length - 1]?.proxyUrl;
  const sent = await replies.createStaffReply({ commentId: buyerRow.id, staffId: staff.id, body: "星期日下午兩點" });
  const replyPost = calls.filter((call) => call.method === "POST" && call.url.includes("sell_dsp.php")).at(-1);
  const fields = formMap(replyPost?.body);
  check(
    "回覆 POST form1 而且同上一動作唔同代理",
    sent.ok &&
      sent.reply.delivery_status === "sent" &&
      fields.get("h_mode") === "add" &&
      fields.get("h_type") === "o" &&
      fields.get("h_vid") === "673498740" &&
      fields.get("h_msg") === "星期日下午兩點" &&
      fields.get("h_t") === "fresh-token-t" &&
      !replyPost?.body?.includes(secret) &&
      !replyPost?.body?.includes("del-token") &&
      !!replyPost?.proxyUrl &&
      replyPost.proxyUrl !== previousProxy
  );

  const parsedLink = wa.parseWhatsAppWebhookPayload({
    to: "85221740001",
    from: "85290001111",
    body: "想問 720S",
    external_id: "wa-board-link",
    referral: { source_url: "https://dj1jdjkadk.28car.com/sell_dsp.php?h_vid=673498740&h_vw=y" },
  });
  check(
    "車輛頁 WhatsApp referral 標成留言區連結",
    parsedLink.messages[0]?.originSite === "28car" && parsedLink.messages[0]?.entryPath === "28car_wa_link"
  );
  const home = wa.parseWhatsAppWebhookPayload({
    to: "85221740001",
    from: "85290001112",
    body: "首頁入嚟",
    external_id: "wa-home",
    referral: { source_url: "https://www.28car.com/" },
  });
  check("28car 首頁 WhatsApp 仍然係來自 28car，但唔係留言區連結", home.messages[0]?.originSite === "28car" && home.messages[0]?.entryPath == null);
  const site = wa.parseWhatsAppWebhookPayload({
    to: "85221740001",
    from: "85290001113",
    body: "官網",
    external_id: "wa-web",
    referral: { source_url: "https://glorious.hk/cn2/" },
  });
  check("官網 WhatsApp 維持 glorious_web", site.messages[0]?.originSite === "glorious_web" && site.messages[0]?.entryPath == null);

  wa.ensureCompanyWhatsAppLine();
  const routed = wa.routeWhatsAppInbound({
    toPhone: "85221740001",
    fromPhone: "85290001111",
    body: "想問 720S",
    externalId: "wa-board-link",
    originSite: parsedLink.messages[0]?.originSite,
    entryPath: parsedLink.messages[0]?.entryPath,
  });
  check(
    "留言區 WhatsApp 入庫後可以篩",
    routed.ok && routed.comment.entry_path === "28car_wa_link" && routed.comment.intake_kind === "whatsapp_click"
  );

  httpMod.setTwentyeightcarProxyRequestForTests(null);
  service.setTwentyeightcarSleepForTests(null);

  try {
    await testLocalProxy();
  } catch (err) {
    check("本地代理隧道", false, err instanceof Error ? err.message : "proxy");
  }
  return finish();
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
