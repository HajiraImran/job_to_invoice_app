> Source: `docs/PRD.md` §§09 (ACC02A), 20, 25
> `action_grants` is specified by ACC02A and is not in the §20 table. D-002 Resolved: grant issuer route is required.

# Database contract

## Conventions (DB01, DB02)

- UUID primary keys
- `timestamptz` UTC for timestamps
- `date` for commercial local dates
- integer/bigint cents constrained to product limits
- `numeric(12,3)` quantities
- `jsonb` only for immutable typed snapshots or versioned event payloads
- Tenant tables: `workspace_id UUID NOT NULL`, `id UUID`, `created_at`, `updated_at` where mutable, `UNIQUE(workspace_id, id)`
- Tenant relationships: composite FK `(workspace_id, referenced_id)` only. Single-column FKs on tenant relationships are rejected.
- Auth user IDs map through application identity; not raw tenant evidence
- No cascade delete of published financial records in ordinary CRUD
- All listed fields required unless `?`
- `[]` means array
- Defaults explicit in migrations
- `created_by` is an application actor UUID; workers use a named service actor
- Mutable rows: `version integer default 1`
- JSON validated against checked-in schemas on write and read
- Enums: constrained text plus migration-defined values
- Private schema; client grants revoked; FORCE RLS (ARC02)

## Roles and grants (ARC02)

| Role | DSN | Notes |
| --- | --- | --- |
| `migrator` | `DATABASE_URL_MIGRATIONS` | Object owner. Hosted Supabase rejects `ALTER ROLE`; safe attributes are assigned only at `CREATE ROLE`; bootstrap fails if a pre-existing app role is unsafe and does not repair it. FORCE RLS owner access is table-scoped `FOR ALL TO migrator` policies (D-010). Migrations and SECURITY DEFINER only. Not a runtime pool. |
| `api_app` | `DATABASE_URL_API` | FORCE RLS. No `BYPASSRLS`. No superuser. No arbitrary UPDATE/DELETE of issued financial payload. |
| `worker_app` | `DATABASE_URL_WORKER` | FORCE RLS. EXECUTE named outbox/PDF/billing functions only. Separate pool from API. |
| `purge_app` | `DATABASE_URL_PURGE` | Scheduled deletion job only. Never in Fastify or outbox pools. No role-level `BYPASSRLS`. Calls named `purge_*` SECURITY DEFINER functions owned by `migrator`. |

Supabase `service_role` is forbidden as an application connection. Client roles `anon` and `authenticated` have no grants on `identity` or `commercial`. Hosted migrations must not `ALTER` or drop those platform roles; create them only when absent for local embedded Postgres. Application migrations contain no `ALTER ROLE`. `api_app`, `worker_app`, `purge_app`, and `migrator` are created with `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION` and must not have `BYPASSRLS`. If any of those four already exists with `LOGIN`, `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION`, or `BYPASSRLS`, bootstrap raises and does not rewrite the role. `migrator` is the object owner. Each FORCE RLS application table has a `FOR ALL TO migrator USING (true) WITH CHECK (true)` policy so definer functions and migration DML still work. Runtime roles never receive that unrestricted policy.

## Migration authoring (D-011)

- Later migrations may `SET ROLE migrator` so application schemas, tables, functions, and SECURITY DEFINER objects are owned by `migrator`.
- Any migration that sets that role must `RESET ROLE` as its last executable statement. No DDL, grants, policies, or comments may follow it.
- Supabase CLI inserts `supabase_migrations.schema_migrations` as the bootstrap session user after the file returns. `migrator` cannot write that catalog. Leaving `SET ROLE migrator` in effect prevents history from being recorded and rolls back the migration.
- Do not `ALTER ROLE`. Do not change hosted `0001_foundation.sql`. Never use `service_role`.

## Hosted apply (D-012)

`db.<project-ref>.supabase.co:5432` is IPv6-only. On an IPv4-only network `supabase db push --linked` times out while `supabase db query --linked` still works (HTTPS). Hosted applies from this network must use the IPv4 **session** pooler, not `--linked`, not `migrate:clean`, and not transaction-mode port `6543`.

Required URL shape:

`postgres://postgres.<linked-project-ref>:<percent-encoded-password>@aws-0-<region>.pooler.supabase.com:5432/postgres`

