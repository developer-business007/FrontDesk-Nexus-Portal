import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Ban,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  KeyRound,
  Lock,
  LockOpen,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { addDaysLocal, localDateString } from "@/lib/date";
import { DateField } from "@/components/ui/DateField";
import { SearchField } from "@/components/ui/SearchField";
import { useHotelRoomInventory } from "@/lib/hotelRooms";
import {
  keyHistoryAgent,
  keyHistoryCheckin,
  keyHistoryCheckout,
  keyHistoryEventTime,
  keyHistoryGuestName,
  keyHistoryNights,
  keyHistoryVisibleOnBusinessDate,
  formatKeyHistoryCompactYmdHm,
  formatKeyHistoryLocaleDateTime,
  formatKeyHistoryShortYmdHm,
  parseKeyHistoryDay,
} from "@/lib/keyHistory";
import type { KeyHistoryRow, PmsSource } from "@/types/database";
import { useAuth } from "@/contexts/AuthContext";
import { hasAtLeastRole } from "@/types/roles";
import { canSendPortalExtensionMessages, portalExtensionBlockReason } from "@/lib/portalExtension";
import { AdminPortalEncodeModal, type ExistingEncodeContext } from "@/pages/AdminPortalEncodeModal";
import { RoomBlockModal } from "@/pages/RoomBlockModal";
import { ReservationStatus } from "@/lib/reservationStatus";
import { useHotelSettings } from "@/lib/hotelSettings";
import {
  formatBlockBadge,
  formatBlockSummary,
  formatBlockTimestamp,
  isDeferredMaintenanceBlock,
  useActiveRoomBlocks,
  type RoomBlock,
} from "@/lib/roomBlocks";
import {
  isRoomAvailableForNewCheckIn,
  ROOM_STATUS_LABELS,
  roomStatusBlocksNewGuestMessage,
  useRoomOperationalStatusMap,
} from "@/lib/housekeeping";
import type { RoomLifecycleStatus } from "@/types/housekeeping";

/**
 * Returns the user's **PC local calendar date** as YYYY-MM-DD, recomputed every
 * minute so the board flips at the user's own midnight. This is the date the page
 * defaults to whenever it opens — it always matches whatever the OS clock says.
 *
 * (The hotel-business-day cutoff still applies separately for `reservations.check_in_date`
 * walk-in writes — that's the data layer. Display is keyed off the user's PC.)
 */
function useTodayLocalDate(): string {
  const [value, setValue] = useState(() => localDateString());
  useEffect(() => {
    const t = setInterval(() => {
      setValue(localDateString());
    }, 60_000);
    return () => clearInterval(t);
  }, []);
  return value;
}

type RoomKeyBoardRow = {
  room: string;
  key: KeyHistoryRow | null;
  /** Same source as Housekeeping board (`room_operational_status`). */
  roomStatus: RoomLifecycleStatus | null;
};

/** PMS-style MD/YY from YYYY-MM-DD. */
function formatBoardDate(isoDate: string | null | undefined): string {
  if (!isoDate) return "";
  const d = isoDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: "2-digit",
        day: "2-digit",
        year: "2-digit",
      }).format(new Date(isoDate));
    } catch {
      return "";
    }
  }
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y.slice(2)}`;
}

/** INNGuru-style "LAST, FIRST" when possible. */
function formatGuestDisplay(name: string | null | undefined): string {
  if (!name?.trim()) return "";
  const t = name.trim();
  if (t.includes(",")) return t.toUpperCase();
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]!.toUpperCase();
    const first = parts.slice(0, -1).join(" ");
    return `${last}, ${first}`;
  }
  return t;
}

type ReservationGuestPick = {
  confirmation_number: string;
  guest_name: string | null;
  pms_source: PmsSource;
  reservation_status: string | null;
  updated_at: string;
  room_number: string | null;
  guest_profile_id?: string | null;
};

/**
 * One guest name + PMS per confirmation (newest `updated_at` wins). Also collects the
 * set of confirmations whose reservation has been marked `checked_out` — used by the
 * board to hide rooms that an admin explicitly removed.
 */
function reservationGuestAndPmsByConfirmation(rows: ReservationGuestPick[]): {
  guests: Map<string, string>;
  pms: Map<string, PmsSource>;
  checkedOut: Set<string>;
  /** Authoritative room on the reservation row (updated on admin room change). */
  roomByConfirmation: Map<string, string>;
  profileByConfirmation: Map<string, string>;
} {
  const latest = new Map<string, ReservationGuestPick>();
  for (const r of rows) {
    const cur = latest.get(r.confirmation_number);
    if (!cur || new Date(r.updated_at) > new Date(cur.updated_at)) {
      latest.set(r.confirmation_number, r);
    }
  }
  const guests = new Map<string, string>();
  const pms = new Map<string, PmsSource>();
  const checkedOut = new Set<string>();
  const roomByConfirmation = new Map<string, string>();
  const profileByConfirmation = new Map<string, string>();
  for (const [, r] of latest) {
    if (r.guest_name?.trim()) guests.set(r.confirmation_number, r.guest_name.trim());
    pms.set(r.confirmation_number, r.pms_source);
    const rn = (r.room_number ?? "").trim();
    if (rn) roomByConfirmation.set(r.confirmation_number, rn);
    const pid = (r.guest_profile_id ?? "").trim();
    if (pid) profileByConfirmation.set(r.confirmation_number, pid);
    if (r.reservation_status === ReservationStatus.CheckedOut) {
      checkedOut.add(r.confirmation_number);
    }
  }
  return { guests, pms, checkedOut, roomByConfirmation, profileByConfirmation };
}

/** Prefer `guest_name` on the key row; otherwise `reservations.guest_name` by confirmation. */
function boardGuestDisplay(k: KeyHistoryRow, resGuests: Map<string, string>): string {
  const fromKey = formatGuestDisplay(keyHistoryGuestName(k));
  if (fromKey) return fromKey;
  return formatGuestDisplay(resGuests.get(k.confirmation_number) ?? null);
}

/**
 * Compact date+time used in the room board table — keeps columns narrow so the
 * detail panel can stay docked on the right. Falls back to medium / day formats
 * when the short variant doesn't apply.
 */
function KeyBoardDateCell({
  value,
  className,
  variant = "short",
}: {
  value: string | null;
  className?: string;
  /** "short" = `5/14 12:24 AM` (default) · "medium" = `May 14, 2026, 12:24 AM`. */
  variant?: "short" | "medium";
}) {
  const formatted =
    variant === "short"
      ? formatKeyHistoryShortYmdHm(value)
      : formatKeyHistoryCompactYmdHm(value);
  if (formatted) {
    return (
      <span
        className={[
          "min-w-0 whitespace-nowrap text-[12.5px] font-medium leading-snug text-[var(--text-h)] tabular-nums",
          className ?? "",
        ].join(" ")}
      >
        {formatted}
      </span>
    );
  }
  const day =
    parseKeyHistoryDay(value) ??
    (value?.trim() && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);
  const label = day ? formatBoardDate(day) : value?.trim() ? formatBoardDate(value) : "";
  if (!label) {
    return <span className="min-h-[2.25rem] text-[var(--text-muted)]">&nbsp;</span>;
  }
  return (
    <span
      className={["text-[12.5px] font-medium tabular-nums text-[var(--text-h)]", className ?? ""].join(" ")}
    >
      {label}
    </span>
  );
}

function vacantStripeClass(_globalRowIndex: number): string {
  return "bg-[var(--surface)]";
}

/**
 * Deferred maintenance (`effective_from_vacancy`) while the board row still shows a guest/key —
 * visually distinct from a plain blocked vacant row (amber).
 */
function boardDeferredOccupiedBlock(block: RoomBlock | null, key: KeyHistoryRow | null): boolean {
  return Boolean(block && key && isDeferredMaintenanceBlock(block));
}

/**
 * Vercel-style row tint: a thin left-side status bar instead of fully tinting the row.
 * Only blocked / failed states get a very subtle row wash; happy paths stay clean.
 */
function encodeRowTint(k: KeyHistoryRow, _globalRowIndex: number): string {
  if (k.success === false) {
    return "border-l-2 border-l-amber-500/70 bg-amber-500/[0.05]";
  }
  if (k.success === true) {
    return "border-l-2 border-l-emerald-500/55";
  }
  return "border-l-2 border-l-transparent";
}

function vacantRowTintByHousekeeping(status: RoomLifecycleStatus | null | undefined): string {
  switch (status) {
    case "dirty":
      return "border-l-2 border-l-amber-500/75 bg-amber-500/[0.06]";
    case "in_service":
      return "border-l-2 border-l-sky-500/70 bg-sky-500/[0.06]";
    case "clean_ready":
      return "border-l-2 border-l-emerald-500/65 bg-emerald-500/[0.06]";
    case "occupied":
      return "border-l-2 border-l-violet-500/60 bg-violet-500/[0.05]";
    case "out_of_order":
      return "border-l-2 border-l-red-500/70 bg-red-500/[0.06]";
    default:
      return "";
  }
}

function roomRowTint(
  key: KeyHistoryRow | null,
  globalRowIndex: number,
  block: RoomBlock | null,
  roomStatus: RoomLifecycleStatus | null,
): string {
  if (boardDeferredOccupiedBlock(block, key)) {
    return "border-l-2 border-l-violet-500/80 bg-violet-500/[0.07]";
  }
  if (block) {
    return "border-l-2 border-l-amber-500/70 bg-amber-500/[0.05]";
  }
  if (!key) {
    const hk = vacantRowTintByHousekeeping(roomStatus);
    return hk || `border-l-2 border-l-transparent ${vacantStripeClass(globalRowIndex)}`;
  }
  return encodeRowTint(key, globalRowIndex);
}

function hkStatusBadgeClass(status: RoomLifecycleStatus): string {
  const base =
    "inline-flex rounded-md border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide";
  switch (status) {
    case "dirty":
      return `${base} border-amber-400 bg-amber-100 text-amber-950 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-100`;
    case "in_service":
      return `${base} border-sky-400 bg-sky-100 text-sky-950 dark:border-sky-500/50 dark:bg-sky-500/15 dark:text-sky-100`;
    case "clean_ready":
      return `${base} border-emerald-400 bg-emerald-100 text-emerald-950 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-100`;
    case "occupied":
      return `${base} border-violet-400 bg-violet-100 text-violet-950 dark:border-violet-500/50 dark:bg-violet-500/15 dark:text-violet-100`;
    case "out_of_order":
      return `${base} border-red-400 bg-red-100 text-red-950 dark:border-red-500/50 dark:bg-red-500/15 dark:text-red-100`;
    default:
      return `${base} border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-h)]`;
  }
}

type BoardDetailTone = "primary" | "body" | "mono";

/**
 * One label/value row in the room-key detail panel.
 * Vercel-style: a horizontal pair separated by hairlines, no inner card boxes.
 */
function BoardDetailField({
  label,
  children,
  tone = "primary",
}: {
  label: string;
  children: React.ReactNode;
  tone?: BoardDetailTone;
}) {
  const valueClass =
    tone === "body"
      ? "min-w-0 text-right text-[13px] font-medium leading-snug text-[var(--text)]"
      : tone === "mono"
        ? "min-w-0 break-all text-right font-mono text-[12px] leading-relaxed text-[var(--text)]"
        : "min-w-0 text-right text-[13px] font-semibold leading-snug text-[var(--text-h)]";
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--border)]/70 py-2.5 last:border-b-0">
      <p className="shrink-0 pt-0.5 text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--text-muted)]">
        {label}
      </p>
      <div className={valueClass}>{children}</div>
    </div>
  );
}

/**
 * Parse a `key_history` time value (`YYYYMMDDHHmm`, hyphenated, or ISO) into form-ready
 * `{ date, time }` strings, so the encode modal can pre-fill arrival/departure controls.
 */
function parseKeyTimeForForm(value: string | null | undefined): { date: string; time: string } | null {
  if (!value) return null;
  const t = value.trim();
  if (/^\d{12}$/.test(t)) {
    return {
      date: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`,
      time: `${t.slice(8, 10)}:${t.slice(10, 12)}`,
    };
  }
  if (/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(t)) {
    const [y, mo, d, hh, mm] = t.split("-");
    return { date: `${y}-${mo}-${d}`, time: `${hh}:${mm}` };
  }
  const dt = new Date(t);
  if (!Number.isNaN(dt.getTime())) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    const hh = String(dt.getHours()).padStart(2, "0");
    const mm = String(dt.getMinutes()).padStart(2, "0");
    return { date: `${y}-${m}-${d}`, time: `${hh}:${mm}` };
  }
  return null;
}

