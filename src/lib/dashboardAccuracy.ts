import { evaluatePmsSyncFreshness } from "@/lib/pmsBoard";
import type { PmsSyncState } from "@/types/pmsBoard";

export type DashboardAccuracy = {
  canShowPmsData: boolean;
  reasons: string[];
  /** SynXis hotel date from PMS sync — required for guest lists. */
  hotelDate: string | null;
};

/**
 * Dashboard PMS widgets only render when DualPMS feed is complete and fresh.
 * If any check fails, guest/room KPIs and lists stay hidden (no partial guesses).
 */
export function evaluateDashboardAccuracy(input: {
  inventoryCount: number;
  syncState: PmsSyncState | undefined;
  nowMs: number;
  pmsBoardLoaded: boolean;
  pmsBoardError: boolean;
  pmsRowCount: number;
}): DashboardAccuracy {
  const reasons: string[] = [];

  if (input.inventoryCount === 0) {
    reasons.push("Room inventory is not configured in Settings.");
  }

  const freshness = evaluatePmsSyncFreshness(input.syncState, null, input.nowMs);

  if (freshness.anyStale) {
    for (const issue of freshness.issues.filter((i) => i.stale)) {
      reasons.push(issue.detail);
    }
  }

  if (freshness.fallbackActive) {
    reasons.push(
      "DualPMS VPS feed is in API fallback mode — dashboard waits for the live VPS bridge copy.",
    );
  }

  const hotelDate = input.syncState?.synxis?.hotel_date?.trim() || null;
  if (!hotelDate) {
    reasons.push("SynXis hotel date is missing from the latest PMS sync.");
  }

  if (input.pmsBoardError) {
    reasons.push("Could not load the PMS room board from Supabase.");
  }

  if (input.pmsBoardLoaded && input.inventoryCount > 0 && input.pmsRowCount === 0) {
    reasons.push("No PMS room rows are stored yet — start the VPS bridge (PM2).");
  }

  return {
    canShowPmsData: reasons.length === 0,
    reasons,
    hotelDate,
  };
}
