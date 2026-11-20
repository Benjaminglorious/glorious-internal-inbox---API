import { db } from "../db";
import {
  REPLY_SLA_CHECK_MS,
  REPLY_SLA_FIRST_SUSPEND_DAYS,
  REPLY_SLA_FIRST_SUSPEND_MS,
  REPLY_SLA_LATER_SUSPEND_DAYS,
  REPLY_SLA_LATER_SUSPEND_MS,
  REPLY_SLA_NOTIFY_USERNAMES,
  REPLY_SLA_STRIKES,
} from "../reply-sla-config";
import { isAutoAssignExcluded } from "./assign";
import { computeReplyDeadline, formatUtcTimestamp } from "./reply-sla-clock";
import { pushToStaff } from "./push";
import { formatStaffTimestamp, parseStoredTimestamp } from "../time";

/**
 * 每則未完成對話入面、尚未有同事回覆的客戶入站（新留言，或者之後嘅 inbound 再留言）
 * 都要現任負責人回覆。已完成（done）的對話唔計。已經有較後同事回覆的維持達標，唔當逾時。
 * 上線前送到的訊息由檢查器第一次跑的瞬間重新計時（reply_sla_epoch），
 * 唔計之前等咗幾多日，亦唔會一上線就當逾時。重啟唔改呢個瞬間。
 * 已經記低的達標、逾時或跳過唔會重開。上線後的新訊息由送到開始計。
 * 夜晚窗 23:00–09:00 一樣暫停。
 * 如果開了期限但每次寫入同事狀態都失敗，那些在第一次可以寫入
 * （reply_sla_epoch.settlement_live_at）之前已過期、又未曾有結果的個案：
 * 已經有同事回覆或已完成就關閉，唔補記逾時；仍未回覆就按同一套計時規則
 * 由呢次檢查重新計，唔會即時逾時或暫停派單。之後先到期的期限照正常記。
 * 期限一過又未有同事 outbound，就記一次逾時。同一則入站只記一次。
 * 逾時計喺期限到期嗰刻嘅負責人；之後改派唔會再計多次。
 * 未有負責人就唔計入任何同事，但仍然通知管理員。
 *
 * 公司線都可以未派：冇人可派、跟進併入一條本來未派嘅對話、未知或已停用線路、
 * 管理員人手清走負責人。呢啲情況唔會當某位同事逾時。
 *
 * 同事回覆 = comment_replies direction outbound 而且 staff_id 有值。
 * 客戶再留言、系統冇員工 id 嘅訊息都唔算。Meta echo 喺 webhook 已經丟棄；
 * 電郵自動回覆唔會入庫。
 *
 * 第一次累積 3 次逾時暫停公司線自動派單 3 日；之後每次再累積 3 次暫停 7 日。
 * suspensions_started 記已經開過幾次，重啟都記得。每次開始暫停都把本輪次數歸零。
 * 2026-11-20 一次過重置（resetStaffReplySlaOnce）會清走而家嘅暫停同本輪次數，
 * 並把 suspensions_started 未滿 1 的人設成 1，所以重置之後下一輪係 7 日，唔會再當第一次 3 日。
 * 呢次重置唔會郁 reply_sla、reply_sla_epoch 或留言內容。標記喺 app_boot_once，只跑一次。
 * 暫停只係唔再入公司線輪流。登入同已派咗嘅留言唔會收。
 * 七日到期靠資料庫嘅 suspended_until 同而家時間比較，唔靠記憶體旗標。
 * 清理欄位失敗都唔會擋住派單。伺服器喺暫停期間重啟，到期一樣自動回到輪流。
 */

const DISCOVER_LIMIT = 100;
const DUE_LIMIT = 50;
const NOTICE_LIMIT = 20;

export interface ReplySlaScanResult {
  restored: number;
  opened: number;
  met: number;
  delays: number;
}

export interface SlaNoticePush {
  staffIds: number[];
  title: string;
  body: string;
  url: string;
  tag: string;
}

type SlaPush = (input: SlaNoticePush) => void;

let pushImpl: SlaPush = (input) => {
  pushToStaff(input.staffIds, input);
};

/** 測試可以換走推送。傳 null 就還原做 Web Push。 */
export function setReplySlaPush(next: SlaPush | null): void {
  pushImpl = next ?? ((input) => pushToStaff(input.staffIds, input));
}

interface SlaCaseRow {
  id: number;
  comment_id: number;
  inbound_reply_id: number | null;
  inbound_at: string;
  due_at: string;
  met_at: string | null;
  delay_recorded_at: string | null;
}

interface StaffStateRow {
  delay_count: number;
  suspended_from: string | null;
  suspended_until: string | null;
  suspensions_started: number;
}

