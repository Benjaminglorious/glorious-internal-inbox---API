import { db } from "../db";

/** Least open comments, then lowest staff id. Only active staff. */
export function pickLeastLoadedStaffId(): number | null {
  const row = db
    .prepare(
      `
      SELECT s.id AS id,
             COALESCE(SUM(CASE WHEN c.status IN ('open','in_progress') THEN 1 ELSE 0 END), 0) AS open_count
      FROM staff s
      LEFT JOIN comments c ON c.assignee_staff_id = s.id
      WHERE s.active = 1
      GROUP BY s.id
      ORDER BY open_count ASC, s.id ASC
      LIMIT 1
    `
    )
    .get() as { id: number; open_count: number } | undefined;
  return row?.id ?? null;
}

export function autoAssignUnassigned(): number {
  const unassigned = db
    .prepare(`SELECT id FROM comments WHERE assignee_staff_id IS NULL ORDER BY id ASC`)
    .all() as { id: number }[];
  const update = db.prepare(
    `UPDATE comments SET assignee_staff_id = ?, updated_at = datetime('now') WHERE id = ?`
  );
  let n = 0;
  for (const c of unassigned) {
    const staffId = pickLeastLoadedStaffId();
    if (staffId == null) break;
    update.run(staffId, c.id);
    n += 1;
  }
  return n;
}
