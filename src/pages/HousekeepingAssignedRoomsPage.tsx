import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useHousekeepingStaff } from "@/lib/housekeeping";
import {
  fetchOpenHousekeepingTasks,
  loadDutyRowsForDate,
  useSaveDutyAssignments,
  type DutyRow,
} from "@/lib/hkTaskOps";
import { derivePmsDutyLabel } from "@/lib/housekeepingPmsRules";
import { resolveRaMonitorHotelDate } from "@/lib/hkRaMonitor";
import { fetchDailySchedules } from "@/lib/housekeepingSchedule";
import { useHotelSettings } from "@/lib/hotelSettings";
import { fetchPmsBoardRows } from "@/lib/pmsBoard";
import { parseHotelRoomList, sortRoomNumbers } from "@/lib/roomInventory";
import { useQuery } from "@tanstack/react-query";
import type { HousekeepingStaff } from "@/types/housekeeping";
import type { PmsBoardRow } from "@/types/pmsBoard";

function staffLabel(s: { full_name: string | null; email: string | null }): string {
  return s.full_name?.trim() || s.email?.trim() || "—";
}

function formatUpdatedAt(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return "—";
  }
}

type RoomSummaryRow = {
  roomNumber: string;
  dutyLabel: string;
  housekeeperId: string | null;
  housekeeperName: string;
  updatedAt: string | null;
};

function buildRoomSummary(
  draftRows: DutyRow[],
  housekeepers: HousekeepingStaff[],
  tasks: Awaited<ReturnType<typeof fetchOpenHousekeepingTasks>>,
  schedules: Awaited<ReturnType<typeof fetchDailySchedules>>,
  pmsByRoom: Map<string, PmsBoardRow>,
  hotelDate: string,
): RoomSummaryRow[] {
  const hkById = new Map(housekeepers.map((h) => [h.id, h]));
  const taskByRoom = new Map(tasks.map((t) => [t.room_number.trim(), t]));
  const scheduleByHk = new Map(schedules.map((s) => [s.housekeeper_id, s]));
  const roomOwner = new Map<string, string>();

  for (const row of draftRows) {
    for (const room of parseHotelRoomList(row.roomText)) {
      roomOwner.set(room, row.housekeeperId);
    }
  }

  const rooms = sortRoomNumbers([
    ...new Set([
      ...roomOwner.keys(),
      ...tasks.filter((t) => t.assigned_to).map((t) => t.room_number.trim()),
    ]),
  ]);

  return rooms.map((roomNumber) => {
    const housekeeperId = roomOwner.get(roomNumber) ?? taskByRoom.get(roomNumber)?.assigned_to ?? null;
    const hk = housekeeperId ? hkById.get(housekeeperId) : null;
    const task = taskByRoom.get(roomNumber);
    const schedule = housekeeperId ? scheduleByHk.get(housekeeperId) : null;
    const pmsRow = pmsByRoom.get(roomNumber);
    const dutyLabel = task
      ? derivePmsDutyLabel(pmsRow, task, hotelDate)
      : "—";
    const updatedAt = task?.assigned_at ?? schedule?.updated_at ?? null;

    return {
      roomNumber,
      dutyLabel,
      housekeeperId,
      housekeeperName: hk ? staffLabel(hk) : "—",
      updatedAt,
    };
  });
}

