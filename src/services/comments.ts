import { db } from "../db";
import { ENTRY_LABEL, ORIGIN_LABEL, SOURCE_LABEL, intakeSummary } from "../labels";
import type {
  CommentSource,
  CommentStatus,
  CommentStatusFilter,
  CommentWithAssignee,
  DeliveryStatus,
  EntryPath,
  IntakeKind,
  OriginFilter,
  OriginSite,
  ReplyDirection,
  StaffPublic,
} from "../types";
import {
  COMMENT_SOURCES,
  ENTRY_PATHS,
  ORIGIN_SITES,
  isDeliveryStatus,
  isEntryPath,
  isIntakeKind,
  isMetaSurface,
  isOriginSite,
} from "../types";
import { blockingOpenThreadId, isOpenCommenterConflict } from "./commenter-thread";

/** 已登入嘅人。管理員見全部（包括未派）；在職同事只見 assignee 係自己嘅留言。 */
export interface CommentViewer {
  staffId: number;
  isAdmin: boolean;
}

export function canViewComment(
  comment: { assignee_staff_id: number | null },
  viewer: CommentViewer
): boolean {
  if (viewer.isAdmin) return true;
  return comment.assignee_staff_id != null && comment.assignee_staff_id === viewer.staffId;
}

export interface CommentFilters {
  source?: CommentSource;
  status?: CommentStatusFilter;
  intake?: IntakeKind;
  origin?: OriginFilter;
  entry?: EntryPath;
  mine?: boolean;
  staffId?: number;
  /** 有傳而且唔係管理員時，強制只返回派咗畀該同事嘅留言。 */
  viewer?: CommentViewer;
  /** 關鍵字。空白當冇搜尋。最長見 normalizeInboxQuery。 */
  q?: string;
}

/** 搜尋框同 API `q` 嘅上限，避免超長 LIKE。 */
export const INBOX_QUERY_MAX = 120;

/** 去掉頭尾空白；空字串當冇搜尋。陣列取第一個。 */
export function normalizeInboxQuery(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, INBOX_QUERY_MAX);
}

const PREVIEW_LEN = 80;

export interface CommentUpdateItem {
  id: number;
  source: CommentSource;
  intake_kind: IntakeKind;
  origin_site: OriginSite | null;
  entry_path: EntryPath | null;
  author_name: string;
  preview: string;
  vehicle_ref: string | null;
  created_at: string;
  assignee_staff_id: number | null;
  assignee_name: string | null;
  /** 併入既有對話嘅客戶再留言。新開嘅留言冇呢個欄。 */
  reply_id?: number;
}

export interface CommentUpdates {
  latest_id: number;
  latest_reply_id: number;
  has_more: boolean;
  comments: CommentUpdateItem[];
  /** 已有 ID 上嘅新客戶訊息。已完成先至會另開 ID，所以跟進唔會變成新 comment id。 */
  follow_ups: CommentUpdateItem[];
  follow_ups_has_more: boolean;
}

interface CommentRow extends Omit<CommentWithAssignee, "reply_count"> {
  reply_count: number | null;
}

const COMMENT_SELECT = `
  SELECT c.*,
         s.display_name AS assignee_name,
         s.username AS assignee_username,
         COALESCE(rc.reply_count, 0) AS reply_count,
         lr.body AS last_reply_body,
         lr.created_at AS last_reply_at,
         lr.delivery_status AS last_reply_delivery_status,
         lr.direction AS last_reply_direction,
         rs.display_name AS last_reply_staff_name
  FROM comments c
  LEFT JOIN staff s ON s.id = c.assignee_staff_id
  LEFT JOIN (
    SELECT comment_id, COUNT(*) AS reply_count, MAX(id) AS last_id
    FROM comment_replies
    GROUP BY comment_id
  ) rc ON rc.comment_id = c.id
  LEFT JOIN comment_replies lr ON lr.id = rc.last_id
  LEFT JOIN staff rs ON rs.id = lr.staff_id
`;

function asDelivery(value: unknown): DeliveryStatus | null {
  return isDeliveryStatus(value) ? value : null;
}

