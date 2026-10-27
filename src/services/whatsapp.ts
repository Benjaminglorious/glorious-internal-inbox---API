import { COMPANY_WHATSAPP_LABEL, COMPANY_WHATSAPP_PHONE } from "../config";
import { db } from "../db";
import type { CommentStatus, CommentWithAssignee, WhatsAppLine, WhatsAppLineKind } from "../types";
import { pickLeastLoadedStaffId } from "./assign";
import { findStaffById, getComment } from "./comments";
import { notifyNewComment } from "./push";

const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;
const MAX_BODY = 8000;
const MAX_STORED_BODY = 20000;
const MAX_EXTERNAL_ID = 200;
const MAX_LABEL = 80;

export interface RouteWhatsAppInboundInput {
  toPhone: string;
  fromPhone: string;
  body: string;
  externalId?: string | null;
  authorName?: string | null;
}

export type WhatsAppRouteOutcome =
  | "staff"
  | "company"
  | "unassigned_unknown_line"
  | "unassigned_no_staff"
  | "unassigned_inactive_staff";

export interface RouteWhatsAppInboundSuccess {
  ok: true;
  outcome: WhatsAppRouteOutcome;
  line: WhatsAppLine | null;
  /** 寫入留言後嘅實際負責人（已存在對話會維持原負責人）。 */
  assigneeStaffId: number | null;
  comment: CommentWithAssignee;
  created: boolean;
}

export interface RouteWhatsAppInboundFailure {
  ok: false;
  error: string;
}

export type RouteWhatsAppInboundResult = RouteWhatsAppInboundSuccess | RouteWhatsAppInboundFailure;

export type WhatsAppLineMutation = { ok: true; line: WhatsAppLine } | { ok: false; error: string };

export interface ParsedWhatsAppWebhook {
  messages: RouteWhatsAppInboundInput[];
  /** Meta 狀態回呼等：認得格式但冇文字要入庫。 */
  ignored: boolean;
  error?: string;
}

interface LineRow {
  id: number;
  phone_e164: string;
  display_label: string;
  kind: string;
  staff_id: number | null;
  is_active: number;
  created_at: string;
  staff_display_name: string | null;
  staff_username: string | null;
}

interface ExistingCommentRow {
  id: number;
  body: string;
  assignee_staff_id: number | null;
  status: CommentStatus;
  author_name: string;
}

const LINE_SELECT = `
  SELECT l.id, l.phone_e164, l.display_label, l.kind, l.staff_id, l.is_active, l.created_at,
         s.display_name AS staff_display_name,
         s.username AS staff_username
  FROM whatsapp_lines l
  LEFT JOIN staff s ON s.id = l.staff_id
`;

/** 去掉空白、+、橫線，只留數字。開頭 00 國際冠碼會去掉。 */
export function normalizePhone(input: string | null | undefined): string {
  if (!input) return "";
  let digits = String(input).replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  return digits;
}

export function formatPhoneE164(digits: string): string {
  if (digits.startsWith("852") && digits.length === 11) {
    return `+852 ${digits.slice(3, 7)} ${digits.slice(7)}`;
  }
  return digits ? `+${digits}` : "";
}

function mapLine(row: LineRow): WhatsAppLine {
  const kind: WhatsAppLineKind = row.kind === "company" ? "company" : "staff";
  return {
    id: row.id,
    phone_e164: row.phone_e164,
    display_label: row.display_label,
    kind,
    staff_id: row.staff_id,
    is_active: row.is_active === 1,
    created_at: row.created_at,
    staff_display_name: row.staff_display_name,
    staff_username: row.staff_username,
  };
}

function getLineRow(id: number): LineRow | undefined {
  return db.prepare(`${LINE_SELECT} WHERE l.id = ?`).get(id) as LineRow | undefined;
}

export function listWhatsAppLines(): WhatsAppLine[] {
  const rows = db
    .prepare(
      `${LINE_SELECT}
       ORDER BY l.is_active DESC,
                CASE l.kind WHEN 'company' THEN 0 ELSE 1 END,
                l.id ASC`
    )
    .all() as LineRow[];
  return rows.map(mapLine);
}

export function activeStaffLinesByStaffId(): Map<number, WhatsAppLine> {
  const map = new Map<number, WhatsAppLine>();
  for (const line of listWhatsAppLines()) {
    if (line.is_active && line.kind === "staff" && line.staff_id != null) {
      map.set(line.staff_id, line);
    }
  }
  return map;
}

