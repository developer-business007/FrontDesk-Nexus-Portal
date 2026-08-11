import { useMemo, useState, type FormEvent } from "react";
import { Check, Mail, Pencil, Plus, RefreshCw, Save, X } from "lucide-react";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { useAuth } from "@/contexts/AuthContext";
import {
  useAllHousekeepingStaff,
  useCreateHousekeepingStaffUser,
  useUpdateStaffProfile,
} from "@/lib/housekeepingStaff";
import { canManageHkStaff } from "@/types/roles";
import type { Profile } from "@/types/database";
import type { UserRole } from "@/types/roles";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BADGE_BASE =
  "inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide";

function roleBadge(role: string): string {
  if (role === "supervisor")
    return `${BADGE_BASE} border-violet-400/70 bg-violet-100 text-violet-950 dark:border-violet-500/50 dark:bg-violet-500/15 dark:text-violet-100`;
  return `${BADGE_BASE} border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-h)]`;
}

function activeBadge(active: boolean): string {
  return active
    ? `${BADGE_BASE} border-emerald-400/70 bg-emerald-100 text-emerald-950 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-100`
    : `${BADGE_BASE} border-red-400/70 bg-red-100 text-red-900 dark:border-red-500/50 dark:bg-red-500/15 dark:text-red-200`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Edit modal
// ---------------------------------------------------------------------------

function EditModal({
  staff,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  staff: Profile;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (patch: { full_name: string | null; role: UserRole }) => void;
}) {
  const [name, setName] = useState(staff.full_name ?? "");
  const [role, setRole] = useState<UserRole>(staff.role);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit({ full_name: name.trim() || null, role });
  }

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-modal-title"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl"
      >
        <h2 id="edit-modal-title" className="text-lg font-semibold text-[var(--text-h)]">
          Edit — {staff.email}
        </h2>

        <div className="mt-4 space-y-3">
          <label className="block text-sm font-medium text-[var(--text-h)]">
            Full name
            <input
              type="text"
              autoFocus
              className="input-field mt-1.5 w-full text-sm"
              placeholder="Jane Smith"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label className="block text-sm font-medium text-[var(--text-h)]">
            Role
            <FilterSelect
              className="mt-1.5"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
            >
              <option value="housekeeper">Housekeeper</option>
              <option value="supervisor">Supervisor</option>
            </FilterSelect>
          </label>
        </div>

        {error ? (
          <p className="mt-3 rounded-lg border border-red-300/80 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-200" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create modal
// ---------------------------------------------------------------------------

function CreateModal({
  busy,
  error,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: { full_name: string; email: string; password: string; role: "housekeeper" | "supervisor" }) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"housekeeper" | "supervisor">("housekeeper");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit({
      full_name: fullName.trim(),
      email: email.trim(),
      password,
      role,
    });
  }

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-modal-title"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl"
      >
        <h2 id="create-modal-title" className="text-lg font-semibold text-[var(--text-h)]">
          Add staff login
        </h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Creates a new login (email + password) and a staff profile.
        </p>

        <div className="mt-4 space-y-3">
          <label className="block text-sm font-medium text-[var(--text-h)]">
            Full name <span className="text-red-500">*</span>
            <input
              type="text"
              autoFocus
              className="input-field mt-1.5 w-full text-sm"
              placeholder="Jane Smith"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              disabled={busy}
              required
            />
          </label>

          <label className="block text-sm font-medium text-[var(--text-h)]">
            Email <span className="text-red-500">*</span>
            <input
              type="email"
              className="input-field mt-1.5 w-full text-sm"
              placeholder="hk.jane@hotel.local"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              required
            />
          </label>

          <label className="block text-sm font-medium text-[var(--text-h)]">
            Password <span className="text-red-500">*</span>
            <input
              type="password"
              className="input-field mt-1.5 w-full text-sm"
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              required
              minLength={8}
            />
          </label>

          <label className="block text-sm font-medium text-[var(--text-h)]">
            Role <span className="text-red-500">*</span>
            <FilterSelect
              className="mt-1.5"
              value={role}
              onChange={(e) => setRole(e.target.value as "housekeeper" | "supervisor")}
              disabled={busy}
            >
              <option value="housekeeper">Housekeeper</option>
              <option value="supervisor">Supervisor</option>
            </FilterSelect>
          </label>
        </div>

        {error ? (
          <p
            className="mt-3 rounded-lg border border-red-300/80 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-200"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary inline-flex items-center gap-2" disabled={busy}>
            <Save className="h-4 w-4" aria-hidden />
            {busy ? "Creating…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Staff row
// ---------------------------------------------------------------------------

function StaffRow({
  member,
  canEdit,
  actionBusy,
  onEdit,
  onToggleActive,
}: {
  member: Profile;
  canEdit: boolean;
  actionBusy: boolean;
  onEdit: () => void;
  onToggleActive: () => void;
}) {
  return (
    <tr className="border-b border-[var(--border)]/60 last:border-0 hover:bg-[var(--surface-2)] transition-colors">
      <td className="px-3 py-2.5">
        <div className="font-medium text-[13px] text-[var(--text-h)]">
          {member.full_name?.trim() || <span className="italic text-[var(--text-muted)]">No name</span>}
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-[var(--text-muted)]">
          <Mail className="h-3 w-3 shrink-0" aria-hidden />
          {member.email ?? "—"}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <span className={roleBadge(member.role)}>{member.role.replace("_", " ")}</span>
      </td>
      <td className="px-3 py-2.5">
        <span className={activeBadge(member.is_active)}>
          {member.is_active ? "Active" : "Inactive"}
        </span>
      </td>
      <td className="px-3 py-2.5 text-[12.5px] text-[var(--text-muted)] tabular-nums">
        {formatDate(member.last_login_at)}
      </td>
      <td className="px-3 py-2.5">
        {canEdit ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            <button
              type="button"
              title="Edit name / role"
              onClick={onEdit}
              disabled={actionBusy}
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-h)] disabled:opacity-40"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">Edit</span>
            </button>
            <button
              type="button"
              title={member.is_active ? "Deactivate account" : "Reactivate account"}
              onClick={onToggleActive}
              disabled={actionBusy}
              className={[
                "inline-flex h-7 w-7 items-center justify-center rounded-lg border transition-colors disabled:opacity-40",
                member.is_active
                  ? "border-red-300/70 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-800/50 dark:bg-red-950/20 dark:text-red-300 dark:hover:bg-red-950/40"
                  : "border-emerald-300/70 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800/50 dark:bg-emerald-950/20 dark:text-emerald-300 dark:hover:bg-emerald-950/40",
              ].join(" ")}
            >
              {member.is_active ? (
                <X className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Check className="h-3.5 w-3.5" aria-hidden />
              )}
              <span className="sr-only">{member.is_active ? "Deactivate" : "Reactivate"}</span>
            </button>
          </div>
        ) : null}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function HousekeepingStaffPage() {
  const { profile } = useAuth();
  const canEdit = profile ? canManageHkStaff(profile.role) : false;

  const staffQuery = useAllHousekeepingStaff();
  const updateMutation = useUpdateStaffProfile();
  const createMutation = useCreateHousekeepingStaffUser();

  const [editTarget, setEditTarget] = useState<Profile | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const stats = useMemo(() => {
    const rows = staffQuery.data ?? [];
    return {
      total: rows.length,
      active: rows.filter((r) => r.is_active).length,
      supervisors: rows.filter((r) => r.role === "supervisor").length,
    };
  }, [staffQuery.data]);

  async function handleToggleActive(member: Profile) {
    setActionError(null);
    setBusyId(member.id);
    try {
      await updateMutation.mutateAsync({
        id: member.id,
        patch: { is_active: !member.is_active },
      });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to update");
    } finally {
      setBusyId(null);
    }
  }

  async function handleEdit(patch: { full_name: string | null; role: UserRole }) {
    if (!editTarget) return;
    setEditError(null);
    try {
      await updateMutation.mutateAsync({ id: editTarget.id, patch });
      setEditTarget(null);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "Failed to save");
    }
  }

  async function handleCreate(input: {
    full_name: string;
    email: string;
    password: string;
    role: "housekeeper" | "supervisor";
  }) {
    setCreateError(null);
    try {
      const fullName = input.full_name.trim();
      const email = input.email.trim().toLowerCase();
      if (!fullName) throw new Error("Full name is required.");
      if (!email) throw new Error("Email is required.");
      if (!input.password || input.password.length < 8) {
        throw new Error("Password must be at least 8 characters.");
      }

      const res = await createMutation.mutateAsync({
        full_name: fullName,
        email,
        password: input.password,
        role: input.role,
      });

      if (!res.ok) throw new Error(res.error ?? "Create failed");
      setShowCreate(false);
      void staffQuery.refetch();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Failed to create staff login");
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Housekeeping staff</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            View and manage housekeeper and supervisor accounts.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit ? (
            <button
              type="button"
              className="btn-primary inline-flex h-9 items-center gap-2 px-4 text-[13px]"
              onClick={() => {
                setCreateError(null);
                setShowCreate(true);
              }}
              disabled={createMutation.isPending}
            >
              <Plus className="h-4 w-4" aria-hidden />
              Add staff
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
            onClick={() => void staffQuery.refetch()}
            disabled={staffQuery.isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${staffQuery.isFetching ? "animate-spin" : ""}`} aria-hidden />
            Refresh
          </button>
        </div>
      </div>

      {/* Stats */}
      <section className="mb-4 flex flex-wrap gap-2 text-[12px]">
        {[
          { label: "Total staff", value: stats.total },
          { label: "Active", value: stats.active },
          { label: "Supervisors", value: stats.supervisors },
        ].map(({ label, value }) => (
          <span
            key={label}
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[var(--text)]"
          >
            {label}
            <span className="font-semibold tabular-nums">{value}</span>
          </span>
        ))}
      </section>

      {actionError ? (
        <p className="mb-3 text-sm text-red-500" role="alert">{actionError}</p>
      ) : null}

      {staffQuery.isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading staff…</p>
      ) : staffQuery.isError ? (
        <p className="text-sm text-red-500">{(staffQuery.error as Error).message}</p>
      ) : (staffQuery.data ?? []).length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-10 text-center">
          <p className="font-medium text-[var(--text-h)]">No housekeeping staff yet</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Create user logins in Admin → Users or Supabase Auth, then set their role to housekeeper or supervisor.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--surface)]">
              <tr>
                {["Name / Email", "Role", "Status", "Last login", ""].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(staffQuery.data ?? []).map((member) => (
                <StaffRow
                  key={member.id}
                  member={member}
                  canEdit={canEdit}
                  actionBusy={busyId === member.id}
                  onEdit={() => {
                    setEditError(null);
                    setEditTarget(member);
                  }}
                  onToggleActive={() => void handleToggleActive(member)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editTarget ? (
        <EditModal
          staff={editTarget}
          busy={updateMutation.isPending}
          error={editError}
          onClose={() => setEditTarget(null)}
          onSubmit={handleEdit}
        />
      ) : null}

      {showCreate ? (
        <CreateModal
          busy={createMutation.isPending}
          error={createError}
          onClose={() => setShowCreate(false)}
          onSubmit={handleCreate}
        />
      ) : null}
    </div>
  );
}
