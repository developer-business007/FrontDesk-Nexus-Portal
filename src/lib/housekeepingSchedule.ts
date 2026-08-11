import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { HOUSEKEEPING_BOARD_KEY, housekeepingMyTasksKey } from "@/lib/housekeeping";
import type { HkAreaFeedback, HkDailySchedule, HkFeedbackType } from "@/types/housekeeping";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export function hkScheduleKey(date: string) {
  return ["hk-daily-schedules", date] as const;
}

export const HK_AREA_SUGGESTIONS_KEY = ["hk-area-suggestions"] as const;

export function hkFeedbackKey(since?: string) {
  return ["hk-area-feedback", since ?? "all"] as const;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive floor number from a room string (e.g. "204" → 2, "1012" → 10). */
export function floorFromRoom(room: string): number {
  const digits = room.replace(/\D/g, "");
  const n = parseInt(digits, 10);
  if (!isFinite(n) || n < 100) return 1;
  return Math.floor(n / 100);
}

function yesterdayIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchDailySchedules(date: string): Promise<HkDailySchedule[]> {
  const { data, error } = await supabase
    .from("hk_daily_schedules")
    .select("*, housekeeper:profiles!hk_daily_schedules_housekeeper_id_fkey(id, full_name, email, role)")
    .eq("schedule_date", date)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as HkDailySchedule[];
}

export async function fetchMyScheduleForDate(
  userId: string,
  date: string,
): Promise<HkDailySchedule | null> {
  const { data, error } = await supabase
    .from("hk_daily_schedules")
    .select("*")
    .eq("schedule_date", date)
    .eq("housekeeper_id", userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as HkDailySchedule | null) ?? null;
}

export function useDailySchedules(date: string) {
  return useQuery({
    queryKey: hkScheduleKey(date),
    queryFn: () => fetchDailySchedules(date),
    staleTime: 15_000,
  });
}

export function useMyDailySchedule(userId: string | undefined, date: string) {
  return useQuery({
    queryKey: ["hk-my-schedule", userId ?? "", date] as const,
    queryFn: () => fetchMyScheduleForDate(userId!, date),
    enabled: !!userId,
    staleTime: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Area suggestions (14-day history + yesterday continuity boost)
// ---------------------------------------------------------------------------

export type AreaSuggestion = {
  housekeeper_id: string;
  floor: number;
  cleanCount: number;
  complaintCount: number;
  /** Yesterday worked this floor with zero complaints — prefer same area next day. */
  continuityBoost: boolean;
  /** Higher is better. */
  score: number;
};

export async function fetchAreaSuggestions(lookbackDays = 14): Promise<AreaSuggestion[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const yDay = yesterdayIso();

  const [tasksRes, feedbackRes, yesterdaySchedulesRes] = await Promise.all([
    supabase
      .from("housekeeping_tasks")
      .select("assigned_to, room_number")
      .eq("status", "completed")
      .gte("completed_at", since)
      .not("assigned_to", "is", null),
    supabase
      .from("hk_area_feedback")
      .select("housekeeper_id, room_number, feedback_type, feedback_date, created_at")
      .gte("created_at", since)
      .not("housekeeper_id", "is", null),
    supabase
      .from("hk_daily_schedules")
      .select("housekeeper_id, assigned_rooms")
      .eq("schedule_date", yDay),
  ]);

  if (tasksRes.error) throw new Error(tasksRes.error.message);

  const complaintRows = feedbackRes.error
    ? []
    : ((feedbackRes.data ?? []) as Array<{
        housekeeper_id: string | null;
        room_number: string;
        feedback_type: string;
        feedback_date: string;
        created_at: string;
      }>).filter((f) => f.feedback_type === "complaint");

  const cleanCounts = new Map<string, number>();
  for (const t of tasksRes.data ?? []) {
    const floor = floorFromRoom(String(t.room_number));
    const key = `${t.assigned_to}|${floor}`;
    cleanCounts.set(key, (cleanCounts.get(key) ?? 0) + 1);
  }

  const complaintCounts = new Map<string, number>();
  const yesterdayComplaints = new Set<string>();
  for (const f of complaintRows) {
    if (!f.housekeeper_id) continue;
    const floor = floorFromRoom(String(f.room_number));
    const key = `${f.housekeeper_id}|${floor}`;
    complaintCounts.set(key, (complaintCounts.get(key) ?? 0) + 1);
    if (f.feedback_date === yDay || f.created_at?.slice(0, 10) === yDay) {
      yesterdayComplaints.add(key);
    }
  }

  const continuityKeys = new Set<string>();
  if (!yesterdaySchedulesRes.error) {
    for (const s of yesterdaySchedulesRes.data ?? []) {
      const floorsWorked = new Set<number>();
      for (const room of s.assigned_rooms ?? []) {
        floorsWorked.add(floorFromRoom(String(room)));
      }
      for (const floor of floorsWorked) {
        const key = `${s.housekeeper_id}|${floor}`;
        if (!yesterdayComplaints.has(key)) {
          continuityKeys.add(key);
        }
      }
    }
  }

  const results: AreaSuggestion[] = [];
  const seen = new Set<string>();

  for (const [key, cleanCount] of cleanCounts) {
    seen.add(key);
    const [housekeeper_id, floorStr] = key.split("|");
    const floor = parseInt(floorStr, 10);
    const complaintCount = complaintCounts.get(key) ?? 0;
    const continuityBoost = continuityKeys.has(key);
    const score = cleanCount - complaintCount * 3 + (continuityBoost ? 5 : 0);
    results.push({ housekeeper_id, floor, cleanCount, complaintCount, continuityBoost, score });
  }

  for (const key of continuityKeys) {
    if (seen.has(key)) continue;
    const [housekeeper_id, floorStr] = key.split("|");
    const floor = parseInt(floorStr, 10);
    results.push({
      housekeeper_id,
      floor,
      cleanCount: 0,
      complaintCount: 0,
      continuityBoost: true,
      score: 5,
    });
  }

  return results.sort(
    (a, b) => b.score - a.score || b.cleanCount - a.cleanCount || (b.continuityBoost ? 1 : 0) - (a.continuityBoost ? 1 : 0),
  );
}

export function useAreaSuggestions() {
  return useQuery({
    queryKey: HK_AREA_SUGGESTIONS_KEY,
    queryFn: () => fetchAreaSuggestions(),
    staleTime: 5 * 60_000,
  });
}

export function bestSuggestionForFloor(
  suggestions: AreaSuggestion[],
  floor: number,
): AreaSuggestion | null {
  const matches = suggestions.filter((s) => s.floor === floor && s.score > 0);
  return matches[0] ?? null;
}

// ---------------------------------------------------------------------------
// Apply schedule → board tasks
// ---------------------------------------------------------------------------

export type ApplyScheduleResult = {
  schedule_date: string;
  assigned: number;
  created: number;
  skipped: number;
  details: Array<{
    room: string;
    action: string;
    reason?: string;
    task_id?: string;
    housekeeper_id?: string;
  }>;
};

export async function applyDailySchedule(
  scheduleDate: string,
  forceReassign = false,
): Promise<ApplyScheduleResult> {
  const { data, error } = await supabase.rpc("hk_apply_daily_schedule", {
    p_schedule_date: scheduleDate,
    p_force_reassign: forceReassign,
  });
  if (error) throw new Error(error.message);
  return data as ApplyScheduleResult;
}

export function useApplyDailySchedule(date: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ forceReassign = false }: { forceReassign?: boolean } = {}) =>
      applyDailySchedule(date, forceReassign),
    onSuccess: async () => {
      await Promise.all([
        qc.refetchQueries({ queryKey: hkScheduleKey(date) }),
        qc.refetchQueries({ queryKey: HOUSEKEEPING_BOARD_KEY }),
        qc.refetchQueries({ queryKey: ["housekeeping-tasks"] }),
      ]);
    },
  });
}

