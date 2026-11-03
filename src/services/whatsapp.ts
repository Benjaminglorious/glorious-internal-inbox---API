import { COMPANY_WHATSAPP_LABEL, COMPANY_WHATSAPP_PHONE } from "../config";
import { db } from "../db";
import { placeholderFor, type MediaKind } from "./media";
import {
  infer28carWaLink,
  normalizeOriginSite,
  originSiteFromReferralSignals,
  resolveEntryPath,
  resolveOriginSite,
} from "../intake";
import type {
  CommentStatus,
  CommentWithAssignee,
  EntryPath,
  OriginSite,
  WhatsAppLine,
  WhatsAppLineKind,
} from "../types";
import { pickLeastLoadedStaffId } from "./assign";
import { findStaffById, getComment } from "./comments";
import { notifyNewComment } from "./push";

const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;
const MAX_BODY = 8000;
const MAX_STORED_BODY = 20000;
const MAX_EXTERNAL_ID = 200;
const MAX_LABEL = 80;

export interface InboundWhatsAppMedia {
  kind: MediaKind;
  graphMediaId: string;
  mimeType: string;
  isVoice: boolean;
  sha256: string | null;
}

export interface RouteWhatsAppInboundInput {
  toPhone: string;
  fromPhone: string;
  body: string;
  externalId?: string | null;
  authorName?: string | null;
  /** Cloud API 媒體 id。入庫之後先下載，派單唔靠呢個欄。 */
  media?: InboundWhatsAppMedia | null;
  /**
   * 客戶係由邊個網站撳 WhatsApp 或簡介連結。
   * 可傳 `instagram` 或別名 `ig`。空則當直接 WhatsApp。
   */
  originSite?: string | null;
  /** 留言區入面嗰條 WhatsApp 連結。網頁留言板唔經呢度。 */
  entryPath?: EntryPath | null;
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

const THREAD_PHONES = /^wa:(\d{8,15}):(\d{8,15})$/;
/** WhatsApp `text=` 預填。中文 percent-encoding 會拉長 URL，所以收短過收件箱回覆。 */
const STAFF_WA_PREFILL_MAX = 500;

function acceptableCustomerPhone(digits: string, linePhone: string): string {
  if (!digits || digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) return "";
  if (digits === COMPANY_WHATSAPP_PHONE) return "";
  if (linePhone && digits === linePhone) return "";
  return digits;
}

/**
 * WhatsApp 對話入面嘅客戶號碼（只留數字）。
 * 優先 `wa_from_phone`，否則 `external_id` 嘅 `wa:{收件}:{寄件}`。
 * 公司總機、收件線路本身、以及唔係 WhatsApp 嘅留言都唔當客戶。
 * 只係讀號碼，唔會打去 Cloud API。
 */
export function resolveWhatsAppCustomerPhone(input: {
  source: string;
  externalId?: string | null;
  waFromPhone?: string | null;
  waToPhone?: string | null;
}): string | null {
  if (input.source !== "whatsapp") return null;
  const thread = THREAD_PHONES.exec((input.externalId ?? "").trim());
  const linePhone = normalizePhone(input.waToPhone) || thread?.[1] || "";
  const stored = acceptableCustomerPhone(normalizePhone(input.waFromPhone), linePhone);
  if (stored) return stored;
  const fromThread = acceptableCustomerPhone(thread?.[2] ?? "", linePhone);
  return fromThread || null;
}

/**
 * 打開同事而家登入嘅 WhatsApp，同客戶開對話。
 * `phone` 係客戶號碼，唔係同事號碼，亦唔係公司總機。
 * 有 `text` 先至加預填。空字串唔加 `text=`。公司總機號碼會拒絕。
 */
export function staffToCustomerWhatsAppUrl(customerDigits: string, text?: string | null): string | null {
  const phone = acceptableCustomerPhone(normalizePhone(customerDigits), "");
  if (!phone) return null;
  const base = `https://api.whatsapp.com/send?phone=${phone}`;
  const trimmed = (text ?? "").replace(/\u0000/g, "").trim();
  if (!trimmed) return base;
  return `${base}&text=${encodeURIComponent(trimmed.slice(0, STAFF_WA_PREFILL_MAX))}`;
}

export interface StaffWhatsAppReplyLink {
  available: boolean;
  customer_phone: string | null;
  /** 冇預填。頁面表格可以另加 `text`。 */
  url: string | null;
  viewer_phone: string | null;
  viewer_label: string | null;
  contacted_phone: string | null;
  /** 客戶打去邊條線路。可直接顯示。 */
  contacted_label: string | null;
  reason: string | null;
}

function contactedLineCopy(phone: string, lines: WhatsAppLine[]): { phone: string | null; label: string | null } {
  if (!phone) return { phone: null, label: null };
  if (phone === COMPANY_WHATSAPP_PHONE) {
    return {
      phone,
      label: `客戶打去公司總機 ${formatPhoneE164(phone)}。系統內「發送回覆」仍然用呢個公司號碼。你亦可以用自己嘅 WhatsApp 直接回覆客戶。`,
    };
  }
  const line = lines.find((item) => item.phone_e164 === phone);
  if (line?.kind === "staff") {
    const who = line.staff_display_name || line.display_label || "同事";
    return {
      phone,
      label: `客戶用 WhatsApp 搵${who}（${formatPhoneE164(phone)}）。`,
    };
  }
  return { phone, label: `客戶打去 ${formatPhoneE164(phone)}。` };
}

/**
 * 登入同事可唔可以用自己嘅 WhatsApp 開呢則客戶對話。
 * 可見範圍由呼叫方先檢查。呢度唔會因為同事未綁定號碼而收起連結：
 * 連結打開嘅係裝置上而家登入嘅 WhatsApp，綁定號碼只係提示同事用邊個號。
 */
export function staffWhatsAppReplyForViewer(
  comment: {
    source: string;
    external_id: string;
    wa_from_phone: string | null;
    wa_to_phone: string | null;
  },
  viewerStaffId: number
): StaffWhatsAppReplyLink {
  const lines = listWhatsAppLines();
  const viewerLine = lines.find(
    (line) => line.is_active && line.kind === "staff" && line.staff_id === viewerStaffId
  );
  const thread = THREAD_PHONES.exec((comment.external_id ?? "").trim());
  const contactedPhone = normalizePhone(comment.wa_to_phone) || thread?.[1] || "";
  const contacted = contactedLineCopy(contactedPhone, lines);
  const base = {
    viewer_phone: viewerLine?.phone_e164 ?? null,
    viewer_label: viewerLine?.display_label ?? null,
    contacted_phone: contacted.phone,
    contacted_label: contacted.label,
  };
  if (comment.source !== "whatsapp") {
    return {
      ...base,
      available: false,
      customer_phone: null,
      url: null,
      reason: "呢則唔係 WhatsApp 聯絡",
    };
  }
  const customer = resolveWhatsAppCustomerPhone({
    source: comment.source,
    externalId: comment.external_id,
    waFromPhone: comment.wa_from_phone,
    waToPhone: comment.wa_to_phone,
  });
  if (!customer) {
    return {
      ...base,
      available: false,
      customer_phone: null,
      url: null,
      reason: "未有客戶 WhatsApp 號碼，開唔到同事 WhatsApp",
    };
  }
  return {
    ...base,
    available: true,
    customer_phone: customer,
    url: staffToCustomerWhatsAppUrl(customer),
    reason: null,
  };
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
    if (code.includes("CONSTRAINT") || code === "23505" || code === "23514" || code === "23503") {
      return "線路資料衝突（號碼或同事已綁定）";
    }
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
 * - 公司總機 → pickLeastLoadedStaffId（未完成最少，同數則 Eddie → Wing → Jason → 其餘按 staff id；Tony 同 Benjamin 唔參與）
 * - 未知／已停用線路 → 入庫為未派，並寫 log
 *
 * 有 externalId 時以佢做冪等鍵。冇則用 wa:{to}:{from} 合成一條對話，新內容會附加，
 * 公司總機唔會因為後續訊息而改派。同事線路每次都會對齊綁定同事。
 * 另外把寄件 wa_id 同收件線路寫入 wa_from_phone／wa_to_phone，畀公司線出站用。派單規則唔變。
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
  const origin = normalizeOriginSite(input.originSite ?? null);
  if (origin === "invalid") {
    return { ok: false, error: "origin_site 必須係 28car、glorious_web、facebook 或 instagram" };
  }
  let originSite: OriginSite | null = origin;
  const entryResolved = resolveEntryPath({
    explicit: input.entryPath,
    inferred: infer28carWaLink(originSite, null),
    channel: "whatsapp",
  });
  if (!entryResolved.ok) return { ok: false, error: entryResolved.error };
  let entryPath = entryResolved.entryPath;
  if (entryPath === "28car_wa_link") {
    if (originSite && originSite !== "28car") {
      return { ok: false, error: "28car_wa_link 只可以配 origin_site=28car" };
    }
    originSite = "28car";
  }

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
             source, external_id, author_name, body, vehicle_ref, status, assignee_staff_id,
             intake_kind, origin_site, wa_from_phone, wa_to_phone, entry_path
           ) VALUES ('whatsapp', ?, ?, ?, NULL, 'open', ?, 'whatsapp_click', ?, ?, ?, ?)`
        )
        .run(externalId, authorName, nextBody, assigneeStaffId, originSite, from, to, entryPath);
      const comment = getComment(Number(info.lastInsertRowid));
      if (!comment) return { ok: false, error: "入庫後讀唔返留言" };
      return { ok: true, outcome, line, assigneeStaffId, comment, created: true };
    }

    db.prepare(
      `UPDATE comments
       SET author_name = ?, body = ?, status = ?, assignee_staff_id = ?,
           intake_kind = 'whatsapp_click',
           origin_site = COALESCE(origin_site, ?),
           wa_from_phone = ?,
           wa_to_phone = ?,
           entry_path = COALESCE(?, entry_path),
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(authorName, nextBody, status, assigneeStaffId, originSite, from, to, entryPath, existing.id);
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
        intake_kind: result.comment.intake_kind,
        origin_site: result.comment.origin_site,
        entry_path: result.comment.entry_path,
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

function graphMedia(message: Record<string, unknown>): (InboundWhatsAppMedia & { caption: string }) | null {
  const rawType = asString(message.type).toLowerCase();
  const type = rawType === "voice" ? "audio" : rawType === "sticker" ? "sticker" : rawType;
  if (type !== "image" && type !== "video" && type !== "audio" && type !== "sticker") return null;
  const block = asRecord(message[type]);
  if (!block) return null;
  const id = asString(block.id).trim();
  if (!/^\d{5,32}$/.test(id)) return null;
  const kind: MediaKind = type === "video" ? "video" : type === "audio" ? "audio" : "image";
  const mime = asString(block.mime_type).trim().toLowerCase();
  const voice = type === "audio" && (block.voice === true || block.voice === "true" || rawType === "voice");
  const sha = asString(block.sha256).trim().toLowerCase();
  return {
    kind,
    graphMediaId: id,
    mimeType: mime,
    isVoice: voice,
    sha256: /^[a-f0-9]{64}$/.test(sha) ? sha : null,
    caption: asString(block.caption).trim(),
  };
}

function messageContent(
  message: Record<string, unknown>
): { body: string; media: InboundWhatsAppMedia | null } | null {
  const text = messageBody(message).trim();
  const media = graphMedia(message);
  if (media) {
    const { caption, ...stored } = media;
    const body = text || caption || placeholderFor(stored.kind, stored.isVoice);
    return { body, media: stored };
  }
  if (!text) return null;
  return { body: text, media: null };
}

function classifyWhatsAppEntry(
  explicit: unknown,
  originSite: OriginSite | null,
  referralUrl: string | null
): { ok: true; originSite: OriginSite | null; entryPath: EntryPath | null } | { ok: false; error: string } {
  const resolved = resolveEntryPath({
    explicit,
    inferred: infer28carWaLink(originSite, referralUrl),
    channel: "whatsapp",
  });
  if (!resolved.ok) return resolved;
  if (resolved.entryPath === "28car_wa_link") {
    if (originSite && originSite !== "28car") {
      return { ok: false, error: "28car_wa_link 只可以配 origin_site=28car" };
    }
    return { ok: true, originSite: "28car", entryPath: "28car_wa_link" };
  }
  return { ok: true, originSite, entryPath: null };
}

function referralUrlFrom(record: Record<string, unknown>): string | null {
  const referral = record.referral;
  if (typeof referral === "string" && referral.trim()) return referral.trim();
  const referralRecord = asRecord(referral);
  if (referralRecord) {
    const url = asString(referralRecord.source_url ?? referralRecord.sourceUrl ?? referralRecord.url).trim();
    if (url) return url;
  }
  const direct = asString(record.source_url ?? record.sourceUrl).trim();
  return direct || null;
}

/**
 * 明確 origin 優先，跟住 referral.source_url（現有 utm／網域規則）。
 * 仍然係空先至睇 referral／context 其餘欄（source_type、permalink、welcome_message 等）。
 * 客戶訊息正文唔參與，避免有機對話被誤標。
 */
function inboundOrigin(
  record: Record<string, unknown>
): { ok: true; originSite: OriginSite | null } | { ok: false; error: string } {
  const explicit = record.origin_site ?? record.originSite;
  const resolved = resolveOriginSite(explicit === undefined ? null : explicit, referralUrlFrom(record));
  if (!resolved.ok || resolved.originSite) return resolved;
  return { ok: true, originSite: originSiteFromReferralSignals(record.referral, record.context) };
}

function parseMetaEntries(entries: unknown[]): { messages: RouteWhatsAppInboundInput[]; error?: string } {
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
        const content = messageContent(messageRecord);
        if (!content) continue;
        const fromPhone = asString(messageRecord.from);
        const referral = referralUrlFrom(messageRecord);
        const origin = inboundOrigin(messageRecord);
        if (!origin.ok) return { messages: [], error: origin.error };
        const entry = classifyWhatsAppEntry(
          messageRecord.entry_path ?? messageRecord.entryPath,
          origin.originSite,
          referral
        );
        if (!entry.ok) return { messages: [], error: entry.error };
        out.push({
          toPhone,
          fromPhone,
          body: content.body,
          externalId: asString(messageRecord.id) || null,
          authorName: names.get(normalizePhone(fromPhone)) ?? null,
          originSite: entry.originSite,
          entryPath: entry.entryPath,
          media: content.media,
        });
      }
    }
  }
  return { messages: out };
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
    const parsed = parseMetaEntries(root.entry);
    if (parsed.error) return { messages: [], ignored: false, error: parsed.error };
    return { messages: parsed.messages, ignored: parsed.messages.length === 0 };
  }

  const toPhone = asString(root.to ?? root.to_phone ?? root.toPhone);
  const fromPhone = asString(root.from ?? root.from_phone ?? root.fromPhone);
  const textRecord = asRecord(root.text);
  const body =
    asString(root.body ?? root.message) ||
    (textRecord ? asString(textRecord.body) : asString(root.text));
  const externalId = asString(root.external_id ?? root.externalId ?? root.id) || null;
  const authorName = asString(root.author_name ?? root.authorName ?? root.name) || null;
  const referral = referralUrlFrom(root);
  const origin = inboundOrigin(root);
  if (!origin.ok) return { messages: [], ignored: false, error: origin.error };
  const entry = classifyWhatsAppEntry(root.entry_path ?? root.entryPath, origin.originSite, referral);
  if (!entry.ok) return { messages: [], ignored: false, error: entry.error };

  if (!toPhone && !fromPhone && !body) {
    return {
      messages: [],
      ignored: false,
      error: "未能辨識 payload。請用 { to, from, body }，或 Meta entry[].changes[].value.messages。",
    };
  }

  return {
    messages: [
      {
        toPhone,
        fromPhone,
        body,
        externalId,
        authorName,
        originSite: entry.originSite,
        entryPath: entry.entryPath,
      },
    ],
    ignored: false,
  };
}
