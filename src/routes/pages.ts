import { Router, Request, Response } from "express";
import { requireAuth } from "../auth/middleware";
import { verifyPassword } from "../auth/passwords";
import { companyWhatsAppChatUrl } from "../config";
import {
  getComment,
  listComments,
  listStaff,
  findStaffByUsername,
  updateStatus,
  reassign,
} from "../services/comments";
import type { CommentSource, CommentStatus, CommentWithAssignee } from "../types";

export const pagesRouter = Router();

const SOURCE_LABEL: Record<string, string> = {
  "28car": "28car",
  glorious_web: "東榮官網",
  facebook: "Facebook",
};

const STATUS_LABEL: Record<string, string> = {
  open: "未處理",
  in_progress: "處理中",
  done: "已完成",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function whatsAppLink(c: Pick<CommentWithAssignee, "source" | "vehicle_ref" | "body">): string {
  const href = companyWhatsAppChatUrl({
    sourceLabel: SOURCE_LABEL[c.source] || c.source,
    vehicleRef: c.vehicle_ref,
    body: c.body,
  });
  return `<a class="btn whatsapp" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>`;
}

function layout(opts: {
  title: string;
  body: string;
  user?: { displayName: string; isAdmin?: boolean };
  active?: string;
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
      </nav>
      <div class="userbox">
        <span>${escapeHtml(opts.user.displayName)}${opts.user.isAdmin ? " · 管理員" : ""}</span>
        <form method="POST" action="/logout" style="display:inline">
          <button type="submit" class="btn ghost">登出</button>
        </form>
      </div>
    </header>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)} · 東榮內部留言</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  ${nav}
  <main class="container">
    ${opts.body}
  </main>
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
      <p class="muted">僅供公司同事登入處理 28car／官網／Facebook 留言</p>
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

pagesRouter.post("/logout", (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/login");
  });
});

pagesRouter.get("/", requireAuth, (req: Request, res: Response) => {
  const source = (req.query.source as CommentSource | undefined) || undefined;
  const status = (req.query.status as CommentStatus | undefined) || undefined;
  const mine = req.query.mine === "1";
  const validSources = ["28car", "glorious_web", "facebook"];
  const validStatuses = ["open", "in_progress", "done"];
  const src = source && validSources.includes(source) ? source : undefined;
  const st = status && validStatuses.includes(status) ? status : undefined;

  const comments = listComments({
    source: src,
    status: st,
    mine,
    staffId: req.session.staffId,
  });

  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (src) p.set("source", src);
    if (st) p.set("status", st);
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
        <td><span class="badge source-${c.source}">${SOURCE_LABEL[c.source] || c.source}</span></td>
        <td>${escapeHtml(c.author_name)}</td>
        <td class="preview">${escapeHtml(preview)}</td>
        <td>${c.vehicle_ref ? escapeHtml(c.vehicle_ref) : "—"}</td>
        <td><span class="badge status-${c.status}">${STATUS_LABEL[c.status]}</span></td>
        <td>${c.assignee_name ? escapeHtml(c.assignee_name) : "未派"}</td>
        <td>${whatsAppLink(c)}</td>
      </tr>`;
    })
    .join("");

  const body = `
    <div class="page-head">
      <h1>留言箱</h1>
      <p class="muted">共 ${comments.length} 條</p>
    </div>
    <form class="filters" method="GET" action="/">
      <label>來源
        <select name="source">
          <option value="">全部</option>
          <option value="28car" ${src === "28car" ? "selected" : ""}>28car</option>
          <option value="glorious_web" ${src === "glorious_web" ? "selected" : ""}>東榮官網</option>
          <option value="facebook" ${src === "facebook" ? "selected" : ""}>Facebook</option>
        </select>
      </label>
      <label>狀態
        <select name="status">
          <option value="">全部</option>
          <option value="open" ${st === "open" ? "selected" : ""}>未處理</option>
          <option value="in_progress" ${st === "in_progress" ? "selected" : ""}>處理中</option>
          <option value="done" ${st === "done" ? "selected" : ""}>已完成</option>
        </select>
      </label>
      <label class="check">
        <input type="checkbox" name="mine" value="1" ${mine ? "checked" : ""} /> 只睇我嘅
      </label>
      <button type="submit" class="btn">篩選</button>
      <a class="btn ghost" href="/">重設</a>
    </form>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th><th>來源</th><th>留言者</th><th>內容</th><th>車輛</th><th>狀態</th><th>負責人</th><th>WhatsApp</th>
          </tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="8" class="empty">暫無留言</td></tr>`}
        </tbody>
      </table>
    </div>
    <p class="muted small">快捷：<a href="${qs({ mine: "1" })}">我的留言</a> ·
      <a href="${qs({ status: "open", mine: "" })}">全部未處理</a></p>
  `;

  res.send(
    layout({
      title: "留言箱",
      body,
      user: { displayName: req.session.displayName || "", isAdmin: req.session.isAdmin },
      active: "inbox",
    })
  );
});

