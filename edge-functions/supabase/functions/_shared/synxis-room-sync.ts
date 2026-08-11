/**
 * Room-board fetch copied from DualPMS/synxis.py (attendant-rooms + guest-details).
 * Session: local sync (npm run dev on hotel PC) or manual cookie in Admin → Settings.
 */
import { type SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { RoomtypeCounts, SynxisRoomSnapshot } from "./pms-board-db.ts";
import type { SynxisPropertyConfig } from "./synxis-secrets.ts";

export { SYNXIS_SESSION_KEY } from "./synxis-session.ts";

const ALLOWED_ROOM_TYPES = new Set(["NK1", "NDD1", "PNK1", "SNK4", "PND2", "SU1", "SU2"]);
const TIMEOUT_MS = 30_000;

type SynxisConfig = {
  propertyId: string;
  chainId: string;
  cookieHeader: string;
};

export async function loadSynxisCookieHeader(
  serviceClient?: SupabaseClient,
): Promise<string | null> {
  const fromEnv = Deno.env.get("SYNXIS_COOKIE_HEADER")?.trim();
  if (fromEnv) return fromEnv;

  if (!serviceClient) return null;

  const { data, error } = await serviceClient
    .from("app_settings")
    .select("value")
    .eq("key", "synxis_session")
    .maybeSingle();

  if (error) {
    console.warn("[synxis] load session from app_settings:", error.message);
    return null;
  }

  const value = data?.value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const cookie = (value as Record<string, unknown>).cookieHeader;
    if (typeof cookie === "string" && cookie.trim()) return cookie.trim();
  }
  return null;
}

/** True when nightaudit/status returns a business date (session alive). */
export async function validateSynxisCookieHeader(
  cookieHeader: string,
  propertyConfig?: SynxisPropertyConfig,
): Promise<boolean> {
  const propertyId =
    propertyConfig?.propertyId ??
    Deno.env.get("SYNXIS_PROPERTY_ID")?.trim() ??
    "93302";
  const chainId =
    propertyConfig?.chainId ??
    Deno.env.get("SYNXIS_CHAIN_ID")?.trim() ??
    "5136";
  const cfg = { propertyId, chainId, cookieHeader: cookieHeader.trim() };
  const { businessDateString } = await fetchBusinessDate(cfg);
  return Boolean(businessDateString);
}

