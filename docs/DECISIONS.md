> Source template: `docs/source/STANDARD OPERATING PROCEDURE.pdf` Version 1.0, section 15 (ASSUMPTIONS LOG)
> Additional required fields: `docs/source/Job_to_Invoice_Developer_PRD (1).docx` Version 1.0, section 34 (Business inputs and decision register)
> Authority: PRD wins on required fields. SOP generic defaults do not replace PRD MUST requirements.

# Decision log

Use this file for non-critical ambiguities and recorded assumptions. Make the most sensible production-quality assumption, write it here, and continue. Do not stop the build for minor ambiguities.

Escalate only decisions that materially affect:

- business model
- pricing
- legal requirements
- fundamental UX
- security
- architecture
- irreversible implementation
- launch geography
- tax engine
- Android launch
- team roles
- payment collection
- signature-provider requirements
- progress billing

Statuses: `Open` | `Assumed` | `Escalated` | `Resolved`

## Template

```
### D-NNN — short title

| Field | Value |
| --- | --- |
| ID | D-NNN |
| Date | YYYY-MM-DD |
| Status | Open / Assumed / Escalated / Resolved |
| Decision | |
| Reason | |
| Evidence | |
| Owner | |
| PRD implication | |
| Impacted requirement IDs | |
| Impacted test IDs | |
| Migration implications | |
| Reversible | Yes / No |
| Escalation category | none / business model / pricing / legal / fundamental UX / security / architecture / irreversible implementation / geography / tax engine / Android / team roles / payment collection / signature provider / progress billing |
```

---

## Logged decisions

### D-001 — SOP generic defaults yield to the approved PRD

| Field | Value |
| --- | --- |
| ID | D-001 |
| Date | 2026-09-14 |
| Status | Resolved |
| Decision | Where SOP Version 1.0 generic defaults conflict with the approved Job to Invoice PRD Version 1.0, the PRD wins. SOP remains the implementation process. |
| Reason | User/project authority rule and SOP section 2: if Cursor or Claude conflicts with the PRD, the PRD wins unless the requirement is technically impossible, unsafe or contradictory. |
| Evidence | SOP §2 hierarchy; PRD DEC01, DEC12, ARC01, section 30 planning range |
| Owner | Engineering lead |
| PRD implication | Implement iPhone-first (Android operator app deferred), Fastify domain API + Next.js portal + worker monorepo, first-party analytics (no tracking SDK / no PostHog as a v1 product requirement), Resend, Render default hosting, and the 10–14 week planning range. Do not treat the SOP 2–3 day timetable, PostHog default, or mandatory physical Android operator-app QA as product requirements for this release. |
| Impacted requirement IDs | DEC01, DEC12, ARC01, ANA01–ANA03, REL01–REL03, NFR02 |
| Impacted test IDs | QA45–QA51, QA67; SOP E2E-01–E2E-07 remain process guidance |
| Migration implications | None. Documentation-only authority resolution. |
| Reversible | Yes |
| Escalation category | none |

### D-002 — ACC02A action-grants route is not listed in the section 22 endpoint table

| Field | Value |
| --- | --- |
| ID | D-002 |
| Date | 2026-09-14 |
| Status | Resolved |
| Decision | Both texts are required. Keep every PRD §22 route. Implement `POST /account/action-grants` as the grant issuer. Export, deletion, email-change and replace-link reject without a valid unused hashed `X-Action-Grant` for that exact action after a fresh OTP. Ordinary token refresh is not fresh authentication. |
| Reason | ACC02A is a MUST. The omitted inventory row is a documentation inconsistency, not permission to skip the grant. Satisfying both texts is the smallest correct architecture: issuer route plus the four existing commands. |
| Evidence | PRD ACC02A; PRD section 22 endpoint inventory; adversarial review B-03 |
| Owner | Engineering lead |
| PRD implication | `action_grants` ships with Stage 2 replace-link. Stage 4 export/deletion reuse the same grant machinery. |
| Impacted requirement IDs | ACC02A, API01, section 22 inventory, EXP01, PRV03, QUO03, APR03 |
| Impacted test IDs | QA56, QA57; replace-link without grant / replay / wrong action |
| Migration implications | `action_grants(id,user_id,action,token_hash,expires_at,used_at)` as specified. OpenAPI includes the issuer route. |
| Reversible | No for the security rule; route path only if a later decision preserves the header and table |
| Escalation category | architecture |

### D-003 — apps/admin implemented with Next.js

| Field | Value |
| --- | --- |
| ID | D-003 |
| Date | 2026-09-14 |
| Status | Assumed |
| Decision | Implement `apps/admin` with Next.js, the same framework PRD ARC01 already requires for `apps/portal`. |
| Reason | ARC01 names `apps/admin` as the staff interface but does not name its framework. Sharing Next.js with the portal is the smallest consistent choice and does not change S28 behaviour, staff MFA, or grants. |
| Evidence | PRD ARC01, S28, SEC05 |
| Owner | Engineering lead |
| PRD implication | S28 remains a restricted staff console. Product behaviour is unchanged. Revisit only if Stage 0 shows Next.js is unfit for the staff surface. |
| Impacted requirement IDs | ARC01, S28, SEC05 |
| Impacted test IDs | QA59, QA60 |
| Migration implications | None. Framework choice only. |
| Reversible | Yes |
| Escalation category | none |

### D-004 — Monorepo tooling is pnpm workspaces plus Turborepo

| Field | Value |
| --- | --- |
| ID | D-004 |
| Date | 2026-09-14 |
| Status | Assumed |
| Decision | Use pnpm workspaces and Turborepo (or an equivalent workspace runner) as implementation tooling for the TypeScript monorepo. |
| Reason | ARC01 requires a TypeScript monorepo and does not specify the workspace tool. This is not a product rule. |
| Evidence | PRD ARC01, ARC05, DEL01 |
| Owner | Engineering lead |
| PRD implication | Apps and `packages/domain` remain as specified. Another workspace tool may replace this without a PRD change. |
| Impacted requirement IDs | ARC01, ARC05, DEL01 |
| Impacted test IDs | CI lockfile checks |
| Migration implications | Lockfile format only. |
| Reversible | Yes |
| Escalation category | none |

### D-005 — Foundation dependency pins

| Field | Value |
| --- | --- |
| ID | D-005 |
| Date | 2026-09-14 |
| Status | Resolved |
| Decision | Pin the repository foundation to Node 22.23.2, pnpm 12.4.1, TypeScript 5.9.3, Expo 57.0.22, React Native 0.86.3, React 19.2.3, Next.js 16.3.5, Fastify 5.12.4, Turbo 2.10.12, Zod 4.6.5, Vitest 5.0.0, ESLint 10.10.0, and Prettier 3.9.6, with exact versions in `pnpm-lock.yaml`. Encrypted SQLite remains unchosen until spike evidence. The original-quote PDF engine is D-016. Plaintext local storage remains forbidden. |
| Reason | ARC05 requires currently supported stable pins at project initialization. Expo SDK 57 requires React Native 0.86 and React 19.2.3, not the newer 0.87 / 19.3 line. |
| Evidence | Expo SDK 57 compatibility table; npm current stables on 2026-09-14; `pnpm-lock.yaml` |
| Owner | Engineering lead |
| PRD implication | Feature slices after this pin use the matrix. SYNC01 and DOC01 spikes remain release-blocking. This pin does not complete Stage 0 product spikes. |
| Impacted requirement IDs | ARC05, SYNC01, DOC01, DEL01 |
| Impacted test IDs | QA68, Stage 0 exit |
| Migration implications | Pin updates only. |
| Reversible | Yes |
| Escalation category | none |

### D-006 — TypeScript 5.9.3 instead of TypeScript 7

| Field | Value |
| --- | --- |
| ID | D-006 |
| Date | 2026-09-14 |
| Status | Assumed |
| Decision | Use TypeScript 5.9.3 for the monorepo. Do not pin TypeScript 7.0.2. |
| Reason | typescript-eslint 8.70.0 declares `typescript >=4.8.4 <6.1.0`. Expo SDK 57 is verified against the 5.x compiler. TypeScript 7 is current but not compatible with this lint/mobile set. |
| Evidence | typescript-eslint peerDependencies; Expo SDK 57 TypeScript guide |
| Owner | Engineering lead |
| PRD implication | Strict TypeScript remains required. Revisit after eslint/Expo support TS 7. |
| Impacted requirement IDs | ARC05, DEL01 |
| Impacted test IDs | CI typecheck |
| Migration implications | Compiler major only. |
| Reversible | Yes |
| Escalation category | none |

