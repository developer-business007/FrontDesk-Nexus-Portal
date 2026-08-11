import { type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  buildUpsertRow,
  isSynxisLocalSyncFresh,
  loadActiveRoomNumbers,
  loadExistingPmsSnapshots,
  PMS_SYNC_STATE_KEY,
  readSynxisSyncState,
  type EzeeRoomSnapshot,
  type SynxisRoomSnapshot,
  upsertPmsRoomRows,
} from "./pms-board-db.ts";

export type PmsSyncRunResult = {
  ok: boolean;
  at: string;
  synxis: { ok: boolean; rooms?: number; error?: string; source?: string; localOnly?: boolean };
  ezee: { ok: boolean; rooms?: number; error?: string; source?: string; localOnly?: boolean };
  upserted?: number;
  error?: string;
};

const DUALPMS_MSG =
  "SynXis + eZee data comes from the VPS bridge (PM2). No cloud PMS API calls.";

const STALE_BRIDGE_MSG =
  "VPS bridge stale — ensure PM2 is running on the DualPMS server (see bridge/README.md)";

function isEzeeBridgeFresh(syncedAt: string | null, maxAgeMs = 120_000): boolean {
  if (!syncedAt) return false;
  const t = new Date(syncedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < maxAgeMs;
}

async function readEzeeSyncState(client: SupabaseClient): Promise<{
  syncedAt: string | null;
  source: string | null;
}> {
  const { data, error } = await client
    .from("app_settings")
    .select("value")
    .eq("key", PMS_SYNC_STATE_KEY)
    .maybeSingle();

  if (error) throw new Error(error.message);

  const ezee = (data?.value as Record<string, unknown> | undefined)?.ezee;
  if (!ezee || typeof ezee !== "object" || Array.isArray(ezee)) {
    return { syncedAt: null, source: null };
  }

  const row = ezee as Record<string, unknown>;
  return {
    syncedAt: typeof row.synced_at === "string" ? row.synced_at : null,
    source: typeof row.source === "string" ? row.source : null,
  };
}

/**
 * Cloud/manual refresh: read-only. DualPMS bridge writes SynXis + eZee into Supabase.
 * This function preserves existing PMS columns and refreshes inventory rows only.
 */
export async function runPmsSync(serviceClient: SupabaseClient): Promise<PmsSyncRunResult> {
  const now = new Date().toISOString();
  const result: PmsSyncRunResult = {
    ok: true,
    at: now,
    synxis: { ok: false, error: "Not run", localOnly: true },
    ezee: { ok: false, error: "Not run", localOnly: true },
  };

  let synxisRooms = new Map<string, SynxisRoomSnapshot>();
  let ezeeRooms = new Map<string, EzeeRoomSnapshot>();
  let synxisSyncedAt: string | null = null;
  let ezeeSyncedAt: string | null = null;

  const existingSnapshots = await loadExistingPmsSnapshots(serviceClient);
  synxisRooms = existingSnapshots.synxis;
  ezeeRooms = existingSnapshots.ezee;

  try {
    const synxisState = await readSynxisSyncState(serviceClient);
    synxisSyncedAt = synxisState.syncedAt;
    const hotelDate =
      typeof synxisState.hotelDate === "string" ? synxisState.hotelDate.slice(0, 10) : null;

    if (isSynxisLocalSyncFresh(synxisSyncedAt)) {
      result.synxis = {
        ok: true,
        rooms: synxisRooms.size,
        source: synxisState.source ?? "dualpms_vps",
        localOnly: true,
      };
    } else if (synxisSyncedAt) {
      const ageSec = Math.round((Date.now() - new Date(synxisSyncedAt).getTime()) / 1000);
      result.synxis = {
        ok: false,
        localOnly: true,
        error: `VPS bridge stale (last copy ${ageSec}s ago). ${STALE_BRIDGE_MSG}`,
      };
    } else {
      result.synxis = { ok: false, localOnly: true, error: DUALPMS_MSG };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "SynXis state read failed";
    console.error("[pms-sync] synxis state", message);
    result.synxis = { ok: false, localOnly: true, error: message };
  }

  try {
    const ezeeState = await readEzeeSyncState(serviceClient);
    ezeeSyncedAt = ezeeState.syncedAt;

    if (isEzeeBridgeFresh(ezeeSyncedAt)) {
      result.ezee = {
        ok: true,
        rooms: ezeeRooms.size,
        source: ezeeState.source ?? "dualpms_vps",
        localOnly: true,
      };
    } else if (ezeeSyncedAt) {
      const ageSec = Math.round((Date.now() - new Date(ezeeSyncedAt).getTime()) / 1000);
      result.ezee = {
        ok: false,
        localOnly: true,
        error: `VPS bridge stale (last copy ${ageSec}s ago). ${STALE_BRIDGE_MSG}`,
      };
    } else {
      result.ezee = { ok: false, localOnly: true, error: DUALPMS_MSG };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "eZee state read failed";
    console.error("[pms-sync] ezee state", message);
    result.ezee = { ok: false, localOnly: true, error: message };
  }

  try {
    const inventory = await loadActiveRoomNumbers(serviceClient);

    const { data: syncTimeRows } = await serviceClient
      .from("room_operational_status")
      .select("room_number, synxis_synced_at, ezee_synced_at");
    const synxisSyncByRoom = new Map<string, string | null>();
    const ezeeSyncByRoom = new Map<string, string | null>();
    for (const row of syncTimeRows ?? []) {
      const r = row as {
        room_number: string;
        synxis_synced_at: string | null;
        ezee_synced_at: string | null;
      };
      synxisSyncByRoom.set(String(r.room_number), r.synxis_synced_at);
      ezeeSyncByRoom.set(String(r.room_number), r.ezee_synced_at);
    }

    const upsertRows: Record<string, unknown>[] = [];
    for (const roomNumber of inventory) {
      upsertRows.push(
        buildUpsertRow(
          roomNumber,
          synxisRooms.get(roomNumber),
          ezeeRooms.get(roomNumber),
          synxisSyncedAt ?? synxisSyncByRoom.get(roomNumber) ?? null,
          ezeeSyncedAt ?? ezeeSyncByRoom.get(roomNumber) ?? null,
        ),
      );
    }

    await upsertPmsRoomRows(serviceClient, upsertRows, hotelDate);
    result.upserted = upsertRows.length;
    result.ok = result.synxis.ok || result.ezee.ok;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Database upsert failed";
    console.error("[pms-sync] db", message);
    result.ok = false;
    result.error = message;
  }

  return result;
}
