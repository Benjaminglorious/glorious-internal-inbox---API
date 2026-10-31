import { sendNotification, setVapidDetails, WebPushError } from "web-push";
import { db } from "../db";
import { intakeSummary } from "../labels";
import { canViewComment } from "./comments";

/** 新寫入嘅留言。改狀態、改派、同事回覆、附加舊對話都唔經呢度。 */
export interface NewCommentNotice {
  id: number;
  source: string;
  author_name: string;
  body: string;
  intake_kind?: string | null;
  origin_site?: string | null;
  entry_path?: string | null;
}

interface StoredSubscription {
  staff_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  is_admin: number;
  active: number;
}

const MAX_PER_STAFF = 10;
const FLUSH_MS = 300;
const PUSH_TTL_SECONDS = 24 * 60 * 60;

let vapidState: "unchecked" | "ready" | "off" = "unchecked";
let cachedPublicKey: string | null = null;
const pending: NewCommentNotice[] = [];
let flushTimer: NodeJS.Timeout | null = null;

function readVapid(): { subject: string; publicKey: string; privateKey: string } | null {
  const subject = process.env.VAPID_SUBJECT?.trim() ?? "";
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? "";
  if (!subject || !publicKey || !privateKey) {
    if (subject || publicKey || privateKey) {
      console.error("[push] VAPID 未齊（要 PUBLIC、PRIVATE、SUBJECT），Web Push 未啟用");
    }
    return null;
  }
  if (!/^mailto:/i.test(subject) && !/^https:\/\//i.test(subject)) {
    console.error("[push] VAPID_SUBJECT 必須係 mailto: 或 https: URL，Web Push 未啟用");
    return null;
  }
  return { subject, publicKey, privateKey };
}

/** 三項 VAPID 都有效先算啟用。缺一項就當未設定，唔會阻住網頁。 */
export function isPushConfigured(): boolean {
  if (vapidState === "unchecked") {
    const vapid = readVapid();
    if (!vapid) {
      vapidState = "off";
      cachedPublicKey = null;
    } else {
      try {
        setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
        cachedPublicKey = vapid.publicKey;
        vapidState = "ready";
      } catch (err) {
        cachedPublicKey = null;
        vapidState = "off";
        const message = err instanceof Error ? err.message : "invalid vapid";
        console.error(`[push] VAPID 金鑰無效，Web Push 未啟用：${message}`);
      }
    }
  }
  return vapidState === "ready";
}

export function vapidPublicKey(): string | null {
  if (!isPushConfigured()) return null;
  return cachedPublicKey;
}

function parseEndpoint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 12 || trimmed.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url.toString();
}

function parseKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 200) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

export function savePushSubscription(
  staffId: number,
  body: unknown,
  userAgent: string | null
): { ok: true } | { ok: false; error: string } {
  if (!Number.isInteger(staffId) || staffId <= 0) return { ok: false, error: "無效同事" };
  if (!body || typeof body !== "object") return { ok: false, error: "訂閱資料不完整" };
  const record = body as { endpoint?: unknown; keys?: unknown };
  const endpoint = parseEndpoint(record.endpoint);
  const keys =
    record.keys && typeof record.keys === "object"
      ? (record.keys as { p256dh?: unknown; auth?: unknown })
      : null;
  const p256dh = keys ? parseKey(keys.p256dh) : null;
  const auth = keys ? parseKey(keys.auth) : null;
  if (!endpoint || !p256dh || !auth) return { ok: false, error: "訂閱資料不完整" };

  const agent = (userAgent ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || null;
  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO push_subscriptions (staff_id, endpoint, p256dh, auth, user_agent)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         staff_id = excluded.staff_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         updated_at = datetime('now')`
    ).run(staffId, endpoint, p256dh, auth, agent);
    db.prepare(
      `DELETE FROM push_subscriptions
       WHERE staff_id = ?
         AND id NOT IN (
           SELECT id FROM push_subscriptions
           WHERE staff_id = ?
           ORDER BY updated_at DESC, id DESC
           LIMIT ?
         )`
    ).run(staffId, staffId, MAX_PER_STAFF);
  });
  write();
  return { ok: true };
}

export function removePushSubscription(
  staffId: number,
  body: unknown
): { ok: true; removed: boolean } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "訂閱資料不完整" };
  const endpoint = parseEndpoint((body as { endpoint?: unknown }).endpoint);
  if (!endpoint) return { ok: false, error: "訂閱資料不完整" };
  const info = db
    .prepare(`DELETE FROM push_subscriptions WHERE staff_id = ? AND endpoint = ?`)
    .run(staffId, endpoint);
  return { ok: true, removed: info.changes > 0 };
}

function subscriptionCount(): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).get() as { n: number };
  return Number(row.n) || 0;
}

function listSubscriptions(): StoredSubscription[] {
  return db
    .prepare(
      `SELECT p.staff_id, p.endpoint, p.p256dh, p.auth, s.is_admin, s.active
       FROM push_subscriptions p
       JOIN staff s ON s.id = p.staff_id
       WHERE s.active = 1
       ORDER BY p.id ASC`
    )
    .all() as StoredSubscription[];
}

/** 推送同列表用同一可見範圍。收藏（active=0）唔收；未派只係管理員。 */
export function notificationVisibleTo(
  staff: { id: number; is_admin: number; active: number },
  assigneeStaffId: number | null
): boolean {
  if (!staff.active) return false;
  return canViewComment(
    { assignee_staff_id: assigneeStaffId },
    { staffId: staff.id, isAdmin: !!staff.is_admin }
  );
}

function assigneeByCommentId(ids: number[]): Map<number, number | null> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  const found = new Map<number, number | null>();
  if (!unique.length) return found;
  const placeholders = unique.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT id, assignee_staff_id FROM comments WHERE id IN (${placeholders})`)
    .all(...unique) as Array<{ id: number; assignee_staff_id: number | null }>;
  for (const row of rows) found.set(row.id, row.assignee_staff_id);
  return found;
}

