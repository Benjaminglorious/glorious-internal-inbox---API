import { Router, Request, Response } from "express";
import { PASSWORD_CHANGED_MESSAGE, PASSWORD_CHANGE_ERRORS, changeOwnPassword } from "../auth/change-password";
import { requireAuth, sessionViewer } from "../auth/middleware";
import { verifyPassword } from "../auth/passwords";
import { COMPANY_WHATSAPP_PHONE, companyWhatsAppChatUrl, whatsAppSendUrl } from "../config";
import { companyEmailAddress } from "../services/email-config";
import {
  DELIVERY_LABEL,
  EMAIL_LEAVE_NOTE,
  ENTRY_LABEL,
  ORIGIN_LABEL,
  SOURCE_LABEL,
  STATUS_LABEL,
  deliveryDetail,
  intakeBadgeText,
  intakeSummary,
  isEmailChannel,
} from "../labels";
import { clipMessagePreview, linkifyMessageHtml } from "../linkify";
import { registerTwentyeightcarPages } from "./twentyeightcar-pages";
import { listingIndex, stockIdFromText } from "../services/twentyeightcar";
import { formatHktIso, formatStaffTimestamp, parseStoredTimestamp, type StoredClock } from "../time";
import {
  REASSIGNED_MESSAGE,
  canViewComment,
  getComment,
  getCommentWithCursor,
  latestCustomerMessageText,
  listCommentsWithCursor,
  listStaff,
  findStaffByUsername,
  normalizeInboxQuery,
  updateStatus,
  reassign,
} from "../services/comments";
import { blockingOpenThreadId } from "../services/commenter-thread";
import { isPlaceholderBody, listMediaForComment, type MediaRecord } from "../services/media";
import { createStaffReply, listReplies } from "../services/replies";
import {
  activeStaffLinesByStaffId,
  addStaffWhatsAppLine,
  deactivateWhatsAppLine,
  formatPhoneE164,
  listWhatsAppLines,
  normalizePhone,
  resolveWhatsAppCustomerPhone,
  staffToCustomerWhatsAppUrl,
  staffWhatsAppReplyForViewer,
} from "../services/whatsapp";
import { sendMedia } from "./media-http";
import {
  COMMENT_SOURCES,
  ORIGIN_FILTERS,
  isCommentSource,
  isCommentStatus,
  isCommentStatusFilter,
  isEntryPath,
  isIntakeKind,
  isOriginFilter,
  type CommentWithAssignee,
  type IntakeKind,
  type OriginFilter,
  type WhatsAppLine,
} from "../types";

export const pagesRouter = Router();

