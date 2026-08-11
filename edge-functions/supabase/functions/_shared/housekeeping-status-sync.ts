import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { DualPmsSshConfig } from "./dualpms-secrets.ts";
import {
  queueDualPmsHousekeeping,
  type PmsHousekeepingStatus,
} from "./dualpms-housekeeping.ts";

export type { PmsHousekeepingStatus };

export type HousekeepingSyncOptions = {
  roomNumbers: string[];
  status: PmsHousekeepingStatus;
  notes?: string | null;
  /** Default true — queue SynXis/eZee via DualPMS VPS. */
  syncPms?: boolean;
  /** Default true — update Nexus housekeeping board (RPCs). */
  syncNexus?: boolean;
};

export type RoomNexusSyncResult = {
  roomNumber: string;
  ok: boolean;
  error?: string;
  task?: Record<string, unknown> | null;
  roomStatus?: Record<string, unknown> | null;
};

export type HousekeepingSyncResult = {
  roomCount: number;
  status: PmsHousekeepingStatus;
  pmsQueued: boolean;
  pmsRandomHex: string | null;
  nexusResults: RoomNexusSyncResult[];
  warnings: string[];
};

function normalizeRoomNumbers(roomNumbers: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of roomNumbers) {
    const rn = String(raw).trim().toUpperCase();
    if (!rn || seen.has(rn)) continue;
    seen.add(rn);
    out.push(rn);
  }
  return out.sort((a, b) => {
    const an = Number.parseInt(a, 10);
    const bn = Number.parseInt(b, 10);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
    return a.localeCompare(b);
  });
}

async function applyNexusHousekeeping(
  client: SupabaseClient,
  roomNumbers: string[],
  status: PmsHousekeepingStatus,
  notes: string | null,
): Promise<RoomNexusSyncResult[]> {
  const defaultNote =
    status === "dirty"
      ? "Synced from Dual PMS"
      : "Synced from Dual PMS — room released";
  const note = notes?.trim() || defaultNote;
  const results: RoomNexusSyncResult[] = [];

  for (const roomNumber of roomNumbers) {
    if (status === "dirty") {
      const { data, error } = await client.rpc("hk_mark_room_dirty", {
        p_room_number: roomNumber,
        p_notes: note,
      });
      if (error) {
        results.push({ roomNumber, ok: false, error: error.message });
      } else {
        results.push({
          roomNumber,
          ok: true,
          task: (data as Record<string, unknown> | null) ?? null,
        });
      }
    } else {
      const { data, error } = await client.rpc("hk_mark_room_available", {
        p_room_number: roomNumber,
        p_reason: note,
      });
      if (error) {
        results.push({ roomNumber, ok: false, error: error.message });
      } else {
        results.push({
          roomNumber,
          ok: true,
          roomStatus: (data as Record<string, unknown> | null) ?? null,
        });
      }
    }
  }

  return results;
}

/** Bidirectional housekeeping sync: Nexus board + DualPMS queue. */
export async function syncHousekeepingStatus(
  serviceClient: SupabaseClient,
  pmsConfig: DualPmsSshConfig | null,
  options: HousekeepingSyncOptions,
): Promise<HousekeepingSyncResult> {
  const roomNumbers = normalizeRoomNumbers(options.roomNumbers);
  const syncPms = options.syncPms !== false;
  const syncNexus = options.syncNexus !== false;

  if (!roomNumbers.length) {
    throw new Error("At least one room is required");
  }
  if (!syncPms && !syncNexus) {
    throw new Error("At least one of syncPms or syncNexus must be enabled");
  }

  const warnings: string[] = [];
  let pmsQueued = false;
  let pmsRandomHex: string | null = null;
  let nexusResults: RoomNexusSyncResult[] = [];

  if (syncNexus) {
    nexusResults = await applyNexusHousekeeping(
      serviceClient,
      roomNumbers,
      options.status,
      options.notes ?? null,
    );
    for (const row of nexusResults) {
      if (!row.ok && row.error) {
        warnings.push(`${row.roomNumber}: ${row.error}`);
      }
    }
  }

  if (syncPms) {
    if (!pmsConfig) {
      throw new Error("Dual PMS integration is not configured");
    }
    const queued = await queueDualPmsHousekeeping(pmsConfig, roomNumbers, options.status);
    pmsQueued = true;
    pmsRandomHex = queued.randomHex;
  }

  return {
    roomCount: roomNumbers.length,
    status: options.status,
    pmsQueued,
    pmsRandomHex,
    nexusResults,
    warnings,
  };
}

export function buildHousekeepingSyncMessage(result: HousekeepingSyncResult): string {
  const parts: string[] = [];
  const nexusOk = result.nexusResults.filter((r) => r.ok).length;

  if (result.nexusResults.length > 0) {
    if (nexusOk === result.roomCount) {
      parts.push(`Housekeeping board updated for ${nexusOk} room(s)`);
    } else if (nexusOk > 0) {
      parts.push(`Housekeeping board updated for ${nexusOk} of ${result.roomCount} room(s)`);
    }
  }

  if (result.pmsQueued) {
    parts.push(
      `Queued ${result.roomCount} room(s) on SynXis/eZee (updates within ~60 seconds)`,
    );
  }

  if (!parts.length) {
    return `Processed ${result.roomCount} room(s).`;
  }
  return `${parts.join(". ")}.`;
}
