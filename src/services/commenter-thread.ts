import { COMPANY_WHATSAPP_PHONE } from "../config";
import { db } from "../db";
import type { CommentStatus } from "../types";

/**
 * 未完成（未處理／處理中）嘅同一留言者只用一個收件箱 ID。
 * 狀態係已完成先至可以再開新 ID。
 *
 * 身份：WhatsApp 用客戶電話；Facebook／Instagram 用 PSID／IGSID；
 * 冇穩定 id（28car、官網、Meta 冇 sender）先至用正規化姓名。
 * 唔會把 WhatsApp 同 FB／IG 當同一個人。
 */

const GENERIC_NAMES = new Set([
  "未知用戶",
  "未知用户",
  "訪客",
  "访客",
  "客人",
  "客戶",
  "客户",
  "用戶",
  "用户",
  "guest",
  "unknown",
  "user",
  "customer",
  "facebook user",
  "instagram user",
  "fb user",
  "ig user",
]);

const OPEN_COMMENTER_INDEX = "idx_comments_one_open_commenter";

export interface CommenterKeyInput {
  source: string;
  authorName?: string | null;
  externalId?: string | null;
  waFromPhone?: string | null;
  waToPhone?: string | null;
  metaSenderId?: string | null;
}

export interface OpenThreadHit {
  id: number;
  status: CommentStatus;
  assignee_staff_id: number | null;
  author_name: string;
  commenter_key: string | null;
}

export interface ThreadFills {
  metaSenderId?: string | null;
  metaSurface?: string | null;
  waFromPhone?: string | null;
  waToPhone?: string | null;
  vehicleRef?: string | null;
  originSite?: string | null;
  entryPath?: string | null;
  metaPostId?: string | null;
  metaPostPermalink?: string | null;
  metaPostCaption?: string | null;
}

interface ThreadRow {
  id: number;
  status: string;
  assignee_staff_id: number | null;
  author_name: string;
  commenter_key: string | null;
}

interface KeyRow {
  comment_id: number;
  reply_id: number | null;
}

function asStatus(value: string): CommentStatus {
  if (value === "in_progress" || value === "done") return value;
  return "open";
}

function mapHit(row: ThreadRow): OpenThreadHit {
  return {
    id: Number(row.id),
    status: asStatus(row.status),
    assignee_staff_id: row.assignee_staff_id == null ? null : Number(row.assignee_staff_id),
    author_name: row.author_name,
    commenter_key: row.commenter_key,
  };
}

export function normalizeAuthorName(name: string | null | undefined): string {
  return String(name ?? "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isGenericAuthorName(name: string | null | undefined): boolean {
  const norm = normalizeAuthorName(name);
  if (norm.length < 2) return true;
  if (GENERIC_NAMES.has(norm)) return true;
  return false;
}

function looksLikePhone(name: string): boolean {
  const compact = name.replace(/[\s+\-().]/g, "");
  return /^\d{8,15}$/.test(compact);
}

function isWeakAuthor(name: string, phone: string | null): boolean {
  if (isGenericAuthorName(name)) return true;
  if (looksLikePhone(name)) return true;
  const phoneDigits = (phone ?? "").replace(/\D/g, "");
  if (phoneDigits.length >= 8 && name.replace(/\D/g, "") === phoneDigits) return true;
  return false;
}

/** 電話或「未知用戶」唔好蓋過已經有嘅真名。有真名就保留。 */
export function preferDisplayName(current: string, incoming: string, phone: string | null): string {
  const next = incoming.replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!next) return current;
  if (!isWeakAuthor(current, phone)) return current;
  if (isWeakAuthor(next, phone)) return current;
  return next;
}

function phoneDigits(value: string | null | undefined): string {
  if (!value) return "";
  let digits = String(value).replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  return digits;
}

function acceptableCustomerPhone(digits: string, linePhone: string): string {
  if (digits.length < 8 || digits.length > 15) return "";
  if (digits === COMPANY_WHATSAPP_PHONE) return "";
  if (linePhone && digits === linePhone) return "";
  return digits;
}

/** 同 resolveWhatsAppCustomerPhone：客戶號碼，唔係公司總機或收件線路。 */
export function whatsAppCustomerDigits(
  from: string | null | undefined,
  to: string | null | undefined,
  externalId: string | null | undefined
): string {
  const thread = /^wa:(\d{8,15}):(\d{8,15})$/.exec((externalId ?? "").trim());
  const line = phoneDigits(to) || thread?.[1] || "";
  const stored = acceptableCustomerPhone(phoneDigits(from), line);
  if (stored) return stored;
  return acceptableCustomerPhone(thread?.[2] ?? "", line);
}

