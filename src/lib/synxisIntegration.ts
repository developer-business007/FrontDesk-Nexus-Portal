import { supabase } from "@/lib/supabase";
import { resolveEdgeFunctionError } from "@/lib/edgeFunctionError";

export type SynxisSessionSource = "manual" | "extension" | "auto" | string;

export type SynxisIntegrationStatus = {
  configured: boolean;
  username: string | null;
  gmailAddress: string | null;
  propertyId: string | null;
  chainId: string | null;
  updatedAt: string | null;
  sessionRefreshedAt: string | null;
  sessionSource: SynxisSessionSource | null;
  sessionValid: boolean | null;
  sessionSaved: boolean;
};

export type SynxisLoginTestResult = {
  ok: boolean;
  error: string | null;
  message: string | null;
  refreshedAt: string | null;
};

function parseStatusPayload(data: unknown): SynxisIntegrationStatus | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (typeof row.error === "string" && row.error.trim()) {
    throw new Error(row.error);
  }
  return {
    configured: row.configured === true,
    username: typeof row.username === "string" ? row.username : null,
    gmailAddress: typeof row.gmailAddress === "string" ? row.gmailAddress : null,
    propertyId: typeof row.propertyId === "string" ? row.propertyId : null,
    chainId: typeof row.chainId === "string" ? row.chainId : null,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    sessionRefreshedAt:
      typeof row.sessionRefreshedAt === "string" ? row.sessionRefreshedAt : null,
    sessionSource: typeof row.sessionSource === "string" ? row.sessionSource : null,
    sessionValid: typeof row.sessionValid === "boolean" ? row.sessionValid : null,
    sessionSaved: row.sessionSaved === true,
  };
}

export function formatSynxisSessionSource(source: SynxisSessionSource | null): string {
  if (!source) return "—";
  if (source === "extension") return "Chrome extension";
  if (source === "manual") return "Manual paste";
  if (source === "auto") return "Auto login";
  return source;
}

export async function fetchSynxisIntegrationStatus(): Promise<{
  data: SynxisIntegrationStatus | null;
  error: string | null;
}> {
  const { data, error } = await supabase.functions.invoke("save-synxis-credentials", {
    body: { action: "status" },
  });
  if (error) {
    return { data: null, error: await resolveEdgeFunctionError(error, data) };
  }
  try {
    return { data: parseStatusPayload(data), error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : "Failed to load SynXis status" };
  }
}

export async function saveSynxisCredentials(input: {
  username: string;
  password?: string;
  gmailAddress: string;
  gmailAppPassword?: string;
  propertyId?: string;
  chainId?: string;
}): Promise<{ ok: boolean; error: string | null }> {
  const { data, error } = await supabase.functions.invoke("save-synxis-credentials", {
    body: input,
  });
  if (error) {
    return { ok: false, error: await resolveEdgeFunctionError(error, data) };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "Invalid server response" };
  }
  const row = data as Record<string, unknown>;
  if (typeof row.error === "string" && row.error.trim()) {
    return { ok: false, error: row.error };
  }
  if (row.ok !== true) return { ok: false, error: "Save failed" };
  return { ok: true, error: null };
}

export async function testSynxisLogin(): Promise<SynxisLoginTestResult> {
  const { data, error } = await supabase.functions.invoke("save-synxis-credentials", {
    body: { action: "testLogin" },
  });
  if (error) {
    return {
      ok: false,
      error: await resolveEdgeFunctionError(error, data),
      message: null,
      refreshedAt: null,
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "Invalid server response", message: null, refreshedAt: null };
  }
  const row = data as Record<string, unknown>;
  if (typeof row.error === "string" && row.error.trim()) {
    return { ok: false, error: row.error, message: null, refreshedAt: null };
  }
  if (row.ok !== true) {
    return { ok: false, error: "Login test failed", message: null, refreshedAt: null };
  }
  const refreshedAt = typeof row.refreshedAt === "string" ? row.refreshedAt : null;
  const source = typeof row.source === "string" ? row.source : null;
  const message =
    typeof row.message === "string" && row.message.trim()
      ? row.message
      : refreshedAt
        ? `SynXis session is valid${source ? ` (${source})` : ""}. Last refreshed ${new Date(refreshedAt).toLocaleString()}.`
        : "SynXis session is valid.";
  return { ok: true, error: null, message, refreshedAt };
}

export async function saveSynxisSessionCookie(
  cookieHeader: string,
): Promise<{ ok: boolean; error: string | null }> {
  const { data, error } = await supabase.functions.invoke("save-synxis-credentials", {
    body: { action: "saveSession", cookieHeader },
  });
  if (error) {
    return { ok: false, error: await resolveEdgeFunctionError(error, data) };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "Invalid server response" };
  }
  const row = data as Record<string, unknown>;
  if (typeof row.error === "string" && row.error.trim()) {
    return { ok: false, error: row.error };
  }
  return { ok: row.ok === true, error: row.ok === true ? null : "Save failed" };
}
