/**
 * 28car 多帳號同出口設定。密碼同代理網址只會留喺環境變數，唔寫入資料庫或 log。
 * 即時網絡預設關閉。未有可輪換代理時，即使開咗旗標都唔會直連。
 */

export const MAX_TWENTYEIGHTCAR_ACCOUNTS = 10;
export const DEFAULT_DEALER_ORIGIN = "https://org.28car.com";
export const DEFAULT_PUBLIC_ORIGIN = "https://www.28car.com";
const DEFAULT_GAP_MS = 2500;
const MIN_GAP_MS = 1000;
const MAX_GAP_MS = 120_000;

export interface DealerAccount {
  username: string;
  password: string;
  displayName: string | null;
}

export interface LoginFormConfig {
  url: string;
  usernameField: string;
  passwordField: string;
  extraFields: Record<string, string>;
}

export interface EgressConfig {
  mode: "off" | "list" | "session_template";
  /** 已通過檢查嘅代理 URL。呼叫方唔好寫入 log。 */
  proxies: string[];
  template: string | null;
  canRotate: boolean;
  proxyCount: number;
  error: string | null;
}

export interface TwentyeightcarPublicStatus {
  account_count: number;
  accounts_truncated: boolean;
  usernames: string[];
  sync_enabled: boolean;
  reply_post_enabled: boolean;
  login_form_configured: boolean;
  egress_mode: EgressConfig["mode"];
  egress_ready: boolean;
  proxy_count: number;
  request_gap_ms: number;
  max_detail_fetches: number;
  max_accounts_per_run: number;
  dealer_origin: string;
  public_origin: string;
  config_error: string | null;
}

export function flagEnabled(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export function syncEnabled(): boolean {
  return flagEnabled("TWENTYEIGHT_CAR_SYNC_ENABLED");
}

export function replyPostEnabled(): boolean {
  return flagEnabled("TWENTYEIGHT_CAR_REPLY_POST_ENABLED");
}

export function requestGapMs(): number {
  const raw = Number(process.env.TWENTYEIGHT_CAR_REQUEST_GAP_MS ?? "");
  if (!Number.isFinite(raw)) return DEFAULT_GAP_MS;
  return Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, Math.floor(raw)));
}

export function maxDetailFetches(): number {
  const raw = Number(process.env.TWENTYEIGHT_CAR_MAX_DETAIL_FETCHES ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return 8;
  return Math.min(40, Math.max(1, Math.floor(raw)));
}

export function maxAccountsPerRun(): number {
  const raw = Number(process.env.TWENTYEIGHT_CAR_MAX_ACCOUNTS_PER_RUN ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return MAX_TWENTYEIGHTCAR_ACCOUNTS;
  return Math.min(MAX_TWENTYEIGHTCAR_ACCOUNTS, Math.max(1, Math.floor(raw)));
}

export function is28carHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "28car.com" || host.endsWith(".28car.com");
}

export function https28carOrigin(raw: string | undefined, fallback: string): string {
  const value = (raw ?? "").trim() || fallback;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !is28carHost(url.hostname)) return fallback;
    return url.origin;
  } catch {
    return fallback;
  }
}

export function dealerOrigin(): string {
  return https28carOrigin(process.env.TWENTYEIGHT_CAR_DEALER_ORIGIN, DEFAULT_DEALER_ORIGIN);
}

export function publicOrigin(): string {
  return https28carOrigin(process.env.TWENTYEIGHT_CAR_PUBLIC_ORIGIN, DEFAULT_PUBLIC_ORIGIN);
}

export function publicListingUrl(vid: string): string {
  const url = new URL("/sell_dsp.php", publicOrigin());
  url.searchParams.set("h_vid", vid);
  url.searchParams.set("h_vw", "y");
  return url.toString();
}

export function dealerListingUrl(vid: string): string {
  const url = new URL("/sell_dsp.php", dealerOrigin());
  url.searchParams.set("h_vid", vid);
  url.searchParams.set("h_url_dsp_src", "/mbr_sell.php");
  url.searchParams.set("h_vw", "1");
  url.searchParams.set("h_f_bk", "y");
  return url.toString();
}

function placeholderField(value: string): boolean {
  const token = value.trim().toLowerCase();
  return !token || token.includes("confirm_me") || token.includes("replace");
}

/**
 * org.28car.com/mbr_login.php form1。
 * h_username、h_password、h_mode=login、h_url_login_src、h_url_src。登入頁冇 h_t／h_k。
 * 未設定 TWENTYEIGHT_CAR_LOGIN_FORM_JSON 時用呢組。即時 POST 仍然要旗標同可輪換代理。
 */
export const DEFAULT_LOGIN_FORM: LoginFormConfig = {
  url: "https://org.28car.com/mbr_login.php",
  usernameField: "h_username",
  passwordField: "h_password",
  extraFields: {
    h_mode: "login",
    h_url_login_src: "",
    h_url_src: "",
  },
};

function copyLoginForm(form: LoginFormConfig): LoginFormConfig {
  return { ...form, extraFields: { ...form.extraFields } };
}

