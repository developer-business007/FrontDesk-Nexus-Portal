import type { Session } from "@supabase/supabase-js";
import type { UserRole } from "@/types/roles";

/**
 * Session bridge v1 — see docs/SESSION_BRIDGE.md
 * The web app cannot write chrome.storage.session; delivery uses
 * chrome.runtime.sendMessage (externally_connectable) and fallbacks.
 */

export const SESSION_BRIDGE_CHANNEL = "FDN_SESSION_V1" as const;
/** Portal → extension hardware / DB actions (must match extension service worker). */
export const PORTAL_BRIDGE_CHANNEL = "FDN_PORTAL_V1" as const;
export const SESSION_BRIDGE_SCHEMA_VERSION = 1 as const;

/** Default TTL hint for consumers (matches typical Supabase access token ~1h; extension should refresh). */
export const SESSION_BRIDGE_ACCESS_TTL_MS = 55 * 60 * 1000;

export type SessionBridgeEnvelope =
  | {
      kind: "session";
      schemaVersion: typeof SESSION_BRIDGE_SCHEMA_VERSION;
      issuedAtMs: number;
      /** When the access token is expected to expire (from JWT exp claim when available). */
      accessExpiresAtMs: number;
      userId: string;
      email: string | null;
      role: UserRole;
      supabaseUrl: string;
      accessToken: string;
      refreshToken: string;
    }
  | {
      kind: "invalidated";
      schemaVersion: typeof SESSION_BRIDGE_SCHEMA_VERSION;
      issuedAtMs: number;
      reason: "logout" | "lock" | "session_expired" | "unknown";
    };

function parseJwtExpMs(accessToken: string): number | null {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      exp?: number;
    };
    if (typeof json.exp === "number") return json.exp * 1000;
  } catch {
    /* ignore */
  }
  return null;
}

function dispatchDomFallback(envelope: SessionBridgeEnvelope): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("fdn-session-bridge", {
      detail: envelope,
    }),
  );
}

function sendToChromeExtension(envelope: SessionBridgeEnvelope): boolean {
  const extId = import.meta.env.VITE_CHROME_EXTENSION_ID?.trim();
  if (!extId) return false;
  const cr = (
    globalThis as typeof globalThis & {
      chrome?: { runtime?: { sendMessage?: (...args: unknown[]) => void } };
    }
  ).chrome;
  if (!cr?.runtime?.sendMessage) return false;
  cr.runtime.sendMessage(extId, {
    channel: SESSION_BRIDGE_CHANNEL,
    payload: envelope,
  });
  return true;
}

export type BridgePublishOptions = {
  role: UserRole;
  supabaseUrl: string;
};

export function publishSessionBridge(
  session: Session,
  options: BridgePublishOptions,
): void {
  const issuedAtMs = Date.now();
  const accessExpiresAtMs =
    parseJwtExpMs(session.access_token) ?? issuedAtMs + SESSION_BRIDGE_ACCESS_TTL_MS;

  const envelope: SessionBridgeEnvelope = {
    kind: "session",
    schemaVersion: SESSION_BRIDGE_SCHEMA_VERSION,
    issuedAtMs,
    accessExpiresAtMs,
    userId: session.user.id,
    email: session.user.email ?? null,
    role: options.role,
    supabaseUrl: options.supabaseUrl,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
  };

  if (!sendToChromeExtension(envelope)) {
    dispatchDomFallback(envelope);
  }
}

export function invalidateSessionBridge(
  reason: "logout" | "lock" | "session_expired" | "unknown" = "logout",
): void {
  const envelope: SessionBridgeEnvelope = {
    kind: "invalidated",
    schemaVersion: SESSION_BRIDGE_SCHEMA_VERSION,
    issuedAtMs: Date.now(),
    reason,
  };
  if (!sendToChromeExtension(envelope)) {
    dispatchDomFallback(envelope);
  }
}