### D-007 — Identity schema, migrator BYPASSRLS, and deferred asset FKs

| Field | Value |
| --- | --- |
| ID | D-007 |
| Date | 2026-09-14 |
| Status | Resolved |
| Decision | Put `app_users` and `action_grants` in schema `identity`. Put tenant tables in schema `commercial`. `migrator` owns those objects so `FORCE ROW LEVEL SECURITY` stays on. Runtime roles `api_app`, `worker_app`, and `purge_app` stay `NOBYPASSRLS`, nologin, and non-superuser. Create `assets` in this slice only so `workspaces.logo_asset_id` can use a composite tenant FK; defer `job_id`/`draft_id` FKs until jobs and drafts exist. Local `pnpm migrate:clean` / `pnpm test:db` start embedded PostgreSQL 16 when `DATABASE_URL_MIGRATIONS` is unset. Role-level `BYPASSRLS` on `migrator` is superseded by D-010. |
| Reason | ACC02A requires a restricted identity schema. ARC02 requires FORCE RLS and a non-bypass API role. Root `workspace_id` FKs cannot be two copies of the same column. The logo FK is the first non-root composite tenant FK and unblocks isolation tests without jobs, quotes, approvals, or invoices. |
| Evidence | `supabase/migrations/0001_foundation.sql`, `0002_identity_tenancy.sql`, `scripts/db-test.mjs`; D-010 for hosted `NOBYPASSRLS` |
| Owner | Engineering lead |
| PRD implication | Authorization still comes from verified identity plus `SET LOCAL`. Workspace IDs in routes/bodies remain non-authoritative. Jobs/quotes/approvals/invoices remain later migrations. |
| Impacted requirement IDs | ARC02, ARC03, AUTHZ01, ACC02A, DB01, DEC04, SREF07 |
| Impacted test IDs | QA03; isolation suite pool-leak and role tests |
| Migration implications | Additive. `assets.job_id` / `draft_id` FKs must be added when those tables ship. |
| Reversible | No for schema split and FORCE RLS; logo table timing only |
| Escalation category | architecture |

### D-008 — Owner OTP session, SecureStore, and GET /me provisioning

| Field | Value |
| --- | --- |
| ID | D-008 |
| Date | 2026-09-14 |
| Status | Resolved |
| Decision | Verify owner access tokens with `jose` against the Supabase JWKS (`AUTH_ISSUER` + `AUTH_AUDIENCE=authenticated`). After a valid JWT, `GET /v1/me` calls `identity.provision_owner` (SECURITY DEFINER, `api_app` EXECUTE only) to map `auth.sub` to `app_users` and create one workspace/membership if needed. The function never accepts `workspace_id`. Persist the Supabase session with `expo-secure-store`, not AsyncStorage. S04 business fields stay for the next slice; new workspaces have empty setup fields and `setup_completed_at` null. Sign-out uses a typed draft-sync port that currently reports no unsynced drafts. Hosted OTP length/expiry/cooldown/attempt limits are dashboard settings documented in `docs/ENV.md`. |
| Reason | ACC01 forbids a second OTP store. ACC02 requires JWKS verification, secure refresh storage, and one refresh then sign-in. AUTHZ01 forbids treating a client workspace ID as authorization. FORCE RLS prevents `api_app` from looking up `auth_user_id` without a definer function. |
| Evidence | `apps/api/src/jwt.ts`, `supabase/migrations/0003_owner_provisioning.sql`, `apps/mobile/src/session/supabase.ts`, `docs/ENV.md` |
| Owner | Engineering lead |
| PRD implication | S02/S03/S22 sign-out ship in this slice. Physical Expo Go (2026-09-15): mailbox OTP succeeded, JWT verified, GET /v1/me returned 200 `response_sent`, and owner bootstrap reached S04. Dashboard attempt caps, production/native Keychain/Keystore, and signed builds remain unverified. |
| Impacted requirement IDs | ACC01, ACC02, AUTHZ01, API01–API03, ANA01, S02, S03, S22, ARC03, NFR01, SEC01, SEC04, OPS03 |
| Impacted test IDs | QA01, QA02, QA19, QA61, QA63 |
| Migration implications | Additive `setup_completed_at`, `analytics_alias_id`, `analytics_events`, `provision_owner`. |
| Reversible | No for JWKS + SecureStore; setup column nullability only |
| Escalation category | architecture |

### D-009 — POST /workspace completes the provisioned workspace

| Field | Value |
| --- | --- |
| ID | D-009 |
| Date | 2026-09-14 |
| Status | Resolved |
| Decision | `GET /v1/me` keeps provisioning one empty workspace (D-008). `POST /v1/workspace` completes that row in place. It does not insert a second workspace. The client cannot send `workspace_id`, `owner_user_id`, `currency`, `version`, or `setup_completed_at`. If-Match is the current workspace version. Logo upload is skipped in S04; the owner must confirm skip. Local setup drafts use a separate SecureStore key (`jti.setup.draft`), not the session blob and not SQLCipher (SYNC01 remains a later spike). `onboarding_completed` is a server event. `job_allowances` is created with zeroed counters so POST /workspace stays atomic without implementing entitlements. |
| Reason | Unique `owner_user_id` forbids a second workspace. API_CONTRACT lists POST /workspace as the setup command. Encrypted SQLite is still TBD; onboarding form state still must survive restart without storing tokens. |
| Evidence | `supabase/migrations/0004_workspace_setup.sql`, `apps/api/src/workspace.ts`, `apps/mobile/app/(onboarding)/setup.tsx` |
| Owner | Engineering lead |
| PRD implication | PATCH /workspace remains Settings/future drafts. S05 is a navigation shell only. Physical Expo Go (2026-09-15): S04 completed and routed to authenticated Jobs. VoiceOver, Maestro, and production/native SecureStore remain unverified. |
| Impacted requirement IDs | S04, VAL01, VAL02, FIN02, INV10, AUTHZ01, API01–API03, ANA01, DEC03, DEC04, ACC01 (onboarding entry), ACC02 (session/offline on setup) |
| Impacted test IDs | QA01, QA61, QA64 |
| Migration implications | Additive tables `job_allowances`, `audit_events`, `idempotency_records`; completed-setup check; `complete_workspace_setup`. |
| Reversible | No for completing setup in place; logo skip is slice timing only |
| Escalation category | architecture |

### D-010 — Hosted CREATE ROLE-only bootstrap with table-scoped owner policies

| Field | Value |
| --- | --- |
| ID | D-010 |
| Date | 2026-09-14 |
| Status | Resolved |
| Decision | Keep D-007’s schema split, `FORCE ROW LEVEL SECURITY`, `migrator` object ownership, and runtime roles that must not bypass RLS. Hosted Supabase `postgres` rejects `ALTER ROLE` (including `BYPASSRLS` / `NOBYPASSRLS` and ordinary attribute changes). Application roles `migrator`, `api_app`, `worker_app`, and `purge_app` receive `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION` only in `CREATE ROLE` when missing. PostgreSQL defaults new roles to `NOBYPASSRLS`. Bootstrap never repairs a pre-existing role: it fails closed if any of those four has `LOGIN`, `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION`, or `BYPASSRLS`. Owner DML uses table-scoped `FOR ALL TO migrator USING (true) WITH CHECK (true)` policies named `{schema}_{table}_migrator_all`. Do not `ALTER` or drop hosted `anon` / `authenticated`; create them only when absent for embedded Postgres. Never give unrestricted policies to runtime or client roles. Never use `service_role`. The migration/runtime login may assume `worker_app` after `0009` (`grant worker_app to current_user`, matching `0001` `grant api_app to current_user`). `worker_app` stays `NOLOGIN`. All worker operations still use transaction-local `SET LOCAL ROLE worker_app`. |
| Reason | Hosted `db push` of `0001` failed on `ALTER ROLE … BYPASSRLS`, then `NOBYPASSRLS`, then `ALTER ROLE migrator with nologin nosuperuser …` with no bypass clause. Hosted `postgres` cannot `ALTER ROLE`. FORCE RLS must remain. Safe attributes belong on `CREATE ROLE` only. Pre-existing unsafe roles must abort, not be rewritten. Table-scoped owner policies restore definer/migration DML without cluster-wide bypass. |
| Evidence | Hosted `LegacyDbPushApplyError` at `ALTER ROLE migrator` (bypass, nobypass, and attribute-only forms); `supabase/migrations/0001_foundation.sql`–`0004_workspace_setup.sql`; `0009_worker_app_membership.sql`; `scripts/db-test.mjs`; `supabase/tests/0003_runtime_roles.sql`; `supabase/tests/0005_migrator_force_rls_policy.sql`; `supabase/tests/0011_worker_app_membership.sql` |
| Owner | Engineering lead |
| PRD implication | ARC02 FORCE RLS and non-bypass API/worker/purge roles stand. Provisioning and workspace setup still run as `SECURITY DEFINER` owned by `migrator`, executable only by `api_app`. Hosted apply of 0001–0004 remains a later authorized step. |
| Impacted requirement IDs | ARC02, ARC03, AUTHZ01, ACC02A, DB01, SREF07 |
| Impacted test IDs | QA03; isolation suite; provision_owner / complete_workspace_setup db tests |
| Migration implications | Do not edit or replay `0001`–`0008`. Forward-only `0009_worker_app_membership.sql` grants `worker_app` to `current_user` so the hosted development worker login can `SET LOCAL ROLE worker_app`. No `ALTER ROLE`. No `LOGIN` on `worker_app`. No extra table grants. Hosted apply of `0009` is a later authorized step; this change does not dispatch it. |
| Reversible | No for hosted compatibility; policy names are additive |
| Escalation category | architecture |

