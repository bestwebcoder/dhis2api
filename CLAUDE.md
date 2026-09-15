# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install
pnpm build          # pnpm -r build; shared/ and backend/dhis2-client build before backend/api can `start`
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

Environment is split by side, and there is no root `.env`:

- **`backend/.env`** (from `backend/.env.example`) — everything the API and the worker need. Both load it via a relative `../../.env` URL from `src/main.ts`; `src/` and `dist/` sit at the same depth, so the one path serves `tsx watch` and `node dist/main.js` alike.
- **`frontend/.env`** (from `frontend/.env.example`) — `VITE_*` only. `frontend/vite.config.ts` sets `envDir` to the frontend directory, so a frontend build cannot read backend configuration at all, rather than relying on Vite's `VITE_` filter to keep it out of the bundle.

Put a new key on one side only; if both genuinely need it, they need it for different reasons and get their own copy. `CONNECTION_ENCRYPTION_KEY` must be a base64 32-byte key (`openssl rand -base64 32`) or the API fails at boot.

In production neither file exists — Fly injects real environment variables and `dotenv` simply finds no file, which is also why the image ships without one (`.dockerignore` excludes `**/.env`).

The database schema is applied only by `backend/database/migrations/*.sql` mounted into the Postgres container's `docker-entrypoint-initdb.d`. Edits to migrations take effect on a fresh volume; there is no migration runner, so applying a change to an existing database means `docker compose down -v` or running the SQL by hand.

## Architecture

pnpm workspace, ESM-only (`"type": "module"`, `NodeNext`). Every relative import inside the workspaces carries a `.js` extension even in `.tsx` files. TypeScript is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

```
frontend/                 React 19 + Vite dashboard — the browser app, and nothing else
backend/api               NestJS on Fastify, global prefix /api/v1
backend/worker            BullMQ consumer, currently a stub
backend/dhis2-client      version-aware DHIS2 HTTP adapter (no framework deps)
backend/database          control-plane DDL, mounted into the Postgres container
shared/contracts          zod schemas + shared types; the single source of truth for the API surface
```

The three top-level directories *are* the architecture. `frontend/` depends on
`shared/contracts` and on nothing under `backend/`; `backend/*` never imports from
`frontend/`. `shared/` is deliberately the narrowest thing that both sides need —
the request and response shapes — so that widening the coupling means adding a
package there, visibly, rather than reaching across a directory.

`pnpm-workspace.yaml` lists the workspaces explicitly for the same reason: a new
one has to be placed on one side of the boundary on purpose.

Deployment follows the same split and always has: `Dockerfile` and `fly.toml` build
and ship `backend/api` only, `frontend/` goes to Vercel. Configuration is split the
same way — `backend/.env` and `frontend/.env`, with nothing at the root — so the
boundary holds for secrets as well as for code.

The workspace packages resolve `types` to `src/index.ts` but `import` to `dist/index.js`, so typecheck works from source while runtime needs `pnpm build` first.

### Two databases in one Postgres

There are two distinct layers in the same Postgres instance, and confusing them is the main way to break this codebase:

- **Control plane** — the tables in `001_control_plane.sql` (`dhis2_connections`, `metadata_snapshots`, `schema_blueprints`, `schema_columns`, `sync_definitions`, `sync_schedules`, `sync_cursors`, `sync_runs`, `audit_log`) plus `users` from `002_auth.sql`, the ownership columns (`created_by`, `sync_runs.triggered_by`, `audit_log.actor_id`) from `003_users_rbac.sql`, and the `admin`/`client` role constraint from `004_client_role.sql`. Always queried with bound parameters.
- **Data plane** — reporting tables generated at runtime into the `dhis_data` schema, one per applied blueprint. Their names and columns come from DHIS2 metadata, so their SQL is necessarily interpolated as strings.

Every interpolated identifier must pass the `/^[a-z_][a-z0-9_]{0,62}$/` guard (`quote()` in `sync.service.ts` / `report.service.ts`, the explicit checks in `schema.repository.ts`) before it reaches a query. `schema-generator.ts:safeIdentifier` is what produces names that satisfy it. Never interpolate a value — only identifiers.

### Ownership and data isolation

There are two roles: `admin` and `client` (`004_client_role.sql` renamed the
earlier `analyst`, which could read the whole control plane). **An admin is
unrestricted; a client can only ever see rows they own.** Ownership is the
`created_by` column that `003_users_rbac.sql` put on `dhis2_connections`,
`schema_blueprints` and `sync_definitions`, always `ON DELETE SET NULL` so an
account's work outlives the account.

`common/access-scope.ts` is the whole mechanism. A controller takes `@Caller()`
instead of `@CurrentUser()` and gets an `AccessScope`; services take that scope
rather than an `AuthUser`, because it carries both the identity (for the audit
trail) and the reach.

