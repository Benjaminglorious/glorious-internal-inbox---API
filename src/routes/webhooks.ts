import { Router, Request, Response } from "express";
import { parseMetaWebhookPayload } from "../services/meta-webhook";
import {
  normalizeSiteCommentSource,
  upsertSiteComment,
  type SiteCommentSource,
} from "../services/site-comments";
import {
  configuredWebhookToken,
  providedWebhookToken,
  queryString,
  verifyMetaSignature,
  webhookTokenMatches,
} from "../services/webhook-auth";
import { parseWhatsAppWebhookPayload, routeWhatsAppInbound } from "../services/whatsapp";

export const whatsappWebhookRouter = Router();
export const siteCommentWebhookRouter = Router();
export const metaWebhookRouter = Router();

function requireWebhookToken(req: Request, res: Response): boolean {
  if (!configuredWebhookToken()) {
    res.status(503).json({ ok: false, error: "WEBHOOK_VERIFY_TOKEN 未設定" });
    return false;
  }
  if (!webhookTokenMatches(providedWebhookToken(req))) {
    res.status(401).json({ ok: false, error: "webhook token 不正確" });
    return false;
  }
  return true;
}

function hubVerify(req: Request, res: Response): void {
  if (!configuredWebhookToken()) {
    res.status(503).type("text/plain").send("WEBHOOK_VERIFY_TOKEN is not set");
    return;
  }
  const mode = queryString(req.query["hub.mode"]);
  const token = queryString(req.query["hub.verify_token"]);
  const challenge = queryString(req.query["hub.challenge"]);
  if (mode === "subscribe" && challenge.length > 0 && challenge.length <= 256 && webhookTokenMatches(token)) {
    res.status(200).type("text/plain").send(challenge);
    return;
  }
  res.status(403).type("text/plain").send("forbidden");
}

/** Meta webhook 驗證（hub.mode=subscribe）。未設定 WEBHOOK_VERIFY_TOKEN 時拒絕。 */
whatsappWebhookRouter.get("/", hubVerify);

/**
 * WhatsApp 入站 stub。而家唔會連接 Meta／Glorious。
 * 用 X-Webhook-Token 或 Authorization: Bearer，對照 WEBHOOK_VERIFY_TOKEN。
 */
whatsappWebhookRouter.post("/", (req: Request, res: Response) => {
  if (!requireWebhookToken(req, res)) return;

  const parsed = parseWhatsAppWebhookPayload(req.body);
  if (parsed.error) {
    res.status(400).json({ ok: false, error: parsed.error });
    return;
  }
  if (parsed.messages.length === 0) {
    res.json({ ok: true, ignored: true, results: [] });
    return;
  }

  const results = parsed.messages.map((message) => {
    const routed = routeWhatsAppInbound(message);
    if (!routed.ok) return { ok: false as const, error: routed.error };
    return {
      ok: true as const,
      outcome: routed.outcome,
      comment_id: routed.comment.id,
      assignee_staff_id: routed.assigneeStaffId,
      created: routed.created,
      line_id: routed.line?.id ?? null,
      intake_kind: routed.comment.intake_kind,
      origin_site: routed.comment.origin_site,
    };
  });
  const anyOk = results.some((result) => result.ok);
  res.status(anyOk ? 200 : 400).json({ ok: anyOk, results });
});

function readSiteCommentBody(
  req: Request,
  forcedSource?: SiteCommentSource
): { ok: true; source: string; external_id: string; author_name: string; body: string; vehicle_ref: string | null } | { ok: false; error: string } {
  const raw = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const sourceRaw = forcedSource ?? raw.source ?? raw.channel;
  const sourceNorm = normalizeSiteCommentSource(sourceRaw);
  if (sourceNorm === "invalid" || sourceNorm == null) {
    return { ok: false, error: "source 必須係 28car、glorious_web、facebook 或 instagram（可用 fb／ig／gw）" };
  }

  const external_id = String(raw.external_id ?? raw.externalId ?? raw.id ?? "");
  const author_name = String(raw.author_name ?? raw.authorName ?? raw.from ?? "");
  const body = String(raw.body ?? raw.message ?? raw.text ?? "");
  const vehicle =
    raw.vehicle_ref != null
      ? String(raw.vehicle_ref)
      : raw.vehicleRef != null
        ? String(raw.vehicleRef)
        : raw.vehicle != null
          ? String(raw.vehicle)
          : null;

  return {
    ok: true,
    source: sourceNorm,
    external_id,
    author_name,
    body,
    vehicle_ref: vehicle,
  };
}

