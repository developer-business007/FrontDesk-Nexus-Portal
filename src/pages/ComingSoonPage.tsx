type ComingSoonPageProps = {
  title: string;
  description: string;
  bullets?: string[];
};

export function ComingSoonPage({ title, description, bullets }: ComingSoonPageProps) {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-10 sm:px-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--accent)]">
          Coming soon
        </p>
        <h1 className="page-title mt-2">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--text)]">{description}</p>
        {bullets?.length ? (
          <ul className="mt-5 list-disc space-y-2 pl-5 text-sm text-[var(--text-muted)]">
            {bullets.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/** Operational reports & KPIs (Milestone 6). */
export function ReportsComingSoonPage() {
  return (
    <ComingSoonPage
      title="Reports"
      description="Operational analytics and KPI dashboards are planned for a future release. Housekeeping, maintenance, and front-desk metrics will appear here."
      bullets={[
        "Room turnover and housekeeping productivity",
        "Maintenance backlog and recurring issues",
        "Occupancy and operational bottlenecks",
        "Exportable summaries for management",
      ]}
    />
  );
}

/** Cash automation is out of scope for this project phase. */
export function CashComingSoonPage() {
  return (
    <ComingSoonPage
      title="Cash"
      description="Spectral payout / cash automation is not included in the current build. Front desk cash handling stays outside this portal for now."
      bullets={[
        "Guest deposits and change dispensing",
        "Machine reconciliation",
        "PMS balance sync",
      ]}
    />
  );
}
