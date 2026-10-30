import { db } from "../db";

/**
 * 公司自動派單次序（未完成數相同時）：Eddie → Wing → Jason → 其餘在職同事。
 * 其餘包括 Tony 同日後新加入嘅 username（唔喺呢個名單）— 全部排 Jason 後面，以 staff.id 升序。
 * 只計 active = 1。
 */
export const AUTO_ASSIGN_PRIORITY_USERNAMES = ["eddie", "wing", "jason"] as const;

/**
 * Least open comments, then auto-assign priority (Eddie → Wing → Jason → others by id).
 * 只計 active = 1（在職管理員同在職同事都計；active = 0 收藏唔計）。
 * 公司 WhatsApp 總機入站（routeWhatsAppInbound）、網站留言 ingest、同 seed 都用呢條規則。
 */
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
      ORDER BY open_count ASC,
               CASE s.username
                 WHEN 'eddie' THEN 0
                 WHEN 'wing' THEN 1
                 WHEN 'jason' THEN 2
                 ELSE 1000 + s.id
               END ASC
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
