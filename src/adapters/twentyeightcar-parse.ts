/**
 * 28car 賣車列表同留言板解析。
 * 留言欄只係數量。留言正文喺 sell_dsp.php 嘅 #msgbox。
 * 簡評唔係留言。class=msg_own 係賣家。form1 先至係留言；form2 的 h_mode=del 唔用。
 * 庫存編號 s2806213 同 h_vid 係兩個欄位。
 */
import { createHash } from "crypto";

export interface ParsedListing {
  stockId: string;
  vid: string | null;
  title: string;
  priceHkd: number | null;
  priceText: string | null;
  commentCount: number | null;
  listingUpdatedAt: string | null;
  year: string | null;
}

export interface ParsedBoardMessage {
  externalId: string;
  authorName: string;
  body: string;
  postedAt: string | null;
  isSeller: boolean;
}

export interface ParsedReplyForm {
  action: string;
  hVid: string | null;
  hT: string;
  hK: string;
  hUrlDspSrc: string;
  hiddenFields: Record<string, string>;
  submitName: string | null;
  submitValue: string | null;
}

export interface ParsedBoard {
  found: boolean;
  blurb: string | null;
  stockId: string | null;
  vid: string | null;
  messages: ParsedBoardMessage[];
  unparsed: boolean;
  replyForm: ParsedReplyForm | null;
}

const STOCK_RE = /\b(s\d{6,8})\b/i;
const VID_RE = /[?&]h_vid=(\d{5,12})\b/i;
const DATE_RE = /(20\d{2})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;
const PRICE_RE = /\$\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,9})/;

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, num: string) => {
      const code = Number(num);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attrsOf(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tag))) {
    const raw = match[3] ?? match[4] ?? match[5] ?? "";
    attrs[match[1].toLowerCase()] = decodeEntities(raw);
  }
  return attrs;
}

