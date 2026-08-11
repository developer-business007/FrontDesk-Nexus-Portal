import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Ban,
  BarChart3,
  CalendarRange,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  Search,
  Settings,
  Sun,
  Users,
  Wallet,
} from "lucide-react";
import { AppLogo } from "@/components/AppLogo";
import { IdDataNavIcon } from "@/components/icons/IdDataNavIcon";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme, type ThemeChoice } from "@/contexts/ThemeContext";
import {
  canSendPortalExtensionMessages,
  portalExtensionBlockReason,
  sendPortalOpenHotelPolicy,
} from "@/lib/portalExtension";
import {
  canManageHousekeeping,
  canPerformHousekeepingTasks,
  hasAtLeastRole,
  isNavItemVisibleForRole,
} from "@/types/roles";

type NavGroup = "operations" | "admin";

type NavItem = {
  to: string;
  end?: boolean;
  icon: LucideIcon;
  label: string;
  group: NavGroup;
  adminOnly?: boolean;
  /** Housekeeping supervisor board (front desk and up; not housekeepers). */
  housekeepingOnly?: boolean;
  /** Housekeeper field view — start / complete assigned rooms. */
  housekeepingMyTasksOnly?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { to: "/", end: true, icon: LayoutDashboard, label: "Dashboard", group: "operations" },
  { to: "/reservations", icon: CalendarRange, label: "Reservations", group: "operations" },
  { to: "/guests", icon: Users, label: "Guests", group: "operations" },
  { to: "/dnr", icon: Ban, label: "DNR", group: "operations" },
  { to: "/cash", icon: Wallet, label: "Cash", group: "operations" },
  { to: "/reports", icon: BarChart3, label: "Reports", group: "operations" },
  { to: "/pdfs", icon: FileText, label: "PDFs", group: "operations" },
  {
    to: "/id-data",
    // Local SVG — some CI installs resolve lucide-react without newer barrel icons.
    icon: IdDataNavIcon as unknown as LucideIcon,
    label: "ID data",
    group: "operations",
  },
  { to: "/keys", icon: KeyRound, label: "Keys", group: "operations" },
  { to: "/dual-pms", icon: Activity, label: "Dual PMS", group: "operations" },
  {
    to: "/housekeeping",
    icon: Monitor,
    label: "Housekeeping",
    group: "operations",
    housekeepingOnly: true,
  },
  {
    to: "/housekeeping/my-tasks",
    icon: Check,
    label: "My tasks",
    group: "operations",
    housekeepingMyTasksOnly: true,
  },
  { to: "/admin/users", icon: Users, label: "Users", group: "admin", adminOnly: true },
  { to: "/admin/settings", icon: Settings, label: "Settings", group: "admin", adminOnly: true },
];

const SIDEBAR_STORAGE_KEY = "fdn:sidebar:collapsed";

/**
 * Header theme picker — small icon button with a 3-item popover
 * (Light / Dark / System). The trigger icon reflects the *resolved* theme.
 */
