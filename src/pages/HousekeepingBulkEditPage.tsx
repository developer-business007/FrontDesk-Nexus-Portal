import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { SearchField } from "@/components/ui/SearchField";
import { useHousekeepingStaff } from "@/lib/housekeeping";
import { canAssignHousekeepingByPms } from "@/lib/housekeepingPmsRules";
import { floorFromRoom } from "@/lib/housekeepingSchedule";
import {
  HK_BULK_STATUS_OPTIONS,
  HK_PRIORITY_OPTIONS,
  isoToDueAtLocal,
  dueAtToIso,
  taskToBulkRow,
  useOpenHousekeepingTasks,
  useSaveBulkTaskEdits,
  type BulkTaskRow,
} from "@/lib/hkTaskOps";
import { fetchPmsBoardRows } from "@/lib/pmsBoard";
import { isTaskOverdue, TASK_STATUS_LABELS } from "@/lib/housekeeping";
import {
  BULK_EDIT_LEGEND,
  bulkEditAssigneeSelectClass,
  bulkEditCheckoutClass,
  bulkEditPrioritySelectClass,
  bulkEditRowClass,
  bulkEditStatusSelectClass,
  bulkEditTypeClass,
} from "@/lib/hkBulkEditUi";
import type { HkTaskStatus, HkTaskType } from "@/types/housekeeping";
import type { PmsBoardRow } from "@/types/pmsBoard";
import { useQuery } from "@tanstack/react-query";

const BULK_EDIT_COL_WIDTHS = {
  room: "5rem",
  type: "13%",
  status: "13%",
  priority: "9%",
  assignee: "18%",
  checkout: "14rem",
  pms: "7rem",
} as const;

function staffLabel(s: { full_name: string | null; email: string | null }): string {
  return s.full_name?.trim() || s.email?.trim() || "—";
}

