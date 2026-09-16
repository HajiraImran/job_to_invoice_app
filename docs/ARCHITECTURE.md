> Source: `docs/PRD.md` §§04, 12, 16, 19–24, 31, 33
> Tooling assumption: `apps/admin` uses Next.js (D-003). Product architecture is ARC01, not SOP `app/` + PostHog.
> Security closures: D-002 Resolved; roles and `SET LOCAL` are normative (B-01, B-02).

# Architecture

## System

```
apps/mobile     React Native + Expo + Expo Router     owner iPhone app
apps/portal     Next.js                               customer approval and view_only
apps/admin      Next.js (D-003)                       restricted staff console S28
apps/api        Fastify REST /v1                      only commercial write path
apps/worker     Node worker                           PDF, email, export, billing
apps/purge      scheduled deletion job only           uses purge_app DSN, never the API pool
packages/domain money, snapshot schema, state machines shared by mobile, API, PDF
packages/schemas snapshot JSON schema versions
packages/config  env validation and shared tooling
packages/testing shared test helpers
```

Managed services (same US region):

| Service | Role | PRD |
| --- | --- | --- |
| Supabase Auth | Owner email OTP only | ACC01, ARC02 |
| Supabase PostgreSQL | Private commercial schema | ARC02, DB01–DB05 |
| Cloudflare R2 | Production/staging private original-document PDFs; API-minted 5-minute presigned GET only. Development may use private MinIO on the same S3 API. | DOC05, D-016 |
| MinIO | Development-only private S3-compatible PDF bucket for local/LAN testing | DOC05, D-016 |
| Render (default) | API, portal, admin, worker (Playwright/Chromium Docker), purge job | ARC01, D-016 |
| Resend | Transactional email | NTF02, EMAIL01–11 |
| RevenueCat + StoreKit | Apple subscriptions | SUB01–SUB08 |
| Sentry | Sanitized errors; replay and screenshots off | OPS03 |
| First-party `analytics_events` | Product analytics | ANA01, DEC12 |
| GitHub | Source of truth | DEL01 |
| Expo EAS | iPhone development and production builds | DEC01, REL01 |

`pnpm --filter @job-to-invoice/mobile dev:go` starts Expo Go for an active-development preview of owner authentication and onboarding. Expo Go is not a release environment (SYNC01). It does not VERIFY production signing, native development builds, physical Keychain/Keystore behavior, or background/offline production behavior. EAS `development` / `preview` development-client profiles remain the native-build path.

Vendor substitution requires an architecture decision that preserves behaviour and acceptance tests (ARC01).

## Trust boundaries

```
Owner iPhone                  Customer browser              Staff browser
   |                                 |                            |
   | Bearer JWT                      | HttpOnly portal cookie     | Staff MFA session
   |                                 | + CSRF                     |
   v                                 v                            v
                    apps/api  Fastify /v1
                         |
                         | DATABASE_URL_API → api_app
                         | (not owner, not BYPASSRLS, not service_role)
                         v
              Private PostgreSQL schema + FORCE RLS
                         |
                         | transactional outbox (same commit)
                         v
                    apps/worker  DATABASE_URL_WORKER → worker_app
                         |
          +--------------+--------------+
          v              v              v
       Resend      S3 original PDF     RevenueCat server API
                        (MinIO dev / R2 prod)
```

Rules:

- Mobile and public browsers call the domain API only. They do not write commercial records through Supabase REST (ARC02).
- Supabase public Auth endpoints are allowed for owner authentication only.
- Clients must not use `supabase-js` (or any SDK) for Storage, Realtime, or Edge Functions. No user JWT against Storage REST, R2, or MinIO. Owner PDF downloads use domain-API-minted 5-minute S3-compatible presigned GET URLs only (DOC05, D-016). Production URLs are Cloudflare R2. Development URLs may be private MinIO, signed against `STORAGE_DOWNLOAD_ENDPOINT` when a physical device cannot reach localhost.
- Commercial tables live in a private schema with client grants revoked.
- Supabase `service_role` is forbidden in `apps/api` and `apps/worker`. It is not a runtime connection string.
- Portal cookies are not accepted as owner authentication (APR01A).
- Owner Bearer tokens are not accepted as portal or staff authentication (AUTHZ01).
- A workspace ID in a route or body is never evidence of authorization (AUTHZ01).
- Cross-tenant object references return generic 404 (AUTHZ01).

