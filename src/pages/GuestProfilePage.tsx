import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  CalendarRange,
  Clock,
  KeyRound,
  Mail,
  Phone,
  ScanLine,
  Users,
} from "lucide-react";
import { formatStayDate } from "@/lib/calendarDate";
import { supabase } from "@/lib/supabase";
import { moneyFromReservation, formatUsd } from "@/lib/reservationMoney";
import { formatRoomChainForDisplay, latestRoomFromReservation } from "@/lib/roomNumber";
import { StatusPill } from "@/components/ui/StatusPill";
import {
  keyHistoryAgent,
  keyHistoryEventTime,
  keyHistoryNights,
} from "@/lib/keyHistory";
import { useHotelSettings } from "@/lib/hotelSettings";
import { ReservationExportDropdown } from "@/components/ui/ReservationExportDropdown";
import type { GuestProfile, IdScan, KeyHistoryRow, Reservation } from "@/types/database";

type TabId = "stays" | "keys" | "scans";

type Tier = "hot" | "warm" | "new";

function tierFromCount(count: number): Tier {
  if (count >= 3) return "hot";
  if (count >= 2) return "warm";
  return "new";
}

const TIER_CONFIG: Record<Tier, { label: string; className: string }> = {
  hot: {
    label: "Hot",
    className: "bg-red-500/15 text-red-400 border border-red-500/25",
  },
  warm: {
    label: "Warm",
    className: "bg-amber-500/15 text-amber-400 border border-amber-500/25",
  },
  new: {
    label: "New",
    className: "bg-blue-500/15 text-blue-400 border border-blue-500/25",
  },
};