pagesRouter.get("/media/:id", requireAuth, (req: Request, res: Response) => {
  void sendMedia(req, res);
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showTime(value: string | null | undefined, clock: StoredClock = "utc"): string {
  const text = formatStaffTimestamp(value, clock, { relative: true });
  if (!text) return "—";
  const instant = value ? parseStoredTimestamp(value, clock) : null;
  if (!instant) return escapeHtml(text);
  return `<time datetime="${escapeHtml(formatHktIso(instant))}">${escapeHtml(text)}</time>`;
}

function sessionUser(req: Request): { displayName: string; isAdmin?: boolean } {
  return { displayName: req.session.displayName || "", isAdmin: req.session.isAdmin };
}

function whatsAppLinks(
  c: Pick<CommentWithAssignee, "source" | "vehicle_ref" | "body" | "assignee_staff_id" | "intake_kind" | "origin_site">,
  staffLines: Map<number, WhatsAppLine>
): string {
  const ctx = {
    sourceLabel: intakeSummary(c),
    vehicleRef: c.vehicle_ref,
    body: c.body,
  };
  const companyHref = companyWhatsAppChatUrl(ctx);
  const company = `<a class="btn whatsapp" href="${escapeHtml(companyHref)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>`;
  const line = c.assignee_staff_id != null ? staffLines.get(c.assignee_staff_id) : undefined;
  if (!line) return `<div class="wa-actions">${company}</div>`;
  const staffHref = whatsAppSendUrl(line.phone_e164, ctx);
  const staff = `<a class="btn whatsapp staff" href="${escapeHtml(staffHref)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(line.display_label)}">同事 WhatsApp</a>`;
  return `<div class="wa-actions">${company}${staff}</div>`;
}

function customerReplyButton(
  c: Pick<CommentWithAssignee, "source" | "external_id" | "wa_from_phone" | "wa_to_phone">
): string {
  const phone = resolveWhatsAppCustomerPhone({
    source: c.source,
    externalId: c.external_id,
    waFromPhone: c.wa_from_phone,
    waToPhone: c.wa_to_phone,
  });
  const href = phone ? staffToCustomerWhatsAppUrl(phone) : null;
  if (!phone || !href) return "";
  return `<a class="btn whatsapp own" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="用你而家登入嘅 WhatsApp 發畀 ${escapeHtml(formatPhoneE164(phone))}">回覆客戶</a>`;
}

/** 預設收起。留言操作只留「回覆」喺外面。 */
function collapsedMore(inner: string, className = "more-actions"): string {
  const body = inner.trim();
  if (!body) return "";
  return `<details class="${className}"><summary>更多</summary><div class="more-actions-body">${body}</div></details>`;
}

function renderMediaBlocks(items: MediaRecord[]): string {
  if (!items.length) return "";
  return items
    .map((item) => {
      if (item.fetch_error || item.byte_size <= 0) {
        return `<p class="media-error">${escapeHtml(item.fetch_error || "未能載入媒體")}</p>`;
      }
      const src = `/media/${item.id}`;
      if (item.kind === "image") {
        return `<div class="bubble-media"><img src="${src}" alt="圖片"></div>`;
      }
      if (item.kind === "video") {
        return `<div class="bubble-media"><video controls preload="metadata" src="${src}"></video><p class="muted small">影片</p></div>`;
      }
      const label = item.is_voice ? "語音" : "錄音";
      return `<div class="bubble-media"><p class="muted small">${escapeHtml(label)}</p><audio controls preload="metadata" src="${src}"></audio></div>`;
    })
    .join("");
}

function renderStaffWhatsAppPanel(c: CommentWithAssignee, viewerStaffId: number): string {
  if (c.source !== "whatsapp") return "";
  const link = staffWhatsAppReplyForViewer(c, viewerStaffId);
  if (!link.available || !link.customer_phone) {
    return `<section class="reply-panel" id="staff-wa">
      <h2>用同事 WhatsApp 回覆客戶</h2>
      <p class="muted small">${escapeHtml(link.reason || "未有客戶 WhatsApp 號碼，開唔到同事 WhatsApp。舊嘅 wamid 要等客戶再傳一則先至有號碼。")}</p>
    </section>`;
  }
  const viewerLine = link.viewer_phone
    ? `<p>你嘅 WhatsApp：<strong>${escapeHtml(formatPhoneE164(link.viewer_phone))}</strong>${
        link.viewer_label ? `（${escapeHtml(link.viewer_label)}）` : ""
      }。請喺已登入<strong>呢個號碼</strong>嘅手機或 WhatsApp 網頁打開。公司 Cloud API 只可以總機 ${COMPANY_WHATSAPP_PHONE} 代發，改唔到寄件人。</p>`
    : `<p class="muted small">你未有啟用中嘅個人 WhatsApp。管理員可以喺「WhatsApp 線路」綁定。下面條連結會打開你而家登入嘅 WhatsApp；請唔好用公司總機 ${COMPANY_WHATSAPP_PHONE} 登入。</p>`;
  return `<section class="reply-panel" id="staff-wa">
    <h2>用同事 WhatsApp 回覆客戶</h2>
    <p class="muted small">客人用 WhatsApp 搵同事時，同事要用自己嘅 WhatsApp 回覆。下面會開新分頁，由你而家登入嘅號碼發送。你仍然要喺 WhatsApp 按發送。</p>
    ${link.contacted_label ? `<p>${escapeHtml(link.contacted_label)}</p>` : ""}
    <p>客戶號碼：<strong>${escapeHtml(formatPhoneE164(link.customer_phone))}</strong></p>
    ${viewerLine}
    <form class="staff-wa-form" method="GET" action="https://api.whatsapp.com/send" target="_blank" referrerpolicy="no-referrer">
      <input type="hidden" name="phone" value="${escapeHtml(link.customer_phone)}">
      <label>預填訊息（可選）
        <textarea name="text" maxlength="500" rows="4" placeholder="可留空。有字會預填喺你嘅 WhatsApp，客戶會見到。內部備註唔好寫喺度。"></textarea>
      </label>
      <button type="submit" class="btn whatsapp own">用我嘅 WhatsApp 發送畀客戶</button>
    </form>
  </section>`;
}

function mediaComposerHint(c: CommentWithAssignee): string {
  if (isEmailChannel(c)) {
    return "客戶電郵入面嘅相片同影片會顯示喺對話。呢度上傳只留喺收件箱，唔會寄出。回覆客戶請用上面「發送回覆」。這是email的留言。";
  }
  if (c.source === "whatsapp") {
    const line = normalizePhone(c.wa_to_phone);
    if (line && line !== COMPANY_WHATSAPP_PHONE) {
      return "呢條係同事個人 WhatsApp。系統可以儲存同播放語音、相片、影片，但唔可以經公司 Cloud API 代發。請用「用我嘅 WhatsApp」打開對話，再喺 WhatsApp 傳送。";
    }
    return `公司總機可以經 Cloud API 發送相片、影片同語音（用公司號碼 ${COMPANY_WHATSAPP_PHONE}）。同事個人號請用「用我嘅 WhatsApp」。`;
  }
  if ((c.source === "facebook" || c.source === "instagram") && c.meta_surface === "message") {
    return "私訊可以經 Graph 發送相片、影片同語音。公開留言只可以回文字。";
  }
  if (c.source === "facebook" || c.source === "instagram") {
    return "公開留言只可以回文字。上傳嘅媒體只會留喺收件箱，唔會發去帖文。";
  }
  return "呢個渠道未支援由系統代發媒體。上傳之後只會留喺收件箱，畀同事查看同播放。";
}

function requirePageAdmin(req: Request, res: Response): boolean {
  if (req.session.isAdmin) return true;
  res.status(403).send(
    layout({
      title: "沒有權限",
      body: `<p>WhatsApp 線路只限管理員管理。</p><p><a href="/">返回留言箱</a></p>`,
      user: sessionUser(req),
    })
  );
  return false;
}

function renderSourceBadges(
  c: Pick<CommentWithAssignee, "source" | "intake_kind" | "origin_site" | "entry_path">
): string {
  const origin =
    c.intake_kind === "whatsapp_click"
      ? c.origin_site
        ? `<span class="badge origin">來自${escapeHtml(ORIGIN_LABEL[c.origin_site])}</span>`
        : `<span class="badge origin direct">直接 WhatsApp</span>`
      : "";
  const entry = c.entry_path
    ? `<span class="badge entry-${c.entry_path}">${escapeHtml(ENTRY_LABEL[c.entry_path])}</span>`
    : "";
  const emailNote = isEmailChannel(c) ? `<span class="badge email-note">${EMAIL_LEAVE_NOTE}</span>` : "";
  return `<div class="badge-stack">
    <span class="badge source-${c.source}">${escapeHtml(SOURCE_LABEL[c.source] || c.source)}</span>
    <span class="badge intake-${c.intake_kind}">${escapeHtml(intakeBadgeText(c.intake_kind, c.source))}</span>
    ${emailNote}
    ${origin}
    ${entry}
  </div>`;
}

function safePostUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function postChannelName(c: CommentWithAssignee): "Facebook" | "Instagram" | "" {
  if (c.source === "instagram") return "Instagram";
  if (c.source === "facebook") return "Facebook";
  const href = safePostUrl(c.meta_post_permalink);
  if (href) {
    try {
      const host = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
      if (host === "instagram.com" || host.endsWith(".instagram.com") || host === "instagr.am") return "Instagram";
      if (
        host === "facebook.com" ||
        host.endsWith(".facebook.com") ||
        host === "fb.com" ||
        host.endsWith(".fb.com") ||
        host === "fb.me" ||
        host === "m.facebook.com" ||
        host === "mbasic.facebook.com"
      ) {
        return "Facebook";
      }
    } catch {
      /* 連結格式唔啱就跟來源站 */
    }
  }
  if (c.origin_site === "instagram") return "Instagram";
  if (c.origin_site === "facebook") return "Facebook";
  return "";
}

function showsParentPost(c: CommentWithAssignee): boolean {
  if (c.source === "facebook" || c.source === "instagram") return true;
  if (c.source !== "whatsapp") return false;
  return Boolean(c.meta_post_caption?.trim() || c.meta_post_id?.trim() || safePostUrl(c.meta_post_permalink));
}

function renderPostHint(c: CommentWithAssignee): string {
  if (!showsParentPost(c)) return "";
  if (c.source !== "whatsapp" && c.meta_surface === "message") return `<div class="post-hint">私訊</div>`;
  const caption = c.meta_post_caption?.replace(/\s+/g, " ").trim() || "";
  const postId = c.meta_post_id?.trim() || "";
  const href = safePostUrl(c.meta_post_permalink);
  if (!caption && !postId && !href) return "";
  const text = caption ? clipMessagePreview(caption, 60) : postId || "開啟原帖";
  return `<div class="post-hint">帖文：${linkifyMessageHtml(text)}</div>`;
}

function renderParentPost(c: CommentWithAssignee): string {
  if (!showsParentPost(c)) return "";
  const channel = postChannelName(c);
  const privateLabel = channel || (c.source === "instagram" ? "Instagram" : "Facebook");
  if (c.source !== "whatsapp" && c.meta_surface === "message") {
    return `<section class="parent-post"><h2>所屬帖文</h2><p class="muted small">呢則係${privateLabel}私訊，唔係公開帖文留言。</p></section>`;
  }
  const caption = c.meta_post_caption?.trim() || "";
  const postId = c.meta_post_id?.trim() || "";
  const href = safePostUrl(c.meta_post_permalink);
  if (!caption && !postId && !href) {
    return `<section class="parent-post"><h2>所屬帖文</h2><p class="muted small">未有${privateLabel}帖文資料。新嘅 Meta webhook 如果帶帖文編號、內容或連結，就會顯示喺度。</p></section>`;
  }
  const heading = channel ? `所屬${channel}帖文` : "所屬帖文";
  const linkLabel = channel ? `開啟${channel}原帖` : "開啟原帖";
  const link = href
    ? `<p><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${linkLabel}</a></p>`
    : "";
  return `<section class="parent-post">
    <h2>${heading}</h2>
    ${caption ? `<p class="caption">${linkifyMessageHtml(caption)}</p>` : `<p class="muted small">未有帖文內容。</p>`}
    <p class="muted small">帖文編號：<code>${postId ? escapeHtml(postId) : "—"}</code></p>
    ${link}
  </section>`;
}

function replyPreview(c: CommentWithAssignee): string {
  if (!c.reply_count || !c.last_reply_body) {
    return `<div class="reply-preview none">未有同事回覆</div>`;
  }
  const flat = c.last_reply_body.replace(/\s+/g, " ").trim();
  const text = clipMessagePreview(flat);
  const count = c.reply_count > 1 ? `（${c.reply_count}）` : "";
  const when = c.last_reply_at ? ` · ${showTime(c.last_reply_at)}` : "";
  if (c.last_reply_direction === "inbound") {
    return `<div class="reply-preview">客戶再留言${count}${when}：${linkifyMessageHtml(text)}</div>`;
  }
  const who = c.last_reply_staff_name || "同事";
  const delivery = c.last_reply_delivery_status ? DELIVERY_LABEL[c.last_reply_delivery_status] : "";
  return `<div class="reply-preview">最新回覆${count} · ${escapeHtml(who)}${when} · ${escapeHtml(delivery)}：${linkifyMessageHtml(text)}</div>`;
}

function layout(opts: {
  title: string;
  body: string;
  user?: { displayName: string; isAdmin?: boolean };
  active?: string;
  /** 有呢個數字先至喺留言箱／詳情輪詢新留言。0 代表暫時未有留言。 */
  liveCursor?: number;
  liveReplyCursor?: number;
}): string {
  const nav = opts.user
    ? `
    <header class="topbar">
      <div class="brand">
        <a href="/">東榮內部留言</a>
        <span class="tag">Internal</span>
      </div>
      <nav>
        <a href="/" class="${opts.active === "inbox" ? "active" : ""}">留言箱</a>
        <a href="/28car" class="${opts.active === "28car" ? "active" : ""}">28car 車盤</a>
        <a href="/staff" class="${opts.active === "staff" ? "active" : ""}">同事</a>
        <a href="/password" class="${opts.active === "password" ? "active" : ""}">改密碼</a>
        ${
          opts.user.isAdmin
            ? `<a href="/whatsapp-lines" class="${opts.active === "whatsapp" ? "active" : ""}">WhatsApp 線路</a>`
            : ""
        }
      </nav>
      <div class="userbox">
        <span>${escapeHtml(opts.user.displayName)}${opts.user.isAdmin ? " · 管理員" : ""}</span>
        <form method="POST" action="/logout" style="display:inline">
          <button type="submit" class="btn ghost">登出</button>
        </form>
      </div>
    </header>`
    : "";

  const live =
    typeof opts.liveCursor === "number"
      ? `<div id="inbox-live" data-latest-id="${opts.liveCursor}" data-latest-reply-id="${opts.liveReplyCursor ?? 0}" hidden></div>`
      : "";

  const authenticated = opts.user ? ` data-authenticated="1"` : "";

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0b3d5c" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black" />
  <meta name="apple-mobile-web-app-title" content="東榮留言" />
  <title>${escapeHtml(opts.title)} · 東榮內部留言</title>
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" href="/icons/icon-192.png" type="image/png" />
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body${authenticated}>
  ${nav}
  <main class="container">
    ${opts.body}
  </main>
  ${live}
  <script src="/app.js"></script>
</body>
</html>`;
}

pagesRouter.get("/login", (req: Request, res: Response) => {
  if (req.session.staffId) {
    res.redirect("/");
    return;
  }
  const err = req.query.error ? String(req.query.error) : "";
  const body = `
    <section class="login-card">
      <h1>東榮汽車 · 內部留言系統</h1>
      <p class="muted">僅供公司同事登入。可以喺系統內回覆 28car、東榮官網、Facebook、東榮 IG 同公司 WhatsApp。</p>
      ${err ? `<p class="error">${escapeHtml(err)}</p>` : ""}
      <form method="POST" action="/login" class="stack">
        <label>帳號
          <input name="username" autocomplete="username" required placeholder="例如 tony" />
        </label>
        <label>密碼
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit" class="btn primary">登入</button>
      </form>
      <p class="hint">示範密碼見 README（正式環境必須更改）</p>
    </section>`;
  res.send(layout({ title: "登入", body }));
});

pagesRouter.post("/login", (req: Request, res: Response) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const staff = findStaffByUsername(username);
  if (!staff || !verifyPassword(password, staff.password_hash)) {
    res.redirect("/login?error=" + encodeURIComponent("帳號或密碼錯誤"));
    return;
  }
  req.session.staffId = staff.id;
  req.session.username = staff.username;
  req.session.displayName = staff.display_name;
  req.session.isAdmin = !!staff.is_admin;
  res.redirect("/");
});

const PASSWORD_FORM_ERRORS = new Set<string>([
  PASSWORD_CHANGE_ERRORS.missing,
  PASSWORD_CHANGE_ERRORS.tooShort,
  PASSWORD_CHANGE_ERRORS.mismatch,
  PASSWORD_CHANGE_ERRORS.same,
  PASSWORD_CHANGE_ERRORS.wrongCurrent,
]);

function renderPasswordPage(req: Request, opts: { error?: string; notice?: string }): string {
  const error = opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : "";
  const notice = opts.notice ? `<p class="notice">${escapeHtml(opts.notice)}</p>` : "";
  const body = `
    <section class="login-card">
      <h1>改密碼</h1>
      <p class="muted">只會改你自己嘅登入密碼。其他同事嘅密碼改唔到。</p>
      ${notice}
      ${error}
      <form method="POST" action="/password" class="stack">
        <label>而家嘅密碼
          <input name="current_password" type="password" autocomplete="current-password" required />
        </label>
        <label>新密碼
          <input name="new_password" type="password" autocomplete="new-password" required minlength="8" />
        </label>
        <label>確認新密碼
          <input name="confirm_password" type="password" autocomplete="new-password" required minlength="8" />
        </label>
        <button type="submit" class="btn primary">更新密碼</button>
      </form>
      <p class="hint">新密碼至少 8 個字，而且要同而家嘅密碼唔同。</p>
    </section>`;
  return layout({
    title: "改密碼",
    body,
    user: sessionUser(req),
    active: "password",
  });
}

pagesRouter.get("/password", requireAuth, (req: Request, res: Response) => {
  const rawError = typeof req.query.error === "string" ? req.query.error : "";
  const error = PASSWORD_FORM_ERRORS.has(rawError) ? rawError : "";
  const notice = req.query.ok === "1" ? PASSWORD_CHANGED_MESSAGE : "";
  res.send(renderPasswordPage(req, { error, notice }));
});

pagesRouter.post("/password", requireAuth, (req: Request, res: Response) => {
  const result = changeOwnPassword(req.session.staffId, {
    current_password: req.body?.current_password,
    new_password: req.body?.new_password,
    confirm_password: req.body?.confirm_password,
  });
  if (!result.ok) {
    if (result.status === 401) {
      res.redirect("/login");
      return;
    }
    res.redirect("/password?error=" + encodeURIComponent(result.error));
    return;
  }
  res.redirect("/password?ok=1");
});

pagesRouter.post("/logout", (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
    res.redirect("/login");
  });
});

pagesRouter.get("/", requireAuth, (req: Request, res: Response) => {
  const sourceRaw = typeof req.query.source === "string" ? req.query.source : undefined;
  const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
  const intakeRaw = typeof req.query.intake === "string" ? req.query.intake : undefined;
  const originRaw = typeof req.query.origin === "string" ? req.query.origin : undefined;
  const entryRaw = typeof req.query.entry === "string" ? req.query.entry : undefined;
  const mine = req.query.mine === "1";
  const q = normalizeInboxQuery(req.query.q);
  const src = sourceRaw && isCommentSource(sourceRaw) ? sourceRaw : undefined;
  const st = statusRaw && isCommentStatusFilter(statusRaw) ? statusRaw : undefined;
  const intake: IntakeKind | undefined = intakeRaw && isIntakeKind(intakeRaw) ? intakeRaw : undefined;
  const origin: OriginFilter | undefined = originRaw && isOriginFilter(originRaw) ? originRaw : undefined;
  const entry = entryRaw && isEntryPath(entryRaw) ? entryRaw : undefined;

  const viewer = sessionViewer(req);
  const { comments, latestId, latestReplyId } = listCommentsWithCursor({
    source: src,
    status: st,
    intake,
    origin,
    entry,
    mine: viewer.isAdmin && mine,
    staffId: req.session.staffId,
    viewer,
    q,
  });
  const staffLines = activeStaffLinesByStaffId();
  const listingsByStock = listingIndex();

  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (src) p.set("source", src);
    if (st) p.set("status", st);
    if (intake) p.set("intake", intake);
    if (origin) p.set("origin", origin);
    if (entry) p.set("entry", entry);
    if (mine) p.set("mine", "1");
    if (q) p.set("q", q);
    for (const [k, v] of Object.entries(extra)) {
      if (v === "") p.delete(k);
      else p.set(k, v);
    }
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  const rows = comments
    .map((c) => {
      const customerText = latestCustomerMessageText(c);
      const preview = clipMessagePreview(customerText);
      const stockId = stockIdFromText(c.vehicle_ref);
      const known = stockId ? listingsByStock.get(stockId) : undefined;
      const vehicleCell = known
        ? `<a href="/28car/${escapeHtml(known.stock_id)}">${escapeHtml(known.title)}</a>`
        : c.vehicle_ref
          ? escapeHtml(c.vehicle_ref)
          : "—";
      return `<tr>
        <td><a href="/comments/${c.id}">#${c.id}</a></td>
        <td>${renderSourceBadges(c)}</td>
        <td>${escapeHtml(c.author_name)}</td>
        <td class="preview"><span class="content-preview">${linkifyMessageHtml(preview)}</span>${renderPostHint(c)}${replyPreview(c)}</td>
        <td>${vehicleCell}</td>
        <td><span class="badge status-${c.status}">${STATUS_LABEL[c.status]}</span></td>
        <td class="when">${showTime(c.created_at)}</td>
        <td>${c.assignee_name ? escapeHtml(c.assignee_name) : "未派"}</td>
        <td class="actions-cell"><a class="btn primary" href="/comments/${c.id}#reply">回覆</a>${collapsedMore(`${customerReplyButton(c)}${whatsAppLinks(c, staffLines)}`)}</td>
      </tr>`;
    })
    .join("");

  const body = `
    <div class="page-head">
      <h1>留言箱</h1>
      <p class="muted">${q ? `搵到 ${comments.length} 條` : `共 ${comments.length} 條`}</p>
    </div>
    ${
      viewer.isAdmin
        ? ""
        : `<p class="muted">你只會見到派咗畀你嘅留言。未派同其他同事嘅留言只係管理員睇到。搜尋同樣只包括呢啲留言。</p>`
    }
    <form class="filters" method="GET" action="/">
      <label class="search">搜尋
        <input type="search" name="q" value="${q ? escapeHtml(q) : ""}" maxlength="120" placeholder="姓名、電話、內容、來源、帖文" />
      </label>
      <label>來源
        <select name="source">
          <option value="">全部</option>
          ${COMMENT_SOURCES.map(
            (source) =>
              `<option value="${source}" ${src === source ? "selected" : ""}>${SOURCE_LABEL[source]}</option>`
          ).join("")}
        </select>
      </label>
      <label>形式
        <select name="intake">
          <option value="">全部</option>
          <option value="site_comment" ${intake === "site_comment" ? "selected" : ""}>網站／IG 留言</option>
          <option value="whatsapp_click" ${intake === "whatsapp_click" ? "selected" : ""}>WhatsApp 聯絡</option>
          <option value="email" ${intake === "email" ? "selected" : ""}>email 留言</option>
        </select>
      </label>
      <label>相關網站
        <select name="origin">
          <option value="">全部</option>
          ${ORIGIN_FILTERS.map((item) => {
            const label = item === "direct" ? "直接 WhatsApp" : ORIGIN_LABEL[item];
            return `<option value="${item}" ${origin === item ? "selected" : ""}>${label}</option>`;
          }).join("")}
        </select>
      </label>
      <label>28car 路徑
        <select name="entry">
          <option value="">全部</option>
          <option value="28car_board" ${entry === "28car_board" ? "selected" : ""}>留言板（網頁留言區）</option>
          <option value="28car_wa_link" ${entry === "28car_wa_link" ? "selected" : ""}>留言區 WhatsApp 連結</option>
        </select>
      </label>
      <label>狀態
        <select name="status">
          <option value="">全部</option>
          <option value="pending" ${st === "pending" ? "selected" : ""}>擱置／未處理</option>
          <option value="open" ${st === "open" ? "selected" : ""}>未處理</option>
          <option value="in_progress" ${st === "in_progress" ? "selected" : ""}>處理中</option>
          <option value="done" ${st === "done" ? "selected" : ""}>已完成</option>
        </select>
      </label>
      ${
        viewer.isAdmin
          ? `<label class="check">
        <input type="checkbox" name="mine" value="1" ${mine ? "checked" : ""} /> 只睇我嘅
      </label>`
          : ""
      }
      <button type="submit" class="btn">篩選</button>
      <a class="btn ghost" href="/">重設</a>
    </form>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th><th>來源／形式</th><th>留言者</th><th>內容</th><th>車輛</th><th>狀態</th><th>時間（HKT）</th><th>負責人</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${
            rows ||
            `<tr><td colspan="9" class="empty">${
              q
                ? `搵唔到同「${escapeHtml(q)}」相符嘅留言。試下其他字，或者 <a href="/">重設</a>。`
                : "暫無留言"
            }</td></tr>`
          }
        </tbody>
      </table>
    </div>
    <p class="muted small">搜尋會搵你睇到嘅留言同回覆：留言者、電話、內容、車輛、來源，以及 Facebook／Instagram 帖文編號、連結同內容。可以同上面嘅篩選一齊用。</p>
    <p class="muted small">同一個留言者未完成（未處理或處理中）嘅新訊息會併入最早嗰個 ID。狀態係已完成之後，下一則先至開新 ID。</p>
    <p class="muted small">時間欄同留言詳情嘅建立、更新、回覆時間都係香港時間（HKT，UTC+8）。「剛剛」「分鐘前」「昨天」按香港日曆計。資料庫仍然儲存 UTC。</p>
    <p class="muted small">「網站留言」＝客戶喺 28car、東榮官網或 Facebook 留低。「IG 留言」＝客戶喺東榮 Instagram 留言或私訊。「WhatsApp 聯絡」＝用 WhatsApp 搵我哋；撳過網站或 IG 簡介連結會再標「來自…」。「email 留言」＝公司郵箱 gloriousinformation@gmail.com 入面、同車有關嘅信，畫面會寫「這是email的留言」。Instagram 簡介去 glorious.hk?utm_source=ig 再入 WhatsApp，算東榮 IG，唔算官網。每條留言只展開「回覆」。回覆客戶、公司 WhatsApp、同事 WhatsApp 收喺「更多」。「回覆客戶」會打開你而家登入嘅 WhatsApp 發畀客戶。公司「WhatsApp」同「同事 WhatsApp」係聯絡總機或負責人，唔係發畀客戶。改狀態同改派喺留言頁嘅「更多」。</p>
    <p class="muted small">快捷：${
      viewer.isAdmin ? `<a href="${qs({ mine: "1" })}">我的留言</a> · ` : ""
    }<a href="${qs({ status: "pending", mine: "" })}">擱置／未處理</a> ·
      <a href="${qs({ status: "open", mine: "" })}">只睇未處理</a> ·
      <a href="${qs({ intake: "whatsapp_click", origin: "instagram", status: "" })}">來自東榮 IG 的 WhatsApp</a></p>
  `;

  res.send(
    layout({
      title: "留言箱",
      body,
      user: sessionUser(req),
      active: "inbox",
      liveCursor: latestId,
      liveReplyCursor: latestReplyId,
    })
  );
});

function commentNotFound(req: Request, res: Response, id: string): void {
  res.status(404).send(
    layout({
      title: "找不到",
      body: `<p>找不到留言 #${escapeHtml(id)}</p><a href="/">返回</a>`,
      user: sessionUser(req),
    })
  );
}

