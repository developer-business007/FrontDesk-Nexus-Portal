import { resolveEdgeFunctionError } from "@/lib/edgeFunctionError";
import { supabase } from "@/lib/supabase";
import type { HousekeepingTask, RoomOperationalStatus } from "@/types/housekeeping";

export type HousekeepingSyncStatus = "clean" | "dirty";

export type SyncHousekeepingStatusInput = {
  roomNumbers: string[];
  status: HousekeepingSyncStatus;
  notes?: string | null;
  /** Default true */
  syncPms?: boolean;
  /** Default true */
  syncNexus?: boolean;
};

export type SyncHousekeepingStatusResult = {
  ok: boolean;
  error: string | null;
  message: string | null;
  warnings: string[];
  nexusTasks: HousekeepingTask[];
  nexusRoomStatuses: RoomOperationalStatus[];
};

type NexusResultRow = {
  roomNumber?: string;
  ok?: boolean;
  error?: string;
  task?: HousekeepingTask | null;
  roomStatus?: RoomOperationalStatus | null;
};

export async function syncHousekeepingStatus(
  input: SyncHousekeepingStatusInput,
): Promise<SyncHousekeepingStatusResult> {
  const { data, error } = await supabase.functions.invoke("request-pms-housekeeping", {
    body: {
      roomNumbers: input.roomNumbers,
      status: input.status,
      notes: input.notes ?? null,
      syncPms: input.syncPms !== false,
      syncNexus: input.syncNexus !== false,
    },
  });

  if (error) {
    return {
      ok: false,
      error: await resolveEdgeFunctionError(error, data),
      message: null,
      warnings: [],
      nexusTasks: [],
      nexusRoomStatuses: [],
    };
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      error: "Invalid server response",
      message: null,
      warnings: [],
      nexusTasks: [],
      nexusRoomStatuses: [],
    };
  }

  const row = data as Record<string, unknown>;
  const warnings = Array.isArray(row.warnings)
    ? row.warnings.filter((w): w is string => typeof w === "string")
    : [];

  if (typeof row.error === "string" && row.error.trim()) {
    return {
      ok: false,
      error: row.error,
      message: null,
      warnings,
      nexusTasks: [],
      nexusRoomStatuses: [],
    };
  }

  if (row.ok !== true) {
    return {
      ok: false,
      error: "Sync failed",
      message: null,
      warnings,
      nexusTasks: [],
      nexusRoomStatuses: [],
    };
  }

  const nexusTasks: HousekeepingTask[] = [];
  const nexusRoomStatuses: RoomOperationalStatus[] = [];
  if (Array.isArray(row.nexusResults)) {
    for (const raw of row.nexusResults) {
      if (!raw || typeof raw !== "object") continue;
      const nr = raw as NexusResultRow;
      if (nr.ok && nr.task) nexusTasks.push(nr.task);
      if (nr.ok && nr.roomStatus) nexusRoomStatuses.push(nr.roomStatus);
    }
  }

  const message =
    typeof row.message === "string" && row.message.trim()
      ? row.message
      : `Synced ${input.roomNumbers.length} room(s) as ${input.status}.`;

  return {
    ok: true,
    error: null,
    message,
    warnings,
    nexusTasks,
    nexusRoomStatuses,
  };
}
