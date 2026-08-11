/**
 * One-time copy: Supabase Storage → Backblaze B2 (Node / tsx).
 * Uses native B2 API (works with Master Application Key).
 *
 * From Web folder:
 *
 *   npm.cmd run migrate:storage-b2
 *
 * Required env (PowerShell — do not commit):
 *
 *   $env:SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY="..."
 *   $env:B2_BUCKET="frontdesk-prod-private"
 *   $env:B2_KEY_ID="..."
 *   $env:B2_APPLICATION_KEY="..."
 *
 * Optional: B2_ENDPOINT / B2_REGION (ignored by native API)
 *
 * B2 object keys: {category}/{path}  (id-scans → id-images/...)
 * Re-run safe: skips when B2 size matches.
 */
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const BUCKETS = ["id-images", "id-scans", "signature-pdfs", "guest-signatures"] as const;

function b2Prefix(bucket: string): string {
  if (bucket === "id-scans") return "id-images";
  return bucket;
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** Native B2 upload requires SHA-1 (X-Bz-Content-Sha1), not SHA-256. */
function sha1Hex(body: Uint8Array): string {
  return createHash("sha1").update(body).digest("hex");
}

function basicAuthHeader(keyId: string, applicationKey: string): string {
  return `Basic ${Buffer.from(`${keyId}:${applicationKey}`, "utf8").toString("base64")}`;
}

type B2Auth = {
  accountId: string;
  apiUrl: string;
  authorizationToken: string;
  downloadUrl: string;
  bucketId: string;
  bucketName: string;
};

async function authorizeB2(
  keyId: string,
  applicationKey: string,
  bucketName: string,
): Promise<B2Auth> {
  const res = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
    method: "GET",
    headers: { Authorization: basicAuthHeader(keyId, applicationKey) },
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
        `b2_authorize_account failed (HTTP ${res.status}). Check B2_KEY_ID / B2_APPLICATION_KEY.`,
    );
  }

  let bucketId = data.allowed?.bucketId ?? null;
  if (!bucketId) {
    const listRes = await fetch(`${data.apiUrl}/b2api/v2/b2_list_buckets`, {
      method: "POST",
      headers: {
        Authorization: data.authorizationToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accountId: data.accountId }),
    });
    const listData = (await listRes.json()) as {
      buckets?: Array<{ bucketId: string; bucketName: string }>;
      message?: string;
    };
    if (!listRes.ok) {
      throw new Error(listData.message ?? `b2_list_buckets failed (HTTP ${listRes.status})`);
    }
    const match = (listData.buckets ?? []).find((b) => b.bucketName === bucketName);
    if (!match) throw new Error(`B2 bucket not found: ${bucketName}`);
    bucketId = match.bucketId;
  }

  return {
    accountId: data.accountId,
    apiUrl: data.apiUrl,
    authorizationToken: data.authorizationToken,
    downloadUrl: data.downloadUrl.replace(/\/$/, ""),
    bucketId,
    bucketName,
  };
}

async function getFileSize(auth: B2Auth, fileName: string): Promise<number | null> {
  const res = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_file_names`, {
    method: "POST",
    headers: {
      Authorization: auth.authorizationToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      bucketId: auth.bucketId,
      startFileName: fileName,
      maxFileCount: 1,
      prefix: fileName,
    }),
  });
  const data = (await res.json()) as {
    files?: Array<{ fileName: string; contentLength?: number }>;
  };
  if (!res.ok) return null;
  const file = data.files?.[0];
  if (!file || file.fileName !== fileName) return null;
  return typeof file.contentLength === "number" ? file.contentLength : null;
}

async function uploadNative(
  auth: B2Auth,
  fileName: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  const urlRes = await fetch(`${auth.apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: "POST",
    headers: {
      Authorization: auth.authorizationToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ bucketId: auth.bucketId }),
  });
  const urlData = (await urlRes.json()) as {
    uploadUrl?: string;
    authorizationToken?: string;
    message?: string;
  };
  if (!urlRes.ok || !urlData.uploadUrl || !urlData.authorizationToken) {
    throw new Error(urlData.message ?? `b2_get_upload_url failed (HTTP ${urlRes.status})`);
  }

  const putRes = await fetch(urlData.uploadUrl, {
    method: "POST",
    headers: {
      Authorization: urlData.authorizationToken,
      "X-Bz-File-Name": encodeURIComponent(fileName),
      "X-Bz-Content-Sha1": sha1Hex(body),
      "Content-Type": contentType,
      "Content-Length": String(body.byteLength),
    },
    body,
  });
  if (!putRes.ok) {
    const t = await putRes.text().catch(() => "");
    throw new Error(`B2 upload failed (HTTP ${putRes.status}) ${t.slice(0, 200)}`);
  }
}