function reassignedNotice(req: Request, res: Response): void {
  res.status(403).send(
    layout({
      title: "未能發送",
      body: `<p class="error">${escapeHtml(REASSIGNED_MESSAGE)}</p><p><a href="/">返回留言箱</a></p>`,
      user: sessionUser(req),
    })
  );
}

pagesRouter.get("/comments/:id", requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { comment: c, latestId, latestReplyId } = getCommentWithCursor(id);
  if (!c || !canViewComment(c, sessionViewer(req))) {
    commentNotFound(req, res, String(req.params.id));
    return;
  }
  const staff = listStaff().filter((s) => s.active);
  const staffLines = activeStaffLinesByStaffId();
  const replies = listReplies(c.id);
  const media = listMediaForComment(c.id);
  const customerMedia = media.filter((item) => item.reply_id == null);
  const mediaByReply = new Map<number, MediaRecord[]>();
  for (const item of media) {
    if (item.reply_id == null) continue;
    const list = mediaByReply.get(item.reply_id) ?? [];
    list.push(item);
    mediaByReply.set(item.reply_id, list);
  }
  const error = typeof req.query.error === "string" ? req.query.error.slice(0, 500) : "";
  const sent = req.query.sent === "1";
  const deliveryQuery = typeof req.query.delivery === "string" ? req.query.delivery : "";
  const options = staff
    .map(
      (s) =>
        `<option value="${s.id}" ${c.assignee_staff_id === s.id ? "selected" : ""}>${escapeHtml(
          s.display_name
        )} (${escapeHtml(s.username)})</option>`
    )
    .join("");
  const assignBlock = req.session.isAdmin
    ? `<h2>改派同事</h2>
        <form method="POST" action="/comments/${c.id}/assign" class="inline-form">
          <select name="staff_id">
            <option value="">— 未派 —</option>
            ${options}
          </select>
          <button type="submit" class="btn">改派</button>
        </form>`
    : `<p class="muted small">改派只限管理員。</p>`;
  const originText =
    c.intake_kind === "whatsapp_click"
      ? c.origin_site
        ? `來自${ORIGIN_LABEL[c.origin_site]}`
        : "直接 WhatsApp（冇經網站或 IG）"
      : "—";
  const thread = replies
    .map((reply) => {
      const inbound = reply.direction === "inbound";
      const who = inbound ? `客戶 · ${c.author_name}` : `同事 · ${reply.staff_name || "同事"}`;
      const errorLine =
        !inbound && reply.delivery_error ? `<p class="error small">${escapeHtml(reply.delivery_error)}</p>` : "";
      const replyMedia = mediaByReply.get(reply.id) ?? [];
      const showBody = reply.body && !(replyMedia.length && isPlaceholderBody(reply.body));
      const delivery = inbound ? "" : ` · ${escapeHtml(deliveryDetail(reply.delivery_status, c.source))}`;
      const emailNote = isEmailChannel(c) ? `${EMAIL_LEAVE_NOTE} · ` : "";
      return `<article class="bubble ${inbound ? "customer" : "staff"}">
        <div class="who">${emailNote}${escapeHtml(who)} · ${showTime(reply.created_at)}${delivery}</div>
        ${errorLine}
        ${showBody ? `<div class="bubble-body">${linkifyMessageHtml(reply.body)}</div>` : ""}
        ${renderMediaBlocks(replyMedia)}
      </article>`;
    })
    .join("");

  const body = `
    <p><a href="/">← 返回留言箱</a></p>
    <article class="detail">
      <div class="page-head">
        <h1>留言 #${c.id}</h1>
        ${renderSourceBadges(c)}
        <span class="badge status-${c.status}">${STATUS_LABEL[c.status]}</span>
      </div>
      <p class="muted small">${
        isEmailChannel(c)
          ? `${EMAIL_LEAVE_NOTE}。下面「發送回覆」會由 ${escapeHtml(companyEmailAddress())} 以電郵回覆 ${escapeHtml(c.email_from || "客戶")}，並且盡量留喺同一封電郵對話。如果原本係未處理，會改做處理中，仍然留喺擱置／未處理。`
          : c.source === "whatsapp"
          ? `公司 WhatsApp 總機（有客戶號碼）會經 Cloud API 用 ${COMPANY_WHATSAPP_PHONE} 發送：成功標「已經 WhatsApp 發送」，失敗會寫低原因。客人用 WhatsApp 搵同事時，用「用我嘅 WhatsApp 發送畀客戶」打開你已綁定嘅個人 WhatsApp。相片、影片同語音可以喺下面播放同發送。如果原本係未處理，系統內回覆會改做處理中，並且繼續出現喺「擱置／未處理」。`
          : "主要喺下面回覆。公司 WhatsApp 總機（有客戶號碼）會經 Cloud API 發送：成功標「已經 WhatsApp 發送」，失敗會寫低原因。Facebook、Instagram 有 Page token 就經 Graph 發送。如果原本係未處理，會改做處理中，並且繼續出現喺「擱置／未處理」。"
      }</p>
      <dl class="meta">
        <dt>形式</dt><dd>${escapeHtml(intakeBadgeText(c.intake_kind, c.source))}</dd>
        <dt>相關網站</dt><dd>${escapeHtml(originText)}</dd>
        <dt>留言者</dt><dd>${escapeHtml(c.author_name)}</dd>
        ${
          isEmailChannel(c)
            ? `<dt>客戶電郵</dt><dd>${escapeHtml(c.email_from || "—")}</dd>
        <dt>電郵主旨</dt><dd>${escapeHtml(c.email_subject || "—")}</dd>
        <dt>說明</dt><dd>${EMAIL_LEAVE_NOTE}</dd>`
            : ""
        }
        <dt>外部 ID</dt><dd><code>${escapeHtml(c.external_id)}</code></dd>
        <dt>路徑</dt><dd>${c.entry_path ? escapeHtml(ENTRY_LABEL[c.entry_path]) : "—"}</dd>
        <dt>車輛</dt><dd>${c.vehicle_ref ? escapeHtml(c.vehicle_ref) : "—"}</dd>
        <dt>負責人</dt><dd>${c.assignee_name ? escapeHtml(c.assignee_name) : "未派"}</dd>
        <dt>建立</dt><dd>${showTime(c.created_at)}</dd>
        <dt>更新</dt><dd>${showTime(c.updated_at)}</dd>
      </dl>

      ${renderParentPost(c)}

      <section class="thread" id="thread">
        <h2>對話</h2>
        <article class="bubble customer">
          <div class="who">${isEmailChannel(c) ? `${EMAIL_LEAVE_NOTE} · ` : ""}客戶 · ${escapeHtml(c.author_name)} · ${showTime(c.created_at)}</div>
          ${
            customerMedia.length && isPlaceholderBody(c.body)
              ? ""
              : `<div class="bubble-body">${linkifyMessageHtml(c.body)}</div>`
          }
          ${renderMediaBlocks(customerMedia)}
        </article>
        ${thread || `<p class="muted small">未有同事回覆。</p>`}
      </section>

      <section class="reply-panel" id="reply">
        <h2>在系統內回覆</h2>
        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
        ${
          sent
            ? `<p class="notice">${escapeHtml(
                deliveryQuery === "sent" && isEmailChannel(c)
                  ? `已由 ${companyEmailAddress()} 以電郵回覆客戶。${EMAIL_LEAVE_NOTE}。未處理嘅留言會改做處理中，仍然留喺擱置／未處理。`
                  : deliveryQuery === "sent" && c.source === "whatsapp"
                  ? "已透過 WhatsApp 發送畀客戶。未處理嘅留言會改做處理中，仍然留喺擱置／未處理。"
                  : deliveryQuery === "stub" && c.source === "whatsapp"
                    ? "已儲存喺收件箱。同事個人 WhatsApp 唔經公司 Cloud API 代發。請用「用我嘅 WhatsApp」打開對話，喺你自己嘅 WhatsApp 發送。"
                    : deliveryQuery === "sent" && c.source === "28car"
                    ? "已送到 28car 留言板。未處理嘅留言會改做處理中，仍然留喺擱置／未處理。"
                    : deliveryQuery === "stored" && c.source === "28car"
                      ? "回覆已排入 28car 留言板隊列，未發送。未處理嘅留言會改做處理中，仍然留喺擱置／未處理。"
                      : "已儲存回覆，並標為示範待發送。未處理嘅留言會改做處理中，仍然留喺擱置／未處理。"
              )}</p>`
            : ""
        }
        ${
          c.source === "28car"
            ? `<p class="muted small">28car 留言板回覆會排入隊列。要代發到公開留言區，伺服器須開啟回覆旗標、可輪換代理，而且車盤要有 vid。每次發送用一個新 IP：登入、讀取 sell_dsp 的 h_t／h_k、再 POST form1（h_mode=add、h_type=o）。</p>`
            : ""
        }
        <form method="POST" action="/comments/${c.id}/replies" class="reply-form">
          <label>回覆內容
            <textarea name="body" required maxlength="4000" rows="5" placeholder="${
              isEmailChannel(c) ? "輸入回覆。這是email的留言，會以電郵發送畀客戶。" : "輸入回覆。客戶唔使你開 WhatsApp 網頁。"
            }"></textarea>
          </label>
          <button type="submit" class="btn primary">發送回覆</button>
        </form>
      </section>

      ${collapsedMore(
        `${renderStaffWhatsAppPanel(c, req.session.staffId ?? 0)}
      <section class="reply-panel" id="staff-media" data-comment-id="${c.id}">
        <h2>傳送相片、影片或語音</h2>
        <p class="muted small">${escapeHtml(mediaComposerHint(c))}</p>
        <p class="media-status" id="staff-media-status" role="status"></p>
        <label>說明（可選。相片同影片會一併發給支援嘅渠道；語音說明只顯示喺收件箱）
          <input id="staff-media-caption" type="text" maxlength="1000" placeholder="可留空">
        </label>
        <div class="wa-actions">
          <label class="btn">上傳相片、影片或語音
            <input id="staff-media-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/3gpp,audio/ogg,audio/mpeg,audio/mp4,audio/aac,audio/webm,audio/*" hidden>
          </label>
          <button type="button" class="btn" id="staff-media-record">錄製語音</button>
          <button type="button" class="btn primary" id="staff-media-send" disabled>發送媒體</button>
        </div>
      </section>
      <section class="secondary-box">
        <h2>次要：聯絡公司或負責人</h2>
        <p class="muted small">${
          c.source === "whatsapp"
            ? "呢度係開公司總機或負責人個人號，並預填內部備註，唔係發畀客戶。發畀客戶請用「用我嘅 WhatsApp 發送畀客戶」。公司總機回覆請用「發送回覆」。"
            : "如果要喺 WhatsApp 網頁同公司或負責人傾，可以開新分頁。主要回覆請用上面個表格。"
        }</p>
        ${whatsAppLinks(c, staffLines)}
      </section>
      <section class="actions">
        <h2>更新狀態</h2>
        <form method="POST" action="/comments/${c.id}/status" class="inline-form">
          <select name="status">
            <option value="open" ${c.status === "open" ? "selected" : ""}>未處理</option>
            <option value="in_progress" ${c.status === "in_progress" ? "selected" : ""}>處理中</option>
            <option value="done" ${c.status === "done" ? "selected" : ""}>已完成</option>
          </select>
          <button type="submit" class="btn">儲存狀態</button>
        </form>
        ${assignBlock}
      </section>`,
        "more-actions page-more"
      )}
    </article>
  `;

  res.send(
    layout({
      title: `留言 #${c.id}`,
      body,
      user: sessionUser(req),
      active: "inbox",
      liveCursor: latestId,
      liveReplyCursor: latestReplyId,
    })
  );
});

