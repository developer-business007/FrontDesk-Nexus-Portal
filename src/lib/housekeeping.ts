import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { sortRoomNumbers } from "@/lib/roomInventory";
import { syncHousekeepingStatus } from "@/lib/housekeepingStatusSync";
import {
  canAssignHousekeepingByPms,
  filterAssignableHousekeepers,
} from "@/lib/housekeepingPmsRules";
import { HK_INSPECTION_LOG_KEY } from "@/lib/hkInspectionLog";
import { HK_TASK_SEARCH_KEY } from "@/lib/hkTaskSearch";
import {
  markSupervisorVerified,
  type HkInspectionRating,
} from "@/lib/hkTaskVerify";
import { fetchPmsBoardRows } from "@/lib/pmsBoard";
import { supabase } from "@/lib/supabase";
import type {
  HkInspectionResult,
  HousekeepingBoardRow,
  HousekeepingStaff,
  HousekeepingTask,
  HousekeepingTaskEvent,
  RoomLifecycleStatus,
  RoomOperationalStatus,
} from "@/types/housekeeping";
import { PMS_BOARD_QUERY_KEY } from "@/types/pmsBoard";

export const HOUSEKEEPING_BOARD_KEY = ["housekeeping-board"] as const;
export const HOUSEKEEPING_STAFF_KEY = ["housekeeping-staff"] as const;

export function housekeepingMyTasksKey(userId: string | undefined) {
  return ["housekeeping-tasks", "mine", userId ?? ""] as const;
}

export function housekeepingEventsKey(taskId: string | undefined) {
  return ["housekeeping-task-events", taskId ?? ""] as const;
}

const OPEN_TASK_STATUSES = [
  "pending",
  "assigned",
  "in_progress",
  "inspection_pending",
] as const;