// ---------------------------------------------------------------------------
// Area feedback
// ---------------------------------------------------------------------------

export async function recordAreaFeedback(params: {
  roomNumber: string;
  feedbackType?: HkFeedbackType;
  description?: string | null;
  housekeeperId?: string | null;
  taskId?: string | null;
  feedbackDate?: string;
}): Promise<HkAreaFeedback> {
  const { data, error } = await supabase.rpc("hk_record_area_feedback", {
    p_room_number: params.roomNumber,
    p_feedback_type: params.feedbackType ?? "complaint",
    p_description: params.description ?? null,
    p_housekeeper_id: params.housekeeperId ?? null,
    p_task_id: params.taskId ?? null,
    p_feedback_date: params.feedbackDate ?? new Date().toISOString().slice(0, 10),
  });
  if (error) throw new Error(error.message);
  return data as HkAreaFeedback;
}

export async function fetchRecentAreaFeedback(limit = 50): Promise<HkAreaFeedback[]> {
  const { data, error } = await supabase
    .from("hk_area_feedback")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as HkAreaFeedback[];
}

export function useRecordAreaFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: recordAreaFeedback,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: HK_AREA_SUGGESTIONS_KEY });
      void qc.invalidateQueries({ queryKey: hkFeedbackKey() });
    },
  });
}

export function useRecentAreaFeedback(limit = 50) {
  return useQuery({
    queryKey: [...hkFeedbackKey(), limit] as const,
    queryFn: () => fetchRecentAreaFeedback(limit),
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Schedule CRUD
// ---------------------------------------------------------------------------

export async function upsertDailySchedule(
  schedule_date: string,
  housekeeper_id: string,
  assigned_rooms: string[],
  notes: string | null,
  created_by: string | null,
): Promise<HkDailySchedule> {
  const { data, error } = await supabase
    .from("hk_daily_schedules")
    .upsert(
      {
        schedule_date,
        housekeeper_id,
        assigned_rooms,
        notes,
        created_by,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "schedule_date,housekeeper_id" },
    )
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data as HkDailySchedule;
}

export async function deleteDailySchedule(id: string): Promise<void> {
  const { error } = await supabase.from("hk_daily_schedules").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export function useUpsertDailySchedule(date: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      housekeeper_id,
      assigned_rooms,
      notes,
      created_by,
    }: {
      housekeeper_id: string;
      assigned_rooms: string[];
      notes?: string | null;
      created_by?: string | null;
    }) =>
      upsertDailySchedule(date, housekeeper_id, assigned_rooms, notes ?? null, created_by ?? null),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: hkScheduleKey(date) });
      void qc.invalidateQueries({ queryKey: HOUSEKEEPING_BOARD_KEY });
      void qc.invalidateQueries({ queryKey: ["housekeeping-tasks"] });
      if (vars.created_by) {
        void qc.invalidateQueries({ queryKey: housekeepingMyTasksKey(vars.housekeeper_id) });
        void qc.invalidateQueries({ queryKey: ["hk-my-schedule", vars.housekeeper_id, date] });
      }
    },
  });
}

export function useDeleteDailySchedule(date: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteDailySchedule(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hkScheduleKey(date) });
    },
  });
}