export function commenterKey(input: CommenterKeyInput): string | null {
  if (input.source === "whatsapp") {
    const phone = whatsAppCustomerDigits(input.waFromPhone, input.waToPhone, input.externalId);
    if (phone) return `wa:${phone}`;
    return null;
  }
  const sender = (input.metaSenderId ?? "").trim();
  if (
    (input.source === "facebook" || input.source === "instagram") &&
    /^[0-9A-Za-z_.:-]{2,200}$/.test(sender)
  ) {
    return `meta:${sender}`;
  }
  if (isGenericAuthorName(input.authorName)) return null;
  return `name:${normalizeAuthorName(input.authorName)}`;
}

export function isOpenCommenterConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("commenter_key") || message.includes(OPEN_COMMENTER_INDEX);
}

function usefulName(name: string | null | undefined): string {
  if (isGenericAuthorName(name)) return "";
  return normalizeAuthorName(name);
}

/**
 * 未完成對話入面，呢個留言者最早嗰條。
 * 有電話／PSID／IGSID 就用佢。冇先至先採用同名、而且未有另一個穩定 id 嘅列。
 */
export function findOpenThread(input: {
  source: string;
  key: string | null;
  authorName: string;
  excludeId?: number;
}): OpenThreadHit | undefined {
  const exclude = input.excludeId ?? 0;
  if (input.key) {
    const direct = db
      .prepare(
        `SELECT id, status, assignee_staff_id, author_name, commenter_key
         FROM comments
         WHERE source = ? AND commenter_key = ? AND status <> 'done' AND id <> ?
         ORDER BY id ASC
         LIMIT 1`
      )
      .get(input.source, input.key, exclude) as ThreadRow | undefined;
    if (direct) return mapHit(direct);
  }

  const name = usefulName(input.authorName);
  if (!name || input.source === "whatsapp") return undefined;

  const rows = db
    .prepare(
      `SELECT id, status, assignee_staff_id, author_name, commenter_key
       FROM comments
       WHERE source = ? AND status <> 'done' AND id <> ?
       ORDER BY id ASC`
    )
    .all(input.source, exclude) as ThreadRow[];

  const named = rows.filter((row) => usefulName(row.author_name) === name);
  if (!named.length) return undefined;

  const incomingStable = !!input.key && !input.key.startsWith("name:");
  if (incomingStable) {
    const nameOnly = named.find((row) => !row.commenter_key || row.commenter_key.startsWith("name:"));
    return nameOnly ? mapHit(nameOnly) : undefined;
  }

  const stable = named.find((row) => row.commenter_key && !row.commenter_key.startsWith("name:"));
  return mapHit(stable ?? named[0]);
}

/** 已完成列可以同未完成列共用 commenter_key。未完成就唔可以撞另一條未完成。 */
export function keySafeToStore(
  source: string,
  commentId: number,
  key: string | null,
  resultingStatus: CommentStatus
): string | null {
  if (!key) return null;
  if (resultingStatus === "done") return key;
  const other = db
    .prepare(
      `SELECT id FROM comments
       WHERE source = ? AND commenter_key = ? AND status <> 'done' AND id <> ?
       LIMIT 1`
    )
    .get(source, key, commentId) as { id: number } | undefined;
  return other ? null : key;
}

/**
 * 想把已完成改回未完成／處理中，但呢個人已經有另一條未完成對話。
 * 返回嗰條未完成 ID。唔使擋就返回 null。
 */
export function blockingOpenThreadId(id: number, next: CommentStatus): number | null {
  if (next === "done" || !Number.isInteger(id)) return null;
  const row = db
    .prepare(`SELECT source, commenter_key, status FROM comments WHERE id = ?`)
    .get(id) as { source: string; commenter_key: string | null; status: string } | undefined;
  if (!row?.commenter_key || row.status !== "done") return null;
  const other = db
    .prepare(
      `SELECT id FROM comments
       WHERE source = ? AND commenter_key = ? AND status <> 'done' AND id <> ?
       ORDER BY id ASC
       LIMIT 1`
    )
    .get(row.source, row.commenter_key, id) as { id: number } | undefined;
  return other ? Number(other.id) : null;
}

