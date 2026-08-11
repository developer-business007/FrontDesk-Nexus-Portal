import { useMemo, useState, type FormEvent } from "react";
import { ChevronLeft, ChevronRight, Plus, RefreshCw, Sun, Trash2, X } from "lucide-react";
import { DateField } from "@/components/ui/DateField";
import { SearchField } from "@/components/ui/SearchField";
import { useAuth } from "@/contexts/AuthContext";
import { fetchHousekeepingBoard } from "@/lib/housekeeping";
import { useQuery } from "@tanstack/react-query";
import {
  bestSuggestionForFloor,
  floorFromRoom,
  useApplyDailySchedule,
  useAreaSuggestions,
  useDeleteDailySchedule,
  useDailySchedules,
  useUpsertDailySchedule,
  type ApplyScheduleResult,
  type AreaSuggestion,
} from "@/lib/housekeepingSchedule";
import { useAllHousekeepingStaff } from "@/lib/housekeepingStaff";
import { parseHotelRoomList } from "@/lib/roomInventory";
import { FilterSelect } from "@/components/ui/FilterSelect";
import type { HkDailySchedule } from "@/types/housekeeping";
import type { Profile } from "@/types/database";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function offsetDate(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function displayDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(new Date(`${iso}T12:00:00`));
  } catch {
    return iso;
  }
}

function staffLabel(s: { full_name: string | null; email: string | null }): string {
  return s.full_name?.trim() || s.email?.trim() || "—";
}

// ---------------------------------------------------------------------------
// Room picker modal
// ---------------------------------------------------------------------------

