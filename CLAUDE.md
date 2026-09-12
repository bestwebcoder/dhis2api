# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install
pnpm build          # pnpm -r build; packages/* must be built before apps/* can `start`
pnpm typecheck      # tsc --noEmit across every workspace
pnpm test           # vitest run in every workspace

pnpm dev:api        # tsx watch, http://localhost:4000/api/v1
pnpm dev:web        # vite, http://127.0.0.1:5173
pnpm dev:worker     # BullMQ consumer

docker compose up -d postgres redis   # Postgres :5433, Redis :6380 (non-default ports)
```

Single test file or case (run from the workspace directory):

```bash
pnpm --filter @dhis-sync/api exec vitest run src/sync/sync.service.test.ts
pnpm --filter @dhis-sync/api exec vitest run -t "splits inclusive ranges"
```

All tests are pure unit tests with mocked repositories/`fetch` — none need Postgres, Redis, or a live DHIS2 server. Keep it that way; there is no integration-test harness.

Environment lives in a single root `.env` (copied from `.env.example`). Both `apps/api` and `apps/worker` load it via a relative `../../../.env` URL from `src/main.ts`, and `apps/web/vite.config.ts` sets `envDir` to the repo root — do not add per-workspace `.env` files. `CONNECTION_ENCRYPTION_KEY` must be a base64 32-byte key (`openssl rand -base64 32`) or the API fails at boot.

The database schema is applied only by `database/migrations/*.sql` mounted into the Postgres container's `docker-entrypoint-initdb.d`. Edits to migrations take effect on a fresh volume; there is no migration runner, so applying a change to an existing database means `docker compose down -v` or running the SQL by hand.

## Architecture

pnpm workspace, ESM-only (`"type": "module"`, `NodeNext`). Every relative import inside the workspaces carries a `.js` extension even in `.tsx` files. TypeScript is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

```
packages/contracts     zod schemas + shared types; the single source of truth for the API surface
packages/dhis2-client   version-aware DHIS2 HTTP adapter (no framework deps)
apps/api                NestJS on Fastify, global prefix /api/v1
apps/web                React 19 + Vite dashboard
apps/worker             BullMQ consumer, currently a stub
database/migrations     control-plane DDL
```

`packages/*` resolve `types` to `src/index.ts` but `import` to `dist/index.js`, so typecheck works from source while runtime needs `pnpm build` first.

### Two databases in one Postgres

There are two distinct layers in the same Postgres instance, and confusing them is the main way to break this codebase:

- **Control plane** — the tables in `001_control_plane.sql` (`dhis2_connections`, `metadata_snapshots`, `schema_blueprints`, `schema_columns`, `sync_definitions`, `sync_schedules`, `sync_cursors`, `sync_runs`, `audit_log`) plus `users` from `002_auth.sql`. Always queried with bound parameters.
- **Data plane** — reporting tables generated at runtime into the `dhis_data` schema, one per applied blueprint. Their names and columns come from DHIS2 metadata, so their SQL is necessarily interpolated as strings.

Every interpolated identifier must pass the `/^[a-z_][a-z0-9_]{0,62}$/` guard (`quote()` in `sync.service.ts` / `report.service.ts`, the explicit checks in `schema.repository.ts`) before it reaches a query. `schema-generator.ts:safeIdentifier` is what produces names that satisfy it. Never interpolate a value — only identifiers.

### Pipeline

1. **Connection** (`connections/`) — base URL is normalized (`normalizeDhis2BaseUrl` strips `/api` and `/api/<version>` suffixes), credentials are verified against `/api/me`, the version comes from `/api/system/info`, and `inferCapabilities` turns that version into a per-API availability map with a `detected | inferred | unknown` confidence. The credential is AES-256-GCM encrypted by `SecretCipherService` into three columns (`encrypted_secret`, `secret_iv`, `secret_tag`); secrets never appear in a response — only `ConnectionSummary`.
2. **Metadata** (`metadata/`) — a Program or Data Set is fetched and stored as an immutable `metadata_snapshots` row keyed by a content hash, so the same metadata is never stored twice and a blueprint always points at exactly the metadata it was generated from.
3. **Schema** (`schema/`) — `schema-generator.ts` deterministically maps DHIS2 value types to SQL types, allocates collision-free column names, and adds a derived `*_name` display column beside any option-set-coded column. Generation is rules-based on purpose; keep it deterministic. Applying a blueprint runs `createTableSql` plus `reconcileTableColumnsSql` (additive `ALTER TABLE`) in one transaction, so re-applying an evolved blueprint upgrades an existing table rather than recreating it.
4. **Sync** (`sync/`) — pulls tracker or aggregate data and flattens it. Writes go to a per-run staging table (`sync_<table>_<runid>`), then `commitStagingTable` takes an `ACCESS EXCLUSIVE` lock, truncates, and swaps in one transaction: **a run is a full replace, not an incremental merge**, and `sync_cursors` is not yet used. Requests that fail with a size/timeout-shaped error (`canSplitRequestError`) are retried by halving the date range, then by splitting the org-unit list. `trackerPageSize` shrinks the page size based on the program's attribute/data-element count.
5. **Reports & backups** (`reports/`, `backups/`) — read the applied `dhis_data` tables directly, paginate, and export CSV/JSON. `raw_payload` (the untouched DHIS2 record) and `sync_run_id` are on every generated row and are excluded from filterable text columns.

### Scheduling

`SyncService` implements `OnModuleInit` and runs a `setInterval` poll every 5s inside the API process (`sync.service.ts:236`) — the BullMQ worker in `apps/worker` receives no real jobs yet. Overlap is prevented by an in-memory `runningDefinitions` set, which means **this only works with a single API replica**; a second replica would double-run schedules. Moving execution into the worker is the intended fix.

This is why the API cannot be hosted serverlessly: nothing stays resident to poll. `Dockerfile` and `fly.toml` in the repo root deploy it to Fly with `auto_stop_machines = false` and a single machine; README covers the secrets and the one-off schema step. Do not raise the machine count without moving execution to the worker first.

### Authentication

`apps/api/src/auth/` owns control-plane accounts, which are unrelated to the DHIS2 credentials in `dhis2_connections`. An `APP_GUARD` in `app.module.ts` registers `AuthGuard` globally, so **every route is closed unless it carries `@Public()`** — only `/auth/register`, `/auth/login` and `/health` do. A new controller is therefore protected without anyone remembering to protect it; use `@CurrentUser()` to read the caller.

The guard verifies the HS256 bearer token (`TokenService` pins `algorithms` so an `alg: none` or key-confusion token is rejected) and then resolves the subject against the `users` table on every request, so a deleted or deactivated account loses access immediately instead of at token expiry. Passwords are scrypt (`PasswordService`, `N=2^15, r=8, p=1`) stored as a self-describing `scrypt$N$r$p$salt$key` string, compared with `timingSafeEqual`; sign-in verifies against a decoy hash when no account matches so a wrong email costs the same as a wrong password, and both failures return one message. The first account created on an empty table becomes the `admin`; `AUTH_ALLOW_SIGNUP=false` closes self-service sign-up to everyone after that. `AUTH_JWT_SECRET` (≥32 chars) is required or the API fails at boot, like `CONNECTION_ENCRYPTION_KEY`.

`RolesGuard` is registered as a second `APP_GUARD` **after** `AuthGuard`, so it can trust `request.user`. It is inert on routes without `@Roles(...)`, and returns `403` otherwise. `@Roles("admin")` covers every `DELETE` endpoint — connections, sync definitions, schedules, run history, blueprints, and the `DROP TABLE` — plus `POST /sync-definitions/:id/run`, because a run is a full replace and therefore destroys the table's current contents. An analyst can read, create, edit and apply, but cannot destroy anything.

Adding a destructive route means adding the decorator; the guard cannot infer it from the HTTP verb. `auth/route-protection.test.ts` reflects over every controller and fails if a `DELETE` route, or the sync run, ever loses its `@Roles("admin")` — it also pins the list of `@Public()` routes.

**Scheduled** runs are unaffected: the poller calls `SyncService.run` directly (`sync.service.ts:670`), never through the controller, so guards do not apply to them. Gating the endpoint restricts who can trigger a run by hand, not whether existing schedules fire.

`apps/web/src/auth-context.tsx` mirrors this in the UI: `useIsAdmin()` hides delete controls and the manual-run button for analysts, and `AdminOnlyNote` explains why in the panel heading. That is cosmetic only — the API is the authority, and a hand-made request from an analyst still gets `403`.

### Request validation

Controllers take `@Body() body: unknown` and validate with a zod schema from `@dhis-sync/contracts` via a local `parse*` helper that raises `BadRequestException` with `path: message` strings. There is no global `ValidationPipe` and no DTO classes — follow the existing per-controller pattern. UUID params use `ParseUUIDPipe`. Destructive endpoints take a `?confirm=<name>` query parameter that must match the entity's name.

### Frontend

`apps/web/src/api.ts` is the only place that talks to the API; each page component (`ConnectionManager`, `SchemaBuilder`, `SyncSchedules`, `Reports`, `Backups`) owns its own fetch state and `App.tsx` switches between them with `useState` — no router, no data-fetching library, no CSS framework.

`App.tsx` gates the dashboard: with no session it renders `LandingPage` (marketing home page) plus `AuthDialog`, and the sidebar shell only once a user is resolved. Only the bearer token is cached (`localStorage`, `d2hub.token` via `session-token.ts`); the user object is never trusted from storage — on boot `restoreSession()` re-validates the token against `GET /auth/me`, and the shell waits behind a "Restoring your session" screen. `api.ts` attaches the token to every request and download, and a `401` from any endpoint calls `notifySessionExpired()`, which clears the token and drops the whole app back to signed-out rather than surfacing a per-page error. Because a bearer header cannot ride on a plain `<a href>`, the CSV export and backups both go through the authenticated blob download in `api.ts`. `VITE_API_URL` is embedded at build time; `vite.config.ts` hard-fails a Vercel production build when it is missing, non-HTTPS, or localhost.
