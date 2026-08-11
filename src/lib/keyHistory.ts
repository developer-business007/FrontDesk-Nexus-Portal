import type { KeyHistoryRow } from "@/types/database";
import { addDaysLocal } from "@/lib/date";

/** Prefer explicit encode time when present; otherwise `created_at`. */
export function keyHistoryEventTime(row: KeyHistoryRow): string {
  return row.encoded_at ?? row.created_at ?? "";
}

export function keyHistoryNights(row: KeyHistoryRow): number | null {
  if (typeof row.nights_encoded === "number") return row.nights_encoded;
  if (typeof row.number_of_nights === "number") return row.number_of_nights;
  return null;
}

export function keyHistoryAgent(row: KeyHistoryRow): string | null {
  return (
    row.encoded_by_username ??
    row.agent_username ??
    row.encoded_by ??
    null
  );
}

export function keyHistoryCheckin(row: KeyHistoryRow): string | null {
  const v = row.checkin_time;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function keyHistoryCheckout(row: KeyHistoryRow): string | null {
  const v = row.checkout_time;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function keyHistoryGuestName(row: KeyHistoryRow): string | null {
  const v = row.guest_name;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const COMPACT_12 = /^\d{12}$/;
const LOCALE_MEDIUM_SHORT: Intl.DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "short",
};

/** Parse encoder `YYYYMMDDHHmm` (12 digits) as **local** wall time. */
function tryParseCompactYmdHmLocal(raw: string): Date | null {
  const t = raw.trim();
  if (!COMPACT_12.test(t)) return null;
  const y = Number(t.slice(0, 4));
  const mo = Number(t.slice(4, 6));
  const d = Number(t.slice(6, 8));
  const h = Number(t.slice(8, 10));
  const mi = Number(t.slice(10, 12));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const dt = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  if (dt.getHours() !== h || dt.getMinutes() !== mi) return null;
  return dt;
}

/**
 * Encoder compact `YYYYMMDDHHmm` (12 digits) → locale **medium date + short time**
 * (e.g. `May 4, 2026, 2:00 PM` in `en-US`). Returns `null` if invalid.
 */
export function formatKeyHistoryCompactYmdHm(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const dt = tryParseCompactYmdHmLocal(value);
  if (!dt) return null;
  return new Intl.DateTimeFormat(undefined, LOCALE_MEDIUM_SHORT).format(dt);
}

/**
 * Tight format for table cells: `5/14 12:24 AM`. Drops the year + the long month name
 * so IN / OUT columns stay narrow when the room detail panel is visible on the right.
 */
const LOCALE_SHORT_NUMERIC: Intl.DateTimeFormatOptions = {
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

export function formatKeyHistoryShortYmdHm(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const t = value.trim();
  const dt = tryParseCompactYmdHmLocal(t);
  if (dt) return new Intl.DateTimeFormat(undefined, LOCALE_SHORT_NUMERIC).format(dt);
  const parsed = new Date(t);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, LOCALE_SHORT_NUMERIC).format(parsed);
}

/** ISO / RFC date-time from DB → same locale style as compact key times. */
export function formatKeyHistoryLocaleDateTime(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const d = new Date(value.trim());
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, LOCALE_MEDIUM_SHORT).format(d);
}

/**
 * Normalize encoder / PMS date strings to YYYY-MM-DD as observed in the **browser's
 * local timezone** (i.e. the user's PC date). Critical so an encode shows on the
 * same UI date the user sees on their OS clock — never silently UTC-shifted.
 */
export function parseKeyHistoryDay(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const t = value.trim();
  const compactDt = tryParseCompactYmdHmLocal(t);
  if (compactDt) {
    const y = compactDt.getFullYear();
    const mo = String(compactDt.getMonth() + 1).padStart(2, "0");
    const d = String(compactDt.getDate()).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }
  const iso = t.slice(0, 10);
  if (DATE_ONLY.test(iso)) return iso;
  const parsed = new Date(t);
  if (Number.isNaN(parsed.getTime())) return null;
  const y = parsed.getFullYear();
  const mo = String(parsed.getMonth() + 1).padStart(2, "0");
  const d = String(parsed.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/**
 * Hotel night-audit rule passed in from `useHotelSettings()`. When supplied, every
 * timestamp on the row is mapped to the **business date** it belongs to (i.e. encodes
 * before `cutoffHour` in `timezone` count as the previous night) before comparing
 * with `businessDate`. Without it, the function falls back to plain calendar-date math.
 */
export type BusinessDayContext = {
  /** IANA timezone of the hotel (e.g. `America/Chicago`). */
  timezone: string;
  /** Hour 0–23; an encode strictly before this hour belongs to the previous business day. */
  cutoffHour: number;
};

/**
 * YYYY-MM-DD that the given timestamp belongs to under the hotel's night-audit rule.
 *
 * - Encoder compact `YYYYMMDDHHmm` → wall-clock parts are taken as hotel-local
 *   (the encoder runs on the hotel's terminal), so we just split the digits.
 * - ISO/RFC 3339 → converted to the hotel timezone via `Intl` first.
 * - When `ctx` is omitted we degrade to {@link parseKeyHistoryDay}.
 */
export function timestampBusinessDate(
  value: string | null | undefined,
  ctx?: BusinessDayContext,
): string | null {
  if (!value?.trim()) return null;
  const t = value.trim();

  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})\d{2}$/.exec(t);
  if (compact) {
    const cal = `${compact[1]}-${compact[2]}-${compact[3]}`;
    if (!ctx) return cal;
    const hour = parseInt(compact[4]!, 10);
    return hour < ctx.cutoffHour ? addDaysLocal(cal, -1) : cal;
  }

  if (!ctx) return parseKeyHistoryDay(value);

  const dt = new Date(t);
  if (Number.isNaN(dt.getTime())) return null;

  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: ctx.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(dt);
    const get = (k: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === k)?.value ?? "";
    const y = get("year");
    const mo = get("month");
    const d = get("day");
    let h = get("hour");
    if (h === "24") h = "00";
    const cal = `${y}-${mo}-${d}`;
    return parseInt(h, 10) < ctx.cutoffHour ? addDaysLocal(cal, -1) : cal;
  } catch {
    return parseKeyHistoryDay(value);
  }
}

/**
 * Row appears on the room board for `businessDate` (stay overlap or encode / insert day).
 *
 * When `ctx` is provided, **all** timestamps on the row are first mapped to the
 * hotel's business date so a 12:30 AM CST encode on May 14 still shows on May 13's
 * board (cutoff 9 AM). Without `ctx` it falls back to plain calendar-date matching.
 */
export function keyHistoryVisibleOnBusinessDate(
  row: KeyHistoryRow,
  businessDate: string,
  ctx?: BusinessDayContext,
): boolean {
  const cin = timestampBusinessDate(keyHistoryCheckin(row), ctx);
  const cout = timestampBusinessDate(keyHistoryCheckout(row), ctx);
  if (cin && cout && cin <= businessDate && cout >= businessDate) return true;
  if (cin && !cout && cin <= businessDate) return true;

  const created = timestampBusinessDate(row.created_at ?? undefined, ctx);
  if (created === businessDate) return true;
  const encoded = timestampBusinessDate(row.encoded_at ?? undefined, ctx);
  if (encoded === businessDate) return true;

  const event = timestampBusinessDate(keyHistoryEventTime(row), ctx);
  if (event === businessDate) return true;

  return false;
}