## Database roles (ARC02)

| Role | DSN | Privileges | Must not |
| --- | --- | --- | --- |
| `migrator` | `DATABASE_URL_MIGRATIONS` | Object owner; safe attributes only at `CREATE ROLE`; fail-closed if pre-existing role is unsafe; table-scoped FORCE RLS owner policies (D-010); used only by migration CI | Runtime HTTP or worker pool; `ALTER ROLE`; `BYPASSRLS`; `service_role` |
| `api_app` | `DATABASE_URL_API` | FORCE RLS; DML allowed by command functions; no BYPASSRLS | Superuser; service_role; arbitrary financial UPDATE/DELETE; purge |
| `worker_app` | `DATABASE_URL_WORKER` | FORCE RLS; EXECUTE named outbox/billing/PDF functions only | service_role; BYPASSRLS; trust payload `workspace_id`; share API pool |
| `purge_app` | `DATABASE_URL_PURGE` | Scheduled deletion job only; EXECUTE named `purge_*` SECURITY DEFINER functions owned by `migrator`; never in Fastify or outbox pool | HTTP handlers; ad-hoc SQL from support; session `BYPASSRLS`; service_role |

`purge_app` is the only privileged deletion path (DB05). It does not hold `BYPASSRLS` as a role attribute. Deletion functions are `SECURITY DEFINER`, audited, and callable only by `purge_app`. Hosted Supabase rejects `ALTER ROLE`. Application roles get `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION` only when created; `NOBYPASSRLS` is the PostgreSQL default. `0001` never repairs a pre-existing role and fails closed if `LOGIN`, `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION`, or `BYPASSRLS` is set (D-010). Owner DML uses table-scoped `FOR ALL TO migrator` policies on FORCE RLS tables. Role default `search_path` is not set in migrations; SQL is schema-qualified and definer functions fix `search_path`. CI fails if `service_role` or `BYPASSRLS` appears on `api_app`, `worker_app`, or app connection config.

Migrations after `0001` may `SET ROLE migrator` for application DDL so objects stay owned by `migrator`. They must `RESET ROLE` as the last executable statement before returning to the Supabase CLI (D-011). Failure to reset leaves the session as `migrator`, which cannot insert `supabase_migrations.schema_migrations`, so history is not recorded and the migration rolls back.

Hosted `db.<ref>.supabase.co` is IPv6-only. IPv4-only networks must apply through the exact session pooler host `aws-0-<region>.pooler.supabase.com` on explicit port 5432, with username `postgres.<linked-project-ref>` from `supabase/.temp/project-ref`. Do not use `db push --linked`, extra pooler subdomains, an omitted port, or transaction pooler port 6543 (D-012).

## Request authorization (ARC03)

Normative tenant-context algorithm. Session-level `SET` is forbidden. GUC must never be set before `BEGIN` or in middleware that runs on a pooled client that is not yet in a transaction.

Owner command:

1. Verify JWT signature, issuer, audience, expiry, account status (ACC02, SREF06).
2. Resolve workspace membership from verified identity via `identity.provision_owner`. A route/body `workspace_id` is ignored as evidence.
3. Checkout one pool client.
4. `BEGIN`.
5. `SET LOCAL app.workspace_id` and `SET LOCAL app.actor_id` from that verified identity only.
6. Execute the authorized command (RLS still enforced).
7. `COMMIT` or `ROLLBACK`. `SET LOCAL` ends with the transaction; do not `SET`/`RESET` at session scope.

