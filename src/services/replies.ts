import { queueOutboundReply } from "../adapters";
import { COMPANY_WHATSAPP_PHONE } from "../config";
import { queueMetaDmMedia } from "../adapters/meta-graph";
import { queueWhatsAppMedia } from "../adapters/whatsapp";
import { db } from "../db";
import type { CommentReply, CommentWithAssignee, DeliveryStatus } from "../types";
import { isDeliveryStatus } from "../types";
import { canViewComment, findStaffById, getComment, type CommentViewer } from "./comments";
import { decodeMediaBase64, inspectMediaBytes, placeholderFor, storeOutboundMedia } from "./media";
import { prepareChannelAudio } from "./ogg-opus";
import { normalizePhone } from "./whatsapp";

const MAX_BODY = 4000;

export type ReplyMutation =
  | { ok: true; reply: CommentReply; comment: CommentWithAssignee }
  | { ok: false; status: number; error: string };

interface ReplyRow {
  id: number;
  comment_id: number;
  staff_id: number | null;
  staff_name: string | null;
  direction: string;
  body: string;
  delivery_status: string;
  delivery_error: string | null;
  created_at: string;
}

function mapReply(row: ReplyRow): CommentReply {
  const delivery: DeliveryStatus = isDeliveryStatus(row.delivery_status) ? row.delivery_status : "stub";
  const deliveryError = typeof row.delivery_error === "string" ? row.delivery_error.trim() : "";
  return {
    id: row.id,
    comment_id: row.comment_id,
    staff_id: row.staff_id,
    staff_name: row.staff_name,
    direction: row.direction === "inbound" ? "inbound" : "outbound",
    body: row.body,
    delivery_status: delivery,
    delivery_error: deliveryError || null,
    created_at: row.created_at,
  };
}

export function listReplies(commentId: number): CommentReply[] {
  if (!Number.isInteger(commentId)) return [];
  const rows = db
    .prepare(
      `
      SELECT r.id, r.comment_id, r.staff_id, r.direction, r.body, r.delivery_status, r.delivery_error, r.created_at,
             s.display_name AS staff_name
      FROM comment_replies r
      LEFT JOIN staff s ON s.id = r.staff_id
      WHERE r.comment_id = ?
      ORDER BY r.created_at ASC, r.id ASC
    `
    )
    .all(commentId) as ReplyRow[];
  return rows.map(mapReply);
}

function getReply(id: number): CommentReply | null {
  const row = db
    .prepare(
      `
      SELECT r.id, r.comment_id, r.staff_id, r.direction, r.body, r.delivery_status, r.delivery_error, r.created_at,
             s.display_name AS staff_name
      FROM comment_replies r
      LEFT JOIN staff s ON s.id = r.staff_id
      WHERE r.id = ?
    `
    )
    .get(id) as ReplyRow | undefined;
  return row ? mapReply(row) : null;
}

/**
 * 同事喺收件箱回覆。內容寫入 comment_replies。
 * 公司 WhatsApp 總機有客戶號碼時會打 Cloud API。
 * Facebook／Instagram 有 Page token 就打 Graph。
 * 成功 sent，失敗 failed 並寫低原因。同事個人線路同官網仍然係 stub。
 * 原本係未處理（open）會改做處理中，唔會標已完成，所以仍然出現喺擱置／未處理。
 */
