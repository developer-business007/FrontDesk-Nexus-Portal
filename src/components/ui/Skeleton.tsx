export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={[
        "animate-pulse rounded-md bg-[var(--surface-3)]",
        className,
      ].join(" ")}
      aria-hidden
    />
  );
}
