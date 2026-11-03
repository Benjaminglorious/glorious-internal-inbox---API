/**
 * Facebook Page／Instagram 出站（Graph API）。
 *
 * 只用 META_PAGE_ACCESS_TOKEN。WhatsApp 公司線仍然走 WHATSAPP_ACCESS_TOKEN，
 * 唔經呢度。
 *
 * 公開留言：
 * - Facebook：POST /{comment-id}/comments ，body { message }
 * - Instagram：POST /{ig-comment-id}/replies ，body { message }
 *   （Facebook Login 嘅 Page token，host 係 graph.facebook.com）
 *
 * 私訊（客戶要先傳過訊，Messenger 用 RESPONSE，24 小時窗口）：
 * - Messenger：POST /{page-id}/messages
 *   { recipient: { id: PSID }, messaging_type: "RESPONSE", message: { text } }
 * - Instagram DM：同一個 Page messages 端點，recipient 係 IGSID，唔帶 messaging_type
 */
import { metaGraphVersion, metaPageAccessToken, metaPageId } from "../config";
import type { OutboundReplyRequest, OutboundReplyResult } from "./outbound";

const GRAPH_TIMEOUT_MS = 20_000;
const GRAPH_HOST = "https://graph.facebook.com";
const NUMERIC_ID = /^\d{5,32}$/;
const PAGE_ID = /^\d{6,20}$/;
/** Page／IG comment id：數字，或者 Facebook 嘅 {post}_{comment}。 */
const COMMENT_ID = /^\d{5,40}(?:_\d{1,40})?$/;
const MSG_FALLBACK = /^msg:([^:]+):/;
const DM_MID = /^(?:m_|mid\.)/i;
const IG_DM_MID = /^aWdfZAG/i;
const MESSAGE_MAX: Record<"facebook" | "instagram", number> = {
  facebook: 2000,
  instagram: 1000,
};

export type MetaChannel = "facebook" | "instagram";

const CHANNEL_LABEL: Record<MetaChannel, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
};

function clipError(message: string, token: string): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  const redacted = token ? cleaned.split(token).join("[redacted]") : cleaned;
  return (redacted || "發送失敗").slice(0, 500);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function idString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return "";
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

function missingRecipient(channel: MetaChannel): string {
  return channel === "instagram"
    ? "沒有客戶 Instagram 用戶 id（IGSID），私訊未發送。請等客戶再傳一則。"
    : "沒有客戶 Messenger 用戶 id（PSID），私訊未發送。請等客戶再傳一則。";
}

export type MetaReplyTarget =
  | { ok: true; kind: "comment"; commentId: string }
  | { ok: true; kind: "message"; recipientId: string }
  | { ok: false; error: string };

/**
 * 決定打邊個 Graph 端點。
 * meta_surface 優先。舊列冇呢欄時：mid／msg: 當私訊，其餘當公開留言 comment id。
 */
export function resolveMetaReplyTarget(input: {
  channel: MetaChannel;
  externalId: string;
  metaSenderId: string | null;
  metaSurface: string | null;
}): MetaReplyTarget {
  const externalId = input.externalId.trim();
  const sender = (input.metaSenderId ?? "").trim();
  const surface = input.metaSurface === "comment" || input.metaSurface === "message" ? input.metaSurface : null;
  const looksLikeDm =
    surface === "message" ||
    (surface !== "comment" &&
      (MSG_FALLBACK.test(externalId) || DM_MID.test(externalId) || IG_DM_MID.test(externalId)));

  if (looksLikeDm) {
    const fromPrefix = MSG_FALLBACK.exec(externalId);
    const prefixed = fromPrefix?.[1] ?? "";
    const recipient = NUMERIC_ID.test(sender) ? sender : NUMERIC_ID.test(prefixed) ? prefixed : "";
    if (!recipient) return { ok: false, error: missingRecipient(input.channel) };
    return { ok: true, kind: "message", recipientId: recipient };
  }

  if (!COMMENT_ID.test(externalId)) {
    return {
      ok: false,
      error: "留言編號唔係 Graph comment id，未發送。請確認係由 Meta webhook 入庫。",
    };
  }
  return { ok: true, kind: "comment", commentId: externalId };
}

function graphResultId(record: Record<string, unknown> | null): string {
  if (!record) return "";
  return idString(record.id) || idString(record.message_id);
}

