import { useQuery } from "@tanstack/react-query";
import { deriveCheckoutReadyKind } from "@/lib/checkoutReadyAlerts";
import {
  fetchHousekeepingStaff,
} from "@/lib/housekeeping";
import { fetchPmsSyncState } from "@/lib/pmsBoard";
import { currentBusinessDateNow, type HotelSettings } from "@/lib/hotelSettings";
import { supabase } from "@/lib/supabase";
import { fetchOpenHkAlerts } from "@/lib/hkAlerts";
import { fetchOpenMaintenanceTasks } from "@/lib/hkMaintenanceTasks";
import type {
  HkAlert,
  HkMaintenanceTask,
  HkTaskStatus,
  HkTaskType,
  HousekeepingBoardRow,
  HousekeepingStaff,
  HousekeepingTask,
} from "@/types/housekeeping";
import type { PmsBoardRow } from "@/types/pmsBoard";
import { fetchPmsBoardRows } from "@/lib/pmsBoard";
import {
  buildPmsTaskContext,
  canAssignHousekeepingByPms,
  canReassignHousekeepingTask,
} from "@/lib/housekeepingPmsRules";
import { isPmsRoomOccupied } from "@/lib/dashboardRoomStats";

export const HK_RA_MONITOR_KEY = ["housekeeping-ra-monitor"] as const;

const OPEN_STATUSES: HkTaskStatus[] = [
  "pending",
  "assigned",
  "in_progress",
  "inspection_pending",
];

export type RaMonitorBucket = "new" | "in_progress" | "finished" | "verified";

export type RaMonitorTaskRow = {
  task: HousekeepingTask;
  roomNumber: string;
  dutyLabel: string;
  priorityLabel: "High" | "Medium" | "Low";
  bucket: RaMonitorBucket;
  displayStatus: string;
  checkoutLabel: string;
  pmsStatusLabel: string;
  guestName: string | null;
  turnoverLabel: string;
  assignAllowed: boolean;
  assignBlockReason: string | null;
};

export type RaMonitorAttendantCard = {
  housekeeperId: string;
  name: string;
  tasks: RaMonitorTaskRow[];
  total: number;
  verified: number;
  finished: number;
  inProgress: number;
  remaining: number;
  progressPct: number;
};

export type RaMonitorPropertyStats = {
  totalTasks: number;
  verified: number;
  remaining: number;
  progressPct: number;
};

export type RaMonitorMaintenanceRow = {
  roomNumber: string;
  roomType: string;
  reason: string | null;
  roomStatus: string;
  assignedTo: string | null;
  assigneeName: string | null;
};

export type RaMonitorDepartureRow = {
  roomNumber: string;
  guestName: string;
  checkoutLabel: string;
  turnoverLabel: string;
  pmsStatus: string;
};

export type RaMonitorData = {
  hotelDate: string;
  property: RaMonitorPropertyStats;
  attendants: RaMonitorAttendantCard[];
  unassigned: RaMonitorTaskRow[];
  waitingCheckout: RaMonitorTaskRow[];
  maintenance: RaMonitorMaintenanceRow[];
  maintenanceTasks: HkMaintenanceTask[];
  alerts: HkAlert[];
  departures: RaMonitorDepartureRow[];
};

function dayBoundsUtc(date: string): [string, string] {
  return [`${date}T00:00:00.000Z`, `${date}T23:59:59.999Z`];
}

export async function resolveRaMonitorHotelDate(hotel: HotelSettings): Promise<string> {
  try {
    const sync = await fetchPmsSyncState();
    const pmsDate = sync?.synxis?.hotel_date?.trim();
    if (pmsDate && /^\d{4}-\d{2}-\d{2}/.test(pmsDate)) {
      return pmsDate.slice(0, 10);
    }
  } catch {
    // fall through
  }
  return currentBusinessDateNow(hotel);
}

export function taskTypeDutyLabel(type: HkTaskType | null | undefined): string {
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

export function priorityLabel(priority: number): "High" | "Medium" | "Low" {
  if (priority >= 8) return "High";
  if (priority >= 5) return "Medium";
  return "Low";
}

export function taskStatusBucket(status: HkTaskStatus): RaMonitorBucket {
  switch (status) {
    case "pending":
    case "assigned":
      return "new";
    case "in_progress":
      return "in_progress";
    case "inspection_pending":
      return "finished";
    case "completed":
      return "verified";
    default:
      return "new";
  }
}

const BUCKET_LABEL: Record<RaMonitorBucket, string> = {
  new: "New",
  in_progress: "In progress",
  finished: "Finished",
  verified: "Verified",
};

function formatCheckoutTime(dueAt: string | null | undefined): string {
  if (!dueAt) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(dueAt));
  } catch {
    return "—";
  }
}

