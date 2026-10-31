import type { CommentSource, DeliveryStatus, IntakeKind, OriginSite } from "../types";

export interface OutboundReplyRequest {
  commentId: number;
  externalId: string;
  source: CommentSource;
  intakeKind: IntakeKind;
  originSite: OriginSite | null;
  body: string;
  staffId: number;
  /** 入站寫入嘅客戶 wa_id。網站留言係 null。 */
  waFromPhone: string | null;
  /** 入站寫入嘅收件線路。網站留言係 null。 */
  waToPhone: string | null;
  /** 留言上嘅車輛編號。28car 用嚟對車盤。 */
  vehicleRef?: string | null;
}

export interface OutboundReplyResult {
  delivery_status: Extract<DeliveryStatus, "stub" | "failed" | "stored" | "sent">;
  /** 內部標記，說明邊個供應商處理。唔代表已經送到客戶。 */
  provider: string;
  /** 失敗時顯示畀同事。成功或未發送嘅 stub 留空。 */
  error?: string | null;
}

/**
 * 尚未連接嘅渠道：寫 log、回傳 stub，唔會打去 Meta Page、28car、官網或 Instagram。
 * 公司 WhatsApp 總機唔經呢度。
 */
export function stubOutbound(provider: string, channelLabel: string, commentId: number): OutboundReplyResult {
  console.warn(
    `[adapter:${provider}] queueOutboundReply 尚未連接 ${channelLabel}，回覆只會標為 stub（comment id=${commentId}）`
  );
  return { delivery_status: "stub", provider };
}
