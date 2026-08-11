import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Save, RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { insertAuditRow } from "@/lib/audit";
import { parseHotelRoomList } from "@/lib/roomInventory";
import {
  formatRoomListForEditor,
  syncRoomsFromText,
  useHotelRoomInventory,
  useInvalidateHotelRooms,
} from "@/lib/hotelRooms";
import { FilterSelect } from "@/components/ui/FilterSelect";
import {
  DEFAULT_HOTEL_SETTINGS,
  TIMEZONE_PRESETS,
  currentBusinessDateNow,
  formatHotelLocaleString,
  saveHotelSettings,
  useHotelSettings,
  useInvalidateHotelSettings,
  type HotelSettings,
} from "@/lib/hotelSettings";
import { EzeeIntegrationSection } from "@/components/settings/EzeeIntegrationSection";
import { SynxisIntegrationSection } from "@/components/settings/SynxisIntegrationSection";
import { BridgeStatusSection } from "@/components/settings/BridgeStatusSection";
import { hasAtLeastRole } from "@/types/roles";
import {
  formatSeniorPreferredFloors,
  parseSeniorPreferredFloorsInput,
  previewSeniorRoomList,
} from "@/lib/seniorRoomRecommend";

function clampInt(v: string, lo: number, hi: number, fallback: number): number {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function formatHourLabel(h: number): string {
  if (h === 0) return "12:00 AM (midnight)";
  if (h < 12) return `${h}:00 AM`;
  if (h === 12) return "12:00 PM (noon)";
  return `${h - 12}:00 PM`;
}

export function SettingsPage() {
  const { profile } = useAuth();
  const persisted = useHotelSettings();
  const invalidate = useInvalidateHotelSettings();
  const invalidateRooms = useInvalidateHotelRooms();
  const dbRoomsQuery = useHotelRoomInventory();
  const dbRoomsHydrated = useRef(false);

  // Local draft mirrors the persisted settings until the user saves / discards.
  const [draft, setDraft] = useState<HotelSettings>(persisted);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  // Re-sync the draft any time the persisted value changes (e.g. another tab saved).
  useEffect(() => {
    setDraft(persisted);
    dbRoomsHydrated.current = false;
  }, [persisted]);

  // Room inventory: database is canonical; hydrate the textarea from `public.rooms`.
  useEffect(() => {
    if (dbRoomsHydrated.current || !dbRoomsQuery.data?.length) return;
    setDraft((s) => ({ ...s, roomList: formatRoomListForEditor(dbRoomsQuery.data) }));
    dbRoomsHydrated.current = true;
  }, [dbRoomsQuery.data]);

  // Live clock so the "Hotel time / Business date" preview ticks while the page is open.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(persisted), [draft, persisted]);
  const isAdmin = profile ? hasAtLeastRole(profile.role, "admin") : false;
  const previewBusinessDate = useMemo(() => currentBusinessDateNow(draft), [draft, now]); // eslint-disable-line react-hooks/exhaustive-deps
  const previewLocaleString = useMemo(
    () => formatHotelLocaleString(now, draft.timezone),
    [now, draft.timezone],
  );
  const parsedRooms = useMemo(() => parseHotelRoomList(draft.roomList), [draft.roomList]);
  const parsedSeniorRooms = useMemo(
    () => previewSeniorRoomList(draft.seniorPreferredRoomList),
    [draft.seniorPreferredRoomList],
  );

  const [fdGrantValue, setFdGrantValue] = useState("4");
  const [fdGrantUnit, setFdGrantUnit] = useState<"hours" | "days">("hours");

  const applyFrontDeskGrant = useCallback(() => {
    const n = clampInt(fdGrantValue, 1, fdGrantUnit === "hours" ? 168 : 30, fdGrantUnit === "hours" ? 4 : 1);
    const ms = fdGrantUnit === "hours" ? n * 3_600_000 : n * 86_400_000;
    setDraft((s) => ({ ...s, frontDeskKeysWriteAccessUntil: new Date(Date.now() + ms).toISOString() }));
  }, [fdGrantValue, fdGrantUnit]);

  const clearFrontDeskGrant = useCallback(() => {
    setDraft((s) => ({ ...s, frontDeskKeysWriteAccessUntil: null }));
  }, []);

  const onSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!profile) {
        setError("You must be signed in.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const { error: saveErr } = await saveHotelSettings(draft);
        if (saveErr) {
          setError(saveErr.message);
          return;
        }

        const { count, error: syncErr } = await syncRoomsFromText(draft.roomList);
        if (syncErr) {
          setError(`Settings saved, but room sync failed: ${syncErr.message}`);
          return;
        }
        if (count === 0 && parseHotelRoomList(draft.roomList).length > 0) {
          setError("Settings saved, but no rooms were written to the database. Check the room list format.");
          return;
        }
        const { error: auditErr } = await insertAuditRow(supabase, {
          action_type: "hotel_settings_updated",
          user_id: profile.id,
          username: profile.email,
          user_role: profile.role,
          description: "Hotel settings updated from Settings page",
          old_value: persisted as unknown as Record<string, unknown>,
          new_value: draft as unknown as Record<string, unknown>,
        });
        if (auditErr) {
          // Don't block UX; surface as a non-blocking warning.
          // eslint-disable-next-line no-console
          console.warn("[settings] audit log failed:", auditErr.message);
        }
        invalidate();
        invalidateRooms();
        dbRoomsHydrated.current = true;
        setSavedAt(new Date());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save settings.");
      } finally {
        setBusy(false);
      }
    },
    [draft, persisted, profile, invalidate, invalidateRooms],
  );

  const onReset = useCallback(() => {
    setDraft(persisted);
    setError(null);
  }, [persisted]);

  const onResetDefaults = useCallback(() => {
    setDraft(DEFAULT_HOTEL_SETTINGS);
  }, []);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Hotel-wide runtime configuration. Stored in{" "}
            <code className="font-mono text-xs">public.app_settings</code> and read by every client on load.
          </p>
        </div>
        {savedAt ? (
          <p className="text-xs text-emerald-700 dark:text-emerald-300">Saved at {savedAt.toLocaleTimeString()}</p>
        ) : null}
      </div>

      <form
        onSubmit={(e) => void onSubmit(e)}
        className="space-y-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 md:p-7"
      >
        {/* ── Hotel information ───────────────────────────────────── */}
        <section className="space-y-4">
          <header>
            <h2 className="text-base font-semibold text-[var(--text-h)]">Hotel information</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Printed on PDF exports such as Guest Profile and Cash Deposit Receipt.
            </p>
          </header>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <label htmlFor="setting-hotel-name" className="block text-sm font-medium text-[var(--text-h)]">
                Hotel name
              </label>
              <input
                id="setting-hotel-name"
                type="text"
                className="input-field mt-1 w-full"
                placeholder="La Quinta Inn Example"
                value={draft.hotelName}
                onChange={(e) => setDraft((s) => ({ ...s, hotelName: e.target.value }))}
              />
            </div>

            <div className="md:col-span-2">
              <label htmlFor="setting-hotel-address" className="block text-sm font-medium text-[var(--text-h)]">
                Street address
              </label>
              <input
                id="setting-hotel-address"
                type="text"
                className="input-field mt-1 w-full"
                placeholder="2108 S Coulter St"
                value={draft.hotelAddress}
                onChange={(e) => setDraft((s) => ({ ...s, hotelAddress: e.target.value }))}
              />
            </div>

            <div>
              <label htmlFor="setting-hotel-city" className="block text-sm font-medium text-[var(--text-h)]">
                City
              </label>
              <input
                id="setting-hotel-city"
                type="text"
                className="input-field mt-1 w-full"
                placeholder="Amarillo"
                value={draft.hotelCity}
                onChange={(e) => setDraft((s) => ({ ...s, hotelCity: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="setting-hotel-state" className="block text-sm font-medium text-[var(--text-h)]">
                  State
                </label>
                <input
                  id="setting-hotel-state"
                  type="text"
                  className="input-field mt-1 w-full"
                  placeholder="TX"
                  maxLength={2}
                  value={draft.hotelState}
                  onChange={(e) => setDraft((s) => ({ ...s, hotelState: e.target.value.toUpperCase() }))}
                />
              </div>
              <div>
                <label htmlFor="setting-hotel-zip" className="block text-sm font-medium text-[var(--text-h)]">
                  ZIP
                </label>
                <input
                  id="setting-hotel-zip"
                  type="text"
                  className="input-field mt-1 w-full"
                  placeholder="79106"
                  maxLength={10}
                  value={draft.hotelZip}
                  onChange={(e) => setDraft((s) => ({ ...s, hotelZip: e.target.value }))}
                />
              </div>
            </div>

            <div>
              <label htmlFor="setting-hotel-phone" className="block text-sm font-medium text-[var(--text-h)]">
                Phone
              </label>
              <input
                id="setting-hotel-phone"
                type="tel"
                className="input-field mt-1 w-full"
                placeholder="(806) 352-6311"
                value={draft.hotelPhone}
                onChange={(e) => setDraft((s) => ({ ...s, hotelPhone: e.target.value }))}
              />
            </div>

            <div>
              <label htmlFor="setting-hotel-email" className="block text-sm font-medium text-[var(--text-h)]">
                Email
              </label>
              <input
                id="setting-hotel-email"
                type="email"
                className="input-field mt-1 w-full"
                placeholder="hotel@example.com"
                value={draft.hotelEmail}
                onChange={(e) => setDraft((s) => ({ ...s, hotelEmail: e.target.value }))}
              />
            </div>

            <div>
              <label htmlFor="setting-cash-deposit" className="block text-sm font-medium text-[var(--text-h)]">
                Cash deposit amount ($)
              </label>
              <input
                id="setting-cash-deposit"
                type="number"
                min={0}
                step={1}
                className="input-field mt-1 w-full"
                value={draft.cashDepositAmount}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    cashDepositAmount: Math.max(0, parseFloat(e.target.value) || 0),
                  }))
                }
              />
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                Printed on the Cash Deposit Receipt PDF.
              </p>
            </div>
          </div>
        </section>

        <hr className="border-[var(--border)]" />

        <SynxisIntegrationSection isAdmin={isAdmin} />
        <BridgeStatusSection isAdmin={isAdmin} />
        <EzeeIntegrationSection isAdmin={isAdmin} />

        <hr className="border-[var(--border)]" />

        {/* ── Time & business day ─────────────────────────────────── */}
        <section className="space-y-4">
          <header>
            <h2 className="text-base font-semibold text-[var(--text-h)]">Time &amp; business day</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              The business day rolls over at the cutoff hour, in the hotel's local timezone. Guests checking in
              before the cutoff still count as the previous night's business.
            </p>
          </header>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="setting-timezone" className="block text-sm font-medium text-[var(--text-h)]">
                Timezone
              </label>
              <FilterSelect
                id="setting-timezone"
                value={draft.timezone}
                onChange={(e) => setDraft((s) => ({ ...s, timezone: e.target.value }))}
                className="mt-1"
              >
                {TIMEZONE_PRESETS.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
                {TIMEZONE_PRESETS.every((tz) => tz.value !== draft.timezone) ? (
                  <option value={draft.timezone}>{draft.timezone} (custom)</option>
                ) : null}
              </FilterSelect>
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                IANA name. DST is handled automatically (e.g. CST ↔ CDT).
              </p>
            </div>

            <div>
              <label htmlFor="setting-cutoff" className="block text-sm font-medium text-[var(--text-h)]">
                Business-day cutoff
              </label>
              <FilterSelect
                id="setting-cutoff"
                value={String(draft.businessDayCutoffHour)}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    businessDayCutoffHour: clampInt(e.target.value, 0, 23, s.businessDayCutoffHour),
                  }))
                }
                className="mt-1"
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={String(h)}>
                    {formatHourLabel(h)}
                  </option>
                ))}
              </FilterSelect>
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                Encodes BEFORE this hour land on the previous business date (admin can still override per row).
              </p>
            </div>

            <div>
              <label htmlFor="setting-checkout" className="block text-sm font-medium text-[var(--text-h)]">
                Default checkout time
              </label>
              <input
                id="setting-checkout"
                type="time"
                className="input-field mt-1 w-full"
                value={draft.defaultCheckoutTime}
                onChange={(e) => setDraft((s) => ({ ...s, defaultCheckoutTime: e.target.value }))}
              />
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                Used as the default key-expiry clock time in the Encode key modal.
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[var(--text-muted)]">Hotel local time</span>
              <span className="font-semibold text-[var(--text-h)]">{previewLocaleString}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[var(--text-muted)]">Current business date</span>
              <span className="font-mono text-[var(--text-h)]">{previewBusinessDate}</span>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <header>
            <h2 className="text-base font-semibold text-[var(--text-h)]">Front desk &amp; ID scan</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Rules applied in the Chrome extension when a guest ID is scanned.
            </p>
          </header>
          <div className="max-w-xs">
            <label htmlFor="setting-min-age" className="block text-sm font-medium text-[var(--text-h)]">
              Minimum check-in age
            </label>
            <input
              id="setting-min-age"
              type="number"
              min={0}
              max={99}
              className="input-field mt-1 w-full"
              value={draft.minimumCheckInAge}
              onChange={(e) =>
                setDraft((s) => ({
                  ...s,
                  minimumCheckInAge: clampInt(e.target.value, 0, 99, s.minimumCheckInAge),
                }))
              }
            />
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">
              Guests younger than this age trigger an underage warning on scan (e.g. 18). Set to{" "}
              <span className="font-mono">0</span> to turn off the warning.
            </p>
          </div>

          <div className="space-y-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
            <div>
              <h3 className="text-sm font-semibold text-[var(--text-h)]">Senior room recommendations</h3>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                After a complete ID scan, the extension shows a non-blocking hint with vacant rooms suited
                for older guests. Does not auto-assign rooms or block check-in.
              </p>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--text-h)]">
              <input
                type="checkbox"
                className="rounded border-[var(--border)]"
                checked={draft.seniorRecommendEnabled}
                onChange={(e) =>
                  setDraft((s) => ({ ...s, seniorRecommendEnabled: e.target.checked }))
                }
              />
              Enable senior room recommendations
            </label>

            <div className="max-w-xs">
              <label htmlFor="setting-senior-age" className="block text-sm font-medium text-[var(--text-h)]">
                Senior recommendation age
              </label>
              <input
                id="setting-senior-age"
                type="number"
                min={0}
                max={99}
                className="input-field mt-1 w-full"
                value={draft.seniorRecommendAge}
                disabled={!draft.seniorRecommendEnabled}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    seniorRecommendAge: clampInt(e.target.value, 0, 99, s.seniorRecommendAge),
                  }))
                }
              />
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                Guests at or above this age see vacant-room suggestions (default{" "}
                <span className="font-mono">50</span>). Set to <span className="font-mono">0</span> to
                disable.
              </p>
            </div>

            <div className="max-w-md">
              <label
                htmlFor="setting-senior-floors"
                className="block text-sm font-medium text-[var(--text-h)]"
              >
                Preferred floors
              </label>
              <input
                id="setting-senior-floors"
                type="text"
                className="input-field mt-1 w-full font-mono text-sm"
                placeholder="1"
                disabled={!draft.seniorRecommendEnabled}
                value={formatSeniorPreferredFloors(draft.seniorPreferredFloors)}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    seniorPreferredFloors: parseSeniorPreferredFloorsInput(e.target.value),
                  }))
                }
              />
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                Used when no custom room list is set. Room <span className="font-mono">101</span> is
                treated as floor <span className="font-mono">1</span>, <span className="font-mono">203</span>{" "}
                as floor <span className="font-mono">2</span>, etc.
              </p>
            </div>

            <div>
              <label
                htmlFor="setting-senior-rooms"
                className="block text-sm font-medium text-[var(--text-h)]"
              >
                Preferred room list (optional override)
              </label>
              <textarea
                id="setting-senior-rooms"
                rows={3}
                className="input-field mt-1 w-full font-mono text-sm"
                placeholder="103, 105, 107-110"
                disabled={!draft.seniorRecommendEnabled}
                value={draft.seniorPreferredRoomList}
                onChange={(e) =>
                  setDraft((s) => ({ ...s, seniorPreferredRoomList: e.target.value }))
                }
              />
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                When set, only these rooms are recommended (ignores preferred floors). Same format as room
                inventory — comma-separated or ranges.
                {parsedSeniorRooms.length > 0 ? (
                  <>
                    {" "}
                    Parsed <strong>{parsedSeniorRooms.length}</strong> room
                    {parsedSeniorRooms.length === 1 ? "" : "s"}.
                  </>
                ) : null}
              </p>
            </div>
          </div>
        </section>

        {/* ── Key encoding rules ─────────────────────────────────── */}
        <section className="space-y-4">
          <header>
            <h2 className="text-base font-semibold text-[var(--text-h)]">Key encoding rules</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Controls when front desk can encode room keys from the extension. Currently applies to eZee
              reservations; SynXis balance support coming once the folio endpoint is confirmed.
            </p>
          </header>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="setting-max-balance" className="block text-sm font-medium text-[var(--text-h)]">
                Maximum allowed balance ($)
              </label>
              <input
                id="setting-max-balance"
                type="number"
                min={0}
                step={1}
                placeholder="Disabled"
                className="input-field mt-1 w-full"
                value={draft.maxAllowedBalance < 0 ? "" : String(draft.maxAllowedBalance)}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    maxAllowedBalance: e.target.value === "" ? -1 : clampInt(e.target.value, 0, 99999, -1),
                  }))
                }
              />
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                If a guest&apos;s balance exceeds this amount, key encoding is blocked until payment is
                processed. Leave blank to disable this check. Example: enter{" "}
                <span className="font-mono">10</span> to block any balance over $10.
              </p>
            </div>
            <div>
              <label htmlFor="setting-manager-pin" className="block text-sm font-medium text-[var(--text-h)]">
                Manager override PIN
              </label>
              <input
                id="setting-manager-pin"
                type="password"
                autoComplete="new-password"
                placeholder="Leave blank to disable override"
                className="input-field mt-1 w-full"
                value={draft.managerOverridePin}
                onChange={(e) => setDraft((s) => ({ ...s, managerOverridePin: e.target.value.slice(0, 32) }))}
              />
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                Front desk can enter this PIN to override a key-encoding block (balance or check-in status).
                Leave blank to disable the override option entirely.
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 p-4">
            <h3 className="text-sm font-semibold text-[var(--text-h)]">Front desk emergency access (system down)</h3>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Admin can temporarily allow all front desk accounts to <span className="font-medium">Add guest</span> and{" "}
              <span className="font-medium">Move room</span> from the extension without manager PIN. Expires automatically.
            </p>

            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)]">Grant duration</label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={fdGrantUnit === "hours" ? 168 : 30}
                    className="input-field w-24"
                    value={fdGrantValue}
                    onChange={(e) => setFdGrantValue(e.target.value)}
                  />
                  <select
                    className="input-field w-28"
                    value={fdGrantUnit}
                    onChange={(e) => setFdGrantUnit(e.target.value === "days" ? "days" : "hours")}
                  >
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                  </select>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={applyFrontDeskGrant}
                    disabled={!profile || profile.role !== "admin"}
                    title={profile?.role !== "admin" ? "Admin only" : "Grant access until expiry"}
                  >
                    Grant
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={clearFrontDeskGrant}
                    disabled={!profile || profile.role !== "admin"}
                    title={profile?.role !== "admin" ? "Admin only" : "Revoke access"}
                  >
                    Revoke
                  </button>
                </div>
              </div>

              <div className="min-w-[16rem]">
                <label className="block text-xs font-medium text-[var(--text-muted)]">Current expiry</label>
                <p className="mt-1 text-sm text-[var(--text-h)]">
                  {draft.frontDeskKeysWriteAccessUntil
                    ? new Date(draft.frontDeskKeysWriteAccessUntil).toLocaleString()
                    : "Disabled"}
                </p>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="inline-flex items-center gap-2 text-sm text-[var(--text-h)]">
                <input
                  type="checkbox"
                  checked={draft.frontDeskDefaultKeyDaysEnabled}
                  onChange={(e) =>
                    setDraft((s) => ({ ...s, frontDeskDefaultKeyDaysEnabled: e.target.checked }))
                  }
                />
                Default key duration
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={30}
                  className="input-field w-20"
                  value={String(draft.frontDeskDefaultKeyDays)}
                  onChange={(e) =>
                    setDraft((s) => ({
                      ...s,
                      frontDeskDefaultKeyDays: clampInt(e.target.value, 1, 30, 1),
                    }))
                  }
                  disabled={!draft.frontDeskDefaultKeyDaysEnabled}
                />
                <span className="text-sm text-[var(--text-muted)]">day(s) (pre-fills checkout; front desk can edit)</span>
              </div>
            </div>
          </div>
        </section>

        {/* ── Security ───────────────────────────────────────────── */}
        <section className="space-y-4">
          <header>
            <h2 className="text-base font-semibold text-[var(--text-h)]">Security</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Applies to both the web portal and the Chrome extension. Staff are signed out after the
              configured period of inactivity (no mouse, keyboard, or touch input).
            </p>
          </header>
          <div className="max-w-xs">
            <label htmlFor="setting-auto-logout" className="block text-sm font-medium text-[var(--text-h)]">
              Auto-logout after inactivity
            </label>
            <FilterSelect
              id="setting-auto-logout"
              value={String(draft.autoLogoutMinutes)}
              onChange={(e) =>
                setDraft((s) => ({
                  ...s,
                  autoLogoutMinutes: parseInt(e.target.value, 10),
                }))
              }
              className="mt-1"
            >
              <option value="0">Never (disabled)</option>
              <option value="15">15 minutes</option>
              <option value="30">30 minutes</option>
              <option value="60">1 hour</option>
              <option value="120">2 hours</option>
              <option value="240">4 hours</option>
              <option value="480">8 hours (default)</option>
              <option value="720">12 hours</option>
              <option value="1440">24 hours</option>
            </FilterSelect>
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">
              Set to <span className="font-mono">Never</span> to disable automatic sign-out. Changes take
              effect immediately — no page reload required.
            </p>
          </div>
        </section>

        {/* ── Room inventory ──────────────────────────────────────── */}
        <section className="space-y-3">
          <header>
            <h2 className="text-base font-semibold text-[var(--text-h)]">Room inventory</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Comma / space / semicolon separated. Inclusive ranges like{" "}
              <code className="font-mono text-[11px]">101-120</code> are expanded and saved to{" "}
              <code className="font-mono text-[11px]">public.rooms</code> when you click Save.
              {dbRoomsQuery.data?.length ? (
                <>
                  {" "}
                  Database currently has{" "}
                  <span className="font-mono text-[var(--text-h)]">{dbRoomsQuery.data.length}</span>{" "}
                  active rooms.
                </>
              ) : null}
            </p>
          </header>

          <textarea
            className="input-field min-h-[5rem] w-full resize-y font-mono text-sm"
            value={draft.roomList}
            onChange={(e) => setDraft((s) => ({ ...s, roomList: e.target.value }))}
            placeholder="101-120, 201-220, 301-320"
          />
          <p className="text-[11px] text-[var(--text-muted)]">
            Parsed: <span className="font-mono text-[var(--text-h)]">{parsedRooms.length}</span> room
            {parsedRooms.length === 1 ? "" : "s"}
            {parsedRooms.length > 0 ? (
              <>
                {" — "}
                <span className="font-mono text-[var(--text)]">
                  {parsedRooms.slice(0, 8).join(", ")}
                  {parsedRooms.length > 8 ? ` … (+${parsedRooms.length - 8})` : ""}
                </span>
              </>
            ) : null}
          </p>
        </section>

        {error ? (
          <p className="text-sm text-red-500" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={onResetDefaults}
            disabled={busy}
            title="Reset all fields to built-in defaults (does not save)"
          >
            Reset to defaults
          </button>
          <div className="ml-auto flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary inline-flex items-center gap-2"
              onClick={onReset}
              disabled={busy || !dirty}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Discard changes
            </button>
            <button type="submit" className="btn-primary inline-flex items-center gap-2" disabled={busy || !dirty}>
              <Save className="h-4 w-4" aria-hidden />
              {busy ? "Saving…" : "Save settings"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
