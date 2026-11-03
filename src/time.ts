/**
 * Staff-facing clocks.
 * The database keeps UTC text (`datetime('now')` / `YYYY-MM-DD HH:MM:SS`).
 * Pages and staff JSON render that instant in Asia/Hong_Kong.
 * 28car listing dates and board times are already Hong Kong wall clock from the site;
 * pass clock "hkt" so they are labeled, not shifted another eight hours.
 */

export const STAFF_TIME_ZONE = "Asia/Hong_Kong";

export type StoredClock = "utc" | "hkt";

export interface FormatStaffTimeOptions {
  /** Inbox UI adds 剛剛 / 分鐘前 / 昨天 from the Hong Kong calendar. API stays absolute. */
  relative?: boolean;
  now?: Date;
}

const NAIVE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

const UTC_KEYS = new Set([
  "created_at",
  "updated_at",
  "last_reply_at",
  "last_synced_at",
  "last_run_at",
]);

/** Already Hong Kong wall clock (28car page text), not UTC storage. */
const WALL_KEYS = new Set(["posted_at", "listing_updated_at"]);

function timeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return Math.round((asUtc - instant.getTime()) / 60000);
}

function wallToUtc(y: number, mo: number, d: number, hh: number, mm: number, ss: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(y, mo - 1, d, hh, mm, ss));
  const offset = timeZoneOffsetMinutes(guess, timeZone);
  const adjusted = new Date(guess.getTime() - offset * 60_000);
  const offset2 = timeZoneOffsetMinutes(adjusted, timeZone);
  if (offset2 === offset) return adjusted;
  return new Date(guess.getTime() - offset2 * 60_000);
}

export function hktParts(instant: Date): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: STAFF_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

export function hktDateKey(instant: Date): string {
  const p = hktParts(instant);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Absolute Hong Kong wall clock, `YYYY-MM-DD HH:mm:ss`. */
export function formatHktClock(instant: Date): string {
  const p = hktParts(instant);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** ISO-8601 with a fixed +08:00 offset for `<time datetime>`. */
export function formatHktIso(instant: Date): string {
  return `${formatHktClock(instant).replace(" ", "T")}+08:00`;
}

/**
 * Parse a stored timestamp into an absolute instant.
 * Date-only values (28car listing dates) are not instants and return null.
 * Strings that already carry `Z` or a numeric offset are absolute and ignore `clock`.
 */
export function parseStoredTimestamp(value: string, clock: StoredClock = "utc"): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const match = NAIVE_RE.exec(trimmed);
  if (!match || match[4] == null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] != null ? Number(match[6]) : 0;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  if (clock === "utc") return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return wallToUtc(year, month, day, hour, minute, second, STAFF_TIME_ZONE);
}

function calendarDayDiff(earlierKey: string, laterKey: string): number {
  const [ay, am, ad] = earlierKey.split("-").map(Number);
  const [by, bm, bd] = laterKey.split("-").map(Number);
  const earlier = Date.UTC(ay, am - 1, ad);
  const later = Date.UTC(by, bm - 1, bd);
  return Math.round((later - earlier) / 86_400_000);
}

/** Relative label from the Hong Kong calendar, empty when only the absolute time should show. */
export function relativeStaffLabel(instant: Date, now: Date = new Date()): string {
  const deltaMs = now.getTime() - instant.getTime();
  const future = deltaMs < 0;
  const absSec = Math.abs(Math.round(deltaMs / 1000));
  if (absSec < 45) return "剛剛";
  const absMin = Math.max(1, Math.round(absSec / 60));
  if (absMin < 60) return future ? `${absMin} 分鐘後` : `${absMin} 分鐘前`;

  const dayDelta = calendarDayDiff(hktDateKey(instant), hktDateKey(now));
  if (dayDelta === 0) {
    const hours = Math.max(1, Math.round(absSec / 3600));
    return future ? `${hours} 小時後` : `${hours} 小時前`;
  }
  if (dayDelta === 1) return "昨天";
  if (dayDelta === -1) return "明天";
  if (dayDelta > 1 && dayDelta < 30) return `${dayDelta} 日前`;
  if (dayDelta < -1 && dayDelta > -30) return `${-dayDelta} 日後`;
  return "";
}

/**
 * Human-readable staff time. Unparseable or date-only input is returned unchanged
 * so a 28car listing date is not turned into 08:00.
 */
export function formatStaffTimestamp(
  value: string | null | undefined,
  clock: StoredClock = "utc",
  options: FormatStaffTimeOptions = {}
): string {
  if (value == null) return "";
  const trimmed = String(value).trim();
  if (!trimmed) return "";
  const instant = parseStoredTimestamp(trimmed, clock);
  if (!instant) return trimmed;
  const absolute = `${formatHktClock(instant)} HKT`;
  if (!options.relative) return absolute;
  const relative = relativeStaffLabel(instant, options.now ?? new Date());
  return relative ? `${absolute}（${relative}）` : absolute;
}

/** Copy a staff JSON row and render known timestamp fields. Other fields stay as stored. */
export function presentStaffTimes<T extends object>(row: T, options: FormatStaffTimeOptions = {}): T {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    const value = out[key];
    if (typeof value !== "string" || !value.trim()) continue;
    if (UTC_KEYS.has(key)) out[key] = formatStaffTimestamp(value, "utc", options);
    else if (WALL_KEYS.has(key)) out[key] = formatStaffTimestamp(value, "hkt", options);
  }
  return out as T;
}
