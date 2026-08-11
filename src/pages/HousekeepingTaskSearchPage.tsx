import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Download, ListFilter, Pencil, RefreshCw, Save, X } from "lucide-react";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { SearchField } from "@/components/ui/SearchField";
import { useAuth } from "@/contexts/AuthContext";
import {
  dueAtToIso,
  HK_PRIORITY_OPTIONS,
  isoToDueAtLocal,
} from "@/lib/hkTaskOps";
import {
  HK_EDIT_STATUS_OPTIONS,
  HK_TASK_DUTY_OPTIONS,
  HK_TASK_TYPE_OPTIONS,
  exportTaskSearchCsv,
  readTaskEditMeta,
  useHousekeepingTaskSearch,
  useUpdateHousekeepingTask,
  type TaskSearchRow,
  type TaskVerifiedBy,
} from "@/lib/hkTaskSearch";
import { priorityLabel, priorityLevel } from "@/lib/hkBulkEditUi";
import {
  TASK_STATUS_LABELS,
  useHousekeepingBoard,
  useHousekeepingStaff,
} from "@/lib/housekeeping";
import { sortRoomNumbers } from "@/lib/roomInventory";
import type { HkTaskStatus, HkTaskType, HousekeepingTask } from "@/types/housekeeping";

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
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

function formatTimeOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
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

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

const STATUS_OPTIONS: { value: HkTaskStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  ...HK_EDIT_STATUS_OPTIONS,
];

function statusBadgeClass(status: HkTaskStatus): string {
  const base =
    "inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide";
  switch (status) {
    case "completed":
      return `${base} border-emerald-400/80 bg-emerald-100 text-emerald-950 dark:border-emerald-500/45 dark:bg-emerald-500/12 dark:text-emerald-100`;
    case "in_progress":
      return `${base} border-sky-400/80 bg-sky-100 text-sky-950 dark:border-sky-500/45 dark:bg-sky-500/12 dark:text-sky-100`;
    case "inspection_pending":
      return `${base} border-violet-400/80 bg-violet-100 text-violet-950 dark:border-violet-500/45 dark:bg-violet-500/12 dark:text-violet-100`;
    case "cancelled":
      return `${base} border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]`;
    default:
      return `${base} border-amber-400/80 bg-amber-100 text-amber-950 dark:border-amber-500/45 dark:bg-amber-500/12 dark:text-amber-100`;
  }
}

function priorityCellClass(priority: number): string {
  const level = priorityLevel(priority);
  if (level === "high") {
    return "font-semibold text-red-800 dark:text-red-200";
  }
  if (level === "medium") {
    return "font-semibold text-amber-900 dark:text-amber-100";
  }
  return "font-semibold text-emerald-900 dark:text-emerald-100";
}

function taskRowClass(priority: number, status: HkTaskStatus): string {
  const level = priorityLevel(priority);
  if (status === "cancelled") {
    return "bg-[var(--surface-2)]/70 text-[var(--text-muted)]";
  }
  if (level === "high") {
    return "bg-red-50/90 dark:bg-red-950/25";
  }
  if (level === "medium") {
    return "bg-amber-50/50 dark:bg-amber-950/15";
  }
  return "bg-[var(--surface)]";
}

function nearestPriority(priority: number): number {
  if (priority >= 80) return 80;
  if (priority >= 55) return 55;
  return 30;
}

type EditFormState = {
  roomNumber: string;
  taskType: HkTaskType;
  duty: string;
  priority: number;
  status: HkTaskStatus;
  assignedTo: string;
  dueAtLocal: string;
  verifiedBy: TaskVerifiedBy;
  petRoom: boolean;
  occupied: boolean;
  createdByName: string;
  notes: string;
};

