import { db } from "../db";

export interface EmailSyncCursor {
  uidValidity: string | null;
  lastUid: number;
}

export interface EmailFetchPlan {
  /** 設咗就用 SINCE 補回看窗口。UIDVALIDITY 變咗或者未有游標先至用。 */
  since: Date | null;
  /** 只處理大過呢個 UID 嘅信。IMAP `n:*` 有時會連最後一封都返回。 */
  lastUid: number;
}

export function readEmailSyncCursor(mailbox: string): EmailSyncCursor | null {
  const row = db
    .prepare(`SELECT uid_validity, last_uid FROM email_sync_state WHERE mailbox = ?`)
    .get(mailbox) as { uid_validity: string | null; last_uid: number } | undefined;
  if (!row) return null;
  return {
    uidValidity: row.uid_validity,
    lastUid: Number(row.last_uid) || 0,
  };
}

export function writeEmailSyncCursor(mailbox: string, uidValidity: string, lastUid: number): void {
  const uid = Number.isFinite(lastUid) && lastUid > 0 ? Math.floor(lastUid) : 0;
  db.prepare(
    `INSERT INTO email_sync_state (mailbox, uid_validity, last_uid)
     VALUES (?, ?, ?)
     ON CONFLICT (mailbox) DO UPDATE SET
       uid_validity = excluded.uid_validity,
       last_uid = excluded.last_uid,
       updated_at = datetime('now')`
  ).run(mailbox, uidValidity, uid);
}

/** 去掉 IMAP `UID n:*` 會多返回嘅舊 UID。 */
export function uidsNewerThan(uids: Array<number | bigint>, lastUid: number): number[] {
  const floor = Number.isFinite(lastUid) ? lastUid : 0;
  const next = new Set<number>();
  for (const uid of uids) {
    const value = typeof uid === "bigint" ? Number(uid) : uid;
    if (!Number.isFinite(value) || value <= floor || value > Number.MAX_SAFE_INTEGER) continue;
    next.add(Math.floor(value));
  }
  return [...next].sort((a, b) => a - b);
}

/**
 * 有同一 UIDVALIDITY 嘅游標就只取更新嘅 UID。
 * 冇游標，或者郵箱重建過，就由 lookback 日再掃。已入庫嘅 Message-ID 會跳過。
 */
export function emailFetchPlan(input: {
  cursor: EmailSyncCursor | null;
  mailboxUidValidity: string;
  lookbackDays: number;
  now?: Date;
}): EmailFetchPlan {
  const now = input.now ?? new Date();
  const validity = input.mailboxUidValidity.trim();
  if (input.cursor && input.cursor.uidValidity === validity) {
    return { since: null, lastUid: input.cursor.lastUid };
  }
  const days = Math.min(90, Math.max(1, Math.floor(input.lookbackDays) || 14));
  return { since: new Date(now.getTime() - days * 24 * 60 * 60 * 1000), lastUid: 0 };
}
