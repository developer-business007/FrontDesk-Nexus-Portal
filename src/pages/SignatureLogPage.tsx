import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink, FileText, Loader2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { localDateString } from "@/lib/date";
import { decryptBinary } from "@/lib/encryption";
import { resolveDownloadUrl } from "@/lib/b2Storage";
import { DateField } from "@/components/ui/DateField";
import { SearchField } from "@/components/ui/SearchField";
import type { Signature } from "@/types/database";

const today = localDateString();

type ReservationLite = {
  confirmation_number: string;
  room_number: string | null;
  guest_name: string | null;
  check_in_date: string | null;
  check_out_date: string | null;
};

async function fetchDecryptPdfBlob(sig: Signature): Promise<Blob> {
  const signedUrl = await resolveDownloadUrl({
    category: "signature-pdfs",
    objectPath: sig.storage_path,
    expiresIn: 3600,
  });

  const res = await fetch(signedUrl);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);

  const buf = await res.arrayBuffer();
  const decrypted = await decryptBinary(new Uint8Array(buf));
  const ab = new Uint8Array(decrypted).buffer;
  return new Blob([ab], { type: "application/pdf" });
}

export function SignatureLogPage() {
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [agentFilter, setAgentFilter] = useState("");
  const [roomFilter, setRoomFilter] = useState("");
  const [listSearch, setListSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const previewBlobUrlRef = useRef<string | null>(null);

  const sigQuery = useQuery({
    queryKey: ["signatures", fromDate, toDate, agentFilter],
    queryFn: async () => {
      let q = supabase
        .from("signatures")
        .select("*")
        .order("created_at", { ascending: false });

      if (fromDate) q = q.gte("created_at", `${fromDate}T00:00:00`);
      if (toDate) q = q.lte("created_at", `${toDate}T23:59:59.999`);
      if (agentFilter.trim()) q = q.ilike("signed_by_username", `%${agentFilter.trim()}%`);

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return data as Signature[];
    },
  });

  const confirmationNumbers = useMemo(
    () => [...new Set((sigQuery.data ?? []).map((s) => s.confirmation_number))],
    [sigQuery.data],
  );

  const reservationQuery = useQuery({
    queryKey: ["sig-reservation-details", confirmationNumbers],
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

  const resByConf = reservationQuery.data ?? {};

  const rows = useMemo(() => {
    const sigs = sigQuery.data ?? [];
    const roomTerm = roomFilter.trim().toLowerCase();
    let list = sigs;
    if (roomTerm) {
      list = list.filter((s) =>
        (resByConf[s.confirmation_number]?.room_number ?? "").toLowerCase().includes(roomTerm),
      );
    }
    const q = listSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) => {
      const res = resByConf[s.confirmation_number];
      const room = (res?.room_number ?? "").toLowerCase();
      const guest = (res?.guest_name ?? "").toLowerCase();
      const conf = s.confirmation_number.toLowerCase();
      const agent = (s.signed_by_username ?? "").toLowerCase();
      return (
        conf.includes(q) || room.includes(q) || guest.includes(q) || agent.includes(q)
      );
    });
  }, [sigQuery.data, resByConf, roomFilter, listSearch]);

  const selectedSig = useMemo(
    () => rows.find((s) => s.id === selectedId) ?? null,
    [rows, selectedId],
  );

  useEffect(() => {
    if (!rows.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !rows.some((r) => r.id === selectedId)) {
      setSelectedId(rows[0].id);
    }
  }, [rows, selectedId]);

  useEffect(() => {
    if (!selectedSig) {
      if (previewBlobUrlRef.current) {
        URL.revokeObjectURL(previewBlobUrlRef.current);
        previewBlobUrlRef.current = null;
      }
      setPreviewUrl(null);
      setPreviewLoading(false);
      setPreviewError(null);
      return;
    }

    let cancelled = false;

    (async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const blob = await fetchDecryptPdfBlob(selectedSig);
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (previewBlobUrlRef.current) URL.revokeObjectURL(previewBlobUrlRef.current);
        previewBlobUrlRef.current = url;
        setPreviewUrl(url);
      } catch (err) {
        if (!cancelled) {
          setPreviewError((err as Error).message);
          setPreviewUrl(null);
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (previewBlobUrlRef.current) {
        URL.revokeObjectURL(previewBlobUrlRef.current);
        previewBlobUrlRef.current = null;
      }
      setPreviewUrl(null);
    };
  }, [selectedSig?.id, selectedSig?.storage_path]);

  const handleDownload = useCallback(async (sig: Signature) => {
    setDownloadingId(sig.id);
    setDownloadError(null);
    try {
      const blob = await fetchDecryptPdfBlob(sig);
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `signature_${sig.confirmation_number}_${sig.created_at.slice(0, 10)}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (err) {
      setDownloadError((err as Error).message);
    } finally {
      setDownloadingId(null);
    }
  }, []);

  const handleExportCsv = useCallback(() => {
    const header = ["Date Signed", "Agent", "Confirmation #", "Room #", "Guest"];
    const csvRows = [
      header,
      ...rows.map((s) => [
        new Date(s.created_at).toLocaleString(),
        s.signed_by_username ?? "",
        s.confirmation_number,
        resByConf[s.confirmation_number]?.room_number ?? "",
        resByConf[s.confirmation_number]?.guest_name ?? "",
      ]),
    ];
    const csv = csvRows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `signature_log_${fromDate}_to_${toDate}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }, [rows, resByConf, fromDate, toDate]);

  const headerGuest =
    selectedSig && resByConf[selectedSig.confirmation_number]?.guest_name?.trim()
      ? resByConf[selectedSig.confirmation_number].guest_name!
      : selectedSig?.confirmation_number ?? "PDF preview";

  return (
    <div className="flex min-h-[calc(100svh-5.5rem)] flex-col gap-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      {/* Top bar — date filters + secondary filters */}
      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 md:px-5">
        <div className="flex flex-wrap items-end gap-3 md:items-center md:justify-between">
          <div>
            <h1 className="text-base font-semibold text-[var(--text-h)]">Signature PDFs</h1>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              Filter by date, then select a row to preview.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3 md:justify-end">
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

      {(downloadError || previewError) && (
        <div className="shrink-0 border-b border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-800/40 dark:bg-red-900/20 dark:text-red-400 md:px-5">
          <div className="flex items-start gap-2">
            <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{downloadError ?? previewError}</span>
          </div>
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
        {/* Left — list */}
        <div className="flex w-full shrink-0 flex-col border-[var(--border)] lg:w-[min(100%,22rem)] lg:border-r xl:w-[min(100%,26rem)]">
          <div className="border-b border-[var(--border)] p-3">
            <SearchField
              className="w-full bg-[var(--surface)]"
              placeholder="Search confirmation, guest, room, agent…"
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
              aria-label="Search PDF list"
            />
            <p className="mt-2 text-[10px] text-[var(--text-muted)]">
              {sigQuery.isLoading
                ? "Loading…"
                : `${rows.length} PDF${rows.length !== 1 ? "s" : ""} in range`}
            </p>
          </div>
          <div className="min-h-[200px] flex-1 overflow-y-auto lg:max-h-none lg:min-h-[min(70vh,calc(100svh-14rem))]">
            {sigQuery.isLoading ? (
              <p className="p-4 text-sm text-[var(--text-muted)]">Loading signatures…</p>
            ) : sigQuery.isError ? (
              <p className="p-4 text-sm text-red-400">{(sigQuery.error as Error).message}</p>
            ) : rows.length === 0 ? (
              <p className="p-4 text-sm text-[var(--text-muted)]">No PDFs for these filters.</p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface-2)] text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  <tr>
                    <th className="px-3 py-2">Room</th>
                    <th className="px-3 py-2">Guest</th>
                    <th className="px-3 py-2">Signed</th>
                    <th className="hidden px-3 py-2 sm:table-cell">Conf.</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((sig) => {
                    const res = resByConf[sig.confirmation_number];
                    const active = sig.id === selectedId;
                    return (
                      <tr
                        key={sig.id}
                        className={
                          active
                            ? "cursor-pointer border-l-2 border-[var(--accent)] bg-[var(--accent-muted)]"
                            : "cursor-pointer border-l-2 border-transparent hover:bg-[var(--sidebar-hover)]"
                        }
                        onClick={() => setSelectedId(sig.id)}
                        aria-current={active ? "true" : undefined}
                      >
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-[var(--text-h)]">
                          {res?.room_number ?? "—"}
                        </td>
                        <td className="max-w-[7rem] truncate px-3 py-2 text-[var(--text-h)] sm:max-w-[9rem]">
                          <span title={res?.guest_name ?? ""}>{res?.guest_name ?? "—"}</span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-[var(--text-muted)]">
                          {new Date(sig.created_at).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                          <span className="hidden sm:inline">
                            {" "}
                            {new Date(sig.created_at).toLocaleTimeString(undefined, {
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </span>
                        </td>
                        <td className="hidden max-w-[4rem] truncate px-3 py-2 font-mono text-[var(--text-muted)] sm:table-cell">
                          {sig.confirmation_number}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right — preview */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg)]">
          <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3 md:px-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2
                className="max-w-full truncate text-lg font-semibold tracking-tight text-[var(--accent)] md:text-xl"
                title={headerGuest}
              >
                {selectedSig ? headerGuest : "Select a PDF"}
              </h2>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary flex items-center gap-1.5 text-sm"
                  disabled={!selectedSig || downloadingId === selectedSig?.id || previewLoading}
                  onClick={() => selectedSig && void handleDownload(selectedSig)}
                >
                  {downloadingId === selectedSig?.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Download className="h-4 w-4" aria-hidden />
                  )}
                  Download
                </button>
                {previewUrl ? (
                  <a
                    href={previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-secondary inline-flex items-center gap-1.5 text-sm"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden />
                    Open
                  </a>
                ) : null}
              </div>
            </div>
            {selectedSig ? (
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                <span className="font-mono">{selectedSig.confirmation_number}</span>
                {selectedSig.signed_by_username ? (
                  <>
                    {" "}
                    · {selectedSig.signed_by_username}
                  </>
                ) : null}
                {" · "}
                {new Date(selectedSig.created_at).toLocaleString()}
              </p>
            ) : null}
          </div>

          <div className="relative min-h-[50vh] flex-1 p-3 md:p-4">
            {!selectedSig ? (
              <div className="flex h-full min-h-[40vh] items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--text-muted)]">
                <div className="flex items-center gap-2">
                  <FileText className="h-5 w-5 shrink-0 opacity-60" aria-hidden />
                  Select a row on the left to preview the decrypted PDF.
                </div>
              </div>
            ) : previewLoading ? (
              <div className="flex h-full min-h-[40vh] items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--text-muted)]">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden />
                Decrypting PDF…
              </div>
            ) : previewUrl ? (
              <iframe
                title="PDF preview"
                src={previewUrl}
                className="h-full min-h-[min(70vh,calc(100svh-16rem))] w-full rounded-lg border border-[var(--border)] bg-white"
              />
            ) : (
              <div className="flex h-full min-h-[40vh] items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--text-muted)]">
                Could not load preview.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
