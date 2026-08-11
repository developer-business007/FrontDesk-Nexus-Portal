/** Align `reservation_status` values with your Supabase CHECK constraint (lowercase). */
export const ReservationStatus = {
  Pending: "pending",
  CheckedIn: "checked_in",
  CheckedOut: "checked_out",
} as const;