export function HousekeepingAssignedRoomsPage() {
  const { profile } = useAuth();
  const hotel = useHotelSettings();
  const staffQuery = useHousekeepingStaff();

  const hotelDateQuery = useQuery({
    queryKey: ["assigned-rooms-hotel-date", hotel.timezone, hotel.businessDayCutoffHour],
    queryFn: () => resolveRaMonitorHotelDate(hotel),
    staleTime: 60_000,
  });
  const hotelDate = hotelDateQuery.data ?? new Date().toISOString().slice(0, 10);

  const dutyQuery = useQuery({
    queryKey: ["hk-duty-rows", hotelDate, staffQuery.data?.length ?? 0] as const,
    queryFn: () => loadDutyRowsForDate(hotelDate, staffQuery.data ?? []),
    enabled: !!staffQuery.data?.length && !!hotelDateQuery.data,
    staleTime: 10_000,
  });

  const tasksQuery = useQuery({
    queryKey: ["hk-open-tasks", "assigned-rooms"] as const,
    queryFn: fetchOpenHousekeepingTasks,
    enabled: !!hotelDateQuery.data,
    staleTime: 10_000,
  });

  const schedulesQuery = useQuery({
    queryKey: ["hk-daily-schedules", hotelDate, "assigned-rooms"] as const,
    queryFn: () => fetchDailySchedules(hotelDate),
    enabled: !!hotelDateQuery.data,
    staleTime: 10_000,
  });

  const pmsQuery = useQuery({
    queryKey: ["pms-board", "assigned-rooms"] as const,
    queryFn: fetchPmsBoardRows,
    staleTime: 15_000,
  });

  const saveMutation = useSaveDutyAssignments(hotelDate);
  const [rows, setRows] = useState<DutyRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const housekeepers = useMemo(
    () => (staffQuery.data ?? []).filter((s) => s.role === "housekeeper"),
    [staffQuery.data],
  );

  useEffect(() => {
    if (dutyQuery.data) {
      setRows(dutyQuery.data);
      setDirty(false);
    }
  }, [dutyQuery.data]);

  const roomCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.housekeeperId, parseHotelRoomList(row.roomText).length);
    }
    return counts;
  }, [rows]);

  const totalRooms = useMemo(
    () => [...roomCounts.values()].reduce((sum, n) => sum + n, 0),
    [roomCounts],
  );

  const pmsByRoom = useMemo(() => {
    const m = new Map<string, PmsBoardRow>();
    for (const r of pmsQuery.data ?? []) m.set(String(r.room_number).trim(), r);
    return m;
  }, [pmsQuery.data]);

  const roomSummary = useMemo(
    () =>
      buildRoomSummary(
        rows,
        housekeepers,
        tasksQuery.data ?? [],
        schedulesQuery.data ?? [],
        pmsByRoom,
        hotelDate,
      ),
    [rows, housekeepers, tasksQuery.data, schedulesQuery.data, pmsByRoom, hotelDate],
  );

  function updateRow(housekeeperId: string, roomText: string) {
    setDirty(true);
    setNotice(null);
    setRows((prev) =>
      prev.map((r) =>
        r.housekeeperId === housekeeperId
          ? { ...r, roomText, rooms: parseHotelRoomList(roomText) }
          : r,
      ),
    );
  }

  async function handleSave() {
    setActionError(null);
    setNotice(null);
    try {
      const result = await saveMutation.mutateAsync({
        rows,
        createdBy: profile?.id ?? null,
      });
      setDirty(false);
      setNotice(
        `Saved ${result.schedulesSaved} schedule(s) · ${result.assigned} assigned · ${result.blocked} blocked (guest in room) · ${result.skipped} skipped`,
      );
      void dutyQuery.refetch();
      void tasksQuery.refetch();
      void schedulesQuery.refetch();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Batch save failed");
    }
  }

  const loading =
    hotelDateQuery.isLoading ||
    staffQuery.isLoading ||
    dutyQuery.isLoading ||
    tasksQuery.isLoading;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Assigned rooms</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            MOP duty list — set each housekeeper&apos;s rooms for {hotelDate}, then batch save to
            update schedule and live assignments.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium hover:bg-[var(--surface-2)] disabled:opacity-40"
            onClick={() => {
              setDirty(false);
              void dutyQuery.refetch();
              void hotelDateQuery.refetch();
              void tasksQuery.refetch();
              void schedulesQuery.refetch();
              void pmsQuery.refetch();
            }}
            disabled={dutyQuery.isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${dutyQuery.isFetching ? "animate-spin" : ""}`} aria-hidden />
            Refresh
          </button>
          <button
            type="button"
            className="btn-primary inline-flex h-9 items-center gap-2 px-4 text-[13px] disabled:opacity-40"
            onClick={() => void handleSave()}
            disabled={saveMutation.isPending || rows.length === 0}
          >
            <Save className="h-4 w-4" aria-hidden />
            {saveMutation.isPending ? "Saving…" : "Batch save"}
          </button>
        </div>
      </div>

      <section className="mb-4 flex flex-wrap gap-2 text-[12px]">
        <span className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1">
          Housekeepers <strong>{housekeepers.length}</strong>
        </span>
        <span className="rounded-full border border-sky-300/80 bg-sky-50/80 px-2.5 py-1 text-sky-950 dark:border-sky-900/40 dark:bg-sky-950/25 dark:text-sky-100">
          Rooms listed <strong>{totalRooms}</strong>
        </span>
        {dirty ? (
          <span className="rounded-full border border-amber-300/80 bg-amber-50/80 px-2.5 py-1 text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/25 dark:text-amber-100">
            Unsaved changes
          </span>
        ) : null}
      </section>

      {notice ? (
        <p className="mb-3 rounded-lg border border-emerald-300/70 bg-emerald-50/80 px-3 py-2 text-sm text-emerald-950 dark:border-emerald-800/40 dark:bg-emerald-950/25 dark:text-emerald-100">
          {notice}
        </p>
      ) : null}
      {actionError ? (
        <p className="mb-3 text-sm text-red-500" role="alert">
          {actionError}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading duty lists…</p>
      ) : housekeepers.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No active housekeepers found.</p>
      ) : (
        <div className="space-y-3">
          {housekeepers.map((hk) => {
            const row = rows.find((r) => r.housekeeperId === hk.id) ?? {
              housekeeperId: hk.id,
              roomText: "",
              rooms: [],
            };
            const count = roomCounts.get(hk.id) ?? 0;
            return (
              <section
                key={hk.id}
                className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
              >
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="font-semibold text-[var(--text-h)]">{staffLabel(hk)}</h2>
                    <p className="text-[12px] text-[var(--text-muted)]">
                      {count} room{count !== 1 ? "s" : ""} in duty list
                    </p>
                  </div>
                </div>
                <label className="block text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  Rooms (comma or range, e.g. 101-120, 205)
                  <textarea
                    className="input-field mt-1.5 min-h-[4.5rem] w-full resize-y font-mono text-sm normal-case tracking-normal"
                    value={row.roomText}
                    onChange={(e) => updateRow(hk.id, e.target.value)}
                    placeholder="101-110, 112, 115"
                    aria-label={`Rooms for ${staffLabel(hk)}`}
                  />
                </label>
              </section>
            );
          })}
        </div>
      )}

      {roomSummary.length > 0 ? (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Room summary
          </h2>
          <p className="mb-3 text-[12px] text-[var(--text-muted)]">
            MOP-style view — room, duty from DualPMS, assignee, and last assignment update.
          </p>
          <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="data-table min-w-[640px] text-left text-sm">
              <thead>
                <tr>
                  <th scope="col">Room</th>
                  <th scope="col">Duty</th>
                  <th scope="col">Housekeeper</th>
                  <th scope="col">Last updated</th>
                </tr>
              </thead>
              <tbody>
                {roomSummary.map((row) => (
                  <tr key={row.roomNumber}>
                    <td className="font-mono font-semibold">{row.roomNumber}</td>
                    <td>{row.dutyLabel}</td>
                    <td>{row.housekeeperName}</td>
                    <td className="text-[var(--text-muted)]">{formatUpdatedAt(row.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <p className="mt-4 text-[12px] text-[var(--text-muted)]">
        Batch save updates today&apos;s schedule and assigns open tasks. Rooms with a guest still in
        (DualPMS) are skipped for due outs — housekeeper sees &quot;Wait checkout&quot; on My tasks.
      </p>
    </div>
  );
}