Portal command:

1. Exchange fragment token → preverified cookie (APR01, APR01A).
2. OTP to bound email (APR02).
3. One-hour recipient session scoped to one request.
4. Same checkout → `BEGIN` → `SET LOCAL` for the request’s workspace and request id, not a general tenant list.
5. Invoke a narrowly authorized handler.

Staff command:

1. Separate staff identity, MFA required (SEC05). Staff tokens are rejected on owner routes.
2. Metadata only unless a time-limited content grant exists.
3. `SET LOCAL` staff actor + grant scope. Never set an arbitrary owner `workspace_id` without a live grant.
4. Every action requires reason and immutable audit.

Worker:

1. Claims `outbox_tasks` with `SKIP LOCKED` on `worker_app`.
2. Locks the aggregate row; derives `workspace_id` from that row, never from `payload_json`.
3. Same algorithm: checkout → `BEGIN` → `SET LOCAL` from the locked row → function → commit/rollback.
4. A forged payload `workspace_id` cannot change context.

## RLS and tenant isolation

- `FORCE ROW LEVEL SECURITY` on tenant tables (ARC02, SREF07).
- Every tenant table: `workspace_id UUID NOT NULL`, `UNIQUE(workspace_id, id)`.
- Every tenant relationship: composite FK `(workspace_id, referenced_id)` (DB01). Single-column FKs on tenant relationships are rejected.
- `api_app` and `worker_app` are not database owner, superuser, or `BYPASSRLS`.
- `migrator` is object owner. Hosted migrations never use `ALTER ROLE`. Bootstrap requires application roles to be nologin, nonsuperuser, nocreatedb, nocreaterole, noreplication, and nobypassrls. FORCE RLS owner access is a table-scoped policy (D-010).
- Migrations that `SET ROLE migrator` must `RESET ROLE` before control returns to Supabase CLI so history can be recorded (D-011).
- Token-hash lookup uses a restricted function that returns minimum request/workspace metadata only (ARC03).
- Authorization tests must hit database paths, not only HTTP (DB04).
- `action_grants` lives in the restricted identity schema (ACC02A).

## Outbox (ARC04)

Business events insert `outbox_tasks` in the same commit as the commercial write.

One outbox row and one `effect_key` per intended external effect. For first-send email the key is `(workspace_id, document_id, template_id, recipient_id)`. Lease retries **update the same row** and reuse that key. Worker must not insert a second approval token or a second `delivery_attempts` row for the same effect. Record `provider_message_id` before acknowledging success. Crash between provider accept and status write reconciles by provider id, not by inserting a new token.

Worker:

- Lease 60 seconds, heartbeat for long jobs
- `generate_original_pdf`: max 5 attempts; backoff 30s, 2m, 10m, 30m; fifth failure or permanent validation failure marks the task `dead`
- Persist `artifact_id` on the outbox payload before the first PutObject; retries reuse `workspaces/{workspace_id}/documents/{document_id}/revisions/{revision}/original/{artifact_id}.pdf`
- Never hold a database transaction open while calling email, storage or billing
- Reconcile a crash between R2 PutObject and artifact insert from database state; do not list the bucket
- PDF/email retry must not allocate a new document number, artifact id, or approval token

Scheduled jobs (OPS08): poll outbox continuously; expire pending approvals every minute (endpoints still enforce exact expiry); cleanup stale uploads hourly; reconcile entitlements nightly; retry billing backlog every five minutes; trial reminders two days before end; purge exports daily; apply retention/deletion daily via `purge_app`; verify backups daily; deidentified cohort reports daily.

## Actors

