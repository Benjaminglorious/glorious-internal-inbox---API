/**
 * 東榮汽車官網留言／聯絡表適配器（stub）
 * TODO: 實作從 https://glorious.hk/cn2/ 拉取官網表單／留言
 */
import type { CommentSource } from "../types";
import { stubOutbound, type OutboundReplyRequest, type OutboundReplyResult } from "./outbound";

export const SOURCE: CommentSource = "glorious_web";
export const SOURCE_URL = "https://glorious.hk/cn2/";

export interface RawComment {
  external_id: string;
  author_name: string;
  body: string;
  vehicle_ref?: string | null;
  created_at?: string;
}

export async function fetchNewComments(): Promise<RawComment[]> {
  // TODO: 接官網 CMS／聯絡表 API 或 webhook
  console.warn("[adapter:glorious_web] fetchNewComments 尚未實作");
  return [];
}

/** 預留：將同事回覆送返東榮官網。而家只標 stub，唔會打網絡。 */
export function queueOutboundReply(input: OutboundReplyRequest): OutboundReplyResult {
  return stubOutbound("glorious_web_unconfigured", "東榮官網", input.commentId);
}
