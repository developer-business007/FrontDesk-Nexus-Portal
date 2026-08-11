import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  assignHousekeepingTask,
  HOUSEKEEPING_BOARD_KEY,
} from "@/lib/housekeeping";
import {
  fetchMyScheduleForDate,
  hkScheduleKey,
  upsertDailySchedule,
} from "@/lib/housekeepingSchedule";
import { HK_RA_MONITOR_KEY, type RaMonitorTaskRow } from "@/lib/hkRaMonitor";
import { parseHotelRoomList, sortRoomNumbers } from "@/lib/roomInventory";
import { supabase } from "@/lib/supabase";

export type RangeAssignItemStatus =
  | "assignable"
  | "blocked"
  | "no_task"
  | "same_assignee"
  | "other_assignee"
  | "in_progress"
  | "verified";

export type RangeAssignPreviewItem = {
  roomNumber: string;
  status: RangeAssignItemStatus;
  reason: string | null;
  taskId: string | null;
};

export type RangeAssignPreview = {
  roomsInRange: string[];
  unknownRooms: string[];
  items: RangeAssignPreviewItem[];
  assignable: number;
  blocked: number;
  skipped: number;
  noTask: number;
};

export type RangeAssignDetail = {
  room: string;
  action: "assigned" | "skipped" | "blocked" | "error";
  reason?: string;
};

export type RangeAssignResult = {
  assigned: number;
  skipped: number;
  blocked: number;
  errors: number;
  details: RangeAssignDetail[];
  scheduleUpdated: boolean;
};

export type RangeAssignParams = {
  roomText: string;
  assignedTo: string;
  scheduleDate: string;
  createdBy?: string | null;
  forceReassign?: boolean;
  notes?: string | null;
  /** Flat monitor rows for the current hotel date. */
  taskRows: RaMonitorTaskRow[];
  /** Known property room numbers (inventory / board). */
  knownRooms: string[];
};

function taskRowByRoom(rows: RaMonitorTaskRow[]): Map<string, RaMonitorTaskRow> {
  const map = new Map<string, RaMonitorTaskRow>();
  for (const row of rows) {
    map.set(row.roomNumber.trim(), row);
  }
  return map;
}

function classifyRangeItem(
  roomNumber: string,
  row: RaMonitorTaskRow | undefined,
  assignedTo: string,
  forceReassign: boolean,
): RangeAssignPreviewItem {
  if (!row) {
    return {
      roomNumber,
      status: "no_task",
      reason: "No open task for this room today",
      taskId: null,
    };
  }

  const task = row.task;
  if (row.bucket === "verified" || task.status === "completed") {
    return {
      roomNumber,
      status: "verified",
      reason: "Already verified complete",
      taskId: task.id,
    };
  }

  if (task.status === "in_progress" || task.status === "inspection_pending") {
    return {
      roomNumber,
      status: "in_progress",
      reason: "Task in progress — finish or reassign individually",
      taskId: task.id,
    };
  }

  if (!row.assignAllowed) {
    return {
      roomNumber,
      status: "blocked",
      reason: row.assignBlockReason ?? "Blocked by DualPMS",
      taskId: task.id,
    };
  }

  if (task.assigned_to === assignedTo) {
    return {
      roomNumber,
      status: "same_assignee",
      reason: "Already assigned to this housekeeper",
      taskId: task.id,
    };
  }

  if (task.assigned_to && task.assigned_to !== assignedTo && !forceReassign) {
    return {
      roomNumber,
      status: "other_assignee",
      reason: "Assigned to another attendant — enable reassign to move",
      taskId: task.id,
    };
  }

  return {
    roomNumber,
    status: "assignable",
    reason: null,
    taskId: task.id,
  };
}

export function previewRangeAssign(params: {
  roomText: string;
  assignedTo: string;
  forceReassign?: boolean;
  taskRows: RaMonitorTaskRow[];
  knownRooms: string[];
}): RangeAssignPreview {
  const parsed = sortRoomNumbers(parseHotelRoomList(params.roomText));
  const known = new Set(params.knownRooms.map((r) => r.trim()));
  const roomsInRange = parsed.filter((r) => known.has(r));
  const unknownRooms = parsed.filter((r) => !known.has(r));
  const byRoom = taskRowByRoom(params.taskRows);

  const items = roomsInRange.map((roomNumber) =>
    classifyRangeItem(roomNumber, byRoom.get(roomNumber), params.assignedTo, !!params.forceReassign),
  );

  let assignable = 0;
  let blocked = 0;
  let skipped = 0;
  let noTask = 0;

  for (const item of items) {
    switch (item.status) {
      case "assignable":
        assignable += 1;
        break;
      case "blocked":
        blocked += 1;
        break;
      case "no_task":
        noTask += 1;
        break;
      default:
        skipped += 1;
        break;
    }
  }

  return {
    roomsInRange,
    unknownRooms,
    items,
    assignable,
    blocked,
    skipped,
    noTask,
  };
}