### D-011 — RESET ROLE before Supabase records migration history

| Field | Value |
| --- | --- |
| ID | D-011 |
| Date | 2026-09-14 |
| Status | Resolved |
| Decision | Application migrations after `0001` may `SET ROLE migrator` so schemas, tables, functions, and SECURITY DEFINER objects stay owned by `migrator`. Any migration that sets that role must `RESET ROLE` as its last executable statement, after all DDL, grants, ownership changes, functions, policies, and comments. No executable statement may follow `RESET ROLE`. Do not change hosted `0001_foundation.sql`. Do not `ALTER ROLE`. Never use `service_role`. |
| Reason | Hosted `db push` applied and recorded `0001`, then failed on `0002` at `INSERT INTO supabase_migrations.schema_migrations` (statement 82). `0002` had run as `migrator`. That role has no catalog access, so history insert failed and `0002` rolled back. `0001` does not `SET ROLE` and recorded successfully. |
| Evidence | Hosted `LegacyDbPushApplyError` at `INSERT INTO supabase_migrations.schema_migrations` during `0002`; `supabase/migrations/0002_identity_tenancy.sql`–`0004_workspace_setup.sql`; `scripts/db-test.mjs`; `supabase/tests/0006_migrator_ownership.sql` |
| Owner | Engineering lead |
| PRD implication | ARC02 ownership, FORCE RLS, and definer functions stand. Hosted `0001` remains applied. Hosted `0002`–`0004` remain unverified until a later authorized apply. |
| Impacted requirement IDs | ARC02, DB01, AUTHZ01, SREF07 |
| Impacted test IDs | QA03; isolation suite; provision_owner / complete_workspace_setup db tests |
| Migration implications | Edit only unapplied `0002`–`0004`. Last statement must be `RESET ROLE`. Do not rewrite or reapply `0001`. Do not repair hosted history in this change. |
| Reversible | No for hosted CLI compatibility |
| Escalation category | architecture |

### D-012 — Hosted apply over IPv4 session pooler

| Field | Value |
| --- | --- |
| ID | D-012 |
| Date | 2026-09-14 |
| Status | Resolved |
| Decision | Hosted `db.<project-ref>.supabase.co:5432` is IPv6-only. `supabase db query --linked` still works over HTTPS; `supabase db push --linked` dials the IPv6 direct host and times out (`LegacyDbConnectError`). Hosted applies from IPv4-only networks must use Supavisor **session** mode: exact host `aws-0-<region>.pooler.supabase.com`, explicit port `5432`, user `postgres.<linked-project-ref>` from `supabase/.temp/project-ref`. Do not take the project ref from the environment. Do not use extra pooler subdomains, omitted port, port `6543`, `--linked`, `--include-all`, `--include-roles`, `--include-seed`, `--debug`, `--log-level`, `--output-format`, or `migrate:clean`. Do not use `service_role`. Do not reapply `0001`. Percent-encode reserved password characters. `pnpm hosted:db-check` is a read-only preflight (`db push --db-url <url> --dry-run` with no `--yes`). `pnpm hosted:db-push` is the live apply (`db push --db-url <url> --yes` with no `--dry-run`). The wrapper ignores child stdin, so live apply must pass `--yes`. Both validate the URL statically (linked ref, `postgres.<linked-ref>` username, session-pooler host, explicit port `5432`, password, protocol; reject direct host, `6543`, `service_role`, query, fragment), then spawn the CLI once with argv and the shell disabled. Custom DNS/TCP reachability probes were removed because they can disagree with Windows and Supabase CLI resolution and add no authorization protection. DNS, TCP, TLS, and authentication are performed by the CLI. The wrapper emits a sanitized report only (ok/fail, exit code, connect started/succeeded, pending `NNNN_name.sql` names, `stage`, allowlisted category, optional migration basename, statement number, SQLSTATE, `LegacyDb*` tag). Raw child output, URLs, passwords, argv, SQL, and unknown text are not printed. Generic `Error:` and login-role `permission denied to alter role` are not a migration SQL failure. Hosted migration commands use the root-pinned `supabase` 2.117.0 CLI. The wrapper resolves repository `supabase/dist/supabase.js` before any global npm PATH shim and launches it through `process.execPath` with `shell:false`. `.cmd`/`.ps1` shims, `cmd.exe`, and PowerShell are prohibited. `--db-url` remains visible on the local process list while the CLI runs. Local Windows live apply over the session pooler has been unreliable at `connecting` after a successful dry-run. Hosted development `0002`–`0004` were applied through `.github/workflows/hosted-development-migrations.yml` (confirmation `APPLY_0002_0004`, Environment `development`, secret `DATABASE_URL_MIGRATIONS`). Further hosted applies use that same dispatch-only Ubuntu path. The current confirmation phrase is `APPLY_0010` for pending `0010_quote_approval_request.sql` only. |
| Reason | Direct host `db.fhgacxkpgjdcjuvanesv.supabase.co` resolves only to AAAA. TCP 5432 to it fails. The us-west-2 session pooler resolves to IPv4 and accepts TCP 5432 and 6543. Linked `db push` of `0002`–`0004` timed out during connect after `0001` was already recorded. A wrapper DNS/TCP preflight then reported DNS failure on Windows while Test-NetConnection succeeded against the same session-pooler host and port. That probe added no authorization protection, so connection checks are delegated to the CLI. Local Windows `hosted:db-check` can list pending `0002`–`0004` while `hosted:db-push` then fails at `connecting`, so live apply is not authorized from that workstation. |
| Evidence | DNS AAAA-only for `db.fhgacxkpgjdcjuvanesv.supabase.co`; TCP 5432 false to that host; TCP 5432 true to `aws-0-us-west-2.pooler.supabase.com`; `LegacyDbConnectError` / `PgClient: Connection timed out`; Windows live `hosted:db-push` `stage: connecting`; `scripts/hosted-db-push.mjs`; `.github/workflows/hosted-development-migrations.yml`; `pnpm test:hosted-push`; hosted `migration list --linked` and catalog SELECT 2026-09-15 (`0001`–`0004` recorded, nine FORCE RLS tables, migrator policies, revoked client grants, `pnpm secret-scan`) |
| Owner | Engineering lead |
| PRD implication | Hosted development `0001`–`0004` are recorded on `fhgacxkpgjdcjuvanesv` and catalog-verified. Physical Expo Go (2026-09-15) executed hosted `provision_owner` (`GET /v1/me` 200 `response_sent`) and `complete_workspace_setup` (S04 saved). Live hosted two-tenant isolation, hosted database lint, and production/native builds remain unverified. |
| Impacted requirement IDs | ARC02, DB01, SREF07 |
| Impacted test IDs | `pnpm test:hosted-push` |
| Migration implications | Do not change or reapply `0001`–`0009`. Do not repair history. Hosted development already recorded `0001`–`0009`. Further hosted applies use `.github/workflows/hosted-development-migrations.yml` with a process-local `DATABASE_URL_MIGRATIONS` session-pooler URL via `pnpm hosted:db-push` on `ubuntu-latest`, not `db push --linked` and not a live apply from the unreliable local Windows session. The next apply is `0010_quote_approval_request.sql` only, confirmation `APPLY_0010`. Do not dispatch until authorized. |
| Reversible | No for IPv4-only networks without the IPv4 add-on |
| Escalation category | architecture |