interface NoticeStaff {
  id: number;
  username: string;
  display_name: string;
  active: number;
}

/**
 * 到期嘅暫停清走欄位，逾時次數留低（暫停期間新逾時係下一輪）。
 * 派單唔依賴呢次清理：輪流直接比較 suspended_until。
 */
export function restoreExpiredSuspensions(now: Date): number {
  const stamp = formatUtcTimestamp(now);
  const result = db
    .prepare(
      `UPDATE staff_reply_sla
       SET suspended_from = NULL,
           suspended_until = NULL,
           updated_at = ?
       WHERE suspended_until IS NOT NULL
         AND suspended_until <= ?`
    )
    .run(stamp, stamp);
  return result.changes;
}

export interface StaffSlaOverview {
  delayCount: number;
  /** 仍然生效嘅暫停到期（UTC 文字）。已到期或未暫停係 null。 */
  suspendedUntil: string | null;
  /** 而家呢次暫停係 3 日定 7 日。未暫停係 null。 */
  suspendDays: 3 | 7 | null;
  poolExcluded: boolean;
}

export function loadStaffSlaOverview(now = new Date()): Map<number, StaffSlaOverview> {
  const stamp = formatUtcTimestamp(now);
  const rows = db
    .prepare(
      `SELECT s.id, s.username,
              COALESCE(sla.delay_count, 0) AS delay_count,
              sla.suspended_until AS suspended_until,
              COALESCE(sla.suspensions_started, 0) AS suspensions_started
       FROM staff s
       LEFT JOIN staff_reply_sla sla ON sla.staff_id = s.id`
    )
    .all() as Array<{
    id: number;
    username: string;
    delay_count: number;
    suspended_until: string | null;
    suspensions_started: number;
  }>;
  const map = new Map<number, StaffSlaOverview>();
  for (const row of rows) {
    const until = row.suspended_until && row.suspended_until > stamp ? row.suspended_until : null;
    const started = Number(row.suspensions_started) || 0;
    map.set(Number(row.id), {
      delayCount: Number(row.delay_count) || 0,
      suspendedUntil: until,
      suspendDays: until ? (started >= 2 ? 7 : 3) : null,
      poolExcluded: isAutoAssignExcluded(row.username),
    });
  }
  return map;
}

export interface OwnSlaStatus {
  delay_count: number;
  suspended: boolean;
  suspend_days: 3 | 7 | null;
  suspended_until: string | null;
  banner: string | null;
}

/** 同事自己嘅留言箱用。暫停到期就冇 banner。 */
export function ownSlaStatus(staffId: number, now = new Date()): OwnSlaStatus {
  const empty: OwnSlaStatus = {
    delay_count: 0,
    suspended: false,
    suspend_days: null,
    suspended_until: null,
    banner: null,
  };
  if (!Number.isInteger(staffId) || staffId <= 0) return empty;
  const row = db
    .prepare(
      `SELECT s.username, COALESCE(sla.delay_count, 0) AS delay_count,
              sla.suspended_until AS suspended_until,
              COALESCE(sla.suspensions_started, 0) AS suspensions_started
       FROM staff s
       LEFT JOIN staff_reply_sla sla ON sla.staff_id = s.id
       WHERE s.id = ?`
    )
    .get(staffId) as
    | {
        username: string;
        delay_count: number;
        suspended_until: string | null;
        suspensions_started: number;
      }
    | undefined;
  if (!row) return empty;
  const stamp = formatUtcTimestamp(now);
  const active =
    !isAutoAssignExcluded(row.username) &&
    row.suspended_until != null &&
    row.suspended_until > stamp;
  const started = Number(row.suspensions_started) || 0;
  const suspendDays: 3 | 7 | null = active ? (started >= 2 ? 7 : 3) : null;
  const untilLabel = active && row.suspended_until ? formatStaffTimestamp(row.suspended_until, "utc") : null;
  const banner =
    active && suspendDays && untilLabel
      ? `你已累積 3 次逾時回覆。自動派單已暫停${suspendDays === 3 ? "三日" : "七日"}，至 ${untilLabel} 到期自動恢復。`
      : null;
  return {
    delay_count: Number(row.delay_count) || 0,
    suspended: active,
    suspend_days: suspendDays,
    suspended_until: untilLabel,
    banner,
  };
}

