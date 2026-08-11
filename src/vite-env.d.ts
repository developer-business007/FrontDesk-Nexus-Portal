/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  
  readonly VITE_HOTEL_NAME?: string;
  readonly VITE_CHROME_EXTENSION_ID?: string;
  readonly VITE_TERMINAL_ID?: string;
  /** Idle time before auto sign-out (ms). Default 28800000 (8 hours). */
  readonly VITE_IDLE_LOGOUT_MS?: string;
  /** Legacy alias for {@link VITE_IDLE_LOGOUT_MS}. */
  readonly VITE_IDLE_LOCK_MS?: string;
  /** Set to "false" to disable idle auto sign-out (local debugging only). */
  readonly VITE_ENABLE_INACTIVITY_LOCK?: string;
  /** Dev only: set "true" to test Chrome session bridge while running `npm run dev` */
  readonly VITE_ENABLE_SESSION_BRIDGE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
