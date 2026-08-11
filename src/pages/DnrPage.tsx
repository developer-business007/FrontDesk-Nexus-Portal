import { useId, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { insertAuditRow } from "@/lib/audit";
import { lookupGuestsForDnr, type DnrGuestLookupHit } from "@/lib/dnrGuestLookup";
import { devUserEmail } from "@/lib/devIdentity";
import { supabase } from "@/lib/supabase";
import { DateField } from "@/components/ui/DateField";
import { useAuth } from "@/contexts/AuthContext";
import { hasAtLeastRole } from "@/types/roles";
import type { DnrEntry } from "@/types/database";

function formatDob(d: string | null) {
  if (!d) return "—";
  return d;
}

function normalizeIdNumber(n: string): string {
  return n.replace(/\s+/g, "").toUpperCase();
}

export function DnrPage() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const canWriteDnr = profile ? hasAtLeastRole(profile.role, "manager") : false;

  const searchId = useId();
  const [q, setQ] = useState("");

  const guestId = useId();
  const idNumId = useId();
  const dobId = useId();
  const reasonId = useId();
  const [newGuest, setNewGuest] = useState("");
  const [newIdNumber, setNewIdNumber] = useState("");
  const [newDob, setNewDob] = useState("");
  const [newReason, setNewReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const [removeId, setRemoveId] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState("");
  const [removeError, setRemoveError] = useState<string | null>(null);

  const guestLookupId = useId();
  const [guestLookupQ, setGuestLookupQ] = useState("");
  const [guestLookupBusy, setGuestLookupBusy] = useState(false);
  const [guestLookupError, setGuestLookupError] = useState<string | null>(null);
  const [guestLookupHits, setGuestLookupHits] = useState<DnrGuestLookupHit[]>([]);

  const listQuery = useQuery({
    queryKey: ["dnr_entries"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("dnr_entries")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data as DnrEntry[];
    },
  });

  const filtered = useMemo(() => {
    const rows = listQuery.data ?? [];
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter(
      (r) =>
        r.id_number.toLowerCase().includes(s) ||
        r.guest_name.toLowerCase().includes(s) ||
        (r.reason?.toLowerCase().includes(s) ?? false),
    );
  }, [listQuery.data, q]);

  const addMutation = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in.");
      const uid = profile.id;
      const gn = newGuest.trim();
      const idn = normalizeIdNumber(newIdNumber);
      if (!gn) throw new Error("Guest name required");
      if (!idn) throw new Error("ID number required");
      if (!newReason.trim()) throw new Error("Reason required");

      const dob = newDob.trim() ? newDob.trim() : null;

      const { data: existing } = await supabase
        .from("dnr_entries")
        .select("id")
        .eq("status", "active")
        .eq("id_number", idn);
      if (existing && existing.length > 0) {
        throw new Error("This ID number is already on the active DNR list.");
      }

      const { data: inserted, error } = await supabase
        .from("dnr_entries")
        .insert({
          guest_name: gn,
          id_number: idn,
          date_of_birth: dob,
          reason: newReason.trim(),
          status: "active",
          flagged_by: uid,
        })
        .select("id")
        .single();

      if (error) throw new Error(error.message);

      const { error: auditErr } = await insertAuditRow(supabase, {
        action_type: "dnr_added",
        username: profile.email ?? devUserEmail(),
        user_role: profile.role,
        description: `DNR added for id_number ${idn}`,
        old_value: null,
        new_value: { dnr_entry_id: inserted.id, id_number: idn, guest_name: gn },
        user_id: uid,
      });
      if (auditErr) throw auditErr;

      return idn;
    },
    onSuccess: async () => {
      setNewGuest("");
      setNewIdNumber("");
      setNewDob("");
      setNewReason("");
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ["dnr_entries"] });
    },
    onError: (e: Error) => {
      setFormError(e.message);
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (entry: DnrEntry) => {
      if (!profile) throw new Error("Not signed in.");
      const uid = profile.id;
      const rr = removeReason.trim();
      if (!rr) throw new Error("Removal reason required");

      const { error } = await supabase
        .from("dnr_entries")
        .update({
          status: "removed",
          removal_reason: rr,
          removed_at: new Date().toISOString(),
          removed_by: uid,
        })
        .eq("id", entry.id)
        .eq("status", "active");

      if (error) throw new Error(error.message);

      const { error: auditErr } = await insertAuditRow(supabase, {
        action_type: "dnr_removed",
        username: profile.email ?? devUserEmail(),
        user_role: profile.role,
        description: `DNR removed for id_number ${entry.id_number}`,
        old_value: { status: "active", reason: entry.reason },
        new_value: { status: "removed", removal_reason: rr },
        user_id: uid,
      });
      if (auditErr) throw auditErr;

      return entry.id;
    },
    onSuccess: async () => {
      setRemoveId(null);
      setRemoveReason("");
      setRemoveError(null);
      await queryClient.invalidateQueries({ queryKey: ["dnr_entries"] });
    },
    onError: (e: Error) => {
      setRemoveError(e.message);
    },
  });

  function onAdd(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    addMutation.mutate();
  }

  async function onGuestLookup(e: FormEvent) {
    e.preventDefault();
    const q = guestLookupQ.trim();
    if (q.length < 3) {
      setGuestLookupError("Enter at least 3 characters (name, ID number, phone, or confirmation).");
      setGuestLookupHits([]);
      return;
    }
    setGuestLookupBusy(true);
    setGuestLookupError(null);
    try {
      const hits = await lookupGuestsForDnr(q);
      setGuestLookupHits(hits);
      if (hits.length === 0) {
        setGuestLookupError("No guests found — try ID number, phone, confirmation, or guest name.");
      }
    } catch (err) {
      setGuestLookupHits([]);
      setGuestLookupError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setGuestLookupBusy(false);
    }
  }

  function applyGuestLookupHit(hit: DnrGuestLookupHit) {
    setNewGuest(hit.guestName);
    if (hit.idNumber) setNewIdNumber(hit.idNumber);
    if (hit.dateOfBirth) setNewDob(hit.dateOfBirth);
    setFormError(null);
    setGuestLookupError(null);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8 text-left">
      <header>
        <h1 className="page-title">Do Not Rent (DNR)</h1>
        <p className="mt-1 text-sm text-[var(--text)]">
          Entries are keyed by guest identity (name, ID number, DOB). Soft-remove only — no hard
          delete.
        </p>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label htmlFor={searchId} className="sr-only">
          Search
        </label>
        <input
          id={searchId}
          type="search"
          placeholder="Search ID number, guest name, or reason"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[var(--text-h)] outline-none focus:ring-2 focus:ring-[var(--accent)] sm:max-w-md"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {canWriteDnr ? (
        <section className="rounded-xl border border-[var(--border)] p-6">
          <h2 className="text-base font-semibold text-[var(--text-h)]">Find guest (ID Data / PMS)</h2>
          <p className="mt-1 text-sm text-[var(--text)]">
            Search by guest name, ID number, phone, or confirmation — then select a row to fill the
            form below.
          </p>
          <form className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={onGuestLookup}>
            <div className="flex-1">
              <label htmlFor={guestLookupId} className="sr-only">
                Find guest
              </label>
              <input
                id={guestLookupId}
                type="search"
                placeholder="Name, ID #, phone, or confirmation"
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[var(--text-h)]"
                value={guestLookupQ}
                onChange={(e) => setGuestLookupQ(e.target.value)}
              />
            </div>
            <button
              type="submit"
              disabled={guestLookupBusy}
              className="rounded-lg border border-[var(--border)] px-4 py-2 font-medium text-[var(--text-h)] disabled:opacity-60"
            >
              {guestLookupBusy ? "Searching…" : "Find guest"}
            </button>
          </form>
          {guestLookupError ? (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">
              {guestLookupError}
            </p>
          ) : null}
          {guestLookupHits.length > 0 ? (
            <ul className="mt-3 divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
              {guestLookupHits.map((hit, i) => (
                <li key={`${hit.guestName}-${hit.idNumber ?? i}`}>
                  <button
                    type="button"
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-[var(--social-bg)]"
                    onClick={() => applyGuestLookupHit(hit)}
                  >
                    <span className="font-medium text-[var(--text-h)]">{hit.guestName}</span>
                    <span className="text-[var(--text)]">
                      {hit.idNumber ? `ID ${hit.idNumber}` : "No ID on file"}
                      {hit.confirmationNumber ? ` · Conf ${hit.confirmationNumber}` : ""}
                      {hit.scannedAt
                        ? ` · Scanned ${new Date(hit.scannedAt).toLocaleDateString()}`
                        : hit.source === "reservation"
                          ? " · PMS reservation"
                          : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <h2 className="mt-8 text-base font-semibold text-[var(--text-h)]">Add DNR</h2>
          <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={onAdd}>
            <div className="sm:col-span-1">
              <label htmlFor={guestId} className="text-sm font-medium text-[var(--text-h)]">
                Guest name
              </label>
              <input
                id={guestId}
                required
                className="mt-1 w-full rounded-lg border border-[var(--border)] px-3 py-2 text-[var(--text-h)]"
                value={newGuest}
                onChange={(e) => setNewGuest(e.target.value)}
              />
            </div>
            <div className="sm:col-span-1">
              <label htmlFor={idNumId} className="text-sm font-medium text-[var(--text-h)]">
                ID number
              </label>
              <input
                id={idNumId}
                required
                className="mt-1 w-full rounded-lg border border-[var(--border)] px-3 py-2 text-[var(--text-h)]"
                value={newIdNumber}
                onChange={(e) => setNewIdNumber(e.target.value)}
              />
            </div>
            <div className="sm:col-span-1">
              <label htmlFor={dobId} className="text-sm font-medium text-[var(--text-h)]">
                Date of birth (optional)
              </label>
              <div className="mt-1">
                <DateField
                  id={dobId}
                  className="w-full"
                  value={newDob}
                  onChange={setNewDob}
                  aria-label="Date of birth"
                  placeholder="Optional"
                />
              </div>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={reasonId} className="text-sm font-medium text-[var(--text-h)]">
                Reason
              </label>
              <textarea
                id={reasonId}
                required
                rows={2}
                className="mt-1 w-full rounded-lg border border-[var(--border)] px-3 py-2 text-[var(--text-h)]"
                value={newReason}
                onChange={(e) => setNewReason(e.target.value)}
              />
            </div>
            {formError ? (
              <p className="sm:col-span-2 text-sm text-red-600 dark:text-red-400" role="alert">
                {formError}
              </p>
            ) : null}
            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={addMutation.isPending}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 font-medium text-white disabled:opacity-60"
              >
                {addMutation.isPending ? "Saving…" : "Add DNR"}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <p className="rounded-lg border border-dashed border-[var(--border)] p-4 text-sm text-[var(--text)]">
          Only managers and admins can add or remove DNR entries. You can still search the list.
        </p>
      )}

      <section>
        <h2 className="text-base font-semibold text-[var(--text-h)]">Entries</h2>
        {listQuery.isLoading ? (
          <p className="mt-2 text-[var(--text)]">Loading…</p>
        ) : listQuery.isError ? (
          <p className="mt-2 text-red-600 dark:text-red-400">
            {(listQuery.error as Error).message}
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-[var(--social-bg)] text-[var(--text-h)]">
                <tr>
                  <th className="px-3 py-2 font-medium">ID number</th>
                  <th className="px-3 py-2 font-medium">Guest</th>
                  <th className="px-3 py-2 font-medium">DOB</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.id} className="border-t border-[var(--border)]">
                    <td className="px-3 py-2 font-mono text-[var(--text-h)]">{row.id_number}</td>
                    <td className="px-3 py-2 text-[var(--text)]">{row.guest_name}</td>
                    <td className="px-3 py-2 text-[var(--text)]">{formatDob(row.date_of_birth)}</td>
                    <td className="px-3 py-2 text-[var(--text)]">{row.reason}</td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          row.status === "active"
                            ? "rounded bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-700 dark:text-red-300"
                            : "rounded bg-[var(--code-bg)] px-2 py-0.5 text-xs text-[var(--text)]"
                        }
                      >
                        {row.status}
                      </span>
                      {row.status === "removed" && row.removal_reason ? (
                        <div className="mt-1 text-xs text-[var(--text)]">
                          Removed: {row.removal_reason}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      {row.status === "active" && canWriteDnr ? (
                        <button
                          type="button"
                          className="text-sm text-[var(--accent)] underline-offset-2 hover:underline"
                          onClick={() => {
                            setRemoveId(row.id);
                            setRemoveReason("");
                            setRemoveError(null);
                          }}
                        >
                          Remove
                        </button>
                      ) : (
                        <span className="text-[var(--text)]">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {removeId ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--bg)] p-6">
            <h3 className="text-base font-semibold text-[var(--text-h)]">Remove DNR</h3>
            <p className="mt-2 text-sm text-[var(--text)]">
              This sets status to <code className="text-xs">removed</code> and writes an audit row.
            </p>
            <label className="mt-4 block text-sm font-medium text-[var(--text-h)]" htmlFor="rm-reason">
              Reason for removal
            </label>
            <textarea
              id="rm-reason"
              rows={3}
              className="mt-1 w-full rounded-lg border border-[var(--border)] px-3 py-2 text-[var(--text-h)]"
              value={removeReason}
              onChange={(e) => setRemoveReason(e.target.value)}
            />
            {removeError ? (
              <p className="mt-2 text-sm text-red-600 dark:text-red-400">{removeError}</p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-[var(--border)] px-4 py-2 text-[var(--text-h)]"
                onClick={() => setRemoveId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={removeMutation.isPending}
                className="rounded-lg bg-red-600 px-4 py-2 font-medium text-white disabled:opacity-60"
                onClick={() => {
                  const row = listQuery.data?.find((r) => r.id === removeId);
                  if (row) removeMutation.mutate(row);
                }}
              >
                {removeMutation.isPending ? "Removing…" : "Confirm remove"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
