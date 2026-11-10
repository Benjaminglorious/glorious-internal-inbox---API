import { Router, Request, Response } from "express";
import { requireAdmin, requireAuth, sessionViewer } from "../auth/middleware";
import { clearDemoFixtures } from "../db/clear-demo";
import { usingPostgres } from "../db";
import { companyWhatsAppUrl } from "../config";
import { emailIngestStatus } from "../services/email-config";
import { isPushConfigured, removePushSubscription, savePushSubscription, vapidPublicKey } from "../services/push";
import {
  REASSIGNED_MESSAGE,
  canViewComment,
  getComment,
  listCommentUpdates,
  listComments,
  listStaff,
  normalizeInboxQuery,
  reassign,
  updateStatus,
  findStaffById,
} from "../services/comments";
import { listMediaForComment, presentMedia } from "../services/media";
import { blockingOpenThreadId } from "../services/commenter-thread";
import { createStaffMediaReply, createStaffReply, listReplies } from "../services/replies";
import { addStaffWhatsAppLine, deactivateWhatsAppLine, listWhatsAppLines, staffWhatsAppReplyForViewer } from "../services/whatsapp";
import { sendMedia } from "./media-http";
import { twentyeightcarStatus } from "../adapters/twentyeightcar-config";
import { flushHeldReplies, getListing, listListingMessages, listListings, syncStateForUi, syncTwentyeightcar } from "../services/twentyeightcar";
import {
  isCommentSource,
  isCommentStatus,
  isCommentStatusFilter,
  isEntryPath,
  isIntakeKind,
  isOriginFilter,
} from "../types";
import { formatStaffTimestamp, presentStaffTimes, STAFF_TIME_ZONE } from "../time";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  const now = new Date();
  res.json({
    ok: true,
    service: "glorious-internal-inbox",
    ts: now.toISOString(),
    ts_hkt: formatStaffTimestamp(now.toISOString(), "utc"),
    time_zone: STAFF_TIME_ZONE,
    company_whatsapp_url: companyWhatsAppUrl(),
    push_enabled: isPushConfigured(),
    email: emailIngestStatus(),
    database: usingPostgres ? "postgres" : "sqlite",
    twentyeightcar: (() => {
      const status = twentyeightcarStatus(false);
      return {
        account_count: status.account_count,
        sync_enabled: status.sync_enabled,
        reply_post_enabled: status.reply_post_enabled,
        login_form_configured: status.login_form_configured,
        egress_ready: status.egress_ready,
        egress_mode: status.egress_mode,
        proxy_count: status.proxy_count,
      };
    })(),
  });
});

/** 公開設定，畀網頁／日後客戶端讀公司 WhatsApp 連結，唔使硬編碼。 */
apiRouter.get("/config", (_req, res) => {
  res.json({
    company_whatsapp_url: companyWhatsAppUrl(),
  });
});

apiRouter.get("/me", requireAuth, (req: Request, res: Response) => {
  const staff = findStaffById(req.session.staffId!);
  if (!staff) {
    res.status(401).json({ error: "工作階段無效" });
    return;
  }
  res.json({
    id: staff.id,
    username: staff.username,
    display_name: staff.display_name,
    is_admin: !!staff.is_admin,
  });
});

apiRouter.get("/comments/updates", requireAuth, (req: Request, res: Response) => {
  const raw = req.query.since_id;
  let sinceId: number | null = null;
  if (raw != null && raw !== "") {
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
      res.status(400).json({ error: "since_id 必須係非負整數" });
      return;
    }
    sinceId = Number(raw);
    if (!Number.isSafeInteger(sinceId)) {
      res.status(400).json({ error: "since_id 必須係非負整數" });
      return;
    }
  }
  const replyRaw = req.query.since_reply_id;
  let sinceReplyId: number | null = null;
  if (replyRaw != null && replyRaw !== "") {
    if (typeof replyRaw !== "string" || !/^\d+$/.test(replyRaw)) {
      res.status(400).json({ error: "since_reply_id 必須係非負整數" });
      return;
    }
    sinceReplyId = Number(replyRaw);
    if (!Number.isSafeInteger(sinceReplyId)) {
      res.status(400).json({ error: "since_reply_id 必須係非負整數" });
      return;
    }
  }
  const updates = listCommentUpdates(sinceId, 30, sessionViewer(req), sinceReplyId);
  res.set("Cache-Control", "no-store");
  res.json({
    ...updates,
    time_zone: STAFF_TIME_ZONE,
    comments: updates.comments.map((comment) => presentStaffTimes(comment)),
    follow_ups: updates.follow_ups.map((comment) => presentStaffTimes(comment)),
  });
});