pagesRouter.post("/comments/:id/replies", requireAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const viewer = sessionViewer(req);
  if (!Number.isInteger(id)) {
    commentNotFound(req, res, String(req.params.id));
    return;
  }
  try {
    const result = await createStaffReply({
      commentId: id,
      staffId: req.session.staffId!,
      body: typeof req.body?.body === "string" ? req.body.body : "",
      viewer,
    });
    if (!result.ok) {
      if (result.status === 404) {
        commentNotFound(req, res, String(req.params.id));
        return;
      }
      if (result.status === 403 && result.error === REASSIGNED_MESSAGE) {
        reassignedNotice(req, res);
        return;
      }
      res.redirect(`/comments/${id}?error=${encodeURIComponent(result.error)}#reply`);
      return;
    }
    if (result.reply.delivery_status === "failed") {
      const message = result.reply.delivery_error || "發送失敗";
      res.redirect(`/comments/${id}?error=${encodeURIComponent(message)}#reply`);
      return;
    }
    res.redirect(`/comments/${id}?sent=1&delivery=${encodeURIComponent(result.reply.delivery_status)}#thread`);
  } catch (err) {
    console.error("[replies] 未能寫入回覆", err);
    res.redirect(`/comments/${id}?error=${encodeURIComponent("未能發送回覆")}#reply`);
  }
});

