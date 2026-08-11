/**
 * Money display for reservations:
 *
 * 1. **Database columns** on `public.reservations` — `total`, `paid`, `balance` (often `text`).
 *    These are read first when present so the UI matches the Table Editor.
 *
 * 2. **Fallback: `scrape_payload` JSON** — if a column is null/empty/unparseable, we look for
 *    similarly named properties inside the nested PMS blob. The arrays below are only those
 *    JSON **property names**, not your SQL column list.
 */
import type { Reservation } from "@/types/database";

const MAX_DEPTH = 8;

function parseMoneyValue(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.trim().replace(/[^0-9.-]/g, "");
    if (t === "" || t === "-" || t === ".") return null;
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Prefer typed / optional columns, then any same-named key on the row object. */
function moneyFromRowColumns(r: Reservation): {
  total: number | null;
  paid: number | null;
  balance: number | null;
} {
  const rec = r as Record<string, unknown>;
  return {
    total: parseMoneyValue(r.total ?? rec.total),
    paid: parseMoneyValue(r.paid ?? rec.paid),
    balance: parseMoneyValue(r.balance ?? rec.balance),
  };
}

function pickMoneyOnObject(obj: Record<string, unknown>, keys: string[]): number | null {
  const lowerToKey = new Map<string, string>();
  for (const k of Object.keys(obj)) {
    lowerToKey.set(k.toLowerCase(), k);
  }
  for (const k of keys) {
    const direct = parseMoneyValue(obj[k]);
    if (direct != null) return direct;
    const actual = lowerToKey.get(k.toLowerCase());
    if (actual && actual !== k) {
      const n = parseMoneyValue(obj[actual]);
      if (n != null) return n;
    }
  }
  return null;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Depth-first: first matching key wins (current object before children). */
function firstMoneyInTree(node: unknown, keys: string[], depth: number): number | null {
  if (depth > MAX_DEPTH || node == null) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const v = firstMoneyInTree(item, keys, depth + 1);
      if (v != null) return v;
    }
    return null;
  }
  if (!isPlainRecord(node)) return null;
  const hit = pickMoneyOnObject(node, keys);
  if (hit != null) return hit;
  for (const v of Object.values(node)) {
    const got = firstMoneyInTree(v, keys, depth + 1);
    if (got != null) return got;
  }
  return null;
}

/** Fallback keys inside `scrape_payload` only (avoid overly generic names that steal `total` / `balance`). */
const TOTAL_KEYS = [
  "grand_total",
  "GrandTotal",
  "total_amount",
  "TotalAmount",
  "folio_total",
  "FolioTotal",
  "total_charges",
  "TotalCharges",
  "room_total",
  "RoomTotal",
  "stay_total",
  "total_rate",
  "TotalRate",
  "booking_total",
  "invoice_total",
  "total",
  "Total",
];

const PAID_KEYS = [
  "amount_paid",
  "AmountPaid",
  "total_paid",
  "TotalPaid",
  "payment_total",
  "PaymentTotal",
  "payments_total",
  "paid_amount",
  "PaidAmount",
  "deposit",
  "Deposit",
  "prepaid",
  "collected",
  "paid",
  "Paid",
];

const BALANCE_KEYS = [
  "balance_due",
  "BalanceDue",
  "amount_due",
  "AmountDue",
  "remaining",
  "Remaining",
  "outstanding",
  "Outstanding",
  "ar_balance",
  "balance",
  "Balance",
];

export type ReservationMoney = {
  total: number | null;
  paid: number | null;
  balance: number | null;
};

function mergeMoney(
  column: number | null,
  fromPayload: number | null,
): number | null {
  if (column != null) return column;
  return fromPayload;
}

/**
 * Reads total / paid / balance: **row columns first** (`total`, `paid`, `balance`), then
 * `scrape_payload` using the key lists above.
 */
export function moneyFromReservation(r: Reservation): ReservationMoney {
  const cols = moneyFromRowColumns(r);
  const p = r.scrape_payload;
  const hasPayload = p && isPlainRecord(p);
  const payloadTotal = hasPayload ? firstMoneyInTree(p, TOTAL_KEYS, 0) : null;
  const payloadPaid = hasPayload ? firstMoneyInTree(p, PAID_KEYS, 0) : null;
  const payloadBalance = hasPayload ? firstMoneyInTree(p, BALANCE_KEYS, 0) : null;

  return {
    total: mergeMoney(cols.total, payloadTotal),
    paid: mergeMoney(cols.paid, payloadPaid),
    balance: mergeMoney(cols.balance, payloadBalance),
  };
}

/** USD with `$` symbol (e.g. `$1,234.56`). */
export function formatUsd(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}
