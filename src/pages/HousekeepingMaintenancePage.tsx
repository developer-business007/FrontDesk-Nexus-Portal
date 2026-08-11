import { useMemo, useState, type FormEvent } from "react";
import { Plus, RefreshCw, Wrench } from "lucide-react";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { SearchField } from "@/components/ui/SearchField";
import { useAuth } from "@/contexts/AuthContext";
import { useAllHousekeepingStaff } from "@/lib/housekeepingStaff";
import {
  HK_MAINT_CATEGORY_OPTIONS,
  HK_MAINT_PRIORITY_OPTIONS,
  HK_MAINT_STATUS_LABELS,
  HK_MAINT_STATUS_OPTIONS,
  maintPriorityClass,
  maintStatusClass,
  useCreateMaintenanceTask,
  useMaintenanceTasks,
  useUpdateMaintenanceTask,
} from "@/lib/hkMaintenanceTasks";
import { canManageHkMaintenance } from "@/types/roles";
import type { HkMaintenancePriority, HkMaintenanceStatus } from "@/types/housekeeping";

function staffLabel(
  id: string | null | undefined,
  staffById: Map<string, { full_name: string | null; email: string | null }>,
): string {
  if (!id) return "—";
  const s = staffById.get(id);
  return s?.full_name?.trim() || s?.email?.trim() || "—";
}

