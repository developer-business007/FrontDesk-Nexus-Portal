import { type SupabaseClient } from "npm:@supabase/supabase-js@2";

export type EncryptedPayload = {
  v: 1;
  alg: "AES-256-GCM";
  iv: string;
  ciphertext: string;
};

export type EzeeIntegrationValue = {
  hotelCode: number;
  authCodeEncrypted: EncryptedPayload | null;
  updatedAt?: string;
};

export const EZEE_INTEGRATION_KEY = "ezee_integration";
export const EZEE_KIOSK_URL = "https://live.ipms247.com/index.php/page/service.kioskconnectivity";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

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

async function getSecretsKey(): Promise<CryptoKey> {
  const b64 = Deno.env.get("EZEE_SECRETS_KEY")?.trim();
  if (!b64) throw new Error("EZEE_SECRETS_KEY is not configured on the server");
  const raw = base64ToBytes(b64);
  if (raw.length !== 32) {
    throw new Error("EZEE_SECRETS_KEY must be a base64-encoded 32-byte key");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptAuthCode(authCode: string): Promise<EncryptedPayload> {
  const trimmed = authCode.trim();
  if (!trimmed) throw new Error("Auth code is required");

  const key = await getSecretsKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify({ authCode: trimmed }));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  return {
    v: 1,
    alg: "AES-256-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptAuthCode(payload: EncryptedPayload): Promise<string> {
  const key = await getSecretsKey();
  const iv = base64ToBytes(payload.iv);
  const ciphertext = base64ToBytes(payload.ciphertext);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as { authCode?: string };
  const authCode = parsed.authCode?.trim();
  if (!authCode) throw new Error("Decrypted auth code is empty");
  return authCode;
}

export function parseEzeeIntegrationValue(raw: unknown): EzeeIntegrationValue | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const hotelCode = Number(o.hotelCode);
  if (!Number.isFinite(hotelCode) || hotelCode <= 0) return null;
  const authCodeEncrypted = isEncryptedPayload(o.authCodeEncrypted) ? o.authCodeEncrypted : null;
  const updatedAt = typeof o.updatedAt === "string" ? o.updatedAt : undefined;
  return { hotelCode, authCodeEncrypted, updatedAt };
}

export async function loadEzeeIntegration(
  serviceClient: SupabaseClient,
): Promise<EzeeIntegrationValue | null> {
  const { data, error } = await serviceClient
    .from("app_settings")
    .select("value")
    .eq("key", EZEE_INTEGRATION_KEY)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return parseEzeeIntegrationValue(data?.value);
}

export async function resolveEzeeCredentials(
  integration: EzeeIntegrationValue | null,
): Promise<{ hotelCode: number; authCode: string }> {
  if (!integration?.authCodeEncrypted) {
    throw new Error("eZee credentials are not configured");
  }
  const authCode = await decryptAuthCode(integration.authCodeEncrypted);
  return { hotelCode: integration.hotelCode, authCode };
}
