import { Router, Request, Response } from "express";
import { requireAuth } from "../auth/middleware";
import {
  getComment,
  listComments,
  listStaff,
  reassign,
  updateStatus,
  findStaffById,
} from "../services/comments";
import type { CommentSource, CommentStatus } from "../types";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({ ok: true, service: "glorious-internal-inbox", ts: new Date().toISOString() });
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

apiRouter.get("/comments", requireAuth, (req: Request, res: Response) => {
  const source = req.query.source as CommentSource | undefined;
  const status = req.query.status as CommentStatus | undefined;
  const mine = req.query.mine === "1" || req.query.mine === "true";
  const validSources = ["28car", "glorious_web", "facebook"];
  const validStatuses = ["open", "in_progress", "done"];
  if (source && !validSources.includes(source)) {
    res.status(400).json({ error: "無效來源" });
    return;
  }
  if (status && !validStatuses.includes(status)) {
    res.status(400).json({ error: "無效狀態" });
    return;
  }
  const rows = listComments({
    source,
    status,
    mine,
    staffId: req.session.staffId,
  });
  res.json({ comments: rows });
});

apiRouter.get("/comments/:id", requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = getComment(id);
  if (!row) {
    res.status(404).json({ error: "找不到留言" });
    return;
  }
  res.json({ comment: row });
});

apiRouter.post("/comments/:id/status", requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || "") as CommentStatus;
  if (!["open", "in_progress", "done"].includes(status)) {
    res.status(400).json({ error: "狀態必須係 open / in_progress / done" });
    return;
  }
  if (!getComment(id)) {
    res.status(404).json({ error: "找不到留言" });
    return;
  }
  const updated = updateStatus(id, status);
  res.json({ comment: updated });
});

apiRouter.post("/comments/:id/assign", requireAuth, (req: Request, res: Response) => {
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
