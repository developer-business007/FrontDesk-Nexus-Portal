import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { readTaskVerify, type HkInspectionRating } from "@/lib/hkTaskVerify";
import type { HkInspectionResult, HousekeepingTask } from "@/types/housekeeping";

export const HK_INSPECTION_LOG_KEY = ["hk-inspection-log"] as const;

type HkInspectionRow = {
  id: string;
  task_id: string;
  attempt: number;
  result: HkInspectionResult;
  notes: string | null;
  inspected_by: string;
  created_at: string;
};

export type InspectionLogRow = {
  id: string;
  eventType: string;
  createdAt: string;
  roomNumber: string;
  taskId: string;
  taskType: string | null;
  attendantId: string | null;
  attendantName: string | null;
  actorId: string | null;
  actorName: string | null;
  resultLabel: string;
  rating: HkInspectionRating | null;
  problemCount: number | null;
  notes: string | null;
  selfVerified: boolean;
  supervisorVerified: boolean;
};

function nDaysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function inspectionEventType(result: HkInspectionResult): string {
  return `inspection_${result}`;
}

function inspectionResultLabel(result: HkInspectionResult): string {
  switch (result) {
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "waived":
      return "Waived";
    default:
      return result;
  }
}

function staffName(
  id: string | null | undefined,
  map: Map<string, { full_name: string | null; email: string | null }>,
): string | null {
  if (!id) return null;
  const s = map.get(id);
  return s?.full_name?.trim() || s?.email?.trim() || null;
}

function rowFromInspection(
  inspection: HkInspectionRow,
  task: HousekeepingTask | undefined,
  staffById: Map<string, { full_name: string | null; email: string | null }>,
): InspectionLogRow {
  const verify = readTaskVerify(task?.metadata);
  return {
    id: inspection.id,
    eventType: inspectionEventType(inspection.result),
    createdAt: inspection.created_at,
    roomNumber: task?.room_number ?? "—",
    taskId: inspection.task_id,
    taskType: task?.task_type ?? null,
    attendantId: task?.assigned_to ?? null,
    attendantName: staffName(task?.assigned_to, staffById),
    actorId: inspection.inspected_by,
    actorName: staffName(inspection.inspected_by, staffById),
    resultLabel: inspectionResultLabel(inspection.result),
    rating: verify.inspectionRating,
    problemCount: verify.problemCount,
    notes: inspection.notes ?? task?.notes ?? null,
    selfVerified: !!verify.selfVerifiedAt,
    supervisorVerified: true,
  };
}

function rowFromSelfVerify(
  task: HousekeepingTask,
  staffById: Map<string, { full_name: string | null; email: string | null }>,
): InspectionLogRow | null {
  const verify = readTaskVerify(task.metadata);
  if (!verify.selfVerifiedAt) return null;

  return {
    id: `self-${task.id}-${verify.selfVerifiedAt}`,
    eventType: "self_verified",
    createdAt: verify.selfVerifiedAt,
    roomNumber: task.room_number,
    taskId: task.id,
    taskType: task.task_type,
    attendantId: task.assigned_to,
    attendantName: staffName(task.assigned_to, staffById),
    actorId: verify.selfVerifiedBy,
    actorName: staffName(verify.selfVerifiedBy, staffById),
    resultLabel: "Self verified",
    rating: null,
    problemCount: null,
    notes: task.notes ?? null,
    selfVerified: true,
    supervisorVerified: !!verify.supervisorVerifiedAt,
  };
}

