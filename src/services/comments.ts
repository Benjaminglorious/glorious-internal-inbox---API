import { db } from "../db";
import type {
  CommentSource,
  CommentStatus,
  CommentStatusFilter,
  CommentWithAssignee,
  DeliveryStatus,
  IntakeKind,
  EntryPath,
  OriginFilter,
  OriginSite,
  ReplyDirection,
  StaffPublic,
} from "../types";
import { isDeliveryStatus, isEntryPath, isIntakeKind, isOriginSite } from "../types";

/** 已登入嘅人。管理員見全部（包括未派）；在職同事只見 assignee 係自己嘅留言。 */
export interface CommentViewer {
  staffId: number;
  isAdmin: boolean;
}

export function canViewComment(
  comment: { assignee_staff_id: number | null },
  viewer: CommentViewer
): boolean {
  if (viewer.isAdmin) return true;
  return comment.assignee_staff_id != null && comment.assignee_staff_id === viewer.staffId;
}

export interface CommentFilters {
  source?: CommentSource;
  status?: CommentStatusFilter;
  intake?: IntakeKind;
  origin?: OriginFilter;
  entry?: EntryPath;
  mine?: boolean;
  staffId?: number;
  /** 有傳而且唔係管理員時，強制只返回派咗畀該同事嘅留言。 */
  viewer?: CommentViewer;
}

const PREVIEW_LEN = 80;

export interface CommentUpdateItem {
  id: number;
  source: CommentSource;
  intake_kind: IntakeKind;
  origin_site: OriginSite | null;
  entry_path: EntryPath | null;
  author_name: string;
  preview: string;
  vehicle_ref: string | null;
  created_at: string;
  assignee_staff_id: number | null;
  assignee_name: string | null;
}

export interface CommentUpdates {
  latest_id: number;
  has_more: boolean;
  comments: CommentUpdateItem[];
}

interface CommentRow extends Omit<CommentWithAssignee, "reply_count"> {
  reply_count: number | null;
}

const COMMENT_SELECT = `
  SELECT c.*,
         s.display_name AS assignee_name,
         s.username AS assignee_username,
         COALESCE(rc.reply_count, 0) AS reply_count,
         lr.body AS last_reply_body,
         lr.created_at AS last_reply_at,
         lr.delivery_status AS last_reply_delivery_status,
         lr.direction AS last_reply_direction,
         rs.display_name AS last_reply_staff_name
  FROM comments c
  LEFT JOIN staff s ON s.id = c.assignee_staff_id
  LEFT JOIN (
    SELECT comment_id, COUNT(*) AS reply_count, MAX(id) AS last_id
    FROM comment_replies
    GROUP BY comment_id
  ) rc ON rc.comment_id = c.id
  LEFT JOIN comment_replies lr ON lr.id = rc.last_id
  LEFT JOIN staff rs ON rs.id = lr.staff_id
`;

function asDelivery(value: unknown): DeliveryStatus | null {
  return isDeliveryStatus(value) ? value : null;
}

function asDirection(value: unknown): ReplyDirection | null {
  if (value === "outbound" || value === "inbound") return value;
  return null;
}

function mapComment(row: CommentRow): CommentWithAssignee {
  return {
    ...row,
    intake_kind: isIntakeKind(row.intake_kind) ? row.intake_kind : "site_comment",
    origin_site: isOriginSite(row.origin_site) ? row.origin_site : null,
    entry_path: isEntryPath(row.entry_path) ? row.entry_path : null,
    reply_count: Number(row.reply_count) || 0,
    last_reply_body: row.last_reply_body ?? null,
    last_reply_at: row.last_reply_at ?? null,
    last_reply_staff_name: row.last_reply_staff_name ?? null,
    last_reply_delivery_status: asDelivery(row.last_reply_delivery_status),
    last_reply_direction: asDirection(row.last_reply_direction),
    wa_from_phone: asStoredPhone(row.wa_from_phone),
    wa_to_phone: asStoredPhone(row.wa_to_phone),
  };
}

function asStoredPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** 全庫最新留言 id，用嚟做游標。列表同更新內容會再按角色篩走其他人嘅留言。 */
export function latestCommentId(): number {
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM comments`).get() as { id: number };
  return Number(row.id) || 0;
}

/**
 * 新留言游標。sinceId 為 null 時只回最新 id，唔把舊留言當成新訊息。
 * MAX(id) 同新留言列表放喺同一個 transaction，避免兩次讀取之間有插入而跳過。
 */
export function listCommentUpdates(
  sinceId: number | null,
  limit = 30,
  viewer?: CommentViewer
): CommentUpdates {
  const cap = Math.min(Math.max(Math.floor(limit) || 30, 1), 50);
  const read = db.transaction((): CommentUpdates => {
    const latest_id = latestCommentId();
    if (sinceId == null) {
      return { latest_id, comments: [], has_more: false };
    }
    const where = ["c.id > ?"];
    const params: unknown[] = [sinceId];
    if (viewer && !viewer.isAdmin) {
      where.push("c.assignee_staff_id = ?");
      params.push(viewer.staffId);
    }
    params.push(cap + 1);
    const rows = db
      .prepare(
        `
        SELECT c.id, c.source, c.intake_kind, c.origin_site, c.entry_path, c.author_name, c.body,
               c.vehicle_ref, c.created_at, c.assignee_staff_id, s.display_name AS assignee_name
        FROM comments c
        LEFT JOIN staff s ON s.id = c.assignee_staff_id
        WHERE ${where.join(" AND ")}
        ORDER BY c.id ASC
        LIMIT ?
      `
      )
      .all(...params) as Array<{
      id: number;
      source: CommentSource;
      intake_kind: string;
      origin_site: string | null;
      entry_path: string | null;
      author_name: string;
      body: string;
      vehicle_ref: string | null;
      created_at: string;
      assignee_staff_id: number | null;
      assignee_name: string | null;
    }>;
    const has_more = rows.length > cap;
    const slice = has_more ? rows.slice(0, cap) : rows;
    return {
      latest_id,
      has_more,
      comments: slice.map((row) => ({
        id: row.id,
        source: row.source,
        intake_kind: isIntakeKind(row.intake_kind) ? row.intake_kind : "site_comment",
        origin_site: isOriginSite(row.origin_site) ? row.origin_site : null,
        entry_path: isEntryPath(row.entry_path) ? row.entry_path : null,
        author_name: row.author_name,
        preview: previewText(row.body),
        vehicle_ref: row.vehicle_ref,
        created_at: row.created_at,
        assignee_staff_id: row.assignee_staff_id,
        assignee_name: row.assignee_name,
      })),
    };
  });
  return read();
}

/** 列表頁用：留言同最新 id 同一個 snapshot，頁面游標先至對得準。 */
export function listCommentsWithCursor(filters: CommentFilters = {}): {
  comments: CommentWithAssignee[];
  latestId: number;
} {
  const read = db.transaction(() => ({
    comments: listComments(filters),
    latestId: latestCommentId(),
  }));
  return read();
}

export function getCommentWithCursor(id: number): {
  comment: CommentWithAssignee | null;
  latestId: number;
} {
  const read = db.transaction(() => ({
    comment: getComment(id),
    latestId: latestCommentId(),
  }));
  return read();
}

function previewText(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= PREVIEW_LEN) return flat;
  return flat.slice(0, PREVIEW_LEN) + "…";
}

export function listComments(filters: CommentFilters = {}): CommentWithAssignee[] {
  const where: string[] = ["1=1"];
  const params: unknown[] = [];

  if (filters.source) {
    where.push("c.source = ?");
    params.push(filters.source);
  }
  if (filters.status === "pending") {
    where.push("c.status IN ('open', 'in_progress')");
  } else if (filters.status) {
    where.push("c.status = ?");
    params.push(filters.status);
  }
  if (filters.intake) {
    where.push("c.intake_kind = ?");
    params.push(filters.intake);
  }
  if (filters.entry) {
    where.push("c.entry_path = ?");
    params.push(filters.entry);
  }
  if (filters.origin === "direct") {
    where.push("c.source = 'whatsapp' AND c.origin_site IS NULL AND c.intake_kind = 'whatsapp_click'");
  } else if (filters.origin) {
    where.push(`(
      (c.intake_kind = 'site_comment' AND c.source = ?)
      OR (c.intake_kind = 'whatsapp_click' AND c.origin_site = ?)
    )`);
    params.push(filters.origin, filters.origin);
  }
  if (filters.viewer && !filters.viewer.isAdmin) {
    where.push("c.assignee_staff_id = ?");
    params.push(filters.viewer.staffId);
  } else if (filters.mine && filters.staffId != null) {
    where.push("c.assignee_staff_id = ?");
    params.push(filters.staffId);
  }

  const sql = `
    ${COMMENT_SELECT}
    WHERE ${where.join(" AND ")}
    ORDER BY
      CASE c.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
      c.created_at DESC,
      c.id DESC
  `;
  return (db.prepare(sql).all(...params) as CommentRow[]).map(mapComment);
}

export function getComment(id: number): CommentWithAssignee | null {
  const row = db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(id) as CommentRow | undefined;
  return row ? mapComment(row) : null;
}

export function updateStatus(id: number, status: CommentStatus): CommentWithAssignee | null {
  db.prepare(`UPDATE comments SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  return getComment(id);
}

export function reassign(id: number, staffId: number | null): CommentWithAssignee | null {
  if (staffId != null) {
    const staff = db.prepare(`SELECT id FROM staff WHERE id = ? AND active = 1`).get(staffId);
    if (!staff) return null;
  }
  db.prepare(`UPDATE comments SET assignee_staff_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
    staffId,
    id
  );
  return getComment(id);
}

export function listStaff(): StaffPublic[] {
  const rows = db
    .prepare(`SELECT id, username, display_name, is_admin, active FROM staff ORDER BY id ASC`)
    .all() as Array<{
    id: number;
    username: string;
    display_name: string;
    is_admin: number;
    active: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    display_name: r.display_name,
    is_admin: !!r.is_admin,
    active: !!r.active,
  }));
}

export function findStaffByUsername(username: string) {
  return db.prepare(`SELECT * FROM staff WHERE username = ? AND active = 1`).get(username) as
    | {
        id: number;
        username: string;
        display_name: string;
        password_hash: string;
        is_admin: number;
        active: number;
      }
    | undefined;
}

export function findStaffById(id: number) {
  return db.prepare(`SELECT * FROM staff WHERE id = ?`).get(id) as
    | {
        id: number;
        username: string;
        display_name: string;
        password_hash: string;
        is_admin: number;
        active: number;
      }
    | undefined;
}