- **`scope.ownerFilter`** is the single value repositories bind: `null` for an
  admin, the account id for a client. Every scoped query is shaped
  `($1::uuid IS NULL OR <table>.created_by = $1::uuid)`, so one query serves both
  roles and there is no separate unfiltered path to reach by mistake.
- **`scope.assertOwns(ownerId, message)`** guards a row already loaded by id, and
  throws **404, never 403**. A client who guesses another client's UUID must not
  be able to tell a row that exists from one that does not, or the API becomes an
  oracle for enumerating other accounts' data. A row with a null `created_by` is
  equally invisible to a client.

Isolation is applied at every read surface, not only the obvious ones:
connections, blueprints, syncs, `GET /reports` and its CSV export, **every one of
the six queries in a configuration backup**, and every dashboard count. Two
deliberate exceptions, both commented where they live:
`ConnectionService.getAuthenticatedClient` (the scheduler opens a connection with
no request behind it) and `SyncRepository`'s internal reloads by id after a write
the caller was already authorised for.

`common/isolation.test.ts` is the regression net: it drives each service with a
client scope against rows owned by someone else and asserts the refusal, and
asserts that report and backup reads bind the owner filter *in SQL* rather than
filtering in memory. Add a read surface, add it there.

One limit worth knowing: `tableNameFor` derives a data table's name from the
DHIS2 resource, so two accounts pointed at the same server would generate the
same physical table and share rows. `SchemaService.generate` detects that and
refuses with a 409 naming the other owner, rather than letting API-level
isolation quietly stop at the table boundary.

### Accounts and the dashboard

Every create path records the caller, which is what makes `GET /dashboard`
individual rather than merely role-shaped.

`backend/api/src/dashboard/` builds one view per caller. `DashboardService` picks the
metrics and the "needs attention" list from the role — an admin sees credential
failures, failed runs and stalled schedules, because only an admin can act on them;
a client's dashboard leads with their own endpoints and lists their unapplied
blueprints and tables whose last run did not finish. The route carries no
`@Roles`, because every query behind it is owner-filtered anyway;
`auth/route-protection.test.ts` pins that it stays open and that account
administration stays closed.

