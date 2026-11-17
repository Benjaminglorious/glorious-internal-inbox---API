/**
 * 同事回覆時限。改規則只改呢度。
 * 資料庫仍然係 UTC。星期同夜晚窗用 Asia/Hong_Kong。
 * 舊訊息的起計時間唔寫死：係部署後檢查器第一次跑的瞬間，記喺 reply_sla_epoch。
 */

/** 星期一至六，計時開始嗰刻決定。 */
export const REPLY_SLA_WEEKDAY_SECONDS = 2 * 60 * 60;
/** 星期日，計時開始嗰刻決定。 */
export const REPLY_SLA_SUNDAY_SECONDS = 3 * 60 * 60;

/** 呢個鐘之後（包括正正 23:00）唔計時，直到朝早。 */
export const REPLY_SLA_NIGHT_START_HOUR = 23;
/** 正正 09:00 開始計時。09:00 之前都係夜晚窗。 */
export const REPLY_SLA_DAY_START_HOUR = 9;

export const REPLY_SLA_STRIKES = 3;
/** 第一次累積 3 次逾時。 */
export const REPLY_SLA_FIRST_SUSPEND_DAYS = 3;
/** 已經有過一次 3 次暫停之後，再累積 3 次。 */
export const REPLY_SLA_LATER_SUSPEND_DAYS = 7;
export const REPLY_SLA_FIRST_SUSPEND_MS = REPLY_SLA_FIRST_SUSPEND_DAYS * 24 * 60 * 60 * 1000;
export const REPLY_SLA_LATER_SUSPEND_MS = REPLY_SLA_LATER_SUSPEND_DAYS * 24 * 60 * 60 * 1000;

/** 逾時即時通知。用用戶名搵 staff，唔好寫死 id。 */
export const REPLY_SLA_NOTIFY_USERNAMES = ["tony", "eddie", "benjamin"] as const;

/** 網頁進程入面嘅檢查間隔。唔使另開付費 worker。 */
export const REPLY_SLA_CHECK_MS = 20_000;
