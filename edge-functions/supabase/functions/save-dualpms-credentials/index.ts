import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireStaff } from "../_shared/auth.ts";
import { jsonResponse, optionsResponse } from "../_shared/cors.ts";
import {
  DUALPMS_INTEGRATION_KEY,
  encryptDualPmsSecret,
  loadDualPmsIntegration,
  resolveDualPmsCredentials,
  type DualPmsIntegrationValue,
} from "../_shared/dualpms-secrets.ts";
import { testDualPmsConnection } from "../_shared/dualpms-ssh-exec.ts";

type SaveBody = {
  action?: string;
  host?: string;
  port?: number | string;
  username?: string;
  password?: string;
  privateKey?: string;
  database?: string;
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
      const integration = await loadDualPmsIntegration(auth.serviceClient);
      return jsonResponse({
        configured: Boolean(
          integration?.passwordEncrypted || integration?.privateKeyEncrypted,
        ),
        host: integration?.host ?? null,
        port: integration?.port ?? null,
        username: integration?.username ?? null,
        database: integration?.database ?? null,
        updatedAt: integration?.updatedAt ?? null,
        hasPassword: Boolean(integration?.passwordEncrypted),
        hasPrivateKey: Boolean(integration?.privateKeyEncrypted),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load status";
      return jsonResponse({ error: message }, 500);
    }
  }

  if (body.action === "testConnection") {
    try {
      const integration = await loadDualPmsIntegration(auth.serviceClient);
      const config = await resolveDualPmsCredentials(integration);
      await testDualPmsConnection(config);
      return jsonResponse({
        ok: true,
        message: `Connected to ${config.host} and read DualPMS database (${config.database}).`,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Connection test failed";
      return jsonResponse({ ok: false, error: message });
    }
  }

  const host = typeof body.host === "string" ? body.host.trim() : "";
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const privateKey = typeof body.privateKey === "string" ? body.privateKey.trim() : "";
  const database =
    typeof body.database === "string" && body.database.trim() ? body.database.trim() : "hotel";
  const port = Number(body.port);

  if (!host || !username) {
    return jsonResponse({ error: "host and username are required" }, 400);
  }

  try {
    const existing = await loadDualPmsIntegration(auth.serviceClient);
    const passwordEncrypted =
      password.trim()
        ? await encryptDualPmsSecret(password)
        : existing?.passwordEncrypted ?? null;
    const privateKeyEncrypted =
      privateKey.trim()
        ? await encryptDualPmsSecret(privateKey)
        : existing?.privateKeyEncrypted ?? null;

    if (!passwordEncrypted && !privateKeyEncrypted) {
      return jsonResponse(
        { error: "password or privateKey is required (leave blank only when updating other fields)" },
        400,
      );
    }

    const updatedAt = new Date().toISOString();
    const value: DualPmsIntegrationValue = {
      host,
      port: Number.isFinite(port) && port > 0 ? Math.floor(port) : existing?.port ?? 22,
      username,
      database,
      passwordEncrypted,
      privateKeyEncrypted,
      updatedAt,
    };

    const { error: upsertError } = await auth.serviceClient
      .from("app_settings")
      .upsert(
        {
          key: DUALPMS_INTEGRATION_KEY,
          value,
          updated_at: updatedAt,
        },
        { onConflict: "key" },
      );

    if (upsertError) {
      return jsonResponse({ error: upsertError.message }, 500);
    }

    const { error: auditError } = await auth.serviceClient.from("audit_log").insert({
      action_type: "dualpms_credentials_updated",
      user_id: auth.userId,
      username: auth.email,
      user_role: auth.role,
      description: "DualPMS VPS SSH credentials updated (secrets stored encrypted)",
      new_value: {
        host: value.host,
        port: value.port,
        username: value.username,
        database: value.database,
        hasPassword: Boolean(value.passwordEncrypted),
        hasPrivateKey: Boolean(value.privateKeyEncrypted),
        updatedAt,
      },
    });
    if (auditError) {
      console.warn("[save-dualpms-credentials] audit log failed:", auditError.message);
    }

    return jsonResponse({ ok: true, configured: true, updatedAt });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save credentials";
    console.error("[save-dualpms-credentials]", message);
    return jsonResponse({ error: message }, 500);
  }
});
