function normalizeStatusKey(status: string) {
  return status.toLowerCase().replace(/\s+/g, "_");
}

/**
 * Table: reservation_status pills.
 *
 * Translucent backgrounds (e.g. `bg-amber-500/[0.12]`) read on both themes,
 * but the original `text-*-200` shades disappear on white — so we pair them
 * with darker `text-*-900` defaults and a `dark:text-*-200` override.
 */
const statusSurface: Record<string, string> = {
  pending:
    "border-amber-500/45 bg-amber-500/[0.12] text-amber-900 dark:text-amber-200",
  checked_in:
    "border-emerald-500/45 bg-emerald-500/[0.14] text-emerald-900 dark:text-emerald-200",
  checked_out:
    "border-slate-500/45 bg-slate-600/20 text-slate-900 dark:text-slate-200",
};

const statusFallback =
  "border-sky-500/40 bg-sky-500/12 text-sky-900 dark:text-sky-200";

export function statusPillClass(status: string): string {
  const key = normalizeStatusKey(status);
  return statusSurface[key] ?? statusFallback;
}

/** Softer panel behind status control in forms. */
export function statusModalPanelClass(status: string): string {
  const key = normalizeStatusKey(status);
  if (key === "pending") return "border-amber-500/40 bg-amber-500/[0.08]";
  if (key === "checked_in") return "border-emerald-500/40 bg-emerald-500/[0.1]";
  if (key === "checked_out") return "border-slate-500/40 bg-slate-500/15";
  return "border-[var(--border)] bg-[var(--surface-2)]";
}

/** DNR true = green, false = red (matches table pills). */
export function dnrModalPanelClass(hit: boolean): string {
  return hit
    ? "border-emerald-500/40 bg-emerald-500/[0.1]"
    : "border-red-500/35 bg-red-500/10";
}
