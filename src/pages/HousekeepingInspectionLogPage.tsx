import { useMemo, useState } from "react";
import { ClipboardCheck, Download, RefreshCw } from "lucide-react";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { SearchField } from "@/components/ui/SearchField";
import {
  exportInspectionLogCsv,
  useInspectionLog,
  type InspectionLogRow,
} from "@/lib/hkInspectionLog";
import { useHousekeepingStaff } from "@/lib/housekeeping";
import { HK_INSPECTION_RATING_OPTIONS } from "@/lib/hkTaskVerify";

function formatWhen(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function resultBadgeClass(eventType: string): string {
  const base =
    "inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide";
  if (eventType === "inspection_passed" || eventType === "self_verified") {
    return `${base} border-emerald-400/80 bg-emerald-100 text-emerald-950 dark:border-emerald-500/45 dark:bg-emerald-500/12 dark:text-emerald-100`;
  }
  if (eventType === "inspection_failed") {
    return `${base} border-red-400/80 bg-red-100 text-red-950 dark:border-red-500/45 dark:bg-red-500/12 dark:text-red-100`;
  }
  if (eventType === "inspection_waived") {
    return `${base} border-amber-400/80 bg-amber-100 text-amber-950 dark:border-amber-500/45 dark:bg-amber-500/12 dark:text-amber-100`;
  }
  return `${base} border-violet-400/80 bg-violet-100 text-violet-950 dark:border-violet-500/45 dark:bg-violet-500/12 dark:text-violet-100`;
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const RESULT_OPTIONS = [
  { value: "all", label: "All results" },
  { value: "passed", label: "Passed" },
  { value: "failed", label: "Failed" },
  { value: "self", label: "Self verified" },
  { value: "supervisor", label: "Supervisor / inspection" },
] as const;

const DAYS_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "14", label: "Last 14 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

function ratingLabel(value: string | null): string {
  if (!value) return "—";
  return HK_INSPECTION_RATING_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export function HousekeepingInspectionLogPage() {
  const staffQuery = useHousekeepingStaff();
  const [room, setRoom] = useState("");
  const [days, setDays] = useState("30");
  const [assigneeId, setAssigneeId] = useState("");
  const [result, setResult] = useState<(typeof RESULT_OPTIONS)[number]["value"]>("all");

  const staffOptions = useMemo(() => {
    const list = staffQuery.data ?? [];
    return [
      { value: "", label: "All attendants" },
      ...list.map((s) => ({
        value: s.id,
        label: s.full_name?.trim() || s.email?.trim() || s.id.slice(0, 8),
      })),
    ];
  }, [staffQuery.data]);

  const filters = useMemo(
    () => ({
      room: room.trim() || undefined,
      days: Number(days) || 30,
      assigneeId: assigneeId || undefined,
      result,
    }),
    [room, days, assigneeId, result],
  );

  const logQuery = useInspectionLog(filters);
  const rows = logQuery.data ?? [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--text-h)]">
            <ClipboardCheck className="h-5 w-5 text-[var(--accent)]" aria-hidden />
            Inspection log
          </h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Pass/fail inspections, self-verify, and supervisor sign-off — MOP-style quality trail.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] hover:bg-[var(--surface-2)] disabled:opacity-40"
            onClick={() => void logQuery.refetch()}
            disabled={logQuery.isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${logQuery.isFetching ? "animate-spin" : ""}`} aria-hidden />
            Refresh
          </button>
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] hover:bg-[var(--surface-2)] disabled:opacity-40"
            disabled={!rows.length}
            onClick={() => downloadCsv(`hk-inspection-log-${days}d.csv`, exportInspectionLogCsv(rows))}
          >
            <Download className="h-4 w-4" aria-hidden />
            Export CSV
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="min-w-[8rem] max-w-[10rem] flex-1">
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Room
          </label>
          <SearchField
            placeholder="e.g. 204"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
          />
        </div>
        <label className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
          Period
          <FilterSelect
            className="input-field mt-1 min-w-[9rem] text-sm normal-case tracking-normal"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          >
            {DAYS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </FilterSelect>
        </label>
        <label className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
          Attendant
          <FilterSelect
            className="input-field mt-1 min-w-[11rem] text-sm normal-case tracking-normal"
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
          >
            {staffOptions.map((o) => (
              <option key={o.value || "all"} value={o.value}>
                {o.label}
              </option>
            ))}
          </FilterSelect>
        </label>
        <label className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
          Result
          <FilterSelect
            className="input-field mt-1 min-w-[11rem] text-sm normal-case tracking-normal"
            value={result}
            onChange={(e) => setResult(e.target.value as (typeof RESULT_OPTIONS)[number]["value"])}
          >
            {RESULT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </FilterSelect>
        </label>
      </div>

      {logQuery.isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading inspection log…</p>
      ) : logQuery.isError ? (
        <p className="text-sm text-red-500">{(logQuery.error as Error).message}</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-10 text-center">
          <p className="font-medium text-[var(--text-h)]">No inspection events</p>
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            Events appear when housekeepers self-verify or supervisors pass/fail rooms.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[52rem] text-left text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--surface-2)] text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              <tr>
                <th className="px-3 py-2.5">When</th>
                <th className="px-3 py-2.5">Room</th>
                <th className="px-3 py-2.5">Result</th>
                <th className="px-3 py-2.5">Rating</th>
                <th className="px-3 py-2.5">Problems</th>
                <th className="px-3 py-2.5">Attendant</th>
                <th className="px-3 py-2.5">By</th>
                <th className="px-3 py-2.5">Verify</th>
                <th className="px-3 py-2.5">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {rows.map((row: InspectionLogRow) => (
                <tr key={row.id} className="bg-[var(--surface)] hover:bg-[var(--surface-2)]/60">
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-[var(--text)]">
                    {formatWhen(row.createdAt)}
                  </td>
                  <td className="px-3 py-2.5 font-mono font-semibold text-[var(--text-h)]">
                    {row.roomNumber}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={resultBadgeClass(row.eventType)}>{row.resultLabel}</span>
                  </td>
                  <td className="px-3 py-2.5 text-[var(--text)]">{ratingLabel(row.rating)}</td>
                  <td className="px-3 py-2.5 tabular-nums text-[var(--text)]">
                    {row.problemCount ?? "—"}
                  </td>
                  <td className="px-3 py-2.5 text-[var(--text)]">{row.attendantName ?? "—"}</td>
                  <td className="px-3 py-2.5 text-[var(--text)]">{row.actorName ?? "—"}</td>
                  <td className="px-3 py-2.5 text-[11px] text-[var(--text-muted)]">
                    {row.selfVerified ? "Self ✓" : "—"}
                    {row.selfVerified && row.supervisorVerified ? " · " : null}
                    {row.supervisorVerified ? "Sup ✓" : null}
                  </td>
                  <td className="max-w-[14rem] truncate px-3 py-2.5 text-[var(--text-muted)]" title={row.notes ?? ""}>
                    {row.notes?.trim() || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