function asDirection(value: unknown): ReplyDirection | null {
  if (value === "outbound" || value === "inbound") return value;
  return null;
}

function mapComment(row: CommentRow): CommentWithAssignee {
  return {
    ...row,
    intake_kind: isIntakeKind(row.intake_kind) ? row.intake_kind : "site_comment",
    origin_site: isOriginSite(row.origin_site) ? row.origin_site : null,
    entry_path: isEntryPath(row.entry_path) ? row.entry_path : null,
    reply_count: Number(row.reply_count) || 0,
    last_reply_body: row.last_reply_body ?? null,
    last_reply_at: row.last_reply_at ?? null,
    last_reply_staff_name: row.last_reply_staff_name ?? null,
    last_reply_delivery_status: asDelivery(row.last_reply_delivery_status),
    last_reply_direction: asDirection(row.last_reply_direction),
    wa_from_phone: asOptionalText(row.wa_from_phone),
    wa_to_phone: asOptionalText(row.wa_to_phone),
    meta_sender_id: asOptionalText(row.meta_sender_id),
    meta_surface: isMetaSurface(row.meta_surface) ? row.meta_surface : null,
    meta_post_id: asOptionalText(row.meta_post_id),
    meta_post_permalink: asOptionalText(row.meta_post_permalink),
    meta_post_caption: asOptionalText(row.meta_post_caption),
  };
}

function asOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** 全庫最新留言 id，用嚟做游標。列表同更新內容會再按角色篩走其他人嘅留言。 */
export function latestCommentId(): number {
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM comments`).get() as { id: number };
  return Number(row.id) || 0;
}

/** 最新回覆 id。客戶再留言係 inbound reply，唔會增加 comment id。 */
export function latestReplyId(): number {
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM comment_replies`).get() as { id: number };
  return Number(row.id) || 0;
}

/**
 * 新留言游標。sinceId 為 null 時只回最新 id，唔把舊留言當成新訊息。
 * MAX(id) 同新留言列表放喺同一個 transaction，避免兩次讀取之間有插入而跳過。
 */
export function listCommentUpdates(
  sinceId: number | null,
  limit = 30,
  viewer?: CommentViewer,
  sinceReplyId?: number | null
): CommentUpdates {
  const cap = Math.min(Math.max(Math.floor(limit) || 30, 1), 50);
  const read = db.transaction((): CommentUpdates => {
    const latest_id = latestCommentId();
    const latest_reply_id = latestReplyId();
    if (sinceId == null) {
      return {
        latest_id,
        latest_reply_id,
        comments: [],
        has_more: false,
        follow_ups: [],
        follow_ups_has_more: false,
      };
    }
    const where = ["c.id > ?"];
    const params: unknown[] = [sinceId];
    if (viewer && !viewer.isAdmin) {
      where.push("c.assignee_staff_id = ?");
      params.push(viewer.staffId);
    }
    params.push(cap + 1);
    const rows = db
      .prepare(
        `
        SELECT c.id, c.source, c.intake_kind, c.origin_site, c.entry_path, c.author_name, c.body,
               c.vehicle_ref, c.created_at, c.assignee_staff_id, s.display_name AS assignee_name
        FROM comments c
        LEFT JOIN staff s ON s.id = c.assignee_staff_id
        WHERE ${where.join(" AND ")}
        ORDER BY c.id ASC
        LIMIT ?
      `
      )
      .all(...params) as Array<{
      id: number;
      source: CommentSource;
      intake_kind: string;
      origin_site: string | null;
      entry_path: string | null;
      author_name: string;
      body: string;
      vehicle_ref: string | null;
      created_at: string;
      assignee_staff_id: number | null;
      assignee_name: string | null;
    }>;
    const has_more = rows.length > cap;
    const slice = has_more ? rows.slice(0, cap) : rows;
    const comments = slice.map((row) => mapUpdateRow(row));
    const known = new Set(comments.map((row) => row.id));
    let follow_ups: CommentUpdateItem[] = [];
    let follow_ups_has_more = false;
    if (sinceReplyId != null) {
      const followWhere = ["r.direction = 'inbound'", "r.id > ?"];
      const followParams: unknown[] = [sinceReplyId];
      if (viewer && !viewer.isAdmin) {
        followWhere.push("c.assignee_staff_id = ?");
        followParams.push(viewer.staffId);
      }
      followParams.push(cap + 1);
      const followRows = db
        .prepare(
          `
          SELECT c.id, r.id AS reply_id, c.source, c.intake_kind, c.origin_site, c.entry_path, c.author_name,
                 r.body, c.vehicle_ref, c.created_at, c.assignee_staff_id, s.display_name AS assignee_name
          FROM comment_replies r
          JOIN comments c ON c.id = r.comment_id
          LEFT JOIN staff s ON s.id = c.assignee_staff_id
          WHERE ${followWhere.join(" AND ")}
          ORDER BY r.id ASC
          LIMIT ?
        `
        )
        .all(...followParams) as Array<{
        id: number;
        reply_id: number;
        source: CommentSource;
        intake_kind: string;
        origin_site: string | null;
        entry_path: string | null;
        author_name: string;
        body: string;
        vehicle_ref: string | null;
        created_at: string;
        assignee_staff_id: number | null;
        assignee_name: string | null;
      }>;
      follow_ups_has_more = followRows.length > cap;
      follow_ups = (follow_ups_has_more ? followRows.slice(0, cap) : followRows)
        .filter((row) => !known.has(row.id))
        .map((row) => ({ ...mapUpdateRow(row), reply_id: Number(row.reply_id) }));
    }
    return {
      latest_id,
      latest_reply_id,
      has_more,
      comments,
      follow_ups,
      follow_ups_has_more,
    };
  });
  return read();
}