function RoomPickerModal({
  existingRooms,
  schedulesByRoom,
  staffById,
  suggestions,
  housekeeperFloor,
  busy,
  defaultApplyToBoard,
  onClose,
  onSave,
}: {
  existingRooms: string[];
  schedulesByRoom: Map<string, string>;
  staffById: Map<string, Pick<Profile, "full_name" | "email">>;
  suggestions: AreaSuggestion[];
  housekeeperFloor: number | null;
  busy: boolean;
  defaultApplyToBoard: boolean;
  onClose: () => void;
  onSave: (rooms: string[], notes: string, applyToBoard: boolean) => void;
}) {
  const boardQuery = useQuery({
    queryKey: ["housekeeping-board-rooms"] as const,
    queryFn: fetchHousekeepingBoard,
    staleTime: 60_000,
  });

  const [selected, setSelected] = useState<Set<string>>(() => new Set(existingRooms));
  const [search, setSearch] = useState("");
  const [rangeInput, setRangeInput] = useState("");
  const [notes, setNotes] = useState("");
  const [applyToBoard, setApplyToBoard] = useState(defaultApplyToBoard);

  const inventoryRooms = useMemo(
    () => new Set((boardQuery.data ?? []).map((r) => r.room_number)),
    [boardQuery.data],
  );

  function addRangeToSelection() {
    const parsed = parseHotelRoomList(rangeInput);
    if (!parsed.length) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const room of parsed) {
        if (inventoryRooms.has(room)) next.add(room);
      }
      return next;
    });
    setRangeInput("");
  }

  const allRooms = useMemo(() => {
    const rows = boardQuery.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.room_number.toLowerCase().includes(q));
  }, [boardQuery.data, search]);

  const floors = useMemo(() => {
    const set = new Set<number>();
    for (const r of boardQuery.data ?? []) set.add(r.floor);
    return [...set].sort((a, b) => a - b);
  }, [boardQuery.data]);

  function toggle(room: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(room)) next.delete(room);
      else next.add(room);
      return next;
    });
  }

  function selectFloor(floor: number) {
    const floorRooms = (boardQuery.data ?? [])
      .filter((r) => r.floor === floor)
      .map((r) => r.room_number);
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = floorRooms.every((r) => next.has(r));
      for (const r of floorRooms) {
        if (allSelected) next.delete(r);
        else next.add(r);
      }
      return next;
    });
  }

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="room-picker-title"
    >
      <div className="flex h-full max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl">
        {/* Header */}
        <div className="border-b border-[var(--border)] px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <h2 id="room-picker-title" className="text-lg font-semibold text-[var(--text-h)]">
              Assign rooms
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-h)]"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          {/* Smart suggestion banner */}
          {housekeeperFloor !== null && (() => {
            const sug = bestSuggestionForFloor(suggestions, housekeeperFloor);
            return sug ? (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/25 dark:text-amber-100">
                <Sun className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  Based on the last 14 days:{" "}
                  <strong>
                    {staffById.get(sug.housekeeper_id)?.full_name ?? "Unknown"}
                  </strong>{" "}
                  is the best match for Floor {sug.floor} ({sug.cleanCount} cleans
                  {sug.complaintCount > 0 ? `, ${sug.complaintCount} complaints` : ", no complaints"}
                  {sug.continuityBoost ? ", same area yesterday with no complaints" : ""}).
                </span>
              </div>
            ) : null;
          })()}

          <div className="mt-3">
            <SearchField
              placeholder="Search room…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search rooms"
            />
          </div>

          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="min-w-[10rem] flex-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Add range
              <input
                type="text"
                className="input-field mt-1 w-full font-mono text-sm normal-case tracking-normal"
                placeholder="101-120"
                value={rangeInput}
                onChange={(e) => setRangeInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addRangeToSelection();
                  }
                }}
                aria-label="Room range"
              />
            </label>
            <button
              type="button"
              className="btn-secondary inline-flex h-9 shrink-0 items-center px-3 text-[12px]"
              disabled={!rangeInput.trim()}
              onClick={addRangeToSelection}
            >
              Add range
            </button>
          </div>

          {/* Floor quick-select */}
          {!search && floors.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {floors.map((f) => {
                const floorRooms = (boardQuery.data ?? []).filter((r) => r.floor === f);
                const allSel = floorRooms.length > 0 && floorRooms.every((r) => selected.has(r.room_number));
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => selectFloor(f)}
                    className={[
                      "rounded-md border px-2 py-0.5 text-[11.5px] font-medium transition-colors",
                      allSel
                        ? "border-[var(--accent-border)] bg-[var(--accent-muted-strong)] text-[var(--accent)]"
                        : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] hover:bg-[var(--surface-3)]",
                    ].join(" ")}
                  >
                    Floor {f}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* Room list */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {boardQuery.isLoading ? (
            <p className="py-6 text-center text-sm text-[var(--text-muted)]">Loading rooms…</p>
          ) : allRooms.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--text-muted)]">No rooms found.</p>
          ) : (
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {allRooms.map((room) => {
                const isSel = selected.has(room.room_number);
                const otherHkId = schedulesByRoom.get(room.room_number);
                const otherHk = otherHkId ? staffById.get(otherHkId) : undefined;
                return (
                  <button
                    key={room.room_number}
                    type="button"
                    onClick={() => toggle(room.room_number)}
                    className={[
                      "flex items-center justify-between gap-1 rounded-lg border px-2.5 py-2 text-left text-[12.5px] font-medium transition-colors",
                      isSel
                        ? "border-[var(--accent-border)] bg-[var(--accent-muted-strong)] text-[var(--accent)]"
                        : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-h)] hover:bg-[var(--surface-3)]",
                    ].join(" ")}
                  >
                    <span className="font-mono">{room.room_number}</span>
                    {otherHk ? (
                      <span className="truncate text-[10.5px] text-[var(--text-muted)]">
                        {staffLabel(otherHk)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Notes + footer */}
        <div className="border-t border-[var(--border)] px-5 py-4">
          <label className="block text-sm font-medium text-[var(--text-h)]">
            Notes (optional)
            <textarea
              className="input-field mt-1.5 w-full resize-none text-sm"
              rows={2}
              placeholder="e.g. Focus on late checkouts first"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <label className="mt-3 flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-[var(--border)]"
              checked={applyToBoard}
              onChange={(e) => setApplyToBoard(e.target.checked)}
            />
            Apply to board — create tasks and assign to this housekeeper
          </label>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-[12.5px] text-[var(--text-muted)]">
              {selected.size} room{selected.size !== 1 ? "s" : ""} selected
            </span>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy || selected.size === 0}
                onClick={() => onSave([...selected], notes, applyToBoard)}
              >
                {busy ? "Saving…" : applyToBoard ? "Save & apply" : "Save schedule"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add housekeeper modal (pick housekeeper first)
// ---------------------------------------------------------------------------

function AddHousekeeperModal({
  staff,
  scheduledIds,
  onClose,
  onPick,
}: {
  staff: Profile[];
  scheduledIds: Set<string>;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const unscheduled = staff.filter((s) => !scheduledIds.has(s.id) && s.is_active);
  const [pick, setPick] = useState(unscheduled[0]?.id ?? "");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!pick) return;
    onPick(pick);
  }

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-hk-title"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl"
      >
        <h2 id="add-hk-title" className="text-lg font-semibold text-[var(--text-h)]">
          Add housekeeper to schedule
        </h2>
        {unscheduled.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--text-muted)]">
            All active housekeeping staff already have a schedule for this day.
          </p>
        ) : (
          <>
            <label className="mt-4 block text-sm font-medium text-[var(--text-h)]">
              Housekeeper
              <FilterSelect
                className="mt-1.5"
                value={pick}
                onChange={(e) => setPick(e.target.value)}
                required
              >
                {unscheduled.map((s) => (
                  <option key={s.id} value={s.id}>
                    {staffLabel(s)} — {s.role}
                  </option>
                ))}
              </FilterSelect>
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={!pick}>
                Next: pick rooms
              </button>
            </div>
          </>
        )}
        {unscheduled.length === 0 ? (
          <div className="mt-4 flex justify-end">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Close
            </button>
          </div>
        ) : null}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedule card for one housekeeper
// ---------------------------------------------------------------------------

function ScheduleCard({
  schedule,
  staffById,
  busy,
  onEdit,
  onDelete,
}: {
  schedule: HkDailySchedule;
  staffById: Map<string, Pick<Profile, "full_name" | "email">>;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const hk = schedule.housekeeper ?? staffById.get(schedule.housekeeper_id);
  const rooms = schedule.assigned_rooms;

  const byFloor = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const r of rooms) {
      const f = floorFromRoom(r);
      const existing = m.get(f);
      if (existing) existing.push(r);
      else m.set(f, [r]);
    }
    return [...m.entries()].sort(([a], [b]) => a - b);
  }, [rooms]);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-[var(--text-h)]">
            {hk ? staffLabel(hk) : "Unknown"}
          </p>
          <p className="mt-0.5 text-[12px] capitalize text-[var(--text-muted)]">
            {schedule.housekeeper?.role?.replace("_", " ") ?? "—"}
          </p>
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            className="btn-secondary inline-flex h-7 items-center gap-1.5 px-2.5 text-[12px]"
          >
            Edit rooms
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            title="Remove from schedule"
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-red-300/70 bg-red-50 text-red-600 transition-colors hover:bg-red-100 disabled:opacity-40 dark:border-red-800/50 dark:bg-red-950/20 dark:text-red-300 dark:hover:bg-red-950/40"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">Delete</span>
          </button>
        </div>
      </div>

      {rooms.length === 0 ? (
        <p className="mt-3 text-[12.5px] italic text-[var(--text-muted)]">No rooms assigned yet.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {byFloor.map(([floor, floorRooms]) => (
            <div key={floor}>
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                Floor {floor}
              </p>
              <div className="flex flex-wrap gap-1">
                {floorRooms.sort().map((r) => (
                  <span
                    key={r}
                    className="inline-flex rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[11.5px] text-[var(--text-h)]"
                  >
                    {r}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {schedule.notes ? (
        <p className="mt-3 text-[12px] text-[var(--text-muted)]">{schedule.notes}</p>
      ) : null}

      <p className="mt-2 text-[11px] text-[var(--text-muted)] tabular-nums">
        {rooms.length} room{rooms.length !== 1 ? "s" : ""}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function HousekeepingSchedulePage() {
  const { profile } = useAuth();
  const [date, setDate] = useState(todayIso());

  const schedulesQuery = useDailySchedules(date);
  const staffQuery = useAllHousekeepingStaff();
  const suggestionsQuery = useAreaSuggestions();
  const upsertMutation = useUpsertDailySchedule(date);
  const deleteMutation = useDeleteDailySchedule(date);
  const applyMutation = useApplyDailySchedule(date);

  const [showAddHk, setShowAddHk] = useState(false);
  const [roomPickTarget, setRoomPickTarget] = useState<{
    housekeeperId: string;
    existingRooms: string[];
    scheduleId: string | null;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyScheduleResult | null>(null);

  const staffById = useMemo(() => {
    const m = new Map<string, Pick<Profile, "full_name" | "email">>();
    for (const s of staffQuery.data ?? []) m.set(s.id, s);
    return m;
  }, [staffQuery.data]);

  const scheduledIds = useMemo(
    () => new Set((schedulesQuery.data ?? []).map((s) => s.housekeeper_id)),
    [schedulesQuery.data],
  );

  // Map room_number → housekeeper_id for the current day (to show in picker)
  const schedulesByRoom = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of schedulesQuery.data ?? []) {
      for (const r of s.assigned_rooms) m.set(r, s.housekeeper_id);
    }
    return m;
  }, [schedulesQuery.data]);

  // For the room picker: detect which floor the housekeeper most commonly works
  const housekeeperFloor = useMemo(() => {
    if (!roomPickTarget) return null;
    const sug = (suggestionsQuery.data ?? []).find(
      (s) => s.housekeeper_id === roomPickTarget.housekeeperId,
    );
    return sug?.floor ?? null;
  }, [roomPickTarget, suggestionsQuery.data]);

  async function handleSaveRooms(rooms: string[], notes: string, applyToBoard: boolean) {
    if (!roomPickTarget) return;
    setActionError(null);
    setApplyResult(null);
    try {
      await upsertMutation.mutateAsync({
        housekeeper_id: roomPickTarget.housekeeperId,
        assigned_rooms: rooms,
        notes: notes.trim() || null,
        created_by: profile?.id ?? null,
      });
      if (applyToBoard) {
        const result = await applyMutation.mutateAsync({});
        setApplyResult(result);
      }
      setRoomPickTarget(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to save schedule");
    }
  }

  async function handleApplySchedule(forceReassign = false) {
    setActionError(null);
    setApplyResult(null);
    try {
      const result = await applyMutation.mutateAsync({ forceReassign });
      setApplyResult(result);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to apply schedule");
    }
  }

  async function handleDelete(id: string) {
    setActionError(null);
    try {
      await deleteMutation.mutateAsync(id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to delete schedule");
    }
  }

  const totalRooms = useMemo(
    () => (schedulesQuery.data ?? []).reduce((sum, s) => sum + s.assigned_rooms.length, 0),
    [schedulesQuery.data],
  );

  return (
    <div className="mx-auto max-w-4xl">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Daily schedule</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Assign rooms to housekeeping staff for a given day.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
            onClick={() => void schedulesQuery.refetch()}
            disabled={schedulesQuery.isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${schedulesQuery.isFetching ? "animate-spin" : ""}`} aria-hidden />
            Refresh
          </button>
          {(schedulesQuery.data ?? []).length > 0 ? (
            <button
              type="button"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-sky-300/80 bg-sky-50/80 px-3 text-[13px] font-medium text-sky-950 transition-colors hover:bg-sky-100/90 disabled:opacity-40 dark:border-sky-900/40 dark:bg-sky-950/25 dark:text-sky-100"
              onClick={() => void handleApplySchedule()}
              disabled={applyMutation.isPending || upsertMutation.isPending}
            >
              {applyMutation.isPending ? "Applying…" : "Apply to board"}
            </button>
          ) : null}
          <button
            type="button"
            className="btn-primary inline-flex h-9 items-center gap-2 px-3 text-[13px]"
            onClick={() => setShowAddHk(true)}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add housekeeper
          </button>
        </div>
      </div>

      {/* Date navigation */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setDate(offsetDate(date, -1))}
          aria-label="Previous day"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-h)]"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>

        <div className="flex items-center gap-2">
          <DateField
            value={date}
            onChange={setDate}
            aria-label="Schedule date"
            className="h-9"
          />
          <span className="text-[13px] font-medium text-[var(--text-h)]">
            {displayDate(date)}
            {date === todayIso() ? (
              <span className="ml-1.5 text-[10.5px] font-semibold text-[var(--accent)]">Today</span>
            ) : null}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setDate(offsetDate(date, 1))}
          aria-label="Next day"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-h)]"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>

        {date !== todayIso() ? (
          <button
            type="button"
            onClick={() => setDate(todayIso())}
            className="text-[12.5px] font-medium text-[var(--accent)] underline-offset-2 hover:underline"
          >
            Go to today
          </button>
        ) : null}
      </div>

      {/* Stats */}
      {(schedulesQuery.data ?? []).length > 0 ? (
        <section className="mb-4 flex flex-wrap gap-2 text-[12px]">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[var(--text)]">
            Staff scheduled
            <span className="font-semibold">{(schedulesQuery.data ?? []).length}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-300/80 bg-sky-50/80 px-2.5 py-1 text-sky-950 dark:border-sky-900/40 dark:bg-sky-950/25 dark:text-sky-100">
            Total rooms
            <span className="font-semibold">{totalRooms}</span>
          </span>
        </section>
      ) : null}

      {actionError ? (
        <p className="mb-3 text-sm text-red-500" role="alert">{actionError}</p>
      ) : null}

      {applyResult ? (
        <p className="mb-3 rounded-lg border border-emerald-300/70 bg-emerald-50/80 px-3 py-2 text-sm text-emerald-950 dark:border-emerald-800/40 dark:bg-emerald-950/25 dark:text-emerald-100">
          Applied schedule for {applyResult.schedule_date}:{" "}
          <strong>{applyResult.assigned}</strong> assigned,{" "}
          <strong>{applyResult.created}</strong> tasks created,{" "}
          <strong>{applyResult.skipped}</strong> skipped.
        </p>
      ) : null}

      {/* Schedule cards */}
      {schedulesQuery.isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading schedule…</p>
      ) : schedulesQuery.isError ? (
        <p className="text-sm text-red-500">{(schedulesQuery.error as Error).message}</p>
      ) : (schedulesQuery.data ?? []).length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-12 text-center">
          <p className="font-medium text-[var(--text-h)]">No schedule yet for this day</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Click "Add housekeeper" to build today's cleaning schedule.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {(schedulesQuery.data ?? []).map((s) => (
            <ScheduleCard
              key={s.id}
              schedule={s}
              staffById={staffById}
              busy={deleteMutation.isPending || upsertMutation.isPending}
              onEdit={() =>
                setRoomPickTarget({
                  housekeeperId: s.housekeeper_id,
                  existingRooms: s.assigned_rooms,
                  scheduleId: s.id,
                })
              }
              onDelete={() => void handleDelete(s.id)}
            />
          ))}
        </div>
      )}

      {/* Modals */}
      {showAddHk ? (
        <AddHousekeeperModal
          staff={staffQuery.data ?? []}
          scheduledIds={scheduledIds}
          onClose={() => setShowAddHk(false)}
          onPick={(id) => {
            setShowAddHk(false);
            setRoomPickTarget({ housekeeperId: id, existingRooms: [], scheduleId: null });
          }}
        />
      ) : null}

      {roomPickTarget ? (
        <RoomPickerModal
          existingRooms={roomPickTarget.existingRooms}
          schedulesByRoom={schedulesByRoom}
          staffById={staffById}
          suggestions={suggestionsQuery.data ?? []}
          housekeeperFloor={housekeeperFloor}
          busy={deleteMutation.isPending || upsertMutation.isPending || applyMutation.isPending}
          defaultApplyToBoard={date === todayIso()}
          onClose={() => setRoomPickTarget(null)}
          onSave={handleSaveRooms}
        />
      ) : null}
    </div>
  );
}