function WorkOrderModal({
  busy,
  staffOptions,
  initial,
  onClose,
  onSave,
}: {
  busy: boolean;
  staffOptions: { id: string; label: string }[];
  initial?: {
    roomNumber: string;
    title: string;
    description: string;
    category: string;
    priority: HkMaintenancePriority;
    assignedTo: string;
    blocksRoom: boolean;
  };
  onClose: () => void;
  onSave: (values: {
    roomNumber: string;
    title: string;
    description: string;
    category: string;
    priority: HkMaintenancePriority;
    assignedTo: string | null;
    blocksRoom: boolean;
  }) => Promise<void>;
}) {
  const [roomNumber, setRoomNumber] = useState(initial?.roomNumber ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [category, setCategory] = useState(initial?.category ?? HK_MAINT_CATEGORY_OPTIONS[0]);
  const [priority, setPriority] = useState<HkMaintenancePriority>(initial?.priority ?? "medium");
  const [assignedTo, setAssignedTo] = useState(initial?.assignedTo ?? "");
  const [blocksRoom, setBlocksRoom] = useState(initial?.blocksRoom ?? false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!roomNumber.trim() || !title.trim()) {
      setError("Room and title are required.");
      return;
    }
    try {
      await onSave({
        roomNumber: roomNumber.trim(),
        title: title.trim(),
        description: description.trim(),
        category,
        priority,
        assignedTo: assignedTo || null,
        blocksRoom,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <form
        className="max-h-[90svh] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void handleSubmit(e)}
      >
        <h2 className="text-lg font-semibold text-[var(--text-h)]">
          {initial ? "Edit work order" : "New maintenance work order"}
        </h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium sm:col-span-1">
            Room
            <input className="input-field mt-1 w-full font-mono" value={roomNumber} onChange={(e) => setRoomNumber(e.target.value)} required />
          </label>
          <label className="block text-sm font-medium sm:col-span-1">
            Category
            <FilterSelect className="input-field mt-1 w-full" value={category} onChange={(e) => setCategory(e.target.value)}>
              {HK_MAINT_CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </FilterSelect>
          </label>
          <label className="block text-sm font-medium sm:col-span-2">
            Title
            <input className="input-field mt-1 w-full" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label className="block text-sm font-medium sm:col-span-2">
            Description
            <textarea className="input-field mt-1 min-h-[4rem] w-full resize-y" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="block text-sm font-medium">
            Priority
            <FilterSelect className="input-field mt-1 w-full" value={priority} onChange={(e) => setPriority(e.target.value as HkMaintenancePriority)}>
              {HK_MAINT_PRIORITY_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </FilterSelect>
          </label>
          <label className="block text-sm font-medium">
            Assign to
            <FilterSelect className="input-field mt-1 w-full" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
              <option value="">Unassigned</option>
              {staffOptions.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </FilterSelect>
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={blocksRoom} onChange={(e) => setBlocksRoom(e.target.checked)} />
            Blocks room (maintenance lockout)
          </label>
        </div>
        {error ? <p className="mt-3 text-sm text-red-500" role="alert">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary px-4 py-2 text-sm disabled:opacity-40" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function HousekeepingMaintenancePage() {
  const { profile } = useAuth();
  const canManage = profile ? canManageHkMaintenance(profile.role) : false;

  const [statusFilter, setStatusFilter] = useState<"open" | "all">("open");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const tasksQuery = useMaintenanceTasks(statusFilter);
  const staffQuery = useAllHousekeepingStaff();
  const createMutation = useCreateMaintenanceTask();
  const updateMutation = useUpdateMaintenanceTask();

  const staffById = useMemo(() => {
    const m = new Map<string, { full_name: string | null; email: string | null }>();
    for (const s of staffQuery.data ?? []) m.set(s.id, s);
    return m;
  }, [staffQuery.data]);

  const staffOptions = useMemo(
    () => (staffQuery.data ?? []).map((s) => ({ id: s.id, label: staffLabel(s.id, staffById) })),
    [staffQuery.data, staffById],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (tasksQuery.data ?? []).filter((t) => {
      if (!q) return true;
      return (
        t.room_number.toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q) ||
        (t.category ?? "").toLowerCase().includes(q)
      );
    });
  }, [tasksQuery.data, search]);

  if (!canManage) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-amber-300 bg-amber-50 px-4 py-6 text-amber-950 dark:border-amber-900/45 dark:bg-amber-950/20 dark:text-amber-100">
        <p className="font-semibold">Supervisor access required</p>
        <p className="mt-2 text-sm opacity-90">Maintenance work orders are managed by supervisors and managers.</p>
      </div>
    );
  }

  async function handleCreate(values: {
    roomNumber: string;
    title: string;
    description: string;
    category: string;
    priority: HkMaintenancePriority;
    assignedTo: string | null;
    blocksRoom: boolean;
  }) {
    if (!profile) return;
    await createMutation.mutateAsync({
      roomNumber: values.roomNumber,
      title: values.title,
      description: values.description || null,
      category: values.category,
      priority: values.priority,
      assignedTo: values.assignedTo,
      blocksRoom: values.blocksRoom,
      reportedBy: profile.id,
    });
    setNotice(`Work order created for room ${values.roomNumber}.`);
  }

  async function patchStatus(id: string, status: HkMaintenanceStatus) {
    setActionError(null);
    try {
      await updateMutation.mutateAsync({
        id,
        patch: { status, completedBy: profile?.id ?? null },
      });
      setNotice("Work order updated.");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Update failed");
    }
  }

  return (
    <div className="w-full min-w-0">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Wrench className="h-5 w-5 text-[var(--accent)]" aria-hidden />
            <h1 className="page-title">Maintenance work orders</h1>
          </div>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Engineering / repair tasks separate from room cleaning turnover.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium hover:bg-[var(--surface-2)]"
            onClick={() => void tasksQuery.refetch()}
          >
            <RefreshCw className={`h-4 w-4 ${tasksQuery.isFetching ? "animate-spin" : ""}`} aria-hidden />
            Refresh
          </button>
          <button type="button" className="btn-primary inline-flex h-9 items-center gap-2 px-4 text-[13px]" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            New work order
          </button>
        </div>
      </div>

      <section className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="min-w-[10rem] flex-1 max-w-xs">
          <SearchField placeholder="Search room or title…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <FilterSelect className="input-field min-w-[8rem] text-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "open" | "all")}>
          <option value="open">Open + in progress</option>
          <option value="all">All</option>
        </FilterSelect>
      </section>

      {notice ? (
        <p className="mb-3 rounded-lg border border-emerald-300/70 bg-emerald-50/80 px-3 py-2 text-sm text-emerald-950 dark:border-emerald-800/40 dark:bg-emerald-950/25 dark:text-emerald-100">{notice}</p>
      ) : null}
      {actionError ? <p className="mb-3 text-sm text-red-500" role="alert">{actionError}</p> : null}

      {tasksQuery.isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading work orders…</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <table className="data-table min-w-full text-left text-sm">
            <thead>
              <tr>
                <th scope="col">Room</th>
                <th scope="col">Title</th>
                <th scope="col">Category</th>
                <th scope="col">Priority</th>
                <th scope="col">Status</th>
                <th scope="col">Assignee</th>
                <th scope="col">Blocks</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-10 text-center text-[var(--text-muted)]">No work orders.</td></tr>
              ) : (
                filtered.map((task) => (
                  <tr key={task.id} className={task.priority === "urgent" || task.priority === "high" ? "bg-red-500/[0.05]" : undefined}>
                    <td className="font-mono font-semibold">{task.room_number}</td>
                    <td className="max-w-[14rem] truncate" title={task.title}>{task.title}</td>
                    <td>{task.category ?? "—"}</td>
                    <td>
                      <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase ${maintPriorityClass(task.priority)}`}>
                        {task.priority}
                      </span>
                    </td>
                    <td>
                      <FilterSelect
                        className={`min-w-[7rem] text-xs ${maintStatusClass(task.status)}`}
                        value={task.status}
                        disabled={updateMutation.isPending}
                        onChange={(e) => void patchStatus(task.id, e.target.value as HkMaintenanceStatus)}
                      >
                        {HK_MAINT_STATUS_OPTIONS.map((s) => (
                          <option key={s} value={s}>{HK_MAINT_STATUS_LABELS[s]}</option>
                        ))}
                      </FilterSelect>
                    </td>
                    <td>{staffLabel(task.assigned_to, staffById)}</td>
                    <td>{task.blocks_room ? "Yes" : "—"}</td>
                    <td>
                      {task.status !== "completed" && task.status !== "cancelled" ? (
                        <button
                          type="button"
                          className="rounded-lg border border-emerald-400/70 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-900 dark:border-emerald-700/50 dark:bg-emerald-950/30 dark:text-emerald-100"
                          onClick={() => void patchStatus(task.id, "completed")}
                        >
                          Mark done
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {showCreate ? (
        <WorkOrderModal
          busy={createMutation.isPending}
          staffOptions={staffOptions}
          onClose={() => setShowCreate(false)}
          onSave={handleCreate}
        />
      ) : null}
    </div>
  );
}
