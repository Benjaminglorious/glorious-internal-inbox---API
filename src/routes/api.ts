import { Router, Request, Response } from "express";
import { requireAdmin, requireAuth, sessionViewer } from "../auth/middleware";
import { companyWhatsAppUrl } from "../config";
import { isPushConfigured, removePushSubscription, savePushSubscription, vapidPublicKey } from "../services/push";
import {
  canViewComment,
  getComment,
  listCommentUpdates,
  listComments,
  listStaff,
  reassign,
  updateStatus,
  findStaffById,
} from "../services/comments";
import { createStaffReply, listReplies } from "../services/replies";
import { addStaffWhatsAppLine, deactivateWhatsAppLine, listWhatsAppLines } from "../services/whatsapp";
import {
  isCommentSource,
  isCommentStatus,
  isCommentStatusFilter,
  isIntakeKind,
  isOriginFilter,
} from "../types";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "glorious-internal-inbox",
    ts: new Date().toISOString(),
    company_whatsapp_url: companyWhatsAppUrl(),
    push_enabled: isPushConfigured(),
  });
});

/** 公開設定，畀網頁／日後客戶端讀公司 WhatsApp 連結，唔使硬編碼。 */
apiRouter.get("/config", (_req, res) => {
  res.json({
    company_whatsapp_url: companyWhatsAppUrl(),
  });
});

apiRouter.get("/me", requireAuth, (req: Request, res: Response) => {
  const staff = findStaffById(req.session.staffId!);
  if (!staff) {
    res.status(401).json({ error: "工作階段無效" });
    return;
  }
  res.json({
    id: staff.id,
    username: staff.username,
    display_name: staff.display_name,
    is_admin: !!staff.is_admin,
  });
});

apiRouter.get("/comments/updates", requireAuth, (req: Request, res: Response) => {
  const raw = req.query.since_id;
  let sinceId: number | null = null;
  if (raw != null && raw !== "") {
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
      res.status(400).json({ error: "since_id 必須係非負整數" });
      return;
    }
    sinceId = Number(raw);
    if (!Number.isSafeInteger(sinceId)) {
      res.status(400).json({ error: "since_id 必須係非負整數" });
      return;
    }
  }
  const updates = listCommentUpdates(sinceId, 30, sessionViewer(req));
  res.set("Cache-Control", "no-store");
  res.json(updates);
});

apiRouter.get("/comments", requireAuth, (req: Request, res: Response) => {
  const sourceRaw = typeof req.query.source === "string" ? req.query.source : undefined;
  const source = sourceRaw && isCommentSource(sourceRaw) ? sourceRaw : undefined;
  const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
  const status = statusRaw && isCommentStatusFilter(statusRaw) ? statusRaw : undefined;
  const intakeRaw = typeof req.query.intake === "string" ? req.query.intake : undefined;
  const intake = intakeRaw && isIntakeKind(intakeRaw) ? intakeRaw : undefined;
  const originRaw = typeof req.query.origin === "string" ? req.query.origin : undefined;
  const origin = originRaw && isOriginFilter(originRaw) ? originRaw : undefined;
  const mine = req.query.mine === "1" || req.query.mine === "true";
  if (sourceRaw && !source) {
    res.status(400).json({ error: "無效來源" });
    return;
  }
  if (statusRaw && !status) {
    res.status(400).json({ error: "無效狀態" });
    return;
  }
  if (intakeRaw && !intake) {
    res.status(400).json({ error: "無效形式" });
    return;
  }
  if (originRaw && !origin) {
    res.status(400).json({ error: "無效相關網站" });
    return;
  }
  const rows = listComments({
    source,
    status,
    intake,
    origin,
    mine,
    staffId: req.session.staffId,
    viewer: sessionViewer(req),
  });
  res.json({ comments: rows });
});

function visibleComment(req: Request, id: number) {
  const comment = getComment(id);
  if (!comment || !canViewComment(comment, sessionViewer(req))) return null;
  return comment;
}