function extractById(html: string, id: string): string | null {
  const re = new RegExp(`<(div|table|section|tbody|ul)\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i");
  const found = re.exec(html);
  if (!found) return null;
  const tag = found[1].toLowerCase();
  let depth = 1;
  let index = found.index + found[0].length;
  const openRe = new RegExp(`<${tag}\\b`, "gi");
  const closeRe = new RegExp(`</${tag}>`, "gi");
  while (index < html.length && depth > 0) {
    openRe.lastIndex = index;
    closeRe.lastIndex = index;
    const open = openRe.exec(html);
    const close = closeRe.exec(html);
    if (!close) return html.slice(found.index + found[0].length);
    if (open && open.index < close.index) {
      depth += 1;
      index = open.index + open[0].length;
    } else {
      depth -= 1;
      if (depth === 0) return html.slice(found.index + found[0].length, close.index);
      index = close.index + close[0].length;
    }
  }
  return null;
}

interface HtmlForm {
  name: string;
  action: string;
  fields: Record<string, string>;
  submitName: string | null;
  submitValue: string | null;
  html: string;
}

function extractForms(html: string): HtmlForm[] {
  const forms: HtmlForm[] = [];
  const re = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const block = match[0];
    const open = /^<form\b[^>]*>/i.exec(block)?.[0] ?? "";
    const openAttrs = attrsOf(open);
    const fields: Record<string, string> = {};
    const inputRe = /<input\b[^>]*>/gi;
    let input: RegExpExecArray | null;
    while ((input = inputRe.exec(block))) {
      const attr = attrsOf(input[0]);
      const name = attr.name || "";
      if (!name) continue;
      const type = (attr.type || "").toLowerCase();
      if (type === "submit" || type === "button" || type === "image" || type === "password") continue;
      if (/pass|pwd/i.test(name)) continue;
      fields[name] = attr.value ?? "";
    }
    const areaRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
    let area: RegExpExecArray | null;
    while ((area = areaRe.exec(block))) {
      const attr = attrsOf(`<textarea ${area[1]}>`);
      if (attr.name) fields[attr.name] = decodeEntities(area[2] || "").trim();
    }
    let submitName: string | null = null;
    let submitValue: string | null = null;
    const buttonRe = /<(?:input|button)\b[^>]*>/gi;
    let button: RegExpExecArray | null;
    while ((button = buttonRe.exec(block))) {
      const attr = attrsOf(button[0]);
      const type = (attr.type || "").toLowerCase();
      const value = attr.value || stripTags(button[0]);
      if (type === "submit" || /留言/.test(value)) {
        if (/刪|del/i.test(value)) continue;
        submitName = attr.name || null;
        submitValue = attr.value || value;
        if (/留言/.test(submitValue)) break;
      }
    }
    forms.push({
      name: (openAttrs.name || openAttrs.id || "").toLowerCase(),
      action: openAttrs.action || "",
      fields,
      submitName,
      submitValue,
      html: block,
    });
  }
  return forms;
}

export function parseReplyForm(html: string): ParsedReplyForm | null {
  const forms = extractForms(html);
  const form =
    forms.find((item) => item.name === "form1" && (item.fields.h_mode || "").toLowerCase() === "add") ||
    forms.find((item) => item.name !== "form2" && (item.fields.h_mode || "").toLowerCase() === "add");
  if (!form) return null;
  const hT = (form.fields.h_t || "").trim();
  const hK = (form.fields.h_k || "").trim();
  if (!hT || !hK) return null;
  if (hT.length > 500 || hK.length > 500) return null;
  const hidden = { ...form.fields };
  delete hidden.h_msg;
  return {
    action: form.action || "/sell_dsp.php",
    hVid: /^\d{5,12}$/.test(form.fields.h_vid || "") ? form.fields.h_vid : null,
    hT,
    hK,
    hUrlDspSrc: form.fields.h_url_dsp_src || "/mbr_sell.php",
    hiddenFields: hidden,
    submitName: form.submitName,
    submitValue: form.submitValue,
  };
}

function fallbackMessageId(author: string, postedAt: string, body: string): string {
  const hex = createHash("sha256").update(`${author}\n${postedAt}\n${body}`).digest("hex").slice(0, 16);
  return `h${hex}`;
}

function messageIdFrom(chunk: string): string | null {
  const reply = /reply_msg\(\s*['"]?(\d{1,12})['"]?\s*\)/i.exec(chunk);
  if (reply) return reply[1];
  const idAttr = /\bid=["'](?:msg[-_]?)?(\d{1,12})["']/i.exec(chunk);
  if (idAttr) return idAttr[1];
  return null;
}

function classIsSeller(tag: string): boolean {
  const attr = attrsOf(tag);
  return /(^|\s)msg_own(\s|$)/i.test(attr.class || "");
}

function innerByClass(chunk: string, className: string): string | null {
  const re = new RegExp(`<(?:div|td|span)\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)</(?:div|td|span)>`, "i");
  const found = re.exec(chunk);
  return found ? stripTags(found[1]) : null;
}

function parseMessageChunk(chunk: string): ParsedBoardMessage | null {
  const open = /^<(tr|div|li)\b[^>]*>/i.exec(chunk)?.[0] ?? "";
  const isSeller = classIsSeller(open);
  const cells = [...chunk.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => stripTags(cell[1]));
  const postedMatch = DATE_RE.exec(stripTags(chunk));
  const postedAt = postedMatch ? postedMatch[0].replace("T", " ") : null;
  let author = innerByClass(chunk, "msg_author") || "";
  let body = innerByClass(chunk, "msg_body") || "";
  if (!body && cells.length) {
    const dated = cells.find((cell) => DATE_RE.test(cell)) || "";
    const rest = cells.filter((cell) => cell && cell !== dated);
    author = author || rest.find((cell) => cell.length <= 40) || (isSeller ? "賣家" : "");
    body = rest.sort((a, b) => b.length - a.length)[0] || "";
    if (body === author) body = rest.filter((cell) => cell !== author).join(" ");
  }
  body = body.replace(/回應此留言/g, "").replace(/\s+/g, " ").trim();
  if (!body || /免責聲明|確定留言前/.test(body)) return null;
  if (!author) author = isSeller ? "賣家" : "28car 留言";
  const externalId = messageIdFrom(chunk) || fallbackMessageId(author, postedAt || "", body);
  return {
    externalId,
    authorName: author.slice(0, 120),
    body: body.slice(0, 4000),
    postedAt,
    isSeller,
  };
}

function messageChunks(inner: string): string[] {
  const withoutForms = inner.replace(/<form\b[\s\S]*?<\/form>/gi, " ");
  const chunks: string[] = [];
  const re = /<(tr|div|li)\b([^>]*)>|<\/(tr|div|li)>/gi;
  const stack: Array<{ tag: string; start: number; className: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(withoutForms))) {
    if (match[1]) {
      const attr = attrsOf(`<${match[1]} ${match[2]}>`);
      stack.push({ tag: match[1].toLowerCase(), start: match.index, className: attr.class || "" });
      continue;
    }
    const closing = (match[3] || "").toLowerCase();
    const top = stack[stack.length - 1];
    if (!top || top.tag !== closing) continue;
    stack.pop();
    const parentHasMsg = stack.some((item) => /(^|\s)msg_/i.test(item.className));
    if (!parentHasMsg && /(^|\s)msg_/i.test(top.className)) {
      chunks.push(withoutForms.slice(top.start, re.lastIndex));
    }
  }
  return chunks;
}

export function parseBlurb(html: string): string | null {
  const byId = extractById(html, "brief");
  if (byId) {
    const text = stripTags(byId).replace(/^簡評\s*/, "").trim();
    return text ? text.slice(0, 2000) : null;
  }
  const match = /簡評\s*<\/[^>]+>\s*([\s\S]{0,1800}?)(?=<[^>]+id=["']msgbox["']|<form\b|$)/i.exec(html);
  if (!match) return null;
  const text = stripTags(match[1]).trim();
  return text ? text.slice(0, 2000) : null;
}

export function parseBoardHtml(html: string): ParsedBoard {
  const stock = STOCK_RE.exec(html);
  const vid = VID_RE.exec(html.replace(/&amp;/gi, "&"));
  const msgbox = extractById(html, "msgbox");
  const replyForm = parseReplyForm(html);
  const blurb = parseBlurb(html);
  if (!msgbox) {
    return {
      found: false,
      blurb,
      stockId: stock ? stock[1].toLowerCase() : null,
      vid: vid ? vid[1] : replyForm?.hVid ?? null,
      messages: [],
      unparsed: false,
      replyForm,
    };
  }
  const messages = messageChunks(msgbox)
    .map((chunk) => parseMessageChunk(chunk))
    .filter((item): item is ParsedBoardMessage => !!item);
  const plain = stripTags(msgbox.replace(/<form\b[\s\S]*?<\/form>/gi, " "));
  const unparsed = messages.length === 0 && plain.length > 80;
  return {
    found: true,
    blurb,
    stockId: stock ? stock[1].toLowerCase() : null,
    vid: vid ? vid[1] : replyForm?.hVid ?? null,
    messages,
    unparsed,
    replyForm,
  };
}

function rowsOf(html: string): string[][] {
  return [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map((row) =>
    [...row[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cell[1])
  );
}

function headerIndex(headers: string[], names: string[]): number {
  return headers.findIndex((header) => names.some((name) => header.includes(name)));
}

export function parseSellListHtml(html: string): ParsedListing[] {
  const rows = rowsOf(html);
  let headers: string[] = [];
  const listings: ParsedListing[] = [];
  const seen = new Set<string>();
  for (const cells of rows) {
    const texts = cells.map((cell) => stripTags(cell));
    const joined = texts.join(" ");
    if (!headers.length && joined.includes("留言") && (joined.includes("售價") || joined.includes("價錢"))) {
      headers = texts;
      continue;
    }
    const hrefBlob = cells.join(" ").replace(/&amp;/gi, "&");
    const stockMatch = STOCK_RE.exec(hrefBlob) || STOCK_RE.exec(joined);
    if (!stockMatch) continue;
    const stockId = stockMatch[1].toLowerCase();
    if (seen.has(stockId)) continue;
    seen.add(stockId);
    const vidMatch = VID_RE.exec(hrefBlob);
    const priceIndex = headerIndex(headers, ["售價", "價錢", "價格"]);
    const commentIndex = headerIndex(headers, ["留言"]);
    const dateIndex = headerIndex(headers, ["更新", "日期"]);
    const yearIndex = headerIndex(headers, ["年份"]);
    const priceSource = priceIndex >= 0 ? texts[priceIndex] || "" : joined;
    const priceMatch = PRICE_RE.exec(priceSource) || PRICE_RE.exec(joined);
    const priceText = priceMatch ? `$${priceMatch[1]}` : null;
    const priceHkd = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : null;
    let commentCount: number | null = null;
    if (commentIndex >= 0 && /^\d{1,4}$/.test(texts[commentIndex] || "")) {
      commentCount = Number(texts[commentIndex]);
    }
    const dateSource = dateIndex >= 0 ? texts[dateIndex] || "" : joined;
    const dateMatch = DATE_RE.exec(dateSource);
    const listingUpdatedAt = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null;
    const year = yearIndex >= 0 && /^(19|20)\d{2}$/.test(texts[yearIndex] || "") ? texts[yearIndex] : null;
    const anchor = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(cells.find((cell) => /<a\b/i.test(cell)) || "");
    let title = anchor ? stripTags(anchor[1]) : texts.find((text) => /[\u3400-\u9fffA-Za-z]/.test(text) && !STOCK_RE.test(text)) || "";
    title = title.replace(STOCK_RE, "").trim();
    if (year && !title.includes(year)) title = `${title} ${year}`.trim();
    if (!title) title = stockId;
    listings.push({
      stockId,
      vid: vidMatch ? vidMatch[1] : null,
      title: title.slice(0, 160),
      priceHkd: priceHkd != null && Number.isFinite(priceHkd) ? priceHkd : null,
      priceText,
      commentCount,
      listingUpdatedAt,
      year,
    });
  }
  return listings;
}

export function declaresLegacyCharset(html: string, contentType: string | null): boolean {
  const type = (contentType || "").toLowerCase();
  if (type.includes("big5") || type.includes("gbk") || type.includes("gb2312")) return true;
  return /charset\s*=\s*["']?(big5|gbk|gb2312)/i.test(html.slice(0, 2500));
}
