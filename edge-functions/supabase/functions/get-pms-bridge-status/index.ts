import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireStaff } from "../_shared/auth.ts";
import { jsonResponse, optionsResponse } from "../_shared/cors.ts";
import {
  PMS_BRIDGE_HEARTBEAT_KEY,
  PMS_SYNC_STATE_KEY,
  PMS_SYNC_WARNINGS_KEY,
} from "../_shared/pms-bridge-keys.ts";

const STALE_BRIDGE_SEC = 90;
const DUALPMS_POLL_STALE_SEC = 45;

function pollAgeSeconds(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const auth = await requireStaff(req, "admin");
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  try {
    const { data: rows, error } = await auth.serviceClient
      .from("app_settings")
      .select("key, value, updated_at")
      .in("key", [PMS_SYNC_STATE_KEY, PMS_BRIDGE_HEARTBEAT_KEY, PMS_SYNC_WARNINGS_KEY]);

    if (error) throw new Error(error.message);

    let syncState: Record<string, unknown> = {};
    let heartbeat: Record<string, unknown> = {};
    let warningsState: Record<string, unknown> = {};

    for (const row of rows ?? []) {
      const v = row.value as Record<string, unknown> | null;
      if (row.key === PMS_SYNC_STATE_KEY && v) syncState = v;
      if (row.key === PMS_BRIDGE_HEARTBEAT_KEY && v) heartbeat = v;
      if (row.key === PMS_SYNC_WARNINGS_KEY && v) warningsState = v;
    }

    const synxis = syncState.synxis as Record<string, unknown> | undefined;
    const ezee = syncState.ezee as Record<string, unknown> | undefined;

    const lastRunAt =
      typeof heartbeat.last_run_at === "string" ? heartbeat.last_run_at : null;
    const lastOkAt =
      typeof heartbeat.last_ok_at === "string" ? heartbeat.last_ok_at : null;
    const lastError =
      typeof heartbeat.last_error === "string" && heartbeat.last_error.trim()
        ? heartbeat.last_error.trim()
        : null;

    const bridgeSecondsAgo = lastRunAt
      ? Math.max(0, Math.round((Date.now() - new Date(lastRunAt).getTime()) / 1000))
      : null;

    const bridgeRunning =
      bridgeSecondsAgo != null && bridgeSecondsAgo <= STALE_BRIDGE_SEC && !lastError;

    const synxisPolledAt =
      synxis && typeof synxis.dualpms_polled_at === "string" ? synxis.dualpms_polled_at : null;
    const ezeePolledAt =
      ezee && typeof ezee.dualpms_polled_at === "string" ? ezee.dualpms_polled_at : null;

    const synxisPollAgeSec = pollAgeSeconds(synxisPolledAt);
    const ezeePollAgeSec = pollAgeSeconds(ezeePolledAt);

    const dualpmsSynxisHealthy =
      typeof synxis?.dualpms_healthy === "boolean"
        ? synxis.dualpms_healthy
        : synxisPollAgeSec != null && synxisPollAgeSec <= DUALPMS_POLL_STALE_SEC;
    const dualpmsEzeeHealthy =
      typeof ezee?.dualpms_healthy === "boolean"
        ? ezee.dualpms_healthy
        : ezeePollAgeSec != null && ezeePollAgeSec <= DUALPMS_POLL_STALE_SEC;

    const synxisSource = synxis && typeof synxis.source === "string" ? synxis.source : null;
    const ezeeSource = ezee && typeof ezee.source === "string" ? ezee.source : null;

    const fallbackActive =
      warningsState.fallback_active === true ||
      heartbeat.fallback_active === true ||
      (synxisSource != null && synxisSource !== "dualpms_vps") ||
      (ezeeSource != null && ezeeSource !== "dualpms_vps");

    const warnings = Array.isArray(warningsState.warnings) ? warningsState.warnings : [];

    function mapApiStats(side: Record<string, unknown> | undefined) {
      const api = side?.api as Record<string, unknown> | undefined;
      if (!api) {
        return {
          status: null,
          roomsFromApi: null,
          roomsWithOccupancy: null,
          roomsWithHk: null,
          inventoryRooms: null,
          staleRoomsUsed: null,
          detail: null,
        };
      }
      return {
        status: typeof api.status === "string" ? api.status : null,
        roomsFromApi: typeof api.rooms_from_api === "number" ? api.rooms_from_api : null,
        roomsWithOccupancy:
          typeof api.rooms_with_occupancy === "number" ? api.rooms_with_occupancy : null,
        roomsWithHk: typeof api.rooms_with_hk === "number" ? api.rooms_with_hk : null,
        inventoryRooms: typeof api.inventory_rooms === "number" ? api.inventory_rooms : null,
        staleRoomsUsed: typeof api.stale_rooms_used === "number" ? api.stale_rooms_used : null,
        detail: typeof api.detail === "string" ? api.detail : null,
      };
    }

    return jsonResponse({
      bridgeRunning,
      bridgeSecondsAgo,
      bridgeHost: typeof heartbeat.host === "string" ? heartbeat.host : null,
      bridgeVersion: typeof heartbeat.version === "string" ? heartbeat.version : null,
      bridgeStartedAt:
        typeof heartbeat.started_at === "string" ? heartbeat.started_at : null,
      lastRunAt,
      lastOkAt,
      lastError,
      roomsRead: typeof heartbeat.rooms_read === "number" ? heartbeat.rooms_read : null,
      roomsUpserted:
        typeof heartbeat.rooms_upserted === "number" ? heartbeat.rooms_upserted : null,
      dualpmsSynxisHealthy,
      dualpmsEzeeHealthy,
      synxisPollAgeSec,
      ezeePollAgeSec,
      fallbackActive,
      warnings,
      synxis: {
        syncedAt: synxis && typeof synxis.synced_at === "string" ? synxis.synced_at : null,
        dualpmsPolledAt: synxisPolledAt,
        dualpmsHealthy: dualpmsSynxisHealthy,
        hotelDate: synxis && typeof synxis.hotel_date === "string" ? synxis.hotel_date : null,
        source: synxisSource,
        api: mapApiStats(synxis),
      },
      ezee: {
        syncedAt: ezee && typeof ezee.synced_at === "string" ? ezee.synced_at : null,
        dualpmsPolledAt: ezeePolledAt,
        dualpmsHealthy: dualpmsEzeeHealthy,
        source: ezeeSource,
        api: mapApiStats(ezee),
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load bridge status";
    return jsonResponse({ error: message }, 500);
  }
});
