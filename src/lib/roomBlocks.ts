import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { addDaysLocal } from "@/lib/date";
import {
  getZonedParts,
  instantAtHotelWallClock,
  type HotelSettings,
} from "@/lib/hotelSettings";

/**
 * Maintenance block for a room. While a block is "active" the encode modal refuses
 * to write new keys for that room.
 */
export type RoomBlock = {
  id: string;
  room_number: string;
  /** ISO timestamp; `null` means "block indefinitely". */
  blocked_until: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: string;
  /** Set when an admin manually released the block. */
  released_at: string | null;
  released_by: string | null;
  /**
   * When true (created while guest was still in-room): full encode block applies once the room
   * is vacant; until checkout/move away, only the current board occupant confirmation may encode
   * additional keys for this room (replacement keys during stay).
   */
  effective_from_vacancy?: boolean | null;
};

const ROOM_BLOCKS_QUERY_KEY = ["room-blocks-active"] as const;

export function isActiveBlock(block: RoomBlock, now: Date = new Date()): boolean {
  if (block.released_at) return false;
  if (!block.blocked_until) return true;
  return new Date(block.blocked_until).getTime() > now.getTime();
}

/** True if this block was saved as "apply full maintenance once the room is vacant". */
export function isDeferredMaintenanceBlock(block: RoomBlock | null | undefined): boolean {
  return Boolean(block?.effective_from_vacancy);
}

export type EncodeBlockCheckContext = {
  /** Confirmation currently shown as in-house on the room board for this room (today's business view). */
  roomOccupantConfirmation: string | null;
  /** Confirmation we are encoding for (walk-ins / unsaved reservations use `null` until created). */
  encodeConfirmation?: string | null;
};

/**
 * Whether an active maintenance block forbids portal encode for `(room)` in context.
 *
 * Immediate blocks (`effective_from_vacancy` false): always forbid.
 * Deferred blocks while someone is listed on the board: forbid unless `encodeConfirmation` matches
 * the board occupant (replacement keys during stay).
 * Deferred + vacant board row: forbid all encodes.
 */
export function isRoomBlockBlockingEncode(
  block: RoomBlock | null | undefined,
  ctx: EncodeBlockCheckContext,
  now?: Date,
): boolean {
  if (!block || !isActiveBlock(block, now ?? new Date())) return false;
  if (!isDeferredMaintenanceBlock(block)) return true;

  const occ = ctx.roomOccupantConfirmation?.trim() || null;
  if (!occ) return true;

  const enc = ctx.encodeConfirmation?.trim() || "";
  return enc !== occ;
}

/**
 * Map of `room_number -> active RoomBlock`. Re-evaluates expiry every 30s so blocks
 * disappear from the UI as soon as `blocked_until` is in the past. Realtime keeps the
 * underlying row list fresh when admins block/release from another tab.
 *
 * If the `room_blocks` table doesn't exist yet (migration not run) the hook returns
 * an empty map without throwing — the feature simply stays disabled.
 */
