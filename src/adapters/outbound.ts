import type { CommentSource, DeliveryStatus, IntakeKind, OriginSite } from "../types";

export interface OutboundReplyRequest {
  commentId: number;
  externalId: string;
  source: CommentSource;
  intakeKind: IntakeKind;
  originSite: OriginSite | null;
  body: string;
  staffId: number;
}

export interface OutboundReplyResult {
  delivery_status: Extract<DeliveryStatus, "stub" | "failed" | "stored">;
  /** 內部標記，說明未連接邊個供應商。唔代表已經送到客戶。 */
  provider: string;
}

/**
 * 出站一律係 stub：寫 log、回傳 stub，唔會打去 Meta、Glorious、28car、官網、Facebook 或 Instagram。
 */
export function stubOutbound(provider: string, channelLabel: string, commentId: number): OutboundReplyResult {
  console.warn(
    `[adapter:${provider}] queueOutboundReply 尚未連接 ${channelLabel}，回覆只會標為 stub（comment id=${commentId}）`
  );
  return { delivery_status: "stub", provider };
}
