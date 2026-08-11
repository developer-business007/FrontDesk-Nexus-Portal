import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Ban, KeyRound, Lock, LockOpen, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { DateField } from "@/components/ui/DateField";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { insertAuditRow } from "@/lib/audit";
import { useAuth } from "@/contexts/AuthContext";
import {
  computeBlockedUntil,
  createRoomBlock,
  formatBlockSummary,
  formatBlockTimestamp,
  isDeferredMaintenanceBlock,
  releaseRoomBlock,
  type BlockDuration,
  type BlockDurationKind,
  type RoomBlock,
} from "@/lib/roomBlocks";
import { useHotelSettings, formatHotelLocaleString } from "@/lib/hotelSettings";

type Props = {
  roomNumber: string;
  /** When provided, the modal opens in "manage" mode (show details + Unblock). */
  block: RoomBlock | null;
  /**
   * Creating a block while this room still shows a guest on the board: saves a deferred block
   * (full maintenance once vacant) and requires acknowledgment in the form.
   */
  occupiedGuest?: { confirmationNumber: string; guestLabel: string } | null;
  onClose: () => void;
  onSuccess: () => void;
  /**
   * Optional: caller navigates to the Key history tab filtered to this room.
   * When provided, a "Room key history" button appears on the modal.
   */
  onOpenRoomHistory?: (roomNumber: string) => void;
};

const DURATION_OPTIONS: { value: BlockDurationKind; label: string }[] = [
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
  { value: "months", label: "Months" },
  { value: "until_date", label: "Until a specific date" },
  { value: "unlimited", label: "Unlimited (until manually unblocked)" },
];

const DEFAULT_VALUES: Record<Exclude<BlockDurationKind, "unlimited" | "until_date">, number> = {
  hours: 4,
  days: 1,
  months: 1,
};

