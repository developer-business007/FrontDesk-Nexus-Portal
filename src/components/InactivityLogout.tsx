import { useCallback, useEffect, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useHotelSettings } from "@/lib/hotelSettings";

/**
 * Signs the user out after the admin-configured idle timeout.
 * Timeout is read live from hotel settings — changes apply without a page reload.
 * Set autoLogoutMinutes = 0 in Settings to disable auto-logout entirely.
 */
export function InactivityLogout({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const { autoLogoutMinutes } = useHotelSettings();
  const timerRef = useRef<number | null>(null);

  // Derived: null means disabled (never auto-logout).
  const timeoutMs = autoLogoutMinutes > 0 ? autoLogoutMinutes * 60 * 1000 : null;

  const armTimer = useCallback(() => {
    if (!user || timeoutMs === null) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void signOut();
    }, timeoutMs);
  }, [user, signOut, timeoutMs]);

  useEffect(() => {
    if (!user || timeoutMs === null) {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      return;
    }

    const events = ["mousedown", "keydown", "scroll", "touchstart", "click"] as const;
    const onActivity = () => armTimer();
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    armTimer();

    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [user, armTimer, timeoutMs]);

  return <>{children}</>;
}

/** @deprecated Use {@link InactivityLogout}. Kept for existing imports. */
export const InactivityLock = InactivityLogout;
