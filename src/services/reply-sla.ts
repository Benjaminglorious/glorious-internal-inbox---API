import { db } from "../db";
import {
  REPLY_SLA_CHECK_MS,
  REPLY_SLA_NOTIFY_USERNAMES,
  REPLY_SLA_START_HKT,
  REPLY_SLA_START_UTC,
  REPLY_SLA_STRIKES,
  REPLY_SLA_SUSPEND_MS,
} from "../reply-sla-config";
import { isAutoAssignExcluded } from "./assign";
import { computeReplyDeadline, formatUtcTimestamp } from "./reply-sla-clock";
import { pushToStaff } from "./push";
import { parseStoredTimestamp } from "../time";

/**
 * 每則客戶入站（新留言，或者之後嘅 inbound 再留言）都要現任負責人回覆。
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
  poolExcluded: boolean;
}

export function loadStaffSlaOverview(now = new Date()): Map<number, StaffSlaOverview> {
  const stamp = formatUtcTimestamp(now);
  const rows = db
    .prepare(
      `SELECT s.id, s.username,
              COALESCE(sla.delay_count, 0) AS delay_count,
              sla.suspended_until AS suspended_until
       FROM staff s
       LEFT JOIN staff_reply_sla sla ON sla.staff_id = s.id`
    )
    .all() as Array<{
    id: number;
    username: string;
    delay_count: number;
    suspended_until: string | null;
  }>;
  const map = new Map<number, StaffSlaOverview>();
  for (const row of rows) {
    const until = row.suspended_until && row.suspended_until > stamp ? row.suspended_until : null;
    map.set(Number(row.id), {
      delayCount: Number(row.delay_count) || 0,
      suspendedUntil: until,
      poolExcluded: isAutoAssignExcluded(row.username),
    });
  }
  return map;
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

function insertCase(
  commentId: number,
  inboundReplyId: number | null,
  inboundAt: string,
  inbound: Date
): boolean {
  const deadline = computeReplyDeadline(inbound);
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

function discoverCases(): number {
  let opened = 0;
  const comments = db
    .prepare(
      `SELECT c.id, c.created_at
       FROM comments c
       WHERE c.created_at >= ?
         AND NOT EXISTS (
           SELECT 1 FROM reply_sla s
           WHERE s.comment_id = c.id AND s.inbound_reply_id IS NULL
         )
       ORDER BY c.id ASC
       LIMIT ?`
    )
    .all(REPLY_SLA_START_UTC, DISCOVER_LIMIT) as Array<{ id: number; created_at: string }>;
  for (const row of comments) {
    const inbound = parseUtc(row.created_at);
    if (!inbound) {
      console.error(`[sla] 留言 #${row.id} 的時間無法解析，跳過`);
      continue;
    }
    try {
      if (insertCase(row.id, null, row.created_at, inbound)) opened += 1;
    } catch (err) {
      console.error(`[sla] 無法為留言 #${row.id} 開期限`, err instanceof Error ? err.message : err);
    }
  }

  const followUps = db
    .prepare(
      `SELECT r.id, r.comment_id, r.created_at
       FROM comment_replies r
       WHERE r.direction = 'inbound'
         AND r.created_at >= ?
         AND NOT EXISTS (SELECT 1 FROM reply_sla s WHERE s.inbound_reply_id = r.id)
       ORDER BY r.id ASC
       LIMIT ?`
    )
    .all(REPLY_SLA_START_UTC, DISCOVER_LIMIT) as Array<{ id: number; comment_id: number; created_at: string }>;
  for (const row of followUps) {
    const inbound = parseUtc(row.created_at);
    if (!inbound) {
      console.error(`[sla] 客戶訊息 #${row.id} 的時間無法解析，跳過`);
      continue;
    }
    try {
      if (insertCase(row.comment_id, row.id, row.created_at, inbound)) opened += 1;
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

function overdueText(input: {
  staffName: string;
  commentId: number;
  inboundReplyId: number | null;
  suspended: boolean;
  unassigned: boolean;
}): string {
  const which =
    input.inboundReplyId == null ? "客戶首則" : `客戶訊息 #${input.inboundReplyId}`;
  const lead = input.unassigned
    ? `未有負責人。留言 #${input.commentId}（${which}）回覆已逾時，仍未有同事回覆。這次沒有計入同事逾時次數。`
    : `${input.staffName} 回覆已逾時。留言 #${input.commentId}（${which}）已超過回覆時限，仍未有同事回覆。`;
  if (!input.suspended) return lead;
  return `${lead}${input.staffName} 已累積 ${REPLY_SLA_STRIKES} 次逾時，暫停自動派單一星期。`;
}

function upsertStaffState(
  staffId: number,
  delayCount: number,
  suspendedFrom: string | null,
  suspendedUntil: string | null,
  stamp: string
): void {
  db.prepare(
    `INSERT INTO staff_reply_sla (staff_id, delay_count, suspended_from, suspended_until, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(staff_id) DO UPDATE SET
       delay_count = excluded.delay_count,
       suspended_from = excluded.suspended_from,
       suspended_until = excluded.suspended_until,
       updated_at = excluded.updated_at`
  ).run(staffId, delayCount, suspendedFrom, suspendedUntil, stamp);
}

function settleOne(caseId: number, now: Date): "met" | "delay" | "skip" {
  const settled = db.transaction((): { kind: "met" | "delay" | "skip"; push: SlaNoticePush | null } => {
    const row = db
      .prepare(
        `SELECT id, comment_id, inbound_reply_id, inbound_at, due_at, met_at, delay_recorded_at
         FROM reply_sla WHERE id = ?`
      )
      .get(caseId) as SlaCaseRow | undefined;
    if (!row || row.met_at || row.delay_recorded_at) return { kind: "skip", push: null };
    const reply = firstStaffReply(row);
    if (reply && reply.created_at <= row.due_at) {
      const marked = db
        .prepare(
          `UPDATE reply_sla
           SET met_at = ?, met_reply_id = ?
           WHERE id = ? AND met_at IS NULL AND delay_recorded_at IS NULL`
        )
        .run(reply.created_at, reply.id, row.id);
      return { kind: marked.changes === 1 ? "met" : "skip", push: null };
    }

    const assignee = db
      .prepare(`SELECT assignee_staff_id FROM comments WHERE id = ?`)
      .get(row.comment_id) as { assignee_staff_id: number | null } | undefined;
    const staffId = assignee?.assignee_staff_id ?? null;
    const staff = staffId
      ? (db.prepare(`SELECT id, username, display_name, active FROM staff WHERE id = ?`).get(staffId) as
          | NoticeStaff
          | undefined)
      : undefined;
    const stamp = formatUtcTimestamp(now);
    const claimed = db
      .prepare(
        `UPDATE reply_sla
         SET delay_recorded_at = ?, delay_staff_id = ?, notified_at = ?
         WHERE id = ? AND met_at IS NULL AND delay_recorded_at IS NULL`
      )
      .run(stamp, staff ? staff.id : null, stamp, row.id);
    if (claimed.changes !== 1) return { kind: "skip", push: null };

    let suspended = false;
    if (staff) {
      const existing = db
        .prepare(
          `SELECT delay_count, suspended_from, suspended_until
           FROM staff_reply_sla WHERE staff_id = ?`
        )
        .get(staff.id) as StaffStateRow | undefined;
      const count = (existing ? Number(existing.delay_count) : 0) + 1;
      if (isAutoAssignExcluded(staff.username)) {
        upsertStaffState(staff.id, count, null, null, stamp);
      } else if (count >= REPLY_SLA_STRIKES) {
        const until = formatUtcTimestamp(new Date(now.getTime() + REPLY_SLA_SUSPEND_MS));
        upsertStaffState(staff.id, 0, stamp, until, stamp);
        suspended = true;
      } else {
        upsertStaffState(
          staff.id,
          count,
          existing?.suspended_from ?? null,
          existing?.suspended_until ?? null,
          stamp
        );
      }
    }

    const body = overdueText({
      staffName: staff?.display_name || "未有負責人",
      commentId: row.comment_id,
      inboundReplyId: row.inbound_reply_id,
      suspended,
      unassigned: !staff,
    });
    const recipients = noticeRecipients();
    const title = "回覆逾時";
    const url = `/comments/${row.comment_id}`;
    for (const recipient of recipients) {
      db.prepare(
        `INSERT INTO staff_notices (staff_id, kind, title, body, url, comment_id)
         VALUES (?, 'reply_sla', ?, ?, ?, ?)`
      ).run(recipient.id, title, body, url, row.comment_id);
    }
    return {
      kind: "delay",
      push: {
        staffIds: recipients.map((recipient) => recipient.id),
        title,
        body,
        url,
        tag: `sla-${row.id}`.slice(0, 64),
      },
    };
  })();

  if (settled.kind === "delay" && settled.push && settled.push.staffIds.length) {
    try {
      pushImpl(settled.push);
    } catch (err) {
      console.error("[sla] 推送失敗", err instanceof Error ? err.message : err);
    }
  }
  return settled.kind;
}

function settleDueCases(now: Date): { met: number; delays: number } {
  const stamp = formatUtcTimestamp(now);
  const due = db
    .prepare(
      `SELECT id
       FROM reply_sla
       WHERE met_at IS NULL
         AND delay_recorded_at IS NULL
         AND due_at <= ?
       ORDER BY due_at ASC, id ASC
       LIMIT ?`
    )
    .all(stamp, DUE_LIMIT) as Array<{ id: number }>;
  let met = 0;
  let delays = 0;
  for (const row of due) {
    const kind = settleOne(row.id, now);
    if (kind === "met") met += 1;
    else if (kind === "delay") delays += 1;
  }
  return { met, delays };
}

/** 開新期限、記準時回覆、記逾時、清走到期暫停。可以重入，同一則入站唔會通知兩次。 */
export function scanReplySla(now = new Date()): ReplySlaScanResult {
  const restored = restoreExpiredSuspensions(now);
  const opened = discoverCases();
  const settled = settleDueCases(now);
  return { restored, opened, met: settled.met, delays: settled.delays };
}

let checkerStarted = false;
let checkerRunning = false;

/** 跟住網頁進程行。啟動先清走到期暫停，之後每 20 秒再檢查。 */
export function startReplySlaChecker(): void {
  if (checkerStarted) return;
  checkerStarted = true;
  console.log(
    `[sla] 回覆時限由 ${REPLY_SLA_START_HKT} 香港時間起計，每 ${REPLY_SLA_CHECK_MS / 1000} 秒檢查一次。暫停七日後自動恢復輪候。`
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