export async function fetchInspectionLog(input: {
  days?: number;
  room?: string;
  assigneeId?: string;
  result?: "all" | "passed" | "failed" | "self" | "supervisor";
}): Promise<InspectionLogRow[]> {
  const days = input.days ?? 30;
  const since = nDaysAgoIso(days);
  const sinceMs = new Date(since).getTime();
  const resultFilter = input.result ?? "all";

  const wantInspections =
    resultFilter === "all" ||
    resultFilter === "passed" ||
    resultFilter === "failed" ||
    resultFilter === "supervisor";
  const wantSelf = resultFilter === "all" || resultFilter === "self";

  const inspectionsPromise = wantInspections
    ? supabase
        .from("housekeeping_inspections")
        .select("*")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1000)
    : Promise.resolve({ data: [], error: null });

  const tasksPromise = wantSelf
    ? supabase
        .from("housekeeping_tasks")
        .select("*")
        .gte("updated_at", since)
        .limit(1000)
    : Promise.resolve({ data: [], error: null });

  const [inspectionsRes, tasksRes, staffRes] = await Promise.all([
    inspectionsPromise,
    tasksPromise,
    supabase.from("profiles").select("id, full_name, email"),
  ]);

  if (inspectionsRes.error) {
    if (/does not exist|schema cache/i.test(inspectionsRes.error.message)) return [];
    throw new Error(inspectionsRes.error.message);
  }
  if (tasksRes.error) throw new Error(tasksRes.error.message);

  const staffById = new Map(
    (staffRes.data ?? []).map((p) => [p.id, { full_name: p.full_name, email: p.email }]),
  );

  const inspectionRows = (inspectionsRes.data ?? []) as HkInspectionRow[];
  const inspectionTaskIds = [...new Set(inspectionRows.map((r) => r.task_id))];

  let inspectionTasks: HousekeepingTask[] = (tasksRes.data ?? []) as HousekeepingTask[];
  const missingTaskIds = inspectionTaskIds.filter((id) => !inspectionTasks.some((t) => t.id === id));
  if (missingTaskIds.length) {
    const { data, error } = await supabase
      .from("housekeeping_tasks")
      .select("*")
      .in("id", missingTaskIds);
    if (error) throw new Error(error.message);
    inspectionTasks = [...inspectionTasks, ...((data ?? []) as HousekeepingTask[])];
  }

  const taskById = new Map(inspectionTasks.map((t) => [t.id, t]));

  let rows: InspectionLogRow[] = [];

  for (const inspection of inspectionRows) {
    rows.push(rowFromInspection(inspection, taskById.get(inspection.task_id), staffById));
  }

  if (wantSelf) {
    for (const task of (tasksRes.data ?? []) as HousekeepingTask[]) {
      const row = rowFromSelfVerify(task, staffById);
      if (row && new Date(row.createdAt).getTime() >= sinceMs) {
        rows.push(row);
      }
    }
  }

  rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const roomQ = input.room?.trim().toLowerCase();
  if (roomQ) rows = rows.filter((r) => r.roomNumber.toLowerCase().includes(roomQ));

  if (input.assigneeId) {
    rows = rows.filter((r) => r.attendantId === input.assigneeId);
  }

  if (resultFilter === "passed") {
    rows = rows.filter((r) => r.eventType === "inspection_passed");
  } else if (resultFilter === "failed") {
    rows = rows.filter((r) => r.eventType === "inspection_failed");
  } else if (resultFilter === "self") {
    rows = rows.filter((r) => r.eventType === "self_verified");
  } else if (resultFilter === "supervisor") {
    rows = rows.filter((r) => r.eventType.startsWith("inspection_"));
  }

  return rows;
}

export function useInspectionLog(filters: {
  days?: number;
  room?: string;
  assigneeId?: string;
  result?: "all" | "passed" | "failed" | "self" | "supervisor";
}) {
  return useQuery({
    queryKey: [
      ...HK_INSPECTION_LOG_KEY,
      filters.days ?? 30,
      filters.room ?? "",
      filters.assigneeId ?? "",
      filters.result ?? "all",
    ] as const,
    queryFn: () => fetchInspectionLog(filters),
    staleTime: 15_000,
  });
}

export function exportInspectionLogCsv(rows: InspectionLogRow[]): string {
  const header = [
    "Date",
    "Room",
    "Result",
    "Rating",
    "Problems",
    "Attendant",
    "Inspector",
    "Notes",
  ];
  const lines = rows.map((r) =>
    [
      r.createdAt,
      r.roomNumber,
      r.resultLabel,
      r.rating ?? "",
      r.problemCount ?? "",
      r.attendantName ?? "",
      r.actorName ?? "",
      (r.notes ?? "").replace(/"/g, '""'),
    ]
      .map((c) => `"${String(c)}"`)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}
