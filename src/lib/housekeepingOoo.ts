import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HOUSEKEEPING_BOARD_KEY } from "@/lib/housekeeping";
import { supabase } from "@/lib/supabase";
import { PMS_BOARD_QUERY_KEY } from "@/types/pmsBoard";
import type { RoomLifecycleStatus, RoomOperationalStatus } from "@/types/housekeeping";

export async function fetchRoomPmsOooCode(roomNumber: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("room_operational_status")
    .select("synxis_ooo_code")
    .eq("room_number", roomNumber)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return typeof data?.synxis_ooo_code === "string" ? data.synxis_ooo_code : null;
}

function isPmsOooCodeActive(code: string | null | undefined): boolean {
  const ooo = code?.trim();
  return !!ooo && ooo !== "~" && ooo !== "FD";
}

async function setRoomLifecycle(
  roomNumber: string,
  status: RoomLifecycleStatus,
  reason: string,
): Promise<RoomOperationalStatus> {
  const { data, error } = await supabase
    .from("room_operational_status")
    .update({
      status,
      status_reason: reason,
      status_changed_at: new Date().toISOString(),
    })
    .eq("room_number", roomNumber)
    .select("room_number, status, current_task_id, confirmation_number, occupied_confirmation, status_reason, status_changed_at, version")
    .single();

  if (error) throw new Error(error.message);
  return data as RoomOperationalStatus;
}

export async function setRoomOutOfOrder(
  roomNumber: string,
  reason?: string | null,
): Promise<RoomOperationalStatus> {
  return setRoomLifecycle(roomNumber, "out_of_order", reason?.trim() || "Set OOO from housekeeping board");
}

export async function clearRoomOutOfOrder(
  roomNumber: string,
  reason?: string | null,
): Promise<RoomOperationalStatus> {
  const oooCode = await fetchRoomPmsOooCode(roomNumber);
  if (isPmsOooCodeActive(oooCode)) {
    throw new Error("Cannot clear OOO — room is still out of order in SynXis PMS");
  }

  const { data: row, error: readError } = await supabase
    .from("room_operational_status")
    .select("synxis_occupancy, ezee_occupancy, synxis_ooo_code")
    .eq("room_number", roomNumber)
    .maybeSingle();

  if (readError) throw new Error(readError.message);
  if (row) {
    const ooo = row.synxis_ooo_code?.trim();
    const blocked =
      (!!ooo && ooo !== "~" && ooo !== "FD") ||
      row.synxis_occupancy === "Blocked" ||
      row.ezee_occupancy === "Blocked";
    if (blocked) {
      throw new Error("Cannot clear OOO — room is blocked in PMS");
    }
  }

  return setRoomLifecycle(roomNumber, "available", reason?.trim() || "OOO cleared from housekeeping board");
}

export function useSetRoomOutOfOrder(userId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { roomNumber: string; reason?: string | null }) =>
      setRoomOutOfOrder(vars.roomNumber, vars.reason),
    onSuccess: async () => {
      await Promise.all([
        qc.refetchQueries({ queryKey: HOUSEKEEPING_BOARD_KEY }),
        qc.refetchQueries({ queryKey: PMS_BOARD_QUERY_KEY }),
        qc.refetchQueries({ queryKey: ["room-operational-status-map"] }),
        userId
          ? qc.refetchQueries({ queryKey: ["housekeeping-tasks", "mine", userId] })
          : Promise.resolve(),
      ]);
    },
  });
}

export function useClearRoomOutOfOrder(userId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { roomNumber: string; reason?: string | null }) =>
      clearRoomOutOfOrder(vars.roomNumber, vars.reason),
    onSuccess: async () => {
      await Promise.all([
        qc.refetchQueries({ queryKey: HOUSEKEEPING_BOARD_KEY }),
        qc.refetchQueries({ queryKey: PMS_BOARD_QUERY_KEY }),
        qc.refetchQueries({ queryKey: ["room-operational-status-map"] }),
        userId
          ? qc.refetchQueries({ queryKey: ["housekeeping-tasks", "mine", userId] })
          : Promise.resolve(),
      ]);
    },
  });
}
