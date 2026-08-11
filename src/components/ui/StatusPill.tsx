import { statusPillClass } from "@/lib/reservationStatusUi";

export function StatusPill({ label }: { label: string }) {
  return (
    <span
      className={`inline-flex max-w-full items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusPillClass(label)}`}
    >
      {label}
    </span>
  );
}

/** `hit` true → "True" (green); false → "False" (red). */
export function DnrPill({ hit }: { hit: boolean }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        hit
          ? "border-emerald-500/45 bg-emerald-500/[0.14] text-emerald-900 dark:text-emerald-200"
          : "border-red-500/40 bg-red-500/12 text-red-900 dark:text-red-300"
      }`}
    >
      {hit ? "True" : "False"}
    </span>
  );
}
