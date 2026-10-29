/**
 * 28car.com 留言／查詢適配器（stub）
 * TODO: 實作從 https://www.28car.com 拉取東榮刊登車輛的留言／私訊
 */
import type { CommentSource } from "../types";
import { stubOutbound, type OutboundReplyRequest, type OutboundReplyResult } from "./outbound";

export const SOURCE: CommentSource = "28car";
export const SOURCE_URL = "https://www.28car.com";

export interface RawComment {
  external_id: string;
  author_name: string;
  body: string;
  vehicle_ref?: string | null;
  created_at?: string;
}

export async function fetchNewComments(): Promise<RawComment[]> {
  // TODO: 登入／爬取或呼叫 28car API，回傳尚未入庫的留言
  console.warn("[adapter:28car] fetchNewComments 尚未實作");
  return [];
}

/** 預留：將同事回覆送返 28car。而家只標 stub，唔會打網絡。 */
export function queueOutboundReply(input: OutboundReplyRequest): OutboundReplyResult {
  return stubOutbound("28car_unconfigured", "28car", input.commentId);
}
