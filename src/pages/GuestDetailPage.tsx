import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowLeft,
  CalendarRange,
  Clock,
  Download,
  ExternalLink,
  FileText,
  KeyRound,
  Loader2,
  Mail,
  Phone,
  ScanLine,
  ScrollText,
} from "lucide-react";
import { formatStayDate } from "@/lib/calendarDate";
import { contactFromReservation } from "@/lib/reservationContact";
import { decryptBinary } from "@/lib/encryption";
import { keyHistoryAgent, keyHistoryEventTime, keyHistoryNights } from "@/lib/keyHistory";
import { resolveDownloadUrl } from "@/lib/b2Storage";
import { createIdScanImageSignedUrl } from "@/lib/idScanStorage";
import { supabase } from "@/lib/supabase";
import { formatRoomChainForDisplay } from "@/lib/roomNumber";
import { DnrPill, StatusPill } from "@/components/ui/StatusPill";
import type { AuditLogRow, IdScan, KeyHistoryRow, PmsSource, Reservation, Signature } from "@/types/database";

type TabId = "id" | "keys" | "audit" | "regcards";

function IdScanImage({ storagePath, label }: { storagePath: string; label: string }) {
  const q = useQuery({
    queryKey: ["signed-url", "id-scan-image", storagePath],
    queryFn: () => createIdScanImageSignedUrl(storagePath, 3600),
    staleTime: 50 * 60 * 1000,
  });

  if (q.isLoading) {
    return <span className="text-sm text-[var(--text-muted)]">Loading {label}…</span>;
  }
  if (q.isError) {
    return (
      <span className="text-sm text-red-400">
        {(q.error as Error).message}
      </span>
    );
  }
  return (
    <a
      href={q.data}
      target="_blank"
      rel="noreferrer"
      className="inline-block rounded-lg border border-[var(--border)] transition-opacity hover:opacity-95"
    >
      <img
        src={q.data}
        alt={`ID ${label}`}
        className="max-h-48 max-w-full rounded-lg object-contain"
      />
    </a>
  );
}

function StatCard({
  label,
  children,
  icon: Icon,
}: {
  label: string;
  children: ReactNode;
  icon: LucideIcon;
}) {
  return (
    <div className="flex min-w-0 gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-3)] text-[var(--accent)]">
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          {label}
        </div>
        <div className="mt-1.5 min-w-0 text-sm font-medium text-[var(--text-h)]">{children}</div>
      </div>
    </div>
  );
}

async function fetchDecryptPdfBlob(storagePath: string): Promise<Blob> {
  const signedUrl = await resolveDownloadUrl({
    category: "signature-pdfs",
    objectPath: storagePath,
    expiresIn: 3600,
  });
  const res = await fetch(signedUrl);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  const decrypted = await decryptBinary(new Uint8Array(buf));
  return new Blob([new Uint8Array(decrypted).buffer as ArrayBuffer], { type: "application/pdf" });
}

function SignatureRow({ sig }: { sig: Signature }) {
  const [busy, setBusy] = useState<"download" | "open" | null>(null);
  const [err, setErr]   = useState<string | null>(null);

  async function handle(action: "download" | "open") {
    setBusy(action);
    setErr(null);
    try {
      const blob = await fetchDecryptPdfBlob(sig.storage_path);
      const url  = URL.createObjectURL(blob);
      if (action === "download") {
        const a   = document.createElement("a");
        a.href    = url;
        a.download = `reg_card_${sig.confirmation_number}_${sig.created_at.slice(0, 10)}.pdf`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
      } else {
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-3)] text-[var(--accent)]">
        <FileText className="h-5 w-5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--text-h)]">
          Signed {new Date(sig.created_at).toLocaleString()}
        </p>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          By {sig.signed_by_username ?? sig.signed_by}
          {sig.terminal_id ? ` · Terminal ${sig.terminal_id}` : ""}
        </p>
        {err ? <p className="mt-1 text-xs text-red-400">{err}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void handle("open")}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-3)] px-3 py-1.5 text-xs font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface)] disabled:opacity-40"
        >
          {busy === "open"
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            : <ExternalLink className="h-3.5 w-3.5" aria-hidden />}
          Open
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void handle("download")}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-3)] px-3 py-1.5 text-xs font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface)] disabled:opacity-40"
        >
          {busy === "download"
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            : <Download className="h-3.5 w-3.5" aria-hidden />}
          Download
        </button>
      </div>
    </li>
  );
}

