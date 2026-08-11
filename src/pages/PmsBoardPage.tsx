import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, RefreshCw, X } from "lucide-react";
import { PmsApiStatusCards } from "@/components/pms/PmsApiStatusCards";
import {
  PmsHousekeepingDialog,
  type PmsHkRequestChoice,
} from "@/components/pms/PmsHousekeepingDialog";
import { SearchField } from "@/components/ui/SearchField";
import { useHotelRoomInventory } from "@/lib/hotelRooms";
import { evaluatePmsApiHealth } from "@/lib/pmsApiHealth";
import {
  buildPmsBoardFromInventory,
  evaluatePmsSyncFreshness,
  ezeeOccupancySortKey,
  ezeeOccBadgeClass,
  folioFromBoardRow,
  hkStatusBadgeClass,
  humanShortDate,
  PMS_ROW_TINT,
  PMS_STALE_SYNC_THRESHOLD_SEC,
  processSynxisOccupancy,
  rowColor,
  secondsAgo,
  stripEzeeSortKey,
  syncAgeClass,
  synxisOccBadgeClass,
  triggerPmsSync,
  usePmsBoard,
  usePmsBoardRealtime,
  usePmsRoomtypeCounts,
  usePmsSyncState,
} from "@/lib/pmsBoard";
import { requestPmsHousekeeping } from "@/lib/pmsHousekeeping";
import { HOUSEKEEPING_BOARD_KEY } from "@/lib/housekeeping";
import {
  DEFAULT_ROOMTYPE_TOTALS,
  PMS_BOARD_QUERY_KEY,
  PMS_SYNC_STATE_KEY,
  ROOM_TYPES,
  type PmsBoardRow,
  type PmsSoldBy,
  type PmsSyncRunResult,
} from "@/types/pmsBoard";

const PMS_SYNC_INTERVAL_MS = 10_000;

type SortKey =
  | "room_number"
  | "room_type"
  | "synxis_hk_status"
  | "synxis_ooo_code"
  | "synxis_occupancy"
  | "ezee_occupancy"
  | "merged_guest_name"
  | "merged_check_in_date"
  | "merged_check_out_date"
  | "folio";

type FilterState = {
  room_numbers: string[];
  synxis_hk: string[];
  synxis_ooo: string[];
  synxis_occ: string[];
  ezee_occ: string[];
  sold_by: PmsSoldBy[];
};

function guestNameClass(soldBy: PmsSoldBy | null): string {
  if (soldBy === "synxis") return "font-semibold text-rose-950 dark:text-rose-200";
  if (soldBy === "ezee") return "font-semibold text-blue-800 dark:text-sky-200";
  return "text-[var(--text-h)]";
}

function StatusBadge({
  label,
  badgeClass,
}: {
  label: string;
  badgeClass: string;
}) {
  if (!label) return null;
  if (!badgeClass) return <>{label}</>;
  return <span className={badgeClass}>{label}</span>;
}

function defaultFilter(roomNumbers: string[]): FilterState {
  return {
    room_numbers: roomNumbers,
    synxis_hk: ["Clean", "Dirty"],
    synxis_ooo: ["ooo", "functional"],
    synxis_occ: ["Vacant", "Occupied", "Reserved"],
    ezee_occ: ["Occupied", "Blocked", "Vacant"],
    sold_by: ["synxis", "ezee", "neither"],
  };
}

function matchesFilter(row: PmsBoardRow, f: FilterState): boolean {
  if (!f.room_numbers.includes(row.room_number)) return false;

  const hk = row.synxis_hk_status;
  if (hk && !f.synxis_hk.includes(hk)) return false;

  const ooo = row.synxis_ooo_code;
  const isOoo = Boolean(ooo && ooo !== "~" && ooo !== "FD");
  if (isOoo && !f.synxis_ooo.includes("ooo")) return false;
  if (!isOoo && !f.synxis_ooo.includes("functional")) return false;

  const sOcc = row.synxis_occupancy;
  if (sOcc) {
    const sOccOk =
      f.synxis_occ.includes(sOcc) ||
      (f.synxis_occ.includes("Occupied") && sOcc === "Reserved");
    if (!sOccOk) return false;
  }

  const eOcc = row.ezee_occupancy;
  if (eOcc && !f.ezee_occ.includes(eOcc)) return false;

  if (row.sold_by && !f.sold_by.includes(row.sold_by)) return false;

  return true;
}

