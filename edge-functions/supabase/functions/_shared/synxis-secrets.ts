import { type SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { EncryptedPayload } from "./ezee-secrets.ts";
import { decryptAuthCode, encryptAuthCode } from "./ezee-secrets.ts";

export const SYNXIS_INTEGRATION_KEY = "synxis_integration";

export type SynxisIntegrationValue = {
  username: string;
  passwordEncrypted: EncryptedPayload | null;
  gmailAddress: string;
  gmailAppPasswordEncrypted: EncryptedPayload | null;
  propertyId: string;
  chainId: string;
  shsTag: string;
  updatedAt?: string;
};

export function parseSynxisIntegrationValue(raw: unknown): SynxisIntegrationValue | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const username = typeof o.username === "string" ? o.username.trim() : "";
  const gmailAddress = typeof o.gmailAddress === "string" ? o.gmailAddress.trim() : "";
  if (!username || !gmailAddress) return null;

  const passwordEncrypted =
    o.passwordEncrypted && typeof o.passwordEncrypted === "object"
      ? (o.passwordEncrypted as EncryptedPayload)
      : null;
  const gmailAppPasswordEncrypted =
    o.gmailAppPasswordEncrypted && typeof o.gmailAppPasswordEncrypted === "object"
      ? (o.gmailAppPasswordEncrypted as EncryptedPayload)
      : null;

  return {
    username,
    passwordEncrypted,
    gmailAddress,
    gmailAppPasswordEncrypted,
    propertyId: typeof o.propertyId === "string" && o.propertyId.trim() ? o.propertyId.trim() : "93302",
    chainId: typeof o.chainId === "string" && o.chainId.trim() ? o.chainId.trim() : "5136",
    shsTag:
      typeof o.shsTag === "string" && o.shsTag.trim()
        ? o.shsTag.trim()
        : "3d41862e94058d16432e263a354fe8c1",
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : undefined,
  };
}

export async function loadSynxisIntegration(
  serviceClient: SupabaseClient,
): Promise<SynxisIntegrationValue | null> {
  const { data, error } = await serviceClient
    .from("app_settings")
    .select("value")
    .eq("key", SYNXIS_INTEGRATION_KEY)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return parseSynxisIntegrationValue(data?.value);
}

export async function resolveSynxisCredentials(
  integration: SynxisIntegrationValue | null,
): Promise<{
  username: string;
  password: string;
  gmailAddress: string;
  gmailAppPassword: string;
  propertyId: string;
  chainId: string;
  shsTag: string;
}> {
  if (!integration?.passwordEncrypted || !integration.gmailAppPasswordEncrypted) {
    throw new Error("SynXis credentials are not configured in Admin → Settings");
  }
  const password = await decryptAuthCode(integration.passwordEncrypted);
  const gmailAppPassword = await decryptAuthCode(integration.gmailAppPasswordEncrypted);
  return {
    username: integration.username,
    password,
    gmailAddress: integration.gmailAddress,
    gmailAppPassword,
    propertyId: integration.propertyId,
    chainId: integration.chainId,
    shsTag: integration.shsTag,
  };
}

export async function encryptSynxisSecret(value: string): Promise<EncryptedPayload> {
  return encryptAuthCode(value);
}

export type SynxisPropertyConfig = {
  propertyId: string;
  chainId: string;
};

/** Property/chain from Admin → Settings, then env, then defaults. */
export async function loadSynxisPropertyConfig(
  serviceClient: SupabaseClient,
): Promise<SynxisPropertyConfig> {
  const integration = await loadSynxisIntegration(serviceClient);
  return {
    propertyId:
      integration?.propertyId ??
      Deno.env.get("SYNXIS_PROPERTY_ID")?.trim() ??
      "93302",
    chainId:
      integration?.chainId ??
      Deno.env.get("SYNXIS_CHAIN_ID")?.trim() ??
      "5136",
  };
}
