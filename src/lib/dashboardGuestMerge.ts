import {
  deriveCheckoutReadyKind,
  type CheckoutReadyKind,
} from "@/lib/checkoutReadyAlerts";
import {
  computeDashboardRoomStats,
  formatPmsRoomStatus,
  isPmsRoomOccupied,
  isPmsRoomReservedArriving,
  pmsGuestNameForRoom,
} from "@/lib/dashboardRoomStats";
import { keyHistoryCheckout } from "@/lib/keyHistory";
import { ReservationStatus } from "@/lib/reservationStatus";
import { latestRoomFromReservation } from "@/lib/roomNumber";
import { supabase } from "@/lib/supabase";
import type { Reservation } from "@/types/database";
import type { KeyHistoryRow } from "@/types/database";
import type { PmsBoardRow, PmsSyncState } from "@/types/pmsBoard";
import { fetchPmsBoardRows, fetchPmsSyncState } from "@/lib/pmsBoard";
import { evaluateDashboardAccuracy } from "@/lib/dashboardAccuracy";

export type DashboardGuestSource = "merged" | "pms_only";

export type DashboardGuestRow = {
  key: string;
  roomNumber: string;
  guestName: string;
  checkInDate: string;
  checkOutDate: string;
  confirmationNumber: string | null;
  reservationId: string | null;
  pmsSource: "synxis" | "ezee" | null;
  pmsStatusLabel: string;
  reservationStatus: string | null;
  source: DashboardGuestSource;
  readyKind?: CheckoutReadyKind;
  checkoutLabel?: string;
};

export type DashboardGuestLists = {
  arrivals: DashboardGuestRow[];
  departures: DashboardGuestRow[];
  stayovers: DashboardGuestRow[];
};

export type DashboardMergedData = {
  accuracy: ReturnType<typeof evaluateDashboardAccuracy>;
  hotelDate: string | null;
  roomStats: ReturnType<typeof computeDashboardRoomStats> | null;
  lists: DashboardGuestLists | null;
  checkoutAlerts: DashboardGuestRow[] | null;
};

export const DASHBOARD_MERGED_QUERY_KEY = ["dashboard-merged"] as const;

