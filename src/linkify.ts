/**
 * 顯示訊息時先跳脫 HTML，再把 http(s) 網址包成新分頁連結。
 * 唔改資料庫原文。javascript:、data: 同其他 scheme 唔會變連結。
 */

const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&()*+,;=%]+/gi;
const TRAILING_PUNCT = new Set([".", ",", ";", ":", "!", "?"]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function countChar(value: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === ch) n += 1;
  }
  return n;
}

function schemeLength(value: string): number {
  return value.slice(0, 8).toLowerCase() === "https://" ? 8 : 7;
}

/** 收短一個 regex 配對：去掉句尾標點、未配對嘅右括號，以及逗號後緊貼嘅下一個網址。 */
function trimUrl(raw: string): string {
  const scheme = schemeLength(raw);
  let end = raw.length;
  const embedded = /[.,;:!?)(]https?:\/\//i.exec(raw.slice(scheme));
  if (embedded && embedded.index != null) end = scheme + embedded.index;
  while (end > scheme) {
    const ch = raw[end - 1];
    if (TRAILING_PUNCT.has(ch)) {
      end -= 1;
      continue;
    }
    if (ch === ")") {
      const slice = raw.slice(0, end);
      if (countChar(slice, ")") > countChar(slice, "(")) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return raw.slice(0, end);
}

function isLinkableHttpUrl(value: string): boolean {
  if (value.length < "http://a".length) return false;
  const head = value.slice(0, 8).toLowerCase();
  if (!head.startsWith("http://") && !head.startsWith("https://")) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function hasSchemeBoundary(text: string, index: number): boolean {
  if (index <= 0) return true;
  return !/[A-Za-z0-9]/.test(text[index - 1] ?? "");
}

function anchor(url: string): string {
  const safe = escapeHtml(url);
  return `<a class="msg-link" href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>`;
}

/**
 * 列表預覽。普通字仍然喺 max 切斷。
 * 切斷點如果喺網址中間，就盡量包含成個網址，避免半截網址變成錯誤連結。
 */
export function clipMessagePreview(text: string, max = 80): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const partial = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&()*+,;=%]*$/i.exec(head);
  if (partial && partial.index != null && partial[0].length > "http://".length) {
    const rest = text.slice(partial.index);
    const full = /^https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&()*+,;=%]+/i.exec(rest);
    if (full && full[0].length > partial[0].length) {
      const fullEnd = partial.index + full[0].length;
      if (fullEnd <= max + 180) {
        if (fullEnd >= text.length) return text;
        return `${text.slice(0, fullEnd)}…`;
      }
      const before = text.slice(0, partial.index).replace(/\s+$/u, "");
      if (before) return `${before}…`;
    }
  }
  return `${head}…`;
}

/** 將純文字訊息轉成可顯示嘅 HTML。呼叫方傳原文，唔好傳已經跳脫嘅字串。 */
export function linkifyMessageHtml(text: string): string {
  if (!text) return "";
  const re = new RegExp(URL_RE.source, "gi");
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (!hasSchemeBoundary(text, match.index)) {
      re.lastIndex = match.index + 1;
      continue;
    }
    const url = trimUrl(match[0]);
    if (!isLinkableHttpUrl(url)) {
      const next = match.index + schemeLength(match[0]);
      re.lastIndex = next > match.index ? next : match.index + 1;
      continue;
    }
    const end = match.index + url.length;
    out += escapeHtml(text.slice(last, match.index));
    out += anchor(url);
    last = end;
    re.lastIndex = end;
  }
  out += escapeHtml(text.slice(last));
  return out;
}
