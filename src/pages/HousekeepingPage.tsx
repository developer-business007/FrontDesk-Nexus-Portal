import { useMemo, useState, type FormEvent } from "react";
import { FileText, RefreshCw, Sun } from "lucide-react";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { SearchField } from "@/components/ui/SearchField";
import { useAuth } from "@/contexts/AuthContext";
import { auditHousekeeping } from "@/lib/housekeepingAudit";
import { supabase } from "@/lib/supabase";
import {
  isTaskOverdue,
  ROOM_STATUS_LABELS,
  TASK_STATUS_LABELS,
  useAssignHousekeepingTask,
  useHousekeepingBoard,
  useHousekeepingRealtime,
  useHousekeepingStaff,
  useMarkRoomAvailable,
  useMarkRoomDirty,
  useRecordHousekeepingInspection,
} from "@/lib/housekeeping";
import {
  bestSuggestionForFloor,
  floorFromRoom,
  useAreaSuggestions,
  useRecordAreaFeedback,
} from "@/lib/housekeepingSchedule";
import {
  readAssignmentProposal,
  useAcceptHousekeepingAssignment,
  useDeclineHousekeepingAssignment,
  useHousekeepingTaskMetadata,
  useProposeHousekeepingAssignment,
} from "@/lib/housekeepingAssignment";
import { useClearRoomOutOfOrder, useSetRoomOutOfOrder } from "@/lib/housekeepingOoo";
import {
  formatPmsTaskSyncSummary,
  useSyncHousekeepingTasksFromPms,
} from "@/lib/hkPmsTaskSync";
import { resolveRaMonitorHotelDate } from "@/lib/hkRaMonitor";
import { useHotelSettings } from "@/lib/hotelSettings";
import { usePmsBoard } from "@/lib/pmsBoard";
import { isPmsRoomOutOfOrder } from "@/lib/dashboardRoomStats";
import { canInspectHousekeeping, canManageHousekeeping } from "@/types/roles";
import { canAssignHousekeepingByPms } from "@/lib/housekeepingPmsRules";
import { filterAssignableHousekeepers } from "@/lib/housekeeping";
import {
  HK_INSPECTION_RATING_OPTIONS,
  readTaskVerify,
  type HkInspectionRating,
} from "@/lib/hkTaskVerify";
import { openAlertsByRoom, useOpenHkAlerts } from "@/lib/hkAlerts";
import { useQuery } from "@tanstack/react-query";
import type { HkAlert } from "@/types/housekeeping";
import type { PmsBoardRow } from "@/types/pmsBoard";
import type {
  HousekeepingBoardRow,
  HousekeepingStaff,
  HousekeepingTask,
  RoomLifecycleStatus,
} from "@/types/housekeeping";

type StatusFilter = "all" | RoomLifecycleStatus | "needs_attention";

function staffLabel(s: { full_name: string | null; email: string | null }): string {
  return s.full_name?.trim() || s.email?.trim() || "—";
}

function formatDue(due: string | null | undefined): string {
  if (!due) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(due));
  } catch {
    return due;
  }
}

const BADGE_BASE =
  "inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide";

function statusBadgeClass(roomStatus: RoomLifecycleStatus): string {
  switch (roomStatus) {
    case "dirty":
      return `${BADGE_BASE} border-amber-400 bg-amber-100 text-amber-950 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-100`;
    case "in_service":
      return `${BADGE_BASE} border-sky-400 bg-sky-100 text-sky-950 dark:border-sky-500/50 dark:bg-sky-500/15 dark:text-sky-100`;
    case "clean_ready":
      return `${BADGE_BASE} border-emerald-400 bg-emerald-100 text-emerald-950 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-100`;
    case "occupied":
      return `${BADGE_BASE} border-violet-400 bg-violet-100 text-violet-950 dark:border-violet-500/50 dark:bg-violet-500/15 dark:text-violet-100`;
    case "out_of_order":
      return `${BADGE_BASE} border-red-400 bg-red-100 text-red-950 dark:border-red-500/50 dark:bg-red-500/15 dark:text-red-100`;
    default:
      return `${BADGE_BASE} border-[var(--border)] bg-[var(--surface)] text-[var(--text-h)]`;
  }
}