### D-013 — PRD-shaped jobs slice without quote/invoice editors

| Field | Value |
| --- | --- |
| ID | D-013 |
| Date | 2026-09-15 |
| Status | Resolved |
| Decision | Authenticated Jobs MVP persists PRD `commercial.customers` and `commercial.jobs` (JOB01 lifecycle, composite tenant FKs, `version`, FORCE RLS, migrator owner policy, `api_app` tenant policies). New jobs start as `draft`. POST `/v1/jobs` accepts a client UUID, customer **name** (inserts the minimum customer row; no S07/S19 CRM), title, explicit `no_site` or site address, optional internal notes, and `mode` `quote` \| `direct_invoice`. `mode` is stored for later publish/issue and is not a document draft. GET `/v1/jobs` is cursor-paginated (`items`, `next_cursor`; S05 Active = `state=open` including drafts). GET `/v1/jobs/{id}` is read-only and does not invent scope or ledger totals. `current_quote_id` / `active_invoice_id` columns exist without document FKs until `documents`. `assets.job_id` FK is added. Server emits `job_created` with allowlisted `mode` `quote`/`direct` only. Hosted `0005` is not applied in this slice. |
| Reason | Option A from the Jobs MVP decision: do not invent a reduced jobs table, and do not ship quote/invoice/CRM screens in this slice. |
| Evidence | `supabase/migrations/0005_customers_jobs.sql`; `apps/api/src/jobs.ts`; `packages/schemas/src/job.ts`; `openapi/v1.json`; mobile `/(tabs)/jobs` |
| Owner | Engineering lead |
| PRD implication | S05/S06/S08 and JOB01 persistence are implemented locally. JRN01 quote publish, API04 drafts, S07/S19, and hosted `0005` remain later. |
| Impacted requirement IDs | S05, S06, S08, JOB01, VAL01, VAL02, API01, API02, DB01, ANA01 |
| Impacted test IDs | `packages/schemas/src/job.test.ts`; `apps/api/src/jobs.test.ts`; `apps/mobile/src/jobs/form.test.ts`; `pnpm test:db`; `pnpm validate:openapi` |
| Migration implications | Forward-only `0005_customers_jobs.sql`. Do not edit or replay `0001`–`0005`. Hosted apply is `.github/workflows/hosted-development-migrations.yml` with confirmation `APPLY_0005`; this repository change does not dispatch it. |
| Reversible | No for the `customers`/`jobs` shape once hosted-applied |
| Escalation category | none |

### D-014 — Quote drafting uses document_drafts payload, not a reduced line table

| Field | Value |
| --- | --- |
| ID | D-014 |
| Date | 2026-09-15 |
| Status | Resolved |
| Decision | Quote-mode draft jobs create or reopen one `commercial.document_drafts` row (`kind=quote`, `draft_state=editing`). Line items, notes, terms, and expiry days live in `payload_json`. Server recalculates FIN01 totals with `@job-to-invoice/domain` and does not persist client totals. `documents` / `document_lines` / official Q-numbers stay unpublished. Direct-invoice jobs cannot open this editor. Optimistic concurrency is If-Match on `version`. |
| Reason | DATABASE.md already specifies `document_drafts.payload_json`. Inventing a separate draft-lines table or skipping tax/discount/units would reduce the PRD. Publish snapshots are a later slice. |
| Evidence | `supabase/migrations/0006_document_drafts.sql`; `apps/api/src/drafts.ts`; `packages/schemas/src/draft.ts`; mobile `/(tabs)/jobs/[id]/quote` |
| Owner | Engineering lead |
| PRD implication | S09/S10 drafting is implemented locally. EMAIL01, customer approval, PDF bytes, API04 invoice drafts, and hosted `0006`/`0007` remain later. |
| Impacted requirement IDs | S08, S09, S10, VAL03, VAL04, FIN01, API01, API03, DB01, SYNC02 |
| Impacted test IDs | `packages/schemas/src/draft.test.ts`; `apps/api/src/drafts.test.ts`; `apps/mobile/src/quotes/form.test.ts`; `pnpm test:db`; `pnpm validate:openapi` |
| Migration implications | Forward-only `0006_document_drafts.sql`. Do not edit or replay `0001`–`0006`. Hosted apply is `.github/workflows/hosted-development-migrations.yml` with confirmation `APPLY_0006`; this repository change does not dispatch it. |
| Reversible | No for the `document_drafts` shape once hosted-applied |
| Escalation category | none |

### D-015 — Quote publish freezes snapshots without email, approval tokens, or in-process PDF

| Field | Value |
| --- | --- |
| ID | D-015 |
| Date | 2026-09-15 |
| Status | Resolved |
| Decision | First quote publication follows TX01 locally: `POST /v1/drafts/{id}/preview` freezes a 10-minute QUO02A commercial snapshot; `POST /v1/drafts/{id}/publish` requires that `preview_hash` plus If-Match draft version, recalculates FIN01 with `@job-to-invoice/domain`, allocates `Q-000001` `R1` from `document_counters`, inserts immutable `documents`/`document_lines`, marks the draft `published` without deleting it, sets `jobs.lifecycle=active` and `completion_right`, consumes one free slot, and inserts a `generate_original_pdf` outbox row. Canonical snapshot bytes exclude the allocated number (it lives on `documents.number`/`revision_no` because allocation happens after preview freeze) and exclude generation timestamps. Recipient email, `approval_requests`, EMAIL01, and PDF bytes are out of this slice; `GET /documents/{id}/download` returns `preparing` until D-016. Hosted `0007` is not applied in this slice. |
| Reason | QUO02, QUO02A, JOB01, INV06, ARC04, and SUB02 are defined. Slice scope forbids email and public approval links. Generating PDF inside the API would violate ARC04 and invent a DOC01 engine. |
| Evidence | `supabase/migrations/0007_quote_publish.sql`; `apps/api/src/quotes.ts`; `packages/domain/src/snapshot.ts`; mobile `/(tabs)/jobs/[id]/publish` |
| Owner | Engineering lead |
| PRD implication | S11 publish is implemented locally. Original PDF bytes are D-016. EMAIL01, APR01, S12, and hosted `0007` remain later. |
| Impacted requirement IDs | S11, S08, QUO01, QUO02, QUO02A, JOB01, TX01, INV03, INV06, INV09, SUB02, ARC04, FIN01, API01, DB01, DB04, ANA01 |
| Impacted test IDs | `packages/domain/src/snapshot.test.ts`; `apps/api/src/quotes.test.ts`; `apps/mobile/src/quotes/form.test.ts`; `pnpm test:db`; `pnpm validate:openapi` |
| Migration implications | Forward-only `0007_quote_publish.sql`. Do not edit or replay `0001`–`0007`. Hosted apply is `.github/workflows/hosted-development-migrations.yml` with confirmation `APPLY_0007`; this repository change does not dispatch it. |
| Reversible | No for the `documents` shape once hosted-applied |
| Escalation category | none |

### D-016 — Playwright original-quote PDF on private Cloudflare R2

