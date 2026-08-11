import { deriveCheckoutReadyKind, formatCheckoutReadyLabel } from "@/lib/checkoutReadyAlerts";
import type { HotelSettings } from "@/lib/hotelSettings";
import {
  formatPmsRoomStatus,
  isPmsRoomOccupied,
  isPmsRoomOutOfOrder,
  isPmsRoomVacant,
  pmsGuestNameForRoom,
} from "@/lib/dashboardRoomStats";
import type { HkTaskType, HousekeepingTask } from "@/types/housekeeping";
import type { PmsBoardRow } from "@/types/pmsBoard";

function taskTypeDutyLabel(type: HkTaskType | null | undefined): string {
  switch (type) {
    case "checkout_turnover":
      return "Due out";
    case "deep_clean":
      return "Full clean";
    case "touch_up":
      return "Refresh";
    case "inspection_only":
      return "Inspection";
    default:
      return "Turnover";
  }
}

export type HkAssignGate = {
  allowed: boolean;
  reason: string | null;
};

function normDate(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const s = value.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function formatPmsCheckoutLabel(
  pmsRow: PmsBoardRow | undefined,
  task: Pick<HousekeepingTask, "due_at">,
  hotel?: HotelSettings,
): string {
  const date = normDate(pmsRow?.merged_check_out_date ?? pmsRow?.synxis_check_out_date ?? pmsRow?.ezee_check_out_date);
  if (date && hotel) {
    const [hh, mm] = hotel.defaultCheckoutTime.split(":").map(Number);
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(`${date}T${String(hh).padStart(2, "0")}:${String(mm ?? 0).padStart(2, "0")}:00`));
    } catch {
      // fall through
    }
  }
  if (task.due_at) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(task.due_at));
    } catch {
      return "—";
    }
  }
  return "—";
}

/** Duty label aligned with DualPMS occupancy + checkout date. */
export function derivePmsDutyLabel(
  pmsRow: PmsBoardRow | undefined,
  task: Pick<HousekeepingTask, "task_type">,
  hotelDate: string,
): string {
  if (!pmsRow) return taskTypeDutyLabel(task.task_type);

  const cout = normDate(pmsRow.merged_check_out_date ?? pmsRow.synxis_check_out_date ?? pmsRow.ezee_check_out_date);
  const cin = normDate(pmsRow.merged_check_in_date ?? pmsRow.synxis_check_in_date ?? pmsRow.ezee_check_in_date);

  if (isPmsRoomOccupied(pmsRow)) {
    if (cout === hotelDate) return "Due out";
    if (cin === hotelDate) return "Arrival";
    return "Stayover";
  }

  if (isPmsRoomVacant(pmsRow)) {
    if (cout === hotelDate || task.task_type === "checkout_turnover") return "Due out";
  }

  return taskTypeDutyLabel(task.task_type);
}

export function buildPmsTaskContext(
  pmsRow: PmsBoardRow | undefined,
  task: Pick<HousekeepingTask, "due_at" | "task_type">,
  hotelDate: string,
  hotel?: HotelSettings,
): {
  pmsStatusLabel: string;
  guestName: string | null;
  dutyLabel: string;
  checkoutLabel: string;
  turnoverLabel: string;
} {
  const lifecycle = (pmsRow?.status as string | null) ?? null;
  const readyKind = deriveCheckoutReadyKind(lifecycle, pmsRow);

  return {
    pmsStatusLabel: formatPmsRoomStatus(pmsRow),
    guestName: pmsGuestNameForRoom(pmsRow),
    dutyLabel: derivePmsDutyLabel(pmsRow, task, hotelDate),
    checkoutLabel: formatPmsCheckoutLabel(pmsRow, task, hotel),
    turnoverLabel: formatCheckoutReadyLabel(readyKind),
  };
}

/** Block new assignment while DualPMS shows a guest in the room. */
export function canAssignHousekeepingByPms(
  pmsRow: PmsBoardRow | undefined,
  task?: Pick<HousekeepingTask, "task_type" | "status">,
): HkAssignGate {
  if (!pmsRow?.room_number) {
    return { allowed: false, reason: "No DualPMS data for this room — sync PMS first." };
  }

  if (isPmsRoomOutOfOrder(pmsRow)) {
    return { allowed: false, reason: "Room is out of order in DualPMS." };
  }

  if (isPmsRoomOccupied(pmsRow)) {
    if (task?.task_type === "touch_up") {
      return { allowed: true, reason: null };
    }
    const guest = pmsGuestNameForRoom(pmsRow);
    return {
      allowed: false,
      reason: guest
        ? `Guest still in room (${guest}) — wait for checkout per DualPMS.`
        : "Guest still in room per DualPMS — wait for checkout.",
    };
  }

  void task;
  return { allowed: true, reason: null };
}

export function canReassignHousekeepingTask(
  pmsRow: PmsBoardRow | undefined,
  task: Pick<HousekeepingTask, "task_type" | "status">,
): HkAssignGate {
  if (task.status === "completed") {
    return { allowed: false, reason: "Task already verified." };
  }
  if (task.status === "in_progress" || task.status === "inspection_pending") {
    return { allowed: true, reason: null };
  }
  return canAssignHousekeepingByPms(pmsRow, task);
}

export function isHousekeeperAssignableRole(role: string): boolean {
  return role === "housekeeper";
}

export function filterAssignableHousekeepers<T extends { id: string; role: string }>(
  staff: T[],
  excludeUserId?: string | null,
): T[] {
  return staff.filter(
    (s) => isHousekeeperAssignableRole(s.role) && (!excludeUserId || s.id !== excludeUserId),
  );
}
