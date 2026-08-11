import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

type UserRole = "admin" | "manager" | "supervisor" | "front_desk" | "housekeeper";

const ROLE_ORDER: Record<UserRole, number> = {
  admin: 5,
  manager: 4,
  supervisor: 3,
  front_desk: 2,
  housekeeper: 1,
};

function hasAtLeastRole(role: UserRole, min: UserRole): boolean {
  return ROLE_ORDER[role] >= ROLE_ORDER[min];
}

export type AuthOk = {
  ok: true;
  userId: string;
  role: UserRole;
  email: string | null;
  userClient: SupabaseClient;
  serviceClient: SupabaseClient;
};

export type AuthFail = {
  ok: false;
  status: number;
  error: string;
};

export function createServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

export async function requireStaff(
  req: Request,
  minRole: UserRole = "front_desk",
): Promise<AuthOk | AuthFail> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Missing authorization" };
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    return { ok: false, status: 500, error: "Server misconfigured" };
  }

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) {
    return { ok: false, status: 401, error: "Invalid session" };
  }

  const serviceClient = createServiceClient();
  const { data: profile, error: profileError } = await serviceClient
    .from("profiles")
    .select("role, is_active, email")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError || !profile) {
    return { ok: false, status: 403, error: "Profile not found" };
  }
  if (!profile.is_active) {
    return { ok: false, status: 403, error: "Account inactive" };
  }

  const role = profile.role as UserRole;
  if (!hasAtLeastRole(role, minRole)) {
    return { ok: false, status: 403, error: "Insufficient permissions" };
  }

  return {
    ok: true,
    userId: userData.user.id,
    role,
    email: profile.email ?? userData.user.email ?? null,
    userClient,
    serviceClient,
  };
}
