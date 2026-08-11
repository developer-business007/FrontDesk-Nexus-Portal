/**
 * Backblaze B2 native API (works with Master Application Key and app keys).
 * Secrets: B2_BUCKET, B2_KEY_ID, B2_APPLICATION_KEY
 * Optional (unused by native API, kept for compatibility): B2_ENDPOINT, B2_REGION
 */
export const STORAGE_CATEGORIES = [
  "id-images",
  "signature-pdfs",
  "guest-signatures",
] as const;

export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

/** Legacy Supabase bucket name still referenced by older rows / readers. */
export function normalizeCategory(raw: string): StorageCategory | null {
  const c = raw.trim();
  if (c === "id-scans") return "id-images";
  if ((STORAGE_CATEGORIES as readonly string[]).includes(c)) {
    return c as StorageCategory;
  }
  return null;
}

export function objectKeyFor(category: StorageCategory, objectPath: string): string {
  const path = objectPath.replace(/^\/+/, "").trim();
  if (!path || path.includes("..")) {
    throw new Error("Invalid object path");
  }
  return `${category}/${path}`;
}

type B2Config = {
  bucket: string;
  keyId: string;
  applicationKey: string;
};

export type B2Auth = {
  accountId: string;
  apiUrl: string;
  authorizationToken: string;
  downloadUrl: string;
  bucketId: string;
  bucketName: string;
};

let cachedAuth: { auth: B2Auth; expiresAt: number } | null = null;

export function loadB2Config(): B2Config {
  const bucket = (Deno.env.get("B2_BUCKET") ?? "").trim();
  const keyId = (Deno.env.get("B2_KEY_ID") ?? "").trim();
  const applicationKey = (Deno.env.get("B2_APPLICATION_KEY") ?? "").trim();
  if (!bucket || !keyId || !applicationKey) {
    throw new Error("Missing B2_BUCKET, B2_KEY_ID, or B2_APPLICATION_KEY");
  }
  return { bucket, keyId, applicationKey };
}

function basicAuthHeader(keyId: string, applicationKey: string): string {
  const raw = `${keyId}:${applicationKey}`;
  const bytes = new TextEncoder().encode(raw);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return `Basic ${btoa(bin)}`;
}

async function resolveBucketId(
  apiUrl: string,
  authorizationToken: string,
  accountId: string,
  bucketName: string,
  allowedBucketId: string | null,
): Promise<string> {
  if (allowedBucketId) return allowedBucketId;

  const res = await fetch(`${apiUrl}/b2api/v2/b2_list_buckets`, {
    method: "POST",
    headers: {
      Authorization: authorizationToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ accountId }),
  });
  const data = (await res.json()) as {
    buckets?: Array<{ bucketId: string; bucketName: string }>;
    message?: string;
  };
  if (!res.ok) {
    throw new Error(data.message ?? `b2_list_buckets failed (HTTP ${res.status})`);
  }
  const match = (data.buckets ?? []).find((b) => b.bucketName === bucketName);
  if (!match) {
    throw new Error(`B2 bucket not found: ${bucketName}`);
  }
  return match.bucketId;
}

export async function getB2Auth(): Promise<B2Auth> {
  if (cachedAuth && cachedAuth.expiresAt > Date.now()) {
    return cachedAuth.auth;
  }

  const cfg = loadB2Config();
  const res = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
    method: "GET",
    headers: { Authorization: basicAuthHeader(cfg.keyId, cfg.applicationKey) },
  });
  const data = (await res.json()) as {
    accountId?: string;
    apiUrl?: string;
    authorizationToken?: string;
    downloadUrl?: string;
    allowed?: { bucketId?: string | null };
    message?: string;
  };
  if (
    !res.ok ||
    !data.accountId ||
    !data.apiUrl ||
    !data.authorizationToken ||
    !data.downloadUrl
  ) {
    throw new Error(
      data.message ??
        `b2_authorize_account failed (HTTP ${res.status}). Check B2_KEY_ID and B2_APPLICATION_KEY.`,
    );
  }

  const bucketId = await resolveBucketId(
    data.apiUrl,
    data.authorizationToken,
    data.accountId,
    cfg.bucket,
    data.allowed?.bucketId ?? null,
  );

  const auth: B2Auth = {
    accountId: data.accountId,
    apiUrl: data.apiUrl,
    authorizationToken: data.authorizationToken,
    downloadUrl: data.downloadUrl.replace(/\/$/, ""),
    bucketId,
    bucketName: cfg.bucket,
  };
  cachedAuth = { auth, expiresAt: Date.now() + 50 * 60 * 1000 };
  return auth;
}

