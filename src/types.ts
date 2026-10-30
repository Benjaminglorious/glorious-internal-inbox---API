export const COMMENT_SOURCES = ["28car", "glorious_web", "facebook", "instagram", "whatsapp"] as const;
export type CommentSource = (typeof COMMENT_SOURCES)[number];

export const INTAKE_KINDS = ["site_comment", "whatsapp_click"] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

/** 客戶撳 WhatsApp（或 IG 簡介連結）時，訊息係由邊個網站帶過嚟。 */
export const ORIGIN_SITES = ["28car", "glorious_web", "facebook", "instagram"] as const;
export type OriginSite = (typeof ORIGIN_SITES)[number];

export const ORIGIN_FILTERS = ["28car", "glorious_web", "facebook", "instagram", "direct"] as const;
export type OriginFilter = (typeof ORIGIN_FILTERS)[number];

export const COMMENT_STATUSES = ["open", "in_progress", "done"] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export const COMMENT_STATUS_FILTERS = ["open", "in_progress", "done", "pending"] as const;
export type CommentStatusFilter = (typeof COMMENT_STATUS_FILTERS)[number];

export const DELIVERY_STATUSES = ["stored", "stub", "failed", "sent"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const REPLY_DIRECTIONS = ["outbound", "inbound"] as const;
export type ReplyDirection = (typeof REPLY_DIRECTIONS)[number];

export type WhatsAppLineKind = "company" | "staff";

export function isCommentSource(value: unknown): value is CommentSource {
  return typeof value === "string" && (COMMENT_SOURCES as readonly string[]).includes(value);
}

export function isIntakeKind(value: unknown): value is IntakeKind {
  return typeof value === "string" && (INTAKE_KINDS as readonly string[]).includes(value);
}

export function isOriginSite(value: unknown): value is OriginSite {
  return typeof value === "string" && (ORIGIN_SITES as readonly string[]).includes(value);
}

export function isOriginFilter(value: unknown): value is OriginFilter {
  return typeof value === "string" && (ORIGIN_FILTERS as readonly string[]).includes(value);
}

export function isCommentStatus(value: unknown): value is CommentStatus {
  return typeof value === "string" && (COMMENT_STATUSES as readonly string[]).includes(value);
}

export function isCommentStatusFilter(value: unknown): value is CommentStatusFilter {
  return typeof value === "string" && (COMMENT_STATUS_FILTERS as readonly string[]).includes(value);
}

export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return typeof value === "string" && (DELIVERY_STATUSES as readonly string[]).includes(value);
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
  intake_kind: IntakeKind;
  origin_site: OriginSite | null;
  /** 客戶 WhatsApp wa_id（只留數字）。只會喺 WhatsApp 入站寫入。 */
  wa_from_phone: string | null;
  /** 收件線路號碼（只留數字）。公司總機係 85221740001。 */
  wa_to_phone: string | null;
}

export interface CommentWithAssignee extends Comment {
  assignee_name: string | null;
  assignee_username: string | null;
  reply_count: number;
  last_reply_body: string | null;
  last_reply_at: string | null;
  last_reply_staff_name: string | null;
  last_reply_delivery_status: DeliveryStatus | null;
  last_reply_direction: ReplyDirection | null;
}

export interface CommentReply {
  id: number;
  comment_id: number;
  staff_id: number | null;
  staff_name: string | null;
  direction: ReplyDirection;
  body: string;
  delivery_status: DeliveryStatus;
  /** 出站失敗時嘅可見原因。成功或 stub 為 null。 */
  delivery_error: string | null;
  created_at: string;
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