- Host must be exactly `aws-0-<region>.pooler.supabase.com` (no extra subdomains).
- Port `5432` must be present in the URL. An omitted port is rejected.
- Username must be `postgres.<linked-project-ref>` from `supabase/.temp/project-ref` after `supabase link`. Do not supply a different project ref through the environment.
- Reserved password characters (`@`, `:`, `/`, `?`, `#`, `%`, and similar) must be percent-encoded. Do not store this URL in the repository.
- Do not add query parameters such as `pgbouncer=true`. Session mode is selected by port `5432`; those parameters are incompatible with session-level `SET ROLE` / `RESET ROLE`.
- Never `service_role`. Never print, log, or commit the URL, username/password pair, or password.

`pnpm hosted:db-check` validates that shape, then runs exactly `db push --db-url <validated URL> --dry-run` once. `pnpm hosted:db-push` uses the same validation and launcher with `--yes` instead of `--dry-run`. Neither command uses `--linked`, `--include-all`, `--include-roles`, `--include-seed`, `--debug`, `--log-level`, `--output-format`, `shell:true`, `cmd.exe`, or PowerShell. The wrapper does not perform a separate DNS lookup or TCP probe. DNS, TCP, TLS, and authentication are performed by the Supabase CLI. Child stdout/stderr is never printed raw. The wrapper emits only a sanitized report: ok/fail, exit code, whether connect started/succeeded, pending `NNNN_name.sql` basenames, failure `stage` (`login_role` / `connecting` / `listing_pending` / `applying` / `unknown`), and on failure an allowlisted category plus optional migration basename, statement number, SQLSTATE, and `LegacyDb*` tag. Unknown child text is omitted. Generic `Error:` and login-role `permission denied to alter role` are not classified as a migration SQL failure.

Passing `--db-url` still exposes the URI on the local process list while the CLI runs. That residual exposure is unavoidable with this CLI interface. Unset the variable after apply.

Local Windows session-pooler live apply has been unreliable after a successful dry-run. Authorized hosted development apply of pending `0002`–`0004` is the dispatch-only Ubuntu workflow `.github/workflows/hosted-development-migrations.yml` (confirmation `APPLY_0002_0004`, Environment `development`, secret `DATABASE_URL_MIGRATIONS`). See `docs/ENV.md`.

PowerShell (process environment only):

```powershell
$env:DATABASE_URL_MIGRATIONS = "<percent-encoded session-pooler URI>"
pnpm hosted:db-check
pnpm hosted:db-push
Remove-Item Env:DATABASE_URL_MIGRATIONS
```

Local `pnpm migrate:clean` / `pnpm test:db` still use embedded PostgreSQL when `DATABASE_URL_MIGRATIONS` is unset.

## Schemas

| Schema | Contents | Client access |
| --- | --- | --- |
| `identity` | `app_users`, `action_grants` | Revoked |
| `commercial` | Tenant commercial tables | Revoked |

`action_grants` lives in `identity` (ACC02A). It is not workspace-scoped; RLS matches `user_id` to `app.actor_id`.

`identity.provision_owner(auth_user_id, display_email, normalized_email)` is `SECURITY DEFINER` owned by `migrator`, executable only by `api_app`. It creates or returns the application user, the single owner workspace, and membership. Callers never pass `workspace_id`. First successful provision emits `signup_verified` with a random `analytics_alias_id`, not an email hash.

## Tenant context (ARC03)

Session `SET` of tenant GUCs is forbidden. Inside an already-open transaction the API/worker must call:

```sql
select identity.set_local_tenant_context(workspace_id, actor_id);
```

which uses `set_config(..., true)` (`SET LOCAL`). `COMMIT`/`ROLLBACK` clears `app.workspace_id` and `app.actor_id`. Connection pooling must not reuse a session-level tenant GUC.

A route or body `workspace_id` is never passed into that function. The values come from verified identity (owner membership lookup, portal request lock, or worker locked aggregate row).

RLS for tenant tables requires both:

1. `workspace_id = identity.current_workspace_id()`
2. an active `memberships` row for `identity.current_actor_id()` on that workspace

A forged GUC for another workspace therefore yields zero rows, not an existence leak.

## Root versus composite foreign keys

