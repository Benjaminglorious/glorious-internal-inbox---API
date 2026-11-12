import { simpleParser } from "mailparser";
import { cleanMessageId, normalizeEmailAddress } from "./email-address";

export interface ParsedInboundEmail {
  messageId: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  text: string;
  listUnsubscribe: boolean;
  autoSubmitted: boolean;
  bulk: boolean;
  references: string[];
  attachments: Array<{ filename: string; contentType: string; content: Buffer }>;
}

function headerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value && typeof value.text === "string") return value.text;
  return "";
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** 解析一封原始信。解析唔到就返回 null，呼叫方跳過呢封，唔阻塞之後嘅 UID。 */
export async function parseRawEmail(source: Buffer, fallbackId: string): Promise<ParsedInboundEmail | null> {
  if (!source.length) return null;
  const parsed = await simpleParser(source);
  const from = parsed.from?.value?.[0];
  const fromAddress = normalizeEmailAddress(from?.address ?? "") ?? "";
  const messageId = cleanMessageId(parsed.messageId) || cleanMessageId(fallbackId);
  if (!fromAddress || !messageId) return null;
  const text = (parsed.text ?? "").trim() || (typeof parsed.html === "string" ? htmlToText(parsed.html) : "");
  const references = (Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [])
    .map((item) => cleanMessageId(item))
    .filter(Boolean);
  const inReply = cleanMessageId(parsed.inReplyTo);
  if (inReply) references.push(inReply);
  const listUnsubscribe = headerText(parsed.headers.get("list-unsubscribe")).trim().length > 0;
  const autoHeader = headerText(parsed.headers.get("auto-submitted"));
  const precedence = headerText(parsed.headers.get("precedence")).toLowerCase();
  const attachments = (parsed.attachments ?? [])
    .filter((item) => Buffer.isBuffer(item.content) && item.content.length > 0)
    .slice(0, 12)
    .map((item) => ({
      filename: (item.filename || "attachment").replace(/[\r\n\u0000]/g, " ").trim().slice(0, 80) || "attachment",
      contentType: item.contentType || "application/octet-stream",
      content: item.content,
    }));
  return {
    messageId,
    fromAddress,
    fromName: (from?.name || "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, 120),
    subject: (parsed.subject || "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, 300),
    text: text.slice(0, 20000),
    listUnsubscribe,
    autoSubmitted: /auto-replied|auto-generated/i.test(autoHeader),
    bulk: precedence === "bulk" || precedence === "list" || precedence === "junk",
    references,
    attachments,
  };
}