export function findFoldedMessage(
  source: string,
  externalId: string
): { commentId: number; replyId: number | null } | null {
  const row = db
    .prepare(`SELECT comment_id, reply_id FROM comment_message_keys WHERE source = ? AND external_id = ?`)
    .get(source, externalId) as KeyRow | undefined;
  if (!row) return null;
  return {
    commentId: Number(row.comment_id),
    replyId: row.reply_id == null ? null : Number(row.reply_id),
  };
}

/** Webhook 重試已經併入嘅訊息：更新呢句，唔開新 ID，亦唔改狀態。 */
export function replayFoldedMessage(source: string, externalId: string, body: string): { commentId: number; replyId: number | null } | null {
  const found = findFoldedMessage(source, externalId);
  if (!found) return null;
  if (found.replyId != null) {
    db.prepare(`UPDATE comment_replies SET body = ? WHERE id = ?`).run(body, found.replyId);
  }
  db.prepare(`UPDATE comments SET updated_at = datetime('now') WHERE id = ?`).run(found.commentId);
  return found;
}

function rememberExternalId(source: string, externalId: string, commentId: number, replyId: number | null): void {
  db.prepare(
    `INSERT INTO comment_message_keys (source, external_id, comment_id, reply_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (source, external_id) DO UPDATE SET
       comment_id = excluded.comment_id,
       reply_id = COALESCE(excluded.reply_id, comment_message_keys.reply_id)`
  ).run(source, externalId, commentId, replyId);
}

/**
 * 把新訊息寫入已有未完成對話，當成客戶再留言。
 * 唔改負責人、狀態、external_id、meta_surface（出站回覆仍然打去原來嗰則）。
 */