| Field | Value |
| --- | --- |
| ID | D-016 |
| Date | 2026-09-15 |
| Status | Resolved |
| Decision | Original published-quote PDFs are generated only from immutable `documents` / `document_lines` (never drafts) by `apps/worker`. The engine is Playwright 1.63.0 + bundled Chromium, pinned with Node 22.23.2. Chromium loads worker-controlled HTML only; all network requests are aborted. Template `quote-original-v1` is A4 portrait, print backgrounds, fixed 18 mm margins, `lang=en`, and calendar dates from the snapshot without `Date` locale conversion. Inter Regular/Medium/Bold (SIL OFL) are embedded as data URIs. DOC01’s US Letter size is superseded here by A4. Storage is S3-compatible and provider-neutral: private Cloudflare R2 in production/staging, private MinIO in development. Not Supabase Storage and not `STORAGE_SERVICE_KEY` / `service_role`. Server-only config: `STORAGE_ENDPOINT`, optional `STORAGE_DOWNLOAD_ENDPOINT` for LAN-reachable presigns, `STORAGE_REGION`, `STORAGE_DOCUMENTS_BUCKET`, `STORAGE_FORCE_PATH_STYLE`, and separate worker (bucket-scoped Object Read & Write) and API (bucket-scoped Object Read-only) keys. Development may use HTTP on localhost or RFC1918. Production and staging require HTTPS and fail closed if a local or private endpoint is configured. Presigned GET URLs for physical-device testing must use `STORAGE_DOWNLOAD_ENDPOINT`, not localhost. Buckets: `job-to-invoice-documents-development` (development) and `job-to-invoice-documents-production` (production). Staging must set `STORAGE_DOCUMENTS_BUCKET` explicitly. Object key `workspaces/{workspace_id}/documents/{document_id}/revisions/{revision}/original/{artifact_id}.pdf`. `artifact_id` is persisted on the outbox payload before the first PutObject so retries overwrite the same key. Mobile receives only the 5-minute URL. No public buckets, no anonymous MinIO policy, no bucket listing, no `EXPO_PUBLIC_*` storage secrets. Outbox: 60 s lease, max 5 attempts, backoff 30 s / 2 m / 10 m / 30 m, fifth failure or permanent validation failure → `dead` and download `failed`. Crash between upload and DB commit retries PutObject then inserts `artifacts` from database state; never list the bucket. Hosted `0008` is not applied in this slice. |
| Reason | Stage 0 left DOC01/DOC05 unchosen. Approved worker/PDF/R2 contract unblocks S11 download without Supabase Storage or `service_role`. |
| Evidence | `supabase/migrations/0008_original_quote_pdf.sql`; `apps/worker`; `packages/domain/src/quote-html.ts`; `GET /v1/documents/{id}/download`; `packages/config/src/storage.ts`; `docker-compose.minio.yml`; physical Expo Go 2026-09-16 original quote PDF generate and download in development (IMPLEMENTED evidence, not production VERIFIED) |
| Owner | Engineering lead |
| PRD implication | DOC01 layout uses A4 for this product. DOC05 signed URLs are S3-compatible presigned GET (Cloudflare R2 in production, private MinIO in development), not Supabase Storage. EMAIL01 and public approval remain later. |
| Impacted requirement IDs | DOC01, DOC05, INV03, ARC04, S11, QA54, QA53 |
| Impacted test IDs | `packages/domain/src/quote-html.test.ts`; `apps/worker/src/outbox.test.ts`; `apps/api/src/quotes.test.ts`; `apps/api/src/documents-store.test.ts`; `packages/config/src/storage.test.ts`; `apps/mobile/src/quotes/form.test.ts`; `pnpm test:db` |
| Migration implications | Forward-only `0008_original_quote_pdf.sql`. Do not edit or replay `0001`–`0008`. Worker runtime membership is a later forward-only `0009_worker_app_membership.sql` (`grant worker_app to current_user`). The login may assume `worker_app`; all worker operations still use transaction-local `SET LOCAL ROLE worker_app`. Hosted apply of `0008` is `.github/workflows/hosted-development-migrations.yml` with confirmation `APPLY_0008`; hosted apply of `0009` is a later authorized step. This repository change does not dispatch either. |
| Reversible | No for R2 key layout and Playwright template once hosted-applied |
| Escalation category | architecture |

### D-017 — Resend HTTPS EMAIL01 with isolated delivery encryption

| Field | Value |
| --- | --- |
| ID | D-017 |
| Date | 2026-09-16 |
| Status | Resolved |
| Decision | First quote-request delivery uses Resend HTTPS POST `https://api.resend.com/emails` via Node `fetch`. No Resend SDK and no Svix package. The API generates a 256-bit token, HMAC-SHA256 hashes it with `APPROVAL_TOKEN_HASH_KEY`, AES-256-GCM encrypts it with `APPROVAL_DELIVERY_ENCRYPTION_KEY` (12-byte nonce, token+tag ciphertext), and atomically inserts `approval_requests`, `delivery_attempts`, `encrypted_delivery_payloads`, `generate_original_pdf`, and `send_email` during TX01. The API never calls Resend and never returns the token or fragment URL to mobile. The worker decrypts the token in memory only after the original PDF artifact is ready, sends EMAIL01 with href `{PORTAL_ORIGIN}/review#{token}`, uses `delivery_attempts.effect_key` as the Resend Idempotency-Key, and persists `provider_message_id` before completing the outbox. Webhooks are verified on `POST /webhooks/email` with the official Svix headers, `whsec_` HMAC-SHA256, five-minute timestamp tolerance in every `APP_ENV`, and `timingSafeEqual` over v1 signatures. JSON is parsed only after verification. Ciphertext is purged within 24 hours of a terminal delivery state. `APPROVAL_EVIDENCE_ENCRYPTION_KEY` is not used for delivery. |
| Reason | Stage 2 D remainder requires EMAIL01 and S12 without exposing tokens to mobile or mixing API webhook secrets with worker send credentials. |
| Evidence | `supabase/migrations/0010_quote_approval_request.sql`; `apps/api` publish/S12/webhook; `apps/worker` EMAIL01; `apps/mobile` S11 recipient + S12; `packages/config` approval-crypto and Resend webhook verifier |
| Owner | Engineering lead |
| PRD implication | EMAIL01 and S12 are implemented locally. Portal OTP/review/approve, resend/withdraw/replace, customer PDF download, and production SPF/DKIM/DMARC remain later. Live Resend delivery is not VERIFIED. |
| Impacted requirement IDs | EMAIL01, S12, APR01, NTF02, NTF03, TX01, INV04, SEC01, SEC02 |
| Impacted test IDs | `packages/config/src/resend-webhook.test.ts`; `packages/config/src/approval-crypto.test.ts`; `apps/api/src/quotes.test.ts`; `apps/worker/src/email.test.ts`; `apps/mobile/src/quotes/form.test.ts`; `pnpm test:db` |
| Migration implications | Forward-only `0010_quote_approval_request.sql`. Do not edit or replay `0001`–`0009`. Hosted apply of pending `0010` is confirmation `APPLY_0010`. This change does not dispatch it. |
| Reversible | No for hashed tokens and EMAIL01 outbox once hosted-applied |
| Escalation category | architecture |

### D-018 — Portal BFF cookies for customer quote review

| Field | Value |
| --- | --- |
| ID | D-018 |
| Date | 2026-09-17 |
| Status | Resolved |
| Decision | Customer portal browsers never set the approval session cookie on the API port. `apps/portal` Next.js BFF (`app/api/portal/*`) forwards `/v1/portal/*` server-side with `Origin: PORTAL_ORIGIN`, then sets `jti_portal` as an HttpOnly SameSite=Lax host-only cookie on `PORTAL_ORIGIN`. CSRF remains a page-memory nonce (HMAC of session hash + generation). Development HTTP may omit `Secure`; staging and production require HTTPS + `Secure`. Owner Bearer is rejected on portal routes; portal cookies are rejected on owner routes. |
| Reason | PRD SameSite=Lax host-only cookies cannot be sent from `localhost:3000` to API `:3001`. A BFF preserves the cookie model without changing TX02 or token fragment rules. |
| Evidence | `supabase/migrations/0011_quote_approval_portal.sql`; `apps/api/src/portal.ts`; `apps/portal/app/api/portal/[...path]/route.ts`; `apps/portal/app/review/**` |
| Owner | Engineering lead |
| PRD implication | JRN02 / S25–S27 / APR01A cookie+CSRF path is implemented locally. Hosted `0011` apply, live Resend/SPF, and QA21 withdraw remain later. |
| Impacted requirement IDs | JRN02, S25, S26, S27, APR01, APR01A, APR02, APR04, APR06, EMAIL03, EMAIL04, EMAIL05, TX02, API01, AUTHZ01, SEC01, QA16, QA18–QA20, QA22–QA26, QA53, QA63 |
| Impacted test IDs | `apps/api/src/portal.test.ts`; `apps/portal/src/review.test.ts`; `apps/worker/src/email.test.ts`; `supabase/tests/0013_quote_approval_portal.sql`; `pnpm test:db` |
| Migration implications | Forward-only `0011_quote_approval_portal.sql`. Do not edit or replay `0001`–`0010`. Hosted apply of pending `0011` is a later authorized step. This change does not dispatch it. |
| Reversible | No for portal sessions, OTP hashes, and TX02 decisions once hosted-applied |
| Escalation category | architecture |

