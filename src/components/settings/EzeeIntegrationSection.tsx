import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Save, X } from "lucide-react";
import {
  fetchEzeeIntegrationStatus,
  saveEzeeCredentials,
  testEzeeConnection,
  type EzeeIntegrationStatus,
} from "@/lib/ezeeIntegration";

type Props = {
  isAdmin: boolean;
};

export function EzeeIntegrationSection({ isAdmin }: Props) {
  const [status, setStatus] = useState<EzeeIntegrationStatus | null>(null);
  const [hotelCode, setHotelCode] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const loadStatus = useCallback(async () => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: loadErr } = await fetchEzeeIntegrationStatus();
    if (loadErr) {
      setError(loadErr);
      setStatus(null);
    } else {
      setStatus(data);
      if (data?.hotelCode) setHotelCode(String(data.hotelCode));
    }
    setAuthCode("");
    setLoading(false);
  }, [isAdmin]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const onSave = useCallback(async () => {
    setBusy(true);
    setError(null);
    setTestMessage(null);
    setTestError(null);
    const code = Number.parseInt(hotelCode, 10);
    if (!Number.isFinite(code) || code <= 0) {
      setError("Enter a valid eZee hotel code.");
      setBusy(false);
      return;
    }
    if (!authCode.trim()) {
      setError("Enter the eZee auth code.");
      setBusy(false);
      return;
    }

    const { ok, error: saveErr } = await saveEzeeCredentials(code, authCode.trim());
    if (!ok || saveErr) {
      setError(saveErr ?? "Failed to save eZee credentials.");
      setBusy(false);
      return;
    }

    setAuthCode("");
    setSavedAt(new Date());
    await loadStatus();
    setBusy(false);
  }, [authCode, hotelCode, loadStatus]);

  const onTest = useCallback(async () => {
    setTestBusy(true);
    setTestMessage(null);
    setTestError(null);
    setError(null);

    const code = Number.parseInt(hotelCode, 10);
    const parsedCode = Number.isFinite(code) && code > 0 ? code : undefined;
    const result = await testEzeeConnection({
      hotelCode: parsedCode,
      authCode: authCode.trim() || undefined,
    });

    if (!result.ok || result.error) {
      setTestError(result.error ?? "Connection test failed.");
    } else {
      setTestMessage(result.message ?? "eZee API connected.");
    }
    setTestBusy(false);
  }, [authCode, hotelCode]);

  const canTest =
    status?.configured || (authCode.trim() && Number.parseInt(hotelCode, 10) > 0);

  if (!isAdmin) return null;

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-base font-semibold text-[var(--text-h)]">eZee API credentials</h2>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Used by the Chrome extension for live folio balance checks. The Dual PMS board reads eZee room
          data from DualPMS on the VPS — not this API directly. Use <strong>Test connection</strong> to
          verify hotel code and auth code against eZee&apos;s cloud API.
        </p>
      </header>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 p-4">
        {loading ? (
          <p className="text-sm text-[var(--text-muted)]">Loading eZee configuration…</p>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {status?.configured ? (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs font-semibold text-emerald-800 dark:text-emerald-200">
                  <Check className="h-3.5 w-3.5" aria-hidden />
                  Configured
                </span>
              ) : (
                <span className="inline-flex rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-semibold text-amber-900 dark:text-amber-200">
                  Not configured
                </span>
              )}
              {status?.updatedAt ? (
                <span className="text-xs text-[var(--text-muted)]">
                  Last saved {new Date(status.updatedAt).toLocaleString()}
                </span>
              ) : null}
              {savedAt ? (
                <span className="text-xs text-emerald-700 dark:text-emerald-300">
                  Saved at {savedAt.toLocaleTimeString()}
                </span>
              ) : null}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="setting-ezee-hotel-code" className="block text-sm font-medium text-[var(--text-h)]">
                  eZee hotel code
                </label>
                <input
                  id="setting-ezee-hotel-code"
                  type="number"
                  min={1}
                  className="input-field mt-1 w-full font-mono"
                  placeholder="51836"
                  value={hotelCode}
                  onChange={(e) => setHotelCode(e.target.value)}
                  autoComplete="off"
                />
              </div>

              <div>
                <label htmlFor="setting-ezee-auth-code" className="block text-sm font-medium text-[var(--text-h)]">
                  eZee auth code
                </label>
                <input
                  id="setting-ezee-auth-code"
                  type="password"
                  className="input-field mt-1 w-full font-mono"
                  placeholder={status?.configured ? "Enter new code to rotate" : "Paste auth code once"}
                  value={authCode}
                  onChange={(e) => setAuthCode(e.target.value)}
                  autoComplete="new-password"
                />
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                  Stored encrypted in <code className="font-mono text-[11px]">app_settings</code>. Never displayed
                  after save.
                </p>
              </div>
            </div>

            {error ? (
              <p className="mt-3 text-sm text-red-500" role="alert">
                {error}
              </p>
            ) : null}
            {testError ? (
              <p className="mt-3 text-sm text-red-500" role="alert">
                {testError}
              </p>
            ) : null}
            {testMessage ? (
              <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-300" role="status">
                {testMessage}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn-primary inline-flex items-center gap-2"
                disabled={busy || !authCode.trim()}
                onClick={() => void onSave()}
              >
                <Save className="h-4 w-4" aria-hidden />
                {busy ? "Saving…" : status?.configured ? "Update eZee credentials" : "Save eZee credentials"}
              </button>
              {canTest ? (
                <button
                  type="button"
                  className="btn-secondary inline-flex items-center gap-2"
                  disabled={testBusy}
                  onClick={() => void onTest()}
                >
                  {testBusy ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      Testing…
                    </>
                  ) : testMessage ? (
                    <>
                      <Check className="h-4 w-4 text-emerald-600" aria-hidden />
                      Test connection
                    </>
                  ) : testError ? (
                    <>
                      <X className="h-4 w-4 text-red-600" aria-hidden />
                      Test connection
                    </>
                  ) : (
                    "Test connection"
                  )}
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
