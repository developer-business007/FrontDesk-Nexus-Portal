import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { FunctionsFetchError, FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import {
  emptyPmsBoardRow,
  PMS_BOARD_QUERY_KEY,
  PMS_SYNC_STATE_KEY,
  PMS_STALE_SYNC_THRESHOLD_SEC,
  DUALPMS_UPSTREAM_STALE_SEC,
  type PmsBoardRow,
  type PmsRoomtypeCounts,
  type PmsSyncFreshness,
  type PmsSyncRunResult,
  type PmsSyncState,
} from "@/types/pmsBoard";

export { PMS_STALE_SYNC_THRESHOLD_SEC, DUALPMS_UPSTREAM_STALE_SEC } from "@/types/pmsBoard";

const PMS_BOARD_SELECT = [
  "room_number",
  "room_type",
  "status",
  "synxis_hk_status",
  "synxis_occupancy",
  "synxis_ooo_code",
  "synxis_guest_name",
  "synxis_check_in_date",
  "synxis_check_out_date",
  "synxis_balance_cents",
  "ezee_hk_status",
  "ezee_occupancy",
  "ezee_guest_name",
  "ezee_check_in_date",
  "ezee_check_out_date",
  "ezee_balance_cents",
  "ezee_booking_status",
  "merged_guest_name",
  "merged_check_in_date",
  "merged_check_out_date",
  "merged_balance_cents",
  "sold_by",
  "synxis_synced_at",
  "ezee_synced_at",
  "pms_updated_at",
].join(", ");

export async function fetchPmsBoardRows(): Promise<PmsBoardRow[]> {
  const { data, error } = await supabase
    .from("room_operational_status")
    .select(PMS_BOARD_SELECT)
    .order("room_number", { ascending: true });

  if (error) {
    // PMS columns may not exist yet — still show inventory on the board.
    if (/column|schema cache|does not exist/i.test(error.message)) {
      return [];
    }
    throw new Error(error.message);
  }
  return (data ?? []) as unknown as PmsBoardRow[];
}

/** Keys-style board: every active inventory room, merged with PMS sync data when present. */
export function buildPmsBoardFromInventory(
  inventory: string[],
  pmsRows: PmsBoardRow[],
): PmsBoardRow[] {
  const byRoom = new Map<string, PmsBoardRow>();
  for (const row of pmsRows) {
    const rn = String(row.room_number ?? "").trim();
    if (rn) byRoom.set(rn, row);
  }
  return inventory.map((roomNumber) => byRoom.get(roomNumber) ?? emptyPmsBoardRow(roomNumber));
}

function parsePmsSyncRunResult(data: unknown): PmsSyncRunResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (typeof row.error === "string" && row.error && row.ok === false && !row.synxis && !row.ezee) {
    throw new Error(row.error);
  }
  if (typeof row.at === "string" && row.synxis && row.ezee) {
    return row as PmsSyncRunResult;
  }
  return null;
}

async function readPmsSyncFromHttpError(error: FunctionsHttpError): Promise<PmsSyncRunResult | null> {
  const response = error.context as Response | undefined;
  if (!response) return null;
  try {
    return parsePmsSyncRunResult(await response.json());
  } catch {
    return null;
  }
}

/** Calls the pms-sync edge function (SynXis + eZee → room_operational_status). */
export async function triggerPmsSync(): Promise<PmsSyncRunResult> {
  const { data, error } = await supabase.functions.invoke("pms-sync", { body: {} });
  if (!error) {
    const parsed = parsePmsSyncRunResult(data);
    if (parsed) return parsed;
    throw new Error("Invalid sync response from server");
  }

  if (error instanceof FunctionsHttpError) {
    const parsed = await readPmsSyncFromHttpError(error);
    if (parsed) return parsed;
  }

  if (error instanceof FunctionsFetchError || error.message.includes("Failed to send")) {
    throw new Error("PMS sync function not reachable. Deploy the pms-sync edge function to Supabase.");
  }

  throw new Error(error.message);
}

export async function fetchPmsSyncState(): Promise<PmsSyncState> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "pms_sync_state")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data?.value ?? {}) as PmsSyncState;
}

export async function fetchPmsRoomtypeCounts(): Promise<PmsRoomtypeCounts> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "pms_roomtype_counts")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data?.value ?? {}) as PmsRoomtypeCounts;
}