function findLineByPhone(phone: string, activeOnly: boolean): LineRow | undefined {
  const sql = activeOnly
    ? `${LINE_SELECT} WHERE l.phone_e164 = ? AND l.is_active = 1`
    : `${LINE_SELECT} WHERE l.phone_e164 = ?`;
  return db.prepare(sql).get(phone) as LineRow | undefined;
}

/** 確保公司總機存在。已存在（包括已停用或改過名稱）就唔覆蓋。 */
export function ensureCompanyWhatsAppLine(): WhatsAppLine {
  db.prepare(
    `INSERT INTO whatsapp_lines (phone_e164, display_label, kind, staff_id, is_active)
     VALUES (?, ?, 'company', NULL, 1)
     ON CONFLICT(phone_e164) DO NOTHING`
  ).run(COMPANY_WHATSAPP_PHONE, COMPANY_WHATSAPP_LABEL);
  const row = findLineByPhone(COMPANY_WHATSAPP_PHONE, false);
  if (!row) {
    throw new Error("無法建立公司 WhatsApp 線路");
  }
  return mapLine(row);
}

function phoneError(digits: string, label: string): string | null {
  if (!digits) return `請填寫${label}`;
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) {
    return `${label}格式不正確（只保留數字，${MIN_PHONE_DIGITS}–${MAX_PHONE_DIGITS} 位）`;
  }
  return null;
}

function constraintMessage(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err) {
    const code = String((err as { code: unknown }).code);
    if (code.includes("CONSTRAINT")) return "線路資料衝突（號碼或同事已綁定）";
  }
  return null;
}

export function addStaffWhatsAppLine(input: {
  staffId: number;
  phone: string;
  displayLabel?: string | null;
}): WhatsAppLineMutation {
  if (!Number.isInteger(input.staffId)) {
    return { ok: false, error: "請選擇同事" };
  }
  const digits = normalizePhone(input.phone);
  const invalid = phoneError(digits, "WhatsApp 號碼");
  if (invalid) return { ok: false, error: invalid };
  if (digits === COMPANY_WHATSAPP_PHONE) {
    return { ok: false, error: "85221740001 係公司總機，不能綁做同事個人線路" };
  }

  const staff = findStaffById(input.staffId);
  if (!staff || !staff.active) {
    return { ok: false, error: "找不到這位在職同事" };
  }

  const label = (input.displayLabel ?? "").trim() || `${staff.display_name} WhatsApp`;
  if (label.length > MAX_LABEL) {
    return { ok: false, error: `顯示名稱不可長過 ${MAX_LABEL} 字` };
  }

  const activeForStaff = db
    .prepare(
      `SELECT id FROM whatsapp_lines
       WHERE kind = 'staff' AND staff_id = ? AND is_active = 1`
    )
    .get(input.staffId) as { id: number } | undefined;

  const existingPhone = findLineByPhone(digits, false);
  if (existingPhone?.kind === "company") {
    return { ok: false, error: "呢個係公司總機號碼，不能綁做同事個人線路" };
  }
  if (existingPhone && existingPhone.is_active === 1) {
    return { ok: false, error: "呢個號碼已經綁定" };
  }
  if (activeForStaff && activeForStaff.id !== existingPhone?.id) {
    return { ok: false, error: "呢位同事已經有啟用中嘅 WhatsApp 線路" };
  }

  try {
    if (existingPhone) {
      db.prepare(
        `UPDATE whatsapp_lines
         SET staff_id = ?, display_label = ?, kind = 'staff', is_active = 1
         WHERE id = ?`
      ).run(input.staffId, label, existingPhone.id);
      const line = getLineRow(existingPhone.id);
      if (!line) return { ok: false, error: "更新線路後讀唔返資料" };
      return { ok: true, line: mapLine(line) };
    }

    const info = db
      .prepare(
        `INSERT INTO whatsapp_lines (phone_e164, display_label, kind, staff_id, is_active)
         VALUES (?, ?, 'staff', ?, 1)`
      )
      .run(digits, label, input.staffId);
    const line = getLineRow(Number(info.lastInsertRowid));
    if (!line) return { ok: false, error: "新增線路後讀唔返資料" };
    return { ok: true, line: mapLine(line) };
  } catch (err) {
    const message = constraintMessage(err);
    if (message) return { ok: false, error: message };
    throw err;
  }
}

export function deactivateWhatsAppLine(id: number): WhatsAppLineMutation {
  if (!Number.isInteger(id)) return { ok: false, error: "無效線路 id" };
  const existing = getLineRow(id);
  if (!existing) return { ok: false, error: "找不到線路" };
  if (existing.is_active === 1) {
    db.prepare(`UPDATE whatsapp_lines SET is_active = 0 WHERE id = ?`).run(id);
  }
  const line = getLineRow(id);
  if (!line) return { ok: false, error: "找不到線路" };
  return { ok: true, line: mapLine(line) };
}

