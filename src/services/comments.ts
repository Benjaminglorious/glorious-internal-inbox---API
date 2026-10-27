import { db } from "../db";
import type { CommentSource, CommentStatus, CommentWithAssignee, StaffPublic } from "../types";

export interface CommentFilters {
  source?: CommentSource;
  status?: CommentStatus;
  mine?: boolean;
  staffId?: number;
}

const PREVIEW_LEN = 80;

export interface CommentUpdateItem {
  id: number;
  source: CommentSource;
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

/** 同 listComments() 唔帶篩選時一樣：已登入同事可以見到全部留言。 */
export function latestCommentId(): number {
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM comments`).get() as { id: number };
  return Number(row.id) || 0;
}

/**
 * 新留言游標。sinceId 為 null 時只回最新 id，唔把舊留言當成新訊息。
 * MAX(id) 同新留言列表放喺同一個 transaction，避免兩次讀取之間有插入而跳過。
 */
export function listCommentUpdates(sinceId: number | null, limit = 30): CommentUpdates {
  const cap = Math.min(Math.max(Math.floor(limit) || 30, 1), 50);
  const read = db.transaction((): CommentUpdates => {
    const latest_id = latestCommentId();
    if (sinceId == null) {
      return { latest_id, comments: [], has_more: false };
    }
    const rows = db
      .prepare(
        `
        SELECT c.id, c.source, c.author_name, c.body, c.vehicle_ref, c.created_at,
               c.assignee_staff_id, s.display_name AS assignee_name
        FROM comments c
        LEFT JOIN staff s ON s.id = c.assignee_staff_id
        WHERE c.id > ?
        ORDER BY c.id ASC
        LIMIT ?
      `
      )
      .all(sinceId, cap + 1) as Array<{
      id: number;
      source: CommentSource;
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
  if (filters.status) {
    where.push("c.status = ?");
    params.push(filters.status);
  }
  if (filters.mine && filters.staffId != null) {
    where.push("c.assignee_staff_id = ?");
    params.push(filters.staffId);
  }

  const sql = `
    SELECT c.*,
           s.display_name AS assignee_name,
           s.username AS assignee_username
    FROM comments c
    LEFT JOIN staff s ON s.id = c.assignee_staff_id
    WHERE ${where.join(" AND ")}
    ORDER BY
      CASE c.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
      c.created_at DESC,
      c.id DESC
  `;
  return db.prepare(sql).all(...params) as CommentWithAssignee[];
}

export function getComment(id: number): CommentWithAssignee | null {
  const row = db
    .prepare(
      `
      SELECT c.*,
             s.display_name AS assignee_name,
             s.username AS assignee_username
      FROM comments c
      LEFT JOIN staff s ON s.id = c.assignee_staff_id
      WHERE c.id = ?
    `
    )
    .get(id) as CommentWithAssignee | undefined;
  return row ?? null;
}

export function updateStatus(id: number, status: CommentStatus): CommentWithAssignee | null {
  db.prepare(
    `UPDATE comments SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(status, id);
  return getComment(id);
}

export function reassign(id: number, staffId: number | null): CommentWithAssignee | null {
  if (staffId != null) {
    const staff = db.prepare(`SELECT id FROM staff WHERE id = ? AND active = 1`).get(staffId);
    if (!staff) return null;
  }
  db.prepare(
    `UPDATE comments SET assignee_staff_id = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(staffId, id);
  return getComment(id);
}

export function listStaff(): StaffPublic[] {
  const rows = db
    .prepare(
      `SELECT id, username, display_name, is_admin, active FROM staff ORDER BY id ASC`
    )
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
