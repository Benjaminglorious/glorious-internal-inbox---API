import { db } from "../db";
import type { CommentSource, CommentStatus, CommentWithAssignee } from "../types";
import { isCommentSource, type EntryPath } from "../types";
import { resolveEntryPath } from "../intake";
import { pickLeastLoadedStaffId } from "./assign";
import { getComment } from "./comments";
import { notifyNewComment } from "./push";

const MAX_BODY = 8000;
const MAX_EXTERNAL_ID = 200;
const MAX_AUTHOR = 120;
const MAX_VEHICLE = 120;

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
}

export interface UpsertSiteCommentSuccess {
  ok: true;
  comment: CommentWithAssignee;
  created: boolean;
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

/**
 * 入庫網站／FB／IG 留言（intake_kind=site_comment，origin_site=NULL）。
 * 以 (source, external_id) 冪等：已存在則更新內容，保留負責人；新留言用最少未完成同事派單。
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

  const run = db.transaction((): UpsertSiteCommentResult => {
    const existing = db
      .prepare(
        `SELECT id, body, author_name, vehicle_ref, status, assignee_staff_id
         FROM comments
         WHERE source = ? AND external_id = ?`
      )
      .get(source, externalId) as ExistingRow | undefined;

    if (!existing) {
      const assigneeStaffId = pickLeastLoadedStaffId();
      const info = db
        .prepare(
          `INSERT INTO comments (
             source, external_id, author_name, body, vehicle_ref, status, assignee_staff_id,
             intake_kind, origin_site, entry_path
           ) VALUES (?, ?, ?, ?, ?, 'open', ?, 'site_comment', NULL, ?)`
        )
        .run(source, externalId, authorName, body, vehicleRef, assigneeStaffId, entryPath);
      const comment = getComment(Number(info.lastInsertRowid));
      if (!comment) return { ok: false, error: "入庫後讀唔返留言" };
      return { ok: true, comment, created: true, assigneeStaffId };
    }

    let status: CommentStatus = existing.status;
    const changed =
      body !== existing.body ||
      authorName !== existing.author_name ||
      (vehicleRef ?? null) !== (existing.vehicle_ref ?? null);
    if (changed && status === "done") status = "open";

    db.prepare(
      `UPDATE comments
       SET author_name = ?, body = ?, vehicle_ref = ?, status = ?,
           intake_kind = 'site_comment', origin_site = NULL,
           entry_path = COALESCE(?, entry_path),
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(authorName, body, vehicleRef, status, entryPath, existing.id);

    const comment = getComment(existing.id);
    if (!comment) return { ok: false, error: "更新後讀唔返留言" };
    return {
      ok: true,
      comment,
      created: false,
      assigneeStaffId: comment.assignee_staff_id,
    };
  });

  const result = run();
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
