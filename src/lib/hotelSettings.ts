import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { addDaysLocal } from "@/lib/date";
import {
  clampSeniorRecommendAge,
  DEFAULT_SENIOR_RECOMMEND_SETTINGS,
  parseSeniorPreferredFloors,
  sanitizeSeniorRoomList,
} from "@/lib/seniorRoomRecommend";

/**
 * Random suffix so multiple components mounting the same hook (e.g. board + modal)
 * each get their own Supabase realtime channel. Sharing a channel name across
 * subscribers throws "cannot add multiple 'postgres_changes' callbacks after subscribe()".
 */
function randomChannelSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Hotel-wide runtime settings. Persisted in `public.app_settings` under `key = 'hotel'`
 * as a JSONB blob so adding new fields never needs a column migration.
 *
 * The defaults reflect a typical US property in Central Time with a 9 AM night-audit cutoff
 * (matches Ankit's requirement) and an 11:00 hotel-wide check-out.
 */
export type HotelSettings = {
  /** IANA timezone of the hotel's local clock. Used to compute "now" + business date. */
  timezone: string;
  /**
   * Hour of day (0–23) in `timezone` when the business day rolls over.
   * Encodes happening BEFORE this hour count as the previous business day.
   * Default 9 → a guest arriving at 2 AM is still on yesterday's night.
   */
  businessDayCutoffHour: number;
  /** Default departure / key-expiry clock time, "HH:MM" 24h. */
  defaultCheckoutTime: string;
  /** Days between scheduled full cleans per stayover room (PMS task sync). Default 90 in DB if unset. */
  deepCleanIntervalDays?: number;
  /** Comma/space/range-separated room list; saved to DB via `hk_sync_rooms_from_text` on Settings save. */
  roomList: string;
  /**
   * Minimum age (whole years) to rent a room. Extension shows an underage warning when scanned DOB
   * is below this. Set to `0` to disable the check.
   */
  minimumCheckInAge: number;
  /**
   * Maximum guest balance (whole dollars) before key encoding is blocked in the extension.
   * -1 = disabled (no balance check). 0 = require zero balance.
   */
  maxAllowedBalance: number;
  /**
   * Manager PIN to override key-encoding blocks (check-in status or balance).
   * Empty string = override disabled.
   */
  managerOverridePin: string;
  /**
   * Minutes of inactivity before the portal and extension are automatically signed out.
   * 0 = disabled (never auto-logout). Default 480 (8 hours).
   */
  autoLogoutMinutes: number;
  /** Hotel identity & contact — used in PDF exports (Guest Profile, Cash Deposit Receipt). */
  hotelName: string;
  hotelAddress: string;
  hotelCity: string;
  hotelState: string;
  hotelZip: string;
  hotelPhone: string;
  hotelEmail: string;
  /** Cash deposit amount (USD) shown on the Cash Deposit Receipt PDF. */
  cashDepositAmount: number;
  /**
   * Emergency write access for all front desk accounts (extension Keys board):
   * allows Add guest + Move room without manager PIN until this ISO timestamp.
   * Null/empty = disabled.
   */
  frontDeskKeysWriteAccessUntil?: string | null;
  /** Default number of days for front desk manual keys (pre-fills checkout; still editable). */
  frontDeskDefaultKeyDays: number;
  /** When true, pre-fill checkout using {@link frontDeskDefaultKeyDays}. */
  frontDeskDefaultKeyDaysEnabled: boolean;
  /** When true, extension suggests senior-friendly vacant rooms after ID scan. */
  seniorRecommendEnabled: boolean;
  /** Minimum guest age (years) for senior room hints. 0 = disabled. */
  seniorRecommendAge: number;
  /** Preferred floors when no custom senior room list is set. */
  seniorPreferredFloors: number[];
  /** Optional room list overriding floor preference (accessible / ground-floor rooms). */
  seniorPreferredRoomList: string;
};

export const DEFAULT_HOTEL_SETTINGS: HotelSettings = {
  timezone: "America/Chicago",
  businessDayCutoffHour: 9,
  defaultCheckoutTime: "11:00",
  roomList: "",
  minimumCheckInAge: 18,
  maxAllowedBalance: -1,
  managerOverridePin: "",
  autoLogoutMinutes: 480,
  hotelName: "",
  hotelAddress: "",
  hotelCity: "",
  hotelState: "",
  hotelZip: "",
  hotelPhone: "",
  hotelEmail: "",
  cashDepositAmount: 100,
  frontDeskKeysWriteAccessUntil: null,
  frontDeskDefaultKeyDays: 1,
  frontDeskDefaultKeyDaysEnabled: true,
  ...DEFAULT_SENIOR_RECOMMEND_SETTINGS,
};

const HOTEL_SETTINGS_KEY = "hotel" as const;
const HOTEL_SETTINGS_QUERY_KEY = ["app-settings", HOTEL_SETTINGS_KEY] as const;

function clampHour(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_HOTEL_SETTINGS.businessDayCutoffHour;
  return Math.max(0, Math.min(23, Math.floor(n)));
}

function sanitizeHhmm(v: unknown): string {
  if (typeof v !== "string") return DEFAULT_HOTEL_SETTINGS.defaultCheckoutTime;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return DEFAULT_HOTEL_SETTINGS.defaultCheckoutTime;
  const h = Math.max(0, Math.min(23, parseInt(m[1]!, 10)));
  const mm = Math.max(0, Math.min(59, parseInt(m[2]!, 10)));
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function clampMinimumCheckInAge(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return DEFAULT_HOTEL_SETTINGS.minimumCheckInAge;
  }
  return Math.max(0, Math.min(99, Math.floor(n)));
}

function clampMaxAllowedBalance(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return -1;
  if (n < 0) return -1;
  return Math.round(n * 100) / 100;
}

function sanitizeManagerOverridePin(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, 32);
}

