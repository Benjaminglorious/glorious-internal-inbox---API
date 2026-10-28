/**
 * Facebook 專頁留言適配器（stub）
 * TODO: 實作從 https://www.facebook.com/GloriousMotors 經 Graph API 拉取留言／私訊
 */
import type { CommentSource } from "../types";
import { stubOutbound, type OutboundReplyRequest, type OutboundReplyResult } from "./outbound";

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
  // TODO: 使用 Facebook Graph API（Page access token）拉取 comments / conversations
  console.warn("[adapter:facebook] fetchNewComments 尚未實作");
  return [];
}

/** 預留：將同事回覆送返 Facebook。而家只標 stub，唔會打網絡。 */
export function queueOutboundReply(input: OutboundReplyRequest): OutboundReplyResult {
  return stubOutbound("facebook_unconfigured", "Facebook", input.commentId);
}