function mapUpdateRow(row: {
  id: number;
  source: CommentSource;
  intake_kind: string;
  origin_site: string | null;
  entry_path: string | null;
  author_name: string;
  body: string;
  vehicle_ref: string | null;
  created_at: string;
  assignee_staff_id: number | null;
  assignee_name: string | null;
}): CommentUpdateItem {
  return {
    id: row.id,
    source: row.source,
    intake_kind: isIntakeKind(row.intake_kind) ? row.intake_kind : "site_comment",
    origin_site: isOriginSite(row.origin_site) ? row.origin_site : null,
    entry_path: isEntryPath(row.entry_path) ? row.entry_path : null,
    author_name: row.author_name,
    preview: previewText(row.body),
    vehicle_ref: row.vehicle_ref,
    created_at: row.created_at,
    assignee_staff_id: row.assignee_staff_id,
    assignee_name: row.assignee_name,
  };
}

/** 列表頁用：留言同最新 id 同一個 snapshot，頁面游標先至對得準。 */
export function listCommentsWithCursor(filters: CommentFilters = {}): {
  comments: CommentWithAssignee[];
  latestId: number;
  latestReplyId: number;
} {
  const read = db.transaction(() => ({
    comments: listComments(filters),
    latestId: latestCommentId(),
    latestReplyId: latestReplyId(),
  }));
  return read();
}