/** 仍然未有同事回覆的已逾時入站。assigneeStaffId 為 null 就係全部。 */
export function overdueUnansweredCommentIds(assigneeStaffId: number | null): Set<number> {
  const sql = `SELECT DISTINCT s.comment_id AS id
     FROM reply_sla s
     JOIN comments c ON c.id = s.comment_id
     WHERE s.delay_recorded_at IS NOT NULL
       AND s.skipped_at IS NULL
       AND c.status != 'done'
       ${assigneeStaffId == null ? "" : "AND c.assignee_staff_id = ?"}
       AND NOT EXISTS (
         SELECT 1 FROM comment_replies r
         WHERE r.comment_id = s.comment_id
           AND r.direction = 'outbound'
           AND r.staff_id IS NOT NULL
           AND (
             (s.inbound_reply_id IS NULL AND r.created_at >= s.inbound_at)
             OR (
               s.inbound_reply_id IS NOT NULL
               AND (r.created_at > s.inbound_at OR (r.created_at = s.inbound_at AND r.id > s.inbound_reply_id))
             )
           )
       )`;
  const rows = (
    assigneeStaffId == null ? db.prepare(sql).all() : db.prepare(sql).all(assigneeStaffId)
  ) as Array<{ id: number }>;
  return new Set(rows.map((row) => Number(row.id)));
}

export function latestSlaNoticeId(staffId: number): number {
  if (!Number.isInteger(staffId) || staffId <= 0) return 0;
  const row = db
    .prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM staff_notices WHERE staff_id = ?`)
    .get(staffId) as { id: number };
  return Number(row.id) || 0;
}

export interface SlaNoticeItem {
  id: number;
  title: string;
  body: string;
  url: string;
  comment_id: number | null;
}

export function listSlaNotices(
  staffId: number,
  sinceId: number | null
): { latest_id: number; notices: SlaNoticeItem[]; has_more: boolean } {
  const latest_id = latestSlaNoticeId(staffId);
  if (sinceId == null || !Number.isInteger(staffId) || staffId <= 0) {
    return { latest_id, notices: [], has_more: false };
  }
  const rows = db
    .prepare(
      `SELECT id, title, body, url, comment_id
       FROM staff_notices
       WHERE staff_id = ? AND id > ?
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(staffId, sinceId, NOTICE_LIMIT + 1) as SlaNoticeItem[];
  const has_more = rows.length > NOTICE_LIMIT;
  return {
    latest_id,
    notices: has_more ? rows.slice(0, NOTICE_LIMIT) : rows,
    has_more,
  };
}

function parseUtc(value: string): Date | null {
  return parseStoredTimestamp(value, "utc");
}

function ensureReplySlaEpoch(now: Date): Date {
  const stamp = formatUtcTimestamp(now);
  const inserted = db
    .prepare(`INSERT INTO reply_sla_epoch (id, effective_at) VALUES (1, ?) ON CONFLICT(id) DO NOTHING`)
    .run(stamp);
  const row = db.prepare(`SELECT effective_at FROM reply_sla_epoch WHERE id = 1`).get() as
    | { effective_at: string }
    | undefined;
  if (!row) throw new Error("reply_sla_epoch 缺少生效時間");
  if (inserted.changes === 1) {
    console.log(
      `[sla] 已記錄回覆時限生效時間 ${row.effective_at} UTC。未完成而尚未回覆的舊訊息由呢刻重新計時。`
    );
  }
  const parsed = parseUtc(row.effective_at);
  if (!parsed) throw new Error("reply_sla_epoch 時間無法解析");
  return parsed;
}

function insertCase(
  commentId: number,
  inboundReplyId: number | null,
  inboundAt: string,
  inbound: Date,
  effective: Date
): boolean {
  const deadline = computeReplyDeadline(inbound, effective);
  const countStart = formatUtcTimestamp(deadline.countStart);
  const due = formatUtcTimestamp(deadline.due);
  const sql =
    inboundReplyId == null
      ? `INSERT INTO reply_sla (
           comment_id, inbound_reply_id, inbound_at, count_start_at, due_at, limit_seconds
         )
         SELECT ?, NULL, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM reply_sla WHERE comment_id = ? AND inbound_reply_id IS NULL
         )`
      : `INSERT INTO reply_sla (
           comment_id, inbound_reply_id, inbound_at, count_start_at, due_at, limit_seconds
         )
         SELECT ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM reply_sla WHERE inbound_reply_id = ?
         )`;
  const params =
    inboundReplyId == null
      ? [commentId, inboundAt, countStart, due, deadline.limitSeconds, commentId]
      : [commentId, inboundReplyId, inboundAt, countStart, due, deadline.limitSeconds, inboundReplyId];
  const result = db.prepare(sql).run(...params);
  return result.changes === 1;
}

