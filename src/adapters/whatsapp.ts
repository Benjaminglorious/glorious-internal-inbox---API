/**
 * WhatsApp 適配器。入站 webhook 喺 routes；呢度 poll／出站仍然未連接 Meta／Glorious。
 *
 * 出站 click-to-chat 用 COMPANY_WHATSAPP_URL。
 * 入站派單唔係靠呢度 poll：POST /api/webhooks/whatsapp 會呼叫 routeWhatsAppInbound
 * （同事個人號 → 綁定同事；公司總機 85221740001 → 最少未完成）。
 * 收 Meta Cloud API messages（display_phone_number）。呢個檔仍然唔會發出任何網絡請求。
 * 同事喺收件箱回覆公司 WhatsApp（包括由 28car／官網／Facebook／IG 撳過嚟）
 * 會呼叫 queueOutboundReply，而家只標 stub。
 */
import { stubOutbound, type OutboundReplyRequest, type OutboundReplyResult } from "./outbound";

export interface InboundWhatsAppMessage {
  external_id: string;
  author_name: string;
  body: string;
  created_at?: string;
}

/**
 * 預留：拉取尚未入庫嘅 WhatsApp 入站對話。
 * 而家必定回傳空陣列，亦唔會發出任何網絡請求。
 */
export async function fetchInboundChats(): Promise<InboundWhatsAppMessage[]> {
  // TODO: WhatsApp Business API — 拉取 phone 85221740001 嘅 inbound chats／messages
  console.warn(
    "[adapter:whatsapp] fetchInboundChats 尚未實作。入站請用 POST /api/webhooks/whatsapp；而家唔會呼叫 WhatsApp API。"
  );
  return [];
}

/**
 * 預留：經 Meta Cloud API 或 Glorious WhatsApp Business API 發送同事回覆。
 * 而家只標 stub。呼叫方必須把回覆寫入 comment_replies，唔好喺呢度打網絡。
 */
export function queueOutboundReply(input: OutboundReplyRequest): OutboundReplyResult {
  return stubOutbound("whatsapp_unconfigured", "Meta／Glorious WhatsApp", input.commentId);
}
