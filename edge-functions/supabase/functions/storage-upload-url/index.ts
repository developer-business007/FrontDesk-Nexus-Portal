import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireStaff } from "../_shared/auth.ts";
import {
  createNativeUpload,
  normalizeCategory,
  objectKeyFor,
} from "../_shared/b2.ts";
import { jsonResponse, optionsResponse } from "../_shared/cors.ts";

const MAX_BYTES: Record<string, number> = {
  "id-images": 20 * 1024 * 1024,
  "signature-pdfs": 25 * 1024 * 1024,
  "guest-signatures": 10 * 1024 * 1024,
};

const ALLOWED_MIME: Record<string, string[]> = {
  "id-images": ["image/jpeg", "image/png", "image/bmp", "image/webp", "application/octet-stream"],
  "signature-pdfs": ["application/octet-stream", "application/pdf"],
  "guest-signatures": ["application/octet-stream", "image/png"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const auth = await requireStaff(req, "front_desk");
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const category = normalizeCategory(String(body.category ?? ""));
  if (!category) {
    return jsonResponse({ error: "Invalid category" }, 400);
  }

  const objectPath = String(body.objectPath ?? body.path ?? "").trim();
  if (!objectPath) {
    return jsonResponse({ error: "objectPath is required" }, 400);
  }

  const contentType = String(body.contentType ?? body.mimeType ?? "application/octet-stream")
    .trim()
    .toLowerCase();
  const allowed = ALLOWED_MIME[category] ?? [];
  if (!allowed.includes(contentType)) {
    return jsonResponse({ error: `MIME type not allowed: ${contentType}` }, 400);
  }

  const size = typeof body.size === "number" ? body.size : Number(body.size);
  if (Number.isFinite(size) && size > 0) {
    const max = MAX_BYTES[category] ?? 20 * 1024 * 1024;
    if (size > max) {
      return jsonResponse({ error: `File too large (max ${max} bytes)` }, 400);
    }
  }

  try {
    const objectKey = objectKeyFor(category, objectPath);
    const upload = await createNativeUpload({ objectKey, contentType });
    return jsonResponse({
      uploadUrl: upload.uploadUrl,
      authorizationToken: upload.authorizationToken,
      fileName: upload.fileName,
      contentType: upload.contentType,
      objectKey,
      category,
      objectPath,
      uploadMode: "b2-native",
      expiresIn: 300,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[storage-upload-url]", msg);
    return jsonResponse({ error: msg }, 500);
  }
});