`workspaces.workspace_id` is the tenant key (`workspace_id = id`). Child tables point at the tenant root with `FOREIGN KEY (workspace_id) REFERENCES commercial.workspaces (workspace_id)`. That is the tenant key itself, not a cross-row reference.

Every relationship to a **non-root** tenant row is composite `(workspace_id, referenced_id)`. Example in this slice: `workspaces (workspace_id, logo_asset_id) → assets (workspace_id, id)`.

`assets.job_id` and `assets.draft_id` are nullable and have **no foreign keys** until `jobs` and `document_drafts` exist. Do not write those columns until those migrations land.

## Identity and workspace

| Table | Domain fields beyond common fields |
| --- | --- |
| app_users | auth_user_id unique, normalized_email, display_email, status active/suspended/deleting/deleted, last_authenticated_at, deletion_requested_at?, terms_version, privacy_version |
| workspaces | owner_user_id unique, business_name, legal_name, contact_name, contact_email, contact_phone?, address_json, timezone IANA, currency USD, trade handyman/other, logo_asset_id?, default_tax_bp 0–2500, default_due_days 0–365, default_terms, setup_completed_at?, version |

Provisioning (`identity.provision_owner`) inserts empty names, `timezone=UTC`, `trade=other`, `setup_completed_at` null. Completed setup (`commercial.complete_workspace_setup` in `0004_workspace_setup.sql`) requires VAL01/VAL02 field bounds, sets `setup_completed_at` as migrator-only, increments `version`, inserts `job_allowances` if missing, appends `audit_events`, and emits server `onboarding_completed`. `api_app` cannot assign `setup_completed_at` or change `currency` away from USD.

| memberships | user_id, role owner, status active; unique workspace/user; v1 exactly one active owner |
| action_grants | id, user_id, action, token_hash, expires_at, used_at? — restricted identity schema (ACC02A). Actions: export, deletion, email_change, replace_link. Five-minute expiry after fresh OTP. Single use. |

`action_grants` is required even though it is absent from the §20 inventory table.

Foreign keys:

- `memberships.workspace_id` → `workspaces(workspace_id)` (tenant root)
- `memberships.user_id` → `app_users(id)` (global identity, not a tenant row)
- `workspaces.owner_user_id` → `app_users(id)`
- `workspaces (workspace_id, logo_asset_id)` → `assets (workspace_id, id)` (composite tenant FK)

## Catalogue and jobs

| Table | Domain fields beyond common fields |
| --- | --- |
| customers | name, email?, normalized_email?, phone?, billing_address_json?, archived_at?, version |
| catalogue_items | description, unit, custom_unit_label?, default_quantity, unit_price_cents, discount_cents, tax_bp, archived_at?, version |
| jobs | customer_id, title, site_address_json?, no_site bool, lifecycle, archived_from_state?, current_quote_id?, active_invoice_id?, scope_version default 0, first_published_at?, entitlement_origin free/trial/paid?, completion_right bool, internal_notes, related_job_id?, version |

Job lifecycle: `draft`, `active`, `invoiced`, `finished`, `canceled`, `archived` plus `archived_from_state` (JOB01).

`completion_right` is write-once. First successful TX01/TX03 publication sets it true. UPDATE that clears it is forbidden except `purge_app` account deletion. `entitlement_snapshots` must not write this column.

Composite FKs:

- `jobs (workspace_id, customer_id)` → `customers (workspace_id, id)`
- `jobs (workspace_id, current_quote_id)` → `documents (workspace_id, id)`
- `jobs (workspace_id, active_invoice_id)` → `documents (workspace_id, id)`
- `jobs (workspace_id, related_job_id)` → `jobs (workspace_id, id)`

## Documents and scope

| Table | Domain fields beyond common fields |
| --- | --- |
| document_drafts | job_id, kind quote/change/invoice/credit, parent_document_id?, base_scope_version, payload_json, schema_version, draft_state editing/discarded/published, version |
| documents | job_id, kind, number, revision_no, prior_document_id?, lifecycle issued/accepted/declined/withdrawn/superseded/voided, issued_at, issue_date, due_date?, currency, net_cents, tax_cents, total_cents, snapshot_json, canonical_snapshot_bytes, schema_version, snapshot_sha256, scope_version, void_reason? |
| document_lines | document_id, position, line_kind source/reduction/credit, source_line_id?, description, quantity?, unit?, unit_price_cents?, discount_cents, net_cents, tax_bp, tax_cents, total_cents, original_source_id? |
| scope_entries | job_id, source_line_id, accepted_document_id, scope_version, event_kind add/reduce, net_delta_cents, tax_delta_cents; append-only |
| document_counters | type quote/change/invoice/credit, next_value; unique workspace/type |

