import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  assignHousekeepingTask,
  fetchHousekeepingBoard,
  HOUSEKEEPING_BOARD_KEY,
} from "@/lib/housekeeping";
import {
  fetchDailySchedules,
  hkScheduleKey,
  upsertDailySchedule,
} from "@/lib/housekeepingSchedule";
import { HK_RA_MONITOR_KEY } from "@/lib/hkRaMonitor";
import { parseHotelRoomList, sortRoomNumbers } from "@/lib/roomInventory";
import { supabase } from "@/lib/supabase";
import type { HousekeepingStaff, HousekeepingTask, HkTaskStatus } from "@/types/housekeeping";

export const HK_OPEN_TASKS_KEY = ["hk-open-tasks"] as const;

const OPEN_STATUSES: HkTaskStatus[] = [
  "pending",
  "assigned",
  "in_progress",
  "inspection_pending",
];

export type DutyRow = {
  housekeeperId: string;
  roomText: string;
  rooms: string[];
};

export type DutySaveResult = {
  schedulesSaved: number;
  assigned: number;
  skipped: number;
  blocked: number;
  errors: number;
  details: Array<{ room: string; housekeeperId: string; action: string; reason?: string }>;
};

export type BulkTaskRow = {
  taskId: string;
  roomNumber: string;
  taskType: HousekeepingTask["task_type"];
  status: HkTaskStatus;
  priority: number;
  assignedTo: string | null;
  dueAt: string | null;
};

export type BulkTaskPatch = {
  taskId: string;
  status?: HkTaskStatus;
  priority?: number;
  assignedTo?: string | null;
  dueAt?: string | null;
};

export type BulkSaveResult = {
  updated: number;
  skipped: number;
  errors: number;
  details: Array<{ taskId: string; room: string; action: string; reason?: string }>;
};

export async function fetchOpenHousekeepingTasks(): Promise<HousekeepingTask[]> {
  const { data, error } = await supabase
    .from("housekeeping_tasks")
    .select("*")
    .in("status", OPEN_STATUSES)
    .order("room_number", { ascending: true });

  if (error) throw new Error(error.message);
  const rows = (data ?? []) as HousekeepingTask[];
  const order = new Map(sortRoomNumbers(rows.map((r) => r.room_number)).map((n, i) => [n, i]));
  return [...rows].sort(
    (a, b) => (order.get(a.room_number) ?? 0) - (order.get(b.room_number) ?? 0),
  );
}

export function useOpenHousekeepingTasks() {
  return useQuery({
    queryKey: HK_OPEN_TASKS_KEY,
    queryFn: fetchOpenHousekeepingTasks,
    staleTime: 10_000,
  });
}

export function taskToBulkRow(task: HousekeepingTask): BulkTaskRow {
  return {
    taskId: task.id,
    roomNumber: task.room_number,
    taskType: task.task_type,
    status: task.status,
    priority: task.priority,
    assignedTo: task.assigned_to,
    dueAt: task.due_at,
  };
}

function roomsToText(rooms: string[]): string {
  return sortRoomNumbers([...new Set(rooms.map((r) => r.trim()).filter(Boolean))]).join(", ");
}

export function buildDutyRows(
  housekeepers: HousekeepingStaff[],
  schedules: Array<{ housekeeper_id: string; assigned_rooms: string[] }>,
  tasks: HousekeepingTask[],
): DutyRow[] {
  const scheduleByHk = new Map(schedules.map((s) => [s.housekeeper_id, s.assigned_rooms ?? []]));
  const tasksByHk = new Map<string, string[]>();

  for (const task of tasks) {
    if (!task.assigned_to) continue;
    const list = tasksByHk.get(task.assigned_to) ?? [];
    list.push(task.room_number);
    tasksByHk.set(task.assigned_to, list);
  }

  return housekeepers
    .filter((h) => h.role === "housekeeper")
    .map((hk) => {
      const fromSchedule = scheduleByHk.get(hk.id) ?? [];
      const fromTasks = tasksByHk.get(hk.id) ?? [];
      const rooms = sortRoomNumbers([...new Set([...fromSchedule, ...fromTasks])]);
      return {
        housekeeperId: hk.id,
        roomText: roomsToText(rooms),
        rooms,
      };
    });
}

