import { createHash } from "crypto";
import { readMediaBytes, writeMediaBytes } from "../db/media-bytes";
import { db } from "../db";
import type { CommentViewer } from "./comments";
import { canViewComment, getComment } from "./comments";

export const MEDIA_KINDS = ["image", "video", "audio"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_AV = 16 * 1024 * 1024;

export function placeholderFor(kind: MediaKind, isVoice: boolean): string {
  if (kind === "image") return "［圖片］";
  if (kind === "video") return "［影片］";
  return isVoice ? "［語音］" : "［錄音］";
}

export function isPlaceholderBody(body: string): boolean {
  return /^［(圖片|影片|語音|錄音)］$/.test(body.trim());
}

export interface MediaRecord {
  id: number;
  comment_id: number;
  reply_id: number | null;
  kind: MediaKind;
  mime_type: string;
  byte_size: number;
  is_voice: boolean;
  fetch_error: string | null;
  created_at: string;
}

export interface InspectedMedia {
  kind: MediaKind;
  mimeType: string;
  isVoice: boolean;
}

interface MediaRow {
  id: number;
  comment_id: number;
  reply_id: number | null;
  kind: string;
  mime_type: string;
  byte_size: number;
  is_voice: number;
  fetch_error: string | null;
  created_at: string;
}

const META_SELECT = `
  SELECT id, comment_id, reply_id, kind, mime_type, byte_size, is_voice, fetch_error, created_at
  FROM message_media
`;

function asKind(value: string): MediaKind | null {
  return value === "image" || value === "video" || value === "audio" ? value : null;
}

function mapRow(row: MediaRow): MediaRecord | null {
  const kind = asKind(row.kind);
  if (!kind) return null;
  return {
    id: row.id,
    comment_id: row.comment_id,
    reply_id: row.reply_id,
    kind,
    mime_type: row.mime_type,
    byte_size: row.byte_size,
    is_voice: row.is_voice === 1,
    fetch_error: row.fetch_error?.trim() || null,
    created_at: row.created_at,
  };
}

export function listMediaForComment(commentId: number): MediaRecord[] {
  if (!Number.isInteger(commentId)) return [];
  const rows = db.prepare(`${META_SELECT} WHERE comment_id = ? ORDER BY id ASC`).all(commentId) as MediaRow[];
  return rows.map(mapRow).filter((row): row is MediaRecord => row != null);
}

export function getMediaMeta(id: number): MediaRecord | null {
  if (!Number.isInteger(id)) return null;
  const row = db.prepare(`${META_SELECT} WHERE id = ?`).get(id) as MediaRow | undefined;
  return row ? mapRow(row) : null;
}

export function presentMedia(row: MediaRecord): {
  id: number;
  comment_id: number;
  reply_id: number | null;
  kind: MediaKind;
  mime_type: string;
  byte_size: number;
  is_voice: boolean;
  fetch_error: string | null;
  url: string | null;
} {
  const ready = row.byte_size > 0 && !row.fetch_error;
  return {
    id: row.id,
    comment_id: row.comment_id,
    reply_id: row.reply_id,
    kind: row.kind,
    mime_type: row.mime_type,
    byte_size: row.byte_size,
    is_voice: row.is_voice,
    fetch_error: row.fetch_error,
    url: ready ? `/media/${row.id}` : null,
  };
}

function extensionFor(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "video/mp4":
      return "mp4";
    case "video/3gpp":
      return "3gp";
    case "audio/ogg":
      return "ogg";
    case "audio/webm":
      return "webm";
    case "audio/mp4":
      return "m4a";
    case "audio/mpeg":
      return "mp3";
    case "audio/aac":
      return "aac";
    case "audio/amr":
      return "amr";
    default:
      return "bin";
  }
}

function ftypBrand(bytes: Buffer): string {
  if (bytes.length < 12) return "";
  if (bytes.toString("ascii", 4, 8) !== "ftyp") return "";
  return bytes.toString("ascii", 8, 12);
}

