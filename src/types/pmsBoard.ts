export type PmsSoldBy = "synxis" | "ezee" | "neither";

export type PmsBoardRow = {
  room_number: string;
  room_type: string | null;
  status: string | null;
  synxis_hk_status: string | null;
  synxis_occupancy: string | null;
  synxis_ooo_code: string | null;
  synxis_guest_name: string | null;
  synxis_check_in_date: string | null;
  synxis_check_out_date: string | null;
  synxis_balance_cents: number | null;
  ezee_hk_status: string | null;
  ezee_occupancy: string | null;
  ezee_guest_name: string | null;
  ezee_check_in_date: string | null;
  ezee_check_out_date: string | null;
  ezee_balance_cents: number | null;
  ezee_booking_status: string | null;
  merged_guest_name: string | null;
  merged_check_in_date: string | null;
  merged_check_out_date: string | null;
  merged_balance_cents: number | null;
  sold_by: PmsSoldBy | null;
  synxis_synced_at: string | null;
  ezee_synced_at: string | null;
  pms_updated_at: string | null;
};

export type PmsApiStats = {
  status?: "ok" | "partial" | "failed";
  rooms_from_api?: number;
  rooms_with_occupancy?: number;
  rooms_with_hk?: number;
  inventory_rooms?: number;
  stale_rooms_used?: number;
  detail?: string;
};

export type PmsSyncState = {
  synxis?: {
    synced_at: string | null;
    hotel_date: string | null;
    source?: string;
    /** When DualPMS on the VPS last polled SynXis (informational). */
    dualpms_polled_at?: string | null;
    dualpms_healthy?: boolean;
    api?: PmsApiStats;
  };
  ezee?: {
    synced_at: string | null;
    source?: string;
    /** When DualPMS on the VPS last polled eZee (informational). */
    dualpms_polled_at?: string | null;
    dualpms_healthy?: boolean;
    api?: PmsApiStats;
  };
};

export type PmsSyncWarning = {
  system: "SynXis" | "eZee";
  message: string;
  at: string;
};

export type PmsSyncFreshnessIssue = {
  system: "SynXis" | "eZee";
  secondsAgo: number | null;
  stale: boolean;
  reason: "failed" | "missing" | "stale" | "fallback";
  detail: string;
};

export type PmsSyncFreshness = {
  synxisSecondsAgo: number | null;
  ezeeSecondsAgo: number | null;
  issues: PmsSyncFreshnessIssue[];
  warnings: string[];
  anyStale: boolean;
  fallbackActive: boolean;
};

export type PmsRoomtypeCounts = {
  synxis?: Record<string, number>;
  ezee?: Record<string, number>;
  totals?: Record<string, number>;
};

export const PMS_BOARD_QUERY_KEY = ["pms-board"] as const;
export const PMS_SYNC_STATE_KEY = ["pms-sync-state"] as const;

/** Client requirement: alert when PMS data is older than this (seconds). */
export const PMS_STALE_SYNC_THRESHOLD_SEC = 60;

/** DualPMS synxis.py / ezee.py poll interval + margin (seconds). */
export const DUALPMS_UPSTREAM_STALE_SEC = 45;

export type PmsSyncRunResult = {
  ok: boolean;
  at: string;
  synxis: { ok: boolean; rooms?: number; error?: string; source?: string; localOnly?: boolean };
  ezee: { ok: boolean; rooms?: number; error?: string };
  upserted?: number;
  error?: string;
};

/** Default inventory totals per type (DualPMS); used when DB counts unavailable. */
export const DEFAULT_ROOMTYPE_TOTALS: Record<string, number> = {
  NDD1: 91,
  NK1: 28,
  PND2: 3,
  PNK1: 3,
  SNK4: 3,
};

export const ROOM_TYPES = ["NDD1", "NK1", "PND2", "PNK1", "SNK4"] as const;

/** Blank PMS fields for an inventory room with no sync row yet. */
export function emptyPmsBoardRow(roomNumber: string): PmsBoardRow {
  return {
    room_number: roomNumber,
    room_type: null,
    status: null,
    synxis_hk_status: null,
    synxis_occupancy: null,
    synxis_ooo_code: null,
    synxis_guest_name: null,
    synxis_check_in_date: null,
    synxis_check_out_date: null,
    synxis_balance_cents: null,
    ezee_hk_status: null,
    ezee_occupancy: null,
    ezee_guest_name: null,
    ezee_check_in_date: null,
    ezee_check_out_date: null,
    ezee_balance_cents: null,
    ezee_booking_status: null,
    merged_guest_name: null,
    merged_check_in_date: null,
    merged_check_out_date: null,
    merged_balance_cents: null,
    sold_by: null,
    synxis_synced_at: null,
    ezee_synced_at: null,
    pms_updated_at: null,
  };
}
