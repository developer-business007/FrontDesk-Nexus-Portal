import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireStaff } from "../_shared/auth.ts";
import {
  createDownloadUrl,
  headObject,
  normalizeCategory,
  objectKeyFor,
} from "../_shared/b2.ts";
import { jsonResponse, optionsResponse } from "../_shared/cors.ts";

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

  const expiresInRaw = typeof body.expiresIn === "number"
    ? body.expiresIn
    : Number(body.expiresIn);
  const expiresIn = Number.isFinite(expiresInRaw) ? expiresInRaw : 600;
  const checkExists = body.checkExists === true;

  try {
    const objectKey = objectKeyFor(category, objectPath);
    if (checkExists) {
      const head = await headObject(objectKey);
      if (!head.exists) {
        return jsonResponse({ error: "Object not found in B2", missing: true }, 404);
      }
    }
    const downloadUrl = await createDownloadUrl({
      objectKey,
      expiresSeconds: expiresIn,
    });
    return jsonResponse({
      downloadUrl,
      objectKey,
      category,
      objectPath,
      expiresIn,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[storage-download-url]", msg);
    return jsonResponse({ error: msg }, 500);
  }
});
