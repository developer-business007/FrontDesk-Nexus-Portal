import { resolveDownloadUrl } from "@/lib/b2Storage";

/**
 * Extension uploads to `id-images`; older docs mention `id-scans`.
 * New objects live in Backblaze B2; unmigrated ones still fall back to Supabase Storage.
 */
export async function createIdScanImageSignedUrl(
  storagePath: string,
  expiresSec = 3600,
): Promise<string> {
  return resolveDownloadUrl({
    category: "id-images",
    objectPath: storagePath,
    expiresIn: expiresSec,
    supabaseFallbackBuckets: ["id-images", "id-scans"],
  });
}
