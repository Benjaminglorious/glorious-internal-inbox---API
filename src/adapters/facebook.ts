/**
 * Facebook 專頁留言／Messenger 適配器。
 *
 * 入站唔係靠呢度 poll：POST /api/webhooks/meta 寫入 site_comment。
 * 同事回覆有 META_PAGE_ACCESS_TOKEN 就打 Graph（留言 POST /{comment-id}/comments，
 * 私訊 POST /{page-id}/messages）。缺設定標 failed，唔會當已發送。
 */
import type { CommentSource } from "../types";
import { queueMetaSurfaceReply } from "./meta-graph";
import type { OutboundReplyRequest, OutboundReplyResult } from "./outbound";

export const SOURCE: CommentSource = "facebook";
export const SOURCE_URL = "https://www.facebook.com/GloriousMotors";

export interface RawComment {
  external_id: string;
  author_name: string;
  body: string;
  vehicle_ref?: string | null;
  created_at?: string;
}

export async function fetchNewComments(): Promise<RawComment[]> {
  // 入站用 webhook。呢度唔會打 Graph。
  console.warn("[adapter:facebook] fetchNewComments 尚未實作。入站請用 POST /api/webhooks/meta。");
  return [];
}

/** 將同事回覆送返 Facebook 公開留言或 Messenger。 */
export function queueOutboundReply(input: OutboundReplyRequest): Promise<OutboundReplyResult> {
  return queueMetaSurfaceReply("facebook", input);
}
