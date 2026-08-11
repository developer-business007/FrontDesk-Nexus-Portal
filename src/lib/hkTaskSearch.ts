import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TASK_STATUS_LABELS } from "@/lib/housekeeping";
import { sortRoomNumbers } from "@/lib/roomInventory";
import { supabase } from "@/lib/supabase";
import { readTaskVerify } from "@/lib/hkTaskVerify";
import type { HkTaskStatus, HkTaskType, HousekeepingTask } from "@/types/housekeeping";

export const HK_TASK_SEARCH_KEY = ["hk-task-search"] as const;

export const HK_TASK_TYPE_OPTIONS: { value: HkTaskType; label: string }[] = [
  { value: "checkout_turnover", label: "Checkout turnover" },
  { value: "deep_clean", label: "Deep clean" },
  { value: "touch_up", label: "Touch up" },
  { value: "inspection_only", label: "Inspection only" },
];

export const HK_TASK_DUTY_OPTIONS = [
  "Due out",
  "Full clean",
  "Stayover",
  "Refresh",
  "Touch up",
  "Inspection",
  "Arrival",
  "Deep clean",
  "Recurring task",
] as const;

export const HK_EDIT_STATUS_OPTIONS: { value: HkTaskStatus; label: string }[] = [
  { value: "pending", label: "New" },
  { value: "assigned", label: "Assigned" },
  { value: "in_progress", label: "In progress" },
  { value: "inspection_pending", label: "Awaiting inspection" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

export type TaskVerifiedBy = "none" | "self" | "super";

export type TaskEditMeta = {
  duty: string;
  petRoom: boolean;
  occupied: boolean;
  createdByName: string | null;
  verifiedBy: TaskVerifiedBy;
};

export type TaskSearchRow = {
  task: HousekeepingTask;
  attendantName: string | null;
  selfVerified: boolean;
  supervisorVerified: boolean;
  dutyLabel: string;
  petRoom: boolean;
  occupied: boolean;
};

export type TaskEditInput = {
  taskId: string;
  roomNumber: string;
  taskType: HkTaskType;
  duty: string;
  priority: number;
  status: HkTaskStatus;
  assignedTo: string | null;
  dueAt: string | null;
  verifiedBy: TaskVerifiedBy;
  petRoom: boolean;
  occupied: boolean;
  createdByName: string;
  notes: string | null;
  /** Actor applying the edit (for verify timestamps / assign). */
  editorId: string;
};

function defaultDutyForType(taskType: HkTaskType): string {
  switch (taskType) {
    case "checkout_turnover":
      return "Due out";
    case "deep_clean":
      return "Full clean";
    case "touch_up":
      return "Refresh";
    case "inspection_only":
      return "Inspection";
    default:
      return "Full clean";
  }
}

export function readTaskEditMeta(
  task: Pick<HousekeepingTask, "task_type" | "metadata">,
): TaskEditMeta {
  const m = task.metadata ?? {};
  const verify = readTaskVerify(m);
  const duty =
    typeof m.duty === "string" && m.duty.trim()
      ? m.duty.trim()
      : defaultDutyForType(task.task_type);

  let verifiedBy: TaskVerifiedBy = "none";
  if (verify.supervisorVerifiedAt) verifiedBy = "super";
  else if (verify.selfVerifiedAt) verifiedBy = "self";

  return {
    duty,
    petRoom: m.pet_room === true,
    occupied: m.occupied === true,
    createdByName:
      typeof m.created_by_name === "string" && m.created_by_name.trim()
        ? m.created_by_name.trim()
        : null,
    verifiedBy,
  };
}

export type TaskSearchFilters = {
  room?: string;
  status?: HkTaskStatus | "all";
  assigneeId?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
};

export async function searchHousekeepingTasks(
  filters: TaskSearchFilters,
): Promise<TaskSearchRow[]> {
  let q = supabase
    .from("housekeeping_tasks")
    .select("*")
    .order("created_at", { ascending: false });

  if (filters.status && filters.status !== "all") {
    q = q.eq("status", filters.status);
  }
  if (filters.assigneeId) q = q.eq("assigned_to", filters.assigneeId);
  if (filters.dateFrom) q = q.gte("created_at", `${filters.dateFrom}T00:00:00.000Z`);
  if (filters.dateTo) q = q.lte("created_at", `${filters.dateTo}T23:59:59.999Z`);

  const limit = filters.limit ?? 500;
  q = q.limit(limit);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  let tasks = (data ?? []) as HousekeepingTask[];
  const roomQ = filters.room?.trim().toLowerCase();
  if (roomQ) {
    tasks = tasks.filter((t) => t.room_number.toLowerCase().includes(roomQ));
  }

  const order = new Map(sortRoomNumbers(tasks.map((t) => t.room_number)).map((n, i) => [n, i]));
  tasks = [...tasks].sort((a, b) => {
    const byDate = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (byDate !== 0) return byDate;
    return (order.get(a.room_number) ?? 0) - (order.get(b.room_number) ?? 0);
  });

  const assigneeIds = [...new Set(tasks.map((t) => t.assigned_to).filter(Boolean))] as string[];
  const { data: staff } = assigneeIds.length
    ? await supabase.from("profiles").select("id, full_name, email").in("id", assigneeIds)
    : { data: [] };

  const staffById = new Map(
    (staff ?? []).map((p) => [p.id, p.full_name?.trim() || p.email?.trim() || null]),
  );

  return tasks.map((task) => {
    const verify = readTaskVerify(task.metadata);
    const editMeta = readTaskEditMeta(task);
    return {
      task,
      attendantName: task.assigned_to ? staffById.get(task.assigned_to) ?? null : null,
      selfVerified: !!verify.selfVerifiedAt,
      supervisorVerified: !!verify.supervisorVerifiedAt,
      dutyLabel: editMeta.duty,
      petRoom: editMeta.petRoom,
      occupied: editMeta.occupied,
    };
  });
}

function applyVerifiedByMetadata(
  metadata: Record<string, unknown>,
  verifiedBy: TaskVerifiedBy,
  editorId: string,
  existing: ReturnType<typeof readTaskVerify>,
): Record<string, unknown> {
  const next = { ...metadata };

  if (verifiedBy === "none") {
    delete next.self_verified_at;
    delete next.self_verified_by;
    delete next.supervisor_verified_at;
    delete next.supervisor_verified_by;
    return next;
  }

  const now = new Date().toISOString();

  if (verifiedBy === "self") {
    next.self_verified_at = existing.selfVerifiedAt ?? now;
    next.self_verified_by = existing.selfVerifiedBy ?? editorId;
    return next;
  }

  next.supervisor_verified_at = existing.supervisorVerifiedAt ?? now;
  next.supervisor_verified_by = existing.supervisorVerifiedBy ?? editorId;
  return next;
}

/**
 * Admin/supervisor single-task edit (All Tasks).
 * Direct update (not assign RPC) so corrections are not blocked by PMS guest-in-room gates.
 */
export async function updateHousekeepingTask(input: TaskEditInput): Promise<HousekeepingTask> {
  const roomNumber = input.roomNumber.trim();
  if (!roomNumber) throw new Error("Room is required.");
  if (!input.duty.trim()) throw new Error("Duty is required.");
  if (!input.taskType) throw new Error("Task type is required.");

  const needsAssignee =
    input.status === "assigned" ||
    input.status === "in_progress" ||
    input.status === "inspection_pending";
  if (needsAssignee && !input.assignedTo) {
    throw new Error("Assignee is required for this status.");
  }

  const { data: existing, error: readError } = await supabase
    .from("housekeeping_tasks")
    .select("*")
    .eq("id", input.taskId)
    .maybeSingle();

  if (readError) throw new Error(readError.message);
  if (!existing) throw new Error("Task not found.");

  const task = existing as HousekeepingTask;
  const verify = readTaskVerify(task.metadata);
  const now = new Date().toISOString();

  let status = input.status;
  const assignedTo = input.assignedTo;
  let assignedAt = task.assigned_at;
  let assignedBy = task.assigned_by;
  let startedAt = task.started_at;
  let completedAt = task.completed_at;
  let cancelledAt = task.cancelled_at;
  let cancelReason = task.cancel_reason;

  if (!assignedTo) {
    assignedAt = null;
    assignedBy = null;
    if (status === "assigned") status = "pending";
  } else {
    if (status === "pending") status = "assigned";
    if (assignedTo !== task.assigned_to || !assignedAt) {
      assignedAt = now;
      assignedBy = input.editorId;
    }
  }

  if (status === "in_progress" || status === "inspection_pending" || status === "completed") {
    if (!startedAt) startedAt = now;
  }

  if (status === "completed") {
    if (!completedAt) completedAt = now;
  } else if (task.status === "completed") {
    completedAt = null;
  }

  if (status === "pending" || status === "assigned") {
    if (task.status === "completed" || task.status === "cancelled") {
      startedAt = null;
      completedAt = null;
    }
  }

  if (status === "cancelled") {
    if (!cancelledAt) cancelledAt = now;
    if (!cancelReason) cancelReason = "Cancelled from All tasks edit";
  } else if (task.status === "cancelled") {
    cancelledAt = null;
    cancelReason = null;
  }

  const metadata = applyVerifiedByMetadata(
    {
      ...(task.metadata ?? {}),
      duty: input.duty.trim(),
      pet_room: input.petRoom,
      occupied: input.occupied,
      created_by_name: input.createdByName.trim() || null,
    },
    input.verifiedBy,
    input.editorId,
    verify,
  );

  const { data, error } = await supabase
    .from("housekeeping_tasks")
    .update({
      room_number: roomNumber,
      task_type: input.taskType,
      priority: input.priority,
      status,
      assigned_to: assignedTo,
      assigned_at: assignedAt,
      assigned_by: assignedBy,
      started_at: startedAt,
      completed_at: completedAt,
      cancelled_at: cancelledAt,
      cancel_reason: cancelReason,
      due_at: input.dueAt,
      notes: input.notes?.trim() || null,
      metadata,
      updated_at: now,
    })
    .eq("id", input.taskId)
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return data as HousekeepingTask;
}

export function useHousekeepingTaskSearch(filters: TaskSearchFilters) {
  return useQuery({
    queryKey: [
      ...HK_TASK_SEARCH_KEY,
      filters.room ?? "",
      filters.status ?? "all",
      filters.assigneeId ?? "",
      filters.dateFrom ?? "",
      filters.dateTo ?? "",
      filters.limit ?? 500,
    ] as const,
    queryFn: () => searchHousekeepingTasks(filters),
    staleTime: 10_000,
  });
}

export function useUpdateHousekeepingTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TaskEditInput) => updateHousekeepingTask(input),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: HK_TASK_SEARCH_KEY }),
        qc.invalidateQueries({ queryKey: ["housekeeping-board"] }),
        qc.invalidateQueries({ queryKey: ["housekeeping-tasks"] }),
        qc.invalidateQueries({ queryKey: ["hk-open-tasks"] }),
        qc.invalidateQueries({ queryKey: ["hk-inspection-log"] }),
        qc.invalidateQueries({ queryKey: ["hk-ra-monitor"] }),
      ]);
    },
  });
}

export function exportTaskSearchCsv(rows: TaskSearchRow[]): string {
  const header = [
    "Room",
    "Duty",
    "Type",
    "Status",
    "Priority",
    "Assignee",
    "Self verify",
    "Supervisor verify",
    "Pet room",
    "Occupied",
    "Created",
    "Completed",
    "Notes",
  ];
  const lines = rows.map(
    ({ task, attendantName, selfVerified, supervisorVerified, dutyLabel, petRoom, occupied }) =>
      [
        task.room_number,
        dutyLabel,
        task.task_type,
        TASK_STATUS_LABELS[task.status] ?? task.status,
        task.priority,
        attendantName ?? "",
        selfVerified ? "Yes" : "No",
        supervisorVerified ? "Yes" : "No",
        petRoom ? "Yes" : "No",
        occupied ? "Yes" : "No",
        task.created_at,
        task.completed_at ?? "",
        (task.notes ?? "").replace(/"/g, '""'),
      ]
        .map((c) => `"${String(c)}"`)
        .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}
