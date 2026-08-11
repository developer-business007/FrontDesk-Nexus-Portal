import { ReservationStatus } from "@/lib/reservationStatus";
import { supabase } from "@/lib/supabase";
import { buildPmsBoardFromInventory, fetchPmsBoardRows, stripEzeeSortKey } from "@/lib/pmsBoard";
import type { PmsBoardRow } from "@/types/pmsBoard";

export type DashboardRoomStats = {
  totalRooms: number;
  occupiedRooms: number;
  vacantRooms: number;
  reservedRooms: number;
  outOfOrderRooms: number;
  dirtyRooms: number;
  cleanVacantRooms: number;
  occupancyPct: number | null;
  pmsRows: PmsBoardRow[];
  pmsByRoom: Map<string, PmsBoardRow>;
};

function normalizeOccupancy(value: string | null | undefined): string {
  return stripEzeeSortKey(value?.trim() ?? "");
}

/** True OOO — matches Dual PMS board row colors (`FD` and `~` are not OOO). */
export function isPmsRoomOutOfOrder(row: PmsBoardRow): boolean {
  const ooo = row.synxis_ooo_code?.trim();
  if (ooo && ooo !== "~" && ooo !== "FD") return true;
  const s = normalizeOccupancy(row.synxis_occupancy);
  const e = normalizeOccupancy(row.ezee_occupancy);
  if (s === "Blocked" || e === "Blocked") return true;
  return false;
}

/** Physical occupancy from DualPMS (SynXis + eZee). */
export function isPmsRoomOccupied(row: PmsBoardRow): boolean {
  const s = normalizeOccupancy(row.synxis_occupancy);
  const e = normalizeOccupancy(row.ezee_occupancy);
  if (s === "Occupied" || s === "Reserved") return true;
  if (e === "Occupied") return true;
  if (row.sold_by === "synxis" || row.sold_by === "ezee") return true;
  return false;
}

export function isPmsRoomReservedArriving(row: PmsBoardRow): boolean {
  return normalizeOccupancy(row.synxis_occupancy) === "Reserved";
}

export function isPmsRoomVacant(row: PmsBoardRow): boolean {
  if (isPmsRoomOccupied(row)) return false;
  if (isPmsRoomOutOfOrder(row)) return false;
  const s = normalizeOccupancy(row.synxis_occupancy);
  const e = normalizeOccupancy(row.ezee_occupancy);
  if (s === "Vacant" || e === "Vacant") return true;
  if (!s && !e) return false;
  return true;
}

export function isPmsRoomDirty(row: PmsBoardRow): boolean {
  const hk = row.synxis_hk_status ?? row.ezee_hk_status;
  return hk === "Dirty";
}

export function computeDashboardRoomStats(
  inventory: string[],
  pmsRows: PmsBoardRow[],
): DashboardRoomStats {
  const board = buildPmsBoardFromInventory(inventory, pmsRows);
  const totalRooms = board.length;

  let occupiedRooms = 0;
  let vacantRooms = 0;
  let reservedRooms = 0;
  let outOfOrderRooms = 0;
  let dirtyRooms = 0;
  let cleanVacantRooms = 0;

  for (const row of board) {
    if (isPmsRoomOccupied(row)) {
      occupiedRooms += 1;
      if (isPmsRoomReservedArriving(row)) reservedRooms += 1;
    } else if (isPmsRoomOutOfOrder(row)) {
      outOfOrderRooms += 1;
    } else if (isPmsRoomVacant(row)) {
      vacantRooms += 1;
      if (isPmsRoomDirty(row)) dirtyRooms += 1;
      else cleanVacantRooms += 1;
    }
  }

  const sellableRooms = Math.max(0, totalRooms - outOfOrderRooms);
  const occupancyPct =
    sellableRooms > 0
      ? Math.round((occupiedRooms / sellableRooms) * 100)
      : totalRooms > 0
        ? 0
        : null;

  const pmsByRoom = new Map(board.map((r) => [String(r.room_number).trim(), r]));

  return {
    totalRooms,
    occupiedRooms,
    vacantRooms,
    reservedRooms,
    outOfOrderRooms,
    dirtyRooms,
    cleanVacantRooms,
    occupancyPct,
    pmsRows: board,
    pmsByRoom,
  };
}

export async function fetchDashboardRoomStats(
  inventory: string[],
): Promise<DashboardRoomStats> {
  const pmsRows = await fetchPmsBoardRows();
  return computeDashboardRoomStats(inventory, pmsRows);
}

/** Short label for dashboard tables — SynXis primary, eZee fallback. */
export function formatPmsRoomStatus(row: PmsBoardRow | undefined): string {
  if (!row) return "—";
  if (isPmsRoomOutOfOrder(row)) {
    return row.synxis_ooo_code ? `OOO ${row.synxis_ooo_code}` : "OOO";
  }
  const occ = normalizeOccupancy(row.synxis_occupancy) || normalizeOccupancy(row.ezee_occupancy);
  const hk = row.synxis_hk_status ?? row.ezee_hk_status;
  if (!occ && !hk) return "—";
  if (occ && hk) return `${occ} · ${hk}`;
  return occ ?? hk ?? "—";
}

export function pmsGuestNameForRoom(row: PmsBoardRow | undefined): string | null {
  if (!row) return null;
  return row.merged_guest_name ?? row.synxis_guest_name ?? row.ezee_guest_name ?? null;
}

/** Prefer reservation guest name; fill room from PMS when reservation room is empty. */
export function mergeReservationRoomDisplay(
  reservationRoom: string | null,
  pmsRow: PmsBoardRow | undefined,
): string {
  if (reservationRoom) return reservationRoom;
  return pmsRow ? String(pmsRow.room_number) : "—";
}

export async function countReservationGuestsInHouse(businessDate: string): Promise<number> {
  const { data, error } = await supabase
    .from("reservations")
    .select("id, room_number, check_in_date, check_out_date, reservation_status")
    .lte("check_in_date", businessDate)
    .gte("check_out_date", businessDate)
    .neq("reservation_status", ReservationStatus.CheckedOut);
  if (error) throw new Error(error.message);
  return (data ?? []).length;
}
