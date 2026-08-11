import { supabase } from "@/lib/supabase";

/** Mark a room dirty after a manual checkout (keys board, etc.). */
export async function autoMarkDirtyOnCheckout(
  roomNumber: string,
  note = "Auto: guest checkout",
): Promise<{ ok: boolean; error: string | null }> {
  const room = roomNumber.trim().toUpperCase();
  if (!room) return { ok: false, error: "Room number is required" };

  const { error } = await supabase.rpc("hk_mark_room_dirty", {
    p_room_number: room,
    p_notes: note,
  });

  if (error) {
    if (/already|dirty|open task|in service|duplicate/i.test(error.message)) {
      return { ok: true, error: null };
    }
    return { ok: false, error: error.message };
  }

  return { ok: true, error: null };
}
