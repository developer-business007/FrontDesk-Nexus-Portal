import { type SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { EncryptedPayload } from "./ezee-secrets.ts";
import { decryptAuthCode, encryptAuthCode } from "./ezee-secrets.ts";

export const DUALPMS_INTEGRATION_KEY = "dualpms_integration";

export type DualPmsIntegrationValue = {
  host: string;
  port: number;
  username: string;
  database: string;
  passwordEncrypted: EncryptedPayload | null;
  privateKeyEncrypted: EncryptedPayload | null;
  updatedAt?: string;
};

export type DualPmsSshConfig = {
  host: string;
  port: number;
  username: string;
  database: string;
  password?: string;
  privateKey?: string;
};

function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    o.v === 1 &&
    o.alg === "AES-256-GCM" &&
    typeof o.iv === "string" &&
    typeof o.ciphertext === "string"
  );
}

export function parseDualPmsIntegrationValue(raw: unknown): DualPmsIntegrationValue | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const host = typeof o.host === "string" ? o.host.trim() : "";
  const username = typeof o.username === "string" ? o.username.trim() : "";
  if (!host || !username) return null;

  const port = Number(o.port);
  const database =
    typeof o.database === "string" && o.database.trim() ? o.database.trim() : "hotel";

  return {
    host,
    port: Number.isFinite(port) && port > 0 ? Math.floor(port) : 22,
    username,
    database,
    passwordEncrypted: isEncryptedPayload(o.passwordEncrypted) ? o.passwordEncrypted : null,
    privateKeyEncrypted: isEncryptedPayload(o.privateKeyEncrypted) ? o.privateKeyEncrypted : null,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : undefined,
  };
}

export async function loadDualPmsIntegration(
  serviceClient: SupabaseClient,
): Promise<DualPmsIntegrationValue | null> {
  const { data, error } = await serviceClient
    .from("app_settings")
    .select("value")
    .eq("key", DUALPMS_INTEGRATION_KEY)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return parseDualPmsIntegrationValue(data?.value);
}

export async function resolveDualPmsCredentials(
  integration: DualPmsIntegrationValue | null,
): Promise<DualPmsSshConfig> {
  if (!integration) {
    throw new Error("DualPMS VPS credentials are not configured in Admin → Settings");
  }

  const password = integration.passwordEncrypted
    ? await decryptAuthCode(integration.passwordEncrypted)
    : undefined;
  const privateKey = integration.privateKeyEncrypted
    ? await decryptAuthCode(integration.privateKeyEncrypted)
    : undefined;

  if (!password?.trim() && !privateKey?.trim()) {
    throw new Error("DualPMS VPS credentials are incomplete — save SSH password or private key");
  }

  return {
    host: integration.host,
    port: integration.port,
    username: integration.username,
    database: integration.database,
    password: password?.trim() || undefined,
    privateKey: privateKey?.trim() || undefined,
  };
}

export async function encryptDualPmsSecret(value: string): Promise<EncryptedPayload> {
  return encryptAuthCode(value);
}