apiRouter.get("/comments", requireAuth, (req: Request, res: Response) => {
  const sourceRaw = typeof req.query.source === "string" ? req.query.source : undefined;
  const source = sourceRaw && isCommentSource(sourceRaw) ? sourceRaw : undefined;
  const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
  const status = statusRaw && isCommentStatusFilter(statusRaw) ? statusRaw : undefined;
  const intakeRaw = typeof req.query.intake === "string" ? req.query.intake : undefined;
  const intake = intakeRaw && isIntakeKind(intakeRaw) ? intakeRaw : undefined;
  const originRaw = typeof req.query.origin === "string" ? req.query.origin : undefined;
  const origin = originRaw && isOriginFilter(originRaw) ? originRaw : undefined;
  const entryRaw = typeof req.query.entry === "string" ? req.query.entry : undefined;
  const entry = entryRaw && isEntryPath(entryRaw) ? entryRaw : undefined;
  const mine = req.query.mine === "1" || req.query.mine === "true";
  const q = normalizeInboxQuery(req.query.q);
  if (sourceRaw && !source) {
    res.status(400).json({ error: "無效來源" });
    return;
  }
  if (statusRaw && !status) {
    res.status(400).json({ error: "無效狀態" });
    return;
  }
  if (intakeRaw && !intake) {
    res.status(400).json({ error: "無效形式" });
    return;
  }
  if (originRaw && !origin) {
    res.status(400).json({ error: "無效相關網站" });
    return;
  }
  if (entryRaw && !entry) {
    res.status(400).json({ error: "entry 必須係 28car_board 或 28car_wa_link" });
    return;
  }
  const rows = listComments({
    source,
    status,
    intake,
    origin,
    entry,
    mine,
    staffId: req.session.staffId,
    viewer: sessionViewer(req),
    q,
  });
  res.json({ time_zone: STAFF_TIME_ZONE, comments: rows.map((row) => presentStaffTimes(row)) });
});

function visibleComment(req: Request, id: number) {
  const comment = getComment(id);
  if (!comment || !canViewComment(comment, sessionViewer(req))) return null;
  return comment;
}

apiRouter.get("/comments/:id/replies", requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!visibleComment(req, id)) {
    res.status(404).json({ error: "找不到留言" });
    return;
  }
  res.json({ time_zone: STAFF_TIME_ZONE, replies: listReplies(id).map((reply) => presentStaffTimes(reply)) });
});

apiRouter.get("/media/:id", requireAuth, (req: Request, res: Response) => {
  void sendMedia(req, res);
});

apiRouter.post("/comments/:id/media-replies", requireAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const viewer = sessionViewer(req);
  try {
    const result = await createStaffMediaReply({
      commentId: id,
      staffId: req.session.staffId!,
      viewer,
      caption: typeof req.body?.caption === "string" ? req.body.caption : "",
      mimeType: typeof req.body?.mime_type === "string" ? req.body.mime_type : "",
      isVoice: req.body?.is_voice === true,
      dataBase64: typeof req.body?.data_base64 === "string" ? req.body.data_base64 : "",
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({
      time_zone: STAFF_TIME_ZONE,
      reply: presentStaffTimes(result.reply),
      comment: presentStaffTimes(result.comment),
      media: listMediaForComment(id).map(presentMedia),
    });
  } catch (err) {
    console.error("[media] 未能寫入媒體回覆", err);
    res.status(500).json({ error: "未能發送媒體" });
  }
});

apiRouter.post("/comments/:id/replies", requireAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const viewer = sessionViewer(req);
  try {
    const result = await createStaffReply({
      commentId: id,
      staffId: req.session.staffId!,
      body: typeof req.body?.body === "string" ? req.body.body : "",
      viewer,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({
      time_zone: STAFF_TIME_ZONE,
      reply: presentStaffTimes(result.reply),
      comment: presentStaffTimes(result.comment),
    });
  } catch (err) {
    console.error("[replies] 未能寫入回覆", err);
    res.status(500).json({ error: "未能發送回覆" });
  }
});

apiRouter.get("/comments/:id", requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = visibleComment(req, id);
  if (!row) {
    res.status(404).json({ error: "找不到留言" });
    return;
  }
  res.json({
    time_zone: STAFF_TIME_ZONE,
    comment: presentStaffTimes(row),
    replies: listReplies(id).map((reply) => presentStaffTimes(reply)),
    media: listMediaForComment(id).map(presentMedia),
    staff_whatsapp_reply: staffWhatsAppReplyForViewer(row, req.session.staffId!),
  });
});

apiRouter.post("/comments/:id/status", requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const status = req.body?.status;
  if (!isCommentStatus(status)) {
    res.status(400).json({ error: "狀態必須係 open / in_progress / done" });
    return;
  }
  const viewer = sessionViewer(req);
  if (!visibleComment(req, id)) {
    res.status(404).json({ error: "找不到留言" });
    return;
  }
  const conflict = blockingOpenThreadId(id, status);
  if (conflict) {
    res.status(409).json({
      error: `呢位留言者已有未完成對話 #${conflict}。狀態係已完成先至可以再開一條。`,
      open_comment_id: conflict,
    });
    return;
  }
  const updated = updateStatus(id, status, viewer);
  if (!updated) {
    const still = getComment(id);
    res.status(still ? 403 : 404).json({ error: still ? REASSIGNED_MESSAGE : "找不到留言" });
    return;
  }
  res.json({ time_zone: STAFF_TIME_ZONE, comment: presentStaffTimes(updated) });
});

