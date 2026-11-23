import { db } from "../db";
import { formatUtcTimestamp } from "./reply-sla-clock";

/**
 * 指定來源帖文／Reel → 同事。新入站如果帶住呢啲編號或 permalink，公司輪流唔適用，直接派畀呢位同事。
 * 對照係編號同連結入面嘅獨立一段（composite post id、Reel／video id、IG media id、ig_id、shortcode）。
 * 唔用 caption 關鍵字。其他帖文即使寫到「360」或「Rosso」都唔會撞到。
 *
 * 2026-11-23 約 17:44 HKT，Facebook 同 Instagram 同一條 Ferrari 360 Challenge Stradale Reel。
 * Tony 要求留言、Messenger、Instagram 私訊、同埋帶住呢條 Reel referral 嘅 WhatsApp，全部派畀 Ken Kan（username=ken）。
 * Ken 即使因為回覆逾時而暫停自動派單，呢條 Reel 仍然派畀佢。呢度唔讀、唔寫 staff_reply_sla，所以暫停時間同累積次數都唔會被倒退或清走。
 * 指定派單亦唔會呼叫輪流，所以 auto_assign_state 游標唔會因為呢啲對話而推進。
 * Tony、Benjamin、Vivian、Raymond 仍然唔參與公司輪流；呢條對照只會派畀表入面嘅用戶名，唔會改派畀管理員。
 */
export interface PinnedSourceAssignment {
  /** app_boot_once 的 key。改咗就會喺下次啟動再改派一次未完成的對應對話。 */
  onceKey: string;
  staffUsername: string;
  /**
   * meta_post_id 可能出現嘅完整值，或者 permalink／複合 id 入面嘅獨立一段。
   * 1645104830962403 係專頁帖文 composite 嘅 story_fbid（後半），permalink.php 同部份 webhook 會單獨交呢個。
   */
  ids: readonly string[];
  /** permalink 路徑一段。Instagram shortcode 區分大小寫。 */
  shortcodes: readonly string[];
}

export const FERRARI_360_CS_REEL_ONCE_KEY = "assign_ferrari_360_cs_reel_ken_20261123";

export const PINNED_SOURCE_ASSIGNMENTS: readonly PinnedSourceAssignment[] = [
  {
    onceKey: FERRARI_360_CS_REEL_ONCE_KEY,
    staffUsername: "ken",
    ids: [
      "317388328327472_1645104830962403",
      "1645104830962403",
      "1152546584163003",
      "17954673084307814",
      "4036657255367133420",
    ],
    shortcodes: ["DgFFmL6KUjs"],
  },
];

const META_HOSTS = [
  "instagram.com",
  "instagr.am",
  "facebook.com",
  "fb.com",
  "fb.me",
  "fb.watch",
  "m.facebook.com",
  "mbasic.facebook.com",
];

const PERMALINK_QUERY_KEYS = ["story_fbid", "fbid", "v", "post_id", "media_id"];

export interface PinnedSourceAssignOnceResult {
  /** 今次有沒有寫入至少一個 boot 標記。已經跑過、或者指定同事未在職，就係 false。 */
  applied: boolean;
  /** 今次由其他人改派去指定同事的未完成對話數。 */
  reassigned: number;
  /** 來源吻合、未完成、而且本來已經係指定同事。 */
  already: number;
}

function knownToken(rule: PinnedSourceAssignment, token: string): boolean {
  if (!token) return false;
  return rule.ids.includes(token) || rule.shortcodes.includes(token);
}

function isMetaHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  if (META_HOSTS.includes(host)) return true;
  return (
    host.endsWith(".instagram.com") ||
    host.endsWith(".facebook.com") ||
    host.endsWith(".fb.com") ||
    host.endsWith(".fb.me")
  );
}

function idMatches(rule: PinnedSourceAssignment, raw: string): boolean {
  const id = raw.trim();
  if (!id) return false;
  if (knownToken(rule, id)) return true;
  const parts = id.split("_");
  if (parts.length < 2) return false;
  if (!parts.every((part) => /^[0-9A-Za-z]{1,32}$/.test(part))) return false;
  return parts.some((part) => knownToken(rule, part));
}

function permalinkMatches(rule: PinnedSourceAssignment, raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (!isMetaHost(url.hostname)) return false;
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  if (segments.some((segment) => knownToken(rule, segment))) return true;
  for (const key of PERMALINK_QUERY_KEYS) {
    const value = (url.searchParams.get(key) ?? "").trim();
    if (value && knownToken(rule, value)) return true;
  }
  return false;
}

