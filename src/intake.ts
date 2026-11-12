import { isEntryPath, isOriginSite, type EntryPath, type OriginSite } from "./types";

const ORIGIN_ALIASES: Record<string, OriginSite> = {
  "28car": "28car",
  glorious_web: "glorious_web",
  facebook: "facebook",
  fb: "facebook",
  instagram: "instagram",
  ig: "instagram",
};

/**
 * 將 webhook／表單傳入嘅來源站正規化。
 * 空值係 null。`ig` 會收成 `instagram`。認唔到就係 "invalid"。
 */
export function normalizeOriginSite(value: unknown): OriginSite | null | "invalid" {
  if (value == null) return null;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  if (!trimmed) return null;
  const mapped = ORIGIN_ALIASES[trimmed.toLowerCase()];
  if (mapped) return mapped;
  if (isOriginSite(trimmed)) return trimmed;
  return "invalid";
}

function decodeRepeated(value: string): string {
  let current = value.replace(/\+/g, " ");
  for (let i = 0; i < 2; i += 1) {
    if (!current.includes("%")) break;
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

function queryParams(url: string): Map<string, string> {
  const map = new Map<string, string>();
  const q = url.indexOf("?");
  if (q < 0) return map;
  const query = url.slice(q + 1).split("#")[0];
  if (!query) return map;
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawVal = eq === -1 ? "" : part.slice(eq + 1);
    const key = decodeRepeated(rawKey).trim().toLowerCase();
    if (!key || map.has(key)) continue;
    map.set(key, decodeRepeated(rawVal).trim());
  }
  return map;
}

function hostOf(url: string): string {
  const stripped = url.split("#")[0].replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const host = stripped.split("/")[0]?.split("?")[0]?.split("@").pop() ?? "";
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** utm 優先於網域。glorious.hk?utm_source=ig 係 Instagram，唔係官網。 */
function fromUtm(url: string): OriginSite | null {
  const params = queryParams(url);
  const source = (params.get("utm_source") || "").toLowerCase();
  if (source === "ig" || source === "instagram") return "instagram";
  if (source === "fb" || source === "facebook") return "facebook";
  if (source === "28car") return "28car";
  if (source === "glorious" || source === "glorious_web" || source === "web") return "glorious_web";
  const content = (params.get("utm_content") || "").toLowerCase();
  if (content === "link_in_bio") return "instagram";
  return null;
}

function hostIsInstagram(host: string): boolean {
  if (
    hostIs(host, "instagram.com") ||
    hostIs(host, "instagr.am") ||
    hostIs(host, "cdninstagram.com") ||
    hostIs(host, "ig.me")
  ) {
    return true;
  }
  // Instagram CDN on Facebook's host, e.g. instagram.fabc-1.fna.fbcdn.net.
  return host.startsWith("instagram.") && host.endsWith(".fbcdn.net");
}

function fromHost(url: string): OriginSite | null {
  const host = hostOf(url);
  if (!host) return null;
  if (hostIsInstagram(host)) return "instagram";
  if (hostIs(host, "28car.com")) return "28car";
  if (hostIs(host, "facebook.com") || hostIs(host, "fb.com") || hostIs(host, "fb.me")) return "facebook";
  if (hostIs(host, "glorious.hk")) return "glorious_web";
  return null;
}

function candidates(url: string): string[] {
  const out = [url];
  const wrapped = queryParams(url).get("u");
  if (wrapped && wrapped !== url) out.push(wrapped);
  return out;
}

/**
 * 由 click-to-chat／簡介連結推斷 origin_site。
 * Instagram 簡介嘅 l.instagram.com 會展開 `u=`，目標通常係
 * `http://glorious.hk/?utm_source=ig&utm_medium=social&utm_content=link_in_bio`。
 * 有 utm_source=ig 就一定係 instagram，即使網域係 glorious.hk。
 */
export function originSiteFromUrl(url: string | null | undefined): OriginSite | null {
  if (!url) return null;
  const raw = url.trim().slice(0, 4000);
  if (!raw) return null;
  const urls = candidates(raw);
  for (const item of urls) {
    const utm = fromUtm(item);
    if (utm) return utm;
  }
  for (const item of urls) {
    const host = fromHost(item);
    if (host) return host;
  }
  return null;
}

/**
 * 客戶係由 28car 車輛頁／留言區撳 WhatsApp，定係只係行經 28car 首頁。
 * 留言區喺 sell_dsp.php（h_vid、h_vw、#msgbox）。公司 click-to-chat
 * `api.whatsapp.com/send?phone=85221740001` 官網同 Facebook 都用，單靠呢條 URL 唔當留言區。
 */
export function is28carListingBoardUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const raw = url.trim().toLowerCase();
  if (!raw) return false;
  const on28car = raw.includes("28car.com") || raw.includes("sell_dsp.php");
  if (!on28car) return false;
  return (
    raw.includes("sell_dsp.php") ||
    raw.includes("h_vid=") ||
    raw.includes("msgbox") ||
    raw.includes("h_vw=") ||
    raw.includes("h_f_bk=")
  );
}

/** 已確定 origin 係 28car，而且連結指向車輛留言頁，先至係留言區 WhatsApp。 */
export function infer28carWaLink(
  origin: OriginSite | null,
  referralUrl: string | null | undefined
): EntryPath | null {
  if (origin !== "28car") return null;
  return is28carListingBoardUrl(referralUrl) ? "28car_wa_link" : null;
}

export function resolveEntryPath(input: {
  explicit: unknown;
  inferred: EntryPath | null;
  channel: "whatsapp" | "site";
}): { ok: true; entryPath: EntryPath | null } | { ok: false; error: string } {
  const blank = input.explicit == null || input.explicit === "";
  if (blank) return { ok: true, entryPath: input.inferred };
  if (typeof input.explicit !== "string" || !isEntryPath(input.explicit.trim())) {
    return { ok: false, error: "entry_path 必須係 28car_board 或 28car_wa_link" };
  }
  const entry = input.explicit.trim() as EntryPath;
  if (input.channel === "whatsapp" && entry !== "28car_wa_link") {
    return { ok: false, error: "WhatsApp 入站只可以標 28car_wa_link" };
  }
  if (input.channel === "site" && entry !== "28car_board") {
    return { ok: false, error: "網站留言只可以標 28car_board" };
  }
  return { ok: true, entryPath: entry };
}

export function resolveOriginSite(
  explicit: unknown,
  referralUrl: string | null | undefined
): { ok: true; originSite: OriginSite | null } | { ok: false; error: string } {
  const normalized = normalizeOriginSite(explicit);
  if (normalized === "invalid") {
    return { ok: false, error: "origin_site 必須係 28car、glorious_web、facebook 或 instagram" };
  }
  if (normalized) return { ok: true, originSite: normalized };
  return { ok: true, originSite: originSiteFromUrl(referralUrl) };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return "";
}

const SOURCE_URL_KEYS = new Set(["sourceurl", "url", "permalink", "permalinkurl", "link"]);
const MEDIA_URL_KEYS = new Set(["imageurl", "videourl", "thumbnailurl", "mediaurl"]);
const PROSE_KEYS = new Set([
  "headline",
  "body",
  "text",
  "title",
  "description",
  "sourceid",
  "ctwaclid",
  "welcomemessage",
]);
const TYPE_KEYS = new Set(["sourcetype", "mediatype"]);

function normKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

/** `ad`／`post`／`image`／`video` 係 Cloud API 文件嘅通用值，唔代表平台。 */
function platformFromSourceType(value: string): OriginSite | null {
  const s = value.trim().toLowerCase();
  if (!s || s === "ad" || s === "post" || s === "image" || s === "video") return null;
  if (/(?:^|[^a-z0-9])instagram(?:[^a-z0-9]|$)/.test(s) || /(?:^|[^a-z0-9])ig(?:[^a-z0-9]|$)/.test(s)) {
    return "instagram";
  }
  if (/(?:^|[^a-z0-9])facebook(?:[^a-z0-9]|$)/.test(s) || /(?:^|[^a-z0-9])fb(?:[^a-z0-9]|$)/.test(s)) {
    return "facebook";
  }
  return null;
}

function mentionsHost(text: string, host: string): boolean {
  const escaped = host.replace(/\./g, "\\.");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:/|$|\\?|#|\\s)`, "i").test(text);
}

function originFromFreeText(text: string): OriginSite | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const direct = originSiteFromUrl(trimmed);
  if (direct) return direct;
  const embedded = trimmed.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
  for (const raw of embedded) {
    const origin = originSiteFromUrl(raw.replace(/[),.;]+$/g, ""));
    if (origin) return origin;
  }
  const lower = trimmed.toLowerCase();
  if (
    mentionsHost(lower, "instagram.com") ||
    mentionsHost(lower, "instagr.am") ||
    mentionsHost(lower, "cdninstagram.com") ||
    mentionsHost(lower, "ig.me") ||
    /instagram\.[a-z0-9.-]+\.fbcdn\.net(?:\/|$|\?|#|\s)/.test(lower) ||
    /(?:^|[?&#\s])utm_source=(?:ig|instagram)(?:&|#|\s|$)/.test(lower) ||
    /(?:^|[?&#\s])utm_content=link_in_bio(?:&|#|\s|$)/.test(lower)
  ) {
    return "instagram";
  }
  if (
    mentionsHost(lower, "facebook.com") ||
    mentionsHost(lower, "fb.com") ||
    mentionsHost(lower, "fb.me") ||
    /(?:^|[?&#\s])utm_source=(?:fb|facebook)(?:&|#|\s|$)/.test(lower)
  ) {
    return "facebook";
  }
  return null;
}

interface ReferralSignalBag {
  sourceUrls: string[];
  mediaUrls: string[];
  types: string[];
  prose: string[];
}

function collectReferralSignals(value: unknown, bag: ReferralSignalBag, depth: number): void {
  if (depth > 5 || value == null) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text) bag.prose.push(text);
    return;
  }
  const record = recordOf(value);
  if (!record) return;
  for (const [key, raw] of Object.entries(record)) {
    const norm = normKey(key);
    if (raw && typeof raw === "object") {
      collectReferralSignals(raw, bag, depth + 1);
      continue;
    }
    const text = textOf(raw);
    if (!text) continue;
    if (SOURCE_URL_KEYS.has(norm)) bag.sourceUrls.push(text);
    else if (MEDIA_URL_KEYS.has(norm)) bag.mediaUrls.push(text);
    else if (TYPE_KEYS.has(norm)) bag.types.push(text);
    else if (PROSE_KEYS.has(norm)) bag.prose.push(text);
  }
}

/**
 * 由 WhatsApp Cloud `messages[].referral`（同可選 `context`）推斷來源站。
 * `source_url` 優先（utm／網域，同 `originSiteFromUrl`）。跟住先至係
 * `source_type`／`media_type` 入面嘅 instagram／ig 或 facebook／fb。
 * 再睇 image／video URL、headline、body、welcome_message、source_id、ctwa_clid。
 * `source_type=ad|post`、`media_type=image|video`、單獨 `ctwa_clid` 都唔當平台。
 * 空 referral、或者完全冇 Instagram／Facebook 訊號，回 null（直接 WhatsApp）。
 * 唔好傳入客戶訊息正文：有機對話提到 IG 都唔可以標來源。
 * Instagram 主頁掣有時 Meta 根本唔附 referral，嗰陣亦會回 null。
 * 帖文／廣告身份（source_id、可開啟連結、headline）唔喺呢度留低，見 whatsapp.ts。
 */
export function originSiteFromReferralSignals(
  referral: unknown,
  context?: unknown
): OriginSite | null {
  const bag: ReferralSignalBag = { sourceUrls: [], mediaUrls: [], types: [], prose: [] };
  if (typeof referral === "string") {
    const origin = originFromFreeText(referral);
    if (origin) return origin;
  } else {
    collectReferralSignals(referral, bag, 0);
  }
  collectReferralSignals(context, bag, 0);

  for (const url of bag.sourceUrls) {
    const origin = originFromFreeText(url);
    if (origin) return origin;
  }
  for (const type of bag.types) {
    const origin = platformFromSourceType(type);
    if (origin) return origin;
  }
  for (const url of [...bag.mediaUrls, ...bag.prose]) {
    const origin = originFromFreeText(url);
    if (origin) return origin;
  }
  return null;
}