export function RoomBlockModal({
  roomNumber,
  block,
  occupiedGuest = null,
  onClose,
  onSuccess,
  onOpenRoomHistory,
}: Props) {
  const { profile } = useAuth();
  const settings = useHotelSettings();

  const isManageMode = block !== null;

  // Form state (block-creation mode).
  const [kind, setKind] = useState<BlockDurationKind>("days");
  const [hours, setHours] = useState(DEFAULT_VALUES.hours);
  const [days, setDays] = useState(DEFAULT_VALUES.days);
  const [months, setMonths] = useState(DEFAULT_VALUES.months);
  const [untilDate, setUntilDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [reason, setReason] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Required when saving a deferred block for an occupied room. */
  const [acknowledgeDeferredBlock, setAcknowledgeDeferredBlock] = useState(false);

  const isCreatingDeferredBlock = Boolean(occupiedGuest && !isManageMode);

  useEffect(() => {
    setAcknowledgeDeferredBlock(false);
  }, [occupiedGuest?.confirmationNumber, roomNumber, isManageMode]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const duration: BlockDuration = useMemo(() => {
    switch (kind) {
      case "unlimited":
        return { kind: "unlimited" };
      case "hours":
        return { kind: "hours", value: Math.max(1, Math.floor(hours)) };
      case "days":
        return { kind: "days", value: Math.max(1, Math.floor(days)) };
      case "months":
        return { kind: "months", value: Math.max(1, Math.floor(months)) };
      case "until_date":
        return { kind: "until_date", date: untilDate };
    }
  }, [kind, hours, days, months, untilDate]);

  const previewUntil = useMemo(() => computeBlockedUntil(duration, settings), [duration, settings]);
  const previewLabel = useMemo(() => {
    if (!previewUntil) return "Indefinitely (no expiry)";
    try {
      return formatHotelLocaleString(new Date(previewUntil), settings.timezone);
    } catch {
      return previewUntil;
    }
  }, [previewUntil, settings.timezone]);

  async function onCreateBlock(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!profile) {
      setError("You must be signed in.");
      return;
    }
    if (!roomNumber.trim()) {
      setError("Room is required.");
      return;
    }
    if (
      kind === "until_date" &&
      (!untilDate || !/^\d{4}-\d{2}-\d{2}$/.test(untilDate))
    ) {
      setError("Please pick a valid date.");
      return;
    }
    if (previewUntil) {
      const dt = new Date(previewUntil);
      if (Number.isNaN(dt.getTime()) || dt.getTime() <= Date.now()) {
        setError("Block end must be in the future. Pick a longer duration.");
        return;
      }
    }
    if (isCreatingDeferredBlock && !acknowledgeDeferredBlock) {
      setError("Confirm that you understand this room is still occupied (checkbox below).");
      return;
    }
    setBusy(true);
    try {
      const { error: insErr, id } = await createRoomBlock({
        roomNumber: roomNumber.trim(),
        blockedUntil: previewUntil,
        reason: reason.trim() || null,
        userId: profile.id,
        effectiveFromVacancy: isCreatingDeferredBlock,
      });
      if (insErr) {
        setError(insErr.message);
        return;
      }
      const { error: auditErr } = await insertAuditRow(supabase, {
        action_type: "room_block_created",
        user_id: profile.id,
        username: profile.email,
        user_role: profile.role,
        description: `Room ${roomNumber.trim()} blocked${
          previewUntil ? ` until ${previewUntil}` : " indefinitely"
        }${isCreatingDeferredBlock ? " (effective when vacant — guest was in-room)" : ""}${
          reason.trim() ? ` — ${reason.trim()}` : ""
        }`,
        new_value: {
          block_id: id,
          room_number: roomNumber.trim(),
          blocked_until: previewUntil,
          reason: reason.trim() || null,
          duration_kind: kind,
          effective_from_vacancy: isCreatingDeferredBlock,
        },
      });
      if (auditErr) {
        setError(`Block saved, but audit log failed: ${auditErr.message}`);
      }
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to block room.");
    } finally {
      setBusy(false);
    }
  }

  async function onUnblock() {
    if (!block || !profile) return;
    setError(null);
    setBusy(true);
    try {
      const { error: relErr } = await releaseRoomBlock({ id: block.id, userId: profile.id });
      if (relErr) {
        setError(relErr.message);
        return;
      }
      const { error: auditErr } = await insertAuditRow(supabase, {
        action_type: "room_block_released",
        user_id: profile.id,
        username: profile.email,
        user_role: profile.role,
        description: `Room ${block.room_number} unblocked`,
        new_value: { block_id: block.id, room_number: block.room_number },
      });
      if (auditErr) {
        setError(`Unblocked, but audit log failed: ${auditErr.message}`);
      }
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unblock room.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center overflow-hidden bg-black/55 p-4 backdrop-blur-sm sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="room-block-title"
    >
      <div
        className="flex max-h-[min(88svh,52rem)] w-full max-w-6xl min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            {isManageMode ? (
              <Lock className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
            ) : (
              <Ban className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
            )}
            <h2
              id="room-block-title"
              className="truncate text-lg font-semibold text-[var(--text-h)]"
            >
              {isManageMode ? `Room ${roomNumber} is blocked` : `Block Room ${roomNumber}`}
            </h2>
          </div>
          <button
            type="button"
            className="icon-btn h-10 w-10 shrink-0"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6 sm:py-5">
        {isManageMode && block ? (
          <div className="mt-4 space-y-4">
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/45 dark:bg-amber-950/30 dark:text-amber-100">
              <p className="font-semibold text-amber-950 dark:text-amber-50">{formatBlockSummary(block, settings.timezone)}</p>
              {block.reason ? (
                <p className="mt-1 text-amber-900 dark:text-amber-100/90">
                  <span className="text-amber-700 dark:text-amber-100/70">Reason: </span>
                  {block.reason}
                </p>
              ) : null}
              <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs text-amber-900 dark:text-amber-100/85">
                <dt className="text-amber-700 dark:text-amber-100/65">Blocked at:</dt>
                <dd>{formatBlockTimestamp(block.created_at, settings.timezone)}</dd>
                <dt className="text-amber-700 dark:text-amber-100/65">Ends:</dt>
                <dd>
                  {block.blocked_until
                    ? formatBlockTimestamp(block.blocked_until, settings.timezone)
                    : "Unlimited (manual unblock only)"}
                </dd>
              </dl>
              <p className="mt-2 text-xs text-amber-800 dark:text-amber-100/70">
                New keys cannot be encoded for this room while the block is fully in effect.
              </p>
              {isDeferredMaintenanceBlock(block) ? (
                <p className="mt-2 text-xs text-amber-900 dark:text-amber-100/90">
                  This block was set while a guest was still in-room. Only that stay could receive
                  replacement keys until checkout or a room move — no new walk-ins. After the room
                  reads vacant on the board, the full maintenance lock applies. Void or lock RFID
                  keys for that stay on the encoder as soon as the guest departs or changes room
                  (hardware lock is not automatic from the portal).
                </p>
              ) : null}
            </div>
            {error ? (
              <p className="text-sm text-red-500" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {onOpenRoomHistory ? (
                <button
                  type="button"
                  className="btn-secondary inline-flex items-center gap-1.5"
                  onClick={() => onOpenRoomHistory(roomNumber)}
                  disabled={busy}
                >
                  <KeyRound className="h-4 w-4" aria-hidden />
                  Room key history
                </button>
              ) : null}
              <div className="ml-auto flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
                  Close
                </button>
                <button
                  type="button"
                  className="btn-primary inline-flex items-center gap-1.5"
                  onClick={() => void onUnblock()}
                  disabled={busy}
                >
                  <LockOpen className="h-4 w-4" aria-hidden />
                  {busy ? "Working…" : "Unblock now"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => void onCreateBlock(e)} className="flex flex-col gap-4">
            {isCreatingDeferredBlock && occupiedGuest ? (
              <div className="rounded-lg border border-sky-500/35 bg-sky-500/10 px-3.5 py-3 text-[13px] text-sky-950 dark:border-sky-400/35 dark:bg-sky-950/25 dark:text-sky-100">
                <p className="font-semibold text-sky-950 dark:text-sky-50">Guest currently in-room</p>
                <p className="mt-1 text-sky-900 dark:text-sky-100/90">
                  <span className="font-semibold">{occupiedGuest.guestLabel || "Guest"}</span> · Conf{" "}
                  <span className="font-mono text-[12px]">{occupiedGuest.confirmationNumber}</span>
                </p>
                <ul className="mt-2 columns-1 gap-x-8 text-xs text-sky-900/95 sm:columns-2 dark:text-sky-100/85">
                  <li className="mb-1 break-inside-avoid">
                    No new walk-ins for this room until the block clears or expires.
                  </li>
                  <li className="mb-1 break-inside-avoid">
                    Replacement keys for this stay stay allowed until checkout or room move.
                  </li>
                  <li className="break-inside-avoid sm:col-span-2">
                    Full lock applies once the board shows this room vacant — void or lock RFID on the encoder
                    at checkout/move (not automatic from the portal).
                  </li>
                </ul>
              </div>
            ) : (
              <p className="text-sm text-[var(--text-muted)]">
                While blocked, the admin encode modal refuses walk-ins and unrelated encodes for this room.
                Use for maintenance, deep clean, or out-of-order holds.
              </p>
            )}

            {isCreatingDeferredBlock ? (
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3 text-sm text-[var(--text-h)] lg:items-center">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0 rounded border-[var(--border)] lg:mt-0"
                  checked={acknowledgeDeferredBlock}
                  onChange={(e) => setAcknowledgeDeferredBlock(e.target.checked)}
                />
                <span>
                  I understand a guest is still in this room. I will void or lock RFID keys at the encoder when they
                  check out or move, and I accept the full maintenance lock once the board shows this room vacant.
                </span>
              </label>
            ) : null}

            <div className="grid gap-4 lg:grid-cols-12 lg:gap-6">
              <div className="min-w-0 space-y-3 lg:col-span-7">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <label htmlFor="room-block-kind" className="block text-sm font-medium text-[var(--text-h)]">
                      Duration
                    </label>
                    <div className="mt-1">
                      <FilterSelect
                        id="room-block-kind"
                        value={kind}
                        onChange={(e) => setKind(e.target.value as BlockDurationKind)}
                      >
                        {DURATION_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </FilterSelect>
                    </div>
                  </div>

                  {kind === "hours" || kind === "days" || kind === "months" ? (
                    <div className="min-w-0">
                      <label className="block text-sm font-medium text-[var(--text-h)]">
                        How many {kind}?
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={kind === "hours" ? 168 : kind === "days" ? 365 : 24}
                        className="input-field mt-1 w-full max-w-[10rem] font-mono sm:max-w-none"
                        value={kind === "hours" ? hours : kind === "days" ? days : months}
                        onChange={(e) => {
                          const v = Math.max(1, Math.floor(Number(e.target.value) || 1));
                          if (kind === "hours") setHours(v);
                          else if (kind === "days") setDays(v);
                          else setMonths(v);
                        }}
                      />
                    </div>
                  ) : kind === "until_date" ? (
                    <div className="min-w-0">
                      <label className="block text-sm font-medium text-[var(--text-h)]">
                        Block through (end of day)
                      </label>
                      <div className="mt-1 max-w-xs">
                        <DateField value={untilDate} onChange={setUntilDate} aria-label="Block end date" />
                      </div>
                    </div>
                  ) : (
                    <div className="hidden sm:block" aria-hidden />
                  )}
                </div>

                <div className="rounded-md border border-dashed border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] px-3 py-2 text-sm">
                  <span className="text-[var(--text-muted)]">Block ends: </span>
                  <span className="font-semibold text-[var(--text-h)]">{previewLabel}</span>
                </div>
                {kind === "days" || kind === "months" || kind === "until_date" ? (
                  <p className="text-[11px] leading-snug text-[var(--text-muted)]">
                    Blocks lift at the business-day cutoff (
                    <span className="font-mono">
                      {String(settings.businessDayCutoffHour).padStart(2, "0")}:00
                    </span>{" "}
                    hotel time) so the room frees at a clean business-day boundary.
                  </p>
                ) : null}
              </div>

              <div className="min-w-0 lg:col-span-5">
                <label className="block text-sm font-medium text-[var(--text-h)]">Reason (optional)</label>
                <textarea
                  className="input-field mt-1 min-h-[5.5rem] w-full resize-y"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder="e.g. Plumbing repair, deep clean, room out of order…"
                />
              </div>
            </div>

            {error ? (
              <p className="text-sm text-red-500" role="alert">
                {error}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-4">
              {onOpenRoomHistory ? (
                <button
                  type="button"
                  className="btn-secondary inline-flex items-center gap-1.5"
                  onClick={() => onOpenRoomHistory(roomNumber)}
                  disabled={busy}
                >
                  <KeyRound className="h-4 w-4" aria-hidden />
                  Room key history
                </button>
              ) : null}
              <div className="ml-auto flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-700 bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:border-red-600 hover:bg-red-500 disabled:pointer-events-none disabled:opacity-50 dark:border-red-600 dark:bg-red-600 dark:hover:bg-red-500 dark:hover:border-red-500"
                  disabled={busy || (isCreatingDeferredBlock && !acknowledgeDeferredBlock)}
                >
                  <Ban className="h-4 w-4 text-white/95" aria-hidden />
                  {busy ? "Working…" : "Block room"}
                </button>
              </div>
            </div>
          </form>
        )}
        </div>
      </div>
    </div>
  );
}
