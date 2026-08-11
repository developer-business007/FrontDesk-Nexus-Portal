import { useId, useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { AppLogo } from "@/components/AppLogo";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import { homePathForRole } from "@/types/roles";

export function LoginPage() {
  const { user, profile, loading, authNotice, clearAuthNotice } = useAuth();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  const emailId = useId();
  const passId = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center text-[var(--text)]">
        <p role="status">Loading…</p>
      </div>
    );
  }

  if (user && profile) {
    const dest = from === "/" || from === "/login" ? homePathForRole(profile.role) : from;
    return <Navigate to={dest} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    clearAuthNotice();
    setBusy(true);
    const { error: signErr } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (signErr) {
      setError(signErr.message);
      return;
    }
  }

  async function onForgotPassword() {
    const em = email.trim();
    if (!em) {
      setError("Enter your email above, then click Forgot password again.");
      return;
    }
    setError(null);
    const redirectTo = `${window.location.origin}/login`;
    const { error: resetErr } = await supabase.auth.resetPasswordForEmail(em, {
      redirectTo,
    });
    if (resetErr) {
      setError(resetErr.message);
      return;
    }
    setResetSent(true);
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-[var(--bg)] p-4">
      <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8">
        <div className="mb-5 flex justify-center">
          <AppLogo variant="lockup" />
        </div>
        <h1 className="page-title">Sign in</h1>
        <p className="mt-1 text-sm text-[var(--text)]">FrontDesk Nexus — Web Portal</p>

        {authNotice ? (
          <div
            className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-[var(--text-h)]"
            role="alert"
          >
            {authNotice}
          </div>
        ) : null}

        {resetSent ? (
          <p className="mt-4 text-sm text-[var(--text)]">
            If an account exists for that email, a reset link has been sent.
          </p>
        ) : null}

        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <div>
            <label htmlFor={emailId} className="text-sm font-medium text-[var(--text-h)]">
              Email
            </label>
            <input
              id={emailId}
              type="email"
              autoComplete="email"
              required
              className="input-field mt-1 w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={passId} className="text-sm font-medium text-[var(--text-h)]">
              Password
            </label>
            <input
              id={passId}
              type="password"
              autoComplete="current-password"
              required
              className="input-field mt-1 w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error ? (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy || loading}
            className="btn-primary w-full py-2.5 disabled:opacity-60"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="mt-4 text-center text-sm">
          <button
            type="button"
            className="text-[var(--accent)] underline-offset-2 hover:underline"
            onClick={() => void onForgotPassword()}
          >
            Forgot password
          </button>
        </div>
      </div>
      <p className="mt-6 text-center text-xs text-[var(--text)]">
        Protected area — automatic sign-out after 8 hours of inactivity.
      </p>
    </div>
  );
}
