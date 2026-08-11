import { parseHotelRoomList, sortRoomNumbers } from "@/lib/roomInventory";

/** Hotel settings subset used for senior room recommendations. */
export type SeniorRecommendSettings = {
  seniorRecommendEnabled: boolean;
  seniorRecommendAge: number;
  seniorPreferredFloors: number[];
  seniorPreferredRoomList: string;
};

export const DEFAULT_SENIOR_RECOMMEND_SETTINGS: SeniorRecommendSettings = {
  seniorRecommendEnabled: true,
  seniorRecommendAge: 50,
  seniorPreferredFloors: [1],
  seniorPreferredRoomList: "",
};

/** Infer hotel floor from room number (`101` → 1, `1203` → 12). */
export function roomFloorFromNumber(room: string): number | null {
  const trimmed = room.trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  if (n < 100) return n;
  return Math.floor(n / 100);
}

export function parseSeniorPreferredFloors(value: unknown): number[] {
  if (Array.isArray(value)) {
    const floors = value
      .map((v) => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : NaN))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (floors.length > 0) return [...new Set(floors)].sort((a, b) => a - b);
  }
  if (typeof value === "string" && value.trim()) {
    const floors = value
      .split(/[\s,;]+/)
      .map((p) => parseInt(p.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (floors.length > 0) return [...new Set(floors)].sort((a, b) => a - b);
  }
  return DEFAULT_SENIOR_RECOMMEND_SETTINGS.seniorPreferredFloors;
}

export function clampSeniorRecommendAge(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return DEFAULT_SENIOR_RECOMMEND_SETTINGS.seniorRecommendAge;
  }
  return Math.max(0, Math.min(99, Math.floor(n)));
}

export function sanitizeSeniorRoomList(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, 2000);
}

/** Format floors for the Settings input (`[1, 2]` → `"1, 2"`). */
export function formatSeniorPreferredFloors(floors: number[]): string {
  return floors.join(", ");
}

/** Parse floors from Settings textarea (`"1, 2"` → `[1, 2]`). */
export function parseSeniorPreferredFloorsInput(raw: string): number[] {
  return parseSeniorPreferredFloors(raw);
}

/** Preview parsed senior room list count for Settings validation hint. */
export function previewSeniorRoomList(raw: string): string[] {
  return sortRoomNumbers(parseHotelRoomList(raw));
}