function clampAutoLogoutMinutes(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_HOTEL_SETTINGS.autoLogoutMinutes;
  if (n <= 0) return 0;
  return Math.round(Math.max(1, n));
}

function sanitizeTimezone(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) return DEFAULT_HOTEL_SETTINGS.timezone;
  const t = v.trim();
  try {
    // Round-trip through Intl to validate.
    new Intl.DateTimeFormat("en-US", { timeZone: t }).format(new Date());
    return t;
  } catch {
    return DEFAULT_HOTEL_SETTINGS.timezone;
  }
}

function sanitizeStr(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, 255);
}

function clampCashDeposit(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_HOTEL_SETTINGS.cashDepositAmount;
  return Math.max(0, Math.round(n * 100) / 100);
}

function clampFrontDeskKeyDays(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_HOTEL_SETTINGS.frontDeskDefaultKeyDays;
  return Math.max(1, Math.min(30, Math.floor(n)));
}

function sanitizeIsoOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function mergeWithDefaults(value: unknown): HotelSettings {
  const v = (value ?? {}) as Partial<HotelSettings>;
  return {
    timezone: sanitizeTimezone(v.timezone),
    businessDayCutoffHour: clampHour(v.businessDayCutoffHour ?? DEFAULT_HOTEL_SETTINGS.businessDayCutoffHour),
    defaultCheckoutTime: sanitizeHhmm(v.defaultCheckoutTime),
    roomList: typeof v.roomList === "string" ? v.roomList : "",
    minimumCheckInAge: clampMinimumCheckInAge(
      v.minimumCheckInAge ?? DEFAULT_HOTEL_SETTINGS.minimumCheckInAge,
    ),
    maxAllowedBalance: clampMaxAllowedBalance(v.maxAllowedBalance),
    managerOverridePin: sanitizeManagerOverridePin(v.managerOverridePin),
    autoLogoutMinutes: clampAutoLogoutMinutes(v.autoLogoutMinutes ?? DEFAULT_HOTEL_SETTINGS.autoLogoutMinutes),
    hotelName: sanitizeStr(v.hotelName),
    hotelAddress: sanitizeStr(v.hotelAddress),
    hotelCity: sanitizeStr(v.hotelCity),
    hotelState: sanitizeStr(v.hotelState),
    hotelZip: sanitizeStr(v.hotelZip),
    hotelPhone: sanitizeStr(v.hotelPhone),
    hotelEmail: sanitizeStr(v.hotelEmail),
    cashDepositAmount: clampCashDeposit(v.cashDepositAmount),
    frontDeskKeysWriteAccessUntil: sanitizeIsoOrNull(v.frontDeskKeysWriteAccessUntil),
    frontDeskDefaultKeyDays: clampFrontDeskKeyDays(v.frontDeskDefaultKeyDays),
    frontDeskDefaultKeyDaysEnabled: Boolean(
      (v as Record<string, unknown>).frontDeskDefaultKeyDaysEnabled ??
        DEFAULT_HOTEL_SETTINGS.frontDeskDefaultKeyDaysEnabled,
    ),
    seniorRecommendEnabled: Boolean(
      (v as Record<string, unknown>).seniorRecommendEnabled ??
        DEFAULT_HOTEL_SETTINGS.seniorRecommendEnabled,
    ),
    seniorRecommendAge: clampSeniorRecommendAge(
      (v as Record<string, unknown>).seniorRecommendAge ?? DEFAULT_HOTEL_SETTINGS.seniorRecommendAge,
    ),
    seniorPreferredFloors: parseSeniorPreferredFloors(
      (v as Record<string, unknown>).seniorPreferredFloors ??
        DEFAULT_HOTEL_SETTINGS.seniorPreferredFloors,
    ),
    seniorPreferredRoomList: sanitizeSeniorRoomList(
      (v as Record<string, unknown>).seniorPreferredRoomList,
    ),
  };
}

