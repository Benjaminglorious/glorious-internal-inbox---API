import { isOriginSite, type OriginSite } from "./types";

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

function fromHost(url: string): OriginSite | null {
  const host = hostOf(url);
  if (!host) return null;
  if (hostIs(host, "instagram.com") || hostIs(host, "instagr.am")) return "instagram";
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
