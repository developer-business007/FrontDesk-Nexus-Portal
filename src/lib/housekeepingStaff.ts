import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HOUSEKEEPING_STAFF_KEY } from "@/lib/housekeeping";
import { resolveEdgeFunctionError } from "@/lib/edgeFunctionError";
import { supabase } from "@/lib/supabase";
import type { Profile } from "@/types/database";
import type { UserRole } from "@/types/roles";

export const HK_STAFF_ALL_KEY = ["hk-staff-all"] as const;

const HK_ROLES: string[] = ["housekeeper", "supervisor"];

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchAllHousekeepingStaff(): Promise<Profile[]> {
  const { data: rpcData, error: rpcError } = await supabase.rpc("hk_list_housekeeping_staff");
  if (!rpcError && rpcData) {
    return (rpcData ?? []) as Profile[];
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .in("role", HK_ROLES)
    .order("full_name", { ascending: true, nullsFirst: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as Profile[];
}

export function useAllHousekeepingStaff() {
  return useQuery({
    queryKey: HK_STAFF_ALL_KEY,
    queryFn: fetchAllHousekeepingStaff,
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function updateStaffProfile(
  id: string,
  patch: { full_name?: string | null; role?: UserRole; is_active?: boolean },
): Promise<Profile> {
  const { data, error } = await supabase
    .from("profiles")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data as Profile;
}

export function useUpdateStaffProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: { full_name?: string | null; role?: UserRole; is_active?: boolean };
    }) => updateStaffProfile(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: HK_STAFF_ALL_KEY });
      void qc.invalidateQueries({ queryKey: HOUSEKEEPING_STAFF_KEY });
    },
  });
}

// ---------------------------------------------------------------------------
// Create staff (Auth + Profile) via edge function
// ---------------------------------------------------------------------------

export type CreateHkStaffInput = {
  full_name: string;
  email: string;
  password: string;
  role: "housekeeper" | "supervisor";
};

export type CreateHkStaffResult = {
  ok: boolean;
  userId: string | null;
  email: string | null;
  error: string | null;
};

export async function createHousekeepingStaffUser(
  input: CreateHkStaffInput,
): Promise<CreateHkStaffResult> {
  const { data, error } = await supabase.functions.invoke("create-hk-staff-user", {
    body: input,
  });

  if (error) {
    return {
      ok: false,
      userId: null,
      email: null,
      error: await resolveEdgeFunctionError(error, data),
    };
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, userId: null, email: null, error: "Invalid server response" };
  }

  const row = data as Record<string, unknown>;
  if (row.ok === true) {
    return {
      ok: true,
      userId: typeof row.userId === "string" ? row.userId : null,
      email: typeof row.email === "string" ? row.email : null,
      error: null,
    };
  }

  return {
    ok: false,
    userId: null,
    email: null,
    error: typeof row.error === "string" && row.error.trim() ? row.error : "Create user failed",
  };
}

export function useCreateHousekeepingStaffUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateHkStaffInput) => createHousekeepingStaffUser(input),
    onSuccess: async () => {
      void qc.invalidateQueries({ queryKey: HK_STAFF_ALL_KEY });
      void qc.invalidateQueries({ queryKey: HOUSEKEEPING_STAFF_KEY });
    },
  });
}