`backend/api/src/users/` is account administration: an admin creates client accounts
by hand (`POST /users`, which deliberately bypasses `AUTH_ALLOW_SIGNUP` — closing
self-service sign-up is what makes this *the* way accounts are created), monitors
them (`GET /users`, which carries each account's `owns` counts), and decides which
client an endpoint belongs to (`PUT /connections/:id/owner`). The users table keeps
its single repository in `auth/user.repository.ts`, which `AuthModule` exports.
Self-service (`PUT /users/me/profile`, `POST /users/me/password`) is open to any
signed-in account and can only touch the caller's own row; everything else is
`@Roles("admin")`.

`backend/api/src/common/` holds what crosses feature modules: `AuditService` (the
write path for `audit_log`, which nothing used before) and `RunRegistry` (the
in-flight sync definitions, so `SchemaService` can refuse to drop a table a run is
writing into without importing `SyncModule`). Both live in a `@Global` `CommonModule`.

### Deleting

`common/deletion.ts` holds the shared rules: `requireConfirmation` (one message
everywhere, and an array or blank `?confirm=` can never match), `rejectDanglingReferences`
(a foreign-key violation becomes the 409 the caller would have got a moment
earlier, not a 500) and `summarise` (a response names only what was really removed).

The rule that matters: **a dependency check and the delete it guards belong in the
same transaction.** `SchemaRepository.dropTable` takes `FOR UPDATE` on the blueprint
and on every dependent sync definition, then decides; checking first and dropping
afterwards leaves a window in which a new sync definition is created and silently
cascaded away. It also refuses while any dependant is in `RunRegistry`, and the
`DROP TABLE`'s own `ACCESS EXCLUSIVE` lock covers the remaining race.

`SyncRepository.clearRuns` deletes finished runs only — deleting the row of a run
still in flight loses its result, because `finishRun` updates by id. Deleting an
account never cascades into the control plane, and the admin floor (at least one
active admin) is held by a transaction-scoped advisory lock so two concurrent
demotions cannot each see the other still standing.

### Pipeline

1. **Connection** (`connections/`) — base URL is normalized (`normalizeDhis2BaseUrl` strips `/api` and `/api/<version>` suffixes), credentials are verified against `/api/me`, the version comes from `/api/system/info`, and `inferCapabilities` turns that version into a per-API availability map with a `detected | inferred | unknown` confidence. The credential is AES-256-GCM encrypted by `SecretCipherService` into three columns (`encrypted_secret`, `secret_iv`, `secret_tag`); secrets never appear in a response — only `ConnectionSummary`.
2. **Metadata** (`metadata/`) — a Program or Data Set is fetched and stored as an immutable `metadata_snapshots` row keyed by a content hash, so the same metadata is never stored twice and a blueprint always points at exactly the metadata it was generated from.
3. **Schema** (`schema/`) — `schema-generator.ts` deterministically maps DHIS2 value types to SQL types, allocates collision-free column names, and adds a derived `*_name` display column beside any option-set-coded column. Generation is rules-based on purpose; keep it deterministic. Applying a blueprint runs `createTableSql` plus `reconcileTableColumnsSql` (additive `ALTER TABLE`) in one transaction, so re-applying an evolved blueprint upgrades an existing table rather than recreating it.
4. **Sync** (`sync/`) — pulls tracker or aggregate data and flattens it. Writes go to a per-run staging table (`sync_<table>_<runid>`), then `commitStagingTable` takes an `ACCESS EXCLUSIVE` lock, truncates, and swaps in one transaction: **a run is a full replace, not an incremental merge**, and `sync_cursors` is not yet used. Requests that fail with a size/timeout-shaped error (`canSplitRequestError`) are retried by halving the date range, then by splitting the org-unit list. `trackerPageSize` shrinks the page size based on the program's attribute/data-element count.
5. **Reports & backups** (`reports/`, `backups/`) — read the applied `dhis_data` tables directly, paginate, and export CSV/JSON. `raw_payload` (the untouched DHIS2 record) and `sync_run_id` are on every generated row and are excluded from filterable text columns.

### Scheduling

`SyncService` implements `OnModuleInit` and runs a `setInterval` poll every 5s inside the API process (`sync.service.ts:289`) — the BullMQ worker in `backend/worker` receives no real jobs yet. Overlap is prevented by the in-memory `RunRegistry` (`common/run-registry.service.ts`), which means **this only works with a single API replica**; a second replica would double-run schedules. Moving execution into the worker is the intended fix.

This is why the API cannot be hosted serverlessly: nothing stays resident to poll. `Dockerfile` and `fly.toml` in the repo root deploy it to Fly with `auto_stop_machines = false` and a single machine; README covers the secrets and the one-off schema step. Do not raise the machine count without moving execution to the worker first.

### Authentication

`backend/api/src/auth/` owns control-plane accounts, which are unrelated to the DHIS2 credentials in `dhis2_connections`. An `APP_GUARD` in `app.module.ts` registers `AuthGuard` globally, so **every route is closed unless it carries `@Public()`** — only `/auth/register`, `/auth/login`, `/auth/google` and `/health` do. A new controller is therefore protected without anyone remembering to protect it; use `@CurrentUser()` to read the caller.

The guard verifies the HS256 bearer token (`TokenService` pins `algorithms` so an `alg: none` or key-confusion token is rejected) and then resolves the subject against the `users` table on every request, so a deleted or deactivated account loses access immediately instead of at token expiry. Passwords are scrypt (`PasswordService`, `N=2^15, r=8, p=1`) stored as a self-describing `scrypt$N$r$p$salt$key` string, compared with `timingSafeEqual`; sign-in verifies against a decoy hash when no account matches so a wrong email costs the same as a wrong password, and both failures return one message. The first account created on an empty table becomes the `admin`; `AUTH_ALLOW_SIGNUP=false` closes self-service sign-up to everyone after that. `AUTH_JWT_SECRET` (≥32 chars) is required or the API fails at boot, like `CONNECTION_ENCRYPTION_KEY`.

**Google sign-in** is optional and on only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are both set (backend) and `VITE_GOOGLE_CLIENT_ID` is set (frontend). `frontend/src/google-auth.ts` runs the authorization-code flow with PKCE and `state` held in `sessionStorage`, redirecting back to the site root; `App.tsx` takes the callback once, strips it from the URL, and `auth.ts:startSession` memoises the exchange because a code is single-use and StrictMode runs effects twice. `GoogleOAuthService` exchanges the code with the secret and checks `iss`/`aud`/`azp`/`exp`/`email_verified`, then `AuthService.signInWithGoogle` issues the ordinary session token — Google's tokens are discarded. Accounts link by `users.google_subject` (the OpenID `sub`), never by email: a sign-in whose email matches an existing account is **refused, not linked**, because password accounts have unverified emails and auto-linking would let a pre-registered password survive into the real owner's account. Linking is `POST /users/me/google` from a signed-in session and requires the Google email to equal the account email. `005_google_identity.sql` makes `password_hash` nullable with a check that every account keeps at least one credential; `unlinkGoogle` re-checks that in its `UPDATE`. Google failures return 400/503, never 401 — `api.ts` treats any 401 outside `/auth/` as an expired session.

`RolesGuard` is registered as a second `APP_GUARD` **after** `AuthGuard`, so it can trust `request.user`. It is inert on routes without `@Roles(...)`, and returns `403` otherwise. `@Roles("admin")` covers every `DELETE` endpoint — connections, sync definitions, schedules, run history, blueprints, accounts, and the `DROP TABLE` — plus `POST /sync-definitions/:id/run` (a run is a full replace, so it destroys the table's current contents), all of `/users` except the `/users/me/*` self-service routes, and `PUT /connections/:id/owner`. A client can read, create, edit and apply **within what they own**, but cannot destroy anything, manage accounts, or move ownership.

Note the two mechanisms are independent and both apply: `RolesGuard` answers *may this account call this route*, and `AccessScope` answers *which rows does this call return*. A client calling `GET /connections` passes the guard and gets their own endpoints; a client calling `DELETE /connections/:id` is stopped by the guard before ownership is ever consulted.

Adding a destructive route means adding the decorator; the guard cannot infer it from the HTTP verb. `auth/route-protection.test.ts` reflects over every controller and fails if a `DELETE` route, or the sync run, ever loses its `@Roles("admin")` — it also pins the list of `@Public()` routes, the self-service account routes, and that `GET /dashboard` stays open to every signed-in account. A new controller must be added to that test's list or it is not covered.

**Scheduled** runs are unaffected: the poller calls `SyncService.run` directly (`sync.service.ts:711`), never through the controller, so guards do not apply to them. Gating the endpoint restricts who can trigger a run by hand, not whether existing schedules fire.

`frontend/src/auth-context.tsx` mirrors this in the UI: `useIsAdmin()` hides delete controls and the manual-run button for clients, `AdminOnlyNote` explains why in the panel heading, and `App.tsx` keeps the management panel out of a client's navigation. That is all cosmetic — the API is the authority, a hand-made request from a client still gets `403`, and *which rows* anyone sees is decided per query by `AccessScope`, never by the UI.

### Request validation

Controllers take `@Body() body: unknown` and validate with a zod schema from `@dhis-sync/contracts` via a local `parse*` helper that raises `BadRequestException` with `path: message` strings. There is no global `ValidationPipe` and no DTO classes — follow the existing per-controller pattern. UUID params use `ParseUUIDPipe`. Destructive endpoints take a `?confirm=<name>` query parameter that must match the entity's name.

### Frontend

`frontend/src/api.ts` is the only place that talks to the API; each page component (`ConnectionManager`, `SchemaBuilder`, `SyncSchedules`, `Reports`, `Backups`, `AdminPanel`) owns its own fetch state and `App.tsx` switches between them with `useState` — no router, no data-fetching library, no CSS framework. `Overview` renders whatever `GET /dashboard` returns rather than computing its own totals, which is why a client's overview is their data without the component knowing anything about roles.

`App.tsx` gates the dashboard: with no session it renders `LandingPage` (marketing home page) plus `AuthDialog`, and the sidebar shell only once a user is resolved. Only the bearer token is cached (`localStorage`, `d2hub.token` via `session-token.ts`); the user object is never trusted from storage — on boot `restoreSession()` re-validates the token against `GET /auth/me`, and the shell waits behind a "Restoring your session" screen. `api.ts` attaches the token to every request and download, and a `401` from any endpoint calls `notifySessionExpired()`, which clears the token and drops the whole app back to signed-out rather than surfacing a per-page error. Because a bearer header cannot ride on a plain `<a href>`, the CSV export and backups both go through the authenticated blob download in `api.ts`. `VITE_API_URL` is embedded at build time; `vite.config.ts` hard-fails a Vercel production build when it is missing, non-HTTPS, or localhost.

### Theme and the persistent header

`frontend/src/theme.ts` owns the light/dark preference: `light | dark | system`,
stored under `d2hub.theme`, defaulting to `system` and re-resolving when the OS
setting changes. `applyTheme` stamps `data-theme` on `<html>` and moves the
`theme-color` meta; `main.tsx` calls it **before** `createRoot`, so the first paint
is already correct and a dark-mode user never sees a white flash.

`styles.css` carries the whole palette as custom properties on `:root`, with
`:root[data-theme="dark"]` redefining the same names — a theme is a palette swap,
not a second stylesheet. Components whose colour is a *pair* (tinted background
plus matching text: alerts, pills, the danger button) get an explicit dark rule in
the block right under the tokens, which wins on specificity wherever it sits.
Adding a component means using the tokens; only add to that block if it needs a
tinted pair. The landing page is deliberately exempt — it is a dark hero in both
themes.

The authenticated shell's `.topbar` is a sticky `<header>` rendered on every page,
holding the Home link (back to the Overview), the theme toggle and the account
menu. Below 900px the sidebar is hidden and this header is the entire navigation,
which is why the Home link and toggle collapse to their icons rather than dropping
out.
