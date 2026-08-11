import { useMemo, useState, type FormEvent } from "react";
import { Download, Lock, Pencil, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { SearchField } from "@/components/ui/SearchField";
import { useAuth } from "@/contexts/AuthContext";
import {
  exportAdminUsersCsv,
  type AdminUserRow,
  type AdminUsersListFilters,
  useAdminCreateUser,
  useAdminDeleteUser,
  useAdminSetPassword,
  useAdminUpdateProfile,
  useAdminUsers,
} from "@/lib/adminUsers";
import type { UserRole } from "@/types/roles";

const ROLE_OPTIONS: Array<{ value: UserRole | "all"; label: string }> = [
  { value: "all", label: "All roles" },
  { value: "admin", label: "Admin" },
  { value: "manager", label: "Manager" },
  { value: "supervisor", label: "Supervisor" },
  { value: "front_desk", label: "Front desk" },
  { value: "housekeeper", label: "Housekeeper" },
];

const ACTIVE_OPTIONS: Array<{ value: "all" | "active" | "inactive"; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function roleBadge(role: UserRole | null): string {
  const base =
    "inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide";
  if (!role) return `${base} border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]`;
  if (role === "admin") {
    return `${base} border-red-400/70 bg-red-100 text-red-950 dark:border-red-500/45 dark:bg-red-500/12 dark:text-red-100`;
  }
  if (role === "manager") {
    return `${base} border-amber-400/70 bg-amber-100 text-amber-950 dark:border-amber-500/45 dark:bg-amber-500/12 dark:text-amber-100`;
  }
  if (role === "supervisor") {
    return `${base} border-violet-400/70 bg-violet-100 text-violet-950 dark:border-violet-500/45 dark:bg-violet-500/12 dark:text-violet-100`;
  }
  if (role === "front_desk") {
    return `${base} border-sky-400/70 bg-sky-100 text-sky-950 dark:border-sky-500/45 dark:bg-sky-500/12 dark:text-sky-100`;
  }
  return `${base} border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-h)]`;
}

function activeBadge(active: boolean | null): string {
  const base =
    "inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide";
  if (active === true) {
    return `${base} border-emerald-400/70 bg-emerald-100 text-emerald-950 dark:border-emerald-500/45 dark:bg-emerald-500/12 dark:text-emerald-100`;
  }
  if (active === false) {
    return `${base} border-red-400/70 bg-red-100 text-red-900 dark:border-red-500/45 dark:bg-red-500/12 dark:text-red-100`;
  }
  return `${base} border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]`;
}

function warningBadge(): string {
  return "inline-flex rounded-md border border-amber-400/70 bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-amber-900 dark:border-amber-500/45 dark:bg-amber-500/12 dark:text-amber-100";
}

type CreateState = {
  full_name: string;
  email: string;
  password: string;
  role: UserRole;
};

function CreateUserModal({
  busy,
  error,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: CreateState) => void;
}) {
  const [state, setState] = useState<CreateState>({
    full_name: "",
    email: "",
    password: "",
    role: "front_desk",
  });

  function patch<K extends keyof CreateState>(key: K, value: CreateState[K]) {
    setState((s) => ({ ...s, [key]: value }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit({
      ...state,
      full_name: state.full_name.trim(),
      email: state.email.trim().toLowerCase(),
    });
  }

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-create-title"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h2 id="admin-create-title" className="text-lg font-semibold text-[var(--text-h)]">
            Add user
          </h2>
          <button
            type="button"
            className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-h)]"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block text-sm font-medium text-[var(--text-h)]">
            Full name <span className="text-red-500">*</span>
            <input
              type="text"
              className="input-field mt-1.5 w-full text-sm"
              value={state.full_name}
              onChange={(e) => patch("full_name", e.target.value)}
              disabled={busy}
              required
            />
          </label>

          <label className="block text-sm font-medium text-[var(--text-h)]">
            Email <span className="text-red-500">*</span>
            <input
              type="email"
              className="input-field mt-1.5 w-full text-sm"
              value={state.email}
              onChange={(e) => patch("email", e.target.value)}
              disabled={busy}
              required
            />
          </label>

          <label className="block text-sm font-medium text-[var(--text-h)]">
            Password <span className="text-red-500">*</span>
            <input
              type="password"
              minLength={8}
              className="input-field mt-1.5 w-full text-sm"
              value={state.password}
              onChange={(e) => patch("password", e.target.value)}
              disabled={busy}
              required
            />
            <p className="mt-1 text-[12px] text-[var(--text-muted)]">Min 8 characters.</p>
          </label>

          <label className="block text-sm font-medium text-[var(--text-h)]">
            Role <span className="text-red-500">*</span>
            <FilterSelect
              className="mt-1.5 w-full"
              value={state.role}
              onChange={(e) => patch("role", e.target.value as UserRole)}
              disabled={busy}
            >
              {ROLE_OPTIONS.filter((r) => r.value !== "all").map((o) => (
                <option key={o.value} value={o.value as UserRole}>
                  {o.label}
                </option>
              ))}
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
            {busy ? "Creating…" : "Create user"}
          </button>
        </div>
      </form>
    </div>
  );
}

