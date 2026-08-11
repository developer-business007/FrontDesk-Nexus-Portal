import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireStaff } from "../_shared/auth.ts";
import { jsonResponse, optionsResponse } from "../_shared/cors.ts";
import { fetchEzeeBillingSummary } from "../_shared/ezee-api.ts";
import { loadEzeeIntegration, resolveEzeeCredentials } from "../_shared/ezee-secrets.ts";

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
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const bookingId = typeof body.bookingId === "string" ? body.bookingId.trim() : "";
  if (!bookingId) {
    return jsonResponse({ error: "bookingId is required" }, 400);
  }

  try {
    const integration = await loadEzeeIntegration(auth.serviceClient);
    const { hotelCode, authCode } = await resolveEzeeCredentials(integration);
    const summary = await fetchEzeeBillingSummary(hotelCode, authCode, bookingId);
    return jsonResponse(summary);
  } catch (e) {
    const message = e instanceof Error ? e.message : "eZee billing failed";
    console.error("[ezee-billing]", message);
    return jsonResponse({ error: message }, 502);
  }
});