function taskStatusBadgeClass(taskStatus: string, overdue: boolean): string {
  if (overdue) {
    return `${BADGE_BASE} border-red-400 bg-red-100 text-red-900 dark:border-red-500/55 dark:bg-red-500/15 dark:text-red-200`;
  }
  switch (taskStatus) {
    case "pending":
      return `${BADGE_BASE} border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-h)]`;
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

/** Keys-board style row accent by room lifecycle state. */
function hkRowTint(roomStatus: RoomLifecycleStatus): string {
  switch (roomStatus) {
    case "dirty":
      return "border-l-2 border-l-amber-500/75 bg-amber-500/[0.06]";
    case "in_service":
      return "border-l-2 border-l-sky-500/70 bg-sky-500/[0.06]";
    case "clean_ready":
      return "border-l-2 border-l-emerald-500/65 bg-emerald-500/[0.06]";
    case "occupied":
      return "border-l-2 border-l-violet-500/60 bg-violet-500/[0.05]";
    case "out_of_order":
      return "border-l-2 border-l-red-500/70 bg-red-500/[0.06]";
    default:
      return "border-l-2 border-l-transparent bg-[var(--surface)]";
  }
}

type HkActionVariant = "neutral" | "assign" | "inspect" | "available" | "dirty";

function hkActionBtn(variant: HkActionVariant, extra = ""): string {
  const base =
    "inline-flex h-8 shrink-0 items-center justify-center rounded-lg border px-2.5 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45";
  switch (variant) {
    case "assign":
      return `${base} border-sky-400/70 bg-sky-100 text-sky-950 hover:bg-sky-200/90 dark:border-sky-500/55 dark:bg-sky-500/20 dark:text-sky-50 dark:hover:bg-sky-500/30 ${extra}`;
    case "inspect":
      return `${base} border-violet-400/70 bg-violet-100 text-violet-950 hover:bg-violet-200/90 dark:border-violet-500/55 dark:bg-violet-500/20 dark:text-violet-50 dark:hover:bg-violet-500/30 ${extra}`;
    case "available":
      return `${base} border-emerald-500/80 bg-[var(--accent)] text-[#042f1f] hover:bg-[var(--accent-hover)] dark:border-emerald-400/60 ${extra}`;
    case "dirty":
      return `${base} border-amber-400/70 bg-amber-100 text-amber-950 hover:bg-amber-200/90 dark:border-amber-500/55 dark:bg-amber-500/20 dark:text-amber-50 dark:hover:bg-amber-500/30 ${extra}`;
    default:
      return `${base} border-[var(--border)] bg-[var(--surface)] text-[var(--text-h)] hover:bg-[var(--surface-2)] ${extra}`;
  }
}

function AssignModal({
  roomNumber,
  floor,
  staff,
  busy,
  onClose,
  onAssign,
}: {
  roomNumber: string;
  floor: number;
  staff: { id: string; full_name: string | null; email: string | null }[];
  busy: boolean;
  onClose: () => void;
  onAssign: (housekeeperId: string, requireAcceptance: boolean) => void;
}) {
  const suggestionsQuery = useAreaSuggestions();
  const suggestion = useMemo(
    () => bestSuggestionForFloor(suggestionsQuery.data ?? [], floor),
    [suggestionsQuery.data, floor],
  );

  const suggestedStaff = suggestion
    ? staff.find((s) => s.id === suggestion.housekeeper_id)
    : null;

  const [hkId, setHkId] = useState(() => suggestion?.housekeeper_id ?? staff[0]?.id ?? "");
  const [requireAcceptance, setRequireAcceptance] = useState(false);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!hkId) return;
    onAssign(hkId, requireAcceptance);
  }

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hk-assign-title"
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl"
      >
        <h2 id="hk-assign-title" className="text-lg font-semibold text-[var(--text-h)]">
          Assign room {roomNumber}
        </h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Choose a housekeeper for this turnover task.</p>

        {suggestedStaff ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/25 dark:text-amber-100">
            <Sun className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              <strong>{staffLabel(suggestedStaff)}</strong> is suggested for Floor {floor} based on
              {suggestion!.cleanCount} recent clean{suggestion!.cleanCount !== 1 ? "s" : ""}
              {suggestion!.complaintCount === 0 ? " with no complaints" : ""}
              {suggestion!.continuityBoost ? " — same area yesterday with no complaints" : ""}.
            </span>
          </div>
        ) : null}

        <label className="mt-4 block text-sm font-medium text-[var(--text-h)]">
          Housekeeper
          <FilterSelect
            className="mt-1.5"
            value={hkId}
            onChange={(e) => setHkId(e.target.value)}
            required
          >
            {staff.length === 0 ? (
              <option value="">No housekeepers in system</option>
            ) : (
              staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {staffLabel(s)}
                  {s.id === suggestion?.housekeeper_id ? " ★ Suggested" : ""}
                </option>
              ))
            )}
          </FilterSelect>
        </label>
        <label className="mt-4 flex items-start gap-2 text-sm text-[var(--text-h)]">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-[var(--border)]"
            checked={requireAcceptance}
            onChange={(e) => setRequireAcceptance(e.target.checked)}
          />
          <span>
            Require housekeeper acceptance
            <span className="mt-0.5 block text-[12px] font-normal text-[var(--text-muted)]">
              Sends a proposal to My tasks — room stays unassigned until they accept.
            </span>
          </span>
        </label>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !hkId}>
            {busy ? "Saving…" : requireAcceptance ? "Send proposal" : "Assign"}
          </button>
        </div>
      </form>
    </div>
  );
}

