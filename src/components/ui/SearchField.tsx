import type { ComponentPropsWithoutRef } from "react";
import { Search } from "lucide-react";

type InputProps = Omit<ComponentPropsWithoutRef<"input">, "type">;

/**
 * Search-style text field with a leading icon **outside** the input
 * (avoids overlap with native `type="search"` decorations in some browsers).
 */
export function SearchField({ className = "", id, ...props }: InputProps) {
  return (
    <div
      className={[
        "flex h-9 min-w-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 transition-[border-color] duration-200",
        "focus-within:border-[var(--accent-border)]",
        className,
      ].join(" ")}
    >
      <Search
        className="block h-4 w-4 shrink-0 text-[var(--text-muted)]"
        strokeWidth={2}
        aria-hidden
      />
      <input
        id={id}
        type="text"
        inputMode="search"
        autoComplete="off"
        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] leading-normal text-[var(--text-h)] outline-none placeholder:text-[var(--text-muted)]"
        {...props}
      />
    </div>
  );
}
