/**
 * WhatsApp 入站對話適配器（stub）
 *
 * 而家只提供公司 click-to-chat 連結（COMPANY_WHATSAPP_URL，
 * 預設 https://api.whatsapp.com/send?phone=85221740001）。
 * 留言箱唔會同步 WhatsApp 訊息。
 *
 * TODO: 日後經 WhatsApp Business API（Cloud API）拉取呢個號碼嘅入站對話，
 * 寫入內部留言箱。未接好憑證同 webhook 之前，唔好呼叫任何真實 WhatsApp API。
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
    "[adapter:whatsapp] fetchInboundChats 尚未實作（未連接 WhatsApp Business API，唔會同步對話）"
  );
  return [];
}
