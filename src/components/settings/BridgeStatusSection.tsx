import { useCallback, useEffect, useState } from "react";
import { Check, RefreshCw, X } from "lucide-react";
import { fetchPmsBridgeStatus, formatPmsSourceLabel, type PmsBridgeStatus } from "@/lib/bridgeStatus";
import { DUALPMS_UPSTREAM_STALE_SEC, PMS_STALE_SYNC_THRESHOLD_SEC } from "@/types/pmsBoard";

type Props = {
  isAdmin: boolean;
};

const POLL_MS = 30_000;

function formatAgo(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s ago` : `${m}m ago`;
}

export function BridgeStatusSection({ isAdmin }: Props) {
  const [status, setStatus] = useState<PmsBridgeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async (silent = false) => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    const { data, error: loadErr } = await fetchPmsBridgeStatus();
    if (loadErr) {
      setError(loadErr);
      setStatus(null);
    } else {
      setStatus(data);
      setError(null);
    }
    setLoading(false);
  }, [isAdmin]);

  useEffect(() => {
    void loadStatus();
    const id = window.setInterval(() => void loadStatus(true), POLL_MS);
    return () => window.clearInterval(id);
  }, [loadStatus]);

  if (!isAdmin) return null;

  const running = status?.bridgeRunning === true;
  const stale =
    status?.bridgeSecondsAgo != null &&
    status.bridgeSecondsAgo > PMS_STALE_SYNC_THRESHOLD_SEC;

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-base font-semibold text-[var(--text-h)]">DualPMS VPS bridge</h2>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Copies DualPMS Postgres to Supabase every ~10s. When DualPMS upstream poll is stale,
          automatically falls back to SynXis browser cookie → script login, or direct eZee API.
        </p>
      </header>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 p-4">
        {loading && !status ? (
          <p className="text-sm text-[var(--text-muted)]">Loading bridge status…</p>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {running ? (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs font-semibold text-emerald-800 dark:text-emerald-200">
                  <Check className="h-3.5 w-3.5" aria-hidden />
                  Bridge running
                </span>
              ) : stale || status?.lastError ? (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs font-semibold text-red-800 dark:text-red-200">
                  <X className="h-3.5 w-3.5" aria-hidden />
                  Bridge not running or stale
                </span>
              ) : (
                <span className="inline-flex rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-semibold text-amber-900 dark:text-amber-200">
                  No heartbeat yet
                </span>
              )}
              {status?.bridgeHost ? (
                <span className="text-xs text-[var(--text-muted)]">Host: {status.bridgeHost}</span>
              ) : null}
              {status?.bridgeVersion ? (
                <span className="text-xs text-[var(--text-muted)]">v{status.bridgeVersion}</span>
              ) : null}
              {status?.fallbackActive ? (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-semibold text-amber-900 dark:text-amber-200">
                  API fallback active
                </span>
              ) : null}
              {status?.dualpmsSynxisHealthy === false ? (
                <span className="text-xs text-amber-700 dark:text-amber-300">
                  DualPMS SynXis poll stale ({formatAgo(status.synxisPollAgeSec)})
                </span>
              ) : null}
              {status?.dualpmsEzeeHealthy === false ? (
                <span className="text-xs text-amber-700 dark:text-amber-300">
                  DualPMS eZee poll stale ({formatAgo(status.ezeePollAgeSec)})
                </span>
              ) : null}
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"
                onClick={() => void loadStatus()}
              >
                <RefreshCw className="h-3 w-3" aria-hidden />
                Refresh
              </button>
            </div>

            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-[var(--text-muted)]">Last bridge run</dt>
                <dd className="mt-0.5 text-[var(--text-h)]">
                  {status?.lastRunAt
                    ? `${new Date(status.lastRunAt).toLocaleString()} (${formatAgo(status.bridgeSecondsAgo)})`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--text-muted)]">Last successful sync</dt>
                <dd className="mt-0.5 text-[var(--text-h)]">
                  {status?.lastOkAt ? new Date(status.lastOkAt).toLocaleString() : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--text-muted)]">Rooms copied</dt>
                <dd className="mt-0.5 text-[var(--text-h)]">
                  {status?.roomsUpserted != null ? `${status.roomsUpserted} rooms` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--text-muted)]">SynXis hotel date</dt>
                <dd className="mt-0.5 text-[var(--text-h)]">{status?.synxis.hotelDate ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--text-muted)]">Supabase SynXis copy</dt>
                <dd className="mt-0.5 text-[var(--text-h)]">
                  {status?.synxis.syncedAt
                    ? new Date(status.synxis.syncedAt).toLocaleString()
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--text-muted)]">Supabase eZee copy</dt>
                <dd className="mt-0.5 text-[var(--text-h)]">
                  {status?.ezee.syncedAt
                    ? new Date(status.ezee.syncedAt).toLocaleString()
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--text-muted)]">SynXis data source</dt>
                <dd className="mt-0.5 text-[var(--text-h)]">
                  {formatPmsSourceLabel(status?.synxis.source)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--text-muted)]">eZee data source</dt>
                <dd className="mt-0.5 text-[var(--text-h)]">
                  {formatPmsSourceLabel(status?.ezee.source)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--text-muted)]">SynXis API result</dt>
                <dd className="mt-0.5 text-[var(--text-h)]">
                  {status?.synxis.api.status ? (
                    <>
                      <span className="font-semibold uppercase">{status.synxis.api.status}</span>
                      {status.synxis.api.roomsWithOccupancy != null &&
                      status.synxis.api.inventoryRooms != null
                        ? ` — S.OCC ${status.synxis.api.roomsWithOccupancy}/${status.synxis.api.inventoryRooms}`
                        : null}
                    </>
                  ) : (
                    "—"
                  )}
                </dd>
                {status?.synxis.api.detail ? (
                  <dd className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                    {status.synxis.api.detail}
                  </dd>
                ) : null}
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--text-muted)]">eZee API result</dt>
                <dd className="mt-0.5 text-[var(--text-h)]">
                  {status?.ezee.api.status ? (
                    <>
                      <span className="font-semibold uppercase">{status.ezee.api.status}</span>
                      {status.ezee.api.roomsWithOccupancy != null &&
                      status.ezee.api.inventoryRooms != null
                        ? ` — E.OCC ${status.ezee.api.roomsWithOccupancy}/${status.ezee.api.inventoryRooms}`
                        : null}
                    </>
                  ) : (
                    "—"
                  )}
                </dd>
                {status?.ezee.api.detail ? (
                  <dd className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                    {status.ezee.api.detail}
                  </dd>
                ) : null}
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--text-muted)]">DualPMS SynXis poll</dt>
                <dd className="mt-0.5 text-[var(--text-h)]">
                  {status?.synxis.dualpmsPolledAt
                    ? new Date(status.synxis.dualpmsPolledAt).toLocaleString()
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--text-muted)]">DualPMS eZee poll</dt>
                <dd className="mt-0.5 text-[var(--text-h)]">
                  {status?.ezee.dualpmsPolledAt
                    ? new Date(status.ezee.dualpmsPolledAt).toLocaleString()
                    : "—"}
                </dd>
              </div>
            </dl>

            {status?.warnings?.length ? (
              <ul className="mt-3 space-y-1 rounded-lg border border-amber-400/50 bg-amber-50/80 px-3 py-2 text-xs text-amber-950 dark:border-amber-600/40 dark:bg-amber-950/30 dark:text-amber-100">
                {status.warnings.map((w) => (
                  <li key={`${w.system}-${w.at}`}>
                    <strong>{w.system}:</strong> {w.message}
                  </li>
                ))}
              </ul>
            ) : null}

            {status?.lastError ? (
              <p className="mt-3 text-sm text-red-500" role="alert">
                Last error: {status.lastError}
              </p>
            ) : null}
            {error ? (
              <p className="mt-3 text-sm text-red-500" role="alert">
                {error}
              </p>
            ) : null}

            <p className="mt-4 text-[11px] text-[var(--text-muted)]">
              Requires <code className="font-mono text-[11px]">EZEE_SECRETS_KEY</code> in{" "}
              <code className="font-mono text-[11px]">bridge/.env</code> for API fallback. Upstream
              stale threshold: {DUALPMS_UPSTREAM_STALE_SEC}s. Deploy:{" "}
              <code className="font-mono text-[11px]">pm2 start ecosystem.config.cjs</code>.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
