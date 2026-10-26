export type CommentSource = "28car" | "glorious_web" | "facebook";
export type CommentStatus = "open" | "in_progress" | "done";

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

declare module "express-session" {
  interface SessionData {
    staffId?: number;
    username?: string;
    displayName?: string;
    isAdmin?: boolean;
  }
}