function formatTaskType(taskType: HkTaskType): string {
  return taskType
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function PmsStatusBadge({ blocked }: { blocked: boolean }) {
  if (blocked) {
    return (
      <span className="inline-flex rounded-md border border-violet-400/80 bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-900 dark:border-violet-700/55 dark:bg-violet-500/20 dark:text-violet-100">
        Guest in room
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-md border border-emerald-400/70 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-900 dark:border-emerald-600/45 dark:bg-emerald-500/14 dark:text-emerald-100">
      Ready
    </span>
  );
}

function BulkEditLegend() {
  return (
    <div className="bulk-edit-legend" aria-label="Row color legend">
      {BULK_EDIT_LEGEND.map((item) => (
        <span key={item.label} className="bulk-edit-legend__item">
          <span className={item.className} aria-hidden />
          {item.label}
        </span>
      ))}
      <span className="bulk-edit-legend__item">
        <span className="bulk-edit-legend__swatch border-red-400/70 bg-red-50 dark:bg-red-500/15" aria-hidden />
        High = red · Medium = amber · Low = green
      </span>
    </div>
  );
}

export function HousekeepingBulkEditPage() {
  const tasksQuery = useOpenHousekeepingTasks();
  const staffQuery = useHousekeepingStaff();
  const saveMutation = useSaveBulkTaskEdits();

  const pmsQuery = useQuery({
    queryKey: ["pms-board", "bulk-edit"] as const,
    queryFn: fetchPmsBoardRows,
    staleTime: 15_000,
  });

  const [rows, setRows] = useState<BulkTaskRow[]>([]);
  const [originals, setOriginals] = useState<Map<string, BulkTaskRow>>(new Map());
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState("");
  const [floorFilter, setFloorFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const pmsByRoom = useMemo(() => {
    const m = new Map<string, PmsBoardRow>();
    for (const r of pmsQuery.data ?? []) m.set(String(r.room_number).trim(), r);
    return m;
  }, [pmsQuery.data]);

  const staffOptions = useMemo(
    () =>
      (staffQuery.data ?? [])
        .filter((s) => s.role === "housekeeper")
        .map((s) => ({ id: s.id, label: staffLabel(s) })),
    [staffQuery.data],
  );

  const floorOptions = useMemo(() => {
    const floors = new Set<number>();
    for (const row of rows) floors.add(floorFromRoom(row.roomNumber));
    return [...floors].sort((a, b) => a - b);
  }, [rows]);

  useEffect(() => {
    if (tasksQuery.data && !dirty) {
      const bulk = tasksQuery.data.map(taskToBulkRow);
      setRows(bulk);
      setOriginals(new Map(bulk.map((r) => [r.taskId, { ...r }])));
    }
  }, [tasksQuery.data, dirty]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !r.roomNumber.toLowerCase().includes(q)) return false;
      if (floorFilter && String(floorFromRoom(r.roomNumber)) !== floorFilter) return false;
      if (statusFilter && r.status !== statusFilter) return false;
      if (assigneeFilter === "__unassigned__" && r.assignedTo) return false;
      if (assigneeFilter && assigneeFilter !== "__unassigned__" && r.assignedTo !== assigneeFilter) {
        return false;
      }
      return true;
    });
  }, [rows, search, floorFilter, statusFilter, assigneeFilter]);

  function patchRow(taskId: string, patch: Partial<BulkTaskRow>) {
    setDirty(true);
    setNotice(null);
    setRows((prev) => prev.map((r) => (r.taskId === taskId ? { ...r, ...patch } : r)));
  }

  async function handleSave() {
    setActionError(null);
    setNotice(null);

    const patches = rows
      .map((row) => {
        const orig = originals.get(row.taskId);
        if (!orig) return null;
        const patch: {
          taskId: string;
          status?: HkTaskStatus;
          priority?: number;
          assignedTo?: string | null;
          dueAt?: string | null;
        } = { taskId: row.taskId };
        if (row.status !== orig.status) patch.status = row.status;
        if (row.priority !== orig.priority) patch.priority = row.priority;
        if (row.assignedTo !== orig.assignedTo) patch.assignedTo = row.assignedTo;
        if (row.dueAt !== orig.dueAt) patch.dueAt = row.dueAt;
        const hasChange =
          patch.status !== undefined ||
          patch.priority !== undefined ||
          patch.assignedTo !== undefined ||
          patch.dueAt !== undefined;
        return hasChange ? patch : null;
      })
      .filter(Boolean) as Parameters<typeof saveMutation.mutateAsync>[0]["patches"];

    if (patches.length === 0) {
      setActionError("No changes to save.");
      return;
    }

    try {
      const result = await saveMutation.mutateAsync({ originals, patches });
      setDirty(false);
      setNotice(
        `Updated ${result.updated} · ${result.errors} failed · ${result.skipped} unchanged`,
      );
      void tasksQuery.refetch();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Bulk save failed");
    }
  }

  return (
    <div className="w-full min-w-0">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Bulk edit tasks</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Edit assignee, priority, status, and checkout time for open tasks — save all at once.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium hover:bg-[var(--surface-2)] disabled:opacity-40"
            onClick={() => {
              setDirty(false);
              void tasksQuery.refetch();
              void pmsQuery.refetch();
            }}
            disabled={tasksQuery.isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${tasksQuery.isFetching ? "animate-spin" : ""}`} aria-hidden />
            Refresh
          </button>
          <button
            type="button"
            className="btn-primary inline-flex h-9 items-center gap-2 px-4 text-[13px] disabled:opacity-40"
            onClick={() => void handleSave()}
            disabled={saveMutation.isPending || !dirty}
          >
            <Save className="h-4 w-4" aria-hidden />
            {saveMutation.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      <section className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-[minmax(12rem,1.25fr)_repeat(3,minmax(7.5rem,10rem))_auto] xl:items-end">
          <label className="block min-w-0 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Search room
            <SearchField
              className="mt-1 normal-case tracking-normal"
              placeholder="e.g. 108"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search tasks"
            />
          </label>
          <label className="block text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Floor
            <FilterSelect
              className="input-field mt-1 text-sm normal-case tracking-normal"
              value={floorFilter}
              onChange={(e) => setFloorFilter(e.target.value)}
              aria-label="Filter by floor"
            >
              <option value="">All floors</option>
              {floorOptions.map((f) => (
                <option key={f} value={String(f)}>
                  Floor {f}
                </option>
              ))}
            </FilterSelect>
          </label>
          <label className="block text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Status
            <FilterSelect
              className="input-field mt-1 text-sm normal-case tracking-normal"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {HK_BULK_STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_LABELS[s] ?? s}
                </option>
              ))}
            </FilterSelect>
          </label>
          <label className="block text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Assignee
            <FilterSelect
              className="input-field mt-1 text-sm normal-case tracking-normal"
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
              aria-label="Filter by assignee"
            >
              <option value="">All assignees</option>
              <option value="__unassigned__">Unassigned</option>
              {staffOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </FilterSelect>
          </label>
          <p className="pb-2 text-[12px] text-[var(--text-muted)] xl:text-right">
            <span className="font-semibold tabular-nums text-[var(--text-h)]">{filtered.length}</span>
            {" of "}
            <span className="tabular-nums">{rows.length}</span>
            {" tasks"}
          </p>
        </div>
      </section>

      {dirty ? (
        <p className="mb-3 text-[12px] font-medium text-amber-700 dark:text-amber-300">
          Unsaved changes — click Save changes to apply.
        </p>
      ) : null}
      {notice ? (
        <p className="mb-3 rounded-lg border border-emerald-300/70 bg-emerald-50/80 px-3 py-2 text-sm text-emerald-950 dark:border-emerald-800/40 dark:bg-emerald-950/25 dark:text-emerald-100">
          {notice}
        </p>
      ) : null}
      {actionError ? (
        <p className="mb-3 text-sm text-red-500" role="alert">
          {actionError}
        </p>
      ) : null}

      {tasksQuery.isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading tasks…</p>
      ) : (
        <>
          <BulkEditLegend />
          <div className="bulk-edit-scroll">
          <table className="data-table bulk-edit-table min-w-[1080px] text-left text-sm">
            <colgroup>
              <col style={{ width: BULK_EDIT_COL_WIDTHS.room }} />
              <col style={{ width: BULK_EDIT_COL_WIDTHS.type }} />
              <col style={{ width: BULK_EDIT_COL_WIDTHS.status }} />
              <col style={{ width: BULK_EDIT_COL_WIDTHS.priority }} />
              <col style={{ width: BULK_EDIT_COL_WIDTHS.assignee }} />
              <col style={{ width: BULK_EDIT_COL_WIDTHS.checkout }} />
              <col style={{ width: BULK_EDIT_COL_WIDTHS.pms }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Room</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Priority</th>
                <th scope="col">Assignee</th>
                <th scope="col">Checkout</th>
                <th scope="col">PMS</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-[var(--text-muted)]">
                    No open tasks match.
                  </td>
                </tr>
              ) : (
                filtered.map((row) => {
                  const pmsRow = pmsByRoom.get(row.roomNumber.trim());
                  const guestBlocked =
                    row.status === "assigned" || row.status === "pending"
                      ? !canAssignHousekeepingByPms(pmsRow, {
                          task_type: row.taskType,
                          status: row.status,
                        }).allowed
                      : false;
                  const overdue = isTaskOverdue(row.dueAt);
                  const rowClass = bulkEditRowClass({
                    status: row.status,
                    priority: row.priority,
                    overdue,
                    guestBlocked,
                    unassigned: !row.assignedTo,
                  });

                  return (
                    <tr key={row.taskId} className={rowClass}>
                      <td
                        className={[
                          "font-mono font-semibold tabular-nums",
                          overdue
                            ? "text-red-700 dark:text-red-300"
                            : row.priority >= 80
                              ? "text-red-600 dark:text-red-300"
                              : undefined,
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        {row.roomNumber}
                      </td>
                      <td>
                        <span className={bulkEditTypeClass(row.taskType)} title={formatTaskType(row.taskType)}>
                          {formatTaskType(row.taskType)}
                        </span>
                      </td>
                      <td className="bulk-edit-table__cell-control">
                        <FilterSelect
                          className={bulkEditStatusSelectClass(row.status, overdue)}
                          value={row.status}
                          onChange={(e) =>
                            patchRow(row.taskId, { status: e.target.value as HkTaskStatus })
                          }
                          aria-label={`Status for room ${row.roomNumber}`}
                        >
                          {HK_BULK_STATUS_OPTIONS.map((s) => (
                            <option key={s} value={s}>
                              {TASK_STATUS_LABELS[s] ?? s}
                            </option>
                          ))}
                        </FilterSelect>
                      </td>
                      <td className="bulk-edit-table__cell-control">
                        <FilterSelect
                          className={bulkEditPrioritySelectClass(row.priority)}
                          value={String(row.priority)}
                          onChange={(e) =>
                            patchRow(row.taskId, { priority: Number(e.target.value) })
                          }
                          aria-label={`Priority for room ${row.roomNumber}`}
                        >
                          {HK_PRIORITY_OPTIONS.map((p) => (
                            <option key={p.value} value={p.value}>
                              {p.label}
                            </option>
                          ))}
                        </FilterSelect>
                      </td>
                      <td className="bulk-edit-table__cell-control">
                        <FilterSelect
                          className={bulkEditAssigneeSelectClass(row.assignedTo)}
                          value={row.assignedTo ?? ""}
                          onChange={(e) =>
                            patchRow(row.taskId, {
                              assignedTo: e.target.value || null,
                              status:
                                e.target.value && row.status === "pending"
                                  ? "assigned"
                                  : row.status,
                            })
                          }
                          aria-label={`Assignee for room ${row.roomNumber}`}
                        >
                          <option value="">Unassigned</option>
                          {staffOptions.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}
                            </option>
                          ))}
                        </FilterSelect>
                      </td>
                      <td className="bulk-edit-table__cell-control">
                        <input
                          type="datetime-local"
                          className={["input-field", bulkEditCheckoutClass(overdue, row.dueAt)]
                            .filter(Boolean)
                            .join(" ")}
                          value={isoToDueAtLocal(row.dueAt)}
                          onChange={(e) =>
                            patchRow(row.taskId, { dueAt: dueAtToIso(e.target.value) })
                          }
                          aria-label={`Checkout for room ${row.roomNumber}`}
                        />
                      </td>
                      <td>
                        <PmsStatusBadge blocked={guestBlocked} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );
}
