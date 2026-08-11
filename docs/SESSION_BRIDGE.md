# FrontDesk Nexus — Session bridge contract (v1)

The web portal and the Chrome extension run in different trust boundaries. The portal **cannot** write `chrome.storage.session` directly. This contract defines how the portal publishes Supabase session material to the extension and how that state is invalidated.

## Transport (concrete)

1. **Primary — `chrome.runtime.sendMessage` (externally connectable)**  
   - The extension manifest lists the portal origins under `externally_connectable.matches` (e.g. `https://<your-vercel-app>.vercel.app/*`, `http://localhost:5173/*`).  
   - The portal sets `VITE_CHROME_EXTENSION_ID` to the published extension ID.  
   - After login, token refresh, and successful inactivity unlock, the portal sends:

   ```json
   {
     "channel": "FDN_SESSION_V1",
     "payload": { ... see Session envelope below ... }
   }
   ```

   - The extension background/service worker handles this message and persists tokens in **extension storage** (e.g. `chrome.storage.session` or `local`) — that step is extension-side only.

2. **Fallback — DOM event (dev / tests / no extension ID)**  
   - If `VITE_CHROME_EXTENSION_ID` is unset or `chrome.runtime.sendMessage` is unavailable, the portal dispatches:

   ```ts
   window.dispatchEvent(new CustomEvent("fdn-session-bridge", { detail: payload }));
   ```

   - A thin content script on the portal origin may listen and forward to the background if you prefer not to use `externally_connectable`.

## Session envelope (`schemaVersion`: 1)

### Active session — `kind: "session"`

| Field | Type | Description |
|--------|------|-------------|
| `kind` | `"session"` | Discriminator |
| `schemaVersion` | `1` | Contract version |
| `issuedAtMs` | number | When the envelope was emitted (epoch ms) |
| `accessExpiresAtMs` | number | Access token expiry (from JWT `exp` when parseable) |
| `userId` | string (uuid) | `auth.users.id` |
| `email` | string \| null | Primary email |
| `role` | `"admin"` \| `"manager"` \| `"front_desk"` | From `public.profiles.role` |
| `supabaseUrl` | string | Same origin as `VITE_SUPABASE_URL` |
| `accessToken` | string | Supabase access JWT |
| `refreshToken` | string | Supabase refresh token |

**Security:** Treat `accessToken` and `refreshToken` as secrets on the extension side. Never log them. Prefer storing in `chrome.storage.session` with minimal lifetime.

### Invalidated — `kind: "invalidated"`

| Field | Type | Description |
|--------|------|-------------|
| `kind` | `"invalidated"` | Discriminator |
| `schemaVersion` | `1` | Contract version |
| `issuedAtMs` | number | When invalidation was emitted |
| `reason` | `"logout"` \| `"lock"` \| `"session_expired"` \| `"unknown"` | Why the bridge was cleared |

The extension must **drop cached tokens** and stop using Supabase until a new `kind: "session"` envelope arrives.

## When the portal emits

| Event | Payload |
|--------|---------|
| Successful sign-in | `session` |
| `TOKEN_REFRESHED` | `session` (rotated tokens) |
| Global sign-out | `invalidated` (`reason: logout`) |
| Idle auto sign-out (8 hours, web + extension) | `invalidated` (`reason: logout`) |

## TTL and refresh

- **TTL:** Consumers should treat `accessExpiresAtMs` as authoritative when present; otherwise assume ~55 minutes as a conservative client hint.  
- **Refresh:** The portal relies on Supabase JS `autoRefreshToken` and will emit a new `session` envelope on each refresh. The extension should either (a) listen for repeated `session` messages and update storage, or (b) use the refresh token with Supabase to rotate locally (extension-only implementation).

## Logout alignment

Portal logout calls `supabase.auth.signOut({ scope: 'global' })` and always sends `invalidated` with `reason: logout` so the extension clears its bridge immediately.
