import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireStaff } from "../../../edge-functions/supabase/functions/_shared/auth.ts";
import { jsonResponse, optionsResponse } from "../../../edge-functions/supabase/functions/_shared/cors.ts";

type UserRole = "admin" | "manager" | "supervisor" | "front_desk" | "housekeeper";

type Body =
  | { action: "list"; page?: number; perPage?: number; query?: string | null; role?: UserRole | "all" | null; active?: "all" | "active" | "inactive" | null }
  | { action: "create"; full_name?: string; email?: string; password?: string; role?: UserRole }
  | { action: "updateProfile"; userId?: string; patch?: { full_name?: string | null; role?: UserRole; is_active?: boolean } }
  | { action: "setPassword"; userId?: string; password?: string }
  | { action: "delete"; userId?: string };

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isRole(value: unknown): value is UserRole {
  return (
    value === "admin" ||
    value === "manager" ||
    value === "supervisor" ||
    value === "front_desk" ||
    value === "housekeeper"
  );
}

async function auditSafe(
  serviceClient: any,
  actor: { userId: string; email: string | null; role: string },
  actionType: string,
  description: string,
  newValue?: Record<string, unknown>,
) {
  try {
    await serviceClient.from("audit_log").insert({
      action_type: actionType,
      user_id: actor.userId,
      username: actor.email,
      user_role: actor.role,
      description,
      new_value: newValue ?? null,
    });
  } catch {
    // best-effort
  }
}