function rpcError(error: { message: string } | null): Error | null {
  return error ? new Error(error.message) : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchHousekeepingBoard(): Promise<HousekeepingBoardRow[]> {
  const { data, error } = await supabase
    .from("v_housekeeping_board")
    .select("*")
    .order("floor", { ascending: true })
    .order("room_number", { ascending: true });

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as HousekeepingBoardRow[];
  const order = new Map(sortRoomNumbers(rows.map((r) => r.room_number)).map((n, i) => [n, i]));
  return [...rows].sort(
    (a, b) => (order.get(a.room_number) ?? 0) - (order.get(b.room_number) ?? 0),
  );
}

export async function fetchHousekeepingStaff(): Promise<HousekeepingStaff[]> {
  const { data: rpcData, error: rpcError } = await supabase.rpc("hk_list_assignable_staff");
  if (!rpcError && rpcData) {
    return (rpcData ?? []) as HousekeepingStaff[];
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name, role")
    .eq("is_active", true)
    .in("role", ["housekeeper", "supervisor"])
    .order("full_name", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as HousekeepingStaff[];
}

export async function fetchMyHousekeepingTasks(
  userId: string,
): Promise<HousekeepingTask[]> {
  const { data, error } = await supabase
    .from("housekeeping_tasks")
    .select("*")
    .eq("assigned_to", userId)
    .in("status", [...OPEN_TASK_STATUSES])
    .order("due_at", { ascending: true, nullsFirst: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as HousekeepingTask[];
}

export async function fetchPendingHousekeepingTasks(): Promise<HousekeepingTask[]> {
  const { data, error } = await supabase
    .from("housekeeping_tasks")
    .select("*")
    .eq("status", "pending")
    .order("priority", { ascending: false })
    .order("due_at", { ascending: true, nullsFirst: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as HousekeepingTask[];
}

export async function fetchHousekeepingTaskEvents(
  taskId: string,
): Promise<HousekeepingTaskEvent[]> {
  const { data, error } = await supabase
    .from("housekeeping_task_events")
    .select("*")
    .eq("task_id", taskId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as HousekeepingTaskEvent[];
}

// ---------------------------------------------------------------------------
// RPCs (Step 1 workflow)
// ---------------------------------------------------------------------------

export async function assignHousekeepingTask(
  taskId: string,
  assignedTo: string,
  notes?: string | null,
): Promise<{ data: HousekeepingTask | null; error: Error | null }> {
  const { data: taskRow, error: readError } = await supabase
    .from("housekeeping_tasks")
    .select("id, room_number, task_type, status")
    .eq("id", taskId)
    .maybeSingle();

  if (readError) return { data: null, error: rpcError(readError) };
  if (!taskRow) return { data: null, error: new Error("Task not found") };

  const pmsRows = await fetchPmsBoardRows();
  const pmsRow = pmsRows.find((r) => String(r.room_number).trim() === String(taskRow.room_number).trim());
  const gate = canAssignHousekeepingByPms(pmsRow, taskRow as HousekeepingTask);
  if (!gate.allowed) {
    return { data: null, error: new Error(gate.reason ?? "Assignment blocked by DualPMS") };
  }

  const { data, error } = await supabase.rpc("hk_assign_task", {
    p_task_id: taskId,
    p_assigned_to: assignedTo,
    p_notes: notes ?? null,
  });
  return { data: (data as HousekeepingTask | null) ?? null, error: rpcError(error) };
}

export { filterAssignableHousekeepers };

export async function startHousekeepingTask(
  taskId: string,
): Promise<{ data: HousekeepingTask | null; error: Error | null }> {
  const { data: taskRow, error: readError } = await supabase
    .from("housekeeping_tasks")
    .select("id, room_number, task_type, status")
    .eq("id", taskId)
    .maybeSingle();

  if (readError) return { data: null, error: rpcError(readError) };
  if (!taskRow) return { data: null, error: new Error("Task not found") };

  const pmsRows = await fetchPmsBoardRows();
  const pmsRow = pmsRows.find((r) => String(r.room_number).trim() === String(taskRow.room_number).trim());
  const gate = canAssignHousekeepingByPms(pmsRow, taskRow as HousekeepingTask);
  if (!gate.allowed) {
    return { data: null, error: new Error(gate.reason ?? "Cannot start — guest still in room per DualPMS") };
  }

  const { data, error } = await supabase.rpc("hk_start_task", { p_task_id: taskId });
  return { data: (data as HousekeepingTask | null) ?? null, error: rpcError(error) };
}

export async function completeHousekeepingTask(
  taskId: string,
  notes?: string | null,
): Promise<{ data: HousekeepingTask | null; error: Error | null }> {
  const { data, error } = await supabase.rpc("hk_complete_task", {
    p_task_id: taskId,
    p_notes: notes ?? null,
  });
  return { data: (data as HousekeepingTask | null) ?? null, error: rpcError(error) };
}

export async function recordHousekeepingInspection(
  taskId: string,
  result: HkInspectionResult,
  notes?: string | null,
): Promise<{ data: HousekeepingTask | null; error: Error | null; pmsWarning: string | null }> {
  const { data, error } = await supabase.rpc("hk_record_inspection", {
    p_task_id: taskId,
    p_result: result,
    p_notes: notes ?? null,
  });
  const task = (data as HousekeepingTask | null) ?? null;
  if (error) {
    return { data: task, error: rpcError(error), pmsWarning: null };
  }

  if (result === "failed" && task?.room_number) {
    const pms = await syncHousekeepingStatus({
      roomNumbers: [task.room_number],
      status: "dirty",
      syncNexus: false,
      syncPms: true,
      notes: notes?.trim() || "Failed inspection",
    });
    if (!pms.ok) {
      return {
        data: task,
        error: null,
        pmsWarning: pms.error ?? "Housekeeping updated but PMS sync failed",
      };
    }
    if (pms.warnings.length) {
      return {
        data: task,
        error: null,
        pmsWarning: pms.warnings.join("; "),
      };
    }
  }

  return { data: task, error: null, pmsWarning: null };
}

export async function markRoomAvailable(
  roomNumber: string,
  reason?: string | null,
): Promise<{ data: RoomOperationalStatus | null; error: Error | null }> {
  const synced = await syncHousekeepingStatus({
    roomNumbers: [roomNumber],
    status: "clean",
    notes: reason ?? null,
    syncPms: true,
    syncNexus: true,
  });
  if (!synced.ok) {
    return { data: null, error: new Error(synced.error ?? "Failed to mark room available") };
  }
  return {
    data: synced.nexusRoomStatuses[0] ?? null,
    error: null,
  };
}

export async function markRoomDirty(
  roomNumber: string,
  notes?: string | null,
): Promise<{ data: HousekeepingTask | null; error: Error | null }> {
  const synced = await syncHousekeepingStatus({
    roomNumbers: [roomNumber],
    status: "dirty",
    notes: notes ?? null,
    syncPms: true,
    syncNexus: true,
  });
  if (!synced.ok) {
    return { data: null, error: new Error(synced.error ?? "Failed to mark room dirty") };
  }
  return {
    data: synced.nexusTasks[0] ?? null,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

export function useHousekeepingBoard() {
  return useQuery({
    queryKey: HOUSEKEEPING_BOARD_KEY,
    queryFn: fetchHousekeepingBoard,
    staleTime: 15_000,
  });
}

export function useHousekeepingStaff() {
  return useQuery({
    queryKey: HOUSEKEEPING_STAFF_KEY,
    queryFn: fetchHousekeepingStaff,
    staleTime: 60_000,
  });
}

export function useMyHousekeepingTasks(userId: string | undefined) {
  return useQuery({
    queryKey: housekeepingMyTasksKey(userId),
    queryFn: () => fetchMyHousekeepingTasks(userId!),
    enabled: !!userId,
    staleTime: 10_000,
  });
}

export function usePendingHousekeepingTasks(enabled = true) {
  return useQuery({
    queryKey: ["housekeeping-tasks", "pending"] as const,
    queryFn: fetchPendingHousekeepingTasks,
    enabled,
    staleTime: 10_000,
  });
}

export function useHousekeepingTaskEvents(taskId: string | undefined) {
  return useQuery({
    queryKey: housekeepingEventsKey(taskId),
    queryFn: () => fetchHousekeepingTaskEvents(taskId!),
    enabled: !!taskId,
  });
}

/** Immediately patch board cache so UI updates before the next network round-trip. */
export function patchHousekeepingBoardCache(
  qc: QueryClient,
  roomNumber: string,
  patch: Partial<HousekeepingBoardRow>,
) {
  qc.setQueryData<HousekeepingBoardRow[]>(HOUSEKEEPING_BOARD_KEY, (rows) => {
    if (!rows) return rows;
    return rows.map((row) =>
      row.room_number === roomNumber ? { ...row, ...patch } : row,
    );
  });
}

export function patchHousekeepingBoardFromTask(
  qc: QueryClient,
  task: HousekeepingTask,
  roomStatus?: RoomLifecycleStatus,
) {
  patchHousekeepingBoardCache(qc, task.room_number, {
    ...(roomStatus ? { room_status: roomStatus } : {}),
    task_id: task.id,
    current_task_id: task.id,
    task_status: task.status,
    task_type: task.task_type,
    task_priority: task.priority,
    assigned_to: task.assigned_to,
    assigned_at: task.assigned_at,
    started_at: task.started_at,
    due_at: task.due_at,
    requires_inspection: task.requires_inspection,
  });
}

export function patchMyTasksCache(
  qc: QueryClient,
  userId: string,
  task: HousekeepingTask,
) {
  qc.setQueryData<HousekeepingTask[]>(housekeepingMyTasksKey(userId), (tasks) => {
    if (!tasks) return tasks;
    const idx = tasks.findIndex((t) => t.id === task.id);
    if (idx === -1) return [...tasks, task];
    return tasks.map((t) => (t.id === task.id ? { ...t, ...task } : t));
  });
}

export function useInvalidateHousekeeping() {
  const qc = useQueryClient();
  return useCallback(
    async (userId?: string) => {
      await Promise.all([
        qc.refetchQueries({ queryKey: HOUSEKEEPING_BOARD_KEY }),
        qc.refetchQueries({ queryKey: ["room-operational-status-map"] }),
        qc.refetchQueries({ queryKey: PMS_BOARD_QUERY_KEY }),
        qc.refetchQueries({ queryKey: ["housekeeping-tasks", "pending"] }),
        qc.refetchQueries({ queryKey: ["housekeeping-tasks", "metadata"] }),
        qc.refetchQueries({ queryKey: ["housekeeping-ra-monitor"] }),
        userId
          ? qc.refetchQueries({ queryKey: housekeepingMyTasksKey(userId) })
          : Promise.resolve(),
      ]);
    },
    [qc],
  );
}

/** Realtime refresh for board + task lists (Step 3 pages should mount this once). */
export function useHousekeepingRealtime(userId?: string) {
  const refresh = useInvalidateHousekeeping();
  const [channelName] = useState(
    () => `housekeeping-rt-${Math.random().toString(36).slice(2, 10)}`,
  );

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void refresh(userId);
      }, 400);
    };

    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "housekeeping_tasks" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_operational_status" },
        scheduleRefresh,
      )
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      void supabase.removeChannel(channel);
    };
  }, [channelName, refresh, userId]);
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

type TaskMutationVars = { taskId: string; notes?: string | null };
type AssignVars = { taskId: string; assignedTo: string; notes?: string | null };
export type InspectVars = {
  taskId: string;
  result: HkInspectionResult;
  notes?: string | null;
  rating?: HkInspectionRating | null;
  problemCount?: number | null;
};
type RoomVars = { roomNumber: string; notes?: string | null; reason?: string | null };

function useHkMutation<TVars, TResult>(
  mutationFn: (vars: TVars) => Promise<{ data: TResult | null; error: Error | null }>,
  userId?: string,
  onCachePatch?: (qc: QueryClient, result: TResult, vars: TVars) => void,
): UseMutationResult<TResult | null, Error, TVars> {
  const qc = useQueryClient();
  const refresh = useInvalidateHousekeeping();
  return useMutation({
    mutationFn: async (vars: TVars) => {
      const { data, error } = await mutationFn(vars);
      if (error) throw error;
      return data;
    },
    onSuccess: async (data, vars) => {
      if (data && onCachePatch) {
        onCachePatch(qc, data, vars);
      }
      await refresh(userId);
    },
  });
}

export function useAssignHousekeepingTask(userId?: string) {
  return useHkMutation<AssignVars, HousekeepingTask>(
    (v) => assignHousekeepingTask(v.taskId, v.assignedTo, v.notes),
    userId,
    (qc, task) => patchHousekeepingBoardFromTask(qc, task),
  );
}

export function useStartHousekeepingTask(userId?: string) {
  return useHkMutation<TaskMutationVars, HousekeepingTask>(
    (v) => startHousekeepingTask(v.taskId),
    userId,
    (qc, task) => {
      patchHousekeepingBoardFromTask(qc, task, "in_service");
      if (userId) patchMyTasksCache(qc, userId, task);
    },
  );
}

export function useCompleteHousekeepingTask(userId?: string) {
  return useHkMutation<TaskMutationVars, HousekeepingTask>(
    (v) => completeHousekeepingTask(v.taskId, v.notes),
    userId,
    (qc, task) => {
      patchHousekeepingBoardFromTask(qc, task, "in_service");
      if (userId) patchMyTasksCache(qc, userId, task);
    },
  );
}

export function useRecordHousekeepingInspection(userId?: string) {
  const qc = useQueryClient();
  const refresh = useInvalidateHousekeeping();
  return useMutation({
    mutationFn: async (vars: InspectVars) => {
      const { data, error, pmsWarning } = await recordHousekeepingInspection(
        vars.taskId,
        vars.result,
        vars.notes,
      );
      if (error) throw error;
      if (data && userId) {
        await markSupervisorVerified(vars.taskId, userId, {
          rating: vars.rating,
          problemCount: vars.problemCount,
          notes: vars.notes,
          result: vars.result,
        });
      }
      if (pmsWarning) {
        throw new Error(`Inspection saved. ${pmsWarning}`);
      }
      return data;
    },
    onSuccess: async (data, vars) => {
      if (data) {
        if (vars.result === "passed" || vars.result === "waived") {
          patchHousekeepingBoardFromTask(qc, data, "clean_ready");
        } else {
          patchHousekeepingBoardFromTask(qc, data, "dirty");
        }
      }
      void qc.invalidateQueries({ queryKey: HK_INSPECTION_LOG_KEY });
      void qc.invalidateQueries({ queryKey: HK_TASK_SEARCH_KEY });
      await refresh(userId);
    },
  });
}

export function useMarkRoomAvailable(userId?: string) {
  return useHkMutation<RoomVars, RoomOperationalStatus>(
    (v) => markRoomAvailable(v.roomNumber, v.reason ?? v.notes),
    userId,
    (qc, row) => {
      patchHousekeepingBoardCache(qc, row.room_number, {
        room_status: row.status,
        current_task_id: null,
        task_id: null,
        task_status: null,
        task_type: null,
        task_priority: null,
        assigned_to: null,
        assigned_at: null,
        started_at: null,
        due_at: null,
        requires_inspection: null,
        confirmation_number: null,
      });
    },
  );
}

export function useMarkRoomDirty(userId?: string) {
  return useHkMutation<RoomVars, HousekeepingTask>(
    (v) => markRoomDirty(v.roomNumber, v.notes),
    userId,
    (qc, task) => patchHousekeepingBoardFromTask(qc, task, "dirty"),
  );
}

/** Human-readable status labels for UI (Step 3). */
export const ROOM_STATUS_LABELS: Record<string, string> = {
  occupied: "Occupied",
  dirty: "Dirty",
  in_service: "In service",
  clean_ready: "Clean ready",
  available: "Available",
  out_of_order: "Out of order",
};

export const TASK_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  assigned: "Assigned",
  in_progress: "In progress",
  inspection_pending: "Awaiting inspection",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function isTaskOverdue(dueAt: string | null | undefined): boolean {
  if (!dueAt) return false;
  return new Date(dueAt).getTime() < Date.now();
}

/** Only `available` rooms may receive a new walk-in / encode on the Keys board. */
export function isRoomAvailableForNewCheckIn(
  status: RoomLifecycleStatus | null | undefined,
): boolean {
  return status === "available" || status == null;
}

export function roomStatusBlocksNewGuestMessage(
  status: RoomLifecycleStatus | null | undefined,
): string | null {
  if (status == null || status === "available") return null;
  const label = ROOM_STATUS_LABELS[status] ?? status;
  return `Room is ${label} on the housekeeping board — release or finish cleaning before check-in.`;
}

export async function fetchRoomOperationalStatusMap(): Promise<
  Map<string, RoomLifecycleStatus>
> {
  const { data, error } = await supabase
    .from("room_operational_status")
    .select("room_number, status");

  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) {
      return new Map();
    }
    throw new Error(error.message);
  }

  const map = new Map<string, RoomLifecycleStatus>();
  for (const row of data ?? []) {
    const rn = String(row.room_number ?? "").trim();
    if (rn) map.set(rn, row.status as RoomLifecycleStatus);
  }
  return map;
}

export function useRoomOperationalStatusMap() {
  const query = useQuery({
    queryKey: ["room-operational-status-map"] as const,
    queryFn: fetchRoomOperationalStatusMap,
    staleTime: 15_000,
  });

  const [channelName] = useState(
    () => `room-status-rt-${Math.random().toString(36).slice(2, 10)}`,
  );

  const qc = useQueryClient();
  useEffect(() => {
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_operational_status" },
        () => {
          void qc.invalidateQueries({ queryKey: ["room-operational-status-map"] });
          void qc.invalidateQueries({ queryKey: HOUSEKEEPING_BOARD_KEY });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [channelName, qc]);

  return query;
}
