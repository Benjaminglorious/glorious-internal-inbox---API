import { createHmac, timingSafeEqual } from "crypto";
import type { Request } from "express";

export function configuredWebhookToken(): string {
  return process.env.WEBHOOK_VERIFY_TOKEN?.trim() ?? "";
}

export function webhookTokenMatches(provided: string): boolean {
  const expected = configuredWebhookToken();
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function queryString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** X-Webhook-Token 或 Authorization: Bearer。 */
export function providedWebhookToken(req: Request): string {
  const header = req.get("x-webhook-token")?.trim();
  if (header) return header;
  const auth = req.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(auth);
  return match?.[1] ?? "";
}

export function metaAppSecret(): string {
  return process.env.META_APP_SECRET?.trim() ?? "";
}

/**
 * Meta X-Hub-Signature-256。有 META_APP_SECRET 時必須驗證；未設定就跳過。
 * 需要 req.rawBody（見 index.ts express.json verify）。
 */
export function verifyMetaSignature(req: Request): { ok: true } | { ok: false; error: string; status: number } {
  const secret = metaAppSecret();
  if (!secret) return { ok: true };

  const header = req.get("x-hub-signature-256")?.trim() ?? "";
  const match = /^sha256=([a-f0-9]+)$/i.exec(header);
  if (!match) {
    return { ok: false, error: "缺少或無效 X-Hub-Signature-256", status: 401 };
  }

  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!raw || !Buffer.isBuffer(raw)) {
    return { ok: false, error: "無法驗證簽名（缺少 raw body）", status: 500 };
  }

  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const provided = match[1].toLowerCase();
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: "X-Hub-Signature-256 不正確", status: 401 };
  }
  return { ok: true };
}
