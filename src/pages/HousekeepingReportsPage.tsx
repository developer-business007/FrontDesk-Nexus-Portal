import { useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { DateField } from "@/components/ui/DateField";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { SearchField } from "@/components/ui/SearchField";
import {
  exportDailySummaryCsv,
  exportStaffPerformanceCsv,
  useDailySummary,
  useRoomHistory,
  useStaffPerformance,
  type DailySummary,
  type RoomHistoryEntry,
  type StaffPerformance,
} from "@/lib/housekeepingReports";
import { useRecentAreaFeedback } from "@/lib/housekeepingSchedule";
import { TASK_STATUS_LABELS } from "@/lib/housekeeping";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ReportTab = "daily" | "staff" | "room" | "feedback";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function nDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function tabClass(active: boolean): string {
  return [
    "rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors whitespace-nowrap",
    active
      ? "border-[var(--accent-border)] bg-[var(--accent-muted-strong)] text-[var(--accent)]"
      : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-2)] hover:text-[var(--text-h)]",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Daily Summary tab
// ---------------------------------------------------------------------------

function SummaryCard({ label, value, sub }: { label: string; value: number | string | null; sub?: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-[var(--text-h)]">
        {value ?? "—"}
      </p>
      {sub ? <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{sub}</p> : null}
    </div>
  );
}

function DailyTab() {
  const [date, setDate] = useState(todayIso());
  const query = useDailySummary(date);
  const data: DailySummary | undefined = query.data;

  const completionRate =
    data && data.total > 0 ? Math.round((data.completed / data.total) * 100) : null;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <label className="block text-sm font-medium text-[var(--text-h)]">
          Date
          <DateField
            className="mt-1.5"
            value={date}
            onChange={setDate}
            aria-label="Report date"
          />
        </label>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} aria-hidden />
          Refresh
        </button>
        {data ? (
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface-2)]"
            onClick={() => exportDailySummaryCsv(data)}
          >
            <Download className="h-4 w-4" aria-hidden />
            Export CSV
          </button>
        ) : null}
      </div>

      {query.isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading summary…</p>
      ) : query.isError ? (
        <p className="text-sm text-red-500">{(query.error as Error).message}</p>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <SummaryCard label="Total tasks" value={data.total} />
            <SummaryCard
              label="Completed"
              value={data.completed}
              sub={completionRate !== null ? `${completionRate}% completion rate` : undefined}
            />
            <SummaryCard label="Pending" value={data.pending} />
            <SummaryCard label="In progress" value={data.in_progress} />
            <SummaryCard label="Awaiting inspection" value={data.inspection_pending} />
            <SummaryCard label="Cancelled" value={data.cancelled} />
            <SummaryCard
              label="Avg clean time"
              value={data.avg_clean_minutes !== null ? `${data.avg_clean_minutes} min` : "—"}
            />
          </div>

          {data.total === 0 ? (
            <p className="mt-6 text-sm text-[var(--text-muted)]">
              No housekeeping tasks were created on {date}.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Staff Performance tab
// ---------------------------------------------------------------------------

function StaffRow({ perf }: { perf: StaffPerformance }) {
  const name = perf.full_name?.trim() || perf.email?.trim() || "Unknown";
  const completionPct =
    perf.total_assigned > 0
      ? Math.round((perf.completed / perf.total_assigned) * 100)
      : null;
  const passPct =
    perf.inspection_passed + perf.inspection_failed > 0
      ? Math.round(
          (perf.inspection_passed / (perf.inspection_passed + perf.inspection_failed)) * 100,
        )
      : null;

  return (
    <tr className="border-b border-[var(--border)]/60 last:border-0 hover:bg-[var(--surface-2)] transition-colors">
      <td className="px-3 py-2.5">
        <p className="text-[13px] font-medium text-[var(--text-h)]">{name}</p>
        <p className="text-[11px] text-[var(--text-muted)]">{perf.email ?? "—"}</p>
      </td>
      <td className="px-3 py-2.5 text-center text-[13px] font-medium tabular-nums text-[var(--text-h)]">
        {perf.total_assigned}
      </td>
      <td className="px-3 py-2.5 text-center text-[13px] tabular-nums text-[var(--text-h)]">
        {perf.completed}
        {completionPct !== null ? (
          <span className="ml-1 text-[11px] text-[var(--text-muted)]">({completionPct}%)</span>
        ) : null}
      </td>
      <td className="px-3 py-2.5 text-center text-[13px] tabular-nums text-[var(--text-muted)]">
        {perf.avg_clean_minutes !== null ? `${perf.avg_clean_minutes} min` : "—"}
      </td>
      <td className="px-3 py-2.5 text-center text-[13px] tabular-nums">
        {perf.inspection_passed + perf.inspection_failed === 0 ? (
          <span className="text-[var(--text-muted)]">—</span>
        ) : (
          <span className={passPct !== null && passPct >= 80 ? "text-emerald-600 dark:text-emerald-400 font-medium" : "text-amber-700 dark:text-amber-300 font-medium"}>
            {passPct !== null ? `${passPct}%` : "—"}
            <span className="ml-1 text-[10.5px] text-[var(--text-muted)]">
              ({perf.inspection_passed}/{perf.inspection_passed + perf.inspection_failed})
            </span>
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-center text-[13px] tabular-nums">
        {perf.overdue_count > 0 ? (
          <span className="font-semibold text-red-600 dark:text-red-300">{perf.overdue_count}</span>
        ) : (
          <span className="text-[var(--text-muted)]">0</span>
        )}
      </td>
    </tr>
  );
}

function StaffTab() {
  const [startDate, setStartDate] = useState(nDaysAgo(6));
  const [endDate, setEndDate] = useState(todayIso());
  const query = useStaffPerformance(startDate, endDate, startDate <= endDate);
  const data: StaffPerformance[] | undefined = query.data;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <label className="block text-sm font-medium text-[var(--text-h)]">
          From
          <DateField
            className="mt-1.5"
            value={startDate}
            onChange={setStartDate}
            aria-label="Start date"
          />
        </label>
        <label className="block text-sm font-medium text-[var(--text-h)]">
          To
          <DateField
            className="mt-1.5"
            value={endDate}
            onChange={setEndDate}
            aria-label="End date"
          />
        </label>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} aria-hidden />
          Refresh
        </button>
        {data && data.length > 0 ? (
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface-2)]"
            onClick={() => exportStaffPerformanceCsv(data, `${startDate}_to_${endDate}`)}
          >
            <Download className="h-4 w-4" aria-hidden />
            Export CSV
          </button>
        ) : null}
      </div>

      {startDate > endDate ? (
        <p className="text-sm text-amber-600 dark:text-amber-400">Start date must be before end date.</p>
      ) : query.isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading performance data…</p>
      ) : query.isError ? (
        <p className="text-sm text-red-500">{(query.error as Error).message}</p>
      ) : !data || data.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          No housekeeping activity found for this date range.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[680px] border-collapse text-left text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--surface)]">
              <tr>
                {["Staff member", "Assigned", "Completed", "Avg clean", "Pass rate", "Overdue"].map((h, i) => (
                  <th
                    key={h}
                    scope="col"
                    className={`px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)] ${i > 0 ? "text-center" : ""}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((perf) => (
                <StaffRow key={perf.housekeeper_id} perf={perf} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Room History tab
// ---------------------------------------------------------------------------

function RoomHistoryRow({ entry }: { entry: RoomHistoryEntry }) {
  const statusLabel = TASK_STATUS_LABELS[entry.status] ?? entry.status;
  const BADGE_BASE =
    "inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide";
  const badgeClass =
    entry.status === "completed"
      ? `${BADGE_BASE} border-emerald-400/70 bg-emerald-100 text-emerald-950 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-100`
      : entry.status === "cancelled"
        ? `${BADGE_BASE} border-red-400/70 bg-red-100 text-red-900 dark:border-red-500/50 dark:bg-red-500/15 dark:text-red-200`
        : `${BADGE_BASE} border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-h)]`;

  return (
    <tr className="border-b border-[var(--border)]/60 last:border-0 hover:bg-[var(--surface-2)] transition-colors">
      <td className="px-3 py-2.5 text-[12.5px] tabular-nums text-[var(--text-muted)]">
        {formatDate(entry.created_at)}
      </td>
      <td className="px-3 py-2.5 text-[12.5px] capitalize text-[var(--text-h)]">
        {entry.task_type.replace(/_/g, " ")}
      </td>
      <td className="px-3 py-2.5">
        <span className={badgeClass}>{statusLabel}</span>
      </td>
      <td className="px-3 py-2.5 text-[12.5px] text-[var(--text-h)]">
        {entry.assignee_name ?? <span className="text-[var(--text-muted)]">—</span>}
      </td>
      <td className="px-3 py-2.5 text-[12.5px] tabular-nums text-[var(--text-muted)]">
        {entry.started_at && entry.completed_at
          ? `${Math.round((new Date(entry.completed_at).getTime() - new Date(entry.started_at).getTime()) / 60_000)} min`
          : "—"}
      </td>
      <td className="max-w-[12rem] truncate px-3 py-2.5 text-[12px] text-[var(--text-muted)]">
        {entry.notes ?? "—"}
      </td>
    </tr>
  );
}

function RoomHistoryTab() {
  const [roomInput, setRoomInput] = useState("");
  const [roomNumber, setRoomNumber] = useState("");
  const [days, setDays] = useState(30);
  const query = useRoomHistory(roomNumber, days);

  function handleSearch() {
    setRoomNumber(roomInput.trim().toUpperCase());
  }

  return (
    <div>
      <section className="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[12rem] flex-1">
            <label
              htmlFor="room-history-search"
              className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
            >
              Room number
            </label>
            <SearchField
              id="room-history-search"
              placeholder="e.g. 204"
              value={roomInput}
              onChange={(e) => setRoomInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              aria-label="Room number"
            />
          </div>

          <div className="w-40">
            <label
              htmlFor="room-history-range"
              className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
            >
              History
            </label>
            <FilterSelect
              id="room-history-range"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              aria-label="History range"
            >
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </FilterSelect>
          </div>

          <button
            type="button"
            className="btn-primary inline-flex h-9 items-center gap-2 px-4 text-[13px]"
            onClick={handleSearch}
            disabled={!roomInput.trim()}
          >
            Search
          </button>
        </div>
      </section>

      {!roomNumber ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-10 text-center">
          <p className="font-medium text-[var(--text-h)]">No room selected</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Enter a room number and search to view its cleaning history.
          </p>
        </div>
      ) : query.isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading history for room {roomNumber}…</p>
      ) : query.isError ? (
        <p className="text-sm text-red-500">{(query.error as Error).message}</p>
      ) : !query.data || query.data.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-10 text-center">
          <p className="font-medium text-[var(--text-h)]">No tasks found</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Room {roomNumber} has no cleaning tasks in the last {days} days.
          </p>
        </div>
      ) : (
        <>
          <p className="mb-3 text-[13px] font-medium text-[var(--text-h)]">
            Room {roomNumber} — {query.data.length} task{query.data.length !== 1 ? "s" : ""} in the last {days} days
          </p>
          <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full min-w-[680px] border-collapse text-left text-sm">
              <thead className="border-b border-[var(--border)] bg-[var(--surface)]">
                <tr>
                  {["Created", "Type", "Status", "Assigned to", "Clean time", "Notes"].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {query.data.map((entry) => (
                  <RoomHistoryRow key={entry.id} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Area feedback tab
// ---------------------------------------------------------------------------

function FeedbackTab() {
  const query = useRecentAreaFeedback(100);

  return (
    <div>
      <p className="mb-4 text-sm text-[var(--text-muted)]">
        Guest complaints and compliments feed smart area suggestions on the schedule and assign modals.
      </p>
      {query.isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading feedback…</p>
      ) : query.isError ? (
        <p className="text-sm text-red-500">{(query.error as Error).message}</p>
      ) : !query.data || query.data.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No feedback logged yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--surface)]">
              <tr>
                {["Date", "Room", "Type", "Description"].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {query.data.map((row) => (
                <tr key={row.id} className="border-b border-[var(--border)]/60 last:border-0">
                  <td className="whitespace-nowrap px-3 py-2.5 text-[12.5px] tabular-nums text-[var(--text-h)]">
                    {formatDate(row.created_at)}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[12.5px] font-semibold text-[var(--text-h)]">
                    {row.room_number}
                  </td>
                  <td className="px-3 py-2.5 capitalize text-[12.5px] text-[var(--text)]">
                    {row.feedback_type}
                  </td>
                  <td className="max-w-md px-3 py-2.5 text-[12.5px] text-[var(--text-muted)]">
                    {row.description ?? "—"}
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function HousekeepingReportsPage() {
  const [tab, setTab] = useState<ReportTab>("daily");

  const tabs: Array<{ key: ReportTab; label: string }> = [
    { key: "daily", label: "Daily summary" },
    { key: "staff", label: "Staff performance" },
    { key: "room", label: "Room history" },
    { key: "feedback", label: "Area feedback" },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4">
        <h1 className="page-title">Housekeeping reports</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Task summaries, staff performance metrics, and room cleaning history.
        </p>
      </div>

      {/* Report type tabs */}
      <div className="mb-5 flex flex-wrap gap-1.5 border-b border-[var(--border)] pb-4">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={tabClass(tab === key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "daily" && <DailyTab />}
      {tab === "staff" && <StaffTab />}
      {tab === "room" && <RoomHistoryTab />}
      {tab === "feedback" && <FeedbackTab />}
    </div>
  );
}