function toMonitorRow(
  task: HousekeepingTask,
  pmsRow: PmsBoardRow | undefined,
  hotelDate: string,
  hotel?: HotelSettings,
): RaMonitorTaskRow {
  const bucket = taskStatusBucket(task.status);
  const pms = buildPmsTaskContext(pmsRow, task, hotelDate, hotel);
  const assignGate =
    task.assigned_to && (task.status === "in_progress" || task.status === "inspection_pending")
      ? canReassignHousekeepingTask(pmsRow, task)
      : canAssignHousekeepingByPms(pmsRow, task);

  return {
    task,
    roomNumber: task.room_number,
    dutyLabel: pms.dutyLabel,
    priorityLabel: priorityLabel(task.priority),
    bucket,
    displayStatus: BUCKET_LABEL[bucket],
    checkoutLabel: pms.checkoutLabel,
    pmsStatusLabel: pms.pmsStatusLabel,
    guestName: pms.guestName,
    turnoverLabel: pms.turnoverLabel,
    assignAllowed: assignGate.allowed,
    assignBlockReason: assignGate.reason,
  };
}

function buildAttendantCard(
  housekeeperId: string,
  name: string,
  tasks: RaMonitorTaskRow[],
): RaMonitorAttendantCard {
  const verified = tasks.filter((t) => t.bucket === "verified").length;
  const finished = tasks.filter((t) => t.bucket === "finished").length;
  const inProgress = tasks.filter((t) => t.bucket === "in_progress").length;
  const remaining = tasks.filter((t) => t.bucket !== "verified").length;
  const total = tasks.length;
  const progressPct = total > 0 ? Math.round((verified / total) * 100) : 0;

  const order: Record<RaMonitorBucket, number> = {
    in_progress: 0,
    new: 1,
    finished: 2,
    verified: 3,
  };

  const sorted = [...tasks].sort((a, b) => {
    const oa = order[a.bucket] ?? 9;
    const ob = order[b.bucket] ?? 9;
    if (oa !== ob) return oa - ob;
    if (a.priorityLabel !== b.priorityLabel) {
      const p = { High: 0, Medium: 1, Low: 2 };
      return p[a.priorityLabel] - p[b.priorityLabel];
    }
    return a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true });
  });

  return {
    housekeeperId,
    name,
    tasks: sorted,
    total,
    verified,
    finished,
    inProgress,
    remaining,
    progressPct,
  };
}

async function fetchDailyMonitorTasks(hotelDate: string): Promise<HousekeepingTask[]> {
  const [start, end] = dayBoundsUtc(hotelDate);

  const [openRes, completedRes] = await Promise.all([
    supabase.from("housekeeping_tasks").select("*").in("status", [...OPEN_STATUSES]),
    supabase
      .from("housekeeping_tasks")
      .select("*")
      .eq("status", "completed")
      .gte("completed_at", start)
      .lte("completed_at", end),
  ]);

  if (openRes.error) throw new Error(openRes.error.message);
  if (completedRes.error) throw new Error(completedRes.error.message);

  const byId = new Map<string, HousekeepingTask>();
  for (const row of [...(openRes.data ?? []), ...(completedRes.data ?? [])]) {
    byId.set(row.id, row as HousekeepingTask);
  }
  return [...byId.values()];
}

function staffDisplayName(s: HousekeepingStaff): string {
  return s.full_name?.trim() || s.email?.trim() || "—";
}

