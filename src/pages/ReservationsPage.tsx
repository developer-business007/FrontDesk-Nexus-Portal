import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronsLeft,
  ChevronsRight,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { insertAuditRow } from "@/lib/audit";
import { formatStayDate } from "@/lib/calendarDate";
import { contactFromReservation, mergeContactIntoPayload } from "@/lib/reservationContact";
import { formatUsd, moneyFromReservation } from "@/lib/reservationMoney";
import { supabase } from "@/lib/supabase";
import { ReservationStatus } from "@/lib/reservationStatus";
import { useAuth } from "@/contexts/AuthContext";
import { DateField } from "@/components/ui/DateField";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { SearchField } from "@/components/ui/SearchField";
import { Skeleton } from "@/components/ui/Skeleton";
import { dnrModalPanelClass, statusModalPanelClass } from "@/lib/reservationStatusUi";
import type { PmsSource, Reservation } from "@/types/database";
import { hasAtLeastRole } from "@/types/roles";

const PAGE_SIZES = [10, 25, 50] as const;

type ReservationUpdatePatch = Partial<
  Pick<
    Reservation,
    | "pms_source"
    | "guest_name"
    | "room_number"
    | "check_in_date"
    | "check_out_date"
    | "reservation_status"
    | "dnr_hit"
    | "external_reservation_id"
    | "scrape_payload"
  >
>;

/** Server-side sortable columns (Supabase order). */
type ServerSortColumn = "confirmation_number" | "room_number" | "check_in_date";

/** Guest / Updated: three-state sort on the current page only (asc → desc → none). */
type ClientSortColumn = "guest_name" | "updated_at";

type ClientSortPhase = "asc" | "desc" | "none";

type TableSortState =
  | { kind: "client"; column: ClientSortColumn; phase: ClientSortPhase }
  | { kind: "server"; column: ServerSortColumn; asc: boolean };

const defaultTableSort: TableSortState = {
  kind: "client",
  column: "updated_at",
  phase: "desc",
};

function serverDefaultAsc(col: ServerSortColumn): boolean {
  if (col === "confirmation_number" || col === "room_number") {
    return true;
  }
  return false;
}

const EDIT_STATUS_OPTIONS = [
  { value: ReservationStatus.Pending, label: "Pending" },
  { value: ReservationStatus.CheckedIn, label: "Checked in" },
  { value: ReservationStatus.CheckedOut, label: "Checked out" },
];

const PMS_OPTIONS = [
  { value: "", label: "All PMS" },
  { value: "synxis", label: "SynXis" },
  { value: "ezee", label: "eZee" },
];

function formatShortDate(iso: string | null) {
  return formatStayDate(iso);
}