pagesRouter.get("/comments/:id", requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const c = getComment(id);
  if (!c) {
    res.status(404).send(
      layout({
        title: "找不到",
        body: `<p>找不到留言 #${id}</p><a href="/">返回</a>`,
        user: { displayName: req.session.displayName || "", isAdmin: req.session.isAdmin },
      })
    );
    return;
  }
  const staff = listStaff().filter((s) => s.active);
  const options = staff
    .map(
      (s) =>
        `<option value="${s.id}" ${c.assignee_staff_id === s.id ? "selected" : ""}>${escapeHtml(
          s.display_name
        )} (${escapeHtml(s.username)})</option>`
    )
    .join("");

  const body = `
    <p><a href="/">← 返回留言箱</a></p>
    <article class="detail">
      <div class="page-head">
        <h1>留言 #${c.id}</h1>
        <span class="badge source-${c.source}">${SOURCE_LABEL[c.source]}</span>
        <span class="badge status-${c.status}">${STATUS_LABEL[c.status]}</span>
        ${whatsAppLink(c)}
      </div>
      <p class="muted small">WhatsApp 按鈕開新分頁去公司 click-to-chat（可預填來源、車輛同留言摘要）。入站對話尚未同步。</p>
      <dl class="meta">
        <dt>留言者</dt><dd>${escapeHtml(c.author_name)}</dd>
        <dt>外部 ID</dt><dd><code>${escapeHtml(c.external_id)}</code></dd>
        <dt>車輛</dt><dd>${c.vehicle_ref ? escapeHtml(c.vehicle_ref) : "—"}</dd>
        <dt>負責人</dt><dd>${c.assignee_name ? escapeHtml(c.assignee_name) : "未派"}</dd>
        <dt>建立</dt><dd>${escapeHtml(c.created_at)}</dd>
        <dt>更新</dt><dd>${escapeHtml(c.updated_at)}</dd>
      </dl>
      <div class="body-box">${escapeHtml(c.body)}</div>

      <section class="actions">
        <h2>更新狀態</h2>
        <form method="POST" action="/comments/${c.id}/status" class="inline-form">
          <select name="status">
            <option value="open" ${c.status === "open" ? "selected" : ""}>未處理</option>
            <option value="in_progress" ${c.status === "in_progress" ? "selected" : ""}>處理中</option>
            <option value="done" ${c.status === "done" ? "selected" : ""}>已完成</option>
          </select>
          <button type="submit" class="btn primary">儲存狀態</button>
        </form>

        <h2>改派同事</h2>
        <form method="POST" action="/comments/${c.id}/assign" class="inline-form">
          <select name="staff_id">
            <option value="">— 未派 —</option>
            ${options}
          </select>
          <button type="submit" class="btn">改派</button>
        </form>
      </section>
    </article>
  `;

  res.send(
    layout({
      title: `留言 #${c.id}`,
      body,
      user: { displayName: req.session.displayName || "", isAdmin: req.session.isAdmin },
      active: "inbox",
    })
  );
});

pagesRouter.post("/comments/:id/status", requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || "") as CommentStatus;
  if (["open", "in_progress", "done"].includes(status)) {
    updateStatus(id, status);
  }
  res.redirect(`/comments/${id}`);
});

pagesRouter.post("/comments/:id/assign", requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const raw = req.body?.staff_id;
  const staffId = raw === "" || raw == null ? null : Number(raw);
  reassign(id, Number.isNaN(staffId as number) ? null : staffId);
  res.redirect(`/comments/${id}`);
});

pagesRouter.get("/staff", requireAuth, (req: Request, res: Response) => {
  const staff = listStaff();
  const rows = staff
    .map(
      (s) => `<tr>
      <td>${s.id}</td>
      <td>${escapeHtml(s.display_name)}</td>
      <td><code>${escapeHtml(s.username)}</code></td>
      <td>${s.is_admin ? "管理員" : "同事"}</td>
      <td>${s.active ? "啟用" : "停用"}</td>
    </tr>`
    )
    .join("");

  const note = req.session.isAdmin
    ? "<p class=\"muted\">你係管理員，可睇到完整同事名單。</p>"
    : "<p class=\"muted\">改派留言時可選以下同事。</p>";

  const body = `
    <div class="page-head"><h1>同事名單</h1></div>
    ${note}
    <div class="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>姓名</th><th>帳號</th><th>角色</th><th>狀態</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  res.send(
    layout({
      title: "同事",
      body,
      user: { displayName: req.session.displayName || "", isAdmin: req.session.isAdmin },
      active: "staff",
    })
  );
});

export { SOURCE_LABEL, STATUS_LABEL };