function TierBadge({ count }: { count: number }) {
  const tier = tierFromCount(count);
  const { label, className } = TIER_CONFIG[tier];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none ${className}`}
    >
      {label}
    </span>
  );
}

function formatDate(d: string | null | undefined) {
  return formatStayDate(d);
}

function formatDateTime(d: string | null | undefined) {
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(d),
    );
  } catch {
    return d;
  }
}

function StatCard({
  label,
  value,
  icon: Icon,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  valueClassName?: string;
}) {
  return (
    <div className="flex min-w-0 gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-3)] text-[var(--accent)]">
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          {label}
        </div>
        <div className={`mt-1.5 text-sm font-medium text-[var(--text-h)] ${valueClassName ?? ""}`}>
          {value}
        </div>
      </div>
    </div>
  );
}

export function GuestProfilePage() {
  const { profileId } = useParams<{ profileId: string }>();
  const [tab, setTab] = useState<TabId>("stays");
  const hotelSettings = useHotelSettings();

  const profileQuery = useQuery({
    queryKey: ["guest_profile", profileId],
    enabled: !!profileId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("guest_profiles")
        .select("*")
        .eq("id", profileId!)
        .single();
      if (error) throw new Error(error.message);
      return data as GuestProfile;
    },
  });

  const staysQuery = useQuery({
    queryKey: ["guest_profile_stays", profileId],
    enabled: !!profileId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reservations")
        .select("*")
        .eq("guest_profile_id", profileId!)
        .order("check_in_date", { ascending: false });
      if (error) throw new Error(error.message);
      return data as Reservation[];
    },
  });

  const keysQuery = useQuery({
    queryKey: ["guest_profile_keys", profileId],
    enabled: !!profileId,
    queryFn: async () => {
      // Look up all confirmation numbers for this guest profile, then fetch key_history by
      // confirmation_number. This works for both old rows (no guest_profile_id set) and new ones.
      const { data: confsData, error: confsErr } = await supabase
        .from("reservations")
        .select("confirmation_number")
        .eq("guest_profile_id", profileId!);
      if (confsErr) throw new Error(confsErr.message);

      const confs = (confsData ?? [])
        .map((r) => r.confirmation_number as string | null)
        .filter((c): c is string => !!c);

      if (confs.length === 0) return [] as KeyHistoryRow[];

      const { data, error } = await supabase
        .from("key_history")
        .select("*")
        .in("confirmation_number", confs)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data as KeyHistoryRow[];
    },
  });

  const scansQuery = useQuery({
    queryKey: ["guest_profile_scans", profileId],
    enabled: !!profileId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("id_scans")
        .select("*")
        .eq("guest_profile_id", profileId!)
        .order("scanned_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data as IdScan[];
    },
  });

  const profile = profileQuery.data;
  const stays = staysQuery.data ?? [];

  const stayStats = useMemo(() => {
    let totalSpent: number | null = null;
    const sorted = [...stays].sort((a, b) => {
      const da = a.check_in_date ?? "";
      const db = b.check_in_date ?? "";
      if (da !== db) return db.localeCompare(da);
      return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
    });

    for (const row of stays) {
      const money = moneyFromReservation(row);
      if (money.total != null) {
        totalSpent = (totalSpent ?? 0) + money.total;
      }
    }

    const lastRoom =
      sorted.length > 0 ? latestRoomFromReservation(sorted[0]!) : null;

    return {
      stayCount: stays.length,
      totalSpent,
      lastRoom,
    };
  }, [stays]);

  if (!profileId) {
    return <p className="text-[var(--text-muted)]">Missing profile ID.</p>;
  }

  const tabClass = (id: TabId) =>
    [
      "inline-flex items-center gap-2 rounded-t-lg px-4 py-2.5 text-sm font-medium transition-colors",
      tab === id
        ? "border border-b-0 border-[var(--border)] bg-[var(--surface)] text-[var(--text-h)]"
        : "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-h)]",
    ].join(" ");

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div>
        <Link
          to="/guests"
          className="inline-flex items-center gap-2 text-sm font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
        >
          <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
          Back to guest profiles
        </Link>
      </div>

      {profileQuery.isLoading ? (
        <p className="text-[var(--text-muted)]">Loading profile…</p>
      ) : profileQuery.isError ? (
        <p className="text-red-400">{(profileQuery.error as Error).message}</p>
      ) : !profile ? (
        <p className="text-[var(--text-muted)]">Profile not found.</p>
      ) : (
        <>
          {/* ── Header ───────────────────────────────────────────────── */}
          <header className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            <div className="border-b border-[var(--border)] bg-[var(--surface-2)]/50 px-6 py-5 md:px-8">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-3)] text-[var(--accent)]">
                  <Users className="h-6 w-6" aria-hidden />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <h1 className="truncate text-2xl font-semibold tracking-tight text-[var(--text-h)] md:text-3xl">
                      {profile.display_name || (
                        <span className="italic text-[var(--text-muted)]">No name on file</span>
                      )}
                    </h1>
                    {stayStats.stayCount > 0 ? <TierBadge count={stayStats.stayCount} /> : null}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                    {profile.email ? (
                      <a
                        href={`mailto:${profile.email}`}
                        className="inline-flex items-center gap-1.5 text-[var(--accent)] underline-offset-2 hover:underline"
                      >
                        <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        {profile.email}
                      </a>
                    ) : null}
                    {profile.phone ? (
                      <a
                        href={`tel:${profile.phone.replace(/\s/g, "")}`}
                        className="inline-flex items-center gap-1.5 text-[var(--accent)] underline-offset-2 hover:underline"
                      >
                        <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        {profile.phone}
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 md:p-6">
              <StatCard label="Total stays" value={stayStats.stayCount} icon={CalendarRange} />
              <StatCard
                label="Total spent"
                value={stayStats.totalSpent != null ? formatUsd(stayStats.totalSpent) : "—"}
                icon={Activity}
                valueClassName={
                  stayStats.totalSpent != null ? "text-emerald-400 font-semibold" : undefined
                }
              />
              <StatCard
                label="Last room"
                value={
                  stayStats.lastRoom ? (
                    <span className="inline-flex items-center gap-1.5 font-mono">
                      <KeyRound className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
                      {stayStats.lastRoom}
                    </span>
                  ) : (
                    "—"
                  )
                }
                icon={KeyRound}
              />
              <StatCard label="First visit" value={formatDate(profile.first_seen_at)} icon={Clock} />
              <StatCard label="Last visit" value={formatDate(profile.last_seen_at)} icon={Clock} />
              <StatCard label="Profile created" value={formatDate(profile.created_at)} icon={Users} />
            </div>
          </header>

          {/* ── Tabs ─────────────────────────────────────────────────── */}
          <div role="tablist" className="flex flex-wrap gap-2 border-b border-[var(--border)] pb-0">
            <button type="button" role="tab" aria-selected={tab === "stays"} className={tabClass("stays")} onClick={() => setTab("stays")}>
              <CalendarRange className="h-4 w-4" aria-hidden />
              Stay history
              {staysQuery.data ? (
                <span className="ml-1 rounded-full bg-[var(--surface-3)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-muted)]">
                  {staysQuery.data.length}
                </span>
              ) : null}
            </button>
            <button type="button" role="tab" aria-selected={tab === "keys"} className={tabClass("keys")} onClick={() => setTab("keys")}>
              <KeyRound className="h-4 w-4" aria-hidden />
              Keys made
              {keysQuery.data ? (
                <span className="ml-1 rounded-full bg-[var(--surface-3)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-muted)]">
                  {keysQuery.data.length}
                </span>
              ) : null}
            </button>
            <button type="button" role="tab" aria-selected={tab === "scans"} className={tabClass("scans")} onClick={() => setTab("scans")}>
              <ScanLine className="h-4 w-4" aria-hidden />
              ID scans
              {scansQuery.data ? (
                <span className="ml-1 rounded-full bg-[var(--surface-3)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-muted)]">
                  {scansQuery.data.length}
                </span>
              ) : null}
            </button>
          </div>

          {/* ── Stay History ─────────────────────────────────────────── */}
          {tab === "stays" ? (
            <section className="rounded-b-xl rounded-tr-xl border border-t-0 border-[var(--border)] bg-[var(--surface)] p-6 md:p-8">
              <h2 className="text-lg font-semibold text-[var(--text-h)]">Stay history</h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">
                All reservations linked to this guest profile across both PMS systems.
              </p>

              {staysQuery.isLoading ? (
                <p className="mt-6 text-sm text-[var(--text-muted)]">Loading stays…</p>
              ) : staysQuery.isError ? (
                <p className="mt-6 text-red-400">{(staysQuery.error as Error).message}</p>
              ) : stays.length === 0 ? (
                <p className="mt-6 rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                  No stays on file yet.
                </p>
              ) : (
                <div className="mt-6 overflow-x-auto rounded-xl border border-[var(--border)]">
                  <table className="data-table min-w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th scope="col">Confirmation</th>
                        <th scope="col">Room</th>
                        <th scope="col">Check-in</th>
                        <th scope="col">Check-out</th>
                        <th scope="col">Total</th>
                        <th scope="col">Status</th>
                        <th scope="col">PMS</th>
                        <th scope="col">Export</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stays.map((res) => {
                        const money = moneyFromReservation(res);
                        return (
                        <tr key={res.id}>
                          <td>
                            <Link
                              to={`/guest/${encodeURIComponent(res.confirmation_number)}?pms=${res.pms_source}`}
                              className="font-mono font-medium text-[var(--accent)] underline-offset-2 hover:underline"
                            >
                              {res.confirmation_number}
                            </Link>
                          </td>
                          <td className="font-mono text-[var(--text-h)]">
                            {formatRoomChainForDisplay(res) ?? "—"}
                          </td>
                          <td className="whitespace-nowrap text-[var(--text-muted)]">
                            {formatDate(res.check_in_date)}
                          </td>
                          <td className="whitespace-nowrap text-[var(--text-muted)]">
                            {formatDate(res.check_out_date)}
                          </td>
                          <td className="whitespace-nowrap font-medium text-emerald-400">
                            {money.total != null ? formatUsd(money.total) : "—"}
                          </td>
                          <td>
                            <StatusPill label={res.reservation_status} />
                          </td>
                          <td>
                            <span className="rounded-md bg-[var(--surface-3)] px-2 py-0.5 text-xs font-semibold uppercase text-[var(--text-h)]">
                              {res.pms_source}
                            </span>
                          </td>
                          <td>
                            <ReservationExportDropdown
                              reservation={res}
                              profile={profile}
                              hotel={hotelSettings}
                            />
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}

          {/* ── Keys ─────────────────────────────────────────────────── */}
          {tab === "keys" ? (
            <section className="rounded-b-xl rounded-tr-xl border border-t-0 border-[var(--border)] bg-[var(--surface)] p-6 md:p-8">
              <h2 className="text-lg font-semibold text-[var(--text-h)]">Keys made</h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">
                All room keys encoded for this guest across every stay.
              </p>

              {keysQuery.isLoading ? (
                <p className="mt-6 text-sm text-[var(--text-muted)]">Loading key history…</p>
              ) : keysQuery.isError ? (
                <p className="mt-6 text-red-400">{(keysQuery.error as Error).message}</p>
              ) : !keysQuery.data?.length ? (
                <p className="mt-6 rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                  No key encodings on file for this guest.
                </p>
              ) : (
                <div className="mt-6 overflow-x-auto rounded-xl border border-[var(--border)]">
                  <table className="data-table min-w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th scope="col">Encoded</th>
                        <th scope="col">Confirmation</th>
                        <th scope="col">Room</th>
                        <th scope="col">Nights</th>
                        <th scope="col">Serial</th>
                        <th scope="col">Agent</th>
                      </tr>
                    </thead>
                    <tbody>
                      {keysQuery.data.map((row) => {
                        const when = keyHistoryEventTime(row);
                        return (
                          <tr key={row.id}>
                            <td className="whitespace-nowrap text-[var(--text-muted)]">
                              {when ? formatDateTime(when) : "—"}
                            </td>
                            <td>
                              <Link
                                to={`/guest/${encodeURIComponent(row.confirmation_number)}`}
                                className="font-mono text-[var(--accent)] underline-offset-2 hover:underline"
                              >
                                {row.confirmation_number}
                              </Link>
                            </td>
                            <td className="font-mono text-[var(--text-h)]">
                              {row.room_number ?? "—"}
                            </td>
                            <td className="text-[var(--text)]">
                              {keyHistoryNights(row) !== null ? keyHistoryNights(row) : "—"}
                            </td>
                            <td className="text-[var(--text)]">
                              {row.card_serial != null ? `Key ${row.card_serial}` : "—"}
                            </td>
                            <td className="max-w-[10rem] min-w-0">
                              <span className="block truncate" title={keyHistoryAgent(row) ?? ""}>
                                {keyHistoryAgent(row) ?? "—"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}

          {/* ── ID Scans ──────────────────────────────────────────────── */}
          {tab === "scans" ? (
            <section className="rounded-b-xl rounded-tr-xl border border-t-0 border-[var(--border)] bg-[var(--surface)] p-6 md:p-8">
              <h2 className="text-lg font-semibold text-[var(--text-h)]">ID scans</h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">
                Every ID scan recorded for this guest, newest first.
              </p>

              {scansQuery.isLoading ? (
                <p className="mt-6 text-sm text-[var(--text-muted)]">Loading scans…</p>
              ) : scansQuery.isError ? (
                <p className="mt-6 text-red-400">{(scansQuery.error as Error).message}</p>
              ) : !scansQuery.data?.length ? (
                <p className="mt-6 rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                  No ID scans on file for this guest.
                </p>
              ) : (
                <div className="mt-6 overflow-x-auto rounded-xl border border-[var(--border)]">
                  <table className="data-table min-w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th scope="col">Scanned at</th>
                        <th scope="col">Confirmation</th>
                        <th scope="col">Scanned by</th>
                        <th scope="col">Manual</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scansQuery.data.map((scan) => (
                        <tr key={scan.id}>
                          <td className="whitespace-nowrap text-[var(--text-muted)]">
                            {formatDateTime(scan.scanned_at)}
                          </td>
                          <td>
                            <Link
                              to={`/guest/${encodeURIComponent(scan.confirmation_number)}`}
                              className="font-mono text-[var(--accent)] underline-offset-2 hover:underline"
                            >
                              {scan.confirmation_number}
                            </Link>
                          </td>
                          <td className="max-w-[12rem] min-w-0">
                            <span className="block truncate" title={scan.scanned_by ?? ""}>
                              {scan.scanned_by ?? "—"}
                            </span>
                          </td>
                          <td className="text-[var(--text-muted)]">
                            {scan.manual_entry ? "Yes" : "No"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
