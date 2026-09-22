> Source of product truth: `docs/PRD.md` Version 1.0
> Process: `docs/SOP.md` §13 (decomposition) and §19 (vertical slices)
> Authority: PRD MUST requirements and §30 gates prevail over the SOP 2–3 day timetable (D-001)

# Implementation plan

This plan converts the approved Job to Invoice PRD into buildable vertical slices. It does not reduce scope, invent a smaller MVP, or substitute generic factory defaults for PRD architecture.

## Feasibility

SOP §17 would classify this product as AMBER/RED against a 2–3 day clock: encrypted offline drafts, hashed immutable documents, approval races, financial corrections, outbox delivery, and Apple subscription reconciliation are all in v1.

The PRD planning range is **10 to 14 calendar weeks for two experienced engineers** with part-time design, QA and product oversight, after Stage 0 spikes. That range is a planning estimate, not a bid. This plan uses PRD Stages 0–6. It does not use the SOP 3-day timetable.

Scope cuts, if later required, may defer secondary UI polish or a platform. They must not cut immutable money, approval evidence, tenant isolation, or completion rights.

## Slice rule

Every slice is vertical. A slice is not done when a screen renders.

Each slice includes, where applicable:

- UI for the named screens
- `packages/domain` calculations and state contracts
- Fastify command + OpenAPI
- PostgreSQL persistence, RLS and indexes
- worker/outbox effects
- authorization
- loading, empty, error, offline and access-expired states
- analytics
- accessibility
- automated tests mapped to QA IDs

Do not implement all screens, then the backend, then connect them.

## Journey-to-stage map

| Journey | Name | Primary stage | Screens |
| --- | --- | --- | --- |
| JRN01 | First useful job | Stage 2 (setup in 1) | S01–S11 |
| JRN02 | Customer approval | Stage 2 | S25–S27 |
| JRN03 | Additional work | Stage 3 | S13, S12, S25–S27 |
| JRN04 | Reduced scope | Stage 3 | S14, S12, S25–S27 |
| JRN05 | Invoice and money | Stage 3 | S15–S18 |
| JRN06 | Direct invoice | Stage 3 | S06, S09–S10, S15–S16 |
| JRN07 | Interrupted work | Stage 1 (used in 2–3) | S09, S11, S23 |

## Stage 0 — Foundation and risk spikes

**Goal:** Prove the four release-blocking technical risks on a real iPhone before storing production-shaped records.

**Work (vertical spikes, not product features):**

1. Validate the intended owner/customer workflow with real operators while implementing (PRD §01). Do not change accounting or authorization because of interview preference.
2. Encrypted per-owner local persistence (SYNC01, SREF08). Confirm SQLCipher or another supported encrypted module in the selected Expo development build, plus OS backup exclusion. Plaintext fallback is forbidden.
3. Supabase Auth email OTP: six-digit code, ten-minute expiry, 60-second resend, five failures; no account enumeration (ACC01). Verify actual SDK limits in staging.
4. RevenueCat initialized with stable owner UUID; restore/transfer behaviour tested with two app accounts and one Apple account (SUB06, SREF04).
5. Server-rendered HTML-to-PDF on a real device-sized document (DOC01). Prove HEIC conversion path (DOC03).
6. Pin current stable versions into `docs/DEPENDENCY_MATRIX.md` (ARC05, §34). Do not invent patch numbers in this document.

**Apps touched:** throwaway spike code may exist locally; no production schema until Stage 1 migrations.

**Exit evidence:** written spike results, sandbox screenshots, architecture decisions for storage/PDF engines, testable risk resolution. No publication path.

**Tests:** spike notes only. QA01–QA08 are Stage 1.

## Stage 1 — Identity and drafts

**Goal:** An owner can authenticate, create a workspace, manage customers and catalogue items, create draft jobs, save locally, and recover conflicts. **No document publication.**

**Vertical slice A — Sign-in and workspace**

