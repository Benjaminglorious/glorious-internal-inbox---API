/**
 * 28car 車盤、留言板同同事回覆隊列。
 * 買家留言入收件箱（entry_path=28car_board）。賣家帖只留喺車盤。
 * 即時讀寫要旗標，而且每次動作換一個代理。未有代理就完全唔出網絡。
 */
import type { OutboundReplyRequest, OutboundReplyResult } from "../adapters/outbound";
import { stubOutbound } from "../adapters/outbound";
import {
  accountByUsername,
  dealerListingUrl,
  maxAccountsPerRun,
  maxDetailFetches,
  publicListingUrl,
  readAccounts,
  readEgress,
  readLoginForm,
  redactSecrets,
  replyPostEnabled,
  requestGapMs,
  syncEnabled,
  twentyeightcarStatus,
  type DealerAccount,
} from "../adapters/twentyeightcar-config";
import { allocateLease, type EgressLease } from "../adapters/twentyeightcar-egress";
import {
  fetchListingBoard,
  fetchSellList,
  postOwnerReply,
  type NetResult,
} from "../adapters/twentyeightcar-http";
import {
  parseBoardHtml,
  parseSellListHtml,
  type ParsedBoard,
  type ParsedBoardMessage,
  type ParsedListing,
} from "../adapters/twentyeightcar-parse";
import { db } from "../db";
import type { EntryPath } from "../types";
import { upsertSiteComment } from "./site-comments";

const OBSERVED_ACCOUNT = "gmld28013@hotmail.com";
const OBSERVED_SELLER_BODY = [
  "睇靚車？即上：",
  "https://api.whatsapp.com/send?phone=85221740001",
  "https://www.glorious.hk/cn2/car_detail?cid=19230",
  "https://www.facebook.com/GloriousMotors/",
  "IG | YouTube以下",
  "Glorious Motors Limited 東榮汽車",
].join("\n");

const OBSERVED_LISTINGS: ParsedListing[] = [
  {
    stockId: "s2806213",
    vid: null,
    title: "麥拿倫 720S 2017",
    priceHkd: 2280001,
    priceText: "$2,280,001",
    commentCount: 1,
    listingUpdatedAt: "2026-10-23",
    year: "2017",
  },
  {
    stockId: "s2800221",
    vid: null,
    title: "寶馬 I8 2015",
    priceHkd: 508000,
    priceText: "$508,000",
    commentCount: 1,
    listingUpdatedAt: "2026-10-23",
    year: "2015",
  },
  {
    stockId: "s2807785",
    vid: null,
    title: "勞斯萊斯 PHANTOM EWB 2011",
    priceHkd: 1680000,
    priceText: "$1,680,000",
    commentCount: 1,
    listingUpdatedAt: "2026-10-12",
    year: "2011",
  },
  {
    stockId: "s2720395",
    vid: null,
    title: "豐田 ALPHARD 2.5Z 2026",
    priceHkd: 678000,
    priceText: "$678,000",
    commentCount: 1,
    listingUpdatedAt: "2026-03-31",
    year: "2026",
  },
];

export interface ListingRow {
  id: number;
  stock_id: string;
  vid: string | null;
  account_username: string;
  title: string;
  price_hkd: number | null;
  price_text: string | null;
  comment_count: number | null;
  listing_updated_at: string | null;
  public_url: string | null;
  dealer_url: string | null;
  blurb: string | null;
  active: boolean;
  sync_origin: string | null;
  last_synced_at: string | null;
  updated_at: string;
  buyer_count: number;
  seller_count: number;
}

export interface ListingMessageRow {
  id: number;
  stock_id: string;
  external_id: string;
  author_name: string;
  body: string;
  is_seller: boolean;
  posted_at: string | null;
  inbox_comment_id: number | null;
}

export interface SyncReport {
  mode: string;
  network: boolean;
  listings_upserted: number;
  buyer_comments_upserted: number;
  accounts_attempted: number;
  stopped: string | null;
  inboxComments: Array<{ external_id: string; author_name: string; body: string; vehicle_ref: string | null }>;
}

