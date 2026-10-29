import { Request, Response, NextFunction } from "express";
import { findStaffById, type CommentViewer } from "../services/comments";

function wantsJson(req: Request): boolean {
  // Router 掛喺 /api 之後 req.path 會被剝走前綴，所以睇返完整網址。
  const fullPath = req.originalUrl || req.url || req.path;
  return fullPath.startsWith("/api/") || !!req.headers.accept?.includes("application/json");
}

function denyUnauthenticated(req: Request, res: Response): void {
  if (wantsJson(req)) {
    res.status(401).json({ error: "未登入" });
    return;
  }
  res.redirect("/login");
}

/** 在職先算登入。收藏（active=0）會清走 session，避免登入頁同留言箱互相跳轉。 */
function loadActiveStaff(req: Request): boolean {
  if (!req.session.staffId) return false;
  const staff = findStaffById(req.session.staffId);
  if (!staff || !staff.active) return false;
  req.session.isAdmin = !!staff.is_admin;
  return true;
}

export function sessionViewer(req: Request): CommentViewer {
  return { staffId: req.session.staffId ?? 0, isAdmin: !!req.session.isAdmin };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (loadActiveStaff(req)) {
    next();
    return;
  }
  if (req.session.staffId) {
    req.session.destroy(() => denyUnauthenticated(req, res));
    return;
  }
  denyUnauthenticated(req, res);
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.staffId) {
    res.status(401).json({ error: "未登入" });
    return;
  }
  const staff = findStaffById(req.session.staffId);
  if (!staff || !staff.active) {
    req.session.destroy(() => {
      res.status(401).json({ error: "未登入" });
    });
    return;
  }
  req.session.isAdmin = !!staff.is_admin;
  if (!req.session.isAdmin) {
    res.status(403).json({ error: "需要管理員權限" });
    return;
  }
  next();
}
