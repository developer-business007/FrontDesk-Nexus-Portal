import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireStaff } from "../_shared/auth.ts";
import { jsonResponse, optionsResponse } from "../_shared/cors.ts";

type Body = {
  full_name?: string;
  email?: string;
  password?: string;
  role?: "housekeeper" | "supervisor";
};

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const auth = await requireStaff(req, "manager");
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const role = body.role === "supervisor" ? "supervisor" : body.role === "housekeeper" ? "housekeeper" : null;

  if (!fullName) return jsonResponse({ error: "Full name is required" }, 400);
  if (!email || !isEmail(email)) return jsonResponse({ error: "Valid email is required" }, 400);
  if (!password || password.length < 8) {
    return jsonResponse({ error: "Password must be at least 8 characters" }, 400);
  }
  if (!role) return jsonResponse({ error: "Role must be housekeeper or supervisor" }, 400);

  // 1) Create auth user
  const { data: created, error: createError } = await auth.serviceClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, role },
  });

  if (createError || !created.user) {
    const msg = createError?.message ?? "Failed to create auth user";
    return jsonResponse({ ok: false, error: msg }, 400);
  }

  const userId = created.user.id;
  const now = new Date().toISOString();

  // 2) Ensure profile row exists
  const { error: upsertError } = await auth.serviceClient.from("profiles").upsert(
    {
      id: userId,
      email,
      full_name: fullName,
      role,
      is_active: true,
      updated_at: now,
    },
    { onConflict: "id" },
  );

  if (upsertError) {
    // Cleanup auth user so we don't leave orphan auth accounts.
    try {
      await auth.serviceClient.auth.admin.deleteUser(userId);
    } catch {
      // ignore cleanup failure
    }
    return jsonResponse({ ok: false, error: upsertError.message }, 500);
  }

  // 3) Optional audit
  try {
    await auth.serviceClient.from("audit_log").insert({
      action_type: "hk_staff_created",
      user_id: auth.userId,
      username: auth.email,
      user_role: auth.role,
      description: `Created housekeeping staff user (${role})`,
      new_value: { user_id: userId, email, full_name: fullName, role },
    });
  } catch {
    // audit is best-effort
  }

  return jsonResponse({ ok: true, userId, email });
});