function handleSiteCommentPost(req: Request, res: Response, forcedSource?: SiteCommentSource): void {
  if (!requireWebhookToken(req, res)) return;

  const parsed = readSiteCommentBody(req, forcedSource);
  if (!parsed.ok) {
    res.status(400).json({ ok: false, error: parsed.error });
    return;
  }

  const result = upsertSiteComment({
    source: parsed.source,
    external_id: parsed.external_id,
    author_name: parsed.author_name,
    body: parsed.body,
    vehicle_ref: parsed.vehicle_ref,
  });
  if (!result.ok) {
    res.status(400).json({ ok: false, error: result.error });
    return;
  }
  res.status(result.created ? 201 : 200).json({
    ok: true,
    created: result.created,
    comment_id: result.comment.id,
    assignee_staff_id: result.assigneeStaffId,
    source: result.comment.source,
    intake_kind: result.comment.intake_kind,
    origin_site: result.comment.origin_site,
  });
}

/**
 * 通用網站／FB／IG 留言入站。
 * Header：X-Webhook-Token 或 Authorization: Bearer = WEBHOOK_VERIFY_TOKEN。
 * Body：source、external_id、author_name、body；vehicle_ref 可選。
 */
siteCommentWebhookRouter.post("/", (req, res) => handleSiteCommentPost(req, res));

/** 路徑別名：強制 source，body 唔使再傳 source。 */
siteCommentWebhookRouter.post("/28car", (req, res) => handleSiteCommentPost(req, res, "28car"));
siteCommentWebhookRouter.post("/glorious-web", (req, res) => handleSiteCommentPost(req, res, "glorious_web"));
siteCommentWebhookRouter.post("/glorious_web", (req, res) => handleSiteCommentPost(req, res, "glorious_web"));
siteCommentWebhookRouter.post("/facebook", (req, res) => handleSiteCommentPost(req, res, "facebook"));
siteCommentWebhookRouter.post("/instagram", (req, res) => handleSiteCommentPost(req, res, "instagram"));

/** Meta Developer Console Callback URL 驗證。 */
metaWebhookRouter.get("/", hubVerify);

/**
 * Meta Page／Instagram webhook。
 * - 有 META_APP_SECRET 時驗證 X-Hub-Signature-256（失敗回 401）。
 * - 未設定 secret 時跳過簽名（方便本地／尚未填密鑰）。
 * - 認得嘅留言／私訊會 upsert 為 site_comment（facebook 或 instagram）。
 */
metaWebhookRouter.post("/", (req: Request, res: Response) => {
  if (!configuredWebhookToken()) {
    res.status(503).json({ ok: false, error: "WEBHOOK_VERIFY_TOKEN 未設定" });
    return;
  }

  const sig = verifyMetaSignature(req);
  if (!sig.ok) {
    res.status(sig.status).json({ ok: false, error: sig.error });
    return;
  }

  // Meta 訂閱驗證之後嘅推送唔帶我哋嘅 X-Webhook-Token；簽名（或未設 secret）就夠。
  // 若同時帶咗 token 就必須啱。
  const provided = providedWebhookToken(req);
  if (provided && !webhookTokenMatches(provided)) {
    res.status(401).json({ ok: false, error: "webhook token 不正確" });
    return;
  }

  const parsed = parseMetaWebhookPayload(req.body);
  if (parsed.error) {
    res.status(400).json({ ok: false, error: parsed.error });
    return;
  }
  if (parsed.items.length === 0) {
    res.json({ ok: true, ignored: true, results: [] });
    return;
  }

  const results = parsed.items.map((item) => {
    const upserted = upsertSiteComment(item);
    if (!upserted.ok) return { ok: false as const, error: upserted.error, external_id: item.external_id };
    return {
      ok: true as const,
      comment_id: upserted.comment.id,
      source: upserted.comment.source,
      created: upserted.created,
      assignee_staff_id: upserted.assigneeStaffId,
      intake_kind: upserted.comment.intake_kind,
      external_id: item.external_id,
    };
  });
  const anyOk = results.some((r) => r.ok);
  res.status(anyOk ? 200 : 400).json({ ok: anyOk, results });
});
