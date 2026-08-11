import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HK_RA_MONITOR_KEY } from "@/lib/hkRaMonitor";
import { HOUSEKEEPING_BOARD_KEY } from "@/lib/housekeeping";
import { supabase } from "@/lib/supabase";
import type { HkMaintenancePriority, HkMaintenanceStatus, HkMaintenanceTask } from "@/types/housekeeping";

export const HK_MAINTENANCE_KEY = ["hk-maintenance-tasks"] as const;

export const HK_MAINT_CATEGORY_OPTIONS = [
  "HVAC",
  "Plumbing",
  "Electrical",
  "Furniture",
  "Appliance",
  "Safety",
  "Other",
] as const;

export const HK_MAINT_PRIORITY_OPTIONS: { value: HkMaintenancePriority; label: string }[] = [
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

export const HK_MAINT_STATUS_OPTIONS: HkMaintenanceStatus[] = [
  "open",
  "in_progress",
  "completed",
  "cancelled",
];

export const HK_MAINT_STATUS_LABELS: Record<HkMaintenanceStatus, string> = {
  open: "New",
  in_progress: "In progress",
  completed: "Done",
  cancelled: "Cancelled",
};

const MAINT_SELECT = "*";

function isMissingTableError(message: string): boolean {
  return /does not exist|schema cache|hk_maintenance_tasks/i.test(message);
}

export async function fetchOpenMaintenanceTasks(): Promise<HkMaintenanceTask[]> {
  const { data, error } = await supabase
    .from("hk_maintenance_tasks")
    .select(MAINT_SELECT)
    .in("status", ["open", "in_progress"])
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingTableError(error.message)) {
      console.warn("[hk-maintenance] table not ready:", error.message);
      return [];
    }
    throw new Error(error.message);
  }
  return (data ?? []) as HkMaintenanceTask[];
}

export async function fetchMaintenanceTasks(status?: "open" | "all"): Promise<HkMaintenanceTask[]> {
  let q = supabase.from("hk_maintenance_tasks").select(MAINT_SELECT).order("created_at", { ascending: false });
  if (status === "open") q = q.in("status", ["open", "in_progress"]);

  const { data, error } = await q.limit(500);
  if (error) {
    if (isMissingTableError(error.message)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as HkMaintenanceTask[];
}

export function useMaintenanceTasks(status?: "open" | "all") {
  return useQuery({
    queryKey: [...HK_MAINTENANCE_KEY, status ?? "open"] as const,
    queryFn: () => fetchMaintenanceTasks(status),
    staleTime: 10_000,
    refetchInterval: 20_000,
  });
}

export async function createMaintenanceTask(input: {
  roomNumber: string;
  title: string;
  description?: string | null;
  category?: string | null;
  priority: HkMaintenancePriority;
  assignedTo?: string | null;
  blocksRoom?: boolean;
  reportedBy: string;
}): Promise<HkMaintenanceTask> {
  const { data, error } = await supabase
    .from("hk_maintenance_tasks")
    .insert({
      room_number: input.roomNumber.trim(),
      title: input.title.trim(),
      description: input.description?.trim() || null,
      category: input.category?.trim() || null,
      priority: input.priority,
      status: input.assignedTo ? "in_progress" : "open",
      assigned_to: input.assignedTo ?? null,
      reported_by: input.reportedBy,
      blocks_room: input.blocksRoom ?? false,
      started_at: input.assignedTo ? new Date().toISOString() : null,
    })
    .select(MAINT_SELECT)
    .single();

  if (error) throw new Error(error.message);
  return data as HkMaintenanceTask;
}

export async function updateMaintenanceTask(
  id: string,
  patch: Partial<{
    title: string;
    description: string | null;
    category: string | null;
    priority: HkMaintenancePriority;
    status: HkMaintenanceStatus;
    assignedTo: string | null;
    blocksRoom: boolean;
    notes: string | null;
    completedBy: string | null;
  }>,
): Promise<HkMaintenanceTask> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.category !== undefined) updates.category = patch.category;
  if (patch.priority !== undefined) updates.priority = patch.priority;
  if (patch.blocksRoom !== undefined) updates.blocks_room = patch.blocksRoom;
  if (patch.notes !== undefined) updates.notes = patch.notes;
  if (patch.assignedTo !== undefined) {
    updates.assigned_to = patch.assignedTo;
    if (patch.assignedTo && patch.status === undefined) {
      updates.status = "in_progress";
      updates.started_at = new Date().toISOString();
    }
  }
  if (patch.status !== undefined) {
    updates.status = patch.status;
    if (patch.status === "in_progress" && !patch.assignedTo) {
      updates.started_at = new Date().toISOString();
    }
    if (patch.status === "completed") {
      updates.completed_at = new Date().toISOString();
      updates.completed_by = patch.completedBy ?? null;
    }
    if (patch.status === "open") {
      updates.completed_at = null;
      updates.completed_by = null;
    }
  }

  const { data, error } = await supabase
    .from("hk_maintenance_tasks")
    .update(updates)
    .eq("id", id)
    .select(MAINT_SELECT)
    .single();

  if (error) throw new Error(error.message);
  return data as HkMaintenanceTask;
}

function invalidateMaintQueries(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: HK_MAINTENANCE_KEY });
  void qc.invalidateQueries({ queryKey: HK_RA_MONITOR_KEY });
  void qc.invalidateQueries({ queryKey: HOUSEKEEPING_BOARD_KEY });
}

export function useCreateMaintenanceTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createMaintenanceTask,
    onSuccess: () => invalidateMaintQueries(qc),
  });
}

export function useUpdateMaintenanceTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Parameters<typeof updateMaintenanceTask>[1];
    }) => updateMaintenanceTask(id, patch),
    onSuccess: () => invalidateMaintQueries(qc),
  });
}

export function maintPriorityClass(priority: HkMaintenancePriority): string {
  switch (priority) {
    case "urgent":
    case "high":
      return "border-red-400/80 bg-red-50 text-red-950 dark:border-red-500/55 dark:bg-red-500/15 dark:text-red-100";
    case "medium":
      return "border-amber-400/80 bg-amber-50 text-amber-950 dark:border-amber-500/55 dark:bg-amber-500/15 dark:text-amber-100";
    default:
      return "border-emerald-400/70 bg-emerald-50 text-emerald-950 dark:border-emerald-500/45 dark:bg-emerald-500/12 dark:text-emerald-100";
  }
}

export function maintStatusClass(status: HkMaintenanceStatus): string {
  switch (status) {
    case "open":
      return "border-red-400/70 bg-red-100 text-red-950 dark:border-red-500/50 dark:bg-red-500/15 dark:text-red-100";
    case "in_progress":
      return "border-sky-400/70 bg-sky-100 text-sky-950 dark:border-sky-500/50 dark:bg-sky-500/15 dark:text-sky-100";
    case "completed":
      return "border-emerald-400/70 bg-emerald-100 text-emerald-950 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-100";
    default:
      return "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]";
  }
}