interface RawListing {
  stock_id: string;
  vid: string | null;
  account_username: string;
  title: string;
  price_hkd: number | null;
  price_text: string | null;
  comment_count: number | null;
  listing_updated_at: string | null;
  public_url: string | null;
  dealer_url: string | null;
  blurb: string | null;
  active: number;
  sync_origin: string | null;
  last_synced_at: string | null;
  updated_at: string;
  buyer_count: number | null;
  seller_count: number | null;
}

const LISTING_SELECT = `
  SELECT l.id, l.stock_id, l.vid, l.account_username, l.title, l.price_hkd, l.price_text,
         l.comment_count, l.listing_updated_at, l.public_url, l.dealer_url, l.blurb,
         l.active, l.sync_origin, l.last_synced_at, l.updated_at,
         (SELECT COUNT(*) FROM car_listing_messages m WHERE m.stock_id = l.stock_id AND m.is_seller = 0) AS buyer_count,
         (SELECT COUNT(*) FROM car_listing_messages m WHERE m.stock_id = l.stock_id AND m.is_seller = 1) AS seller_count
  FROM car_listings l
`;

function mapListing(row: RawListing & { id: number }): ListingRow {
  return {
    id: row.id,
    stock_id: row.stock_id,
    vid: row.vid,
    account_username: row.account_username,
    title: row.title,
    price_hkd: row.price_hkd,
    price_text: row.price_text,
    comment_count: row.comment_count,
    listing_updated_at: row.listing_updated_at,
    public_url: row.public_url,
    dealer_url: row.dealer_url,
    blurb: row.blurb,
    active: row.active === 1,
    sync_origin: row.sync_origin,
    last_synced_at: row.last_synced_at,
    updated_at: row.updated_at,
    buyer_count: Number(row.buyer_count) || 0,
    seller_count: Number(row.seller_count) || 0,
  };
}

export function stockIdFromText(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /\b(s\d{6,8})\b/i.exec(value);
  return match ? match[1].toLowerCase() : null;
}

export function listListings(account?: string): ListingRow[] {
  const username = account?.trim().toLowerCase();
  const rows = (
    username
      ? db.prepare(`${LISTING_SELECT} WHERE l.account_username = ? ORDER BY l.listing_updated_at DESC, l.stock_id`).all(username)
      : db.prepare(`${LISTING_SELECT} WHERE l.active = 1 ORDER BY l.listing_updated_at DESC, l.stock_id`).all()
  ) as Array<RawListing & { id: number }>;
  return rows.map(mapListing);
}

export function getListing(stockId: string): ListingRow | null {
  const id = stockIdFromText(stockId);
  if (!id) return null;
  const row = db.prepare(`${LISTING_SELECT} WHERE l.stock_id = ?`).get(id) as (RawListing & { id: number }) | undefined;
  return row ? mapListing(row) : null;
}

export function listListingMessages(stockId: string): ListingMessageRow[] {
  const id = stockIdFromText(stockId);
  if (!id) return [];
  const rows = db
    .prepare(
      `SELECT id, stock_id, external_id, author_name, body, is_seller, posted_at, inbox_comment_id
       FROM car_listing_messages WHERE stock_id = ? ORDER BY id ASC`
    )
    .all(id) as Array<Omit<ListingMessageRow, "is_seller"> & { is_seller: number }>;
  return rows.map((row) => ({ ...row, is_seller: row.is_seller === 1 }));
}

