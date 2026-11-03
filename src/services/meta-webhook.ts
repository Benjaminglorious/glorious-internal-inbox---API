import type { UpsertSiteCommentInput } from "./site-comments";
import type { SiteCommentSource } from "./site-comments";
import type { MetaSurface } from "../types";

/**
 * 將 Meta Page／Instagram webhook JSON 拆成 upsertSiteComment 輸入。
 * 只處理認得嘅留言／私訊形狀；狀態回呼等會 ignored。
 * 公開留言記住 comment id；私訊記住 mid 同客戶 PSID／IGSID，出站先回得到。
 * META_PAGE_ID／META_IG_BUSINESS_ACCOUNT_ID 自己發出嘅事件唔入庫。
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

function actorId(record: Record<string, unknown> | null): string {
  if (!record) return "";
  return asString(record.id).trim();
}

/** 專頁或 IG 專業帳號自己嘅 webhook（通常係出站回覆嘅回聲）。 */
function isOwnMetaActor(id: string): boolean {
  const actor = id.trim();
  if (!actor) return false;
  const page = process.env.META_PAGE_ID?.trim() ?? "";
  const ig = process.env.META_IG_BUSINESS_ACCOUNT_ID?.trim() ?? "";
  return (page !== "" && actor === page) || (ig !== "" && actor === ig);
}

interface MetaPostBits {
  postId?: string | null;
  postPermalink?: string | null;
  postCaption?: string | null;
}

function pushItem(
  items: UpsertSiteCommentInput[],
  source: SiteCommentSource,
  externalId: string,
  authorName: string,
  body: string,
  meta?: { senderId?: string; surface?: MetaSurface } & MetaPostBits
): void {
  const id = externalId.trim();
  const text = body.trim();
  if (!id || !text) return;
  const senderId = (meta?.senderId ?? "").trim();
  const surface = meta?.surface ?? null;
  const onPost = surface === "comment";
  items.push({
    source,
    external_id: id.slice(0, 200),
    author_name: (authorName.trim() || "未知用戶").slice(0, 120),
    body: text.slice(0, 8000),
    meta_sender_id: senderId || null,
    meta_surface: surface,
    meta_post_id: onPost ? meta?.postId ?? null : null,
    meta_post_permalink: onPost ? meta?.postPermalink ?? null : null,
    meta_post_caption: onPost ? meta?.postCaption ?? null : null,
  });
}

/**
 * Facebook comment id 常常係 `{pageId}_{postId}_{commentId}`。
 * 有三段或以上數字時，帖文 id 係頭兩段。兩段唔猜，避免把 comment id 當成帖文。
 */
export function inferFacebookPostId(commentExternalId: string): string | null {
  const parts = commentExternalId.trim().split("_");
  if (parts.length < 3) return null;
  if (!parts.every((part) => /^\d{1,20}$/.test(part))) return null;
  if (parts[0].length < 5 || parts[1].length < 5) return null;
  return `${parts[0]}_${parts[1]}`;
}

function cleanWebhookPostId(value: string): string | null {
  const id = value.trim();
  if (!/^[0-9A-Za-z_.:-]{1,200}$/.test(id)) return null;
  return id;
}

function cleanWebhookUrl(value: string): string | null {
  const text = value.trim();
  if (!text || text.length > 500) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function cleanWebhookCaption(value: string): string | null {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, 500);
}

/** 由 feed／comments／media 物件抽出帖文編號、連結、內文。私訊唔經呢度。 */
function readParentPost(
  value: Record<string, unknown>,
  commentId: string,
  source: SiteCommentSource
): MetaPostBits {
  const post = asRecord(value.post);
  const media = asRecord(value.media);
  const explicit =
    cleanWebhookPostId(asString(value.post_id)) ||
    cleanWebhookPostId(asString(post?.id)) ||
    cleanWebhookPostId(asString(media?.id)) ||
    cleanWebhookPostId(asString(value.media_id));
  let postId = explicit;
  if (!postId && source === "facebook") {
    const parent = cleanWebhookPostId(asString(value.parent_id));
    if (parent && /^\d+_\d+$/.test(parent) && commentId.startsWith(`${parent}_`)) postId = parent;
    if (!postId) postId = inferFacebookPostId(commentId);
  }
  const permalink = cleanWebhookUrl(
    asString(post?.permalink_url) ||
      asString(post?.permalink) ||
      asString(media?.permalink) ||
      asString(value.permalink_url) ||
      asString(value.permalink)
  );
  const caption = cleanWebhookCaption(
    asString(post?.message) ||
      asString(post?.caption) ||
      asString(media?.caption) ||
      asString(post?.story) ||
      asString(value.caption)
  );
  return { postId, postPermalink: permalink, postCaption: caption };
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
  if (isOwnMetaActor(actorId(from))) return;
  pushItem(items, "facebook", commentId, fromName(from), message, {
    senderId: actorId(from),
    surface: "comment",
    ...readParentPost(value, commentId, "facebook"),
  });
}

/** Instagram comments field。 */
function parseIgCommentChange(value: Record<string, unknown>, items: UpsertSiteCommentInput[]): void {
  const commentId = asString(value.id) || asString(value.comment_id);
  const text = asString(value.text) || asString(value.message);
  const from = asRecord(value.from);
  if (isOwnMetaActor(actorId(from))) return;
  pushItem(items, "instagram", commentId, fromName(from), text, {
    senderId: actorId(from),
    surface: "comment",
    ...readParentPost(value, commentId, "instagram"),
  });
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
    const senderId = actorId(sender);
    if (isOwnMetaActor(senderId)) continue;
    const author = fromName(sender) || senderId;
    const externalId = mid || (senderId ? `msg:${senderId}:${text.slice(0, 40)}` : "");
    pushItem(items, source, externalId, author, text, { senderId, surface: "message" });
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
          if (isOwnMetaActor(actorId(from))) continue;
          pushItem(items, "facebook", commentId, fromName(from), text, {
            senderId: actorId(from),
            surface: "comment",
            ...readParentPost(value, commentId, "facebook"),
          });
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
