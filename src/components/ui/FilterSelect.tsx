import type { ComponentPropsWithoutRef } from "react";
import { ChevronDown } from "lucide-react";

type NativeSelectProps = ComponentPropsWithoutRef<"select">;

/** Dark minimal select with chevron (matches admin-table filter row). */
export function FilterSelect({ className = "", children, ...props }: NativeSelectProps) {
  return (
    <div className="relative min-w-0">
      <select
        className={[
          "fdn-select input-field w-full cursor-pointer appearance-none pr-9",
          className,
        ].join(" ")}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]"
        aria-hidden
      />
    </div>
  );
}
