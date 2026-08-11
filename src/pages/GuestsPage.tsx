import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, IdCard, KeyRound, Mail, Phone, Plus, Users } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { decryptJson, hashIdNumber, isEncryptedPayload } from "@/lib/encryption";
import { moneyFromReservation, formatUsd } from "@/lib/reservationMoney";
import { latestRoomFromReservation } from "@/lib/roomNumber";
import { SearchField } from "@/components/ui/SearchField";
import { Skeleton } from "@/components/ui/Skeleton";
import type { GuestProfile, GuestProfileIdType, Reservation } from "@/types/database";

// ── Types ────────────────────────────────────────────────────────────────────

type Tier = "hot" | "warm" | "new";

type ProfileStats = {
  stayCount: number;
  totalSpent: number | null;
  lastRoom: string | null;
};

type PiiPayload = {
  fullName?: string | null;
  idGuru?: {
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
};

type ContactPayload = { value: string };

// ── Helpers ──────────────────────────────────────────────────────────────────

function tierFromCount(count: number): Tier {
  if (count >= 3) return "hot";
  if (count >= 2) return "warm";
  return "new";
}

const TIER_CONFIG: Record<Tier, { label: string; className: string }> = {
  hot: {
    label: "Hot",
    className:
      "bg-red-500/15 text-red-400 border border-red-500/25 ring-0",
  },
  warm: {
    label: "Warm",
    className:
      "bg-amber-500/15 text-amber-400 border border-amber-500/25",
  },
  new: {
    label: "New",
    className:
      "bg-blue-500/15 text-blue-400 border border-blue-500/25",
  },
};

const TIER_STAT_CARD: Record<
  Tier,
  { label: string; cardClass: string; countClass: string; iconClass: string }
> = {
  hot: {
    label: "Hot guests",
    cardClass:
      "border-red-500/50 bg-gradient-to-br from-red-500/25 via-red-950/20 to-[var(--surface-2)]",
    countClass: "bg-red-500 text-white shadow-sm shadow-red-900/40",
    iconClass: "text-red-400",
  },
  warm: {
    label: "Warm guests",
    cardClass:
      "border-amber-500/50 bg-gradient-to-br from-amber-500/25 via-amber-950/15 to-[var(--surface-2)]",
    countClass: "bg-amber-500 text-amber-950 shadow-sm shadow-amber-900/30",
    iconClass: "text-amber-400",
  },
  new: {
    label: "New guests",
    cardClass:
      "border-blue-500/50 bg-gradient-to-br from-blue-500/25 via-blue-950/15 to-[var(--surface-2)]",
    countClass: "bg-blue-500 text-white shadow-sm shadow-blue-900/30",
    iconClass: "text-blue-400",
  },
};

const TIER_FILTER_ACTIVE: Record<Tier | "all", string> = {
  all: "bg-[var(--surface)] text-[var(--text-h)] shadow-sm ring-1 ring-[var(--border)]",
  hot: "bg-red-500/25 text-red-300 shadow-sm ring-1 ring-red-500/40",
  warm: "bg-amber-500/25 text-amber-200 shadow-sm ring-1 ring-amber-500/40",
  new: "bg-blue-500/25 text-blue-300 shadow-sm ring-1 ring-blue-500/40",
};

const TIER_FILTER_IDLE: Record<Tier | "all", string> = {
  all: "text-[var(--text-muted)] hover:bg-[var(--surface)] hover:text-[var(--text-h)]",
  hot: "text-red-400/80 hover:bg-red-500/10 hover:text-red-300",
  warm: "text-amber-400/80 hover:bg-amber-500/10 hover:text-amber-200",
  new: "text-blue-400/80 hover:bg-blue-500/10 hover:text-blue-300",
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

function timeAgo(d: string | null | undefined): string {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}yr ago`;
}

function timeAgoColor(d: string | null | undefined): string {
  if (!d) return "text-[var(--text-muted)]";
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
  if (days <= 30) return "text-emerald-400";
  if (days <= 90) return "text-amber-400";
  return "text-[var(--text-muted)]";
}

// ── Backfill ─────────────────────────────────────────────────────────────────

async function backfillNullProfiles(
  profiles: GuestProfile[],
  onDone: () => void,
) {
  const nullProfiles = profiles.filter(
    (p) => !p.display_name && !p.email && !p.phone,
  );
  if (!nullProfiles.length) return;

  for (const profile of nullProfiles) {
    try {
      const { data: scan } = await supabase
        .from("id_scans")
        .select("pii_encrypted, phone_encrypted, email_encrypted")
        .eq("id_number_hash", profile.id_number_hash)
        .order("scanned_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!scan) continue;

      let displayName: string | null = null;
      let email: string | null = null;
      let phone: string | null = null;

      if (isEncryptedPayload(scan.pii_encrypted)) {
        try {
          const pii = await decryptJson<PiiPayload>(scan.pii_encrypted);
          const first = pii.idGuru?.firstName?.trim() ?? "";
          const last = pii.idGuru?.lastName?.trim() ?? "";
          displayName =
            [first, last].filter(Boolean).join(" ") ||
            pii.fullName?.trim() ||
            null;
          if (pii.idGuru?.email?.trim()) email = pii.idGuru.email.trim();
          if (pii.idGuru?.phone?.trim()) phone = pii.idGuru.phone.trim();
        } catch { /* skip */ }
      }

      if (isEncryptedPayload(scan.email_encrypted) && !email) {
        try {
          const dec = await decryptJson<ContactPayload>(scan.email_encrypted);
          email = dec.value?.trim() || null;
        } catch { /* skip */ }
      }

      if (isEncryptedPayload(scan.phone_encrypted) && !phone) {
        try {
          const dec = await decryptJson<ContactPayload>(scan.phone_encrypted);
          phone = dec.value?.trim() || null;
        } catch { /* skip */ }
      }

      if (!displayName && !email && !phone) continue;

      await supabase
        .from("guest_profiles")
        .update({ display_name: displayName, email, phone })
        .eq("id", profile.id);
    } catch { /* skip this profile */ }
  }

  onDone();
}

// ── Page ─────────────────────────────────────────────────────────────────────

const ID_TYPE_CONFIG: Record<GuestProfileIdType, { label: string; className: string }> = {
  dl:       { label: "DL",       className: "bg-sky-500/15 text-sky-400 border border-sky-500/25" },
  passport: { label: "Passport", className: "bg-violet-500/15 text-violet-400 border border-violet-500/25" },
  manual:   { label: "Manual",   className: "bg-[var(--surface-3)] text-[var(--text-muted)] border border-[var(--border)]" },
};

export function GuestsPage() {
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<Tier | "all">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const queryClient = useQueryClient();
  const backfillRan = useRef(false);

  // Guest profiles
  const profilesQuery = useQuery({
    queryKey: ["guest_profiles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("guest_profiles")
        .select("*")
        .order("last_seen_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data as GuestProfile[];
    },
  });

  // Reservation stats per profile
  const statsQuery = useQuery({
    queryKey: ["guest_profile_res_stats"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reservations")
        .select(
          "guest_profile_id, room_number, total, paid, balance, scrape_payload, check_in_date, updated_at",
        )
        .not("guest_profile_id", "is", null);
      if (error) throw new Error(error.message);

      const rows = ((data ?? []) as (Reservation & { guest_profile_id: string })[]).sort(
        (a, b) => {
          const da = a.check_in_date ?? "";
          const db = b.check_in_date ?? "";
          if (da !== db) return db.localeCompare(da);
          return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
        },
      );

      const map = new Map<string, ProfileStats>();
      for (const row of rows) {
        const id = row.guest_profile_id;
        const existing = map.get(id) ?? { stayCount: 0, totalSpent: null, lastRoom: null };
        existing.stayCount += 1;
        const money = moneyFromReservation(row);
        if (money.total != null) {
          existing.totalSpent = (existing.totalSpent ?? 0) + money.total;
        }
        // Most recent stay first — use latest room in chain (e.g. 203 not 133).
        if (!existing.lastRoom) {
          const room = latestRoomFromReservation(row);
          if (room) existing.lastRoom = room;
        }
        map.set(id, existing);
      }
      return map;
    },
  });

  // Auto-backfill null profiles
  useEffect(() => {
    if (!profilesQuery.data || backfillRan.current) return;
    backfillRan.current = true;
    void backfillNullProfiles(profilesQuery.data, () => {
      void queryClient.invalidateQueries({ queryKey: ["guest_profiles"] });
    });
  }, [profilesQuery.data, queryClient]);

  const profiles = profilesQuery.data ?? [];
  const stats = statsQuery.data ?? new Map<string, ProfileStats>();

  const normalizedSearch = search.trim().toLowerCase();

  const filtered = profiles.filter((p) => {
    const s = stats.get(p.id);
    const tier = tierFromCount(s?.stayCount ?? 0);
    if (tierFilter !== "all" && tier !== tierFilter) return false;
    if (!normalizedSearch) return true;
    return (
      p.display_name?.toLowerCase().includes(normalizedSearch) ||
      p.email?.toLowerCase().includes(normalizedSearch) ||
      p.phone?.toLowerCase().includes(normalizedSearch)
    );
  });

  const tierCounts = {
    hot: profiles.filter((p) => tierFromCount(stats.get(p.id)?.stayCount ?? 0) === "hot").length,
    warm: profiles.filter((p) => tierFromCount(stats.get(p.id)?.stayCount ?? 0) === "warm").length,
    new: profiles.filter((p) => tierFromCount(stats.get(p.id)?.stayCount ?? 0) === "new").length,
  };

  const isLoading = profilesQuery.isLoading;
  const isError = profilesQuery.isError;

  return (
    <div className="mx-auto max-w-6xl space-y-6">

      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-h)]">
            Guest Profiles
          </h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            One profile per unique guest identity — accumulated across all visits.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {profiles.length > 0 && (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-2">
              <Users className="h-5 w-5 text-emerald-400" aria-hidden />
              <span className="text-2xl font-bold tabular-nums text-emerald-400">{profiles.length}</span>
              <span className="text-sm font-medium text-emerald-300/90">total profiles</span>
            </div>
          )}
          <button
            type="button"
            className="btn-primary inline-flex items-center gap-2"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-4 w-4" aria-hidden />
            New Profile
          </button>
        </div>
      </div>

      {/* Stat pills */}
      {profiles.length > 0 && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-3">
          {(["hot", "warm", "new"] as Tier[]).map((tier) => {
            const card = TIER_STAT_CARD[tier];
            return (
              <div
                key={tier}
                className={`flex items-center justify-between rounded-xl border px-4 py-4 ${card.cardClass}`}
              >
                <span className={`text-sm font-semibold ${card.iconClass}`}>{card.label}</span>
                <span
                  className={`inline-flex min-w-[2.25rem] items-center justify-center rounded-full px-3 py-1 text-lg font-bold tabular-nums ${card.countClass}`}
                >
                  {tierCounts[tier]}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-72">
          <SearchField
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email, phone…"
          />
        </div>

        {/* Tier filter */}
        <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1">
          {(["all", "hot", "warm", "new"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTierFilter(t)}
              className={[
                "rounded-md px-3 py-1.5 text-xs font-semibold capitalize transition-colors",
                tierFilter === t ? TIER_FILTER_ACTIVE[t] : TIER_FILTER_IDLE[t],
              ].join(" ")}
            >
              {t === "all" ? `All (${profiles.length})` : `${TIER_CONFIG[t].label} (${tierCounts[t]})`}
            </button>
          ))}
        </div>

        {!isLoading && (
          <span className="text-sm text-[var(--text-muted)]">
            {filtered.length} shown
          </span>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <p className="text-red-400">{(profilesQuery.error as Error).message}</p>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-4 py-16 text-center text-sm text-[var(--text-muted)]">
          {normalizedSearch
            ? `No guests match "${search.trim()}".`
            : profiles.length === 0
              ? "No guest profiles yet. They are created automatically when a guest ID is scanned."
              : "No guests in this tier."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)]">
          <table className="data-table guests-table w-full table-fixed text-left text-sm">
            <colgroup>
              <col className="guests-table__col-name" />
              <col className="guests-table__col-contact" />
              <col className="guests-table__col-tier" />
              <col className="guests-table__col-stays" />
              <col className="guests-table__col-spent" />
              <col className="guests-table__col-room" />
              <col className="guests-table__col-visit" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Guest</th>
                <th scope="col">Contact</th>
                <th scope="col">Tier</th>
                <th scope="col" className="text-center">Stays</th>
                <th scope="col">Total Spent</th>
                <th scope="col">Last Room</th>
                <th scope="col">Last Visit</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((profile) => {
                const s = stats.get(profile.id);
                const stayCount = s?.stayCount ?? 0;
                const lastRoom = s?.lastRoom ?? null;
                return (
                  <tr key={profile.id}>

                    {/* Guest name */}
                    <td className="guests-table__cell-name">
                      <Link
                        to={`/guests/${profile.id}`}
                        className="group inline-flex min-w-0 items-center gap-2 font-semibold text-[var(--accent)] underline-offset-2 hover:underline"
                      >
                        <Users className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
                        <span className="truncate" title={profile.display_name ?? ""}>
                          {profile.display_name || (
                            <span className="font-normal italic text-[var(--text-muted)]">
                              No name
                            </span>
                          )}
                        </span>
                      </Link>
                    </td>

                    {/* Contact */}
                    <td className="guests-table__cell-contact">
                      <div className="flex flex-col gap-0.5">
                        {profile.email ? (
                          <span className="inline-flex min-w-0 items-center gap-1.5 text-[var(--text)]">
                            <Mail className="h-3 w-3 shrink-0 text-[var(--text-muted)]" aria-hidden />
                            <span className="truncate text-xs" title={profile.email}>
                              {profile.email}
                            </span>
                          </span>
                        ) : null}
                        {profile.phone ? (
                          <span className="inline-flex items-center gap-1.5 text-[var(--text)]">
                            <Phone className="h-3 w-3 shrink-0 text-[var(--text-muted)]" aria-hidden />
                            <span className="text-xs">{profile.phone}</span>
                          </span>
                        ) : null}
                        {!profile.email && !profile.phone ? (
                          <span className="text-xs text-[var(--text-muted)]">—</span>
                        ) : null}
                      </div>
                    </td>

                    {/* Tier */}
                    <td className="guests-table__cell-tier">
                      <div className="flex flex-wrap items-center gap-1">
                        <TierBadge count={stayCount} />
                        {(() => {
                          const cfg = ID_TYPE_CONFIG[profile.id_type ?? 'dl'];
                          return (
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none ${cfg.className}`}>
                              <IdCard className="h-2.5 w-2.5 shrink-0" aria-hidden />
                              {cfg.label}
                            </span>
                          );
                        })()}
                      </div>
                    </td>

                    {/* Stays count */}
                    <td className="guests-table__cell-stays text-center">
                      {stayCount > 0 ? (
                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--surface-3)] text-xs font-semibold text-[var(--text-h)]">
                          {stayCount}
                        </span>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>

                    {/* Total spent */}
                    <td className="guests-table__cell-spent">
                      {s?.totalSpent != null ? (
                        <span className="font-medium text-emerald-400">
                          {formatUsd(s.totalSpent)}
                        </span>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>

                    {/* Last room */}
                    <td className="guests-table__cell-room">
                      {lastRoom ? (
                        <span
                          className="inline-flex max-w-full items-center gap-1 font-mono text-xs text-[var(--text-h)]"
                          title={lastRoom}
                        >
                          <KeyRound className="h-3 w-3 shrink-0 text-[var(--text-muted)]" aria-hidden />
                          <span className="truncate">{lastRoom}</span>
                        </span>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>

                    {/* Last visit */}
                    <td className="guests-table__cell-visit">
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs font-medium ${timeAgoColor(profile.last_seen_at)}`}
                      >
                        <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        {timeAgo(profile.last_seen_at)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {createOpen ? (
        <CreateGuestProfileModal onClose={() => setCreateOpen(false)} />
      ) : null}
    </div>
  );
}

// ── Create Guest Profile Modal ────────────────────────────────────────────────

const ID_TYPE_OPTIONS: { value: GuestProfileIdType; label: string; desc: string }[] = [
  { value: "dl",       label: "Driver's License", desc: "US / international DL" },
  { value: "passport", label: "Passport",          desc: "Any country passport" },
  { value: "manual",   label: "No ID",             desc: "Name only, no document" },
];

function CreateGuestProfileModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [idType, setIdType] = useState<GuestProfileIdType>("dl");
  const [idNumber, setIdNumber] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: async () => {
      const trimName = name.trim();
      if (!trimName) throw new Error("Full name is required.");

      let id_number_hash: string;
      if (idType !== "manual") {
        const trimId = idNumber.replace(/\s+/g, "").trim();
        if (!trimId) throw new Error("ID number is required for Driver's License and Passport.");
        id_number_hash = await hashIdNumber(trimId);
      } else {
        // No document — generate a unique key so the profile is always distinct
        id_number_hash = crypto.randomUUID().replace(/-/g, "");
      }

      const now = new Date().toISOString();
      const { error } = await supabase.from("guest_profiles").upsert(
        {
          id_number_hash,
          id_type: idType,
          display_name: trimName,
          email: email.trim() || null,
          phone: phone.trim() || null,
          last_seen_at: now,
        },
        { onConflict: "id_number_hash" },
      );
      if (error) throw new Error(error.message);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["guest_profiles"] });
      onClose();
    },
    onError: (e: Error) => setFormError(e.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    createMutation.mutate();
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Create guest profile"
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6"
      >
        <h2 className="text-lg font-semibold text-[var(--text-h)]">Create guest profile</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Manually add a guest when ID cannot be scanned.
        </p>

        <div className="mt-4 grid gap-3">
          {/* Full name */}
          <label className="block text-sm">
            <span className="text-[var(--text-muted)]">
              Full name <span className="text-red-400">*</span>
            </span>
            <input
              className="input-field mt-1 w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. John Smith"
              autoFocus
              required
            />
          </label>

          {/* ID type selector */}
          <div className="block text-sm">
            <span className="text-[var(--text-muted)]">ID type</span>
            <div className="mt-1 flex gap-2">
              {ID_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`flex-1 rounded-lg border px-2 py-2.5 text-left transition-colors ${
                    idType === opt.value
                      ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent-border)] hover:text-[var(--text-h)]"
                  }`}
                  onClick={() => { setIdType(opt.value); setIdNumber(""); }}
                >
                  <div className="text-xs font-semibold">{opt.label}</div>
                  <div className="mt-0.5 text-[10px] opacity-70">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* ID number — hidden for "manual" */}
          {idType !== "manual" && (
            <label className="block text-sm">
              <span className="text-[var(--text-muted)]">
                {idType === "dl" ? "Driver's license #" : "Passport #"}{" "}
                <span className="text-red-400">*</span>
              </span>
              <input
                className="input-field mt-1 w-full font-mono tracking-wider"
                value={idNumber}
                onChange={(e) => setIdNumber(e.target.value)}
                placeholder={idType === "dl" ? "e.g. A1234567" : "e.g. AB1234567"}
                required
              />
              <span className="mt-0.5 block text-[11px] text-[var(--text-muted)]">
                Stored as a secure hash — the number itself is never saved.
              </span>
            </label>
          )}

          {/* Email */}
          <label className="block text-sm">
            <span className="text-[var(--text-muted)]">Email</span>
            <input
              type="email"
              autoComplete="off"
              className="input-field mt-1 w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="guest@example.com"
            />
          </label>

          {/* Phone */}
          <label className="block text-sm">
            <span className="text-[var(--text-muted)]">Phone</span>
            <input
              type="tel"
              autoComplete="off"
              className="input-field mt-1 w-full"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 555 000 0000"
            />
          </label>
        </div>

        {formError ? (
          <p className="mt-3 text-sm text-red-400">{formError}</p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
            disabled={createMutation.isPending}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn-primary"
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? "Creating…" : "Create profile"}
          </button>
        </div>
      </form>
    </div>
  );
}