apiRouter.get("/comments/:id/replies", requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!visibleComment(req, id)) {
    res.status(404).json({ error: "找不到留言" });
    return;
  }
  res.json({ replies: listReplies(id) });
});

apiRouter.post("/comments/:id/replies", requireAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const viewer = sessionViewer(req);
  try {
    const result = await createStaffReply({
      commentId: id,
      staffId: req.session.staffId!,
      body: typeof req.body?.body === "string" ? req.body.body : "",
      viewer,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({ reply: result.reply, comment: result.comment });
  } catch (err) {
    console.error("[replies] 未能寫入回覆", err);
    res.status(500).json({ error: "未能發送回覆" });
  }
});

apiRouter.get("/comments/:id", requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = visibleComment(req, id);
  if (!row) {
    res.status(404).json({ error: "找不到留言" });
    return;
  }
  res.json({ comment: row, replies: listReplies(id) });
});

apiRouter.post("/comments/:id/status", requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const status = req.body?.status;
  if (!isCommentStatus(status)) {
    res.status(400).json({ error: "狀態必須係 open / in_progress / done" });
    return;
  }
  if (!visibleComment(req, id)) {
    res.status(404).json({ error: "找不到留言" });
    return;
  }
  const updated = updateStatus(id, status);
  res.json({ comment: updated });
});

apiRouter.post("/comments/:id/assign", requireAdmin, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const staffIdRaw = req.body?.staff_id;
  const staffId =
    staffIdRaw === null || staffIdRaw === "" || staffIdRaw === undefined
      ? null
      : Number(staffIdRaw);
  if (staffId != null && Number.isNaN(staffId)) {
    res.status(400).json({ error: "無效同事 id" });
    return;
  }
  if (!getComment(id)) {
    res.status(404).json({ error: "找不到留言" });
    return;
  }
  const updated = reassign(id, staffId);
  if (!updated && staffId != null) {
    res.status(400).json({ error: "找不到有效同事" });
    return;
  }
  res.json({ comment: updated });
});

apiRouter.get("/staff", requireAuth, (_req: Request, res: Response) => {
  res.json({ staff: listStaff() });
});

apiRouter.get("/whatsapp-lines", requireAdmin, (_req: Request, res: Response) => {
  res.json({ lines: listWhatsAppLines() });
});

apiRouter.post("/whatsapp-lines", requireAdmin, (req: Request, res: Response) => {
  const staffId = Number(req.body?.staff_id);
  const result = addStaffWhatsAppLine({
    staffId,
    phone: String(req.body?.phone ?? ""),
    displayLabel: req.body?.display_label != null ? String(req.body.display_label) : undefined,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json({ line: result.line });
});

apiRouter.post("/whatsapp-lines/:id/deactivate", requireAdmin, (req: Request, res: Response) => {
  const result = deactivateWhatsAppLine(Number(req.params.id));
  if (!result.ok) {
    res.status(result.error === "找不到線路" ? 404 : 400).json({ error: result.error });
    return;
  }
  res.json({ line: result.line });
});

apiRouter.get("/push/config", requireAuth, (_req: Request, res: Response) => {
  const enabled = isPushConfigured();
  res.set("Cache-Control", "no-store");
  res.json({ enabled, public_key: enabled ? vapidPublicKey() : null });
});

apiRouter.post("/push/subscribe", requireAuth, (req: Request, res: Response) => {
  if (!isPushConfigured()) {
    res.status(503).json({ error: "伺服器未設定 Web Push" });
    return;
  }
  const result = savePushSubscription(req.session.staffId!, req.body, req.get("user-agent") ?? null);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

apiRouter.post("/push/unsubscribe", requireAuth, (req: Request, res: Response) => {
  const result = removePushSubscription(req.session.staffId!, req.body);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true, removed: result.removed });
});
