import { useMemo, useState, type FormEvent } from "react";
import { Bell, Plus, RefreshCw } from "lucide-react";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { SearchField } from "@/components/ui/SearchField";
import { useAuth } from "@/contexts/AuthContext";
import { useHousekeepingStaff } from "@/lib/housekeeping";
import {
  alertPriorityClass,
  alertStatusClass,
  HK_ALERT_DUTY_OPTIONS,
  HK_ALERT_PRIORITY_OPTIONS,
  HK_ALERT_STATUS_LABELS,
  useCreateHkAlert,
  useHkAlerts,
  useUpdateHkAlert,
} from "@/lib/hkAlerts";
import { resolveRaMonitorHotelDate } from "@/lib/hkRaMonitor";
import { useHotelSettings } from "@/lib/hotelSettings";
import { canLogHkAlerts } from "@/types/roles";
import type { HkAlertPriority, HkAlertStatus } from "@/types/housekeeping";
import { useQuery } from "@tanstack/react-query";

function staffLabel(
  id: string | null | undefined,
  staffById: Map<string, { full_name: string | null; email: string | null }>,
): string {
  if (!id) return "—";
  const s = staffById.get(id);
  return s?.full_name?.trim() || s?.email?.trim() || "—";
}

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

type AlertPatch = {
  duty?: string;
  description?: string;
  priority?: HkAlertPriority;
  status?: HkAlertStatus;
  assignedTo?: string | null;
  resolvedBy?: string | null;
};