pagesRouter.post("/comments/:id/status", requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const comment = getComment(id);
  if (!comment || !canViewComment(comment, sessionViewer(req))) {
    commentNotFound(req, res, String(req.params.id));
    return;
  }
  const status = req.body?.status;
  if (isCommentStatus(status)) {
    const conflict = blockingOpenThreadId(id, status);
    if (conflict) {
      const message = `呢位留言者已有未完成對話 #${conflict}。狀態係已完成先至可以再開一條。`;
      res.redirect(`/comments/${id}?error=${encodeURIComponent(message)}`);
      return;
    }
    const updated = updateStatus(id, status, sessionViewer(req));
    if (!updated) {
      if (!getComment(id)) {
        commentNotFound(req, res, String(req.params.id));
        return;
      }
      reassignedNotice(req, res);
      return;
    }
  }
  res.redirect(`/comments/${id}`);
});

pagesRouter.post("/comments/:id/assign", requireAuth, (req: Request, res: Response) => {
  if (!req.session.isAdmin) {
    res.status(403).send(
      layout({
        title: "沒有權限",
        body: `<p>改派只限管理員。</p><p><a href="/">返回留言箱</a></p>`,
        user: sessionUser(req),
      })
    );
    return;
  }
  const id = Number(req.params.id);
  if (!getComment(id)) {
    commentNotFound(req, res, String(req.params.id));
    return;
  }
  const raw = req.body?.staff_id;
  const staffId = raw === "" || raw == null ? null : Number(raw);
  reassign(id, Number.isNaN(staffId as number) ? null : staffId);
  res.redirect(`/comments/${id}`);
});