async function postGraph(input: {
  provider: string;
  commentId: number;
  accessToken: string;
  url: string;
  payload: Record<string, unknown>;
  logDetail: string;
}): Promise<OutboundReplyResult> {
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.payload),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "網絡錯誤";
    return failed(input.provider, clipError(`發送失敗：${message}`, input.accessToken), input.commentId);
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
      input.provider,
      clipError(graphErrorMessage(response.status, parsed, raw), input.accessToken),
      input.commentId
    );
  }

  const graphId = graphResultId(record);
  if (!graphId) {
    return failed(input.provider, "Graph 回應缺少 id，未當成功", input.commentId);
  }

  console.log(
    `[adapter:${input.provider}] 已發送 comment id=${input.commentId} graph_id=${graphId} ${input.logDetail}`
  );
  return { delivery_status: "sent", provider: input.provider, error: null };
}

export interface MetaParentPost {
  permalink: string | null;
  caption: string | null;
}

const LOOKUP_TIMEOUT_MS = 4000;

/**
 * 讀公開帖文嘅 caption／permalink。冇 token、Graph 失敗或超時都回 null，唔拋出。
 * 回覆仍然走 queueMetaSurfaceReply，呢度只係 GET，唔會發留言。
 */
export async function lookupMetaParentPost(input: {
  channel: MetaChannel;
  postId: string;
}): Promise<MetaParentPost | null> {
  const accessToken = metaPageAccessToken();
  if (!accessToken) return null;
  const version = metaGraphVersion();
  if (!version.ok) return null;
  const postId = input.postId.trim();
  if (!/^[0-9A-Za-z_.:-]{1,200}$/.test(postId)) return null;
  const fields = input.channel === "instagram" ? "id,caption,permalink" : "id,message,permalink_url,story";
  const url = `${GRAPH_HOST}/${version.version}/${encodeURIComponent(postId)}?fields=${encodeURIComponent(fields)}`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    const raw = await response.text();
    if (!response.ok) return null;
    let parsed: unknown = null;
    try {
      parsed = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      return null;
    }
    const record = asRecord(parsed);
    if (!record || record.error) return null;
    const textOf = (key: string): string => {
      const value = record[key];
      return typeof value === "string" ? value.trim() : "";
    };
    const caption = input.channel === "instagram" ? textOf("caption") : textOf("message") || textOf("story");
    const permalink = input.channel === "instagram" ? textOf("permalink") : textOf("permalink_url");
    if (!caption && !permalink) return null;
    return { caption: caption || null, permalink: permalink || null };
  } catch {
    return null;
  }
}

/**
 * 同事回覆送去 Facebook 或 Instagram。
 * 成功先標 sent。缺 token、缺私訊對象、Graph 錯誤都標 failed，唔會拋出。
 */
export async function queueMetaSurfaceReply(
  channel: MetaChannel,
  input: OutboundReplyRequest
): Promise<OutboundReplyResult> {
  const provider = `${channel}_graph`;
  const unconfigured = `${channel}_unconfigured`;
  const label = CHANNEL_LABEL[channel];
  try {
    const target = resolveMetaReplyTarget({
      channel,
      externalId: input.externalId,
      metaSenderId: input.metaSenderId ?? null,
      metaSurface: input.metaSurface ?? null,
    });
    if (!target.ok) return failed(provider, target.error, input.commentId);

    const accessToken = metaPageAccessToken();
    if (!accessToken) {
      return failed(unconfigured, `META_PAGE_ACCESS_TOKEN 未設定，${label} 回覆未發送`, input.commentId);
    }
    const version = metaGraphVersion();
    if (!version.ok) return failed(unconfigured, version.error, input.commentId);

    if (target.kind === "message") {
      const pageId = metaPageId();
      if (!pageId) {
        return failed(unconfigured, "META_PAGE_ID 未設定，私訊未發送", input.commentId);
      }
      if (!PAGE_ID.test(pageId)) {
        return failed(unconfigured, "META_PAGE_ID 格式不正確，私訊未發送", input.commentId);
      }
      const max = MESSAGE_MAX[channel];
      if (input.body.length > max) {
        return failed(provider, `${label} 私訊不可長過 ${max} 字，未發送`, input.commentId);
      }
      const payload: Record<string, unknown> = {
        recipient: { id: target.recipientId },
        message: { text: input.body },
      };
      if (channel === "facebook") payload.messaging_type = "RESPONSE";
      return await postGraph({
        provider,
        commentId: input.commentId,
        accessToken,
        url: `${GRAPH_HOST}/${version.version}/${encodeURIComponent(pageId)}/messages`,
        payload,
        logDetail: `kind=message to=${target.recipientId}`,
      });
    }

    const edge = channel === "instagram" ? "replies" : "comments";
    return await postGraph({
      provider,
      commentId: input.commentId,
      accessToken,
      url: `${GRAPH_HOST}/${version.version}/${encodeURIComponent(target.commentId)}/${edge}`,
      payload: { message: input.body },
      logDetail: `kind=comment`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "未知錯誤";
    return failed(provider, clipError(`發送失敗：${message}`, metaPageAccessToken()), input.commentId);
  }
}
