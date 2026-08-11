/**
 * SynXis local sync — runs on the hotel front-desk PC (same network as SynXis).
 * Started automatically by `npm run dev` when server keys are in Web/.env.
 *
 * Manual: npm run synxis-sync
 * Test:   npm run synxis-sync:test
 */
import "./deno-shim.js";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  buildUpsertRow,
  loadActiveRoomNumbers,
  loadExistingPmsSnapshots,
  PMS_ROOMTYPE_COUNTS_KEY,
  PMS_SYNC_STATE_KEY,
  updateAppSettingsJson,
  upsertPmsRoomRows,
} from "../edge-functions/supabase/functions/_shared/pms-board-db.ts";
import { ensureSynxisSession } from "../edge-functions/supabase/functions/_shared/synxis-session.ts";
import { syncSynxisRooms } from "../edge-functions/supabase/functions/_shared/synxis-room-sync.ts";
import { loadSynxisPropertyConfig } from "../edge-functions/supabase/functions/_shared/synxis-secrets.ts";

const LOOP_INTERVAL_MS = 10_000;

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback?.trim();
  if (!value) throw new Error(`Missing env ${name} — see Web/.env.example`);
  return value;
}

function createServiceClient() {
  const url = requireEnv("SUPABASE_URL", process.env.VITE_SUPABASE_URL);
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

async function runSynxisSync(testOnly = false): Promise<void> {
  const client = createServiceClient();
  const propertyConfig = await loadSynxisPropertyConfig(client);

  console.log("[synxis-sync] logging in (hotel network)…");
  const cookieHeader = await ensureSynxisSession(client);
  console.log("[synxis-sync] session OK, cookie length", cookieHeader.length);

  if (testOnly) {
    console.log("[synxis-sync] login test passed");
    return;
  }

  const synxis = await syncSynxisRooms(cookieHeader, propertyConfig);
  console.log("[synxis-sync] fetched", synxis.rooms.size, "rooms");

  const inventory = await loadActiveRoomNumbers(client);
  const existing = await loadExistingPmsSnapshots(client);
  const now = new Date().toISOString();

  const { data: syncTimeRows } = await client
    .from("room_operational_status")
    .select("room_number, ezee_synced_at");
  const ezeeSyncByRoom = new Map<string, string | null>();
  for (const row of syncTimeRows ?? []) {
    const r = row as { room_number: string; ezee_synced_at: string | null };
    ezeeSyncByRoom.set(String(r.room_number), r.ezee_synced_at);
  }

  const upsertRows = inventory.map((roomNumber) =>
    buildUpsertRow(
      roomNumber,
      synxis.rooms.get(roomNumber),
      existing.ezee.get(roomNumber),
      now,
      ezeeSyncByRoom.get(roomNumber) ?? null,
    ),
  );

  await upsertPmsRoomRows(client, upsertRows);

  await updateAppSettingsJson(client, PMS_SYNC_STATE_KEY, {
    synxis: { synced_at: now, hotel_date: synxis.hotelDate, source: "local" },
  });

  await updateAppSettingsJson(client, PMS_ROOMTYPE_COUNTS_KEY, {
    synxis: synxis.roomtypeCounts,
  });

  console.log("[synxis-sync] upserted", upsertRows.length, "rooms at", now);
}

const args = new Set(process.argv.slice(2));
const testOnly = args.has("--test");
const loop = args.has("--loop");

if (loop) {
  console.log("[synxis-sync] loop mode — every 10s (Ctrl+C to stop)");
  for (;;) {
    try {
      await runSynxisSync(false);
    } catch (e) {
      console.error("[synxis-sync]", e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, LOOP_INTERVAL_MS));
  }
} else {
  await runSynxisSync(testOnly);
}
