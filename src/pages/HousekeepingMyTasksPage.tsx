import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, CalendarRange, RefreshCw, ShieldCheck } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { auditHousekeeping } from "@/lib/housekeepingAudit";
import { canAssignHousekeepingByPms } from "@/lib/housekeepingPmsRules";
import { fetchPmsBoardRows } from "@/lib/pmsBoard";
import { supabase } from "@/lib/supabase";
import {
  isTaskOverdue,
  TASK_STATUS_LABELS,
  useCompleteHousekeepingTask,
  useHousekeepingRealtime,
  useMyHousekeepingTasks,
  useStartHousekeepingTask,
} from "@/lib/housekeeping";
import { readTaskVerify, useSelfVerifyHousekeepingTask } from "@/lib/hkTaskVerify";
import {
  readAssignmentProposal,
  useAcceptHousekeepingAssignment,
  useDeclineHousekeepingAssignment,
  useProposedHousekeepingTasks,
} from "@/lib/housekeepingAssignment";
import { useMyDailySchedule } from "@/lib/housekeepingSchedule";
import { canManageHousekeeping } from "@/types/roles";
import type { HousekeepingTask, HkTaskStatus } from "@/types/housekeeping";
import type { PmsBoardRow } from "@/types/pmsBoard";

const BADGE_BASE =
  "inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDue(due: string | null | undefined): string {
  if (!due) return "No due time";
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(due));
  } catch {
    return due;
  }
}

function taskBadgeClass(status: HkTaskStatus, overdue: boolean): string {
  if (overdue) {
    return `${BADGE_BASE} border-red-400 bg-red-100 text-red-900 dark:border-red-500/55 dark:bg-red-500/15 dark:text-red-200`;
  }
  switch (status) {
    case "assigned":
      return `${BADGE_BASE} border-sky-400/80 bg-sky-100 text-sky-950 dark:border-sky-500/45 dark:bg-sky-500/12 dark:text-sky-100`;
    case "in_progress":
      return `${BADGE_BASE} border-sky-500 bg-sky-200/80 text-sky-950 dark:border-sky-400/55 dark:bg-sky-500/20 dark:text-sky-50`;
    case "inspection_pending":
      return `${BADGE_BASE} border-violet-400 bg-violet-100 text-violet-950 dark:border-violet-500/50 dark:bg-violet-500/15 dark:text-violet-100`;
    default:
      return `${BADGE_BASE} border-[var(--border)] bg-[var(--surface)] text-[var(--text-h)]`;
  }
}

function hkBtn(variant: "start" | "complete" | "neutral", extra = ""): string {
  const base =
    "inline-flex min-h-[2.5rem] w-full items-center justify-center gap-2 rounded-lg border px-3 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-[2.75rem] sm:text-sm";
  switch (variant) {
    case "start":
      return `${base} border-sky-400/70 bg-sky-100 text-sky-950 hover:bg-sky-200/90 dark:border-sky-500/55 dark:bg-sky-500/20 dark:text-sky-50 dark:hover:bg-sky-500/30 ${extra}`;
    case "complete":
      return `${base} border-emerald-500/80 bg-[var(--accent)] text-[#042f1f] hover:bg-[var(--accent-hover)] dark:border-emerald-400/60 ${extra}`;
    default:
      return `${base} border-[var(--border)] bg-[var(--surface)] text-[var(--text-h)] hover:bg-[var(--surface-2)] ${extra}`;
  }
}

function taskStartGate(task: HousekeepingTask, pmsByRoom: Map<string, PmsBoardRow>) {
  return canAssignHousekeepingByPms(pmsByRoom.get(task.room_number.trim()), task);
}