function normDate(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

function normalizeName(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
}

function namesCompatible(pmsName: string, reservationName: string | null | undefined): boolean {
  const a = normalizeName(pmsName);
  const b = normalizeName(reservationName);
  if (!a || !b) return true;
  return a === b || a.includes(b) || b.includes(a);
}

function pmsSoldSource(row: PmsBoardRow): "synxis" | "ezee" | null {
  if (row.sold_by === "synxis" || row.sold_by === "ezee") return row.sold_by;
  return null;
}

function reservationActiveOnDate(res: Reservation, hotelDate: string): boolean {
  const inDate = normDate(res.check_in_date);
  const outDate = normDate(res.check_out_date);
  if (!inDate || !outDate) return false;
  return inDate <= hotelDate && outDate > hotelDate;
}

function reservationDisplayStatus(res: Reservation): string {
  const pms = res.scrape_payload?.pmsStatus;
  if (typeof pms === "string" && pms.trim()) return pms.trim();
  return res.reservation_status;
}

function isCompletePmsGuestRow(row: PmsBoardRow): boolean {
  const guest = pmsGuestNameForRoom(row);
  const cin = normDate(row.merged_check_in_date);
  const cout = normDate(row.merged_check_out_date);
  return Boolean(guest && cin && cout);
}

function isPmsArrival(row: PmsBoardRow, hotelDate: string): boolean {
  const cin = normDate(row.merged_check_in_date);
  if (cin !== hotelDate) return false;
  return isPmsRoomReservedArriving(row) || isPmsRoomOccupied(row);
}

function isPmsDeparture(row: PmsBoardRow, hotelDate: string): boolean {
  const cout = normDate(row.merged_check_out_date);
  if (cout !== hotelDate) return false;
  return isPmsRoomOccupied(row);
}

function isPmsStayover(row: PmsBoardRow, hotelDate: string): boolean {
  const cin = normDate(row.merged_check_in_date);
  const cout = normDate(row.merged_check_out_date);
  if (!cin || !cout || !(cin < hotelDate && cout > hotelDate)) return false;
  return isPmsRoomOccupied(row);
}

function findReservationMatch(
  roomNumber: string,
  pmsRow: PmsBoardRow,
  pool: Reservation[],
  hotelDate: string,
  usedIds: Set<string>,
): Reservation | null {
  const pmsGuest = pmsGuestNameForRoom(pmsRow);
  const byRoom = pool.filter((res) => {
    if (usedIds.has(res.id)) return false;
    if (res.reservation_status === ReservationStatus.CheckedOut) return false;
    const room = latestRoomFromReservation(res);
    if (room !== roomNumber) return false;
    return reservationActiveOnDate(res, hotelDate);
  });

  if (byRoom.length === 0) return null;

  if (pmsGuest) {
    const compatible = byRoom.filter((res) => namesCompatible(pmsGuest, res.guest_name));
    if (compatible.length === 1) return compatible[0]!;
    if (compatible.length > 1) return null;
    return null;
  }

  return byRoom.length === 1 ? byRoom[0]! : null;
}

function buildGuestRow(
  pmsRow: PmsBoardRow,
  reservation: Reservation | null,
  kind?: "departure",
  checkoutLabel?: string,
): DashboardGuestRow | null {
  if (!isCompletePmsGuestRow(pmsRow)) return null;

  const guestName = pmsGuestNameForRoom(pmsRow)!;
  const checkInDate = normDate(pmsRow.merged_check_in_date)!;
  const checkOutDate = normDate(pmsRow.merged_check_out_date)!;
  const roomNumber = String(pmsRow.room_number).trim();

  let source: DashboardGuestSource = "pms_only";
  let confirmationNumber: string | null = null;
  let reservationId: string | null = null;
  let reservationStatus: string | null = null;

  if (reservation && namesCompatible(guestName, reservation.guest_name)) {
    source = "merged";
    confirmationNumber = reservation.confirmation_number;
    reservationId = reservation.id;
    reservationStatus = reservationDisplayStatus(reservation);
  }

  const row: DashboardGuestRow = {
    key: `${roomNumber}-${checkInDate}-${checkOutDate}`,
    roomNumber,
    guestName,
    checkInDate,
    checkOutDate,
    confirmationNumber,
    reservationId,
    pmsSource: pmsSoldSource(pmsRow),
    pmsStatusLabel: formatPmsRoomStatus(pmsRow),
    reservationStatus,
    source,
  };

  if (kind === "departure") {
    row.readyKind = deriveCheckoutReadyKind(pmsRow.status, pmsRow);
    row.checkoutLabel = checkoutLabel ?? "—";
  }

  return row;
}

async function fetchReservationPool(hotelDate: string): Promise<Reservation[]> {
  const { data, error } = await supabase
    .from("reservations")
    .select("*")
    .lte("check_in_date", hotelDate)
    .gte("check_out_date", hotelDate)
    .neq("reservation_status", ReservationStatus.CheckedOut);

  if (error) throw new Error(error.message);
  return (data ?? []) as Reservation[];
}

async function fetchCheckoutTimesByConf(
  confirmations: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!confirmations.length) return map;

  const { data, error } = await supabase
    .from("key_history")
    .select("confirmation_number, checkout_time, created_at")
    .in("confirmation_number", confirmations)
    .order("created_at", { ascending: false });

  if (error || !data) return map;

  for (const row of data as Pick<KeyHistoryRow, "confirmation_number" | "checkout_time" | "created_at">[]) {
    const conf = row.confirmation_number;
    if (!conf || map.has(conf)) continue;
    const co = keyHistoryCheckout(row as KeyHistoryRow);
    if (co) map.set(conf, co);
  }
  return map;
}

function formatCheckoutLabel(isoOrCompact: string | undefined, checkOutDate: string): string {
  if (!isoOrCompact) return "—";
  const raw = isoOrCompact.trim();
  const compact = /^\d{12}$/.test(raw);
  if (compact) {
    const h = Number(raw.slice(8, 10));
    const mi = Number(raw.slice(10, 12));
    const dt = new Date(
      Number(raw.slice(0, 4)),
      Number(raw.slice(4, 6)) - 1,
      Number(raw.slice(6, 8)),
      h,
      mi,
    );
    if (Number.isFinite(dt.getTime())) {
      return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(dt);
    }
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
      new Date(parsed),
    );
  }
  void checkOutDate;
  return "—";
}