export function appendInboundMessage(input: {
  commentId: number;
  source: string;
  externalId: string;
  body: string;
  authorName: string;
  commenterKey: string | null;
  fills?: ThreadFills;
}): { replyId: number; duplicate: boolean } {
  const existing = findFoldedMessage(input.source, input.externalId);
  if (existing?.replyId != null) {
    db.prepare(`UPDATE comment_replies SET body = ? WHERE id = ?`).run(input.body, existing.replyId);
    db.prepare(`UPDATE comments SET updated_at = datetime('now') WHERE id = ?`).run(existing.commentId);
    return { replyId: existing.replyId, duplicate: true };
  }

  const info = db
    .prepare(
      `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status)
       VALUES (?, NULL, 'inbound', ?, 'stored')`
    )
    .run(input.commentId, input.body);
  const replyId = Number(info.lastInsertRowid);
  rememberExternalId(input.source, input.externalId, input.commentId, replyId);

  const current = db
    .prepare(`SELECT author_name, commenter_key, wa_from_phone FROM comments WHERE id = ?`)
    .get(input.commentId) as { author_name: string; commenter_key: string | null; wa_from_phone: string | null } | undefined;
  const fills = input.fills ?? {};
  const phone = fills.waFromPhone ?? current?.wa_from_phone ?? null;
  const author = preferDisplayName(current?.author_name ?? input.authorName, input.authorName, phone);
  const currentKey = current?.commenter_key ?? null;
  let nextKey = currentKey;
  if (!currentKey) nextKey = input.commenterKey;
  else if (currentKey.startsWith("name:") && input.commenterKey && !input.commenterKey.startsWith("name:")) {
    nextKey = input.commenterKey;
  }

  db.prepare(
    `UPDATE comments SET
       author_name = ?,
       commenter_key = ?,
       meta_sender_id = COALESCE(meta_sender_id, ?),
       meta_surface = COALESCE(meta_surface, ?),
       wa_from_phone = COALESCE(wa_from_phone, ?),
       wa_to_phone = COALESCE(wa_to_phone, ?),
       vehicle_ref = COALESCE(vehicle_ref, ?),
       origin_site = COALESCE(origin_site, ?),
       entry_path = COALESCE(entry_path, ?),
       meta_post_id = COALESCE(meta_post_id, ?),
       meta_post_permalink = COALESCE(meta_post_permalink, ?),
       meta_post_caption = COALESCE(meta_post_caption, ?),
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    author,
    nextKey,
    fills.metaSenderId ?? null,
    fills.metaSurface ?? null,
    fills.waFromPhone ?? null,
    fills.waToPhone ?? null,
    fills.vehicleRef ?? null,
    fills.originSite ?? null,
    fills.entryPath ?? null,
    fills.metaPostId ?? null,
    fills.metaPostPermalink ?? null,
    fills.metaPostCaption ?? null,
    input.commentId
  );
  return { replyId, duplicate: false };
}

interface FullRow {
  id: number;
  source: string;
  external_id: string;
  author_name: string;
  body: string;
  vehicle_ref: string | null;
  status: string;
  assignee_staff_id: number | null;
  commenter_key: string | null;
  created_at: string;
  wa_from_phone: string | null;
  wa_to_phone: string | null;
  origin_site: string | null;
  entry_path: string | null;
  meta_sender_id: string | null;
  meta_surface: string | null;
  meta_post_id: string | null;
  meta_post_permalink: string | null;
  meta_post_caption: string | null;
}

const FULL_SELECT = `
  SELECT id, source, external_id, author_name, body, vehicle_ref, status, assignee_staff_id,
         commenter_key, created_at, wa_from_phone, wa_to_phone, origin_site, entry_path,
         meta_sender_id, meta_surface, meta_post_id, meta_post_permalink, meta_post_caption
  FROM comments
`;

function backfillCommenterKeys(): void {
  const rows = db
    .prepare(
      `SELECT id, source, external_id, author_name, wa_from_phone, wa_to_phone, meta_sender_id
       FROM comments
       WHERE commenter_key IS NULL`
    )
    .all() as Array<{
    id: number;
    source: string;
    external_id: string;
    author_name: string;
    wa_from_phone: string | null;
    wa_to_phone: string | null;
    meta_sender_id: string | null;
  }>;
  if (!rows.length) return;
  const update = db.prepare(`UPDATE comments SET commenter_key = ? WHERE id = ? AND commenter_key IS NULL`);
  for (const row of rows) {
    const key = commenterKey({
      source: row.source,
      authorName: row.author_name,
      externalId: row.external_id,
      waFromPhone: row.wa_from_phone,
      waToPhone: row.wa_to_phone,
      metaSenderId: row.meta_sender_id,
    });
    if (!key) continue;
    const apply = db.transaction(() => {
      update.run(key, row.id);
    });
    try {
      apply();
    } catch (err) {
      if (!isOpenCommenterConflict(err)) throw err;
    }
  }
}

function foldInto(canonical: FullRow, extra: FullRow): void {
  const existingKey = db
    .prepare(`SELECT reply_id FROM comment_message_keys WHERE source = ? AND external_id = ?`)
    .get(extra.source, extra.external_id) as { reply_id: number | null } | undefined;
  let replyId = existingKey?.reply_id == null ? null : Number(existingKey.reply_id);
  if (replyId == null) {
    const info = db
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
         VALUES (?, NULL, 'inbound', ?, 'stored', ?)`
      )
      .run(canonical.id, extra.body, extra.created_at);
    replyId = Number(info.lastInsertRowid);
  }
  rememberExternalId(extra.source, extra.external_id, canonical.id, replyId);

  db.prepare(`UPDATE comment_replies SET comment_id = ? WHERE comment_id = ?`).run(canonical.id, extra.id);
  db.prepare(
    `UPDATE message_media SET comment_id = ?, reply_id = ? WHERE comment_id = ? AND reply_id IS NULL`
  ).run(canonical.id, replyId, extra.id);
  db.prepare(`UPDATE message_media SET comment_id = ? WHERE comment_id = ?`).run(canonical.id, extra.id);
  db.prepare(`UPDATE car_listing_messages SET inbox_comment_id = ? WHERE inbox_comment_id = ?`).run(
    canonical.id,
    extra.id
  );
  db.prepare(`UPDATE car_reply_queue SET comment_id = ? WHERE comment_id = ?`).run(canonical.id, extra.id);
  db.prepare(`UPDATE comment_message_keys SET comment_id = ? WHERE comment_id = ?`).run(canonical.id, extra.id);
  db.prepare(`DELETE FROM comments WHERE id = ?`).run(extra.id);

  const status = canonical.status === "in_progress" || extra.status === "in_progress" ? "in_progress" : canonical.status;
  const author = preferDisplayName(canonical.author_name, extra.author_name, canonical.wa_from_phone || extra.wa_from_phone);
  const nextKey = canonical.commenter_key || extra.commenter_key;
  db.prepare(
    `UPDATE comments SET
       author_name = ?,
       status = ?,
       commenter_key = COALESCE(commenter_key, ?),
       assignee_staff_id = COALESCE(assignee_staff_id, ?),
       wa_from_phone = COALESCE(wa_from_phone, ?),
       wa_to_phone = COALESCE(wa_to_phone, ?),
       vehicle_ref = COALESCE(vehicle_ref, ?),
       origin_site = COALESCE(origin_site, ?),
       entry_path = COALESCE(entry_path, ?),
       meta_sender_id = COALESCE(meta_sender_id, ?),
       meta_surface = COALESCE(meta_surface, ?),
       meta_post_id = COALESCE(meta_post_id, ?),
       meta_post_permalink = COALESCE(meta_post_permalink, ?),
       meta_post_caption = COALESCE(meta_post_caption, ?),
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    author,
    status,
    nextKey,
    extra.assignee_staff_id,
    extra.wa_from_phone,
    extra.wa_to_phone,
    extra.vehicle_ref,
    extra.origin_site,
    extra.entry_path,
    extra.meta_sender_id,
    extra.meta_surface,
    extra.meta_post_id,
    extra.meta_post_permalink,
    extra.meta_post_caption,
    canonical.id
  );
  canonical.author_name = author;
  canonical.status = status;
  canonical.commenter_key = canonical.commenter_key || nextKey;
  if (canonical.assignee_staff_id == null) canonical.assignee_staff_id = extra.assignee_staff_id;
}

function foldOpenDuplicates(): number {
  const fold = (canonicalId: number, extraId: number): boolean => {
    const run = db.transaction(() => {
      const canonical = db.prepare(`${FULL_SELECT} WHERE id = ?`).get(canonicalId) as FullRow | undefined;
      const extra = db.prepare(`${FULL_SELECT} WHERE id = ?`).get(extraId) as FullRow | undefined;
      if (!canonical || !extra || canonical.id === extra.id) return false;
      if (canonical.status === "done" || extra.status === "done") return false;
      foldInto(canonical, extra);
      return true;
    });
    return run();
  };

  let merged = 0;
  const openRows = () =>
    db
      .prepare(`${FULL_SELECT} WHERE status <> 'done' ORDER BY id ASC`)
      .all() as FullRow[];

  const groups = new Map<string, FullRow[]>();
  for (const row of openRows()) {
    if (!row.commenter_key) continue;
    const bucket = `${row.source}\0${row.commenter_key}`;
    const list = groups.get(bucket) ?? [];
    list.push(row);
    groups.set(bucket, list);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const canonical = list[0];
    for (const extra of list.slice(1)) {
      if (fold(canonical.id, extra.id)) merged += 1;
    }
  }

  const fresh = openRows();
  const bySource = new Map<string, FullRow[]>();
  for (const row of fresh) {
    const list = bySource.get(row.source) ?? [];
    list.push(row);
    bySource.set(row.source, list);
  }
  for (const list of bySource.values()) {
    const byName = new Map<string, FullRow[]>();
    for (const row of list) {
      const name = usefulName(row.author_name);
      if (!name || row.source === "whatsapp") continue;
      const named = byName.get(name) ?? [];
      named.push(row);
      byName.set(name, named);
    }
    for (const named of byName.values()) {
      if (named.length < 2) continue;
      const stable = named.filter((row) => row.commenter_key && !row.commenter_key.startsWith("name:"));
      const anchor = (stable[0] ?? named[0])!;
      for (const extra of named) {
        if (extra.id === anchor.id) continue;
        if (extra.commenter_key && !extra.commenter_key.startsWith("name:") && extra.commenter_key !== anchor.commenter_key) {
          continue;
        }
        if (fold(anchor.id, extra.id)) merged += 1;
      }
    }
  }
  return merged;
}

function assertNoOpenDuplicates(): void {
  const dupes = db
    .prepare(
      `SELECT source, commenter_key, COUNT(*) AS n
       FROM comments
       WHERE commenter_key IS NOT NULL AND status <> 'done'
       GROUP BY source, commenter_key
       HAVING COUNT(*) > 1`
    )
    .all() as Array<{ source: string; commenter_key: string; n: number }>;
  if (dupes.length) {
    throw new Error(`[inbox] 未完成對話仍然有重複留言者，未建立唯一索引：${JSON.stringify(dupes)}`);
  }
}

/**
 * 啟動時把已經拆開、但未完成嘅同一留言者併入最早嗰個 ID。
 * 已完成嘅列保留自己嘅 ID。跟住先建立「每個留言者只有一條未完成」索引。
 */
export function unifyOpenCommenterThreads(): number {
  backfillCommenterKeys();
  const merged = foldOpenDuplicates();
  assertNoOpenDuplicates();
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${OPEN_COMMENTER_INDEX}
     ON comments(source, commenter_key)
     WHERE commenter_key IS NOT NULL AND status <> 'done'`
  );
  if (merged > 0) {
    console.log(`[inbox] 已將 ${merged} 條未完成重複對話併入同一留言者 ID`);
  }
  return merged;
}