function discoverCases(effective: Date): number {
  let opened = 0;
  const comments = db
    .prepare(
      `SELECT c.id, c.created_at
       FROM comments c
       WHERE c.status != 'done'
         AND NOT EXISTS (
           SELECT 1 FROM reply_sla s
           WHERE s.comment_id = c.id AND s.inbound_reply_id IS NULL
         )
       ORDER BY c.id ASC
       LIMIT ?`
    )
    .all(DISCOVER_LIMIT) as Array<{ id: number; created_at: string }>;
  for (const row of comments) {
    const inbound = parseUtc(row.created_at);
    if (!inbound) {
      console.error(`[sla] 留言 #${row.id} 的時間無法解析，跳過`);
      continue;
    }
    try {
      if (insertCase(row.id, null, row.created_at, inbound, effective)) opened += 1;
    } catch (err) {
      console.error(`[sla] 無法為留言 #${row.id} 開期限`, err instanceof Error ? err.message : err);
    }
  }

  const followUps = db
    .prepare(
      `SELECT r.id, r.comment_id, r.created_at
       FROM comment_replies r
       JOIN comments c ON c.id = r.comment_id
       WHERE r.direction = 'inbound'
         AND c.status != 'done'
         AND NOT EXISTS (SELECT 1 FROM reply_sla s WHERE s.inbound_reply_id = r.id)
       ORDER BY r.id ASC
       LIMIT ?`
    )
    .all(DISCOVER_LIMIT) as Array<{ id: number; comment_id: number; created_at: string }>;
  for (const row of followUps) {
    const inbound = parseUtc(row.created_at);
    if (!inbound) {
      console.error(`[sla] 客戶訊息 #${row.id} 的時間無法解析，跳過`);
      continue;
    }
    try {
      if (insertCase(row.comment_id, row.id, row.created_at, inbound, effective)) opened += 1;
    } catch (err) {
      console.error(`[sla] 無法為客戶訊息 #${row.id} 開期限`, err instanceof Error ? err.message : err);
    }
  }
  return opened;
}

interface StaffReplyHit {
  id: number;
  created_at: string;
}

function firstStaffReply(row: SlaCaseRow): StaffReplyHit | undefined {
  if (row.inbound_reply_id == null) {
    return db
      .prepare(
        `SELECT id, created_at
         FROM comment_replies
         WHERE comment_id = ?
           AND direction = 'outbound'
           AND staff_id IS NOT NULL
           AND created_at >= ?
         ORDER BY created_at ASC, id ASC
         LIMIT 1`
      )
      .get(row.comment_id, row.inbound_at) as StaffReplyHit | undefined;
  }
  return db
    .prepare(
      `SELECT id, created_at
       FROM comment_replies
       WHERE comment_id = ?
         AND direction = 'outbound'
         AND staff_id IS NOT NULL
         AND (created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at ASC, id ASC
       LIMIT 1`
    )
    .get(row.comment_id, row.inbound_at, row.inbound_at, row.inbound_reply_id) as StaffReplyHit | undefined;
}

function noticeRecipients(): NoticeStaff[] {
  const rows = db
    .prepare(`SELECT id, username, display_name, active FROM staff ORDER BY id ASC`)
    .all() as NoticeStaff[];
  const byUser = new Map<string, NoticeStaff>();
  for (const row of rows) byUser.set(row.username.toLowerCase(), row);
  const picked: NoticeStaff[] = [];
  const missing: string[] = [];
  for (const name of REPLY_SLA_NOTIFY_USERNAMES) {
    let row = byUser.get(name);
    if (!row && name === "eddie") {
      row = rows.find((item) => item.display_name.trim().toLowerCase() === "eddie lau");
    }
    if (!row && name === "benjamin") {
      row = rows.find((item) => item.display_name.trim().toLowerCase() === "benjamin");
    }
    if (!row && name === "tony") {
      row = rows.find((item) => item.display_name.trim().toLowerCase() === "tony chan");
    }
    if (!row || !row.active) {
      missing.push(name);
      continue;
    }
    picked.push(row);
  }
  if (missing.length) console.warn(`[sla] 搵唔到在職通知同事：${missing.join("、")}`);
  return picked;
}

function whichInbound(inboundReplyId: number | null): string {
  return inboundReplyId == null ? "客戶首則" : `客戶訊息 #${inboundReplyId}`;
}

function pausePhrase(days: 3 | 7): string {
  return days === REPLY_SLA_FIRST_SUSPEND_DAYS ? "三日" : "七日";
}

function overdueText(input: {
  staffName: string;
  commentId: number;
  inboundReplyId: number | null;
  suspended: boolean;
  suspendDays: 3 | 7 | null;
  unassigned: boolean;
}): string {
  const which = whichInbound(input.inboundReplyId);
  const lead = input.unassigned
    ? `未有負責人。留言 #${input.commentId}（${which}）回覆已逾時，仍未有同事回覆。這次沒有計入同事逾時次數。`
    : `${input.staffName} 回覆已逾時。留言 #${input.commentId}（${which}）已超過回覆時限，仍未有同事回覆。`;
  if (!input.suspended || !input.suspendDays) return lead;
  return `${lead}${input.staffName} 已累積 ${REPLY_SLA_STRIKES} 次逾時，暫停自動派單${pausePhrase(input.suspendDays)}。`;
}

