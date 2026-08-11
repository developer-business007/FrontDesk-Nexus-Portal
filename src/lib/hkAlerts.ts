import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HK_RA_MONITOR_KEY } from "@/lib/hkRaMonitor";
import { HOUSEKEEPING_BOARD_KEY } from "@/lib/housekeeping";
import { supabase } from "@/lib/supabase";
import type { HkAlert, HkAlertPriority, HkAlertStatus } from "@/types/housekeeping";

export const HK_ALERTS_KEY = ["hk-alerts"] as const;

export const HK_ALERT_DUTY_OPTIONS = [
  "Urgent clean",
  "Extra towels",
  "Maintenance issue",
  "Guest complaint",
  "Pet room",
  "Late checkout",
  "Other",
] as const;

export const HK_ALERT_PRIORITY_OPTIONS: { value: HkAlertPriority; label: string }[] = [
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

export const HK_ALERT_STATUS_LABELS: Record<HkAlertStatus, string> = {
  open: "Open",
  assigned: "Assigned",
  resolved: "Resolved",
  cancelled: "Cancelled",
};

const ALERT_SELECT = "*";

function isMissingTableError(message: string): boolean {
  return /does not exist|schema cache|hk_alerts/i.test(message);
}

export async function fetchOpenHkAlerts(hotelDate?: string): Promise<HkAlert[]> {
  let q = supabase
    .from("hk_alerts")
    .select(ALERT_SELECT)
    .in("status", ["open", "assigned"])
    .order("created_at", { ascending: false });

  if (hotelDate) q = q.eq("hotel_date", hotelDate);

  const { data, error } = await q;
  if (error) {
    if (isMissingTableError(error.message)) {
      console.warn("[hk-alerts] table not ready:", error.message);
      return [];
    }
    throw new Error(error.message);
  }
  return (data ?? []) as HkAlert[];
}

export async function fetchHkAlerts(options?: {
  hotelDate?: string;
  status?: HkAlertStatus | "active" | "all";
}): Promise<HkAlert[]> {
  let q = supabase.from("hk_alerts").select(ALERT_SELECT).order("created_at", { ascending: false });

  if (options?.hotelDate) q = q.eq("hotel_date", options.hotelDate);
  if (options?.status === "active") q = q.in("status", ["open", "assigned"]);
  else if (options?.status && options.status !== "all") q = q.eq("status", options.status);

  const { data, error } = await q.limit(500);
  if (error) {
    if (isMissingTableError(error.message)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as HkAlert[];
}

export function useHkAlerts(options?: {
  hotelDate?: string;
  status?: HkAlertStatus | "active" | "all";
}) {
  return useQuery({
    queryKey: [...HK_ALERTS_KEY, options?.hotelDate ?? "all", options?.status ?? "active"] as const,
    queryFn: () => fetchHkAlerts(options),
    staleTime: 10_000,
    refetchInterval: 20_000,
  });
}

export function useOpenHkAlerts(hotelDate?: string) {
  return useQuery({
    queryKey: [...HK_ALERTS_KEY, "open", hotelDate ?? "all"] as const,
    queryFn: () => fetchOpenHkAlerts(hotelDate),
    staleTime: 10_000,
    refetchInterval: 20_000,
  });
}

export async function createHkAlert(input: {
  roomNumber: string;
  duty: string;
  description: string;
  priority: HkAlertPriority;
  hotelDate: string;
  createdBy: string;
  assignedTo?: string | null;
}): Promise<HkAlert> {
  const status: HkAlertStatus = input.assignedTo ? "assigned" : "open";
  const { data, error } = await supabase
    .from("hk_alerts")
    .insert({
      room_number: input.roomNumber.trim(),
      duty: input.duty.trim(),
      description: input.description.trim(),
      priority: input.priority,
      status,
      assigned_to: input.assignedTo ?? null,
      created_by: input.createdBy,
      hotel_date: input.hotelDate,
    })
    .select(ALERT_SELECT)
    .single();

  if (error) throw new Error(error.message);
  return data as HkAlert;
}

export async function updateHkAlert(
  id: string,
  patch: Partial<{
    duty: string;
    description: string;
    priority: HkAlertPriority;
    status: HkAlertStatus;
    assignedTo: string | null;
    resolvedBy: string | null;
  }>,
): Promise<HkAlert> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.duty !== undefined) updates.duty = patch.duty;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.priority !== undefined) updates.priority = patch.priority;
  if (patch.assignedTo !== undefined) {
    updates.assigned_to = patch.assignedTo;
    if (patch.assignedTo && patch.status === undefined) updates.status = "assigned";
    if (!patch.assignedTo && patch.status === undefined) updates.status = "open";
  }
  if (patch.status !== undefined) {
    updates.status = patch.status;
    if (patch.status === "resolved" || patch.status === "cancelled") {
      updates.resolved_at = new Date().toISOString();
      updates.resolved_by = patch.resolvedBy ?? null;
    }
  }

  const { data, error } = await supabase
    .from("hk_alerts")
    .update(updates)
    .eq("id", id)
    .select(ALERT_SELECT)
    .single();

  if (error) throw new Error(error.message);
  return data as HkAlert;
}

function invalidateAlertQueries(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: HK_ALERTS_KEY });
  void qc.invalidateQueries({ queryKey: HK_RA_MONITOR_KEY });
  void qc.invalidateQueries({ queryKey: HOUSEKEEPING_BOARD_KEY });
}

export function useCreateHkAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createHkAlert,
    onSuccess: () => invalidateAlertQueries(qc),
  });
}

export function useUpdateHkAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Parameters<typeof updateHkAlert>[1];
    }) => updateHkAlert(id, patch),
    onSuccess: () => invalidateAlertQueries(qc),
  });
}

export function alertPriorityClass(priority: HkAlertPriority): string {
  switch (priority) {
    case "urgent":
    case "high":
      return "border-red-400/80 bg-red-50 text-red-950 dark:border-red-500/55 dark:bg-red-500/15 dark:text-red-100";
    case "medium":
      return "border-amber-400/80 bg-amber-50 text-amber-950 dark:border-amber-500/55 dark:bg-amber-500/15 dark:text-amber-100";
    default:
      return "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-h)]";
  }
}

export function alertStatusClass(status: HkAlertStatus): string {
  switch (status) {
    case "open":
      return "border-red-400/70 bg-red-100 text-red-950 dark:border-red-500/50 dark:bg-red-500/15 dark:text-red-100";
    case "assigned":
      return "border-sky-400/70 bg-sky-100 text-sky-950 dark:border-sky-500/50 dark:bg-sky-500/15 dark:text-sky-100";
    case "resolved":
      return "border-emerald-400/70 bg-emerald-100 text-emerald-950 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-100";
    default:
      return "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]";
  }
}

export function openAlertsByRoom(alerts: HkAlert[]): Map<string, HkAlert[]> {
  const m = new Map<string, HkAlert[]>();
  for (const a of alerts) {
    const room = a.room_number.trim();
    const list = m.get(room) ?? [];
    list.push(a);
    m.set(room, list);
  }
  return m;
}
