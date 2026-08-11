# FrontDesk Nexus — Web Portal

React + TypeScript SPA for front desk and managers. Backend: **Supabase** (Postgres, Realtime, Storage). **Sign-in is currently removed** from this app; use optional `VITE_DEV_*` values in `.env` for display and for DNR/audit user ids. Hosts cleanly on **Vercel**.

Database tables and RLS are maintained **in your Supabase project** (this repo does not ship SQL migrations — align your schema with the queries in `src/`).

## Prerequisites

- Node.js 20+
- A Supabase project with the FrontDesk schema applied (profiles, reservations, id_scans, dnr_entries, audit_log, terminals, etc.)

## Run locally

```bash
cp .env.example .env
# Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or publishable client key per your dashboard)
npm install
npm run dev
```

Open the URL Vite prints (typically `http://localhost:5173`).

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `VITE_SUPABASE_URL` | Yes | Project URL |
| `VITE_SUPABASE_ANON_KEY` | Yes | Public client key (anon / publishable — not `service_role`) |
| `VITE_HOTEL_NAME` | No | Dashboard title; defaults to "FrontDesk Nexus" |
| `VITE_DEV_USER_LABEL` | No | Shown in the shell header and dashboard; defaults to `Guest` |
| `VITE_DEV_USER_ID` | No | UUID for DNR add/remove and `audit_log.user_id` when auth is off |
| `VITE_DEV_USER_EMAIL` | No | Optional username on audit rows |
| `VITE_DEV_USER_ROLE` | No | Optional role string on audit rows; defaults to `manager` |
| `VITE_CHROME_EXTENSION_ID` | No | Reserved for a future session bridge (see `docs/SESSION_BRIDGE.md`) |
| `VITE_TERMINAL_ID` | No | UUID of a `public.terminals` row, stored on `audit_log.terminal_id` |

## Supabase setup

1. **Realtime:** enable replication for `reservations` and `id_scans` if you want live updates on Guest detail (**Database → Replication**).
2. **Storage:** ensure a private bucket (e.g. `id-scans`) exists with policies so your client key can read objects referenced by `id_scans.image_front_path` / `image_back_path`.

### When you re-enable Supabase Auth

Configure **Auth → URL configuration** (site URL and redirect URLs), wire a login flow back into the app, and use `public.profiles` for roles again.

### Demo data (optional)

Insert a `reservations` row and matching `id_scans` (with `pii_encrypted` as `{}` or a valid JSON object per your constraints). Upload images to your storage bucket and set `image_front_path` / `image_back_path` to the object keys.

## Deploy to Vercel

1. Connect this repo/folder to Vercel (framework: Vite).
2. Set the same `VITE_*` variables as in `.env.example`.
3. `vercel.json` rewrites all routes to `index.html` for client-side routing.

## Chrome extension session bridge

See **[docs/SESSION_BRIDGE.md](docs/SESSION_BRIDGE.md)**.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck + production build |
| `npm run preview` | Preview production build |
| `npm run lint` | ESLint |