function buildExistingEncodeContext(
  key: KeyHistoryRow,
  guestByConfirmation: Map<string, string>,
  pmsByConfirmation: Map<string, PmsSource>,
): ExistingEncodeContext | null {
  const room = (key.room_number ?? "").trim();
  const conf = key.confirmation_number?.trim();
  if (!room || !conf) return null;
  const cin = parseKeyTimeForForm(keyHistoryCheckin(key));
  const cout = parseKeyTimeForForm(keyHistoryCheckout(key));
  if (!cin || !cout) return null;
  const guestName =
    keyHistoryGuestName(key) ?? guestByConfirmation.get(conf) ?? "";
  const pmsSource = pmsByConfirmation.get(conf) ?? "synxis";
  return {
    confirmationNumber: conf,
    guestName,
    roomNumber: room,
    pmsSource,
    checkinDate: cin.date,
    checkinTime: cin.time,
    checkoutDate: cout.date,
    checkoutTime: cout.time,
  };
}

/**
 * One occupied room per confirmation for the board (`keys` must be newest-first).
 *
 * Uses `reservations.room_number` when present so an admin room change (108 → 103) moves
 * the guest on the board without leaving a stale line on 108. Older `key_history` rows
 * for the old room remain in the ledger; they are not shown on the board for that room.
 */
function occupancyByRoomForDate(
  keys: KeyHistoryRow[],
  businessDate: string,
  hideConfirmations: Set<string>,
  roomByConfirmation: Map<string, string>,
): Map<string, KeyHistoryRow> {
  const latestKeyByConf = new Map<string, KeyHistoryRow>();
  for (const k of keys) {
    if (!keyHistoryVisibleOnBusinessDate(k, businessDate)) continue;
    const conf = k.confirmation_number?.trim();
    if (!conf || hideConfirmations.has(conf)) continue;
    if (!latestKeyByConf.has(conf)) latestKeyByConf.set(conf, k);
  }

  const byRoom = new Map<string, KeyHistoryRow>();
  for (const [conf, k] of latestKeyByConf) {
    const resRoom = roomByConfirmation.get(conf)?.trim() ?? "";
    const keyRoom = (k.room_number ?? "").trim();
    const room = resRoom || keyRoom;
    if (!room) continue;

    const displayKey: KeyHistoryRow =
      resRoom && resRoom !== keyRoom ? { ...k, room_number: resRoom } : k;

    const prev = byRoom.get(room);
    if (!prev) {
      byRoom.set(room, displayKey);
      continue;
    }
    const prevAt = keyHistoryEventTime(prev);
    const nextAt = keyHistoryEventTime(displayKey);
    if (nextAt.localeCompare(prevAt) > 0) byRoom.set(room, displayKey);
  }
  return byRoom;
}