function sniff(bytes: Buffer, hintMime: string): { kind: MediaKind; mimeType: string } | null {
  const hint = hintMime.toLowerCase().split(";")[0].trim();
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: "image", mimeType: "image/jpeg" };
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString("ascii", 1, 4) === "PNG") {
    return { kind: "image", mimeType: "image/png" };
  }
  if (bytes.length >= 6 && (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a")) {
    return { kind: "image", mimeType: "image/gif" };
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { kind: "image", mimeType: "image/webp" };
  }
  if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "OggS") {
    return { kind: "audio", mimeType: "audio/ogg" };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    if (hint.startsWith("video/")) return null;
    return { kind: "audio", mimeType: "audio/webm" };
  }
  if (bytes.length >= 5 && bytes.toString("ascii", 0, 5) === "#!AMR") {
    return { kind: "audio", mimeType: "audio/amr" };
  }
  if (bytes.length >= 3 && bytes.toString("ascii", 0, 3) === "ID3") {
    return { kind: "audio", mimeType: "audio/mpeg" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    const aac = bytes[1] === 0xf1 || bytes[1] === 0xf9;
    return { kind: "audio", mimeType: aac ? "audio/aac" : "audio/mpeg" };
  }
  const brand = ftypBrand(bytes);
  if (brand) {
    if (brand.startsWith("3gp")) return { kind: "video", mimeType: "video/3gpp" };
    if (brand === "M4A " || hint.startsWith("audio/")) return { kind: "audio", mimeType: "audio/mp4" };
    return { kind: "video", mimeType: "video/mp4" };
  }
  return null;
}

export function inspectMediaBytes(
  bytes: Buffer,
  hintMime: string,
  wantVoice: boolean
): { ok: true; media: InspectedMedia } | { ok: false; error: string } {
  if (!bytes.length) return { ok: false, error: "未有檔案" };
  if (bytes.length < 8) return { ok: false, error: "檔案太小" };
  if (bytes.length > MAX_AV) return { ok: false, error: "檔案太大（上限 16MB）" };
  const hint = hintMime.toLowerCase();
  if (hint.startsWith("video/") && bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45) {
    return { ok: false, error: "影片請用 MP4。WebM 只可以當語音。" };
  }
  const sniffed = sniff(bytes, hintMime);
  if (!sniffed) {
    return { ok: false, error: "只接受相片（JPEG、PNG、WEBP、GIF）、MP4 影片，或語音（Ogg、M4A、MP3、AAC、WebM、AMR）" };
  }
  if (sniffed.kind === "image" && bytes.length > MAX_IMAGE) {
    return { ok: false, error: "相片太大（上限 5MB）" };
  }
  return {
    ok: true,
    media: { kind: sniffed.kind, mimeType: sniffed.mimeType, isVoice: sniffed.kind === "audio" && wantVoice },
  };
}

export function decodeMediaBase64(input: string): Buffer | null {
  const cleaned = input.replace(/\s/g, "");
  if (!cleaned || cleaned.length > 24 * 1024 * 1024) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null;
  try {
    const buf = Buffer.from(cleaned, "base64");
    if (!buf.length) return null;
    return buf;
  } catch {
    return null;
  }
}

