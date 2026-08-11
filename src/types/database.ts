import type { UserRole } from "./roles";

export type Profile = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: UserRole;
  terminal_id: string | null;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Front-desk station heartbeat (extension / bridge updates `last_seen_at`). */
export type Terminal = {
  id: string;
  label: string | null;
  last_seen_at: string | null;
};

/** SynXis and eZee only in your schema (`pms_source` check). */
export type PmsSource = "synxis" | "ezee";

export type Reservation = {
  id: string;
  confirmation_number: string;
  pms_source: PmsSource;
  external_reservation_id: string | null;
  guest_name: string | null;
  room_number: string | null;
  check_in_date: string | null;
  check_out_date: string | null;
  reservation_status: string;
  dnr_hit: boolean;
  version: number;
  last_scraped_at: string | null;
  scrape_payload: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  guest_profile_id?: string | null;
  /** Optional DB columns (often `text`) when the scraper mirrors guest + folio onto the row. */
  email?: string | null;
  phone?: string | null;
  total?: string | null;
  paid?: string | null;
  balance?: string | null;
};

export type IdScan = {
  id: string;
  reservation_id: string | null;
  confirmation_number: string;
  scanned_by: string | null;
  terminal_id: string | null;
  scanned_at: string;
  manual_entry: boolean;
  ocr_provider: string | null;
  ocr_raw: Record<string, unknown> | null;
  pii_encrypted: Record<string, unknown>;
  image_front_path: string | null;
  image_back_path: string | null;
  phone_encrypted: Record<string, unknown> | null;
  email_encrypted: Record<string, unknown> | null;
  /** Privacy-safe lookup key (extension); multiple rows per guest allowed. */
  id_number_hash?: string | null;
  phone_number_hash?: string | null;
  created_at: string;
};

export type DnrEntry = {
  id: string;
  guest_name: string;
  id_number: string;
  date_of_birth: string | null;
  reason: string;
  status: "active" | "removed";
  flagged_by: string | null;
  flagged_at: string;
  removed_at: string | null;
  removed_by: string | null;
  removal_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type Signature = {
  id: string;
  confirmation_number: string;
  reservation_id: string | null;
  storage_path: string;
  signed_by: string;
  signed_by_username: string | null;
  terminal_id: string | null;
  created_at: string;
};

/**
 * Permanent RFID key encoding log (`key_history`). Column names may vary slightly
 * by migration; accessors in `lib/keyHistory.ts` normalize the common variants.
 */
export type KeyHistoryRow = {
  id: string;
  confirmation_number: string;
  reservation_id?: string | null;
  room_number: string | null;
  /** Stay start as logged by encoder (text / ISO); optional per schema */
  checkin_time?: string | null;
  /** Stay end as logged by encoder (text / ISO); optional per schema */
  checkout_time?: string | null;
  card_serial?: number | null;
  guest_name?: string | null;
  nights_encoded?: number | null;
  /** Alternate column name some schemas use */
  number_of_nights?: number | null;
  encoded_by_username?: string | null;
  agent_username?: string | null;
  encoded_by?: string | null;
  terminal_id: string | null;
  /** When the encoder reported success (optional). */
  success?: boolean | null;
  error_message?: string | null;
  encoded_at?: string | null;
  /** Default timestamp when the row was inserted */
  created_at?: string;
};

export type GuestProfileIdType = 'dl' | 'passport' | 'manual';

export type GuestProfile = {
  id: string;
  id_number_hash: string;
  id_type: GuestProfileIdType;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
};

export type AuditLogRow = {
  id: string;
  occurred_at: string;
  user_id: string | null;
  username: string | null;
  user_role: string | null;
  terminal_id: string | null;
  action_type: string;
  confirmation_number: string | null;
  description: string | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  ip_address: string | null;
  context: Record<string, unknown>;
};
