import { createHash } from "crypto";
import { whatsAppCloudSettings } from "../config";
import { inspectMediaBytes, saveInboundMedia, type MediaKind } from "./media";

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_BYTES = 16 * 1024 * 1024;

const HOST_SUFFIXES = ["fbcdn.net", "fbsbx.com", "cdninstagram.com", "facebook.com", "whatsapp.net", "whatsapp.com"];

export function isMediaHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  return HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export interface GraphInboundMedia {
  kind: MediaKind;
  graphMediaId: string;
  mimeType: string;
  isVoice: boolean;
  sha256?: string | null;
}

export interface RemoteInboundMedia {
  kind: MediaKind;
  url: string;
  isVoice: boolean;
}

function clip(message: string, token: string): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  const redacted = token ? cleaned.split(token).join("[redacted]") : cleaned;
  return (redacted || "未能下載媒體").slice(0, 300);
}

async function readCapped(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") || "");
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new Error("媒體太大");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error("媒體太大");
  if (!bytes.length) throw new Error("媒體係空");
  return bytes;
}

async function fetchAllowlisted(url: string, token: string | null, depth = 0): Promise<Buffer> {
  if (depth > 2) throw new Error("重新導向太多");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("媒體網址無效");
  }
  if (parsed.protocol !== "https:" || !isMediaHostAllowed(parsed.hostname)) {
    throw new Error("媒體網址不接受");
  }
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(parsed.toString(), {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error("重新導向無效");
    return fetchAllowlisted(new URL(location, parsed).toString(), token, depth + 1);
  }
  if (!response.ok) throw new Error(`下載失敗 HTTP ${response.status}`);
  return readCapped(response);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * 用 WhatsApp media id 下載。URL 只會跟 Graph 回應入面、而且網域係 Meta 嘅連結。
 * 未設定 token 就唔會打網絡。
 */
export async function ingestWhatsAppGraphMedia(
  commentId: number,
  media: GraphInboundMedia,
  replyId?: number | null
): Promise<void> {
  const externalId = media.graphMediaId.trim();
  if (!/^\d{5,32}$/.test(externalId)) return;
  const settings = whatsAppCloudSettings();
  if (!settings.ok) {
    await saveInboundMedia({
      commentId,
      replyId,
      externalId,
      kind: media.kind,
      mimeType: media.mimeType,
      isVoice: media.isVoice,
      sha256: media.sha256 ?? null,
      fetchError: settings.error,
    });
    return;
  }

  const version = settings.messagesUrl.split("/")[3] || "v21.0";
  const metaUrl = `https://graph.facebook.com/${version}/${externalId}`;
  try {
    const described = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${settings.accessToken}` },
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    const raw = await described.text();
    if (!described.ok) {
      throw new Error(`Graph HTTP ${described.status}`);
    }
    const record = asRecord(JSON.parse(raw) as unknown);
    const fileUrl = record && typeof record.url === "string" ? record.url : "";
    const fileSize = record && typeof record.file_size === "number" ? record.file_size : 0;
    if (fileSize > MAX_BYTES) throw new Error("媒體太大");
    const bytes = await fetchAllowlisted(fileUrl, settings.accessToken);
    const hinted =
      (record && typeof record.mime_type === "string" && record.mime_type.trim()) || media.mimeType;
    const inspected = inspectMediaBytes(bytes, hinted, media.isVoice);
    if (!inspected.ok) throw new Error(inspected.error);
    await saveInboundMedia({
      commentId,
      replyId,
      externalId,
      kind: inspected.media.kind,
      mimeType: inspected.media.mimeType,
      isVoice: media.isVoice || inspected.media.isVoice,
      sha256: media.sha256 ?? null,
      bytes,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "未能下載媒體";
    console.error(`[media] WhatsApp 媒體未下載 comment=${commentId} media=${externalId}`);
    await saveInboundMedia({
      commentId,
      replyId,
      externalId,
      kind: media.kind,
      mimeType: media.mimeType,
      isVoice: media.isVoice,
      sha256: media.sha256 ?? null,
      fetchError: clip(message, settings.accessToken),
    });
  }
}

/** Messenger／IG／Facebook 留言附帶嘅 https 媒體。唔跟非 Meta 網域，避免 SSRF。 */
export async function ingestRemoteAttachments(
  commentId: number,
  items: RemoteInboundMedia[],
  replyId?: number | null
): Promise<void> {
  const token = process.env.META_PAGE_ACCESS_TOKEN?.trim() || process.env.WHATSAPP_ACCESS_TOKEN?.trim() || "";
  const limited = items.slice(0, 4);
  for (const item of limited) {
    let parsed: URL;
    try {
      parsed = new URL(item.url);
    } catch {
      continue;
    }
    const externalId = createHash("sha256").update(item.url).digest("hex");
    const fallbackMime = item.kind === "image" ? "image/jpeg" : item.kind === "video" ? "video/mp4" : "audio/mp4";
    if (parsed.protocol !== "https:" || !isMediaHostAllowed(parsed.hostname)) {
      await saveInboundMedia({
        commentId,
        replyId,
        externalId,
        kind: item.kind,
        mimeType: fallbackMime,
        isVoice: item.isVoice,
        fetchError: "媒體連結唔係 Meta 網域，已拒絕下載",
      });
      continue;
    }
    const host = parsed.hostname.toLowerCase();
    const auth =
      host === "graph.facebook.com" || host === "facebook.com" || host.endsWith(".facebook.com") ? null : token || null;
    try {
      const bytes = await fetchAllowlisted(parsed.toString(), auth);
      const inspected = inspectMediaBytes(bytes, fallbackMime, item.isVoice);
      if (!inspected.ok) throw new Error(inspected.error);
      await saveInboundMedia({
        commentId,
        replyId,
        externalId,
        kind: inspected.media.kind,
        mimeType: inspected.media.mimeType,
        isVoice: item.isVoice || inspected.media.isVoice,
        bytes,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "未能下載媒體";
      console.error(`[media] 遠端媒體未下載 comment=${commentId}`);
      await saveInboundMedia({
        commentId,
        replyId,
        externalId,
        kind: item.kind,
        mimeType: item.kind === "image" ? "image/jpeg" : item.kind === "video" ? "video/mp4" : "audio/mp4",
        isVoice: item.isVoice,
        fetchError: clip(message, token),
      });
    }
  }
}
