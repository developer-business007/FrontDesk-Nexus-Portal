import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireStaff } from "../_shared/auth.ts";
import { jsonResponse, optionsResponse } from "../_shared/cors.ts";
import {
  loadDualPmsIntegration,
  resolveDualPmsCredentials,
} from "../_shared/dualpms-secrets.ts";
import {
  buildHousekeepingSyncMessage,
  syncHousekeepingStatus,
  type PmsHousekeepingStatus,
} from "../_shared/housekeeping-status-sync.ts";

type RequestBody = {
  roomNumbers?: Array<string | number>;
  status?: string;
  notes?: string | null;
  /** Default true — also update Nexus housekeeping board. */
  syncNexus?: boolean;
  /** Default true — queue SynXis/eZee via DualPMS VPS. */
  syncPms?: boolean;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const auth = await requireStaff(req, "front_desk");
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const roomNumbers = Array.isArray(body.roomNumbers)
    ? body.roomNumbers.map((r) => String(r).trim()).filter(Boolean)
    : [];
  const statusRaw = typeof body.status === "string" ? body.status.trim().toLowerCase() : "";

  if (!roomNumbers.length) {
    return jsonResponse({ error: "roomNumbers is required" }, 400);
  }
  if (statusRaw !== "clean" && statusRaw !== "dirty") {
    return jsonResponse({ error: "status must be 'clean' or 'dirty'" }, 400);
  }

  const status = statusRaw as PmsHousekeepingStatus;
  const syncNexus = body.syncNexus !== false;
  const syncPms = body.syncPms !== false;

  try {
    const integration = await loadDualPmsIntegration(auth.serviceClient);
    const pmsConfig = syncPms ? await resolveDualPmsCredentials(integration) : null;

    const result = await syncHousekeepingStatus(auth.serviceClient, pmsConfig, {
      roomNumbers,
      status,
      notes: body.notes ?? null,
      syncNexus,
      syncPms,
    });

    const { error: auditError } = await auth.serviceClient.from("audit_log").insert({
      action_type: "housekeeping_status_synced",
      user_id: auth.userId,
      username: auth.email,
      user_role: auth.role,
      description: `HK sync: mark ${result.roomCount} room(s) ${status}`,
      new_value: {
        roomNumbers,
        status,
        syncNexus,
        syncPms,
        pmsQueued: result.pmsQueued,
        pmsRandomHex: result.pmsRandomHex,
        nexusWarnings: result.warnings,
      },
    });
    if (auditError) {
      console.warn("[request-pms-housekeeping] audit log failed:", auditError.message);
    }

    const message = buildHousekeepingSyncMessage(result);
    const nexusFailed = result.nexusResults.filter((r) => !r.ok).length;
    const allNexusFailed = syncNexus && nexusFailed === result.roomCount;

    if (allNexusFailed && !syncPms) {
      return jsonResponse({
        error: result.warnings[0] ?? "Failed to update housekeeping board",
        warnings: result.warnings,
      }, 422);
    }

    return jsonResponse({
      ok: true,
      roomCount: result.roomCount,
      status,
      syncNexus,
      syncPms,
      pmsQueued: result.pmsQueued,
      nexusSynced: result.nexusResults.filter((r) => r.ok).length,
      nexusResults: result.nexusResults,
      warnings: result.warnings,
      message,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to sync housekeeping status";
    console.error("[request-pms-housekeeping]", message);
    return jsonResponse({ error: message }, 500);
  }
});
