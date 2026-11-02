/** 公司總機號碼（只保留數字）。入站線路同預設 click-to-chat 都用呢個。 */
export const COMPANY_WHATSAPP_PHONE = "85221740001";
export const COMPANY_WHATSAPP_LABEL = "東榮總機";

/** 28car／glorious.hk／Facebook 用緊嘅公司 WhatsApp click-to-chat。 */
export const DEFAULT_COMPANY_WHATSAPP_URL =
  `https://api.whatsapp.com/send?phone=${COMPANY_WHATSAPP_PHONE}`;

/** 讀 COMPANY_WHATSAPP_URL；空白或未設定時用上面預設。 */
export function companyWhatsAppUrl(): string {
  const raw = process.env.COMPANY_WHATSAPP_URL?.trim();
  return raw ? raw : DEFAULT_COMPANY_WHATSAPP_URL;
}

/**
 * 公司總機 85221740001 嘅 WhatsApp Cloud API phone number id。
 * 唔係密鑰。未設定 WHATSAPP_PHONE_NUMBER_ID 時用呢個生產值。
 */
export const DEFAULT_WHATSAPP_PHONE_NUMBER_ID = "241163761376752";
export const DEFAULT_WHATSAPP_GRAPH_VERSION = "v21.0";

export type WhatsAppCloudSettings =
  | { ok: true; phoneNumberId: string; accessToken: string; messagesUrl: string }
  | { ok: false; error: string };

/** 公司線出站要用嘅 Graph 設定。Token 只從環境變數讀，唔會有預設密鑰。 */
export function whatsAppCloudSettings(): WhatsAppCloudSettings {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim() ?? "";
  if (!accessToken) {
    return { ok: false, error: "WHATSAPP_ACCESS_TOKEN 未設定，公司 WhatsApp 回覆未發送" };
  }

  const idRaw = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "";
  const phoneNumberId = idRaw || DEFAULT_WHATSAPP_PHONE_NUMBER_ID;
  if (!/^\d{6,20}$/.test(phoneNumberId)) {
    return { ok: false, error: "WHATSAPP_PHONE_NUMBER_ID 格式不正確，公司 WhatsApp 回覆未發送" };
  }

  const versionRaw = process.env.WHATSAPP_GRAPH_VERSION?.trim() ?? "";
  const version = versionRaw || DEFAULT_WHATSAPP_GRAPH_VERSION;
  if (!/^v\d+\.\d+$/.test(version)) {
    return { ok: false, error: "WHATSAPP_GRAPH_VERSION 格式不正確，公司 WhatsApp 回覆未發送" };
  }

  return {
    ok: true,
    phoneNumberId,
    accessToken,
    messagesUrl: `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
  };
}

/**
 * Facebook Page／Instagram 出站用嘅 Graph 版本。
 * 同 WhatsApp 分開：唔好讀 WHATSAPP_GRAPH_VERSION，亦唔好用 Page token 發 WhatsApp。
 */
export const DEFAULT_META_GRAPH_VERSION = "v21.0";

export type MetaGraphVersionResult = { ok: true; version: string } | { ok: false; error: string };

/** Page／IG 出站版本。未設定 META_GRAPH_VERSION 時用 v21.0。格式錯就唔打網絡。 */
export function metaGraphVersion(): MetaGraphVersionResult {
  const versionRaw = process.env.META_GRAPH_VERSION?.trim() ?? "";
  const version = versionRaw || DEFAULT_META_GRAPH_VERSION;
  if (!/^v\d+\.\d+$/.test(version)) {
    return { ok: false, error: "META_GRAPH_VERSION 格式不正確，Facebook／Instagram 回覆未發送" };
  }
  return { ok: true, version };
}

/** Page access token。空白即未設定。唔會有預設密鑰。 */
export function metaPageAccessToken(): string {
  return process.env.META_PAGE_ACCESS_TOKEN?.trim() ?? "";
}

/** 專頁 id。私訊發送先需要。空白即未設定。 */
export function metaPageId(): string {
  return process.env.META_PAGE_ID?.trim() ?? "";
}

/** 連住專頁嘅 IG 專業帳號 id。用來認自己嘅 webhook，唔係私訊 URL。 */
export function metaIgBusinessAccountId(): string {
  return process.env.META_IG_BUSINESS_ACCOUNT_ID?.trim() ?? "";
}

const SNIPPET_MAX = 80;

export function commentSnippet(body: string | null | undefined, max = SNIPPET_MAX): string {
  if (!body) return "";
  const compact = body.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}…`;
}

export interface WhatsAppLinkContext {
  sourceLabel?: string | null;
  vehicleRef?: string | null;
  body?: string | null;
}

function withWhatsAppPrefill(base: string, ctx?: WhatsAppLinkContext): string {
  if (!ctx) return base;

  const lines: string[] = [];
  const source = ctx.sourceLabel?.trim();
  const vehicle = ctx.vehicleRef?.trim();
  const snippet = commentSnippet(ctx.body);
  if (source) lines.push(`來源：${source}`);
  if (vehicle) lines.push(`車輛：${vehicle}`);
  if (snippet) lines.push(`留言：${snippet}`);
  if (lines.length === 0) return base;

  const joiner = base.includes("?") ? "&" : "?";
  return `${base}${joiner}text=${encodeURIComponent(lines.join("\n"))}`;
}

/**
 * 公司 click-to-chat 連結。有來源／車輛／留言摘要時以 text= 預填（encodeURIComponent）。
 * 只組 URL，唔會呼叫 WhatsApp。
 */
export function companyWhatsAppChatUrl(ctx?: WhatsAppLinkContext): string {
  return withWhatsAppPrefill(companyWhatsAppUrl(), ctx);
}

/** 任意號碼嘅 click-to-chat（同事個人線路）。只組 URL，唔會呼叫 WhatsApp。 */
export function whatsAppSendUrl(phoneDigits: string, ctx?: WhatsAppLinkContext): string {
  return withWhatsAppPrefill(`https://api.whatsapp.com/send?phone=${phoneDigits}`, ctx);
}