function fieldMatches(rule: PinnedSourceAssignment, value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  if (idMatches(rule, text)) return true;
  if (/^https?:\/\//i.test(text)) return permalinkMatches(rule, text);
  return false;
}

function ruleMatches(
  rule: PinnedSourceAssignment,
  metaPostId: string | null | undefined,
  metaPostPermalink: string | null | undefined
): boolean {
  return fieldMatches(rule, metaPostId) || fieldMatches(rule, metaPostPermalink);
}

/** 呢個 post id 或 permalink 係不是指定來源。唔睇 caption。 */
export function matchesPinnedSourcePost(
  metaPostId: string | null | undefined,
  metaPostPermalink: string | null | undefined
): boolean {
  return PINNED_SOURCE_ASSIGNMENTS.some((rule) => ruleMatches(rule, metaPostId, metaPostPermalink));
}

function activeStaffId(username: string): number | null {
  const row = db.prepare(`SELECT id, active FROM staff WHERE lower(username) = ?`).get(username.toLowerCase()) as
    | { id: number; active: number | boolean }
    | undefined;
  if (!row || Number(row.active) !== 1) return null;
  return Number(row.id);
}

/**
 * 來源吻合時返回指定同事的 staff.id。唔吻合、或者該同事未在職，返回 null，呼叫方用公司輪流。
 * 吻合而且同事在職時，即使 staff_reply_sla 暫停未到期都返回佢。呢個函數唔會更新逾時次數或暫停欄。
 */
export function pinnedSourceAssigneeStaffId(
  metaPostId: string | null | undefined,
  metaPostPermalink: string | null | undefined
): number | null {
  const rule = PINNED_SOURCE_ASSIGNMENTS.find((item) => ruleMatches(item, metaPostId, metaPostPermalink));
  if (!rule) return null;
  const staffId = activeStaffId(rule.staffUsername);
  if (staffId == null) {
    console.warn(
      `[assign] 帖文指定派畀 ${rule.staffUsername}，但搵唔到在職同事，改回公司輪流（逾時暫停紀錄唔會改）`
    );
    return null;
  }
  return staffId;
}

/**
 * 啟動時一次過：未完成（未處理／處理中）而且 meta_post_id 或 meta_post_permalink 吻合指定來源的對話，改派畀指定同事。
 * 已完成唔會改派，亦唔會改狀態，所以唔會為咗改派而重開。
 * 唔改正文、caption、其他帖文的負責人、回覆逾時次數或暫停。
 * 標記同更新同一筆交易。指定同事未在職就唔寫標記，下次啟動再試。標記寫入之後唔會再改派。
 */
export function assignPinnedSourceThreadsOnce(now = new Date()): PinnedSourceAssignOnceResult {
  const stamp = formatUtcTimestamp(now);
  return db.transaction((): PinnedSourceAssignOnceResult => {
    let applied = false;
    let reassigned = 0;
    let already = 0;
    const rows = () =>
      db
        .prepare(
          `SELECT id, meta_post_id, meta_post_permalink, assignee_staff_id
           FROM comments
           WHERE status <> 'done'
             AND (
               (meta_post_id IS NOT NULL AND trim(meta_post_id) <> '')
               OR (meta_post_permalink IS NOT NULL AND trim(meta_post_permalink) <> '')
             )`
        )
        .all() as Array<{
        id: number;
        meta_post_id: string | null;
        meta_post_permalink: string | null;
        assignee_staff_id: number | null;
      }>;
    const update = db.prepare(
      `UPDATE comments
       SET assignee_staff_id = ?, updated_at = datetime('now')
       WHERE id = ? AND status <> 'done'`
    );

    for (const rule of PINNED_SOURCE_ASSIGNMENTS) {
      const staffId = activeStaffId(rule.staffUsername);
      if (staffId == null) {
        console.warn(
          `[boot] 指定帖文改派未跑（${rule.onceKey}）：搵唔到在職同事 ${rule.staffUsername}。下次啟動再試。逾時紀錄唔會改。`
        );
        continue;
      }
      const claim = db
        .prepare(`INSERT INTO app_boot_once (key, applied_at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`)
        .run(rule.onceKey, stamp);
      if (claim.changes !== 1) continue;
      applied = true;
      for (const row of rows()) {
        if (!ruleMatches(rule, row.meta_post_id, row.meta_post_permalink)) continue;
        if (row.assignee_staff_id != null && Number(row.assignee_staff_id) === staffId) {
          already += 1;
          continue;
        }
        const result = update.run(staffId, row.id);
        if (result.changes === 1) reassigned += 1;
      }
    }
    return { applied, reassigned, already };
  })();
}