function buildLists(
  board: PmsBoardRow[],
  hotelDate: string,
  reservations: Reservation[],
  checkoutByConf: Map<string, string>,
): DashboardGuestLists {
  const arrivals: DashboardGuestRow[] = [];
  const departures: DashboardGuestRow[] = [];
  const stayovers: DashboardGuestRow[] = [];
  const usedByArrivals = new Set<string>();
  const usedByDepartures = new Set<string>();
  const usedByStayovers = new Set<string>();

  for (const pmsRow of board) {
    if (!isCompletePmsGuestRow(pmsRow)) continue;

    const roomNumber = String(pmsRow.room_number).trim();

    if (isPmsArrival(pmsRow, hotelDate)) {
      const reservation = findReservationMatch(
        roomNumber,
        pmsRow,
        reservations,
        hotelDate,
        usedByArrivals,
      );
      const row = buildGuestRow(pmsRow, reservation);
      if (row) {
        arrivals.push(row);
        if (reservation) usedByArrivals.add(reservation.id);
      }
    }

    if (isPmsDeparture(pmsRow, hotelDate)) {
      const reservation = findReservationMatch(
        roomNumber,
        pmsRow,
        reservations,
        hotelDate,
        usedByDepartures,
      );
      const coLabel = reservation
        ? formatCheckoutLabel(checkoutByConf.get(reservation.confirmation_number), rowCheckOut(pmsRow))
        : "—";
      const row = buildGuestRow(pmsRow, reservation, "departure", coLabel);
      if (row) {
        departures.push(row);
        if (reservation) usedByDepartures.add(reservation.id);
      }
    }

    if (isPmsStayover(pmsRow, hotelDate)) {
      const reservation = findReservationMatch(
        roomNumber,
        pmsRow,
        reservations,
        hotelDate,
        usedByStayovers,
      );
      const row = buildGuestRow(pmsRow, reservation);
      if (row) {
        stayovers.push(row);
        if (reservation) usedByStayovers.add(reservation.id);
      }
    }
  }

  const byGuest = (a: DashboardGuestRow, b: DashboardGuestRow) =>
    a.guestName.localeCompare(b.guestName);

  return {
    arrivals: arrivals.sort(byGuest),
    departures: departures.sort((a, b) => {
      const ta = a.checkoutLabel ?? "";
      const tb = b.checkoutLabel ?? "";
      if (ta !== tb) return ta.localeCompare(tb);
      return byGuest(a, b);
    }),
    stayovers: stayovers.sort(byGuest),
  };
}

function rowCheckOut(pmsRow: PmsBoardRow): string {
  return normDate(pmsRow.merged_check_out_date) ?? "";
}

export async function fetchDashboardMergedData(
  inventory: string[],
  nowMs: number,
): Promise<DashboardMergedData> {
  let pmsRows: PmsBoardRow[] = [];
  let syncState: PmsSyncState | undefined;
  let pmsBoardError = false;

  try {
    [pmsRows, syncState] = await Promise.all([fetchPmsBoardRows(), fetchPmsSyncState()]);
  } catch {
    pmsBoardError = true;
  }

  const accuracy = evaluateDashboardAccuracy({
    inventoryCount: inventory.length,
    syncState,
    nowMs,
    pmsBoardLoaded: !pmsBoardError,
    pmsBoardError,
    pmsRowCount: pmsRows.length,
  });

  if (!accuracy.canShowPmsData || pmsBoardError) {
    return {
      accuracy,
      hotelDate: accuracy.hotelDate,
      roomStats: null,
      lists: null,
      checkoutAlerts: null,
    };
  }

  const roomStats = computeDashboardRoomStats(inventory, pmsRows);
  const hotelDate = accuracy.hotelDate!;

  try {
    const reservations = await fetchReservationPool(hotelDate);
    const confs = reservations.map((r) => r.confirmation_number).filter(Boolean);
    const checkoutByConf = await fetchCheckoutTimesByConf(confs);
    const lists = buildLists(roomStats.pmsRows, hotelDate, reservations, checkoutByConf);

    return {
      accuracy,
      hotelDate,
      roomStats,
      lists,
      checkoutAlerts: lists.departures.filter((row) => row.readyKind != null),
    };
  } catch {
    return {
      accuracy: {
        ...accuracy,
        canShowPmsData: false,
        reasons: [...accuracy.reasons, "Could not load or merge reservation enrichment data."],
      },
      hotelDate: accuracy.hotelDate,
      roomStats: null,
      lists: null,
      checkoutAlerts: null,
    };
  }
}
