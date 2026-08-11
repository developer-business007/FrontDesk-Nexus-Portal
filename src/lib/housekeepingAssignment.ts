import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { assignHousekeepingTask, HOUSEKEEPING_BOARD_KEY, housekeepingMyTasksKey } from "@/lib/housekeeping";
import {
  canAssignHousekeepingByPms,
} from "@/lib/housekeepingPmsRules";
import { fetchPmsBoardRows } from "@/lib/pmsBoard";
import { supabase } from "@/lib/supabase";
import type { HousekeepingTask } from "@/types/housekeeping";

export type AssignmentProposal = {
  proposedAssignee: string;
  proposedBy: string;
  proposedAt: string;
};

const PROPOSAL_KEYS = {
  assignee: "proposed_assignee",
  by: "proposed_by",
  at: "proposed_at",
} as const;

export function readAssignmentProposal(metadata: Record<string, unknown> | null | undefined): AssignmentProposal | null {
  if (!metadata || typeof metadata !== "object") return null;
  const assignee = metadata[PROPOSAL_KEYS.assignee];
  const by = metadata[PROPOSAL_KEYS.by];
  const at = metadata[PROPOSAL_KEYS.at];
  if (typeof assignee !== "string" || !assignee.trim()) return null;
  if (typeof by !== "string" || !by.trim()) return null;
  if (typeof at !== "string" || !at.trim()) return null;
  return {
    proposedAssignee: assignee,
    proposedBy: by,
    proposedAt: at,
  };
}

export function hasAssignmentProposal(task: Pick<HousekeepingTask, "status" | "metadata">): boolean {
  return task.status === "pending" && readAssignmentProposal(task.metadata) != null;
}

export async function fetchOpenTasksWithMetadata(): Promise<HousekeepingTask[]> {
  const { data, error } = await supabase
    .from("housekeeping_tasks")
    .select("*")
    .in("status", ["pending", "assigned", "in_progress", "inspection_pending"]);

  if (error) throw new Error(error.message);
  return (data ?? []) as HousekeepingTask[];
}

export async function fetchProposedHousekeepingTasks(userId: string): Promise<HousekeepingTask[]> {
  const { data, error } = await supabase
    .from("housekeeping_tasks")
    .select("*")
    .eq("status", "pending")
    .contains("metadata", { [PROPOSAL_KEYS.assignee]: userId });

  if (error) throw new Error(error.message);
  return ((data ?? []) as HousekeepingTask[]).filter((task) => hasAssignmentProposal(task));
}

export async function proposeHousekeepingAssignment(
  taskId: string,
  proposedAssignee: string,
  proposedBy: string,
): Promise<HousekeepingTask> {
  const { data: existing, error: readError } = await supabase
    .from("housekeeping_tasks")
    .select("id, room_number, task_type, status, metadata")
    .eq("id", taskId)
    .single();

  if (readError) throw new Error(readError.message);

  const pmsRows = await fetchPmsBoardRows();
  const pmsRow = pmsRows.find(
    (r) => String(r.room_number).trim() === String(existing.room_number).trim(),
  );
  const gate = canAssignHousekeepingByPms(pmsRow, existing as HousekeepingTask);
  if (!gate.allowed) {
    throw new Error(gate.reason ?? "Proposal blocked by DualPMS");
  }

  const metadata = {
    ...((existing?.metadata as Record<string, unknown>) ?? {}),
    [PROPOSAL_KEYS.assignee]: proposedAssignee,
    [PROPOSAL_KEYS.by]: proposedBy,
    [PROPOSAL_KEYS.at]: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("housekeeping_tasks")
    .update({ metadata })
    .eq("id", taskId)
    .eq("status", "pending")
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return data as HousekeepingTask;
}

export async function clearHousekeepingAssignmentProposal(taskId: string): Promise<void> {
  const { data: existing, error: readError } = await supabase
    .from("housekeeping_tasks")
    .select("metadata")
    .eq("id", taskId)
    .single();

  if (readError) throw new Error(readError.message);

  const current = { ...((existing?.metadata as Record<string, unknown>) ?? {}) };
  delete current[PROPOSAL_KEYS.assignee];
  delete current[PROPOSAL_KEYS.by];
  delete current[PROPOSAL_KEYS.at];

  const { error } = await supabase
    .from("housekeeping_tasks")
    .update({ metadata: current })
    .eq("id", taskId);

  if (error) throw new Error(error.message);
}

export async function acceptHousekeepingAssignment(taskId: string): Promise<HousekeepingTask> {
  const { data: taskRow, error: readError } = await supabase
    .from("housekeeping_tasks")
    .select("*")
    .eq("id", taskId)
    .single();

  if (readError) throw new Error(readError.message);

  const task = taskRow as HousekeepingTask;
  const proposal = readAssignmentProposal(task.metadata);
  if (!proposal) throw new Error("No pending assignment proposal for this task");

  const { data, error } = await assignHousekeepingTask(taskId, proposal.proposedAssignee);
  if (error) throw error;
  if (!data) throw new Error("Assignment failed");

  await clearHousekeepingAssignmentProposal(taskId);
  return data;
}

export const HK_TASK_METADATA_KEY = ["housekeeping-tasks", "metadata"] as const;

export function useHousekeepingTaskMetadata() {
  return useQuery({
    queryKey: HK_TASK_METADATA_KEY,
    queryFn: fetchOpenTasksWithMetadata,
    staleTime: 10_000,
  });
}

function invalidateAssignmentQueries(qc: QueryClient, userId?: string) {
  return Promise.all([
    qc.refetchQueries({ queryKey: HOUSEKEEPING_BOARD_KEY }),
    qc.refetchQueries({ queryKey: HK_TASK_METADATA_KEY }),
    qc.refetchQueries({ queryKey: ["housekeeping-tasks", "pending"] }),
    userId
      ? qc.refetchQueries({ queryKey: housekeepingMyTasksKey(userId) })
      : Promise.resolve(),
    userId
      ? qc.refetchQueries({ queryKey: ["housekeeping-tasks", "proposed", userId] })
      : Promise.resolve(),
  ]);
}

export function useProposeHousekeepingAssignment(userId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { taskId: string; proposedAssignee: string; proposedBy: string }) =>
      proposeHousekeepingAssignment(vars.taskId, vars.proposedAssignee, vars.proposedBy),
    onSuccess: async () => {
      await invalidateAssignmentQueries(qc, userId);
    },
  });
}

export function useAcceptHousekeepingAssignment(userId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => acceptHousekeepingAssignment(taskId),
    onSuccess: async () => {
      await invalidateAssignmentQueries(qc, userId);
    },
  });
}

export function useDeclineHousekeepingAssignment(userId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => clearHousekeepingAssignmentProposal(taskId),
    onSuccess: async () => {
      await invalidateAssignmentQueries(qc, userId);
    },
  });
}

export function useProposedHousekeepingTasks(userId: string | undefined) {
  return useQuery({
    queryKey: ["housekeeping-tasks", "proposed", userId ?? ""] as const,
    queryFn: () => fetchProposedHousekeepingTasks(userId!),
    enabled: !!userId,
    staleTime: 10_000,
  });
}
