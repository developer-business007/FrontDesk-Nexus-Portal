export function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="mx-auto max-w-2xl rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-left">
      <h1 className="page-title">{title}</h1>
      <p className="mt-2 text-sm text-[var(--text-muted)]">Coming soon — scaffold only for this sprint.</p>
    </div>
  );
}
