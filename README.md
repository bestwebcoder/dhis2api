# DHIS2 Interoperability Hub

An interoperability and data-sync platform for connecting DHIS2 instances, generating relational reporting schemas, scheduling synchronization work, and producing flattened tracker reports.

The repository contains an end-to-end local implementation of the connection, schema, synchronization, reporting, and backup workflow.

## What is implemented

- React dashboard shell, connection manager, and an administrator management panel
- Light and dark themes, following the operating system by default and remembered per browser
- A persistent sticky header on every signed-in page, carrying the Home link, the theme control and the account menu
- Administrator and client roles, with per-query data isolation so a client only ever reaches their own endpoints, tables and rows
- Per-account dashboards built from one `GET /dashboard` call, shaped by role and filled from what the account owns
- Source, destination, and bidirectional endpoint roles
- Personal access token and basic authentication support
- AES-256-GCM credential encryption before PostgreSQL storage
- DHIS2 base URL normalization, including context paths and versioned `/api` URLs
- Version detection through `/api/system/info`
- Credential verification through `/api/me`
- Version-aware capability inference for tracker, aggregate, metadata, enrollment analytics, and push analytics APIs
- PostgreSQL control-plane schema for metadata snapshots, generated table blueprints, schedules, cursors, and synchronization runs
- Live Program and Data Set discovery with immutable, hashed metadata snapshots
- Relational schema generation with DHIS2 value-type mapping, semantic filter hints, and safe SQL identifiers
- Multi-stage tracker flattening with latest-event, first-event, aggregate, and normalized policies
- Reviewed table application and confirmed cascading table removal
- Manual tracker and aggregate synchronization with modern and legacy DHIS2 API compatibility
- Background interval scheduling with execution limits, active/paused states, and run history
- Immediate first execution when a schedule is activated, five-second due-work polling, overlap protection, and automatic pausing at the execution limit
- Single-line reports with facility, patient identifier, date, and full-text filters
- Paginated report data plus year-filtered CSV/JSON data and credential-free configuration exports
- Redis and BullMQ worker boundary for future distributed job execution; the current API also includes a lightweight scheduler for local development

## Repository layout

Frontend and backend are separated at the top level, and the separation is the
point: `frontend/` depends on `shared/` and never on `backend/`, `backend/` never
imports from `frontend/`, and `shared/` holds only the request and response shapes
both sides have to agree on.

```text
frontend/         React and Vite dashboard — the browser app
backend/
  api/            NestJS and Fastify control API
  worker/         BullMQ synchronization worker
  dhis2-client/   Version-aware DHIS2 HTTP adapter
  database/
    migrations/   PostgreSQL control-plane migrations
shared/
  contracts/      API contracts and validation, used by both sides
```

They deploy independently: `Dockerfile` and `fly.toml` build `backend/api` only,
and `frontend/` goes to Vercel. Configuration is split the same way — `backend/.env`
holds the database URL, the encryption key and the token secret; `frontend/.env`
holds only `VITE_API_URL`. There is no root `.env`, so a frontend build has no path
to backend configuration at all.

## Local setup

Requirements: Node.js 22 or newer, pnpm 11, and Docker.

1. Create the local environment files — one per side, and there is no root `.env`:

   ```bash
   cp backend/.env.example backend/.env      # database URL, keys, token secret
   cp frontend/.env.example frontend/.env    # VITE_API_URL only
   ```

2. Generate an encryption key and put it in `backend/.env` as `CONNECTION_ENCRYPTION_KEY`:

   ```bash
   openssl rand -base64 32
   ```

3. Start PostgreSQL and Redis:

   ```bash
   docker compose up -d postgres redis
   ```

   The development ports default to PostgreSQL `5433` and Redis `6380` to avoid common local conflicts. Override them with `POSTGRES_PORT` and `REDIS_PORT` if needed.

4. Install dependencies and build the shared packages:

   ```bash
   pnpm install
   pnpm build
   ```

5. Run the services in separate terminals:

   ```bash
   pnpm dev:api
   pnpm dev:worker
   pnpm dev:web
   ```

