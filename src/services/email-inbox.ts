import { bareEmailSubject, cleanMessageId, joinReferenceIds, normalizeEmailAddress } from "./email-address";
import { classifyCompanyEmail } from "./email-filter";
import { db } from "../db";
import { pickNextAutoAssignStaffId } from "./assign";
import {
  appendInboundMessage,
  commenterKey,
  findFoldedMessage,
  findOpenThread,
  isOpenCommenterConflict,
} from "./commenter-thread";
import { getComment } from "./comments";
import { inspectMediaBytes, saveInboundMedia } from "./media";
import { notifyNewComment } from "./push";

const MAX_BODY = 8000;
const MAX_ATTACHMENTS = 8;

export interface InboundCompanyEmail {
  mailbox: string;
  messageId: string;
  fromAddress: string;
  fromName?: string | null;
  subject?: string | null;
  text?: string | null;
  listUnsubscribe?: boolean;
  autoSubmitted?: boolean;
  bulk?: boolean;
  references?: string[];
  attachments?: Array<{ filename?: string | null; contentType?: string | null; content: Buffer }>;
}

export type IngestEmailResult =
  | {
      ok: true;
      outcome: "created" | "appended" | "duplicate";
      commentId: number;
      assigneeStaffId: number | null;
      reason: string;
    }
  | { ok: true; outcome: "ignored"; commentId: null; reason: string; assigneeStaffId: null }
  | { ok: false; error: string };

interface StoredMedia {
  filename: string;
  contentType: string;
  content: Buffer;
  kind: "image" | "video";
  mimeType: string;
}

