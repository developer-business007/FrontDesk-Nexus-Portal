import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { HousekeepingTask } from "@/types/housekeeping";

export type HkInspectionRating = "excellent" | "good" | "fair" | "poor";

export const HK_INSPECTION_RATING_OPTIONS: { value: HkInspectionRating; label: string }[] = [
  { value: "excellent", label: "Excellent" },
  { value: "good", label: "Good" },
  { value: "fair", label: "Fair" },
  { value: "poor", label: "Poor" },
];

export type TaskVerifyMeta = {
  selfVerifiedAt: string | null;
  selfVerifiedBy: string | null;
  supervisorVerifiedAt: string | null;
  supervisorVerifiedBy: string | null;
  inspectionRating: HkInspectionRating | null;
  problemCount: number | null;
};

export function readTaskVerify(metadata: Record<string, unknown> | null | undefined): TaskVerifyMeta {
  const m = metadata ?? {};
  const rating = m.inspection_rating;
  return {
    selfVerifiedAt: typeof m.self_verified_at === "string" ? m.self_verified_at : null,
    selfVerifiedBy: typeof m.self_verified_by === "string" ? m.self_verified_by : null,
    supervisorVerifiedAt:
      typeof m.supervisor_verified_at === "string" ? m.supervisor_verified_at : null,
    supervisorVerifiedBy:
      typeof m.supervisor_verified_by === "string" ? m.supervisor_verified_by : null,
    inspectionRating:
      rating === "excellent" || rating === "good" || rating === "fair" || rating === "poor"
        ? rating
        : null,
    problemCount: typeof m.problem_count === "number" ? m.problem_count : null,
  };
}

async function patchTaskMetadata(
  taskId: string,
  metadataPatch: Record<string, unknown>,
): Promise<HousekeepingTask> {
  const { data: row, error: readError } = await supabase
    .from("housekeeping_tasks")
    .select("metadata")
    .eq("id", taskId)
    .maybeSingle();

  if (readError) throw new Error(readError.message);
  if (!row) throw new Error("Task not found");

  const metadata = { ...(row.metadata as Record<string, unknown>), ...metadataPatch };
  const { data, error } = await supabase
    .from("housekeeping_tasks")
    .update({ metadata, updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return data as HousekeepingTask;
}

export async function selfVerifyHousekeepingTask(
  taskId: string,
  userId: string,
): Promise<HousekeepingTask> {
  const { data: task, error } = await supabase
    .from("housekeeping_tasks")
    .select("*")
    .eq("id", taskId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!task) throw new Error("Task not found");

  const row = task as HousekeepingTask;
  if (row.status !== "in_progress" && row.status !== "inspection_pending") {
    throw new Error("Self-verify is only available while cleaning or awaiting inspection.");
  }
  if (row.assigned_to && row.assigned_to !== userId) {
    throw new Error("Only the assigned housekeeper can self-verify this room.");
  }

  const now = new Date().toISOString();
  const updated = await patchTaskMetadata(taskId, {
    self_verified_at: now,
    self_verified_by: userId,
  });

  return updated;
}

export async function markSupervisorVerified(
  taskId: string,
  supervisorId: string,
  input?: {
    rating?: HkInspectionRating | null;
    problemCount?: number | null;
    notes?: string | null;
    result?: string;
  },
): Promise<HousekeepingTask> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    supervisor_verified_at: now,
    supervisor_verified_by: supervisorId,
  };
  if (input?.rating) patch.inspection_rating = input.rating;
  if (input?.problemCount != null) patch.problem_count = input.problemCount;

  const updated = await patchTaskMetadata(taskId, patch);

  return updated;
}

export function useSelfVerifyHousekeepingTask(userId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => selfVerifyHousekeepingTask(taskId, userId!),
    onSuccess: async (task) => {
      if (userId) {
        void qc.invalidateQueries({ queryKey: ["housekeeping-tasks", "mine", userId] });
      }
      void qc.invalidateQueries({ queryKey: ["housekeeping-board"] });
      void qc.invalidateQueries({ queryKey: ["hk-inspection-log"] });
      void qc.invalidateQueries({ queryKey: ["hk-task-search"] });
      void qc.invalidateQueries({ queryKey: ["housekeeping-tasks"] });
      void qc.invalidateQueries({ queryKey: ["housekeeping-tasks", "metadata"] });
      return task;
    },
  });
}
