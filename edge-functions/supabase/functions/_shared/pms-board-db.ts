import { type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  applyPassivePmsHkSync,
  autoMarkDirtyOnCheckout,
  detectCheckoutRooms,
  type RoomPmsHkSnapshot,
} from "./hk-pms-passive-sync.ts";
import { syncHousekeepingTasksFromPms } from "./hk-pms-task-sync.ts";

export const PMS_SYNC_STATE_KEY = "pms_sync_state";
export const PMS_ROOMTYPE_COUNTS_KEY = "pms_roomtype_counts";
export const PMS_EZEE_FOLIO_CACHE_KEY = "pms_ezee_folio_cache";

export type EzeeFolioCacheEntry = {
  balanceCents: number | null;
  updatedAt: string;
};

export type EzeeFolioCache = Record<string, EzeeFolioCacheEntry>;

export type PmsSoldBy = "synxis" | "ezee" | "neither";

export type SynxisRoomSnapshot = {
  roomNumber: string;
  roomType: string | null;
  hkStatus: string | null;
  occupancy: string | null;
  oooCode: string | null;
  guestName: string | null;
  checkInDate: string | null;
  checkOutDate: string | null;
  balanceCents: number | null;
};

export type EzeeRoomSnapshot = {
  roomNumber: string;
  roomType: string | null;
  hkStatus: string | null;
  occupancy: string | null;
  guestName: string | null;
  checkInDate: string | null;
  checkOutDate: string | null;
  balanceCents: number | null;
  bookingStatus: string | null;
};

export type RoomtypeCounts = Record<string, number>;