export async function createStaffReply(input: {
  commentId: number;
  staffId: number;
  body: string;
  /** 有傳就按可見範圍拒絕。Seed 等內部寫入唔傳，所以示範回覆可以跨負責人。 */
  viewer?: CommentViewer;
}): Promise<ReplyMutation> {
  if (!Number.isInteger(input.commentId)) return { ok: false, status: 400, error: "無效留言 id" };
  if (!Number.isInteger(input.staffId)) return { ok: false, status: 400, error: "無效同事 id" };

  const body = (input.body ?? "").replace(/\u0000/g, "").trim();
  if (!body) return { ok: false, status: 400, error: "請填寫回覆內容" };
  if (body.length > MAX_BODY) return { ok: false, status: 400, error: `回覆不可長過 ${MAX_BODY} 字` };

  const comment = getComment(input.commentId);
  if (!comment || (input.viewer && !canViewComment(comment, input.viewer))) {
    return { ok: false, status: 404, error: "找不到留言" };
  }

  const staff = findStaffById(input.staffId);
  if (!staff || !staff.active) return { ok: false, status: 403, error: "找不到這位在職同事" };

  const queued = await queueOutboundReply({
    commentId: comment.id,
    externalId: comment.external_id,
    source: comment.source,
    intakeKind: comment.intake_kind,
    originSite: comment.origin_site,
    body,
    staffId: staff.id,
    waFromPhone: comment.wa_from_phone,
    waToPhone: comment.wa_to_phone,
    vehicleRef: comment.vehicle_ref,
    metaSenderId: comment.meta_sender_id,
    metaSurface: comment.meta_surface,
  });
  const delivery: DeliveryStatus = isDeliveryStatus(queued.delivery_status) ? queued.delivery_status : "stub";
  const deliveryError =
    delivery === "failed" ? (queued.error || "發送失敗").replace(/\s+/g, " ").trim().slice(0, 500) || "發送失敗" : null;

  const replyId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, delivery_error)
         VALUES (?, ?, 'outbound', ?, ?, ?)`
      )
      .run(comment.id, staff.id, body, delivery, deliveryError);
    if (comment.status === "open") {
      db.prepare(
        `UPDATE comments SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?`
      ).run(comment.id);
    } else {
      db.prepare(`UPDATE comments SET updated_at = datetime('now') WHERE id = ?`).run(comment.id);
    }
    return Number(info.lastInsertRowid);
  })();

  const reply = getReply(replyId);
  const updated = getComment(comment.id);
  if (!reply || !updated) return { ok: false, status: 500, error: "回覆已寫入但讀唔返" };
  return { ok: true, reply, comment: updated };
}

/**
 * 同事上傳相片、影片或語音。文字回覆仍然走 createStaffReply。
 * 公司 WhatsApp 同 FB／IG 私訊會代發。公開留言、官網、28car、同事個人線路唔會假成功。
 */
export async function createStaffMediaReply(input: {
  commentId: number;
  staffId: number;
  caption?: string;
  mimeType?: string;
  isVoice?: boolean;
  dataBase64: string;
  viewer?: CommentViewer;
}): Promise<ReplyMutation> {
  if (!Number.isInteger(input.commentId)) return { ok: false, status: 400, error: "無效留言 id" };
  if (!Number.isInteger(input.staffId)) return { ok: false, status: 400, error: "無效同事 id" };
  const caption = (input.caption ?? "").replace(/\u0000/g, "").trim();
  if (caption.length > 1000) return { ok: false, status: 400, error: "說明不可長過 1000 字" };

  const bytes = decodeMediaBase64(input.dataBase64 || "");
  if (!bytes) return { ok: false, status: 400, error: "媒體內容不正確" };
  const inspected = inspectMediaBytes(bytes, input.mimeType || "", input.isVoice === true);
  if (!inspected.ok) return { ok: false, status: 400, error: inspected.error };

  const comment = getComment(input.commentId);
  if (!comment || (input.viewer && !canViewComment(comment, input.viewer))) {
    return { ok: false, status: 404, error: "找不到留言" };
  }
  const staff = findStaffById(input.staffId);
  if (!staff || !staff.active) return { ok: false, status: 403, error: "找不到這位在職同事" };

  const body = caption || placeholderFor(inspected.media.kind, inspected.media.isVoice);
  const replyId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, delivery_error)
         VALUES (?, ?, 'outbound', ?, 'stored', NULL)`
      )
      .run(comment.id, staff.id, body);
    if (comment.status === "open") {
      db.prepare(`UPDATE comments SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?`).run(comment.id);
    } else {
      db.prepare(`UPDATE comments SET updated_at = datetime('now') WHERE id = ?`).run(comment.id);
    }
    return Number(info.lastInsertRowid);
  })();

  const stored = await storeOutboundMedia({
    commentId: comment.id,
    replyId,
    media: inspected.media,
    bytes,
  });
  if (!stored.ok) {
    db.prepare(`UPDATE comment_replies SET delivery_status = 'failed', delivery_error = ? WHERE id = ?`).run(
      stored.error,
      replyId
    );
    const reply = getReply(replyId);
    const updated = getComment(comment.id);
    if (!reply || !updated) return { ok: false, status: 500, error: stored.error };
    return { ok: true, reply, comment: updated };
  }

  let outboundBytes = bytes;
  let outboundMime = inspected.media.mimeType;
  const linePhone = normalizePhone(comment.wa_to_phone) || (/^wa:(\d{8,15}):/.exec(comment.external_id)?.[1] ?? "");
  const companyWhatsApp =
    (comment.source === "whatsapp" || comment.intake_kind === "whatsapp_click") && linePhone === COMPANY_WHATSAPP_PHONE;
  const metaDm =
    (comment.source === "facebook" || comment.source === "instagram") && comment.meta_surface === "message";
  if ((companyWhatsApp || metaDm) && inspected.media.kind === "audio") {
    const prepared = prepareChannelAudio(bytes, inspected.media.mimeType);
    if (!prepared.ok) {
      db.prepare(`UPDATE comment_replies SET delivery_status = 'failed', delivery_error = ? WHERE id = ?`).run(
        prepared.error,
        replyId
      );
      const reply = getReply(replyId);
      const updated = getComment(comment.id);
      if (!reply || !updated) return { ok: false, status: 500, error: prepared.error };
      return { ok: true, reply, comment: updated };
    }
    outboundBytes = prepared.bytes;
    outboundMime = prepared.mime;
  }

  let queued: { delivery_status: DeliveryStatus; error?: string | null };
  if (comment.source === "whatsapp" || comment.intake_kind === "whatsapp_click") {
    queued = await queueWhatsAppMedia({
      commentId: comment.id,
      externalId: comment.external_id,
      waFromPhone: comment.wa_from_phone,
      waToPhone: comment.wa_to_phone,
      kind: inspected.media.kind,
      mimeType: outboundMime,
      bytes: outboundBytes,
      caption: caption || null,
    });
  } else if (comment.source === "facebook" || comment.source === "instagram") {
    queued = await queueMetaDmMedia({
      channel: comment.source,
      commentId: comment.id,
      externalId: comment.external_id,
      metaSenderId: comment.meta_sender_id,
      metaSurface: comment.meta_surface,
      kind: inspected.media.kind,
      mimeType: outboundMime,
      bytes: outboundBytes,
    });
  } else {
    queued = {
      delivery_status: "failed",
      error: "呢個渠道未支援由系統發送媒體。檔案已留喺收件箱。",
    };
  }

  const delivery: DeliveryStatus = isDeliveryStatus(queued.delivery_status) ? queued.delivery_status : "failed";
  const deliveryError =
    delivery === "failed" ? (queued.error || "發送失敗").replace(/\s+/g, " ").trim().slice(0, 500) || "發送失敗" : null;
  db.prepare(`UPDATE comment_replies SET delivery_status = ?, delivery_error = ? WHERE id = ?`).run(
    delivery,
    deliveryError,
    replyId
  );
  const reply = getReply(replyId);
  const updated = getComment(comment.id);
  if (!reply || !updated) return { ok: false, status: 500, error: "回覆已寫入但讀唔返" };
  return { ok: true, reply, comment: updated };
}