export function getCommentWithCursor(id: number): {
  comment: CommentWithAssignee | null;
  latestId: number;
  latestReplyId: number;
} {
  const read = db.transaction(() => ({
    comment: getComment(id),
    latestId: latestCommentId(),
    latestReplyId: latestReplyId(),
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
  if (filters.status === "pending") {
    where.push("c.status IN ('open', 'in_progress')");
  } else if (filters.status) {
    where.push("c.status = ?");
    params.push(filters.status);
  }
  if (filters.intake) {
    where.push("c.intake_kind = ?");
    params.push(filters.intake);
  }
  if (filters.entry) {
    where.push("c.entry_path = ?");
    params.push(filters.entry);
  }
  if (filters.origin === "direct") {
    where.push("c.source = 'whatsapp' AND c.origin_site IS NULL AND c.intake_kind = 'whatsapp_click'");
  } else if (filters.origin) {
    where.push(`(
      (c.intake_kind = 'site_comment' AND c.source = ?)
      OR (c.intake_kind = 'whatsapp_click' AND c.origin_site = ?)
    )`);
    params.push(filters.origin, filters.origin);
  }
  if (filters.viewer && !filters.viewer.isAdmin) {
    where.push("c.assignee_staff_id = ?");
    params.push(filters.viewer.staffId);
  } else if (filters.mine && filters.staffId != null) {
    where.push("c.assignee_staff_id = ?");
    params.push(filters.staffId);
  }
  const query = normalizeInboxQuery(filters.q);
  if (query) appendInboxSearch(where, params, query);

  // 冇搜尋時未處理排前面，方便日常清箱。
  // 有搜尋時按更新時間，已完成嘅舊對話先搵到。
  const order = query
    ? "c.updated_at DESC, c.id DESC"
    : `CASE c.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
      c.created_at DESC,
      c.id DESC`;

  const sql = `
    ${COMMENT_SELECT}
    WHERE ${where.join(" AND ")}
    ORDER BY
      ${order}
  `;
  return (db.prepare(sql).all(...params) as CommentRow[]).map(mapComment);
}

/**
 * 關鍵字 LIKE。`%`／`_` 當字面字，唔當萬用字元。
 * 典型收件箱用渲染時掃描就夠；可見範圍（負責人）仍然先套上。
 */
function appendInboxSearch(where: string[], params: unknown[], query: string): void {
  const pattern = likeContains(query);
  const parts = [
    "lower(c.author_name) LIKE ? ESCAPE '!'",
    "lower(c.body) LIKE ? ESCAPE '!'",
    "lower(COALESCE(c.vehicle_ref, '')) LIKE ? ESCAPE '!'",
    "lower(COALESCE(c.wa_from_phone, '')) LIKE ? ESCAPE '!'",
    "lower(COALESCE(c.wa_to_phone, '')) LIKE ? ESCAPE '!'",
    "lower(COALESCE(c.external_id, '')) LIKE ? ESCAPE '!'",
    "lower(COALESCE(s.display_name, '')) LIKE ? ESCAPE '!'",
    "lower(COALESCE(s.username, '')) LIKE ? ESCAPE '!'",
    "lower(COALESCE(c.source, '')) LIKE ? ESCAPE '!'",
    "lower(COALESCE(c.origin_site, '')) LIKE ? ESCAPE '!'",
    "lower(COALESCE(c.entry_path, '')) LIKE ? ESCAPE '!'",
    "lower(COALESCE(c.meta_post_id, '')) LIKE ? ESCAPE '!'",
    "lower(COALESCE(c.meta_post_permalink, '')) LIKE ? ESCAPE '!'",
    "lower(COALESCE(c.meta_post_caption, '')) LIKE ? ESCAPE '!'",
    `EXISTS (
      SELECT 1 FROM comment_replies r
      WHERE r.comment_id = c.id AND lower(r.body) LIKE ? ESCAPE '!'
    )`,
  ];
  for (let i = 0; i < parts.length; i++) params.push(pattern);

  const digits = query.replace(/\D/g, "");
  if (digits.length >= 4) {
    const digitPattern = likeContains(digits);
    const phoneExpr = (column: string) =>
      `replace(replace(replace(COALESCE(${column}, ''), '+', ''), '-', ''), ' ', '') LIKE ? ESCAPE '!'`;
    parts.push(phoneExpr("c.wa_from_phone"), phoneExpr("c.wa_to_phone"));
    params.push(digitPattern, digitPattern);
  }

  for (const clause of searchLabelClauses(query)) {
    parts.push(clause.sql);
    params.push(...clause.params);
  }

  where.push(`(${parts.join(" OR ")})`);
}

function likeContains(term: string): string {
  const escaped = term.toLowerCase().replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
  return `%${escaped}%`;
}

function compactSearch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

/** 完整標籤，或者查詢包含成個標籤。短字（例如「留言」）唔會順便命中所有標籤。 */
function mentionsLabel(query: string, label: string): boolean {
  const q = compactSearch(query);
  const lab = compactSearch(label);
  if (q.length < 2 || lab.length < 2) return false;
  if (q === lab || q.includes(lab)) return true;
  if (q.length >= 3 && (lab.endsWith(q) || lab.startsWith(q))) return true;
  return false;
}

function isAlias(query: string, aliases: readonly string[]): boolean {
  const q = compactSearch(query);
  return aliases.some((alias) => q === compactSearch(alias));
}

function searchLabelClauses(query: string): Array<{ sql: string; params: unknown[] }> {
  const clauses: Array<{ sql: string; params: unknown[] }> = [];
  const seen = new Set<string>();
  const add = (sql: string, params: unknown[] = []) => {
    if (seen.has(sql)) return;
    seen.add(sql);
    clauses.push({ sql, params });
  };

  const sourceAliases: Partial<Record<CommentSource, readonly string[]>> = {
    facebook: ["fb"],
    instagram: ["ig"],
    glorious_web: ["官網", "glorious"],
    whatsapp: ["wa"],
  };
  for (const source of COMMENT_SOURCES) {
    const aliases = sourceAliases[source] ?? [];
    if (mentionsLabel(query, SOURCE_LABEL[source]) || mentionsLabel(query, source) || isAlias(query, aliases)) {
      add("c.source = ?", [source]);
    }
  }
  for (const origin of ORIGIN_SITES) {
    const summary = intakeSummary({
      source: "whatsapp",
      intake_kind: "whatsapp_click",
      origin_site: origin,
    });
    const aliases = sourceAliases[origin] ?? [];
    if (
      mentionsLabel(query, ORIGIN_LABEL[origin]) ||
      mentionsLabel(query, summary) ||
      mentionsLabel(query, origin) ||
      isAlias(query, aliases)
    ) {
      add(
        `((c.intake_kind = 'site_comment' AND c.source = ?) OR (c.intake_kind = 'whatsapp_click' AND c.origin_site = ?))`,
        [origin, origin]
      );
    }
  }
  if (
    mentionsLabel(query, "直接 WhatsApp") ||
    mentionsLabel(query, "直接 WhatsApp（冇經網站或 IG）") ||
    isAlias(query, ["直接"])
  ) {
    add("(c.source = 'whatsapp' AND c.origin_site IS NULL AND c.intake_kind = 'whatsapp_click')");
  }
  for (const entry of ENTRY_PATHS) {
    if (mentionsLabel(query, ENTRY_LABEL[entry]) || mentionsLabel(query, entry)) {
      add("c.entry_path = ?", [entry]);
    }
  }
  if (mentionsLabel(query, "WhatsApp 聯絡") || isAlias(query, ["wa"])) {
    add("c.intake_kind = ?", ["whatsapp_click"]);
  }
  if (
    mentionsLabel(query, "IG 留言") ||
    mentionsLabel(query, "東榮 IG 留言") ||
    isAlias(query, ["ig"])
  ) {
    add("(c.intake_kind = 'site_comment' AND c.source = 'instagram')");
  }
  if (mentionsLabel(query, "網站留言")) {
    add("(c.intake_kind = 'site_comment' AND c.source <> 'instagram')");
  }
  return clauses;
}

export function getComment(id: number): CommentWithAssignee | null {
  const row = db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(id) as CommentRow | undefined;
  return row ? mapComment(row) : null;
}

export function updateStatus(id: number, status: CommentStatus): CommentWithAssignee | null {
  if (blockingOpenThreadId(id, status)) return getComment(id);
  try {
    db.prepare(`UPDATE comments SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  } catch (err) {
    if (!isOpenCommenterConflict(err)) throw err;
    return getComment(id);
  }
  return getComment(id);
}

export function reassign(id: number, staffId: number | null): CommentWithAssignee | null {
  if (staffId != null) {
    const staff = db.prepare(`SELECT id FROM staff WHERE id = ? AND active = 1`).get(staffId);
    if (!staff) return null;
  }
  db.prepare(`UPDATE comments SET assignee_staff_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
    staffId,
    id
  );
  return getComment(id);
}

export function listStaff(): StaffPublic[] {
  const rows = db
    .prepare(`SELECT id, username, display_name, is_admin, active FROM staff ORDER BY id ASC`)
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
