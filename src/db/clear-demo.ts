import "dotenv/config";
import path from "path";
import { db, shutdownDatabase } from "./index";
import { DEMO_COMMENTS } from "./seed";
import { DEMO_LISTING_MESSAGE_IDS, OBSERVED_SYNC_ORIGIN } from "../services/twentyeightcar";

export interface ClearDemoResult {
  comments_deleted: number;
  replies_deleted: number;
  listing_messages_deleted: number;
  listings_deleted: number;
}

/**
 * 刪 seed 清單入面嘅示範留言同相關回覆、觀察車盤。
 * 保留 Meta `wamid.*`、`wa:{to}:{from}` 真實對話，同埋唔喺清單入面嘅 28car 留言板。
 * 同事帳號唔會刪。
 */
export function clearDemoFixtures(): ClearDemoResult {
  const tuple = DEMO_COMMENTS.map(() => "(?, ?)").join(", ");
  const keyParams = DEMO_COMMENTS.flatMap((row) => [row.source, row.external_id]);
  const messagePlaceholders = DEMO_LISTING_MESSAGE_IDS.map(() => "?").join(", ");
  const run = db.transaction(() => {
    const replyRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM comment_replies
         WHERE comment_id IN (
           SELECT id FROM comments WHERE (source, external_id) IN (${tuple})
         )`
      )
      .get(...keyParams) as { n: number };
    const comments = db
      .prepare(`DELETE FROM comments WHERE (source, external_id) IN (${tuple})`)
      .run(...keyParams);
    const messages = db
      .prepare(
        `DELETE FROM car_listing_messages
         WHERE external_id IN (${messagePlaceholders})
            OR stock_id IN (SELECT stock_id FROM car_listings WHERE sync_origin = ?)`
      )
      .run(...DEMO_LISTING_MESSAGE_IDS, OBSERVED_SYNC_ORIGIN);
    const listings = db.prepare(`DELETE FROM car_listings WHERE sync_origin = ?`).run(OBSERVED_SYNC_ORIGIN);
    return {
      comments_deleted: comments.changes,
      replies_deleted: Number(replyRow.n) || 0,
      listing_messages_deleted: messages.changes,
      listings_deleted: listings.changes,
    };
  });
  const result = run();
  console.log(
    `[clear:demo] 已刪示範留言 ${result.comments_deleted}、回覆 ${result.replies_deleted}、觀察車盤訊息 ${result.listing_messages_deleted}、觀察車盤 ${result.listings_deleted}。同事帳號、wamid 對話同 seed 清單以外嘅 28car 留言仍然留低。`
  );
  return result;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(__filename);
}

if (isDirectRun()) {
  try {
    clearDemoFixtures();
    shutdownDatabase();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    shutdownDatabase();
    process.exit(1);
  }
}
