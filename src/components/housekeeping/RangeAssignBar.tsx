import { useMemo, useState } from "react";
import { LayoutGrid } from "lucide-react";
import { FilterSelect } from "@/components/ui/FilterSelect";
import {
  formatRangeAssignSummary,
  previewRangeAssign,
  useRangeAssignHousekeeping,
  type RangeAssignResult,
} from "@/lib/hkRangeAssign";
import type { RaMonitorData } from "@/lib/hkRaMonitor";

type StaffOption = { id: string; label: string };

function flattenMonitorTasks(data: RaMonitorData) {
  return [
    ...data.unassigned,
    ...data.waitingCheckout,
    ...data.attendants.flatMap((a) => a.tasks),
  ];
}

export function RangeAssignBar({
  data,
  knownRooms,
  staffOptions,
  hotelDate,
  createdBy,
  onAssigned,
  onError,
}: {
  data: RaMonitorData;
  knownRooms: string[];
  staffOptions: StaffOption[];
  hotelDate: string;
  createdBy?: string | null;
  onAssigned: (result: RangeAssignResult) => void;
  onError: (message: string) => void;
}) {
  const [roomText, setRoomText] = useState("");
  const [assignedTo, setAssignedTo] = useState(staffOptions[0]?.id ?? "");
  const [forceReassign, setForceReassign] = useState(false);
  const rangeMutation = useRangeAssignHousekeeping(hotelDate);

  const taskRows = useMemo(() => flattenMonitorTasks(data), [data]);

  const preview = useMemo(
    () =>
      roomText.trim()
        ? previewRangeAssign({
            roomText,
            assignedTo,
            forceReassign,
            taskRows,
            knownRooms,
          })
        : null,
    [roomText, assignedTo, forceReassign, taskRows, knownRooms],
  );

  async function handleAssign() {
    if (!assignedTo || !roomText.trim()) {
      onError("Enter a room range and select a housekeeper.");
      return;
    }
    if (!preview || preview.assignable === 0) {
      onError("No assignable tasks in that range.");
      return;
    }

    try {
      const result = await rangeMutation.mutateAsync({
        roomText,
        assignedTo,
        scheduleDate: hotelDate,
        createdBy: createdBy ?? null,
        forceReassign,
        notes: `Zone assign ${roomText.trim()}`,
        taskRows,
        knownRooms,
      });
      onAssigned(result);
      if (result.assigned === 0) {
        onError(formatRangeAssignSummary(result));
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Range assign failed");
    }
  }

  return (
    <section className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <LayoutGrid className="h-4 w-4 text-[var(--accent)]" aria-hidden />
        <h2 className="text-sm font-semibold text-[var(--text-h)]">Zone assign</h2>
        <span className="text-xs text-[var(--text-muted)]">
          MOP-style — assign a room block to one attendant (e.g. 101-120)
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="min-w-[12rem] flex-1 text-xs font-medium text-[var(--text-h)]">
          Rooms
          <input
            type="text"
            className="input-field mt-1 w-full font-mono text-sm"
            placeholder="101-120, 201-205"
            value={roomText}
            onChange={(e) => setRoomText(e.target.value)}
            aria-label="Room range"
          />
        </label>

        <label className="min-w-[10rem] text-xs font-medium text-[var(--text-h)]">
          Assign to
          <FilterSelect
            className="mt-1 w-full text-sm"
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
            aria-label="Housekeeper"
          >
            {staffOptions.length === 0 ? (
              <option value="">No housekeepers</option>
            ) : (
              staffOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))
            )}
          </FilterSelect>
        </label>

        <button
          type="button"
          className="btn-primary inline-flex h-9 items-center px-4 text-[13px] disabled:opacity-40"
          disabled={rangeMutation.isPending || !assignedTo || !roomText.trim()}
          onClick={() => void handleAssign()}
        >
          {rangeMutation.isPending ? "Assigning…" : "Assign zone"}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <label className="inline-flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 rounded border-[var(--border)]"
            checked={forceReassign}
            onChange={(e) => setForceReassign(e.target.checked)}
          />
          Reassign from other attendants (pending / assigned only)
        </label>
      </div>

      {preview ? (
        <p className="mt-2 text-[12px] text-[var(--text-muted)]">
          <span className="font-medium text-[var(--text-h)]">{preview.roomsInRange.length}</span> rooms in
          property
          {preview.unknownRooms.length > 0 ? (
            <>
              {" "}
              · <span className="text-amber-700 dark:text-amber-300">{preview.unknownRooms.length} unknown</span>
            </>
          ) : null}
          {" · "}
          <span className="font-medium text-emerald-700 dark:text-emerald-300">{preview.assignable} assignable</span>
          {preview.blocked > 0 ? (
            <>
              {" · "}
              <span className="text-violet-700 dark:text-violet-300">{preview.blocked} blocked (guest in room)</span>
            </>
          ) : null}
          {preview.skipped > 0 ? (
            <>
              {" · "}
              {preview.skipped} skipped
            </>
          ) : null}
          {preview.noTask > 0 ? (
            <>
              {" · "}
              {preview.noTask} no task
            </>
          ) : null}
        </p>
      ) : (
        <p className="mt-2 text-[12px] text-[var(--text-muted)]">
          Comma or space separated. Inclusive ranges like <code className="font-mono">101-120</code> expand to
          individual rooms. Guests still in room are skipped per DualPMS.
        </p>
      )}
    </section>
  );
}
