import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { canPerformHousekeepingTasks } from "@/types/roles";

/** Housekeeper / supervisor field workflow (start & complete assigned tasks). */
export function RequireHousekeepingTasks({ children }: { children: React.ReactNode }) {
  const { profile } = useAuth();

  if (!profile || !canPerformHousekeepingTasks(profile.role)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
