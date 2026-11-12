import { db, usingPostgres } from "../db";

/**
 * 公司自動派單輪流次序：Eddie → Wing → Jason → 其餘在職同事（staff.id 升序）。
 * 其餘唔包括 Tony、Benjamin、Vivian、Ken。四人即使 active=1 都唔會被自動派單；管理員可以人手改派畀佢哋。
 * 排除係用戶名名單，唔係所有管理員。Eddie（is_admin）仍然喺優先名單。
 * 新同事（唔喺優先名單、亦唔喺排除名單）排喺 Jason 後面，以 staff.id 升序。只計 active = 1。
 * 唔計 open／in_progress 幾多。上一位記喺 auto_assign_state，重啟同多個 instance 共用。
 */
export const AUTO_ASSIGN_PRIORITY_USERNAMES = ["eddie", "wing", "jason"] as const;
export const AUTO_ASSIGN_EXCLUDED_USERNAMES = ["tony", "benjamin", "vivian", "ken"] as const;

const PRIORITY_RANK = new Map<string, number>(
  AUTO_ASSIGN_PRIORITY_USERNAMES.map((name, index) => [name, index])
);

/** 優先名單 0、1、2；其餘用 1000 + staff.id，所以一定排喺 Jason 後面。 */
function rotationRank(username: string, id: number): number {
  const priority = PRIORITY_RANK.get(username.toLowerCase());
  if (priority != null) return priority;
  return 1000 + id;
}

interface RotationStaff {
  id: number;
  username: string;
}

interface RotationCursor {
  last_staff_id: number | null;
  last_username: string | null;
  version: number;
}

class AutoAssignConflict extends Error {
  constructor() {
    super("auto-assign rotation conflict");
    this.name = "AutoAssignConflict";
  }
}

function compareRotation(a: RotationStaff, b: RotationStaff): number {
  return rotationRank(a.username, a.id) - rotationRank(b.username, b.id) || a.id - b.id;
}

/**
 * 上一位喺輪流次序嘅位置。冇游標就返回 null（由第一位開始）。
 * 列仲喺就用而家嘅用戶名，即使已停用或被排除。列冇咗就用記低嘅用戶名，先至可以跳去下一位。
 */
function cursorRank(lastStaffId: number | null, lastUsername: string | null): number | null {
  if (lastStaffId == null && (lastUsername == null || lastUsername === "")) return null;
  if (lastStaffId != null) {
    const live = db.prepare(`SELECT id, username FROM staff WHERE id = ?`).get(lastStaffId) as
      | RotationStaff
      | undefined;
    if (live) return rotationRank(live.username, live.id);
  }
  if (lastUsername) return rotationRank(lastUsername, lastStaffId ?? 0);
  return 1000 + (lastStaffId as number);
}

function nextInRotation(eligible: RotationStaff[], lastRank: number | null): RotationStaff {
  const ordered = [...eligible].sort(compareRotation);
  if (lastRank == null) return ordered[0];
  return ordered.find((person) => rotationRank(person.username, person.id) > lastRank) ?? ordered[0];
}

function excludedUsernames(): string[] {
  return AUTO_ASSIGN_EXCLUDED_USERNAMES.map((name) => name.toLowerCase());
}

/** 有冇至少一位可以自動派單嘅在職同事。唔推進游標。 */
export function hasEligibleAutoAssignStaff(): boolean {
  const excluded = excludedUsernames();
  const excludedSql = excluded.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM staff
       WHERE active = 1 AND lower(username) NOT IN (${excludedSql})
       LIMIT 1`
    )
    .get(...excluded) as { ok: number } | undefined;
  return row != null;
}

function chooseNextStaffId(): number | null {
  db.prepare(
    `INSERT INTO auto_assign_state (id, last_staff_id, last_username, version)
     VALUES (1, NULL, NULL, 0)
     ON CONFLICT (id) DO NOTHING`
  ).run();

  const stateSql = usingPostgres
    ? `SELECT last_staff_id, last_username, version FROM auto_assign_state WHERE id = 1 FOR UPDATE`
    : `SELECT last_staff_id, last_username, version FROM auto_assign_state WHERE id = 1`;
  const state = db.prepare(stateSql).get() as RotationCursor | undefined;
  if (!state) throw new Error("auto_assign_state 缺少游標列");

  const excluded = excludedUsernames();
  const excludedSql = excluded.map(() => "?").join(", ");
  const eligible = db
    .prepare(
      `SELECT id, username FROM staff
       WHERE active = 1 AND lower(username) NOT IN (${excludedSql})`
    )
    .all(...excluded) as RotationStaff[];
  if (eligible.length === 0) return null;

  const chosen = nextInRotation(eligible, cursorRank(state.last_staff_id, state.last_username));
  const updated = db
    .prepare(
      `UPDATE auto_assign_state
       SET last_staff_id = ?,
           last_username = ?,
           version = version + 1,
           updated_at = datetime('now')
       WHERE id = 1 AND version = ?`
    )
    .run(chosen.id, chosen.username.toLowerCase(), Number(state.version));
  if (updated.changes !== 1) throw new AutoAssignConflict();
  return chosen.id;
}

/**
 * 下一位自動派單同事。唔睇 open／in_progress。
 * 次序：Eddie → Wing → Jason → 其他 active 同事（staff.id 升序）。
 * Tony、Benjamin、Vivian、Ken 同 active = 0 唔參與。Eddie 雖然係管理員都參與。
 * 公司 WhatsApp 總機入站、網站留言 ingest、同未派留言補派都用呢條。
 * 同事個人 WhatsApp 唔經呢度。
 * 游標同今次選擇一齊提交；呼叫方如果包住 transaction，失敗會一齊回滾。
 * 冇游標時由第一位符合資格嘅同事開始（通常係 Eddie）。
 * 上一位已停用、被排除或帳號冇咗，就由佢個位之後下一位仍然符合資格嘅同事接。
 */
export function pickNextAutoAssignStaffId(): number | null {
  const wrapped = db.transaction(chooseNextStaffId);
  const run = usingPostgres ? wrapped : () => wrapped.immediate();
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      return run();
    } catch (err) {
      if (!(err instanceof AutoAssignConflict) || attempt === 8) throw err;
    }
  }
  throw new AutoAssignConflict();
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
    const staffId = pickNextAutoAssignStaffId();
    if (staffId == null) break;
    update.run(staffId, c.id);
    n += 1;
  }
  return n;
}
