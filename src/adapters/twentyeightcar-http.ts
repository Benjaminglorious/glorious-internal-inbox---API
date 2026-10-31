/**
 * 28car 只可以經已租用嘅代理出去。冇 proxyUrl 就拒絕，唔會直連。
 * 同一個短動作（登入＋一頁，或者登入＋取 token＋POST）共用一個代理。
 * 下一個動作必須另租代理。
 */
import https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  dealerListingUrl,
  dealerOrigin,
  is28carHost,
  redactSecrets,
  type DealerAccount,
  type LoginFormConfig,
} from "./twentyeightcar-config";
import { declaresLegacyCharset, parseReplyForm, type ParsedReplyForm } from "./twentyeightcar-parse";
import type { EgressLease } from "./twentyeightcar-egress";

const MAX_BODY = 2_000_000;
const TIMEOUT_MS = 20_000;
const USER_AGENT = "GloriousInbox/1.0 (+https://glorious.hk)";

export interface ProxyHttpResult {
  status: number;
  url: string;
  body: string;
  contentType: string | null;
  setCookies: string[];
  location: string | null;
}

export interface NetOk {
  ok: true;
  status: number;
  url: string;
  body: string;
  contentType: string | null;
}

export interface NetFail {
  ok: false;
  blocked: boolean;
  busy: boolean;
  loginRejected: boolean;
  error: string;
}

export type NetResult = NetOk | NetFail;

type ProxyRequest = (input: {
  proxyUrl: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}) => Promise<ProxyHttpResult>;

let proxyRequestImpl: ProxyRequest = defaultProxyRequest;

export function setTwentyeightcarProxyRequestForTests(next: ProxyRequest | null): void {
  proxyRequestImpl = next ?? defaultProxyRequest;
}

export function defaultProxyRequest(input: {
  proxyUrl: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  rejectUnauthorized?: boolean;
}): Promise<ProxyHttpResult> {
  if (!input.proxyUrl) return Promise.reject(new Error("拒絕直連：未有代理"));
  const target = new URL(input.url);
  if (target.protocol !== "https:") return Promise.reject(new Error("只可以經代理連 HTTPS"));
  const agent = new HttpsProxyAgent(input.proxyUrl);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: input.method,
        headers: input.headers,
        agent,
        timeout: input.timeoutMs,
        rejectUnauthorized: input.rejectUnauthorized !== false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY) {
            res.destroy();
            reject(new Error("回應過大"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const rawCookies = res.headers["set-cookie"];
          const setCookies = Array.isArray(rawCookies) ? rawCookies : rawCookies ? [rawCookies] : [];
          const location = typeof res.headers.location === "string" ? res.headers.location : null;
          const contentType = typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : null;
          resolve({
            status: res.statusCode || 0,
            url: input.url,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType,
            setCookies,
            location,
          });
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("代理請求逾時"));
    });
    req.on("error", reject);
    if (input.body) req.write(input.body);
    req.end();
  });
}

