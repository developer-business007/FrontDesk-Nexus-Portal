/** `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss` → calendar `YYYY-MM-DD` (no UTC shift). */
export function calendarDatePart(iso: string | null | undefined): string | null {
  if (!iso?.trim()) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Format a stay/check-in date for display without off-by-one UTC bugs. */
export function formatStayDate(iso: string | null | undefined): string {
  const cal = calendarDatePart(iso);
  if (!cal) return iso?.trim() ? iso : "—";
  const [y, mo, d] = cal.split("-").map(Number);
  const local = new Date(y, mo - 1, d);
  if (Number.isNaN(local.getTime())) return cal;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(local);
}
