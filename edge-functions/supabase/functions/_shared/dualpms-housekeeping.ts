import type { DualPmsSshConfig } from "./dualpms-secrets.ts";
import { execDualPmsPsql } from "./dualpms-ssh-exec.ts";

export type PmsHousekeepingStatus = "clean" | "dirty";

const STATUS_TO_ID: Record<PmsHousekeepingStatus, number> = {
  dirty: 1,
  clean: 2,
};

function parseRoomNumbers(roomNumbers: string[]): number[] {
  const nums = roomNumbers.map((raw) => {
    const n = Number.parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`Invalid room number: ${raw}`);
    }
    return n;
  });
  if (nums.length === 0) {
    throw new Error("At least one room is required");
  }
  return [...new Set(nums)].sort((a, b) => a - b);
}

function randomHex64(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Queue a manual HK change on the VPS (same `housekeeping` table as original DualPMS). */
export async function queueDualPmsHousekeeping(
  config: DualPmsSshConfig,
  roomNumbers: string[],
  status: PmsHousekeepingStatus,
): Promise<{ randomHex: string; roomCount: number; setStatus: number }> {
  const rooms = parseRoomNumbers(roomNumbers);
  const setStatus = STATUS_TO_ID[status];
  const randomHex = randomHex64();
  const arrayLiteral = `ARRAY[${rooms.join(",")}]`;
  const sql =
    `INSERT INTO housekeeping (random_hex, room_nos, set_housekeeping_status, requested_on) ` +
    `VALUES ('${randomHex}', ${arrayLiteral}, ${setStatus}, NOW())`;

  await execDualPmsPsql(config, sql);
  return { randomHex, roomCount: rooms.length, setStatus };
}