function upsertListing(input: {
  listing: ParsedListing;
  accountUsername: string;
  blurb?: string | null;
  syncOrigin: string;
  preserveVid: boolean;
}): void {
  const vid = input.listing.vid;
  const publicUrl = vid ? publicListingUrl(vid) : null;
  const dealerUrl = vid ? dealerListingUrl(vid) : null;
  db.prepare(
    `INSERT INTO car_listings (
       source, stock_id, vid, account_username, title, price_hkd, price_text, comment_count,
       listing_updated_at, public_url, dealer_url, blurb, active, sync_origin, last_synced_at, updated_at
     ) VALUES ('28car', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))
     ON CONFLICT(source, stock_id) DO UPDATE SET
       vid = CASE WHEN ? = 1 THEN COALESCE(car_listings.vid, excluded.vid) ELSE COALESCE(excluded.vid, car_listings.vid) END,
       account_username = excluded.account_username,
       title = excluded.title,
       price_hkd = excluded.price_hkd,
       price_text = excluded.price_text,
       comment_count = COALESCE(excluded.comment_count, car_listings.comment_count),
       listing_updated_at = COALESCE(excluded.listing_updated_at, car_listings.listing_updated_at),
       public_url = COALESCE(excluded.public_url, car_listings.public_url),
       dealer_url = COALESCE(excluded.dealer_url, car_listings.dealer_url),
       blurb = COALESCE(excluded.blurb, car_listings.blurb),
       active = 1,
       sync_origin = excluded.sync_origin,
       last_synced_at = datetime('now'),
       updated_at = datetime('now')`
  ).run(
    input.listing.stockId,
    vid,
    input.accountUsername,
    input.listing.title,
    input.listing.priceHkd,
    input.listing.priceText,
    input.listing.commentCount,
    input.listing.listingUpdatedAt,
    publicUrl,
    dealerUrl,
    input.blurb ?? null,
    input.syncOrigin,
    input.preserveVid ? 1 : 0
  );
}

function replaceBoardMessages(stockId: string, board: ParsedBoard, account: DealerAccount): number {
  if (!board.found || board.unparsed) return 0;
  const keep = board.messages.map((message) => message.externalId);
  if (keep.length === 0) {
    db.prepare(`DELETE FROM car_listing_messages WHERE stock_id = ?`).run(stockId);
  } else {
    const placeholders = keep.map(() => "?").join(", ");
    db.prepare(`DELETE FROM car_listing_messages WHERE stock_id = ? AND external_id NOT IN (${placeholders})`).run(
      stockId,
      ...keep
    );
  }
  let buyers = 0;
  const upsert = db.prepare(
    `INSERT INTO car_listing_messages (
       stock_id, external_id, author_name, body, is_seller, posted_at, inbox_comment_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(stock_id, external_id) DO UPDATE SET
       author_name = excluded.author_name,
       body = excluded.body,
       is_seller = excluded.is_seller,
       posted_at = excluded.posted_at,
       inbox_comment_id = COALESCE(excluded.inbox_comment_id, car_listing_messages.inbox_comment_id),
       updated_at = datetime('now')`
  );
  for (const message of board.messages) {
    const inboxId = message.isSeller ? null : promoteBuyer(stockId, message);
    if (inboxId) buyers += 1;
    upsert.run(stockId, message.externalId, message.authorName, message.body, message.isSeller ? 1 : 0, message.postedAt, inboxId);
  }
  if (board.blurb) {
    db.prepare(`UPDATE car_listings SET blurb = ? WHERE stock_id = ?`).run(board.blurb, stockId);
  }
  void account;
  return buyers;
}

function promoteBuyer(stockId: string, message: ParsedBoardMessage): number | null {
  const listing = getListing(stockId);
  const title = listing?.title || stockId;
  const vehicle = `${stockId} ${title}`.slice(0, 120);
  const externalId = `28car:${stockId}:${message.externalId}`.slice(0, 200);
  const saved = upsertSiteComment({
    source: "28car",
    external_id: externalId,
    author_name: message.authorName,
    body: message.body,
    vehicle_ref: vehicle,
    entry_path: "28car_board" satisfies EntryPath,
  });
  return saved.ok ? saved.comment.id : null;
}

