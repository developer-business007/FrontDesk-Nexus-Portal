import { ReservationStatus } from "@/lib/reservationStatus";
import {
  isPmsRoomOccupied,
  isPmsRoomOutOfOrder,
} from "@/lib/dashboardRoomStats";
import { keyHistoryCheckout } from "@/lib/keyHistory";
import type { HotelSettings } from "@/lib/hotelSettings";
import { latestRoomFromColumn } from "@/lib/roomNumber";
import { supabase } from "@/lib/supabase";
import type { Reservation } from "@/types/database";
import type { KeyHistoryRow } from "@/types/database";
import type { PmsBoardRow } from "@/types/pmsBoard";
import type { RoomLifecycleStatus } from "@/types/housekeeping";

export type CheckoutReadyKind =
  | "ready"
  | "cleaning"
  | "dirty"
  | "occupied"
  | "ooo"
  | "unknown";

export type CheckoutReadyAlert = {
  reservationId: string;
  confirmationNumber: string;
  guestName: string;
  roomNumber: string | null;
  checkoutAtMs: number | null;
  checkoutLabel: string;
  readyKind: CheckoutReadyKind;
  lifecycleStatus: RoomLifecycleStatus | null;
};

export const CHECKOUT_READY_QUERY_KEY = ["checkout-ready-alerts"] as const;

const COMPACT_12 = /^\d{12}$/;

function parseCheckoutInstant(value: string, timezone: string): number | null {
  const raw = value.trim();
  if (!raw) return null;

  if (COMPACT_12.test(raw)) {
    const y = Number(raw.slice(0, 4));
    const mo = Number(raw.slice(4, 6));
    const d = Number(raw.slice(6, 8));
    const h = Number(raw.slice(8, 10));
    const mi = Number(raw.slice(10, 12));
    const dt = new Date(y, mo - 1, d, h, mi, 0, 0);
    return Number.isFinite(dt.getTime()) ? dt.getTime() : null;
  }

  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [hh, mm] = "11:00".split(":").map(Number);
    const dt = new Date(`${raw}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`);
    return Number.isFinite(dt.getTime()) ? dt.getTime() : null;
  }

  void timezone;
  return null;
}

