import type { UpsertSiteCommentInput } from "./site-comments";
import type { SiteCommentSource } from "./site-comments";

/**
 * 將 Meta Page／Instagram webhook JSON 拆成 upsertSiteComment 輸入。
 * 只處理認得嘅留言／私訊形狀；狀態回呼等會 ignored。
 * 出站 Graph API 仍然未接。
 */

export interface ParsedMetaWebhook {
  items: UpsertSiteCommentInput[];
  ignored: boolean;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function fromName(from: Record<string, unknown> | null): string {
  if (!from) return "";
  return (
    asString(from.name).trim() ||
    asString(from.username).trim() ||
    asString(from.id).trim()
  );
}

function pushItem(
  items: UpsertSiteCommentInput[],
  source: SiteCommentSource,
  externalId: string,
  authorName: string,
  body: string
): void {
  const id = externalId.trim();
  const text = body.trim();
  if (!id || !text) return;
  items.push({
    source,
    external_id: id.slice(0, 200),
    author_name: (authorName.trim() || "未知用戶").slice(0, 120),
    body: text.slice(0, 8000),
  });
}

/** Page feed comment（field=feed, item=comment）。 */
function parseFeedChange(value: Record<string, unknown>, items: UpsertSiteCommentInput[]): void {
  const item = asString(value.item).toLowerCase();
  const verb = asString(value.verb).toLowerCase();
  if (item !== "comment") return;
  if (verb && verb !== "add" && verb !== "edited") return;

  const commentId = asString(value.comment_id) || asString(value.commentId);
  const message = asString(value.message) || asString(value.text);
  const from = asRecord(value.from);
  pushItem(items, "facebook", commentId, fromName(from), message);
}

/** Instagram comments field。 */
function parseIgCommentChange(value: Record<string, unknown>, items: UpsertSiteCommentInput[]): void {
  const commentId = asString(value.id) || asString(value.comment_id);
  const text = asString(value.text) || asString(value.message);
  const from = asRecord(value.from);
  pushItem(items, "instagram", commentId, fromName(from), text);
}

/** Messenger / IG messaging（entry.messaging[]）。 */
function parseMessaging(
  messaging: unknown[],
  source: SiteCommentSource,
  items: UpsertSiteCommentInput[]
): void {
  for (const raw of messaging) {
    const event = asRecord(raw);
    if (!event) continue;
    if (event.message == null) continue;
    const message = asRecord(event.message);
    if (!message) continue;
    if (message.is_echo === true || message.is_echo === "true") continue;

    const mid = asString(message.mid) || asString(message.id);
    const text = asString(message.text);
    if (!text) continue;
    const sender = asRecord(event.sender);
    const author = fromName(sender) || asString(sender?.id);
    pushItem(items, source, mid || `msg:${asString(sender?.id)}:${text.slice(0, 40)}`, author, text);
  }
}

function parseEntry(entry: Record<string, unknown>, objectType: string, items: UpsertSiteCommentInput[]): void {
  const defaultDmSource: SiteCommentSource = objectType === "instagram" ? "instagram" : "facebook";

  for (const rawChange of asArray(entry.changes)) {
    const change = asRecord(rawChange);
    if (!change) continue;
    const field = asString(change.field).toLowerCase();
    const value = asRecord(change.value);
    if (!value) continue;

    if (field === "feed") {
      parseFeedChange(value, items);
      continue;
    }
    if (field === "comments" || field === "live_comments") {
      if (objectType === "instagram" || field === "comments") {
        // Page 亦可能用 comments；object=instagram 先標 IG，否則當 Facebook。
        if (objectType === "instagram") parseIgCommentChange(value, items);
        else {
          // Facebook comments field 形狀接近 IG
          const commentId = asString(value.id) || asString(value.comment_id);
          const text = asString(value.text) || asString(value.message);
          const from = asRecord(value.from);
          pushItem(items, "facebook", commentId, fromName(from), text);
        }
      }
      continue;
    }
  }

  parseMessaging(asArray(entry.messaging), defaultDmSource, items);
}

/**
 * 接受 Meta Graph webhook envelope（object=page|instagram）。
 * 空 body／純 statuses 會 ignored:true。
 */
export function parseMetaWebhookPayload(body: unknown): ParsedMetaWebhook {
  if (body == null) {
    return { items: [], ignored: true };
  }
  const root = asRecord(body);
  if (!root) {
    return { items: [], ignored: false, error: "payload 必須係 JSON 物件" };
  }

  const objectType = asString(root.object).toLowerCase();
  if (objectType && objectType !== "page" && objectType !== "instagram") {
    // 有機會係 WhatsApp Cloud 誤指過嚟；唔當 error，忽略。
    return { items: [], ignored: true };
  }

  const entries = asArray(root.entry);
  if (entries.length === 0) {
    return { items: [], ignored: true };
  }

  const items: UpsertSiteCommentInput[] = [];
  for (const rawEntry of entries) {
    const entry = asRecord(rawEntry);
    if (!entry) continue;
    parseEntry(entry, objectType || "page", items);
  }

  if (items.length === 0) {
    return { items: [], ignored: true };
  }
  return { items, ignored: false };
}
