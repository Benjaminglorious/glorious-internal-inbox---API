import type { Request, Response, Router } from "express";
import { requireAuth } from "../auth/middleware";
import {
  flushHeldReplies,
  getListing,
  listListingMessages,
  listListings,
  listReplyQueue,
  syncStateForUi,
  syncTwentyeightcar,
} from "../services/twentyeightcar";

interface PageUser {
  displayName: string;
  isAdmin?: boolean;
}

interface PageHelpers {
  layout(opts: { title: string; body: string; user?: PageUser; active?: string }): string;
  escapeHtml(value: string): string;
  sessionUser(req: Request): PageUser;
}

function money(priceText: string | null, priceHkd: number | null): string {
  if (priceText) return priceText;
  if (priceHkd == null) return "—";
  return `$${priceHkd.toLocaleString("en-HK")}`;
}

export function registerTwentyeightcarPages(router: Router, view: PageHelpers): void {
  const { layout, escapeHtml, sessionUser } = view;

  router.get("/28car", requireAuth, (req: Request, res: Response) => {
    const user = sessionUser(req);
    const state = syncStateForUi();
    const account = typeof req.query.account === "string" ? req.query.account : undefined;
    const listings = listListings(account);
    const rows = listings
      .map((listing) => {
        const link = listing.public_url
          ? `<a href="${escapeHtml(listing.public_url)}" target="_blank" rel="noopener noreferrer">公開頁</a>`
          : "vid 未確認";
        return `<tr>
          <td><a href="/28car/${escapeHtml(listing.stock_id)}"><code>${escapeHtml(listing.stock_id)}</code></a></td>
          <td>${listing.vid ? `<code>${escapeHtml(listing.vid)}</code>` : "—"}</td>
          <td>${escapeHtml(listing.title)}</td>
          <td>${escapeHtml(money(listing.price_text, listing.price_hkd))}</td>
          <td>${escapeHtml(listing.listing_updated_at || "—")}</td>
          <td>${escapeHtml(listing.account_username)}</td>
          <td>${listing.comment_count ?? "—"}</td>
          <td>${listing.buyer_count} 買家 / ${listing.seller_count} 賣家</td>
          <td>${link}</td>
        </tr>`;
      })
      .join("");
    const accounts = state.status.usernames.length
      ? state.status.usernames.map((name) => `<code>${escapeHtml(name)}</code>`).join("、")
      : "未設定";
    const admin = user.isAdmin
      ? `<form method="POST" action="/28car/sync" style="display:inline">
           <button class="btn" type="submit">同步車盤同留言板</button>
         </form>
         <form method="POST" action="/28car/replies/flush" style="display:inline">
           <button class="btn" type="submit">發送已排隊回覆</button>
         </form>`
      : "";
    const notice = typeof req.query.ok === "string" ? `<p class="notice">${escapeHtml(req.query.ok.slice(0, 300))}</p>` : "";
    const error = typeof req.query.error === "string" ? `<p class="error">${escapeHtml(req.query.error.slice(0, 300))}</p>` : "";
    const queue = user.isAdmin
      ? `<h2>回覆隊列</h2>
         <div class="table-wrap"><table>
           <thead><tr><th>ID</th><th>車盤</th><th>vid</th><th>狀態</th><th>備註</th></tr></thead>
           <tbody>${
             listReplyQueue(12)
               .map(
                 (row) => `<tr>
                   <td>${row.id}</td>
                   <td>${row.stock_id ? escapeHtml(row.stock_id) : "—"}</td>
                   <td>${row.vid ? escapeHtml(row.vid) : "—"}</td>
                   <td>${escapeHtml(row.status)}</td>
                   <td>${row.last_error ? escapeHtml(row.last_error) : "—"}</td>
                 </tr>`
               )
               .join("") || `<tr><td colspan="5" class="empty">隊列是空的</td></tr>`
           }</tbody>
         </table></div>`
      : "";
    const body = `
      <div class="page-head"><h1>28car 車盤</h1><p class="muted">${listings.length} 個</p></div>
      <div class="warn-banner">
        同一 IP 連續登入多個車行帳號有機會被 28car 限制。每次登入、賣車列表、打開留言板、發送回覆都會換下一個代理。
        未設定可輪換代理之前，系統唔會直連 28car。而家：${state.status.egress_ready ? "代理已可輪換" : "代理未就緒"}，
        同步${state.status.sync_enabled ? "已開" : "關閉"}，回覆代發${state.status.reply_post_enabled ? "已開" : "關閉"}。
      </div>
      ${notice}${error}
      <p class="muted">已設定帳號（最多 10 個）：${accounts}。買家寫喺留言板嘅帖會出現喺<a href="/?source=28car&entry=28car_board">收件箱 · 28car 留言板</a>。撳留言區 WhatsApp 連結入嚟嘅，係<a href="/?entry=28car_wa_link">28car 留言區 WhatsApp</a>。</p>
      ${admin}
      <div class="table-wrap">
        <table>
          <thead><tr><th>庫存編號</th><th>vid</th><th>車輛</th><th>售價</th><th>更新</th><th>帳號</th><th>留言欄</th><th>已入庫</th><th>連結</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="9" class="empty">未有車盤。可跑 npm run seed，或管理員喺設定代理同旗標之後同步。</td></tr>`}</tbody>
        </table>
      </div>
      ${queue}
    `;
    res.send(layout({ title: "28car 車盤", body, user, active: "28car" }));
  });

  router.get("/28car/:stockId", requireAuth, (req: Request, res: Response) => {
    const listing = getListing(String(req.params.stockId));
    if (!listing) {
      res.status(404).send(
        layout({
          title: "找不到車盤",
          body: `<p>找不到車盤。</p><p><a href="/28car">返回</a></p>`,
          user: sessionUser(req),
          active: "28car",
        })
      );
      return;
    }
    const messages = listListingMessages(listing.stock_id)
      .map((message) => {
        const kind = message.is_seller ? "賣家" : "買家";
        const inbox = message.inbox_comment_id
          ? `<a href="/comments/${message.inbox_comment_id}">收件箱 #${message.inbox_comment_id}</a>`
          : message.is_seller
            ? "賣家帖，唔當客戶查詢"
            : "—";
        return `<article class="bubble ${message.is_seller ? "staff" : "customer"}">
          <div class="who">${kind} · ${escapeHtml(message.author_name)}${message.posted_at ? ` · ${escapeHtml(message.posted_at)}` : ""} · ${inbox}</div>
          <div class="bubble-body">${escapeHtml(message.body)}</div>
        </article>`;
      })
      .join("");
    const publicLink = listing.public_url
      ? `<a href="${escapeHtml(listing.public_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(listing.public_url)}</a>`
      : "未有 vid，公開連結未建立";
    const body = `
      <p><a href="/28car">← 28car 車盤</a></p>
      <article class="detail">
        <div class="page-head"><h1>${escapeHtml(listing.title)}</h1></div>
        <dl class="meta">
          <dt>庫存編號</dt><dd><code>${escapeHtml(listing.stock_id)}</code></dd>
          <dt>vid</dt><dd>${listing.vid ? `<code>${escapeHtml(listing.vid)}</code>` : "—"}</dd>
          <dt>帳號</dt><dd>${escapeHtml(listing.account_username)}</dd>
          <dt>售價</dt><dd>${escapeHtml(money(listing.price_text, listing.price_hkd))}</dd>
          <dt>更新</dt><dd>${escapeHtml(listing.listing_updated_at || "—")}</dd>
          <dt>留言欄</dt><dd>${listing.comment_count ?? "—"}（只係數量）</dd>
          <dt>公開頁</dt><dd>${publicLink}</dd>
          <dt>簡評</dt><dd>${listing.blurb ? escapeHtml(listing.blurb) : "—"}</dd>
        </dl>
        <section class="thread">
          <h2>留言板</h2>
          <p class="muted small">買家帖會同時入收件箱，標記「28car 留言板」。賣家帖（例如 WhatsApp 21740001 附註）留喺呢度。</p>
          ${messages || `<p class="muted">未有留言板內容。</p>`}
        </section>
      </article>
    `;
    res.send(layout({ title: listing.title, body, user: sessionUser(req), active: "28car" }));
  });

  router.post("/28car/sync", requireAuth, async (req: Request, res: Response) => {
    if (!req.session.isAdmin) {
      res.redirect("/28car?error=" + encodeURIComponent("同步只限管理員"));
      return;
    }
    try {
      const report = await syncTwentyeightcar();
      const text = report.network
        ? `已同步 ${report.listings_upserted} 個車盤、${report.buyer_comments_upserted} 則買家留言`
        : `未連線（${report.mode}）${report.stopped ? `：${report.stopped}` : ""}`;
      res.redirect("/28car?ok=" + encodeURIComponent(text));
    } catch {
      res.redirect("/28car?error=" + encodeURIComponent("同步失敗"));
    }
  });

  router.post("/28car/replies/flush", requireAuth, async (req: Request, res: Response) => {
    if (!req.session.isAdmin) {
      res.redirect("/28car?error=" + encodeURIComponent("發送只限管理員"));
      return;
    }
    try {
      const result = await flushHeldReplies(3);
      const text = result.stopped
        ? `已試 ${result.attempted} 則，送出 ${result.sent}。${result.stopped}`
        : `已試 ${result.attempted} 則，送出 ${result.sent}`;
      res.redirect("/28car?ok=" + encodeURIComponent(text));
    } catch {
      res.redirect("/28car?error=" + encodeURIComponent("隊列發送失敗"));
    }
  });
}
