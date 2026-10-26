import { Request, Response, NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.staffId) {
    if (req.path.startsWith("/api/") || req.headers.accept?.includes("application/json")) {
      res.status(401).json({ error: "未登入" });
      return;
    }
    res.redirect("/login");
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.staffId) {
    res.status(401).json({ error: "未登入" });
    return;
  }
  if (!req.session.isAdmin) {
    res.status(403).json({ error: "需要管理員權限" });
    return;
  }
  next();
}