async function synxisPost(
  url: string,
  cookieHeader: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBusinessDate(
  cfg: SynxisConfig,
): Promise<{ hotelDate: string | null; businessDateString: string | null }> {
  const res = await synxisPost(
    "https://sph.synxis.com/pms-web-ui/service/v1/nightaudit/status",
    cfg.cookieHeader,
    {
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://sph.synxis.com/pms-web-ui/guest-mgt/dashboard?PropertyChanged",
    },
    { payload: { hotelId: cfg.propertyId, chainId: Number(cfg.chainId) } },
  );

  if (!res.ok) return { hotelDate: null, businessDateString: null };

  const json = (await res.json()) as Record<string, unknown>;
  let businessDateString: string | null = null;

  if (typeof json.businessDate === "string") {
    businessDateString = json.businessDate.slice(0, 10) + "T00:00:00.000Z";
  } else if (
    json.data &&
    typeof json.data === "object" &&
    typeof (json.data as Record<string, unknown>).businessDate === "string"
  ) {
    const d = (json.data as Record<string, unknown>).businessDate as string;
    businessDateString = d.slice(0, 10) + "T00:00:00.000Z";
  } else if (typeof json.currentBusinessDate === "string") {
    businessDateString = json.currentBusinessDate.slice(0, 10) + "T00:00:00.000Z";
  }

  const hotelDate = businessDateString ? businessDateString.slice(0, 10) : null;
  return { hotelDate, businessDateString };
}

function msToDateString(ms: number): string | null {
  if (!ms) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

export type SynxisSyncResult = {
  rooms: Map<string, SynxisRoomSnapshot>;
  roomtypeCounts: RoomtypeCounts;
  hotelDate: string | null;
};

export async function syncSynxisRooms(
  cookieHeader: string,
  propertyConfig?: SynxisPropertyConfig,
): Promise<SynxisSyncResult> {
  const propertyId =
    propertyConfig?.propertyId ??
    Deno.env.get("SYNXIS_PROPERTY_ID")?.trim() ??
    "93302";
  const chainId =
    propertyConfig?.chainId ??
    Deno.env.get("SYNXIS_CHAIN_ID")?.trim() ??
    "5136";
  const activeCfg: SynxisConfig = {
    propertyId,
    chainId,
    cookieHeader: cookieHeader.trim(),
  };

  const { businessDateString, hotelDate } = await fetchBusinessDate(activeCfg);
  if (!businessDateString) {
    throw new Error("SynXis business date unavailable (session may be expired)");
  }

  const ts = String(Date.now());
  const attendantRes = await synxisPost(
    "https://sph.synxis.com/pms-web-ui/service/v1/housekeeping/attendant-rooms",
    activeCfg.cookieHeader,
    {
      origin: "https://sph.synxis.com",
      pageid: "20052",
      pagename: "RoomsStatus",
      referer: "https://sph.synxis.com/pms-web-ui/housekeeping/rooms-status",
      timestamp: ts,
      "x-requested-with": "XMLHttpRequest",
      "baggage-usecase": "HouseKeeping",
    },
    {
      payload: {
        property: activeCfg.propertyId,
        batch: 1,
        businessDate: businessDateString,
      },
    },
  );

  if (!attendantRes.ok) {
    throw new Error(`SynXis attendant-rooms HTTP ${attendantRes.status}`);
  }

  const attendantJson = (await attendantRes.json()) as {
    data?: { roomUnits?: Array<Record<string, unknown>> };
  };

  const rooms = new Map<string, SynxisRoomSnapshot>();
  const roomtypeCounts: RoomtypeCounts = {};

  for (const unit of attendantJson.data?.roomUnits ?? []) {
    const roomNoRaw = unit.roomUnitNo;
    const roomNumber = String(roomNoRaw ?? "").trim();
    if (!/^\d+$/.test(roomNumber)) continue;

    const roomType = String(unit.roomUnitType ?? "");
    if (!ALLOWED_ROOM_TYPES.has(roomType)) continue;

    let occupancy = String(unit.occupancyStatus ?? "");
    const guestStatus = String(unit.guestStatus ?? "");
    if (guestStatus === "RESERVED" && occupancy === "Vacant") {
      occupancy = "Reserved";
    }

    let oooCode = unit.outOfOrderCode ? String(unit.outOfOrderCode) : "~";

    rooms.set(roomNumber, {
      roomNumber,
      roomType,
      hkStatus: String(unit.housekeepingStatus ?? "") || null,
      occupancy: occupancy || null,
      oooCode,
      guestName: null,
      checkInDate: null,
      checkOutDate: null,
      balanceCents: null,
    });
  }

  const guestPayload = {
    payload: {
      status: "inhouse",
      property: activeCfg.propertyId,
      startDate: businessDateString,
      viewType: "DetailedLookup",
    },
  };

  const guestRes = await synxisPost(
    "https://sph.synxis.com/pms-web-ui/service/v1/guest-mgt/guest-board/guest-details",
    activeCfg.cookieHeader,
    {
      origin: "https://sph.synxis.com",
      pageid: "20011",
      pagename: "GuestBoard",
      referer: "https://sph.synxis.com/pms-web-ui/guest-mgt/guest-board",
      timestamp: String(Date.now()),
      "x-requested-with": "XMLHttpRequest",
      "baggage-usecase": "GuestBoard",
    },
    guestPayload,
  );

  if (guestRes.ok) {
    const guestJson = (await guestRes.json()) as {
      data?: { reservations?: Record<string, Array<Record<string, unknown>>> };
    };
    const reservations = guestJson.data?.reservations ?? {};

    for (const status of ["stayOver", "departing"] as const) {
      for (const r of reservations[status] ?? []) {
        const roomDetails = r.roomDetails as Record<string, unknown> | undefined;
        const roomNoRaw = roomDetails?.roomNumber;
        const roomNumber = String(roomNoRaw ?? "").trim();
        if (!/^\d+$/.test(roomNumber)) continue;

        const guestInfo = (r.guestInfo as Array<Record<string, unknown>> | undefined)?.[0];
        const firstName = String(guestInfo?.firstName ?? "");
        const lastName = String(guestInfo?.lastName ?? "");
        const guestName = `${firstName} ${lastName}`.trim();
        const checkInDate = msToDateString(Number(guestInfo?.arrivalDate ?? 0));
        const checkOutDate = msToDateString(Number(guestInfo?.departureDate ?? 0));

        const existing = rooms.get(roomNumber);
        if (existing) {
          rooms.set(roomNumber, {
            ...existing,
            guestName: guestName ? guestName.replace(/\b\w/g, (c) => c.toUpperCase()) : null,
            checkInDate,
            checkOutDate,
          });
        }
      }
    }

    for (const status of ["stayOver"] as const) {
      for (const r of reservations[status] ?? []) {
        const roomType = String(
          (r.roomDetails as Record<string, unknown> | undefined)?.roomType ?? "",
        );
        if (roomType) {
          roomtypeCounts[roomType] = (roomtypeCounts[roomType] ?? 0) + 1;
        }
      }
    }
  }

  const arrivalRes = await synxisPost(
    "https://sph.synxis.com/pms-web-ui/service/v1/guest-mgt/guest-board/guest-details",
    activeCfg.cookieHeader,
    {
      origin: "https://sph.synxis.com",
      pageid: "20011",
      pagename: "GuestBoard",
      referer: "https://sph.synxis.com/pms-web-ui/guest-mgt/guest-board",
      timestamp: String(Date.now()),
      "x-requested-with": "XMLHttpRequest",
      "baggage-usecase": "GuestBoard",
    },
    {
      payload: {
        status: "arrival",
        property: activeCfg.propertyId,
        startDate: businessDateString,
        viewType: "DetailedLookup",
      },
    },
  );

  if (arrivalRes.ok) {
    const arrivalJson = (await arrivalRes.json()) as {
      data?: { reservations?: Record<string, Array<Record<string, unknown>>> };
    };
    for (const r of arrivalJson.data?.reservations?.arriving ?? []) {
      const roomType = String(
        (r.roomDetails as Record<string, unknown> | undefined)?.roomType ?? "",
      );
      if (roomType) {
        roomtypeCounts[roomType] = (roomtypeCounts[roomType] ?? 0) + 1;
      }
    }
  }

  return { rooms, roomtypeCounts, hotelDate };
}

export async function isSynxisConfigured(serviceClient?: SupabaseClient): Promise<boolean> {
  const hasEnv = Boolean(
    Deno.env.get("SYNXIS_USERNAME")?.trim() &&
      Deno.env.get("SYNXIS_PASSWORD")?.trim() &&
      Deno.env.get("SYNXIS_GMAIL_ADDRESS")?.trim() &&
      Deno.env.get("SYNXIS_GMAIL_APP_PASSWORD")?.trim(),
  );
  if (hasEnv) return true;
  return Boolean(await loadSynxisCookieHeader(serviceClient));
}