async function tryRpcRangeAssign(
  roomNumbers: string[],
  assignedTo: string,
  scheduleDate: string,
  forceReassign: boolean,
  notes: string | null,
): Promise<RangeAssignResult | null> {
  const { data, error } = await supabase.rpc("hk_assign_room_range", {
    p_room_numbers: roomNumbers,
    p_assigned_to: assignedTo,
    p_schedule_date: scheduleDate,
    p_force_reassign: forceReassign,
    p_notes: notes,
  });

  if (error) {
    if (/function.*does not exist|hk_assign_room_range/i.test(error.message)) {
      return null;
    }
    throw new Error(error.message);
  }

  if (!data || typeof data !== "object") {
    return {
      assigned: 0,
      skipped: 0,
      blocked: 0,
      errors: 0,
      details: [],
      scheduleUpdated: false,
    };
  }

  const row = data as Record<string, unknown>;
  const num = (key: string) => (typeof row[key] === "number" ? row[key] : 0) as number;
  const details = Array.isArray(row.details)
    ? (row.details as RangeAssignDetail[])
    : [];

  return {
    assigned: num("assigned"),
    skipped: num("skipped"),
    blocked: num("blocked"),
    errors: num("errors"),
    details,
    scheduleUpdated: row.schedule_updated === true,
  };
}

async function assignRangeClientSide(
  preview: RangeAssignPreview,
  assignedTo: string,
  notes: string | null,
): Promise<RangeAssignResult> {
  const result: RangeAssignResult = {
    assigned: 0,
    skipped: 0,
    blocked: 0,
    errors: 0,
    details: [],
    scheduleUpdated: false,
  };

  for (const item of preview.items) {
    if (item.status !== "assignable" || !item.taskId) {
      if (item.status === "blocked") {
        result.blocked += 1;
        result.details.push({ room: item.roomNumber, action: "blocked", reason: item.reason ?? undefined });
      } else {
        result.skipped += 1;
        result.details.push({ room: item.roomNumber, action: "skipped", reason: item.reason ?? undefined });
      }
      continue;
    }

    const { error } = await assignHousekeepingTask(item.taskId, assignedTo, notes);
    if (error) {
      if (/guest still in room|DualPMS|blocked/i.test(error.message)) {
        result.blocked += 1;
        result.details.push({ room: item.roomNumber, action: "blocked", reason: error.message });
      } else {
        result.errors += 1;
        result.details.push({ room: item.roomNumber, action: "error", reason: error.message });
      }
      continue;
    }

    result.assigned += 1;
    result.details.push({ room: item.roomNumber, action: "assigned" });
  }

  return result;
}

async function syncScheduleRooms(
  scheduleDate: string,
  housekeeperId: string,
  roomNumbers: string[],
  createdBy: string | null,
): Promise<boolean> {
  if (!roomNumbers.length) return false;

  const existing = await fetchMyScheduleForDate(housekeeperId, scheduleDate);
  const merged = sortRoomNumbers([
    ...new Set([...(existing?.assigned_rooms ?? []), ...roomNumbers]),
  ]);

  await upsertDailySchedule(
    scheduleDate,
    housekeeperId,
    merged,
    existing?.notes ?? null,
    createdBy,
  );
  return true;
}

export async function assignRoomRange(params: RangeAssignParams): Promise<RangeAssignResult> {
  const preview = previewRangeAssign({
    roomText: params.roomText,
    assignedTo: params.assignedTo,
    forceReassign: params.forceReassign,
    taskRows: params.taskRows,
    knownRooms: params.knownRooms,
  });

  if (preview.assignable === 0) {
    return {
      assigned: 0,
      skipped: preview.skipped,
      blocked: preview.blocked,
      errors: 0,
      details: preview.items
        .filter((i) => i.status !== "assignable")
        .map((i) => ({
          room: i.roomNumber,
          action: i.status === "blocked" ? "blocked" : "skipped",
          reason: i.reason ?? undefined,
        })),
      scheduleUpdated: false,
    };
  }

  const assignableRooms = preview.items
    .filter((i) => i.status === "assignable")
    .map((i) => i.roomNumber);

  let result =
    (await tryRpcRangeAssign(
      assignableRooms,
      params.assignedTo,
      params.scheduleDate,
      !!params.forceReassign,
      params.notes ?? null,
    )) ?? (await assignRangeClientSide(preview, params.assignedTo, params.notes ?? null));

  if (!result.scheduleUpdated && result.assigned > 0) {
    const assignedRooms = result.details
      .filter((d) => d.action === "assigned")
      .map((d) => d.room);
    result.scheduleUpdated = await syncScheduleRooms(
      params.scheduleDate,
      params.assignedTo,
      assignedRooms,
      params.createdBy ?? null,
    );
  }

  return result;
}

export function formatRangeAssignSummary(result: RangeAssignResult): string {
  const parts = [`${result.assigned} assigned`];
  if (result.blocked > 0) parts.push(`${result.blocked} blocked`);
  if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
  if (result.errors > 0) parts.push(`${result.errors} failed`);
  return parts.join(", ");
}

export function useRangeAssignHousekeeping(_hotelDate?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: RangeAssignParams) => assignRoomRange(params),
    onSuccess: async (_data, vars) => {
      await Promise.all([
        qc.refetchQueries({ queryKey: HK_RA_MONITOR_KEY }),
        qc.refetchQueries({ queryKey: HOUSEKEEPING_BOARD_KEY }),
        qc.refetchQueries({ queryKey: ["housekeeping-tasks"] }),
        qc.refetchQueries({ queryKey: hkScheduleKey(vars.scheduleDate) }),
        qc.refetchQueries({ queryKey: ["hk-my-schedule", vars.assignedTo, vars.scheduleDate] }),
      ]);
    },
  });
}
