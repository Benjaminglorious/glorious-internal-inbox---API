import * as twentyeightcar from "./twentyeightcar";
import * as gloriousWeb from "./glorious-web";
import * as facebook from "./facebook";

export const adapters = {
  "28car": twentyeightcar,
  glorious_web: gloriousWeb,
  facebook,
} as const;

export type AdapterName = keyof typeof adapters;

/** 預留：日後排程呼叫各來源 stub／實作 */
export async function pollAllSources(): Promise<void> {
  for (const [name, adapter] of Object.entries(adapters)) {
    const items = await adapter.fetchNewComments();
    console.log(`[adapters] ${name}: 取得 ${items.length} 條（stub）`);
  }
}
