import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { Profile } from "@/types/database";

type AuthState = {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  /** Shown on login page after failed profile load or inactive account */
  authNotice: string | null;
  clearAuthNotice: () => void;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as Profile | null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const lastLoadedUserIdRef = useRef<string | null>(null);

  const clearAuthNotice = useCallback(() => setAuthNotice(null), []);

  const applySession = useCallback(async (next: Session | null) => {
    if (!next?.user) {
      lastLoadedUserIdRef.current = null;
      setSession(null);
      setUser(null);
      setProfile(null);
      return;
    }

    if (lastLoadedUserIdRef.current === next.user.id) {
      setSession(next);
      setUser(next.user);
      return;
    }

    try {
      const p = await fetchProfile(next.user.id);
      if (!p) {
        lastLoadedUserIdRef.current = null;
        setProfile(null);
        setSession(null);
        setUser(null);
        setAuthNotice("No profile row found for this user. Ask an admin to create your profile.");
        await supabase.auth.signOut({ scope: "global" });
        return;
      }
      if (!p.is_active) {
        lastLoadedUserIdRef.current = null;
        setProfile(null);
        setSession(null);
        setUser(null);
        setAuthNotice("This account is inactive.");
        await supabase.auth.signOut({ scope: "global" });
        return;
      }
      setAuthNotice(null);
      lastLoadedUserIdRef.current = next.user.id;
      setSession(next);
      setUser(next.user);
      setProfile(p);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load profile.";
      lastLoadedUserIdRef.current = null;
      setProfile(null);
      setSession(null);
      setUser(null);
      setAuthNotice(msg);
      await supabase.auth.signOut({ scope: "global" });
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!user) return;
    const p = await fetchProfile(user.id);
    setProfile(p);
  }, [user]);

  const signOut = useCallback(async () => {
    setAuthNotice(null);
    lastLoadedUserIdRef.current = null;
    await supabase.auth.signOut({ scope: "global" });
    setProfile(null);
    setUser(null);
    setSession(null);
  }, []);

  useEffect(() => {
    let mounted = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      void applySession(data.session).finally(() => {
        if (mounted) setLoading(false);
      });
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === "INITIAL_SESSION") return;
      void (async () => {
        await applySession(nextSession);
        if (mounted) setLoading(false);
      })();
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [applySession]);

  const value = useMemo(
    () => ({
      user,
      session,
      profile,
      loading,
      authNotice,
      clearAuthNotice,
      signOut,
      refreshProfile,
    }),
    [user, session, profile, loading, authNotice, clearAuthNotice, signOut, refreshProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
