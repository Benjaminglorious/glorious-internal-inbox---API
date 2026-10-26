import * as twentyeightcar from "./twentyeightcar";
import * as gloriousWeb from "./glorious-web";
import * as facebook from "./facebook";
import * as whatsapp from "./whatsapp";

export const adapters = {
  "28car": twentyeightcar,
  glorious_web: gloriousWeb,
  facebook,
} as const;

export type AdapterName = keyof typeof adapters;

/**
 * WhatsApp 唔係而家三個留言來源之一。
 * click-to-chat 用 COMPANY_WHATSAPP_URL；入站同步見 fetchInboundChats（stub，未連接 Business API）。
 * pollAllSources 故意唔呼叫佢。
 */
export const whatsappInbound = whatsapp;

/** 預留：日後排程呼叫各留言來源 stub／實作（不包括 WhatsApp） */
export async function pollAllSources(): Promise<void> {
  for (const [name, adapter] of Object.entries(adapters)) {
    const items = await adapter.fetchNewComments();
    console.log(`[adapters] ${name}: 取得 ${items.length} 條（stub）`);
  }
}