function insertMeta(input: {
  commentId: number;
  replyId: number | null;
  kind: MediaKind;
  mimeType: string;
  byteSize: number;
  isVoice: boolean;
  externalId: string | null;
  sha256: string | null;
  fetchError: string | null;
}): number {
  const info = db
    .prepare(
      `INSERT INTO message_media (
         comment_id, reply_id, kind, mime_type, byte_size, is_voice, external_id, sha256, fetch_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.commentId,
      input.replyId,
      input.kind,
      input.mimeType,
      input.byteSize,
      input.isVoice ? 1 : 0,
      input.externalId,
      input.sha256,
      input.fetchError
    );
  return Number(info.lastInsertRowid);
}

export async function storeOutboundMedia(input: {
  commentId: number;
  replyId: number;
  media: InspectedMedia;
  bytes: Buffer;
}): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const id = insertMeta({
    commentId: input.commentId,
    replyId: input.replyId,
    kind: input.media.kind,
    mimeType: input.media.mimeType,
    byteSize: input.bytes.length,
    isVoice: input.media.isVoice,
    externalId: null,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    fetchError: null,
  });
  try {
    await writeMediaBytes(id, input.bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : "未能儲存媒體";
    db.prepare(`UPDATE message_media SET byte_size = 0, fetch_error = ? WHERE id = ?`).run(
      message.slice(0, 300),
      id
    );
    return { ok: false, error: "未能儲存媒體" };
  }
  return { ok: true, id };
}

function findInbound(commentId: number, externalId: string): { id: number; byte_size: number } | undefined {
  return db
    .prepare(
      `SELECT id, byte_size FROM message_media
       WHERE comment_id = ? AND external_id = ? AND reply_id IS NULL`
    )
    .get(commentId, externalId) as { id: number; byte_size: number } | undefined;
}

export async function saveInboundMedia(input: {
  commentId: number;
  externalId: string;
  kind: MediaKind;
  mimeType: string;
  isVoice: boolean;
  sha256?: string | null;
  bytes?: Buffer | null;
  fetchError?: string | null;
}): Promise<void> {
  const existing = findInbound(input.commentId, input.externalId);
  if (existing && existing.byte_size > 0) return;
  const bytes = input.bytes ?? null;
  const fetchError = input.fetchError?.trim().slice(0, 300) || null;
  const mime = input.mimeType || (input.kind === "image" ? "image/jpeg" : input.kind === "video" ? "video/mp4" : "audio/ogg");
  let id = existing?.id;
  if (!id) {
    id = insertMeta({
      commentId: input.commentId,
      replyId: null,
      kind: input.kind,
      mimeType: mime,
      byteSize: bytes?.length ?? 0,
      isVoice: input.isVoice,
      externalId: input.externalId,
      sha256: input.sha256 ?? null,
      fetchError: bytes ? null : fetchError || "未能下載媒體",
    });
  } else {
    db.prepare(
      `UPDATE message_media
       SET kind = ?, mime_type = ?, byte_size = ?, is_voice = ?, sha256 = COALESCE(?, sha256), fetch_error = ?
       WHERE id = ?`
    ).run(input.kind, mime, bytes?.length ?? 0, input.isVoice ? 1 : 0, input.sha256 ?? null, bytes ? null : fetchError, id);
  }
  if (!bytes) return;
  try {
    await writeMediaBytes(id, bytes);
  } catch (err) {
    console.error("[media] 未能寫入入站媒體", err instanceof Error ? err.message : err);
    db.prepare(`UPDATE message_media SET byte_size = 0, fetch_error = ? WHERE id = ?`).run("未能儲存媒體", id);
  }
}

export interface VisibleMediaBody {
  status: 200 | 206 | 404 | 416;
  mime?: string;
  filename?: string;
  bytes?: Buffer;
  total?: number;
  contentRange?: string;
}

export async function readVisibleMedia(
  id: number,
  viewer: CommentViewer,
  rangeHeader: string | undefined
): Promise<VisibleMediaBody> {
  const meta = getMediaMeta(id);
  if (!meta || meta.byte_size <= 0 || meta.fetch_error) return { status: 404 };
  const comment = getComment(meta.comment_id);
  if (!comment || !canViewComment(comment, viewer)) return { status: 404 };
  const bytes = await readMediaBytes(id);
  if (!bytes || bytes.length === 0) return { status: 404 };
  const filename = `media-${id}.${extensionFor(meta.mime_type)}`;
  const range = parseRange(rangeHeader, bytes.length);
  if (range === "unsatisfiable") {
    return { status: 416, total: bytes.length, contentRange: `bytes */${bytes.length}` };
  }
  if (range) {
    return {
      status: 206,
      mime: meta.mime_type,
      filename,
      bytes: bytes.subarray(range.start, range.end + 1),
      total: bytes.length,
      contentRange: `bytes ${range.start}-${range.end}/${bytes.length}`,
    };
  }
  return { status: 200, mime: meta.mime_type, filename, bytes, total: bytes.length };
}

function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, size - 1) };
}