function assigneeOverdueText(input: {
  commentId: number;
  inboundReplyId: number | null;
  delayCount: number;
  suspended: boolean;
  suspendDays: 3 | 7 | null;
}): string {
  const which = whichInbound(input.inboundReplyId);
  const lead = `你的回覆已逾時。留言 #${input.commentId}（${which}）已超過回覆時限，仍未有同事回覆。`;
  if (input.suspended && input.suspendDays) {
    return `${lead}你已累積 ${REPLY_SLA_STRIKES} 次逾時，自動派單暫停${pausePhrase(input.suspendDays)}，到期自動恢復。`;
  }
  return `${lead}你而家累積 ${input.delayCount}/${REPLY_SLA_STRIKES} 次逾時。`;
}

/**
 * 一次過重置的標記。唔好改：改 key 會令下次啟動再清一次本輪次數。
 * 只代表「2026-11-20 清走暫停，並把第一輪當已用過」。
 */
export const STAFF_SLA_RESET_ONCE_KEY = "staff_reply_sla_clear_20261120";

export interface StaffSlaResetResult {
  applied: boolean;
  /** 今次寫入嘅同事列數。已經跑過就係 0。 */
  staff: number;
}

/**
 * 清走全部同事而家嘅暫停同本輪逾時次數，並保證下次 3 次逾時暫停 7 日。
 * suspensions_started 未滿 1 的人設成 1；已經大過或等於 1 的輪次保留，唔會倒退成第一次 3 日。
 * 唔會開新期限、唔會改 reply_sla／reply_sla_epoch、唔會改留言或補記逾時。
 * 標記同更新同一筆交易：失敗會一齊回滾，下次啟動先再試。標記寫入之後唔會再清。
 */
export function resetStaffReplySlaOnce(now = new Date()): StaffSlaResetResult {
  const stamp = formatUtcTimestamp(now);
  return db.transaction((): StaffSlaResetResult => {
    const claim = db
      .prepare(`INSERT INTO app_boot_once (key, applied_at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`)
      .run(STAFF_SLA_RESET_ONCE_KEY, stamp);
    if (claim.changes !== 1) return { applied: false, staff: 0 };
    const result = db
      .prepare(
        `INSERT INTO staff_reply_sla (
           staff_id, delay_count, suspended_from, suspended_until, suspensions_started, updated_at
         )
         SELECT
           s.id,
           0,
           NULL,
           NULL,
           CASE WHEN COALESCE(sla.suspensions_started, 0) < 1 THEN 1 ELSE sla.suspensions_started END,
           ?
         FROM staff s
         LEFT JOIN staff_reply_sla sla ON sla.staff_id = s.id
         ON CONFLICT(staff_id) DO UPDATE SET
           delay_count = 0,
           suspended_from = NULL,
           suspended_until = NULL,
           suspensions_started = excluded.suspensions_started,
           updated_at = excluded.updated_at`
      )
      .run(stamp);
    return { applied: true, staff: result.changes };
  })();
}

/** staff_reply_sla 的主鍵係 staff_id，冇 id 欄。Postgres 包裝唔可以再補 RETURNING id。 */
export const STAFF_REPLY_SLA_UPSERT_SQL = `INSERT INTO staff_reply_sla (
       staff_id, delay_count, suspended_from, suspended_until, suspensions_started, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(staff_id) DO UPDATE SET
       delay_count = excluded.delay_count,
       suspended_from = excluded.suspended_from,
       suspended_until = excluded.suspended_until,
       suspensions_started = excluded.suspensions_started,
       updated_at = excluded.updated_at`;

function upsertStaffState(
  staffId: number,
  delayCount: number,
  suspendedFrom: string | null,
  suspendedUntil: string | null,
  suspensionsStarted: number,
  stamp: string
): void {
  db.prepare(STAFF_REPLY_SLA_UPSERT_SQL).run(
    staffId,
    delayCount,
    suspendedFrom,
    suspendedUntil,
    suspensionsStarted,
    stamp
  );
}

