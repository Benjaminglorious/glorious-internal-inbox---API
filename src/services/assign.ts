import { db } from "../db";

/**
 * 公司自動派單次序（未完成數相同時）：Eddie → Wing → Jason → 其餘在職同事。
 * 其餘唔包括 Tony。Tony 即使 active=1 都唔會被自動派單；管理員可以人手改派畀佢。
 * 新同事（唔喺優先名單）排喺 Jason 後面，以 staff.id 升序。只計 active = 1。
 */
export const AUTO_ASSIGN_PRIORITY_USERNAMES = ["eddie", "wing", "jason"] as const;
export const AUTO_ASSIGN_EXCLUDED_USERNAMES = ["tony"] as const;

/**
 * Least open comments, then Eddie → Wing → Jason → other active staff by id.
 * Tony is excluded. Inactive (active = 0) staff are excluded.
 * 公司 WhatsApp 總機入站（routeWhatsAppInbound）、網站留言 ingest、同 seed 都用呢條規則。
 */
export function pickLeastLoadedStaffId(): number | null {
  const excluded = AUTO_ASSIGN_EXCLUDED_USERNAMES.map((name) => name.toLowerCase());
  const excludedSql = excluded.map(() => "?").join(", ");
  const row = db
    .prepare(
      `
      SELECT s.id AS id,
             COALESCE(SUM(CASE WHEN c.status IN ('open','in_progress') THEN 1 ELSE 0 END), 0) AS open_count
      FROM staff s
      LEFT JOIN comments c ON c.assignee_staff_id = s.id
      WHERE s.active = 1
        AND lower(s.username) NOT IN (${excludedSql})
      GROUP BY s.id
      ORDER BY open_count ASC,
               CASE lower(s.username)
                 WHEN 'eddie' THEN 0
                 WHEN 'wing' THEN 1
                 WHEN 'jason' THEN 2
                 ELSE 1000 + s.id
               END ASC
      LIMIT 1
    `
    )
    .get(...excluded) as { id: number; open_count: number } | undefined;
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
