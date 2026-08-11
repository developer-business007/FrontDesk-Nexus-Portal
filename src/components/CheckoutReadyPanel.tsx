import { Link } from "react-router-dom";
import { LogOut } from "lucide-react";
import type { DashboardGuestRow } from "@/lib/dashboardGuestMerge";
import {
  checkoutReadyTone,
  formatCheckoutReadyLabel,
  type CheckoutReadyKind,
} from "@/lib/checkoutReadyAlerts";

function countDepartureReady(departures: DashboardGuestRow[]) {
  const ready = departures.filter((d) => d.readyKind === "ready").length;
  return { ready, notReady: departures.length - ready, total: departures.length };
}

const TONE_CLASS: Record<
  ReturnType<typeof checkoutReadyTone>,
  string
> = {
  emerald:
    "border-emerald-400/70 bg-emerald-100 text-emerald-950 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-100",
  sky: "border-sky-400/70 bg-sky-100 text-sky-950 dark:border-sky-500/50 dark:bg-sky-500/15 dark:text-sky-100",
  amber:
    "border-amber-400/70 bg-amber-100 text-amber-950 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-100",
  violet:
    "border-violet-400/70 bg-violet-100 text-violet-950 dark:border-violet-500/50 dark:bg-violet-500/15 dark:text-violet-100",
  red: "border-red-400/70 bg-red-100 text-red-950 dark:border-red-500/50 dark:bg-red-500/15 dark:text-red-100",
  slate: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-h)]",
};

function ReadyBadge({ kind }: { kind: CheckoutReadyKind }) {
  const tone = checkoutReadyTone(kind);
  return (
    <span
      className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${TONE_CLASS[tone]}`}
    >
      {formatCheckoutReadyLabel(kind)}
    </span>
  );
}

export function CheckoutReadyPanel({
  departures,
  hotelDate,
}: {
  departures: DashboardGuestRow[];
  hotelDate: string;
}) {
  const counts = countDepartureReady(departures);

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <LogOut className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden />
            <h2 className="text-lg font-semibold text-[var(--text-h)]">Checkout-ready alerts</h2>
          </div>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            DualPMS departures ({hotelDate}) with live room turnover status.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-[12px]">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/80 bg-emerald-50/80 px-2.5 py-1 font-medium text-emerald-950 dark:border-emerald-900/40 dark:bg-emerald-950/25 dark:text-emerald-100">
            Ready
            <span className="font-semibold tabular-nums">{counts.ready}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/80 bg-amber-50/80 px-2.5 py-1 font-medium text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/25 dark:text-amber-100">
            Not ready
            <span className="font-semibold tabular-nums">{counts.notReady}</span>
          </span>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-xl border border-[var(--border)]">
        {departures.length === 0 ? (
          <p className="p-6 text-center text-sm text-[var(--text-muted)]">
            No verified departures for this hotel date.
          </p>
        ) : (
          <table className="data-table min-w-full text-left text-sm">
            <thead>
              <tr>
                <th scope="col">Checkout</th>
                <th scope="col">Guest</th>
                <th scope="col">Room</th>
                <th scope="col">Turnover</th>
                <th scope="col">Conf.</th>
              </tr>
            </thead>
            <tbody>
              {departures.map((row) => (
                <tr
                  key={row.key}
                  className={
                    row.readyKind === "ready"
                      ? "bg-emerald-500/[0.04]"
                      : row.readyKind === "occupied" || row.readyKind === "dirty"
                        ? "bg-amber-500/[0.05]"
                        : undefined
                  }
                >
                  <td className="whitespace-nowrap font-medium tabular-nums text-[var(--text-h)]">
                    {row.checkoutLabel ?? "—"}
                  </td>
                  <td className="font-medium text-[var(--text-h)]">{row.guestName}</td>
                  <td className="whitespace-nowrap font-mono text-[var(--text-h)]">{row.roomNumber}</td>
                  <td>
                    {row.readyKind ? <ReadyBadge kind={row.readyKind} /> : null}
                  </td>
                  <td className="whitespace-nowrap">
                    {row.confirmationNumber ? (
                      <Link
                        to={`/guest/${encodeURIComponent(row.confirmationNumber)}${row.pmsSource ? `?pms=${encodeURIComponent(row.pmsSource)}` : ""}`}
                        className="font-mono text-[var(--accent)] hover:underline"
                      >
                        {row.confirmationNumber}
                      </Link>
                    ) : (
                      <span className="text-[var(--text-muted)]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

export function CheckoutReadyDepartureBadge({ kind }: { kind: CheckoutReadyKind | null | undefined }) {
  if (!kind || kind === "unknown") return null;
  return <ReadyBadge kind={kind} />;
}