function settleOne(caseId: number, now: Date, allowDelay: boolean): "met" | "delay" | "skip" | "open" {
  const settled = db.transaction((): { kind: "met" | "delay" | "skip" | "open"; pushes: SlaNoticePush[] } => {
    const row = db
      .prepare(
        `SELECT id, comment_id, inbound_reply_id, inbound_at, due_at, met_at, delay_recorded_at
         FROM reply_sla WHERE id = ?`
      )
      .get(caseId) as SlaCaseRow | undefined;
    if (!row || row.met_at || row.delay_recorded_at) return { kind: "skip", pushes: [] };
    const skippedAlready = db.prepare(`SELECT skipped_at FROM reply_sla WHERE id = ?`).get(row.id) as
      | { skipped_at: string | null }
      | undefined;
    if (skippedAlready?.skipped_at) return { kind: "skip", pushes: [] };
    const reply = firstStaffReply(row);
    if (reply && reply.created_at <= row.due_at) {
      const marked = db
        .prepare(
          `UPDATE reply_sla
           SET met_at = ?, met_reply_id = ?
           WHERE id = ? AND met_at IS NULL AND delay_recorded_at IS NULL AND skipped_at IS NULL`
        )
        .run(reply.created_at, reply.id, row.id);
      return { kind: marked.changes === 1 ? "met" : "skip", pushes: [] };
    }

    const comment = db
      .prepare(`SELECT assignee_staff_id, status FROM comments WHERE id = ?`)
      .get(row.comment_id) as { assignee_staff_id: number | null; status: string } | undefined;
    const stamp = formatUtcTimestamp(now);
    if (!comment || comment.status === "done") {
      db.prepare(
        `UPDATE reply_sla
         SET skipped_at = ?
         WHERE id = ? AND met_at IS NULL AND delay_recorded_at IS NULL AND skipped_at IS NULL`
      ).run(stamp, row.id);
      return { kind: "skip", pushes: [] };
    }
    if (!allowDelay) return { kind: "open", pushes: [] };

    const staffId = comment.assignee_staff_id ?? null;
    const staff = staffId
      ? (db.prepare(`SELECT id, username, display_name, active FROM staff WHERE id = ?`).get(staffId) as
          | NoticeStaff
          | undefined)
      : undefined;
    const claimed = db
      .prepare(
        `UPDATE reply_sla
         SET delay_recorded_at = ?, delay_staff_id = ?, notified_at = ?
         WHERE id = ? AND met_at IS NULL AND delay_recorded_at IS NULL AND skipped_at IS NULL`
      )
      .run(stamp, staff ? staff.id : null, stamp, row.id);
    if (claimed.changes !== 1) return { kind: "skip", pushes: [] };

    let suspended = false;
    let suspendDays: 3 | 7 | null = null;
    let assigneeCount = 0;
    if (staff) {
      const existing = db
        .prepare(
          `SELECT delay_count, suspended_from, suspended_until, suspensions_started
           FROM staff_reply_sla WHERE staff_id = ?`
        )
        .get(staff.id) as StaffStateRow | undefined;
      const count = (existing ? Number(existing.delay_count) : 0) + 1;
      const started = existing ? Number(existing.suspensions_started) || 0 : 0;
      assigneeCount = count;
      if (isAutoAssignExcluded(staff.username)) {
        upsertStaffState(staff.id, count, null, null, started, stamp);
      } else if (count >= REPLY_SLA_STRIKES) {
        suspendDays = started === 0 ? REPLY_SLA_FIRST_SUSPEND_DAYS : REPLY_SLA_LATER_SUSPEND_DAYS;
        const span = suspendDays === REPLY_SLA_FIRST_SUSPEND_DAYS ? REPLY_SLA_FIRST_SUSPEND_MS : REPLY_SLA_LATER_SUSPEND_MS;
        const until = formatUtcTimestamp(new Date(now.getTime() + span));
        upsertStaffState(staff.id, 0, stamp, until, started + 1, stamp);
        suspended = true;
        assigneeCount = REPLY_SLA_STRIKES;
      } else {
        upsertStaffState(
          staff.id,
          count,
          existing?.suspended_from ?? null,
          existing?.suspended_until ?? null,
          started,
          stamp
        );
      }
    }

    const adminBody = overdueText({
      staffName: staff?.display_name || "未有負責人",
      commentId: row.comment_id,
      inboundReplyId: row.inbound_reply_id,
      suspended,
      suspendDays,
      unassigned: !staff,
    });
    const recipients = noticeRecipients();
    const url = `/comments/${row.comment_id}`;
    const tag = `sla-${row.id}`.slice(0, 64);
    const drafts: Array<{ staffId: number; title: string; body: string }> = recipients.map((recipient) => ({
      staffId: recipient.id,
      title: "回覆逾時",
      body: adminBody,
    }));
    if (staff && !recipients.some((recipient) => recipient.id === staff.id)) {
      drafts.push({
        staffId: staff.id,
        title: "你的回覆已逾時",
        body: assigneeOverdueText({
          commentId: row.comment_id,
          inboundReplyId: row.inbound_reply_id,
          delayCount: assigneeCount,
          suspended,
          suspendDays,
        }),
      });
    }
    for (const draft of drafts) {
      db.prepare(
        `INSERT INTO staff_notices (staff_id, kind, title, body, url, comment_id)
         VALUES (?, 'reply_sla', ?, ?, ?, ?)`
      ).run(draft.staffId, draft.title, draft.body, url, row.comment_id);
    }
    const pushes: SlaNoticePush[] = [];
    for (const draft of drafts) {
      const same = pushes.find((item) => item.body === draft.body && item.title === draft.title);
      if (same) same.staffIds.push(draft.staffId);
      else pushes.push({ staffIds: [draft.staffId], title: draft.title, body: draft.body, url, tag });
    }
    return { kind: "delay", pushes };
  })();

  if (settled.kind === "delay") {
    for (const push of settled.pushes) {
      if (!push.staffIds.length) continue;
      try {
        pushImpl(push);
      } catch (err) {
        console.error("[sla] 推送失敗", err instanceof Error ? err.message : err);
      }
    }
  }
  return settled.kind;
}