function ThemeMenu() {
  const { theme, resolved, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const TriggerIcon = resolved === "dark" ? Moon : Sun;
  const items: Array<{ key: ThemeChoice; label: string; icon: LucideIcon }> = [
    { key: "light", label: "Light", icon: Sun },
    { key: "dark", label: "Dark", icon: Moon },
    { key: "system", label: "System", icon: Monitor },
  ];

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Theme"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Theme · ${theme[0]!.toUpperCase()}${theme.slice(1)}`}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-h)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-border)]"
      >
        <TriggerIcon className="h-4 w-4" aria-hidden />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Choose theme"
          className="absolute right-0 top-[calc(100%+0.375rem)] z-50 min-w-[10rem] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1"
        >
          {items.map(({ key, label, icon: Icon }) => {
            const isActive = theme === key;
            return (
              <button
                key={key}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => {
                  setTheme(key);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors ${
                  isActive
                    ? "bg-[var(--sidebar-hover)] text-[var(--text-h)]"
                    : "text-[var(--text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-h)]"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
                <span className="flex-1">{label}</span>
                {isActive ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-hidden />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function SideNavLink({
  to,
  end,
  icon: Icon,
  label,
  collapsed,
}: {
  to: string;
  end?: boolean;
  icon: LucideIcon;
  label: string;
  collapsed: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
      className={({ isActive }) =>
        [
          "group relative flex items-center rounded-xl text-[0.9375rem] font-medium tracking-[-0.01em] transition-[background,color] duration-200 ease-out",
          collapsed ? "h-10 w-10 justify-center" : "gap-3 px-3 py-2.5",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-border)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--sidebar)]",
          isActive
            ? "bg-[var(--accent-muted-strong)] text-[var(--accent)]"
            : "text-[var(--text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-h)] active:scale-[0.99]",
        ].join(" ")
      }
    >
      {({ isActive }) => (
        <>
          {isActive && !collapsed ? (
            <span
              className="absolute left-0 top-1/2 h-7 w-1 -translate-y-1/2 rounded-full bg-[var(--accent)]"
              aria-hidden
            />
          ) : null}
          <Icon
            className="relative h-5 w-5 shrink-0 stroke-[1.5] transition-[color,transform] duration-200 group-hover:scale-[1.03]"
            aria-hidden
          />
          {!collapsed ? (
            <span className="relative min-w-0 truncate">{label}</span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

function HotelPolicyHeaderButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canOpen = canSendPortalExtensionMessages();
  const blockReason = portalExtensionBlockReason();

  async function handleOpen() {
    setBusy(true);
    setError(null);
    try {
      const res = await sendPortalOpenHotelPolicy();
      if (!res.ok) {
        setError('error' in res ? res.error : "Could not open hotel policy.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open hotel policy.");
    } finally {
      setBusy(false);
    }
  }

  const title = !canOpen
    ? blockReason === "missing_extension_id"
      ? "Set VITE_CHROME_EXTENSION_ID in portal .env"
      : "Open the portal in Chrome with the FrontDesk extension installed"
    : "Show hotel policy on the guest-facing display";

  return (
    <div className="relative">
      <button
        type="button"
        disabled={!canOpen || busy}
        title={title}
        onClick={() => void handleOpen()}
        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-sm font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface-3)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <FileText className="h-4 w-4 shrink-0" aria-hidden />
        {busy ? "Opening…" : "Open Hotel Policy"}
      </button>
      {error ? (
        <p className="absolute right-0 top-full z-10 mt-1 max-w-xs rounded-md border border-red-500/30 bg-red-950/90 px-2 py-1 text-xs text-red-300 shadow-lg">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function AppLayout() {
  const { profile, signOut } = useAuth();
  const isAdmin = profile ? hasAtLeastRole(profile.role, "admin") : false;
  const showHousekeeping = profile ? canManageHousekeeping(profile.role) : false;
  const showHousekeepingMyTasks = profile ? canPerformHousekeepingTasks(profile.role) : false;
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      // ignore quota/SSR
    }
  }, [collapsed]);

  const normalizedQuery = query.trim().toLowerCase();

  const visibleItems = useMemo(() => {
    return NAV_ITEMS.filter((item) => {
      if (!isNavItemVisibleForRole(profile?.role, item)) return false;
      if (item.adminOnly && !isAdmin) return false;
      if (item.housekeepingOnly && !showHousekeeping) return false;
      if (item.housekeepingMyTasksOnly && !showHousekeepingMyTasks) return false;
      if (!normalizedQuery) return true;
      return item.label.toLowerCase().includes(normalizedQuery);
    });
  }, [profile?.role, isAdmin, showHousekeeping, showHousekeepingMyTasks, normalizedQuery]);

  const hasOperations = visibleItems.some((i) => i.group === "operations");
  const hasAdmin = visibleItems.some((i) => i.group === "admin");

  const focusSearch = useCallback(() => {
    setCollapsed(false);
    requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    });
  }, []);

  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // `e.key` can be undefined for IME composition / dead keys / some Windows shortcuts.
      if (!e.key) return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const typing =
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        target?.isContentEditable;

      const key = e.key.toLowerCase();

      if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        focusSearch();
        return;
      }
      if (key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        focusSearch();
        return;
      }
      if (key === "b" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusSearch, toggleCollapsed]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || !normalizedQuery) return;
    const first = visibleItems[0];
    if (first) {
      e.preventDefault();
      navigate(first.to);
      setQuery("");
    }
  };

  const sidebarWidth = collapsed ? "md:w-[3.75rem]" : "md:w-[17.5rem]";

  return (
    <div className="flex min-h-svh w-full max-w-none flex-1 text-left">
      <aside
        className={`relative hidden shrink-0 flex-col border-r border-[var(--border)] bg-[var(--sidebar)] md:sticky md:top-0 md:flex md:min-h-svh md:max-h-svh transition-[width] duration-200 ease-out ${sidebarWidth}`}
        aria-label="Primary"
        data-collapsed={collapsed ? "true" : "false"}
      >
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)"}
          className={[
            "absolute -right-3 top-6 z-20 hidden items-center justify-center border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] transition-[background,color] duration-150 hover:bg-[var(--surface-2)] hover:text-[var(--text-h)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-border)] md:flex",
            collapsed
              ? // Collapsed: half-pill tab — only the right half pokes out so it
                // doesn't bleed into the narrow brand area.
                "h-7 w-3 rounded-l-none rounded-r-full border-l-0"
              : // Expanded: full circle straddling the sidebar's right edge.
                "h-6 w-6 rounded-full",
          ].join(" ")}
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3 stroke-[2.25]" aria-hidden />
          ) : (
            <ChevronLeft className="h-3.5 w-3.5 stroke-[2.25]" aria-hidden />
          )}
        </button>

        {collapsed ? (
          <div className="flex flex-col items-center gap-2 border-b border-[var(--border)] px-2 pb-3 pt-4">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl"
              title="FrontDesk Nexus"
            >
              <AppLogo />
            </div>
            <button
              type="button"
              onClick={focusSearch}
              title="Search (Ctrl+K)"
              aria-label="Search"
              className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--text-muted)] transition-[background,color] duration-150 hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-h)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-border)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--sidebar)]"
            >
              <Search className="h-4 w-4 stroke-[2]" aria-hidden />
            </button>
          </div>
        ) : (
          <div className="border-b border-[var(--border)] px-4 pb-4 pt-5">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl">
                <AppLogo />
              </div>
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="truncate text-[0.9375rem] font-semibold leading-tight tracking-[-0.02em] text-[var(--text-h)]">
                  FrontDesk Nexus
                </div>
                <div className="mt-0.5 text-[0.8125rem] leading-snug text-[var(--text-muted)]">
                  Front desk portal
                </div>
              </div>
            </div>

            <label className="mt-4 block">
              <span className="sr-only">Filter navigation</span>
              <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 transition-[border-color] duration-200 focus-within:border-[var(--accent-border)]">
                <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" strokeWidth={2} aria-hidden />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onSearchKeyDown}
                  placeholder="Find a page…"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-[var(--text-h)] placeholder:text-[var(--text-muted)] outline-none"
                />
                <span className="fdn-kbd shrink-0" title="Press / to focus">
                  /
                </span>
              </div>
            </label>
          </div>
        )}

        <nav
          className={`flex flex-1 flex-col overflow-y-auto py-4 ${
            collapsed ? "items-center gap-1 px-2" : "gap-1 px-3"
          }`}
          aria-label="Main"
        >
          {hasOperations ? (
            <>
              {!collapsed ? (
                <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">
                  Operations
                </p>
              ) : null}
              <div
                className={`flex w-full flex-col ${collapsed ? "items-center gap-1" : "gap-0.5"}`}
              >
                {visibleItems
                  .filter((i) => i.group === "operations")
                  .map((item) => (
                    <SideNavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      icon={item.icon}
                      label={item.label}
                      collapsed={collapsed}
                    />
                  ))}
              </div>
            </>
          ) : null}

          {hasAdmin ? (
            <>
              <div
                className={`my-3 h-px bg-[var(--border)]/80 ${
                  collapsed ? "w-8" : "w-full"
                }`}
                role="presentation"
              />
              {!collapsed ? (
                <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">
                  Admin
                </p>
              ) : null}
              <div
                className={`flex w-full flex-col ${collapsed ? "items-center gap-1" : "gap-0.5"}`}
              >
                {visibleItems
                  .filter((i) => i.group === "admin")
                  .map((item) => (
                    <SideNavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      icon={item.icon}
                      label={item.label}
                      collapsed={collapsed}
                    />
                  ))}
              </div>
            </>
          ) : null}

          {!collapsed && normalizedQuery && visibleItems.length === 0 ? (
            <p className="px-3 py-6 text-center text-[0.8125rem] text-[var(--text-muted)]">
              No pages match “{query.trim()}”.
            </p>
          ) : null}
        </nav>

        <div
          className={`mt-auto border-t border-[var(--border)] ${
            collapsed ? "flex justify-center px-2 py-3" : "p-3"
          }`}
        >
          {collapsed ? (
            <button
              type="button"
              onClick={() => void signOut()}
              title="Sign out"
              aria-label="Sign out"
              className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] transition-[background,color] duration-150 hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-h)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-border)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--sidebar)]"
            >
              <LogOut className="h-5 w-5 stroke-[1.5]" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void signOut()}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[0.9375rem] font-medium text-[var(--text)] transition-[background,color,transform] duration-200 ease-out hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-h)] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-border)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--sidebar)]"
            >
              <LogOut className="h-5 w-5 shrink-0 stroke-[1.5] text-[var(--text-muted)]" aria-hidden />
              Sign out
            </button>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--header)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5 md:hidden">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg">
              <AppLogo />
            </div>
            <span className="truncate text-sm font-semibold text-[var(--text-h)]">FrontDesk Nexus</span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-sm">
            <HotelPolicyHeaderButton />
            {profile ? (
              <>
                <span className="hidden max-w-[200px] truncate text-[var(--text-h)] sm:inline">
                  {profile.full_name?.trim() || profile.email || "Signed in"}
                </span>
                <span className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-xs font-medium capitalize text-[var(--text-h)]">
                  {profile.role.replace("_", " ")}
                </span>
              </>
            ) : null}
            <ThemeMenu />
          </div>
        </header>

        <main className="flex-1 p-4 md:p-6">
          <Outlet />
        </main>

        <nav
          className="flex gap-1 border-t border-[var(--border)] bg-[var(--header)] p-2 md:hidden"
          aria-label="Mobile"
        >
          <NavLink
            to="/"
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 rounded-xl py-2 text-[10px] font-semibold transition-colors ${
                isActive ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
              }`
            }
            end
          >
            <LayoutDashboard className="h-5 w-5 stroke-[1.5]" />
            Home
          </NavLink>
          <NavLink
            to="/reservations"
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 rounded-xl py-2 text-[10px] font-semibold transition-colors ${
                isActive ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
              }`
            }
          >
            <CalendarRange className="h-5 w-5 stroke-[1.5]" />
            Res.
          </NavLink>
          <NavLink
            to="/dnr"
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 rounded-xl py-2 text-[10px] font-semibold transition-colors ${
                isActive ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
              }`
            }
          >
            <Ban className="h-5 w-5 stroke-[1.5]" />
            DNR
          </NavLink>
          <NavLink
            to="/pdfs"
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 rounded-xl py-2 text-[10px] font-semibold transition-colors ${
                isActive ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
              }`
            }
          >
            <FileText className="h-5 w-5 stroke-[1.5]" />
            PDFs
          </NavLink>
          <NavLink
            to="/id-data"
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 rounded-xl py-2 text-[10px] font-semibold transition-colors ${
                isActive ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
              }`
            }
          >
            <IdDataNavIcon className="h-5 w-5 stroke-[1.5]" />
            ID
          </NavLink>
          <NavLink
            to="/keys"
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 rounded-xl py-2 text-[10px] font-semibold transition-colors ${
                isActive ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
              }`
            }
          >
            <KeyRound className="h-5 w-5 stroke-[1.5]" />
            Keys
          </NavLink>
        </nav>
      </div>
    </div>
  );
}