export function GuestDetailPage() {
  const { confirmationNumber: rawCn } = useParams<{ confirmationNumber: string }>();
  const [searchParams] = useSearchParams();
  const pms = (searchParams.get("pms") as PmsSource | null) ?? undefined;
  const queryClient = useQueryClient();

  const confirmationNumber = rawCn ? decodeURIComponent(rawCn) : "";

  const [tab, setTab] = useState<TabId>("id");

  const reservationQuery = useQuery({
    queryKey: ["reservation", confirmationNumber, pms ?? "any"],
    enabled: !!confirmationNumber,
    queryFn: async () => {
      let q = supabase.from("reservations").select("*").eq("confirmation_number", confirmationNumber);
      if (pms) {
        q = q.eq("pms_source", pms);
      } else {
        q = q.order("created_at", { ascending: false }).limit(1);
      }
      const { data, error } = await q.maybeSingle();
      if (error) throw new Error(error.message);
      return data as Reservation | null;
    },
  });

  const scansQuery = useQuery({
    queryKey: ["id_scans", confirmationNumber],
    enabled: !!confirmationNumber,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("id_scans")
        .select("*")
        .eq("confirmation_number", confirmationNumber)
        .order("scanned_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data as IdScan[];
    },
  });

  const auditQuery = useQuery({
    queryKey: ["audit_log", confirmationNumber],
    enabled: !!confirmationNumber && tab === "audit",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("audit_log")
        .select("*")
        .eq("confirmation_number", confirmationNumber)
        .order("occurred_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data as AuditLogRow[];
    },
  });

  const keysQuery = useQuery({
    queryKey: ["key_history", confirmationNumber],
    enabled: !!confirmationNumber && tab === "keys",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("key_history")
        .select("*")
        .eq("confirmation_number", confirmationNumber)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data as KeyHistoryRow[];
    },
  });

  const signaturesQuery = useQuery({
    queryKey: ["signatures_tab", confirmationNumber],
    enabled: !!confirmationNumber && tab === "regcards",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signatures")
        .select("*")
        .eq("confirmation_number", confirmationNumber)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data as Signature[];
    },
  });

  useEffect(() => {
    if (!confirmationNumber) return;

    const channel = supabase
      .channel(`guest-realtime-${confirmationNumber}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "id_scans",
          filter: `confirmation_number=eq.${confirmationNumber}`,
        },
        () => {
          void queryClient.invalidateQueries({ queryKey: ["id_scans", confirmationNumber] });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "reservations",
          filter: `confirmation_number=eq.${confirmationNumber}`,
        },
        () => {
          void queryClient.invalidateQueries({
            queryKey: ["reservation", confirmationNumber, pms ?? "any"],
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "key_history",
          filter: `confirmation_number=eq.${confirmationNumber}`,
        },
        () => {
          void queryClient.invalidateQueries({ queryKey: ["key_history", confirmationNumber] });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "signatures",
          filter: `confirmation_number=eq.${confirmationNumber}`,
        },
        () => {
          void queryClient.invalidateQueries({ queryKey: ["signatures_tab", confirmationNumber] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [confirmationNumber, pms, queryClient]);

  const res = reservationQuery.data;

  const guestContact = useMemo(
    () => (res ? contactFromReservation(res) : { email: "", phone: "" }),
    [res],
  );

  const titleLine = useMemo(() => {
    if (!res) return "";
    const roomChain = formatRoomChainForDisplay(res);
    const parts = [res.guest_name, roomChain ? `Room ${roomChain}` : null].filter(Boolean);
    return parts.join(" · ");
  }, [res]);

  if (!confirmationNumber) {
    return <p className="text-[var(--text-muted)]">Missing confirmation number.</p>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div>
        <Link
          to="/reservations"
          className="inline-flex items-center gap-2 text-sm font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
        >
          <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
          Back to reservations
        </Link>
      </div>

      {reservationQuery.isLoading ? (
        <p className="text-[var(--text-muted)]" role="status">
          Loading guest…
        </p>
      ) : reservationQuery.isError ? (
        <p className="text-red-400" role="alert">
          {(reservationQuery.error as Error).message}
        </p>
      ) : !res ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 text-[var(--text)]">
          No reservation found for{" "}
          <span className="font-mono font-medium text-[var(--text-h)]">{confirmationNumber}</span>
          {pms ? (
            <>
              {" "}
              ({pms})
            </>
          ) : null}
          .
        </div>
      ) : (
        <>
          <header className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            <div className="border-b border-[var(--border)] bg-[var(--surface-2)]/50 px-6 py-5 md:px-8">
              <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Confirmation
              </p>
              <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-[var(--text-h)] md:text-3xl">
                {res.confirmation_number}
              </h1>
              {titleLine ? (
                <p className="mt-2 truncate text-base text-[var(--text)]" title={titleLine}>
                  {titleLine}
                </p>
              ) : null}

              {(guestContact.email || guestContact.phone) && (
                <div className="mt-3 flex min-w-0 flex-col gap-1.5 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5 sm:gap-y-1">
                  {guestContact.email ? (
                    <a
                      href={`mailto:${guestContact.email}`}
                      className="inline-flex min-w-0 items-center gap-2 text-[var(--accent)] underline-offset-2 hover:underline"
                      title={guestContact.email}
                    >
                      <Mail className="h-4 w-4 shrink-0 opacity-80" aria-hidden />
                      <span className="truncate font-medium">{guestContact.email}</span>
                    </a>
                  ) : null}
                  {guestContact.phone ? (
                    <a
                      href={`tel:${guestContact.phone.replace(/\s/g, "")}`}
                      className="inline-flex min-w-0 items-center gap-2 text-[var(--accent)] underline-offset-2 hover:underline"
                      title={guestContact.phone}
                    >
                      <Phone className="h-4 w-4 shrink-0 opacity-80" aria-hidden />
                      <span className="truncate font-medium">{guestContact.phone}</span>
                    </a>
                  ) : null}
                </div>
              )}

              <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--border)] pt-5 text-sm">
                <span className="inline-flex min-w-0 items-center gap-2 text-[var(--text)]">
                  <CalendarRange className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
                  <span className="truncate">
                    {formatStayDate(res.check_in_date)} → {formatStayDate(res.check_out_date)}
                  </span>
                </span>
                <span className="text-[var(--border)]">|</span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-[var(--text-muted)]">PMS</span>
                  <span className="rounded-md bg-[var(--surface-3)] px-2 py-0.5 text-xs font-semibold uppercase text-[var(--text-h)]">
                    {res.pms_source}
                  </span>
                </span>
              </div>
            </div>

            <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 md:p-6">
              <StatCard label="Reservation status" icon={Activity}>
                <span className="inline-flex max-w-full">
                  <StatusPill label={res.reservation_status} />
                </span>
              </StatCard>
              <StatCard label="DNR check" icon={ScanLine}>
                <DnrPill hit={res.dnr_hit} />
              </StatCard>
              <StatCard label="Last synced" icon={Clock}>
                <span className="block truncate" title={res.last_scraped_at ?? ""}>
                  {res.last_scraped_at
                    ? new Date(res.last_scraped_at).toLocaleString()
                    : "—"}
                </span>
              </StatCard>
              <StatCard label="Email" icon={Mail}>
                {guestContact.email ? (
                  <a
                    href={`mailto:${guestContact.email}`}
                    className="break-all text-[var(--accent)] underline-offset-2 hover:underline"
                  >
                    {guestContact.email}
                  </a>
                ) : (
                  "—"
                )}
              </StatCard>
              <StatCard label="Phone" icon={Phone}>
                {guestContact.phone ? (
                  <a
                    href={`tel:${guestContact.phone.replace(/\s/g, "")}`}
                    className="break-all text-[var(--accent)] underline-offset-2 hover:underline"
                  >
                    {guestContact.phone}
                  </a>
                ) : (
                  "—"
                )}
              </StatCard>
            </div>
          </header>

          <div role="tablist" aria-label="Guest sections" className="flex flex-wrap gap-2 border-b border-[var(--border)] pb-0">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "id"}
              className={[
                "inline-flex items-center gap-2 rounded-t-lg px-4 py-2.5 text-sm font-medium transition-colors",
                tab === "id"
                  ? "border border-b-0 border-[var(--border)] bg-[var(--surface)] text-[var(--text-h)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-h)]",
              ].join(" ")}
              onClick={() => setTab("id")}
            >
              <ScanLine className="h-4 w-4" aria-hidden />
              ID scans
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "regcards"}
              className={[
                "inline-flex items-center gap-2 rounded-t-lg px-4 py-2.5 text-sm font-medium transition-colors",
                tab === "regcards"
                  ? "border border-b-0 border-[var(--border)] bg-[var(--surface)] text-[var(--text-h)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-h)]",
              ].join(" ")}
              onClick={() => setTab("regcards")}
            >
              <FileText className="h-4 w-4" aria-hidden />
              Reg Cards
              {signaturesQuery.data ? (
                <span className="ml-1 rounded-full bg-[var(--surface-3)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-muted)]">
                  {signaturesQuery.data.length}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "keys"}
              className={[
                "inline-flex items-center gap-2 rounded-t-lg px-4 py-2.5 text-sm font-medium transition-colors",
                tab === "keys"
                  ? "border border-b-0 border-[var(--border)] bg-[var(--surface)] text-[var(--text-h)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-h)]",
              ].join(" ")}
              onClick={() => setTab("keys")}
            >
              <KeyRound className="h-4 w-4" aria-hidden />
              Room keys
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "audit"}
              className={[
                "inline-flex items-center gap-2 rounded-t-lg px-4 py-2.5 text-sm font-medium transition-colors",
                tab === "audit"
                  ? "border border-b-0 border-[var(--border)] bg-[var(--surface)] text-[var(--text-h)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-h)]",
              ].join(" ")}
              onClick={() => setTab("audit")}
            >
              <ScrollText className="h-4 w-4" aria-hidden />
              Audit trail
            </button>
          </div>

          {tab === "id" ? (
            <section
              aria-labelledby="id-heading"
              className="rounded-b-xl rounded-tr-xl border border-t-0 border-[var(--border)] bg-[var(--surface)] p-6 md:p-8"
            >
              <h2 id="id-heading" className="text-lg font-semibold text-[var(--text-h)]">
                ID scans
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--text-muted)]">
                Encrypted identity data stays on the server. Here you only see scan times and ID
                images when available.
              </p>
              {scansQuery.isLoading ? (
                <p className="mt-6 text-sm text-[var(--text-muted)]">Loading scans…</p>
              ) : scansQuery.isError ? (
                <p className="mt-6 text-red-400">{(scansQuery.error as Error).message}</p>
              ) : !scansQuery.data?.length ? (
                <p className="mt-6 rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                  No ID scans for this reservation yet.
                </p>
              ) : (
                <ul className="mt-6 space-y-4">
                  {scansQuery.data.map((scan) => (
                    <li
                      key={scan.id}
                      className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4 md:p-5"
                    >
                      <div className="flex flex-col gap-4 md:flex-row md:gap-6">
                        <div className="min-w-0 flex-1 space-y-2 text-sm">
                          <p className="text-[var(--text)]">
                            <span className="font-medium text-[var(--text-h)]">Scanned</span>{" "}
                            {new Date(scan.scanned_at).toLocaleString()}
                          </p>
                          <p className="truncate text-[var(--text)]" title={scan.scanned_by ?? ""}>
                            <span className="font-medium text-[var(--text-h)]">By</span>{" "}
                            {scan.scanned_by ?? "—"}
                          </p>
                          <p className="text-[var(--text)]">
                            <span className="font-medium text-[var(--text-h)]">Manual entry</span>{" "}
                            {scan.manual_entry ? "Yes" : "No"}
                          </p>
                          {scan.ocr_provider ? (
                            <p className="truncate text-[var(--text)]" title={scan.ocr_provider}>
                              <span className="font-medium text-[var(--text-h)]">OCR</span>{" "}
                              {scan.ocr_provider}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 flex-col gap-4 sm:flex-row">
                          {scan.image_front_path ? (
                            <div>
                              <div className="mb-1.5 text-xs font-medium text-[var(--text-muted)]">
                                Front
                              </div>
                              <IdScanImage storagePath={scan.image_front_path} label="front" />
                            </div>
                          ) : null}
                          {scan.image_back_path ? (
                            <div>
                              <div className="mb-1.5 text-xs font-medium text-[var(--text-muted)]">
                                Back
                              </div>
                              <IdScanImage storagePath={scan.image_back_path} label="back" />
                            </div>
                          ) : null}
                          {!scan.image_front_path && !scan.image_back_path ? (
                            <span className="text-sm text-[var(--text-muted)]">No images on file</span>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {tab === "keys" ? (
            <section
              aria-labelledby="keys-heading"
              className="rounded-b-xl rounded-tr-xl border border-t-0 border-[var(--border)] bg-[var(--surface)] p-6 md:p-8"
            >
              <h2 id="keys-heading" className="text-lg font-semibold text-[var(--text-h)]">
                Room keys
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--text-muted)]">
                Permanent log of RFID encodings for this confirmation (same data as{" "}
                <Link to="/keys" className="text-[var(--accent)] underline-offset-2 hover:underline">
                  Keys
                </Link>{" "}
                in the sidebar).
              </p>
              {keysQuery.isLoading ? (
                <p className="mt-6 text-sm text-[var(--text-muted)]">Loading key history…</p>
              ) : keysQuery.isError ? (
                <p className="mt-6 text-red-400">{(keysQuery.error as Error).message}</p>
              ) : !keysQuery.data?.length ? (
                <p className="mt-6 rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                  No key encodings recorded for this reservation yet.
                </p>
              ) : (
                <div className="mt-6 overflow-x-auto rounded-xl border border-[var(--border)]">
                  <table className="data-table min-w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th scope="col">Encoded</th>
                        <th scope="col">Room</th>
                        <th scope="col">Nights</th>
                        <th scope="col">Agent</th>
                        <th scope="col">Terminal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {keysQuery.data.map((row) => {
                        const when = keyHistoryEventTime(row);
                        return (
                          <tr key={row.id}>
                            <td className="whitespace-nowrap text-[var(--text-muted)]">
                              {when ? new Date(when).toLocaleString() : "—"}
                            </td>
                            <td className="font-mono text-[var(--text-h)]">
                              {row.room_number ?? "—"}
                            </td>
                            <td className="text-[var(--text)]">
                              {keyHistoryNights(row) !== null ? keyHistoryNights(row) : "—"}
                            </td>
                            <td className="max-w-[10rem] min-w-0">
                              <span className="block truncate" title={keyHistoryAgent(row) ?? ""}>
                                {keyHistoryAgent(row) ?? "—"}
                              </span>
                            </td>
                            <td className="font-mono text-xs text-[var(--text-muted)]">
                              {row.terminal_id ?? "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}

          {tab === "regcards" ? (
            <section
              aria-labelledby="regcards-heading"
              className="rounded-b-xl rounded-tr-xl border border-t-0 border-[var(--border)] bg-[var(--surface)] p-6 md:p-8"
            >
              <h2 id="regcards-heading" className="text-lg font-semibold text-[var(--text-h)]">
                Signed reg cards
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--text-muted)]">
                Encrypted reg card PDFs saved when a guest signed at check-in. Each file is
                decrypted on download — nothing is stored in plain text.
              </p>
              {signaturesQuery.isLoading ? (
                <p className="mt-6 text-sm text-[var(--text-muted)]">Loading…</p>
              ) : signaturesQuery.isError ? (
                <p className="mt-6 text-red-400">{(signaturesQuery.error as Error).message}</p>
              ) : !signaturesQuery.data?.length ? (
                <p className="mt-6 rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                  No signed reg cards on file for this reservation.
                </p>
              ) : (
                <ul className="mt-6 space-y-3">
                  {signaturesQuery.data.map((sig) => (
                    <SignatureRow key={sig.id} sig={sig} />
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {tab === "audit" ? (
            <section
              aria-labelledby="audit-heading"
              className="rounded-b-xl rounded-tr-xl border border-t-0 border-[var(--border)] bg-[var(--surface)] p-6 md:p-8"
            >
              <h2 id="audit-heading" className="text-lg font-semibold text-[var(--text-h)]">
                Audit trail
              </h2>
              {auditQuery.isLoading ? (
                <p className="mt-6 text-sm text-[var(--text-muted)]">Loading audit…</p>
              ) : auditQuery.isError ? (
                <p className="mt-6 text-red-400">{(auditQuery.error as Error).message}</p>
              ) : !auditQuery.data?.length ? (
                <p className="mt-6 text-sm text-[var(--text-muted)]">
                  No audit entries for this reservation yet.
                </p>
              ) : (
                <div className="mt-6 overflow-x-auto rounded-xl border border-[var(--border)]">
                  <table className="data-table min-w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th scope="col">Time</th>
                        <th scope="col">Action</th>
                        <th scope="col">User</th>
                        <th scope="col">Role</th>
                        <th scope="col">Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditQuery.data.map((row) => (
                        <tr key={row.id}>
                          <td className="whitespace-nowrap text-[var(--text-muted)]">
                            {new Date(row.occurred_at).toLocaleString()}
                          </td>
                          <td className="font-medium text-[var(--text-h)]">{row.action_type}</td>
                          <td className="max-w-[8rem] min-w-0">
                            <span className="block truncate" title={row.username ?? ""}>
                              {row.username ?? "—"}
                            </span>
                          </td>
                          <td className="text-[var(--text-muted)]">{row.user_role ?? "—"}</td>
                          <td className="max-w-md min-w-[12rem]">
                            {row.description ? (
                              <p className="mb-1 line-clamp-2 text-[var(--text)]">{row.description}</p>
                            ) : null}
                            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-2)] p-2 text-xs text-[var(--text-muted)]">
                              {JSON.stringify({ old: row.old_value, new: row.new_value }, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
