import { db } from "../db";
import type { CommentSource, CommentStatus, CommentWithAssignee, MetaSurface } from "../types";
import { isCommentSource, isMetaSurface, type EntryPath } from "../types";
import { resolveEntryPath } from "../intake";
import { pickNextAutoAssignStaffId } from "./assign";
import {
  appendInboundMessage,
  commenterKey,
  findOpenThread,
  isOpenCommenterConflict,
  keySafeToStore,
  replayFoldedMessage,
  type ThreadFills,
} from "./commenter-thread";
import { getComment } from "./comments";
import { notifyNewComment } from "./push";

const MAX_BODY = 8000;
const MAX_EXTERNAL_ID = 200;
const MAX_AUTHOR = 120;
const MAX_VEHICLE = 120;
const MAX_POST_ID = 200;
const MAX_POST_URL = 500;
const MAX_POST_CAPTION = 500;

/** 網站／FB／IG 留言來源（唔包括 whatsapp）。 */
export const SITE_COMMENT_SOURCES = ["28car", "glorious_web", "facebook", "instagram"] as const;
export type SiteCommentSource = (typeof SITE_COMMENT_SOURCES)[number];

const SOURCE_ALIASES: Record<string, SiteCommentSource> = {
  "28car": "28car",
  glorious_web: "glorious_web",
  glorious: "glorious_web",
  gw: "glorious_web",
  web: "glorious_web",
  facebook: "facebook",
  fb: "facebook",
  instagram: "instagram",
  ig: "instagram",
};

export interface UpsertSiteCommentInput {
  source: string;
  external_id: string;
  author_name: string;
  body: string;
  vehicle_ref?: string | null;
  /** 28car 網頁留言區寫入 `28car_board`。其他來源留空。 */
  entry_path?: string | null;
  /** Messenger PSID、IGSID，或公開留言者 id。 */
  meta_sender_id?: string | null;
  /** 公開留言 comment；私訊 message。 */
  meta_surface?: string | null;
  /** Facebook post id 或 Instagram media id。只會寫入 facebook／instagram。 */
  meta_post_id?: string | null;
  /** 帖文 permalink。只接受 http(s)。 */
  meta_post_permalink?: string | null;
  /** 帖文內文或 caption 摘要。 */
  meta_post_caption?: string | null;
  /** 私訊或留言附帶嘅媒體。upsert 唔寫入 comments，webhook 另外下載。 */
  attachments?: Array<{ kind: "image" | "video" | "audio"; url: string; isVoice: boolean }>;
}

export interface UpsertSiteCommentSuccess {
  ok: true;
  comment: CommentWithAssignee;
  created: boolean;
  /** 新訊息併入未完成對話，冇開新 ID。 */
  appended: boolean;
  /** 併入嘅客戶再留言。新開或更新原帖時係 null。 */
  inboundReplyId: number | null;
  assigneeStaffId: number | null;
}

export interface UpsertSiteCommentFailure {
  ok: false;
  error: string;
}

export type UpsertSiteCommentResult = UpsertSiteCommentSuccess | UpsertSiteCommentFailure;

interface ExistingRow {
  id: number;
  body: string;
  author_name: string;
  vehicle_ref: string | null;
  status: CommentStatus;
  assignee_staff_id: number | null;
}

export function isSiteCommentSource(value: unknown): value is SiteCommentSource {
  return typeof value === "string" && (SITE_COMMENT_SOURCES as readonly string[]).includes(value);
}

/**
 * 正規化 webhook／表單傳入嘅來源。
 * 接受別名：`fb`→facebook、`ig`→instagram、`gw`/`web`/`glorious`→glorious_web。
 */
export function normalizeSiteCommentSource(value: unknown): SiteCommentSource | null | "invalid" {
  if (value == null) return null;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  if (!trimmed) return null;
  const mapped = SOURCE_ALIASES[trimmed.toLowerCase()];
  if (mapped) return mapped;
  if (isSiteCommentSource(trimmed)) return trimmed;
  if (isCommentSource(trimmed) && trimmed === "whatsapp") return "invalid";
  return "invalid";
}

function cleanExternalId(value: string): string | null {
  const id = value.replace(/\u0000/g, "").trim();
  if (!id || id.length > MAX_EXTERNAL_ID) return null;
  return id;
}

function cleanMetaSenderId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.replace(/\u0000/g, "").trim();
  if (!id || id.length > MAX_EXTERNAL_ID) return null;
  if (!/^[0-9A-Za-z_.:-]{1,200}$/.test(id)) return null;
  return id;
}

function cleanMetaSurface(value: unknown): MetaSurface | null {
  return isMetaSurface(value) ? value : null;
}