| Actor | Session | May | Must not |
| --- | --- | --- | --- |
| Business owner | Bearer | Own workspace commercial commands | Approve as customer; rewrite snapshots; reset own trial |
| Customer recipient | Portal cookie | View/approve/decline bound document | Browse workspace; see other customers |
| Support agent | Staff MFA | Metadata, resend via approved action | Read content by default; edit money |
| Support supervisor | Staff MFA + grant | Revoke links, bounded case access | Silent impersonation |
| Worker | `worker_app` | One queued task | Unvalidated tenant IDs; service_role |
| Purge job | `purge_app` | Authorized deletion ledger | HTTP; outbox email |
| Infrastructure operator | Break-glass | Recovery under incident record | Routine content browsing |

## Domain package

`packages/domain` is the only money and snapshot implementation. Mobile previews, API commits and PDF totals must be identical (INV01, FIN01–FIN05, F01–F12). No binary floating point. Quantities are three-place decimal strings. Amounts are integer USD cents.

One canonicalizer function in `packages/domain` implements QUO02A in full: UTF-8; recursively sorted object keys; explicit nulls for nullable snapshot fields; decimal quantities as three-place strings; integer cents; arrays ordered by stable position then UUID; **exclude** request tokens, live delivery status and generation timestamps. Preview, publish, approve-hash check and tests call this function only. Persist `canonical_snapshot_bytes`. Digest compare uses the stored bytes; never re-canonicalize a stored snapshot to compare hashes. SHA-256 of those bytes is `snapshot_sha256`. PDF has a separate digest (INV03).

## Transaction flows

### TX01 Publish

```
Owner confirm S11
  -> API locks job, allowances, current request
  -> first publication: consume one new-job slot or return ENTITLEMENT_REQUIRED
  -> already-published job: verify completion_right; do not consume another slot
  -> set jobs.completion_right = true on first successful publish (write-once)
  -> match preview_hash against stored canonical bytes
  -> insert snapshot, lines, tokenized request, outbox
  -> commit
  -> return IDs
  -> worker original PDF (D-016) then EMAIL01/02 (never inside the transaction)
```

No environment or compile-time stub may skip slot consumption. `APP_ENV=development` may seed fixture allowances; it must still run this command. Staging, TestFlight and production use real `job_allowances`. Precommit failure rolls back the counter. Entitlement snapshot updates must not write `completion_right`.

### TX02 Approve

```
Recipient S26
  -> CSRF + session
  -> lock request and job
  -> expiry, stored snapshot_sha256, scope version, reduction caps
  -> unique decision + scope_entries
  -> commit
  -> outbox EMAIL04/05
```

First valid concurrent command wins; loser gets 409. `ALREADY_DECIDED` does not create another charge. Compare the client hash to stored bytes; do not re-serialize.

### TX03 Invoice issue

```
Owner S15
  -> lock job
  -> no pending/unresolved changes (unless direct invoice JRN06)
  -> one active invoice (pointer AND partial unique index)
  -> first publication of a direct-invoice job: same slot + completion_right rules as TX01
  -> insert snapshot/number, set pointer
  -> commit
  -> worker PDF
```

Timeout recovery via `operation_id`. Worker failure cannot duplicate the invoice.

### TX04 Credit / payment / refund / reversal

```
Owner S17 / S18
  -> lock invoice
  -> load effective ledger and cumulative credits
  -> validate caps
  -> insert append-only entry or credit snapshot with permanent operation_id
  -> recompute derived balance (never a writable paid flag)
  -> append audit/outbox
  -> commit
```

Concurrent commands serialize on the invoice and must not both spend the same remaining capacity (QA28, QA37–QA43).

### TX05 Billing

```
StoreKit / webhook
  -> persist provider_events by provider + external_event_id
  -> acknowledge only after durable persist
  -> worker fetches authoritative subscriber state
  -> update entitlement_snapshots if newer
  -> never write jobs.completion_right
  -> never extend access when provider is unavailable
```

### TX06 Public link compromise

```
Supervisor or owner replace-link
  -> revoke tokens and sessions on the compromised pending request
  -> block future decisions on that request
  -> preserve approval_decisions and encrypted evidence
  -> issue a fresh request when appropriate (new token_hash)
  -> notify owner with incident ID
```

