import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { HousekeepingTask } from "@/types/housekeeping";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DailySummary = {
  date: string;
  total: number;
  completed: number;
  pending: number;
  in_progress: number;
  inspection_pending: number;
  cancelled: number;
  avg_clean_minutes: number | null;
};

export type StaffPerformance = {
  housekeeper_id: string;
  full_name: string | null;
  email: string | null;
  total_assigned: number;
  completed: number;
  inspection_passed: number;
  inspection_failed: number;
  avg_clean_minutes: number | null;
  overdue_count: number;
};

export type RoomHistoryEntry = HousekeepingTask & {
  assignee_name: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dayBounds(date: string): [string, string] {
  return [`${date}T00:00:00.000Z`, `${date}T23:59:59.999Z`];
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

export async function fetchDailySummary(date: string): Promise<DailySummary> {
  const [start, end] = dayBounds(date);

  const { data, error } = await supabase
    .from("housekeeping_tasks")
    .select("status, started_at, completed_at")
    .gte("created_at", start)
    .lte("created_at", end);

  if (error) throw new Error(error.message);

  const rows = data ?? [];
  let totalCleanMs = 0;
  let cleanCount = 0;

  for (const r of rows) {
    if (r.completed_at && r.started_at) {
      const ms = new Date(r.completed_at).getTime() - new Date(r.started_at).getTime();
      if (ms > 0) {
        totalCleanMs += ms;
        cleanCount++;
      }
    }
  }

  return {
    date,
    total: rows.length,
    completed: rows.filter((r) => r.status === "completed").length,
    pending: rows.filter((r) => r.status === "pending").length,
    in_progress: rows.filter((r) => r.status === "in_progress").length,
    inspection_pending: rows.filter((r) => r.status === "inspection_pending").length,
    cancelled: rows.filter((r) => r.status === "cancelled").length,
    avg_clean_minutes: cleanCount > 0 ? Math.round(totalCleanMs / cleanCount / 60_000) : null,
  };
}

export async function fetchStaffPerformance(
  startDate: string,
  endDate: string,
): Promise<StaffPerformance[]> {
  const [start] = dayBounds(startDate);
  const [, end] = dayBounds(endDate);

  const [tasksRes, staffRes, eventsRes] = await Promise.all([
    supabase
      .from("housekeeping_tasks")
      .select("id, assigned_to, status, started_at, completed_at, due_at")
      .gte("created_at", start)
      .lte("created_at", end)
      .not("assigned_to", "is", null),
    supabase
      .from("profiles")
      .select("id, full_name, email")
      .in("role", ["housekeeper", "supervisor"]),
    supabase
      .from("housekeeping_inspections")
      .select("task_id, result")
      .gte("created_at", start)
      .lte("created_at", end),
  ]);

  if (tasksRes.error) throw new Error(tasksRes.error.message);
  if (staffRes.error) throw new Error(staffRes.error.message);

  // Build staff lookup
  const staffMap = new Map<string, { full_name: string | null; email: string | null }>();
  for (const s of staffRes.data ?? []) {
    staffMap.set(s.id, { full_name: s.full_name, email: s.email });
  }

  // Count inspection events per task
  const passCounts = new Map<string, number>();
  const failCounts = new Map<string, number>();
  for (const e of eventsRes.data ?? []) {
    if (e.result === "passed") {
      passCounts.set(e.task_id, (passCounts.get(e.task_id) ?? 0) + 1);
    } else if (e.result === "failed") {
      failCounts.set(e.task_id, (failCounts.get(e.task_id) ?? 0) + 1);
    }
  }

  // Group tasks by housekeeper
  type TaskRow = (typeof tasksRes.data)[0];
  const byHk = new Map<string, TaskRow[]>();
  for (const t of tasksRes.data ?? []) {
    const hkId = t.assigned_to!;
    const existing = byHk.get(hkId);
    if (existing) existing.push(t);
    else byHk.set(hkId, [t]);
  }

  const result: StaffPerformance[] = [];
  for (const [hkId, tasks] of byHk) {
    const staff = staffMap.get(hkId) ?? { full_name: null, email: null };
    let totalCleanMs = 0;
    let cleanCount = 0;
    let passed = 0;
    let failed = 0;
    let overdue = 0;

    for (const t of tasks) {
      if (t.completed_at && t.started_at) {
        const ms = new Date(t.completed_at).getTime() - new Date(t.started_at).getTime();
        if (ms > 0) {
          totalCleanMs += ms;
          cleanCount++;
        }
      }
      passed += passCounts.get(t.id) ?? 0;
      failed += failCounts.get(t.id) ?? 0;
      if (
        t.due_at &&
        t.status !== "completed" &&
        t.status !== "cancelled" &&
        new Date(t.due_at).getTime() < Date.now()
      ) {
        overdue++;
      }
    }

    result.push({
      housekeeper_id: hkId,
      full_name: staff.full_name,
      email: staff.email,
      total_assigned: tasks.length,
      completed: tasks.filter((t) => t.status === "completed").length,
      inspection_passed: passed,
      inspection_failed: failed,
      avg_clean_minutes: cleanCount > 0 ? Math.round(totalCleanMs / cleanCount / 60_000) : null,
      overdue_count: overdue,
    });
  }

  return result.sort((a, b) => b.total_assigned - a.total_assigned);
}

export async function fetchRoomHistory(
  roomNumber: string,
  days = 30,
): Promise<RoomHistoryEntry[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [tasksRes, staffRes] = await Promise.all([
    supabase
      .from("housekeeping_tasks")
      .select("*")
      .eq("room_number", roomNumber)
      .gte("created_at", since)
      .order("created_at", { ascending: false }),
    supabase.from("profiles").select("id, full_name, email"),
  ]);

  if (tasksRes.error) throw new Error(tasksRes.error.message);

  const staffMap = new Map<string, string | null>();
  for (const s of staffRes.data ?? []) {
    staffMap.set(s.id, s.full_name ?? s.email ?? null);
  }

  return (tasksRes.data ?? []).map((t) => ({
    ...(t as HousekeepingTask),
    assignee_name: t.assigned_to ? (staffMap.get(t.assigned_to) ?? null) : null,
  }));
}

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

export function useDailySummary(date: string) {
  return useQuery({
    queryKey: ["hk-reports-daily", date] as const,
    queryFn: () => fetchDailySummary(date),
    staleTime: 30_000,
  });
}

export function useStaffPerformance(startDate: string, endDate: string, enabled = true) {
  return useQuery({
    queryKey: ["hk-reports-staff", startDate, endDate] as const,
    queryFn: () => fetchStaffPerformance(startDate, endDate),
    enabled,
    staleTime: 30_000,
  });
}

export function useRoomHistory(roomNumber: string, days = 30) {
  return useQuery({
    queryKey: ["hk-reports-room", roomNumber, days] as const,
    queryFn: () => fetchRoomHistory(roomNumber, days),
    enabled: !!roomNumber.trim(),
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",");
}

export function exportStaffPerformanceCsv(data: StaffPerformance[], label: string): void {
  const headers = [
    "Name",
    "Email",
    "Assigned",
    "Completed",
    "Avg Clean (min)",
    "Passed Inspection",
    "Failed Inspection",
    "Overdue",
  ];
  const rows = data.map((r) => [
    r.full_name,
    r.email,
    r.total_assigned,
    r.completed,
    r.avg_clean_minutes,
    r.inspection_passed,
    r.inspection_failed,
    r.overdue_count,
  ]);

  const csv = [csvRow(headers), ...rows.map(csvRow)].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hk-staff-performance-${label}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportDailySummaryCsv(data: DailySummary): void {
  const rows: (string | number | null)[][] = [
    ["Date", data.date],
    ["Total Tasks", data.total],
    ["Completed", data.completed],
    ["Pending", data.pending],
    ["In Progress", data.in_progress],
    ["Awaiting Inspection", data.inspection_pending],
    ["Cancelled", data.cancelled],
    ["Avg Clean Time (min)", data.avg_clean_minutes],
  ];

  const csv = rows.map(csvRow).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hk-daily-summary-${data.date}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