function normalizeQuery(q: unknown): string {
  return typeof q === "string" ? q.trim().toLowerCase() : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const auth = await requireStaff(req, "admin");
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  // ---------------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------------
  if (body.action === "list") {
    const page = Number.isFinite(Number(body.page)) ? Math.max(1, Math.floor(Number(body.page))) : 1;
    const perPage = Number.isFinite(Number(body.perPage))
      ? Math.min(200, Math.max(10, Math.floor(Number(body.perPage))))
      : 50;
    const query = normalizeQuery(body.query);
    const roleFilter = body.role && (body.role === "all" || isRole(body.role)) ? body.role : "all";
    const activeFilter =
      body.active === "active" || body.active === "inactive" || body.active === "all"
        ? body.active
        : "all";

    const { data, error } = await auth.serviceClient.auth.admin.listUsers({
      page,
      perPage,
    });
    if (error) return jsonResponse({ error: error.message }, 500);

    const users = data.users ?? [];
    const ids = users.map((u: any) => u.id);

    const profilesRes = ids.length
      ? await auth.serviceClient
          .from("profiles")
          .select("id, email, full_name, role, is_active, last_login_at, created_at, updated_at")
          .in("id", ids)
      : { data: [], error: null };

    if (profilesRes.error) {
      return jsonResponse({ error: profilesRes.error.message }, 500);
    }

    const profileById = new Map<string, any>((profilesRes.data ?? []).map((p: any) => [p.id, p]));

    let rows = users.map((u: any) => {
      const p = profileById.get(u.id) ?? null;
      return {
        id: u.id,
        email: (p?.email ?? u.email ?? null) as string | null,
        auth_created_at: u.created_at ?? null,
        last_sign_in_at: u.last_sign_in_at ?? null,
        full_name: (p?.full_name ?? null) as string | null,
        role: (p?.role ?? null) as UserRole | null,
        is_active: (p?.is_active ?? null) as boolean | null,
        last_login_at: (p?.last_login_at ?? null) as string | null,
        profile_missing: p == null,
      };
    });

    if (query) {
      rows = rows.filter((r) => {
        const hay = `${r.email ?? ""} ${r.full_name ?? ""}`.toLowerCase();
        return hay.includes(query);
      });
    }
    if (roleFilter !== "all") {
      rows = rows.filter((r) => r.role === roleFilter);
    }
    if (activeFilter === "active") rows = rows.filter((r) => r.is_active === true);
    if (activeFilter === "inactive") rows = rows.filter((r) => r.is_active === false);

    return jsonResponse({
      ok: true,
      page,
      perPage,
      count: rows.length,
      rows,
    });
  }

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------
  if (body.action === "create") {
    const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const role = body.role;

    if (!fullName) return jsonResponse({ error: "Full name is required" }, 400);
    if (!email || !isEmail(email)) return jsonResponse({ error: "Valid email is required" }, 400);
    if (!password || password.length < 8) {
      return jsonResponse({ error: "Password must be at least 8 characters" }, 400);
    }
    if (!isRole(role)) return jsonResponse({ error: "Invalid role" }, 400);

    const { data: created, error: createError } = await auth.serviceClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role },
    });

    if (createError || !created.user) {
      return jsonResponse({ error: createError?.message ?? "Failed to create auth user" }, 400);
    }

    const userId = created.user.id;
    const now = new Date().toISOString();

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
      try {
        await auth.serviceClient.auth.admin.deleteUser(userId);
      } catch {
        // ignore cleanup failure
      }
      return jsonResponse({ error: upsertError.message }, 500);
    }

    await auditSafe(
      auth.serviceClient,
      { userId: auth.userId, email: auth.email, role: auth.role },
      "admin_user_created",
      "Created user",
      { user_id: userId, email, full_name: fullName, role },
    );

    return jsonResponse({ ok: true, userId, email });
  }

  // ---------------------------------------------------------------------------
  // updateProfile
  // ---------------------------------------------------------------------------
  if (body.action === "updateProfile") {
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const patch = body.patch ?? {};
    if (!userId) return jsonResponse({ error: "userId is required" }, 400);

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.full_name !== undefined) {
      update.full_name = typeof patch.full_name === "string" ? patch.full_name.trim() || null : null;
    }
    if (patch.role !== undefined) {
      if (!isRole(patch.role)) return jsonResponse({ error: "Invalid role" }, 400);
      update.role = patch.role;
    }
    if (patch.is_active !== undefined) {
      update.is_active = Boolean(patch.is_active);
    }

    const { data, error } = await auth.serviceClient
      .from("profiles")
      .update(update)
      .eq("id", userId)
      .select("id, email, full_name, role, is_active, last_login_at, created_at, updated_at")
      .single();

    if (error) return jsonResponse({ error: error.message }, 500);

    await auditSafe(
      auth.serviceClient,
      { userId: auth.userId, email: auth.email, role: auth.role },
      "admin_user_profile_updated",
      "Updated user profile",
      { user_id: userId, patch: update },
    );

    return jsonResponse({ ok: true, profile: data });
  }

  // ---------------------------------------------------------------------------
  // setPassword
  // ---------------------------------------------------------------------------
  if (body.action === "setPassword") {
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!userId) return jsonResponse({ error: "userId is required" }, 400);
    if (!password || password.length < 8) {
      return jsonResponse({ error: "Password must be at least 8 characters" }, 400);
    }

    const { error } = await auth.serviceClient.auth.admin.updateUserById(userId, { password });
    if (error) return jsonResponse({ error: error.message }, 500);

    await auditSafe(
      auth.serviceClient,
      { userId: auth.userId, email: auth.email, role: auth.role },
      "admin_user_password_set",
      "Set user password",
      { user_id: userId },
    );

    return jsonResponse({ ok: true });
  }

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------
  if (body.action === "delete") {
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!userId) return jsonResponse({ error: "userId is required" }, 400);
    if (userId === auth.userId) {
      return jsonResponse({ error: "You cannot delete your own admin account." }, 400);
    }

    const { error: deleteError } = await auth.serviceClient.auth.admin.deleteUser(userId);
    if (deleteError) return jsonResponse({ error: deleteError.message }, 500);

    const { error: profileDeleteError } = await auth.serviceClient
      .from("profiles")
      .delete()
      .eq("id", userId);
    if (profileDeleteError) return jsonResponse({ error: profileDeleteError.message }, 500);

    await auditSafe(
      auth.serviceClient,
      { userId: auth.userId, email: auth.email, role: auth.role },
      "admin_user_deleted",
      "Deleted user",
      { user_id: userId },
    );

    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Unknown action" }, 400);
});

