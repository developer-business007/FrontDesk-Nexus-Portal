import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CalendarRange,
  ChevronRight,
  KeyRound,
  LogOut,
  Users,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { CheckoutReadyPanel, CheckoutReadyDepartureBadge } from "@/components/CheckoutReadyPanel";
import {
  DASHBOARD_MERGED_QUERY_KEY,
  fetchDashboardMergedData,
  type DashboardGuestRow,
} from "@/lib/dashboardGuestMerge";
import { useHotelRoomInventory } from "@/lib/hotelRooms";
import {
  currentBusinessDateNow,
  formatHotelLocaleString,
  hotelDateRangeToUtcIso,
  useHotelSettings,
} from "@/lib/hotelSettings";
import { usePmsBoardRealtime } from "@/lib/pmsBoard";
import { StatusPill } from "@/components/ui/StatusPill";
import { supabase } from "@/lib/supabase";
import type { CheckoutReadyKind } from "@/lib/checkoutReadyAlerts";

function useNowMs(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function DashboardPage() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const hotel = useHotelSettings();
  const nowMs = useNowMs(15_000);
  usePmsBoardRealtime();

  const nexusBusinessDate = useMemo(
    () => currentBusinessDateNow(hotel),
    [hotel, nowMs],
  );

  const hotelName =
    hotel.hotelName.trim() ||
    (import.meta.env.VITE_HOTEL_NAME as string | undefined)?.trim() ||
    "FrontDesk Nexus";

  const roomsQuery = useHotelRoomInventory();
  const inventory = roomsQuery.data ?? [];
  const totalRooms = inventory.length > 0 ? inventory.length : null;

  const mergedQuery = useQuery({
    queryKey: [...DASHBOARD_MERGED_QUERY_KEY, inventory.join(","), Math.floor(nowMs / 15_000)],
    queryFn: () => fetchDashboardMergedData(inventory, nowMs),
    enabled: inventory.length > 0,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const accuracy = mergedQuery.data?.accuracy;
  const canShowPms = accuracy?.canShowPmsData === true;
  const hotelDate = mergedQuery.data?.hotelDate ?? null;
  const roomStats = mergedQuery.data?.roomStats;
  const lists = mergedQuery.data?.lists;

  const opsDate = hotelDate ?? nexusBusinessDate;

  const opsQuery = useQuery({
    queryKey: ["dashboard-ops", opsDate, hotel.timezone],
    queryFn: async () => {
      const { startIso, endIso } = hotelDateRangeToUtcIso(opsDate, opsDate, hotel.timezone);
      const [idScans, keys] = await Promise.all([
        supabase
          .from("id_scans")
          .select("*", { count: "exact", head: true })
          .gte("scanned_at", startIso)
          .lte("scanned_at", endIso),
        supabase
          .from("key_history")
          .select("*", { count: "exact", head: true })
          .gte("created_at", startIso)
          .lte("created_at", endIso),
      ]);
      return {
        idScansToday: idScans.count ?? 0,
        keysToday: keys.count ?? 0,
      };
    },
  });

  useEffect(() => {
    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_MERGED_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["dashboard-ops"] });
    };

    const channel = supabase
      .channel("dashboard-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "reservations" }, invalidate)
      .on("postgres_changes", { event: "*", schema: "public", table: "room_operational_status" }, invalidate)
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, invalidate)
      .on("postgres_changes", { event: "*", schema: "public", table: "id_scans" }, invalidate)
      .on("postgres_changes", { event: "*", schema: "public", table: "key_history" }, invalidate)
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const hotelClock = useMemo(
    () => formatHotelLocaleString(new Date(nowMs), hotel.timezone),
    [nowMs, hotel.timezone],
  );

  if (!profile) return null;

  const pmsLoading = roomsQuery.isLoading || mergedQuery.isLoading;
  const pmsError = mergedQuery.isError;
  const displayDate = hotelDate ?? nexusBusinessDate;

  return (
    <div className="mx-auto max-w-7xl space-y-8 text-left">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-[var(--text-muted)]">{hotelClock}</p>
          <h1 className="page-title mt-1">{hotelName}</h1>
          <p className="mt-2 text-sm text-[var(--text)]">
            <span className="font-medium text-[var(--text-h)]">
              {profile.full_name ?? profile.email}
            </span>
            <span className="text-[var(--text)]"> · </span>
            <span className="rounded bg-[var(--code-bg)] px-2 py-0.5 text-xs text-[var(--text-h)]">
              {profile.role.replace("_", " ")}
            </span>
          </p>
        </div>
        <div className="rounded-xl border border-[var(--accent-border)] bg-[var(--accent-muted)] px-4 py-2 text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {canShowPms ? "SynXis hotel date" : "Business date"}
          </div>
          <div className="text-lg font-semibold text-[var(--accent)]">{displayDate}</div>
        </div>
      </header>

      {!pmsLoading && !canShowPms ? (
        <DashboardPmsUnavailable
          reasons={accuracy?.reasons ?? ["PMS data is not ready."]}
          loading={false}
          error={pmsError}
        />
      ) : null}

      {canShowPms ? (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Arrivals today"
              value={lists?.arrivals.length}
              loading={pmsLoading}
              error={pmsError}
              tone="emerald"
              icon={CalendarRange}
              sub="DualPMS verified"
            />
            <KpiCard
              label="Departures today"
              value={lists?.departures.length}
              loading={pmsLoading}
              error={pmsError}
              tone="amber"
              icon={LogOut}
              sub="DualPMS verified"
            />
            <KpiCard
              label="Occupied rooms"
              value={roomStats?.occupiedRooms}
              loading={pmsLoading}
              error={pmsError}
              tone="sky"
              icon={Users}
              sub={
                roomStats?.occupancyPct != null
                  ? `${roomStats.occupancyPct}% occupancy`
                  : "DualPMS"
              }
            />
            <KpiCard
              label="Vacant rooms"
              value={roomStats?.vacantRooms}
              loading={pmsLoading}
              error={pmsError}
              tone="slate"
              icon={KeyRound}
              sub={
                totalRooms != null
                  ? `${roomStats?.dirtyRooms ?? 0} dirty · ${roomStats?.outOfOrderRooms ?? 0} OOO · ${totalRooms} total`
                  : "DualPMS"
              }
            />
          </section>

          {roomStats?.occupancyPct != null && totalRooms != null ? (
            <section className="dashboard-occupancy rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Room occupancy (DualPMS)
                </h2>
                <span className="text-sm font-medium text-[var(--text-h)]">
                  {roomStats.occupiedRooms} / {totalRooms} rooms · {roomStats.occupancyPct}%
                </span>
              </div>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Guest lists below are built from DualPMS room rows, enriched with matching reservations
                when guest and dates align.
              </p>
              <div className="dashboard-occupancy__track mt-3">
                <div
                  className="dashboard-occupancy__fill"
                  style={{ width: `${Math.min(100, roomStats.occupancyPct)}%` }}
                />
              </div>
            </section>
          ) : null}

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MiniStat label="Dirty vacant" value={roomStats?.dirtyRooms} loading={pmsLoading} />
            <MiniStat label="Out of order" value={roomStats?.outOfOrderRooms} loading={pmsLoading} />
            <MiniStat label="Stay-overs" value={lists?.stayovers.length} loading={pmsLoading} />
            <MiniStat label="Guests in house" value={roomStats?.occupiedRooms} loading={pmsLoading} />
          </section>

          {lists && hotelDate ? (
            <CheckoutReadyPanel departures={lists.departures} hotelDate={hotelDate} />
          ) : null}

          <section className="grid items-stretch gap-6 xl:grid-cols-2">
            <GuestListPanel
              title="Today's arrivals"
              subtitle={`DualPMS arrivals on ${hotelDate}.`}
              rows={lists?.arrivals ?? []}
              loading={pmsLoading}
              error={pmsError}
              emptyMessage="No verified arrivals for this hotel date."
            />
            <GuestListPanel
              title="Today's departures"
              subtitle={`DualPMS departures on ${hotelDate}.`}
              rows={lists?.departures ?? []}
              loading={pmsLoading}
              error={pmsError}
              emptyMessage="No verified departures for this hotel date."
              showTurnover
            />
          </section>

          <GuestListPanel
            title="Stay-overs tonight"
            subtitle={`Occupied DualPMS rooms not departing on ${hotelDate}.`}
            rows={lists?.stayovers ?? []}
            loading={pmsLoading}
            error={pmsError}
            emptyMessage="No verified stay-overs for this hotel date."
          />
        </>
      ) : pmsLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading DualPMS dashboard…</p>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MiniStat label="ID scans today" value={opsQuery.data?.idScansToday} loading={opsQuery.isLoading} />
        <MiniStat label="Keys encoded today" value={opsQuery.data?.keysToday} loading={opsQuery.isLoading} />
      </section>
    </div>
  );
}

function DashboardPmsUnavailable({
  reasons,
  loading,
  error,
}: {
  reasons: string[];
  loading: boolean;
  error: boolean;
}) {
  if (loading) return null;
  return (
    <div
      className="flex items-start gap-3 rounded-xl border-2 border-red-500 bg-red-50 px-4 py-4 text-sm text-red-950 shadow-sm dark:border-red-400 dark:bg-red-950/40 dark:text-red-100"
      role="alert"
    >
      <Activity className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-semibold">
          {error
            ? "DualPMS dashboard data is unavailable — load failed."
            : "DualPMS dashboard data is hidden until accuracy checks pass."}
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs sm:text-sm">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs opacity-90">
          Room KPIs, guest lists, and checkout alerts stay blank until the VPS bridge feed is fresh
          and SynXis hotel date is present. Use the Dual PMS board or Reservations page meanwhile.
        </p>
      </div>
    </div>
  );
}

type KpiTone = "emerald" | "amber" | "sky" | "slate";

const KPI_TONE: Record<
  KpiTone,
  { card: string; iconWrap: string; icon: string; value: string; sub: string }
> = {
  emerald: {
    card: "border-emerald-500/45 bg-gradient-to-br from-emerald-500/18 via-emerald-500/8 to-[var(--surface)] dark:from-emerald-500/20 dark:via-emerald-950/10",
    iconWrap: "bg-emerald-500/15 dark:bg-black/20",
    icon: "text-emerald-700 dark:text-emerald-400",
    value: "text-emerald-900 dark:text-emerald-300",
    sub: "text-emerald-800/80 dark:text-[var(--text-muted)]",
  },
  amber: {
    card: "border-amber-500/45 bg-gradient-to-br from-amber-500/18 via-amber-500/8 to-[var(--surface)] dark:from-amber-500/20 dark:via-amber-950/10",
    iconWrap: "bg-amber-500/15 dark:bg-black/20",
    icon: "text-amber-800 dark:text-amber-400",
    value: "text-amber-950 dark:text-amber-200",
    sub: "text-amber-900/80 dark:text-[var(--text-muted)]",
  },
  sky: {
    card: "border-sky-500/45 bg-gradient-to-br from-sky-500/18 via-sky-500/8 to-[var(--surface)] dark:from-sky-500/20 dark:via-sky-950/10",
    iconWrap: "bg-sky-500/15 dark:bg-black/20",
    icon: "text-sky-800 dark:text-sky-400",
    value: "text-sky-950 dark:text-sky-200",
    sub: "text-sky-900/80 dark:text-[var(--text-muted)]",
  },
  slate: {
    card: "border-[var(--border)] bg-gradient-to-br from-[var(--surface-2)] to-[var(--surface)]",
    iconWrap: "bg-[var(--surface-3)]",
    icon: "text-[var(--text-muted)]",
    value: "text-[var(--text-h)]",
    sub: "text-[var(--text-muted)]",
  },
};

function KpiCard({
  label,
  value,
  loading,
  error,
  tone,
  icon: Icon,
  sub,
}: {
  label: string;
  value: number | null | undefined;
  loading: boolean;
  error: boolean;
  tone: KpiTone;
  icon: React.ComponentType<{ className?: string }>;
  sub?: string;
}) {
  const t = KPI_TONE[tone];
  return (
    <div className={`rounded-xl border p-5 ${t.card}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {label}
          </div>
          {loading ? (
            <div className="mt-3 h-9 w-20 animate-pulse rounded bg-[var(--border)]" />
          ) : error ? (
            <p className="mt-3 text-sm text-red-400">Error</p>
          ) : (
            <div className={`mt-2 text-3xl font-bold tabular-nums ${t.value}`}>
              {value === null || value === undefined ? "—" : value}
            </div>
          )}
          {sub ? <p className={`mt-1.5 text-xs font-medium ${t.sub}`}>{sub}</p> : null}
        </div>
        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${t.iconWrap} ${t.icon}`}
        >
          <Icon className="h-5 w-5" aria-hidden />
        </div>
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  loading,
}: {
  label: string;
  value: number | null | undefined;
  loading: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </div>
      {loading ? (
        <div className="mt-2 h-7 w-12 animate-pulse rounded bg-[var(--border)]" />
      ) : (
        <div className="mt-1 text-xl font-semibold tabular-nums text-[var(--text-h)]">
          {value ?? "—"}
        </div>
      )}
    </div>
  );
}

function GuestListPanel({
  title,
  subtitle,
  rows,
  loading,
  error,
  emptyMessage,
  showTurnover,
}: {
  title: string;
  subtitle: string;
  rows: DashboardGuestRow[];
  loading: boolean;
  error: boolean;
  emptyMessage: string;
  showTurnover?: boolean;
}) {
  return (
    <section className="dashboard-panel flex h-full flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="min-w-0 truncate text-lg font-semibold text-[var(--text-h)]">{title}</h2>
        {!loading && !error ? (
          <span className="dashboard-count-badge tabular-nums">{rows.length} total</span>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-[var(--text-muted)]">{subtitle}</p>

      <div className="dashboard-table-scroll mt-4 rounded-xl border border-[var(--border)]">
        {loading ? (
          <p className="flex h-full items-center justify-center p-6 text-sm text-[var(--text-muted)]">
            Loading…
          </p>
        ) : error ? (
          <p className="flex h-full items-center justify-center p-6 text-sm text-red-400">
            Could not load guest list.
          </p>
        ) : rows.length === 0 ? (
          <p className="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--text-muted)]">
            {emptyMessage}
          </p>
        ) : (
          <div className="dashboard-table-scroll__body">
            <table className="data-table dashboard-table min-w-full text-left text-sm">
              <thead>
                <tr>
                  <th scope="col">Guest</th>
                  <th scope="col">Conf.</th>
                  <th scope="col">Room</th>
                  <th scope="col">PMS</th>
                  {showTurnover ? <th scope="col">Turnover</th> : null}
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td className="dashboard-table__guest font-medium text-[var(--text-h)]">
                      {row.guestName}
                      {row.source === "merged" ? (
                        <span className="mt-0.5 block text-[10px] font-normal text-emerald-700 dark:text-emerald-300">
                          Matched reservation
                        </span>
                      ) : (
                        <span className="mt-0.5 block text-[10px] font-normal text-[var(--text-muted)]">
                          DualPMS only
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      {row.confirmationNumber ? (
                        <Link
                          to={`/guest/${encodeURIComponent(row.confirmationNumber)}${row.pmsSource ? `?pms=${encodeURIComponent(row.pmsSource)}` : ""}`}
                          className="font-mono text-[var(--accent)] hover:underline"
                        >
                          {row.confirmationNumber}
                        </Link>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap font-mono text-[var(--text-h)]">{row.roomNumber}</td>
                    <td className="whitespace-nowrap text-xs text-[var(--text-muted)]">
                      {row.pmsStatusLabel}
                    </td>
                    {showTurnover ? (
                      <td className="whitespace-nowrap">
                        <CheckoutReadyDepartureBadge kind={row.readyKind as CheckoutReadyKind | undefined} />
                      </td>
                    ) : null}
                    <td className="whitespace-nowrap">
                      <StatusPill
                        label={row.reservationStatus ?? row.pmsStatusLabel.split(" · ")[0] ?? "—"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-[var(--text-muted)]">
        <Link to="/reservations" className="font-medium text-[var(--accent)] hover:underline">
          All reservations
          <ChevronRight className="ml-0.5 inline h-3.5 w-3.5" aria-hidden />
        </Link>
        {" · "}
        <Link to="/pms-board" className="font-medium text-[var(--accent)] hover:underline">
          Dual PMS board
        </Link>
      </p>
    </section>
  );
}