export function useActiveRoomBlocks(): {
  byRoom: Map<string, RoomBlock>;
  isLoading: boolean;
  error: Error | null;
} {
  const qc = useQueryClient();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const q = useQuery({
    queryKey: ROOM_BLOCKS_QUERY_KEY,
    staleTime: 30_000,
    queryFn: async (): Promise<RoomBlock[]> => {
      const { data, error } = await supabase
        .from("room_blocks")
        .select("*")
        .is("released_at", null);
      if (error) {
        // eslint-disable-next-line no-console
        console.warn("[room-blocks] load failed:", error.message);
        return [];
      }
      return (data ?? []) as RoomBlock[];
    },
  });

  // Unique channel name per hook instance — multiple mounts (board + modal) must not
  // share a channel, or `.on()` after `.subscribe()` will throw.
  const [channelName] = useState(
    () => `room-blocks-realtime-${Math.random().toString(36).slice(2, 10)}`,
  );
  useEffect(() => {
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_blocks" },
        () => {
          void qc.invalidateQueries({ queryKey: ROOM_BLOCKS_QUERY_KEY });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [qc, channelName]);

  const byRoom = useMemo(() => {
    const m = new Map<string, RoomBlock>();
    for (const b of q.data ?? []) {
      if (!isActiveBlock(b, now)) continue;
      const cur = m.get(b.room_number);
      if (!cur || new Date(b.created_at).getTime() > new Date(cur.created_at).getTime()) {
        m.set(b.room_number, b);
      }
    }
    return m;
  }, [q.data, now]);

  return {
    byRoom,
    isLoading: q.isLoading,
    error: (q.error as Error | null) ?? null,
  };
}

export type BlockDurationKind = "unlimited" | "hours" | "days" | "months" | "until_date";

export type BlockDuration =
  | { kind: "unlimited" }
  | { kind: "hours"; value: number }
  | { kind: "days"; value: number }
  | { kind: "months"; value: number }
  | { kind: "until_date"; date: string };

/**
 * Returns an ISO timestamp the block should expire at, or `null` for "unlimited".
 *
 * Day-granularity rules (when `settings` is provided):
 * - "Days N"      → lifts at the **business-day cutoff hour** (e.g. 09:00) in the
 *                   hotel's timezone, N calendar days from today's hotel date.
 *                   So "block for 2 days" at 3 PM today → ends 09:00 the day-after-tomorrow.
 * - "Months N"    → same idea, but N calendar months out.
 * - "Until date"  → ends at the cutoff hour on the day **after** the picked date
 *                   (the picked day is fully blocked, room frees up at next 9 AM).
 * - "Hours N"     → strict `now + N hours` (sub-day granularity is taken literally).
 * - "Unlimited"   → null.
 *
 * Without `settings`, falls back to naive math (used by tests / non-React callers).
 */
export function computeBlockedUntil(
  duration: BlockDuration,
  settings: HotelSettings | null = null,
  now: Date = new Date(),
): string | null {
  switch (duration.kind) {
    case "unlimited":
      return null;

    case "hours":
      return new Date(now.getTime() + Math.max(1, duration.value) * 3_600_000).toISOString();

    case "days": {
      const n = Math.max(1, Math.floor(duration.value));
      if (!settings) {
        return new Date(now.getTime() + n * 86_400_000).toISOString();
      }
      const z = getZonedParts(now, settings.timezone);
      const baseCal = `${z.year}-${String(z.month).padStart(2, "0")}-${String(z.day).padStart(2, "0")}`;
      const targetCal = addDaysLocal(baseCal, n);
      const dt = instantAtHotelWallClock(targetCal, settings.businessDayCutoffHour, 0, settings.timezone);
      return dt.toISOString();
    }

    case "months": {
      const n = Math.max(1, Math.floor(duration.value));
      if (!settings) {
        const d = new Date(now);
        d.setMonth(d.getMonth() + n);
        return d.toISOString();
      }
      const z = getZonedParts(now, settings.timezone);
      const targetMonth = z.month - 1 + n;
      const targetYear = z.year + Math.floor(targetMonth / 12);
      const monthIdx = ((targetMonth % 12) + 12) % 12;
      // Clamp day-of-month so Feb 30 → Feb 28/29 etc.
      const lastDayOfMonth = new Date(targetYear, monthIdx + 1, 0).getDate();
      const day = Math.min(z.day, lastDayOfMonth);
      const targetCal = `${targetYear}-${String(monthIdx + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const dt = instantAtHotelWallClock(targetCal, settings.businessDayCutoffHour, 0, settings.timezone);
      return dt.toISOString();
    }

    case "until_date": {
      if (!duration.date.match(/^\d{4}-\d{2}-\d{2}$/)) return null;
      if (!settings) {
        const m = duration.date.match(/^(\d{4})-(\d{2})-(\d{2})$/)!;
        const d = new Date(
          parseInt(m[1]!, 10),
          parseInt(m[2]!, 10) - 1,
          parseInt(m[3]!, 10),
          23,
          59,
          59,
        );
        return d.toISOString();
      }
      // Picked date is fully blocked; lift at the cutoff hour on the *next* day.
      const liftCal = addDaysLocal(duration.date, 1);
      const dt = instantAtHotelWallClock(liftCal, settings.businessDayCutoffHour, 0, settings.timezone);
      return dt.toISOString();
    }
  }
}

export async function createRoomBlock(params: {
  roomNumber: string;
  blockedUntil: string | null;
  reason: string | null;
  userId: string;
  effectiveFromVacancy?: boolean;
}): Promise<{ error: Error | null; id: string | null }> {
  const { data, error } = await supabase
    .from("room_blocks")
    .insert({
      room_number: params.roomNumber.trim(),
      blocked_until: params.blockedUntil,
      reason: params.reason?.trim() ? params.reason.trim() : null,
      created_by: params.userId,
      effective_from_vacancy: params.effectiveFromVacancy === true,
    })
    .select("id")
    .maybeSingle();
  return {
    error: error ? new Error(error.message) : null,
    id: ((data ?? null) as { id?: string } | null)?.id ?? null,
  };
}

export async function releaseRoomBlock(params: {
  id: string;
  userId: string;
}): Promise<{ error: Error | null }> {
  const { error } = await supabase
    .from("room_blocks")
    .update({
      released_at: new Date().toISOString(),
      released_by: params.userId,
    })
    .eq("id", params.id);
  return { error: error ? new Error(error.message) : null };
}

/** "Blocked until Wed, May 15 11:00 AM" / "Blocked indefinitely". */
export function formatBlockSummary(block: RoomBlock, tz?: string): string {
  if (isDeferredMaintenanceBlock(block)) {
    if (!block.blocked_until) {
      return "Maintenance block — full room lock once vacant (no end date)";
    }
    try {
      return `Maintenance when vacant — until ${new Intl.DateTimeFormat(undefined, {
        timeZone: tz,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(block.blocked_until))}`;
    } catch {
      return `Maintenance when vacant — until ${block.blocked_until}`;
    }
  }

  if (!block.blocked_until) return "Blocked indefinitely";
  try {
    return `Blocked until ${new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(block.blocked_until))}`;
  } catch {
    return `Blocked until ${block.blocked_until}`;
  }
}

/** Compact label for the table — "BLOCKED · 2d left" / "BLOCKED · ∞". */
export function formatBlockBadge(block: RoomBlock, now: Date = new Date()): string {
  if (isDeferredMaintenanceBlock(block)) {
    if (!block.blocked_until) return "MAINT · after guest";
    const ms = new Date(block.blocked_until).getTime() - now.getTime();
    if (ms <= 0) return "MAINT";
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `MAINT · after guest · ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `MAINT · after guest · ${hours}h`;
    const days = Math.floor(hours / 24);
    return `MAINT · after guest · ${days}d`;
  }

  if (!block.blocked_until) return "BLOCKED · ∞";
  const ms = new Date(block.blocked_until).getTime() - now.getTime();
  if (ms <= 0) return "BLOCKED";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `BLOCKED · ${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `BLOCKED · ${hours}h left`;
  const days = Math.floor(hours / 24);
  return `BLOCKED · ${days}d left`;
}

/** "Mon, May 13, 9:45 PM CST" — formatted timestamp in the hotel timezone. */
export function formatBlockTimestamp(iso: string | null, tz?: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
