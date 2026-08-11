import { EZEE_KIOSK_URL } from "./ezee-secrets.ts";

export type EzeeBillingSummary = {
  dueAmount: number;
  totalCharges: number;
  paidAmount: number;
};

export type EzeeReservationDetail = {
  confirmationNumber: string;
  roomNumber: string | null;
  /** Local wall-clock ISO date/time without Z, e.g. 2026-06-23T20:47:00 */
  checkInDate: string | null;
  checkOutDate: string | null;
  guestName: string | null;
  status: string | null;
  totalCharges: number;
  paidAmount: number;
  dueAmount: number;
};

const EZEE_ROOMLIST_URL =
  Deno.env.get("EZEE_ROOMLIST_URL")?.trim() ||
  "https://live.ipms247.com/index.php/page/service.hkinfoforkaterina";

type EzeeHkGuest = {
  room?: string | number;
  guestname?: string;
  reservationno?: string;
  checkindate?: string;
  checkoutdate?: string;
  bookingstatus?: string;
};

function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").replace(/\$/g, "").trim();
  if (!cleaned) return 0;
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

function splitSubBookingId(bookingId: string): { parent: string; suffix: string | null } {
  const m = bookingId.trim().match(/^(.+)-(\d+)$/);
  if (!m) return { parent: bookingId.trim(), suffix: null };
  return { parent: m[1], suffix: m[2] };
}

function normalizeReservationToken(value: string): string {
  return value.trim().toLowerCase();
}

function reservationTokensMatch(a: string, b: string): boolean {
  const left = normalizeReservationToken(a);
  const right = normalizeReservationToken(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const { parent: pA, suffix: sA } = splitSubBookingId(a);
  const { parent: pB, suffix: sB } = splitSubBookingId(b);
  if (sA && sB) return pA.toLowerCase() === pB.toLowerCase() && sA === sB;
  if (sA) return pA.toLowerCase() === right && sA === "1";
  if (sB) return pB.toLowerCase() === left && sB === "1";
  return false;
}

/** eZee hkinfo returns `YYYY-MM-DD HH:MM:SS` in property local time. */
function ezeeDateTimeToIsoLocal(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const m = raw.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!m) return null;
  const [, yyyy, mm, dd, h, min, sec] = m;
  if (!h) return `${yyyy}-${mm}-${dd}`;
  const hh = h.padStart(2, "0");
  const ss = (sec ?? "00").padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}`;
}

function combineBookingDateTime(
  dateRaw: string | null | undefined,
  timeRaw: string | null | undefined,
): string | null {
  if (!dateRaw?.trim()) return null;
  const date = dateRaw.trim().slice(0, 10);
  if (!timeRaw?.trim()) return date;
  const time = timeRaw.trim();
  const normalized = time.length === 5 ? `${time}:00` : time;
  return `${date}T${normalized}`;
}

function guestDisplayName(
  salutation: string | null | undefined,
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string | null {
  const parts = [salutation, firstName, lastName]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

async function postEzeeKiosk(
  hotelCode: number,
  authCode: string,
  requestType: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(EZEE_KIOSK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      RES_Request: {
        Request_Type: requestType,
        Authentication: {
          HotelCode: hotelCode,
          AuthCode: authCode,
        },
        ...extra,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`eZee API HTTP ${res.status}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch {
    throw new Error("eZee API returned non-JSON");
  }

  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("eZee API returned invalid JSON");
  }

  const root = json as Record<string, unknown>;
  const errorCode = (root.Errors as Record<string, unknown> | undefined)?.ErrorCode;
  if (errorCode !== "0" && errorCode !== 0) {
    const msg = (root.Errors as Record<string, unknown> | undefined)?.ErrorMessage;
    throw new Error(typeof msg === "string" && msg.trim() ? msg : "eZee API error");
  }

  return root;
}

async function fetchEzeeInHouseGuest(
  hotelCode: number,
  authCode: string,
  bookingId: string,
): Promise<EzeeHkGuest | null> {
  const res = await fetch(EZEE_ROOMLIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hotel_code: String(hotelCode), authcode: authCode }),
  });
  if (!res.ok) return null;

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;

  const list = (json as { checkinguestlist?: EzeeHkGuest[] }).checkinguestlist;
  if (!Array.isArray(list)) return null;

  for (const guest of list) {
    const resNo = typeof guest.reservationno === "string" ? guest.reservationno.trim() : "";
    if (!resNo) continue;
    if (reservationTokensMatch(resNo, bookingId)) return guest;
  }
  return null;
}

function pickBookingTran(
  tranList: Record<string, unknown>[],
  bookingId: string,
): Record<string, unknown> | null {
  const { parent, suffix } = splitSubBookingId(bookingId);
  for (const tran of tranList) {
    const sub = String(tran.SubBookingId ?? "").trim();
    const voucher = String(tran.VoucherNo ?? "");
    if (suffix && sub === suffix) return tran;
    if (reservationTokensMatch(`${parent}-${sub}`, bookingId)) return tran;
    if (voucher.toLowerCase().includes(bookingId.toLowerCase())) return tran;
  }
  if (tranList.length === 1) return tranList[0] ?? null;
  if (suffix) {
    const bySuffix = tranList.find((t) => String(t.SubBookingId ?? "").trim() === suffix);
    if (bySuffix) return bySuffix;
  }
  return null;
}

