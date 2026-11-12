import { ImapFlow } from "imapflow";
import { MAX_EMAILS_PER_POLL, readEmailMailboxConfig, type EmailMailboxConfig } from "./email-config";
import { ingestCompanyEmail } from "./email-inbox";
import { parseRawEmail } from "./email-parse";
import { emailFetchPlan, readEmailSyncCursor, uidsNewerThan, writeEmailSyncCursor } from "./email-sync";

let started = false;
let running = false;
let tokenCache: { token: string; expiresAt: number } | null = null;

async function accessToken(cfg: EmailMailboxConfig): Promise<string> {
  const oauth = cfg.oauth;
  if (!oauth) throw new Error("Gmail OAuth 未設定");
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
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
  if (!json.access_token) throw new Error("Gmail OAuth 沒有 access_token");
  tokenCache = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

/**
 * 讀公司郵箱 INBOX 一次。唔刪信。
 * 游標寫喺 email_sync_state。進程休眠或重啟之後由最後一個成功 UID 繼續。
 * UIDVALIDITY 變咗就按 lookback 日再掃，已入庫嘅 Message-ID 唔會開第二張單。
 */
export async function pollCompanyEmailOnce(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (running) return;
  const cfg = readEmailMailboxConfig(env);
  if (!cfg) return;
  running = true;
  let client: ImapFlow | null = null;
  try {
    const token = cfg.mode === "oauth" ? await accessToken(cfg) : "";
    client = new ImapFlow({
      host: cfg.imapHost,
      port: cfg.imapPort,
      secure: cfg.imapPort === 993,
      auth: cfg.mode === "oauth" ? { user: cfg.address, accessToken: token } : { user: cfg.address, pass: cfg.appPassword },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 30000,
    });
    client.on("error", (err: Error) => {
      console.error("[email] IMAP", err.message);
    });
    await client.connect();
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const mailbox = client.mailbox;
      if (!mailbox) return;
      const validity = mailbox.uidValidity.toString();
      const cursor = readEmailSyncCursor(cfg.address);
      const plan = emailFetchPlan({
        cursor,
        mailboxUidValidity: validity,
        lookbackDays: cfg.lookbackDays,
      });
      const searched = plan.since
        ? await client.search({ since: plan.since }, { uid: true })
        : await client.search({ uid: `${plan.lastUid + 1}:*` }, { uid: true });
      const found = Array.isArray(searched) ? searched : [];
      const uids = uidsNewerThan(found, plan.lastUid).slice(0, MAX_EMAILS_PER_POLL);
      if (!uids.length) {
        // SINCE 冇結果就唔好跳去 UIDNEXT，否則第一次會漏咗 lookback 入面嘅信。
        // 已經有游標嘅 UID 搜尋冇新信，先至推進到 UIDNEXT，避免 n:* 每次都撞到最後一封。
        if (!plan.since) {
          const high = Number(mailbox.uidNext) - 1;
          const last = Number.isFinite(high) && high > plan.lastUid ? Math.floor(high) : plan.lastUid;
          if (!cursor || cursor.uidValidity !== validity || last > cursor.lastUid) {
            writeEmailSyncCursor(cfg.address, validity, last);
          }
        }
        return;
      }
      for (const uid of uids) {
        let advanced = false;
        try {
          let saw = false;
          for await (const message of client.fetch(String(uid), { uid: true, source: true }, { uid: true })) {
            saw = true;
            const source = message.source;
            if (!source || !Buffer.isBuffer(source)) {
              writeEmailSyncCursor(cfg.address, validity, uid);
              advanced = true;
              continue;
            }
            const parsed = await parseRawEmail(source, `uid-${validity}-${uid}@${cfg.address}`);
            if (!parsed) {
              console.error(`[email] 解析失敗，跳過 uid=${uid}`);
              writeEmailSyncCursor(cfg.address, validity, uid);
              advanced = true;
              continue;
            }
            const saved = await ingestCompanyEmail({ mailbox: cfg.address, ...parsed });
            if (!saved.ok) throw new Error(saved.error);
            writeEmailSyncCursor(cfg.address, validity, uid);
            advanced = true;
          }
          if (!saw) {
            writeEmailSyncCursor(cfg.address, validity, uid);
            advanced = true;
          }
        } catch (err) {
          console.error(
            `[email] uid=${uid} ${advanced ? "已處理一部分" : "未入庫，下次再試"}`,
            err instanceof Error ? err.message : err
          );
          break;
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    running = false;
    if (client) {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }
}

/** 伺服器聽港之後先呼叫。未設定憑證就只記一行，唔會連去 Gmail。 */
export function startCompanyEmailPoller(): void {
  if (started) return;
  const cfg = readEmailMailboxConfig();
  if (!cfg) {
    console.log("[email] 未設定公司電郵憑證，gloriousinformation@gmail.com 唔會入庫。見 README。");
    return;
  }
  started = true;
  const seconds = Math.round(cfg.pollMs / 1000);
  console.log(
    `[email] 公司郵箱 ${cfg.address} 每 ${seconds} 秒讀一次 INBOX（每次最多 ${MAX_EMAILS_PER_POLL} 封）。休眠或重啟後沿用資料庫 UID，補收睇漏嘅信。`
  );
  const tick = () => {
    void pollCompanyEmailOnce().catch((err) => {
      console.error("[email] 收信失敗", err instanceof Error ? err.message : err);
    });
  };
  setTimeout(tick, 5000).unref();
  setInterval(tick, cfg.pollMs).unref();
}