function cleanExternalId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_EXTERNAL_ID);
}

function mergeBody(previous: string, incoming: string, append: boolean): string {
  if (!append) return incoming;
  if (previous === incoming || previous.endsWith(`\n---\n${incoming}`)) return previous;
  const merged = `${previous}\n---\n${incoming}`;
  if (merged.length <= MAX_STORED_BODY) return merged;
  return merged.slice(merged.length - MAX_STORED_BODY);
}

function resolveAssignment(
  to: string,
  from: string,
  externalId: string,
  existing: ExistingCommentRow | undefined
): { outcome: WhatsAppRouteOutcome; assigneeStaffId: number | null; line: WhatsAppLine | null } {
  const row = findLineByPhone(to, true);
  const line = row ? mapLine(row) : null;

  if (!line) {
    if (!existing) {
      console.warn(
        `[whatsapp] 未知或未啟用線路 to=${to} from=${from} external_id=${externalId}，留言已入庫但未派單`
      );
    }
    return {
      outcome: "unassigned_unknown_line",
      assigneeStaffId: existing?.assignee_staff_id ?? null,
      line: null,
    };
  }

  if (line.kind === "staff") {
    const staff = line.staff_id != null ? findStaffById(line.staff_id) : undefined;
    if (!staff || !staff.active) {
      if (!existing || existing.assignee_staff_id == null) {
        console.warn(
          `[whatsapp] 同事線路 ${line.phone_e164} 綁定嘅同事已停用或不存在，留言未派單 external_id=${externalId}`
        );
      }
      return {
        outcome: "unassigned_inactive_staff",
        assigneeStaffId: existing?.assignee_staff_id ?? null,
        line,
      };
    }
    return { outcome: "staff", assigneeStaffId: staff.id, line };
  }

  if (existing?.assignee_staff_id != null) {
    return { outcome: "company", assigneeStaffId: existing.assignee_staff_id, line };
  }

  const staffId = pickLeastLoadedStaffId();
  if (staffId == null) {
    console.warn(`[whatsapp] 公司總機 ${line.phone_e164} 沒有在職同事可派 external_id=${externalId}`);
    return { outcome: "unassigned_no_staff", assigneeStaffId: null, line };
  }
  return { outcome: "company", assigneeStaffId: staffId, line };
}

/**
 * 將一則打去某條 WhatsApp 線路嘅訊息入庫並派單。
 *
 * - 同事個人線路 → 派畀綁定同事
 * - 公司總機 → pickLeastLoadedStaffId（未完成最少，同數則 staff id 較細）
 * - 未知／已停用線路 → 入庫為未派，並寫 log
 *
 * 有 externalId 時以佢做冪等鍵。冇則用 wa:{to}:{from} 合成一條對話，新內容會附加，
 * 公司總機唔會因為後續訊息而改派。同事線路每次都會對齊綁定同事。
 */
