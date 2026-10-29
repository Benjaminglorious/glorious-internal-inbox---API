import { timingSafeEqual } from "crypto";
import { Router, Request, Response } from "express";
import { parseWhatsAppWebhookPayload, routeWhatsAppInbound } from "../services/whatsapp";

export const whatsappWebhookRouter = Router();

function configuredToken(): string {
  return process.env.WEBHOOK_VERIFY_TOKEN?.trim() ?? "";
}

function tokenMatches(provided: string): boolean {
  const expected = configuredToken();
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function queryString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function providedToken(req: Request): string {
  const header = req.get("x-webhook-token")?.trim();
  if (header) return header;
  const auth = req.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(auth);
  return match?.[1] ?? "";
}

/** Meta webhook 驗證（hub.mode=subscribe）。未設定 WEBHOOK_VERIFY_TOKEN 時拒絕。 */
whatsappWebhookRouter.get("/", (req: Request, res: Response) => {
  if (!configuredToken()) {
    res.status(503).type("text/plain").send("WEBHOOK_VERIFY_TOKEN is not set");
    return;
  }
  const mode = queryString(req.query["hub.mode"]);
  const token = queryString(req.query["hub.verify_token"]);
  const challenge = queryString(req.query["hub.challenge"]);
  if (mode === "subscribe" && challenge.length > 0 && challenge.length <= 256 && tokenMatches(token)) {
    res.status(200).type("text/plain").send(challenge);
    return;
  }
  res.status(403).type("text/plain").send("forbidden");
});

/**
 * 入站 stub。而家唔會連接 Meta／Glorious。
 * 用 X-Webhook-Token 或 Authorization: Bearer，對照 WEBHOOK_VERIFY_TOKEN。
 */
whatsappWebhookRouter.post("/", (req: Request, res: Response) => {
  if (!configuredToken()) {
    res.status(503).json({ ok: false, error: "WEBHOOK_VERIFY_TOKEN 未設定" });
    return;
  }
  if (!tokenMatches(providedToken(req))) {
    res.status(401).json({ ok: false, error: "webhook token 不正確" });
    return;
  }

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