/**
 * Loads hotel settings from Supabase, falling back to {@link DEFAULT_HOTEL_SETTINGS}
 * when the `app_settings` table is absent or unreadable.
 *
 * Returns the resolved settings directly (never `undefined`) so callers can use it
 * synchronously without null-guards on first render.
 */
export function useHotelSettings(): HotelSettings {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: HOTEL_SETTINGS_QUERY_KEY,
    staleTime: 60_000,
    queryFn: async (): Promise<HotelSettings> => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", HOTEL_SETTINGS_KEY)
        .maybeSingle();
      if (error) {
        // Table might not exist yet on this deployment; swallow and fall back.
        // eslint-disable-next-line no-console
        console.warn("[hotelSettings] load failed:", error.message);
        return DEFAULT_HOTEL_SETTINGS;
      }
      return mergeWithDefaults(data?.value ?? {});
    },
  });

  // Realtime: any change to app_settings (e.g. another tab saved) invalidates the cache
  // so every page re-reads the new values without a manual refresh.
  const [channelName] = useState(() => `app-settings-realtime-${randomChannelSuffix()}`);
  useEffect(() => {
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "app_settings" },
        () => {
          void qc.invalidateQueries({ queryKey: HOTEL_SETTINGS_QUERY_KEY });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [qc, channelName]);

  return query.data ?? DEFAULT_HOTEL_SETTINGS;
}

export function useInvalidateHotelSettings(): () => void {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: HOTEL_SETTINGS_QUERY_KEY });
  }, [qc]);
}

