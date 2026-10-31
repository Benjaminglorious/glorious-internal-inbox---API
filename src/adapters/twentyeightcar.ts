/**
 * 28car 車盤同留言板。
 * 買家寫喺 sell_dsp.php #msgbox 的帖會入收件箱，entry_path=28car_board。
 * 同事回覆經已登入車行 session POST form1（h_mode=add、h_type=o、當頁 h_t/h_k）。
 * 即時網絡要旗標，而且每次動作換代理。未設定代理時唔會打出去。
 */
import type { CommentSource } from "../types";
import type { OutboundReplyRequest, OutboundReplyResult } from "./outbound";
import { syncTwentyeightcar, queueTwentyeightcarReply } from "../services/twentyeightcar";

export const SOURCE: CommentSource = "28car";
export const SOURCE_URL = "https://www.28car.com";

export interface RawComment {
  external_id: string;
  author_name: string;
  body: string;
  vehicle_ref?: string | null;
  created_at?: string;
}

let loggedDisabled = false;

export async function fetchNewComments(): Promise<RawComment[]> {
  const report = await syncTwentyeightcar();
  if (report.mode === "disabled" && !loggedDisabled) {
    loggedDisabled = true;
    console.info("[adapter:28car] 即時同步未開。車盤同留言板唔會連去 28car。");
  }
  return report.inboxComments;
}

/** 排入 28car 留言板隊列。旗標同代理都齊先至 POST form1。 */
export async function queueOutboundReply(input: OutboundReplyRequest): Promise<OutboundReplyResult> {
  return queueTwentyeightcarReply(input);
}