export class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(setCookies: string[]): void {
    for (const line of setCookies) {
      const part = line.split(";")[0] ?? "";
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!name) continue;
      if (!value) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string | undefined {
    if (this.jar.size === 0) return undefined;
    return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

function allowedGetPath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  if (path.includes("mbr_chg")) return false;
  return (
    path === "/" ||
    path.endsWith("/mbr_sell.php") ||
    path.endsWith("/sell_dsp.php") ||
    path.endsWith("/index.htm") ||
    path.endsWith("/index.html") ||
    path.endsWith("/index.php") ||
    path.endsWith("/msg_busy.php")
  );
}

export function isBusy(url: string, body: string): boolean {
  return /msg_busy\.php/i.test(url) || /msg_busy/i.test(body);
}

/**
 * Cloudflare 會喺正常 HTML 注入 JavaScript Detection 腳本
 * （cdn-cgi/challenge-platform/.../scripts/jsd/main.js）。呢個唔係攔截牆。
 * 真正攔截先至係其餘 challenge-platform 網址，或者「Just a moment」而頁面冇可用表單。
 */
const SOFT_JSD_URL = /cdn-cgi\/challenge-platform\/(?:[A-Za-z0-9_.~-]+\/)*scripts\/jsd\/[^"'<>\s]*/gi;

function stripSoftJsd(body: string): string {
  return body.replace(SOFT_JSD_URL, "");
}

function hasNamedField(body: string, name: string): boolean {
  return new RegExp(`<(?:input|textarea|select)\\b[^>]*\\bname\\s*=\\s*(?:["']${name}["']|${name}\\b)`, "i").test(body);
}

function hasUsableDealerDocument(body: string): boolean {
  const login =
    hasNamedField(body, "h_username") &&
    (hasNamedField(body, "h_password") || /<input\b[^>]*\btype\s*=\s*["']password["']/i.test(body));
  if (login) return true;
  if (/<a\b[^>]*\bhref\s*=\s*["'][^"']*sell_dsp\.php\?[^"']*\bh_vid=/i.test(body)) return true;
  if (/id\s*=\s*["']msgbox["']/i.test(body)) return true;
  if (
    /<form\b[^>]*\b(?:name|id)\s*=\s*["']form1["']/i.test(body) &&
    (hasNamedField(body, "h_t") || hasNamedField(body, "h_k") || hasNamedField(body, "h_msg"))
  ) {
    return true;
  }
  return false;
}

function isChallengeWall(body: string): boolean {
  return /cdn-cgi\/challenge|just a moment/i.test(stripSoftJsd(body));
}

export function isBlockedResponse(status: number, url: string, body: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  if (isBusy(url, body)) return true;
  if (hasUsableDealerDocument(body)) return false;
  return isChallengeWall(body);
}

function fail(error: string, flags: Partial<NetFail>, secrets: string[]): NetFail {
  return {
    ok: false,
    blocked: !!flags.blocked,
    busy: !!flags.busy,
    loginRejected: !!flags.loginRejected,
    error: redactSecrets(error, secrets),
  };
}

async function requestOnce(
  lease: EgressLease,
  jar: CookieJar,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  secrets: string[]
): Promise<NetResult | { redirect: string }> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return fail("網址無效", { blocked: true }, secrets);
  }
  if (target.protocol !== "https:" || !is28carHost(target.hostname)) {
    return fail("拒絕連去 28car 以外嘅網址", { blocked: true }, secrets);
  }
  const pathOk = method === "GET" ? allowedGetPath(target.pathname) : target.pathname.toLowerCase().endsWith("/sell_dsp.php");
  if (!pathOk && method !== "POST") return fail("拒絕讀取會員資料修改頁", { blocked: true }, secrets);
  if (method === "POST" && !target.pathname.toLowerCase().endsWith("/sell_dsp.php") && !target.pathname.toLowerCase().endsWith("/mbr_login.php")) {
    return fail("只可以 POST 去登入頁或 sell_dsp.php", { blocked: true }, secrets);
  }
  try {
    const response = await proxyRequestImpl({
      proxyUrl: lease.proxyUrl,
      url: target.toString(),
      method,
      headers,
      body,
      timeoutMs: TIMEOUT_MS,
    });
    jar.absorb(response.setCookies);
    if (response.location && response.status >= 300 && response.status < 400) {
      const next = new URL(response.location, target).toString();
      return { redirect: next };
    }
    if (isBlockedResponse(response.status, response.url, response.body)) {
      return fail(`28car 擋住呢次請求（${response.status}）`, {
        blocked: true,
        busy: isBusy(response.url, response.body),
      }, secrets);
    }
    if (declaresLegacyCharset(response.body, response.contentType)) {
      return fail("頁面宣告 big5/gbk，已拒絕解讀以免寫入亂碼", { blocked: false }, secrets);
    }
    return {
      ok: true,
      status: response.status,
      url: response.url,
      body: response.body,
      contentType: response.contentType,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "代理請求失敗";
    return fail(message, { blocked: true }, secrets);
  }
}

async function requestFollowing(
  lease: EgressLease,
  jar: CookieJar,
  url: string,
  method: string,
  extraHeaders: Record<string, string>,
  body: string | undefined,
  secrets: string[]
): Promise<NetResult> {
  let current = url;
  let currentMethod = method;
  let currentBody = body;
  for (let hop = 0; hop < 4; hop += 1) {
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml",
      ...extraHeaders,
    };
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    if (currentBody != null) headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    const result = await requestOnce(lease, jar, current, currentMethod, headers, currentBody, secrets);
    if ("redirect" in result) {
      if (isBusy(result.redirect, "")) {
        return fail("28car 回應 msg_busy.php，已停止以免連續刷新", { blocked: true, busy: true }, secrets);
      }
      current = result.redirect;
      currentMethod = "GET";
      currentBody = undefined;
      continue;
    }
    return result;
  }
  return fail("重新導向過多", { blocked: true }, secrets);
}

function secretsFor(account: DealerAccount, lease: EgressLease): string[] {
  return [account.password, lease.proxyUrl];
}

export async function loginOnLease(
  lease: EgressLease,
  account: DealerAccount,
  login: LoginFormConfig
): Promise<{ ok: true; jar: CookieJar } | NetFail> {
  const jar = new CookieJar();
  const secrets = secretsFor(account, lease);
  const body = new URLSearchParams();
  body.set(login.usernameField, account.username);
  body.set(login.passwordField, account.password);
  for (const [key, value] of Object.entries(login.extraFields)) body.set(key, value);
  const result = await requestFollowing(lease, jar, login.url, "POST", {}, body.toString(), secrets);
  if (!result.ok) return result;
  const stillLogin = /<input\b[^>]*type=["']password["']/i.test(result.body) || /mbr_login\.php/i.test(result.url);
  if (stillLogin && !/登出/.test(result.body)) {
    return fail("登入未成功，已停止，唔會再試其他帳號", { loginRejected: true }, secrets);
  }
  return { ok: true, jar };
}

export async function get28carPage(lease: EgressLease, jar: CookieJar, account: DealerAccount, url: string): Promise<NetResult> {
  return requestFollowing(lease, jar, url, "GET", {}, undefined, secretsFor(account, lease));
}

export function buildOwnerReplyBody(form: ParsedReplyForm, vid: string, message: string): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form.hiddenFields)) {
    if (key === "h_mode" || key === "h_msg") continue;
    params.set(key, value);
  }
  params.set("h_mode", "add");
  params.set("h_vid", vid);
  params.set("h_type", "o");
  params.set("h_url_dsp_src", "/mbr_sell.php");
  params.set("h_t", form.hT);
  params.set("h_k", form.hK);
  params.set("h_msg", message);
  if (form.submitName && form.submitValue && /留言/.test(form.submitValue)) {
    params.set(form.submitName, form.submitValue);
  }
  return params;
}

export async function postOwnerReply(input: {
  lease: EgressLease;
  account: DealerAccount;
  login: LoginFormConfig;
  vid: string;
  message: string;
}): Promise<NetResult> {
  const loggedIn = await loginOnLease(input.lease, input.account, input.login);
  if (!loggedIn.ok) return loggedIn;
  const pageUrl = dealerListingUrl(input.vid);
  const page = await get28carPage(input.lease, loggedIn.jar, input.account, pageUrl);
  if (!page.ok) return page;
  const form = parseReplyForm(page.body);
  if (!form) {
    return fail("sell_dsp 未見到 form1 的 h_t／h_k，已拒絕 POST", {}, secretsFor(input.account, input.lease));
  }
  const action = new URL(form.action || "/sell_dsp.php", page.url);
  if (action.protocol !== "https:" || !is28carHost(action.hostname) || !action.pathname.toLowerCase().endsWith("/sell_dsp.php")) {
    return fail("留言表單 action 唔係 28car 的 sell_dsp.php", { blocked: true }, secretsFor(input.account, input.lease));
  }
  const params = buildOwnerReplyBody(form, input.vid, input.message);
  if (params.get("h_mode") !== "add" || params.get("h_type") !== "o") {
    return fail("留言表單組裝錯誤", {}, secretsFor(input.account, input.lease));
  }
  const posted = await requestFollowing(
    input.lease,
    loggedIn.jar,
    action.toString(),
    "POST",
    { referer: pageUrl },
    params.toString(),
    secretsFor(input.account, input.lease)
  );
  if (!posted.ok) return posted;
  if (/mbr_login\.php/i.test(posted.url) || (/請先登入/.test(posted.body) && !posted.body.includes(input.message))) {
    return fail("登入階段失效，留言未送出", { loginRejected: true }, secretsFor(input.account, input.lease));
  }
  if (/錯誤|失敗|太頻密/.test(posted.body) && !posted.body.includes(input.message)) {
    return fail("28car 未接受留言", {}, secretsFor(input.account, input.lease));
  }
  return posted;
}

export async function fetchSellList(input: {
  lease: EgressLease;
  account: DealerAccount;
  login: LoginFormConfig;
}): Promise<NetResult> {
  const loggedIn = await loginOnLease(input.lease, input.account, input.login);
  if (!loggedIn.ok) return loggedIn;
  return get28carPage(input.lease, loggedIn.jar, input.account, `${dealerOrigin()}/mbr_sell.php`);
}

export async function fetchListingBoard(input: {
  lease: EgressLease;
  account: DealerAccount;
  login: LoginFormConfig;
  vid: string;
}): Promise<NetResult> {
  const loggedIn = await loginOnLease(input.lease, input.account, input.login);
  if (!loggedIn.ok) return loggedIn;
  return get28carPage(input.lease, loggedIn.jar, input.account, dealerListingUrl(input.vid));
}