Never erase historical approval evidence. Revoke-after-approve must leave the decision row intact.

## Completion rights (INV08, SUB05)

`jobs.completion_right` is write-once. TX01 and TX03 set it true on the first successful publish or direct-invoice issue. An UPDATE that clears it is forbidden except account-deletion purge. Subscription expiry, refund, or downgrade must not clear it. Owner may finish and export published jobs after Pro/trial end. New-job publication still requires a free slot, trial capacity, or verified Pro.

## Offline contract (SYNC02–SYNC06)

- Persist draft changes locally after a 500 ms debounce; flush on blur/background as OS permits. Show Saving locally, then Saved on this device. While online, queue **draft** writes within two seconds; Synced only on acknowledgement (SYNC02).
- Every PATCH requires If-Match. On 409 VERSION_CONFLICT, pause that resource queue and preserve both copies. Never last-write-wins for amounts, recipients, terms or site identity. User keeps server copy or saves local data as a new draft revision. Publication always reviews the current server version (SYNC03).
- Local IDs are UUIDs. Sync order: customer, job, document draft, lines, completed attachments. Pending attachments block publication until ready or removed. Local drafts do not consume numbers or slots (SYNC04).
- Draft retries: exponential delay with jitter, 2s to 5 minutes; cap 20 concurrent draft operations per device and one per resource. **Never auto-issue** publish, approve, invoice, credit, payment, refund, reverse, deletion or purchase reconciliation from the offline queue. Those require a live connected user action. If a live command times out, query `GET /operations/{id}` before offering another command (SYNC05).
- Cache 90 days / 500 jobs / 250 MB rules as specified. Never auto-evict unsynced work. Account switch locks and wipes the previous encrypted DB after unsynced-work confirmation. No shared local database between accounts (SYNC06).

Plaintext local commercial records are forbidden. Stage 0 must choose the encrypted engine before Stage 1 stores drafts.

## Session, OTP and action grants

- Owner refresh tokens in OS secure storage only (ACC01).
- Email-change and deletion lock revoke existing owner refresh tokens.
- Staff auth is a separate issuer/audience; staff credentials on owner routes return 401.
- Portal cookies: `Secure`, `HttpOnly`, `SameSite=Lax` (or Strict where the flow allows), host-only, scoped to one request.
- Owner and portal OTP: hashed at rest; 6 digits; 10-minute expiry; 60-second resend; 5 failures lock the challenge (`consumed_at` or equivalent). Raw codes and grants never appear in logs, Sentry, analytics or emails beyond the one delivery.
- Action grants (D-002 Resolved): `POST /account/action-grants` issues a single-use hashed grant after a **fresh** owner OTP (not token refresh). Export, deletion, email-change and replace-link **reject** without a valid unused `X-Action-Grant` for that exact action (5-minute expiry). Wrong-action or replayed grant → 403.
- Approval raw token lives only in the URL fragment. Email and share links are exactly `{PORTAL_ORIGIN}/review#{token}` (APR01). Never a query parameter. Never log `Location` or `Referer` containing the secret. Disable click-tracking that rewrites hrefs. After `POST /portal/exchange`, discard the fragment. Replace-link rotates `token_hash` and revokes sessions.
- No tokens in localStorage, analytics or error reports (SEC01, SEC06).

## Approval evidence (APR05)

`encrypted_evidence_json` uses versioned envelope encryption with `APPROVAL_EVIDENCE_ENCRYPTION_KEY` and `evidence_key_version`. Ciphertext in the database must not be plaintext JSON. Decrypt only for owner export or a live staff content grant. Never attach evidence to default logs, Sentry, or metadata-only support views.

## Feature flags (OPS02)

`FEATURE_NEW_PUBLICATION` and `FEATURE_PURCHASES` disable new publish and billing initiation during incidents. They must not disable read, export, or completion of already-published jobs.

