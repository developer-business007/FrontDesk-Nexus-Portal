import { formatPmsSourceLabel } from "@/lib/bridgeStatus";
import type { PmsBoardRow, PmsSyncState } from "@/types/pmsBoard";

export type PmsApiHealthStatus = "ok" | "partial" | "failed" | "unknown";

export type PmsSystemApiHealth = {
  system: "SynXis" | "eZee";
  status: PmsApiHealthStatus;
  source: string | null;
  sourceLabel: string;
  roomsWithOccupancy: number;
  roomsWithHk: number;
  roomsPopulated: number;
  inventoryRooms: number;
  roomsFromApi: number | null;
  staleRoomsUsed: number | null;
  detail: string;
};

export type PmsApiHealthSnapshot = {
  synxis: PmsSystemApiHealth;
  ezee: PmsSystemApiHealth;
};

type StoredApiStats = {
  status?: string;
  rooms_from_api?: number;
  rooms_with_occupancy?: number;
  rooms_with_hk?: number;
  inventory_rooms?: number;
  stale_rooms_used?: number;
  detail?: string;
};

function parseStoredStatus(value: string | undefined): PmsApiHealthStatus {
  if (value === "ok" || value === "partial" || value === "failed") return value;
  return "unknown";
}

function countBoardFields(
  rows: PmsBoardRow[],
  system: "synxis" | "ezee",
): { occupancy: number; hk: number; populated: number } {
  let occupancy = 0;
  let hk = 0;
  let populated = 0;
  for (const row of rows) {
    const occ = system === "synxis" ? row.synxis_occupancy : row.ezee_occupancy;
    const hkVal = system === "synxis" ? row.synxis_hk_status : row.ezee_hk_status;
    if (occ) occupancy += 1;
    if (hkVal) hk += 1;
    if (occ || hkVal) populated += 1;
  }
  return { occupancy, hk, populated };
}

function deriveStatusFromCounts(
  populated: number,
  inventory: number,
  stored: StoredApiStats | undefined,
): PmsApiHealthStatus {
  if (stored?.status === "ok" || stored?.status === "partial" || stored?.status === "failed") {
    return stored.status;
  }
  if (inventory <= 0) return "unknown";
  if (populated === 0) return "failed";
  if (populated < inventory * 0.85) return "partial";
  return "ok";
}

function buildSystemHealth(
  system: "SynXis" | "eZee",
  source: string | null | undefined,
  stored: StoredApiStats | undefined,
  boardCounts: { occupancy: number; hk: number; populated: number },
  inventoryRooms: number,
): PmsSystemApiHealth {
  const sourceLabel = formatPmsSourceLabel(source ?? null);
  const status = deriveStatusFromCounts(boardCounts.populated, inventoryRooms, stored);

  const roomsFromApi =
    typeof stored?.rooms_from_api === "number" ? stored.rooms_from_api : null;
  const staleRoomsUsed =
    typeof stored?.stale_rooms_used === "number" ? stored.stale_rooms_used : null;

  let detail =
    typeof stored?.detail === "string" && stored.detail.trim()
      ? stored.detail.trim()
      : `${system} on board: ${boardCounts.populated}/${inventoryRooms} rooms have data`;

  if (status === "partial" || status === "failed") {
    const occLabel = system === "SynXis" ? "S.OCC" : "E.OCC";
    detail = `${boardCounts.occupancy}/${inventoryRooms} rooms with ${occLabel}`;
    if (roomsFromApi != null && roomsFromApi < inventoryRooms) {
      detail += ` · API returned ${roomsFromApi}/${inventoryRooms}`;
    }
    if (staleRoomsUsed && staleRoomsUsed > 0) {
      detail += ` · ${staleRoomsUsed} from stale Postgres`;
    }
    if (typeof stored?.detail === "string" && stored.detail.trim()) {
      detail = stored.detail.trim();
    }
  }

  return {
    system,
    status: stored?.status ? parseStoredStatus(stored.status) : status,
    source: source ?? null,
    sourceLabel,
    roomsWithOccupancy: boardCounts.occupancy,
    roomsWithHk: boardCounts.hk,
    roomsPopulated: boardCounts.populated,
    inventoryRooms,
    roomsFromApi,
    staleRoomsUsed,
    detail,
  };
}

export function evaluatePmsApiHealth(
  rows: PmsBoardRow[],
  syncState: PmsSyncState | undefined,
  inventoryRooms: number,
): PmsApiHealthSnapshot {
  const synxisBoard = countBoardFields(rows, "synxis");
  const ezeeBoard = countBoardFields(rows, "ezee");

  const synxisStored = syncState?.synxis?.api as StoredApiStats | undefined;
  const ezeeStored = syncState?.ezee?.api as StoredApiStats | undefined;

  return {
    synxis: buildSystemHealth(
      "SynXis",
      syncState?.synxis?.source,
      synxisStored,
      synxisBoard,
      inventoryRooms,
    ),
    ezee: buildSystemHealth(
      "eZee",
      syncState?.ezee?.source,
      ezeeStored,
      ezeeBoard,
      inventoryRooms,
    ),
  };
}

export function apiHealthStatusClass(status: PmsApiHealthStatus): string {
  switch (status) {
    case "ok":
      return "border-emerald-500/50 bg-emerald-50/80 text-emerald-950 dark:border-emerald-600/40 dark:bg-emerald-950/30 dark:text-emerald-100";
    case "partial":
      return "border-amber-500/50 bg-amber-50/80 text-amber-950 dark:border-amber-600/40 dark:bg-amber-950/30 dark:text-amber-100";
    case "failed":
      return "border-red-500/50 bg-red-50/80 text-red-950 dark:border-red-600/40 dark:bg-red-950/30 dark:text-red-100";
    default:
      return "border-[var(--border)] bg-[var(--surface-2)]/60 text-[var(--text)]";
  }
}

export function apiHealthBadgeClass(status: PmsApiHealthStatus): string {
  switch (status) {
    case "ok":
      return "bg-emerald-600 text-white";
    case "partial":
      return "bg-amber-600 text-white";
    case "failed":
      return "bg-red-600 text-white";
    default:
      return "bg-[var(--surface-3)] text-[var(--text-muted)]";
  }
}

export function apiHealthStatusLabel(status: PmsApiHealthStatus): string {
  switch (status) {
    case "ok":
      return "OK";
    case "partial":
      return "Partial";
    case "failed":
      return "Failed";
    default:
      return "Unknown";
  }
}