/**
 * 第一次可以成功寫入同事逾時狀態的 UTC 時間。只寫一次，重啟唔改。
 * 在這之前的失敗檢查可能已經開了期限，但逾時次數同暫停從未提交。
 */
function ensureSettlementLive(now: Date): Date {
  const existing = db.prepare(`SELECT settlement_live_at FROM reply_sla_epoch WHERE id = 1`).get() as
    | { settlement_live_at: string | null }
    | undefined;
  if (!existing) throw new Error("reply_sla_epoch 缺少生效時間");
  if (existing.settlement_live_at) {
    const parsed = parseUtc(existing.settlement_live_at);
    if (!parsed) throw new Error("reply_sla_epoch 可寫入時間無法解析");
    return parsed;
  }
  const stamp = formatUtcTimestamp(now);
  db.prepare(
    `UPDATE reply_sla_epoch SET settlement_live_at = ? WHERE id = 1 AND settlement_live_at IS NULL`
  ).run(stamp);
  const row = db.prepare(`SELECT settlement_live_at FROM reply_sla_epoch WHERE id = 1`).get() as
    | { settlement_live_at: string | null }
    | undefined;
  if (!row?.settlement_live_at) throw new Error("reply_sla_epoch 缺少可寫入時間");
  console.log(
    `[sla] 由 ${row.settlement_live_at} UTC 開始先會寫入逾時結果。在這之前已過期、但檢查失敗未記低的個案，唔會因為補跑而即時逾時或暫停派單。`
  );
  const parsed = parseUtc(row.settlement_live_at);
  if (!parsed) throw new Error("reply_sla_epoch 可寫入時間無法解析");
  return parsed;
}

/**
 * 寫入同事狀態之前已經失敗的檢查，唔好喺第一次成功時一次過追討。
 * 只處理期限早於或剛好等於 settlement_live_at、而且尚未有結果的個案：
 * 已完成就跳過；已經有同事回覆就當達標，唔補記一次逾時；
 * 仍未回覆就用同一套計時規則由呢次檢查重新計，今次唔當逾時。
 * settlement_live_at 之後先到期的期限唔會改。
 */
function releaseCasesMissedWhileCheckerFailed(liveAt: Date, now: Date): { rebased: number; answered: number; skipped: number } {
  const live = formatUtcTimestamp(liveAt);
  const rows = db
    .prepare(
      `SELECT id, comment_id, inbound_reply_id, inbound_at, due_at, met_at, delay_recorded_at
       FROM reply_sla
       WHERE met_at IS NULL
         AND delay_recorded_at IS NULL
         AND skipped_at IS NULL
         AND due_at <= ?`
    )
    .all(live) as SlaCaseRow[];
  if (!rows.length) return { rebased: 0, answered: 0, skipped: 0 };
  const notBefore = now.getTime() > liveAt.getTime() ? now : liveAt;
  const notBeforeStamp = formatUtcTimestamp(notBefore);
  let rebased = 0;
  let answered = 0;
  let skipped = 0;
  for (const row of rows) {
    const comment = db.prepare(`SELECT status FROM comments WHERE id = ?`).get(row.comment_id) as
      | { status: string }
      | undefined;
    if (!comment || comment.status === "done") {
      const result = db
        .prepare(
          `UPDATE reply_sla
           SET skipped_at = ?
           WHERE id = ? AND met_at IS NULL AND delay_recorded_at IS NULL AND skipped_at IS NULL`
        )
        .run(notBeforeStamp, row.id);
      if (result.changes === 1) skipped += 1;
      continue;
    }
    const reply = firstStaffReply(row);
    if (reply) {
      const marked = db
        .prepare(
          `UPDATE reply_sla
           SET met_at = ?, met_reply_id = ?
           WHERE id = ? AND met_at IS NULL AND delay_recorded_at IS NULL AND skipped_at IS NULL`
        )
        .run(reply.created_at, reply.id, row.id);
      if (marked.changes === 1) answered += 1;
      continue;
    }
    const inbound = parseUtc(row.inbound_at);
    if (!inbound) {
      console.error(`[sla] 留言 #${row.comment_id} 的時間無法解析，跳過重計`);
      continue;
    }
    const deadline = computeReplyDeadline(inbound, notBefore);
    const updated = db
      .prepare(
        `UPDATE reply_sla
         SET count_start_at = ?, due_at = ?, limit_seconds = ?
         WHERE id = ?
           AND met_at IS NULL
           AND delay_recorded_at IS NULL
           AND skipped_at IS NULL
           AND due_at <= ?`
      )
      .run(
        formatUtcTimestamp(deadline.countStart),
        formatUtcTimestamp(deadline.due),
        deadline.limitSeconds,
        row.id,
        live
      );
    if (updated.changes === 1) rebased += 1;
  }
  if (rebased > 0 || answered > 0 || skipped > 0) {
    console.log(
      `[sla] 檢查先前未能寫入逾時。${answered} 則已有同事回覆，不當逾時；${skipped} 則已完成，已跳過；${rebased} 則仍未回覆，由 ${notBeforeStamp} UTC 按原有計時規則重新計。今次未記逾時，亦未暫停派單。`
    );
  }
  return { rebased, answered, skipped };
}

