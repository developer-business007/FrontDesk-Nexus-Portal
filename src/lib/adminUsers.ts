import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { resolveEdgeFunctionError } from "@/lib/edgeFunctionError";
import { supabase } from "@/lib/supabase";
import type { UserRole } from "@/types/roles";

export const ADMIN_USERS_KEY = ["admin-users"] as const;

export type AdminUserRow = {
  id: string;
  email: string | null;
  auth_created_at: string | null;
  last_sign_in_at: string | null;
  full_name: string | null;
  role: UserRole | null;
  is_active: boolean | null;
  last_login_at: string | null;
  profile_missing: boolean;
};

export type AdminUsersListFilters = {
  query?: string;
  role?: UserRole | "all";
  active?: "all" | "active" | "inactive";
  page?: number;
  perPage?: number;
};

type ListResponse = {
  ok: true;
  page: number;
  perPage: number;
  count: number;
  rows: AdminUserRow[];
};

export async function adminListUsers(filters: AdminUsersListFilters): Promise<ListResponse> {
  const { data, error } = await supabase.functions.invoke("admin-users", {
    body: {
      action: "list",
      page: filters.page ?? 1,
      perPage: filters.perPage ?? 50,
      query: filters.query?.trim() || null,
      role: filters.role ?? "all",
      active: filters.active ?? "all",
    },
  });

  if (error) {
    throw new Error(await resolveEdgeFunctionError(error, data));
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Invalid server response");
  }

  const row = data as any;
  if (row.ok !== true) throw new Error(typeof row.error === "string" ? row.error : "Request failed");
  return row as ListResponse;
}

export type AdminCreateUserInput = {
  full_name: string;
  email: string;
  password: string;
  role: UserRole;
};

export async function adminCreateUser(input: AdminCreateUserInput): Promise<{ ok: true; userId: string; email: string }> {
  const { data, error } = await supabase.functions.invoke("admin-users", {
    body: {
      action: "create",
      ...input,
    },
  });
  if (error) throw new Error(await resolveEdgeFunctionError(error, data));
  const row = data as any;
  if (!row?.ok) throw new Error(typeof row?.error === "string" ? row.error : "Create failed");
  return row as { ok: true; userId: string; email: string };
}

export async function adminUpdateProfile(input: {
  userId: string;
  patch: { full_name?: string | null; role?: UserRole; is_active?: boolean };
}): Promise<{ ok: true; profile: any }> {
  const { data, error } = await supabase.functions.invoke("admin-users", {
    body: {
      action: "updateProfile",
      userId: input.userId,
      patch: input.patch,
    },
  });
  if (error) throw new Error(await resolveEdgeFunctionError(error, data));
  const row = data as any;
  if (!row?.ok) throw new Error(typeof row?.error === "string" ? row.error : "Update failed");
  return row;
}

export async function adminSetPassword(input: { userId: string; password: string }): Promise<{ ok: true }> {
  const { data, error } = await supabase.functions.invoke("admin-users", {
    body: {
      action: "setPassword",
      userId: input.userId,
      password: input.password,
    },
  });
  if (error) throw new Error(await resolveEdgeFunctionError(error, data));
  const row = data as any;
  if (!row?.ok) throw new Error(typeof row?.error === "string" ? row.error : "Password update failed");
  return row;
}

export async function adminDeleteUser(input: { userId: string }): Promise<{ ok: true }> {
  const { data, error } = await supabase.functions.invoke("admin-users", {
    body: { action: "delete", userId: input.userId },
  });
  if (error) throw new Error(await resolveEdgeFunctionError(error, data));
  const row = data as any;
  if (!row?.ok) throw new Error(typeof row?.error === "string" ? row.error : "Delete failed");
  return row;
}

export function useAdminUsers(filters: AdminUsersListFilters) {
  return useQuery({
    queryKey: [
      ...ADMIN_USERS_KEY,
      filters.query ?? "",
      filters.role ?? "all",
      filters.active ?? "all",
      filters.page ?? 1,
      filters.perPage ?? 50,
    ] as const,
    queryFn: () => adminListUsers(filters),
    staleTime: 10_000,
  });
}

export function useAdminCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AdminCreateUserInput) => adminCreateUser(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ADMIN_USERS_KEY });
    },
  });
}

export function useAdminUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; patch: { full_name?: string | null; role?: UserRole; is_active?: boolean } }) =>
      adminUpdateProfile(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ADMIN_USERS_KEY });
    },
  });
}

export function useAdminSetPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; password: string }) => adminSetPassword(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ADMIN_USERS_KEY });
    },
  });
}

export function useAdminDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string }) => adminDeleteUser(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ADMIN_USERS_KEY });
    },
  });
}

export function exportAdminUsersCsv(rows: AdminUserRow[]): string {
  const header = [
    "Full name",
    "Email",
    "Role",
    "Active",
    "Last login",
    "Auth created",
    "Profile missing",
  ];
  const lines = rows.map((r) =>
    [
      r.full_name ?? "",
      r.email ?? "",
      r.role ?? "",
      r.is_active === true ? "Yes" : r.is_active === false ? "No" : "",
      r.last_login_at ?? r.last_sign_in_at ?? "",
      r.auth_created_at ?? "",
      r.profile_missing ? "Yes" : "No",
    ]
      .map((c) => `"${String(c).replace(/"/g, '""')}"`)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