export function ingestSellListHtml(html: string, accountUsername: string): number {
  const listings = parseSellListHtml(html);
  const username = accountUsername.trim().toLowerCase();
  const tx = db.transaction(() => {
    for (const listing of listings) {
      upsertListing({ listing, accountUsername: username, syncOrigin: "sell_list", preserveVid: false });
    }
    if (listings.length > 0) {
      const ids = listings.map((listing) => listing.stockId);
      const placeholders = ids.map(() => "?").join(", ");
      db.prepare(
        `UPDATE car_listings SET active = 0, updated_at = datetime('now')
         WHERE account_username = ? AND stock_id NOT IN (${placeholders})`
      ).run(username, ...ids);
    }
  });
  tx();
  return listings.length;
}

export function ingestBoardHtml(html: string, stockId: string, accountUsername: string): { buyers: number; sellers: number } {
  const board = parseBoardHtml(html);
  const id = stockIdFromText(stockId);
  if (!id) return { buyers: 0, sellers: 0 };
  const account = accountByUsername(accountUsername) ?? {
    username: accountUsername.trim().toLowerCase(),
    password: "",
    displayName: null,
  };
  const buyers = replaceBoardMessages(id, board, account);
  const sellers = board.messages.filter((message) => message.isSeller).length;
  return { buyers, sellers };
}

/** 2026-10-31 觀察到嘅 gmld28013 車盤。vid 未確認，所以公開連結留空。 */
export function upsertObservedDealerListings(): number {
  const tx = db.transaction(() => {
    for (const listing of OBSERVED_LISTINGS) {
      upsertListing({
        listing,
        accountUsername: OBSERVED_ACCOUNT,
        syncOrigin: "observed",
        preserveVid: true,
      });
      const existing = db
        .prepare(`SELECT COUNT(*) AS n FROM car_listing_messages WHERE stock_id = ?`)
        .get(listing.stockId) as { n: number };
      if (existing.n === 0) {
        db.prepare(
          `INSERT INTO car_listing_messages (stock_id, external_id, author_name, body, is_seller, posted_at)
           VALUES (?, 'observed-seller-whatsapp', '東榮汽車', ?, 1, NULL)`
        ).run(listing.stockId, OBSERVED_SELLER_BODY);
      }
      if (listing.stockId === "s2806213") {
        const buyer = db
          .prepare(`SELECT id FROM comments WHERE source = '28car' AND external_id = '28car:s2806213:demo-buyer'`)
          .get() as { id: number } | undefined;
        db.prepare(
          `INSERT INTO car_listing_messages (
             stock_id, external_id, author_name, body, is_seller, posted_at, inbox_comment_id
           ) VALUES ('s2806213', 'demo-buyer', '李先生', ?, 0, NULL, ?)
           ON CONFLICT(stock_id, external_id) DO UPDATE SET
             inbox_comment_id = COALESCE(excluded.inbox_comment_id, car_listing_messages.inbox_comment_id),
             updated_at = datetime('now')`
        ).run("我想喺 28car 留言板問麥拿倫 720S，星期六下午可唔可以睇車？", buyer?.id ?? null);
      }
    }
  });
  tx();
  return OBSERVED_LISTINGS.length;
}

function rememberSync(mode: string, error: string | null, listings: number, comments: number, network: boolean): void {
  db.prepare(
    `INSERT INTO car_sync_state (source, last_run_at, last_mode, last_error, listings_upserted, comments_upserted, network_used)
     VALUES ('28car', datetime('now'), ?, ?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET
       last_run_at = datetime('now'),
       last_mode = excluded.last_mode,
       last_error = excluded.last_error,
       listings_upserted = excluded.listings_upserted,
       comments_upserted = excluded.comments_upserted,
       network_used = excluded.network_used`
  ).run(mode, error, listings, comments, network ? 1 : 0);
}

function lastLeaseId(): string | null {
  const row = db.prepare(`SELECT last_lease_id FROM car_egress_state WHERE id = 1`).get() as
    | { last_lease_id: string | null }
    | undefined;
  return row?.last_lease_id ?? null;
}

