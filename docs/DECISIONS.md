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
| Decision | Pin the repository foundation to Node 22.23.2, pnpm 12.4.1, TypeScript 5.9.3, Expo 57.0.22, React Native 0.86.3, React 19.2.3, Next.js 16.3.5, Fastify 5.12.4, Turbo 2.10.12, Zod 4.6.5, Vitest 5.0.0, ESLint 10.10.0, and Prettier 3.9.6, with exact versions in `pnpm-lock.yaml`. Encrypted SQLite and the PDF engine remain unchosen until spike evidence. Plaintext local storage remains forbidden. |
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
| Decision | Put `app_users` and `action_grants` in schema `identity`. Put tenant tables in schema `commercial`. Give `migrator` `BYPASSRLS` and object ownership so `FORCE ROW LEVEL SECURITY` does not block migrations. Runtime roles `api_app`, `worker_app`, and `purge_app` stay `NOBYPASSRLS`, nologin, and non-superuser. Create `assets` in this slice only so `workspaces.logo_asset_id` can use a composite tenant FK; defer `job_id`/`draft_id` FKs until jobs and drafts exist. Local `pnpm migrate:clean` / `pnpm test:db` start embedded PostgreSQL 16 when `DATABASE_URL_MIGRATIONS` is unset. |
| Reason | ACC02A requires a restricted identity schema. ARC02 requires FORCE RLS and a non-bypass API role. Root `workspace_id` FKs cannot be two copies of the same column. The logo FK is the first non-root composite tenant FK and unblocks isolation tests without jobs, quotes, approvals, or invoices. |
| Evidence | `supabase/migrations/0001_foundation.sql`, `0002_identity_tenancy.sql`, `scripts/db-test.mjs` |
| Owner | Engineering lead |
| PRD implication | Authorization still comes from verified identity plus `SET LOCAL`. Workspace IDs in routes/bodies remain non-authoritative. Jobs/quotes/approvals/invoices remain later migrations. |
| Impacted requirement IDs | ARC02, ARC03, AUTHZ01, ACC02A, DB01, DEC04, SREF07 |
| Impacted test IDs | QA03; isolation suite pool-leak and role tests |
| Migration implications | Additive. `assets.job_id` / `draft_id` FKs must be added when those tables ship. |
| Reversible | No for schema split and FORCE RLS; logo table timing only |
| Escalation category | architecture |
