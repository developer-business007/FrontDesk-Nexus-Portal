import { NavLink } from "react-router-dom";
import { CalendarRange, ClipboardList, LayoutDashboard, BarChart3, Bell, Monitor, Table2, Users, Wrench, ClipboardCheck, ListFilter } from "lucide-react";
import type { UserRole } from "@/types/roles";
import { canLogHkAlerts, canManageHkMaintenance, canManageHkStaff, canViewHkReports, canViewHkSchedule, canViewRaMonitor } from "@/types/roles";

type Tab = {
  to: string;
  end?: boolean;
  icon: React.ElementType;
  label: string;
};

function tabClass(isActive: boolean) {
  return [
    "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors whitespace-nowrap",
    isActive
      ? "border-[var(--accent-border)] bg-[var(--accent-muted-strong)] text-[var(--accent)]"
      : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-2)] hover:text-[var(--text-h)]",
  ].join(" ");
}

export function HousekeepingSubNav({ role }: { role: UserRole }) {
  const tabs: Tab[] = [
    { to: "/housekeeping", end: true, icon: LayoutDashboard, label: "Board" },
  ];

  if (canViewRaMonitor(role)) {
    tabs.push({ to: "/housekeeping/monitor", icon: Monitor, label: "RA monitor" });
  }

  if (canLogHkAlerts(role)) {
    tabs.push({ to: "/housekeeping/alerts", icon: Bell, label: "Alerts" });
  }

  if (canManageHkMaintenance(role)) {
    tabs.push({ to: "/housekeeping/maintenance", icon: Wrench, label: "Maintenance" });
  }

  if (canViewHkSchedule(role)) {
    tabs.push({ to: "/housekeeping/assigned-rooms", icon: ClipboardList, label: "Assigned rooms" });
    tabs.push({ to: "/housekeeping/bulk-edit", icon: Table2, label: "Bulk edit" });
    tabs.push({ to: "/housekeeping/schedule", icon: CalendarRange, label: "Schedule" });
  }
  if (canManageHkStaff(role)) {
    tabs.push({ to: "/housekeeping/staff", icon: Users, label: "Staff" });
  }
  if (canViewHkReports(role)) {
    tabs.push({ to: "/housekeeping/reports", icon: BarChart3, label: "Reports" });
    tabs.push({ to: "/housekeeping/inspection-log", icon: ClipboardCheck, label: "Inspection log" });
    tabs.push({ to: "/housekeeping/tasks", icon: ListFilter, label: "All tasks" });
  }

  return (
    <nav
      aria-label="Housekeeping sections"
      className="mb-5 flex flex-wrap gap-1.5 border-b border-[var(--border)] pb-4"
    >
      {tabs.map(({ to, end, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => tabClass(isActive)}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