function formatShortDateTime(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function rowsToCsv(rows: Reservation[], rowOffset: number): string {
  const headers = [
    "no",
    "guest_name",
    "email",
    "phone",
    "confirmation_number",
    "room_number",
    "check_in_date",
    "check_out_date",
    "pms_source",
    "total_usd",
    "paid_usd",
    "balance_usd",
    "updated_at",
  ];
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") {
      const s = JSON.stringify(v);
      return `"${s.replace(/"/g, '""')}"`;
    }
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  rows.forEach((r, i) => {
    const rec = r as unknown as Record<string, unknown>;
    const { email, phone } = contactFromReservation(r);
    const m = moneyFromReservation(r);
    const no = rowOffset + i + 1;
    const cells = [
      no,
      esc(rec.guest_name),
      esc(email),
      esc(phone),
      esc(rec.confirmation_number),
      esc(rec.room_number),
      esc(rec.check_in_date),
      esc(rec.check_out_date),
      esc(rec.pms_source),
      m.total ?? "",
      m.paid ?? "",
      m.balance ?? "",
      esc(rec.updated_at),
    ];
    lines.push(cells.join(","));
  });
  return lines.join("\n");
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const FETCH_CHUNK = 1000;

/** Text search: confirmation, guest, room, email/phone, and raw scrape_payload JSON (all client-side). */
function matchesReservationSearch(r: Reservation, raw: string): boolean {
  const term = raw.trim().toLowerCase();
  if (!term) return true;
  const { email, phone } = contactFromReservation(r);
  const fields = [r.confirmation_number, r.guest_name, r.room_number, email, phone];
  for (const f of fields) {
    if (f && String(f).toLowerCase().includes(term)) return true;
  }
  if (r.scrape_payload && typeof r.scrape_payload === "object") {
    try {
      if (JSON.stringify(r.scrape_payload).toLowerCase().includes(term)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function matchesRoomFilter(r: Reservation, raw: string): boolean {
  const term = raw.trim().toLowerCase();
  if (!term) return true;
  return (r.room_number ?? "").toLowerCase().includes(term);
}

function compareUpdatedAtRows(a: Reservation, b: Reservation, asc: boolean): number {
  const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
  const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
  const c = ta - tb;
  return asc ? c : -c;
}

/** Sort the full filtered list in the browser (no extra API calls when search/sort changes). */
function sortReservations(rows: Reservation[], tableSort: TableSortState): Reservation[] {
  const copy = [...rows];
  if (tableSort.kind === "server") {
    const col = tableSort.column;
    const asc = tableSort.asc;
    copy.sort((a, b) => {
      if (col === "confirmation_number") {
        const sa = (a.confirmation_number ?? "").toLowerCase();
        const sb = (b.confirmation_number ?? "").toLowerCase();
        const c = sa.localeCompare(sb, undefined, { sensitivity: "base" });
        return asc ? c : -c;
      }
      if (col === "room_number") {
        const sa = (a.room_number ?? "").toLowerCase();
        const sb = (b.room_number ?? "").toLowerCase();
        const c = sa.localeCompare(sb, undefined, { sensitivity: "base", numeric: true });
        return asc ? c : -c;
      }
      const av = a.check_in_date ?? "";
      const bv = b.check_in_date ?? "";
      const c = av.localeCompare(bv);
      return asc ? c : -c;
    });
    return copy;
  }
  if (tableSort.phase === "none") {
    copy.sort((a, b) => compareUpdatedAtRows(a, b, false));
    return copy;
  }
  if (tableSort.column === "guest_name") {
    const asc = tableSort.phase === "asc";
    copy.sort((a, b) => {
      const ga = (a.guest_name ?? "").toLocaleLowerCase();
      const gb = (b.guest_name ?? "").toLocaleLowerCase();
      const c = ga.localeCompare(gb, undefined, { sensitivity: "base" });
      return asc ? c : -c;
    });
    return copy;
  }
  const asc = tableSort.phase === "asc";
  copy.sort((a, b) => compareUpdatedAtRows(a, b, asc));
  return copy;
}

const SKELETON_DATA_COLS = 13;

const RES_COL_STORAGE_KEY = "fdn-reservations-col-widths-v2";
const RES_COL_DEFAULTS: Record<string, number> = {
  no: 40,
  guest: 120,
  email: 130,
  phone: 110,
  conf: 118,
  room: 76,
  stay: 128,
  pms: 68,
  total: 88,
  paid: 88,
  balance: 88,
  updated: 104,
  actions: 104,
};

function loadResColWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(RES_COL_STORAGE_KEY);
    if (raw) return { ...RES_COL_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...RES_COL_DEFAULTS };
}

function ColumnResizeHandle({
  onResizeStart,
}: {
  onResizeStart: (e: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      title="Drag to resize column"
      className="group absolute right-0 top-0 z-10 flex h-full w-3 translate-x-1/2 cursor-col-resize select-none touch-none justify-center hover:bg-[var(--accent)]/20 active:bg-[var(--accent)]/30"
      onMouseDown={onResizeStart}
    >
      <span
        className="pointer-events-none my-1.5 w-px shrink-0 rounded-full bg-[var(--border)] transition-colors group-hover:bg-[var(--accent)]"
        aria-hidden
      />
    </div>
  );
}

function ReservationTableSkeleton({ rows }: { rows: number }) {
  const n = Math.min(Math.max(rows, 6), 12);
  return (
    <div
      className="reservations-table-scroll px-4 py-5"
      role="status"
      aria-busy="true"
      aria-label="Loading reservations"
    >
      <span className="sr-only">Loading reservations…</span>
      <div className="min-w-[1180px] space-y-5">
        <div className="flex gap-2">
          <Skeleton className="h-3.5 w-9 shrink-0 rounded" />
          {Array.from({ length: SKELETON_DATA_COLS }).map((_, i) => (
            <Skeleton key={`head-${i}`} className="h-3.5 flex-1 basis-0 min-w-[3rem]" />
          ))}
        </div>
        {Array.from({ length: n }).map((_, r) => (
          <div key={r} className="flex gap-2">
            <Skeleton className="h-5 w-9 shrink-0 rounded" />
            {Array.from({ length: SKELETON_DATA_COLS }).map((_, i) => (
              <Skeleton key={`${r}-${i}`} className="h-5 flex-1 basis-0 min-w-[3rem]" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function PaginationBarSkeleton() {
  return (
    <div className="flex flex-col items-stretch gap-3 border-t border-[var(--border)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
        <Skeleton className="h-9 w-9 shrink-0 rounded-md" />
        <Skeleton className="h-9 w-9 shrink-0 rounded-md" />
        <Skeleton className="mx-2 h-9 w-28 rounded-md" />
        <Skeleton className="h-9 w-9 shrink-0 rounded-md" />
        <Skeleton className="h-9 w-9 shrink-0 rounded-md" />
      </div>
      <Skeleton className="mx-auto h-9 w-40 rounded-md sm:mx-0" />
    </div>
  );
}

function ReservationSortTh({
  col,
  sortState,
  onSort,
  children,
  columnResize,
}: {
  col: ServerSortColumn;
  sortState: TableSortState;
  onSort: (col: ServerSortColumn) => void;
  children: ReactNode;
  columnResize?: ReactNode;
}) {
  const active = sortState.kind === "server" && sortState.column === col;
  const sortAsc = active ? sortState.asc : false;
  return (
    <th scope="col" className="relative whitespace-nowrap">
      <button
        type="button"
        className="group inline-flex max-w-full items-center gap-1.5 text-left font-semibold text-[var(--text-muted)] transition-colors hover:text-[var(--text-h)]"
        onClick={() => onSort(col)}
      >
        {children}
        {active ? (
          sortAsc ? (
            <ArrowUp className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-hidden />
          ) : (
            <ArrowDown className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-hidden />
          )
        ) : (
          <span className="inline-block w-3.5 shrink-0 opacity-0 group-hover:opacity-40" aria-hidden>
            ·
          </span>
        )}
      </button>
      {columnResize}
    </th>
  );
}

function ClientSortTh({
  column,
  sortState,
  onSort,
  children,
  columnResize,
}: {
  column: ClientSortColumn;
  sortState: TableSortState;
  onSort: (col: ClientSortColumn) => void;
  children: ReactNode;
  columnResize?: ReactNode;
}) {
  const active = sortState.kind === "client" && sortState.column === column;
  const phase = active ? sortState.phase : "none";
  return (
    <th scope="col" className="relative whitespace-nowrap">
      <button
        type="button"
        className="group inline-flex max-w-full items-center gap-1.5 text-left font-semibold text-[var(--text-muted)] transition-colors hover:text-[var(--text-h)]"
        onClick={() => onSort(column)}
      >
        {children}
        {phase === "asc" ? (
          <ArrowUp className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-hidden />
        ) : phase === "desc" ? (
          <ArrowDown className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-hidden />
        ) : (
          <span className="inline-block w-3.5 shrink-0 opacity-0 group-hover:opacity-40" aria-hidden>
            ·
          </span>
        )}
      </button>
      {columnResize}
    </th>
  );
}

export function ReservationsPage() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const canMutate = profile ? hasAtLeastRole(profile.role, "manager") : false;

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [debouncedRoom, setDebouncedRoom] = useState("");
  const [pmsFilter, setPmsFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [tableSort, setTableSort] = useState<TableSortState>(defaultTableSort);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(10);

  const [editRow, setEditRow] = useState<Reservation | null>(null);
  const [deleteRow, setDeleteRow] = useState<Reservation | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [colWidths, setColWidths] = useState<Record<string, number>>(loadResColWidths);

  useEffect(() => {
    try {
      localStorage.setItem(RES_COL_STORAGE_KEY, JSON.stringify(colWidths));
    } catch {
      /* ignore */
    }
  }, [colWidths]);

  function startColResize(key: keyof typeof RES_COL_DEFAULTS) {
    return (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = colWidths[key] ?? RES_COL_DEFAULTS[key];
      const onMove = (ev: globalThis.MouseEvent) => {
        const next = Math.max(48, Math.min(520, startW + ev.clientX - startX));
        setColWidths((prev) => ({ ...prev, [key]: next }));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  }

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(searchInput.trim()), 320);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedRoom(roomInput.trim()), 320);
    return () => window.clearTimeout(t);
  }, [roomInput]);

  useEffect(() => {
    // Reset pagination when filters / page size change (not sort — keep current page).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional UX
    setPage(0);
  }, [
    debouncedSearch,
    debouncedRoom,
    pmsFilter,
    fromDate,
    toDate,
    pageSize,
  ]);

  /** Load rows (excluding checked-out), PMS / date filters; search, room, sort, and paging run in the browser. */
  const listQuery = useQuery({
    queryKey: ["reservations-list", pmsFilter, fromDate, toDate],
    queryFn: async () => {
      const build = () => {
        let q = supabase.from("reservations").select("*");
        q = q.neq("reservation_status", ReservationStatus.CheckedOut);
        if (pmsFilter) {
          q = q.eq("pms_source", pmsFilter as PmsSource);
        }
        if (fromDate) {
          q = q.gte("check_in_date", fromDate);
        }
        if (toDate) {
          q = q.lte("check_in_date", toDate);
        }
        return q.order("updated_at", { ascending: false });
      };

      const all: Reservation[] = [];
      let offset = 0;
      for (;;) {
        const { data, error } = await build().range(offset, offset + FETCH_CHUNK - 1);
        if (error) throw new Error(error.message);
        const batch = (data ?? []) as Reservation[];
        all.push(...batch);
        if (batch.length < FETCH_CHUNK) break;
        offset += FETCH_CHUNK;
      }
      return { rows: all };
    },
  });

  const toggleServerSort = useCallback((col: ServerSortColumn) => {
    setTableSort((prev) => {
      if (prev.kind === "server" && prev.column === col) {
        return { kind: "server", column: col, asc: !prev.asc };
      }
      return { kind: "server", column: col, asc: serverDefaultAsc(col) };
    });
  }, []);

  const toggleClientSort = useCallback((col: ClientSortColumn) => {
    const cycle: ClientSortPhase[] = ["asc", "desc", "none"];
    setTableSort((prev) => {
      if (prev.kind === "client" && prev.column === col) {
        const i = cycle.indexOf(prev.phase);
        const next = cycle[(i + 1) % cycle.length];
        return { kind: "client", column: col, phase: next };
      }
      return { kind: "client", column: col, phase: "asc" };
    });
  }, []);

  const saveMutation = useMutation({
    mutationFn: async (payload: { row: Reservation; patch: ReservationUpdatePatch }) => {
      if (!profile) throw new Error("Not signed in.");
      const nextVersion = payload.row.version + 1;
      const { data, error } = await supabase
        .from("reservations")
        .update({
          ...payload.patch,
          version: nextVersion,
        })
        .eq("id", payload.row.id)
        .eq("version", payload.row.version)
        .select("id")
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!data) {
        throw new Error(
          "This reservation was updated elsewhere. Refresh the list and try again.",
        );
      }

      const { error: auditErr } = await insertAuditRow(supabase, {
        action_type: "reservation_updated",
        user_id: profile.id,
        username: profile.email,
        user_role: profile.role,
        confirmation_number: payload.row.confirmation_number,
        description: "Reservation edited from Reservations page",
        old_value: {
          confirmation_number: payload.row.confirmation_number,
          reservation_status: payload.row.reservation_status,
          room_number: payload.row.room_number,
        },
        new_value: payload.patch,
      });
      if (auditErr) throw auditErr;
    },
    onSuccess: async () => {
      setEditRow(null);
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ["reservations-list"] });
    },
    onError: (e: Error) => {
      setFormError(e.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (row: Reservation) => {
      if (!profile) throw new Error("Not signed in.");
      const { error } = await supabase.from("reservations").delete().eq("id", row.id);
      if (error) throw new Error(error.message);

      const { error: auditErr } = await insertAuditRow(supabase, {
        action_type: "reservation_deleted",
        user_id: profile.id,
        username: profile.email,
        user_role: profile.role,
        confirmation_number: row.confirmation_number,
        description: "Reservation deleted from Reservations page",
        old_value: { id: row.id, confirmation_number: row.confirmation_number },
        new_value: { deleted: true },
      });
      if (auditErr) throw auditErr;
    },
    onSuccess: async () => {
      setDeleteRow(null);
      await queryClient.invalidateQueries({ queryKey: ["reservations-list"] });
    },
    onError: (e: Error) => {
      setFormError(e.message);
    },
  });

  const filteredRows = useMemo(() => {
    const rows = listQuery.data?.rows ?? [];
    return rows.filter(
      (r) =>
        matchesReservationSearch(r, debouncedSearch) && matchesRoomFilter(r, debouncedRoom),
    );
  }, [listQuery.data?.rows, debouncedSearch, debouncedRoom]);

  const sortedRows = useMemo(
    () => sortReservations(filteredRows, tableSort),
    [filteredRows, tableSort],
  );

  const total = sortedRows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages - 1);

  const displayRows = useMemo(() => {
    const start = safePage * pageSize;
    return sortedRows.slice(start, start + pageSize);
  }, [sortedRows, safePage, pageSize]);

  const goPage = useCallback(
    (p: number) => {
      setPage(Math.max(0, Math.min(p, totalPages - 1)));
    },
    [totalPages],
  );

  useEffect(() => {
    if (page === safePage) return;
    // Clamp when total shrinks (e.g. after delete or filter).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync with computed max page
    setPage(safePage);
  }, [page, safePage]);

  const busy = saveMutation.isPending || deleteMutation.isPending;

  const pageWindow = 5;
  const pageStart = Math.max(0, Math.min(safePage - Math.floor(pageWindow / 2), totalPages - pageWindow));
  const pageNumbers = Array.from({ length: Math.min(pageWindow, totalPages) }, (_, i) => pageStart + i);

  return (
    <div className="mx-auto max-w-[1600px] space-y-5 text-left">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="page-title">Reservations</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary inline-flex items-center gap-2"
            onClick={() => {
              if (!displayRows.length) return;
              downloadCsv(
                `reservations-page-${safePage + 1}.csv`,
                rowsToCsv(displayRows, safePage * pageSize),
              );
            }}
            disabled={!displayRows.length || listQuery.isLoading}
            title="Export current page as CSV"
          >
            <Download className="h-4 w-4" aria-hidden />
            Export page
          </button>
          <button
            type="button"
            className="btn-secondary inline-flex items-center gap-2"
            onClick={() => void listQuery.refetch()}
            disabled={listQuery.isFetching}
            title="Reload rows from the database (read-only)"
          >
            <RefreshCw
              className={`h-4 w-4 ${listQuery.isFetching ? "animate-spin" : ""}`}
              aria-hidden
            />
            Refresh
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
          <SearchField
            className="min-w-0 flex-1"
            placeholder="Search confirmation, guest, room, email, or phone…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search reservations"
          />
          <SearchField
            className="min-w-0 flex-1 sm:max-w-xs"
            placeholder="Room # filter…"
            value={roomInput}
            onChange={(e) => setRoomInput(e.target.value)}
            aria-label="Filter by room number"
          />
          <div className="flex flex-wrap gap-2">
            <FilterSelect
              className="min-w-[8.5rem]"
              value={pmsFilter}
              onChange={(e) => setPmsFilter(e.target.value)}
              aria-label="Filter by PMS"
            >
              {PMS_OPTIONS.map((o) => (
                <option key={o.value || "all-pms"} value={o.value}>
                  {o.label}
                </option>
              ))}
            </FilterSelect>
            <DateField
              className="w-auto min-w-[10.5rem]"
              value={fromDate}
              onChange={setFromDate}
              aria-label="Check-in from"
              placeholder="From…"
            />
            <DateField
              className="w-auto min-w-[10.5rem]"
              value={toDate}
              onChange={setToDate}
              aria-label="Check-in to"
              placeholder="To…"
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3 text-sm text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-2">
            Total reservations:
            {listQuery.isLoading ? (
              <Skeleton className="inline-block h-5 w-12" />
            ) : (
              <span className="font-semibold text-[var(--accent)]">{total}</span>
            )}
          </span>
          {!canMutate ? (
            <span className="text-xs">Managers and admins can edit or delete.</span>
          ) : null}
        </div>
      </div>

      <div className="relative min-w-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        {listQuery.isFetching && !listQuery.isLoading ? (
          <div
            className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-[var(--border)]"
            aria-hidden
          >
            <div className="fdn-refetch-indicator h-full w-1/3 rounded-full bg-[var(--accent)]" />
          </div>
        ) : null}

        {listQuery.isLoading ? (
          <>
            <ReservationTableSkeleton rows={pageSize} />
            <PaginationBarSkeleton />
          </>
        ) : listQuery.isError ? (
          <p className="p-10 text-center text-sm text-red-400" role="alert">
            {(listQuery.error as Error).message}
          </p>
        ) : (
          <div
            className={`reservations-table-scroll min-w-0 w-full transition-opacity duration-200 ${
              listQuery.isFetching ? "opacity-[0.88]" : "opacity-100"
            }`}
          >
            <table className="data-table table-fixed w-full min-w-[1180px] text-left">
              <colgroup>
                <col style={{ width: colWidths.no }} />
                <col style={{ width: colWidths.guest }} />
                <col style={{ width: colWidths.email }} />
                <col style={{ width: colWidths.phone }} />
                <col style={{ width: colWidths.conf }} />
                <col style={{ width: colWidths.room }} />
                <col style={{ width: colWidths.stay }} />
                <col style={{ width: colWidths.pms }} />
                <col style={{ width: colWidths.total }} />
                <col style={{ width: colWidths.paid }} />
                <col style={{ width: colWidths.balance }} />
                <col style={{ width: colWidths.updated }} />
                <col style={{ width: colWidths.actions }} />
              </colgroup>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="relative whitespace-nowrap text-center font-semibold uppercase tracking-wider"
                  >
                    No
                    <ColumnResizeHandle onResizeStart={startColResize("no")} />
                  </th>
                  <ClientSortTh
                    column="guest_name"
                    sortState={tableSort}
                    onSort={toggleClientSort}
                    columnResize={<ColumnResizeHandle onResizeStart={startColResize("guest")} />}
                  >
                    Guest
                  </ClientSortTh>
                  <th
                    scope="col"
                    className="relative whitespace-nowrap font-semibold uppercase tracking-wider"
                  >
                    Email
                    <ColumnResizeHandle onResizeStart={startColResize("email")} />
                  </th>
                  <th
                    scope="col"
                    className="relative whitespace-nowrap font-semibold uppercase tracking-wider"
                  >
                    Phone
                    <ColumnResizeHandle onResizeStart={startColResize("phone")} />
                  </th>
                  <ReservationSortTh
                    col="confirmation_number"
                    sortState={tableSort}
                    onSort={toggleServerSort}
                    columnResize={<ColumnResizeHandle onResizeStart={startColResize("conf")} />}
                  >
                    Confirmation
                  </ReservationSortTh>
                  <ReservationSortTh
                    col="room_number"
                    sortState={tableSort}
                    onSort={toggleServerSort}
                    columnResize={<ColumnResizeHandle onResizeStart={startColResize("room")} />}
                  >
                    Room
                  </ReservationSortTh>
                  <ReservationSortTh
                    col="check_in_date"
                    sortState={tableSort}
                    onSort={toggleServerSort}
                    columnResize={<ColumnResizeHandle onResizeStart={startColResize("stay")} />}
                  >
                    Stay
                  </ReservationSortTh>
                  <th
                    scope="col"
                    className="relative whitespace-nowrap font-semibold uppercase tracking-wider"
                  >
                    PMS
                    <ColumnResizeHandle onResizeStart={startColResize("pms")} />
                  </th>
                  <th
                    scope="col"
                    className="relative whitespace-nowrap font-semibold uppercase tracking-wider"
                  >
                    Total
                    <ColumnResizeHandle onResizeStart={startColResize("total")} />
                  </th>
                  <th
                    scope="col"
                    className="relative whitespace-nowrap font-semibold uppercase tracking-wider"
                  >
                    Paid
                    <ColumnResizeHandle onResizeStart={startColResize("paid")} />
                  </th>
                  <th
                    scope="col"
                    className="relative whitespace-nowrap font-semibold uppercase tracking-wider"
                  >
                    Balance
                    <ColumnResizeHandle onResizeStart={startColResize("balance")} />
                  </th>
                  <ClientSortTh
                    column="updated_at"
                    sortState={tableSort}
                    onSort={toggleClientSort}
                    columnResize={<ColumnResizeHandle onResizeStart={startColResize("updated")} />}
                  >
                    Updated
                  </ClientSortTh>
                  <th
                    scope="col"
                    className="reservations-actions-col relative w-[1%] whitespace-nowrap text-end align-middle font-semibold uppercase tracking-wider"
                  >
                    <div className="flex justify-end pr-0">
                      <span className="inline-block">Actions</span>
                    </div>
                    <ColumnResizeHandle onResizeStart={startColResize("actions")} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((r, idx) => {
                  const rowNo = safePage * pageSize + idx + 1;
                  const stayLine = `${formatShortDate(r.check_in_date)} → ${formatShortDate(r.check_out_date)}`;
                  const { email, phone } = contactFromReservation(r);
                  const money = moneyFromReservation(r);
                  return (
                  <tr key={r.id} className="h-11">
                    <td className="min-w-0 align-middle text-center tabular-nums text-sm text-[var(--text-muted)]">
                      {rowNo}
                    </td>
                    <td className="min-w-0 align-middle">
                      <div
                        className="truncate font-medium text-[var(--text-h)]"
                        title={r.guest_name ?? ""}
                      >
                        {r.guest_name ?? "—"}
                      </div>
                    </td>
                    <td className="min-w-0 align-middle">
                      <div className="truncate text-sm text-[var(--text)]" title={email || undefined}>
                        {email || "—"}
                      </div>
                    </td>
                    <td className="min-w-0 align-middle">
                      <div className="truncate text-sm text-[var(--text)]" title={phone || undefined}>
                        {phone || "—"}
                      </div>
                    </td>
                    <td className="min-w-0 align-middle">
                      <Link
                        to={`/guest/${encodeURIComponent(r.confirmation_number)}?pms=${encodeURIComponent(r.pms_source)}`}
                        className="block truncate font-mono text-sm text-[var(--accent)] hover:underline"
                        title={r.confirmation_number}
                      >
                        {r.confirmation_number}
                      </Link>
                    </td>
                    <td className="min-w-0 align-middle">
                      <div className="truncate text-[var(--text)]" title={r.room_number ?? ""}>
                        {r.room_number ?? "—"}
                      </div>
                    </td>
                    <td className="min-w-0 align-middle">
                      <div className="truncate text-sm text-[var(--text)]" title={stayLine}>
                        {stayLine}
                      </div>
                    </td>
                    <td className="min-w-0 align-middle">
                      <div className="truncate text-xs font-medium uppercase text-[var(--text-muted)]" title={r.pms_source}>
                        {r.pms_source}
                      </div>
                    </td>
                    <td className="min-w-0 align-middle text-end tabular-nums">
                      <span className="block truncate text-sm text-[var(--text)]" title={formatUsd(money.total)}>
                        {formatUsd(money.total)}
                      </span>
                    </td>
                    <td className="min-w-0 align-middle text-end tabular-nums">
                      <span className="block truncate text-sm text-[var(--text)]" title={formatUsd(money.paid)}>
                        {formatUsd(money.paid)}
                      </span>
                    </td>
                    <td className="min-w-0 align-middle text-end tabular-nums">
                      <span className="block truncate text-sm text-[var(--text)]" title={formatUsd(money.balance)}>
                        {formatUsd(money.balance)}
                      </span>
                    </td>
                    <td className="min-w-0 align-middle">
                      <span className="block truncate text-xs text-[var(--text-muted)]" title={formatShortDateTime(r.updated_at)}>
                        {formatShortDateTime(r.updated_at)}
                      </span>
                    </td>
                    <td className="reservations-actions-col min-w-0 text-end align-middle">
                      <div className="flex justify-end gap-0.5">
                        <Link
                          to={`/guest/${encodeURIComponent(r.confirmation_number)}?pms=${encodeURIComponent(r.pms_source)}`}
                          className="icon-btn"
                          title="View guest"
                          aria-label="View guest"
                        >
                          <Eye className="h-4 w-4" />
                        </Link>
                        {canMutate ? (
                          <>
                            <button
                              type="button"
                              className="icon-btn"
                              title="Edit"
                              aria-label="Edit reservation"
                              onClick={() => {
                                setFormError(null);
                                setEditRow(r);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              className="icon-btn text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                              title="Delete"
                              aria-label="Delete reservation"
                              onClick={() => {
                                setFormError(null);
                                setDeleteRow(r);
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            {!displayRows.length ? (
              <p className="border-t border-[var(--border)] p-10 text-center text-sm text-[var(--text-muted)]">
                No reservations match your filters.
              </p>
            ) : null}
          </div>
        )}

        <div className="flex flex-col items-stretch gap-3 border-t border-[var(--border)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center justify-center gap-1 sm:justify-start">
            <button
              type="button"
              className="icon-btn"
              aria-label="First page"
              disabled={safePage <= 0}
              onClick={() => goPage(0)}
            >
              <ChevronsLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Previous page"
              disabled={safePage <= 0}
              onClick={() => goPage(safePage - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-1 px-2">
              {pageNumbers.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`min-w-[2.25rem] rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${
                    n === safePage
                      ? "bg-[var(--accent)] text-[#042f1f]"
                      : "text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text-h)]"
                  }`}
                  onClick={() => goPage(n)}
                  aria-label={`Page ${n + 1}`}
                  aria-current={n === safePage ? "page" : undefined}
                >
                  {n + 1}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="Next page"
              disabled={safePage >= totalPages - 1}
              onClick={() => goPage(safePage + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Last page"
              disabled={safePage >= totalPages - 1}
              onClick={() => goPage(totalPages - 1)}
            >
              <ChevronsRight className="h-4 w-4" />
            </button>
          </div>
          <label className="flex items-center justify-center gap-2 text-sm text-[var(--text-muted)] sm:justify-end">
            <span>Rows per page</span>
            <FilterSelect
              className="w-auto min-w-[4.5rem] py-1.5"
              value={String(pageSize)}
              onChange={(e) =>
                setPageSize(Number(e.target.value) as (typeof PAGE_SIZES)[number])
              }
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </FilterSelect>
          </label>
        </div>
      </div>

      {formError ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-900 dark:text-red-200">
          {formError}
        </div>
      ) : null}
      {editRow ? (
        <EditReservationModal
          key={editRow.id}
          row={editRow}
          busy={busy}
          onClose={() => {
            setEditRow(null);
            setFormError(null);
          }}
          onSave={(patch) => {
            saveMutation.mutate({ row: editRow, patch });
          }}
        />
      ) : null}

      {deleteRow ? (
        <ConfirmDeleteModal
          row={deleteRow}
          busy={busy}
          onClose={() => {
            setDeleteRow(null);
            setFormError(null);
          }}
          onConfirm={() => deleteMutation.mutate(deleteRow)}
        />
      ) : null}
    </div>
  );
}

function EditReservationModal({
  row,
  busy,
  onClose,
  onSave,
}: {
  row: Reservation;
  busy: boolean;
  onClose: () => void;
  onSave: (patch: ReservationUpdatePatch) => void;
}) {
  const [pms_source, setPms] = useState<PmsSource>(row.pms_source);
  const [guest_name, setGuest] = useState(row.guest_name ?? "");
  const [room_number, setRoom] = useState(row.room_number ?? "");
  const [check_in_date, setIn] = useState(row.check_in_date ?? "");
  const [check_out_date, setOut] = useState(row.check_out_date ?? "");
  const [reservation_status, setStatus] = useState(row.reservation_status);
  const [dnr_hit, setDnr] = useState(row.dnr_hit);
  const [external_reservation_id, setExt] = useState(row.external_reservation_id ?? "");
  const initialContact = contactFromReservation(row);
  const [contactEmail, setContactEmail] = useState(initialContact.email ?? "");
  const [contactPhone, setContactPhone] = useState(initialContact.phone ?? "");

  const mergedPayload = useMemo(
    () => mergeContactIntoPayload(row.scrape_payload, contactEmail, contactPhone),
    [row.scrape_payload, contactEmail, contactPhone],
  );
  const payloadJson =
    Object.keys(mergedPayload).length > 0 ? JSON.stringify(mergedPayload, null, 2) : "—";

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const patch: ReservationUpdatePatch = {
      pms_source,
      guest_name: guest_name.trim() || null,
      room_number: room_number.trim() || null,
      check_in_date: check_in_date || null,
      check_out_date: check_out_date || null,
      reservation_status: reservation_status.trim(),
      dnr_hit,
      external_reservation_id: external_reservation_id.trim() || null,
      scrape_payload: mergeContactIntoPayload(row.scrape_payload, contactEmail, contactPhone),
    };
    onSave(patch);
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={onSubmit}
        className="max-h-[90svh] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6"
      >
        <h2 className="text-lg font-semibold text-[var(--text-h)]">Edit reservation</h2>
        <p className="mt-1 font-mono text-xs text-[var(--text-muted)]">
          id: {row.id} · version {row.version}
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="sm:col-span-2 block text-sm">
            <span className="text-[var(--text-muted)]">Confirmation #</span>
            <input
              className="input-field mt-1 w-full cursor-not-allowed opacity-80"
              value={row.confirmation_number}
              readOnly
              disabled
              aria-readonly="true"
              title="Confirmation number cannot be changed"
            />
          </label>
          <label className="block text-sm">
            <span className="text-[var(--text-muted)]">PMS</span>
            <FilterSelect className="mt-1 w-full" value={pms_source} onChange={(e) => setPms(e.target.value as PmsSource)}>
              <option value="synxis">SynXis</option>
              <option value="ezee">eZee</option>
            </FilterSelect>
          </label>
          <label className="block text-sm">
            <span className="text-[var(--text-muted)]">Status</span>
            <div className={`mt-1 rounded-lg border p-0.5 ${statusModalPanelClass(reservation_status)}`}>
            <FilterSelect
              className="!border-0 !bg-transparent shadow-none"
              value={reservation_status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {EDIT_STATUS_OPTIONS.every((o) => o.value !== reservation_status) ? (
                <option value={reservation_status}>{reservation_status}</option>
              ) : null}
              {EDIT_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </FilterSelect>
            </div>
          </label>
          <label className="sm:col-span-2 block text-sm">
            <span className="text-[var(--text-muted)]">Guest name</span>
            <input
              className="input-field mt-1 w-full"
              value={guest_name}
              onChange={(e) => setGuest(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="text-[var(--text-muted)]">Email</span>
            <input
              type="email"
              autoComplete="off"
              className="input-field mt-1 w-full"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="guest@example.com"
            />
          </label>
          <label className="block text-sm">
            <span className="text-[var(--text-muted)]">Phone</span>
            <input
              type="tel"
              autoComplete="off"
              className="input-field mt-1 w-full"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder="+1 …"
            />
          </label>
          <label className="block text-sm">
            <span className="text-[var(--text-muted)]">Room</span>
            <input
              className="input-field mt-1 w-full"
              value={room_number}
              onChange={(e) => setRoom(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="text-[var(--text-muted)]">External PMS id</span>
            <input
              className="input-field mt-1 w-full"
              value={external_reservation_id}
              onChange={(e) => setExt(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="text-[var(--text-muted)]">Check-in</span>
            <div className="mt-1">
              <DateField
                className="w-full"
                value={check_in_date}
                onChange={setIn}
                aria-label="Check-in date"
                placeholder="Check-in"
              />
            </div>
          </label>
          <label className="block text-sm">
            <span className="text-[var(--text-muted)]">Check-out</span>
            <div className="mt-1">
              <DateField
                className="w-full"
                value={check_out_date}
                onChange={setOut}
                aria-label="Check-out date"
                placeholder="Check-out"
              />
            </div>
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-[var(--text-muted)]">DNR</span>
            <div className={`mt-1 rounded-lg border p-0.5 ${dnrModalPanelClass(dnr_hit)}`}>
              <FilterSelect
                className="!border-0 !bg-transparent shadow-none"
                value={dnr_hit ? "true" : "false"}
                onChange={(e) => setDnr(e.target.value === "true")}
                aria-label="DNR"
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </FilterSelect>
            </div>
          </label>
          <div className="sm:col-span-2">
            <span className="text-sm text-[var(--text-muted)]">Scrape payload (email/phone merge preview)</span>
            <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 font-mono text-xs text-[var(--text)]">
              {payloadJson}
            </pre>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ConfirmDeleteModal({
  row,
  busy,
  onClose,
  onConfirm,
}: {
  row: Reservation;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <h2 className="text-lg font-semibold text-[var(--text-h)]">Delete reservation?</h2>
        <p className="mt-2 text-sm text-[var(--text-muted)]">
          This removes{" "}
          <span className="font-mono text-[var(--text-h)]">{row.confirmation_number}</span>{" "}
          permanently (subject to RLS). Related records may be blocked by foreign keys or policies.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-60"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
