import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Download, ExternalLink, Loader2, ScanLine, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { hotelDateRangeToUtcIso, useHotelSettings, zonedDateString } from "@/lib/hotelSettings";
import { decryptJson, isEncryptedPayload } from "@/lib/encryption";
import { createIdScanImageSignedUrl } from "@/lib/idScanStorage";
import { DateField } from "@/components/ui/DateField";
import { SearchField } from "@/components/ui/SearchField";
import type { IdScan } from "@/types/database";

type ReservationLite = {
  confirmation_number: string;
  room_number: string | null;
  guest_name: string | null;
  check_in_date: string | null;
  check_out_date: string | null;
};

type ProfileLite = {
  id: string;
  email: string | null;
  full_name: string | null;
};

/** Decrypted `id_scans.pii_encrypted` (extension `saveIdScan` payload). */
type DecryptedPii = {
  fullName?: string | null;
  dateOfBirth?: string | null;
  idNumber?: string | null;
  idType?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  address?: string | null;
  idGuru?: {
    firstName?: string | null;
    middleName?: string | null;
    lastName?: string | null;
    streetAddress?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    phone?: string | null;
    email?: string | null;
    phoneCountryCode?: string | null;
    usaCaPhone?: boolean | null;
  } | null;
  documentDataSnapshot?: Record<string, unknown> | null;
  remarks?: { guest?: string; checkIn?: string };
};

function agentLabel(p: ProfileLite | undefined, fallbackId: string | null): string {
  if (!fallbackId) return "—";
  const name = p?.full_name?.trim();
  const email = p?.email?.trim();
  if (name && email) return `${name} (${email})`;
  if (name) return name;
  if (email) return email;
  return fallbackId.slice(0, 8) + "…";
}

