import {
  REPLY_SLA_DAY_START_HOUR,
  REPLY_SLA_NIGHT_START_HOUR,
  REPLY_SLA_SUNDAY_SECONDS,
  REPLY_SLA_WEEKDAY_SECONDS,
} from "../reply-sla-config";
import { STAFF_TIME_ZONE, hktParts, parseStoredTimestamp } from "../time";

export interface ReplyDeadline {
  /** 夜晚窗完結之後、真正開始計時嘅瞬間。 */
  countStart: Date;
  due: Date;
  /** 2 小時或 3 小時。由 countStart 嘅香港星期決定，之後唔會改。 */
  limitSeconds: number;
}

/** UTC 文字，同資料庫 datetime('now') 一樣：YYYY-MM-DD HH:MM:SS。 */
export function formatUtcTimestamp(instant: Date): string {
  const iso = instant.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function atHkt(year: number, month: number, day: number, hour: number, minute: number, second: number): Date {
  const text = `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
  const instant = parseStoredTimestamp(text, "hkt");
  if (!instant) throw new Error(`無法解析香港時間 ${text}`);
  return instant;
}

export function isNightHkt(instant: Date): boolean {
  const hour = Number(hktParts(instant).hour);
  return hour >= REPLY_SLA_NIGHT_START_HOUR || hour < REPLY_SLA_DAY_START_HOUR;
}

/** 如果而家喺夜晚窗，推到下一刻 09:00；否則就係原瞬間。 */
export function nextCountedInstant(instant: Date): Date {
  if (!isNightHkt(instant)) return instant;
  const parts = hktParts(instant);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  if (hour < REPLY_SLA_DAY_START_HOUR) return atHkt(year, month, day, REPLY_SLA_DAY_START_HOUR, 0, 0);
  const next = new Date(Date.UTC(year, month - 1, day) + 86_400_000);
  return atHkt(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), REPLY_SLA_DAY_START_HOUR, 0, 0);
}

function sameDayPause(instant: Date): Date {
  const parts = hktParts(instant);
  return atHkt(
    Number(parts.year),
    Number(parts.month),
    Number(parts.day),
    REPLY_SLA_NIGHT_START_HOUR,
    0,
    0
  );
}

function isSundayHkt(instant: Date): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: STAFF_TIME_ZONE,
    weekday: "short",
  }).format(instant);
  return weekday === "Sun";
}

/**
 * 由客戶訊息瞬間計到回覆期限。
 * 23:00–09:00 香港時間唔計。期限長度睇計時真正開始嗰刻係星期幾。
 * 跑緊嘅鐘去到 23:00 會停，09:00 帶住剩餘時間繼續。
 * notBefore：上線前已送到的訊息由生效瞬間重新計，唔計之前等咗幾耐。
 * 生效瞬間如果喺夜晚窗，一樣推到 09:00。上線後的新訊息唔使傳 notBefore。
 */
export function computeReplyDeadline(inboundAt: Date, notBefore?: Date): ReplyDeadline {
  const anchor = notBefore && inboundAt.getTime() < notBefore.getTime() ? notBefore : inboundAt;
  const countStart = nextCountedInstant(anchor);
  const limitSeconds = isSundayHkt(countStart) ? REPLY_SLA_SUNDAY_SECONDS : REPLY_SLA_WEEKDAY_SECONDS;
  let cursor = countStart.getTime();
  let remainingMs = limitSeconds * 1000;
  for (let guard = 0; guard < 8; guard += 1) {
    const pause = sameDayPause(new Date(cursor)).getTime();
    const openMs = pause - cursor;
    if (openMs <= 0) {
      cursor = nextCountedInstant(new Date(cursor + 1000)).getTime();
      continue;
    }
    if (remainingMs <= openMs) {
      return { countStart, due: new Date(cursor + remainingMs), limitSeconds };
    }
    remainingMs -= openMs;
    cursor = nextCountedInstant(new Date(pause)).getTime();
  }
  throw new Error("回覆期限計唔完");
}
