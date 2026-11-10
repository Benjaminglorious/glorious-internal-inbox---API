import { DEFAULT_COMPANY_EMAIL, normalizeEmailAddress } from "./email-address";

/** 現有 web 進程輪詢。免費服務休眠期間唔會跑，喚醒後再補。 */
export const DEFAULT_EMAIL_POLL_MS = 120_000;
export const MIN_EMAIL_POLL_MS = 60_000;
export const MAX_EMAIL_POLL_MS = 15 * 60_000;
export const DEFAULT_EMAIL_LOOKBACK_DAYS = 14;
export const MAX_EMAILS_PER_POLL = 50;

export interface EmailOAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface EmailMailboxConfig {
  address: string;
  mode: "app_password" | "oauth";
  appPassword: string;
  oauth: EmailOAuthConfig | null;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  pollMs: number;
  lookbackDays: number;
}

export interface EmailIngestStatus {
  enabled: boolean;
  address: string;
  mode: "off" | "app_password" | "oauth";
  poll_ms: number | null;
  lookback_days: number;
}

function readInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function hostOf(raw: string | undefined, fallback: string): string {
  const host = (raw ?? "").trim().toLowerCase();
  if (!host || /[\s/@:]/.test(host) || host.includes("://")) return fallback;
  return host;
}

function oauthFromEnv(env: NodeJS.ProcessEnv): EmailOAuthConfig | null {
  const clientId = env.GLORIOUS_EMAIL_OAUTH_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GLORIOUS_EMAIL_OAUTH_CLIENT_SECRET?.trim() ?? "";
  const refreshToken = env.GLORIOUS_EMAIL_OAUTH_REFRESH_TOKEN?.trim() ?? "";
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

/** 畫面同預設寄件人。未設定憑證都返回公司郵箱，唔會因此去連 Gmail。 */
export function companyEmailAddress(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.GLORIOUS_EMAIL_ADDRESS?.trim() || DEFAULT_COMPANY_EMAIL;
  return normalizeEmailAddress(raw) ?? DEFAULT_COMPANY_EMAIL;
}

/**
 * 有應用程式密碼，或者三項 OAuth 都齊，先至啟用收信同回信。
 * 兩種都有時用應用程式密碼。地址留空就用 gloriousinformation@gmail.com。
 */
export function readEmailMailboxConfig(env: NodeJS.ProcessEnv = process.env): EmailMailboxConfig | null {
  const appPassword = (env.GLORIOUS_EMAIL_APP_PASSWORD ?? "").replace(/\s+/g, "");
  const oauth = oauthFromEnv(env);
  if (!appPassword && !oauth) return null;
  const address = normalizeEmailAddress(env.GLORIOUS_EMAIL_ADDRESS?.trim() || DEFAULT_COMPANY_EMAIL);
  if (!address) return null;
  const mode = appPassword ? "app_password" : "oauth";
  return {
    address,
    mode,
    appPassword,
    oauth: mode === "oauth" ? oauth : null,
    imapHost: hostOf(env.GLORIOUS_EMAIL_IMAP_HOST, "imap.gmail.com"),
    imapPort: readInt(env.GLORIOUS_EMAIL_IMAP_PORT, 993, 1, 65535),
    smtpHost: hostOf(env.GLORIOUS_EMAIL_SMTP_HOST, "smtp.gmail.com"),
    smtpPort: readInt(env.GLORIOUS_EMAIL_SMTP_PORT, 465, 1, 65535),
    pollMs: readInt(env.GLORIOUS_EMAIL_POLL_MS, DEFAULT_EMAIL_POLL_MS, MIN_EMAIL_POLL_MS, MAX_EMAIL_POLL_MS),
    lookbackDays: readInt(env.GLORIOUS_EMAIL_LOOKBACK_DAYS, DEFAULT_EMAIL_LOOKBACK_DAYS, 1, 90),
  };
}

export function emailIngestStatus(env: NodeJS.ProcessEnv = process.env): EmailIngestStatus {
  const cfg = readEmailMailboxConfig(env);
  if (!cfg) {
    return {
      enabled: false,
      address: companyEmailAddress(env),
      mode: "off",
      poll_ms: null,
      lookback_days: readInt(env.GLORIOUS_EMAIL_LOOKBACK_DAYS, DEFAULT_EMAIL_LOOKBACK_DAYS, 1, 90),
    };
  }
  return {
    enabled: true,
    address: cfg.address,
    mode: cfg.mode,
    poll_ms: cfg.pollMs,
    lookback_days: cfg.lookbackDays,
  };
}
