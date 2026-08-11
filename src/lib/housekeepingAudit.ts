import type { SupabaseClient } from "@supabase/supabase-js";
import { insertAuditRow } from "@/lib/audit";
import type { Profile } from "@/types/database";

export async function auditHousekeeping(
  client: SupabaseClient,
  profile: Profile,
  action_type: string,
  description: string,
  new_value?: Record<string, unknown> | null,
  confirmation_number?: string | null,
): Promise<void> {
  const { error } = await insertAuditRow(client, {
    action_type,
    user_id: profile.id,
    username: profile.email,
    user_role: profile.role,
    description,
    new_value: new_value ?? null,
    confirmation_number: confirmation_number ?? null,
  });
  if (error) {
    // eslint-disable-next-line no-console
    console.warn("[housekeeping] audit log failed:", error.message);
  }
}
