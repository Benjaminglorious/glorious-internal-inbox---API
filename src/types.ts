export const COMMENT_SOURCES = ["28car", "glorious_web", "facebook", "whatsapp"] as const;
export type CommentSource = (typeof COMMENT_SOURCES)[number];
export type CommentStatus = "open" | "in_progress" | "done";
export type WhatsAppLineKind = "company" | "staff";

export function isCommentSource(value: unknown): value is CommentSource {
  return typeof value === "string" && (COMMENT_SOURCES as readonly string[]).includes(value);
}

export interface Staff {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  active: number;
  created_at: string;
}

export interface StaffPublic {
  id: number;
  username: string;
  display_name: string;
  is_admin: boolean;
  active: boolean;
}

export interface Comment {
  id: number;
  source: CommentSource;
  external_id: string;
  author_name: string;
  body: string;
  vehicle_ref: string | null;
  status: CommentStatus;
  assignee_staff_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface CommentWithAssignee extends Comment {
  assignee_name: string | null;
  assignee_username: string | null;
}

export interface WhatsAppLine {
  id: number;
  phone_e164: string;
  display_label: string;
  kind: WhatsAppLineKind;
  staff_id: number | null;
  is_active: boolean;
  created_at: string;
  staff_display_name: string | null;
  staff_username: string | null;
}

declare module "express-session" {
  interface SessionData {
    staffId?: number;
    username?: string;
    displayName?: string;
    isAdmin?: boolean;
  }
}
