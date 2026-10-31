import type { CommentSource, DeliveryStatus, EntryPath, IntakeKind, OriginSite } from "./types";

export const SOURCE_LABEL: Record<CommentSource, string> = {
  "28car": "28car",
  glorious_web: "東榮官網",
  facebook: "Facebook",
  instagram: "東榮 IG",
  whatsapp: "WhatsApp",
};

export const ORIGIN_LABEL: Record<OriginSite, string> = {
  "28car": "28car",
  glorious_web: "東榮官網",
  facebook: "Facebook",
  instagram: "東榮 IG",
};

export const ENTRY_LABEL: Record<EntryPath, string> = {
  "28car_board": "28car 留言板",
  "28car_wa_link": "28car 留言區 WhatsApp",
};

export const STATUS_LABEL: Record<string, string> = {
  open: "未處理",
  in_progress: "處理中",
  done: "已完成",
  pending: "擱置／未處理",
};

export const DELIVERY_LABEL: Record<DeliveryStatus, string> = {
  stub: "示範待發送",
  stored: "已儲存",
  failed: "發送失敗",
  sent: "已發送",
};

export function intakeBadgeText(kind: IntakeKind, source: CommentSource): string {
  if (kind === "whatsapp_click") return "WhatsApp 聯絡";
  if (source === "instagram") return "IG 留言";
  return "網站留言";
}

/** 列表、新留言提示、推送用嘅一行來源描述。 */
export function intakeSummary(input: {
  source: string;
  intake_kind?: string | null;
  origin_site?: string | null;
  entry_path?: string | null;
}): string {
  if (input.entry_path === "28car_board") return ENTRY_LABEL["28car_board"];
  if (input.entry_path === "28car_wa_link") return ENTRY_LABEL["28car_wa_link"];
  const sourceLabel = SOURCE_LABEL[input.source as CommentSource] || input.source || "留言";
  if (input.intake_kind === "whatsapp_click") {
    const origin = input.origin_site ? ORIGIN_LABEL[input.origin_site as OriginSite] : "";
    return origin ? `來自${origin}的 WhatsApp` : "WhatsApp 聯絡";
  }
  if (input.intake_kind === "site_comment") {
    if (input.source === "instagram") return "東榮 IG 留言";
    return `${sourceLabel} 網站留言`;
  }
  return sourceLabel;
}

export function deliveryDetail(status: DeliveryStatus, source: CommentSource): string {
  if (status === "failed") return "發送失敗";
  if (source === "28car" && status === "sent") return "已發送到 28car 留言板";
  if (source === "28car" && status === "stored") return "已排入 28car 留言板隊列（未發送）";
  if (status === "sent") return source === "whatsapp" ? "已經 WhatsApp 發送" : "已發送";
  if (status === "stored") return "已儲存（未發送）";
  switch (source) {
    case "whatsapp":
      return "示範待發送 · 同事個人線路未經公司 Cloud API";
    case "28car":
      return "示範待發送 · 未綁定車盤編號";
    case "glorious_web":
      return "示範待發送 · 尚未連接東榮官網";
    case "facebook":
      return "示範待發送 · 尚未連接 Facebook";
    case "instagram":
      return "示範待發送 · 尚未連接 Instagram";
    default:
      return "示範待發送";
  }
}
