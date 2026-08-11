import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Save, X } from "lucide-react";
import {
  fetchSynxisIntegrationStatus,
  formatSynxisSessionSource,
  saveSynxisCredentials,
  saveSynxisSessionCookie,
  testSynxisLogin,
  type SynxisIntegrationStatus,
} from "@/lib/synxisIntegration";

type Props = {
  isAdmin: boolean;
};

type TestLoginFeedback =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "success"; message: string; at: string }
  | { status: "error"; message: string; at: string };

const TEST_RESULT_STORAGE_KEY = "synxis-login-test-result";
const SESSION_STATUS_POLL_MS = 30_000;

function sessionStatusLabel(status: SynxisIntegrationStatus | null): {
  text: string;
  className: string;
} {
  if (!status?.sessionSaved) {
    return {
      text: "Not saved",
      className: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
    };
  }
  if (status.sessionValid === true) {
    return {
      text: "Valid",
      className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    };
  }
  if (status.sessionValid === false) {
    return {
      text: "Expired",
      className: "border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-200",
    };
  }
  return {
    text: "Unknown",
    className: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]",
  };
}

function readStoredTestFeedback(): TestLoginFeedback {
  try {
    const raw = sessionStorage.getItem(TEST_RESULT_STORAGE_KEY);
    if (!raw) return { status: "idle" };
    const parsed = JSON.parse(raw) as TestLoginFeedback;
    if (
      parsed.status === "success" ||
      parsed.status === "error" ||
      parsed.status === "testing"
    ) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return { status: "idle" };
}

function storeTestFeedback(feedback: TestLoginFeedback): void {
  try {
    if (feedback.status === "idle") {
      sessionStorage.removeItem(TEST_RESULT_STORAGE_KEY);
    } else {
      sessionStorage.setItem(TEST_RESULT_STORAGE_KEY, JSON.stringify(feedback));
    }
  } catch {
    // ignore
  }
}

export function SynxisIntegrationSection({ isAdmin }: Props) {
  const [status, setStatus] = useState<SynxisIntegrationStatus | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [gmailAddress, setGmailAddress] = useState("");
  const [gmailAppPassword, setGmailAppPassword] = useState("");
  const [propertyId, setPropertyId] = useState("93302");
  const [chainId, setChainId] = useState("5136");
  const [cookieHeader, setCookieHeader] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [testFeedback, setTestFeedback] = useState<TestLoginFeedback>(() => readStoredTestFeedback());
  const testFeedbackRef = useRef<HTMLDivElement | null>(null);

  const showTestFeedback = useCallback((next: TestLoginFeedback) => {
    setTestFeedback(next);
    storeTestFeedback(next);
    requestAnimationFrame(() => {
      testFeedbackRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, []);

  const loadStatus = useCallback(async (options?: { silent?: boolean }) => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    if (!options?.silent) {
      setLoading(true);
      setError(null);
    }
    const { data, error: loadErr } = await fetchSynxisIntegrationStatus();
    if (loadErr) {
      setError(loadErr);
      setStatus(null);
    } else {
      setStatus(data);
      if (data?.username) setUsername(data.username);
      if (data?.gmailAddress) setGmailAddress(data.gmailAddress);
      if (data?.propertyId) setPropertyId(data.propertyId);
      if (data?.chainId) setChainId(data.chainId);
    }
    setPassword("");
    setGmailAppPassword("");
    if (!options?.silent) setLoading(false);
  }, [isAdmin]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!isAdmin) return;
    const id = window.setInterval(() => {
      void loadStatus({ silent: true });
    }, SESSION_STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [isAdmin, loadStatus]);

  const hasNonSecretChanges =
    status?.configured === true &&
    (propertyId.trim() !== (status.propertyId ?? "").trim() ||
      chainId.trim() !== (status.chainId ?? "").trim() ||
      username.trim() !== (status.username ?? "").trim() ||
      gmailAddress.trim() !== (status.gmailAddress ?? "").trim());

  const hasSecretRotation = Boolean(password && gmailAppPassword);
  const hasPartialSecret = Boolean(password) !== Boolean(gmailAppPassword);

  const canSaveNew =
    !status?.configured &&
    Boolean(username.trim() && password && gmailAddress.trim() && gmailAppPassword);
  const canSaveUpdate =
    status?.configured === true && !hasPartialSecret && (hasSecretRotation || hasNonSecretChanges);
  const canSave = canSaveNew || canSaveUpdate;

  const onSave = useCallback(async () => {
    setBusy(true);
    setError(null);
    if (!username.trim() || !gmailAddress.trim()) {
      setError("Enter SynXis username and Gmail address.");
      setBusy(false);
      return;
    }
    if (hasPartialSecret) {
      setError("Enter both SynXis password and Gmail app password to rotate secrets.");
      setBusy(false);
      return;
    }
    if (!status?.configured && (!password || !gmailAppPassword)) {
      setError("Enter SynXis password and Gmail app password for initial setup.");
      setBusy(false);
      return;
    }
    if (status?.configured && !hasSecretRotation && !hasNonSecretChanges) {
      setError("No changes to save.");
      setBusy(false);
      return;
    }
    const { ok, error: saveErr } = await saveSynxisCredentials({
      username: username.trim(),
      gmailAddress: gmailAddress.trim(),
      propertyId: propertyId.trim() || "93302",
      chainId: chainId.trim() || "5136",
      ...(password ? { password } : {}),
      ...(gmailAppPassword ? { gmailAppPassword } : {}),
    });
    if (!ok || saveErr) {
      setError(saveErr ?? "Failed to save SynXis credentials.");
      setBusy(false);
      return;
    }
    setPassword("");
    setGmailAppPassword("");
    setSavedAt(new Date());
    await loadStatus();
    setBusy(false);
  }, [
    username,
    password,
    gmailAddress,
    gmailAppPassword,
    propertyId,
    chainId,
    status?.configured,
    hasNonSecretChanges,
    hasPartialSecret,
    hasSecretRotation,
    loadStatus,
  ]);

  const onTestLogin = useCallback(async () => {
    setTestBusy(true);
    setError(null);
    showTestFeedback({ status: "testing" });
    try {
      const result = await testSynxisLogin();
      if (!result.ok || result.error) {
        showTestFeedback({
          status: "error",
          message: result.error ?? "SynXis login test failed.",
          at: new Date().toISOString(),
        });
        return;
      }
      showTestFeedback({
        status: "success",
        message: result.message ?? "SynXis login test succeeded.",
        at: new Date().toISOString(),
      });
      await loadStatus({ silent: true });
    } catch (e) {
      showTestFeedback({
        status: "error",
        message: e instanceof Error ? e.message : "SynXis login test failed.",
        at: new Date().toISOString(),
      });
    } finally {
      setTestBusy(false);
    }
  }, [loadStatus, showTestFeedback]);

  const onSaveSession = useCallback(async () => {
    setSessionBusy(true);
    setError(null);
    if (!cookieHeader.trim()) {
      setError("Paste a SynXis Cookie header to save session.");
      setSessionBusy(false);
      return;
    }
    const { ok, error: saveErr } = await saveSynxisSessionCookie(cookieHeader.trim());
    if (!ok || saveErr) {
      setError(saveErr ?? "Failed to save session cookie.");
      setSessionBusy(false);
      return;
    }
    setCookieHeader("");
    await loadStatus();
    setSessionBusy(false);
  }, [cookieHeader, loadStatus]);

  if (!isAdmin) return null;

  const sessionStatus = sessionStatusLabel(status);

  const formatTestTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString();
    } catch {
      return iso;
    }
  };

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-base font-semibold text-[var(--text-h)]">SynXis credentials</h2>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          SynXis credentials below are for <strong>cookie backup only</strong> (extension / manual paste).
          Primary room data comes from the VPS bridge (PM2) — see <strong>DualPMS VPS bridge</strong> below.
        </p>
      </header>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-h)]">Backup session cookie</h3>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Used when DualPMS Postgres is unavailable. The extension saves the latest cookie when
              staff log into SynXis.
            </p>
          </div>
          <span
            className={`inline-flex rounded-md border px-2.5 py-1 text-xs font-semibold ${sessionStatus.className}`}
          >
            {sessionStatus.text}
          </span>
        </div>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-[var(--text-muted)]">Last saved</dt>
            <dd className="mt-0.5 text-[var(--text)]">
              {status?.sessionRefreshedAt
                ? new Date(status.sessionRefreshedAt).toLocaleString()
                : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-[var(--text-muted)]">Saved by</dt>
            <dd className="mt-0.5 text-[var(--text)]">
              {formatSynxisSessionSource(status?.sessionSource ?? null)}
            </dd>
          </div>
        </dl>
      </div>

      {testFeedback.status !== "idle" ? (
        <div ref={testFeedbackRef}>
          {testFeedback.status === "testing" ? (
            <div
              className="flex items-start gap-2 rounded-lg border-2 border-amber-500 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-sm dark:border-amber-400 dark:bg-amber-950/40 dark:text-amber-100"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin" aria-hidden />
              <div>
                <p className="font-semibold">Testing saved SynXis session…</p>
                <p className="mt-1 text-xs opacity-90">
                  Checks whether the saved session cookie is still valid with SynXis.
                </p>
              </div>
            </div>
          ) : null}

          {testFeedback.status === "success" ? (
            <div
              className="flex items-start gap-2 rounded-lg border-2 border-emerald-500 bg-emerald-50 px-4 py-3 text-sm text-emerald-950 shadow-sm dark:border-emerald-400 dark:bg-emerald-950/40 dark:text-emerald-100"
              role="status"
              aria-live="polite"
            >
              <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <div>
                <p className="font-semibold">Session test passed</p>
                <p className="mt-1 text-xs opacity-90">{testFeedback.message}</p>
                <p className="mt-1 text-[11px] opacity-75">
                  Checked at {formatTestTime(testFeedback.at)}
                </p>
              </div>
            </div>
          ) : null}

          {testFeedback.status === "error" ? (
            <div
              className="flex items-start gap-2 rounded-lg border-2 border-red-500 bg-red-50 px-4 py-3 text-sm text-red-950 shadow-sm dark:border-red-400 dark:bg-red-950/40 dark:text-red-100"
              role="alert"
              aria-live="assertive"
            >
              <X className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
              <div>
                <p className="font-semibold">Session test failed</p>
                <p className="mt-1 text-xs opacity-90">{testFeedback.message}</p>
                <p className="mt-1 text-[11px] opacity-75">
                  Failed at {formatTestTime(testFeedback.at)}
                </p>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 p-4">
        {loading ? (
          <p className="text-sm text-[var(--text-muted)]">Loading SynXis configuration…</p>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {status?.configured ? (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs font-semibold text-emerald-800 dark:text-emerald-200">
                  <Check className="h-3.5 w-3.5" aria-hidden />
                  Credentials configured
                </span>
              ) : (
                <span className="inline-flex rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-semibold text-amber-900 dark:text-amber-200">
                  Not configured
                </span>
              )}
              {status?.updatedAt ? (
                <span className="text-xs text-[var(--text-muted)]">
                  Credentials updated {new Date(status.updatedAt).toLocaleString()}
                </span>
              ) : null}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="setting-synxis-username" className="block text-sm font-medium">
                  SynXis username
                </label>
                <input
                  id="setting-synxis-username"
                  className="input-field mt-1 w-full font-mono"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div>
                <label htmlFor="setting-synxis-password" className="block text-sm font-medium">
                  SynXis password
                </label>
                <input
                  id="setting-synxis-password"
                  type="password"
                  className="input-field mt-1 w-full"
                  placeholder={status?.configured ? "Enter new password to rotate" : "Required"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div>
                <label htmlFor="setting-synxis-gmail" className="block text-sm font-medium">
                  Gmail address (MFA inbox)
                </label>
                <input
                  id="setting-synxis-gmail"
                  type="email"
                  className="input-field mt-1 w-full"
                  value={gmailAddress}
                  onChange={(e) => setGmailAddress(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div>
                <label htmlFor="setting-synxis-gmail-app" className="block text-sm font-medium">
                  Gmail app password
                </label>
                <input
                  id="setting-synxis-gmail-app"
                  type="password"
                  className="input-field mt-1 w-full"
                  placeholder="16-character app password"
                  value={gmailAppPassword}
                  onChange={(e) => setGmailAppPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div>
                <label htmlFor="setting-synxis-property" className="block text-sm font-medium">
                  Property ID
                </label>
                <input
                  id="setting-synxis-property"
                  className="input-field mt-1 w-full font-mono"
                  value={propertyId}
                  onChange={(e) => setPropertyId(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="setting-synxis-chain" className="block text-sm font-medium">
                  Chain ID
                </label>
                <input
                  id="setting-synxis-chain"
                  className="input-field mt-1 w-full font-mono"
                  value={chainId}
                  onChange={(e) => setChainId(e.target.value)}
                />
              </div>
            </div>

            {error ? (
              <p className="mt-3 text-sm text-red-500" role="alert">
                {error}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn-primary inline-flex items-center gap-2"
                disabled={busy || !canSave}
                onClick={() => void onSave()}
              >
                <Save className="h-4 w-4" aria-hidden />
                {busy ? "Saving…" : status?.configured ? "Update SynXis credentials" : "Save SynXis credentials"}
              </button>
              {status?.configured || status?.sessionSaved ? (
                <button
                  type="button"
                  className="btn-secondary inline-flex items-center gap-2"
                  disabled={testBusy}
                  onClick={() => void onTestLogin()}
                >
                  {testBusy ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      Testing login…
                    </>
                  ) : testFeedback.status === "success" ? (
                    <>
                      <Check className="h-4 w-4 text-emerald-600" aria-hidden />
                      Test saved session
                    </>
                  ) : testFeedback.status === "error" ? (
                    <>
                      <X className="h-4 w-4 text-red-600" aria-hidden />
                      Test saved session
                    </>
                  ) : (
                    "Test saved session"
                  )}
                </button>
              ) : null}
              {savedAt ? (
                <span className="text-xs text-emerald-700 dark:text-emerald-300">
                  Saved at {savedAt.toLocaleTimeString()}
                </span>
              ) : null}
            </div>

            <div className="mt-6 border-t border-[var(--border)] pt-4">
              <h3 className="text-sm font-semibold text-[var(--text-h)]">
                Session cookie (manual fallback)
              </h3>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Paste a cookie manually if the extension has not saved one yet.
              </p>
              <textarea
                className="input-field mt-2 min-h-[80px] w-full font-mono text-xs"
                placeholder="Cookie: name=value; name2=value2…"
                value={cookieHeader}
                onChange={(e) => setCookieHeader(e.target.value)}
              />
              <button
                type="button"
                className="btn-secondary mt-2"
                disabled={sessionBusy || !cookieHeader.trim()}
                onClick={() => void onSaveSession()}
              >
                {sessionBusy ? "Saving…" : "Save session cookie"}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
