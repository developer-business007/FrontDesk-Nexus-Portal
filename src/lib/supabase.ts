import { createClient } from "@supabase/supabase-js";
import type { UserRole } from "@/types/roles";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anon) {
  console.warn(
    "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing — set them in .env for a working build.",
  );
}

export const supabase = createClient(
  url ?? "https://placeholder.supabase.co",
  anon ?? "placeholder",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: typeof window !== "undefined" ? window.localStorage : undefined,
      flowType: "pkce",
    },
  },
);

export function assertSupabaseConfigured(): void {
  if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
    throw new Error("Supabase is not configured. Copy .env.example to .env and add your keys.");
  }
}

export type AuthProfile = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: UserRole;
};