export function readLoginForm(): LoginFormConfig | null {
  const raw = (process.env.TWENTYEIGHT_CAR_LOGIN_FORM_JSON ?? "").trim();
  if (!raw) return copyLoginForm(DEFAULT_LOGIN_FORM);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const urlRaw = typeof record.url === "string" ? record.url.trim() : DEFAULT_LOGIN_FORM.url;
  const usernameField =
    typeof record.username_field === "string" && record.username_field.trim()
      ? record.username_field.trim()
      : DEFAULT_LOGIN_FORM.usernameField;
  const passwordField =
    typeof record.password_field === "string" && record.password_field.trim()
      ? record.password_field.trim()
      : DEFAULT_LOGIN_FORM.passwordField;
  if (placeholderField(usernameField) || placeholderField(passwordField)) return null;
  if (!/^[A-Za-z0-9_]+$/.test(usernameField) || !/^[A-Za-z0-9_]+$/.test(passwordField)) return null;
  let url: URL;
  try {
    url = new URL(urlRaw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !is28carHost(url.hostname)) return null;
  const extra: Record<string, string> = { ...DEFAULT_LOGIN_FORM.extraFields };
  const extraRaw = record.extra_fields;
  if (extraRaw && typeof extraRaw === "object" && !Array.isArray(extraRaw)) {
    for (const [key, value] of Object.entries(extraRaw)) {
      if (!/^[A-Za-z0-9_]+$/.test(key) || key.length > 40) continue;
      if (/pass|pwd/i.test(key)) continue;
      if (typeof value !== "string" || value.length > 200) continue;
      extra[key] = value;
    }
  }
  return { url: url.toString(), usernameField, passwordField, extraFields: extra };
}

function acceptProxyUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return trimmed;
}

function parseProxyList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => (typeof item === "string" ? acceptProxyUrl(item) : null))
        .filter((item): item is string => !!item);
    } catch {
      return [];
    }
  }
  return trimmed
    .split(/[\s,]+/)
    .map((item) => acceptProxyUrl(item))
    .filter((item): item is string => !!item);
}

export function readEgress(): EgressConfig {
  const list = parseProxyList(process.env.TWENTYEIGHT_CAR_PROXY_URLS ?? "");
  const singleRaw = (process.env.TWENTYEIGHT_CAR_PROXY_URL ?? "").trim();
  const single = singleRaw ? acceptProxyUrl(singleRaw.replaceAll("{session}", "probe")) : null;
  const template = singleRaw.includes("{session}") && single ? singleRaw : null;

  if (list.length >= 2) {
    return {
      mode: "list",
      proxies: list.slice(0, 50),
      template: null,
      canRotate: true,
      proxyCount: Math.min(list.length, 50),
      error: null,
    };
  }
  if (template) {
    return {
      mode: "session_template",
      proxies: [],
      template,
      canRotate: true,
      proxyCount: 1,
      error: null,
    };
  }
  const mentioned = list.length > 0 || !!singleRaw;
  return {
    mode: "off",
    proxies: [],
    template: null,
    canRotate: false,
    proxyCount: list.length,
    error: mentioned
      ? "代理未夠輪換。要至少兩個 http(s) 代理，或者一個含 {session} 的 TWENTYEIGHT_CAR_PROXY_URL。未設定前唔會直連 28car。"
      : null,
  };
}

export function readAccounts(): {
  accounts: DealerAccount[];
  truncated: boolean;
  error: string | null;
} {
  const raw = (process.env.TWENTYEIGHT_CAR_ACCOUNTS_JSON ?? "").trim();
  if (!raw) return { accounts: [], truncated: false, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { accounts: [], truncated: false, error: "TWENTYEIGHT_CAR_ACCOUNTS_JSON 唔係有效 JSON" };
  }
  if (!Array.isArray(parsed)) {
    return { accounts: [], truncated: false, error: "TWENTYEIGHT_CAR_ACCOUNTS_JSON 必須係陣列" };
  }
  const accounts: DealerAccount[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const username = typeof record.username === "string" ? record.username.trim().toLowerCase() : "";
    const password = typeof record.password === "string" ? record.password : "";
    const displayName =
      typeof record.display_name === "string" && record.display_name.trim()
        ? record.display_name.trim().slice(0, 80)
        : null;
    if (!username.includes("@") || username.length > 120) continue;
    if (!password || password.length > 200) continue;
    accounts.push({ username, password, displayName });
    if (accounts.length === MAX_TWENTYEIGHTCAR_ACCOUNTS) break;
  }
  return {
    accounts,
    truncated: parsed.length > MAX_TWENTYEIGHTCAR_ACCOUNTS,
    error: accounts.length === 0 ? "TWENTYEIGHT_CAR_ACCOUNTS_JSON 冇有效帳號" : null,
  };
}

export function accountByUsername(username: string): DealerAccount | null {
  const wanted = username.trim().toLowerCase();
  return readAccounts().accounts.find((account) => account.username === wanted) ?? null;
}

export function twentyeightcarStatus(includeUsernames: boolean): TwentyeightcarPublicStatus {
  const accounts = readAccounts();
  const egress = readEgress();
  const errors = [accounts.error, egress.error].filter((item): item is string => !!item);
  return {
    account_count: accounts.accounts.length,
    accounts_truncated: accounts.truncated,
    usernames: includeUsernames ? accounts.accounts.map((account) => account.username) : [],
    sync_enabled: syncEnabled(),
    reply_post_enabled: replyPostEnabled(),
    login_form_configured: readLoginForm() != null,
    egress_mode: egress.mode,
    egress_ready: egress.canRotate,
    proxy_count: egress.mode === "session_template" ? 1 : egress.proxyCount,
    request_gap_ms: requestGapMs(),
    max_detail_fetches: maxDetailFetches(),
    max_accounts_per_run: maxAccountsPerRun(),
    dealer_origin: dealerOrigin(),
    public_origin: publicOrigin(),
    config_error: errors[0] ?? null,
  };
}

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  for (const proxy of [...readEgress().proxies, readEgress().template ?? ""]) {
    if (!proxy) continue;
    out = out.split(proxy).join("[proxy]");
    try {
      const url = new URL(proxy.replaceAll("{session}", "x"));
      if (url.password) out = out.split(decodeURIComponent(url.password)).join("[redacted]");
    } catch {
      // 代理 URL 解析唔到就只替走原字串。
    }
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 400);
}
