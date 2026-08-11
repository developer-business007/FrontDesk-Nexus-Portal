import type { HkTaskStatus, HkTaskType } from "@/types/housekeeping";

export type HkPriorityLevel = "high" | "medium" | "low";

const TONE_BASE =
  "font-medium transition-colors dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]";

export function priorityLevel(priority: number): HkPriorityLevel {
  if (priority >= 80) return "high";
  if (priority >= 55) return "medium";
  return "low";
}

export function priorityLabel(priority: number): string {
  const level = priorityLevel(priority);
  if (level === "high") return "High";
  if (level === "medium") return "Medium";
  return "Low";
}

/** Row wash + left accent — strongest signal wins (overdue > guest blocked > status/priority). */
export function bulkEditRowClass(input: {
  status: HkTaskStatus;
  priority: number;
  overdue: boolean;
  guestBlocked: boolean;
  unassigned: boolean;
}): string {
  const { status, priority, overdue, guestBlocked, unassigned } = input;

  if (overdue) return "bulk-edit-row bulk-edit-row--overdue";
  if (guestBlocked) return "bulk-edit-row bulk-edit-row--guest";
  if (priorityLevel(priority) === "high" && (status === "pending" || status === "assigned")) {
    return "bulk-edit-row bulk-edit-row--priority-high";
  }
  if (unassigned && status === "pending") return "bulk-edit-row bulk-edit-row--unassigned";
  if (status === "in_progress") return "bulk-edit-row bulk-edit-row--in-progress";
  if (status === "inspection_pending") return "bulk-edit-row bulk-edit-row--inspection";
  if (status === "assigned") return "bulk-edit-row bulk-edit-row--assigned";
  return "bulk-edit-row";
}

export function bulkEditPrioritySelectClass(priority: number): string {
  const level = priorityLevel(priority);
  if (level === "high") {
    return `${TONE_BASE} border-red-400/85 bg-red-50 text-red-950 dark:border-red-500/60 dark:bg-red-500/18 dark:text-red-100`;
  }
  if (level === "medium") {
    return `${TONE_BASE} border-amber-400/85 bg-amber-50 text-amber-950 dark:border-amber-500/55 dark:bg-amber-500/16 dark:text-amber-100`;
  }
  return `${TONE_BASE} border-emerald-400/70 bg-emerald-50/90 text-emerald-950 dark:border-emerald-500/45 dark:bg-emerald-500/12 dark:text-emerald-100`;
}

export function bulkEditStatusSelectClass(status: HkTaskStatus, overdue: boolean): string {
  if (overdue) {
    return `${TONE_BASE} border-red-400/85 bg-red-50 text-red-950 dark:border-red-500/60 dark:bg-red-500/18 dark:text-red-100`;
  }
  switch (status) {
    case "in_progress":
      return `${TONE_BASE} border-sky-500/80 bg-sky-100 text-sky-950 dark:border-sky-400/55 dark:bg-sky-500/22 dark:text-sky-50`;
    case "assigned":
      return `${TONE_BASE} border-sky-400/80 bg-sky-50 text-sky-950 dark:border-sky-500/50 dark:bg-sky-500/14 dark:text-sky-100`;
    case "inspection_pending":
      return `${TONE_BASE} border-violet-400/80 bg-violet-50 text-violet-950 dark:border-violet-500/55 dark:bg-violet-500/16 dark:text-violet-100`;
    case "pending":
    default:
      return `${TONE_BASE} border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-h)]`;
  }
}

export function bulkEditAssigneeSelectClass(assignedTo: string | null): string {
  if (!assignedTo) {
    return `${TONE_BASE} border-amber-400/80 bg-amber-50 text-amber-950 dark:border-amber-500/55 dark:bg-amber-500/14 dark:text-amber-100`;
  }
  return `${TONE_BASE} border-[var(--border)] bg-[var(--surface)] text-[var(--text-h)]`;
}

export function bulkEditCheckoutClass(overdue: boolean, dueAt: string | null): string {
  if (overdue) {
    return `${TONE_BASE} border-red-400/85 bg-red-50 text-red-700 dark:border-red-500/60 dark:bg-red-500/18 dark:text-red-200`;
  }
  if (dueAt) {
    const ms = new Date(dueAt).getTime() - Date.now();
    if (ms > 0 && ms < 2 * 60 * 60 * 1000) {
      return `${TONE_BASE} border-amber-400/75 bg-amber-50/80 text-amber-950 dark:border-amber-500/50 dark:bg-amber-500/12 dark:text-amber-100`;
    }
  }
  return "";
}

export function bulkEditTypeClass(taskType: HkTaskType): string {
  switch (taskType) {
    case "checkout_turnover":
      return "bulk-edit-type bulk-edit-type--turnover";
    case "deep_clean":
      return "bulk-edit-type bulk-edit-type--deep";
    case "touch_up":
      return "bulk-edit-type bulk-edit-type--touch-up";
    case "inspection_only":
      return "bulk-edit-type bulk-edit-type--inspection";
    default:
      return "bulk-edit-type";
  }
}

export const BULK_EDIT_LEGEND = [
  { className: "bulk-edit-legend__swatch bulk-edit-legend__swatch--overdue", label: "Overdue checkout" },
  { className: "bulk-edit-legend__swatch bulk-edit-legend__swatch--guest", label: "Guest in room" },
  { className: "bulk-edit-legend__swatch bulk-edit-legend__swatch--priority-high", label: "High priority" },
  { className: "bulk-edit-legend__swatch bulk-edit-legend__swatch--unassigned", label: "Unassigned" },
  { className: "bulk-edit-legend__swatch bulk-edit-legend__swatch--in-progress", label: "In progress" },
  { className: "bulk-edit-legend__swatch bulk-edit-legend__swatch--inspection", label: "Awaiting inspection" },
] as const;
