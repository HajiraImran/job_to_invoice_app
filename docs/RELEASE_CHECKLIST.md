> Source: `docs/PRD.md` §§30–34, OPS02, REL01–REL03
> Android operator production build is not a v1 product checkbox (D-001). iPhone TestFlight and physical iPhone QA are required.

# Release checklist

All items start unchecked. A checked item requires evidence, not a claim.

## Stage 0 — Foundation and risk spikes

- [ ] Encrypted local persistence proven on a real iPhone; plaintext rejected (SYNC01)
- [ ] Supabase OTP behaviour verified in staging (ACC01)
- [ ] RevenueCat identity/restore mapping tested with two app accounts, one Apple account (SUB06)
- [ ] HTML-to-PDF and HEIC path proven (DOC01, DOC03)
- [ ] Dependency versions pinned in DEPENDENCY_MATRIX.md (ARC05)
- [ ] Written spike results recorded

## Stage 1 — Identity and drafts

- [ ] QA01–QA08 pass
- [ ] Tenant isolation suite pass (QA03, QA04)
- [ ] No publication path enabled

## Stage 2 — Quotes and approvals

- [ ] JRN01 and JRN02 work end-to-end
- [ ] QA10 slot gate against real `job_allowances` (no stub)
- [ ] QA16–QA26 pass, including approval races
- [ ] `POST /account/action-grants` + replace-link grant tests
- [ ] EMAIL01/03/04/05/08 sending in staging allowlist; href uses `#token` only

## Stage 3 — Changes and invoicing

- [ ] F01–F12 match on mobile, server and PDF (QA30)
- [ ] Invoice/ledger QA31–QA44 pass
- [ ] No mutable accepted totals (QA26)

## Stage 4 — Billing and lifecycle

- [ ] QA11–QA13, QA45–QA51 sandbox billing (QA10 already a Stage 2 gate)
- [ ] QA56–QA57 export and deletion
- [ ] Account/receipt mapping documented

## Stage 5 — Hardening and pilot

- [ ] Security review of approvals/billing/tenant boundaries (SEC07)
- [ ] No open severity 1/2 or exploitable high/critical findings
- [ ] QA61 accessibility
- [ ] QA66 restore drill on a **new** instance; deletion ledger first; restored email tasks `dead` until human replay; RPO 15m / RTO 4h measured (OPS06, NFR04)
- [ ] QA67 load targets measured
- [ ] 15–25 invitation-only TestFlight pilots (REL03)

## Stage 6 — PRD §32 release acceptance

- [ ] Every MUST mapped to an implemented ticket and passing test/evidence
- [ ] All 68 QA scenarios executed; financial, isolation and approval concurrency automated
- [ ] No open severity 1/2 defects or exploitable high/critical security findings
- [ ] Production configuration complete; legal/support pages contain no placeholders
- [ ] Apple sandbox purchase, renewal, grace, cancellation, refund, restore and account-mismatch demonstrated
- [ ] Free/trial counters and completion rights verified across reinstalls and two devices
- [ ] PDF/receipt checked at supported maximum sizes; all money fixtures match
- [ ] Privacy deletion, export and backup restoration drills completed with recorded evidence
- [ ] Actual rate limits, object retention and backup plans configured, not merely described
- [ ] Support console permissions and on-call coverage verified; incident drills rehearsed
- [ ] Named on-call channel staffed; OPS04 Sev-1 pages reach a person, not only a dashboard
- [ ] Current store policy and third-party licences reviewed; no unsupported marketing promises
- [ ] Owner receives repository, infrastructure/store ownership and secure credential inventory

## CI gates (OPS02)

- [ ] Lint and types
- [ ] Domain/financial tests
- [ ] API contract validation
- [ ] Migrations on a clean database
- [ ] Tenant isolation tests, including pool-leak, role DSNs, and composite FKs
- [ ] Dependency and secret scans (`service_role` banned in app config)
- [ ] Worker idempotency / `effect_key` tests
- [ ] Financial idempotency permanence (post-expiry replay)
- [ ] Signed mobile build smoke test
- [ ] Staging E2E on every release candidate
- [ ] FEATURE_NEW_PUBLICATION and FEATURE_PURCHASES flags ready

## Owner-supplied production inputs (§34)

- [ ] Final name and trademark review
- [ ] Contracting legal entity and address on terms/privacy/store
- [ ] Owner-controlled App Store account before production signing
- [ ] Owned verified domain and monitored support mailbox
- [ ] Counsel-reviewed commercial terms and approval wording
- [ ] Privacy notice and restricted-retention categories (no blanket invoice exemption)
- [ ] Production vendor accounts and payment method
- [ ] Named support and on-call contacts actually staffed
- [ ] Final selected dependency matrix recorded
- [ ] Pricing confirmation or recorded product decision (USD 19.99 / 149.99 remain hypotheses until then)

## iOS distribution (REL01–REL02)

- [ ] Current required Apple SDK/toolchain
- [ ] Privacy labels and required-reason declarations
- [ ] Bundle ID, signing, subscription group/products
- [ ] Privacy, terms, support URLs
- [ ] Screenshots from the production-equivalent build
- [ ] Review notes: 14-day trial never auto-charges; customer approval is a separate web flow
- [ ] Controlled demo or review identity with test inboxes; no global auth bypass
- [ ] TestFlight build installable without Cursor or source

## Explicitly not v1 product blockers

- Android operator Play/App Store listing
- PostHog
- Native push
- Card payment collection
