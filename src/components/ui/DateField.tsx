import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import {
  buildMonthGridCells,
  dateToIsoLocal,
  formatIsoForDisplay,
  isSameLocalDay,
  isTodayLocal,
  parseIsoLocal,
} from "@/lib/dateIso";

const WEEKDAY_LABELS = (() => {
  const base = new Date(2024, 0, 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    return new Intl.DateTimeFormat(undefined, { weekday: "narrow" }).format(d);
  });
})();

export type DateFieldProps = {
  value: string;
  onChange: (isoYmd: string) => void;
  id?: string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  "aria-label"?: string;
};

export function DateField({
  value,
  onChange,
  id: idProp,
  className = "",
  disabled,
  placeholder = "Select date",
  "aria-label": ariaLabel,
}: DateFieldProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const selected = value ? parseIsoLocal(value) : null;
  const initialCursor = selected ?? new Date();
  const [cursorYear, setCursorYear] = useState(initialCursor.getFullYear());
  const [cursorMonth, setCursorMonth] = useState(initialCursor.getMonth());

  const syncCursorFromValue = useCallback(() => {
    const d = value ? parseIsoLocal(value) : new Date();
    if (d) {
      setCursorYear(d.getFullYear());
      setCursorMonth(d.getMonth());
    }
  }, [value]);

  useEffect(() => {
    if (!open) return;
    syncCursorFromValue();
  }, [open, syncCursorFromValue]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const cells = useMemo(
    () => buildMonthGridCells(cursorYear, cursorMonth),
    [cursorYear, cursorMonth],
  );

  const monthTitle = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
        new Date(cursorYear, cursorMonth, 1),
      );
    } catch {
      return `${cursorYear}-${cursorMonth + 1}`;
    }
  }, [cursorYear, cursorMonth]);

  function prevMonth() {
    setCursorMonth((m) => {
      if (m <= 0) {
        setCursorYear((y) => y - 1);
        return 11;
      }
      return m - 1;
    });
  }

  function nextMonth() {
    setCursorMonth((m) => {
      if (m >= 11) {
        setCursorYear((y) => y + 1);
        return 0;
      }
      return m + 1;
    });
  }

  function pickDay(d: Date) {
    onChange(dateToIsoLocal(d));
    setOpen(false);
  }

  function clearDate() {
    onChange("");
    setOpen(false);
  }

  function pickToday() {
    onChange(dateToIsoLocal(new Date()));
    setOpen(false);
  }

  const display = selected ? formatIsoForDisplay(value) : "";

  return (
    <div ref={wrapRef} className={`relative ${className}`.trim()}>
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          if (disabled) return;
          setOpen((o) => !o);
        }}
        className="input-field flex h-9 w-full items-center justify-between gap-2 whitespace-nowrap text-left disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className={display ? "text-[var(--text-h)]" : "text-[var(--text-muted)]"}>
          {display || placeholder}
        </span>
        <CalendarIcon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
      </button>

      {open && !disabled ? (
        <div
          role="dialog"
          aria-label="Choose date"
          className="absolute left-0 top-[calc(100%+0.25rem)] z-50 w-[min(100vw-1.5rem,18.5rem)] rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <button
              type="button"
              className="icon-btn shrink-0"
              aria-label="Previous month"
              onClick={prevMonth}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-0 flex-1 text-center text-sm font-semibold tracking-tight text-[var(--text-h)]">
              {monthTitle}
            </span>
            <button
              type="button"
              className="icon-btn shrink-0"
              aria-label="Next month"
              onClick={nextMonth}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-0.5 text-center text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {WEEKDAY_LABELS.map((w) => (
              <div key={w} className="py-1">
                {w}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5">
            {cells.map(({ date, inMonth }, i) => {
              const sel = selected && isSameLocalDay(date, selected);
              const today = isTodayLocal(date);
              return (
                <button
                  key={`${date.getTime()}-${i}`}
                  type="button"
                  onClick={() => pickDay(date)}
                  className={[
                    "relative flex aspect-square max-h-9 items-center justify-center rounded-lg text-sm font-medium transition-colors",
                    inMonth ? "text-[var(--text-h)]" : "text-[var(--text-muted)] opacity-45",
                    sel
                      ? "bg-[var(--accent)] text-[#042f1f]"
                      : "hover:bg-[var(--surface-3)]",
                    !sel && today ? "ring-1 ring-[var(--accent-border)] ring-inset" : "",
                  ].join(" ")}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--border)] pt-3 text-xs font-medium">
            <button
              type="button"
              className="rounded-md px-2 py-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-h)]"
              onClick={clearDate}
            >
              Clear
            </button>
            <button
              type="button"
              className="rounded-md px-2 py-1.5 text-[var(--accent)] transition-colors hover:bg-[var(--accent-muted)] hover:text-[var(--accent-hover)]"
              onClick={pickToday}
            >
              Today
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
