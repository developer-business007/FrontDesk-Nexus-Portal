import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Users } from "lucide-react";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { RangeAssignBar } from "@/components/housekeeping/RangeAssignBar";
import { useAuth } from "@/contexts/AuthContext";
import { auditHousekeeping } from "@/lib/housekeepingAudit";
import {
  fetchHousekeepingBoard,
  useAssignHousekeepingTask,
  useHousekeepingRealtime,
  useHousekeepingStaff,
} from "@/lib/housekeeping";
import { formatRangeAssignSummary, type RangeAssignResult } from "@/lib/hkRangeAssign";
import {
  resolveRaMonitorHotelDate,
  type RaMonitorAttendantCard,
  type RaMonitorBucket,
  type RaMonitorTaskRow,
  useRaMonitor,
} from "@/lib/hkRaMonitor";
import { filterAssignableHousekeepers } from "@/lib/housekeepingPmsRules";
import { useHotelSettings } from "@/lib/hotelSettings";
import { supabase } from "@/lib/supabase";
import { canInspectHousekeeping, canLogHkAlerts } from "@/types/roles";
import { useQuery } from "@tanstack/react-query";
import {
  alertPriorityClass,
  alertStatusClass,
  HK_ALERT_STATUS_LABELS,
} from "@/lib/hkAlerts";
import {
  maintPriorityClass,
  maintStatusClass,
  HK_MAINT_STATUS_LABELS,
} from "@/lib/hkMaintenanceTasks";

type MonitorTab = "attendants" | "maintenance" | "front_desk";

const ROW_TINT: Record<RaMonitorBucket, string> = {
  new: "bg-[var(--surface)]",
  in_progress: "bg-sky-500/[0.07]",
  finished: "bg-amber-400/[0.12]",
  verified: "bg-emerald-500/[0.1]",
};

const HIGH_NEW = "bg-red-500/[0.08]";

function bucketBadgeClass(bucket: RaMonitorBucket, priority: "High" | "Medium" | "Low"): string {
  const base =
    "inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide";
  switch (bucket) {
    case "verified":
      return `${base} border-emerald-400/70 bg-emerald-100 text-emerald-950 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-100`;
    case "finished":
      return `${base} border-amber-400/70 bg-amber-100 text-amber-950 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-100`;
    case "in_progress":
      return `${base} border-sky-400/70 bg-sky-100 text-sky-950 dark:border-sky-500/50 dark:bg-sky-500/15 dark:text-sky-100`;
    default:
      if (priority === "High") {
        return `${base} border-red-400/70 bg-red-100 text-red-950 dark:border-red-500/50 dark:bg-red-500/15 dark:text-red-100`;
      }
      return `${base} border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-h)]`;
  }
}

function tabBtn(active: boolean): string {
  return [
    "rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors",
    active
      ? "border-[var(--accent-border)] bg-[var(--accent-muted-strong)] text-[var(--accent)]"
      : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-2)]",
  ].join(" ");
}

