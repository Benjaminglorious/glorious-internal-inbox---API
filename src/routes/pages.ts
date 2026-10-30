import { Router, Request, Response } from "express";
import { PASSWORD_CHANGED_MESSAGE, PASSWORD_CHANGE_ERRORS, changeOwnPassword } from "../auth/change-password";
import { requireAuth, sessionViewer } from "../auth/middleware";
import { verifyPassword } from "../auth/passwords";
import { companyWhatsAppChatUrl, whatsAppSendUrl } from "../config";
import {
  DELIVERY_LABEL,
  ORIGIN_LABEL,
  SOURCE_LABEL,
  STATUS_LABEL,
  deliveryDetail,
  intakeBadgeText,
  intakeSummary,
} from "../labels";
import {
  canViewComment,
  getComment,
  getCommentWithCursor,
  listCommentsWithCursor,
  listStaff,
  findStaffByUsername,
  updateStatus,
  reassign,
} from "../services/comments";
import { createStaffReply, listReplies } from "../services/replies";
import {
  activeStaffLinesByStaffId,
  addStaffWhatsAppLine,
  deactivateWhatsAppLine,
  formatPhoneE164,
  listWhatsAppLines,
} from "../services/whatsapp";
import {
  COMMENT_SOURCES,
  ORIGIN_FILTERS,
  isCommentSource,
  isCommentStatus,
  isCommentStatusFilter,
  isIntakeKind,
  isOriginFilter,
  type CommentWithAssignee,
  type IntakeKind,
  type OriginFilter,
  type WhatsAppLine,
} from "../types";

export const pagesRouter = Router();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function renderSourceBadges(c: Pick<CommentWithAssignee, "source" | "intake_kind" | "origin_site">): string {
  const origin =
    c.intake_kind === "whatsapp_click"
      ? c.origin_site
        ? `<span class="badge origin">來自${escapeHtml(ORIGIN_LABEL[c.origin_site])}</span>`
        : `<span class="badge origin direct">直接 WhatsApp</span>`
      : "";
  return `<div class="badge-stack">
    <span class="badge source-${c.source}">${escapeHtml(SOURCE_LABEL[c.source] || c.source)}</span>
    <span class="badge intake-${c.intake_kind}">${escapeHtml(intakeBadgeText(c.intake_kind, c.source))}</span>
    ${origin}
  </div>`;
}

function replyPreview(c: CommentWithAssignee): string {
  if (!c.reply_count || !c.last_reply_body) {
    return `<div class="reply-preview none">未有同事回覆</div>`;
  }
  const who = c.last_reply_staff_name || "同事";
  const delivery = c.last_reply_delivery_status ? DELIVERY_LABEL[c.last_reply_delivery_status] : "";
  const flat = c.last_reply_body.replace(/\s+/g, " ").trim();
  const text = flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
  const count = c.reply_count > 1 ? `（${c.reply_count}）` : "";
  return `<div class="reply-preview">最新回覆${count} · ${escapeHtml(who)} · ${escapeHtml(delivery)}：${escapeHtml(text)}</div>`;
}

