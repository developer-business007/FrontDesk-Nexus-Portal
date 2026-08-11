import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import type { UserRole } from "@/types/roles";
import { hasAtLeastRole } from "@/types/roles";

export function RequireRole({
  minRole,
  children,
}: {
  minRole: UserRole;
  children: React.ReactNode;
}) {
  const { profile } = useAuth();

  if (!profile || !hasAtLeastRole(profile.role, minRole)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
