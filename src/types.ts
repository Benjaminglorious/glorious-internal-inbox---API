export const COMMENT_SOURCES = ["28car", "glorious_web", "facebook", "instagram", "whatsapp", "email"] as const;
export type CommentSource = (typeof COMMENT_SOURCES)[number];

export const INTAKE_KINDS = ["site_comment", "whatsapp_click", "email"] as const;
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

/** 28car 留言板（網頁留言區）對比留言區入面嗰條 WhatsApp 連結。 */
export const ENTRY_PATHS = ["28car_board", "28car_wa_link"] as const;
export type EntryPath = (typeof ENTRY_PATHS)[number];

export const DELIVERY_STATUSES = ["stored", "stub", "failed", "sent"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Meta 入站：公開留言定 Messenger／IG 私訊。舊列可以係 null。 */
export const META_SURFACES = ["comment", "message"] as const;
export type MetaSurface = (typeof META_SURFACES)[number];

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

export function isEntryPath(value: unknown): value is EntryPath {
  return typeof value === "string" && (ENTRY_PATHS as readonly string[]).includes(value);
}

export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return typeof value === "string" && (DELIVERY_STATUSES as readonly string[]).includes(value);
}

export function isMetaSurface(value: unknown): value is MetaSurface {
  return value === "comment" || value === "message";
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
  /**
   * Messenger PSID 或 Instagram IGSID。
   * 公開留言可以係留言者 id，回覆時用 external_id（comment id），唔使靠呢欄。
   */
  meta_sender_id: string | null;
  /** 公開留言 comment；私訊 message。舊資料係 null，出站會再睇 external_id。 */
  meta_surface: MetaSurface | null;
  /**
   * Facebook post id（通常係 pageId_postId）、Instagram media id，
   * WhatsApp click-to-chat referral 嘅 source_id，
   * 或由帖文、限時動態、廣告開啟私訊時 webhook referral 嘅 post id。
   * 普通私訊、直接 WhatsApp、冇 referral 嘅舊列係 null。
   */
  meta_post_id: string | null;
  /** 帖文 permalink 或可開啟嘅廣告／帖文連結。Webhook 或 Graph 冇提供就係 null。 */
  meta_post_permalink: string | null;
  /** 帖文內文、caption，或 referral 嘅 headline／body。冇就係 null。 */
  meta_post_caption: string | null;
  /**
   * 28car_board：客戶寫喺網頁留言區。
   * 28car_wa_link：客戶撳咗留言區入面嘅 WhatsApp 連結，入公司 WhatsApp。
   */
  entry_path: EntryPath | null;
  /** 公司電郵客戶地址。其他來源係 null。 */
  email_from: string | null;
  /** 電郵主旨，唔帶 Re:。其他來源係 null。 */
  email_subject: string | null;
  /** 最新一封客戶信嘅 Message-ID，用來回覆同一串。 */
  email_message_id: string | null;
  /** 已見過嘅 Message-ID，空格分隔。 */
  email_references: string | null;
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
  /**
   * 客戶最新一句再留言（inbound）。未有再留言就係 null。
   * 留言箱「內容」用呢句；同事回覆唔會寫入呢度。
   */
  latest_inbound_body: string | null;
  latest_inbound_at: string | null;
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
