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
 * WhatsApp 入站唔經 poll。線路綁定同派單見 routeWhatsAppInbound；
 * webhook stub 係 POST /api/webhooks/whatsapp。真實 Meta／Glorious 連接尚未啟用。
 * pollAllSources 故意唔呼叫呢度，避免打去 WhatsApp API。
 */
export const whatsappInbound = whatsapp;

/** 預留：日後排程呼叫各留言來源 stub／實作（不包括 WhatsApp） */
export async function pollAllSources(): Promise<void> {
  for (const [name, adapter] of Object.entries(adapters)) {
    const items = await adapter.fetchNewComments();
    console.log(`[adapters] ${name}: 取得 ${items.length} 條（stub）`);
  }
}