export async function saveHotelSettings(value: HotelSettings): Promise<{ error: Error | null }> {
  const clean = mergeWithDefaults(value);
  const { error } = await supabase
    .from("app_settings")
    .upsert(
      {
        key: HOTEL_SETTINGS_KEY,
        value: clean,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
  return { error: error ? new Error(error.message) : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Timezone-aware helpers
// ─────────────────────────────────────────────────────────────────────────────

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

/** Read Y/M/D/H/m of `now` as observed in IANA `tz`. */
export function getZonedParts(now: Date, tz: string): ZonedParts {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const get = (k: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === k)?.value ?? "00";
    let hourStr = get("hour");
    // Some runtimes emit "24" for midnight under hour12:false; normalize to 00.
    if (hourStr === "24") hourStr = "00";
    return {
      year: parseInt(get("year"), 10),
      month: parseInt(get("month"), 10),
      day: parseInt(get("day"), 10),
      hour: parseInt(hourStr, 10),
      minute: parseInt(get("minute"), 10),
    };
  } catch {
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: now.getHours(),
      minute: now.getMinutes(),
    };
  }
}

/** Y/M/D portion of `getZonedParts` as `YYYY-MM-DD`. */
export function zonedDateString(now: Date, tz: string): string {
  const p = getZonedParts(now, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * Hotel business date at the moment `now`:
 * - If the current hour in `settings.timezone` is BEFORE `businessDayCutoffHour`,
 *   the business date is yesterday's calendar date (the "night" hasn't ended yet).
 * - Otherwise it is today's calendar date in the hotel's timezone.
 *
 * Example (cutoff = 9, tz = America/Chicago): at 02:30 CST on May 14 → "2026-05-13".
 */
export function currentBusinessDate(now: Date, settings: HotelSettings): string {
  const parts = getZonedParts(now, settings.timezone);
  const calendar = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  if (parts.hour < settings.businessDayCutoffHour) {
    return addDaysLocal(calendar, -1);
  }
  return calendar;
}

/** Same as {@link currentBusinessDate} but for "right now". */
export function currentBusinessDateNow(settings: HotelSettings): string {
  return currentBusinessDate(new Date(), settings);
}

/**
 * Convert a "wall-clock" hotel-local date+time (YYYY-MM-DD + HH:MM in `tz`) into the
 * exact UTC instant. Iterates twice to converge through DST transitions — the first
 * pass corrects for the standard offset, the second handles forward/backward DST.
 *
 * Example: instantAtHotelWallClock("2026-05-15", 9, 0, "America/Chicago")
 *   → exactly 09:00 CDT on May 15 2026 (== 14:00 UTC).
 */
function clampDateRangeStrings(from: string, to: string): { from: string; to: string } {
  if (!from || !to) return { from, to };
  if (from <= to) return { from, to };
  return { from: to, to: from };
}

/**
 * Inclusive hotel-local calendar range → UTC ISO bounds for `timestamptz` queries.
 * Uses Settings timezone so evening scans match the hotel's "today".
 */
export function hotelDateRangeToUtcIso(
  fromDate: string,
  toDate: string,
  timezone: string,
): { startIso: string; endIso: string } {
  const { from, to } = clampDateRangeStrings(fromDate, toDate);
  const start = instantAtHotelWallClock(from, 0, 0, timezone);
  const end = new Date(instantAtHotelWallClock(to, 23, 59, timezone).getTime() + 59_999);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export function instantAtHotelWallClock(
  ymd: string,
  hour: number,
  minute: number,
  tz: string,
): Date {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return new Date(NaN);
  const y = parseInt(m[1]!, 10);
  const mo = parseInt(m[2]!, 10);
  const d = parseInt(m[3]!, 10);
  let dt = new Date(Date.UTC(y, mo - 1, d, hour, minute));
  for (let i = 0; i < 2; i++) {
    const parts = getZonedParts(dt, tz);
    const drift =
      Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) -
      Date.UTC(y, mo - 1, d, hour, minute);
    if (drift === 0) break;
    dt = new Date(dt.getTime() - drift);
  }
  return dt;
}

/** "Sun, May 13, 9:45 AM CST" — formatted in the hotel's timezone. */
export function formatHotelLocaleString(now: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(now);
  } catch {
    return now.toString();
  }
}

/** A small curated list shown in the timezone picker on the Settings page. */
export const TIMEZONE_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "America/New_York", label: "America/New_York (Eastern)" },
  { value: "America/Chicago", label: "America/Chicago (Central)" },
  { value: "America/Denver", label: "America/Denver (Mountain)" },
  { value: "America/Phoenix", label: "America/Phoenix (Arizona, no DST)" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles (Pacific)" },
  { value: "America/Anchorage", label: "America/Anchorage (Alaska)" },
  { value: "Pacific/Honolulu", label: "Pacific/Honolulu (Hawaii)" },
  { value: "UTC", label: "UTC" },
];