export function HousekeepingMyTasksPage() {
  const { profile } = useAuth();
  const userId = profile?.id;
  const showBoardLink = profile ? canManageHousekeeping(profile.role) : false;
  const today = todayIso();

  const tasksQuery = useMyHousekeepingTasks(userId);
  const proposedQuery = useProposedHousekeepingTasks(userId);
  const scheduleQuery = useMyDailySchedule(userId, today);
  const pmsQuery = useQuery({
    queryKey: ["pms-board", "my-tasks"] as const,
    queryFn: fetchPmsBoardRows,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  useHousekeepingRealtime(userId);

  const startMutation = useStartHousekeepingTask(userId);
  const completeMutation = useCompleteHousekeepingTask(userId);
  const selfVerifyMutation = useSelfVerifyHousekeepingTask(userId);
  const acceptMutation = useAcceptHousekeepingAssignment(userId);
  const declineMutation = useDeclineHousekeepingAssignment(userId);

  const [actionError, setActionError] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const tasks = tasksQuery.data ?? [];
  const proposals = proposedQuery.data ?? [];

  const pmsByRoom = useMemo(() => {
    const map = new Map<string, PmsBoardRow>();
    for (const row of pmsQuery.data ?? []) {
      map.set(String(row.room_number).trim(), row);
    }
    return map;
  }, [pmsQuery.data]);

  const scheduledOnlyRooms = useMemo(() => {
    const scheduled = scheduleQuery.data?.assigned_rooms ?? [];
    const taskRooms = new Set(tasks.map((t) => t.room_number));
    return scheduled.filter((room) => !taskRooms.has(room));
  }, [scheduleQuery.data, tasks]);

  const sorted = useMemo(() => {
    return [...tasks].sort((a, b) => {
      const aReady = taskStartGate(a, pmsByRoom).allowed ? 0 : 1;
      const bReady = taskStartGate(b, pmsByRoom).allowed ? 0 : 1;
      if (aReady !== bReady) return aReady - bReady;

      const order: Record<string, number> = {
        in_progress: 0,
        assigned: 1,
        inspection_pending: 2,
        pending: 3,
      };
      const oa = order[a.status] ?? 9;
      const ob = order[b.status] ?? 9;
      if (oa !== ob) return oa - ob;
      const da = a.due_at ? new Date(a.due_at).getTime() : Infinity;
      const db = b.due_at ? new Date(b.due_at).getTime() : Infinity;
      return da - db;
    });
  }, [tasks, pmsByRoom]);

  const stats = useMemo(() => {
    const active = tasks.filter((t) => t.status === "assigned" || t.status === "in_progress");
    const waiting = tasks.filter((t) => t.status === "inspection_pending");
    const overdue = tasks.filter((t) => isTaskOverdue(t.due_at));
    const waitingCheckout = tasks.filter(
      (t) =>
        (t.status === "assigned" || t.status === "pending") && !taskStartGate(t, pmsByRoom).allowed,
    );
    const readyToClean = tasks.filter(
      (t) =>
        (t.status === "assigned" || t.status === "in_progress") && taskStartGate(t, pmsByRoom).allowed,
    );
    return {
      active: active.length,
      waiting: waiting.length,
      overdue: overdue.length,
      scheduled: scheduledOnlyRooms.length,
      waitingCheckout: waitingCheckout.length,
      readyToClean: readyToClean.length,
    };
  }, [tasks, scheduledOnlyRooms.length, pmsByRoom]);

  async function runTaskAction(
    taskId: string,
    fn: () => Promise<{ room_number?: string; confirmation_number?: string | null } | null | void>,
    audit?: { action: string; description: string; extra?: Record<string, unknown> },
  ) {
    setActionError(null);
    setBusyTaskId(taskId);
    try {
      const result = await fn();
      if (profile && audit) {
        await auditHousekeeping(supabase, profile, audit.action, audit.description, {
          task_id: taskId,
          ...audit.extra,
          ...(result && typeof result === "object" ? result : {}),
        }, result && typeof result === "object" ? result.confirmation_number ?? null : null);
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyTaskId(null);
    }
  }

  const isLoading = tasksQuery.isLoading || scheduleQuery.isLoading || proposedQuery.isLoading;
  const isEmpty = sorted.length === 0 && scheduledOnlyRooms.length === 0 && proposals.length === 0;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">My tasks</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Today&apos;s assigned rooms and your daily schedule — start cleaning, then mark complete for inspection.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
          onClick={() => {
            void tasksQuery.refetch();
            void scheduleQuery.refetch();
            void proposedQuery.refetch();
            void pmsQuery.refetch();
          }}
          disabled={tasksQuery.isFetching || scheduleQuery.isFetching || proposedQuery.isFetching || pmsQuery.isFetching}
        >
          <RefreshCw
            className={`h-4 w-4 ${tasksQuery.isFetching || scheduleQuery.isFetching || proposedQuery.isFetching ? "animate-spin" : ""}`}
            aria-hidden
          />
          Refresh
        </button>
      </div>

      {showBoardLink ? (
        <p className="mb-3 text-sm">
          <Link
            to="/housekeeping"
            className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
          >
            Open housekeeping board
          </Link>
          <span className="text-[var(--text-muted)]"> (assign & inspect)</span>
        </p>
      ) : null}

      <section className="mb-4 flex flex-wrap gap-2 text-[12px] tabular-nums">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/80 bg-emerald-50/80 px-2.5 py-1 font-medium text-emerald-950 dark:border-emerald-900/40 dark:bg-emerald-950/25 dark:text-emerald-100">
          Ready to clean
          <span className="font-semibold">{stats.readyToClean}</span>
        </span>
        {stats.waitingCheckout > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-300/80 bg-violet-50/80 px-2.5 py-1 font-medium text-violet-950 dark:border-violet-900/40 dark:bg-violet-950/25 dark:text-violet-100">
            Guest in room
            <span className="font-semibold">{stats.waitingCheckout}</span>
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-300/80 bg-sky-50/80 px-2.5 py-1 font-medium text-sky-950 dark:border-sky-900/40 dark:bg-sky-950/25 dark:text-sky-100">
          To do
          <span className="font-semibold">{stats.active}</span>
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-300/80 bg-violet-50/80 px-2.5 py-1 font-medium text-violet-950 dark:border-violet-900/40 dark:bg-violet-950/25 dark:text-violet-100">
          Awaiting inspection
          <span className="font-semibold">{stats.waiting}</span>
        </span>
        {stats.scheduled > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/80 bg-amber-50/80 px-2.5 py-1 font-medium text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/25 dark:text-amber-100">
            Scheduled
            <span className="font-semibold">{stats.scheduled}</span>
          </span>
        ) : null}
        {stats.overdue > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-red-300/80 bg-red-50/80 px-2.5 py-1 font-medium text-red-950 dark:border-red-900/40 dark:bg-red-950/25 dark:text-red-100">
            Overdue
            <span className="font-semibold">{stats.overdue}</span>
          </span>
        ) : null}
      </section>

      {actionError ? (
        <p className="mb-3 rounded-lg border border-red-300/80 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-200" role="alert">
          {actionError}
        </p>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading your tasks…</p>
      ) : tasksQuery.isError ? (
        <p className="text-sm text-red-500">{(tasksQuery.error as Error).message}</p>
      ) : isEmpty ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-10 text-center">
          <p className="font-medium text-[var(--text-h)]">No tasks assigned</p>
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            When a supervisor assigns you a room on the schedule or board, it will appear here.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 pb-8 sm:grid-cols-2 xl:grid-cols-3">
          {proposals.length > 0 ? (
            <li className="col-span-full rounded-xl border border-amber-300/70 bg-amber-50/50 px-4 py-3 dark:border-amber-800/40 dark:bg-amber-950/15">
              <p className="text-sm font-semibold text-[var(--text-h)]">Assignment proposals</p>
              <p className="mt-1 text-[12.5px] text-[var(--text-muted)]">
                A supervisor proposed these rooms for you — accept to add them to your task list.
              </p>
              <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {proposals.map((task) => (
                  <ProposalCard
                    key={task.id}
                    task={task}
                    busy={busyTaskId === task.id}
                    onAccept={() =>
                      void runTaskAction(
                        task.id,
                        () => acceptMutation.mutateAsync(task.id),
                        {
                          action: "hk_task_accepted",
                          description: `Accepted assignment for room ${task.room_number}`,
                          extra: { room_number: task.room_number },
                        },
                      )
                    }
                    onDecline={() =>
                      void runTaskAction(
                        task.id,
                        () => declineMutation.mutateAsync(task.id),
                        {
                          action: "hk_task_declined",
                          description: `Declined assignment for room ${task.room_number}`,
                          extra: { room_number: task.room_number },
                        },
                      )
                    }
                  />
                ))}
              </ul>
            </li>
          ) : null}

          {scheduledOnlyRooms.length > 0 ? (
            <li className="col-span-full rounded-xl border border-dashed border-amber-300/70 bg-amber-50/50 px-4 py-3 dark:border-amber-800/40 dark:bg-amber-950/15">
              <div className="flex items-start gap-2">
                <CalendarRange className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
                <div>
                  <p className="text-sm font-semibold text-[var(--text-h)]">On today&apos;s schedule</p>
                  <p className="mt-1 text-[12.5px] text-[var(--text-muted)]">
                    These rooms are planned for you — they will become active tasks once the supervisor applies the schedule.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {scheduledOnlyRooms.map((room) => (
                      <span
                        key={room}
                        className="inline-flex rounded-md border border-amber-300/80 bg-amber-100/80 px-2 py-0.5 font-mono text-[12px] font-semibold text-amber-950 dark:border-amber-700/50 dark:bg-amber-900/30 dark:text-amber-100"
                      >
                        {room}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </li>
          ) : null}

          {sorted.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              startGate={taskStartGate(task, pmsByRoom)}
              busy={busyTaskId === task.id}
              onStart={() =>
                void runTaskAction(
                  task.id,
                  () => startMutation.mutateAsync({ taskId: task.id }),
                  {
                    action: "hk_task_started",
                    description: `Started cleaning room ${task.room_number}`,
                    extra: { room_number: task.room_number },
                  },
                )
              }
              onComplete={() =>
                void runTaskAction(
                  task.id,
                  () => completeMutation.mutateAsync({ taskId: task.id }),
                  {
                    action: "hk_task_completed",
                    description: `Completed cleaning room ${task.room_number}`,
                    extra: { room_number: task.room_number },
                  },
                )
              }
              onSelfVerify={() =>
                void runTaskAction(
                  task.id,
                  () => selfVerifyMutation.mutateAsync(task.id),
                  {
                    action: "hk_task_self_verified",
                    description: `Self-verified room ${task.room_number}`,
                    extra: { room_number: task.room_number },
                  },
                )
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProposalCard({
  task,
  busy,
  onAccept,
  onDecline,
}: {
  task: HousekeepingTask;
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const proposal = readAssignmentProposal(task.metadata);
  return (
    <li className="flex flex-col justify-between gap-3 rounded-lg border border-amber-300/60 bg-[var(--surface)] px-3 py-2.5">
      <div>
        <p className="font-mono text-xl font-bold text-[var(--text-h)]">{task.room_number}</p>
        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
          Proposed {proposal ? new Date(proposal.proposedAt).toLocaleString() : ""}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className={hkBtn("neutral", "min-h-0 py-2")} disabled={busy} onClick={onDecline}>
          Decline
        </button>
        <button type="button" className={hkBtn("start", "min-h-0 py-2")} disabled={busy} onClick={onAccept}>
          Accept
        </button>
      </div>
    </li>
  );
}

function TaskCard({
  task,
  startGate,
  busy,
  onStart,
  onComplete,
  onSelfVerify,
}: {
  task: HousekeepingTask;
  startGate: { allowed: boolean; reason: string | null };
  busy: boolean;
  onStart: () => void;
  onComplete: () => void;
  onSelfVerify: () => void;
}) {
  const overdue = isTaskOverdue(task.due_at);
  const status = task.status;
  const verify = readTaskVerify(task.metadata);
  const selfVerified = !!verify.selfVerifiedAt;
  const guestInRoom = !startGate.allowed && (status === "assigned" || status === "pending");
  const canStart = status === "assigned" && startGate.allowed;
  const canSelfVerify =
    !selfVerified && (status === "in_progress" || status === "inspection_pending");

  const accent =
    guestInRoom
      ? "border-t-violet-500"
      : overdue && status !== "inspection_pending"
        ? "border-t-red-500"
        : status === "in_progress"
          ? "border-t-sky-500"
          : status === "assigned"
            ? "border-t-emerald-500"
            : status === "inspection_pending"
              ? "border-t-violet-400"
              : "border-t-[var(--border)]";

  return (
    <li
      className={[
        "flex min-h-[11.5rem] flex-col rounded-xl border border-[var(--border)] border-t-[3px] bg-[var(--surface)] p-3.5 shadow-sm transition-shadow hover:shadow-md sm:min-h-[12rem] sm:p-4",
        accent,
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-2xl font-bold leading-none tracking-tight text-[var(--text-h)] sm:text-[1.65rem]">
            {task.room_number}
          </p>
          <p className="mt-1.5 truncate text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            {task.task_type.replace(/_/g, " ")}
          </p>
        </div>
        <span className={taskBadgeClass(status, overdue && status !== "inspection_pending")}>
          {guestInRoom ? "Wait checkout" : TASK_STATUS_LABELS[status] ?? status}
        </span>
      </div>

      {selfVerified ? (
        <p className="mt-2 inline-flex items-center gap-1 rounded-md border border-emerald-300/70 bg-emerald-50/80 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-emerald-950 dark:border-emerald-700/45 dark:bg-emerald-500/10 dark:text-emerald-100">
          <ShieldCheck className="h-3 w-3" aria-hidden />
          Self verified
        </p>
      ) : null}

      {guestInRoom ? (
        <p className="mt-2 rounded-md border border-violet-300/60 bg-violet-50/80 px-2 py-1.5 text-[11px] font-medium leading-snug text-violet-950 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100">
          Guest in room — do not enter. Start cleaning after checkout when DualPMS shows the room vacant.
        </p>
      ) : null}

      <p
        className={[
          "mt-3 text-[12px] font-medium leading-snug tabular-nums",
          overdue && status !== "inspection_pending"
            ? "text-red-600 dark:text-red-300"
            : "text-[var(--text-h)]",
        ].join(" ")}
      >
        Due {formatDue(task.due_at)}
      </p>

      {task.notes ? (
        <p className="mt-1.5 line-clamp-2 text-[12px] text-[var(--text-muted)]">{task.notes}</p>
      ) : null}

      <div className="mt-auto pt-3">
        {canStart ? (
          <button type="button" className={hkBtn("start")} disabled={busy} onClick={onStart}>
            {busy ? "Starting…" : "Start cleaning"}
          </button>
        ) : null}

        {guestInRoom ? (
          <div className="rounded-lg border border-violet-300/60 bg-violet-50/60 px-2.5 py-2.5 text-center text-[11.5px] font-medium text-violet-900 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100">
            Waiting for guest checkout
          </div>
        ) : null}

        {status === "assigned" && !startGate.allowed && !guestInRoom ? (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2.5 text-center text-[11.5px] text-[var(--text-muted)]">
            {startGate.reason ?? "Not ready to start"}
          </div>
        ) : null}

        {status === "in_progress" ? (
          <div className="flex flex-col gap-2">
            <button type="button" className={hkBtn("complete")} disabled={busy} onClick={onComplete}>
              <Check className="h-4 w-4" aria-hidden />
              {busy ? "Saving…" : "Mark complete"}
            </button>
            {canSelfVerify ? (
              <button type="button" className={hkBtn("neutral")} disabled={busy} onClick={onSelfVerify}>
                <ShieldCheck className="h-4 w-4" aria-hidden />
                {busy ? "Saving…" : "Self verify"}
              </button>
            ) : null}
          </div>
        ) : null}

        {status === "inspection_pending" ? (
          <div className="flex flex-col gap-2">
            <div className="rounded-lg border border-violet-300/60 bg-violet-50/80 px-2.5 py-2.5 text-center text-[11.5px] font-medium leading-snug text-violet-950 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100">
              Awaiting supervisor inspection
            </div>
            {canSelfVerify ? (
              <button type="button" className={hkBtn("neutral")} disabled={busy} onClick={onSelfVerify}>
                <ShieldCheck className="h-4 w-4" aria-hidden />
                {busy ? "Saving…" : "Self verify"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
