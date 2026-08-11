import {
  syncHousekeepingStatus,
  type HousekeepingSyncStatus,
} from "@/lib/housekeepingStatusSync";

export type PmsHousekeepingStatus = HousekeepingSyncStatus;

export async function requestPmsHousekeeping(input: {
  roomNumbers: string[];
  status: PmsHousekeepingStatus;
  notes?: string | null;
}): Promise<{ ok: boolean; error: string | null; message: string | null; warnings: string[] }> {
  const result = await syncHousekeepingStatus({
    roomNumbers: input.roomNumbers,
    status: input.status,
    notes: input.notes,
    syncPms: true,
    syncNexus: true,
  });

  return {
    ok: result.ok,
    error: result.error,
    message: result.message,
    warnings: result.warnings,
  };
}