/** Supabase/Postgres may return int8/numeric as string — coerce to integer cents. */
export function parsePmsCents(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function soldBy(
  synxisOccupancy: string | null,
  ezeeOccupancy: string | null,
): PmsSoldBy {
  if (synxisOccupancy === "Occupied" || synxisOccupancy === "Reserved") return "synxis";
  if (ezeeOccupancy === "Occupied") return "ezee";
  return "neither";
}

function mergeGuest(
  synxis: SynxisRoomSnapshot | undefined,
  ezee: EzeeRoomSnapshot | undefined,
): {
  guestName: string | null;
  checkInDate: string | null;
  checkOutDate: string | null;
  balanceCents: number | null;
} {
  // DualPMS: SynXis folio is usually unset; fall back to eZee kiosk balance.
  const mergedBalance = synxis?.balanceCents ?? ezee?.balanceCents ?? null;

  if (synxis?.guestName) {
    return {
      guestName: synxis.guestName,
      checkInDate: synxis.checkInDate,
      checkOutDate: synxis.checkOutDate,
      balanceCents: mergedBalance,
    };
  }
  if (ezee?.guestName) {
    return {
      guestName: ezee.guestName,
      checkInDate: ezee.checkInDate,
      checkOutDate: ezee.checkOutDate,
      balanceCents: mergedBalance,
    };
  }
  return {
    guestName: null,
    checkInDate: null,
    checkOutDate: null,
    balanceCents: null,
  };
}

export function buildUpsertRow(
  roomNumber: string,
  synxis: SynxisRoomSnapshot | undefined,
  ezee: EzeeRoomSnapshot | undefined,
  synxisSyncedAt: string | null,
  ezeeSyncedAt: string | null,
): Record<string, unknown> {
  const merged = mergeGuest(synxis, ezee);
  const synxisOcc = synxis?.occupancy ?? null;
  const ezeeOcc = ezee?.occupancy ?? null;

  return {
    room_number: roomNumber,
    room_type: synxis?.roomType ?? ezee?.roomType ?? null,
    synxis_hk_status: synxis?.hkStatus ?? null,
    synxis_occupancy: synxisOcc,
    synxis_ooo_code: synxis?.oooCode ?? null,
    synxis_guest_name: synxis?.guestName ?? null,
    synxis_check_in_date: synxis?.checkInDate ?? null,
    synxis_check_out_date: synxis?.checkOutDate ?? null,
    synxis_balance_cents: synxis?.balanceCents ?? null,
    ezee_hk_status: ezee?.hkStatus ?? null,
    ezee_occupancy: ezeeOcc,
    ezee_guest_name: ezee?.guestName ?? null,
    ezee_check_in_date: ezee?.checkInDate ?? null,
    ezee_check_out_date: ezee?.checkOutDate ?? null,
    ezee_balance_cents: ezee?.balanceCents ?? null,
    ezee_booking_status: ezee?.bookingStatus ?? null,
    merged_guest_name: merged.guestName,
    merged_check_in_date: merged.checkInDate,
    merged_check_out_date: merged.checkOutDate,
    merged_balance_cents: merged.balanceCents,
    sold_by: soldBy(synxisOcc, ezeeOcc),
    synxis_synced_at: synxisSyncedAt,
    ezee_synced_at: ezeeSyncedAt,
    pms_updated_at: new Date().toISOString(),
  };
}

export async function upsertPmsRoomRows(
  client: SupabaseClient,
  rows: Record<string, unknown>[],
  hotelDate?: string | null,
): Promise<void> {
  if (!rows.length) return;

  const roomNumbers = rows.map((r) => String(r.room_number));
  const { data: existing, error: existingError } = await client
    .from("room_operational_status")
    .select(
      "room_number, status, synxis_occupancy, ezee_occupancy, synxis_ooo_code, synxis_hk_status, ezee_hk_status",
    )
    .in("room_number", roomNumbers);

  if (existingError) throw new Error(existingError.message);

  const previousSnapshots: RoomPmsHkSnapshot[] = (existing ?? []).map((row) => {
    const r = row as RoomPmsHkSnapshot;
    return {
      room_number: String(r.room_number),
      synxis_occupancy: r.synxis_occupancy ?? null,
      ezee_occupancy: r.ezee_occupancy ?? null,
      synxis_ooo_code: r.synxis_ooo_code ?? null,
      synxis_hk_status: r.synxis_hk_status ?? null,
      ezee_hk_status: r.ezee_hk_status ?? null,
      lifecycle_status: r.status ?? null,
    };
  });

  const knownStatus = new Map<string, string>();
  for (const row of existing ?? []) {
    const rn = String((row as { room_number: string }).room_number);
    const st = (row as { status: string | null }).status;
    if (st) knownStatus.set(rn, st);
  }

  const checkoutRooms = detectCheckoutRooms(previousSnapshots, rows);
  const checkoutProcessed = new Set<string>();
  if (checkoutRooms.length > 0) {
    const hk = await autoMarkDirtyOnCheckout(client, checkoutRooms);
    for (const room of [...hk.marked, ...hk.skipped]) {
      knownStatus.set(room, "dirty");
      checkoutProcessed.add(room);
    }
    if (hk.marked.length > 0) {
      console.log("[pms-board] Auto dirty on checkout:", hk.marked.join(", "));
    }
    for (const err of hk.errors) {
      console.warn("[pms-board] Checkout dirty failed:", err);
    }
  }

  const passive = await applyPassivePmsHkSync(client, previousSnapshots, rows, checkoutProcessed);
  for (const [room, status] of passive.lifecyclePatches) {
    knownStatus.set(room, status);
  }
  if (passive.passiveDirty.length > 0) {
    console.log("[pms-board] Passive PMS dirty:", passive.passiveDirty.join(", "));
  }
  if (passive.passiveAvailable.length > 0) {
    console.log("[pms-board] Passive PMS available:", passive.passiveAvailable.join(", "));
  }

  const payload = rows.map((row) => {
    const roomNumber = String(row.room_number);
    return { ...row, status: knownStatus.get(roomNumber) ?? "available" };
  });

  const { error } = await client.from("room_operational_status").upsert(payload, {
    onConflict: "room_number",
    ignoreDuplicates: false,
  });

  if (error) throw new Error(error.message);

  try {
    const syncResult = await syncHousekeepingTasksFromPms(client, hotelDate);
    const created =
      syncResult.due_out_created +
      syncResult.stayover_created +
      syncResult.deep_clean_created +
      syncResult.vacant_dirty;
    if (created > 0) {
      console.log(`[pms-board] PMS task sync (${syncResult.hotel_date}): ${created} created`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[pms-board] PMS task sync skipped:", msg);
  }
}

export async function updateAppSettingsJson(
  client: SupabaseClient,
  key: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { data, error } = await client
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();

  if (error) throw new Error(error.message);

  const current =
    data?.value && typeof data.value === "object" && !Array.isArray(data.value)
      ? (data.value as Record<string, unknown>)
      : {};

  const next = { ...current, ...patch };
  const { error: upsertError } = await client.from("app_settings").upsert(
    {
      key,
      value: next,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" },
  );

  if (upsertError) throw new Error(upsertError.message);
}

export async function loadActiveRoomNumbers(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client
    .from("rooms")
    .select("room_number")
    .eq("is_active", true);

  if (error) throw new Error(error.message);

  return (data ?? [])
    .map((r) => String((r as { room_number: string }).room_number).trim())
    .filter(Boolean)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

const PMS_ROW_SELECT = [
  "room_number",
  "room_type",
  "synxis_hk_status",
  "synxis_occupancy",
  "synxis_ooo_code",
  "synxis_guest_name",
  "synxis_check_in_date",
  "synxis_check_out_date",
  "synxis_balance_cents",
  "ezee_hk_status",
  "ezee_occupancy",
  "ezee_guest_name",
  "ezee_check_in_date",
  "ezee_check_out_date",
  "ezee_balance_cents",
  "ezee_booking_status",
  "synxis_synced_at",
  "ezee_synced_at",
].join(", ");

/** Read current PMS snapshots from DB (cloud eZee merge preserves local SynXis rows). */
export async function loadExistingPmsSnapshots(client: SupabaseClient): Promise<{
  synxis: Map<string, SynxisRoomSnapshot>;
  ezee: Map<string, EzeeRoomSnapshot>;
}> {
  const synxis = new Map<string, SynxisRoomSnapshot>();
  const ezee = new Map<string, EzeeRoomSnapshot>();

  const { data, error } = await client.from("room_operational_status").select(PMS_ROW_SELECT);
  if (error) throw new Error(error.message);

  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    const roomNumber = String(r.room_number ?? "").trim();
    if (!roomNumber) continue;

    if (r.synxis_hk_status != null || r.synxis_occupancy != null || r.synxis_guest_name != null) {
      synxis.set(roomNumber, {
        roomNumber,
        roomType: typeof r.room_type === "string" ? r.room_type : null,
        hkStatus: typeof r.synxis_hk_status === "string" ? r.synxis_hk_status : null,
        occupancy: typeof r.synxis_occupancy === "string" ? r.synxis_occupancy : null,
        oooCode: typeof r.synxis_ooo_code === "string" ? r.synxis_ooo_code : null,
        guestName: typeof r.synxis_guest_name === "string" ? r.synxis_guest_name : null,
        checkInDate: typeof r.synxis_check_in_date === "string" ? r.synxis_check_in_date : null,
        checkOutDate: typeof r.synxis_check_out_date === "string" ? r.synxis_check_out_date : null,
        balanceCents: parsePmsCents(r.synxis_balance_cents),
      });
    }

    if (r.ezee_hk_status != null || r.ezee_occupancy != null || r.ezee_guest_name != null) {
      ezee.set(roomNumber, {
        roomNumber,
        roomType: typeof r.room_type === "string" ? r.room_type : null,
        hkStatus: typeof r.ezee_hk_status === "string" ? r.ezee_hk_status : null,
        occupancy: typeof r.ezee_occupancy === "string" ? r.ezee_occupancy : null,
        guestName: typeof r.ezee_guest_name === "string" ? r.ezee_guest_name : null,
        checkInDate: typeof r.ezee_check_in_date === "string" ? r.ezee_check_in_date : null,
        checkOutDate: typeof r.ezee_check_out_date === "string" ? r.ezee_check_out_date : null,
        balanceCents: parsePmsCents(r.ezee_balance_cents),
        bookingStatus: typeof r.ezee_booking_status === "string" ? r.ezee_booking_status : null,
      });
    }
  }

  return { synxis, ezee };
}

/** Local SynXis agent should heartbeat at least this often (ms). */
export const LOCAL_SYNXIS_STALE_MS = 120_000;

export async function readSynxisSyncState(client: SupabaseClient): Promise<{
  syncedAt: string | null;
  hotelDate: string | null;
  source: string | null;
}> {
  const { data, error } = await client
    .from("app_settings")
    .select("value")
    .eq("key", PMS_SYNC_STATE_KEY)
    .maybeSingle();

  if (error) throw new Error(error.message);

  const synxis = (data?.value as Record<string, unknown> | undefined)?.synxis;
  if (!synxis || typeof synxis !== "object" || Array.isArray(synxis)) {
    return { syncedAt: null, hotelDate: null, source: null };
  }

  const s = synxis as Record<string, unknown>;
  return {
    syncedAt: typeof s.synced_at === "string" ? s.synced_at : null,
    hotelDate: typeof s.hotel_date === "string" ? s.hotel_date : null,
    source: typeof s.source === "string" ? s.source : null,
  };
}

export function isSynxisLocalSyncFresh(syncedAt: string | null, maxAgeMs = LOCAL_SYNXIS_STALE_MS): boolean {
  if (!syncedAt) return false;
  const t = new Date(syncedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < maxAgeMs;
}