type Sb = ReturnType<typeof createClient>;

async function listAllFiles(supabase: Sb, bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [prefix];
  let foldersDone = 0;

  while (queue.length) {
    const folder = queue.shift()!;
    const label = folder || "(root)";
    console.log(
      `listing ${bucket}/${label} … (files so far: ${out.length}, folders queued: ${queue.length})`,
    );
    let offset = 0;
    for (;;) {
      const { data, error } = await supabase.storage.from(bucket).list(folder, {
        limit: 100,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) {
        console.warn(`list ${bucket}/${label}: ${error.message}`);
        break;
      }
      if (!data?.length) break;

      let pageFiles = 0;
      let pageFolders = 0;
      for (const item of data) {
        const name = item.name;
        if (!name || name === ".emptyFolderPlaceholder") continue;
        const full = folder ? `${folder}/${name}` : name;
        const isFolder = item.id === null && (item.metadata == null || item.metadata?.size == null);
        if (isFolder) {
          queue.push(full);
          pageFolders++;
        } else {
          out.push(full);
          pageFiles++;
        }
      }
      console.log(
        `  page offset=${offset}: +${pageFiles} file(s), +${pageFolders} folder(s)`,
      );
      if (data.length < 100) break;
      offset += data.length;
    }
    foldersDone++;
    if (foldersDone % 25 === 0) {
      console.log(
        `… progress: ${foldersDone} folder(s) listed, ${out.length} file(s), ${queue.length} folder(s) left`,
      );
    }
  }
  return out;
}

async function main() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const b2Bucket = requireEnv("B2_BUCKET");
  const keyId = requireEnv("B2_KEY_ID");
  const appKey = requireEnv("B2_APPLICATION_KEY");

  console.log("Authorizing Backblaze B2 (native API)...");
  const auth = await authorizeB2(keyId, appKey, b2Bucket);
  console.log(`OK — bucket ${auth.bucketName} (${auth.bucketId})`);

  const supabase = createClient(supabaseUrl, serviceKey);

  let total = 0;
  let copied = 0;
  let skipped = 0;
  let failed = 0;
  let bytes = 0;

  for (const bucket of BUCKETS) {
    console.log(`\n=== Listing ${bucket} ===`);
    const files = await listAllFiles(supabase, bucket, "");
    console.log(`Found ${files.length} file(s) in ${bucket}`);

    console.log(`=== Uploading ${bucket} (${files.length} file(s)) ===`);
    for (let i = 0; i < files.length; i++) {
      const path = files[i]!;
      total++;
      const key = `${b2Prefix(bucket)}/${path}`;
      const prog = `[${i + 1}/${files.length}]`;
      try {
        console.log(`${prog} download ${bucket}/${path}`);
        const { data: blob, error: dlErr } = await supabase.storage.from(bucket).download(path);
        if (dlErr || !blob) throw new Error(dlErr?.message ?? "download failed");

        const body = new Uint8Array(await blob.arrayBuffer());
        console.log(`${prog} check B2 ${key} (${body.byteLength} bytes)`);
        const existingLen = await getFileSize(auth, key);
        if (existingLen === body.byteLength) {
          skipped++;
          console.log(`${prog} skip (exists) ${key}`);
          continue;
        }

        const contentType = blob.type || "application/octet-stream";
        console.log(`${prog} upload ${key}`);
        await uploadNative(auth, key, body, contentType);
        copied++;
        bytes += body.byteLength;
        console.log(`${prog} ok ${key} (${body.byteLength} bytes)`);
      } catch (e) {
        failed++;
        console.error(`${prog} FAIL ${key}:`, e instanceof Error ? e.message : e);
      }
    }
  }

  console.log("\n=== Report ===");
  console.log({ total, copied, skipped, failed, bytes });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
