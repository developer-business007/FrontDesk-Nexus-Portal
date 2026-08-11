import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { sortRoomNumbers } from "@/lib/roomInventory";

export const HOTEL_ROOMS_QUERY_KEY = ["hotel-rooms"] as const;

/** Active room numbers from `public.rooms` (canonical inventory). */
export async function fetchHotelRoomNumbers(): Promise<string[]> {
  const { data, error } = await supabase
    .from("rooms")
    .select("room_number")
    .eq("is_active", true);

  if (error) {
    throw new Error(error.message);
  }

  const numbers = (data ?? [])
    .map((r) => String((r as { room_number: string }).room_number).trim())
    .filter(Boolean);

  return sortRoomNumbers(numbers);
}

/**
 * Writes parsed room numbers to `public.rooms` via DB function
 * `hk_sync_rooms_from_text` (same range syntax as the old env list).
 */
export async function syncRoomsFromText(
  roomList: string,
): Promise<{ count: number; error: Error | null }> {
  const { data, error } = await supabase.rpc("hk_sync_rooms_from_text", {
    p_room_list: roomList,
  });

  if (error) {
    return { count: 0, error: new Error(error.message) };
  }

  const count = typeof data === "number" ? data : Number(data) || 0;
  return { count, error: null };
}

export function useHotelRoomInventory() {
  return useQuery({
    queryKey: HOTEL_ROOMS_QUERY_KEY,
    queryFn: fetchHotelRoomNumbers,
    staleTime: 5 * 60_000,
  });
}

export function useInvalidateHotelRooms() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: HOTEL_ROOMS_QUERY_KEY });
}

/** Comma-separated list for the Settings textarea (sorted numeric rooms). */
export function formatRoomListForEditor(rooms: string[]): string {
  return sortRoomNumbers(rooms).join(", ");
}