function CreateAlertModal({
  hotelDate,
  staffOptions,
  busy,
  onClose,
  onCreate,
}: {
  hotelDate: string;
  staffOptions: { id: string; label: string }[];
  busy: boolean;
  onClose: () => void;
  onCreate: (input: {
    roomNumber: string;
    duty: string;
    description: string;
    priority: HkAlertPriority;
    assignedTo: string | null;
  }) => Promise<void>;
}) {
  const [roomNumber, setRoomNumber] = useState("");
  const [duty, setDuty] = useState<string>(HK_ALERT_DUTY_OPTIONS[0]);
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<HkAlertPriority>("high");
  const [assignedTo, setAssignedTo] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!roomNumber.trim()) {
      setError("Room number is required.");
      return;
    }
    if (!description.trim()) {
      setError("Description is required.");
      return;
    }
    try {
      await onCreate({
        roomNumber: roomNumber.trim(),
        duty,
        description: description.trim(),
        priority,
        assignedTo: assignedTo || null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create alert");
    }
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="presentation"
      onClick={onClose}
    >
      <form
        className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void handleSubmit(e)}
      >
        <h2 className="text-lg font-semibold text-[var(--text-h)]">Add HK alert</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Front desk urgent room issue for {hotelDate}.
        </p>
        <div className="mt-4 space-y-3">
          <label className="block text-sm font-medium text-[var(--text-h)]">
            Room
            <input
              className="input-field mt-1 w-full font-mono"
              value={roomNumber}
              onChange={(e) => setRoomNumber(e.target.value)}
              placeholder="108"
              required
            />
          </label>
          <label className="block text-sm font-medium text-[var(--text-h)]">
            Duty
            <FilterSelect className="input-field mt-1 w-full" value={duty} onChange={(e) => setDuty(e.target.value)}>
              {HK_ALERT_DUTY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </FilterSelect>
          </label>
          <label className="block text-sm font-medium text-[var(--text-h)]">
            Priority
            <FilterSelect
              className="input-field mt-1 w-full"
              value={priority}
              onChange={(e) => setPriority(e.target.value as HkAlertPriority)}
            >
              {HK_ALERT_PRIORITY_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </FilterSelect>
          </label>
          <label className="block text-sm font-medium text-[var(--text-h)]">
            Description
            <textarea
              className="input-field mt-1 min-h-[4.5rem] w-full resize-y"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Guest reports AC not working…"
              required
            />
          </label>
          <label className="block text-sm font-medium text-[var(--text-h)]">
            Assign to (optional)
            <FilterSelect
              className="input-field mt-1 w-full"
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
            >
              <option value="">— Unassigned —</option>
              {staffOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </FilterSelect>
          </label>
        </div>
        {error ? (
          <p className="mt-3 text-sm text-red-500" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary px-4 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary px-4 py-2 text-sm disabled:opacity-40" disabled={busy}>
            {busy ? "Saving…" : "Create alert"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function HousekeepingAlertsPage() {
  const { profile } = useAuth();
  const hotel = useHotelSettings();
  const canCreate = profile ? canLogHkAlerts(profile.role) : false;
  const canAssign = profile ? canLogHkAlerts(profile.role) : false;

  const hotelDateQuery = useQuery({
    queryKey: ["alerts-hotel-date", hotel.timezone, hotel.businessDayCutoffHour],
    queryFn: () => resolveRaMonitorHotelDate(hotel),
    staleTime: 60_000,
  });
  const hotelDate = hotelDateQuery.data ?? new Date().toISOString().slice(0, 10);

  const [statusFilter, setStatusFilter] = useState<HkAlertStatus | "active" | "all">("active");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const alertsQuery = useHkAlerts({ hotelDate, status: statusFilter });
  const staffQuery = useHousekeepingStaff();
  const createMutation = useCreateHkAlert();
  const updateMutation = useUpdateHkAlert();

  const staffById = useMemo(() => {
    const m = new Map<string, { full_name: string | null; email: string | null }>();
    for (const s of staffQuery.data ?? []) m.set(s.id, s);
    return m;
  }, [staffQuery.data]);

  const staffOptions = useMemo(
    () =>
      (staffQuery.data ?? [])
        .filter((s) => s.role === "housekeeper" || s.role === "supervisor")
        .map((s) => ({ id: s.id, label: staffLabel(s.id, staffById) })),
    [staffQuery.data, staffById],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (alertsQuery.data ?? []).filter((a) => {
      if (!q) return true;
      return (
        a.room_number.toLowerCase().includes(q) ||
        a.duty.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
      );
    });
  }, [alertsQuery.data, search]);

  const openCount = useMemo(
    () => (alertsQuery.data ?? []).filter((a) => a.status === "open" || a.status === "assigned").length,
    [alertsQuery.data],
  );

  async function handleCreate(input: {
    roomNumber: string;
    duty: string;
    description: string;
    priority: HkAlertPriority;
    assignedTo: string | null;
  }) {
    if (!profile) return;
    await createMutation.mutateAsync({
      ...input,
      hotelDate,
      createdBy: profile.id,
    });
    setNotice(`Alert created for room ${input.roomNumber}.`);
  }

  async function handleUpdate(id: string, patch: AlertPatch) {
    setActionError(null);
    try {
      await updateMutation.mutateAsync({ id, patch });
      setNotice("Alert updated.");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Update failed");
    }
  }

  return (
    <div className="w-full min-w-0">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-[var(--accent)]" aria-hidden />
            <h1 className="page-title">HK alerts</h1>
          </div>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Front desk urgent room issues — visible on board and RA monitor for {hotelDate}.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium hover:bg-[var(--surface-2)] disabled:opacity-40"
            onClick={() => void alertsQuery.refetch()}
            disabled={alertsQuery.isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${alertsQuery.isFetching ? "animate-spin" : ""}`} aria-hidden />
            Refresh
          </button>
          {canCreate ? (
            <button
              type="button"
              className="btn-primary inline-flex h-9 items-center gap-2 px-4 text-[13px]"
              onClick={() => setShowCreate(true)}
            >
              <Plus className="h-4 w-4" aria-hidden />
              Add alert
            </button>
          ) : null}
        </div>
      </div>

      <section className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="min-w-[10rem] flex-1 max-w-xs">
          <SearchField placeholder="Search room or text…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <label className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
          Status
          <FilterSelect
            className="input-field mt-1 min-w-[8rem] text-sm normal-case tracking-normal"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as HkAlertStatus | "active" | "all")}
          >
            <option value="active">Open + assigned</option>
            <option value="open">Open only</option>
            <option value="assigned">Assigned</option>
            <option value="resolved">Resolved</option>
            <option value="cancelled">Cancelled</option>
            <option value="all">All</option>
          </FilterSelect>
        </label>
        <span className="pb-1 text-[12px] text-[var(--text-muted)]">
          <strong className="text-red-600 dark:text-red-300">{openCount}</strong> active
        </span>
      </section>

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

      {alertsQuery.isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading alerts…</p>
      ) : alertsQuery.isError ? (
        <p className="text-sm text-red-500">{(alertsQuery.error as Error).message}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <table className="data-table min-w-full text-left text-sm">
            <thead>
              <tr>
                <th scope="col">Room</th>
                <th scope="col">Duty</th>
                <th scope="col">Priority</th>
                <th scope="col">Status</th>
                <th scope="col">Description</th>
                <th scope="col">Assignee</th>
                <th scope="col">Created</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-[var(--text-muted)]">
                    No alerts match.
                  </td>
                </tr>
              ) : (
                filtered.map((alert) => (
                  <tr
                    key={alert.id}
                    className={
                      alert.priority === "urgent" || alert.priority === "high"
                        ? "bg-red-500/[0.05]"
                        : undefined
                    }
                  >
                    <td className="font-mono font-semibold">{alert.room_number}</td>
                    <td>{alert.duty}</td>
                    <td>
                      <span
                        className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase ${alertPriorityClass(alert.priority)}`}
                      >
                        {alert.priority}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase ${alertStatusClass(alert.status)}`}
                      >
                        {HK_ALERT_STATUS_LABELS[alert.status]}
                      </span>
                    </td>
                    <td className="max-w-[16rem] truncate" title={alert.description}>
                      {alert.description}
                    </td>
                    <td>
                      {alert.status === "resolved" || alert.status === "cancelled" || !canAssign ? (
                        staffLabel(alert.assigned_to, staffById)
                      ) : (
                        <FilterSelect
                          className="min-w-[9rem] text-xs"
                          value={alert.assigned_to ?? ""}
                          disabled={updateMutation.isPending}
                          onChange={(e) =>
                            void handleUpdate(alert.id, { assignedTo: e.target.value || null })
                          }
                          aria-label={`Assign alert for room ${alert.room_number}`}
                        >
                          <option value="">— Unassigned —</option>
                          {staffOptions.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}
                            </option>
                          ))}
                        </FilterSelect>
                      )}
                    </td>
                    <td className="text-xs text-[var(--text-muted)]">{formatWhen(alert.created_at)}</td>
                    <td>
                      {alert.status === "resolved" || alert.status === "cancelled" ? null : (
                        <div className="flex flex-wrap gap-1">
                          <button
                            type="button"
                            className="rounded-lg border border-emerald-400/70 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-900 hover:bg-emerald-100 disabled:opacity-40 dark:border-emerald-700/50 dark:bg-emerald-950/30 dark:text-emerald-100"
                            disabled={updateMutation.isPending}
                            onClick={() =>
                              void handleUpdate(alert.id, {
                                status: "resolved",
                                resolvedBy: profile?.id ?? null,
                              })
                            }
                          >
                            Resolve
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && profile ? (
        <CreateAlertModal
          hotelDate={hotelDate}
          staffOptions={staffOptions}
          busy={createMutation.isPending}
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      ) : null}
    </div>
  );
}