export function routeWhatsAppInbound(input: RouteWhatsAppInboundInput): RouteWhatsAppInboundResult {
  const to = normalizePhone(input.toPhone);
  const from = normalizePhone(input.fromPhone);
  const body = (input.body ?? "").replace(/\u0000/g, "").trim();
  const toError = phoneError(to, "收件號碼");
  if (toError) return { ok: false, error: toError };
  const fromError = phoneError(from, "寄件號碼");
  if (fromError) return { ok: false, error: fromError };
  if (!body) return { ok: false, error: "缺少訊息內容" };
  if (body.length > MAX_BODY) return { ok: false, error: "訊息內容太長" };

  const explicitExternalId = cleanExternalId(input.externalId);
  const externalId = explicitExternalId ?? `wa:${to}:${from}`;
  const authorName = (input.authorName ?? "").trim() || formatPhoneE164(from);

  const run = db.transaction((): RouteWhatsAppInboundResult => {
    const existing = db
      .prepare(
        `SELECT id, body, assignee_staff_id, status, author_name
         FROM comments
         WHERE source = 'whatsapp' AND external_id = ?`
      )
      .get(externalId) as ExistingCommentRow | undefined;

    const { outcome, assigneeStaffId, line } = resolveAssignment(to, from, externalId, existing);
    const nextBody = existing ? mergeBody(existing.body, body, explicitExternalId == null) : body;
    let status: CommentStatus = existing?.status ?? "open";
    if (existing && nextBody !== existing.body && status === "done") status = "open";

    if (!existing) {
      const info = db
        .prepare(
          `INSERT INTO comments (
             source, external_id, author_name, body, vehicle_ref, status, assignee_staff_id
           ) VALUES ('whatsapp', ?, ?, ?, NULL, 'open', ?)`
        )
        .run(externalId, authorName, nextBody, assigneeStaffId);
      const comment = getComment(Number(info.lastInsertRowid));
      if (!comment) return { ok: false, error: "入庫後讀唔返留言" };
      return { ok: true, outcome, line, assigneeStaffId, comment, created: true };
    }

    db.prepare(
      `UPDATE comments
       SET author_name = ?, body = ?, status = ?, assignee_staff_id = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(authorName, nextBody, status, assigneeStaffId, existing.id);
    const comment = getComment(existing.id);
    if (!comment) return { ok: false, error: "更新後讀唔返留言" };
    return { ok: true, outcome, line, assigneeStaffId, comment, created: false };
  });

  const result = run();
  if (result.ok && result.created) {
    try {
      notifyNewComment({
        id: result.comment.id,
        source: result.comment.source,
        author_name: result.comment.author_name,
        body: result.comment.body,
      });
    } catch (err) {
      console.error("[push] 未能排程推送", err);
    }
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return "";
}

function messageBody(message: Record<string, unknown>): string {
  const text = asRecord(message.text);
  if (text && asString(text.body).trim()) return asString(text.body);
  if (typeof message.text === "string") return message.text;
  const button = asRecord(message.button);
  if (button && asString(button.text).trim()) return asString(button.text);
  const interactive = asRecord(message.interactive);
  const reply = interactive
    ? asRecord(interactive.button_reply) ?? asRecord(interactive.list_reply)
    : null;
  if (reply && asString(reply.title).trim()) return asString(reply.title);
  return "";
}

function parseMetaEntries(entries: unknown[]): RouteWhatsAppInboundInput[] {
  const out: RouteWhatsAppInboundInput[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record || !Array.isArray(record.changes)) continue;
    for (const change of record.changes) {
      const changeRecord = asRecord(change);
      const value = changeRecord ? asRecord(changeRecord.value) : null;
      if (!value) continue;
      const metadata = asRecord(value.metadata);
      const toPhone = metadata ? asString(metadata.display_phone_number) : "";
      const names = new Map<string, string>();
      if (Array.isArray(value.contacts)) {
        for (const contact of value.contacts) {
          const contactRecord = asRecord(contact);
          if (!contactRecord) continue;
          const waId = normalizePhone(asString(contactRecord.wa_id));
          const profile = asRecord(contactRecord.profile);
          const name = profile ? asString(profile.name).trim() : "";
          if (waId && name) names.set(waId, name);
        }
      }
      if (!Array.isArray(value.messages)) continue;
      for (const message of value.messages) {
        const messageRecord = asRecord(message);
        if (!messageRecord) continue;
        const body = messageBody(messageRecord).trim();
        if (!body) continue;
        const fromPhone = asString(messageRecord.from);
        out.push({
          toPhone,
          fromPhone,
          body,
          externalId: asString(messageRecord.id) || null,
          authorName: names.get(normalizePhone(fromPhone)) ?? null,
        });
      }
    }
  }
  return out;
}

/**
 * 接受簡單 JSON `{ to, from, body, external_id? }`，
 * 以及簡化版 Meta Cloud API `entry[].changes[].value`。
 * 狀態回呼（只有 statuses、冇文字 messages）會變成 ignored。
 */
export function parseWhatsAppWebhookPayload(payload: unknown): ParsedWhatsAppWebhook {
  const root = asRecord(payload);
  if (!root) return { messages: [], ignored: false, error: "JSON 必須係物件" };

  if (Array.isArray(root.entry)) {
    const messages = parseMetaEntries(root.entry);
    return { messages, ignored: messages.length === 0 };
  }

  const toPhone = asString(root.to ?? root.to_phone ?? root.toPhone);
  const fromPhone = asString(root.from ?? root.from_phone ?? root.fromPhone);
  const textRecord = asRecord(root.text);
  const body =
    asString(root.body ?? root.message) ||
    (textRecord ? asString(textRecord.body) : asString(root.text));
  const externalId = asString(root.external_id ?? root.externalId ?? root.id) || null;
  const authorName = asString(root.author_name ?? root.authorName ?? root.name) || null;

  if (!toPhone && !fromPhone && !body) {
    return {
      messages: [],
      ignored: false,
      error: "未能辨識 payload。請用 { to, from, body }，或 Meta entry[].changes[].value.messages。",
    };
  }

  return {
    messages: [{ toPhone, fromPhone, body, externalId, authorName }],
    ignored: false,
  };
}
