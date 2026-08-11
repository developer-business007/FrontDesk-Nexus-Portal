import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserRole } from "@/types/roles";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `audit_log.terminal_id` must be a UUID that exists in `public.terminals`, or null. */
function terminalIdFromEnv(): string | null {
  const raw = import.meta.env.VITE_TERMINAL_ID?.trim();
  if (!raw) return null;
  return UUID_RE.test(raw) ? raw : null;
}

export type AuditInsert = {
  action_type: string;
  username: string | null;
  user_role: UserRole | string | null;
  /** Overrides env when you already resolved a terminal UUID in code */
  terminal_id?: string | null;
  confirmation_number?: string | null;
  description?: string | null;
  old_value?: Record<string, unknown> | null;
  new_value?: Record<string, unknown> | null;
  /** `public.profiles.id` (same as `auth.users.id`) */
  user_id: string;
};

export async function insertAuditRow(
  client: SupabaseClient,
  row: AuditInsert,
): Promise<{ error: Error | null }> {
  const terminal = row.terminal_id ?? terminalIdFromEnv();

  const { error } = await client.from("audit_log").insert({
    action_type: row.action_type,
    username: row.username,
    user_role: row.user_role,
    terminal_id: terminal,
    confirmation_number: row.confirmation_number ?? null,
    description: row.description ?? null,
    old_value: row.old_value ?? null,
    new_value: row.new_value ?? null,
    user_id: row.user_id,
    context: {},
  });

  return { error: error ? new Error(error.message) : null };
}
