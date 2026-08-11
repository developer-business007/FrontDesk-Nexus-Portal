const ENV_KEY_B64: string | undefined = import.meta.env.VITE_PII_ENCRYPTION_KEY

let _cachedKey: CryptoKey | null = null

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  // Make a real ArrayBuffer copy to satisfy TS environments that type Uint8Array.buffer as ArrayBufferLike.
  const copy = new Uint8Array(u8.byteLength)
  copy.set(u8)
  return copy.buffer
}

/** Same shape as extension `encryptJson` / `id_scans.pii_encrypted` JSONB. */
export type EncryptedPayload = {
  v: 1
  alg: "AES-256-GCM"
  iv: string
  ciphertext: string
}

export function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!value || typeof value !== "object") return false
  const o = value as Record<string, unknown>
  return (
    o.v === 1 &&
    o.alg === "AES-256-GCM" &&
    typeof o.iv === "string" &&
    typeof o.ciphertext === "string"
  )
}

async function getAesKey(): Promise<CryptoKey> {
  if (_cachedKey) return _cachedKey
  if (!ENV_KEY_B64) throw new Error("VITE_PII_ENCRYPTION_KEY is not configured")
  const raw = Uint8Array.from(atob(ENV_KEY_B64), (c) => c.charCodeAt(0))
  _cachedKey = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"])
  return _cachedKey
}

/** Decrypts JSON written by the extension (`encryptJson`) — PII / phone / email blobs on `id_scans`. */
export async function decryptJson<T = unknown>(payload: EncryptedPayload): Promise<T> {
  const key = await getAesKey()
  const iv = Uint8Array.from(atob(payload.iv), (c) => c.charCodeAt(0))
  const ciphertext = Uint8Array.from(atob(payload.ciphertext), (c) => c.charCodeAt(0))
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext)
  return JSON.parse(new TextDecoder().decode(plain)) as T
}

/**
 * SHA-256 hex of normalized ID number — identical algorithm to the extension's hashIdNumber.
 * Strips whitespace, uppercases, then hashes. Ensures manual entries match future scans.
 */
export async function hashIdNumber(idNumber: string): Promise<string> {
  const norm = idNumber.replace(/\s+/g, '').toUpperCase()
  const data = new TextEncoder().encode(norm)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Decrypts bytes written by the extension's encryptBinary(): [12-byte IV ‖ AES-GCM ciphertext] → plaintext. */
export async function decryptBinary(data: Uint8Array): Promise<Uint8Array> {
  const key = await getAesKey()
  const iv = data.subarray(0, 12)
  const ciphertext = data.subarray(12)
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ciphertext),
  )
  return new Uint8Array(plain)
}
