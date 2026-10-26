/**
 * 東榮汽車官網留言／聯絡表適配器（stub）
 * TODO: 實作從 https://glorious.hk/cn2/ 拉取官網表單／留言
 */
import type { CommentSource } from "../types";

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
