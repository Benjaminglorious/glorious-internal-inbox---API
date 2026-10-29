import { db } from "../db";
import { findStaffById } from "../services/comments";
import { hashPassword, verifyPassword } from "./passwords";

export const MIN_PASSWORD_LENGTH = 8;

export const PASSWORD_CHANGED_MESSAGE = "密碼已更新，你仍然登入緊。下次登入請用新密碼。";

export const PASSWORD_CHANGE_ERRORS = {
  missing: "請填寫而家嘅密碼、新密碼同確認新密碼",
  tooShort: `新密碼至少要 ${MIN_PASSWORD_LENGTH} 個字`,
  mismatch: "新密碼同確認密碼唔一致",
  same: "新密碼唔可以同而家嘅密碼一樣",
  wrongCurrent: "而家嘅密碼唔正確",
  unauthenticated: "未登入",
} as const;

export type PasswordChangeResult = { ok: true } | { ok: false; status: number; error: string };

function readSecret(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function updateActiveStaffPassword(id: number, passwordHash: string): boolean {
  const result = db
    .prepare(`UPDATE staff SET password_hash = ? WHERE id = ? AND active = 1`)
    .run(passwordHash, id);
  return result.changes === 1;
}

/**
 * 只改傳入 staff id 自己嘅密碼（呼叫端要用 session，唔好信 body 入面嘅帳號）。
 * 收藏同事（active=0）唔會被改到。
 */
export function changeOwnPassword(
  staffId: number | undefined,
  input: {
    current_password?: unknown;
    new_password?: unknown;
    confirm_password?: unknown;
  }
): PasswordChangeResult {
  if (staffId == null || !Number.isInteger(staffId) || staffId <= 0) {
    return { ok: false, status: 401, error: PASSWORD_CHANGE_ERRORS.unauthenticated };
  }

  const currentPassword = readSecret(input.current_password);
  const newPassword = readSecret(input.new_password);
  const confirmPassword = readSecret(input.confirm_password);

  if (!currentPassword || !newPassword || !confirmPassword) {
    return { ok: false, status: 400, error: PASSWORD_CHANGE_ERRORS.missing };
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, status: 400, error: PASSWORD_CHANGE_ERRORS.tooShort };
  }
  if (newPassword !== confirmPassword) {
    return { ok: false, status: 400, error: PASSWORD_CHANGE_ERRORS.mismatch };
  }

  const staff = findStaffById(staffId);
  if (!staff || !staff.active) {
    return { ok: false, status: 401, error: PASSWORD_CHANGE_ERRORS.unauthenticated };
  }
  if (!verifyPassword(currentPassword, staff.password_hash)) {
    return { ok: false, status: 400, error: PASSWORD_CHANGE_ERRORS.wrongCurrent };
  }
  if (newPassword === currentPassword) {
    return { ok: false, status: 400, error: PASSWORD_CHANGE_ERRORS.same };
  }

  if (!updateActiveStaffPassword(staff.id, hashPassword(newPassword))) {
    return { ok: false, status: 401, error: PASSWORD_CHANGE_ERRORS.unauthenticated };
  }
  return { ok: true };
}
