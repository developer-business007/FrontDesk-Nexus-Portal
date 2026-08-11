import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireStaff } from "../_shared/auth.ts";
import { jsonResponse, optionsResponse } from "../_shared/cors.ts";
import {
  EZEE_INTEGRATION_KEY,
  encryptAuthCode,
  loadEzeeIntegration,
  resolveEzeeCredentials,
  type EncryptedPayload,
} from "../_shared/ezee-secrets.ts";
import { syncEzeeRooms } from "../_shared/ezee-room-sync.ts";

type SaveBody = {
  action?: string;
  hotelCode?: number | string;
  authCode?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const auth = await requireStaff(req, "admin");
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  let body: SaveBody;
  try {
    body = (await req.json()) as SaveBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (body.action === "status") {
    try {
      const integration = await loadEzeeIntegration(auth.serviceClient);
      return jsonResponse({
        configured: Boolean(integration?.authCodeEncrypted),
        hotelCode: integration?.hotelCode ?? null,
        updatedAt: integration?.updatedAt ?? null,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load status";
      return jsonResponse({ error: message }, 500);
    }
  }

  if (body.action === "testConnection") {
    try {
      const integration = await loadEzeeIntegration(auth.serviceClient);
      const bodyHotelCode = Number(body.hotelCode);
      const bodyAuthCode = typeof body.authCode === "string" ? body.authCode.trim() : "";

      let hotelCode = Number.isFinite(bodyHotelCode) && bodyHotelCode > 0
        ? Math.floor(bodyHotelCode)
        : integration?.hotelCode ?? 0;
      let authCode = bodyAuthCode;

      if (!authCode) {
        const resolved = await resolveEzeeCredentials(integration);
        hotelCode = resolved.hotelCode;
        authCode = resolved.authCode;
      }

      if (!hotelCode || !authCode) {
        return jsonResponse({
          ok: false,
          error: "eZee credentials are not configured. Save hotel code and auth code first.",
        });
      }

      const result = await syncEzeeRooms(hotelCode, authCode, false);
      return jsonResponse({
        ok: true,
        hotelCode,
        roomCount: result.rooms.size,
        message: `eZee API connected — ${result.rooms.size} rooms returned.`,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "eZee connection test failed";
      return jsonResponse({ ok: false, error: message });
    }
  }

  if (body.action !== "save") {
    return jsonResponse({ error: "Unknown action" }, 400);
  }

  const hotelCode = Number(body.hotelCode);
  const authCode = typeof body.authCode === "string" ? body.authCode.trim() : "";
  if (!Number.isFinite(hotelCode) || hotelCode <= 0) {
    return jsonResponse({ error: "Valid hotelCode is required" }, 400);
  }
  if (!authCode) {
    return jsonResponse({ error: "authCode is required" }, 400);
  }

  try {
    const authCodeEncrypted: EncryptedPayload = await encryptAuthCode(authCode);
    const updatedAt = new Date().toISOString();
    const value = {
      hotelCode: Math.floor(hotelCode),
      authCodeEncrypted,
      updatedAt,
    };

    const { error: upsertError } = await auth.serviceClient
      .from("app_settings")
      .upsert(
        {
          key: EZEE_INTEGRATION_KEY,
          value,
          updated_at: updatedAt,
        },
        { onConflict: "key" },
      );

    if (upsertError) {
      return jsonResponse({ error: upsertError.message }, 500);
    }

    const { error: auditError } = await auth.serviceClient.from("audit_log").insert({
      action_type: "ezee_credentials_updated",
      user_id: auth.userId,
      username: auth.email,
      user_role: auth.role,
      description: "eZee API credentials updated (auth code stored encrypted)",
      new_value: { hotelCode: value.hotelCode, updatedAt },
    });
    if (auditError) {
      console.warn("[save-ezee-credentials] audit log failed:", auditError.message);
    }

    return jsonResponse({ ok: true, configured: true, hotelCode: value.hotelCode, updatedAt });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save credentials";
    console.error("[save-ezee-credentials]", message);
    return jsonResponse({ error: message }, 500);
  }
});