function normDate(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const s = value.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function guestNameFromPms(row: PmsBoardRow): string {
  return row.merged_guest_name?.trim() || row.synxis_guest_name?.trim() || row.ezee_guest_name?.trim() || "—";
}

function buildMaintenanceRows(
  board: HousekeepingBoardRow[],
  staffById: Map<string, HousekeepingStaff>,
): RaMonitorMaintenanceRow[] {
  return board
    .filter((r) => r.maintenance_blocked)
    .map((r) => ({
      roomNumber: r.room_number,
      roomType: r.room_type,
      reason: r.maintenance_reason,
      roomStatus: r.room_status,
      assignedTo: r.assigned_to,
      assigneeName: r.assigned_to ? staffDisplayName(staffById.get(r.assigned_to)!) : null,
    }))
    .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
}

function buildDepartureRows(
  pmsRows: PmsBoardRow[],
  hotelDate: string,
): RaMonitorDepartureRow[] {
  const rows: RaMonitorDepartureRow[] = [];

  for (const row of pmsRows) {
    const cout = normDate(row.merged_check_out_date);
    if (cout !== hotelDate || !isPmsRoomOccupied(row)) continue;

    const ready = deriveCheckoutReadyKind(row.status, row);
    const turnoverLabel =
      ready === "ready"
        ? "Ready"
        : ready === "cleaning"
          ? "Cleaning"
          : ready === "dirty"
            ? "Dirty"
            : ready === "occupied"
              ? "Occupied"
              : ready === "ooo"
                ? "OOO"
                : "—";

    rows.push({
      roomNumber: row.room_number,
      guestName: guestNameFromPms(row),
      checkoutLabel: formatCheckoutTime(
        row.merged_check_out_date ? `${row.merged_check_out_date}T12:00:00` : null,
      ),
      turnoverLabel,
      pmsStatus: row.synxis_occupancy ?? row.ezee_occupancy ?? "—",
    });
  }

  return rows.sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
}

export async function fetchRaMonitorData(
  hotelDate: string,
  hotel?: HotelSettings,
): Promise<RaMonitorData> {
  const [tasks, staff, boardRes, pmsRows, alerts, maintenanceTasks] = await Promise.all([
    fetchDailyMonitorTasks(hotelDate),
    fetchHousekeepingStaff(),
    supabase.from("v_housekeeping_board").select("*"),
    fetchPmsBoardRows(),
    fetchOpenHkAlerts(hotelDate),
    fetchOpenMaintenanceTasks(),
  ]);

  if (boardRes.error) throw new Error(boardRes.error.message);
  const board = (boardRes.data ?? []) as HousekeepingBoardRow[];
  const pmsByRoom = new Map(pmsRows.map((r) => [String(r.room_number).trim(), r]));

  const staffById = new Map(staff.map((s) => [s.id, s]));
  const byAttendant = new Map<string, RaMonitorTaskRow[]>();
  const unassigned: RaMonitorTaskRow[] = [];
  const waitingCheckout: RaMonitorTaskRow[] = [];

  for (const task of tasks) {
    const pmsRow = pmsByRoom.get(task.room_number.trim());
    const row = toMonitorRow(task, pmsRow, hotelDate, hotel);
    if (!task.assigned_to) {
      if (row.assignAllowed) {
        unassigned.push(row);
      } else {
        waitingCheckout.push(row);
      }
      continue;
    }
    const list = byAttendant.get(task.assigned_to) ?? [];
    list.push(row);
    byAttendant.set(task.assigned_to, list);
  }

  const attendantIds = new Set([...staff.map((s) => s.id), ...byAttendant.keys()]);
  const attendants: RaMonitorAttendantCard[] = [...attendantIds]
    .map((id) => {
      const member = staffById.get(id);
      const name = member ? staffDisplayName(member) : "Unknown staff";
      return buildAttendantCard(id, name, byAttendant.get(id) ?? []);
    })
    .filter((card) => card.total > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const allRows = tasks.map((task) =>
    toMonitorRow(task, pmsByRoom.get(task.room_number.trim()), hotelDate, hotel),
  );
  const propertyVerified = allRows.filter((t) => t.bucket === "verified").length;
  const propertyTotal = allRows.length;
  const propertyRemaining = propertyTotal - propertyVerified;

  return {
    hotelDate,
    property: {
      totalTasks: propertyTotal,
      verified: propertyVerified,
      remaining: propertyRemaining,
      progressPct: propertyTotal > 0 ? Math.round((propertyVerified / propertyTotal) * 100) : 0,
    },
    attendants,
    unassigned: unassigned.sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true })),
    waitingCheckout: waitingCheckout.sort((a, b) =>
      a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }),
    ),
    maintenance: buildMaintenanceRows(board, staffById),
    maintenanceTasks,
    alerts,
    departures: buildDepartureRows(pmsRows, hotelDate),
  };
}

export function useRaMonitor(hotelDate: string | undefined, hotel?: HotelSettings) {
  return useQuery({
    queryKey: [...HK_RA_MONITOR_KEY, hotelDate ?? "", hotel?.timezone ?? "", hotel?.defaultCheckoutTime ?? ""],
    queryFn: () => fetchRaMonitorData(hotelDate!, hotel),
    enabled: !!hotelDate,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

export function invalidateRaMonitorKeys() {
  return HK_RA_MONITOR_KEY;
}