async function fetchEzeeSingleBookingTran(
  hotelCode: number,
  authCode: string,
  bookingId: string,
): Promise<Record<string, unknown> | null> {
  const { parent } = splitSubBookingId(bookingId);
  const lookupId = bookingId.includes("-") ? bookingId : parent;

  const root = await postEzeeKiosk(hotelCode, authCode, "FetchSingleBooking", {
    BookingId: lookupId,
  });

  const reservations = root.Reservations as Record<string, unknown> | undefined;
  const reservationRaw = reservations?.Reservation;
  const reservationList = Array.isArray(reservationRaw)
    ? reservationRaw
    : reservationRaw && typeof reservationRaw === "object"
      ? [reservationRaw]
      : [];

  for (const reservation of reservationList as Record<string, unknown>[]) {
    const tranRaw = reservation.BookingTran;
    const tranList = Array.isArray(tranRaw)
      ? tranRaw
      : tranRaw && typeof tranRaw === "object"
        ? [tranRaw]
        : [];
    const picked = pickBookingTran(tranList as Record<string, unknown>[], bookingId);
    if (picked) return picked;
  }

  return null;
}

export async function fetchEzeeBillingSummary(
  hotelCode: number,
  authCode: string,
  bookingId: string,
): Promise<EzeeBillingSummary> {
  const root = await postEzeeKiosk(hotelCode, authCode, "RetrieveListofBills", {
    Authentication: {
      HotelCode: hotelCode,
      AuthCode: authCode,
      BookingId: bookingId.trim(),
    },
  });

  const success = root.Success as Record<string, unknown> | undefined;
  const folioList = success?.FolioList;
  if (!Array.isArray(folioList) || folioList.length === 0) {
    return { dueAmount: 0, totalCharges: 0, paidAmount: 0 };
  }

  let dueAmount = 0;
  let totalCharges = 0;
  let paidAmount = 0;
  for (const folio of folioList as Record<string, unknown>[]) {
    const due = parseMoney(String(folio.DueAmount ?? "0"));
    const charges = parseMoney(String(folio.TotalCharges ?? "0"));
    const paid = parseMoney(String(folio.PaidAmount ?? "0"));
    if (due != null) dueAmount += due;
    if (charges != null) totalCharges += charges;
    if (paid != null) paidAmount += paid;
  }

  return { dueAmount, totalCharges, paidAmount };
}

/** Room, stay dates, status (hkinfo / FetchSingleBooking) plus folio totals (RetrieveListofBills). */
export async function fetchEzeeReservationDetail(
  hotelCode: number,
  authCode: string,
  bookingId: string,
): Promise<EzeeReservationDetail> {
  const id = bookingId.trim();
  const [inHouse, bookingTran, billing] = await Promise.all([
    fetchEzeeInHouseGuest(hotelCode, authCode, id),
    fetchEzeeSingleBookingTran(hotelCode, authCode, id).catch(() => null),
    fetchEzeeBillingSummary(hotelCode, authCode, id),
  ]);

  const roomFromTran = bookingTran
    ? String(bookingTran.RoomName ?? bookingTran.Room ?? "").trim() || null
    : null;
  const roomFromHk = inHouse?.room != null ? String(inHouse.room).trim() : null;

  const checkInFromHk = ezeeDateTimeToIsoLocal(inHouse?.checkindate);
  const checkOutFromHk = ezeeDateTimeToIsoLocal(inHouse?.checkoutdate);
  const checkInFromTran = combineBookingDateTime(
    typeof bookingTran?.Start === "string" ? bookingTran.Start : null,
    typeof bookingTran?.ArrivalTime === "string" ? bookingTran.ArrivalTime : null,
  );
  const checkOutFromTran = combineBookingDateTime(
    typeof bookingTran?.End === "string" ? bookingTran.End : null,
    typeof bookingTran?.DepartureTime === "string" ? bookingTran.DepartureTime : null,
  );

  const totalFromTran = parseMoney(String(bookingTran?.TotalAmountAfterTax ?? ""));
  const paidFromTran = parseMoney(String(bookingTran?.TotalPayment ?? ""));

  const guestFromHk = inHouse?.guestname?.trim() || null;
  const guestFromTran = bookingTran
    ? guestDisplayName(
        typeof bookingTran.Salutation === "string" ? bookingTran.Salutation : null,
        typeof bookingTran.FirstName === "string" ? bookingTran.FirstName : null,
        typeof bookingTran.LastName === "string" ? bookingTran.LastName : null,
      )
    : null;

  const status =
    inHouse?.bookingstatus?.trim() ||
    (typeof bookingTran?.CurrentStatus === "string" ? bookingTran.CurrentStatus.trim() : null) ||
    null;

  const totalCharges =
    billing.totalCharges > 0
      ? billing.totalCharges
      : totalFromTran != null && totalFromTran > 0
        ? totalFromTran
        : billing.totalCharges;
  const paidAmount =
    billing.paidAmount > 0
      ? billing.paidAmount
      : paidFromTran != null && paidFromTran >= 0
        ? paidFromTran
        : billing.paidAmount;

  return {
    confirmationNumber: id,
    roomNumber: roomFromHk ?? roomFromTran,
    checkInDate: checkInFromHk ?? checkInFromTran,
    checkOutDate: checkOutFromHk ?? checkOutFromTran,
    guestName: guestFromHk ?? guestFromTran,
    status,
    totalCharges,
    paidAmount,
    dueAmount: billing.dueAmount,
  };
}

