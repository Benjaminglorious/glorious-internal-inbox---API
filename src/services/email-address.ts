import { createHash } from "crypto";

/** 公司郵箱。未設定 GLORIOUS_EMAIL_ADDRESS 時用呢個。 */
export const DEFAULT_COMPANY_EMAIL = "gloriousinformation@gmail.com";

const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

/** 收成小寫地址。唔接受顯示名以外嘅垃圾。 */
export function normalizeEmailAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.replace(/\u0000/g, "").trim().toLowerCase();
  if (!trimmed) return null;
  const angle = trimmed.match(/<([^<>\s]+)>/);
  const addr = (angle?.[1] ?? trimmed).trim();
  if (!EMAIL_RE.test(addr) || addr.length > 254) return null;
  return addr;
}

/** Message-ID 去掉角括號。太長就用雜湊，避免 external_id 撞截斷。 */
export function cleanMessageId(value: string | null | undefined): string {
  const raw = String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, "")
    .trim();
  if (!raw) return "";
  if (raw.length <= 500 && /^[\x21-\x7E]+$/.test(raw)) return raw;
  if (!raw) return "";
  return createHash("sha256").update(raw).digest("hex");
}

export function bracketMessageId(value: string | null | undefined): string {
  const id = cleanMessageId(value);
  return id ? `<${id}>` : "";
}

/** 保留最後 20 個，去重，唔帶角括號。 */
export function joinReferenceIds(existing: string | null | undefined, more: Array<string | null | undefined>): string {
  const ids: string[] = [];
  const parts = `${existing ?? ""} ${more.filter(Boolean).join(" ")}`.split(/\s+/);
  for (const part of parts) {
    const id = cleanMessageId(part);
    if (!id || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids.slice(-20).join(" ");
}

/** 回覆主旨只加一個 Re:。 */
export function bareEmailSubject(subject: string | null | undefined): string {
  let value = String(subject ?? "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (let guard = 0; guard < 6 && /^(re|fw|fwd)\s*:/i.test(value); guard += 1) {
    value = value.replace(/^(re|fw|fwd)\s*:\s*/i, "").trim();
  }
  return value.slice(0, 300);
}

export function replySubject(subject: string | null | undefined): string {
  const bare = bareEmailSubject(subject);
  return `Re: ${bare || "東榮汽車查詢"}`.slice(0, 320);
}
