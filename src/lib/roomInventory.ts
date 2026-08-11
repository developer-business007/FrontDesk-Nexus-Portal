/**
 * Parses a comma/space/semicolon-separated room list (inclusive ranges like `101-120`).
 * Used by Settings before syncing to `public.rooms`. Returns sorted unique room strings.
 */
export function parseHotelRoomList(raw: string | undefined | null): string[] {
  if (!raw?.trim()) return [];
  const rooms = new Set<string>();
  for (const part of raw.split(/[\s,;]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let a = parseInt(range[1]!, 10);
      let b = parseInt(range[2]!, 10);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (a > b) [a, b] = [b, a];
      const cap = 5000;
      if (b - a > cap) b = a + cap;
      for (let n = a; n <= b; n++) rooms.add(String(n));
    } else if (/^\d+$/.test(part)) {
      rooms.add(part);
    }
  }
  return sortRoomNumbers([...rooms]);
}

/** Numeric-aware sort for room number strings. */
export function sortRoomNumbers(rooms: string[]): string[] {
  return [...rooms].sort((x, y) => {
    const nx = parseInt(x, 10);
    const ny = parseInt(y, 10);
    if (Number.isFinite(nx) && Number.isFinite(ny) && String(nx) === x && String(ny) === y) {
      return nx - ny;
    }
    return x.localeCompare(y, undefined, { numeric: true });
  });
}
