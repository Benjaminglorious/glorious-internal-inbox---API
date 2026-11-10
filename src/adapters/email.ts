import { randomBytes } from "crypto";
import nodemailer from "nodemailer";
import { db } from "../db";
import { companyEmailAddress, readEmailMailboxConfig, type EmailMailboxConfig } from "../services/email-config";
import { bracketMessageId, cleanMessageId, joinReferenceIds, replySubject } from "../services/email-address";
import type { OutboundReplyRequest, OutboundReplyResult } from "./outbound";

export interface OutboundEmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo: string | null;
  references: string[];
  messageId: string;
}

type EmailTransport = (message: OutboundEmailMessage) => Promise<void>;

let transportOverride: EmailTransport | null = null;

/** 示範同測試用。正式發送唔經呢度。 */
export function setEmailTransportForTests(transport: EmailTransport | null): void {
  transportOverride = transport;
}

let tokenCache: { key: string; token: string; expiresAt: number } | null = null;

async function gmailAccessToken(cfg: EmailMailboxConfig): Promise<string> {
  const oauth = cfg.oauth;
  if (!oauth) throw new Error("Gmail OAuth 未設定，email 未發送");
  const key = `${oauth.clientId}:${oauth.refreshToken.slice(0, 8)}`;
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const body = new URLSearchParams({
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    refresh_token: oauth.refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Gmail OAuth 更新失敗（HTTP ${response.status}）`);
  const json = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Gmail OAuth 沒有 access_token，email 未發送");
  tokenCache = {
    key,
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return json.access_token;
}

function safeError(err: unknown, secret: string): string {
  const message = err instanceof Error ? err.message : "公司電郵發送失敗";
  const cleaned = secret ? message.split(secret).join("***") : message;
  return cleaned.replace(/\s+/g, " ").trim().slice(0, 300) || "公司電郵發送失敗";
}

function rememberSent(commentId: number, messageId: string): void {
  const row = db.prepare(`SELECT email_references FROM comments WHERE id = ?`).get(commentId) as
    | { email_references: string | null }
    | undefined;
  const next = joinReferenceIds(row?.email_references, [messageId]);
  db.prepare(`UPDATE comments SET email_references = ? WHERE id = ?`).run(next || null, commentId);
}

async function deliver(cfg: EmailMailboxConfig, message: OutboundEmailMessage): Promise<void> {
  const accessToken = cfg.mode === "oauth" ? await gmailAccessToken(cfg) : "";
  const transporter = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpPort === 465,
    auth:
      cfg.mode === "oauth"
        ? { type: "OAuth2", user: cfg.address, accessToken }
        : { user: cfg.address, pass: cfg.appPassword },
  });
  try {
    await transporter.sendMail({
      from: message.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      replyTo: cfg.address,
      messageId: message.messageId,
      inReplyTo: message.inReplyTo ?? undefined,
      references: message.references.length ? message.references : undefined,
    });
  } finally {
    transporter.close();
  }
}

/**
 * 同事撳發送回覆時，由公司郵箱寄回客戶，並用 In-Reply-To 留喺同一封對話。
 * 未設定憑證就標 failed，唔會當已發送。
 */
export async function queueOutboundReply(input: OutboundReplyRequest): Promise<OutboundReplyResult> {
  const to = (input.emailFrom ?? "").trim().toLowerCase();
  if (!to) {
    return { delivery_status: "failed", provider: "email", error: "未有客戶電郵地址，email 未發送" };
  }
  const domain = companyEmailAddress().split("@")[1] || "localhost";
  const ourId = `${Date.now()}.${randomBytes(8).toString("hex")}@${domain}`;
  const inReply = cleanMessageId(input.emailMessageId);
  const references = joinReferenceIds(input.emailReferences, inReply ? [inReply] : [])
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => bracketMessageId(id))
    .filter(Boolean);
  const message: OutboundEmailMessage = {
    from: `東榮汽車 <${companyEmailAddress()}>`,
    to,
    subject: replySubject(input.emailSubject),
    text: input.body,
    inReplyTo: inReply ? bracketMessageId(inReply) : null,
    references,
    messageId: `<${ourId}>`,
  };

  try {
    if (transportOverride) await transportOverride(message);
    else {
      const cfg = readEmailMailboxConfig();
      if (!cfg) {
        return {
          delivery_status: "failed",
          provider: "email",
          error: "未設定公司電郵憑證（GLORIOUS_EMAIL_APP_PASSWORD 或 OAuth），email 未發送",
        };
      }
      await deliver(cfg, { ...message, from: `東榮汽車 <${cfg.address}>` });
    }
  } catch (err) {
    const cfg = readEmailMailboxConfig();
    return {
      delivery_status: "failed",
      provider: "email",
      error: safeError(err, cfg?.appPassword || cfg?.oauth?.clientSecret || ""),
    };
  }

  try {
    rememberSent(input.commentId, ourId);
  } catch (err) {
    console.error("[email] 已發送但未寫低對話編號", err instanceof Error ? err.message : err);
  }
  return { delivery_status: "sent", provider: "email" };
}