/** Name from decrypted ID scan (OCR / ID Guru) — primary label for list & header. */
function nameFromDecryptedPii(pii: DecryptedPii | null | undefined): string | null {
  if (!pii) return null;
  const fn = pii.fullName?.trim();
  if (fn) return fn;
  const g = pii.idGuru;
  if (!g) return null;
  const parts = [g.firstName, g.middleName, g.lastName]
    .map((x) => (x && String(x).trim()) || "")
    .filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

/** ID card name first; PMS reservation guest only when ID name is unavailable. */
function idScanGuestDisplayName(
  pii: DecryptedPii | null | undefined,
  reservationGuest?: string | null,
): string {
  const fromId = nameFromDecryptedPii(pii);
  if (fromId) return fromId;
  const pms = reservationGuest?.trim();
  if (pms) return pms;
  return "—";
}

type ScanListMeta = {
  displayName: string;
  /** Lowercase blob for client-side filter (name, email, phone, ID #, address, conf, …). */
  haystack: string;
};

function pushSearchParts(parts: string[], ...values: (string | null | undefined)[]) {
  for (const v of values) {
    const t = v?.trim();
    if (t) parts.push(t);
  }
}

async function buildScanListMeta(
  scan: IdScan,
  res: ReservationLite | undefined,
  agentDisplay?: string,
): Promise<ScanListMeta> {
  const parts: string[] = [];
  pushSearchParts(parts, agentDisplay);
  pushSearchParts(
    parts,
    scan.confirmation_number,
    scan.ocr_provider ?? undefined,
    scan.terminal_id ?? undefined,
    scan.manual_entry ? "manual" : "scan",
  );
  pushSearchParts(parts, res?.guest_name, res?.room_number, res?.check_in_date, res?.check_out_date);

  let pii: DecryptedPii | null = null;
  if (isEncryptedPayload(scan.pii_encrypted)) {
    try {
      pii = await decryptJson<DecryptedPii>(scan.pii_encrypted);
    } catch {
      pii = null;
    }
  }
  if (pii) {
    pushSearchParts(
      parts,
      pii.fullName,
      pii.dateOfBirth,
      pii.idNumber,
      pii.idType,
      pii.issueDate,
      pii.expiryDate,
      pii.address,
      pii.remarks?.guest,
      pii.remarks?.checkIn,
    );
    const g = pii.idGuru;
    if (g) {
      pushSearchParts(
        parts,
        g.firstName,
        g.middleName,
        g.lastName,
        g.streetAddress,
        g.city,
        g.state,
        g.postalCode,
        g.phone,
        g.email,
      );
    }
  }

  if (scan.phone_encrypted && isEncryptedPayload(scan.phone_encrypted)) {
    try {
      const o = await decryptJson<{ value?: string }>(scan.phone_encrypted);
      pushSearchParts(parts, o.value);
      const digits = (o.value ?? "").replace(/\D/g, "");
      if (digits.length >= 7) parts.push(digits);
    } catch {
      /* skip */
    }
  }
  if (scan.email_encrypted && isEncryptedPayload(scan.email_encrypted)) {
    try {
      const o = await decryptJson<{ value?: string }>(scan.email_encrypted);
      pushSearchParts(parts, o.value);
    } catch {
      /* skip */
    }
  }

  return {
    displayName: idScanGuestDisplayName(pii, res?.guest_name),
    haystack: parts.join(" ").toLowerCase(),
  };
}

const ID_SCANS_PAGE_SIZE = 500;
const ID_SCANS_MAX_ROWS = 5000;

async function fetchAllIdScans(): Promise<IdScan[]> {
  const all: IdScan[] = [];
  let offset = 0;
  while (all.length < ID_SCANS_MAX_ROWS) {
    const { data, error } = await supabase
      .from("id_scans")
      .select("*")
      .order("scanned_at", { ascending: false })
      .range(offset, offset + ID_SCANS_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as IdScan[];
    all.push(...batch);
    if (batch.length < ID_SCANS_PAGE_SIZE) break;
    offset += ID_SCANS_PAGE_SIZE;
  }
  return all;
}

/** Client-side filter — no extra API calls while typing. */
function matchesListSearch(haystack: string, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  if (haystack.includes(q)) return true;
  const digits = q.replace(/\D/g, "");
  if (digits.length >= 3 && haystack.replace(/\D/g, "").includes(digits)) return true;
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length > 1) return terms.every((t) => haystack.includes(t));
  return false;
}

/** Label + value aligned in a responsive grid (structured / reservation blocks). */
function IdDataFieldGrid({ items }: { items: { label: string; value: string }[] }) {
  const visible = items.filter((i) => i.value.trim() !== "");
  if (!visible.length) return null;
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
      {visible.map(({ label, value }) => (
        <div key={label} className="min-w-0">
          <div className="text-[9px] font-bold uppercase tracking-[0.06em] text-[var(--text-muted)]">{label}</div>
          <div className="mt-0.5 break-words font-mono text-[11px] font-medium leading-snug text-[var(--text-h)]">
            {value}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Secondary fields: aligned grid (default when dense) or inline flex. */
function InlineFieldsRow({
  items,
  dense,
  layout = "inline",
}: {
  items: { label: string; value: string }[];
  dense?: boolean;
  layout?: "inline" | "grid";
}) {
  const visible = items.filter((i) => i.value.trim() !== "");
  if (!visible.length) return null;

  if (layout === "grid" || dense) {
    const cols =
      visible.length >= 4
        ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
        : visible.length === 2
          ? "grid-cols-2"
          : "grid-cols-1 sm:grid-cols-2";
    return (
      <div className={`grid gap-x-4 gap-y-3 ${cols}`}>
        {visible.map(({ label, value }) => (
          <div key={label} className="min-w-0">
            <div className="text-[9px] font-bold uppercase tracking-[0.06em] text-[var(--text-muted)]">{label}</div>
            <div className="mt-0.5 break-words text-xs font-medium leading-snug text-[var(--text-h)]">
              {dense ? <span className="font-mono">{value}</span> : value}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 py-0.5">
      {visible.map(({ label, value }) => (
        <div key={label} className="min-w-0 max-w-full">
          <span className="text-[9px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{label}</span>{" "}
          <span className="break-words text-xs font-medium text-[var(--text-h)]">{value}</span>
        </div>
      ))}
    </div>
  );
}

/** Accent KPI box — optional full-width name row + even grid for remaining fields. */
function IdHeroKpiRow({
  items,
  variant = "even",
}: {
  items: { label: string; value: string; kind?: "name" | "mono" }[];
  variant?: "even" | "name-first";
}) {
  const visible = items.filter((i) => i.value.trim() !== "");
  if (!visible.length) return null;

  const nameIdx = visible.findIndex((i) => i.kind === "name");
  const nameItem = variant === "name-first" && nameIdx >= 0 ? visible[nameIdx] : null;
  const rest =
    variant === "name-first" && nameItem != null
      ? visible.filter((_, i) => i !== nameIdx)
      : visible;

  return (
    <div className="rounded-lg border border-[var(--accent)]/50 bg-[var(--accent-muted-strong)] px-2.5 py-2 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
      {nameItem ? (
        <div className="mb-2 border-b border-[var(--accent)]/30 pb-2">
          <div className="text-[9px] font-bold uppercase tracking-[0.08em] text-[var(--accent)]">{nameItem.label}</div>
          <div className="mt-1 whitespace-normal break-words text-[13px] font-bold leading-snug tracking-tight text-[var(--text-h)]">
            {nameItem.value}
          </div>
        </div>
      ) : null}
      <div
        className={
          rest.length === 1
            ? "grid grid-cols-1 gap-2"
            : rest.length === 2
              ? "grid grid-cols-2 gap-3"
              : "grid grid-cols-1 gap-2 min-[360px]:grid-cols-3"
        }
      >
        {rest.map((item) => (
          <div key={item.label} className="min-w-0">
            <div className="text-[9px] font-bold uppercase tracking-[0.08em] text-[var(--accent)]">{item.label}</div>
            <div className="mt-0.5 break-words font-mono text-[11px] font-semibold leading-snug text-[var(--text-h)]">
              {item.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ContactPill({ children, mono }: { children: string; mono?: boolean }) {
  return (
    <span
      className={`inline-flex max-w-full min-w-0 items-center rounded-md border border-[var(--accent)]/55 bg-[var(--accent-muted)] px-2.5 py-1 text-xs font-semibold text-[var(--accent)] shadow-sm ${
        mono ? "font-mono tracking-tight" : "break-all"
      }`}
    >
      {children}
    </span>
  );
}

function IdScanPreviewImage({
  storagePath,
  label,
  compact,
}: {
  storagePath: string;
  label: string;
  /** Small thumbnails for overview layout */
  compact?: boolean;
}) {
  const q = useQuery({
    queryKey: ["id-data-signed-url", storagePath],
    queryFn: () => createIdScanImageSignedUrl(storagePath, 3600),
    staleTime: 50 * 60 * 1000,
  });

  if (q.isLoading) {
    return <span className="text-xs text-[var(--text-muted)]">Loading {label}…</span>;
  }
  if (q.isError) {
    return <span className="text-xs text-red-400">{(q.error as Error).message}</span>;
  }
  return (
    <a
      href={q.data}
      target="_blank"
      rel="noreferrer"
      title="Open full size"
      className="block w-full max-w-full overflow-hidden rounded-md border border-[var(--border)] bg-black/20 transition-opacity hover:opacity-90"
    >
      <img
        src={q.data}
        alt={`ID ${label}`}
        className={
          compact
            ? "mx-auto block h-auto max-h-[6.75rem] w-full max-w-full object-contain sm:max-h-[7.25rem]"
            : "max-h-[min(52vh,28rem)] max-w-full rounded-lg object-contain"
        }
      />
    </a>
  );
}

type IdDataViewMode = "byDate" | "byGuest";

export function IdDataPage() {
  const settings = useHotelSettings();
  const hotelToday = useMemo(
    () => zonedDateString(new Date(), settings.timezone),
    [settings.timezone],
  );
  const [viewMode, setViewMode] = useState<IdDataViewMode>("byDate");
  const [fromDate, setFromDate] = useState(hotelToday);
  const [toDate, setToDate] = useState(hotelToday);
  const [agentFilter, setAgentFilter] = useState("");
  const [roomFilter, setRoomFilter] = useState("");
  const [listSearch, setListSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const scansQuery = useQuery({
    queryKey: ["id_scans_log", fromDate, toDate, settings.timezone],
    enabled: viewMode === "byDate",
    queryFn: async () => {
      const { startIso, endIso } = hotelDateRangeToUtcIso(fromDate, toDate, settings.timezone);
      let q = supabase.from("id_scans").select("*").order("scanned_at", { ascending: false });
      if (fromDate) q = q.gte("scanned_at", startIso);
      if (toDate) q = q.lte("scanned_at", endIso);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return data as IdScan[];
    },
  });

  /** Guest history: one load of all scans; search/filter is client-side only. */
  const allScansQuery = useQuery({
    queryKey: ["id_scans_all_history"],
    enabled: viewMode === "byGuest",
    queryFn: fetchAllIdScans,
    staleTime: 5 * 60 * 1000,
  });

  const activeScans =
    viewMode === "byGuest" ? (allScansQuery.data ?? []) : (scansQuery.data ?? []);
  const scansLoading = viewMode === "byGuest" ? allScansQuery.isLoading : scansQuery.isLoading;
  const scansError = viewMode === "byGuest" ? allScansQuery.error : scansQuery.error;

  const confirmationNumbers = useMemo(
    () => [...new Set(activeScans.map((s) => s.confirmation_number))],
    [activeScans],
  );

  const reservationQuery = useQuery({
    queryKey: ["id-data-reservations", confirmationNumbers],
    enabled: confirmationNumbers.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reservations")
        .select("confirmation_number, room_number, guest_name, check_in_date, check_out_date")
        .in("confirmation_number", confirmationNumbers);
      if (error) throw new Error(error.message);
      const byConf: Record<string, ReservationLite> = {};
      for (const r of (data ?? []) as ReservationLite[]) {
        byConf[r.confirmation_number] = r;
      }
      return byConf;
    },
    staleTime: 5 * 60 * 1000,
  });

  const scans = activeScans;
  const userIds = useMemo(
    () => [...new Set(activeScans.map((s) => s.scanned_by).filter(Boolean))] as string[],
    [activeScans],
  );

  const profilesQuery = useQuery({
    queryKey: ["id-data-profiles", userIds],
    enabled: userIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,email,full_name")
        .in("id", userIds);
      if (error) throw new Error(error.message);
      const map: Record<string, ProfileLite> = {};
      for (const p of (data ?? []) as ProfileLite[]) {
        map[p.id] = p;
      }
      return map;
    },
    staleTime: 5 * 60 * 1000,
  });

  const resByConf = reservationQuery.data ?? {};
  const profById = profilesQuery.data ?? {};

  const scanListMetaQuery = useQuery({
    queryKey: [
      "id-data-scan-meta",
      viewMode,
      scans.map((s) => s.id).join("|"),
      userIds.join("|"),
    ],
    enabled:
      !scansLoading &&
      !scansError &&
      scans.length > 0 &&
      reservationQuery.isSuccess &&
      (userIds.length === 0 || profilesQuery.isSuccess),
    queryFn: async () => {
      const resMap = reservationQuery.data ?? {};
      const profMap = profilesQuery.data ?? {};
      const out: Record<string, ScanListMeta> = {};
      for (const s of scans) {
        const agent = agentLabel(profMap[s.scanned_by ?? ""] ?? undefined, s.scanned_by);
        out[s.id] = await buildScanListMeta(s, resMap[s.confirmation_number], agent);
      }
      return out;
    },
    staleTime: 5 * 60 * 1000,
  });

  const rows = useMemo(() => {
    const roomTerm = roomFilter.trim().toLowerCase();
    const agentTerm = agentFilter.trim().toLowerCase();
    const searchRaw = listSearch.trim();
    const meta = scanListMetaQuery.data ?? {};

    let list = scans;
    if (roomTerm) {
      list = list.filter((s) =>
        (resByConf[s.confirmation_number]?.room_number ?? "").toLowerCase().includes(roomTerm),
      );
    }
    if (agentTerm) {
      list = list.filter((s) =>
        agentLabel(profById[s.scanned_by ?? ""] ?? undefined, s.scanned_by)
          .toLowerCase()
          .includes(agentTerm),
      );
    }
    if (!searchRaw) return list;

    return list.filter((s) => {
      const haystack = meta[s.id]?.haystack;
      if (haystack) return matchesListSearch(haystack, searchRaw);
      const res = resByConf[s.confirmation_number];
      const fallback = [
        s.confirmation_number,
        res?.guest_name,
        res?.room_number,
        agentLabel(profById[s.scanned_by ?? ""] ?? undefined, s.scanned_by),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return matchesListSearch(fallback, searchRaw);
    });
  }, [
    scans,
    resByConf,
    roomFilter,
    agentFilter,
    listSearch,
    profById,
    scanListMetaQuery.data,
  ]);

  const selectedScan = useMemo(
    () => rows.find((s) => s.id === selectedId) ?? null,
    [rows, selectedId],
  );

  useEffect(() => {
    if (!rows.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !rows.some((r) => r.id === selectedId)) {
      setSelectedId(rows[0]!.id);
    }
  }, [rows, selectedId]);

  const decryptQuery = useQuery({
    queryKey: ["id-data-decrypt", selectedScan?.id],
    enabled: !!selectedScan,
    queryFn: async () => {
      const scan = selectedScan!;
      let pii: DecryptedPii | null = null;
      let phone: string | null = null;
      let email: string | null = null;
      let piiError: string | null = null;

      if (isEncryptedPayload(scan.pii_encrypted)) {
        try {
          pii = await decryptJson<DecryptedPii>(scan.pii_encrypted);
        } catch (e) {
          piiError = (e as Error).message;
        }
      } else {
        piiError = "PII payload is missing or not in encrypted format (v1).";
      }

      if (scan.phone_encrypted && isEncryptedPayload(scan.phone_encrypted)) {
        try {
          const o = await decryptJson<{ value?: string }>(scan.phone_encrypted);
          phone = o.value?.trim() || null;
        } catch {
          phone = null;
        }
      }
      if (scan.email_encrypted && isEncryptedPayload(scan.email_encrypted)) {
        try {
          const o = await decryptJson<{ value?: string }>(scan.email_encrypted);
          email = o.value?.trim() || null;
        } catch {
          email = null;
        }
      }

      return { pii, phone, email, piiError };
    },
  });

  const handleExportCsv = useCallback(() => {
    const meta = scanListMetaQuery.data ?? {};
    const header = [
      "Scanned",
      "Agent",
      "Confirmation",
      "Guest display",
      "Room",
      "Reservation guest",
      "Manual",
      "OCR",
    ];
    const csvRows = [
      header,
      ...rows.map((s) => {
        const res = resByConf[s.confirmation_number];
        const guestDisp =
          (meta[s.id]?.displayName && meta[s.id]!.displayName !== "—"
            ? meta[s.id]!.displayName
            : "") || res?.guest_name?.trim() || "";
        return [
          new Date(s.scanned_at).toLocaleString(),
          agentLabel(profById[s.scanned_by ?? ""] ?? undefined, s.scanned_by),
          s.confirmation_number,
          guestDisp,
          res?.room_number ?? "",
          res?.guest_name ?? "",
          s.manual_entry ? "Yes" : "No",
          s.ocr_provider ?? "",
        ];
      }),
    ];
    const csv = csvRows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `id_scans_${fromDate}_to_${toDate}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }, [rows, resByConf, profById, fromDate, toDate, scanListMetaQuery.data]);

  const headerGuest = useMemo(() => {
    if (!selectedScan) return "Select a scan";
    const r = resByConf[selectedScan.confirmation_number];
    const fromDecrypt = idScanGuestDisplayName(decryptQuery.data?.pii ?? null, null);
    if (fromDecrypt !== "—") return fromDecrypt;
    const fromList = scanListMetaQuery.data?.[selectedScan.id]?.displayName;
    if (fromList && fromList !== "—") return fromList;
    if (r?.guest_name?.trim()) return r.guest_name.trim();
    return selectedScan.confirmation_number;
  }, [selectedScan, resByConf, scanListMetaQuery.data, decryptQuery.data]);

  const res = selectedScan ? resByConf[selectedScan.confirmation_number] : undefined;
  const profile = selectedScan?.scanned_by ? profById[selectedScan.scanned_by] : undefined;

  return (
    <div className="flex min-h-[calc(100svh-5.5rem)] flex-col gap-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 md:px-5">
        <div className="flex flex-wrap items-end gap-3 md:items-center md:justify-between">
          <div>
            <h1 className="text-base font-semibold text-[var(--text-h)]">ID data</h1>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              {viewMode === "byDate"
                ? "Daily scan log by date range. Search filters the loaded list only."
                : "Full check-in history loaded once — search by name, email, phone, ID #, conf, etc."}
            </p>
            <div className="mt-2 inline-flex rounded-lg border border-[var(--border)] bg-[var(--surface)] p-0.5">
              <button
                type="button"
                className={
                  viewMode === "byDate"
                    ? "rounded-md bg-[var(--accent-muted)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent)]"
                    : "rounded-md px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-h)]"
                }
                onClick={() => setViewMode("byDate")}
              >
                By date
              </button>
              <button
                type="button"
                className={
                  viewMode === "byGuest"
                    ? "rounded-md bg-[var(--accent-muted)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent)]"
                    : "rounded-md px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-h)]"
                }
                onClick={() => setViewMode("byGuest")}
              >
                Guest history
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3 md:justify-end">
            {viewMode === "byDate" ? (
              <>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                    From
                  </label>
                  <DateField
                    value={fromDate}
                    onChange={setFromDate}
                    aria-label="From date"
                    className="w-36"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                    To
                  </label>
                  <DateField value={toDate} onChange={setToDate} aria-label="To date" className="w-36" />
                </div>
              </>
            ) : null}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Agent
              </label>
              <input
                type="text"
                className="input-field w-40"
                placeholder="Filter…"
                value={agentFilter}
                onChange={(e) => setAgentFilter(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Room #
              </label>
              <input
                type="text"
                className="input-field w-24"
                placeholder="Room"
                value={roomFilter}
                onChange={(e) => setRoomFilter(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn-secondary flex items-center gap-2 self-end text-sm"
              onClick={handleExportCsv}
              disabled={rows.length === 0}
            >
              <Download className="h-4 w-4" aria-hidden />
              Export CSV
            </button>
          </div>
        </div>
      </div>

      {decryptQuery.isError ? (
        <div className="shrink-0 border-b border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-800/40 dark:bg-red-900/20 dark:text-red-400 md:px-5">
          <div className="flex items-start gap-2">
            <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{(decryptQuery.error as Error).message}</span>
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
        <div className="flex w-full shrink-0 flex-col border-[var(--border)] lg:w-[min(100%,22rem)] lg:border-r xl:w-[min(100%,26rem)]">
          <div className="border-b border-[var(--border)] p-3">
            <SearchField
              className="w-full bg-[var(--surface)]"
              placeholder="Name, email, phone, ID #, conf, room, address…"
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
              aria-label="Search ID scan list"
            />
            <p className="mt-2 text-[10px] text-[var(--text-muted)]">
              {scansLoading
                ? "Loading scans…"
                : scanListMetaQuery.isFetching && scans.length > 0
                  ? "Indexing decrypted fields for search…"
                  : `${rows.length} of ${scans.length} scan${scans.length !== 1 ? "s" : ""}${
                      listSearch.trim() || roomFilter.trim() || agentFilter.trim() ? " (filtered)" : ""
                    }`}
            </p>
          </div>
          <div className="min-h-[200px] flex-1 overflow-y-auto lg:max-h-none lg:min-h-[min(70vh,calc(100svh-14rem))]">
            {scansLoading ? (
              <p className="p-4 text-sm text-[var(--text-muted)]">Loading ID scans…</p>
            ) : scansError ? (
              <p className="p-4 text-sm text-red-400">{(scansError as Error).message}</p>
            ) : rows.length === 0 ? (
              <p className="p-4 text-sm text-[var(--text-muted)]">No scans match these filters.</p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface-2)] text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  <tr>
                    <th className="px-3 py-2">Guest</th>
                    <th className="px-3 py-2">Scanned</th>
                    <th className="hidden px-3 py-2 sm:table-cell">Conf.</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => {
                    const r = resByConf[s.confirmation_number];
                    const meta = scanListMetaQuery.data ?? {};
                    const guestShow = scanListMetaQuery.isPending
                      ? "…"
                      : (meta[s.id]?.displayName && meta[s.id]!.displayName !== "—"
                          ? meta[s.id]!.displayName
                          : r?.guest_name?.trim() || "—");
                    const active = s.id === selectedId;
                    return (
                      <tr
                        key={s.id}
                        className={
                          active
                            ? "cursor-pointer border-l-2 border-[var(--accent)] bg-[var(--accent-muted)]"
                            : "cursor-pointer border-l-2 border-transparent hover:bg-[var(--sidebar-hover)]"
                        }
                        onClick={() => setSelectedId(s.id)}
                        aria-current={active ? "true" : undefined}
                      >
                        <td className="min-w-0 max-w-[12rem] px-3 py-2 text-[var(--text-h)] sm:max-w-[20rem]">
                          <span className="block truncate" title={guestShow}>
                            {guestShow}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-[var(--text-muted)]">
                          {new Date(s.scanned_at).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                          <span className="hidden sm:inline">
                            {" "}
                            {new Date(s.scanned_at).toLocaleTimeString(undefined, {
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </span>
                        </td>
                        <td className="hidden max-w-[4rem] truncate px-3 py-2 font-mono text-[var(--text-muted)] sm:table-cell">
                          {s.confirmation_number}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg)]">
          <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 md:px-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2
                className="max-w-full truncate text-base font-bold tracking-tight text-[var(--accent)] md:text-lg"
                title={headerGuest}
              >
                {selectedScan ? headerGuest : "Select a scan"}
              </h2>
              {selectedScan ? (
                <Link
                  to={`/guest/${encodeURIComponent(selectedScan.confirmation_number)}`}
                  className="btn-secondary inline-flex shrink-0 items-center gap-1.5 py-1.5 text-xs"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  Guest
                </Link>
              ) : null}
            </div>
            {selectedScan ? (
              <p className="mt-0.5 truncate text-[10px] leading-snug text-[var(--text-muted)]" title={`${selectedScan.confirmation_number} · ${agentLabel(profile, selectedScan.scanned_by)} · ${new Date(selectedScan.scanned_at).toLocaleString()}${selectedScan.terminal_id ? ` · ${selectedScan.terminal_id}` : ""}`}>
                <span className="font-mono">{selectedScan.confirmation_number}</span>
                {" · "}
                {agentLabel(profile, selectedScan.scanned_by)}
                {" · "}
                {new Date(selectedScan.scanned_at).toLocaleString()}
                {selectedScan.terminal_id ? (
                  <>
                    {" · "}
                    <span className="font-mono">{selectedScan.terminal_id}</span>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>

          <div className="relative min-h-0 flex-1 overflow-y-auto p-2 md:p-3 lg:max-h-[calc(100svh-7.25rem)]">
            {!selectedScan ? (
              <div className="flex h-full min-h-[32vh] items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--text-muted)]">
                <div className="flex items-center gap-2">
                  <ScanLine className="h-5 w-5 shrink-0 opacity-60" aria-hidden />
                  Select a row on the left to preview decrypted ID data and images.
                </div>
              </div>
            ) : (
              <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-col gap-2 lg:max-h-[min(calc(100svh-8.25rem),58rem)] lg:overflow-y-auto">
                {decryptQuery.isLoading ? (
                  <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--text-muted)]">
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                    Loading decrypted fields…
                  </div>
                ) : null}

                {!decryptQuery.isLoading && decryptQuery.data?.piiError ? (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
                    {decryptQuery.data.piiError}
                    <span className="mt-1 block text-[10px] text-[var(--text-muted)]">
                      Check <code className="rounded bg-[var(--surface-2)] px-1">VITE_PII_ENCRYPTION_KEY</code> matches
                      the extension.
                    </span>
                  </div>
                ) : null}

                {/* Reference: 3 columns — images | identity + reservation + address | ID dates + scan */}
                <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_minmax(0,1fr)] lg:items-stretch">
                  <div className="flex min-w-0 w-full max-w-full flex-col gap-2 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5 shadow-sm sm:flex-row lg:flex-col">
                    {selectedScan.image_front_path ? (
                      <div className="min-w-0 w-full max-w-full flex-1 overflow-hidden rounded border border-[var(--border)] bg-black/15 p-1.5 sm:max-w-[min(49%,12rem)] lg:max-w-full lg:flex-none">
                        <div className="mb-1 text-[9px] font-bold uppercase tracking-wide text-[var(--accent)]">
                          Front
                        </div>
                        <IdScanPreviewImage
                          compact
                          storagePath={selectedScan.image_front_path}
                          label="front"
                        />
                      </div>
                    ) : null}
                    {selectedScan.image_back_path ? (
                      <div className="min-w-0 w-full max-w-full flex-1 overflow-hidden rounded border border-[var(--border)] bg-black/15 p-1.5 sm:max-w-[min(49%,12rem)] lg:max-w-full lg:flex-none">
                        <div className="mb-1 text-[9px] font-bold uppercase tracking-wide text-[var(--accent)]">
                          Back
                        </div>
                        <IdScanPreviewImage
                          compact
                          storagePath={selectedScan.image_back_path}
                          label="back"
                        />
                      </div>
                    ) : null}
                    {!selectedScan.image_front_path && !selectedScan.image_back_path ? (
                      <p className="self-center text-[11px] text-[var(--text-muted)]">No ID images.</p>
                    ) : null}
                  </div>

                  <div className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5 shadow-sm">
                    {!decryptQuery.isLoading && decryptQuery.data?.pii ? (
                      <IdHeroKpiRow
                        variant="name-first"
                        items={[
                          { label: "Full name", value: decryptQuery.data.pii.fullName ?? "", kind: "name" },
                          { label: "DOB", value: decryptQuery.data.pii.dateOfBirth ?? "", kind: "mono" },
                          { label: "ID #", value: decryptQuery.data.pii.idNumber ?? "", kind: "mono" },
                        ]}
                      />
                    ) : null}

                    <div>
                      <h3 className="text-[9px] font-bold uppercase tracking-[0.08em] text-[var(--accent)]">
                        Reservation
                      </h3>
                      {res?.guest_name?.trim() ||
                      res?.room_number?.trim() ||
                      res?.check_in_date?.trim() ||
                      res?.check_out_date?.trim() ? (
                        <div className="mt-1.5">
                          <InlineFieldsRow
                            dense
                            items={[
                              { label: "Guest (PMS)", value: res?.guest_name ?? "" },
                              { label: "Room", value: res?.room_number ?? "" },
                              { label: "Check-in", value: res?.check_in_date ?? "" },
                              { label: "Check-out", value: res?.check_out_date ?? "" },
                            ]}
                          />
                        </div>
                      ) : (
                        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                          No reservation (e.g. walk-in).
                        </p>
                      )}
                    </div>

                    <div className="border-t border-[var(--border)] pt-2.5">
                      <h3 className="text-[9px] font-bold uppercase tracking-[0.08em] text-[var(--accent)]">
                        Address & remarks
                      </h3>
                      <div className="mt-1.5 space-y-2">
                        {!decryptQuery.isLoading && decryptQuery.data?.pii ? (
                          <>
                            {decryptQuery.data.pii.address?.trim() ? (
                              <div className="min-w-0">
                                <div className="text-[9px] font-bold uppercase tracking-[0.06em] text-[var(--text-muted)]">
                                  Address
                                </div>
                                <div className="mt-0.5 break-words font-mono text-[11px] font-medium leading-relaxed text-[var(--text-h)]">
                                  {decryptQuery.data.pii.address}
                                </div>
                              </div>
                            ) : null}
                            <InlineFieldsRow
                              dense
                              items={[
                                { label: "Remark (guest)", value: decryptQuery.data.pii.remarks?.guest ?? "" },
                                { label: "Remark (check-in)", value: decryptQuery.data.pii.remarks?.checkIn ?? "" },
                              ]}
                            />
                          </>
                        ) : (
                          <p className="text-[10px] text-[var(--text-muted)]">—</p>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5 shadow-sm">
                    {!decryptQuery.isLoading && decryptQuery.data?.pii ? (
                      <IdHeroKpiRow
                        variant="even"
                        items={[
                          { label: "ID type", value: decryptQuery.data.pii.idType ?? "", kind: "mono" },
                          { label: "Expires", value: decryptQuery.data.pii.expiryDate ?? "", kind: "mono" },
                          { label: "Issued", value: decryptQuery.data.pii.issueDate ?? "", kind: "mono" },
                        ]}
                      />
                    ) : null}

                    <div className="min-h-0 flex-1">
                      <h3 className="text-[9px] font-bold uppercase tracking-[0.08em] text-[var(--accent)]">
                        Scan record
                      </h3>
                      <div className="mt-1.5">
                        <InlineFieldsRow
                          dense
                          items={[
                            { label: "Manual", value: selectedScan.manual_entry ? "Yes" : "No" },
                            { label: "OCR", value: selectedScan.ocr_provider ?? "" },
                          ]}
                        />
                        {decryptQuery.isLoading ? (
                          <p className="mt-1.5 text-[10px] text-[var(--text-muted)]">Loading phone / email…</p>
                        ) : (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {decryptQuery.data?.phone?.trim() ? (
                              <ContactPill mono>{decryptQuery.data.phone}</ContactPill>
                            ) : null}
                            {decryptQuery.data?.email?.trim() ? (
                              <ContactPill>{decryptQuery.data.email}</ContactPill>
                            ) : null}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Bottom: structured AAMVA + raw JSON (reference “address info” block) */}
                <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5 shadow-sm">
                  <h3 className="border-b border-[var(--border)]/80 pb-2 text-[9px] font-bold uppercase tracking-[0.08em] text-[var(--accent)]">
                    Structured address / contact
                  </h3>
                  {!decryptQuery.isLoading && decryptQuery.data?.pii?.idGuru ? (
                    <>
                      <div className="mt-2.5">
                        <IdDataFieldGrid
                          items={[
                            { label: "First", value: decryptQuery.data.pii.idGuru.firstName ?? "" },
                            { label: "Middle", value: decryptQuery.data.pii.idGuru.middleName ?? "" },
                            { label: "Last", value: decryptQuery.data.pii.idGuru.lastName ?? "" },
                            { label: "Street", value: decryptQuery.data.pii.idGuru.streetAddress ?? "" },
                            { label: "City", value: decryptQuery.data.pii.idGuru.city ?? "" },
                            { label: "State", value: decryptQuery.data.pii.idGuru.state ?? "" },
                            { label: "Postal", value: decryptQuery.data.pii.idGuru.postalCode ?? "" },
                          ]}
                        />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
                        {decryptQuery.data.pii.idGuru.phone?.trim() ? (
                          <ContactPill mono>{decryptQuery.data.pii.idGuru.phone}</ContactPill>
                        ) : null}
                        {decryptQuery.data.pii.idGuru.email?.trim() ? (
                          <ContactPill>{decryptQuery.data.pii.idGuru.email}</ContactPill>
                        ) : null}
                      </div>
                    </>
                  ) : !decryptQuery.isLoading ? (
                    <p className="mt-2 text-[11px] text-[var(--text-muted)]">No structured AAMVA / Guru fields.</p>
                  ) : null}

                  <div className="mt-3 space-y-2 border-t border-[var(--border)] pt-3">
                    {selectedScan.ocr_raw && Object.keys(selectedScan.ocr_raw).length > 0 ? (
                      <details className="group rounded-md border border-[var(--border)] bg-[var(--surface-2)]/50">
                        <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-[10px] font-bold text-[var(--accent)] [&::-webkit-details-marker]:hidden">
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--accent)] transition-transform group-open:rotate-90" aria-hidden />
                          OCR raw (JSON)
                        </summary>
                        <pre className="mx-2 mb-2 max-h-28 overflow-auto rounded border border-[var(--border)]/60 bg-[var(--surface-2)] p-2 font-mono text-[10px] leading-relaxed text-[var(--text-muted)]">
                          {JSON.stringify(selectedScan.ocr_raw, null, 2)}
                        </pre>
                      </details>
                    ) : null}

                    {!decryptQuery.isLoading &&
                    decryptQuery.data?.pii?.documentDataSnapshot &&
                    Object.keys(decryptQuery.data.pii.documentDataSnapshot).length > 0 ? (
                      <details className="group rounded-md border border-[var(--border)] bg-[var(--surface-2)]/50">
                        <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-[10px] font-bold text-[var(--accent)] [&::-webkit-details-marker]:hidden">
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--accent)] transition-transform group-open:rotate-90" aria-hidden />
                          Document snapshot (JSON)
                        </summary>
                        <pre className="mx-2 mb-2 max-h-28 overflow-auto rounded border border-[var(--border)]/60 bg-[var(--surface-2)] p-2 font-mono text-[10px] leading-relaxed text-[var(--text-muted)]">
                          {JSON.stringify(decryptQuery.data.pii.documentDataSnapshot, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