function reconcileOpenCases(now: Date): { met: number } {
  const rows = db
    .prepare(
      `SELECT id
       FROM reply_sla
       WHERE met_at IS NULL AND delay_recorded_at IS NULL AND skipped_at IS NULL
       ORDER BY due_at ASC, id ASC
       LIMIT ?`
    )
    .all(DISCOVER_LIMIT) as Array<{ id: number }>;
  let met = 0;
  for (const row of rows) {
    if (settleOne(row.id, now, false) === "met") met += 1;
  }
  return { met };
}

function settleDueCases(now: Date): { met: number; delays: number } {
  const stamp = formatUtcTimestamp(now);
  const due = db
    .prepare(
      `SELECT id
       FROM reply_sla
       WHERE met_at IS NULL
         AND delay_recorded_at IS NULL
         AND skipped_at IS NULL
         AND due_at <= ?
       ORDER BY due_at ASC, id ASC
       LIMIT ?`
    )
    .all(stamp, DUE_LIMIT) as Array<{ id: number }>;
  let met = 0;
  let delays = 0;
  for (const row of due) {
    const kind = settleOne(row.id, now, true);
    if (kind === "met") met += 1;
    else if (kind === "delay") delays += 1;
  }
  return { met, delays };
}

/** 開新期限、記準時回覆、記逾時、清走到期暫停。可以重入，同一則入站唔會通知兩次。 */
export function scanReplySla(now = new Date()): ReplySlaScanResult {
  const restored = restoreExpiredSuspensions(now);
  const effective = ensureReplySlaEpoch(now);
  const liveAt = ensureSettlementLive(now);
  const opened = discoverCases(effective);
  releaseCasesMissedWhileCheckerFailed(liveAt, now);
  const reconciled = reconcileOpenCases(now);
  const settled = settleDueCases(now);
  return { restored, opened, met: reconciled.met + settled.met, delays: settled.delays };
}

let checkerStarted = false;
let checkerRunning = false;

/** 跟住網頁進程行。啟動先清走到期暫停，之後每 20 秒再檢查。 */
export function startReplySlaChecker(): void {
  if (checkerStarted) return;
  checkerStarted = true;
  console.log(
    `[sla] 回覆時限每 ${REPLY_SLA_CHECK_MS / 1000} 秒檢查一次。未覆舊訊息由第一次檢查重新計時。暫停七日後自動恢復輪候。`
  );
  const tick = () => {
    if (checkerRunning) return;
    checkerRunning = true;
    try {
      const result = scanReplySla(new Date());
      if (result.delays > 0) console.log(`[sla] 已記錄 ${result.delays} 次回覆逾時`);
      if (result.restored > 0) console.log(`[sla] ${result.restored} 位同事暫停到期，已回到自動派單`);
    } catch (err) {
      console.error("[sla] 檢查失敗", err instanceof Error ? err.message : err);
    } finally {
      checkerRunning = false;
    }
  };
  try {
    const restored = restoreExpiredSuspensions(new Date());
    if (restored > 0) console.log(`[sla] 啟動時 ${restored} 位同事暫停已到期，回到自動派單`);
  } catch (err) {
    console.error("[sla] 啟動時無法清理到期暫停", err instanceof Error ? err.message : err);
  }
  setTimeout(tick, 5000).unref();
  setInterval(tick, REPLY_SLA_CHECK_MS).unref();
}