export async function loadDutyRowsForDate(
  scheduleDate: string,
  housekeepers: HousekeepingStaff[],
): Promise<DutyRow[]> {
  const [schedules, tasks] = await Promise.all([
    fetchDailySchedules(scheduleDate),
    fetchOpenHousekeepingTasks(),
  ]);
  return buildDutyRows(housekeepers, schedules, tasks);
}

export async function saveDutyAssignments(
  scheduleDate: string,
  rows: DutyRow[],
  createdBy: string | null,
): Promise<DutySaveResult> {
  const board = await fetchHousekeepingBoard();
  const knownRooms = new Set(board.map((r) => r.room_number.trim()));
  const tasks = await fetchOpenHousekeepingTasks();
  const taskByRoom = new Map(tasks.map((t) => [t.room_number.trim(), t]));

  const result: DutySaveResult = {
    schedulesSaved: 0,
    assigned: 0,
    skipped: 0,
    blocked: 0,
    errors: 0,
    details: [],
  };

  const roomOwner = new Map<string, string>();
  for (const row of rows) {
    const rooms = sortRoomNumbers(
      parseHotelRoomList(row.roomText).filter((r) => knownRooms.has(r)),
    );
    for (const room of rooms) {
      roomOwner.set(room, row.housekeeperId);
    }

    try {
      await upsertDailySchedule(
        scheduleDate,
        row.housekeeperId,
        rooms,
        null,
        createdBy,
      );
      result.schedulesSaved += 1;
    } catch (e) {
      result.errors += 1;
      result.details.push({
        room: "—",
        housekeeperId: row.housekeeperId,
        action: "error",
        reason: e instanceof Error ? e.message : "Schedule save failed",
      });
    }
  }

  for (const [room, housekeeperId] of roomOwner) {
    const task = taskByRoom.get(room);
    if (!task) {
      result.skipped += 1;
      result.details.push({
        room,
        housekeeperId,
        action: "skipped",
        reason: "No open task for room",
      });
      continue;
    }

    if (task.assigned_to === housekeeperId) {
      result.skipped += 1;
      continue;
    }

    if (task.status === "in_progress" || task.status === "inspection_pending") {
      result.skipped += 1;
      result.details.push({
        room,
        housekeeperId,
        action: "skipped",
        reason: "Task in progress — edit individually",
      });
      continue;
    }

    const { error } = await assignHousekeepingTask(task.id, housekeeperId, "Duty list batch save");
    if (error) {
      if (/guest still in room|DualPMS|blocked/i.test(error.message)) {
        result.blocked += 1;
        result.details.push({ room, housekeeperId, action: "blocked", reason: error.message });
      } else {
        result.errors += 1;
        result.details.push({ room, housekeeperId, action: "error", reason: error.message });
      }
      continue;
    }

    result.assigned += 1;
    result.details.push({ room, housekeeperId, action: "assigned" });
  }

  return result;
}

async function tryRpcPatchTask(patch: BulkTaskPatch): Promise<boolean> {
  const { error } = await supabase.rpc("hk_patch_task", {
    p_task_id: patch.taskId,
    p_status: patch.status ?? null,
    p_priority: patch.priority ?? null,
    p_assigned_to: patch.assignedTo ?? null,
    p_due_at: patch.dueAt ?? null,
  });
  if (error) {
    if (/function.*does not exist|hk_patch_task/i.test(error.message)) return false;
    throw new Error(error.message);
  }
  return true;
}

async function patchTaskClientSide(
  original: BulkTaskRow,
  patch: BulkTaskPatch,
): Promise<void> {
  const assigneeChanged =
    patch.assignedTo !== undefined && patch.assignedTo !== original.assignedTo;
  const statusChanged = patch.status !== undefined && patch.status !== original.status;

  if (assigneeChanged && patch.assignedTo) {
    const { error } = await assignHousekeepingTask(
      patch.taskId,
      patch.assignedTo,
      "Bulk edit assign",
    );
    if (error) throw error;
  }

  const updates: Record<string, unknown> = {};
  if (patch.priority !== undefined) updates.priority = patch.priority;
  if (patch.dueAt !== undefined) updates.due_at = patch.dueAt;
  if (statusChanged) updates.status = patch.status;
  if (assigneeChanged && !patch.assignedTo) {
    updates.assigned_to = null;
    updates.assigned_at = null;
    if (!patch.status) updates.status = "pending";
  }

  if (Object.keys(updates).length === 0) return;

  const { error } = await supabase
    .from("housekeeping_tasks")
    .update(updates)
    .eq("id", patch.taskId);

  if (error) throw new Error(error.message);
}