### D-019 — Owner /v1/me 15s timeout and empty draft-sync port until SYNC01

| Field | Value |
| --- | --- |
| ID | D-019 |
| Date | 2026-09-18 |
| Status | Resolved |
| Decision | Owner bootstrap `GET /v1/me` uses a 15-second client `AbortController` timeout (NFR06 mobile reads). Timeout/abort maps to status `0`, code `UNAVAILABLE`, retryable, existing network copy, and `BOOTSTRAP_NETWORK`. One refresh on 401 is unchanged; Retry remains one GET and does not refresh. OTP send/verify are not auto-retried. Local draft persistence (SYNC01) is not in this slice: `getDraftSyncStatus` stays `EMPTY_DRAFT_SYNC`, `discardLocalDrafts` is a no-op, and Settings never offers Synchronize. A supplied `hasUnsyncedDrafts: true` still requires stay/discard confirmation; discard failure does not sign out. Seven-day offline *record* access stays BLOCKED on SYNC01. Signed-out jobs deep links resolve to welcome via `resolveOwnerGuard`; ACC01 remains typed email codes, not magic links. |
| Reason | Audit CODE GAPS for in-scope hardening only. Do not rebuild working OTP. Do not fake SQLite or a successful Synchronize. |
| Evidence | `apps/mobile/src/session/bootstrap.ts`; `apps/mobile/src/session/sign-out.ts`; `apps/mobile/src/drafts/sync.ts`; `apps/mobile/src/session/logic.ts`; `apps/mobile/app/_layout.tsx`; physical Expo Go OTP 2026-09-15 (development) |
| Owner | Engineering lead |
| PRD implication | NFR06 owner-read timeout is implemented for `/v1/me` only. ACC02 JWT/refresh/sign-out empty port remain. ACC02 7-day offline records, real unsynced sign-out, provider OTP caps, production Keychain, VoiceOver, and hosted TLS/HSTS are not VERIFIED. |
| Impacted requirement IDs | NFR06, ACC02, S22, SYNC01, NFR05 |
| Impacted test IDs | QA01, QA02, QA05, QA06; `apps/mobile/src/session/bootstrap.test.ts`; `apps/mobile/src/session/sign-out.test.ts`; `apps/mobile/src/session/logic.test.ts`; `apps/mobile/src/drafts/sync.test.ts` |
| Migration implications | None. |
| Reversible | Yes for timeout injection; empty draft adapter is replaced when SYNC01 ships |
| Escalation category | none |

### D-020 — SYNC01 Phase 0 uses expo-sqlite SQLCipher in EAS native builds

| Field | Value |
| --- | --- |
| ID | D-020 |
| Date | 2026-09-19 |
| Status | Resolved |
| Decision | Phase 0 encrypted local persistence uses `expo-sqlite@57.0.3` with the Expo config plugin `["expo-sqlite", { "useSQLCipher": true }]`. Each authenticated owner gets one SQLCipher database file and a 256-bit key stored only in `expo-secure-store` under `jti.sqlite.key.{owner_id}`. Keys are generated with `expo-crypto` `getRandomBytes(32)` and applied as `PRAGMA key = "x'<hex>'"` immediately after open. Expo Go is an unsupported runtime. Phase 0 creates only a harmless `sync01_probe` table; jobs, quotes, drafts, tokens, emails, and OTPs are not stored. Wipe deletes the database file and SecureStore key and reports failure if either step fails. Wrong-key open maps to `DATABASE_UNAVAILABLE` and does not regenerate a key over an existing ciphertext. |
| Reason | PRD SYNC01 and SREF08 require encrypted per-owner SQLite, OS-secured keys, Expo development builds, and forbid plaintext fallback. Expo 57 documents SQLCipher via `useSQLCipher`. |
| Evidence | `apps/mobile/app.json` plugin; `apps/mobile/package.json` / `pnpm-lock.yaml`; `apps/mobile/src/storage/*`; unit orchestration tests; physical Android EAS development build 2026-09-20 Phase 0 checks A–E PASS (capability, probe write, force-close reopen, wrong-key rejection, wipe). Normal-SQLite file extraction not performed. |
| Owner | Engineering lead |
| PRD implication | Phase 0 SQLCipher foundation device checks A–E are VERIFIED on physical Android EAS development build (2026-09-20). Commercial SYNC01 slice (cache, drafts, outbox, conflict, sign-out, D-021–D-023) is IMPLEMENTED; partial commercial Android happy-path evidence is recorded in TEST_PLAN; combined QA05–08 remains NOT VERIFIED. Temporary diagnostics harness must not ship. |
| Impacted requirement IDs | SYNC01, NFR05, ACC02, DEC10, SREF08 |
| Impacted test IDs | QA05; `apps/mobile/src/storage/*.test.ts`; EAS SQLCipher manual procedure in `docs/TEST_PLAN.md` |
| Migration implications | None for Postgres. Requires a new EAS development/preview binary after enabling SQLCipher. |
| Reversible | Yes before commercial records are stored; irreversible once owners have encrypted drafts on device |
| Escalation category | architecture |

### D-021 — Manual Synchronize overrides outbox backoff and reclaim stuck in_flight

| Field | Value |
| --- | --- |
| ID | D-021 |
| Date | 2026-09-20 |
| Status | Resolved |
| Decision | Settings Synchronize and sign-out Synchronize call `drainOutbox` with `forceImmediate: true`. That pass reclaims every `in_flight` row back to `pending` and sets `next_attempt_at = now` on pending rows so SYNC05 exponential backoff cannot permanently block a user-requested drain. Automatic reconnect/foreground drain keeps `forceImmediate: false`: it respects `next_attempt_at` and only reclaims `in_flight` rows older than the 60s lease. `operation_id`, idempotency key, and If-Match/base version are never regenerated on reclaim or retry. Drain outcomes distinguish `empty`, backoff (`ineligible_retry_time`), `no_executable_operation`, request/auth/conflict/server failures, and success; Synchronize reports failure when remaining work exists after a zero-drain pass and never signs out until the outbox is empty. Safe `__DEV__` diagnostics may log only stage/outcome/kind/HTTP status. |
| Reason | Physical Android evidence: offline save survived restart and Settings showed unsynced work, but Synchronize returned generic failure with no API request because a prior reconnect attempt left the op `in_flight` or behind `next_attempt_at`, and `listRunnableOutboxOperations` only selects eligible `pending` rows. |
| Evidence | `apps/mobile/src/drafts/persist.ts`; `apps/mobile/src/sync/outbox.ts` `prepareOutboxForDrain`; `apps/mobile/src/sync/controller.ts`; `apps/mobile/src/session/AuthProvider.tsx`; `apps/mobile/src/sync/sync01.test.ts` manual synchronize cases |
| Owner | Engineering lead |
| PRD implication | SYNC05 backoff remains for automatic drain. Manual Synchronize is an explicit user override of retry timing, not a second queue. |
| Impacted requirement IDs | SYNC01, SYNC05, SYNC02, S22, ACC02, QA05, QA06 |
| Impacted test IDs | `apps/mobile/src/sync/sync01.test.ts`; physical Settings Synchronize retest |
| Migration implications | None. Existing pending/in_flight outbox rows are preserved and become executable on next manual Synchronize. |
| Reversible | Yes |
| Escalation category | architecture |

### D-023 — Outbox draft PATCH body matches online save contract