function RoomBoardTab() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const isAdmin = hasAtLeastRole(profile?.role, "admin");
  const extensionReady = canSendPortalExtensionMessages();
  const extensionBlock = portalExtensionBlockReason();
  const settings = useHotelSettings();
  const roomsQuery = useHotelRoomInventory();
  const HOTEL_ROOM_INVENTORY = roomsQuery.data ?? [];
  // "Today" follows the user's own PC clock — what the OS says is today's date.
  // Refreshes every minute so the board rolls over at the user's local midnight.
  const businessToday = useTodayLocalDate();
  const [businessDate, setBusinessDate] = useState<string>(() => localDateString());
  const [listSearch, setListSearch] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [encodeModalState, setEncodeModalState] = useState<
    { room: string; existing?: ExistingEncodeContext } | null
  >(null);
  const [blockModalState, setBlockModalState] = useState<{
    room: string;
    block: RoomBlock | null;
    /** When creating a block for a room that still shows a guest on the board — enables deferred mode. */
    occupiedGuest?: { confirmationNumber: string; guestLabel: string } | null;
  } | null>(null);
  const { byRoom: activeBlocks } = useActiveRoomBlocks();
  const roomStatusQuery = useRoomOperationalStatusMap();
  const roomStatusByRoom = roomStatusQuery.data ?? new Map<string, RoomLifecycleStatus>();

  // Sync `businessDate` to the live business-today whenever the cutoff rolls over,
  // but only if the user hasn't manually scrolled to a different day.
  const [trackingToday, setTrackingToday] = useState(true);
  useEffect(() => {
    if (trackingToday) setBusinessDate(businessToday);
  }, [businessToday, trackingToday]);

  const inventoryConfigured = !roomsQuery.isLoading && HOTEL_ROOM_INVENTORY.length > 0;
  const inventoryLoadFailed = roomsQuery.isError;

  const keysQuery = useQuery({
    queryKey: ["key-board-keys", businessDate],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("key_history")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as KeyHistoryRow[];
    },
  });

  const keyConfirmationNumbers = useMemo(() => {
    const set = new Set<string>();
    for (const k of keysQuery.data ?? []) {
      if (!keyHistoryVisibleOnBusinessDate(k, businessDate)) continue;
      const c = k.confirmation_number?.trim();
      if (c) set.add(c);
    }
    return [...set];
  }, [keysQuery.data, businessDate]);

  const reservationsGuestsQuery = useQuery({
    queryKey: ["key-board-reservation-guests", [...keyConfirmationNumbers].sort().join("|")],
    enabled: keyConfirmationNumbers.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reservations")
        .select(
          "confirmation_number, guest_name, pms_source, reservation_status, updated_at, room_number, guest_profile_id",
        )
        .in("confirmation_number", keyConfirmationNumbers);
      if (error) throw new Error(error.message);
      return (data ?? []) as ReservationGuestPick[];
    },
  });

  const {
    guests: guestByConfirmation,
    pms: pmsByConfirmation,
    checkedOut: checkedOutConfirmations,
    roomByConfirmation,
    profileByConfirmation,
  } = useMemo(
    () => reservationGuestAndPmsByConfirmation(reservationsGuestsQuery.data ?? []),
    [reservationsGuestsQuery.data],
  );

  const boardRows = useMemo((): RoomKeyBoardRow[] => {
    if (!inventoryConfigured) return [];
    const byRoom = occupancyByRoomForDate(
      keysQuery.data ?? [],
      businessDate,
      checkedOutConfirmations,
      roomByConfirmation,
    );
    return HOTEL_ROOM_INVENTORY.map((room) => ({
      room,
      key: byRoom.get(room) ?? null,
      roomStatus: roomStatusByRoom.get(room) ?? null,
    }));
  }, [
    keysQuery.data,
    businessDate,
    inventoryConfigured,
    checkedOutConfirmations,
    roomByConfirmation,
    HOTEL_ROOM_INVENTORY,
    roomStatusByRoom,
  ]);

  const boardStats = useMemo(() => {
    const withKey = boardRows.filter((x) => x.key).length;
    const notReady = boardRows.filter(
      (x) => !x.key && x.roomStatus != null && !isRoomAvailableForNewCheckIn(x.roomStatus),
    ).length;
    return {
      total: boardRows.length,
      withKey,
      vacant: boardRows.length - withKey,
      notReady,
    };
  }, [boardRows]);

  const boardOccupantConfirmationByRoom = useMemo(() => {
    const m = new Map<string, string>();
    for (const { room, key: k } of boardRows) {
      const cn = k?.confirmation_number?.trim();
      if (cn) m.set(room, cn);
    }
    return m;
  }, [boardRows]);

  const filteredRows = useMemo(() => {
    const agentTerm = agentFilter.trim().toLowerCase();
    const q = listSearch.trim().toLowerCase();
    return boardRows.filter(({ room, key: k }) => {
      if (agentTerm) {
        if (!k) return false;
        const ag = (keyHistoryAgent(k) ?? "").toLowerCase();
        if (!ag.includes(agentTerm)) return false;
      }
      if (!q) return true;
      if (room.toLowerCase().includes(q)) return true;
      if (!k) return false;
      const conf = k.confirmation_number.toLowerCase();
      const guestKey = (keyHistoryGuestName(k) ?? "").toLowerCase();
      const guestRes = (guestByConfirmation.get(k.confirmation_number) ?? "").toLowerCase();
      return conf.includes(q) || guestKey.includes(q) || guestRes.includes(q);
    });
  }, [boardRows, listSearch, agentFilter, guestByConfirmation]);

  const selectedRow = useMemo(() => {
    if (!selectedRoom) return null;
    return (
      filteredRows.find((x) => x.room === selectedRoom) ??
      boardRows.find((x) => x.room === selectedRoom) ??
      null
    );
  }, [filteredRows, boardRows, selectedRoom]);

  useEffect(() => {
    if (!filteredRows.length) {
      setSelectedRoom(null);
      return;
    }
    if (!selectedRoom || !filteredRows.some((x) => x.room === selectedRoom)) {
      setSelectedRoom(filteredRows[0]!.room);
    }
  }, [filteredRows, selectedRoom]);

  const [boardChannelName] = useState(
    () => `key-board-realtime-${Math.random().toString(36).slice(2, 10)}`,
  );
  useEffect(() => {
    const channel = supabase
      .channel(boardChannelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "key_history" },
        () => {
          void queryClient.invalidateQueries({ queryKey: ["key-board-keys"] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "reservations" },
        () => {
          void queryClient.invalidateQueries({ queryKey: ["key-board-reservation-guests"] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient, boardChannelName]);

  const loadError = keysQuery.error ?? reservationsGuestsQuery.error;

  const handleExportCsv = useCallback(() => {
    const header = [
      "Room",
      "Guest",
      "In (key)",
      "Out (key)",
      "Confirmation",
      "Encoded (local)",
      "Nights on key",
      "Key by",
      "Terminal",
      "Card serial",
      "Success",
    ];
    const csvRows = [
      header,
      ...filteredRows.map(({ room, key: k }) => {
        const t = k ? keyHistoryEventTime(k) : "";
        return [
          room,
          k ? boardGuestDisplay(k, guestByConfirmation) : "",
          k ? formatKeyHistoryCompactYmdHm(keyHistoryCheckin(k)) ?? parseKeyHistoryDay(keyHistoryCheckin(k)) ?? keyHistoryCheckin(k) ?? "" : "",
          k ? formatKeyHistoryCompactYmdHm(keyHistoryCheckout(k)) ?? parseKeyHistoryDay(keyHistoryCheckout(k)) ?? keyHistoryCheckout(k) ?? "" : "",
          k?.confirmation_number ?? "",
          t ? new Date(t).toLocaleString() : "",
          k ? (keyHistoryNights(k) ?? "") : "",
          k ? (keyHistoryAgent(k) ?? "") : "",
          k?.terminal_id ?? "",
          k && typeof k.card_serial === "number" ? k.card_serial : "",
          k ? (k.success === true ? "yes" : k.success === false ? "no" : "") : "",
        ];
      }),
    ];
    const csv = csvRows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `room_board_${businessDate}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }, [filteredRows, businessDate, guestByConfirmation]);

  const key = selectedRow?.key ?? null;
  const guestPms = key ? pmsByConfirmation.get(key.confirmation_number) : undefined;
  const guestProfileId = key ? profileByConfirmation.get(key.confirmation_number) ?? null : null;
  const guestHref = key
    ? guestProfileId
      ? `/guests/${encodeURIComponent(guestProfileId)}`
      : guestPms
        ? `/guest/${encodeURIComponent(key.confirmation_number)}?pms=${encodeURIComponent(guestPms)}`
        : `/guest/${encodeURIComponent(key.confirmation_number)}`
    : null;
  const guestLabel = key ? boardGuestDisplay(key, guestByConfirmation) || key.confirmation_number : "";
  const headerTitle = selectedRow ? (key ? guestLabel || `Room ${selectedRow.room}` : `Room ${selectedRow.room}`) : "Details";

  const isLoading =
    inventoryConfigured &&
    (keysQuery.isLoading ||
      (keyConfirmationNumbers.length > 0 && reservationsGuestsQuery.isLoading));

  const refreshBoard = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["key-board-keys"] });
    void queryClient.invalidateQueries({ queryKey: ["key-board-reservation-guests"] });
    void queryClient.invalidateQueries({ queryKey: ["room-operational-status-map"] });
  }, [queryClient]);

  const onToday = businessDate === businessToday;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h2 className="text-[1.375rem] font-semibold leading-tight tracking-[-0.015em] text-[var(--text-h)]">
            Room board
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-h)] disabled:opacity-40"
              aria-label="Previous day"
              onClick={() => {
                setTrackingToday(false);
                setBusinessDate((d) => addDaysLocal(d, -1));
              }}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <DateField
              value={businessDate}
              onChange={(d) => {
                setTrackingToday(d === businessToday);
                setBusinessDate(d);
              }}
              aria-label="Business date"
              className="w-40"
            />
            <button
              type="button"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-h)] disabled:opacity-40"
              aria-label="Next day"
              onClick={() => {
                setTrackingToday(false);
                setBusinessDate((d) => addDaysLocal(d, 1));
              }}
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <button
            type="button"
            className={`rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors ${
              onToday
                ? "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]"
                : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-h)] hover:bg-[var(--surface-2)]"
            }`}
            onClick={() => {
              setTrackingToday(true);
              setBusinessDate(businessToday);
            }}
            disabled={onToday}
            aria-label="Jump to today"
            title="Jump to today"
          >
            Today
          </button>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
            <input
              type="text"
              className="h-9 w-44 rounded-lg border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-[13px] text-[var(--text-h)] placeholder:text-[var(--text-muted)] outline-none transition-[border-color] focus:border-[var(--accent-border)]"
              placeholder="Filter by agent"
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              aria-label="Key agent filter"
            />
          </div>

          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-h)] disabled:opacity-40"
            aria-label="Refresh"
            onClick={refreshBoard}
            disabled={!inventoryConfigured}
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
          </button>

          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
            onClick={handleExportCsv}
            disabled={filteredRows.length === 0}
          >
            <Download className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
            Export
          </button>
        </div>
      </div>

      {loadError ? (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-[13px] text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
          <div className="flex items-start gap-2">
            <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{(loadError as Error).message}</span>
          </div>
        </div>
      ) : null}

      {isAdmin && inventoryConfigured ? (
        <div
          className={`rounded-xl border px-4 py-3 text-[13px] leading-relaxed ${
            extensionReady
              ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900/45 dark:bg-emerald-950/20 dark:text-emerald-100/90"
              : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/45 dark:bg-amber-950/20 dark:text-amber-100/85"
          }`}
        >
          {extensionReady ? (
            <p>
              <span className="font-semibold text-emerald-950 dark:text-emerald-50">Admin tip · </span>
              Click a vacant <strong className="font-semibold">available</strong> room to encode keys.
              Dirty / in-service / clean-ready rooms match the Housekeeping board and cannot take new guests.
            </p>
          ) : extensionBlock === "missing_extension_id" ? (
            <p>
              <span className="font-semibold text-amber-950 dark:text-amber-50">Admin key encode · </span>
              This deployment was built without{" "}
              <code className="rounded bg-amber-100/70 px-1 py-0.5 font-mono text-[11px] text-amber-900 dark:bg-black/30 dark:text-amber-100">VITE_CHROME_EXTENSION_ID</code>. Add it in
              Vercel → Project → Settings → Environment Variables (same ID as in{" "}
              <code className="font-mono text-[11px]">chrome://extensions</code>), then redeploy. The extension manifest already
              allows <code className="font-mono text-[11px]">https://front-desk-nexus.vercel.app/*</code>.
            </p>
          ) : (
            <p>
              <span className="font-semibold text-amber-950 dark:text-amber-50">Admin key encode · </span>
              Open{" "}
              <a
                className="font-mono text-[11px] text-amber-800 underline underline-offset-2 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-50"
                href="https://front-desk-nexus.vercel.app/keys"
              >
                this site
              </a>{" "}
              in <span className="font-semibold text-amber-950 dark:text-amber-50">Google Chrome</span> with the FrontDesk extension installed.
              Session bridge and RFID messages require Chrome&apos;s extension API.
            </p>
          )}
        </div>
      ) : null}

      {inventoryLoadFailed ? (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-4 text-[13px] text-red-900 dark:border-red-900/45 dark:bg-red-950/20 dark:text-red-100/90">
          <p className="font-semibold">Could not load room inventory</p>
          <p className="mt-1.5 opacity-90">{(roomsQuery.error as Error).message}</p>
        </div>
      ) : null}

      {!roomsQuery.isLoading && !inventoryConfigured && !inventoryLoadFailed ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-4 text-[13px] text-amber-900 dark:border-amber-900/45 dark:bg-amber-950/20 dark:text-amber-100/90">
          <p className="font-semibold text-amber-950 dark:text-amber-50">Room list not configured</p>
          <p className="mt-1.5 text-amber-900/85 dark:text-amber-100/80">
            An admin can add rooms under{" "}
            <Link to="/admin/settings" className="font-semibold underline">
              Settings → Room inventory
            </Link>{" "}
            (saved to the database), or run{" "}
            <code className="font-mono text-[11px]">hk_sync_rooms_from_text</code> in Supabase.
          </p>
        </div>
      ) : null}

      {inventoryConfigured ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] tabular-nums">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[var(--text-muted)]">
            Business date
            <span className="font-medium text-[var(--text-h)]">{businessDate}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[var(--text-muted)]">
            Rooms
            <span className="font-semibold text-[var(--text-h)]">{boardStats.total}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200/85">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" aria-hidden />
            With key
            <span className="font-semibold text-emerald-950 dark:text-emerald-100">{boardStats.withKey}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[var(--text-muted)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-muted)]" aria-hidden />
            No key
            <span className="font-semibold text-[var(--text-h)]">{boardStats.vacant}</span>
          </span>
          {boardStats.notReady > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200/85">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
              Not ready
              <span className="font-semibold text-amber-950 dark:text-amber-100">{boardStats.notReady}</span>
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:min-h-[min(70vh,calc(100svh-16rem))] lg:border-r lg:border-[var(--border)]">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
            <div className="min-w-0 max-w-sm flex-1">
              <SearchField
                className="w-full bg-[var(--surface)]"
                placeholder="Search room, guest or confirmation…"
                value={listSearch}
                onChange={(e) => setListSearch(e.target.value)}
                aria-label="Search room board"
              />
            </div>
            {listSearch ? (
              <button
                type="button"
                className="icon-btn shrink-0"
                aria-label="Clear search"
                onClick={() => setListSearch("")}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            ) : null}
            <span className="ml-auto hidden text-[15px] tabular-nums text-[var(--text-muted)] sm:inline">
              <span className="ml-auto hidden text-[15px] tabular-nums text-[var(--text-h)] sm:inline">
                {isLoading
                  ? "Loading…"
                  : filteredRows.length === 0
                    ? "0"
                    : (
                        <>
                          <span className="font-bold text-emerald-700 dark:text-emerald-300">
                            {filteredRows.length}
                          </span>{" "}
                          {filteredRows.length === 1 ? "room" : "rooms"}
                        </>
                      )
                }
              </span>
            </span>
       
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {!inventoryConfigured ? null : isLoading ? (
              <p className="p-6 text-sm text-[var(--text-muted)]">Loading key_history…</p>
            ) : filteredRows.length === 0 ? (
              <p className="p-6 text-sm text-[var(--text-muted)]">Nothing matches your filters.</p>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[440px] border-collapse text-left text-sm">
                    <thead className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface)]">
                      <tr>
                        <th
                          scope="col"
                          className="px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
                        >
                          Room
                        </th>
                        <th
                          scope="col"
                          className="px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
                        >
                          Guest
                        </th>
                        <th
                          scope="col"
                          className="px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
                        >
                          In
                        </th>
                        <th
                          scope="col"
                          className="px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
                        >
                          Out
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRows.map(({ room, key: k, roomStatus }, idx) => {
                        const globalIdx = idx;
                        const active = room === selectedRoom;
                        const block = activeBlocks.get(room) ?? null;
                        const guest = k ? boardGuestDisplay(k, guestByConfirmation) : "";
                        const hkBlocksNewGuest =
                          !k && !isRoomAvailableForNewCheckIn(roomStatus);
                        return (
                          <tr
                            key={room}
                            className={[
                              "cursor-pointer border-b border-[var(--border)]/60 transition-colors",
                              roomRowTint(k, globalIdx, block, roomStatus),
                              active
                                ? "bg-[var(--accent-muted)] !border-l-[var(--accent)]"
                                : "hover:bg-[var(--surface-2)]",
                            ].join(" ")}
                            onClick={() => {
                              setSelectedRoom(room);
                              if (!isAdmin || !extensionReady) return;

                              const deferVacantBlocksEncode =
                                Boolean(block) &&
                                isDeferredMaintenanceBlock(block) &&
                                !k;

                              const hardBlock =
                                Boolean(block) &&
                                (!isDeferredMaintenanceBlock(block) || deferVacantBlocksEncode);

                              if (hardBlock && block) {
                                setBlockModalState({ room, block, occupiedGuest: null });
                                return;
                              }

                              if (hkBlocksNewGuest) return;

                              const existing = k
                                ? buildExistingEncodeContext(
                                    k,
                                    guestByConfirmation,
                                    pmsByConfirmation,
                                  ) ?? undefined
                                : undefined;
                              setEncodeModalState({ room, existing });
                            }}
                            aria-current={active ? "true" : undefined}
                          >
                            <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[12.5px] font-semibold text-[var(--text-h)]">
                              <div className="flex items-center gap-1.5">
                                <span>{room}</span>
                                {block ? (
                                  <span
                                    className={
                                      boardDeferredOccupiedBlock(block, k)
                                        ? "inline-flex items-center gap-1 rounded-md border border-violet-400 bg-violet-100 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-violet-950 dark:border-violet-400/55 dark:bg-violet-500/15 dark:text-violet-100"
                                        : "inline-flex items-center gap-1 rounded-md border border-amber-400 bg-amber-100 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-amber-900 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-200"
                                    }
                                    title={formatBlockSummary(block, settings.timezone)}
                                  >
                                    <Lock
                                      className={
                                        boardDeferredOccupiedBlock(block, k)
                                          ? "h-2.5 w-2.5 text-violet-700 dark:text-violet-300"
                                          : "h-2.5 w-2.5"
                                      }
                                      aria-hidden
                                    />
                                    {formatBlockBadge(block)}
                                  </span>
                                ) : null}
                                {!k && roomStatus && roomStatus !== "available" ? (
                                  <span
                                    className={hkStatusBadgeClass(roomStatus)}
                                    title={roomStatusBlocksNewGuestMessage(roomStatus) ?? undefined}
                                  >
                                    {ROOM_STATUS_LABELS[roomStatus] ?? roomStatus}
                                  </span>
                                ) : null}
                              </div>
                            </td>
                            <td className="max-w-[min(36vw,12rem)] truncate px-3 py-2.5 text-[12.5px] text-[var(--text)]">
                              {guest || ""}
                            </td>
                            <td className="w-[7.5rem] min-w-[7rem] px-3 py-2.5 align-top">
                              {k ? (
                                <KeyBoardDateCell value={keyHistoryCheckin(k)} />
                              ) : (
                                <span className="min-h-[2rem] text-[var(--text-muted)]">&nbsp;</span>
                              )}
                            </td>
                            <td className="w-[7.5rem] min-w-[7rem] px-3 py-2.5 align-top">
                              {k ? (
                                <KeyBoardDateCell value={keyHistoryCheckout(k)} />
                              ) : (
                                <span className="min-h-[2rem] text-[var(--text-muted)]">&nbsp;</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex w-full shrink-0 flex-col border-t border-[var(--border)] lg:w-[min(100%,22rem)] lg:border-l lg:border-t-0 xl:w-[min(100%,24rem)] 2xl:w-[min(100%,26rem)]">
          <div className="shrink-0 border-b border-[var(--border)] px-4 py-3.5 md:px-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2
                className="max-w-full truncate text-base font-semibold tracking-[-0.01em] text-[var(--text-h)] md:text-[1.0625rem]"
                title={headerTitle}
              >
                {selectedRow ? headerTitle : "Select a room"}
              </h2>
              {key && guestHref ? (
                <Link
                  to={guestHref}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface-2)]"
                >
                  <ExternalLink className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-hidden />
                  Guest
                </Link>
              ) : null}
            </div>
            {key ? (
              <p className="mt-1 font-mono text-[11px] text-[var(--text-muted)]">{key.confirmation_number}</p>
            ) : selectedRow ? (
              <p className="mt-1 font-mono text-[11px] text-[var(--text-muted)]">Room {selectedRow.room}</p>
            ) : null}
          </div>

          <div className="min-h-[40vh] flex-1 overflow-y-auto p-4 md:p-5 lg:min-h-0">
            {!selectedRow ? (
              <div className="flex h-full min-h-[32vh] flex-col items-center justify-center gap-2 text-center text-sm text-[var(--text-muted)]">
                <KeyRound className="h-7 w-7 opacity-50" aria-hidden />
                Select a room row for details.
              </div>
            ) : key ? (
              <KeyHistoryRecordDetail
                row={key}
                guestDisplay={boardGuestDisplay(key, guestByConfirmation)}
                isAdmin={isAdmin}
                extensionReady={extensionReady}
                block={activeBlocks.get(selectedRow.room) ?? null}
                onOpenReencode={() => {
                  const existing = buildExistingEncodeContext(key, guestByConfirmation, pmsByConfirmation);
                  setEncodeModalState({
                    room: (key.room_number ?? selectedRow.room).trim() || selectedRow.room,
                    existing: existing ?? undefined,
                  });
                }}
                onOpenBlock={(block) =>
                  setBlockModalState({
                    room: selectedRow.room,
                    block,
                    occupiedGuest:
                      !block && selectedRow.key
                        ? {
                            confirmationNumber: selectedRow.key.confirmation_number,
                            guestLabel: boardGuestDisplay(
                              selectedRow.key,
                              guestByConfirmation,
                            ),
                          }
                        : null,
                  })
                }
                tz={settings.timezone}
              />
            ) : (
              <VacantRoomKeyDetail
                room={selectedRow.room}
                roomStatus={selectedRow.roomStatus}
                isAdmin={isAdmin}
                extensionReady={extensionReady}
                block={activeBlocks.get(selectedRow.room) ?? null}
                onOpenEncode={() => setEncodeModalState({ room: selectedRow.room })}
                onOpenBlock={(block) =>
                  setBlockModalState({
                    room: selectedRow.room,
                    block,
                    occupiedGuest:
                      !block && selectedRow.key
                        ? {
                            confirmationNumber: selectedRow.key.confirmation_number,
                            guestLabel: boardGuestDisplay(
                              selectedRow.key,
                              guestByConfirmation,
                            ),
                          }
                        : null,
                  })
                }
                tz={settings.timezone}
              />
            )}
          </div>
        </div>
      </div>

      {encodeModalState && inventoryConfigured ? (
        <AdminPortalEncodeModal
          initialRoom={encodeModalState.room}
          roomInventory={HOTEL_ROOM_INVENTORY}
          existing={encodeModalState.existing}
          boardOccupantConfirmationByRoom={boardOccupantConfirmationByRoom}
          onClose={() => setEncodeModalState(null)}
          onSuccess={refreshBoard}
          onRoomChanged={(newRoom) => setSelectedRoom(newRoom)}
          onOpenRoomHistory={(roomNumber) => {
            setEncodeModalState(null);
            navigate(`/keys?tab=history&room=${encodeURIComponent(roomNumber)}`);
          }}
        />
      ) : null}

      {blockModalState && inventoryConfigured && isAdmin ? (
        <RoomBlockModal
          roomNumber={blockModalState.room}
          block={blockModalState.block}
          occupiedGuest={blockModalState.block ? null : (blockModalState.occupiedGuest ?? null)}
          onClose={() => setBlockModalState(null)}
          onSuccess={refreshBoard}
          onOpenRoomHistory={(roomNumber) => {
            setBlockModalState(null);
            navigate(`/keys?tab=history&room=${encodeURIComponent(roomNumber)}`);
          }}
        />
      ) : null}
    </div>
  );
}

function VacantRoomKeyDetail({
  room,
  roomStatus,
  isAdmin,
  extensionReady,
  block,
  onOpenEncode,
  onOpenBlock,
  tz,
}: {
  room: string;
  roomStatus: RoomLifecycleStatus | null;
  isAdmin: boolean;
  extensionReady: boolean;
  block: RoomBlock | null;
  onOpenEncode: () => void;
  onOpenBlock: (block: RoomBlock | null) => void;
  tz?: string;
}) {
  const hkMessage = roomStatusBlocksNewGuestMessage(roomStatus);
  const canEncodeNewGuest = isRoomAvailableForNewCheckIn(roomStatus);

  return (
    <div className="space-y-4">
      <div>
        <BoardDetailField label="Room" tone="primary">
          <span className="font-mono text-base">{(room ?? "").trim() || "—"}</span>
        </BoardDetailField>
        {roomStatus ? (
          <BoardDetailField label="Housekeeping" tone="body">
            <span className={hkStatusBadgeClass(roomStatus)}>
              {ROOM_STATUS_LABELS[roomStatus] ?? roomStatus}
            </span>
          </BoardDetailField>
        ) : null}
      </div>

      {hkMessage ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-[13px] text-amber-900 dark:border-amber-900/45 dark:bg-amber-950/25 dark:text-amber-100/90">
          <p className="font-semibold text-amber-950 dark:text-amber-50">Not available for check-in</p>
          <p className="mt-1.5 text-amber-900/90 dark:text-amber-100/85">{hkMessage}</p>
          <p className="mt-2 text-xs text-amber-800/85 dark:text-amber-100/65">
            Finish on the{" "}
            <Link to="/housekeeping" className="font-medium underline underline-offset-2">
              Housekeeping
            </Link>{" "}
            board, then mark the room available before encoding keys here.
          </p>
        </div>
      ) : null}

      {block ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-[13px] text-amber-900 dark:border-amber-900/45 dark:bg-amber-950/25 dark:text-amber-100/90">
          <p className="flex items-center gap-2 font-semibold text-amber-950 dark:text-amber-50">
            <Lock className="h-4 w-4" aria-hidden />
            {formatBlockSummary(block, tz)}
          </p>
          {block.reason ? (
            <p className="mt-1.5 text-amber-900 dark:text-amber-100/85">
              <span className="text-amber-700 dark:text-amber-100/60">Reason · </span>
              {block.reason}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-100/70">
            <span className="text-amber-700 dark:text-amber-100/55">Blocked at · </span>
            {formatBlockTimestamp(block.created_at, tz)}
          </p>
          <p className="mt-1 text-xs text-amber-800/85 dark:text-amber-100/65">
            {isDeferredMaintenanceBlock(block)
              ? "The in-house guest has departed; the full maintenance lock is in effect. New keys cannot be encoded until you unblock (or the block expires)."
              : "New keys cannot be encoded while this block is active."}
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {isAdmin && extensionReady && !block && canEncodeNewGuest ? (
          <button
            type="button"
            className="inline-flex w-full items-center justify-center rounded-lg bg-[var(--accent)] px-3 py-2.5 text-[13px] font-semibold text-[#042f1f] transition-colors hover:bg-[var(--accent-hover)]"
            onClick={onOpenEncode}
          >
            Guest details &amp; encode keys
          </button>
        ) : null}

        {isAdmin && block ? (
          <button
            type="button"
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-2.5 text-[13px] font-semibold text-[#042f1f] transition-colors hover:bg-[var(--accent-hover)]"
            onClick={() => onOpenBlock(block)}
          >
            <LockOpen className="h-4 w-4" aria-hidden />
            Manage / unblock
          </button>
        ) : null}

        {isAdmin && !block ? (
          <button
            type="button"
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-700 bg-red-600 px-3 py-2 text-[13px] font-semibold text-white shadow-sm transition-colors hover:border-red-600 hover:bg-red-500 dark:border-red-600 dark:bg-red-600 dark:text-white dark:hover:bg-red-500 dark:hover:border-red-500"
            onClick={() => onOpenBlock(null)}
          >
            <Ban className="h-4 w-4 text-white/95" aria-hidden />
            Block room (maintenance)
          </button>
        ) : null}
      </div>
    </div>
  );
}

function KeyHistoryRecordDetail({
  row,
  guestDisplay,
  isAdmin,
  extensionReady,
  block,
  onOpenReencode,
  onOpenBlock,
  tz,
}: {
  row: KeyHistoryRow;
  guestDisplay: string;
  isAdmin: boolean;
  extensionReady: boolean;
  block: RoomBlock | null;
  onOpenReencode: () => void;
  onOpenBlock: (block: RoomBlock | null) => void;
  tz?: string;
}) {
  const when = keyHistoryEventTime(row);
  const nights = keyHistoryNights(row);
  const agent = keyHistoryAgent(row);

  return (
    <div className="space-y-4">
      {block ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-[13px] text-amber-900 dark:border-amber-900/45 dark:bg-amber-950/25 dark:text-amber-100/90">
          <p className="flex items-center gap-2 font-semibold text-amber-950 dark:text-amber-50">
            <Lock className="h-4 w-4" aria-hidden />
            {formatBlockSummary(block, tz)}
          </p>
          {block.reason ? (
            <p className="mt-1.5 text-amber-900 dark:text-amber-100/85">
              <span className="text-amber-700 dark:text-amber-100/60">Reason · </span>
              {block.reason}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-100/70">
            <span className="text-amber-700 dark:text-amber-100/55">Blocked at · </span>
            {formatBlockTimestamp(block.created_at, tz)}
          </p>
          <p className="mt-1 text-xs text-amber-800/85 dark:text-amber-100/65">
            {isDeferredMaintenanceBlock(block)
              ? "Replacement keys for this stay remain available until checkout or a room change. New walk-ins cannot be keyed into this room after the block was set. Void RFID keys on the encoder when the guest departs — the full maintenance lock applies automatically once the board shows this room vacant."
              : "New keys cannot be encoded for this room while the block is fully active."}
          </p>
          {isAdmin ? (
            <div className="mt-2.5">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400 bg-amber-100 px-2.5 py-1.5 text-[12px] font-medium text-amber-900 transition-colors hover:bg-amber-200 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100 dark:hover:bg-amber-900/40"
                onClick={() => onOpenBlock(block)}
              >
                <LockOpen className="h-3.5 w-3.5" aria-hidden />
                Manage / unblock
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {isAdmin && extensionReady && (!block || isDeferredMaintenanceBlock(block)) ? (
          <button
            type="button"
            className="inline-flex w-full items-center justify-center rounded-lg bg-[var(--accent)] px-3 py-2.5 text-[13px] font-semibold text-[#042f1f] transition-colors hover:bg-[var(--accent-hover)]"
            onClick={onOpenReencode}
          >
            Encode another key
          </button>
        ) : null}

        {isAdmin && !block ? (
          <button
            type="button"
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-700 bg-red-600 px-3 py-2 text-[13px] font-semibold text-white shadow-sm transition-colors hover:border-red-600 hover:bg-red-500 dark:border-red-600 dark:bg-red-600 dark:text-white dark:hover:bg-red-500 dark:hover:border-red-500"
            onClick={() => onOpenBlock(null)}
          >
            <Ban className="h-4 w-4 text-white/95" aria-hidden />
            Block room (maintenance)
          </button>
        ) : null}
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-4 py-1.5">
        <BoardDetailField label="Room" tone="primary">
          <span className="font-mono text-lg">{(row.room_number ?? "").trim() || "—"}</span>
        </BoardDetailField>
        <BoardDetailField label="Guest" tone="body">
          {guestDisplay || "—"}
        </BoardDetailField>
        <BoardDetailField label="In (key)" tone="primary">
          <KeyBoardDateCell value={keyHistoryCheckin(row)} variant="medium" className="text-sm" />
        </BoardDetailField>
        <BoardDetailField label="Out (key)" tone="primary">
          <KeyBoardDateCell value={keyHistoryCheckout(row)} variant="medium" className="text-sm" />
        </BoardDetailField>
        <BoardDetailField label="Confirmation" tone="primary">
          <span className="font-mono text-[13px]">{row.confirmation_number}</span>
        </BoardDetailField>
        {typeof row.card_serial === "number" ? (
          <BoardDetailField label="Card serial" tone="primary">
            <span className="font-mono text-[13px]">{row.card_serial}</span>
          </BoardDetailField>
        ) : null}
        <BoardDetailField label="Encoded" tone="primary">
          {formatKeyHistoryLocaleDateTime(when) ?? (when ? when : "—")}
        </BoardDetailField>
        <BoardDetailField label="Nights on key" tone="primary">
          {nights !== null ? nights : "—"}
        </BoardDetailField>
        <BoardDetailField label="Encoded by" tone="body">
          <span className="block truncate" title={agent ?? ""}>
            {agent ?? "—"}
          </span>
        </BoardDetailField>
        <BoardDetailField label="Terminal" tone="mono">
          {row.terminal_id ?? "—"}
        </BoardDetailField>
        {row.success !== null && row.success !== undefined ? (
          <BoardDetailField label="Encoder" tone="primary">
            {row.success ? "OK" : "Failed"}
          </BoardDetailField>
        ) : null}
        {row.error_message ? (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 dark:border-red-800/35 dark:bg-red-900/15">
            <p className="text-xs font-bold uppercase tracking-[0.1em] text-red-800 dark:text-red-200">Error</p>
            <div className="mt-2 text-xs leading-relaxed text-red-800 dark:text-red-200">{row.error_message}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Outer tabbed page: Room board (current) + Key history (ledger).
// ─────────────────────────────────────────────────────────────────────────────

type KeysTab = "board" | "history";

export function KeyHistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: KeysTab = searchParams.get("tab") === "history" ? "history" : "board";

  const setTab = useCallback(
    (next: KeysTab) => {
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          if (next === "board") sp.delete("tab");
          else sp.set("tab", next);
          return sp;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return (
    <div className="flex min-h-[calc(100svh-5.5rem)] flex-col gap-6">
      <div className="space-y-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-[var(--text-h)]">
            Keys
          </h1>
          <p className="text-sm text-[var(--text-muted)]">
            Live room board for today and the full encode ledger.
          </p>
        </div>

        <div
          role="tablist"
          aria-label="Keys view"
          className="flex gap-6 border-b border-[var(--border)]"
        >
          {(
            [
              ["board", "Room board"],
              ["history", "Key history"],
            ] as const
          ).map(([k, label]) => {
            const active = tab === k;
            return (
              <button
                key={k}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => setTab(k)}
                className={`relative -mb-px border-b-2 pb-3 pt-1 text-[0.9375rem] font-medium tracking-[-0.01em] transition-colors ${
                  active
                    ? "border-[var(--text-h)] text-[var(--text-h)]"
                    : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {tab === "board" ? <RoomBoardTab /> : <KeyHistoryLedgerTab />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Key history (ledger) tab — every successful `key_history` row, newest first.
// ─────────────────────────────────────────────────────────────────────────────

const LEDGER_PAGE_SIZE_OPTIONS = [10, 15, 25, 50] as const;
type LedgerPageSize = (typeof LEDGER_PAGE_SIZE_OPTIONS)[number];

/**
 * Hard cap on rows we fetch in one go for the all-client-side ledger. The browser sorts
 * / filters / paginates entirely in memory after this single fetch — no per-keystroke
 * requests are sent for search, filter changes, or sort clicks.
 *
 * 10 000 rows ≈ many months of encodes for a small property and is well under what a
 * modern browser can sort instantly.
 */
const LEDGER_FETCH_LIMIT = 10_000;

type LedgerQuickRange = "today" | "yesterday" | "7d" | "30d" | "all";

/** Columns the user can sort by — every comparator runs in the browser. */
type LedgerSortColumn =
  | "encoded"
  | "room"
  | "guest"
  | "confirmation"
  | "card"
  | "in"
  | "out"
  | "encodedBy"
  | "terminal";
type LedgerSortDir = "asc" | "desc";

/** Extract the value used for sorting a given column from a row. Nulls sort last. */
function ledgerSortValue(
  row: KeyHistoryRow,
  col: LedgerSortColumn,
  guestByConfirmation: Map<string, string>,
): string | number | null {
  switch (col) {
    case "encoded":
      return row.encoded_at ?? row.created_at ?? null;
    case "room":
      return (row.room_number ?? "").trim().toLowerCase() || null;
    case "guest":
      return boardGuestDisplay(row, guestByConfirmation).toLowerCase() || null;
    case "confirmation":
      return (row.confirmation_number ?? "").toLowerCase() || null;
    case "card":
      return typeof row.card_serial === "number" ? row.card_serial : null;
    case "in":
      return keyHistoryCheckin(row);
    case "out":
      return keyHistoryCheckout(row);
    case "encodedBy":
      return (keyHistoryAgent(row) ?? "").toLowerCase() || null;
    case "terminal":
      return (row.terminal_id ?? "").toLowerCase() || null;
  }
}

function compareLedgerValues(a: string | number | null, b: string | number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : 1;
}

function KeyHistoryLedgerTab() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const roomFilter = searchParams.get("room")?.trim() ?? "";
  // "Today" in the ledger follows the user's own PC clock.
  const today = useTodayLocalDate();

  // Default quick range = "All" (no date bounds). Admins narrow with the date pickers
  // or the Today / Yesterday / 7d / 30d chips when needed.
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [search, setSearch] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<LedgerPageSize>(25);
  // Default: newest IN time first ("key check-in stamped on the card"). Matches the user's
  // mental model — a 2 PM key on May 13 sorts above a 1:54 AM key on the same date.
  const [sort, setSort] = useState<{ column: LedgerSortColumn; dir: LedgerSortDir }>(
    () => ({ column: "in", dir: "desc" }),
  );

  const toggleSort = useCallback((column: LedgerSortColumn) => {
    setSort((prev) =>
      prev.column === column
        ? { column, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { column, dir: "desc" },
    );
  }, []);

  // When a room filter is supplied via URL, broaden the date range so deep-linked
  // history isn't accidentally hidden by the default 30-day window.
  useEffect(() => {
    if (roomFilter) {
      setFrom("");
      setTo("");
    }
  }, [roomFilter]);

  // Reset to page 1 whenever any filter, sort, or page size changes.
  useEffect(() => {
    setPage(1);
  }, [from, to, search, agentFilter, roomFilter, sort, pageSize]);

  const clearRoomFilter = useCallback(() => {
    setSearchParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        sp.delete("room");
        return sp;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  // ────────────────────────────────────────────────────────────────────────
  // Single fetch — everything else (filter / search / sort / paginate / CSV)
  // runs entirely in the browser. No request is sent on keystroke or column
  // click. Realtime invalidation refreshes the cached dataset on row changes.
  // ────────────────────────────────────────────────────────────────────────
  const ledgerQuery = useQuery({
    queryKey: ["key-history-ledger-all"],
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("key_history")
        .select("*")
        .order("created_at", { ascending: false })
        .range(0, LEDGER_FETCH_LIMIT - 1);
      if (error) throw new Error(error.message);
      return (data ?? []) as KeyHistoryRow[];
    },
  });

  // Hide confirmed encoder failures (`success === false`). Rows where the column
  // is missing or `null` stay visible — that matches old behavior.
  const baseRows = useMemo(
    () => (ledgerQuery.data ?? []).filter((r) => r.success !== false),
    [ledgerQuery.data],
  );

  // We still need the guest names to render the Guest column + sort by guest.
  // Fetch reservations for ALL confirmations once — realtime invalidates this too.
  const confirmationNumbers = useMemo(() => {
    const set = new Set<string>();
    for (const r of baseRows) {
      const c = r.confirmation_number?.trim();
      if (c) set.add(c);
    }
    return [...set];
  }, [baseRows]);

  const guestsQuery = useQuery({
    queryKey: ["key-history-ledger-guests", [...confirmationNumbers].sort().join("|")],
    enabled: confirmationNumbers.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reservations")
        .select("confirmation_number, guest_name, pms_source, reservation_status, updated_at, guest_profile_id")
        .in("confirmation_number", confirmationNumbers);
      if (error) throw new Error(error.message);
      return (data ?? []) as ReservationGuestPick[];
    },
  });

  const { guests: guestByConfirmation, profileByConfirmation } = useMemo(
    () => reservationGuestAndPmsByConfirmation(guestsQuery.data ?? []),
    [guestsQuery.data],
  );

  // Apply every filter purely in JS.
  const filteredRows = useMemo(() => {
    const searchTerm = search.trim().toLowerCase();
    const agentTerm = agentFilter.trim().toLowerCase();
    const room = roomFilter.trim().toLowerCase();
    const hasDateBound = Boolean(from) || Boolean(to);

    return baseRows.filter((r) => {
      if (room && (r.room_number ?? "").trim().toLowerCase() !== room) return false;

      if (hasDateBound) {
        // Compare against the row's encode date as seen on the user's PC clock —
        // matches what `Today / Last 7d / Last 30d` resolve to (also PC-local).
        const bd = parseKeyHistoryDay(r.created_at ?? r.encoded_at ?? null);
        if (!bd) return false;
        if (from && bd < from) return false;
        if (to && bd > to) return false;
      }

      if (searchTerm) {
        const roomS = (r.room_number ?? "").toLowerCase();
        const confS = (r.confirmation_number ?? "").toLowerCase();
        const guestS = (
          boardGuestDisplay(r, guestByConfirmation) || ""
        ).toLowerCase();
        if (
          !roomS.includes(searchTerm) &&
          !confS.includes(searchTerm) &&
          !guestS.includes(searchTerm)
        ) {
          return false;
        }
      }

      if (agentTerm) {
        const agent = (keyHistoryAgent(r) ?? "").toLowerCase();
        if (!agent.includes(agentTerm)) return false;
      }

      return true;
    });
  }, [baseRows, search, agentFilter, from, to, roomFilter, guestByConfirmation]);

  // Sort the filtered set in JS (every column, including Guest).
  const sortedRows = useMemo(() => {
    const arr = [...filteredRows];
    const dir = sort.dir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      const va = ledgerSortValue(a, sort.column, guestByConfirmation);
      const vb = ledgerSortValue(b, sort.column, guestByConfirmation);
      const primary = compareLedgerValues(va, vb) * dir;
      if (primary !== 0) return primary;
      // Stable tie-breaker: newest encode first.
      const ta = a.created_at ?? "";
      const tb = b.created_at ?? "";
      return tb < ta ? -1 : tb > ta ? 1 : 0;
    });
    return arr;
  }, [filteredRows, sort, guestByConfirmation]);

  const totalFiltered = sortedRows.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));

  useEffect(() => {
    setPage((p) => Math.min(p, totalPages));
  }, [totalPages]);

  const pageOffset = (page - 1) * pageSize;

  // Paginate purely client-side.
  const rows = useMemo(
    () => sortedRows.slice(pageOffset, pageOffset + pageSize),
    [sortedRows, pageOffset, pageSize],
  );

  const rangeStart = totalFiltered === 0 ? 0 : pageOffset + 1;
  const rangeEnd = pageOffset + rows.length;
  const totalCount = baseRows.length;
  const filteredCount = filteredRows.length;
  const fetchCapped = (ledgerQuery.data?.length ?? 0) >= LEDGER_FETCH_LIMIT;

  const [ledgerChannelName] = useState(
    () => `key-history-ledger-realtime-${Math.random().toString(36).slice(2, 10)}`,
  );
  useEffect(() => {
    const channel = supabase
      .channel(ledgerChannelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "key_history" },
        () => {
          void queryClient.invalidateQueries({ queryKey: ["key-history-ledger-all"] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "reservations" },
        () => {
          void queryClient.invalidateQueries({ queryKey: ["key-history-ledger-guests"] });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient, ledgerChannelName]);

  const applyQuickRange = useCallback((kind: LedgerQuickRange) => {
    if (kind === "all") {
      setFrom("");
      setTo("");
      return;
    }
    if (kind === "today") {
      setFrom(today);
      setTo(today);
    } else if (kind === "yesterday") {
      const y = addDaysLocal(today, -1);
      setFrom(y);
      setTo(y);
    } else if (kind === "7d") {
      setFrom(addDaysLocal(today, -6));
      setTo(today);
    } else if (kind === "30d") {
      setFrom(addDaysLocal(today, -29));
      setTo(today);
    }
  }, []);

  const activeQuickRange: LedgerQuickRange | null = useMemo(() => {
    if (!from && !to) return "all";
    if (from === today && to === today) return "today";
    const y = addDaysLocal(today, -1);
    if (from === y && to === y) return "yesterday";
    if (from === addDaysLocal(today, -6) && to === today) return "7d";
    if (from === addDaysLocal(today, -29) && to === today) return "30d";
    return null;
  }, [from, to]);

  const handleExportCsv = useCallback(() => {
    const header = [
      "Encoded (local)",
      "Room",
      "Guest",
      "Confirmation",
      "Card serial",
      "In (key)",
      "Out (key)",
      "Encoded by",
      "Terminal",
    ];
    // Export every row matching the current filter+sort (not just the visible page).
    const csvRows = [
      header,
      ...sortedRows.map((r) => {
        const t = keyHistoryEventTime(r);
        return [
          t ? new Date(t).toLocaleString() : "",
          r.room_number ?? "",
          boardGuestDisplay(r, guestByConfirmation),
          r.confirmation_number,
          typeof r.card_serial === "number" ? r.card_serial : "",
          formatKeyHistoryCompactYmdHm(keyHistoryCheckin(r)) ??
            parseKeyHistoryDay(keyHistoryCheckin(r)) ??
            keyHistoryCheckin(r) ??
            "",
          formatKeyHistoryCompactYmdHm(keyHistoryCheckout(r)) ??
            parseKeyHistoryDay(keyHistoryCheckout(r)) ??
            keyHistoryCheckout(r) ??
            "",
          keyHistoryAgent(r) ?? "",
          r.terminal_id ?? "",
        ];
      }),
    ];
    const csv = csvRows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `key_history_${from || "all"}_${to || "all"}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }, [sortedRows, guestByConfirmation, from, to]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["key-history-ledger-all"] });
    void queryClient.invalidateQueries({ queryKey: ["key-history-ledger-guests"] });
  }, [queryClient]);

  const loadError = ledgerQuery.error;
  const isLoading = ledgerQuery.isLoading;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h2 className="text-[1.375rem] font-semibold leading-tight tracking-[-0.015em] text-[var(--text-h)]">
            Key history
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <div className="inline-flex items-center gap-1">
            <DateField value={from} onChange={setFrom} aria-label="From date" className="w-40" />
            <span className="px-0.5 text-[12px] text-[var(--text-muted)]">→</span>
            <DateField value={to} onChange={setTo} aria-label="To date" className="w-40" />
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
            <input
              type="text"
              className="h-9 w-44 rounded-lg border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-[13px] text-[var(--text-h)] placeholder:text-[var(--text-muted)] outline-none transition-[border-color] focus:border-[var(--accent-border)]"
              placeholder="Filter by agent"
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              aria-label="Encoded by filter"
            />
          </div>
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-h)]"
            aria-label="Refresh"
            onClick={refresh}
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
            onClick={handleExportCsv}
            disabled={sortedRows.length === 0}
          >
            <Download className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
            Export
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
          Quick range
        </span>
        <div className="h-5 w-px bg-[var(--border)]" aria-hidden />
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              ["today", "Today"],
              ["yesterday", "Yesterday"],
              ["7d", "Last 7 days"],
              ["30d", "Last 30 days"],
              ["all", "All time"],
            ] as const
          ).map(([k, label]) => {
            const isActive = activeQuickRange === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => applyQuickRange(k)}
                aria-pressed={isActive}
                className={`inline-flex h-8 items-center rounded-full border px-3.5 text-[13px] font-medium transition-colors ${
                  isActive
                    ? "border-[var(--text-h)]/30 bg-[var(--surface-2)] text-[var(--text-h)]"
                    : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)] hover:text-[var(--text-h)]"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {loadError ? (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-[13px] text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
          <div className="flex items-start gap-2">
            <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{(loadError as Error).message}</span>
          </div>
        </div>
      ) : null}

      {fetchCapped ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-900 dark:border-amber-900/45 dark:bg-amber-950/20 dark:text-amber-100/85">
          Loaded the most recent <span className="font-semibold">{LEDGER_FETCH_LIMIT.toLocaleString()}</span> rows.
          Older history isn&apos;t in this view — narrow the date range or open Supabase if you need it.
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        {roomFilter ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2.5 text-[12px]">
            <span className="text-[var(--text-muted)]">Filtered to</span>
            <span className="rounded-md border border-[var(--accent-border)] bg-[var(--accent-muted)] px-2 py-0.5 font-mono text-[12px] font-semibold text-[var(--text-h)]">
              Room {roomFilter}
            </span>
            <button
              type="button"
              className="text-[12px] text-[var(--text-muted)] underline-offset-2 hover:text-[var(--text-h)] hover:underline"
              onClick={clearRoomFilter}
            >
              Clear
            </button>
            <span className="ml-auto text-[11px] text-[var(--text-muted)]">
              Showing every encode for this room across all dates.
            </span>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
          <div className="relative min-w-[14rem] max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
            <input
              type="search"
              className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-[13px] text-[var(--text-h)] placeholder:text-[var(--text-muted)] outline-none transition-[border-color] focus:border-[var(--accent-border)]"
              placeholder="Search room, guest or confirmation…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search key history"
            />
          </div>
          {search ? (
            <button
              type="button"
              className="icon-btn shrink-0"
              aria-label="Clear search"
              onClick={() => setSearch("")}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
          <p className="ml-auto text-[11px] tabular-nums text-[var(--text-muted)]">
            {isLoading
              ? "Loading…"
              : totalCount === 0
                ? "0 rows"
                : filteredCount === totalCount
                  ? `${totalCount.toLocaleString()} ${totalCount === 1 ? "encode" : "encodes"}`
                  : `${filteredCount.toLocaleString()} matches · ${totalCount.toLocaleString()} total`}
            {ledgerQuery.isFetching && !isLoading ? " · refreshing…" : ""}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] border-collapse text-left text-sm">
              <thead className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface)]">
                <tr>
                  {(
                    [
                      ["encoded", "Encoded"],
                      ["room", "Room"],
                      ["guest", "Guest"],
                      ["confirmation", "Confirmation"],
                      ["card", "Card #"],
                      ["in", "In"],
                      ["out", "Out"],
                      ["encodedBy", "Encoded by"],
                      ["terminal", "Terminal"],
                    ] as ReadonlyArray<readonly [LedgerSortColumn, string]>
                  ).map(([col, label]) => {
                    const isActive = sort.column === col;
                    const Arrow = isActive && sort.dir === "asc" ? ArrowUp : ArrowDown;
                    return (
                      <th
                        key={col}
                        scope="col"
                        aria-sort={
                          isActive ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
                        }
                        className="whitespace-nowrap px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
                      >
                        <button
                          type="button"
                          onClick={() => toggleSort(col)}
                          className={[
                            "inline-flex items-center gap-1 rounded px-0.5 py-0.5 transition-colors",
                            isActive
                              ? "text-[var(--text-h)]"
                              : "hover:text-[var(--text-h)]",
                          ].join(" ")}
                          aria-label={`Sort by ${label} ${
                            isActive && sort.dir === "asc" ? "descending" : "ascending"
                          }`}
                        >
                          <span>{label}</span>
                          <Arrow
                            className={[
                              "h-3 w-3",
                              isActive ? "opacity-90" : "opacity-25",
                            ].join(" ")}
                            aria-hidden
                          />
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const t = keyHistoryEventTime(r);
                  return (
                    <tr
                      key={r.id ?? `${r.confirmation_number}-${r.card_serial ?? "x"}-${t}`}
                      className="border-b border-[var(--border)]/60 transition-colors hover:bg-[var(--surface-2)]"
                    >
                      <td className="whitespace-nowrap px-3 py-2.5 text-[13px] font-medium text-[var(--text-h)]">
                        {formatKeyHistoryLocaleDateTime(t) ?? (t ? t : "—")}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[13px] font-semibold text-[var(--text-h)]">
                        {(r.room_number ?? "").trim() || "—"}
                      </td>
                      <td className="max-w-[18rem] truncate px-3 py-2.5 text-[13px] text-[var(--text)]">
                        <span className="inline-flex items-center gap-2">
                          <span className="truncate">{boardGuestDisplay(r, guestByConfirmation) || "—"}</span>
                          {(() => {
                            const pid = profileByConfirmation.get(r.confirmation_number) ?? "";
                            return pid ? (
                              <Link
                                to={`/guests/${encodeURIComponent(pid)}`}
                                className="inline-flex items-center rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-h)] hover:bg-[var(--surface-2)]"
                                title="Open guest profile"
                                onClick={(e) => e.stopPropagation()}
                              >
                                ↗
                              </Link>
                            ) : null;
                          })()}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[12px] text-[var(--text)]">
                        {r.confirmation_number}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-center font-mono text-[12px] text-[var(--text)]">
                        {typeof r.card_serial === "number" ? r.card_serial : "—"}
                      </td>
                      <td className="min-w-[11rem] px-3 py-2 align-top">
                        <KeyBoardDateCell value={keyHistoryCheckin(r)} variant="medium" />
                      </td>
                      <td className="min-w-[11rem] px-3 py-2 align-top">
                        <KeyBoardDateCell value={keyHistoryCheckout(r)} variant="medium" />
                      </td>
                      <td
                        className="max-w-[12rem] truncate px-3 py-2.5 text-[13px] text-[var(--text)]"
                        title={keyHistoryAgent(r) ?? ""}
                      >
                        {keyHistoryAgent(r) ?? "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px] text-[var(--text-muted)]">
                        {r.terminal_id ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && !isLoading ? (
              <p className="p-6 text-center text-sm text-[var(--text-muted)]">
                No encodes match the current filters.
              </p>
            ) : null}
          </div>

          {!isLoading ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[12px] text-[var(--text-muted)]">
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="ledger-page-size" className="whitespace-nowrap font-medium">
                  Rows per page
                </label>
                <select
                  id="ledger-page-size"
                  className="h-8 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-[13px] font-medium text-[var(--text-h)] outline-none transition-[border-color] focus:border-[var(--accent-border)]"
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value) as LedgerPageSize);
                  }}
                  aria-label="Rows per page"
                >
                  {LEDGER_PAGE_SIZE_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <span className="tabular-nums">
                  {totalFiltered === 0 ? (
                    <>0 rows</>
                  ) : (
                    <>
                      Showing{" "}
                      <span className="font-medium text-[var(--text-h)]">
                        {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()}
                      </span>{" "}
                      of {totalFiltered.toLocaleString()}
                    </>
                  )}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-h)] disabled:pointer-events-none disabled:opacity-35"
                  aria-label="Previous page"
                  disabled={page <= 1 || totalFiltered === 0}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden />
                </button>
                <span className="min-w-[7.5rem] tabular-nums text-center text-[var(--text-h)]">
                  Page {page.toLocaleString()} of {totalPages.toLocaleString()}
                </span>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-h)] disabled:pointer-events-none disabled:opacity-35"
                  aria-label="Next page"
                  disabled={page >= totalPages || totalFiltered === 0}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  <ChevronRight className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
