/** Split PMS room chains: `133 → 203`, `133 -> 203`, or single `203`. */
const ROOM_CHAIN_SPLIT = /\s*(?:→|->)\s*/;

/** Display separator for room move chains — always Unicode arrow, never `->`. */
const ROOM_CHAIN_ARROW = " → ";

export function parseRoomChain(value: string | null | undefined): string[] {
  const raw = (value ?? "").trim();
  if (!raw) return [];
  if (ROOM_CHAIN_SPLIT.test(raw)) {
    return raw
      .split(ROOM_CHAIN_SPLIT)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [raw];
}

/** Latest room in a stored column value (last segment of the chain). */
export function latestRoomFromColumn(value: string | null | undefined): string | null {
  const parts = parseRoomChain(value);
  return parts.length > 0 ? parts[parts.length - 1]! : null;
}

/** Prefer `scrape_payload.fdn.roomNumberHistory` when present; else parse column. */
export function latestRoomFromReservation(row: {
  room_number: string | null;
  scrape_payload?: Record<string, unknown> | null;
}): string | null {
  const payload = row.scrape_payload;
  if (payload?.fdn && typeof payload.fdn === "object" && !Array.isArray(payload.fdn)) {
    const h = (payload.fdn as Record<string, unknown>).roomNumberHistory;
    if (Array.isArray(h) && h.length > 0) {
      const cleaned = h.map((x) => String(x).trim()).filter((x) => x.length > 0);
      if (cleaned.length > 0) return cleaned[cleaned.length - 1]!;
    }
  }
  return latestRoomFromColumn(row.room_number);
}

function roomNumberHistoryFromReservation(row: {
  scrape_payload?: Record<string, unknown> | null;
}): string[] | null {
  const payload = row.scrape_payload;
  if (payload?.fdn && typeof payload.fdn === "object" && !Array.isArray(payload.fdn)) {
    const h = (payload.fdn as Record<string, unknown>).roomNumberHistory;
    if (Array.isArray(h) && h.length > 0) {
      const cleaned = h.map((x) => String(x).trim()).filter((x) => x.length > 0);
      if (cleaned.length > 0) return cleaned;
    }
  }
  return null;
}

function joinRoomChain(parts: string[]): string {
  return parts.length === 1 ? parts[0]! : parts.join(ROOM_CHAIN_ARROW);
}

/** Normalize a stored `room_number` column for display (parses `->` / `→`, outputs `→`). */
export function formatRoomChainColumnForDisplay(
  value: string | null | undefined,
): string | null {
  const parts = parseRoomChain(value);
  if (parts.length === 0) return null;
  return joinRoomChain(parts);
}

/** Full room move chain for detail views (e.g. `133 → 203`). */
export function formatRoomChainForDisplay(row: {
  room_number: string | null;
  scrape_payload?: Record<string, unknown> | null;
}): string | null {
  const history = roomNumberHistoryFromReservation(row);
  if (history) return joinRoomChain(history);
  return formatRoomChainColumnForDisplay(row.room_number);
}
