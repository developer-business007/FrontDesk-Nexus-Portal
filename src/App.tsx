import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { canManageHousekeeping } from "@/types/roles";
import { AppLayout } from "@/components/AppLayout";
import { HousekeepingSubNav } from "@/components/housekeeping/HousekeepingSubNav";
import { InactivityLogout } from "@/components/InactivityLogout";
import { RequireAuth } from "@/components/RequireAuth";
import { RequireRole } from "@/components/RequireRole";
import { RequireHousekeepingTasks } from "@/components/RequireHousekeepingTasks";
import { DashboardPage } from "@/pages/DashboardPage";
import { DnrPage } from "@/pages/DnrPage";
import { GuestDetailPage } from "@/pages/GuestDetailPage";
import { GuestsPage } from "@/pages/GuestsPage";
import { GuestProfilePage } from "@/pages/GuestProfilePage";
import { LoginPage } from "@/pages/LoginPage";
import { CashComingSoonPage, ReportsComingSoonPage } from "@/pages/ComingSoonPage";
import { ReservationsPage } from "@/pages/ReservationsPage";
import { KeyHistoryPage } from "@/pages/KeyHistoryPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { IdDataPage } from "@/pages/IdDataPage";
import { SignatureLogPage } from "@/pages/SignatureLogPage";
import { HousekeepingPage } from "@/pages/HousekeepingPage";
import { HousekeepingMyTasksPage } from "@/pages/HousekeepingMyTasksPage";
import { HousekeepingStaffPage } from "@/pages/HousekeepingStaffPage";
import { HousekeepingSchedulePage } from "@/pages/HousekeepingSchedulePage";
import { HousekeepingReportsPage } from "@/pages/HousekeepingReportsPage";
import { HousekeepingRaMonitorPage } from "@/pages/HousekeepingRaMonitorPage";
import { HousekeepingAssignedRoomsPage } from "@/pages/HousekeepingAssignedRoomsPage";
import { HousekeepingBulkEditPage } from "@/pages/HousekeepingBulkEditPage";
import { HousekeepingAlertsPage } from "@/pages/HousekeepingAlertsPage";
import { HousekeepingMaintenancePage } from "@/pages/HousekeepingMaintenancePage";
import { HousekeepingInspectionLogPage } from "@/pages/HousekeepingInspectionLogPage";
import { HousekeepingTaskSearchPage } from "@/pages/HousekeepingTaskSearchPage";
import { AdminUsersPage } from "@/pages/AdminUsersPage";
import { PmsBoardPage } from "@/pages/PmsBoardPage";

/**
 * Layout wrapper for all housekeeping manager routes (/housekeeping, /housekeeping/schedule, etc.)
 * Redirects housekeepers to their task view and blocks non-managers.
 */
function HousekeepingManagerLayout() {
  const { profile } = useAuth();

  if (profile?.role === "housekeeper") {
    return <Navigate to="/housekeeping/my-tasks" replace />;
  }
  if (!profile || !canManageHousekeeping(profile.role)) {
    return <Navigate to="/" replace />;
  }

  return (
    <div>
      <HousekeepingSubNav role={profile.role} />
      <Outlet />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <RequireAuth>
            <InactivityLogout>
              <AppLayout />
            </InactivityLogout>
          </RequireAuth>
        }
      >
        <Route path="/" element={<DashboardPage />} />
        <Route path="/guest/:confirmationNumber" element={<GuestDetailPage />} />
        <Route path="/guests" element={<GuestsPage />} />
        <Route path="/guests/:profileId" element={<GuestProfilePage />} />
        <Route path="/dnr" element={<DnrPage />} />
        <Route path="/reservations" element={<ReservationsPage />} />
        <Route path="/cash" element={<CashComingSoonPage />} />
        <Route path="/reports" element={<ReportsComingSoonPage />} />
        <Route path="/pdfs" element={<SignatureLogPage />} />
        <Route path="/id-data" element={<IdDataPage />} />
        <Route path="/keys" element={<KeyHistoryPage />} />
        <Route path="/dual-pms" element={<PmsBoardPage />} />

        {/* Housekeeping manager section — all tabs share the layout with sub-nav */}
        <Route path="/housekeeping" element={<HousekeepingManagerLayout />}>
          <Route index element={<HousekeepingPage />} />
          <Route path="monitor" element={<HousekeepingRaMonitorPage />} />
          <Route path="assigned-rooms" element={<HousekeepingAssignedRoomsPage />} />
          <Route path="bulk-edit" element={<HousekeepingBulkEditPage />} />
          <Route path="alerts" element={<HousekeepingAlertsPage />} />
          <Route path="maintenance" element={<HousekeepingMaintenancePage />} />
          <Route path="schedule" element={<HousekeepingSchedulePage />} />
          <Route path="staff" element={<HousekeepingStaffPage />} />
          <Route path="reports" element={<HousekeepingReportsPage />} />
          <Route path="inspection-log" element={<HousekeepingInspectionLogPage />} />
          <Route path="tasks" element={<HousekeepingTaskSearchPage />} />
        </Route>

        {/* Housekeeper field view — start / complete assigned rooms */}
        <Route
          path="/housekeeping/my-tasks"
          element={
            <RequireHousekeepingTasks>
              <HousekeepingMyTasksPage />
            </RequireHousekeepingTasks>
          }
        />
        
        <Route
          path="/admin/users"
          element={
            <RequireRole minRole="admin">
              <AdminUsersPage />
            </RequireRole>
          }
        />
        <Route
          path="/admin/settings"
          element={
            <RequireRole minRole="admin">
              <SettingsPage />
            </RequireRole>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
