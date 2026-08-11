const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Optional UUID for audit/DNR when auth is disabled — set `VITE_DEV_USER_ID` in `.env`. */
export function devUserId(): string | null {
  const raw = import.meta.env.VITE_DEV_USER_ID?.trim();
  if (!raw || !UUID_RE.test(raw)) return null;
  return raw;
}

export function devDisplayLabel(): string {
  return import.meta.env.VITE_DEV_USER_LABEL?.trim() || "Guest";
}

export function devUserEmail(): string | null {
  const e = import.meta.env.VITE_DEV_USER_EMAIL?.trim();
  return e || null;
}

/** Shown on audit rows when auth is off. */
export function devUserRoleForAudit(): string {
  return import.meta.env.VITE_DEV_USER_ROLE?.trim() || "manager";
}