function FeedbackModal({
  roomNumber,
  housekeeperId,
  busy,
  onClose,
  onSubmit,
}: {
  roomNumber: string;
  housekeeperId: string | null;
  taskId: string | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (description: string, feedbackType: "complaint" | "compliment" | "note") => void;
}) {
  const [description, setDescription] = useState("");
  const [feedbackType, setFeedbackType] = useState<"complaint" | "compliment" | "note">("complaint");

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hk-feedback-title"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(description.trim(), feedbackType);
        }}
        className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl"
      >
        <h2 id="hk-feedback-title" className="text-lg font-semibold text-[var(--text-h)]">
          Log feedback — room {roomNumber}
        </h2>
        <label className="mt-4 block text-sm font-medium text-[var(--text-h)]">
          Type
          <FilterSelect
            className="mt-1.5"
            value={feedbackType}
            onChange={(e) => setFeedbackType(e.target.value as "complaint" | "compliment" | "note")}
          >
            <option value="complaint">Complaint</option>
            <option value="compliment">Compliment</option>
            <option value="note">Note</option>
          </FilterSelect>
        </label>
        <label className="mt-3 block text-sm font-medium text-[var(--text-h)]">
          Description
          <textarea
            className="input-field mt-1.5 min-h-[4rem] w-full resize-y text-sm"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Guest reported missed area, stain, etc."
            required
          />
        </label>
        {housekeeperId ? (
          <p className="mt-2 text-[12px] text-[var(--text-muted)]">
            Linked to the assigned housekeeper for area scoring.
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !description.trim()}>
            {busy ? "Saving…" : "Save feedback"}
          </button>
        </div>
      </form>
    </div>
  );
}