function previewText(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "（沒有內容）";
  if (flat.length <= 80) return flat;
  return `${flat.slice(0, 80)}…`;
}

function oneLine(comment: NewCommentNotice): string {
  const source = intakeSummary(comment);
  const author = comment.author_name.replace(/\s+/g, " ").trim() || "（無名）";
  return `${source} · ${author}：${previewText(comment.body)}`;
}

function buildPayload(comments: NewCommentNotice[]): string {
  const latest = comments[comments.length - 1];
  const body =
    comments.length > 1 ? `共 ${comments.length} 則新留言。最新：${oneLine(latest)}` : oneLine(latest);
  return JSON.stringify({
    title: "有新留言",
    body,
    url: `/comments/${latest.id}`,
    tag: comments.length > 1 ? "glorious-inbox-new" : `glorious-inbox-${latest.id}`,
  });
}

function safeError(err: unknown): string {
  const status = err instanceof WebPushError ? err.statusCode : 0;
  const raw = err instanceof Error ? err.message : "unknown";
  const brief = raw.replace(/https?:\/\/\S+/g, "[url]").slice(0, 160);
  return status ? `status=${status} ${brief}` : brief;
}

async function sendOne(sub: StoredSubscription, payload: string): Promise<boolean> {
  try {
    await sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
      { TTL: PUSH_TTL_SECONDS, urgency: "high", topic: "glorious-inbox" }
    );
    return true;
  } catch (err) {
    const status = err instanceof WebPushError ? err.statusCode : 0;
    if (status === 404 || status === 410) {
      db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(sub.endpoint);
    }
    console.error(`[push] 送唔到 staff=${sub.staff_id} ${safeError(err)}`);
    return false;
  }
}

async function deliver(comments: NewCommentNotice[]): Promise<void> {
  if (!comments.length || !isPushConfigured()) return;
  const subs = listSubscriptions();
  if (!subs.length) return;
  const assignees = assigneeByCommentId(comments.map((comment) => comment.id));
  const byStaff = new Map<number, StoredSubscription[]>();
  for (const sub of subs) {
    const list = byStaff.get(sub.staff_id) ?? [];
    list.push(sub);
    byStaff.set(sub.staff_id, list);
  }

  let sent = 0;
  let failed = 0;
  const jobs: Promise<void>[] = [];
  for (const [staffId, staffSubs] of byStaff) {
    const sample = staffSubs[0];
    const visible = comments.filter((comment) =>
      notificationVisibleTo(
        { id: staffId, is_admin: sample.is_admin, active: sample.active },
        assignees.get(comment.id) ?? null
      )
    );
    if (!visible.length) continue;
    const payload = buildPayload(visible);
    const ids = visible.map((comment) => comment.id).join(",");
    console.log(`[push] 新留言 #${ids} → staff=${staffId} 訂閱 ${staffSubs.length}`);
    for (const sub of staffSubs) {
      jobs.push(
        sendOne(sub, payload).then((ok) => {
          if (ok) sent += 1;
          else failed += 1;
        })
      );
    }
  }
  await Promise.all(jobs);
  if (jobs.length) console.log(`[push] 已送出 ${sent}，失敗 ${failed}`);
}

function flush(): void {
  flushTimer = null;
  const batch = pending.splice(0, pending.length);
  const byId = new Map<number, NewCommentNotice>();
  for (const comment of batch) byId.set(comment.id, comment);
  const comments = [...byId.values()].sort((a, b) => a.id - b.id);
  void deliver(comments).catch((err) => {
    console.error("[push] 推送失敗", safeError(err));
  });
}

/**
 * 新留言入庫之後呼叫。會稍為合併同一輪插入，再按可見範圍推送：
 * 管理員收到全部（包括未派）；在職同事只收到派咗畀自己嘅。收藏同事唔推。
 * 未設定 VAPID 或未有訂閱時立即返回，唔會拖慢 webhook／seed。
 * 日後 adapter 寫入新留言都要呼叫呢度。
 */
export function notifyNewComment(comment: NewCommentNotice): void {
  if (!comment || !Number.isInteger(comment.id) || comment.id <= 0) return;
  if (!isPushConfigured()) return;
  if (subscriptionCount() === 0) return;
  pending.push(comment);
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_MS);
}