export function HousekeepingRaMonitorPage() {
  const { profile } = useAuth();
  const hotel = useHotelSettings();
  const canReassign = profile ? canInspectHousekeeping(profile.role) : false;
  const canAddAlerts = profile ? canLogHkAlerts(profile.role) : false;
  const isFrontDesk = profile?.role === "front_desk";

  const hotelDateQuery = useQuery({
    queryKey: ["ra-monitor-hotel-date", hotel.timezone, hotel.businessDayCutoffHour],
    queryFn: () => resolveRaMonitorHotelDate(hotel),
    staleTime: 60_000,
  });

  const hotelDate = hotelDateQuery.data;
  const monitorQuery = useRaMonitor(hotelDate, hotel);
  const staffQuery = useHousekeepingStaff();
  const assignMutation = useAssignHousekeepingTask(profile?.id);
  useHousekeepingRealtime(profile?.id);

  const [tab, setTab] = useState<MonitorTab>("attendants");

  useEffect(() => {
    if (isFrontDesk) setTab("front_desk");
  }, [isFrontDesk]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rangeNotice, setRangeNotice] = useState<string | null>(null);

  const boardRoomsQuery = useQuery({
    queryKey: ["housekeeping-board-rooms", "range-assign"] as const,
    queryFn: fetchHousekeepingBoard,
    staleTime: 60_000,
  });

  const knownRooms = useMemo(
    () => (boardRoomsQuery.data ?? []).map((r) => r.room_number),
    [boardRoomsQuery.data],
  );

  const staffOptions = useMemo(
    () =>
      filterAssignableHousekeepers(staffQuery.data ?? [], profile?.id).map((s) => ({
        id: s.id,
        label: s.full_name?.trim() || s.email?.trim() || s.id,
      })),
    [staffQuery.data, profile?.id],
  );

  async function reassignTask(taskId: string, assignedTo: string, roomNumber: string) {
    if (!assignedTo || !profile) return;
    setActionError(null);
    try {
      const data = await assignMutation.mutateAsync({ taskId, assignedTo });
      const hk = staffQuery.data?.find((s) => s.id === assignedTo);
      await auditHousekeeping(supabase, profile, "hk_task_assigned", `RA monitor reassigned room ${roomNumber}`, {
        task_id: taskId,
        room_number: roomNumber,
        assigned_to: assignedTo,
        assignee: hk?.full_name ?? hk?.email,
      }, data?.confirmation_number ?? null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Reassign failed");
    }
  }

  const busyTaskId = assignMutation.isPending ? assignMutation.variables?.taskId ?? null : null;

  const data = monitorQuery.data;
  const loading = hotelDateQuery.isLoading || monitorQuery.isLoading;

  return (
    <div className="mx-auto max-w-[1500px]">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-[var(--accent)]" aria-hidden />
            <h1 className="page-title">RA monitor</h1>
          </div>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Live room attendant progress — hotel date {hotelDate ?? "…"}. Duty and occupancy from DualPMS.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] hover:bg-[var(--surface-2)] disabled:opacity-40"
          onClick={() => {
            void hotelDateQuery.refetch();
            void monitorQuery.refetch();
          }}
          disabled={monitorQuery.isFetching}
        >
          <RefreshCw className={`h-4 w-4 ${monitorQuery.isFetching ? "animate-spin" : ""}`} aria-hidden />
          Refresh
        </button>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <button type="button" className={tabBtn(tab === "attendants")} onClick={() => setTab("attendants")}>
          Room attendants
        </button>
        <button type="button" className={tabBtn(tab === "maintenance")} onClick={() => setTab("maintenance")}>
          Maintenance
          {data && data.maintenance.length + data.maintenanceTasks.length > 0
            ? ` (${data.maintenance.length + data.maintenanceTasks.length})`
            : ""}
        </button>
        <button type="button" className={tabBtn(tab === "front_desk")} onClick={() => setTab("front_desk")}>
          Front desk
          {data && data.alerts.length > 0 ? ` (${data.alerts.length})` : ""}
        </button>
      </div>

      {actionError ? (
        <p className="mb-3 text-sm text-red-500" role="alert">
          {actionError}
        </p>
      ) : null}

      {rangeNotice ? (
        <p className="mb-3 rounded-lg border border-emerald-300/70 bg-emerald-50/80 px-3 py-2 text-sm text-emerald-950 dark:border-emerald-800/40 dark:bg-emerald-950/25 dark:text-emerald-100">
          {rangeNotice}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading monitor…</p>
      ) : monitorQuery.isError ? (
        <p className="text-sm text-red-500">{(monitorQuery.error as Error).message}</p>
      ) : !data ? null : (
        <>
          {tab === "attendants" ? (
            <>
              <PropertyStatsBar stats={data.property} />
              {canReassign ? (
                <RangeAssignBar
                  data={data}
                  knownRooms={knownRooms}
                  staffOptions={staffOptions}
                  hotelDate={hotelDate ?? data.hotelDate}
                  createdBy={profile?.id}
                  onAssigned={(result: RangeAssignResult) => {
                    setActionError(null);
                    setRangeNotice(`Zone assign: ${formatRangeAssignSummary(result)}`);
                    if (profile && result.assigned > 0) {
                      void auditHousekeeping(
                        supabase,
                        profile,
                        "hk_range_assigned",
                        `Zone assign — ${result.assigned} room(s)`,
                        { details: result.details.slice(0, 50) },
                      );
                    }
                  }}
                  onError={(message) => {
                    setRangeNotice(null);
                    setActionError(message);
                  }}
                />
              ) : null}
              {data.unassigned.length > 0 ? (
                <AttendantCard
                  title="Unassigned — ready to assign"
                  subtitle="Vacant per DualPMS — assign to a housekeeper."
                  card={{
                    housekeeperId: "",
                    name: "Unassigned",
                    tasks: data.unassigned,
                    total: data.unassigned.length,
                    verified: 0,
                    finished: 0,
                    inProgress: 0,
                    remaining: data.unassigned.length,
                    progressPct: 0,
                  }}
                  canReassign={canReassign}
                  staffOptions={staffOptions}
                  busyTaskId={busyTaskId}
                  onReassign={reassignTask}
                />
              ) : null}
              {data.waitingCheckout.length > 0 ? (
                <AttendantCard
                  title="Waiting for checkout"
                  subtitle="Guest still in room per DualPMS — assign after checkout."
                  card={{
                    housekeeperId: "",
                    name: "Waiting",
                    tasks: data.waitingCheckout,
                    total: data.waitingCheckout.length,
                    verified: 0,
                    finished: 0,
                    inProgress: 0,
                    remaining: data.waitingCheckout.length,
                    progressPct: 0,
                  }}
                  canReassign={false}
                  staffOptions={[]}
                  busyTaskId={null}
                  onReassign={reassignTask}
                  readOnlyAssign
                />
              ) : null}
              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                {data.attendants.map((card) => (
                  <AttendantCard
                    key={card.housekeeperId}
                    title={card.name}
                    subtitle={`${card.verified} verified · ${card.finished} awaiting inspection · ${card.remaining} remaining`}
                    card={card}
                    canReassign={canReassign}
                    staffOptions={staffOptions}
                    busyTaskId={busyTaskId}
                    onReassign={reassignTask}
                  />
                ))}
              </div>
              {data.attendants.length === 0 && data.unassigned.length === 0 ? (
                <p className="mt-6 text-center text-sm text-[var(--text-muted)]">
                  No active tasks for this hotel date.
                </p>
              ) : null}
            </>
          ) : null}

          {tab === "maintenance" ? (
            <div className="space-y-6">
              <section>
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Work orders
                </h2>
                <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
                  <table className="data-table min-w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th scope="col">Room</th>
                        <th scope="col">Title</th>
                        <th scope="col">Priority</th>
                        <th scope="col">Status</th>
                        <th scope="col">Blocks room</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.maintenanceTasks.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-3 py-6 text-center text-[var(--text-muted)]">
                            No open work orders — create them on the Maintenance tab.
                          </td>
                        </tr>
                      ) : (
                        data.maintenanceTasks.map((row) => (
                          <tr key={row.id} className={row.priority === "urgent" || row.priority === "high" ? "bg-red-500/[0.05]" : undefined}>
                            <td className="font-mono font-semibold">{row.room_number}</td>
                            <td>{row.title}</td>
                            <td>
                              <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase ${maintPriorityClass(row.priority)}`}>
                                {row.priority}
                              </span>
                            </td>
                            <td>
                              <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase ${maintStatusClass(row.status)}`}>
                                {HK_MAINT_STATUS_LABELS[row.status]}
                              </span>
                            </td>
                            <td>{row.blocks_room ? "Yes" : "—"}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
              <section>
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Room blocks (encode lockout)
                </h2>
                <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
                  <table className="data-table min-w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th scope="col">Room</th>
                        <th scope="col">Type</th>
                        <th scope="col">HK status</th>
                        <th scope="col">Reason</th>
                        <th scope="col">Assigned</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.maintenance.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-3 py-6 text-center text-[var(--text-muted)]">
                            No maintenance-blocked rooms on the board.
                          </td>
                        </tr>
                      ) : (
                        data.maintenance.map((row) => (
                          <tr key={row.roomNumber} className="bg-amber-500/[0.06]">
                            <td className="font-mono font-semibold">{row.roomNumber}</td>
                            <td>{row.roomType}</td>
                            <td>{row.roomStatus}</td>
                            <td>{row.reason ?? "—"}</td>
                            <td>{row.assigneeName ?? "—"}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          ) : null}

          {tab === "front_desk" ? (
            <div className="space-y-6">
              <PropertyStatsBar stats={data.property} />
              <section className="grid gap-3 sm:grid-cols-3">
                <StatBox
                  label="Departures today"
                  value={data.departures.length}
                />
                <StatBox
                  label="Ready for check-in"
                  value={data.departures.filter((d) => d.turnoverLabel === "Ready").length}
                />
                <StatBox
                  label="Open HK alerts"
                  value={data.alerts.length}
                />
              </section>

              <section>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    Open alerts
                  </h2>
                  {canAddAlerts ? (
                    <Link to="/housekeeping/alerts" className="text-[13px] font-medium text-[var(--accent)] hover:underline">
                      Manage alerts →
                    </Link>
                  ) : null}
                </div>
                <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
                  <table className="data-table min-w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th scope="col">Room</th>
                        <th scope="col">Duty</th>
                        <th scope="col">Priority</th>
                        <th scope="col">Status</th>
                        <th scope="col">Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.alerts.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-3 py-6 text-center text-[var(--text-muted)]">
                            No open alerts for today.
                          </td>
                        </tr>
                      ) : (
                        data.alerts.map((alert) => (
                          <tr key={alert.id} className={alert.priority === "urgent" || alert.priority === "high" ? "bg-red-500/[0.06]" : undefined}>
                            <td className="font-mono font-semibold">{alert.room_number}</td>
                            <td>{alert.duty}</td>
                            <td>
                              <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase ${alertPriorityClass(alert.priority)}`}>
                                {alert.priority}
                              </span>
                            </td>
                            <td>
                              <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase ${alertStatusClass(alert.status)}`}>
                                {HK_ALERT_STATUS_LABELS[alert.status]}
                              </span>
                            </td>
                            <td className="max-w-[20rem] truncate" title={alert.description}>{alert.description}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section>
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Housekeeping progress
                </h2>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {data.attendants.map((card) => (
                    <div key={card.housekeeperId} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
                      <p className="font-semibold text-[var(--text-h)]">{card.name}</p>
                      <p className="text-[12px] text-[var(--text-muted)]">
                        {card.verified}/{card.total} verified · {card.remaining} remaining
                      </p>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
                        <div
                          className="h-full rounded-full bg-[var(--accent)]"
                          style={{ width: `${card.progressPct}%` }}
                        />
                      </div>
                    </div>
                  ))}
                  {data.attendants.length === 0 ? (
                    <p className="text-sm text-[var(--text-muted)]">No attendant assignments yet.</p>
                  ) : null}
                </div>
              </section>

              <section>
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Departures — turnover status
                </h2>
                <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
                  <p className="border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--text-muted)]">
                    DualPMS departures today — read-only front desk view.
                  </p>
                  <table className="data-table min-w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th scope="col">Room</th>
                        <th scope="col">Guest</th>
                        <th scope="col">Checkout</th>
                        <th scope="col">Turnover</th>
                        <th scope="col">PMS occ.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.departures.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-3 py-8 text-center text-[var(--text-muted)]">
                            No departures on this hotel date.
                          </td>
                        </tr>
                      ) : (
                        data.departures.map((row) => (
                          <tr
                            key={row.roomNumber}
                            className={
                              row.turnoverLabel === "Ready"
                                ? "bg-emerald-500/[0.06]"
                                : row.turnoverLabel === "Dirty" || row.turnoverLabel === "Occupied"
                                  ? "bg-amber-500/[0.06]"
                                  : undefined
                            }
                          >
                            <td className="font-mono font-semibold">{row.roomNumber}</td>
                            <td>{row.guestName}</td>
                            <td className="tabular-nums">{row.checkoutLabel}</td>
                            <td>{row.turnoverLabel}</td>
                            <td>{row.pmsStatus}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function PropertyStatsBar({
  stats,
}: {
  stats: { totalTasks: number; verified: number; remaining: number; progressPct: number };
}) {
  return (
    <section className="mb-4 grid gap-3 sm:grid-cols-3">
      <StatBox label="Daily housekeeping tasks" value={stats.totalTasks} />
      <StatBox label="Verified complete" value={`${stats.verified} · ${stats.progressPct}%`} />
      <StatBox label="Remaining" value={stats.remaining} />
    </section>
  );
}

function StatBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-center">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums text-[var(--text-h)]">{value}</p>
    </div>
  );
}

function AttendantCard({
  title,
  subtitle,
  card,
  canReassign,
  staffOptions,
  busyTaskId,
  onReassign,
  readOnlyAssign = false,
}: {
  title: string;
  subtitle: string;
  card: RaMonitorAttendantCard;
  canReassign: boolean;
  staffOptions: { id: string; label: string }[];
  busyTaskId: string | null;
  onReassign: (taskId: string, assignedTo: string, roomNumber: string) => void;
  readOnlyAssign?: boolean;
}) {
  const showAssignCol = canReassign && !readOnlyAssign;

  return (
    <section className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="border-b border-[var(--border)] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-h)]">{title}</h2>
            <p className="text-xs text-[var(--text-muted)]">{subtitle}</p>
          </div>
          <div className="text-right text-sm font-semibold tabular-nums text-[var(--text-h)]">
            {card.verified} / {card.total} · {card.progressPct}%
          </div>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--surface-3)]">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-all"
            style={{ width: `${card.progressPct}%` }}
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
              <th className="px-3 py-2">Room</th>
              <th className="px-3 py-2">DualPMS</th>
              <th className="px-3 py-2">Guest</th>
              <th className="px-3 py-2">Duty</th>
              <th className="px-3 py-2">Turnover</th>
              <th className="px-3 py-2">HK status</th>
              <th className="px-3 py-2">Checkout</th>
              {showAssignCol ? <th className="px-3 py-2">Assigned to</th> : null}
            </tr>
          </thead>
          <tbody>
            {card.tasks.map((row) => (
              <TaskRow
                key={row.task.id}
                row={row}
                canReassign={showAssignCol}
                staffOptions={staffOptions}
                currentAssignee={card.housekeeperId || row.task.assigned_to}
                busy={busyTaskId === row.task.id}
                onReassign={onReassign}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TaskRow({
  row,
  canReassign,
  staffOptions,
  currentAssignee,
  busy,
  onReassign,
}: {
  row: RaMonitorTaskRow;
  canReassign: boolean;
  staffOptions: { id: string; label: string }[];
  currentAssignee: string | null;
  busy: boolean;
  onReassign: (taskId: string, assignedTo: string, roomNumber: string) => void;
}) {
  const tint = !row.assignAllowed
    ? "bg-violet-500/[0.08]"
    : row.bucket === "new" && row.priorityLabel === "High"
      ? HIGH_NEW
      : ROW_TINT[row.bucket];

  return (
    <tr className={`border-t border-[var(--border)]/50 ${tint}`}>
      <td className="whitespace-nowrap px-3 py-2 font-mono font-semibold">{row.roomNumber}</td>
      <td className="max-w-[8rem] truncate px-3 py-2 text-xs" title={row.pmsStatusLabel}>
        {row.pmsStatusLabel}
      </td>
      <td className="max-w-[8rem] truncate px-3 py-2 text-xs" title={row.guestName ?? undefined}>
        {row.guestName ?? "—"}
      </td>
      <td className="px-3 py-2">{row.dutyLabel}</td>
      <td className="px-3 py-2 text-xs">{row.turnoverLabel}</td>
      <td className="px-3 py-2">
        <span className={bucketBadgeClass(row.bucket, row.priorityLabel)}>{row.displayStatus}</span>
      </td>
      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{row.checkoutLabel}</td>
      {canReassign ? (
        <td className="px-3 py-2">
          {row.assignAllowed ? (
            <FilterSelect
              className="min-w-[9rem] text-xs"
              value={currentAssignee ?? row.task.assigned_to ?? ""}
              disabled={busy || row.bucket === "verified"}
              onChange={(e) => {
                const next = e.target.value;
                if (next) onReassign(row.task.id, next, row.roomNumber);
              }}
            >
              <option value="">—</option>
              {staffOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </FilterSelect>
          ) : (
            <span className="text-xs text-[var(--text-muted)]" title={row.assignBlockReason ?? undefined}>
              Blocked
            </span>
          )}
        </td>
      ) : null}
    </tr>
  );
}