function layout(opts: {
  title: string;
  body: string;
  user?: { displayName: string; isAdmin?: boolean };
  active?: string;
  /** 有呢個數字先至喺留言箱／詳情輪詢新留言。0 代表暫時未有留言。 */
  liveCursor?: number;
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
      ? `<div id="inbox-live" data-latest-id="${opts.liveCursor}" hidden></div>`
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
  const mine = req.query.mine === "1";
  const src = sourceRaw && isCommentSource(sourceRaw) ? sourceRaw : undefined;
  const st = statusRaw && isCommentStatusFilter(statusRaw) ? statusRaw : undefined;
  const intake: IntakeKind | undefined = intakeRaw && isIntakeKind(intakeRaw) ? intakeRaw : undefined;
  const origin: OriginFilter | undefined = originRaw && isOriginFilter(originRaw) ? originRaw : undefined;

  const viewer = sessionViewer(req);
  const { comments, latestId } = listCommentsWithCursor({
    source: src,
    status: st,
    intake,
    origin,
    mine: viewer.isAdmin && mine,
    staffId: req.session.staffId,
    viewer,
  });
  const staffLines = activeStaffLinesByStaffId();

  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (src) p.set("source", src);
    if (st) p.set("status", st);
    if (intake) p.set("intake", intake);
    if (origin) p.set("origin", origin);
    if (mine) p.set("mine", "1");
    for (const [k, v] of Object.entries(extra)) {
      if (v === "") p.delete(k);
      else p.set(k, v);
    }
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  const rows = comments
    .map((c) => {
      const preview = c.body.length > 80 ? c.body.slice(0, 80) + "…" : c.body;
      return `<tr>
        <td><a href="/comments/${c.id}">#${c.id}</a></td>
        <td>${renderSourceBadges(c)}</td>
        <td>${escapeHtml(c.author_name)}</td>
        <td class="preview">${escapeHtml(preview)}${replyPreview(c)}</td>
        <td>${c.vehicle_ref ? escapeHtml(c.vehicle_ref) : "—"}</td>
        <td><span class="badge status-${c.status}">${STATUS_LABEL[c.status]}</span></td>
        <td>${c.assignee_name ? escapeHtml(c.assignee_name) : "未派"}</td>
        <td class="actions-cell"><a class="btn primary" href="/comments/${c.id}#reply">回覆</a>${whatsAppLinks(c, staffLines)}</td>
      </tr>`;
    })
    .join("");

  const body = `
    <div class="page-head">
      <h1>留言箱</h1>
      <p class="muted">共 ${comments.length} 條</p>
    </div>
    ${
      viewer.isAdmin
        ? ""
        : `<p class="muted">你只會見到派咗畀你嘅留言。未派同其他同事嘅留言只係管理員睇到。</p>`
    }
    <form class="filters" method="GET" action="/">
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
            <th>ID</th><th>來源／形式</th><th>留言者</th><th>內容</th><th>車輛</th><th>狀態</th><th>負責人</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="8" class="empty">暫無留言</td></tr>`}
        </tbody>
      </table>
    </div>
    <p class="muted small">「網站留言」＝客戶喺 28car、東榮官網或 Facebook 留低。「IG 留言」＝客戶喺東榮 Instagram 留言或私訊。「WhatsApp 聯絡」＝用 WhatsApp 搵我哋；撳過網站或 IG 簡介連結會再標「來自…」。Instagram 簡介去 glorious.hk?utm_source=ig 再入 WhatsApp，算東榮 IG，唔算官網。回覆請入去留言，WhatsApp 按鈕只係次要。</p>
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

pagesRouter.get("/comments/:id", requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { comment: c, latestId } = getCommentWithCursor(id);
  if (!c || !canViewComment(c, sessionViewer(req))) {
    commentNotFound(req, res, String(req.params.id));
    return;
  }
  const staff = listStaff().filter((s) => s.active);
  const staffLines = activeStaffLinesByStaffId();
  const replies = listReplies(c.id);
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
      const who = reply.staff_name || "同事";
      const errorLine = reply.delivery_error
        ? `<p class="error small">${escapeHtml(reply.delivery_error)}</p>`
        : "";
      return `<article class="bubble staff">
        <div class="who">同事 · ${escapeHtml(who)} · ${escapeHtml(reply.created_at)} · ${escapeHtml(deliveryDetail(reply.delivery_status, c.source))}</div>
        ${errorLine}
        <div class="bubble-body">${escapeHtml(reply.body)}</div>
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
      <p class="muted small">主要喺下面回覆。公司 WhatsApp 總機（有客戶號碼）會經 Cloud API 發送：成功標「已經 WhatsApp 發送」，失敗會寫低原因。同事個人線路、網站同 IG 留言仍然只係示範待發送。如果原本係未處理，會改做處理中，並且繼續出現喺「擱置／未處理」。</p>
      <dl class="meta">
        <dt>形式</dt><dd>${escapeHtml(intakeBadgeText(c.intake_kind, c.source))}</dd>
        <dt>相關網站</dt><dd>${escapeHtml(originText)}</dd>
        <dt>留言者</dt><dd>${escapeHtml(c.author_name)}</dd>
        <dt>外部 ID</dt><dd><code>${escapeHtml(c.external_id)}</code></dd>
        <dt>車輛</dt><dd>${c.vehicle_ref ? escapeHtml(c.vehicle_ref) : "—"}</dd>
        <dt>負責人</dt><dd>${c.assignee_name ? escapeHtml(c.assignee_name) : "未派"}</dd>
        <dt>建立</dt><dd>${escapeHtml(c.created_at)}</dd>
        <dt>更新</dt><dd>${escapeHtml(c.updated_at)}</dd>
      </dl>

      <section class="thread" id="thread">
        <h2>對話</h2>
        <article class="bubble customer">
          <div class="who">客戶 · ${escapeHtml(c.author_name)} · ${escapeHtml(c.created_at)}</div>
          <div class="bubble-body">${escapeHtml(c.body)}</div>
        </article>
        ${thread || `<p class="muted small">未有同事回覆。</p>`}
      </section>

      <section class="reply-panel" id="reply">
        <h2>在系統內回覆</h2>
        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
        ${
          sent
            ? `<p class="notice">${escapeHtml(
                deliveryQuery === "sent"
                  ? "已透過 WhatsApp 發送畀客戶。未處理嘅留言會改做處理中，仍然留喺擱置／未處理。"
                  : "已儲存回覆，並標為示範待發送。未處理嘅留言會改做處理中，仍然留喺擱置／未處理。"
              )}</p>`
            : ""
        }
        <form method="POST" action="/comments/${c.id}/replies" class="reply-form">
          <label>回覆內容
            <textarea name="body" required maxlength="4000" rows="5" placeholder="輸入回覆。客戶唔使你開 WhatsApp 網頁。"></textarea>
          </label>
          <button type="submit" class="btn primary">發送回覆</button>
        </form>
      </section>

      <section class="secondary-box">
        <h2>次要：開 WhatsApp 網頁</h2>
        <p class="muted small">如果要喺 WhatsApp 網頁睇對話，可以開新分頁。主要回覆請用上面個表格。真實 Meta／Glorious 連接尚未啟用，呢度唔會代你發送。</p>
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
      </section>
    </article>
  `;

  res.send(
    layout({
      title: `留言 #${c.id}`,
      body,
      user: sessionUser(req),
      active: "inbox",
      liveCursor: latestId,
    })
  );
});

pagesRouter.post("/comments/:id/replies", requireAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const viewer = sessionViewer(req);
  const existing = getComment(id);
  if (!existing || !canViewComment(existing, viewer)) {
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
    updateStatus(id, status);
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
    <p class="muted">客戶打去<strong>同事個人號</strong>會自動派畀該同事。打去<strong>公司總機 85221740001</strong>就用現有規則：未完成（open + in_progress）最少嘅在職同事，同數則 Eddie → Wing → Jason → 其餘在職同事（按 staff id，排喺 Jason 後面）。未知號碼會入庫但未派。真實 Meta／Glorious 連接尚未啟用。</p>
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

export { SOURCE_LABEL, STATUS_LABEL };
