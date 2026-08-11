import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createServiceClient, requireStaff } from "../_shared/auth.ts";
import { jsonResponse, optionsResponse } from "../_shared/cors.ts";
import { runPmsSync } from "../_shared/run-pms-sync.ts";

function authorizeCron(req: Request): boolean {
  const secret = Deno.env.get("PMS_SYNC_CRON_SECRET")?.trim();
  if (!secret) return false;
  const header = req.headers.get("x-pms-sync-secret")?.trim();
  const auth = req.headers.get("authorization")?.trim();
  return header === secret || auth === `Bearer ${secret}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let serviceClient;
  if (authorizeCron(req)) {
    serviceClient = createServiceClient();
  } else {
    const auth = await requireStaff(req, "front_desk");
    if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
    serviceClient = auth.serviceClient;
  }

  const result = await runPmsSync(serviceClient);
  // Always 200 so the portal can read synxis/ezee diagnostics even when both PMS calls fail.
  return jsonResponse(result, 200);
});