- Screens: S01–S04
- Domain: workspace + memberships + allowances
- API: `GET /me`, `POST /workspace`, Auth OTP
- DB: `app_users`, `workspaces`, `memberships`, `job_allowances`
- States: generic code-sent, throttle, network failure, expired/incorrect code
- Analytics: `signup_verified`, `onboarding_completed`
- Tests: QA01, QA02

**Vertical slice B — Customers, items, jobs**

- Screens: S05–S08, S19, S20
- API: customer/item/job CRUD, archive, draft-only delete
- DB: `customers`, `catalogue_items`, `jobs`, `document_drafts`
- Seed five zero-price catalogue examples (CAT01)
- Tests: customer duplicate warning, archive vs delete, isolation QA03–QA04

**Vertical slice C — Local persistence and conflict**

- Screens: S09 (draft save indicators), S23
- Domain: version integers, `operation_id`
- API: `PATCH` with If-Match
- Local: encrypted SQLite, 500 ms debounce, Saved on this device
- Offline contract: SYNC02–SYNC06 — no last-write-wins; pause queue on 409 and keep both copies; never auto-issue publish/approve/invoice/ledger/deletion/purchase from the draft queue; wipe local DB on account switch after unsynced confirmation
- Tests: QA05–QA08; timeout then queue drain must not publish

**Do not** implement publish, portal, invoice, or paywall in this stage.

**Exit evidence:** QA01–QA08 and the tenant isolation suite. Persistence works.

## Stage 2 — Quotes and approvals

**Goal:** JRN01 and JRN02 work end-to-end: publish a frozen quote, deliver EMAIL01, customer verifies and approves the exact revision.

**Vertical slice D — Preview, hash, publish**

- Screens: S09–S12
- Domain: FIN01 preview, QUO02A canonical bytes, INV03 digest
- API: `POST /drafts/{id}/preview`, `POST /drafts/{id}/publish`
- TX: TX01
- DB: `documents`, `document_lines`, `document_counters`, `approval_requests`, `outbox_tasks`
- Entitlement: consume one job slot in the same TX01 transaction or return ENTITLEMENT_REQUIRED; set `completion_right` write-once. No compile-time or env stub in staging, TestFlight or production. `APP_ENV=development` may seed fixture allowances; it must still run the command.
- Copy: NTF05 offline publish
- Analytics: `document_published`
- Tests: QA09, QA10 (three publishes then ENTITLEMENT_REQUIRED against real `job_allowances`; RevenueCat not required), QA14, QA15

**Vertical slice E — Customer portal**

- Screens: S25–S27
- API: `/portal/exchange`, `/portal/code/*`, `/portal/document`, `/portal/decision`, `/portal/receipt`, `/portal/download`
- TX: TX02
- Security: fragment token, CSRF, APR01–APR08
- Email: EMAIL03, EMAIL04, EMAIL05
- Analytics: `approval_completed`, `request_delivery_result`
- Tests: QA16–QA26

**Vertical slice F — Request lifecycle**

- Screens: S12
- API: resend, withdraw, `POST /account/action-grants`, replace-link with `X-Action-Grant`
- DB: `action_grants` (required in Stage 2, not deferred to Stage 4)
- Email: EMAIL08; href exactly `{PORTAL_ORIGIN}/review#{token}`
- Tests: QA17, NTF04 resend bounds; Bearer without grant → 403; grant replay / wrong action → 403

**Exit evidence:** full owner/customer quote journey; race tests QA16–QA26; QA10 slot gate on real allowances.

## Stage 3 — Changes and invoicing

**Goal:** JRN03–JRN06. Approved extras stay on the invoice. Ledger math matches F01–F12 on mobile, server and PDF.

**Vertical slice G — Extra work and reductions**

- Screens: S13, S14
- Domain: CHG01–CHG05, FIN03
- API: `POST /jobs/{id}/changes`, publish
- Email: EMAIL02
- Analytics: `change_started`
- Tests: QA27–QA29, F04–F06, F12