Open [http://localhost:5173](http://localhost:5173). The API health endpoint is [http://localhost:4000/api/v1/health](http://localhost:4000/api/v1/health).

## API deployment (Fly.io)

The API needs a **persistent** host: `SyncService` polls for due schedules every
5s inside the process, and a tracker download can run for many minutes. Serverless
platforms cannot host it — a Vercel deployment boots per request, so schedules
never fire. `Dockerfile` and `fly.toml` in the repo root cover this; the dashboard
stays on Vercel.

```bash
fly launch --no-deploy               # reuses the checked-in fly.toml
fly postgres create --name dhis2api-db --region sin
fly postgres attach dhis2api-db      # sets DATABASE_URL for you

# CONNECTION_ENCRYPTION_KEY encrypts stored DHIS2 credentials. A new key cannot
# decrypt rows written under an old one, so generate it once and keep it safe.
fly secrets set \
  CONNECTION_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  AUTH_JWT_SECRET="$(openssl rand -base64 48)" \
  WEB_ORIGIN="https://YOUR_FRONTEND_HOST"

fly deploy
fly ssh console -C "true"            # then apply the schema, below
curl https://YOUR_APP.fly.dev/api/v1/health
```

There is no migration runner, so apply the schema once against the attached
database — `fly proxy` forwards it to a local port:

```bash
fly proxy 15432:5432 -a dhis2api-db   # leave running in one terminal
psql "postgresql://postgres:PASSWORD@localhost:15432/dhis2api" \
  -v ON_ERROR_STOP=1 \
  -f backend/database/migrations/001_control_plane.sql \
  -f backend/database/migrations/002_auth.sql \
  -f backend/database/migrations/003_users_rbac.sql \
  -f backend/database/migrations/004_client_role.sql
```

Then open the dashboard and sign up — the first account on an empty `users` table
becomes the admin — and re-add each DHIS2 connection, since credentials encrypted
under a different key cannot be carried over.

**Keep this at exactly one machine.** Overlap between scheduled runs is prevented
by an in-memory set, so a second machine double-runs every schedule against the
same tables. `fly scale count 1`, and move execution into `backend/worker` before
scaling out.

The image builds and runs locally too, which is the quickest way to check a change
before deploying:

```bash
docker build -t dhis2api:local .
docker run --rm -p 4100:4000 --network dhis2api_default \
  -e DATABASE_URL="postgresql://dhis_sync:dhis_sync@postgres:5432/dhis_sync" \
  -e CONNECTION_ENCRYPTION_KEY="$(grep '^CONNECTION_ENCRYPTION_KEY=' backend/.env | cut -d= -f2-)" \
  -e AUTH_JWT_SECRET="$(openssl rand -base64 48)" \
  dhis2api:local
```

## Vercel frontend deployment

The Vite dashboard and NestJS API are separate services. Deploying the dashboard
does not start the API, PostgreSQL, or the background scheduler.

1. Deploy `backend/api` on a persistent host — see the Fly.io section above — with the
   backend environment variables from `backend/.env.example` and a reachable PostgreSQL.
2. Verify `https://YOUR_BACKEND_HOST/api/v1/health` responds successfully.
3. On the backend, set `WEB_ORIGIN=https://YOUR_FRONTEND_HOST` (no trailing slash)
   and restart it so CORS allows your frontend's exact origin.
4. In the Vercel frontend project's Settings → Environment Variables, set
   `VITE_API_URL=https://YOUR_BACKEND_HOST/api/v1` for Production and, if used,
   Preview. This is the hub backend URL, not a DHIS2 instance URL.
5. Redeploy the frontend. Vite embeds the API URL during the build; editing an
   environment variable does not update an existing deployment.

Vercel builds reject missing, localhost, and non-HTTPS API URLs. Local development
still supports `http://localhost:4000/api/v1`. Backend secrets such as
`DATABASE_URL` and `CONNECTION_ENCRYPTION_KEY` belong on the backend and must not
use the browser-visible `VITE_` prefix.

## Connection API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/connections` | List safe connection summaries |
| `POST` | `/api/v1/connections/test` | Test credentials without saving them |
| `POST` | `/api/v1/connections` | Encrypt and save a connection |
| `POST` | `/api/v1/connections/:id/test` | Retest a saved connection |
| `DELETE` | `/api/v1/connections/:id?confirm=<name>` | Delete an unused connection with typed confirmation |

Secrets are never included in an API response. The current implementation intentionally stores only an encrypted credential envelope and a safe summary of the authenticated DHIS2 user.

## Main API areas

| Area | Routes |
| --- | --- |
| Dashboard | `GET /dashboard` — one route, shaped by the caller's role and filled only with rows they own |
| Accounts | `PUT /users/me/profile`, `POST /users/me/password` (any account); `GET/POST /users`, `GET/PUT /users/:id`, `DELETE /users/:id?confirm=<email>` (admin) |
| Endpoint ownership | `PUT /connections/:id/owner` (admin) — hand an endpoint to a client, or take it back with `null` |
| Metadata | `GET /metadata/connections/:id/resources`, `POST /metadata/discover` |
| Schemas | `GET/POST /schema-blueprints`, `POST /schema-blueprints/:id/apply`, `DELETE /schema-blueprints/:id/table`, `DELETE /schema-blueprints/:id/blueprint` |
| Sync | `GET/POST /sync-definitions`, `POST /sync-definitions/:id/run`, `PUT/DELETE /sync-definitions/:id/schedule`, `DELETE /sync-definitions/:id/runs`, `DELETE /sync-definitions/:id` |
| Reports | `GET /reports`, `GET /reports/:id/data`, `GET /reports/:id/export.csv` |
| Backups | `GET /backups/configuration.json`, `GET /backups/:id/years`, `GET /backups/:id/data.json`, `GET /backups/:id/data.csv` |

All paths above are below `/api/v1`.

### Roles and data isolation

There are two roles. The **first account created on an empty `users` table becomes
the administrator**; every account after that is a **client**, and an administrator
creates them by hand from the management panel.

| | Administrator | Client |
| --- | --- | --- |
| Sees | the whole control plane | only what they own |
| Accounts | create, edit, deactivate, delete | their own profile and password |
| Endpoints | all, and decides who owns each | only theirs, and may add their own |
| Tables, syncs, reports, backups | all | only those built from their endpoints |
| Destructive actions | yes | no |

Isolation is enforced per query on the API, not in the UI. Each request carries an
`AccessScope`: an administrator's owner filter is `null` and lifts the restriction,
a client's is their account id and is bound into every read — connections,
blueprints, syncs, reports and their CSV exports, every table in a configuration
backup, and every number on the dashboard.

Reaching for another account's row by id returns **404, not 403**. That is
deliberate: a 403 would confirm the row exists, which would let anyone enumerate
other accounts' data by guessing UUIDs.

One structural limit: a data table's name is derived from the DHIS2 resource it
came from, so two accounts pointed at the same DHIS2 server would generate the
same physical table. Rather than let them silently share rows, generating a
blueprint for a table another account already owns is refused with a `409` naming
that owner.

### Deleting things

Every destructive route is reserved for `admin` and takes `?confirm=<name>` — the
entity's own name, or the account's email, typed back exactly. The response says
what else went with it (`cascaded`) and what survived with a null reference
(`orphaned`), so nothing is removed that the caller did not see coming:

- A **connection** is refused while any sync definition or blueprint still uses
  it, and the refusal names them. Only its metadata snapshots go with it.
- A **data table** is refused while sync definitions write into it, unless
  `&cascade=true`, and always while one of those syncs is mid-run. The
  dependency check runs inside the dropping transaction, so a sync created a
  moment earlier cannot be swept away unannounced.
- A **blueprint** cannot be deleted while its table is applied — drop the table
  first, as a separate, separately confirmed action.
- **Run history** keeps the rows of runs still queued or running, which would
  otherwise finish into a row that no longer exists.
- An **account** never cascades into the control plane it built: connections,
  blueprints and syncs survive with `created_by` set to null, and the audit trail
  keeps the actor's name after the account is gone. The last active administrator
  cannot be deleted, demoted or deactivated, and nobody can do any of those to
  their own account.

## DHIS2 access requirements

A healthy connection proves that the credential can authenticate and call system APIs. Reading tracker records additionally requires the DHIS2 user to have capture or data-read access to the selected Program and its organisation units. If DHIS2 returns `Current user is not authorized to read data from selected program`, assign the Program and organisation units through a user role or user group in DHIS2, then use **Retest** and **Run now** again.

## Scheduling and safe deletion

Activating a schedule queues its first run immediately. The local scheduler checks for due work every five seconds, prevents overlapping runs for the same definition, and pauses a schedule automatically when its execution limit is reached.

Deletion actions require typed confirmation. Deleting a sync removes its schedule and run history. Dropping a data table from the dashboard also removes every sync definition, schedule, and run history attached to any blueprint version of that physical table, then retires those blueprint versions in one transaction.

To remove a complete setup, use this order:

1. Download a JSON or CSV backup, selecting a database year or **All years**.
2. Drop the applied reporting table. Dependent sync definitions are removed automatically after confirmation.
3. Delete the retired schema blueprint.
4. Delete the connection after no schemas or sync definitions reference it.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

`backend/api/src/common/isolation.test.ts` is the one to keep green when adding a
read surface: it drives each service as a client against another account's rows
and asserts the refusal, and asserts that report and backup reads bind the owner
filter in SQL rather than filtering after the fact.

## Production hardening still recommended

- Move scheduled execution entirely to BullMQ workers when deploying more than one API replica.
- Move manual sync runs to the worker too: the endpoint holds the HTTP request open for the
  whole run, which a load balancer will eventually cut off on a large download.
- Add a migration runner, so a deploy applies `backend/database/migrations/*.sql` instead of an operator remembering to.
- Add an audit-log viewer; every destructive action is recorded in `audit_log`, but nothing reads it back except the caller's own recent activity on their dashboard.
- Add password reset. An administrator can create an account with a temporary password and a user can change their own, but nobody can reset someone else's.
- Consider per-owner data table names. Ownership is enforced on every query, but two accounts pointed at the same DHIS2 server would generate the same physical table; that collision is currently refused rather than accommodated.
- Add incremental cursor-based pulls after validating the exact DHIS2 version and Program-specific update semantics.
- Add object-storage targets and retention policies for large backups.
- Keep deterministic generation as the authority; if an LLM is added for label or type suggestions, require explicit review before applying DDL.