function InspectModal({
  roomNumber,
  selfVerified,
  busy,
  onClose,
  onResult,
}: {
  roomNumber: string;
  selfVerified: boolean;
  busy: boolean;
  onClose: () => void;
  onResult: (
    result: "passed" | "failed" | "waived",
    input: { notes: string; rating: HkInspectionRating; problemCount: number },
  ) => void;
}) {
  const [notes, setNotes] = useState("");
  const [rating, setRating] = useState<HkInspectionRating>("good");
  const [problemCount, setProblemCount] = useState(0);

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hk-inspect-title"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl">
        <h2 id="hk-inspect-title" className="text-lg font-semibold text-[var(--text-h)]">
          Inspect room {roomNumber}
        </h2>
        {selfVerified ? (
          <p className="mt-2 rounded-md border border-emerald-300/70 bg-emerald-50/80 px-2.5 py-1.5 text-[12px] font-medium text-emerald-950 dark:border-emerald-700/45 dark:bg-emerald-500/10 dark:text-emerald-100">
            Housekeeper self-verified this room.
          </p>
        ) : (
          <p className="mt-2 text-[12px] text-[var(--text-muted)]">
            No self-verify on file — inspect as usual.
          </p>
        )}
        <label className="mt-4 block text-sm font-medium text-[var(--text-h)]">
          Quality rating
          <select
            className="input-field mt-1.5 w-full text-sm"
            value={rating}
            onChange={(e) => setRating(e.target.value as HkInspectionRating)}
          >
            {HK_INSPECTION_RATING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="mt-3 block text-sm font-medium text-[var(--text-h)]">
          Problem count
          <input
            type="number"
            min={0}
            max={99}
            className="input-field mt-1.5 w-full text-sm"
            value={problemCount}
            onChange={(e) => setProblemCount(Math.max(0, Number(e.target.value) || 0))}
          />
        </label>
        <label className="mt-3 block text-sm font-medium text-[var(--text-h)]">
          Notes (optional)
          <textarea
            className="input-field mt-1.5 min-h-[4rem] w-full resize-y text-sm"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-secondary border-amber-300 text-amber-900 dark:border-amber-700 dark:text-amber-200"
            disabled={busy}
            onClick={() => onResult("waived", { notes, rating, problemCount })}
          >
            Waive
          </button>
          <button
            type="button"
            className="btn-secondary border-red-300 text-red-700 dark:border-red-800 dark:text-red-300"
            disabled={busy}
            onClick={() => onResult("failed", { notes, rating, problemCount })}
          >
            Fail
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => onResult("passed", { notes, rating, problemCount })}
          >
            {busy ? "Saving…" : "Pass"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function HousekeepingPage() {
  const { profile } = useAuth();
  const userId = profile?.id;
  const hotel = useHotelSettings();
  const canManage = profile ? canManageHousekeeping(profile.role) : false;
  const canInspect = profile ? canInspectHousekeeping(profile.role) : false;

  const boardQuery = useHousekeepingBoard();
  const staffQuery = useHousekeepingStaff();
  const taskMetaQuery = useHousekeepingTaskMetadata();
  const pmsBoardQuery = usePmsBoard();
  const pmsTaskSyncMutation = useSyncHousekeepingTasksFromPms();
  useHousekeepingRealtime(userId);

  const hotelDateQuery = useQuery({
    queryKey: ["board-hotel-date", hotel.timezone, hotel.businessDayCutoffHour],
    queryFn: () => resolveRaMonitorHotelDate(hotel),
    staleTime: 60_000,
  });
  const alertsQuery = useOpenHkAlerts(hotelDateQuery.data);
  const alertsByRoom = useMemo(
    () => openAlertsByRoom(alertsQuery.data ?? []),
    [alertsQuery.data],
  );

  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  const assignMutation = useAssignHousekeepingTask(userId);
  const proposeMutation = useProposeHousekeepingAssignment(userId);
  const approveMutation = useAcceptHousekeepingAssignment(userId);
  const declineProposalMutation = useDeclineHousekeepingAssignment(userId);
  const inspectMutation = useRecordHousekeepingInspection(userId);
  const availableMutation = useMarkRoomAvailable(userId);
  const dirtyMutation = useMarkRoomDirty(userId);
  const setOooMutation = useSetRoomOutOfOrder(userId);
  const clearOooMutation = useClearRoomOutOfOrder(userId);
  const feedbackMutation = useRecordAreaFeedback();

  const [search, setSearch] = useState("");
  const [floorFilter, setFloorFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<{ taskId: string; roomNumber: string; floor: number } | null>(
    null,
  );
  const [inspectTarget, setInspectTarget] = useState<{
    taskId: string;
    roomNumber: string;
    assignedTo: string | null;
    selfVerified: boolean;
  } | null>(null);
  const [feedbackTarget, setFeedbackTarget] = useState<{
    roomNumber: string;
    housekeeperId: string | null;
    taskId: string | null;
  } | null>(null);

  const floors = useMemo(() => {
    const set = new Set<number>();
    for (const r of boardQuery.data ?? []) set.add(r.floor);
    return [...set].sort((a, b) => a - b);
  }, [boardQuery.data]);

  const stats = useMemo(() => {
    const rows = boardQuery.data ?? [];
    return {
      total: rows.length,
      dirty: rows.filter((r) => r.room_status === "dirty").length,
      inService: rows.filter((r) => r.room_status === "in_service").length,
      cleanReady: rows.filter((r) => r.room_status === "clean_ready").length,
      inspection: rows.filter((r) => r.task_status === "inspection_pending").length,
      unassigned: rows.filter((r) => r.task_status === "pending").length,
      overdue: rows.filter((r) => isTaskOverdue(r.due_at) && r.task_status && r.task_status !== "completed").length,
    };
  }, [boardQuery.data]);

  const staffById = useMemo(() => {
    const m = new Map<string, HousekeepingStaff>();
    for (const s of staffQuery.data ?? []) m.set(s.id, s);
    return m;
  }, [staffQuery.data]);

  const taskMetaById = useMemo(() => {
    const m = new Map<string, HousekeepingTask>();
    for (const task of taskMetaQuery.data ?? []) m.set(task.id, task);
    return m;
  }, [taskMetaQuery.data]);

  const pmsByRoom = useMemo(() => {
    const m = new Map<string, NonNullable<typeof pmsBoardQuery.data>[number]>();
    for (const row of pmsBoardQuery.data ?? []) m.set(row.room_number, row);
    return m;
  }, [pmsBoardQuery.data]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (boardQuery.data ?? []).filter((row) => {
      if (floorFilter !== "all" && String(row.floor) !== floorFilter) return false;
      if (unassignedOnly && row.task_status !== "pending") return false;
      if (statusFilter === "needs_attention") {
        const attention =
          row.room_status === "dirty" ||
          row.room_status === "in_service" ||
          row.task_status === "inspection_pending" ||
          isTaskOverdue(row.due_at);
        if (!attention) return false;
      } else if (statusFilter !== "all" && row.room_status !== statusFilter) {
        return false;
      }
      if (q && !row.room_number.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [boardQuery.data, floorFilter, statusFilter, unassignedOnly, search]);

  const busy =
    assignMutation.isPending ||
    proposeMutation.isPending ||
    approveMutation.isPending ||
    declineProposalMutation.isPending ||
    inspectMutation.isPending ||
    availableMutation.isPending ||
    dirtyMutation.isPending ||
    setOooMutation.isPending ||
    clearOooMutation.isPending ||
    feedbackMutation.isPending ||
    pmsTaskSyncMutation.isPending;

  async function runPmsTaskSync() {
    setActionError(null);
    setSyncNotice(null);
    try {
      const hotelDate = await resolveRaMonitorHotelDate(hotel);
      const result = await pmsTaskSyncMutation.mutateAsync(hotelDate);
      setSyncNotice(formatPmsTaskSyncSummary(result));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "PMS task sync failed");
    }
  }

  async function runAction(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Action failed");
    }
  }

  if (!canManage) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-amber-300 bg-amber-50 px-4 py-6 text-amber-950 dark:border-amber-900/45 dark:bg-amber-950/20 dark:text-amber-100">
        <p className="font-semibold">Access restricted</p>
        <p className="mt-2 text-sm opacity-90">
          Housekeeping board is for front desk, supervisors, and managers. Housekeepers use{" "}
          <strong>My tasks</strong> in the sidebar.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px]">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Housekeeping</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Room turnover board — assign, inspect, and release rooms for check-in.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canInspect ? (
            <button
              type="button"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--accent-border)] bg-[var(--accent-muted-strong)] px-3 text-[13px] font-medium text-[var(--accent)] transition-colors hover:opacity-90 disabled:opacity-40"
              onClick={() => void runPmsTaskSync()}
              disabled={pmsTaskSyncMutation.isPending}
              title="Create due out, stayover, and full clean tasks from DualPMS"
            >
              <RefreshCw
                className={`h-4 w-4 ${pmsTaskSyncMutation.isPending ? "animate-spin" : ""}`}
                aria-hidden
              />
              Sync from PMS
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
            onClick={() => void boardQuery.refetch()}
            disabled={boardQuery.isFetching}
          >
            <RefreshCw
              className={`h-4 w-4 ${boardQuery.isFetching ? "animate-spin" : ""}`}
              aria-hidden
            />
            Refresh
          </button>
        </div>
      </div>

      {syncNotice ? (
        <p className="mb-3 text-sm text-emerald-700 dark:text-emerald-300">{syncNotice}</p>
      ) : null}

      <section className="mb-4 flex flex-wrap gap-2 text-[12px] tabular-nums">
        <StatPill label="Rooms" value={stats.total} />
        <StatPill label="Dirty" value={stats.dirty} tone="amber" />
        <StatPill label="In service" value={stats.inService} tone="sky" />
        <StatPill label="Awaiting inspection" value={stats.inspection} tone="violet" />
        <StatPill label="Clean ready" value={stats.cleanReady} tone="emerald" />
        <StatPill label="Unassigned tasks" value={stats.unassigned} />
        {stats.overdue > 0 ? <StatPill label="Overdue" value={stats.overdue} tone="red" /> : null}
      </section>

      <section className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <SearchField
            placeholder="Search room…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search room number"
          />
        </div>
        <div className="w-36">
          <label className="mb-1 block text-[11px] font-medium text-[var(--text-muted)]">Floor</label>
          <FilterSelect value={floorFilter} onChange={(e) => setFloorFilter(e.target.value)}>
            <option value="all">All floors</option>
            {floors.map((f) => (
              <option key={f} value={String(f)}>
                Floor {f}
              </option>
            ))}
          </FilterSelect>
        </div>
        <div className="w-44">
          <label className="mb-1 block text-[11px] font-medium text-[var(--text-muted)]">
            Room status
          </label>
          <FilterSelect
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            <option value="all">All statuses</option>
            <option value="needs_attention">Needs attention</option>
            <option value="dirty">Dirty</option>
            <option value="in_service">In service</option>
            <option value="clean_ready">Clean ready</option>
            <option value="available">Available</option>
            <option value="occupied">Occupied</option>
            <option value="out_of_order">Out of order</option>
          </FilterSelect>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-[var(--text-muted)]">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-[var(--border)]"
            checked={unassignedOnly}
            onChange={(e) => setUnassignedOnly(e.target.checked)}
          />
          Unassigned only
        </label>
      </section>

      {actionError ? (
        <p className="mb-3 text-sm text-red-500" role="alert">
          {actionError}
        </p>
      ) : null}

      {boardQuery.isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading board…</p>
      ) : boardQuery.isError ? (
        <p className="text-sm text-red-500">{(boardQuery.error as Error).message}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[880px] border-collapse text-left text-sm">
            <thead className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface)]">
              <tr>
                <th
                  scope="col"
                  className="px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
                >
                  Room
                </th>
                <th
                  scope="col"
                  className="px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
                >
                  Fl
                </th>
                <th
                  scope="col"
                  className="px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
                >
                  Status
                </th>
                <th
                  scope="col"
                  className="px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
                >
                  Task
                </th>
                <th
                  scope="col"
                  className="px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
                >
                  Assigned
                </th>
                <th
                  scope="col"
                  className="px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
                >
                  Due
                </th>
                <th
                  scope="col"
                  className="px-3 py-2.5 text-right text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-[var(--text-muted)]">
                    No rooms match filters.
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => {
                  const taskId = row.task_id ?? row.current_task_id;
                  const taskMeta = taskId ? taskMetaById.get(taskId) : undefined;
                  const proposal = taskMeta ? readAssignmentProposal(taskMeta.metadata) : null;
                  const pmsRow = pmsByRoom.get(row.room_number);
                  const pmsOoo = pmsRow ? isPmsRoomOutOfOrder(pmsRow) : false;

                  return (
                  <BoardRow
                    key={row.room_number}
                    row={row}
                    assignee={
                      row.assigned_to ? staffById.get(row.assigned_to) : undefined
                    }
                    proposedAssignee={
                      proposal ? staffById.get(proposal.proposedAssignee) : undefined
                    }
                    awaitingAcceptance={!!proposal}
                    pmsOoo={pmsOoo}
                    pmsRow={pmsRow}
                    roomAlerts={alertsByRoom.get(row.room_number.trim()) ?? []}
                    busy={busy}
                    canInspect={canInspect}
                    onAssign={() => {
                      const taskId = row.task_id ?? row.current_task_id;
                      if (!taskId) {
                        setActionError("No open task for this room — mark dirty first.");
                        return;
                      }
                      const gate = canAssignHousekeepingByPms(pmsRow, {
                        task_type: row.task_type ?? "checkout_turnover",
                        status: row.task_status ?? "pending",
                      });
                      if (!gate.allowed) {
                        setActionError(gate.reason ?? "Cannot assign while guest is in room.");
                        return;
                      }
                      setAssignTarget({
                        taskId,
                        roomNumber: row.room_number,
                        floor: row.floor ?? floorFromRoom(row.room_number),
                      });
                    }}
                    onInspect={() => {
                      const taskId = row.task_id ?? row.current_task_id;
                      if (!taskId) return;
                      const metaTask = taskMetaQuery.data?.find((t) => t.id === taskId);
                      const selfVerified = metaTask
                        ? !!readTaskVerify(metaTask.metadata).selfVerifiedAt
                        : false;
                      setInspectTarget({
                        taskId,
                        roomNumber: row.room_number,
                        assignedTo: row.assigned_to,
                        selfVerified,
                      });
                    }}
                    onFeedback={() =>
                      setFeedbackTarget({
                        roomNumber: row.room_number,
                        housekeeperId: row.assigned_to,
                        taskId: row.task_id ?? row.current_task_id,
                      })
                    }
                    onMarkAvailable={() =>
                      void runAction(async () => {
                        await availableMutation.mutateAsync({
                          roomNumber: row.room_number,
                          reason: "Released from housekeeping board",
                        });
                        if (profile) {
                          await auditHousekeeping(
                            supabase,
                            profile,
                            "hk_room_available",
                            `Room ${row.room_number} marked available`,
                            { room_number: row.room_number },
                            row.confirmation_number,
                          );
                        }
                      })
                    }
                    onMarkDirty={() =>
                      void runAction(async () => {
                        const task = await dirtyMutation.mutateAsync({
                          roomNumber: row.room_number,
                          notes: "Marked dirty from board",
                        });
                        if (profile) {
                          await auditHousekeeping(
                            supabase,
                            profile,
                            "hk_room_dirty",
                            `Room ${row.room_number} marked dirty`,
                            { room_number: row.room_number, task_id: task?.id },
                            task?.confirmation_number ?? row.confirmation_number,
                          );
                        }
                      })
                    }
                    onApprove={() => {
                      if (!taskId) return;
                      void runAction(async () => {
                        const task = await approveMutation.mutateAsync(taskId);
                        if (profile) {
                          await auditHousekeeping(
                            supabase,
                            profile,
                            "hk_task_assigned",
                            `Approved assignment for room ${row.room_number}`,
                            {
                              task_id: taskId,
                              room_number: row.room_number,
                              assigned_to: task?.assigned_to,
                            },
                            task?.confirmation_number ?? row.confirmation_number,
                          );
                        }
                      });
                    }}
                    onSetOoo={() =>
                      void runAction(async () => {
                        await setOooMutation.mutateAsync({
                          roomNumber: row.room_number,
                          reason: "Set OOO from housekeeping board",
                        });
                        if (profile) {
                          await auditHousekeeping(
                            supabase,
                            profile,
                            "hk_room_ooo",
                            `Room ${row.room_number} set out of order`,
                            { room_number: row.room_number },
                            row.confirmation_number,
                          );
                        }
                      })
                    }
                    onClearOoo={() =>
                      void runAction(async () => {
                        await clearOooMutation.mutateAsync({
                          roomNumber: row.room_number,
                          reason: "OOO cleared from housekeeping board",
                        });
                        if (profile) {
                          await auditHousekeeping(
                            supabase,
                            profile,
                            "hk_room_ooo_cleared",
                            `Room ${row.room_number} OOO cleared`,
                            { room_number: row.room_number },
                            row.confirmation_number,
                          );
                        }
                      })
                    }
                  />
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {assignTarget ? (
        <AssignModal
          roomNumber={assignTarget.roomNumber}
          floor={assignTarget.floor}
          staff={filterAssignableHousekeepers(staffQuery.data ?? [], profile?.id)}
          busy={assignMutation.isPending || proposeMutation.isPending}
          onClose={() => setAssignTarget(null)}
          onAssign={(housekeeperId, requireAcceptance) => {
            void runAction(async () => {
              const hk = staffQuery.data?.find((s) => s.id === housekeeperId);
              if (requireAcceptance) {
                if (!profile?.id) throw new Error("Not signed in");
                await proposeMutation.mutateAsync({
                  taskId: assignTarget.taskId,
                  proposedAssignee: housekeeperId,
                  proposedBy: profile.id,
                });
                if (profile) {
                  await auditHousekeeping(
                    supabase,
                    profile,
                    "hk_task_proposed",
                    `Proposed room ${assignTarget.roomNumber} to ${hk?.full_name ?? hk?.email ?? housekeeperId}`,
                    {
                      task_id: assignTarget.taskId,
                      room_number: assignTarget.roomNumber,
                      proposed_assignee: housekeeperId,
                    },
                  );
                }
              } else {
                const task = await assignMutation.mutateAsync({
                  taskId: assignTarget.taskId,
                  assignedTo: housekeeperId,
                });
                if (profile) {
                  await auditHousekeeping(
                    supabase,
                    profile,
                    "hk_task_assigned",
                    `Assigned room ${assignTarget.roomNumber}`,
                    {
                      task_id: assignTarget.taskId,
                      room_number: assignTarget.roomNumber,
                      assigned_to: housekeeperId,
                      assignee: hk?.full_name ?? hk?.email,
                    },
                    task?.confirmation_number,
                  );
                }
              }
              setAssignTarget(null);
            });
          }}
        />
      ) : null}

      {inspectTarget ? (
        <InspectModal
          roomNumber={inspectTarget.roomNumber}
          selfVerified={inspectTarget.selfVerified}
          busy={inspectMutation.isPending}
          onClose={() => setInspectTarget(null)}
          onResult={(result, input) => {
            void runAction(async () => {
              const notes = input.notes.trim() || null;
              const task = await inspectMutation.mutateAsync({
                taskId: inspectTarget.taskId,
                result,
                notes,
                rating: input.rating,
                problemCount: input.problemCount,
              });
              if (result === "failed") {
                await feedbackMutation.mutateAsync({
                  roomNumber: inspectTarget.roomNumber,
                  feedbackType: "complaint",
                  description: notes || "Failed inspection",
                  housekeeperId: inspectTarget.assignedTo,
                  taskId: inspectTarget.taskId,
                });
              }
              if (profile) {
                await auditHousekeeping(
                  supabase,
                  profile,
                  "hk_inspection_recorded",
                  `Inspection ${result} — room ${inspectTarget.roomNumber}`,
                  {
                    task_id: inspectTarget.taskId,
                    room_number: inspectTarget.roomNumber,
                    result,
                    notes,
                    rating: input.rating,
                    problem_count: input.problemCount,
                  },
                  task?.confirmation_number,
                );
              }
              setInspectTarget(null);
            });
          }}
        />
      ) : null}

      {feedbackTarget ? (
        <FeedbackModal
          roomNumber={feedbackTarget.roomNumber}
          housekeeperId={feedbackTarget.housekeeperId}
          taskId={feedbackTarget.taskId}
          busy={feedbackMutation.isPending}
          onClose={() => setFeedbackTarget(null)}
          onSubmit={(description, feedbackType) => {
            void runAction(async () => {
              await feedbackMutation.mutateAsync({
                roomNumber: feedbackTarget.roomNumber,
                feedbackType,
                description,
                housekeeperId: feedbackTarget.housekeeperId,
                taskId: feedbackTarget.taskId,
              });
              if (profile) {
                await auditHousekeeping(
                  supabase,
                  profile,
                  "hk_area_feedback",
                  `${feedbackType} logged for room ${feedbackTarget.roomNumber}`,
                  {
                    room_number: feedbackTarget.roomNumber,
                    feedback_type: feedbackType,
                    task_id: feedbackTarget.taskId,
                  },
                );
              }
              setFeedbackTarget(null);
            });
          }}
        />
      ) : null}
    </div>
  );
}

function StatPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "amber" | "sky" | "emerald" | "violet" | "red";
}) {
  const toneClass =
    tone === "amber"
      ? "border-amber-300/80 bg-amber-50/80 text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/25 dark:text-amber-100"
      : tone === "sky"
        ? "border-sky-300/80 bg-sky-50/80 text-sky-950 dark:border-sky-900/40 dark:bg-sky-950/25 dark:text-sky-100"
        : tone === "emerald"
          ? "border-emerald-300/80 bg-emerald-50/80 text-emerald-950 dark:border-emerald-900/40 dark:bg-emerald-950/25 dark:text-emerald-100"
          : tone === "violet"
            ? "border-violet-300/80 bg-violet-50/80 text-violet-950 dark:border-violet-900/40 dark:bg-violet-950/25 dark:text-violet-100"
            : tone === "red"
              ? "border-red-300/80 bg-red-50/80 text-red-950 dark:border-red-900/40 dark:bg-red-950/25 dark:text-red-100"
              : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] ${toneClass}`}
    >
      {label}
      <span className="font-semibold tabular-nums">{value}</span>
    </span>
  );
}

function BoardRow({
  row,
  assignee,
  proposedAssignee,
  awaitingAcceptance,
  pmsOoo,
  pmsRow,
  roomAlerts,
  busy,
  canInspect,
  onAssign,
  onInspect,
  onFeedback,
  onMarkAvailable,
  onMarkDirty,
  onApprove,
  onSetOoo,
  onClearOoo,
}: {
  row: HousekeepingBoardRow;
  assignee?: { full_name: string | null; email: string | null };
  proposedAssignee?: { full_name: string | null; email: string | null };
  awaitingAcceptance: boolean;
  pmsOoo: boolean;
  pmsRow?: PmsBoardRow;
  roomAlerts: HkAlert[];
  busy: boolean;
  canInspect: boolean;
  onAssign: () => void;
  onInspect: () => void;
  onFeedback: () => void;
  onMarkAvailable: () => void;
  onMarkDirty: () => void;
  onApprove: () => void;
  onSetOoo: () => void;
  onClearOoo: () => void;
}) {
  const openTask = row.task_id ?? row.current_task_id;
  const assignGate = canAssignHousekeepingByPms(pmsRow, {
    task_type: row.task_type ?? "checkout_turnover",
    status: row.task_status ?? "pending",
  });
  const canAssign =
    !!openTask &&
    (row.task_status === "pending" || row.task_status === "assigned") &&
    assignGate.allowed;
  const assignBlockedReason = assignGate.allowed ? null : assignGate.reason;
  const canRelease = row.room_status === "clean_ready";
  const showInspect = canInspect && row.task_status === "inspection_pending" && !!openTask;
  const overdue = isTaskOverdue(row.due_at) && row.task_status && row.task_status !== "completed";
  const showSetOoo = row.room_status !== "out_of_order" && row.room_status !== "occupied";
  const showClearOoo = row.room_status === "out_of_order" && !pmsOoo;

  return (
    <tr
      className={[
        "border-b border-[var(--border)]/60 transition-colors last:border-0",
        hkRowTint(row.room_status),
        "hover:bg-[var(--surface-2)]",
      ].join(" ")}
    >
      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[12.5px] font-semibold text-[var(--text-h)]">
        {row.room_number}
        {row.is_vip ? (
          <span className="ml-1.5 inline-flex rounded-md border border-violet-400 bg-violet-100 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-violet-950 dark:border-violet-400/55 dark:bg-violet-500/15 dark:text-violet-100">
            VIP
          </span>
        ) : null}
        {row.maintenance_blocked ? (
          <span
            className="ml-1.5 inline-flex rounded-md border border-amber-400 bg-amber-100 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-amber-900 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-200"
            title={row.maintenance_reason ?? "Maintenance block"}
          >
            Maint
          </span>
        ) : null}
        {roomAlerts.length > 0 ? (
          <span
            className="ml-1.5 inline-flex rounded-md border border-red-400 bg-red-100 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-red-950 dark:border-red-500/50 dark:bg-red-500/15 dark:text-red-100"
            title={roomAlerts.map((a) => `${a.duty}: ${a.description}`).join(" · ")}
          >
            Alert{roomAlerts.length > 1 ? ` (${roomAlerts.length})` : ""}
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2.5 text-[12.5px] font-medium tabular-nums text-[var(--text-h)]">
        {row.floor}
      </td>
      <td className="px-3 py-2.5">
        <span className={statusBadgeClass(row.room_status)}>
          {ROOM_STATUS_LABELS[row.room_status] ?? row.room_status}
        </span>
      </td>
      <td className="px-3 py-2.5">
        {row.task_status ? (
          <div className="flex flex-col items-start gap-1">
            <span className={taskStatusBadgeClass(row.task_status, Boolean(overdue))}>
              {TASK_STATUS_LABELS[row.task_status] ?? row.task_status}
            </span>
            {awaitingAcceptance ? (
              <span className={`${BADGE_BASE} border-amber-400/80 bg-amber-100 text-amber-950 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-100`}>
                Awaiting acceptance
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-[12.5px] text-[var(--text-muted)]">—</span>
        )}
      </td>
      <td className="max-w-[10rem] truncate px-3 py-2.5 text-[12.5px] font-medium text-[var(--text)]">
        {assignee ? (
          staffLabel(assignee)
        ) : proposedAssignee ? (
          <span title="Proposed assignee">{staffLabel(proposedAssignee)} (proposed)</span>
        ) : (
          <span className="text-[var(--text-muted)]">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-[12.5px] font-medium tabular-nums text-[var(--text-h)]">
        <span className={overdue ? "!font-semibold text-red-600 dark:text-red-300" : undefined}>
          {formatDue(row.due_at)}
        </span>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex flex-wrap justify-end gap-1.5">
          {awaitingAcceptance && row.task_status === "pending" ? (
            <button
              type="button"
              className={hkActionBtn("assign")}
              disabled={busy}
              onClick={onApprove}
            >
              Approve
            </button>
          ) : null}
          {canAssign ? (
            <button
              type="button"
              className={hkActionBtn("assign")}
              disabled={busy}
              onClick={onAssign}
            >
              Assign
            </button>
          ) : openTask &&
            (row.task_status === "pending" || row.task_status === "assigned") &&
            assignBlockedReason ? (
            <span
              className="max-w-[9rem] text-[10px] leading-tight text-violet-700 dark:text-violet-300"
              title={assignBlockedReason}
            >
              Guest in room
            </span>
          ) : null}
          {showInspect ? (
            <button
              type="button"
              className={hkActionBtn("inspect")}
              disabled={busy}
              onClick={onInspect}
            >
              Inspect
            </button>
          ) : null}
          {canInspect ? (
            <button
              type="button"
              className={hkActionBtn("neutral")}
              disabled={busy}
              onClick={onFeedback}
              title="Log guest complaint or compliment"
            >
              <FileText className="h-3.5 w-3.5" aria-hidden />
              Feedback
            </button>
          ) : null}
          {canRelease ? (
            <button
              type="button"
              className={hkActionBtn("available")}
              disabled={busy}
              onClick={onMarkAvailable}
            >
              Available
            </button>
          ) : null}
          <button
            type="button"
            className={hkActionBtn("dirty")}
            disabled={busy}
            onClick={onMarkDirty}
            title="Create or refresh turnover task"
          >
            Mark dirty
          </button>
          {showSetOoo ? (
            <button
              type="button"
              className={hkActionBtn("neutral")}
              disabled={busy}
              onClick={onSetOoo}
            >
              Set OOO
            </button>
          ) : null}
          {showClearOoo ? (
            <button
              type="button"
              className={hkActionBtn("neutral")}
              disabled={busy}
              onClick={onClearOoo}
              title="Clear Nexus OOO when PMS is not OOO"
            >
              Clear OOO
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
