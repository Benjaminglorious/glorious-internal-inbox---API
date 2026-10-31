import { queueOutboundReply } from "../adapters";
import { db } from "../db";
import type { CommentReply, CommentWithAssignee, DeliveryStatus } from "../types";
import { isDeliveryStatus } from "../types";
import { canViewComment, findStaffById, getComment, type CommentViewer } from "./comments";

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
      ORDER BY r.id ASC
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
 * 公司 WhatsApp 總機有客戶號碼時會打 Cloud API：成功 sent，失敗 failed 並寫低原因。
 * 其他渠道同同事個人線路仍然係 stub。
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