/** Native B2 upload target for browser/extension direct upload. */
export async function createNativeUpload(opts: {
  objectKey: string;
  contentType: string;
}): Promise<{
  uploadUrl: string;
  authorizationToken: string;
  fileName: string;
  contentType: string;
  objectKey: string;
}> {
  const auth = await getB2Auth();
  const res = await fetch(`${auth.apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: "POST",
    headers: {
      Authorization: auth.authorizationToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ bucketId: auth.bucketId }),
  });
  const data = (await res.json()) as {
    uploadUrl?: string;
    authorizationToken?: string;
    message?: string;
  };
  if (!res.ok || !data.uploadUrl || !data.authorizationToken) {
    cachedAuth = null;
    throw new Error(data.message ?? `b2_get_upload_url failed (HTTP ${res.status})`);
  }
  return {
    uploadUrl: data.uploadUrl,
    authorizationToken: data.authorizationToken,
    fileName: opts.objectKey,
    contentType: opts.contentType,
    objectKey: opts.objectKey,
  };
}

export async function createDownloadUrl(opts: {
  objectKey: string;
  expiresSeconds?: number;
}): Promise<string> {
  const auth = await getB2Auth();
  const expires = Math.min(Math.max(opts.expiresSeconds ?? 600, 60), 86400);

  const res = await fetch(`${auth.apiUrl}/b2api/v2/b2_get_download_authorization`, {
    method: "POST",
    headers: {
      Authorization: auth.authorizationToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      bucketId: auth.bucketId,
      fileNamePrefix: opts.objectKey,
      validDurationInSeconds: expires,
    }),
  });
  const data = (await res.json()) as {
    authorizationToken?: string;
    message?: string;
  };
  if (!res.ok || !data.authorizationToken) {
    cachedAuth = null;
    throw new Error(data.message ?? `b2_get_download_authorization failed (HTTP ${res.status})`);
  }

  const encodedName = opts.objectKey
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const url = new URL(
    `${auth.downloadUrl}/file/${encodeURIComponent(auth.bucketName)}/${encodedName}`,
  );
  url.searchParams.set("Authorization", data.authorizationToken);
  return url.toString();
}

export async function headObject(objectKey: string): Promise<{
  exists: boolean;
  contentLength: number | null;
  contentType: string | null;
}> {
  const auth = await getB2Auth();
  const res = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_file_names`, {
    method: "POST",
    headers: {
      Authorization: auth.authorizationToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      bucketId: auth.bucketId,
      startFileName: objectKey,
      maxFileCount: 1,
      prefix: objectKey,
    }),
  });
  const data = (await res.json()) as {
    files?: Array<{ fileName: string; contentLength?: number; contentType?: string }>;
    message?: string;
  };
  if (!res.ok) {
    throw new Error(data.message ?? `b2_list_file_names failed (HTTP ${res.status})`);
  }
  const file = data.files?.[0];
  if (!file || file.fileName !== objectKey) {
    return { exists: false, contentLength: null, contentType: null };
  }
  return {
    exists: true,
    contentLength: typeof file.contentLength === "number" ? file.contentLength : null,
    contentType: file.contentType ?? null,
  };
}