type EnrichedPmsRow = PmsBoardRow & {
  folio: number | null;
  color: ReturnType<typeof rowColor>;
  ezee_sort: string;
};

function rowSearchHaystack(row: EnrichedPmsRow): string {
  const parts = [
    row.room_number,
    row.room_type,
    row.synxis_hk_status,
    row.synxis_ooo_code && row.synxis_ooo_code !== "~" ? row.synxis_ooo_code : "",
    processSynxisOccupancy(row.synxis_occupancy),
    row.synxis_occupancy,
    stripEzeeSortKey(row.ezee_occupancy),
    row.ezee_occupancy,
    row.merged_guest_name,
    row.synxis_guest_name,
    row.ezee_guest_name,
    humanShortDate(row.merged_check_in_date),
    humanShortDate(row.merged_check_out_date),
    row.merged_check_in_date,
    row.merged_check_out_date,
    row.folio != null ? String(row.folio) : "",
    row.sold_by,
  ];
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function matchesSearch(row: EnrichedPmsRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return rowSearchHaystack(row).includes(q);
}

function AvailabilityModal({
  open,
  onClose,
  counters,
}: {
  open: boolean;
  onClose: () => void;
  counters: Array<{ label: string; values: Record<string, number> }>;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-[var(--text-h)]">Availability</h2>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
        <table className="mt-4 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] bg-emerald-600/90 text-white">
              <th className="px-3 py-2 text-left font-semibold" />
              {ROOM_TYPES.map((t) => (
                <th key={t} className="px-3 py-2 text-center font-semibold">
                  {t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {counters.map((row) => (
              <tr key={row.label} className="border-b border-[var(--border)]">
                <td className="px-3 py-2 font-medium text-[var(--text-h)]">{row.label}</td>
                {ROOM_TYPES.map((t) => (
                  <td key={t} className="px-3 py-2 text-center tabular-nums">
                    {row.values[t] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PmsBoardPage() {
  const queryClient = useQueryClient();
  const inventoryQuery = useHotelRoomInventory();
  const boardQuery = usePmsBoard();
  const syncQuery = usePmsSyncState();
  const countsQuery = usePmsRoomtypeCounts();
  usePmsBoardRealtime();

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [sortBy, setSortBy] = useState<SortKey>("room_number");
  const [sortAsc, setSortAsc] = useState(true);
  const [showAvailability, setShowAvailability] = useState(false);
  const [filter, setFilter] = useState<FilterState | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<PmsSyncRunResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const syncInFlight = useRef(false);
  const [selectedRooms, setSelectedRooms] = useState<string[]>([]);
  const [hkDialogOpen, setHkDialogOpen] = useState(false);
  const [hkRequestStatus, setHkRequestStatus] = useState<PmsHkRequestChoice>(0);
  const [hkBusy, setHkBusy] = useState(false);
  const [hkError, setHkError] = useState<string | null>(null);
  const [hkMessage, setHkMessage] = useState<string | null>(null);

  const closeHkDialog = useCallback(() => {
    setHkDialogOpen(false);
    setHkError(null);
    setHkRequestStatus(0);
  }, []);

  const clearHkSelection = useCallback(() => {
    setSelectedRooms([]);
    setHkRequestStatus(0);
    setHkError(null);
    setHkDialogOpen(false);
  }, []);

  const toggleRoomSelection = useCallback((roomNumber: string, checked: boolean) => {
    setShowAvailability(false);
    setHkMessage(null);
    setHkError(null);
    const key = roomNumber.trim();
    setSelectedRooms((prev) =>
      checked
        ? prev.includes(key)
          ? prev
          : [...prev, key]
        : prev.filter((r) => r !== key),
    );
  }, []);

  const sendHousekeepingRequest = useCallback(async () => {
    if (hkRequestStatus === 0 || selectedRooms.length === 0) return;
    setHkBusy(true);
    setHkError(null);
    setHkMessage(null);
    const status = hkRequestStatus === 2 ? "clean" : "dirty";
    const result = await requestPmsHousekeeping({
      roomNumbers: selectedRooms,
      status,
    });
    if (!result.ok || result.error) {
      setHkError(result.error ?? "Failed to send housekeeping request.");
      setHkBusy(false);
      return;
    }
    setHkMessage(result.message);
    clearHkSelection();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: PMS_BOARD_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: HOUSEKEEPING_BOARD_KEY }),
      queryClient.invalidateQueries({ queryKey: ["room-operational-status-map"] }),
    ]);
    setHkBusy(false);
  }, [clearHkSelection, hkRequestStatus, queryClient, selectedRooms]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearHkSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearHkSelection]);

  const roomNumbers = inventoryQuery.data ?? [];

  const runPmsSyncJob = useCallback(async () => {
    if (syncInFlight.current) return;
    syncInFlight.current = true;
    setSyncing(true);
    try {
      const result = await triggerPmsSync();
      setLastSync(result);
      setSyncError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: PMS_BOARD_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: PMS_SYNC_STATE_KEY }),
        queryClient.invalidateQueries({ queryKey: ["pms-roomtype-counts"] }),
      ]);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "PMS sync failed");
    } finally {
      syncInFlight.current = false;
      setSyncing(false);
    }
  }, [queryClient]);

  useEffect(() => {
    void runPmsSyncJob();
    const id = window.setInterval(() => void runPmsSyncJob(), PMS_SYNC_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [runPmsSyncJob]);

  useEffect(() => {
    if (roomNumbers.length && !filter) {
      setFilter(defaultFilter(roomNumbers));
    }
  }, [roomNumbers, filter]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const inventoryConfigured = !inventoryQuery.isLoading && roomNumbers.length > 0;

  const baseRows = useMemo(() => {
    if (!inventoryConfigured) return [];
    return buildPmsBoardFromInventory(roomNumbers, boardQuery.data ?? []);
  }, [inventoryConfigured, roomNumbers, boardQuery.data]);

  const enriched = useMemo(() => {
    return baseRows.map((row) => ({
      ...row,
      folio: folioFromBoardRow(row),
      color: rowColor(row),
      ezee_sort: ezeeOccupancySortKey(row.ezee_occupancy),
    }));
  }, [baseRows]);

  const afterColumnFilter = useMemo(() => {
    if (!filter) return enriched;
    return enriched.filter((r) => matchesFilter(r, filter));
  }, [enriched, filter]);

  const visible = useMemo(() => {
    if (!searchQuery.trim()) return afterColumnFilter;
    return afterColumnFilter.filter((r) => matchesSearch(r, searchQuery));
  }, [afterColumnFilter, searchQuery]);

  const sorted = useMemo(() => {
    const dir = sortAsc ? 1 : -1;
    return [...visible].sort((a, b) => {
      let av: string | number | null;
      let bv: string | number | null;
      switch (sortBy) {
        case "room_number":
          av = parseInt(a.room_number, 10);
          bv = parseInt(b.room_number, 10);
          break;
        case "folio":
          av = a.folio;
          bv = b.folio;
          break;
        case "ezee_occupancy":
          av = a.ezee_sort;
          bv = b.ezee_sort;
          break;
        default:
          av = (a[sortBy] as string | null) ?? "";
          bv = (b[sortBy] as string | null) ?? "";
      }
      if (av == null && bv == null) return 0;
      if (av == null) return dir;
      if (bv == null) return -dir;
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return 0;
    });
  }, [visible, sortBy, sortAsc]);

  const visibleRoomNumbers = useMemo(() => sorted.map((r) => r.room_number), [sorted]);

  const allVisibleSelected =
    visibleRoomNumbers.length > 0 &&
    visibleRoomNumbers.every((r) => selectedRooms.includes(r));

  const someVisibleSelected =
    visibleRoomNumbers.some((r) => selectedRooms.includes(r)) && !allVisibleSelected;

  const toggleSelectAllVisible = useCallback(
    (checked: boolean) => {
      setShowAvailability(false);
      setHkMessage(null);
      setHkError(null);
      setSelectedRooms((prev) => {
        if (checked) {
          return [...new Set([...prev, ...visibleRoomNumbers])];
        }
        return prev.filter((r) => !visibleRoomNumbers.includes(r));
      });
    },
    [visibleRoomNumbers],
  );

  const availabilityCounters = useMemo(() => {
    const total = { ...DEFAULT_ROOMTYPE_TOTALS };
    const ooo: Record<string, number> = {};
    const occupied: Record<string, number> = {};
    for (const t of ROOM_TYPES) {
      ooo[t] = 0;
      occupied[t] = 0;
    }
    for (const row of enriched) {
      const rt = row.room_type ?? "";
      if (!ROOM_TYPES.includes(rt as (typeof ROOM_TYPES)[number])) continue;
      const code = row.synxis_ooo_code;
      if (code && code !== "~" && code !== "FD") {
        ooo[rt] = (ooo[rt] ?? 0) + 1;
      }
    }
    const syncTotals = countsQuery.data?.totals;
    for (const t of ROOM_TYPES) {
      occupied[t] = syncTotals?.[t] ?? 0;
    }
    const available: Record<string, number> = {};
    for (const t of ROOM_TYPES) {
      available[t] = (total[t] ?? 0) - (ooo[t] ?? 0) - (occupied[t] ?? 0);
    }
    return [
      { label: "Total", values: total },
      { label: "Out of Order", values: ooo },
      { label: "Reserved", values: occupied },
      { label: "Available", values: available },
    ];
  }, [enriched, countsQuery.data]);

  const toggleSort = useCallback((key: SortKey) => {
    setSortBy((prev) => {
      if (prev === key) {
        setSortAsc((d) => !d);
        return prev;
      }
      setSortAsc(true);
      return key;
    });
  }, []);

  const clearFilter = useCallback(() => {
    if (roomNumbers.length) setFilter(defaultFilter(roomNumbers));
  }, [roomNumbers]);

  const synxisAgo = secondsAgo(syncQuery.data?.synxis?.synced_at, nowMs);
  const synxisSource = syncQuery.data?.synxis?.source ?? null;
  const ezeeAgo = secondsAgo(
    syncQuery.data?.ezee?.synced_at ?? (lastSync?.ezee.ok ? lastSync.at : null),
    nowMs,
  );
  const syncFreshness = useMemo(
    () => evaluatePmsSyncFreshness(syncQuery.data, lastSync, nowMs),
    [syncQuery.data, lastSync, nowMs],
  );
  const apiHealth = useMemo(
    () =>
      evaluatePmsApiHealth(
        enriched,
        syncQuery.data,
        roomNumbers.length || enriched.length,
      ),
    [enriched, syncQuery.data, roomNumbers.length],
  );
  const synxisIssue = syncFreshness.issues.find((i) => i.system === "SynXis");
  const synxisFailed = Boolean(synxisIssue);
  const ezeeFailed = Boolean(lastSync && !lastSync.ezee.ok);
  const synxisFailMsg = synxisIssue?.detail ?? null;
  const ezeeFailMsg = ezeeFailed ? (lastSync?.ezee.error ?? "Failed") : null;
  const hotelDate = syncQuery.data?.synxis?.hotel_date;
  const totalRooms = roomNumbers.length || sorted.length;
  const filteredCount = sorted.length;
  const hasActiveSearch = Boolean(searchQuery.trim());
  const columnFiltersActive = afterColumnFilter.length !== enriched.length;
  const showingSubset = filteredCount !== totalRooms;

  const thClass = (key: SortKey) =>
    [
      "cursor-pointer select-none px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide",
      sortBy === key ? "bg-[var(--accent-muted-strong)] text-[var(--accent)]" : "bg-[var(--surface-2)]",
    ].join(" ");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-[var(--accent)]" aria-hidden />
            <h1 className="page-title">Dual PMS</h1>
          </div>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Side-by-side SynXis and eZee room status. Keys tab uses the same operational status
            table.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary inline-flex items-center gap-2"
          disabled={syncing}
          onClick={() => void runPmsSyncJob()}
        >
          <RefreshCw className={`h-4 w-4 ${syncing || boardQuery.isFetching ? "animate-spin" : ""}`} />
          {syncing ? "Syncing…" : "Refresh"}
        </button>
      </div>

      {!syncing && syncFreshness.anyStale ? (
        <div
          className="flex items-start gap-3 rounded-lg border-2 border-red-500 bg-red-50 px-4 py-3 text-sm text-red-950 shadow-sm dark:border-red-400 dark:bg-red-950/40 dark:text-red-100"
          role="alert"
          aria-live="assertive"
        >
          <Activity className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              PMS sync stale — data may be outdated (threshold: {PMS_STALE_SYNC_THRESHOLD_SEC}s)
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs sm:text-sm">
              {syncFreshness.issues.map((issue) => (
                <li key={issue.system}>
                  <strong>{issue.system}:</strong> {issue.detail}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs opacity-90">
              Stale means the VPS bridge (PM2) has not copied data to Supabase recently — not an eZee API
              failure. Settings → eZee <strong>Test connection</strong> checks the cloud API separately.
              Settings → <strong>DualPMS VPS bridge</strong> shows PM2 heartbeat.
            </p>
          </div>
        </div>
      ) : null}

      {!syncing && syncFreshness.fallbackActive ? (
        <div
          className="flex items-start gap-3 rounded-lg border-2 border-amber-500 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-sm dark:border-amber-400 dark:bg-amber-950/40 dark:text-amber-100"
          role="status"
          aria-live="polite"
        >
          <Activity className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Backup mode: API fallback active</p>
            <p className="mt-1 text-xs opacity-90">
              DualPMS upstream poll is stale on the VPS. The bridge is fetching live data via SynXis
              cookie / script login and/or eZee API instead of Postgres.
            </p>
            {syncFreshness.warnings.length ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                {syncFreshness.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}

      {!syncing && !syncFreshness.fallbackActive && syncFreshness.warnings.length ? (
        <div
          className="flex items-start gap-3 rounded-lg border border-amber-400/60 bg-amber-50/80 px-4 py-3 text-sm text-amber-950 dark:border-amber-600/40 dark:bg-amber-950/30 dark:text-amber-100"
          role="status"
        >
          <ul className="list-disc space-y-1 pl-5 text-xs">
            {syncFreshness.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {totalRooms > 0 ? <PmsApiStatusCards health={apiHealth} /> : null}

      <ul className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-[var(--text)]">
        <li>
          SynXis:{" "}
          {synxisFailed ? (
            <span className="text-red-700 dark:text-red-300">{synxisFailMsg}</span>
          ) : (
            <>
              <span className={syncAgeClass(synxisAgo)}>
                {synxisAgo != null ? String(synxisAgo).padStart(2, "0") : "—"}
              </span>{" "}
              seconds ago ({synxisSource && synxisSource !== "dualpms_vps" ? `fallback: ${synxisSource}` : "VPS bridge"})
              {synxisAgo != null && synxisAgo > PMS_STALE_SYNC_THRESHOLD_SEC ? " (stale)" : null}
            </>
          )}
        </li>
        <li>
          eZee:{" "}
          {ezeeFailed ? (
            <span className="text-red-700 dark:text-red-300">{ezeeFailMsg}</span>
          ) : (
            <>
              <span className={syncAgeClass(ezeeAgo)}>
                {ezeeAgo != null ? String(ezeeAgo).padStart(2, "0") : "—"}
              </span>{" "}
              seconds ago (VPS bridge)
              {ezeeAgo != null && ezeeAgo > PMS_STALE_SYNC_THRESHOLD_SEC ? " (stale)" : null}
            </>
          )}
        </li>
        {syncQuery.data?.ezee?.dualpms_polled_at ? (
          <li className="text-xs text-[var(--text-muted)]">
            DualPMS VPS eZee poll:{" "}
            {(() => {
              const pollAgo = secondsAgo(syncQuery.data.ezee?.dualpms_polled_at, nowMs);
              if (pollAgo == null) return "—";
              return pollAgo > 120
                ? `${pollAgo}s ago (slow — normal if DualPMS polls eZee every few minutes)`
                : `${pollAgo}s ago`;
            })()}
          </li>
        ) : null}
        <li>Hotel date: {humanShortDate(hotelDate) || "—"}</li>
        <li>
          <button
            type="button"
            className="text-[var(--accent)] hover:underline"
            onClick={() => {
              clearHkSelection();
              setShowAvailability(true);
            }}
          >
            Availability
          </button>
        </li>
        <li className={showingSubset ? "text-amber-600" : ""}>
          Showing {filteredCount}/{totalRooms}
        </li>
        {hasActiveSearch ? (
          <li>
            <button
              type="button"
              className="text-[var(--accent)] hover:underline"
              onClick={() => setSearchQuery("")}
            >
              Clear search
            </button>
          </li>
        ) : null}
        {columnFiltersActive ? (
          <li>
            <button type="button" className="text-[var(--accent)] hover:underline" onClick={clearFilter}>
              Clear filters
            </button>
          </li>
        ) : null}
      </ul>

      {syncError ? (
        <div className="rounded-lg border border-amber-400/60 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-600/50 dark:bg-amber-950/30 dark:text-amber-100">
          <strong>PMS sync:</strong> {syncError}
        </div>
      ) : synxisAgo == null && ezeeAgo == null && !syncing ? (
        <div className="rounded-lg border border-amber-400/60 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-600/50 dark:bg-amber-950/30 dark:text-amber-100">
          <strong>No PMS data yet.</strong> The board lists rooms from inventory; SynXis and eZee
          columns fill in after the sync job succeeds. Check diagnostics below if this persists.
        </div>
      ) : null}

      {lastSync && (!lastSync.synxis.ok || !lastSync.ezee.ok || lastSync.error) ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text)]">
          <p className="font-medium text-[var(--text-h)]">Last sync diagnostics</p>
          <ul className="mt-2 space-y-1 text-[var(--text-muted)]">
            <li>
              SynXis:{" "}
              {lastSync.synxis.ok
                ? `OK via DualPMS Postgres (${lastSync.synxis.rooms ?? 0} rooms in DB)`
                : lastSync.synxis.error ?? "VPS bridge not running"}
            </li>
            <li>
              eZee:{" "}
              {lastSync.ezee.ok
                ? `OK (${lastSync.ezee.rooms ?? 0} rooms)`
                : lastSync.ezee.error ?? "Failed"}
            </li>
            {lastSync.upserted != null ? <li>Database rows written: {lastSync.upserted}</li> : null}
            {lastSync.error ? <li>Database: {lastSync.error}</li> : null}
          </ul>
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            Room data is copied from DualPMS Postgres on the VPS by PM2 (
            <code className="font-mono text-[11px]">bridge/</code>). See Settings → DualPMS VPS bridge.
          </p>
        </div>
      ) : null}

      {boardQuery.isError ? (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100">
          {(boardQuery.error as Error).message}
          <p className="mt-2 text-xs opacity-90">
            If columns are missing, run the Dual PMS SQL migration on Supabase first.
          </p>
        </div>
      ) : null}

      {hkMessage ? (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-100">
          {hkMessage}
        </div>
      ) : null}

      {selectedRooms.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--accent-border)] bg-[var(--accent)]/10 px-4 py-2.5 text-sm">
          <span className="font-medium text-[var(--text-h)]">
            {selectedRooms.length} room{selectedRooms.length === 1 ? "" : "s"} selected
          </span>
          <button type="button" className="btn-primary" onClick={() => setHkDialogOpen(true)}>
            Mark clean / dirty
          </button>
          <button type="button" className="btn-secondary" onClick={clearHkSelection}>
            Clear selection
          </button>
          <span className="text-xs text-[var(--text-muted)]">Escape clears selection</span>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-[var(--border)]">
        <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
          <div className="min-w-0 max-w-md flex-1">
            <SearchField
              className="w-full"
              placeholder="Search room, guest, type, status…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search Dual PMS board"
            />
          </div>
          {hasActiveSearch ? (
            <button
              type="button"
              className="icon-btn shrink-0"
              aria-label="Clear search"
              onClick={() => setSearchQuery("")}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
        <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="w-10 px-1 py-2 text-center text-xs font-semibold text-[var(--text-muted)]">
                <input
                  type="checkbox"
                  aria-label="Select all visible rooms"
                  checked={allVisibleSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someVisibleSelected;
                  }}
                  onChange={(e) => toggleSelectAllVisible(e.target.checked)}
                />
              </th>
              <th className={thClass("room_number")} onClick={() => toggleSort("room_number")}>
                No.
              </th>
              <th className={thClass("room_type")} onClick={() => toggleSort("room_type")}>
                Type
              </th>
              <th className={thClass("synxis_hk_status")} onClick={() => toggleSort("synxis_hk_status")}>
                HK
              </th>
              <th className={thClass("synxis_ooo_code")} onClick={() => toggleSort("synxis_ooo_code")}>
                OOO
              </th>
              <th className={thClass("synxis_occupancy")} onClick={() => toggleSort("synxis_occupancy")}>
                S. Occ.
              </th>
              <th className={thClass("ezee_occupancy")} onClick={() => toggleSort("ezee_occupancy")}>
                E. Occ.
              </th>
              <th className={thClass("merged_guest_name")} onClick={() => toggleSort("merged_guest_name")}>
                Guest Name
              </th>
              <th className={thClass("merged_check_in_date")} onClick={() => toggleSort("merged_check_in_date")}>
                CI
              </th>
              <th className={thClass("merged_check_out_date")} onClick={() => toggleSort("merged_check_out_date")}>
                CO
              </th>
              <th className={thClass("folio")} onClick={() => toggleSort("folio")}>
                F. Bal.
              </th>
            </tr>
          </thead>
          <tbody>
            {inventoryQuery.isLoading ? (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-[var(--text-muted)]">
                  Loading room list…
                </td>
              </tr>
            ) : !inventoryConfigured ? (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-[var(--text-muted)]">
                  No rooms in inventory. Add rooms under Admin → Settings, then run the PMS sync job
                  for live SynXis / eZee data.
                </td>
              </tr>
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-[var(--text-muted)]">
                  {hasActiveSearch
                    ? "No rooms match your search."
                    : "No rooms match the current filters."}
                </td>
              </tr>
            ) : (
              sorted.map((row) => (
                <tr
                  key={row.room_number}
                  className={`border-b border-[var(--border)] ${PMS_ROW_TINT[row.color]} ${
                    selectedRooms.includes(row.room_number)
                      ? "outline outline-2 -outline-offset-2 outline-[var(--accent)]"
                      : ""
                  }`}
                >
                  <td className="px-1 py-1.5 text-center">
                    <input
                      type="checkbox"
                      aria-label={`Select room ${row.room_number}`}
                      checked={selectedRooms.includes(row.room_number)}
                      onChange={(e) => toggleRoomSelection(row.room_number, e.target.checked)}
                    />
                  </td>
                  <td className="px-2 py-1.5 text-center font-mono text-[var(--text-h)]">
                    {row.room_number}
                  </td>
                  <td className="px-2 py-1.5 text-center text-[var(--text)]">
                    {row.room_type ?? "—"}
                  </td>
                  <td className="px-2 py-1.5 text-center text-[var(--text)]">
                    {row.synxis_hk_status ? (
                      <StatusBadge
                        label={row.synxis_hk_status}
                        badgeClass={hkStatusBadgeClass(row.synxis_hk_status)}
                      />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    {row.synxis_ooo_code && row.synxis_ooo_code !== "~" ? row.synxis_ooo_code : ""}
                  </td>
                  <td className="px-2 py-1.5 text-center text-[var(--text)]">
                    <StatusBadge
                      label={processSynxisOccupancy(row.synxis_occupancy)}
                      badgeClass={synxisOccBadgeClass(row.synxis_occupancy)}
                    />
                  </td>
                  <td className="px-2 py-1.5 text-center text-[var(--text)]">
                    <StatusBadge
                      label={stripEzeeSortKey(row.ezee_occupancy)}
                      badgeClass={ezeeOccBadgeClass(row.ezee_occupancy)}
                    />
                  </td>
                  <td className={`px-2 py-1.5 text-center ${guestNameClass(row.sold_by)}`}>
                    {row.merged_guest_name ?? ""}
                  </td>
                  <td className="px-2 py-1.5 text-center text-[var(--text)]">
                    {humanShortDate(row.merged_check_in_date)}
                  </td>
                  <td className="px-2 py-1.5 text-center text-[var(--text)]">
                    {humanShortDate(row.merged_check_out_date)}
                  </td>
                  <td className="px-2 py-1.5 text-center tabular-nums text-[var(--text-h)]">
                    {row.folio ?? ""}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </div>
      </div>

      <PmsHousekeepingDialog
        open={hkDialogOpen}
        selectedCount={selectedRooms.length}
        requestStatus={hkRequestStatus}
        busy={hkBusy}
        error={hkError}
        onRequestStatusChange={setHkRequestStatus}
        onClose={closeHkDialog}
        onSend={() => void sendHousekeepingRequest()}
      />

      <AvailabilityModal
        open={showAvailability}
        onClose={() => setShowAvailability(false)}
        counters={availabilityCounters}
      />
    </div>
  );
}
