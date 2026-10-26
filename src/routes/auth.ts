import { Router, Request, Response } from "express";
import { verifyPassword } from "../auth/passwords";
import { findStaffByUsername } from "../services/comments";

export const authRouter = Router();

authRouter.post("/login", (req: Request, res: Response) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!username || !password) {
    res.status(400).json({ error: "請輸入帳號同密碼" });
    return;
  }
  const staff = findStaffByUsername(username);
  if (!staff || !verifyPassword(password, staff.password_hash)) {
    res.status(401).json({ error: "帳號或密碼錯誤" });
    return;
  }
  req.session.staffId = staff.id;
  req.session.username = staff.username;
  req.session.displayName = staff.display_name;
  req.session.isAdmin = !!staff.is_admin;
  res.json({
    ok: true,
    staff: {
      id: staff.id,
      username: staff.username,
      display_name: staff.display_name,
      is_admin: !!staff.is_admin,
    },
  });
});

authRouter.post("/logout", (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: "登出失敗" });
      return;
    }
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});
