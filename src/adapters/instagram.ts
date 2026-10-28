/**
 * 東榮 Instagram 留言／私訊適配器（stub）。
 *
 * 畫面來源係 `instagram`（「東榮 IG」）。客戶喺 IG 帖文或私訊留低嘅內容先至經呢度入庫，
 * intake_kind = site_comment。
 *
 * 簡介連結（link in bio）會跳去
 * http://glorious.hk/?utm_source=ig&utm_medium=social&utm_content=link_in_bio
 * 如果客戶跟住用 WhatsApp 聯絡，來源仍然係 `whatsapp`，origin_site = `instagram`，
 * 唔好寫成東榮官網。判斷見 `originSiteFromUrl`。
 *
 * TODO: Instagram Graph API。而家唔會發出任何網絡請求。
 */
import type { CommentSource } from "../types";
import { stubOutbound, type OutboundReplyRequest, type OutboundReplyResult } from "./outbound";

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
  // TODO: Instagram Graph API — 拉取專頁留言／私訊。唔好將 bio link 嘅 WhatsApp 當官網。
  console.warn("[adapter:instagram] fetchNewComments 尚未實作。而家唔會呼叫 Instagram API。");
  return [];
}

/** 預留：將同事回覆送返 Instagram。而家只標 stub，呼叫方要自己寫入 comment_replies。 */
export function queueOutboundReply(input: OutboundReplyRequest): OutboundReplyResult {
  return stubOutbound("instagram_unconfigured", "Instagram", input.commentId);
}