pagesRouter.get("/staff", requireAuth, (req: Request, res: Response) => {
  const staff = listStaff();
  const staffLines = activeStaffLinesByStaffId();
  const rows = staff
    .map((s) => {
      const line = staffLines.get(s.id);
      const phone = line ? `${escapeHtml(formatPhoneE164(line.phone_e164))}（${escapeHtml(line.display_label)}）` : "—";
      return `<tr>
      <td>${s.id}</td>
      <td>${escapeHtml(s.display_name)}</td>
      <td><code>${escapeHtml(s.username)}</code></td>
      <td>${s.is_admin ? "管理員" : "同事"}</td>
      <td>${s.active ? "啟用" : "收藏"}</td>
      <td>${phone}</td>
    </tr>`;
    })
    .join("");

  const note = req.session.isAdmin
    ? `<p class="muted">你係管理員，可以睇全部留言（包括未派）同改派。<a href="/whatsapp-lines">管理 WhatsApp 線路</a></p>`
    : `<p class="muted">你只可以處理派咗畀你嘅留言。改派只限管理員。個人 WhatsApp 由管理員綁定。</p>`;

  const body = `
    <div class="page-head"><h1>同事名單</h1></div>
    ${note}
    <div class="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>姓名</th><th>帳號</th><th>角色</th><th>狀態</th><th>個人 WhatsApp</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  res.send(
    layout({
      title: "同事",
      body,
      user: sessionUser(req),
      active: "staff",
    })
  );
});

pagesRouter.get("/whatsapp-lines", requireAuth, (req: Request, res: Response) => {
  if (!requirePageAdmin(req, res)) return;
  const lines = listWhatsAppLines();
  const boundStaff = new Set(
    lines.filter((line) => line.is_active && line.kind === "staff" && line.staff_id != null).map((line) => line.staff_id)
  );
  const choices = listStaff().filter((s) => s.active && !boundStaff.has(s.id));
  const staffOptions = choices
    .map((s) => `<option value="${s.id}">${escapeHtml(s.display_name)} (${escapeHtml(s.username)})</option>`)
    .join("");
  const error = typeof req.query.error === "string" ? req.query.error.slice(0, 200) : "";
  const ok = typeof req.query.ok === "string" ? req.query.ok.slice(0, 200) : "";

  const rows = lines
    .map((line) => {
      const who =
        line.kind === "staff"
          ? line.staff_display_name
            ? `${escapeHtml(line.staff_display_name)}（${escapeHtml(line.staff_username || "")}）`
            : "—"
          : "—";
      const action = line.is_active
        ? `<form method="POST" action="/whatsapp-lines/${line.id}/deactivate" onsubmit="return confirm('停用呢條線路？之後打去呢個號碼唔會再按原規則自動派單。');">
            <button type="submit" class="btn">停用</button>
          </form>`
        : `<span class="muted">已停用</span>`;
      return `<tr>
        <td><code>${escapeHtml(formatPhoneE164(line.phone_e164))}</code></td>
        <td>${escapeHtml(line.display_label)}</td>
        <td><span class="badge kind-${line.kind}">${line.kind === "company" ? "公司總機" : "同事個人"}</span></td>
        <td>${who}</td>
        <td>${line.is_active ? "啟用" : "停用"}</td>
        <td>${action}</td>
      </tr>`;
    })
    .join("");

  const form = choices.length
    ? `<form class="filters" method="POST" action="/whatsapp-lines">
        <label>同事
          <select name="staff_id" required>${staffOptions}</select>
        </label>
        <label>WhatsApp 號碼
          <input name="phone" required inputmode="tel" placeholder="85291234567" autocomplete="off" />
        </label>
        <label>顯示名稱（可選）
          <input name="display_label" maxlength="80" placeholder="例如 Wing Cheng WhatsApp" />
        </label>
        <button type="submit" class="btn primary">綁定</button>
      </form>`
    : `<p class="muted">所有在職同事都已經有啟用中嘅個人線路。</p>`;

  const body = `
    <div class="page-head"><h1>WhatsApp 線路</h1></div>
    <p class="muted">客戶打去<strong>同事個人號</strong>會自動派畀該同事。打去<strong>公司總機 85221740001</strong>就按固定輪流：Eddie → Wing → Jason → 其餘在職同事（按 staff id，排喺 Jason 後面）。每次新對話派畀上一位之後嗰位，唔會計未完成（open + in_progress）幾多。Tony、Benjamin、Vivian、Ken 唔參與自動派單。未知號碼會入庫但未派。真實 Meta／Glorious 連接尚未啟用。</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    ${ok ? `<p class="notice">${escapeHtml(ok)}</p>` : ""}
    <h2>綁定同事個人號碼</h2>
    ${form}
    <div class="table-wrap">
      <table>
        <thead><tr><th>號碼</th><th>名稱</th><th>類型</th><th>同事</th><th>狀態</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6" class="empty">尚未有線路</td></tr>`}</tbody>
      </table>
    </div>
  `;

  res.send(
    layout({
      title: "WhatsApp 線路",
      body,
      user: sessionUser(req),
      active: "whatsapp",
    })
  );
});

pagesRouter.post("/whatsapp-lines", requireAuth, (req: Request, res: Response) => {
  if (!requirePageAdmin(req, res)) return;
  const staffId = Number(req.body?.staff_id);
  const result = addStaffWhatsAppLine({
    staffId,
    phone: String(req.body?.phone ?? ""),
    displayLabel: String(req.body?.display_label ?? ""),
  });
  if (!result.ok) {
    res.redirect(`/whatsapp-lines?error=${encodeURIComponent(result.error)}`);
    return;
  }
  res.redirect(`/whatsapp-lines?ok=${encodeURIComponent("已綁定同事線路")}`);
});

pagesRouter.post("/whatsapp-lines/:id/deactivate", requireAuth, (req: Request, res: Response) => {
  if (!requirePageAdmin(req, res)) return;
  const result = deactivateWhatsAppLine(Number(req.params.id));
  if (!result.ok) {
    res.redirect(`/whatsapp-lines?error=${encodeURIComponent(result.error)}`);
    return;
  }
  res.redirect(`/whatsapp-lines?ok=${encodeURIComponent("已停用線路")}`);
});

registerTwentyeightcarPages(pagesRouter, { layout, escapeHtml, sessionUser });

export { SOURCE_LABEL, STATUS_LABEL };
