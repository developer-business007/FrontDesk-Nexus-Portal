import { supabase } from "@/lib/supabase";
import { resolveEdgeFunctionError } from "@/lib/edgeFunctionError";

export type EzeeIntegrationStatus = {
  configured: boolean;
  hotelCode: number | null;
  updatedAt: string | null;
};

export type EzeeConnectionTestResult = {
  ok: boolean;
  error: string | null;
  message: string | null;
  roomCount: number | null;
};

function parseStatusPayload(data: unknown): EzeeIntegrationStatus | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (typeof row.error === "string" && row.error.trim()) {
    throw new Error(row.error);
  }
  return {
    configured: row.configured === true,
    hotelCode: typeof row.hotelCode === "number" && Number.isFinite(row.hotelCode) ? row.hotelCode : null,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
  };
}

export async function fetchEzeeIntegrationStatus(): Promise<{
  data: EzeeIntegrationStatus | null;
  error: string | null;
}> {
  const { data, error } = await supabase.functions.invoke("save-ezee-credentials", {
    body: { action: "status" },
  });
  if (error) {
    return { data: null, error: await resolveEdgeFunctionError(error, data) };
  }
  try {
    return { data: parseStatusPayload(data), error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : "Failed to load eZee status" };
  }
}

export async function saveEzeeCredentials(
  hotelCode: number,
  authCode: string,
): Promise<{ ok: boolean; error: string | null }> {
  const { data, error } = await supabase.functions.invoke("save-ezee-credentials", {
    body: { action: "save", hotelCode, authCode },
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
  if (row.ok !== true) {
    return { ok: false, error: "Save failed" };
  }
  return { ok: true, error: null };
}

export async function testEzeeConnection(input?: {
  hotelCode?: number;
  authCode?: string;
}): Promise<EzeeConnectionTestResult> {
  const { data, error } = await supabase.functions.invoke("save-ezee-credentials", {
    body: {
      action: "testConnection",
      hotelCode: input?.hotelCode,
      authCode: input?.authCode,
    },
  });
  if (error) {
    return {
      ok: false,
      error: await resolveEdgeFunctionError(error, data),
      message: null,
      roomCount: null,
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "Invalid server response", message: null, roomCount: null };
  }
  const row = data as Record<string, unknown>;
  if (typeof row.error === "string" && row.error.trim()) {
    return { ok: false, error: row.error, message: null, roomCount: null };
  }
  if (row.ok !== true) {
    return { ok: false, error: "Connection test failed", message: null, roomCount: null };
  }
  const roomCount = typeof row.roomCount === "number" ? row.roomCount : null;
  const message =
    typeof row.message === "string" && row.message.trim()
      ? row.message
      : roomCount != null
        ? `eZee API connected — ${roomCount} rooms returned.`
        : "eZee API connected.";
  return { ok: true, error: null, message, roomCount };
}