| Field | Value |
| --- | --- |
| ID | D-023 |
| Date | 2026-09-20 |
| Status | Resolved |
| Decision | Outbox replay of `PATCH /v1/drafts/{id}` must send the same body as the online quote save: only `notes`, `terms`, `expiry_days`, and `lines` (line fields without computed totals). Local SQLCipher rows may still store a richer QuoteDraftRecord for hydration. `ownerDraftPatchBodyFromStored` maps rich or clean JSON at enqueue and again at drain so already-queued bad bodies become valid. HTTP 422 / `VALIDATION_FAILED` marks the outbox op `failed` (no SYNC05 retry loop) while preserving the local draft for a later user save. Duplicate open ops for one resource are coalesced to the newest pending/failed row (`SUPERSEDED`). D-021 and D-022 remain in force. |
| Reason | Physical Android drain logged HTTP 422 because outbox `body_json` was the full draft record (`id`, `job_id`, `version`, …), which `parseDraftPayload` rejects as unknown fields. Online save correctly sent `parsed.value` only. |
| Evidence | `apps/mobile/src/drafts/patch-body.ts`; `persist.ts`; `sync/outbox.ts`; `patch-body.test.ts` |
| Owner | Engineering lead |
| PRD implication | SYNC02/SYNC05 replay must be wire-compatible with API02 draft validation; do not weaken server validation. |
| Impacted requirement IDs | SYNC01, SYNC02, SYNC05, QUO01, API02, QA06 |
| Impacted test IDs | `apps/mobile/src/drafts/patch-body.test.ts` |
| Migration implications | Existing queued rich bodies are remapped on next drain; no DB schema change. |
| Reversible | Yes |
| Escalation category | architecture |

### D-022 — Successful /v1/me replaces stale offline_cached with generation-gated recovery

| Field | Value |
| --- | --- |
| ID | D-022 |
| Date | 2026-09-20 |
| Status | Resolved |
| Decision | Owner bootstrap uses a monotonic generation gate plus a single in-flight `/v1/me` promise. A successful authenticated `/v1/me` 200 always applies `authenticated`, refreshes `jti.auth.last_success_at`, persists `jti.auth.bootstrap`, clears the offline banner, opens the sync session, and attempts an eligible outbox drain. Failures may keep `offline_cached` only inside the ACC02 seven-day window. An older in-flight failure cannot apply after a newer success (`canApplyFailure` requires `generation === latestStarted && generation > latestApplied`). AppState `active` re-runs the same recovery for `offline_cached` and `authenticated` without signing out. D-021 manual Synchronize behavior is unchanged. |
| Reason | Physical Android: API logged `owner_me` 200 after relaunch while Jobs still showed offline_cached because a delayed/concurrent failure path could re-apply cached offline state, and foreground only drained the outbox without re-bootstrapping. |
| Evidence | `apps/mobile/src/session/recovery.ts`; `AuthProvider.tsx` `loadMe` / `recoverBootstrapIfNeeded`; `recovery.test.ts` |
| Owner | Engineering lead |
| PRD implication | ACC02 offline cache remains for failed recovery inside seven days; online authority returns on the next successful `/v1/me`. |
| Impacted requirement IDs | ACC02, S02, S05, S09, SYNC01, SYNC02, QA05, QA06 |
| Impacted test IDs | `apps/mobile/src/session/recovery.test.ts` |
| Migration implications | None |
| Reversible | Yes |
| Escalation category | architecture |

### D-024 — ACC02A action grants use JWT auth_time for fresh authentication

| Field | Value |
| --- | --- |
| ID | D-024 |
| Date | 2026-09-20 |
| Status | Resolved |
| Decision | `POST /v1/account/action-grants` requires a verified access JWT whose `auth_time` claim is within 300 seconds of server now. Ordinary refresh tokens without a recent `auth_time` are rejected with ACTION_GRANT_REQUIRED. Issued grants are 32-byte secrets, stored only as SHA-256 hashes in `identity.action_grants`, expire in five minutes, and are single-use. This slice issues and consumes `replace_link` only; export, deletion, and email_change remain deferred. APR03 requires token rotation on both owner resend and replace-link; worker retries of the same delivery attempt do not rotate. |
| Reason | ACC02A forbids treating refresh alone as fresh authentication; Supabase Auth exposes `auth_time` after OTP verification. |
| Evidence | `apps/api/src/action-grants.ts`; `apps/api/src/jwt.ts`; `apps/api/src/requests.ts`; `supabase/migrations/0012_owner_request_controls.sql`; `apps/api/src/requests.test.ts` |
| Owner | Engineering lead |
| PRD implication | Replace-link requires a fresh owner OTP before grant issuance. |
| Impacted requirement IDs | ACC02A, S12, APR03, QUO03, NTF04, EMAIL08, QA17, QA21 |
| Impacted test IDs | `apps/api/src/requests.test.ts` |
| Migration implications | `0012_owner_request_controls.sql` |
| Reversible | Yes for unused actions; replace_link path is production behavior |
| Escalation category | security |

### D-025 — Direct invoices use dedicated freeze/issue functions

| Field | Value |
| --- | --- |
| ID | D-025 |
| Date | 2026-09-22 |
| Status | Resolved |
| Decision | First-issue of a `mode=direct_invoice` job uses `open_direct_invoice_draft`, `save_direct_invoice_draft`, `freeze_direct_invoice_preview`, and `issue_direct_invoice` rather than extending quote-based `freeze_invoice_preview`/`issue_invoice`. Direct issue skips residual-scope matching, writes `scope_entries` for each issued line, consumes the first-job slot like TX01, and queues EMAIL06/`view_only` only when a customer email is present. Quote-based issue remains unchanged. Replacement after void reuses existing 0017 functions because they do not require quote mode. |
| Reason | Quote-based TX03 requires `mode=quote`, an accepted quote, and residual totals matching current scope. Direct invoices have no prior scope and optional customer email (VAL01). |
| Evidence | `supabase/migrations/0019_direct_invoice.sql`; `apps/api/src/invoices.direct.test.ts`; `apps/api/src/quotes.ts` preview dispatch; `apps/api/src/invoices.ts` issue dispatch |
| Owner | Engineering lead |
| PRD implication | JRN06/API04/QA44/TX03 direct-mode exception. |
| Impacted requirement IDs | JRN06, API04, QA44, TX03, BIL01, S08, S15, VAL01 |
| Impacted test IDs | `apps/api/src/invoices.direct.test.ts`; `packages/schemas/src/invoice.test.ts`; `packages/domain/src/invoice-html.test.ts`; `supabase/tests/0020_direct_invoice.sql` |
| Migration implications | `0019_direct_invoice.sql`; hosted confirmation `APPLY_0019` |
| Reversible | Additive functions only; quote issue path unchanged |
| Escalation category | architecture |

### D-025 — Direct invoices use dedicated freeze/issue functions

| Field | Value |
| --- | --- |
| ID | D-025 |
| Date | 2026-09-22 |
| Status | Resolved |
| Decision | First-issue of a `mode=direct_invoice` job uses `open_direct_invoice_draft`, `save_direct_invoice_draft`, `freeze_direct_invoice_preview`, and `issue_direct_invoice` rather than extending quote-based `freeze_invoice_preview`/`issue_invoice`. Direct issue skips residual-scope matching, writes `scope_entries` for each issued line, consumes the first-job slot like TX01, and queues EMAIL06/`view_only` only when a customer email is present. Quote-based issue remains unchanged. Replacement after void reuses existing 0017 functions because they do not require quote mode. |
| Reason | Quote-based TX03 requires `mode=quote`, an accepted quote, and residual totals matching current scope. Direct invoices have no prior scope and optional customer email (VAL01). |
| Evidence | `supabase/migrations/0019_direct_invoice.sql`; `apps/api/src/invoices.direct.test.ts`; `apps/api/src/quotes.ts` preview dispatch; `apps/api/src/invoices.ts` issue dispatch |
| Owner | Engineering lead |
| PRD implication | JRN06/API04/QA44/TX03 direct-mode exception. |
| Impacted requirement IDs | JRN06, API04, QA44, TX03, BIL01, S08, S15, VAL01 |
| Impacted test IDs | `apps/api/src/invoices.direct.test.ts`; `packages/schemas/src/invoice.test.ts`; `packages/domain/src/invoice-html.test.ts`; `supabase/tests/0020_direct_invoice.sql` |
| Migration implications | `0019_direct_invoice.sql`; hosted confirmation `APPLY_0019` |
| Reversible | Additive functions only; quote issue path unchanged |
| Escalation category | architecture |


### D-026 — Catalogue most-recently-used uses updated_at; GET /items/{id} is a member read

