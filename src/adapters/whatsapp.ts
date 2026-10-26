/**
 * WhatsApp 入站適配器（尚未連接 Meta／Glorious）。
 *
 * 出站 click-to-chat 用 COMPANY_WHATSAPP_URL。
 * 入站派單唔係靠呢度 poll：POST /api/webhooks/whatsapp 會呼叫 routeWhatsAppInbound
 * （同事個人號 → 綁定同事；公司總機 85221740001 → 最少未完成）。
 * 真實 Cloud API 稍後先接。呢個函式仍然唔會發出任何網絡請求。
 */

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
    "[adapter:whatsapp] fetchInboundChats 尚未實作。入站請用 webhook stub（WEBHOOK_VERIFY_TOKEN）；而家唔會呼叫 WhatsApp API。"
  );
  return [];
}