Numbering: Q-000001, CO-000001, INV-000001, CN-000001; never reuse after void; failed allocation kept as void/reserved (INV06).

Composite FKs:

- `document_drafts (workspace_id, job_id)` → `jobs (workspace_id, id)`
- `document_drafts (workspace_id, parent_document_id)` → `documents (workspace_id, id)`
- `documents (workspace_id, job_id)` → `jobs (workspace_id, id)`
- `documents (workspace_id, prior_document_id)` → `documents (workspace_id, id)`
- `document_lines (workspace_id, document_id)` → `documents (workspace_id, id)`
- `document_lines (workspace_id, source_line_id)` → `document_lines (workspace_id, id)`
- `document_lines (workspace_id, original_source_id)` → `document_lines (workspace_id, id)`
- `scope_entries (workspace_id, job_id)` → `jobs (workspace_id, id)`
- `scope_entries (workspace_id, source_line_id)` → `document_lines (workspace_id, id)`
- `scope_entries (workspace_id, accepted_document_id)` → `documents (workspace_id, id)`

## Approval

| Table | Domain fields beyond common fields |
| --- | --- |
| approval_requests | job_id, document_id, purpose approval/view_only, recipient_name?, recipient_email, token_hash unique, token_key_version, state pending/approved/declined/withdrawn/expired/superseded/revoked, expected_scope_version, expires_at, access_until, token_rotated_at?, decided_at? |
| approval_challenges | request_id, code_hash, secret_key_version, expires_at, failed_attempts, last_sent_at, consumed_at? |
| approval_sessions | request_id, session_hash unique, verified_email, expires_at, revoked_at?, token_generation |
| approval_decisions | request_id unique, document_id, decision approve/decline, signer_name, verified_email, decided_at, snapshot_sha256, consent_version, consent_text, comment?, encrypted_evidence_json?, evidence_key_version? |

Partial unique index: `approval_requests(workspace_id, job_id) WHERE state='pending' AND purpose='approval'` (DB03, INV04). view_only rows are excluded from that uniqueness (API05).

`encrypted_evidence_json` is versioned envelope ciphertext, not plaintext JSON. Decrypt only for owner export or a live staff content grant.

Composite FKs:

- `approval_requests (workspace_id, job_id)` → `jobs (workspace_id, id)`
- `approval_requests (workspace_id, document_id)` → `documents (workspace_id, id)`
- `approval_challenges (workspace_id, request_id)` → `approval_requests (workspace_id, id)`
- `approval_sessions (workspace_id, request_id)` → `approval_requests (workspace_id, id)`
- `approval_decisions (workspace_id, request_id)` → `approval_requests (workspace_id, id)`
- `approval_decisions (workspace_id, document_id)` → `documents (workspace_id, id)`

## Ledger

| Table | Domain fields beyond common fields |
| --- | --- |
| ledger_entries | invoice_id, type payment/refund/reversal, amount_cents positive, effective_date, method?, reference?, note?, reverses_entry_id? unique, created_by, operation_id unique; append-only |
| credit_allocations | credit_document_id, invoice_line_id, net_credit_cents, tax_credit_cents; unique credit/line |
| ledger_refund_allocations | refund_entry_id, payment_entry_id, amount_cents positive; append-only, same invoice/workspace |

Payment status is derived (INV07). Never store a writable “paid” flag.

Composite FKs:

- `ledger_entries (workspace_id, invoice_id)` → `documents (workspace_id, id)`
- `ledger_entries (workspace_id, reverses_entry_id)` → `ledger_entries (workspace_id, id)`
- `credit_allocations (workspace_id, credit_document_id)` → `documents (workspace_id, id)`
- `credit_allocations (workspace_id, invoice_line_id)` → `document_lines (workspace_id, id)`
- `ledger_refund_allocations (workspace_id, refund_entry_id)` → `ledger_entries (workspace_id, id)`
- `ledger_refund_allocations (workspace_id, payment_entry_id)` → `ledger_entries (workspace_id, id)`

