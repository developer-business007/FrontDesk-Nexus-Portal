import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireStaff } from "../_shared/auth.ts";
import { jsonResponse, optionsResponse } from "../_shared/cors.ts";
import {
  encryptSynxisSecret,
  loadSynxisIntegration,
  loadSynxisPropertyConfig,
  SYNXIS_INTEGRATION_KEY,
  type SynxisIntegrationValue,
} from "../_shared/synxis-secrets.ts";
import {
  normalizeSynxisCookieHeader,
  SYNXIS_SESSION_KEY,
} from "../_shared/synxis-session.ts";
import { validateSynxisCookieHeader } from "../_shared/synxis-room-sync.ts";

type SaveBody = {
  action?: string;
  username?: string;
  password?: string;
  gmailAddress?: string;
  gmailAppPassword?: string;
  propertyId?: string;
  chainId?: string;
  cookieHeader?: string;
  source?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: SaveBody;
  try {
    body = (await req.json()) as SaveBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  // Most actions are admin-only. Cookie save is allowed for normal staff so the
  // extension can persist the latest SynXis session as a fallback.
  const auth = await requireStaff(
    req,
    body.action === "saveSession" ? "front_desk" : "admin",
  );
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  if (body.action === "status") {
    try {
      const integration = await loadSynxisIntegration(auth.serviceClient);
      const { data: sessionRow } = await auth.serviceClient
        .from("app_settings")
        .select("value")
        .eq("key", SYNXIS_SESSION_KEY)
        .maybeSingle();
      const session = sessionRow?.value as Record<string, unknown> | undefined;
      const sessionRefreshedAt =
        typeof session?.refreshedAt === "string" ? session.refreshedAt : null;
      const sessionSource =
        typeof session?.source === "string" && session.source.trim() ? session.source.trim() : null;
      const cookieHeader = normalizeSynxisCookieHeader(
        typeof session?.cookieHeader === "string" ? session.cookieHeader : "",
      );

      let sessionValid: boolean | null = null;
      if (cookieHeader) {
        try {
          const propertyConfig = await loadSynxisPropertyConfig(auth.serviceClient);
          sessionValid = await validateSynxisCookieHeader(cookieHeader, propertyConfig);
        } catch {
          sessionValid = false;
        }
      }

      return jsonResponse({
        configured: Boolean(
          integration?.passwordEncrypted && integration?.gmailAppPasswordEncrypted,
        ),
        username: integration?.username ?? null,
        gmailAddress: integration?.gmailAddress ?? null,
        propertyId: integration?.propertyId ?? null,
        chainId: integration?.chainId ?? null,
        updatedAt: integration?.updatedAt ?? null,
        sessionRefreshedAt,
        sessionSource,
        sessionValid,
        sessionSaved: Boolean(cookieHeader),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load status";
      return jsonResponse({ error: message }, 500);
    }
  }

  if (body.action === "testLogin") {
    try {
      const propertyConfig = await loadSynxisPropertyConfig(auth.serviceClient);
      const { data: sessionRow } = await auth.serviceClient
        .from("app_settings")
        .select("value")
        .eq("key", SYNXIS_SESSION_KEY)
        .maybeSingle();
      const session = sessionRow?.value as Record<string, unknown> | undefined;
      const cookieHeader = normalizeSynxisCookieHeader(
        typeof session?.cookieHeader === "string" ? session.cookieHeader : "",
      );

      if (!cookieHeader) {
        return jsonResponse({
          ok: false,
          error:
            "No SynXis session saved. Run the local sync agent on the hotel PC, or paste a browser cookie below.",
        });
      }

      const valid = await validateSynxisCookieHeader(cookieHeader, propertyConfig);
      if (!valid) {
        return jsonResponse({
          ok: false,
          error:
            "Saved SynXis session expired. Log into SynXis in your browser, paste a fresh cookie, or restart the local sync agent on the front-desk PC.",
        });
      }

      return jsonResponse({
        ok: true,
        refreshedAt: typeof session?.refreshedAt === "string" ? session.refreshedAt : null,
        source: typeof session?.source === "string" ? session.source : null,
        cookieLength: cookieHeader.length,
        message: "Saved SynXis session is valid. Room sync runs from the hotel PC local agent.",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "SynXis session test failed";
      return jsonResponse({ ok: false, error: message });
    }
  }

  if (body.action === "saveSession") {
    const raw = typeof body.cookieHeader === "string" ? body.cookieHeader : "";
    const cookieHeader = normalizeSynxisCookieHeader(raw);
    if (!cookieHeader) {
      return jsonResponse({ error: "cookieHeader is required" }, 400);
    }

    try {
      const propertyConfig = await loadSynxisPropertyConfig(auth.serviceClient);
      const valid = await validateSynxisCookieHeader(cookieHeader, propertyConfig);
      if (!valid) {
        return jsonResponse({
          ok: false,
          error:
            "Cookie header failed SynXis validation. Log into SynXis in your browser and copy a fresh Cookie header.",
        });
      }

      const refreshedAt = new Date().toISOString();
      const source =
        body.source === "extension" || body.source === "manual" || body.source === "auto"
          ? body.source
          : "manual";
      const { error: upsertError } = await auth.serviceClient
        .from("app_settings")
        .upsert(
          {
            key: SYNXIS_SESSION_KEY,
            value: { cookieHeader, refreshedAt, source },
            updated_at: refreshedAt,
          },
          { onConflict: "key" },
        );

      if (upsertError) {
        return jsonResponse({ error: upsertError.message }, 500);
      }

      const { error: auditError } = await auth.serviceClient.from("audit_log").insert({
        action_type: "synxis_session_saved",
        user_id: auth.userId,
        username: auth.email,
        user_role: auth.role,
        description: `SynXis session cookie saved (${source})`,
        new_value: { refreshedAt, source, cookieLength: cookieHeader.length },
      });
      if (auditError) {
        console.warn("[save-synxis-credentials] audit log failed:", auditError.message);
      }

      return jsonResponse({ ok: true, refreshedAt, source });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to save session";
      return jsonResponse({ error: message }, 500);
    }
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const gmailAddress = typeof body.gmailAddress === "string" ? body.gmailAddress.trim() : "";
  const gmailAppPassword =
    typeof body.gmailAppPassword === "string" ? body.gmailAppPassword : "";

  if (!username || !gmailAddress) {
    return jsonResponse({ error: "username and gmailAddress are required" }, 400);
  }

  try {
    const existing = await loadSynxisIntegration(auth.serviceClient);
    const hasStoredSecrets = Boolean(
      existing?.passwordEncrypted && existing?.gmailAppPasswordEncrypted,
    );

    if (!hasStoredSecrets && (!password || !gmailAppPassword)) {
      return jsonResponse(
        { error: "password and gmailAppPassword are required for initial setup" },
        400,
      );
    }

    if (hasStoredSecrets && (password || gmailAppPassword) && (!password || !gmailAppPassword)) {
      return jsonResponse(
        { error: "Provide both password and gmailAppPassword to rotate secrets" },
        400,
      );
    }

    const passwordEncrypted = password
      ? await encryptSynxisSecret(password)
      : existing!.passwordEncrypted!;
    const gmailAppPasswordEncrypted = gmailAppPassword
      ? await encryptSynxisSecret(gmailAppPassword)
      : existing!.gmailAppPasswordEncrypted!;
    const updatedAt = new Date().toISOString();
    const value: SynxisIntegrationValue = {
      username,
      passwordEncrypted,
      gmailAddress,
      gmailAppPasswordEncrypted,
      propertyId:
        typeof body.propertyId === "string" && body.propertyId.trim()
          ? body.propertyId.trim()
          : existing?.propertyId ?? "93302",
      chainId:
        typeof body.chainId === "string" && body.chainId.trim()
          ? body.chainId.trim()
          : existing?.chainId ?? "5136",
      shsTag: existing?.shsTag ?? "3d41862e94058d16432e263a354fe8c1",
      updatedAt,
    };

    const { error: upsertError } = await auth.serviceClient
      .from("app_settings")
      .upsert(
        {
          key: SYNXIS_INTEGRATION_KEY,
          value,
          updated_at: updatedAt,
        },
        { onConflict: "key" },
      );

    if (upsertError) {
      return jsonResponse({ error: upsertError.message }, 500);
    }

    const { error: auditError } = await auth.serviceClient.from("audit_log").insert({
      action_type: "synxis_credentials_updated",
      user_id: auth.userId,
      username: auth.email,
      user_role: auth.role,
      description: password || gmailAppPassword
        ? "SynXis credentials updated (passwords stored encrypted)"
        : "SynXis settings updated (property/chain/username/gmail)",
      new_value: {
        username: value.username,
        gmailAddress: value.gmailAddress,
        propertyId: value.propertyId,
        chainId: value.chainId,
        updatedAt,
      },
    });
    if (auditError) {
      console.warn("[save-synxis-credentials] audit log failed:", auditError.message);
    }

    return jsonResponse({ ok: true, configured: true, updatedAt });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save credentials";
    console.error("[save-synxis-credentials]", message);
    return jsonResponse({ error: message }, 500);
  }
});