| Field | Value |
| --- | --- |
| ID | D-026 |
| Date | 2026-09-22 |
| Status | Resolved |
| Decision | CAT01 "most recently used" lists catalogue items by `updated_at desc, id desc` because the PRD `catalogue_items` table has no `last_used_at`. Copy-on-use is a client field copy into a new draft line and never stores a live catalogue FK. `GET /v1/items/{id}` is the member read for S20 edit; it is not a new command. Mutations are online-only and are not queued in SYNC01. QA15 in this slice covers catalogue price edits only; business-address updates remain S22. |
| Reason | The PRD API inventory lists GET/POST/PATCH/archive. A use endpoint would invent a route. `updated_at` already moves on create, edit, and restore. |
| Evidence | `supabase/migrations/0020_catalogue_items.sql`; `apps/api/src/items.ts`; `apps/mobile/src/items/form.ts` |
| Owner | Engineering lead |
| PRD implication | CAT01 / S20 / QA15 catalogue half. |
| Impacted requirement IDs | CAT01, S20, S10, QA15 |
| Impacted test IDs | `apps/api/src/items.test.ts`; `packages/schemas/src/item.test.ts`; `apps/mobile/src/items/form.test.ts`; `supabase/tests/0021_catalogue_items.sql` |
| Migration implications | `0020_catalogue_items.sql`; hosted confirmation `APPLY_0020` |
| Reversible | Additive table and functions |
| Escalation category | none |

### D-027 — JOB02 cancel notification and linked create

| Field | Value |
| --- | --- |
| ID | D-027 |
| Date | 2026-09-22 |
| Status | Resolved |
| Decision | Cancel of a job with a pending approval request withdraws those requests and queues EMAIL08 using the existing withdraw template. EMAIL01–11 define no accepted-job cancellation template, so cancel of an accepted job with no pending request does not send a new customer email. Owner UI states the PRD operational-notice disclaimer. Linked new jobs reuse `POST /v1/jobs` with optional `related_job_id` that must reference a canceled job in the same workspace. Cancel and delete are online-only and are not queued in SYNC01. Cancel reason is audited as `reason_len` only. |
| Reason | Inventing EMAIL12 or a new create-linked route would exceed the PRD inventory. `related_job_id` already exists on `jobs`. Withdraw already defines EMAIL08. |
| Evidence | `supabase/migrations/0021_job_cancel_delete.sql`; `apps/api/src/jobs.ts`; `apps/mobile/app/(tabs)/jobs/[id]/index.tsx` |
| Owner | Engineering lead |
| PRD implication | JOB02 / S08 cancel, delete, and linked create. |
| Impacted requirement IDs | JOB02, JOB01, S08, EMAIL08 |
| Impacted test IDs | `apps/api/src/jobs.test.ts`; `apps/api/src/jobs.lifecycle.test.ts`; `packages/schemas/src/job.test.ts`; `apps/mobile/src/jobs/form.test.ts`; `supabase/tests/0022_job_cancel_delete.sql` |
| Migration implications | `0021_job_cancel_delete.sql`; hosted confirmation `APPLY_0021` |
| Reversible | Additive functions and optional create field |
| Escalation category | none |

### D-028 — JOB01 finish is invoiced-only; archive is visibility-only

| Field | Value |
| --- | --- |
| ID | D-028 |
| Date | 2026-09-22 |
| Status | Resolved |
| Decision | `POST /v1/jobs/{id}/finish` is allowed only from `lifecycle=invoiced` when the active issued invoice has derived ledger balance zero (payments, issued credits, mixed, or a zero-total invoice). Canceled jobs are not finished; JOB02 already forbids reopen, and a canceled receivable stays canceled until archived. `POST /v1/jobs/{id}/archive` with `{ archived: boolean }` archives any non-draft state when no `purpose=approval` request is pending, stores `archived_from_state`, and restores that state. Archive does not withdraw requests, change invoices, or emit email. No analytics events exist for archive or finish. Both commands are online-only and are not queued in SYNC01. Hosted confirmation remains `APPLY_0021` because repository/workflow history still targets `0021_job_cancel_delete.sql`; `0022` is local-only until 0021 is applied. |
| Reason | JOB01 defines finish as a settlement/credit close of the working view and archive as visibility with `archived_from_state`. Inventing unfinish, finish-from-canceled, EMAIL12, or analytics events would exceed the PRD. |
| Evidence | `supabase/migrations/0022_job_archive_finish.sql`; `apps/api/src/jobs.ts`; `apps/mobile/app/(tabs)/jobs/[id]/index.tsx` |
| Owner | Engineering lead |
| PRD implication | JOB01 leftover archive/restore/finish on S08. |
| Impacted requirement IDs | JOB01, S05, S08 |
| Impacted test IDs | `apps/api/src/jobs.lifecycle.test.ts`; `packages/schemas/src/job.test.ts`; `apps/mobile/src/jobs/form.test.ts`; `supabase/tests/0023_job_archive_finish.sql` |
| Migration implications | `0022_job_archive_finish.sql`. Do not modify 0001–0021. Do not change hosted confirmation from `APPLY_0021` until 0021 is applied. |
| Reversible | Additive functions only |
| Escalation category | none |

### D-029 — App-managed trial is once-only and independent of StoreKit

| Field | Value |
| --- | --- |
| ID | D-029 |
| Date | 2026-09-23 |
| Status | Resolved |
| Decision | `POST /v1/subscription/trial` starts the 14-day app-managed trial only after `{ acknowledged: true }`, once per workspace, using server UTC. While the trial is active, first publication consumes a trial slot and leaves unused free slots for after expiry. EMAIL09 is queued at start with `available_at = trial_ends_at - 2 days`. StoreKit prices, RevenueCat purchase, restore, and reconcile are not implemented in this slice because product IDs remain provisional and credentials are empty. Hosted confirmation stays `APPLY_0022`; `0023` is local-only until 0022 is applied. |
| Reason | SUB03 is explicit, app-managed, and unblocked. Implementing paid IAP here would hard-code provisional identifiers and invent store configuration. |
| Evidence | `supabase/migrations/0023_app_managed_trial.sql`; `apps/api/src/subscription.ts`; `apps/mobile/app/(tabs)/settings/subscription.tsx` |
| Owner | Engineering lead |
| PRD implication | SUB03, SUB02 trial marking, EMAIL09, S21 trial half, QA11/QA12. |
| Impacted requirement IDs | SUB03, SUB02, S21, EMAIL09, INV09, QA11, QA12 |
| Impacted test IDs | `apps/api/src/subscription.test.ts`; `packages/schemas/src/subscription.test.ts`; `apps/mobile/src/subscription/presentation.test.ts`; `supabase/tests/0024_app_managed_trial.sql` |
| Migration implications | `0023_app_managed_trial.sql`. Do not modify 0001–0022. Do not change hosted confirmation from `APPLY_0022` until 0022 is applied. |
| Reversible | Additive functions, indexes, and CREATE OR REPLACE of live publish slot allocation |
| Escalation category | none |

### D-030 — Owner export is the first Stage 4 K half

| Field | Value |
| --- | --- |
| ID | D-030 |
| Date | 2026-09-23 |
| Status | Resolved |
| Decision | After hosted 0023, the next unblocked customer-visible slice is owner export (`POST /v1/exports`, S24 export, EMAIL10), not paid IAP and not account deletion. Paid purchase remains blocked on empty RevenueCat credentials and provisional product IDs. Deletion (PRV03–PRV06, EMAIL11) is a separate later K half. Customers remain teammate-owned; export reads `customers` only through SQL. ZIP is STORE-format without a third-party library. Single numbered part plus MANIFEST covers EXP02 split/checksum until a size threshold is proven. |
| Reason | Implementation Plan order after remaining J is blocked. EXP01/EXP02 and EMAIL10 are unblocked and independently shippable. |
| Evidence | `supabase/migrations/0024_owner_export.sql`; `apps/api/src/exports.ts`; `apps/mobile/app/(tabs)/settings/data.tsx`; `apps/worker/src/export.ts` |
| Owner | Engineering lead |
| PRD implication | EXP01, EXP02, EMAIL10, S24 export, QA55, QA56, ANA01 `export_completed`. |
| Impacted requirement IDs | EXP01, EXP02, EMAIL10, S24, ACC02A, ANA01, QA55, QA56 |
| Impacted test IDs | `apps/api/src/exports.test.ts`; `apps/worker/src/export-bundle.test.ts`; `apps/worker/src/email.test.ts`; `packages/schemas/src/export.test.ts`; `supabase/tests/0025_owner_export.sql` |
| Migration implications | `0024_owner_export.sql`. Do not modify 0001–0023. Hosted confirmation is `APPLY_0024`. |
| Reversible | Additive table, functions, and artifact FK |
| Escalation category | none |