function checkoutFromPayload(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload || typeof payload !== "object") return null;
  const candidates = [
    payload.checkoutTime,
    payload.checkout_time,
    payload.checkOutTime,
    payload.departureTime,
    payload.departure_time,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  const fdn = payload.fdn;
  if (fdn && typeof fdn === "object") {
    const f = fdn as Record<string, unknown>;
    for (const key of ["checkoutTime", "checkout_time", "checkOutTime"]) {
      const v = f[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

function defaultCheckoutInstant(checkOutDate: string | null, hotel: HotelSettings): number | null {
  if (!checkOutDate) return null;
  const [hh, mm] = hotel.defaultCheckoutTime.split(":").map(Number);
  const dt = new Date(
    `${checkOutDate}T${String(hh).padStart(2, "0")}:${String(mm ?? 0).padStart(2, "0")}:00`,
  );
  return Number.isFinite(dt.getTime()) ? dt.getTime() : null;
}

export function deriveCheckoutReadyKind(
  lifecycle: RoomLifecycleStatus | string | null | undefined,
  pmsRow?: PmsBoardRow,
): CheckoutReadyKind {
  if (pmsRow && isPmsRoomOutOfOrder(pmsRow)) return "ooo";
  if (lifecycle === "out_of_order") return "ooo";
  if (lifecycle === "available" || lifecycle === "clean_ready") return "ready";
  if (lifecycle === "in_service") return "cleaning";
  if (lifecycle === "dirty") return "dirty";
  if (lifecycle === "occupied" || (pmsRow && isPmsRoomOccupied(pmsRow))) return "occupied";
  return "unknown";
}

export function formatCheckoutReadyLabel(kind: CheckoutReadyKind): string {
  switch (kind) {
    case "ready":
      return "Ready";
    case "cleaning":
      return "Cleaning";
    case "dirty":
      return "Dirty";
    case "occupied":
      return "Still occupied";
    case "ooo":
      return "Out of order";
    default:
      return "Unknown";
  }
}

export function checkoutReadyTone(kind: CheckoutReadyKind): "emerald" | "sky" | "amber" | "violet" | "red" | "slate" {
  switch (kind) {
    case "ready":
      return "emerald";
    case "cleaning":
      return "sky";
    case "dirty":
      return "amber";
    case "occupied":
      return "violet";
    case "ooo":
      return "red";
    default:
      return "slate";
  }
}

function resolveCheckoutInstant(
  res: Reservation,
  hotel: HotelSettings,
  keyCheckout: string | null | undefined,
): { ms: number | null; label: string } {
  const fromKey = keyCheckout ? parseCheckoutInstant(keyCheckout, hotel.timezone) : null;
  if (fromKey != null) {
    return {
      ms: fromKey,
      label: new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(fromKey)),
    };
  }

  const fromPayload = checkoutFromPayload(res.scrape_payload);
  const fromPayloadMs = fromPayload ? parseCheckoutInstant(fromPayload, hotel.timezone) : null;
  if (fromPayloadMs != null) {
    return {
      ms: fromPayloadMs,
      label: new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(fromPayloadMs)),
    };
  }

  const defaultMs = defaultCheckoutInstant(res.check_out_date, hotel);
  if (defaultMs != null) {
    return {
      ms: defaultMs,
      label: new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(defaultMs)),
    };
  }

  return { ms: null, label: "—" };
}

export async function fetchCheckoutReadyAlerts(
  businessDate: string,
  hotel: HotelSettings,
  pmsByRoom: Map<string, PmsBoardRow>,
): Promise<CheckoutReadyAlert[]> {
  const { data: departures, error } = await supabase
    .from("reservations")
    .select("*")
    .eq("check_out_date", businessDate)
    .neq("reservation_status", ReservationStatus.CheckedOut)
    .order("guest_name", { ascending: true });

  if (error) throw new Error(error.message);

  const rows = (departures ?? []) as Reservation[];
  if (!rows.length) return [];

  const confs = [...new Set(rows.map((r) => r.confirmation_number).filter(Boolean))];
  const keyCheckoutByConf = new Map<string, string>();

  if (confs.length > 0) {
    const { data: keys, error: keyError } = await supabase
      .from("key_history")
      .select("confirmation_number, checkout_time, created_at")
      .in("confirmation_number", confs)
      .order("created_at", { ascending: false });

    if (!keyError && keys) {
      for (const row of keys as Pick<KeyHistoryRow, "confirmation_number" | "checkout_time" | "created_at">[]) {
        const conf = row.confirmation_number;
        if (!conf || keyCheckoutByConf.has(conf)) continue;
        const co = keyHistoryCheckout(row as KeyHistoryRow);
        if (co) keyCheckoutByConf.set(conf, co);
      }
    }
  }

  const alerts: CheckoutReadyAlert[] = rows.map((res) => {
    const room = latestRoomFromColumn(res.room_number);
    const pmsRow = room ? pmsByRoom.get(room) : undefined;
    const lifecycle = (pmsRow?.status as RoomLifecycleStatus | null) ?? null;
    const { ms, label } = resolveCheckoutInstant(
      res,
      hotel,
      keyCheckoutByConf.get(res.confirmation_number),
    );

    return {
      reservationId: res.id,
      confirmationNumber: res.confirmation_number,
      guestName: res.guest_name?.trim() || pmsRow?.merged_guest_name?.trim() || "—",
      roomNumber: room,
      checkoutAtMs: ms,
      checkoutLabel: label,
      readyKind: deriveCheckoutReadyKind(lifecycle, pmsRow),
      lifecycleStatus: lifecycle,
    };
  });

  alerts.sort((a, b) => {
    const ta = a.checkoutAtMs ?? Number.POSITIVE_INFINITY;
    const tb = b.checkoutAtMs ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return a.guestName.localeCompare(b.guestName);
  });

  return alerts;
}

export function countCheckoutReady(alerts: CheckoutReadyAlert[]): {
  ready: number;
  notReady: number;
  total: number;
} {
  const ready = alerts.filter((a) => a.readyKind === "ready").length;
  return { ready, notReady: alerts.length - ready, total: alerts.length };
}