export function usePmsBoard() {
  return useQuery({
    queryKey: PMS_BOARD_QUERY_KEY,
    queryFn: fetchPmsBoardRows,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

export function usePmsSyncState() {
  return useQuery({
    queryKey: PMS_SYNC_STATE_KEY,
    queryFn: fetchPmsSyncState,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

export function usePmsRoomtypeCounts() {
  return useQuery({
    queryKey: ["pms-roomtype-counts"] as const,
    queryFn: fetchPmsRoomtypeCounts,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

export function usePmsBoardRealtime() {
  const qc = useQueryClient();
  const [channelName] = useState(
    () => `pms-board-rt-${Math.random().toString(36).slice(2, 10)}`,
  );

  useEffect(() => {
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_operational_status" },
        () => {
          void qc.invalidateQueries({ queryKey: PMS_BOARD_QUERY_KEY });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "app_settings" },
        () => {
          void qc.invalidateQueries({ queryKey: PMS_SYNC_STATE_KEY });
          void qc.invalidateQueries({ queryKey: ["pms-roomtype-counts"] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [channelName, qc]);
}

export function secondsAgo(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

function formatStaleAge(secondsAgo: number | null): string {
  if (secondsAgo == null) return "never synced";
  if (secondsAgo < 60) return `${secondsAgo}s ago`;
  const mins = Math.floor(secondsAgo / 60);
  const secs = secondsAgo % 60;
  return secs > 0 ? `${mins}m ${secs}s ago` : `${mins}m ago`;
}

/** True when SynXis/eZee snapshot is missing or older than threshold. */
export function evaluatePmsSyncFreshness(
  syncState: PmsSyncState | undefined,
  _lastSync: PmsSyncRunResult | null,
  nowMs: number,
  thresholdSec = PMS_STALE_SYNC_THRESHOLD_SEC,
  upstreamStaleSec = DUALPMS_UPSTREAM_STALE_SEC,
): PmsSyncFreshness {
  const synxisSecondsAgo = secondsAgo(syncState?.synxis?.synced_at, nowMs);
  const ezeeSecondsAgo = secondsAgo(syncState?.ezee?.synced_at, nowMs);
  const synxisPollAgo = secondsAgo(syncState?.synxis?.dualpms_polled_at, nowMs);
  const ezeePollAgo = secondsAgo(syncState?.ezee?.dualpms_polled_at, nowMs);

  const synxisSource = syncState?.synxis?.source ?? null;
  const ezeeSource = syncState?.ezee?.source ?? null;
  const synxisFallback =
    synxisSource != null && synxisSource !== "dualpms_vps";
  const ezeeFallback = ezeeSource != null && ezeeSource !== "dualpms_vps";
  const fallbackActive = synxisFallback || ezeeFallback;

  const issues: PmsSyncFreshness["issues"] = [];
  const warnings: string[] = [];

  if (synxisFallback) {
    const label =
      synxisSource === "cookie_backup"
        ? "extension browser cookie"
        : synxisSource === "synxis_api_credentials"
          ? "script login"
          : "API fallback";
    warnings.push(`SynXis: DualPMS upstream stale — data via ${label}`);
    issues.push({
      system: "SynXis",
      secondsAgo: synxisSecondsAgo,
      stale: false,
      reason: "fallback",
      detail: `Backup mode active (${label}) — DualPMS poll ${
        synxisPollAgo != null ? `${synxisPollAgo}s ago` : "never"
      }`,
    });
  }

  if (ezeeFallback) {
    warnings.push("eZee: DualPMS upstream stale — data via direct eZee API");
    issues.push({
      system: "eZee",
      secondsAgo: ezeeSecondsAgo,
      stale: false,
      reason: "fallback",
      detail: `Backup mode active (eZee API) — DualPMS poll ${
        ezeePollAgo != null ? `${ezeePollAgo}s ago` : "never"
      }`,
    });
  }

  if (synxisSecondsAgo == null) {
    issues.push({
      system: "SynXis",
      secondsAgo: null,
      stale: true,
      reason: "missing",
      detail: "VPS bridge not running — start PM2 on DualPMS server (see Settings → DualPMS VPS bridge)",
    });
  } else if (synxisSecondsAgo > thresholdSec) {
    issues.push({
      system: "SynXis",
      secondsAgo: synxisSecondsAgo,
      stale: true,
      reason: "stale",
      detail: `VPS bridge stale (${formatStaleAge(synxisSecondsAgo)} since last Supabase copy) — check PM2 on DualPMS server`,
    });
  } else if (
    !synxisFallback &&
    synxisPollAgo != null &&
    synxisPollAgo > upstreamStaleSec
  ) {
    warnings.push(
      `SynXis: DualPMS upstream poll stale (${formatStaleAge(synxisPollAgo)}) — bridge should switch to API fallback`,
    );
  }

  if (ezeeSecondsAgo == null) {
    issues.push({
      system: "eZee",
      secondsAgo: null,
      stale: true,
      reason: "missing",
      detail: "No eZee data in Supabase yet — start VPS bridge (PM2)",
    });
  } else if (ezeeSecondsAgo > thresholdSec) {
    issues.push({
      system: "eZee",
      secondsAgo: ezeeSecondsAgo,
      stale: true,
      reason: "stale",
      detail: `VPS bridge stale (${formatStaleAge(ezeeSecondsAgo)} since last Supabase copy) — check PM2 on DualPMS server`,
    });
  } else if (_lastSync && !_lastSync.ezee.ok) {
    issues.push({
      system: "eZee",
      secondsAgo: ezeeSecondsAgo,
      stale: true,
      reason: "failed",
      detail: _lastSync.ezee.error ?? "Sync failed",
    });
  } else if (!ezeeFallback && ezeePollAgo != null && ezeePollAgo > upstreamStaleSec) {
    warnings.push(
      `eZee: DualPMS upstream poll stale (${formatStaleAge(ezeePollAgo)}) — bridge should switch to API fallback`,
    );
  }

  return {
    synxisSecondsAgo,
    ezeeSecondsAgo,
    issues: issues.filter((i) => i.stale),
    warnings,
    anyStale: issues.some((i) => i.stale),
    fallbackActive,
  };
}

export function syncAgeClass(secondsAgo: number | null, thresholdSec = PMS_STALE_SYNC_THRESHOLD_SEC): string {
  if (secondsAgo == null) return "text-red-600 dark:text-red-400 font-semibold";
  if (secondsAgo > thresholdSec) return "text-red-600 dark:text-red-400 font-semibold";
  if (secondsAgo > 30) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

export function humanShortDate(d: string | null | undefined): string {
  if (!d) return "";
  const monthNames: Record<string, string> = {
    "01": "Jan",
    "02": "Feb",
    "03": "Mar",
    "04": "Apr",
    "05": "May",
    "06": "Jun",
    "07": "Jul",
    "08": "Aug",
    "09": "Sep",
    "10": "Oct",
    "11": "Nov",
    "12": "Dec",
  };
  const month = d.slice(5, 7);
  const day = d.slice(8, 10);
  return `${monthNames[month] ?? month} ${day}`;
}

export function parsePmsCents(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function folioFromCents(cents: unknown): number | null {
  const normalized = parsePmsCents(cents);
  if (normalized === 0) return 0;
  if (normalized == null) return null;
  return normalized / 100;
}

export function resolveBalanceCents(
  row: Pick<PmsBoardRow, "merged_balance_cents" | "synxis_balance_cents" | "ezee_balance_cents">,
): number | null {
  const merged = parsePmsCents(row.merged_balance_cents);
  if (merged != null) return merged;
  const synxis = parsePmsCents(row.synxis_balance_cents);
  if (synxis != null) return synxis;
  return parsePmsCents(row.ezee_balance_cents);
}

export function folioFromBoardRow(row: PmsBoardRow): number | null {
  return folioFromCents(resolveBalanceCents(row));
}

export type PmsRowColor = "reddish" | "greenish" | "grayish" | "whitish" | "";

export function rowColor(row: PmsBoardRow): PmsRowColor {
  const sOcc = row.synxis_occupancy;
  const eOcc = row.ezee_occupancy;
  if (sOcc === "Occupied" || sOcc === "Reserved") return "reddish";
  if (eOcc === "Occupied") return "reddish";
  if (sOcc === "Vacant" && eOcc === "Vacant" && row.synxis_hk_status === "Dirty") {
    return "grayish";
  }
  if (sOcc === "Vacant" && eOcc === "Vacant" && row.synxis_hk_status === "Clean") {
    return "greenish";
  }
  const ooo = row.synxis_ooo_code;
  if (ooo && ooo !== "FD" && ooo !== "~") return "whitish";
  return "";
}

export const PMS_ROW_TINT: Record<PmsRowColor, string> = {
  // Light: pastel row wash (DualPMS-style). Dark: neutral row + left accent only — badges stay readable.
  reddish:
    "bg-red-100/80 dark:bg-[var(--surface)] dark:border-l-[3px] dark:border-l-rose-500",
  greenish:
    "bg-emerald-200/90 dark:bg-green-600/38 dark:border-l-[4px] dark:border-l-green-400 dark:shadow-[inset_0_0_0_1px_rgba(74,222,128,0.3)]",
  grayish:
    "bg-amber-100/60 dark:bg-[var(--surface)] dark:border-l-[3px] dark:border-l-amber-500",
  whitish:
    "bg-[var(--surface-2)] dark:bg-[var(--surface-2)] dark:border-l-[3px] dark:border-l-zinc-500",
  "": "dark:bg-[var(--surface)] dark:border-l-[3px] dark:border-l-transparent",
};

const STATUS_BADGE =
  "inline-block min-w-[3.25rem] rounded px-1.5 py-0.5 text-[11px] font-bold leading-tight border border-transparent";

function statusBadge(light: string, dark: string): string {
  return `${STATUS_BADGE} ${light} ${dark}`;
}

export function hkStatusBadgeClass(status: string | null): string {
  if (status === "Clean") {
    return statusBadge(
      "bg-emerald-500/20 text-emerald-900",
      "dark:bg-green-500 dark:text-zinc-950 dark:border-green-300 dark:shadow-[0_0_10px_rgba(34,197,94,0.35)]",
    );
  }
  if (status === "Dirty") {
    return statusBadge(
      "bg-amber-500/25 text-amber-950",
      "dark:bg-amber-600 dark:text-white dark:border-amber-400/50",
    );
  }
  return "";
}

export function synxisOccBadgeClass(occupancy: string | null): string {
  const label = processSynxisOccupancy(occupancy);
  if (label === "Occupied" || occupancy === "Occupied") {
    return statusBadge(
      "bg-rose-500/20 text-rose-900",
      "dark:bg-rose-600 dark:text-white dark:border-rose-400/50",
    );
  }
  if (label === "Arriving" || occupancy === "Reserved") {
    return statusBadge(
      "bg-violet-500/20 text-violet-900",
      "dark:bg-violet-600 dark:text-white dark:border-violet-400/50",
    );
  }
  if (label === "Vacant" || occupancy === "Vacant") {
    return statusBadge(
      "bg-zinc-500/15 text-zinc-700",
      "dark:bg-zinc-700 dark:text-zinc-100 dark:border-zinc-500/60",
    );
  }
  return "";
}

export function ezeeOccBadgeClass(occupancy: string | null): string {
  const label = stripEzeeSortKey(occupancy);
  if (label === "Occupied") {
    return statusBadge(
      "bg-rose-500/20 text-rose-900",
      "dark:bg-rose-600 dark:text-white dark:border-rose-400/50",
    );
  }
  if (label === "Blocked") {
    return statusBadge(
      "bg-orange-500/25 text-orange-950",
      "dark:bg-orange-600 dark:text-white dark:border-orange-400/50",
    );
  }
  if (label === "Vacant") {
    return statusBadge(
      "bg-zinc-500/15 text-zinc-700",
      "dark:bg-zinc-700 dark:text-zinc-100 dark:border-zinc-500/60",
    );
  }
  return "";
}

export function processSynxisOccupancy(o: string | null): string {
  if (o === "Reserved") return "Arriving";
  return o ?? "";
}

export function ezeeOccupancySortKey(o: string | null): string {
  if (o === "Occupied") return "1_Occupied";
  if (o === "Blocked") return "2_Blocked";
  if (o === "Vacant") return "3_Vacant";
  return "9_" + (o ?? "");
}

export function stripEzeeSortKey(o: string | null): string {
  return (o ?? "").replace(/^1_|^2_|^3_/, "");
}