function authorName(fromName: string | null | undefined, from: string): string {
  const name = String(fromName ?? "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  if (name && !normalizeEmailAddress(name)) return name;
  return from.slice(0, 120);
}

function composeBody(subject: string, text: string, notes: string[], mediaKind: "image" | "video" | null): string {
  const parts: string[] = [];
  if (subject.trim()) parts.push(`主旨：${subject.trim()}`);
  if (text.trim()) parts.push(text.trim());
  if (notes.length) parts.push(notes.join("\n"));
  if (!parts.length && mediaKind === "image") parts.push("［圖片］");
  if (!parts.length && mediaKind === "video") parts.push("［影片］");
  if (!parts.length) parts.push("［沒有文字的電郵］");
  return parts.join("\n\n").slice(0, MAX_BODY);
}

function splitAttachments(
  attachments: InboundCompanyEmail["attachments"]
): { kept: StoredMedia[]; notes: string[] } {
  const kept: StoredMedia[] = [];
  const notes: string[] = [];
  for (const item of (attachments ?? []).slice(0, 12)) {
    const filename = (item.filename || "attachment").replace(/[\r\n\u0000]/g, " ").trim().slice(0, 80) || "attachment";
    if (kept.length >= MAX_ATTACHMENTS) {
      notes.push(`［附件未收入：${filename}］`);
      continue;
    }
    const inspected = inspectMediaBytes(item.content, item.contentType || "", false);
    if (!inspected.ok || (inspected.media.kind !== "image" && inspected.media.kind !== "video")) {
      notes.push(`［附件未收入：${filename}］`);
      continue;
    }
    kept.push({
      filename,
      contentType: inspected.media.mimeType,
      content: item.content,
      kind: inspected.media.kind,
      mimeType: inspected.media.mimeType,
    });
  }
  return { kept, notes };
}

function existingCommentId(messageId: string): number | null {
  const folded = findFoldedMessage("email", messageId);
  if (folded) return folded.commentId;
  const row = db
    .prepare(`SELECT id FROM comments WHERE source = 'email' AND external_id = ?`)
    .get(messageId) as { id: number } | undefined;
  return row ? Number(row.id) : null;
}

/**
 * 把一封已經收到公司郵箱嘅信寫入現有 comments。
 * 主旨有 Glorious Motors Ltd／Limited，或者內容明顯係車，先至入庫。
 * 同一電郵地址未完成（未處理／處理中）只得一個 ID。已完成之後先至開新 ID。
 * 新對話用公司線輪流派單（Eddie → Wing → Jason → 其他在職同事，唔包括 Tony、Benjamin、Vivian）。
 */
export async function ingestCompanyEmail(input: InboundCompanyEmail): Promise<IngestEmailResult> {
  const mailbox = normalizeEmailAddress(input.mailbox);
  const from = normalizeEmailAddress(input.fromAddress);
  const messageId = cleanMessageId(input.messageId);
  if (!mailbox || !from || !messageId) {
    return { ok: true, outcome: "ignored", commentId: null, reason: "bad-envelope", assigneeStaffId: null };
  }
  if (from === mailbox) {
    return { ok: true, outcome: "ignored", commentId: null, reason: "own-mailbox", assigneeStaffId: null };
  }

  const already = existingCommentId(messageId);
  if (already != null) {
    const comment = getComment(already);
    return {
      ok: true,
      outcome: "duplicate",
      commentId: already,
      assigneeStaffId: comment?.assignee_staff_id ?? null,
      reason: "duplicate",
    };
  }

  const subject = String(input.subject ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
  const text = String(input.text ?? "").replace(/\u0000/g, "");
  const classified = classifyCompanyEmail({
    fromAddress: from,
    subject,
    text,
    listUnsubscribe: input.listUnsubscribe,
    autoSubmitted: input.autoSubmitted,
    bulk: input.bulk,
  });
  const author = authorName(input.fromName, from);
  const identityKey = commenterKey({ source: "email", authorName: author, emailAddress: from });
  const open = identityKey ? findOpenThread({ source: "email", key: identityKey, authorName: author }) : undefined;
  if (!classified.ingest) {
    if (classified.hardReject || !open) {
      return { ok: true, outcome: "ignored", commentId: null, reason: classified.reason, assigneeStaffId: null };
    }
  }

  const { kept, notes } = splitAttachments(input.attachments);
  const body = composeBody(subject, text, notes, kept[0]?.kind ?? null);
  const vehicleRef = classified.vehicleRef;
  const bareSubject = bareEmailSubject(subject);
  const references = joinReferenceIds(null, [...(input.references ?? []), messageId]);

  const write = db.transaction((): IngestEmailResult => {
    const again = existingCommentId(messageId);
    if (again != null) {
      const comment = getComment(again);
      return {
        ok: true,
        outcome: "duplicate",
        commentId: again,
        assigneeStaffId: comment?.assignee_staff_id ?? null,
        reason: "duplicate",
      };
    }
    const thread = identityKey ? findOpenThread({ source: "email", key: identityKey, authorName: author }) : undefined;
    if (thread) {
      const appended = appendInboundMessage({
        commentId: thread.id,
        source: "email",
        externalId: messageId,
        body,
        authorName: author,
        commenterKey: identityKey,
        fills: { vehicleRef },
      });
      const currentRefs = db.prepare(`SELECT email_references FROM comments WHERE id = ?`).get(thread.id) as
        | { email_references: string | null }
        | undefined;
      db.prepare(
        `UPDATE comments SET
           email_from = COALESCE(email_from, ?),
           email_subject = COALESCE(email_subject, ?),
           email_message_id = ?,
           email_references = ?,
           vehicle_ref = COALESCE(vehicle_ref, ?)
         WHERE id = ?`
      ).run(
        from,
        bareSubject || null,
        messageId,
        joinReferenceIds(currentRefs?.email_references, [messageId]),
        vehicleRef,
        thread.id
      );
      const comment = getComment(thread.id);
      return {
        ok: true,
        outcome: appended.duplicate ? "duplicate" : "appended",
        commentId: thread.id,
        assigneeStaffId: comment?.assignee_staff_id ?? thread.assignee_staff_id,
        reason: classified.ingest ? "vehicle" : "open-thread",
      };
    }

    if (!classified.ingest) {
      return { ok: true, outcome: "ignored", commentId: null, reason: classified.reason, assigneeStaffId: null };
    }

    const assigneeStaffId = pickNextAutoAssignStaffId();
    const info = db
      .prepare(
        `INSERT INTO comments (
           source, external_id, author_name, body, vehicle_ref, status, assignee_staff_id,
           intake_kind, origin_site, commenter_key,
           email_from, email_subject, email_message_id, email_references
         ) VALUES (?, ?, ?, ?, ?, 'open', ?, 'email', NULL, ?, ?, ?, ?, ?)`
      )
      .run(
        "email",
        messageId,
        author,
        body,
        vehicleRef,
        assigneeStaffId,
        identityKey,
        from,
        bareSubject || null,
        messageId,
        references
      );
    const commentId = Number(info.lastInsertRowid);
    const comment = getComment(commentId);
    if (!comment) return { ok: false, error: "入庫後讀唔返留言" };
    return {
      ok: true,
      outcome: "created",
      commentId,
      assigneeStaffId: comment.assignee_staff_id,
      reason: "vehicle",
    };
  });

  let result: IngestEmailResult;
  try {
    result = write();
  } catch (err) {
    if (!isOpenCommenterConflict(err)) throw err;
    result = write();
  }

  if (!result.ok || (result.outcome !== "created" && result.outcome !== "appended")) return result;

  const folded = findFoldedMessage("email", messageId);
  const replyId = result.outcome === "appended" ? folded?.replyId ?? null : null;
  for (const [index, media] of kept.entries()) {
    try {
      await saveInboundMedia({
        commentId: result.commentId,
        externalId: `email:${messageId}:${index}`,
        kind: media.kind,
        mimeType: media.mimeType,
        isVoice: false,
        bytes: media.content,
        replyId,
      });
    } catch (err) {
      console.error("[email] 相片或影片未寫入", err instanceof Error ? err.message : err);
    }
  }

  if (result.outcome === "created") {
    const comment = getComment(result.commentId);
    if (comment) {
      try {
        notifyNewComment({
          id: comment.id,
          source: comment.source,
          author_name: comment.author_name,
          body: comment.body,
          intake_kind: comment.intake_kind,
          origin_site: comment.origin_site,
          entry_path: comment.entry_path,
        });
      } catch (err) {
        console.error("[push] 未能排程推送", err);
      }
    }
  }
  return result;
}