**Vertical slice H — Invoice issue**

- Screens: S15, S16
- TX: TX03
- API: invoice-preview, issue-invoice, void, replacement
- Worker: original PDF, then EMAIL06
- Analytics: `invoice_issued`
- Tests: QA31–QA36, QA44, F12
- JRN06 direct invoice: implemented in `0019_direct_invoice.sql` / S15; hosted APPLY_0019 and device evidence remain open

**Vertical slice I — Credits, payments, refunds**

- Screens: S16–S18
- Domain: FIN04–FIN05, BIL04–BIL08
- TX: TX04
- API: credits, payments, refunds, reverse
- Copy: NTF05 ledger warning
- Email: EMAIL07
- Analytics: `payment_recorded` (no amount or reference)
- Tests: QA37–QA43, F07–F11

**Exit evidence:** all money fixtures plus invoice/ledger QA. No mutable accepted totals.

## Stage 4 — Billing and lifecycle

**Goal:** Free/trial/Pro, completion rights, export, deletion, support case intake.

**Vertical slice J — Entitlement**

- Screen: S21
- Domain: INV09, SUB01–SUB08
- API: trial, subscription, reconcile, RevenueCat webhook
- TX: TX05
- Email: EMAIL09
- Analytics: `trial_started`, `paywall_viewed`, `purchase_verified`, `subscription_expired`
- Tests: QA11–QA13, QA45–QA51 (QA10 already required at Stage 2; Stage 4 adds store/trial). Entitlement jobs must not write `completion_right`.

**Vertical slice K — Export and deletion**

- Screens: S22, S24
- API: exports and account deletion using Stage 2 `action_grants` + `X-Action-Grant`
- DB: `exports`, `deletion_requests`
- Email: EMAIL10, EMAIL11
- Analytics: `export_completed`
- Tests: QA56–QA58

**Vertical slice L — Support intake**

- Screens: S22 (owner), S28 (staff, may start metadata-only)
- API: `POST /support/cases`, admin routes
- Tests: QA59–QA60

**Exit evidence:** sandbox billing/restore and deletion tests; account/receipt mapping documented.

## Stage 5 — Hardening and pilot

**Goal:** No critical/high defects. Evidence for SEC, NFR, OPS, accessibility.

**Work:** security review (SEC07), VoiceOver/Dynamic Type/keyboard/zoom (QA61, NFR01), load (QA67, NFR03), backup restore drill (QA66, OPS06), rate limits actually configured (SEC02), 15–25 invitation-only TestFlight pilots (REL03).

**Exit evidence:** no critical/high defects, end-to-end evidence, actual pilot feedback.

## Stage 6 — Production release

**Goal:** §32 checklist signed. §34 owner inputs complete. Store package. Monitoring and on-call staffed.

**Work:** production configuration (empty secrets fail start), privacy/terms without placeholders, TestFlight then limited public release, owner-controlled repository and credentials (DEL01, DEL05).

**Exit evidence:** [docs/RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) complete.

## Definition of slice done

A slice is done only when DEL04 is satisfied: domain tests, authorization checks, loading/empty/offline/error states, accessibility labels, required analytics, structured logs, migration compatibility, and documentation. Interactive mocks are not done.

## Parallelization

Independent after Stage 0: design frames S01–S28 (DEL03) may proceed in parallel with Stage 1 persistence. Do not parallelize two agents on navigation, auth, or money.

Staff console depth beyond metadata-only can trail Stage 4 if S28 MFA, grant expiry and audit land before pilot content access.

## What this plan does not do

- It does not schedule a 2-3 day ship.
- It does not add Android operator-app store QA as a v1 product gate (DEC01, D-001).
- It does not add PostHog or a tracking SDK (DEC12).
- It does not invent legal identity, trademark, or store credentials (§34).