## Assets, artifacts, entitlements

| Table | Domain fields beyond common fields |
| --- | --- |
| assets | job_id?, draft_id?, visibility internal/customer, bucket_key, upload_state pending/processing/ready/rejected, media_type, source_size, stored_size?, width?, height?, sha256?, rejection_code?, uploaded_by |
| document_assets | document_id, asset_id, position; append-only after document issue |
| artifacts | document_id?, export_id?, type original_pdf/status_pdf/receipt_pdf/statement_pdf/export_zip, object_key, sha256, bytes, template_version, generated_at, state ready/failed |
| job_allowances | PRIMARY KEY (workspace_id). Exactly one row per workspace. free_jobs_consumed default 0, trial_started_at?, trial_ends_at?, trial_jobs_consumed default 0, retained_bytes default 0, version. Created on provision/setup; slot increments remain a later slice. |
| entitlement_snapshots | user_id unique, provider_customer_id unique, entitlement pro, status, product_id?, expires_at?, will_renew?, verified_at, source_event_id?, environment sandbox/production |
| provider_events | provider, external_event_id unique per provider, received_at, payload_encrypted?, processing_state, processed_at?, attempts, last_error_code? |

Slot increments occur in the same transaction as the document insert (TX01/TX03). Rollback restores `free_jobs_consumed` / `trial_jobs_consumed`. Two allowance rows per workspace are a migration defect.

Composite FKs:

- `assets (workspace_id, job_id)` → `jobs (workspace_id, id)` — deferred until `jobs` exists
- `assets (workspace_id, draft_id)` → `document_drafts (workspace_id, id)` — deferred until `document_drafts` exists
- `document_assets (workspace_id, document_id)` → `documents (workspace_id, id)`
- `document_assets (workspace_id, asset_id)` → `assets (workspace_id, id)`
- `artifacts (workspace_id, document_id)` → `documents (workspace_id, id)`
- `artifacts (workspace_id, export_id)` → `exports (workspace_id, id)` when export is tenant-scoped
- `job_allowances.workspace_id` → `workspaces.id` (1:1)

## Outbox, audit, privacy, staff

| Table | Domain fields beyond common fields |
| --- | --- |
| outbox_tasks | event_id unique, task_type, aggregate_id, payload_json, schema_version, available_at, lease_until?, attempts, status pending/running/done/dead, effect_key unique, last_error_code? |
| delivery_attempts | document_id?, request_id?, template_id, recipient_email_encrypted, state, provider_message_id?, effect_key unique, last_event_at, retry_count |
| idempotency_records | actor_scope, key, route, request_hash, operation_id unique, status, response_code?, response_json?, created_at, expires_at, permanence financial/ephemeral; unique actor_scope/key. Workspace setup uses ephemeral 30-day rows (`0004_workspace_setup.sql`). |
| audit_events | workspace_id tenant key, actor_type, actor_id?, action, entity_type, entity_id, occurred_at, request_id, before_version?, after_version?, reason?, safe_metadata_json; append-only. Setup writes `workspace_setup_completed` without names or addresses. |
| exports | workspace_id NOT NULL, owner_id, cutoff_at, status queued/running/ready/failed/expired, manifest_json?, expires_at?, error_code? |
| support_cases | workspace_id NOT NULL, owner_id, category, message, state, content_access_granted_at?, content_access_expires_at?, assigned_staff_id? |
| analytics_events | event_id unique, pseudonymous_owner_id?, job_id?, event_name, schema_version, occurred_at, received_at, safe_properties_json |
| staff_users | Global table: auth_subject unique, role agent/supervisor/infra, mfa_required true, status; no commercial tenant access by default |
| staff_access_grants | staff_user_id, support_case_id, scope_json, reason, approved_by, expires_at, revoked_at? |
| deletion_requests | workspace_id NOT NULL, owner_id, requested_at, verified_at, status locked/purging/completed/exception, purge_deadline, completed_at?, retained_categories_json? |

Delivery attempt states: queued, submitting, accepted_by_provider, delivered, bounced, complained, failed (NTF03).