function takeLease(operation: string): EgressLease | { error: string } {
  const picked = allocateLease(operation, lastLeaseId());
  if ("error" in picked) return picked;
  db.prepare(
    `INSERT INTO car_egress_state (id, last_lease_id, last_operation, updated_at)
     VALUES (1, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       last_lease_id = excluded.last_lease_id,
       last_operation = excluded.last_operation,
       updated_at = datetime('now')`
  ).run(picked.lease.leaseId, operation);
  return picked.lease;
}

let sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function setTwentyeightcarSleepForTests(next: ((ms: number) => Promise<void>) | null): void {
  sleepImpl = next ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

async function pause(first: boolean): Promise<void> {
  if (first) return;
  await sleepImpl(requestGapMs());
}

function emptyReport(mode: string, error: string | null): SyncReport {
  rememberSync(mode, error, 0, 0, false);
  return {
    mode,
    network: false,
    listings_upserted: 0,
    buyer_comments_upserted: 0,
    accounts_attempted: 0,
    stopped: error,
    inboxComments: [],
  };
}

export async function syncTwentyeightcar(): Promise<SyncReport> {
  if (!syncEnabled()) return emptyReport("disabled", null);
  const egress = readEgress();
  if (!egress.canRotate) return emptyReport("proxy_required", egress.error);
  const login = readLoginForm();
  if (!login) return emptyReport("login_form_unconfirmed", "未確認登入表單欄位，未有任何登入請求");
  const { accounts } = readAccounts();
  if (accounts.length === 0) return emptyReport("no_accounts", "未設定 28car 帳號");

  const report: SyncReport = {
    mode: "live",
    network: true,
    listings_upserted: 0,
    buyer_comments_upserted: 0,
    accounts_attempted: 0,
    stopped: null,
    inboxComments: [],
  };
  let detailsLeft = maxDetailFetches();
  let first = true;
  let consecutiveBlocks = 0;
  const secrets = accounts.map((account) => account.password);

  for (const account of accounts.slice(0, maxAccountsPerRun())) {
    report.accounts_attempted += 1;
    await pause(first);
    first = false;
    const listLease = takeLease(`sell_list:${account.username}`);
    if ("error" in listLease) {
      report.stopped = listLease.error;
      break;
    }
    const list = await fetchSellList({ lease: listLease, account, login });
    if (!list.ok) {
      if (list.loginRejected || list.busy) {
        report.stopped = list.error;
        break;
      }
      if (list.blocked) {
        consecutiveBlocks += 1;
        report.stopped = list.error;
        if (consecutiveBlocks >= 2) break;
        continue;
      }
      report.stopped = list.error;
      break;
    }
    consecutiveBlocks = 0;
    const parsed = parseSellListHtml(list.body);
    report.listings_upserted += ingestSellListHtml(list.body, account.username);
    for (const listing of parsed) {
      if (!listing.vid || detailsLeft <= 0) continue;
      detailsLeft -= 1;
      await pause(false);
      const detailLease = takeLease(`sell_dsp:${account.username}:${listing.vid}`);
      if ("error" in detailLease) {
        report.stopped = detailLease.error;
        break;
      }
      const detail = await fetchListingBoard({ lease: detailLease, account, login, vid: listing.vid });
      if (!detail.ok) {
        report.stopped = detail.error;
        if (detail.busy || detail.loginRejected || detail.blocked) break;
        continue;
      }
      const board = parseBoardHtml(detail.body);
      const before = report.buyer_comments_upserted;
      report.buyer_comments_upserted += replaceBoardMessages(listing.stockId, board, account);
      if (report.buyer_comments_upserted > before) {
        for (const message of board.messages.filter((item) => !item.isSeller)) {
          report.inboxComments.push({
            external_id: `28car:${listing.stockId}:${message.externalId}`,
            author_name: message.authorName,
            body: message.body,
            vehicle_ref: listing.stockId,
          });
        }
      }
    }
    if (report.stopped) break;
  }

  rememberSync(
    report.mode,
    report.stopped ? redactSecrets(report.stopped, secrets) : null,
    report.listings_upserted,
    report.buyer_comments_upserted,
    true
  );
  if (report.stopped) report.stopped = redactSecrets(report.stopped, secrets);
  return report;
}

export interface ReplyQueueRow {
  id: number;
  comment_id: number;
  stock_id: string | null;
  vid: string | null;
  account_username: string | null;
  body: string;
  status: string;
  last_error: string | null;
  created_at: string;
}

export function listReplyQueue(limit = 30): ReplyQueueRow[] {
  return db
    .prepare(
      `SELECT id, comment_id, stock_id, vid, account_username, body, status, last_error, created_at
       FROM car_reply_queue ORDER BY id DESC LIMIT ?`
    )
    .all(Math.min(Math.max(limit, 1), 100)) as ReplyQueueRow[];
}

function insertHeld(input: {
  commentId: number;
  stockId: string | null;
  vid: string | null;
  accountUsername: string | null;
  body: string;
  error: string | null;
}): number {
  const info = db
    .prepare(
      `INSERT INTO car_reply_queue (comment_id, stock_id, vid, account_username, body, status, last_error)
       VALUES (?, ?, ?, ?, ?, 'held', ?)`
    )
    .run(input.commentId, input.stockId, input.vid, input.accountUsername, input.body, input.error);
  return Number(info.lastInsertRowid);
}

function finishQueue(id: number, status: "sent" | "failed" | "held", error: string | null): void {
  db.prepare(
    `UPDATE car_reply_queue SET status = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(status, error, id);
}

async function postQueued(row: { id: number; vid: string; account: DealerAccount; body: string }): Promise<NetResult> {
  const login = readLoginForm();
  if (!login) return { ok: false, blocked: false, busy: false, loginRejected: false, error: "未確認登入表單欄位" };
  const lease = takeLease(`reply:${row.account.username}:${row.vid}:${row.id}`);
  if ("error" in lease) return { ok: false, blocked: false, busy: false, loginRejected: false, error: lease.error };
  return postOwnerReply({
    lease,
    account: row.account,
    login,
    vid: row.vid,
    message: row.body,
  });
}

export async function queueTwentyeightcarReply(input: OutboundReplyRequest): Promise<OutboundReplyResult> {
  const stockId = stockIdFromText(input.vehicleRef) || stockIdFromText(input.externalId);
  const listing = stockId ? getListing(stockId) : null;
  if (!listing) return stubOutbound("28car_no_listing", "28car", input.commentId);

  const heldError = !listing.vid ? "已對到車盤，但未有 vid，未發送" : null;
  const queueId = insertHeld({
    commentId: input.commentId,
    stockId: listing.stock_id,
    vid: listing.vid,
    accountUsername: listing.account_username,
    body: input.body,
    error: heldError,
  });

  if (!replyPostEnabled()) return { delivery_status: "stored", provider: "28car_queued" };
  if (!readEgress().canRotate) {
    finishQueue(queueId, "held", "未設定可輪換代理，留言留喺隊列，未直連 28car");
    return { delivery_status: "stored", provider: "28car_queued" };
  }
  if (!listing.vid) return { delivery_status: "stored", provider: "28car_queued" };
  const account = accountByUsername(listing.account_username);
  if (!account || !readLoginForm()) {
    finishQueue(queueId, "held", "未有呢個帳號嘅登入設定或登入表單，未發送");
    return { delivery_status: "stored", provider: "28car_queued" };
  }

  const claimed = db
    .prepare(`UPDATE car_reply_queue SET status = 'posting', updated_at = datetime('now') WHERE id = ? AND status = 'held'`)
    .run(queueId);
  if (claimed.changes === 0) return { delivery_status: "stored", provider: "28car_queued" };

  const posted = await postQueued({ id: queueId, vid: listing.vid, account, body: input.body });
  if (posted.ok) {
    finishQueue(queueId, "sent", null);
    return { delivery_status: "sent", provider: "28car_board" };
  }
  const error = redactSecrets(posted.error, [account.password]);
  finishQueue(queueId, posted.busy ? "failed" : "failed", error);
  return { delivery_status: "failed", provider: "28car_board", error };
}

export async function flushHeldReplies(limit = 3): Promise<{ attempted: number; sent: number; stopped: string | null }> {
  if (!replyPostEnabled() || !readEgress().canRotate || !readLoginForm()) {
    return { attempted: 0, sent: 0, stopped: "旗標、代理或登入表單未齊，未發送" };
  }
  const rows = db
    .prepare(
      `SELECT id, comment_id, vid, account_username, body
       FROM car_reply_queue
       WHERE status = 'held' AND vid IS NOT NULL AND account_username IS NOT NULL
       ORDER BY id ASC LIMIT ?`
    )
    .all(Math.min(Math.max(limit, 1), 5)) as Array<{
    id: number;
    comment_id: number;
    vid: string;
    account_username: string;
    body: string;
  }>;
  let sent = 0;
  let attempted = 0;
  for (const row of rows) {
    const account = accountByUsername(row.account_username);
    if (!account) continue;
    const claimed = db
      .prepare(`UPDATE car_reply_queue SET status = 'posting', updated_at = datetime('now') WHERE id = ? AND status = 'held'`)
      .run(row.id);
    if (claimed.changes === 0) continue;
    attempted += 1;
    if (attempted > 1) await sleepImpl(requestGapMs());
    const posted = await postQueued({ id: row.id, vid: row.vid, account, body: row.body });
    if (!posted.ok) {
      const error = redactSecrets(posted.error, [account.password]);
      finishQueue(row.id, "failed", error);
      db.prepare(
        `UPDATE comment_replies SET delivery_status = 'failed', delivery_error = ?
         WHERE id = (
           SELECT id FROM comment_replies
           WHERE comment_id = ? AND body = ? AND direction = 'outbound' AND delivery_status = 'stored'
           ORDER BY id DESC LIMIT 1
         )`
      ).run(error, row.comment_id, row.body);
      return { attempted, sent, stopped: error };
    }
    finishQueue(row.id, "sent", null);
    db.prepare(
      `UPDATE comment_replies SET delivery_status = 'sent', delivery_error = NULL
       WHERE id = (
         SELECT id FROM comment_replies
         WHERE comment_id = ? AND body = ? AND direction = 'outbound' AND delivery_status = 'stored'
         ORDER BY id DESC LIMIT 1
       )`
    ).run(row.comment_id, row.body);
    sent += 1;
  }
  return { attempted, sent, stopped: null };
}

export function syncStateForUi(): {
  status: ReturnType<typeof twentyeightcarStatus>;
  last_mode: string | null;
  last_error: string | null;
  last_run_at: string | null;
  held_replies: number;
} {
  const state = db
    .prepare(`SELECT last_mode, last_error, last_run_at FROM car_sync_state WHERE source = '28car'`)
    .get() as { last_mode: string | null; last_error: string | null; last_run_at: string | null } | undefined;
  const held = db.prepare(`SELECT COUNT(*) AS n FROM car_reply_queue WHERE status = 'held'`).get() as { n: number };
  return {
    status: twentyeightcarStatus(true),
    last_mode: state?.last_mode ?? null,
    last_error: state?.last_error ?? null,
    last_run_at: state?.last_run_at ?? null,
    held_replies: held.n,
  };
}

export function listingIndex(): Map<string, { stock_id: string; title: string }> {
  const rows = db.prepare(`SELECT stock_id, title FROM car_listings`).all() as Array<{ stock_id: string; title: string }>;
  return new Map(rows.map((row) => [row.stock_id, row]));
}