export function cleanMetaPostId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) value = String(Math.trunc(value));
  if (typeof value !== "string") return null;
  const id = value.replace(/\u0000/g, "").trim();
  if (!id || id.length > MAX_POST_ID) return null;
  if (!/^[0-9A-Za-z_.:-]{1,200}$/.test(id)) return null;
  return id;
}

export function cleanMetaPostPermalink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\u0000/g, "").trim();
  if (!text || text.length > MAX_POST_URL) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function cleanMetaPostCaption(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, MAX_POST_CAPTION);
}

/**
 * 入庫網站／FB／IG 留言（intake_kind=site_comment，origin_site=NULL）。
 * 以 (source, external_id) 冪等：已存在則更新內容，保留負責人；新留言用輪流次序派單（唔計未完成數）。
 */
export function upsertSiteComment(input: UpsertSiteCommentInput): UpsertSiteCommentResult {
  const sourceNorm = normalizeSiteCommentSource(input.source);
  if (sourceNorm === "invalid" || sourceNorm == null) {
    return { ok: false, error: "source 必須係 28car、glorious_web、facebook 或 instagram" };
  }
  const source: CommentSource = sourceNorm;

  const externalId = cleanExternalId(String(input.external_id ?? ""));
  if (!externalId) {
    return { ok: false, error: "缺少有效 external_id" };
  }

  const authorName = String(input.author_name ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, MAX_AUTHOR);
  if (!authorName) {
    return { ok: false, error: "缺少留言者名稱" };
  }

  const body = String(input.body ?? "")
    .replace(/\u0000/g, "")
    .trim();
  if (!body) {
    return { ok: false, error: "缺少留言內容" };
  }
  if (body.length > MAX_BODY) {
    return { ok: false, error: "留言內容太長" };
  }

  let vehicleRef: string | null = null;
  if (input.vehicle_ref != null && String(input.vehicle_ref).trim()) {
    vehicleRef = String(input.vehicle_ref).replace(/\u0000/g, "").trim().slice(0, MAX_VEHICLE);
  }

  const entryResolved = resolveEntryPath({
    explicit: input.entry_path,
    inferred: null,
    channel: "site",
  });
  if (!entryResolved.ok) return { ok: false, error: entryResolved.error };
  const entryPath: EntryPath | null = entryResolved.entryPath;
  if (entryPath === "28car_board" && source !== "28car") {
    return { ok: false, error: "28car_board 只可以配 source=28car" };
  }

  const metaSenderId = cleanMetaSenderId(input.meta_sender_id);
  const metaSurface = cleanMetaSurface(input.meta_surface);
  const storePost = source === "facebook" || source === "instagram";
  const metaPostId = storePost ? cleanMetaPostId(input.meta_post_id) : null;
  const metaPostPermalink = storePost ? cleanMetaPostPermalink(input.meta_post_permalink) : null;
  const metaPostCaption = storePost ? cleanMetaPostCaption(input.meta_post_caption) : null;
  const identityKey = commenterKey({
    source,
    authorName,
    externalId,
    metaSenderId,
  });
  const fills: ThreadFills = {
    metaSenderId,
    metaSurface,
    vehicleRef,
    entryPath,
    metaPostId,
    metaPostPermalink,
    metaPostCaption,
  };

  const run = db.transaction((): UpsertSiteCommentResult => {
    const existing = db
      .prepare(
        `SELECT id, body, author_name, vehicle_ref, status, assignee_staff_id
         FROM comments
         WHERE source = ? AND external_id = ?`
      )
      .get(source, externalId) as ExistingRow | undefined;

    if (!existing) {
      const folded = replayFoldedMessage(source, externalId, body);
      if (folded) {
        const comment = getComment(folded.commentId);
        if (!comment) return { ok: false, error: "更新後讀唔返留言" };
        return {
          ok: true,
          comment,
          created: false,
          appended: false,
          inboundReplyId: folded.replyId,
          assigneeStaffId: comment.assignee_staff_id,
        };
      }

      const open = findOpenThread({ source, key: identityKey, authorName });
      if (open) {
        const appended = appendInboundMessage({
          commentId: open.id,
          source,
          externalId,
          body,
          authorName,
          commenterKey: identityKey,
          fills,
        });
        const comment = getComment(open.id);
        if (!comment) return { ok: false, error: "更新後讀唔返留言" };
        return {
          ok: true,
          comment,
          created: false,
          appended: !appended.duplicate,
          inboundReplyId: appended.replyId,
          assigneeStaffId: comment.assignee_staff_id,
        };
      }

      const assigneeStaffId = pickNextAutoAssignStaffId();
      const info = db
        .prepare(
          `INSERT INTO comments (
             source, external_id, author_name, body, vehicle_ref, status, assignee_staff_id,
             intake_kind, origin_site, entry_path, meta_sender_id, meta_surface,
             meta_post_id, meta_post_permalink, meta_post_caption, commenter_key
           ) VALUES (?, ?, ?, ?, ?, 'open', ?, 'site_comment', NULL, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          source,
          externalId,
          authorName,
          body,
          vehicleRef,
          assigneeStaffId,
          entryPath,
          metaSenderId,
          metaSurface,
          metaPostId,
          metaPostPermalink,
          metaPostCaption,
          identityKey
        );
      const comment = getComment(Number(info.lastInsertRowid));
      if (!comment) return { ok: false, error: "入庫後讀唔返留言" };
      return { ok: true, comment, created: true, appended: false, inboundReplyId: null, assigneeStaffId };
    }

    let status: CommentStatus = existing.status;
    const changed =
      body !== existing.body ||
      authorName !== existing.author_name ||
      (vehicleRef ?? null) !== (existing.vehicle_ref ?? null);
    if (changed && status === "done") {
      const otherOpen = findOpenThread({ source, key: identityKey, authorName, excludeId: existing.id });
      if (!otherOpen) status = "open";
    }
    const keyToStore = keySafeToStore(source, existing.id, identityKey, status);

    if (storePost) {
      db.prepare(
        `UPDATE comments
         SET author_name = ?, body = ?, vehicle_ref = ?, status = ?,
             intake_kind = 'site_comment', origin_site = NULL,
             entry_path = COALESCE(?, entry_path),
             meta_sender_id = COALESCE(?, meta_sender_id),
             meta_surface = COALESCE(?, meta_surface),
             meta_post_id = COALESCE(?, meta_post_id),
             meta_post_permalink = COALESCE(?, meta_post_permalink),
             meta_post_caption = COALESCE(?, meta_post_caption),
             commenter_key = COALESCE(commenter_key, ?),
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        authorName,
        body,
        vehicleRef,
        status,
        entryPath,
        metaSenderId,
        metaSurface,
        metaPostId,
        metaPostPermalink,
        metaPostCaption,
        keyToStore,
        existing.id
      );
    } else {
      db.prepare(
        `UPDATE comments
         SET author_name = ?, body = ?, vehicle_ref = ?, status = ?,
             intake_kind = 'site_comment', origin_site = NULL,
             entry_path = COALESCE(?, entry_path),
             meta_sender_id = COALESCE(?, meta_sender_id),
             meta_surface = COALESCE(?, meta_surface),
             commenter_key = COALESCE(commenter_key, ?),
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(authorName, body, vehicleRef, status, entryPath, metaSenderId, metaSurface, keyToStore, existing.id);
    }

    const comment = getComment(existing.id);
    if (!comment) return { ok: false, error: "更新後讀唔返留言" };
    return {
      ok: true,
      comment,
      created: false,
      appended: false,
      inboundReplyId: null,
      assigneeStaffId: comment.assignee_staff_id,
    };
  });

  let result: UpsertSiteCommentResult;
  try {
    result = run();
  } catch (err) {
    if (!isOpenCommenterConflict(err)) throw err;
    result = run();
  }
  if (result.ok && result.created) {
    try {
      notifyNewComment({
        id: result.comment.id,
        source: result.comment.source,
        author_name: result.comment.author_name,
        body: result.comment.body,
        intake_kind: result.comment.intake_kind,
        origin_site: result.comment.origin_site,
        entry_path: result.comment.entry_path,
      });
    } catch (err) {
      console.error("[push] 未能排程推送", err);
    }
  }
  return result;
}

/**
 * Graph 補回帖文內容或連結。只填空白欄，唔改留言時間，唔覆蓋 webhook 已有嘅值。
 * 私訊同非 Meta 來源唔寫。
 */
export function fillMetaPostIfMissing(
  id: number,
  post: { id?: string | null; permalink?: string | null; caption?: string | null }
): CommentWithAssignee | null {
  const current = getComment(id);
  if (!current) return null;
  if (current.source !== "facebook" && current.source !== "instagram") return current;
  const nextId = current.meta_post_id || cleanMetaPostId(post.id);
  const nextLink = current.meta_post_permalink || cleanMetaPostPermalink(post.permalink);
  const nextCaption = current.meta_post_caption || cleanMetaPostCaption(post.caption);
  if (
    nextId === current.meta_post_id &&
    nextLink === current.meta_post_permalink &&
    nextCaption === current.meta_post_caption
  ) {
    return current;
  }
  db.prepare(
    `UPDATE comments
     SET meta_post_id = ?, meta_post_permalink = ?, meta_post_caption = ?
     WHERE id = ?`
  ).run(nextId, nextLink, nextCaption, id);
  return getComment(id);
}
