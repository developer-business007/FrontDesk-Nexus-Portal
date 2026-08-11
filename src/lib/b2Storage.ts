import { supabase } from "@/lib/supabase";

export type StorageCategory = "id-images" | "signature-pdfs" | "guest-signatures";

type UploadUrlResponse = {
  uploadUrl?: string;
  authorizationToken?: string;
  fileName?: string;
  contentType?: string;
  objectKey?: string;
  uploadMode?: string;
  error?: string;
};

type DownloadUrlResponse = {
  downloadUrl?: string;
  objectKey?: string;
  missing?: boolean;
  error?: string;
};

function invokeErrorMessage(error: unknown, data: { error?: string } | null): string {
  if (data?.error) return data.error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: string }).message);
  }
  return "Storage request failed";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function toUint8Array(body: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await body.arrayBuffer());
}

/** Ask Edge Function for a short-lived B2 native upload target. */
export async function getStorageUploadUrl(args: {
  category: StorageCategory;
  objectPath: string;
  contentType: string;
  size?: number;
}): Promise<{
  uploadUrl: string;
  authorizationToken: string;
  fileName: string;
  contentType: string;
  objectKey: string;
}> {
  const { data, error } = await supabase.functions.invoke<UploadUrlResponse>(
    "storage-upload-url",
    {
      body: {
        category: args.category,
        objectPath: args.objectPath,
        contentType: args.contentType,
        size: args.size,
      },
    },
  );
  if (error || !data?.uploadUrl || !data.authorizationToken || !data.fileName) {
    throw new Error(invokeErrorMessage(error, data ?? null));
  }
  return {
    uploadUrl: data.uploadUrl,
    authorizationToken: data.authorizationToken,
    fileName: data.fileName,
    contentType: data.contentType ?? args.contentType,
    objectKey: data.objectKey ?? args.objectPath,
  };
}

/** Ask Edge Function for a short-lived B2 download URL. */
export async function getStorageDownloadUrl(args: {
  category: StorageCategory;
  objectPath: string;
  expiresIn?: number;
  checkExists?: boolean;
}): Promise<string> {
  const { data, error } = await supabase.functions.invoke<DownloadUrlResponse>(
    "storage-download-url",
    {
      body: {
        category: args.category,
        objectPath: args.objectPath,
        expiresIn: args.expiresIn ?? 600,
        checkExists: args.checkExists === true,
      },
    },
  );
  if (error || !data?.downloadUrl) {
    throw new Error(invokeErrorMessage(error, data ?? null));
  }
  return data.downloadUrl;
}

/** Upload bytes directly to B2 using native upload URL + token. */
export async function uploadBytesToB2(args: {
  category: StorageCategory;
  objectPath: string;
  body: Blob | ArrayBuffer | Uint8Array;
  contentType: string;
}): Promise<void> {
  const bytes = await toUint8Array(args.body);
  const upload = await getStorageUploadUrl({
    category: args.category,
    objectPath: args.objectPath,
    contentType: args.contentType,
    size: bytes.byteLength,
  });

  const res = await fetch(upload.uploadUrl, {
    method: "POST",
    headers: {
      Authorization: upload.authorizationToken,
      "X-Bz-File-Name": encodeURIComponent(upload.fileName),
      "X-Bz-Content-Sha256": await sha256Hex(bytes),
      "Content-Type": upload.contentType,
      "Content-Length": String(bytes.byteLength),
    },
    body: bytes,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`B2 upload failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
}

/**
 * Prefer B2 signed URL; fall back to legacy Supabase Storage for unmigrated objects.
 */
export async function resolveDownloadUrl(args: {
  category: StorageCategory;
  objectPath: string;
  expiresIn?: number;
  /** Extra Supabase buckets to try (e.g. legacy id-scans). */
  supabaseFallbackBuckets?: string[];
}): Promise<string> {
  const path = args.objectPath.trim();
  if (!path) throw new Error("Empty storage path");

  try {
    return await getStorageDownloadUrl({
      category: args.category,
      objectPath: path,
      expiresIn: args.expiresIn,
      checkExists: true,
    });
  } catch {
    // fall through to Supabase
  }

  const buckets = args.supabaseFallbackBuckets?.length
    ? args.supabaseFallbackBuckets
    : [args.category];

  let lastMessage = "Could not create signed URL";
  for (const bucket of buckets) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(path, args.expiresIn ?? 3600);
    if (error) {
      lastMessage = error.message;
      continue;
    }
    if (data?.signedUrl) return data.signedUrl;
  }
  throw new Error(lastMessage);
}