## Operations, monitoring and restore (OPS02–OPS06)

### Merge gates (OPS02)

CI on `main` must run: lint/types; domain/financial tests including F01–F12; API contract validation; migrations on a clean database; tenant isolation including pool-leak and role tests; dependency/secret scans (`service_role` banned in app config); worker idempotency tests; signed mobile build smoke on release candidates. Staging E2E on every release candidate.

### Telemetry (OPS03)

Structured `request_id`, `operation_id`, tenant pseudonym, endpoint, duration, status/error code, worker effect ID. Redact authorization headers, cookies, token fragments, emails, commercial text, attachments and payment references before logs leave the process. Sentry replay and screenshots remain off. `GET /v1/me` emits a console `owner_me` event with only `event`, `request_id`, `status`, a safe `stage` enum, and an allowlisted PostgreSQL `sqlstate` when present. Database stages are `database_connect_failed`, `transaction_start_failed`, `set_role_failed`, `provision_owner_failed`, and `bootstrap_query_failed`. The original-PDF worker emits a console `worker_pdf` event with only `event`, an allowlisted `stage`, and an allowlisted PostgreSQL `sqlstate` when present. Stages are `started`, `claim_started`, `no_work` (rate-limited), `claimed`, `rendering`, `uploading`, `completed`, `retry_scheduled`, `dead`, `database_connect_failed`, `transaction_start_failed`, `set_role_failed`, `claim_query_failed`, and `claim_timed_out`. Claim attempts use bounded connect and statement timeouts. Do not log error messages, stacks, SQL, credentials, URLs, object keys, payloads, document IDs, customer data, or connection details. These events are operational diagnostics, not `analytics_events`.

Dashboards: API error rate and latency, queue age, publication-to-PDF time, email failures, duplicate command rate, billing reconciliation age, backup freshness, crash-free sessions, storage growth.

### Alerts (OPS04)

Page immediately (Sev-1) on detected cross-tenant access, snapshot hash mismatch or negative source balance. Alert if p95 write latency exceeds two seconds for ten minutes, API 5xx exceeds two percent for five minutes, oldest normal task age exceeds ten minutes, billing reconciliation is stale over one hour for repeated failures, or backup success is absent beyond the scheduled window. A dashboard alone is not incident response. Route to a staffed on-call channel (named at Stage 6; §34 owner input).

### Severity (OPS05)

Sev-1: data disclosure, corrupted issued documents, or widespread unavailable approvals. Acknowledge within 30 minutes during production coverage; disable the unsafe write path; preserve evidence; open an incident record. Sev-2: partial email/PDF/provider outage without lost commitments; acknowledge within four business hours.

### Restore runbook (OPS06, NFR04)

RPO 15 minutes, RTO 4 hours. Backups expire within 35 days.

1. Isolate the affected environment.
2. Establish the corruption cutoff.
3. Restore the database to a **new** instance (never onto the live primary in place).
4. Restore matching object versions.
5. Replay the deletion ledger and verified immutable operation records **before** exposing the instance.
6. Compare snapshot/PDF hashes and counts.
7. Reconcile subscription state.
8. Mark restored email/outbox tasks `dead` until a human replays them. Do not blindly resend EMAIL01–11.
9. Run isolation and ledger smoke tests.
10. Switch traffic only after checks.

Test this runbook before launch and quarterly afterward (QA58, QA66).

## Environments

Separate Auth, database, storage, email and RevenueCat for development, staging and production (OPS01). Sandbox purchases never grant production entitlement. Staging watermarks every generated document TEST. No production personal data in development.

## What is not in v1 architecture

Android **operator app**, full operator web app, staff seats, customer accounts, payment collection, PostHog, tracking SDKs, native push (NTF01 deferred), in-memory queues, client-side secret API keys.

Customer **portal** browsers still include Chrome on Android current and previous major, plus the rest of the NFR02 matrix. That is not an operator Android app.