`effect_key` for first-send email is `(workspace_id, document_id, template_id, recipient_id)`. Lease retries update the same `outbox_tasks` and `delivery_attempts` rows. Never insert a second approval token on retry.

Idempotency: rows for publish, approve, invoice, credit, payment, refund, reverse, deletion and entitlement are `permanence=financial` and **never expire**. Unique `operation_id` is also stored on the money/effect row (`ledger_entries.operation_id`, document issue, decision). Only non-financial cached response bodies may set `expires_at` (30 days). Deleting an expired ephemeral row must not allow a second financial write.

Composite FKs:

- `outbox_tasks` tenant-scoped aggregates: `(workspace_id, aggregate_id)` to the locked parent
- `delivery_attempts (workspace_id, document_id)` → `documents (workspace_id, id)`
- `delivery_attempts (workspace_id, request_id)` → `approval_requests (workspace_id, id)`

## Indexes (DB03)

- Every list path: `(workspace_id, updated_at DESC, id DESC)`
- Jobs: `(workspace_id, lifecycle, updated_at)`
- Customer normalized email by workspace
- Documents: `(workspace_id, kind, number, revision_no)`
- Approval request hash; state/expiry
- Ledger by invoice and time
- Tasks: status/available_at and lease_until
- Partial unique pending approval (purpose=approval only)
- Partial unique **and** transactional pointer for the active non-voided final invoice per job. Both are required. Do not rely on UI. Suggested index: unique `(workspace_id, job_id)` on `documents` WHERE `kind='invoice'` AND lifecycle NOT IN (`voided`) for the final invoice (or an equivalent dedicated registry table plus `jobs.active_invoice_id` updated in the same transaction).

A state transition must expire/withdraw the old pending approval row before creating its successor in one transaction.

## Triggers and immutability (DB04, INV02)

After a document is issued, reject UPDATE/DELETE of commercial payload on:

- `documents` payload columns including `canonical_snapshot_bytes`, `snapshot_json`, `snapshot_sha256`, cents, number, revision
- `document_lines` (all payload columns)
- `scope_entries` (append-only; no UPDATE/DELETE)
- `document_assets` (append-only after issue)
- `artifacts` rows with `type=original_pdf` (bytes, sha256, object_key). Status/statement PDFs are **new** artifact rows, never overwrites.

Also:

- Reject UPDATE that clears `jobs.completion_right` except `purge_app`
- Status transitions are restricted commands and append `audit_events`
- `api_app` / `worker_app` have no arbitrary writes to financial tables
- Ledger reversal function: reference must belong to the same invoice/workspace and must not already be reversed
- Authorization tests must exercise database access paths

## Deletion (DB05, PRV04–PRV06)

Deletion uses `purge_app` only, on a scheduled job with a separate DSN. Operational immutability does not block an authorized privacy request.

- Lock account immediately; start purge within 24 hours; complete live deletion within 30 days
- Apply a deletion ledger before any restored backup is exposed (OPS06)
- Purge Storage objects separately
- Backups expire within 35 days (BACKUP_RETENTION_DAYS)
- Restricted retention categories come from counsel before launch; no default blanket invoice exemption

## Active invoice uniqueness

At most one active non-voided final invoice per job (BIL02, DEC08). Enforce **both**:

1. `jobs.active_invoice_id` set in the same transaction as issue
2. A partial unique index (or dedicated registry) that rejects a second non-voided final invoice for that `(workspace_id, job_id)`

Pointer-only or index-only is insufficient.

## Entity groups

```
identity:     app_users, action_grants
workspace:    workspaces, memberships
catalogue:    customers, catalogue_items
job:          jobs, job_allowances
documents:    document_drafts, documents, document_lines, document_counters, document_assets
scope:        scope_entries
approval:     approval_requests, approval_challenges, approval_sessions, approval_decisions
ledger:       ledger_entries, credit_allocations, ledger_refund_allocations
files:        assets, artifacts
billing:      entitlement_snapshots, provider_events
async:        outbox_tasks, delivery_attempts, idempotency_records
ops:          audit_events, exports, analytics_events, deletion_requests
staff:        staff_users, staff_access_grants, support_cases
```

Production SQL must enforce this contract with tests. The table is a design contract, not a substitute for migrations (DEL02).
