/** Match extension `normalizePhoneForLookup` / `hashPhoneNumber` for guest history search. */
export function normalizePhoneForLookup(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

export function isCompletePhoneForLookup(phone: string | null | undefined): boolean {
  return normalizePhoneForLookup(phone).length >= 10;
}

/** SHA-256 hex of normalized ID number — same as extension `hashIdNumber`. */
export async function hashIdNumber(idNumber: string): Promise<string> {
  const norm = idNumber.replace(/\s+/g, "").toUpperCase();
  const data = new TextEncoder().encode(norm);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 hex of normalized phone — same as extension `hashPhoneNumber`. */
export async function hashPhoneNumber(phone: string): Promise<string | null> {
  if (!isCompletePhoneForLookup(phone)) return null;
  const norm = normalizePhoneForLookup(phone);
  const data = new TextEncoder().encode(norm);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type GuestLookupKind = "phone" | "id" | "confirmation";

/** Classify guest lookup input for server-side query strategy. */
export function classifyGuestLookup(raw: string): GuestLookupKind | null {
  const q = raw.trim();
  if (!q) return null;
  if (isCompletePhoneForLookup(q)) return "phone";
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{3,}$/.test(q) && /\d/.test(q)) return "confirmation";
  if (q.length >= 3) return "id";
  return null;
}
