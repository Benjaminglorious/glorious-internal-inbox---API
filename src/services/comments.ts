import { db } from "../db";
import type { CommentSource, CommentStatus, CommentWithAssignee, StaffPublic } from "../types";

export interface CommentFilters {
  source?: CommentSource;
  status?: CommentStatus;
  mine?: boolean;
  staffId?: number;
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
