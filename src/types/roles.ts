export type UserRole =
  | "admin"
  | "manager"
  | "supervisor"
  | "front_desk"
  | "housekeeper";

export const ROLE_ORDER: Record<UserRole, number> = {
  admin: 5,
  manager: 4,
  supervisor: 3,
  front_desk: 2,
  housekeeper: 1,
};

export function hasAtLeastRole(role: UserRole | null | undefined, min: UserRole): boolean {
  if (!role) return false;
  return ROLE_ORDER[role] >= ROLE_ORDER[min];
}

/** Supervisor board: assign, inspect, mark available (excludes housekeeper-only). */
export function canManageHousekeeping(role: UserRole | null | undefined): boolean {
  if (!role) return false;
  return hasAtLeastRole(role, "front_desk");
}

/** Start/complete assigned turnover tasks. */
export function canPerformHousekeepingTasks(role: UserRole | null | undefined): boolean {
  if (!role) return false;
  return role === "housekeeper" || role === "supervisor" || hasAtLeastRole(role, "manager");
}

/** Pass/fail inspection (DB RPC: supervisor, manager, admin only). */
export function canInspectHousekeeping(role: UserRole | null | undefined): boolean {
  if (!role) return false;
  return hasAtLeastRole(role, "supervisor");
}

/** Supervisor board: schedule management, staff management, reports. */
export function canManageHkStaff(role: UserRole | null | undefined): boolean {
  if (!role) return false;
  return hasAtLeastRole(role, "supervisor");
}

export function canViewHkSchedule(role: UserRole | null | undefined): boolean {
  if (!role) return false;
  return hasAtLeastRole(role, "supervisor");
}

export function canViewHkReports(role: UserRole | null | undefined): boolean {
  if (!role) return false;
  return hasAtLeastRole(role, "supervisor");
}

/** RA monitor: attendant progress, maintenance blocks, departure turnover (front desk+). */
export function canViewRaMonitor(role: UserRole | null | undefined): boolean {
  if (!role) return false;
  return hasAtLeastRole(role, "front_desk");
}

/** Front desk+ can log HK alerts. */
export function canLogHkAlerts(role: UserRole | null | undefined): boolean {
  if (!role) return false;
  return hasAtLeastRole(role, "front_desk");
}

/** Supervisor+ manages maintenance work orders. */
export function canManageHkMaintenance(role: UserRole | null | undefined): boolean {
  if (!role) return false;
  return hasAtLeastRole(role, "supervisor");
}

/** Default landing route after sign-in. */
export function homePathForRole(role: UserRole | null | undefined): string {
  if (role === "housekeeper") return "/housekeeping/my-tasks";
  return "/";
}

/** Housekeepers only need dashboard + my tasks in the sidebar. */
export function isNavItemVisibleForRole(
  role: UserRole | null | undefined,
  item: { to: string; adminOnly?: boolean; housekeepingOnly?: boolean; housekeepingMyTasksOnly?: boolean },
): boolean {
  if (!role) return false;
  if (role === "housekeeper") {
    if (item.adminOnly) return false;
    if (item.to === "/" || item.housekeepingMyTasksOnly) return true;
    return false;
  }
  return true;
}
