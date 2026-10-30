/**
 * WhatsApp 適配器。
 *
 * 入站派單唔係靠呢度 poll：POST /api/webhooks/whatsapp 會呼叫 routeWhatsAppInbound
 * （同事個人號 → 綁定同事；公司總機 85221740001 → 最少未完成）。收件路徑唔改。
 * fetchInboundChats 仍然唔會打網絡。
 *
 * 同事喺收件箱回覆公司總機（有入站儲存嘅客戶 wa_id）會 POST Graph
 * `/{phone-number-id}/messages`。同事個人線路維持 stub，唔經 Cloud API。
 */
import { COMPANY_WHATSAPP_PHONE, whatsAppCloudSettings } from "../config";
import { normalizePhone } from "../services/whatsapp";
import type { OutboundReplyRequest, OutboundReplyResult } from "./outbound";

export interface InboundWhatsAppMessage {
  external_id: string;
  author_name: string;
  body: string;
  created_at?: string;
}

const THREAD_ID = /^wa:(\d{8,15}):(\d{8,15})$/;
const GRAPH_TIMEOUT_MS = 20_000;

/**
 * 預留：拉取尚未入庫嘅 WhatsApp 入站對話。
 * 而家必定回傳空陣列，亦唔會發出任何網絡請求。
 */
export async function fetchInboundChats(): Promise<InboundWhatsAppMessage[]> {
  console.warn(
    "[adapter:whatsapp] fetchInboundChats 尚未實作。入站請用 POST /api/webhooks/whatsapp；而家唔會呼叫 WhatsApp API。"
  );
  return [];
}

export type CompanyCustomerTarget =
  | { send: true; to: string }
  | { send: false; reason: "not_company" | "missing_customer" };

/**
 * 只會發送公司總機對話。客戶號碼優先用 comments.wa_from_phone；
 * 舊列如果 external_id 係 wa:{收件}:{寄件} 亦可以還原。
 * 同事個人線路、冇號碼嘅示範資料都唔會當公司線。
 */
export function resolveCompanyCustomer(input: {
  externalId: string;
  waFromPhone: string | null;
  waToPhone: string | null;
}): CompanyCustomerTarget {
  const line = normalizePhone(input.waToPhone);
  const storedFrom = normalizePhone(input.waFromPhone);
  const thread = THREAD_ID.exec(input.externalId.trim());
  const threadTo = thread?.[1] ?? "";
  const threadFrom = thread?.[2] ?? "";
  const toLine = line || threadTo;
  if (toLine !== COMPANY_WHATSAPP_PHONE) return { send: false, reason: "not_company" };

  const customer = storedFrom || threadFrom;
  if (!customer || customer === COMPANY_WHATSAPP_PHONE || customer.length < 8 || customer.length > 15) {
    return { send: false, reason: "missing_customer" };
  }
  return { send: true, to: customer };
}

function clipError(message: string, token: string): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  const redacted = token ? cleaned.split(token).join("[redacted]") : cleaned;
  return (redacted || "發送失敗").slice(0, 500);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function graphErrorMessage(status: number, payload: unknown, raw: string): string {
  const record = asRecord(payload);
  const err = record ? asRecord(record.error) : null;
  const message = err && typeof err.message === "string" ? err.message.trim() : "";
  const code = err && (typeof err.code === "number" || typeof err.code === "string") ? String(err.code) : "";
  if (message) {
    return code ? `Graph ${status} (${code}): ${message}` : `Graph ${status}: ${message}`;
  }
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact ? `Graph ${status}: ${compact}` : `Graph HTTP ${status}`;
}

function failed(provider: string, error: string, commentId: number): OutboundReplyResult {
  console.error(`[adapter:${provider}] ${error}（comment id=${commentId}）`);
  return { delivery_status: "failed", provider, error };
}

/**
 * 公司總機回覆經 WhatsApp Cloud API 發送。
 * 成功先標 sent。缺 token、冇客戶號碼、Graph 錯誤都標 failed，唔會當成功。
 * 同事個人線路同其他未識別對話維持 stub，唔會打去 Graph。
 */
export async function queueOutboundReply(input: OutboundReplyRequest): Promise<OutboundReplyResult> {
  const target = resolveCompanyCustomer({
    externalId: input.externalId,
    waFromPhone: input.waFromPhone,
    waToPhone: input.waToPhone,
  });
  if (!target.send) {
    if (target.reason === "missing_customer") {
      return failed(
        "whatsapp_cloud",
        "沒有客戶 WhatsApp 號碼（wa_id），未發送",
        input.commentId
      );
    }
    return { delivery_status: "stub", provider: "whatsapp_staff_or_unset", error: null };
  }

  const settings = whatsAppCloudSettings();
  if (!settings.ok) {
    return failed("whatsapp_unconfigured", settings.error, input.commentId);
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: target.to,
    type: "text",
    text: { preview_url: false, body: input.body },
  };

  let response: Response;
  try {
    response = await fetch(settings.messagesUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "網絡錯誤";
    return failed(
      "whatsapp_cloud",
      clipError(`WhatsApp 發送失敗：${message}`, settings.accessToken),
      input.commentId
    );
  }

  const raw = await response.text();
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = null;
    }
  }

  const record = asRecord(parsed);
  const graphErr = record ? record.error : null;
  if (!response.ok || graphErr) {
    return failed(
      "whatsapp_cloud",
      clipError(graphErrorMessage(response.status, parsed, raw), settings.accessToken),
      input.commentId
    );
  }

  const messages = record && Array.isArray(record.messages) ? record.messages : [];
  const first = asRecord(messages[0]);
  const messageId = first && typeof first.id === "string" ? first.id.trim() : "";
  if (!messageId) {
    return failed("whatsapp_cloud", "Graph 回應缺少訊息 id，未當成功", input.commentId);
  }

  console.log(
    `[adapter:whatsapp_cloud] 已發送 comment id=${input.commentId} graph_message_id=${messageId} to=${target.to}`
  );
  return { delivery_status: "sent", provider: "whatsapp_cloud", error: null };
}
