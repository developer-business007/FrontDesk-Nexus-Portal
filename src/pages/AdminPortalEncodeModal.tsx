import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { KeyRound, Loader2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { addDaysLocal } from "@/lib/date";
import { DateField } from "@/components/ui/DateField";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { insertAuditRow } from "@/lib/audit";
import { sendPortalAdminRfidMakeKey, type PortalExtensionResponse } from "@/lib/portalExtension";
import { ReservationStatus } from "@/lib/reservationStatus";
import type { PmsSource } from "@/types/database";
import { useAuth } from "@/contexts/AuthContext";
import { hasAtLeastRole } from "@/types/roles";
import {
  currentBusinessDate,
  formatHotelLocaleString,
  getZonedParts,
  useHotelSettings,
  type HotelSettings,
} from "@/lib/hotelSettings";
import {
  formatBlockSummary,
  isDeferredMaintenanceBlock,
  isRoomBlockBlockingEncode,
  useActiveRoomBlocks,
} from "@/lib/roomBlocks";
import { autoMarkDirtyOnCheckout } from "@/lib/hkCheckoutDirty";
import {
  isRoomAvailableForNewCheckIn,
  roomStatusBlocksNewGuestMessage,
  useRoomOperationalStatusMap,
} from "@/lib/housekeeping";

const ROOM_TYPES = ["Standard", "Queen", "King", "Suite"] as const;

function combineLocalDateTime(isoDate: string, hhmm: string): string {
  const t = hhmm.trim();
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return "";
  if (!/^\d{2}:\d{2}$/.test(t)) return `${isoDate}T12:00:00`;
  return `${isoDate}T${t}:00`;
}

/** Local date + time → ISO for extension / key_history (room change preserves original IN). */
function localPartsToIso(date: string, time: string): string {
  const combined = combineLocalDateTime(date, time);
  if (!combined) return new Date().toISOString();
  const ms = new Date(combined).getTime();
  if (Number.isNaN(ms)) return new Date().toISOString();
  return new Date(ms).toISOString();
}

/**
 * Hotel key expiry rule: keys default to expire at the configured `defaultCheckoutTime`
 * (e.g. 11:00) in the hotel's timezone.
 *
 * - If the current hotel-local hour is **before** that time → expire **today** at it.
 * - Otherwise → expire **next day** at it.
 *
 * Arrival is never editable — every key's IN time is stamped at the exact moment
 * the encoder writes the card (see `runEncode`), so `key_history.checkin_time`
 * always equals `key_history.encoded_at`/`created_at`.
 */
function defaultDeparture(
  settings: HotelSettings,
  now = new Date(),
): { date: string; time: string } {
  const zoned = getZonedParts(now, settings.timezone);
  const calendarToday = `${zoned.year}-${String(zoned.month).padStart(2, "0")}-${String(zoned.day).padStart(2, "0")}`;
  const [coh, com] = settings.defaultCheckoutTime.split(":").map((s) => parseInt(s, 10) || 0);
  const beforeCheckout =
    zoned.hour < (coh ?? 11) || (zoned.hour === (coh ?? 11) && zoned.minute < (com ?? 0));
  return {
    date: beforeCheckout ? calendarToday : addDaysLocal(calendarToday, 1),
    time: settings.defaultCheckoutTime,
  };
}

/** ISO datetime for "right now" — used to stamp each key's IN time at the encode moment. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Existing reservation to encode additional keys against (e.g. lost key / extra copies).
 * When set, the modal skips reservation insertion and reuses `confirmationNumber`.
 */
export type ExistingEncodeContext = {
  confirmationNumber: string;
  guestName: string;
  roomNumber: string;
  pmsSource: PmsSource;
  /** YYYY-MM-DD */
  checkinDate: string;
  /** HH:MM (24h) */
  checkinTime: string;
  checkoutDate: string;
  checkoutTime: string;
};

type Props = {
  initialRoom: string;
  roomInventory: string[];
  /** When provided, the modal re-encodes keys for an existing reservation (no new walk-in row). */
  existing?: ExistingEncodeContext;
  onClose: () => void;
  onSuccess: () => void;
  /** After a successful room change, select this room on the board. */
  onRoomChanged?: (newRoomNumber: string) => void;
  /**
   * Optional: caller navigates to the Key history tab filtered to this room.
   * When provided, a "Room key history" button appears in the footer (re-encode mode only).
   */
  onOpenRoomHistory?: (roomNumber: string) => void;
  /** Room → confirmation for whoever the board lists in this room today (maintenance blocking). */
  boardOccupantConfirmationByRoom?: ReadonlyMap<string, string>;
};

type Phase = "form" | "encoding" | "done";

/** Re-encode only: move guest to another room (updates reservation + encodes with same IN/OUT). */
type FormMode = "encode" | "roomChange";

export function AdminPortalEncodeModal({
  initialRoom,
  roomInventory,
  existing,
  onClose,
  onSuccess,
  onRoomChanged,
  onOpenRoomHistory,
  boardOccupantConfirmationByRoom,
}: Props) {
  const { profile } = useAuth();
  const isAdmin = hasAtLeastRole(profile?.role, "admin");
  const settings = useHotelSettings();
  const { byRoom: activeBlocks } = useActiveRoomBlocks();
  const roomStatusQuery = useRoomOperationalStatusMap();

  const boardOccupierForRoom = useCallback(
    (r: string): string | null => boardOccupantConfirmationByRoom?.get(r.trim()) ?? null,
    [boardOccupantConfirmationByRoom],
  );

  const maintenanceEncodeForbidden = useCallback(
    (room: string, encodeConfirmation: string | null | undefined): boolean =>
      isRoomBlockBlockingEncode(activeBlocks.get(room.trim()), {
        roomOccupantConfirmation: boardOccupierForRoom(room),
        encodeConfirmation: encodeConfirmation ?? null,
      }),
    [activeBlocks, boardOccupierForRoom],
  );

  const initialDeparture = useMemo(() => defaultDeparture(settings), [settings]);
  // Live "now" preview for the read-only Arrival row; refreshes every 30s so the admin
  // sees the timestamp creep forward while they fill the form.
  const [nowPreview, setNowPreview] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNowPreview(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const [guestName, setGuestName] = useState(existing?.guestName ?? "");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [departureDate, setDepartureDate] = useState(existing?.checkoutDate ?? initialDeparture.date);
  const [departureTime, setDepartureTime] = useState(existing?.checkoutTime ?? initialDeparture.time);
  const [roomType, setRoomType] = useState<(typeof ROOM_TYPES)[number]>("Standard");
  const [roomNumber, setRoomNumber] = useState((existing?.roomNumber ?? initialRoom).trim());
  const [numKeys, setNumKeys] = useState(1);
  const [remark, setRemark] = useState("");
  const [pms, setPms] = useState<PmsSource>(existing?.pmsSource ?? "synxis");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // "Remove guest" (re-encode mode only): inline confirm + in-flight flag.
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removingGuest, setRemovingGuest] = useState(false);

  // Encoding state machine
  const [phase, setPhase] = useState<Phase>("form");
  /** Serial we will encode next when the user clicks the Encode button. */
  const [encodeQueue, setEncodeQueue] = useState(1);
  const [encodingBusy, setEncodingBusy] = useState(false);
  const [encodingError, setEncodingError] = useState<string | null>(null);
  /** Locked-in values once we leave the form so user edits don't change the live encode loop. */
  const [formMode, setFormMode] = useState<FormMode>("encode");

  const [encodeJob, setEncodeJob] = useState<{
    room: string;
    confirmationNumber: string;
    guestName: string;
    /** Departure (key expiry) — locked at submit; same for every key in this loop. */
    checkoutIso: string;
    totalKeys: number;
    /** Room change: keep original check-in on the new-room key(s). */
    checkinIso?: string;
    roomChangeFrom?: string;
  } | null>(null);

  const checkoutIsoPreview = useMemo(
    () => combineLocalDateTime(departureDate, departureTime),
    [departureDate, departureTime],
  );

  const handleClose = useCallback(() => {
    // If anything was already encoded, refresh the board on close.
    if (phase !== "form") {
      if (encodeJob?.roomChangeFrom && encodeJob.room.trim()) {
        onRoomChanged?.(encodeJob.room.trim());
      }
      onSuccess();
    }
    onClose();
  }, [phase, encodeJob, onRoomChanged, onSuccess, onClose]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  async function handleRemoveGuest() {
    if (!existing || !profile) return;
    setRemovingGuest(true);
    setError(null);
    try {
      const { error: updErr } = await supabase
        .from("reservations")
        .update({ reservation_status: ReservationStatus.CheckedOut })
        .eq("confirmation_number", existing.confirmationNumber);
      if (updErr) {
        setError(updErr.message);
        return;
      }
      const hk = await autoMarkDirtyOnCheckout(
        existing.roomNumber,
        "Auto: guest checkout (admin portal)",
      );
      if (!hk.ok && hk.error) {
        console.warn("[admin-portal] Auto dirty on checkout failed:", hk.error);
      }
      const { error: auditErr } = await insertAuditRow(supabase, {
        action_type: "admin_portal_room_remove_guest",
        user_id: profile.id,
        username: profile.email,
        user_role: profile.role,
        confirmation_number: existing.confirmationNumber,
        description: `Admin portal — removed ${existing.guestName || "guest"} from Room ${existing.roomNumber}`,
        new_value: {
          room_number: existing.roomNumber,
          guest_name: existing.guestName,
          reservation_status: ReservationStatus.CheckedOut,
        },
      });
      if (auditErr) {
        // Reservation update already succeeded; surface the audit failure but still refresh.
        setError(`Reservation updated, but audit log failed: ${auditErr.message}`);
      } else {
        const upkeep = activeBlocks.get(existing.roomNumber.trim());
        if (isDeferredMaintenanceBlock(upkeep)) {
          const { error: lockAuditErr } = await insertAuditRow(supabase, {
            action_type: "room_block_guest_departed_key_reminder",
            user_id: profile.id,
            username: profile.email,
            user_role: profile.role,
            confirmation_number: existing.confirmationNumber,
            description: `Guest departed Room ${existing.roomNumber.trim()} — void or lock RFID keys on encoder (maintenance block was queued while in-house).`,
            new_value: {
              room_number: existing.roomNumber.trim(),
              block_id: upkeep?.id ?? null,
            },
          });
          if (lockAuditErr) {
            setError(`Logged checkout, but key reminder audit failed: ${lockAuditErr.message}`);
          }
        }
      }
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove guest.");
    } finally {
      setRemovingGuest(false);
      setConfirmingRemove(false);
    }
  }

  const runEncode = useCallback(
    async (job: NonNullable<typeof encodeJob>, serial: number) => {
      setEncodingBusy(true);
      setEncodingError(null);
      try {
        // Default: IN at encode moment. Room change: preserve the guest's original IN.
        const checkinIso = job.checkinIso ?? nowIso();
        const res = await sendPortalAdminRfidMakeKey({
          roomNumber: job.room,
          checkinTime: checkinIso,
          checkoutTime: job.checkoutIso,
          cardSerial: serial,
          confirmationNumber: job.confirmationNumber,
          guestName: job.guestName,
        });
        if (!res.ok) {
          const fail = res as Extract<PortalExtensionResponse, { ok: false }>;
          setEncodingError(fail.error);
          return;
        }
        if (serial >= job.totalKeys) {
          setPhase("done");
        } else {
          setEncodeQueue(serial + 1);
        }
      } catch (err) {
        setEncodingError(err instanceof Error ? err.message : "Encoder request failed.");
      } finally {
        setEncodingBusy(false);
      }
    },
    [],
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!profile) {
      setError("You must be signed in.");
      return;
    }
    if (!guestName.trim()) {
      setError("Guest name is required.");
      return;
    }
    const room = roomNumber.trim();
    if (!room) {
      setError("Room is required.");
      return;
    }
    const activeBlock = activeBlocks.get(room);
    if (maintenanceEncodeForbidden(room, existing?.confirmationNumber ?? null)) {
      setError(
        `Room ${room} is blocked. ${activeBlock ? formatBlockSummary(activeBlock, settings.timezone) : ""}${
          activeBlock?.reason ? ` — ${activeBlock.reason}` : ""
        }. Unblock this room before encoding.`,
      );
      return;
    }
    if (!existing) {
      const hkStatus = roomStatusQuery.data?.get(room);
      if (!isRoomAvailableForNewCheckIn(hkStatus)) {
        setError(
          roomStatusBlocksNewGuestMessage(hkStatus) ??
            "This room is not available for check-in on the housekeeping board.",
        );
        return;
      }
    }
    if (!checkoutIsoPreview) {
      setError("Departure date/time is required.");
      return;
    }
    // IN is "now" (set at the moment each key is encoded); only the departure window is editable.
    const now = new Date();
    const cout = new Date(checkoutIsoPreview);
    if (Number.isNaN(cout.getTime()) || cout.getTime() <= now.getTime()) {
      setError("Departure must be in the future.");
      return;
    }
    const nk = Math.min(8, Math.max(1, Math.floor(numKeys)));

    setBusy(true);
    try {
      let confirmation_number: string;

      if (existing) {
        // Re-encode flow: reuse the existing reservation, no insert/audit.
        confirmation_number = existing.confirmationNumber;
      } else {
        confirmation_number = `WALKIN-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const scrape: Record<string, unknown> = {
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
          remark: remark.trim() || undefined,
          room_type: roomType,
          admin_portal_room_encode: true,
        };
        const { error: insErr } = await supabase.from("reservations").insert({
          confirmation_number,
          pms_source: pms,
          guest_name: guestName.trim(),
          reservation_status: ReservationStatus.Pending,
          dnr_hit: false,
          version: 1,
          // Walk-in: the `check_in_date` is the hotel's current BUSINESS date in the
          // configured timezone — encodes before the night-audit cutoff (default 9 AM)
          // count as the previous night's business, matching the front-desk mental model.
          check_in_date: currentBusinessDate(now, settings),
          check_out_date: departureDate,
          room_number: room,
          scrape_payload: scrape,
        });
        if (insErr) {
          setError(insErr.message);
          return;
        }

        const { error: auditErr } = await insertAuditRow(supabase, {
          action_type: "admin_portal_room_key_guest",
          user_id: profile.id,
          username: profile.email,
          user_role: profile.role,
          confirmation_number,
          description: "Admin portal — guest + room created for manual key encode",
          new_value: { room_number: room, guest_name: guestName.trim(), pms_source: pms },
        });
        if (auditErr) {
          setError(auditErr.message);
          return;
        }
      }

      const job = {
        room,
        confirmationNumber: confirmation_number,
        guestName: guestName.trim(),
        checkoutIso: checkoutIsoPreview,
        totalKeys: nk,
      };
      setEncodeJob(job);
      setPhase("encoding");
      setEncodeQueue(1);

      // First key: encode immediately (the blank card is already on the encoder).
      await runEncode(job, 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Encode failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onRoomChangeSubmit(e: FormEvent) {
    e.preventDefault();
    if (!existing || !profile || !isAdmin) return;
    setError(null);

    const fromRoom = existing.roomNumber.trim();
    const toRoom = roomNumber.trim();
    if (!toRoom) {
      setError("Select the new room.");
      return;
    }
    if (toRoom === fromRoom) {
      setError("Choose a different room than the guest's current room.");
      return;
    }
    const activeBlock = activeBlocks.get(toRoom);
    if (maintenanceEncodeForbidden(toRoom, existing.confirmationNumber)) {
      setError(
        `Room ${toRoom} is blocked. ${activeBlock ? formatBlockSummary(activeBlock, settings.timezone) : ""}${
          activeBlock?.reason ? ` — ${activeBlock.reason}` : ""
        }. Unblock before moving a guest here or pick another room.`,
      );
      return;
    }

    const checkoutIso = localPartsToIso(existing.checkoutDate, existing.checkoutTime);
    const checkoutAt = new Date(checkoutIso);
    if (Number.isNaN(checkoutAt.getTime())) {
      setError("Could not read this guest's departure time from key history.");
      return;
    }

    const preservedCheckinIso = localPartsToIso(existing.checkinDate, existing.checkinTime);
    const checkinAt = new Date(preservedCheckinIso);
    if (Number.isNaN(checkinAt.getTime())) {
      setError("Could not read this guest's check-in time from key history.");
      return;
    }

    const nk = 1;

    setBusy(true);
    try {
      let updErr = (
        await supabase
          .from("reservations")
          .update({ room_number: toRoom })
          .eq("confirmation_number", existing.confirmationNumber)
          .eq("pms_source", existing.pmsSource)
      ).error;
      if (!updErr) {
        const retry = await supabase
          .from("reservations")
          .update({ room_number: toRoom })
          .eq("confirmation_number", existing.confirmationNumber);
        updErr = retry.error;
      }
      if (updErr) {
        setError(updErr.message);
        return;
      }

      const { error: auditErr } = await insertAuditRow(supabase, {
        action_type: "admin_portal_room_change",
        user_id: profile.id,
        username: profile.email,
        user_role: profile.role,
        confirmation_number: existing.confirmationNumber,
        description: `Admin portal — room change ${fromRoom} → ${toRoom} for ${existing.guestName || "guest"}`,
        old_value: { room_number: fromRoom },
        new_value: {
          room_number: toRoom,
          guest_name: existing.guestName,
          checkin_time: preservedCheckinIso,
          checkout_time: checkoutIso,
        },
      });
      if (auditErr) {
        setError(`Room updated in the portal, but audit log failed: ${auditErr.message}`);
        return;
      }

      const fromBlock = activeBlocks.get(fromRoom);
      if (isDeferredMaintenanceBlock(fromBlock)) {
        const { error: moveKeyAuditErr } = await insertAuditRow(supabase, {
          action_type: "room_block_guest_moved_key_reminder",
          user_id: profile.id,
          username: profile.email,
          user_role: profile.role,
          confirmation_number: existing.confirmationNumber,
          description: `Guest moved from Room ${fromRoom} (${toRoom}). Void or retire RFID keys for the old room on the encoder — maintenance lock applies there once vacant.`,
          new_value: { from_room: fromRoom, to_room: toRoom, block_id: fromBlock?.id ?? null },
        });
        if (moveKeyAuditErr) {
          setError(`Room moved, but key-reminder audit failed: ${moveKeyAuditErr.message}`);
        }
      }

      const job = {
        room: toRoom,
        confirmationNumber: existing.confirmationNumber,
        guestName: existing.guestName.trim() || guestName.trim(),
        checkoutIso,
        totalKeys: nk,
        checkinIso: preservedCheckinIso,
        roomChangeFrom: fromRoom,
      };
      setEncodeJob(job);
      setPhase("encoding");
      setEncodeQueue(1);
      await runEncode(job, 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Room change failed.");
    } finally {
      setBusy(false);
    }
  }

  const isReencode = Boolean(existing);
  const isRoomChange = isReencode && formMode === "roomChange";
  const title = isRoomChange
    ? "Room change"
    : isReencode
      ? "Encode key"
      : "Guest details & keys";
  const submitLabel = isRoomChange
    ? "Room change & encode key"
    : isReencode
      ? numKeys === 1
        ? "Encode 1 key"
        : `Encode ${numKeys} keys`
      : numKeys === 1
        ? "Check-in & make key"
        : `Check-in & make ${numKeys} keys`;

  const rnMaintenance = roomNumber.trim();
  const currentBlock = rnMaintenance ? (activeBlocks.get(rnMaintenance) ?? null) : null;
  const maintenanceHardStop =
    Boolean(currentBlock) &&
    maintenanceEncodeForbidden(rnMaintenance, existing?.confirmationNumber ?? null);
  const deferredSameGuestAllowsEncode =
    Boolean(currentBlock) && isDeferredMaintenanceBlock(currentBlock) && !maintenanceHardStop;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center overflow-hidden bg-black/55 p-4 backdrop-blur-sm sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-encode-title"
    >
      <div
        className="flex max-h-[min(88svh,52rem)] w-full max-w-6xl min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4 sm:px-6">
          <h2 id="admin-encode-title" className="text-lg font-semibold text-[var(--text-h)]">
            {phase === "done" ? "All keys encoded" : title}
          </h2>
          <button
            type="button"
            className="icon-btn h-10 w-10 shrink-0"
            aria-label="Close"
            onClick={handleClose}
            disabled={busy || encodingBusy}
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6 sm:py-5">
        {phase === "form" ? (
          <form onSubmit={(e) => void (isRoomChange ? onRoomChangeSubmit(e) : onSubmit(e))}>
            {isRoomChange && existing ? (
              <p className="mb-4 text-sm text-[var(--text-muted)]">
                Move{" "}
                <span className="font-semibold text-[var(--text-h)]">{existing.guestName || "this guest"}</span> from
                Room <span className="font-mono text-[var(--text-h)]">{existing.roomNumber}</span> to another room.
              </p>
            ) : isReencode ? (
              <p className="mb-4 text-sm text-[var(--text-muted)]">
                Encode additional keys for{" "}
                <span className="font-semibold text-[var(--text-h)]">{existing?.guestName || "this guest"}</span> · Room{" "}
                <span className="font-mono text-[var(--text-h)]">{existing?.roomNumber}</span> · Conf{" "}
                <span className="font-mono text-[12px] text-[var(--text-h)]">{existing?.confirmationNumber}</span>.
                No new walk-in row will be created. Use <span className="font-semibold text-[var(--text-h)]">Room change</span>{" "}
                to assign a different room in the portal.
              </p>
            ) : (
              <p className="mb-4 text-sm text-[var(--text-muted)]">
                Manual entry (no PMS tab). Keys are encoded via the Chrome extension and logged as{" "}
                <span className="font-semibold text-[var(--text-h)]">Admin</span> in key history.
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="min-w-0 sm:col-span-2 lg:col-span-3">
            <label className="block text-sm font-medium text-[var(--text-h)]">Guest name</label>
            <input
              required
              readOnly={isRoomChange}
              className="input-field mt-1 w-full read-only:opacity-90"
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              autoComplete="name"
            />
            </div>

            {isReencode ? null : (
              <>
                <div className="min-w-0">
                <label className="block text-sm font-medium text-[var(--text-h)]">Phone</label>
                <input
                  type="tel"
                  className="input-field mt-1 w-full"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  autoComplete="tel"
                />
                </div>

                <div className="min-w-0">
                <label className="block text-sm font-medium text-[var(--text-h)]">Email</label>
                <input
                  type="email"
                  className="input-field mt-1 w-full"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
                </div>
              </>
            )}

              <div className="min-w-0">
                <span className="block text-sm font-medium text-[var(--text-h)]">Arrival (IN)</span>
                {isRoomChange && existing ? (
                  <div className="mt-1 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text)]">
                    <span className="font-mono text-[var(--text-h)]">
                      {formatHotelLocaleString(
                        new Date(localPartsToIso(existing.checkinDate, existing.checkinTime)),
                        settings.timezone,
                      )}
                    </span>
                  </div>
                ) : (
                  <>
                    <div
                      className="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] px-3 py-2 text-sm text-[var(--text)]"
                      aria-live="polite"
                    >
                      <span className="font-semibold text-[var(--text-h)]">Now</span>
                      <span className="font-mono text-[12px] text-[var(--text-muted)]">
                        ≈ {formatHotelLocaleString(nowPreview, settings.timezone)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      Stamped automatically the moment each key is encoded, so the IN time always matches Encoded in
                      key history.
                    </p>
                  </>
                )}
              </div>
              <div className="min-w-0">
                <span className="block text-sm font-medium text-[var(--text-h)]">Departure (OUT)</span>
                {isRoomChange && existing ? (
                  <div className="mt-1 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text)]">
                    <span className="font-mono text-[var(--text-h)]">
                      {formatHotelLocaleString(
                        new Date(localPartsToIso(existing.checkoutDate, existing.checkoutTime)),
                        settings.timezone,
                      )}
                    </span>
                  </div>
                ) : (
                  <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-3">
                    <div className="min-w-0 flex-1">
                      <DateField value={departureDate} onChange={setDepartureDate} aria-label="Departure date" />
                    </div>
                    <input
                      type="time"
                      className="input-field w-full shrink-0 sm:max-w-[10rem]"
                      value={departureTime}
                      onChange={(e) => setDepartureTime(e.target.value)}
                      aria-label="Departure time"
                    />
                  </div>
                )}
              </div>

            {isReencode ? null : (
              <div className="min-w-0">
                <label htmlFor="admin-encode-room-type" className="block text-sm font-medium text-[var(--text-h)]">
                  Room type
                </label>
                <div className="mt-1">
                  <FilterSelect
                    id="admin-encode-room-type"
                    value={roomType}
                    onChange={(e) => setRoomType(e.target.value as (typeof ROOM_TYPES)[number])}
                  >
                    {ROOM_TYPES.map((rt) => (
                      <option key={rt} value={rt}>
                        {rt}
                      </option>
                    ))}
                  </FilterSelect>
                </div>
              </div>
            )}

            <div className="min-w-0">
            <label htmlFor="admin-encode-room" className="block text-sm font-medium text-[var(--text-h)]">
              {isRoomChange ? "New room" : "Room"}
            </label>
            <div className="mt-1">
              <FilterSelect
                id="admin-encode-room"
                className="font-mono"
                value={roomNumber}
                disabled={isReencode && !isRoomChange}
                onChange={(e) => {
                  setRoomNumber(e.target.value);
                  setError(null);
                }}
              >
                {isRoomChange ? (
                  <option value="">Select room…</option>
                ) : null}
                {(isRoomChange && existing
                  ? roomInventory.filter((r) => r !== existing.roomNumber)
                  : roomInventory
                ).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </FilterSelect>
            </div>
            {isReencode && !isRoomChange ? (
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                To move this guest to another room in the portal, use <span className="font-semibold">Room change</span>.
              </p>
            ) : null}
            </div>

            {isReencode ? null : (
              <div className="min-w-0">
                <label htmlFor="admin-encode-pms" className="block text-sm font-medium text-[var(--text-h)]">
                  PMS label (reservation row)
                </label>
                <div className="mt-1">
                  <FilterSelect id="admin-encode-pms" value={pms} onChange={(e) => setPms(e.target.value as PmsSource)}>
                    <option value="synxis">SynXis</option>
                    <option value="ezee">eZee</option>
                  </FilterSelect>
                </div>
              </div>
            )}

            {!isRoomChange ? (
              <div className="min-w-0">
                <span className="block text-sm font-medium text-[var(--text-h)]">No. of keys</span>
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary px-3 py-2"
                  disabled={busy || numKeys <= 1}
                  onClick={() => setNumKeys((n) => Math.max(1, n - 1))}
                  aria-label="Fewer keys"
                >
                  −
                </button>
                <input
                  type="number"
                  min={1}
                  max={8}
                  className="input-field w-20 text-center font-mono"
                  value={numKeys}
                  onChange={(e) => setNumKeys(Number(e.target.value))}
                />
                <button
                  type="button"
                  className="btn-secondary px-3 py-2"
                  disabled={busy || numKeys >= 8}
                  onClick={() => setNumKeys((n) => Math.min(8, n + 1))}
                  aria-label="More keys"
                >
                  +
                </button>
              </div>
              {numKeys > 1 ? (
                <p className="mt-2 text-xs text-[var(--text-muted)]">
                  Key 1 is encoded right after you submit. You&apos;ll be prompted to swap in a fresh blank card
                  before each of the next {numKeys - 1} key{numKeys - 1 === 1 ? "" : "s"}. Each key&apos;s IN time is
                  stamped at its own encode moment.
                </p>
              ) : null}
              </div>
            ) : null}

            {isReencode ? null : (
              <div className="min-w-0 sm:col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-[var(--text-h)]">Remark</label>
                <textarea
                  className="input-field mt-1 min-h-[4rem] w-full resize-y"
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                  rows={2}
                />
              </div>
            )}

            </div>

            {maintenanceHardStop ? (
              <div
                className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-3 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-100"
                role="alert"
              >
                <p className="font-semibold text-amber-950 dark:text-amber-50">
                  Room {rnMaintenance} cannot be keyed right now — maintenance lock is active.
                </p>
                <p className="mt-0.5">{currentBlock ? formatBlockSummary(currentBlock, settings.timezone) : ""}</p>
                {currentBlock?.reason ? (
                  <p className="mt-0.5 text-amber-900 dark:text-amber-100/90">
                    <span className="text-amber-700 dark:text-amber-100/70">Reason: </span>
                    {currentBlock.reason}
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-amber-800 dark:text-amber-100/80">
                  Unblock from the board (Manage / unblock) or wait until policy allows encodes for this room.
                </p>
              </div>
            ) : null}

            {deferredSameGuestAllowsEncode && currentBlock ? (
              <div
                className="mt-4 rounded-lg border border-sky-400/40 bg-sky-500/10 px-3.5 py-3 text-sm text-sky-950 dark:border-sky-500/35 dark:bg-sky-950/25 dark:text-sky-100"
                role="status"
              >
                <p className="font-semibold text-sky-950 dark:text-sky-50">Maintenance block (guest still in-room)</p>
                <p className="mt-0.5">{formatBlockSummary(currentBlock, settings.timezone)}</p>
                <p className="mt-1 text-xs text-sky-900/95 dark:text-sky-100/85">
                  Replacement keys for this stay are allowed until checkout or room change. Void or lock RFID keys at the
                  encoder when the guest departs — full lock applies automatically once this room reads vacant on the
                  board.
                </p>
              </div>
            ) : null}

            {error ? (
              <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            ) : null}

            {isReencode && !isRoomChange && confirmingRemove ? (
              <div
                className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-100"
                role="alert"
              >
                <p>
                  Remove <span className="font-semibold">{existing?.guestName || "this guest"}</span> from Room{" "}
                  <span className="font-mono">{existing?.roomNumber}</span>?
                </p>
                <p className="mt-1 text-xs text-amber-800 dark:text-amber-100/85">
                  The reservation will be marked <span className="font-mono">{ReservationStatus.CheckedOut}</span>; the
                  room becomes vacant on the board. Past key history rows are preserved.
                </p>
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setConfirmingRemove(false)}
                    disabled={removingGuest}
                  >
                    Keep guest
                  </button>
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => void handleRemoveGuest()}
                    disabled={removingGuest}
                  >
                    {removingGuest ? "Removing…" : "Yes, remove guest"}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="mt-5 flex flex-wrap items-center gap-2">
              {isRoomChange ? (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setFormMode("encode");
                    setRoomNumber(existing?.roomNumber ?? initialRoom);
                    setError(null);
                  }}
                  disabled={busy || removingGuest}
                >
                  Back to encode
                </button>
              ) : isReencode ? (
                <>
                  {isAdmin ? (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        setFormMode("roomChange");
                        setRoomNumber("");
                        setError(null);
                        setConfirmingRemove(false);
                      }}
                      disabled={busy || removingGuest || confirmingRemove}
                    >
                      Room change
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => setConfirmingRemove(true)}
                    disabled={busy || removingGuest || confirmingRemove}
                  >
                    Remove guest
                  </button>
                  {onOpenRoomHistory ? (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => onOpenRoomHistory(existing?.roomNumber || roomNumber)}
                      disabled={busy || removingGuest}
                    >
                      Room key history
                    </button>
                  ) : null}
                </>
              ) : null}
              <div className="ml-auto flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleClose}
                  disabled={busy || removingGuest}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={
                    busy ||
                    removingGuest ||
                    maintenanceHardStop ||
                    (isRoomChange && !roomNumber.trim())
                  }
                  title={
                    isRoomChange && !roomNumber.trim()
                      ? "Select a new room"
                      : maintenanceHardStop
                        ? "Room is under maintenance lock"
                        : undefined
                  }
                >
                  {busy ? "Working…" : submitLabel}
                </button>
              </div>
            </div>
          </form>
        ) : null}

        {phase === "encoding" && encodeJob ? (
          <EncodingStep
            job={encodeJob}
            serial={encodeQueue}
            busy={encodingBusy}
            error={encodingError}
            onEncode={() => void runEncode(encodeJob, encodeQueue)}
            onClose={handleClose}
          />
        ) : null}

        {phase === "done" && encodeJob ? (
          <DoneStep job={encodeJob} onClose={handleClose} />
        ) : null}
        </div>
      </div>
    </div>
  );
}

function EncodingStep({
  job,
  serial,
  busy,
  error,
  onEncode,
  onClose,
}: {
  job: {
    room: string;
    confirmationNumber: string;
    guestName: string;
    totalKeys: number;
    roomChangeFrom?: string;
  };
  serial: number;
  busy: boolean;
  error: string | null;
  onEncode: () => void;
  onClose: () => void;
}) {
  const isFirst = serial === 1;
  const remaining = job.totalKeys - (serial - 1);
  return (
    <div className="mt-4">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text)]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-[var(--text-h)]">
            {job.guestName} · Room <span className="font-mono">{job.room}</span>
          </span>
          <span className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
            Key {serial} of {job.totalKeys}
          </span>
        </div>
        {job.roomChangeFrom ? (
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Room change from <span className="font-mono">{job.roomChangeFrom}</span>
          </p>
        ) : null}
        <p className="mt-1 font-mono text-[11px] text-[var(--text-muted)]">{job.confirmationNumber}</p>
      </div>

      <div className="mt-5 flex flex-col items-center text-center">
        <KeyRound className="h-10 w-10 text-[var(--accent)]" aria-hidden />
        {busy ? (
          <>
            <p className="mt-3 text-base font-semibold text-[var(--text-h)]">
              {job.roomChangeFrom ? "Encoding room-change key" : "Encoding key"} {serial} of {job.totalKeys}…
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-[var(--text-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Keep the card on the encoder.
            </p>
          </>
        ) : error ? (
          <>
            <p className="mt-3 text-base font-semibold text-[var(--text-h)]">
              Key {serial} of {job.totalKeys} failed
            </p>
            <p className="mt-1 text-sm text-red-500" role="alert">
              {error}
            </p>
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              Reseat the card on the encoder and retry, or cancel to skip the remaining keys.
            </p>
          </>
        ) : isFirst ? (
          <>
            <p className="mt-3 text-base font-semibold text-[var(--text-h)]">Preparing to encode…</p>
            <p className="mt-1 text-sm text-[var(--text-muted)]">Hold the first blank card on the encoder.</p>
          </>
        ) : (
          <>
            <p className="mt-3 text-base font-semibold text-[var(--text-h)]">
              Place blank key card {serial} of {job.totalKeys} on the encoder
            </p>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              Remove the previous card, set a fresh blank card on the encoder, then press <em>Encode key {serial}</em>.
            </p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {remaining} key{remaining === 1 ? "" : "s"} remaining · IN time is stamped when you click Encode.
            </p>
          </>
        )}
      </div>

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
          {error ? "Cancel" : "Stop & close"}
        </button>
        {error ? (
          <button type="button" className="btn-primary" onClick={onEncode} disabled={busy}>
            Retry key {serial}
          </button>
        ) : !isFirst ? (
          <button type="button" className="btn-primary" onClick={onEncode} disabled={busy}>
            Encode key {serial}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DoneStep({
  job,
  onClose,
}: {
  job: {
    room: string;
    guestName: string;
    totalKeys: number;
    confirmationNumber: string;
    roomChangeFrom?: string;
  };
  onClose: () => void;
}) {
  return (
    <div className="mt-4">
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-4 text-sm text-emerald-900 dark:border-emerald-800/40 dark:bg-emerald-950/30 dark:text-emerald-100">
        <p className="text-base font-semibold text-emerald-950 dark:text-emerald-50">
          {job.roomChangeFrom
            ? job.totalKeys === 1
              ? "Room changed and 1 key encoded"
              : `Room changed and ${job.totalKeys} keys encoded`
            : job.totalKeys === 1
              ? "1 key encoded"
              : `${job.totalKeys} keys encoded`}{" "}
          successfully.
        </p>
        {job.roomChangeFrom ? (
          <p className="mt-1 text-sm text-emerald-900 dark:text-emerald-100/90">
            Moved from Room <span className="font-mono">{job.roomChangeFrom}</span> to{" "}
            <span className="font-mono">{job.room}</span>
          </p>
        ) : null}
        <p className="mt-1 text-emerald-900 dark:text-emerald-100/90">
          {job.guestName} · Room <span className="font-mono">{job.room}</span>
        </p>
        <p className="mt-1 font-mono text-[11px] text-emerald-800 dark:text-emerald-200/80">{job.confirmationNumber}</p>
      </div>
      <div className="mt-5 flex justify-end">
        <button type="button" className="btn-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