export async function saveBulkTaskEdits(
  originals: Map<string, BulkTaskRow>,
  patches: BulkTaskPatch[],
): Promise<BulkSaveResult> {
  const result: BulkSaveResult = { updated: 0, skipped: 0, errors: 0, details: [] };

  for (const patch of patches) {
    const original = originals.get(patch.taskId);
    if (!original) continue;

    const hasChange =
      (patch.status !== undefined && patch.status !== original.status) ||
      (patch.priority !== undefined && patch.priority !== original.priority) ||
      (patch.assignedTo !== undefined && patch.assignedTo !== original.assignedTo) ||
      (patch.dueAt !== undefined && patch.dueAt !== original.dueAt);

    if (!hasChange) {
      result.skipped += 1;
      continue;
    }

    if (
      (patch.status === "assigned" || patch.status === "in_progress") &&
      (patch.assignedTo ?? original.assignedTo) == null
    ) {
      result.errors += 1;
      result.details.push({
        taskId: patch.taskId,
        room: original.roomNumber,
        action: "error",
        reason: "Assignee required for this status",
      });
      continue;
    }

    try {
      const rpcOk = await tryRpcPatchTask(patch);
      if (!rpcOk) await patchTaskClientSide(original, patch);
      result.updated += 1;
      result.details.push({ taskId: patch.taskId, room: original.roomNumber, action: "updated" });
    } catch (e) {
      result.errors += 1;
      result.details.push({
        taskId: patch.taskId,
        room: original.roomNumber,
        action: "error",
        reason: e instanceof Error ? e.message : "Update failed",
      });
    }
  }

  return result;
}

export function useSaveDutyAssignments(scheduleDate: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      rows,
      createdBy,
    }: {
      rows: DutyRow[];
      createdBy: string | null;
    }) => saveDutyAssignments(scheduleDate, rows, createdBy),
    onSuccess: async () => {
      await Promise.all([
        qc.refetchQueries({ queryKey: hkScheduleKey(scheduleDate) }),
        qc.refetchQueries({ queryKey: HK_OPEN_TASKS_KEY }),
        qc.refetchQueries({ queryKey: HOUSEKEEPING_BOARD_KEY }),
        qc.refetchQueries({ queryKey: HK_RA_MONITOR_KEY }),
        qc.refetchQueries({ queryKey: ["housekeeping-tasks"] }),
      ]);
    },
  });
}

export function useSaveBulkTaskEdits() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      originals,
      patches,
    }: {
      originals: Map<string, BulkTaskRow>;
      patches: BulkTaskPatch[];
    }) => saveBulkTaskEdits(originals, patches),
    onSuccess: async () => {
      await Promise.all([
        qc.refetchQueries({ queryKey: HK_OPEN_TASKS_KEY }),
        qc.refetchQueries({ queryKey: HOUSEKEEPING_BOARD_KEY }),
        qc.refetchQueries({ queryKey: HK_RA_MONITOR_KEY }),
        qc.refetchQueries({ queryKey: ["housekeeping-tasks"] }),
      ]);
    },
  });
}

export const HK_PRIORITY_OPTIONS = [
  { value: 80, label: "High" },
  { value: 55, label: "Medium" },
  { value: 30, label: "Low" },
] as const;

export const HK_BULK_STATUS_OPTIONS: HkTaskStatus[] = [
  "pending",
  "assigned",
  "in_progress",
  "inspection_pending",
];

/** `datetime-local` value → ISO (local interpretation). */
export function dueAtToIso(localValue: string): string | null {
  if (!localValue.trim()) return null;
  const d = new Date(localValue);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}

export function isoToDueAtLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}
