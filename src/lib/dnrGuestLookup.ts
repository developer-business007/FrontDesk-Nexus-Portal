import { decryptJson, isEncryptedPayload } from "@/lib/encryption";
import { classifyGuestLookup, hashIdNumber, hashPhoneNumber } from "@/lib/idScanLookup";
import { supabase } from "@/lib/supabase";
import type { IdScan } from "@/types/database";

export type DnrGuestLookupHit = {
  guestName: string;
  idNumber: string | null;
  dateOfBirth: string | null;
  confirmationNumber: string | null;
  scannedAt: string | null;
  source: "id_scan" | "reservation";
};

type DecryptedPii = {
  fullName?: string | null;
  dateOfBirth?: string | null;
  idNumber?: string | null;
  idGuru?: {
    firstName?: string | null;
    middleName?: string | null;
    lastName?: string | null;
  } | null;
};

function nameFromPii(pii: DecryptedPii | null): string {
  if (!pii) return "";
  const g = pii.idGuru;
  const fromGuru = [g?.firstName, g?.middleName, g?.lastName]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (fromGuru) return fromGuru;
  return pii.fullName?.trim() ?? "";
}

async function hitFromIdScan(scan: IdScan): Promise<DnrGuestLookupHit | null> {
  let pii: DecryptedPii | null = null;
  if (isEncryptedPayload(scan.pii_encrypted)) {
    try {
      pii = await decryptJson<DecryptedPii>(scan.pii_encrypted);
    } catch {
      pii = null;
    }
  }
  const guestName = nameFromPii(pii);
  if (!guestName && !pii?.idNumber) return null;
  return {
    guestName: guestName || "—",
    idNumber: pii?.idNumber?.trim() ?? null,
    dateOfBirth: pii?.dateOfBirth?.trim() ?? null,
    confirmationNumber: scan.confirmation_number,
    scannedAt: scan.scanned_at,
    source: "id_scan",
  };
}

function looksLikeGuestNameQuery(q: string): boolean {
  return q.length >= 3 && /[a-zA-Z]/.test(q) && !/\d/.test(q);
}

/** Find guests in ID Data or reservations to prefill the DNR form (portal). */
export async function lookupGuestsForDnr(raw: string): Promise<DnrGuestLookupHit[]> {
  const q = raw.trim();
  if (q.length < 3) return [];

  if (looksLikeGuestNameQuery(q)) {
    return lookupGuestsByName(q);
  }

  const kind = classifyGuestLookup(q);
  const hits: DnrGuestLookupHit[] = [];
  const seen = new Set<string>();

  const push = (hit: DnrGuestLookupHit) => {
    const key = `${hit.idNumber ?? ""}|${hit.guestName}|${hit.confirmationNumber ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(hit);
  };

  if (kind === "id") {
    const hash = await hashIdNumber(q);
    const { data, error } = await supabase
      .from("id_scans")
      .select("*")
      .eq("id_number_hash", hash)
      .order("scanned_at", { ascending: false })
      .limit(8);
    if (error) throw new Error(error.message);
    for (const scan of (data ?? []) as IdScan[]) {
      const hit = await hitFromIdScan(scan);
      if (hit) push(hit);
    }
    return hits;
  }

  if (kind === "phone") {
    const hash = await hashPhoneNumber(q);
    if (!hash) return [];
    const { data, error } = await supabase
      .from("id_scans")
      .select("*")
      .eq("phone_number_hash", hash)
      .order("scanned_at", { ascending: false })
      .limit(8);
    if (error) throw new Error(error.message);
    for (const scan of (data ?? []) as IdScan[]) {
      const hit = await hitFromIdScan(scan);
      if (hit) push(hit);
    }
    return hits;
  }

  if (kind === "confirmation") {
    const { data: scans, error: scanErr } = await supabase
      .from("id_scans")
      .select("*")
      .eq("confirmation_number", q)
      .order("scanned_at", { ascending: false })
      .limit(5);
    if (scanErr) throw new Error(scanErr.message);
    for (const scan of (scans ?? []) as IdScan[]) {
      const hit = await hitFromIdScan(scan);
      if (hit) push(hit);
    }

    const { data: resRows, error: resErr } = await supabase
      .from("reservations")
      .select("guest_name, confirmation_number")
      .ilike("confirmation_number", `%${q}%`)
      .order("updated_at", { ascending: false })
      .limit(5);
    if (resErr) throw new Error(resErr.message);
    for (const row of resRows ?? []) {
      const gn = (row.guest_name as string | null)?.trim();
      if (!gn) continue;
      push({
        guestName: gn,
        idNumber: null,
        dateOfBirth: null,
        confirmationNumber: row.confirmation_number as string,
        scannedAt: null,
        source: "reservation",
      });
    }
    return hits;
  }

  return hits;
}

async function lookupGuestsByName(q: string): Promise<DnrGuestLookupHit[]> {
  const hits: DnrGuestLookupHit[] = [];
  const seen = new Set<string>();

  const push = (hit: DnrGuestLookupHit) => {
    const key = `${hit.idNumber ?? ""}|${hit.guestName}|${hit.confirmationNumber ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(hit);
  };

  const { data: resRows, error: resErr } = await supabase
    .from("reservations")
    .select("guest_name, confirmation_number")
    .ilike("guest_name", `%${q}%`)
    .order("updated_at", { ascending: false })
    .limit(8);
  if (resErr) throw new Error(resErr.message);
  for (const row of resRows ?? []) {
    const gn = (row.guest_name as string | null)?.trim();
    if (!gn) continue;
    push({
      guestName: gn,
      idNumber: null,
      dateOfBirth: null,
      confirmationNumber: row.confirmation_number as string,
      scannedAt: null,
      source: "reservation",
    });
  }

  const { data: recentScans, error: scanErr } = await supabase
    .from("id_scans")
    .select("*")
    .order("scanned_at", { ascending: false })
    .limit(120);
  if (scanErr) throw new Error(scanErr.message);

  const needle = q.toLowerCase();
  for (const scan of (recentScans ?? []) as IdScan[]) {
    const hit = await hitFromIdScan(scan);
    if (!hit) continue;
    const hay = [hit.guestName, hit.idNumber, hit.confirmationNumber]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(needle)) continue;
    push(hit);
    if (hits.length >= 10) break;
  }

  return hits;
}
