import { supabase } from "@/lib/supabase";
import { resolveEdgeFunctionError } from "@/lib/edgeFunctionError";

export type PmsSyncWarning = {
  system: "SynXis" | "eZee";
  message: string;
  at: string;
};

export type PmsBridgeStatus = {
  bridgeRunning: boolean;
  bridgeSecondsAgo: number | null;
  bridgeHost: string | null;
  bridgeVersion: string | null;
  bridgeStartedAt: string | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  roomsRead: number | null;
  roomsUpserted: number | null;
  dualpmsSynxisHealthy: boolean;
  dualpmsEzeeHealthy: boolean;
  synxisPollAgeSec: number | null;
  ezeePollAgeSec: number | null;
  fallbackActive: boolean;
  warnings: PmsSyncWarning[];
  synxis: {
    syncedAt: string | null;
    dualpmsPolledAt: string | null;
    dualpmsHealthy: boolean;
    hotelDate: string | null;
    source: string | null;
    api: {
      status: string | null;
      roomsFromApi: number | null;
      roomsWithOccupancy: number | null;
      roomsWithHk: number | null;
      inventoryRooms: number | null;
      staleRoomsUsed: number | null;
      detail: string | null;
    };
  };
  ezee: {
    syncedAt: string | null;
    dualpmsPolledAt: string | null;
    dualpmsHealthy: boolean;
    source: string | null;
    api: {
      status: string | null;
      roomsFromApi: number | null;
      roomsWithOccupancy: number | null;
      roomsWithHk: number | null;
      inventoryRooms: number | null;
      staleRoomsUsed: number | null;
      detail: string | null;
    };
  };
};

function parseWarnings(raw: unknown): PmsSyncWarning[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((w) => w && typeof w === "object")
    .map((w) => {
      const row = w as Record<string, unknown>;
      return {
        system: (row.system === "eZee" ? "eZee" : "SynXis") as PmsSyncWarning["system"],
        message: typeof row.message === "string" ? row.message : "",
        at: typeof row.at === "string" ? row.at : "",
      };
    })
    .filter((w) => w.message);
}

function parseApiStats(raw: unknown): PmsBridgeStatus["synxis"]["api"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
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
  const o = raw as Record<string, unknown>;
  return {
    status: typeof o.status === "string" ? o.status : null,
    roomsFromApi: typeof o.rooms_from_api === "number" ? o.rooms_from_api : null,
    roomsWithOccupancy:
      typeof o.rooms_with_occupancy === "number" ? o.rooms_with_occupancy : null,
    roomsWithHk: typeof o.rooms_with_hk === "number" ? o.rooms_with_hk : null,
    inventoryRooms: typeof o.inventory_rooms === "number" ? o.inventory_rooms : null,
    staleRoomsUsed: typeof o.stale_rooms_used === "number" ? o.stale_rooms_used : null,
    detail: typeof o.detail === "string" ? o.detail : null,
  };
}

function parsePayload(data: unknown): PmsBridgeStatus | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (typeof row.error === "string" && row.error.trim()) {
    throw new Error(row.error);
  }

  const synxis = row.synxis as Record<string, unknown> | undefined;
  const ezee = row.ezee as Record<string, unknown> | undefined;

  return {
    bridgeRunning: row.bridgeRunning === true,
    bridgeSecondsAgo:
      typeof row.bridgeSecondsAgo === "number" ? row.bridgeSecondsAgo : null,
    bridgeHost: typeof row.bridgeHost === "string" ? row.bridgeHost : null,
    bridgeVersion: typeof row.bridgeVersion === "string" ? row.bridgeVersion : null,
    bridgeStartedAt:
      typeof row.bridgeStartedAt === "string" ? row.bridgeStartedAt : null,
    lastRunAt: typeof row.lastRunAt === "string" ? row.lastRunAt : null,
    lastOkAt: typeof row.lastOkAt === "string" ? row.lastOkAt : null,
    lastError: typeof row.lastError === "string" ? row.lastError : null,
    roomsRead: typeof row.roomsRead === "number" ? row.roomsRead : null,
    roomsUpserted: typeof row.roomsUpserted === "number" ? row.roomsUpserted : null,
    dualpmsSynxisHealthy: row.dualpmsSynxisHealthy === true,
    dualpmsEzeeHealthy: row.dualpmsEzeeHealthy === true,
    synxisPollAgeSec:
      typeof row.synxisPollAgeSec === "number" ? row.synxisPollAgeSec : null,
    ezeePollAgeSec: typeof row.ezeePollAgeSec === "number" ? row.ezeePollAgeSec : null,
    fallbackActive: row.fallbackActive === true,
    warnings: parseWarnings(row.warnings),
    synxis: {
      syncedAt: typeof synxis?.syncedAt === "string" ? synxis.syncedAt : null,
      dualpmsPolledAt:
        typeof synxis?.dualpmsPolledAt === "string" ? synxis.dualpmsPolledAt : null,
      dualpmsHealthy: synxis?.dualpmsHealthy === true,
      hotelDate: typeof synxis?.hotelDate === "string" ? synxis.hotelDate : null,
      source: typeof synxis?.source === "string" ? synxis.source : null,
      api: parseApiStats(synxis?.api),
    },
    ezee: {
      syncedAt: typeof ezee?.syncedAt === "string" ? ezee.syncedAt : null,
      dualpmsPolledAt:
        typeof ezee?.dualpmsPolledAt === "string" ? ezee.dualpmsPolledAt : null,
      dualpmsHealthy: ezee?.dualpmsHealthy === true,
      source: typeof ezee?.source === "string" ? ezee.source : null,
      api: parseApiStats(ezee?.api),
    },
  };
}

export async function fetchPmsBridgeStatus(): Promise<{
  data: PmsBridgeStatus | null;
  error: string | null;
}> {
  const { data, error } = await supabase.functions.invoke("get-pms-bridge-status", {
    body: {},
  });
  if (error) {
    return { data: null, error: await resolveEdgeFunctionError(error, data) };
  }
  try {
    return { data: parsePayload(data), error: null };
  } catch (e) {
    return {
      data: null,
      error: e instanceof Error ? e.message : "Failed to load bridge status",
    };
  }
}

export function isSynxisFallbackSource(source: string | null | undefined): boolean {
  return source === "cookie_backup" || source === "synxis_api_credentials";
}

export function isEzeeFallbackSource(source: string | null | undefined): boolean {
  return source === "ezee_api_fallback";
}

export function formatPmsSourceLabel(source: string | null | undefined): string {
  switch (source) {
    case "dualpms_vps":
      return "DualPMS";
    case "cookie_backup":
      return "browser cookie";
    case "synxis_api_credentials":
      return "script login";
    case "ezee_api_fallback":
      return "eZee API";
    default:
      return source ?? "—";
  }
}
