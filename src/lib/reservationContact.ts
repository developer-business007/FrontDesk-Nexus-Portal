import type { Reservation } from "@/types/database";

function stringFromUnknown(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  const lowerToKey = new Map<string, string>();
  for (const k of Object.keys(obj)) {
    lowerToKey.set(k.toLowerCase(), k);
  }
  for (const k of keys) {
    const direct = stringFromUnknown(obj[k]);
    if (direct) return direct;
    const ci = lowerToKey.get(k.toLowerCase());
    if (ci && ci !== k) {
      const s = stringFromUnknown(obj[ci]);
      if (s) return s;
    }
  }
  return "";
}

const EMAIL_KEYS = [
  "email",
  "Email",
  "guest_email",
  "guestEmail",
  "primary_email",
  "primaryEmail",
  "contact_email",
  "GuestEmail",
  "E-mail",
  "e_mail",
  "email_address",
  "EmailAddress",
  "guestemail",
  "PrimaryGuestEmail",
];

const PHONE_KEYS = [
  "phone",
  "Phone",
  "guest_phone",
  "guestPhone",
  "mobile",
  "Mobile",
  "primary_phone",
  "contact_phone",
  "PhoneNo",
  "phone_no",
  "PhoneNumber",
  "GuestPhone",
  "cell",
  "Cell",
  "telephone",
  "Telephone",
  "tel",
  "Tel",
  "MobileNo",
  "mobile_no",
  "HomePhone",
  "home_phone",
];

const MAX_PAYLOAD_DEPTH = 8;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Depth-first: first hit wins (shallow keys preferred due to call order). */
function contactFromNestedPayload(
  node: unknown,
  depth: number,
): { email: string; phone: string } {
  if (!isPlainRecord(node) || depth > MAX_PAYLOAD_DEPTH) {
    return { email: "", phone: "" };
  }
  let email = pickString(node, EMAIL_KEYS);
  let phone = pickString(node, PHONE_KEYS);
  if (email && phone) return { email, phone };

  for (const v of Object.values(node)) {
    if (email && phone) break;
    if (Array.isArray(v)) {
      for (const item of v) {
        const inner = contactFromNestedPayload(item, depth + 1);
        if (!email && inner.email) email = inner.email;
        if (!phone && inner.phone) phone = inner.phone;
        if (email && phone) break;
      }
      continue;
    }
    if (isPlainRecord(v)) {
      const inner = contactFromNestedPayload(v, depth + 1);
      if (!email && inner.email) email = inner.email;
      if (!phone && inner.phone) phone = inner.phone;
    }
  }
  return { email, phone };
}

/** Reads email/phone: optional `email` column on the row first, then `scrape_payload`. */
export function contactFromReservation(r: Reservation): { email: string; phone: string } {
  const rec = r as Record<string, unknown>;
  const colEmail = stringFromUnknown(r.email ?? rec.email);
  const colPhone = stringFromUnknown(r.phone ?? rec.phone);

  if (!r.scrape_payload || typeof r.scrape_payload !== "object") {
    return { email: colEmail, phone: colPhone };
  }
  const fromPayload = contactFromNestedPayload(r.scrape_payload as Record<string, unknown>, 0);
  return {
    email: colEmail || fromPayload.email,
    phone: colPhone || fromPayload.phone,
  };
}

/** Writes canonical `email` / `phone` keys; preserves other `scrape_payload` fields. */
export function mergeContactIntoPayload(
  existing: Record<string, unknown> | null,
  email: string,
  phone: string,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  const e = email.trim();
  const p = phone.trim();
  if (e) base.email = e;
  else delete base.email;
  if (p) base.phone = p;
  else delete base.phone;
  return base;
}