apiRouter.post("/comments/:id/assign", requireAdmin, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const staffIdRaw = req.body?.staff_id;
  const staffId =
    staffIdRaw === null || staffIdRaw === "" || staffIdRaw === undefined
      ? null
      : Number(staffIdRaw);
  if (staffId != null && Number.isNaN(staffId)) {
    res.status(400).json({ error: "無效同事 id" });
    return;
  }
  if (!getComment(id)) {
    res.status(404).json({ error: "找不到留言" });
    return;
  }
  const updated = reassign(id, staffId);
  if (!updated && staffId != null) {
    res.status(400).json({ error: "找不到有效同事" });
    return;
  }
  res.json({ time_zone: STAFF_TIME_ZONE, comment: updated ? presentStaffTimes(updated) : updated });
});

apiRouter.get("/28car/status", requireAuth, (_req: Request, res: Response) => {
  res.json({ ...presentStaffTimes(syncStateForUi()), time_zone: STAFF_TIME_ZONE });
});

apiRouter.get("/28car/listings", requireAuth, (req: Request, res: Response) => {
  const account = typeof req.query.account === "string" ? req.query.account : undefined;
  res.json({
    time_zone: STAFF_TIME_ZONE,
    listings: listListings(account).map((listing) => presentStaffTimes(listing)),
  });
});

apiRouter.get("/28car/listings/:stockId", requireAuth, (req: Request, res: Response) => {
  const listing = getListing(String(req.params.stockId));
  if (!listing) {
    res.status(404).json({ error: "找不到車盤" });
    return;
  }
  res.json({
    time_zone: STAFF_TIME_ZONE,
    listing: presentStaffTimes(listing),
    messages: listListingMessages(listing.stock_id).map((message) => presentStaffTimes(message)),
  });
});

apiRouter.post("/28car/sync", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const report = await syncTwentyeightcar();
    res.json({
      mode: report.mode,
      network: report.network,
      listings_upserted: report.listings_upserted,
      buyer_comments_upserted: report.buyer_comments_upserted,
      accounts_attempted: report.accounts_attempted,
      stopped: report.stopped,
    });
  } catch (err) {
    console.error("[28car] sync", err instanceof Error ? err.message : "failed");
    res.status(500).json({ error: "同步失敗" });
  }
});

apiRouter.post("/28car/replies/flush", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await flushHeldReplies(3);
    res.json(result);
  } catch (err) {
    console.error("[28car] flush", err instanceof Error ? err.message : "failed");
    res.status(500).json({ error: "隊列發送失敗" });
  }
});

apiRouter.get("/staff", requireAuth, (_req: Request, res: Response) => {
  res.json({ staff: listStaff() });
});

apiRouter.get("/whatsapp-lines", requireAdmin, (_req: Request, res: Response) => {
  res.json({
    time_zone: STAFF_TIME_ZONE,
    lines: listWhatsAppLines().map((line) => presentStaffTimes(line)),
  });
});

apiRouter.post("/whatsapp-lines", requireAdmin, (req: Request, res: Response) => {
  const staffId = Number(req.body?.staff_id);
  const result = addStaffWhatsAppLine({
    staffId,
    phone: String(req.body?.phone ?? ""),
    displayLabel: req.body?.display_label != null ? String(req.body.display_label) : undefined,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json({ time_zone: STAFF_TIME_ZONE, line: presentStaffTimes(result.line) });
});

apiRouter.post("/whatsapp-lines/:id/deactivate", requireAdmin, (req: Request, res: Response) => {
  const result = deactivateWhatsAppLine(Number(req.params.id));
  if (!result.ok) {
    res.status(result.error === "找不到線路" ? 404 : 400).json({ error: result.error });
    return;
  }
  res.json({ time_zone: STAFF_TIME_ZONE, line: presentStaffTimes(result.line) });
});

apiRouter.get("/push/config", requireAuth, (_req: Request, res: Response) => {
  const enabled = isPushConfigured();
  res.set("Cache-Control", "no-store");
  res.json({ enabled, public_key: enabled ? vapidPublicKey() : null });
});

apiRouter.post("/push/subscribe", requireAuth, (req: Request, res: Response) => {
  if (!isPushConfigured()) {
    res.status(503).json({ error: "伺服器未設定 Web Push" });
    return;
  }
  const result = savePushSubscription(req.session.staffId!, req.body, req.get("user-agent") ?? null);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

apiRouter.post("/admin/clear-demo", requireAdmin, (_req: Request, res: Response) => {
  try {
    const result = clearDemoFixtures();
    res.json({
      ok: true,
      ...result,
      kept: "同事帳號、wamid WhatsApp 對話，以及 seed 清單以外嘅 28car 留言",
    });
  } catch (err) {
    console.error("[clear:demo]", err instanceof Error ? err.message : "failed");
    res.status(500).json({ error: "清除示範資料失敗" });
  }
});

apiRouter.post("/push/unsubscribe", requireAuth, (req: Request, res: Response) => {
  const result = removePushSubscription(req.session.staffId!, req.body);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true, removed: result.removed });
});