function EditUserModal({
  user,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  user: AdminUserRow;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (patch: { full_name: string | null; role: UserRole }) => void;
}) {
  const [name, setName] = useState(user.full_name ?? "");
  const [role, setRole] = useState<UserRole>((user.role ?? "front_desk") as UserRole);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit({ full_name: name.trim() || null, role });
  }

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--text-h)]">Edit user</h2>
          <button type="button" className="rounded-md p-1 hover:bg-[var(--surface-2)]" onClick={onClose} disabled={busy}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mt-1 text-sm text-[var(--text-muted)]">{user.email ?? user.id}</p>

        <div className="mt-4 space-y-3">
          <label className="block text-sm font-medium text-[var(--text-h)]">
            Full name
            <input
              type="text"
              className="input-field mt-1.5 w-full text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="block text-sm font-medium text-[var(--text-h)]">
            Role
            <FilterSelect className="mt-1.5 w-full" value={role} onChange={(e) => setRole(e.target.value as UserRole)} disabled={busy}>
              {ROLE_OPTIONS.filter((r) => r.value !== "all").map((o) => (
                <option key={o.value} value={o.value as UserRole}>
                  {o.label}
                </option>
              ))}
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

function PasswordModal({
  user,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  user: AdminUserRow;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit(password);
  }

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <form onSubmit={handleSubmit} className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--text-h)]">Set password</h2>
          <button type="button" className="rounded-md p-1 hover:bg-[var(--surface-2)]" onClick={onClose} disabled={busy}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mt-1 text-sm text-[var(--text-muted)]">{user.email ?? user.id}</p>

        <label className="mt-4 block text-sm font-medium text-[var(--text-h)]">
          New password <span className="text-red-500">*</span>
          <input
            type="password"
            minLength={8}
            className="input-field mt-1.5 w-full text-sm"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            required
          />
          <p className="mt-1 text-[12px] text-[var(--text-muted)]">Min 8 characters.</p>
        </label>

        {error ? (
          <p className="mt-3 rounded-lg border border-red-300/80 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-200" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary inline-flex items-center gap-2" disabled={busy}>
            <Lock className="h-4 w-4" aria-hidden />
            {busy ? "Saving…" : "Save password"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ConfirmDeleteModal({
  user,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  user: AdminUserRow;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--text-h)]">Delete user</h2>
          <button type="button" className="rounded-md p-1 hover:bg-[var(--surface-2)]" onClick={onClose} disabled={busy}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mt-3 text-sm text-[var(--text)]">
          This will permanently delete the Auth account and profile for:
        </p>
        <p className="mt-2 rounded-lg border border-red-300/70 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-200">
          {user.email ?? user.id}
        </p>

        {error ? (
          <p className="mt-3 rounded-lg border border-red-300/80 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-200" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-secondary border-red-300 text-red-700 dark:border-red-800 dark:text-red-200"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AdminUsersPage() {
  const { profile } = useAuth();
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<UserRole | "all">("all");
  const [active, setActive] = useState<"all" | "active" | "inactive">("all");

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminUserRow | null>(null);
  const [pwTarget, setPwTarget] = useState<AdminUserRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminUserRow | null>(null);

  const [createError, setCreateError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const filters: AdminUsersListFilters = useMemo(
    () => ({ query: query.trim() || undefined, role, active, page: 1, perPage: 100 }),
    [query, role, active],
  );

  const usersQuery = useAdminUsers(filters);
  const createMutation = useAdminCreateUser();
  const updateMutation = useAdminUpdateProfile();
  const pwMutation = useAdminSetPassword();
  const deleteMutation = useAdminDeleteUser();

  const rows = usersQuery.data?.rows ?? [];
  const totals = useMemo(() => {
    const total = rows.length;
    const activeCount = rows.filter((r) => r.is_active === true).length;
    const inactiveCount = rows.filter((r) => r.is_active === false).length;
    const missingProfiles = rows.filter((r) => r.profile_missing).length;
    return { total, active: activeCount, inactive: inactiveCount, missingProfiles };
  }, [rows]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">User management</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Admin only — manage logins (create, roles, activation, password resets, and delete).
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary inline-flex h-9 items-center gap-2 px-4 text-[13px]"
            onClick={() => {
              setCreateError(null);
              setCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add user
          </button>
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
            onClick={() => void usersQuery.refetch()}
            disabled={usersQuery.isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${usersQuery.isFetching ? "animate-spin" : ""}`} aria-hidden />
            Refresh
          </button>
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
            disabled={!rows.length}
            onClick={() => downloadCsv("users.csv", exportAdminUsersCsv(rows))}
          >
            <Download className="h-4 w-4" aria-hidden />
            Export CSV
          </button>
        </div>
      </div>

      {notice ? (
        <p className="mb-3 rounded-lg border border-emerald-300/80 bg-emerald-50 px-3 py-2 text-sm text-emerald-950 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-100">
          {notice}
        </p>
      ) : null}

      <section className="mb-4 flex flex-wrap gap-2 text-[12px]">
        {[
          { label: "Total", value: totals.total },
          { label: "Active", value: totals.active },
          { label: "Inactive", value: totals.inactive },
          { label: "Missing profile", value: totals.missingProfiles },
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

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="min-w-[14rem] flex-1">
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Search
          </label>
          <SearchField
            placeholder="Name or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <label className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
          Role
          <FilterSelect className="input-field mt-1 min-w-[11rem] text-sm normal-case tracking-normal" value={role} onChange={(e) => setRole(e.target.value as any)}>
            {ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </FilterSelect>
        </label>
        <label className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
          Active
          <FilterSelect className="input-field mt-1 min-w-[9rem] text-sm normal-case tracking-normal" value={active} onChange={(e) => setActive(e.target.value as any)}>
            {ACTIVE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </FilterSelect>
        </label>
      </div>

      {usersQuery.isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading users…</p>
      ) : usersQuery.isError ? (
        <p className="text-sm text-red-500">{(usersQuery.error as Error).message}</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-10 text-center">
          <p className="font-medium text-[var(--text-h)]">No users found</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Try clearing filters.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[860px] border-collapse text-left text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--surface)]">
              <tr>
                {["Name / Email", "Role", "Status", "Last login", "Created", ""].map((h) => (
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
              {rows.map((u) => {
                const isSelf = profile?.id === u.id;
                return (
                  <tr key={u.id} className="border-b border-[var(--border)]/60 last:border-0 hover:bg-[var(--surface-2)] transition-colors">
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="font-medium text-[13px] text-[var(--text-h)]">
                          {u.full_name?.trim() || <span className="italic text-[var(--text-muted)]">No name</span>}
                        </div>
                        {u.profile_missing ? <span className={warningBadge()}>Profile missing</span> : null}
                        {isSelf ? <span className="text-[11px] font-semibold text-[var(--text-muted)]">(You)</span> : null}
                      </div>
                      <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">{u.email ?? "—"}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={roleBadge(u.role)}>{(u.role ?? "—").replace("_", " ")}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={activeBadge(u.is_active)}>{u.is_active === true ? "Active" : u.is_active === false ? "Inactive" : "—"}</span>
                    </td>
                    <td className="px-3 py-2.5 text-[12.5px] text-[var(--text-muted)] tabular-nums">
                      {formatWhen(u.last_login_at ?? u.last_sign_in_at)}
                    </td>
                    <td className="px-3 py-2.5 text-[12.5px] text-[var(--text-muted)] tabular-nums">
                      {formatWhen(u.auth_created_at)}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <button
                          type="button"
                          title="Edit name / role"
                          onClick={() => {
                            setEditError(null);
                            setEditTarget(u);
                          }}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-h)] disabled:opacity-40"
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                        </button>

                        <button
                          type="button"
                          title="Set password"
                          onClick={() => {
                            setPwError(null);
                            setPwTarget(u);
                          }}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-h)] disabled:opacity-40"
                        >
                          <Lock className="h-3.5 w-3.5" aria-hidden />
                        </button>

                        <button
                          type="button"
                          title={u.is_active ? "Deactivate" : "Reactivate"}
                          disabled={isSelf || updateMutation.isPending}
                          onClick={() => {
                            setNotice(null);
                            void updateMutation.mutateAsync({
                              userId: u.id,
                              patch: { is_active: !(u.is_active === true) },
                            }).then(() => {
                              setNotice(`${u.email ?? "User"} ${u.is_active === true ? "deactivated" : "reactivated"}.`);
                            }).catch((e) => {
                              setNotice(null);
                              setEditError(e instanceof Error ? e.message : "Update failed");
                            });
                          }}
                          className={[
                            "inline-flex h-7 items-center justify-center gap-1 rounded-lg border px-2 text-[12px] font-semibold transition-colors disabled:opacity-40",
                            u.is_active === true
                              ? "border-red-300/70 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-800/50 dark:bg-red-950/20 dark:text-red-200 dark:hover:bg-red-950/40"
                              : "border-emerald-300/70 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800/50 dark:bg-emerald-950/20 dark:text-emerald-200 dark:hover:bg-emerald-950/40",
                          ].join(" ")}
                        >
                          {u.is_active === true ? "Off" : "On"}
                        </button>

                        <button
                          type="button"
                          title="Delete"
                          disabled={isSelf}
                          onClick={() => {
                            setDeleteError(null);
                            setDeleteTarget(u);
                          }}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-red-300/70 bg-red-50 text-red-700 transition-colors hover:bg-red-100 disabled:opacity-40 dark:border-red-800/50 dark:bg-red-950/20 dark:text-red-200 dark:hover:bg-red-950/40"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {createOpen ? (
        <CreateUserModal
          busy={createMutation.isPending}
          error={createError}
          onClose={() => setCreateOpen(false)}
          onSubmit={(input) => {
            setNotice(null);
            setCreateError(null);
            void createMutation
              .mutateAsync(input)
              .then(() => {
                setCreateOpen(false);
                setNotice(`Created user ${input.email}.`);
              })
              .catch((e) => setCreateError(e instanceof Error ? e.message : "Create failed"));
          }}
        />
      ) : null}

      {editTarget ? (
        <EditUserModal
          user={editTarget}
          busy={updateMutation.isPending}
          error={editError}
          onClose={() => setEditTarget(null)}
          onSubmit={(patch) => {
            setEditError(null);
            void updateMutation
              .mutateAsync({ userId: editTarget.id, patch })
              .then(() => {
                setEditTarget(null);
                setNotice(`Updated ${editTarget.email ?? "user"}.`);
              })
              .catch((e) => setEditError(e instanceof Error ? e.message : "Update failed"));
          }}
        />
      ) : null}

      {pwTarget ? (
        <PasswordModal
          user={pwTarget}
          busy={pwMutation.isPending}
          error={pwError}
          onClose={() => setPwTarget(null)}
          onSubmit={(password) => {
            setPwError(null);
            void pwMutation
              .mutateAsync({ userId: pwTarget.id, password })
              .then(() => {
                setPwTarget(null);
                setNotice(`Password updated for ${pwTarget.email ?? "user"}.`);
              })
              .catch((e) => setPwError(e instanceof Error ? e.message : "Password update failed"));
          }}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDeleteModal
          user={deleteTarget}
          busy={deleteMutation.isPending}
          error={deleteError}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => {
            setDeleteError(null);
            void deleteMutation
              .mutateAsync({ userId: deleteTarget.id })
              .then(() => {
                setDeleteTarget(null);
                setNotice(`Deleted ${deleteTarget.email ?? "user"}.`);
              })
              .catch((e) => setDeleteError(e instanceof Error ? e.message : "Delete failed"));
          }}
        />
      ) : null}
    </div>
  );
}

