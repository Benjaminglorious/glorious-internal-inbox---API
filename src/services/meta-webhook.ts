import type { UpsertSiteCommentInput } from "./site-comments";
import type { SiteCommentSource } from "./site-comments";
import type { MetaSurface } from "../types";
import { placeholderFor, type MediaKind } from "./media";

/**
 * 將 Meta Page／Instagram webhook JSON 拆成 upsertSiteComment 輸入。
 * 只處理認得嘅留言／私訊形狀；狀態回呼等會 ignored。
 * 公開留言記住 comment id；私訊記住 mid 同客戶 PSID／IGSID，出站先回得到。
 * 由帖文、限時動態或廣告開啟嘅私訊，另外記住 meta_post_*。客戶訊息正文唔會當成帖文。
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
  attachments?: UpsertSiteCommentInput["attachments"];
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
  const keepPost = surface === "comment" || surface === "message";
  items.push({
    source,
    external_id: id.slice(0, 200),
    author_name: (authorName.trim() || "未知用戶").slice(0, 120),
    body: text.slice(0, 8000),
    meta_sender_id: senderId || null,
    meta_surface: surface,
    meta_post_id: keepPost ? meta?.postId ?? null : null,
    meta_post_permalink: keepPost ? meta?.postPermalink ?? null : null,
    meta_post_caption: keepPost ? meta?.postCaption ?? null : null,
    attachments: meta?.attachments,
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

/** 由 feed／comments／media 物件抽出帖文編號、連結、內文。私訊 referral 唔經呢度。 */
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
  const photo = asString(value.photo).trim();
  const body = message.trim() || (photo ? placeholderFor("image", false) : "");
  const from = asRecord(value.from);
  if (isOwnMetaActor(actorId(from))) return;
  pushItem(items, "facebook", commentId, fromName(from), body, {
    senderId: actorId(from),
    surface: "comment",
    ...readParentPost(value, commentId, "facebook"),
    attachments: photo ? [{ kind: "image", url: photo, isVoice: false }] : undefined,
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

function readDmAttachments(message: Record<string, unknown>): NonNullable<UpsertSiteCommentInput["attachments"]> {
  const out: NonNullable<UpsertSiteCommentInput["attachments"]> = [];
  for (const raw of asArray(message.attachments)) {
    const attachment = asRecord(raw);
    if (!attachment) continue;
    const type = asString(attachment.type).toLowerCase();
    const payload = asRecord(attachment.payload);
    const url = payload ? asString(payload.url).trim() : "";
    if (!url) continue;
    let kind: MediaKind | null = null;
    let isVoice = false;
    if (type === "image") kind = "image";
    else if (type === "video") kind = "video";
    else if (type === "audio" || type === "voice") {
      kind = "audio";
      isVoice = true;
    }
    if (!kind) continue;
    out.push({ kind, url, isVoice });
    if (out.length >= 4) break;
  }
  return out;
}

/** 冇客戶句子、只有帖文 referral 或分享帖文時用。唔會當成帖文 caption。 */
const REFERRAL_DM_BODY = "（由帖文開啟私訊）";

/** Instagram／Facebook 可以開到嘅帖文、限時動態或廣告連結。CDN 預覽唔算。 */
function openablePostPermalink(value: string): string | null {
  const cleaned = cleanWebhookUrl(value);
  if (!cleaned) return null;
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.toLowerCase();
  if (host === "instagram.com" || host === "instagr.am" || host.endsWith(".instagram.com")) {
    if (/^\/(?:p|reel|reels|tv|stories|share)\//.test(path)) return cleaned;
    return null;
  }
  if (host === "fb.me") return url.pathname.length > 1 ? cleaned : null;
  if (
    host === "facebook.com" ||
    host.endsWith(".facebook.com") ||
    host === "fb.com" ||
    host.endsWith(".fb.com") ||
    host === "m.facebook.com" ||
    host === "mbasic.facebook.com"
  ) {
    if (
      path.includes("/posts/") ||
      path.includes("/permalink") ||
      path.includes("/reel") ||
      path.includes("/videos/") ||
      path.includes("/photos/") ||
      path.includes("/share/") ||
      path.includes("/stories/")
    ) {
      return cleaned;
    }
    if (url.searchParams.has("story_fbid") || url.searchParams.has("fbid")) return cleaned;
  }
  return null;
}

/** POST、STORY、ADS、IG_POST 這類先係帖文或廣告。ig.me／SHORTLINK 唔算。 */
function isContentReferralSource(source: string): boolean {
  if (!source) return false;
  return source
    .split("_")
    .filter(Boolean)
    .some((token) => token === "POST" || token === "STORY" || token === "ADS" || token === "AD");
}

function referralCaption(parts: string[]): string | null {
  const seen: string[] = [];
  for (const raw of parts) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text || /^https?:\/\//i.test(text)) continue;
    if (seen.includes(text)) continue;
    seen.push(text);
  }
  if (!seen.length) return null;
  return cleanWebhookCaption(seen.join(" — "));
}

/**
 * Messenger／Instagram messaging referral。
 * 睇 message.referral、event.referral，同 postback.referral。
 * 客戶訊息正文唔讀。Shop product id、ig.me ref 唔當帖文。
 */
function readMessagingReferral(referral: unknown): MetaPostBits | null {
  const record = asRecord(referral);
  if (!record) return null;
  const source = asString(record.source)
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  const ads = asRecord(record.ads_context_data) ?? asRecord(record.adsContextData);
  const contentSource = isContentReferralSource(source);
  const postId =
    cleanWebhookPostId(asString(record.post_id)) ||
    cleanWebhookPostId(asString(record.postId)) ||
    cleanWebhookPostId(asString(ads?.post_id)) ||
    cleanWebhookPostId(asString(ads?.postId)) ||
    cleanWebhookPostId(asString(record.media_id)) ||
    cleanWebhookPostId(asString(record.ig_post_media_id)) ||
    cleanWebhookPostId(asString(record.story_id));
  const adId = cleanWebhookPostId(
    asString(record.ad_id) || asString(record.adId) || asString(ads?.ad_id)
  );
  const permalink =
    openablePostPermalink(asString(record.source_url)) ||
    openablePostPermalink(asString(record.sourceUrl)) ||
    openablePostPermalink(asString(record.permalink)) ||
    openablePostPermalink(asString(record.permalink_url)) ||
    openablePostPermalink(asString(record.url)) ||
    openablePostPermalink(asString(ads?.source_url)) ||
    openablePostPermalink(asString(ads?.permalink)) ||
    openablePostPermalink(asString(ads?.permalink_url));
  const caption = referralCaption([
    asString(ads?.ad_title),
    asString(ads?.adTitle),
    asString(record.title),
    asString(record.headline),
    asString(record.caption),
    asString(ads?.body),
    asString(record.body),
  ]);
  const id = postId || (contentSource ? adId : null);
  if (!id && !permalink && !caption) return null;
  if (!contentSource && !postId && !permalink) return null;
  return { postId: id, postPermalink: permalink, postCaption: caption };
}

/** 客戶分享帖文（ig_post／帶 media id 嘅 share）。CDN 預覽唔當 permalink，亦唔當客戶自己嘅相片。 */
function readSharedPost(message: Record<string, unknown>): MetaPostBits | null {
  const igPosts: MetaPostBits[] = [];
  const shares: MetaPostBits[] = [];
  for (const raw of asArray(message.attachments)) {
    const attachment = asRecord(raw);
    if (!attachment) continue;
    const type = asString(attachment.type).toLowerCase();
    if (type !== "ig_post" && type !== "share") continue;
    const payload = asRecord(attachment.payload);
    if (!payload) continue;
    const postId = cleanWebhookPostId(
      asString(payload.ig_post_media_id) || asString(payload.post_id) || asString(payload.media_id)
    );
    const postCaption = cleanWebhookCaption(asString(payload.title) || asString(payload.caption));
    const postPermalink = openablePostPermalink(asString(payload.permalink) || asString(payload.url));
    if (!postId && !postCaption && !postPermalink) continue;
    const bits = { postId, postPermalink, postCaption };
    if (type === "ig_post") igPosts.push(bits);
    else shares.push(bits);
  }
  return mergePostBits(...igPosts, ...shares) ?? null;
}

/** 回覆限時動態。story.id 係媒體編號；CDN url 唔當原帖連結。 */
function readStoryReply(message: Record<string, unknown>): MetaPostBits | null {
  const reply = asRecord(message.reply_to);
  const story = reply ? asRecord(reply.story) : null;
  if (!story) return null;
  const postId = cleanWebhookPostId(asString(story.id));
  const postPermalink = openablePostPermalink(asString(story.url) || asString(story.permalink));
  if (!postId && !postPermalink) return null;
  return { postId, postPermalink, postCaption: null };
}

function mergePostBits(...parts: Array<MetaPostBits | null>): MetaPostBits | undefined {
  let postId: string | null = null;
  let postPermalink: string | null = null;
  let postCaption: string | null = null;
  for (const part of parts) {
    if (!part) continue;
    postId = postId || part.postId || null;
    postPermalink = postPermalink || part.postPermalink || null;
    postCaption = postCaption || part.postCaption || null;
  }
  if (!postId && !postPermalink && !postCaption) return undefined;
  return { postId, postPermalink, postCaption };
}

function messagingSender(event: Record<string, unknown>): { senderId: string; author: string } {
  const sender = asRecord(event.sender);
  const senderId = actorId(sender);
  return { senderId, author: fromName(sender) || senderId };
}

/** Messenger / IG messaging（entry.messaging[]），包括冇 message 嘅 referral。 */
function parseMessaging(
  messaging: unknown[],
  source: SiteCommentSource,
  items: UpsertSiteCommentInput[]
): void {
  for (const raw of messaging) {
    const event = asRecord(raw);
    if (!event) continue;
    const { senderId, author } = messagingSender(event);
    if (isOwnMetaActor(senderId)) continue;
    const postback = asRecord(event.postback);
    const message = asRecord(event.message);
    const post = mergePostBits(
      message ? readMessagingReferral(message.referral) : null,
      readMessagingReferral(event.referral),
      postback ? readMessagingReferral(postback.referral) : null,
      message ? readSharedPost(message) : null,
      message ? readStoryReply(message) : null
    );

    if (message) {
      if (message.is_echo === true || message.is_echo === "true") continue;
      if (message.is_deleted === true || message.is_deleted === "true") continue;
      const mid = asString(message.mid) || asString(message.id);
      const text = asString(message.text).trim();
      const attachments = readDmAttachments(message);
      const body =
        text ||
        (attachments[0] ? placeholderFor(attachments[0].kind, attachments[0].isVoice) : "") ||
        (post ? REFERRAL_DM_BODY : "");
      if (!body) continue;
      const externalId = mid || (senderId ? `msg:${senderId}:${body.slice(0, 40)}` : "");
      pushItem(items, source, externalId, author, body, {
        senderId,
        surface: "message",
        ...post,
        attachments: attachments.length ? attachments : undefined,
      });
      continue;
    }

    if (!post || !senderId) continue;
    const stamp = asString(event.timestamp);
    const postbackTitle = postback ? asString(postback.title).trim() : "";
    const mid = postback ? asString(postback.mid) : "";
    const externalId = (mid || `ref:${senderId}:${post.postId || stamp || "open"}`).slice(0, 200);
    pushItem(items, source, externalId, author, postbackTitle || REFERRAL_DM_BODY, {
      senderId,
      surface: "message",
      ...post,
    });
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
