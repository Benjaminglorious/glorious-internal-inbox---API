/**
 * 東榮 Instagram 留言／私訊適配器。
 *
 * 畫面來源係 `instagram`（「東榮 IG」）。客戶喺 IG 帖文或私訊留低嘅內容經
 * POST /api/webhooks/meta 入庫，intake_kind = site_comment。
 *
 * 簡介連結（link in bio）會跳去
 * http://glorious.hk/?utm_source=ig&utm_medium=social&utm_content=link_in_bio
 * 如果客戶跟住用 WhatsApp 聯絡，來源仍然係 `whatsapp`，origin_site = `instagram`，
 * 唔好寫成東榮官網。判斷見 `originSiteFromUrl`。WhatsApp 出站唔經呢度。
 *
 * 同事回覆用連住專頁嘅 Page access token：
 * 公開留言 POST /{ig-comment-id}/replies；私訊 POST /{page-id}/messages（IGSID）。
 */
import type { CommentSource } from "../types";
import { queueMetaSurfaceReply } from "./meta-graph";
import type { OutboundReplyRequest, OutboundReplyResult } from "./outbound";

export const SOURCE: CommentSource = "instagram";
export const SOURCE_LABEL = "東榮 IG";
export const LINK_IN_BIO_URL =
  "http://glorious.hk/?utm_source=ig&utm_medium=social&utm_content=link_in_bio";

export interface RawComment {
  external_id: string;
  author_name: string;
  body: string;
  vehicle_ref?: string | null;
  created_at?: string;
}

export async function fetchNewComments(): Promise<RawComment[]> {
  // 入站用 webhook。呢度唔會打 Graph。
  console.warn("[adapter:instagram] fetchNewComments 尚未實作。入站請用 POST /api/webhooks/meta。");
  return [];
}

/** 將同事回覆送返 Instagram 公開留言或私訊。 */
export function queueOutboundReply(input: OutboundReplyRequest): Promise<OutboundReplyResult> {
  return queueMetaSurfaceReply("instagram", input);
}