function taskToEditForm(task: HousekeepingTask, fallbackCreatedBy: string): EditFormState {
  const meta = readTaskEditMeta(task);
  return {
    roomNumber: task.room_number,
    taskType: task.task_type,
    duty: meta.duty,
    priority: nearestPriority(task.priority),
    status: task.status,
    assignedTo: task.assigned_to ?? "",
    dueAtLocal: isoToDueAtLocal(task.due_at),
    verifiedBy: meta.verifiedBy,
    petRoom: meta.petRoom,
    occupied: meta.occupied,
    createdByName: meta.createdByName ?? fallbackCreatedBy,
    notes: task.notes ?? "",
  };
}

function EditTaskModal({
  task,
  roomOptions,
  staffOptions,
  editorName,
  busy,
  onClose,
  onSave,
}: {
  task: HousekeepingTask;
  roomOptions: string[];
  staffOptions: { id: string; label: string }[];
  editorName: string;
  busy: boolean;
  onClose: () => void;
  onSave: (form: EditFormState) => Promise<void>;
}) {
  const [form, setForm] = useState<EditFormState>(() => taskToEditForm(task, editorName));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(taskToEditForm(task, editorName));
    setError(null);
  }, [task, editorName]);

  const dutyOptions = useMemo(() => {
    const set = new Set<string>([...HK_TASK_DUTY_OPTIONS]);
    if (form.duty.trim()) set.add(form.duty.trim());
    return [...set];
  }, [form.duty]);

  const rooms = useMemo(() => {
    const set = new Set(roomOptions);
    if (form.roomNumber.trim()) set.add(form.roomNumber.trim());
    return sortRoomNumbers([...set]);
  }, [roomOptions, form.roomNumber]);

  function patch<K extends keyof EditFormState>(key: K, value: EditFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await onSave(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  return (
    <div
      className="fixed inset-0 z-[130] flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hk-edit-task-title"
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="my-4 w-full max-w-lg rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3.5">
          <h2 id="hk-edit-task-title" className="text-lg font-semibold text-[var(--accent)]">
            Edit Task
          </h2>
          <button
            type="button"
            className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-h)]"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[min(70vh,36rem)] space-y-3 overflow-y-auto px-5 py-4">
          <label className="block text-sm font-medium text-[var(--text-h)]">
            Room <span className="text-red-500">*</span>
            <FilterSelect
              className="input-field mt-1.5 w-full text-sm"
              value={form.roomNumber}
              onChange={(e) => patch("roomNumber", e.target.value)}
              required
              disabled={busy}
            >
              {rooms.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </FilterSelect>
          </label>

          <label className="block text-sm font-medium text-[var(--text-h)]">
            Task type <span className="text-red-500">*</span>
            <FilterSelect
              className="input-field mt-1.5 w-full text-sm"
              value={form.taskType}
              onChange={(e) => patch("taskType", e.target.value as HkTaskType)}
              required
              disabled={busy}
            >
              {HK_TASK_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </FilterSelect>
          </label>

          <label className="block text-sm font-medium text-[var(--text-h)]">
            Duty <span className="text-red-500">*</span>
            <FilterSelect
              className="input-field mt-1.5 w-full text-sm"
              value={form.duty}
              onChange={(e) => patch("duty", e.target.value)}
              required
              disabled={busy}
            >
              {dutyOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </FilterSelect>
          </label>

          <label className="block text-sm font-medium text-[var(--text-h)]">
            Priority <span className="text-red-500">*</span>
            <FilterSelect
              className="input-field mt-1.5 w-full text-sm"
              value={String(form.priority)}
              onChange={(e) => patch("priority", Number(e.target.value))}
              required
              disabled={busy}
            >
              {HK_PRIORITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </FilterSelect>
          </label>

          <label className="block text-sm font-medium text-[var(--text-h)]">
            Status <span className="text-red-500">*</span>
            <FilterSelect
              className="input-field mt-1.5 w-full text-sm"
              value={form.status}
              onChange={(e) => patch("status", e.target.value as HkTaskStatus)}
              required
              disabled={busy}
            >
              {HK_EDIT_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </FilterSelect>
          </label>

          <label className="block text-sm font-medium text-[var(--text-h)]">
            Assigned to{" "}
            {(form.status === "assigned" ||
              form.status === "in_progress" ||
              form.status === "inspection_pending") && (
              <span className="text-red-500">*</span>
            )}
            <FilterSelect
              className="input-field mt-1.5 w-full text-sm"
              value={form.assignedTo}
              onChange={(e) => patch("assignedTo", e.target.value)}
              disabled={busy}
            >
              <option value="">Unassigned</option>
              {staffOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </FilterSelect>
          </label>

          <label className="block text-sm font-medium text-[var(--text-h)]">
            Checkout time
            <input
              type="datetime-local"
              className="input-field mt-1.5 w-full text-sm"
              value={form.dueAtLocal}
              onChange={(e) => patch("dueAtLocal", e.target.value)}
              disabled={busy}
            />
          </label>

          <fieldset className="block">
            <legend className="text-sm font-medium text-[var(--text-h)]">Verified by</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              {(
                [
                  { value: "self", label: "Self" },
                  { value: "super", label: "Super" },
                  { value: "none", label: "None" },
                ] as const
              ).map((opt) => (
                <label
                  key={opt.value}
                  className="inline-flex items-center gap-2 text-sm text-[var(--text-h)]"
                >
                  <input
                    type="radio"
                    name="verifiedBy"
                    className="accent-[var(--accent)]"
                    checked={form.verifiedBy === opt.value}
                    onChange={() => patch("verifiedBy", opt.value)}
                    disabled={busy}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-wrap gap-5">
            <label className="inline-flex items-center gap-2 text-sm font-medium text-[var(--text-h)]">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--accent)]"
                checked={form.petRoom}
                onChange={(e) => patch("petRoom", e.target.checked)}
                disabled={busy}
              />
              Pet room
            </label>
            <label className="inline-flex items-center gap-2 text-sm font-medium text-[var(--text-h)]">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--accent)]"
                checked={form.occupied}
                onChange={(e) => patch("occupied", e.target.checked)}
                disabled={busy}
              />
              Occupied
            </label>
          </div>

          <label className="block text-sm font-medium text-[var(--text-h)]">
            Created by
            <input
              type="text"
              className="input-field mt-1.5 w-full text-sm"
              value={form.createdByName}
              onChange={(e) => patch("createdByName", e.target.value)}
              disabled={busy}
            />
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <p className="text-sm font-medium text-[var(--text-h)]">Create date</p>
              <p className="mt-1 text-sm text-[var(--accent)]">{formatWhen(task.created_at)}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-h)]">Task start time</p>
              <p className="mt-1 text-sm text-[var(--accent)]">{formatTimeOnly(task.started_at)}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-h)]">Task end time</p>
              <p className="mt-1 text-sm text-[var(--accent)]">{formatTimeOnly(task.completed_at)}</p>
            </div>
          </div>

          <label className="block text-sm font-medium text-[var(--text-h)]">
            Notes
            <textarea
              className="input-field mt-1.5 min-h-[5rem] w-full resize-y text-sm"
              value={form.notes}
              onChange={(e) => patch("notes", e.target.value)}
              disabled={busy}
            />
          </label>

          {error ? (
            <p className="rounded-lg border border-red-300/80 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-200" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--border)] px-5 py-3.5">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary inline-flex items-center gap-2" disabled={busy}>
            <Save className="h-4 w-4" aria-hidden />
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function HousekeepingTaskSearchPage() {
  const { profile } = useAuth();
  const staffQuery = useHousekeepingStaff();
  const boardQuery = useHousekeepingBoard();
  const updateMutation = useUpdateHousekeepingTask();

  const [room, setRoom] = useState("");
  const [status, setStatus] = useState<HkTaskStatus | "all">("all");
  const [assigneeId, setAssigneeId] = useState("");
  const [dateFrom, setDateFrom] = useState(daysAgoIso(14));
  const [dateTo, setDateTo] = useState(todayIso());
  const [editTask, setEditTask] = useState<HousekeepingTask | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const editorName =
    profile?.full_name?.trim() || profile?.email?.trim() || "Supervisor";

  const staffOptions = useMemo(() => {
    const list = staffQuery.data ?? [];
    return list.map((s) => ({
      id: s.id,
      label: s.full_name?.trim() || s.email?.trim() || s.id.slice(0, 8),
    }));
  }, [staffQuery.data]);

  const staffFilterOptions = useMemo(
    () => [{ value: "", label: "All assignees" }, ...staffOptions.map((s) => ({ value: s.id, label: s.label }))],
    [staffOptions],
  );

  const roomOptions = useMemo(() => {
    const fromBoard = (boardQuery.data ?? []).map((r) => r.room_number.trim()).filter(Boolean);
    return sortRoomNumbers([...new Set(fromBoard)]);
  }, [boardQuery.data]);

  const filters = useMemo(
    () => ({
      room: room.trim() || undefined,
      status,
      assigneeId: assigneeId || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      limit: 500,
    }),
    [room, status, assigneeId, dateFrom, dateTo],
  );

  const searchQuery = useHousekeepingTaskSearch(filters);
  const rows = searchQuery.data ?? [];

  async function handleSave(form: EditFormState) {
    if (!profile?.id) throw new Error("You must be signed in to edit tasks.");
    await updateMutation.mutateAsync({
      taskId: editTask!.id,
      roomNumber: form.roomNumber,
      taskType: form.taskType,
      duty: form.duty,
      priority: form.priority,
      status: form.status,
      assignedTo: form.assignedTo || null,
      dueAt: dueAtToIso(form.dueAtLocal),
      verifiedBy: form.verifiedBy,
      petRoom: form.petRoom,
      occupied: form.occupied,
      createdByName: form.createdByName,
      notes: form.notes,
      editorId: profile.id,
    });
    setEditTask(null);
    setNotice(`Saved task for room ${form.roomNumber.trim()}.`);
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--text-h)]">
            <ListFilter className="h-5 w-5 text-[var(--accent)]" aria-hidden />
            All tasks
          </h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Search every housekeeping task — open and closed — and edit any row like MOP Task Search.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] hover:bg-[var(--surface-2)] disabled:opacity-40"
            onClick={() => void searchQuery.refetch()}
            disabled={searchQuery.isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${searchQuery.isFetching ? "animate-spin" : ""}`} aria-hidden />
            Refresh
          </button>
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] hover:bg-[var(--surface-2)] disabled:opacity-40"
            disabled={!rows.length}
            onClick={() =>
              downloadCsv(
                `hk-tasks-${dateFrom}_to_${dateTo}.csv`,
                exportTaskSearchCsv(rows),
              )
            }
          >
            <Download className="h-4 w-4" aria-hidden />
            Export CSV
          </button>
        </div>
      </div>

      {notice ? (
        <p className="mb-3 rounded-lg border border-emerald-300/80 bg-emerald-50 px-3 py-2 text-sm text-emerald-950 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-100">
          {notice}
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="min-w-[8rem] max-w-[10rem] flex-1">
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Room
          </label>
          <SearchField
            placeholder="e.g. 312"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
          />
        </div>
        <label className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
          Status
          <FilterSelect
            className="input-field mt-1 min-w-[10rem] text-sm normal-case tracking-normal"
            value={status}
            onChange={(e) => setStatus(e.target.value as HkTaskStatus | "all")}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </FilterSelect>
        </label>
        <label className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
          Assignee
          <FilterSelect
            className="input-field mt-1 min-w-[11rem] text-sm normal-case tracking-normal"
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
          >
            {staffFilterOptions.map((o) => (
              <option key={o.value || "all"} value={o.value}>
                {o.label}
              </option>
            ))}
          </FilterSelect>
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
          From
          <input
            type="date"
            className="input-field h-9 w-full min-w-[9rem] text-sm normal-case tracking-normal"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
          To
          <input
            type="date"
            className="input-field h-9 w-full min-w-[9rem] text-sm normal-case tracking-normal"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </label>
      </div>

      {searchQuery.isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Searching tasks…</p>
      ) : searchQuery.isError ? (
        <p className="text-sm text-red-500">{(searchQuery.error as Error).message}</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-10 text-center">
          <p className="font-medium text-[var(--text-h)]">No tasks match</p>
          <p className="mt-2 text-sm text-[var(--text-muted)]">Try widening the date range or clearing filters.</p>
        </div>
      ) : (
        <>
          <p className="mb-2 text-[12px] text-[var(--text-muted)]">
            Showing {rows.length} task{rows.length === 1 ? "" : "s"}
            {rows.length >= 500 ? " (limit 500 — narrow dates if needed)" : ""}
          </p>
          <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full min-w-[60rem] text-left text-sm">
              <thead className="border-b border-[var(--border)] bg-[var(--surface-2)] text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                <tr>
                  <th className="px-2 py-2.5 w-12" />
                  <th className="px-3 py-2.5">Room</th>
                  <th className="px-3 py-2.5">Duty</th>
                  <th className="px-3 py-2.5">Type</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Priority</th>
                  <th className="px-3 py-2.5">Assignee</th>
                  <th className="px-3 py-2.5">Self</th>
                  <th className="px-3 py-2.5">Supervisor</th>
                  <th className="px-3 py-2.5">Created</th>
                  <th className="px-3 py-2.5">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {rows.map((row: TaskSearchRow) => {
                  const { task, attendantName, selfVerified, supervisorVerified, dutyLabel } = row;
                  return (
                    <tr
                      key={task.id}
                      className={`${taskRowClass(task.priority, task.status)} hover:brightness-[0.98] dark:hover:brightness-110`}
                    >
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-sky-400/70 bg-sky-100 text-sky-900 hover:bg-sky-200/90 dark:border-sky-500/50 dark:bg-sky-500/20 dark:text-sky-100 dark:hover:bg-sky-500/30"
                          title={`Edit room ${task.room_number}`}
                          aria-label={`Edit room ${task.room_number}`}
                          onClick={() => {
                            setNotice(null);
                            setEditTask(task);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </td>
                      <td className="px-3 py-2.5 font-mono font-semibold text-[var(--text-h)]">
                        {task.room_number}
                        {row.petRoom ? (
                          <span className="ml-1 text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-300">
                            Pet
                          </span>
                        ) : null}
                        {row.occupied ? (
                          <span className="ml-1 text-[10px] font-semibold uppercase text-violet-700 dark:text-violet-300">
                            Occ
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 text-[var(--text)]">{dutyLabel}</td>
                      <td className="px-3 py-2.5 capitalize text-[var(--text)]">
                        {task.task_type.replace(/_/g, " ")}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={statusBadgeClass(task.status)}>
                          {TASK_STATUS_LABELS[task.status] ?? task.status}
                        </span>
                      </td>
                      <td className={`px-3 py-2.5 ${priorityCellClass(task.priority)}`}>
                        {priorityLabel(task.priority)}
                      </td>
                      <td className="px-3 py-2.5 text-[var(--text)]">{attendantName ?? "—"}</td>
                      <td className="px-3 py-2.5 text-[var(--text)]">{selfVerified ? "Yes" : "—"}</td>
                      <td className="px-3 py-2.5 text-[var(--text)]">{supervisorVerified ? "Yes" : "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-[var(--text)]">
                        {formatWhen(task.created_at)}
                      </td>
                      <td
                        className="max-w-[12rem] truncate px-3 py-2.5 text-[var(--text-muted)]"
                        title={task.notes ?? ""}
                      >
                        {task.notes?.trim() || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editTask ? (
        <EditTaskModal
          task={editTask}
          roomOptions={roomOptions}
          staffOptions={staffOptions}
          editorName={editorName}
          busy={updateMutation.isPending}
          onClose={() => setEditTask(null)}
          onSave={handleSave}
        />
      ) : null}
    </div>
  );
}
