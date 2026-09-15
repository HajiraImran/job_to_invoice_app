> Source: `docs/PRD.md` Version 1.0. Statuses: PENDING until tested implementation is VERIFIED.
> Columns required by the Stage 13 brief. IDs are PRD IDs, not generic R-001.

# Requirements matrix

Only **VERIFIED** counts as complete. Every row starts **PENDING**. Do not mark VERIFIED because a screen, function, comment or mocked test exists.

SREF01–SREF08 are normative references for implementation, not skippable product features. They appear in Notes.

| ID | Exact requirement summary | Application or package | Screen or flow | Backend component | Database entity | Analytics event | Test ID or evidence | Dependencies | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DEC01 | iPhone first; iOS 17+ unless raised and documented; Apple SDK overrides | apps/mobile | All owner screens | EAS iOS | — | — | NFR02 device matrix | REL01 | PENDING | Android operator app deferred |
| DEC02 | Customer browser portal; no customer app or account | apps/portal | S25–S27 | Portal routes | approval_requests purpose | — | QA18 | APR01 | PENDING | |
| DEC03 | US English USD; US business address; browsers may be elsewhere | all | S04 VAL02 | — | workspaces.currency USD | — | packages/schemas/src/workspace-setup.test.ts; pnpm test:db currency | — | IMPLEMENTED | USD locked; US address + IANA TZ. Device locale QA unverified |
| DEC04 | One owner, one workspace; two iPhones OK; no staff seats or transfer | apps/mobile apps/api | S04 | memberships | memberships | — | pnpm test:db duplicate provisioning + setup complete (2026-09-14) | ACC03 | IMPLEMENTED | Unique owner + one workspace enforced; S04 completes that row. Two-device unverified |
| DEC05 | Record external payments only; no card collection | apps/mobile apps/api | S17 | payments/refunds | ledger_entries | payment_recorded | QA37 | BIL05 | PENDING | |
| DEC06 | 3 free jobs; optional 14-day app trial; monthly/annual Apple subs | apps/mobile apps/api | S21 | entitlements | job_allowances entitlement_snapshots | trial_started purchase_verified | QA10 QA45 | SUB01–SUB03 | PENDING | |
| DEC07 | Email code then explicit approval of immutable revision; no notarization claim | apps/portal | S26 | TX02 | approval_decisions | approval_completed | QA24 | APR04 | PENDING | |
| DEC08 | One approved quote; sequential extras; one active final invoice | apps/api | S08 S16 | TX01 TX03 | documents jobs.active_invoice_id | — | QA43 | BIL02 | PENDING | |
| DEC09 | Operator-selected tax-exclusive rate; no tax advice | packages/domain | S10 S04 | FIN01 | document_lines.tax_bp | — | F01 | FIN02 | PENDING | |
| DEC10 | Offline draft/cache; live commands need connectivity | apps/mobile | S09 S11 | SYNC05 | local SQLite | — | QA05 QA06 | SYNC01 | PENDING | |
| DEC11 | No custom AI, autonomous pricing, image interpretation or generative terms | all | — | — | — | — | Review | — | PENDING | Keyboard dictation OK |
| DEC12 | No tracking SDK or IDFA; first-party funnel only | apps/api | — | analytics_events | analytics_events | ANA01 | QA63 | ANA03 | PENDING | D-001 |
| DEC13 | In-app support and monitored public address; no 24h claim unless staffed | apps/mobile apps/admin | S22 S28 | support_cases | support_cases | support_opened | QA59 | SEC05 | PENDING | §34 staffing |
| DEC14 | Pre-invoice reduction order; post-invoice credit note; no edit of approvals | apps/mobile | S14 S18 | TX02 TX04 | scope_entries documents | — | QA27 QA38 | CHG BIL04 | PENDING | |
| MET01 | Activation: real publish in 7 days; ≥35% hypothesis | analytics | JRN01 | reports | analytics_events | document_published | Cohort job | ANA02 | PENDING | Must not change auth |
| MET02 | Approved change in 30 days among approved-quote owners | analytics | JRN03 | reports | analytics_events | approval_completed | Cohort job | — | PENDING | Do not force changes |
| MET03 | Repeat distinct real job in 30 days; pilot ≥50% | analytics | JRN01 | reports | analytics_events | document_published | Cohort job | — | PENDING | |
| MET04 | Median invoice preview→issue <2 min excluding idle >30s | apps/mobile | S15 | — | — | invoice_issued | Timing buckets | — | PENDING | |
| MET05 | Zero lost commits/dup financials/cross-tenant; crash-free ≥99.5% | all | — | Sentry | audit_events | — | QA03 MET05 | OPS03 | PENDING | |
| MET06 | Paying owner = verified sub, first txn not refunded; after trial | apps/api | S21 | TX05 | entitlement_snapshots | purchase_verified | QA45 | SUB07 | PENDING | |
| MET07 | CAC = media / non-refunded new paying; unknown separate; $40–50 hypothesis | ops | — | spend import | — | — | Report | ANA03 | PENDING | Business hypothesis |
| MET08 | Monthly renewal by cohort; weekly activity; annual buy ≠ annual retention | analytics | S21 | reports | entitlement_snapshots | purchase_verified | Cohort job | — | PENDING | |
| AUTHZ01 | Auth from verified identity; workspace ID not auth; cross-tenant 404; portal ≠ owner; staff MFA | apps/api | all | JWT + RLS | memberships staff_users | — | QA03; pnpm test:db; apps/api/src/workspace.test.ts injection 422 | ARC02 | IMPLEMENTED | Owner JWT + provision + setup identity-only mutation. Portal/staff still pending |
| INV01 | Integer cents; qty 3-decimal string; no binary float; server authoritative; shared package | packages/domain | S10 S11 | calculate | document_lines | — | packages/domain fixtures.test.ts F01–F12; 40 passing domain tests | FIN01 | VERIFIED | Shared BigInt engine; mobile/API/PDF must import this package |
| INV01 | Integer cents; qty 3-decimal string; no binary float; server authoritative; shared package | packages/domain | S10 S11 | calculate | document_lines | — | packages/domain fixtures.test.ts F01–F12; 40 passing domain tests | FIN01 | VERIFIED | Shared BigInt engine; mobile/API/PDF must import this package |
| INV02 | Accepted commercial facts immutable; corrections via new version/reversal/credit | apps/api | S08 | triggers | documents ledger_entries | — | QA26 | DB04 | PENDING | |
| INV03 | Canonical snapshot SHA-256; separate PDF digest; integrity not legal ID | packages/domain apps/worker | S11 S26 | hash | documents.snapshot_sha256 artifacts | packages/domain/src/snapshot.test.ts; apps/api/src/quotes.test.ts | QA24 QA30 | QUO02A | IMPLEMENTED | Preview/publish store SHA-256 of canonical commercial bytes. PDF digest later. Not VERIFIED on device |
| INV04 | At most one pending approval per job; lock; one terminal winner | apps/api | S12 | TX01 TX02 | approval_requests | — | QA16 QA20 | DB03 | PENDING | |
| INV05 | Additions/reductions update scope atomically; invoice locks scope | apps/api | S13 S15 | TX02 TX03 | scope_entries jobs.scope_version | — | QA31 QA32 | CHG | PENDING | |
| INV06 | Unique monotonic numbers; never reuse after void | apps/api | S11 S15 | counters | document_counters | apps/api/src/quotes.test.ts Q-000001..Q-000003 | QA09 QA43 | QUO02 | IMPLEMENTED | Quote counters allocate Q-00000N R1 uniquely per workspace. Void reuse later. Not hosted-verified |
| INV07 | Payment status derived; Mark paid is an entry flow | apps/api | S16 S17 | TX04 | ledger_entries | payment_recorded | QA37 | BIL08 | PENDING | |
| INV08 | Archive hides; expiry keeps access/completion; deletion separate | apps/mobile | S05 S21 S24 | — | jobs.archived_at | — | QA13 | SUB05 PRV | PENDING | |
| INV09 | Published job counts once; retries/changes do not; delete does not replenish | apps/api | S11 S21 | TX01 | job_allowances | document_published | apps/api/src/quotes.test.ts fourth publish ENTITLEMENT_REQUIRED | QA10 QA11 | SUB02 | IMPLEMENTED | First quote publish consumes one free slot; retries and failed fourth job leave draft. Trial/Pro later. Not hosted-verified |
| INV10 | Server UTC authoritative; display workspace TZ; date-only no UTC midnight | packages/domain packages/schemas | S04 S11 S15 | — | workspaces.timezone | — | packages/schemas/src/workspace-setup.test.ts NY/LA DST | QUO01 | IMPLEMENTED | IANA store + date-only helper tests. Quote/invoice display still later |
| JRN01 | First useful job: setup, quote, publish, delivery indicator | apps/mobile | S01–S11 | TX01 | documents | document_published | apps/api/src/quotes.test.ts; apps/mobile/src/quotes/form.test.ts | Stage 2 | IMPLEMENTED | Setup through published quote locally. Delivery indicator, email, and device QA not in this slice. Not VERIFIED on device |
| JRN02 | Customer verifies and approves exact revision; refresh cannot re-approve | apps/portal | S25–S27 | TX02 | approval_decisions | approval_completed | QA20 QA24 | Stage 2 | PENDING | |
| JRN03 | Extra work; old/change/new totals; original quote unchanged | apps/mobile apps/portal | S13 S26 | TX02 | scope_entries | change_started | QA27 | Stage 3 | PENDING | |
| JRN04 | Reduction on source line; tax auto; cannot go below zero | apps/mobile apps/portal | S14 S26 | FIN03 | document_lines | change_started | QA28 F05 | Stage 3 | PENDING | |
| JRN05 | Invoice after resolving changes; record money/credit/refund | apps/mobile | S15–S18 | TX03 TX04 | documents ledger_entries | invoice_issued | QA31 QA37 | Stage 3 | PENDING | |
| JRN06 | Direct invoice; no approval; no later pre-invoice changes; labelled | apps/mobile | S06 S15 | API04 | jobs mode | invoice_issued | QA44 | Stage 3 | PENDING | |
| JRN07 | Offline draft; Saved after persist; conflict compare; no silent overwrite | apps/mobile | S09 S23 | If-Match | document_drafts | sync_conflict | QA05 QA07 | Stage 1 | PENDING | |
| UI01 | SF type scale, 8pt grid, colors, Dynamic Type, a11y contrast | apps/mobile | all | — | — | — | QA61 | NFR01 | PENDING | |
| UI02 | 48pt buttons, 44pt targets, keyboards, safe area, SR focus | apps/mobile | forms | — | — | — | QA61 | — | PENDING | |
| UI03 | Light only; portal 720/320/200% | apps/mobile apps/portal | all | — | — | — | QA61 | — | PENDING | |
| UI04 | Loading empty loaded refresh-fail offline access-expired | all apps | all data screens | — | — | — | Screen QA | SCREEN_MAP | PENDING | |
| S01 | Welcome; no paywall; demo cannot send | apps/mobile | S01 | — | — | — | apps/mobile/app/(public)/welcome.tsx; physical Expo Go 2026-09-15 | JRN01 | IMPLEMENTED | Physical Expo Go session used Welcome → Sign in with no paywall. Demo send and production/native signing unverified |
| S02 | Email sign in; generic sent; throttle | apps/mobile | S02 | Auth | — | — | packages/schemas/src/index.test.ts; apps/mobile/src/auth/auth.test.ts; physical Expo Go OTP 2026-09-15 | ACC01 | IMPLEMENTED | UI + validation + non-enumerating send. Physical Expo Go OTP send succeeded. Dashboard throttle caps and production signing unverified |
| S03 | Verify code; paste/autofill; limits | apps/mobile | S03 | Auth | — | signup_verified | apps/mobile/src/auth/auth.test.ts; apps/mobile/src/session/bootstrap.test.ts; physical Expo Go 2026-09-15 jwt_verified + /v1/me 200 | ACC01 | IMPLEMENTED | Code UI, cooldown, 5-fail client stop. Physical Expo Go: OTP succeeded, JWT verified, GET /v1/me 200 response_sent, owner bootstrap succeeded. Failure path keeps S03 + support code. Production Keychain/Keystore unverified |
| S04 | Three-step setup; back keeps data; optional logo | apps/mobile | S04 | POST /workspace | workspaces | onboarding_completed | packages/schemas src/index.test.ts; mobile bootstrap.test.ts; api 20+; pnpm test:db; physical Expo Go 2026-09-15 | VAL01 | IMPLEMENTED | Form + API + DB. Physical Expo Go: workspace setup completed and routed to authenticated Jobs. Logo skip only. VoiceOver, Maestro, production SecureStore/Keychain unverified |
| S05 | Jobs list search filters New job sync badges pagination | apps/mobile | S05 | GET /jobs | jobs | — | packages/schemas/src/job.test.ts; apps/api/src/jobs.test.ts; apps/mobile/src/jobs/form.test.ts; pnpm test:db | SYNC06 | IMPLEMENTED | List, search, Active/Finished/Archived, cursor page, empty/loading/error. Draft-sync badges and encrypted cache not in this slice. Not VERIFIED on device |
| S06 | Create job Quote or Direct invoice; no forced contacts | apps/mobile | S06 | POST /jobs | jobs | job_created | packages/schemas/src/job.test.ts; apps/api/src/jobs.test.ts; apps/mobile/src/jobs/form.test.ts | JRN06 | IMPLEMENTED | Customer name + site/no-site + mode stored. No contacts permission. Quote editor is a later screen on quote-mode jobs. Server `job_created` only. Not VERIFIED on device |
| S07 | Customer form; duplicate warn; archive restore | apps/mobile | S07 | customers | customers | — | CUS01 | VAL01 | PENDING | |
| S08 | Job overview; next action by state; no generic status | apps/mobile | S08 | GET /jobs/{id} | jobs | — | apps/api/src/jobs.test.ts; apps/mobile/src/jobs/form.test.ts | JOB01 | IMPLEMENTED | Overview plus quote draft totals or published quote number. Create/Open quote for quote-mode drafts. View published quote after TX01. Direct invoice does not open the quote editor. No ledger. Not VERIFIED on device |
| S09 | Quote editor; save indicators; conflict | apps/mobile | S09 | PATCH /drafts/{id} | document_drafts | — | apps/api/src/drafts.test.ts; apps/mobile/src/quotes/form.test.ts | SYNC02 | IMPLEMENTED | Create/open one editing quote draft; line cards; notes/terms/expiry; 500ms debounce save; If-Match conflict keep-server; Review quote. Encrypted local SQLite and device QA not in this slice. Not VERIFIED on device |
| S10 | Line editor; live net/tax; optional item copy | apps/mobile | S10 | domain calc | document_drafts | — | packages/domain/src/boundaries.test.ts; apps/mobile/src/quotes/form.test.ts F01 | VAL03 | IMPLEMENTED | Description, unit, qty, unit price, discount, tax on quote cards with live FIN01 totals. Catalogue picker later. Not VERIFIED on device |
| S11 | Preview publish; slot/paywall; stale recovery | apps/mobile | S11 | TX01 | documents | document_published | apps/api/src/quotes.test.ts; apps/mobile/src/quotes/form.test.ts; pnpm test:db | QA09 QA10 | QUO02A | IMPLEMENTED | Review preview, confirm publish, published read-only screen, preparing/ready/failed PDF download. Recipient email later. Not VERIFIED on device |
| S12 | Request detail; resend withdraw replace | apps/mobile | S12 | requests | approval_requests delivery_attempts | request_delivery_result | QA17 | NTF04 | PENDING | |
| S13 | Extra work; after accept before invoice | apps/mobile | S13 | changes | document_drafts | change_started | QA27 | CHG01 | PENDING | |
| S14 | Reduction; bound max; block all-zero | apps/mobile | S14 | changes | document_lines | change_started | QA28 | CHG03 | PENDING | |
| S15 | Invoice preview; block unresolved; direct label | apps/mobile | S15 | TX03 | documents | invoice_issued | QA31 QA44 | BIL01 | PENDING | |
| S16 | Invoice detail ledger actions | apps/mobile | S16 | ledger | ledger_entries | payment_recorded | QA37 | BIL08 | PENDING | |
| S17 | Payment/refund; overpay warn; online only | apps/mobile | S17 | TX04 | ledger_entries | payment_recorded | QA37 QA39 | BIL05 | PENDING | |
| S18 | Credit note; caps; irreversible warning | apps/mobile | S18 | TX04 | credit_allocations | — | QA38 | BIL04 | PENDING | |
| S19 | Customers list/detail | apps/mobile | S19 | customers | customers | — | CUS02 | — | PENDING | |
| S20 | Items list; archive; no live link to docs | apps/mobile | S20 | items | catalogue_items | — | QA15 | CAT01 | PENDING | |
| S21 | Subscription all billing states | apps/mobile | S21 | TX05 | entitlement_snapshots | paywall_viewed | QA45 QA46 QA47 QA48 QA49 QA50 QA51 | SUB | PENDING | |
| S22 | Settings; reauth; future-only profile updates | apps/mobile | S22 | workspace | workspaces | support_opened | apps/mobile/app/(tabs)/settings.tsx; src/drafts/sync.ts | ACC03 | IMPLEMENTED | Sign-out + unsynced-draft port (empty). Business defaults, reauth, support not in this slice |
| S23 | Conflict; keep server or local copy; no auto replace sent | apps/mobile | S23 | If-Match | document_drafts | sync_conflict | QA07 | SYNC03 | PENDING | |
| S24 | Export and deletion | apps/mobile | S24 | exports deletion | exports deletion_requests | export_completed | QA56 QA57 | PRV EXP | PENDING | |
| S25 | Access; no private data before verify | apps/portal | S25 | portal exchange | approval_sessions | — | QA18 | APR02 | PENDING | |
| S26 | Review; PDF ready; consent; approve/decline | apps/portal | S26 | TX02 | approval_decisions | approval_completed | QA24 | APR04 | PENDING | |
| S27 | Receipt; no payment claim | apps/portal | S27 | portal receipt | artifacts | — | QA20 | API05 | PENDING | |
| S28 | Support console MFA grant expiry audit | apps/admin | S28 | admin | staff_users staff_access_grants | — | QA59 QA60 | SEC05 | PENDING | |
| VAL01 | Name/email/phone lengths; no enumeration rewrite | packages/schemas apps/api apps/mobile | S04 S06 S07 | validation | customers workspaces jobs | — | packages/schemas/src/workspace-setup.test.ts; packages/schemas/src/job.test.ts; apps/api/src/workspace.test.ts 422; apps/api/src/jobs.test.ts 422 | — | IMPLEMENTED | Workspace setup and job/customer name bounds client+server. S07 customer form later |
| VAL02 | US address; distinct billing/site; TZ confirm; MM/DD/YYYY | packages/schemas | S04 S06 | validation | address_json site_address_json | — | packages/schemas/src/workspace-setup.test.ts ZIP/state/TZ; packages/schemas/src/job.test.ts no_site xor site | QA64 | IMPLEMENTED | Business address + TZ confirm. Site address and No site address on job create. Date presentation later |
| VAL03 | Line limits; USD only; quote needs one positive net | packages/domain | S10 | validation | document_drafts | — | F01 VAL boundaries.test.ts; packages/schemas/src/draft.test.ts | — | IMPLEMENTED | Qty/price/discount/100-line/total/description/unit. Positive-net is a publish gate; empty drafts may save. Not hosted-verified |
| VAL04 | Notes/terms/reason/name; plain text; client+server | packages/schemas | S09 | validation | document_drafts | — | packages/schemas/src/draft.test.ts notes/terms/expiry | — | IMPLEMENTED | Public notes 2000 and terms 4000 on quote drafts. Approval name/reason later |
| ACC01 | Supabase OTP 6-digit 10m 60s 5 fails; no second code store; secure tokens | apps/mobile apps/api | S02 S03 | Supabase Auth | app_users | signup_verified | packages/schemas/src/index.test.ts; docs/ENV.md; physical Expo Go OTP 2026-09-15 | SREF06 | IMPLEMENTED | SDK OTP path; dashboard 6/600s/60s/5 documented. No second OTP table. Physical Expo Go mailbox OTP succeeded. Production native Keychain/Keystore unverified |
| ACC02 | JWT verify; refresh once; 7-day offline read; sign-out unsynced warn | apps/mobile apps/api | S02 S05 | JWT | app_users | — | apps/api/src/auth.test.ts 401 JWT vs 503 provision; apps/api/src/me-log.test.ts; apps/mobile/src/session/bootstrap.test.ts one refresh and Retry one GET; physical Expo Go 2026-09-15 | SREF06 | IMPLEMENTED | JWKS verify. Physical Expo Go: jwt_verified then GET /v1/me 200 response_sent. Post-OTP 401 refreshes once. Retry is one GET /v1/me. Production Keychain/Keystore unverified |
| ACC02A | Fresh OTP + action grant 5m X-Action-Grant; action_grants table | apps/api | S24 S12 | action-grants | action_grants | — | QA56 QA57 | D-002 Resolved | PENDING | identity.action_grants table exists; issuer route still pending |
| ACC03 | Email change reauth; UUID stable; no ownership transfer | apps/api | S22 | email-change | app_users | — | ACC03 | ACC02A | PENDING | |
| CUS01 | Duplicate email warn; snapshots frozen; apply-current explicit | apps/api | S07 S11 | customers | customers | — | QA15 | — | PENDING | |
| CUS02 | Archive vs delete; no rewrite history on contact delete | apps/api | S19 | archive | customers | — | CUS02 | PRV | PENDING | |
| CAT01 | Copy-on-use items; five zero-price seeds; no invented rates | apps/mobile | S20 S10 | items | catalogue_items | — | QA15 | — | PENDING | |
| JOB01 | lifecycle draft/active/invoiced/finished/canceled/archived | apps/api | S08 | jobs | jobs | — | supabase/migrations/0005_customers_jobs.sql; apps/api/src/quotes.test.ts draft→active on publish; pnpm test:db archive constraint | — | IMPLEMENTED | Enum + draft create + first quote publish to active. Archive/cancel/finish commands later. Not VERIFIED on device |
| JOB02 | Draft delete only; cancel reason; no reopen; linked new job | apps/api | S08 | cancel delete | jobs | — | JOB02 | — | PENDING | |
| QUO01 | Expiry default 14d 23:59:59 TZ; 1–90; no silent extend | apps/api | S11 | publish | documents.snapshot_json | apps/api/src/quotes.test.ts preview expiry_local_date | QA22 QA64 | INV10 | IMPLEMENTED | Frozen at preview from draft expiry_days. Approval-request expiry later. Not VERIFIED on device |
| QUO02 | Q-000001; R1+; number+snapshot+slot+request+outbox one txn | apps/api | S11 | TX01 | document_counters | document_published | apps/api/src/quotes.test.ts; supabase/migrations/0007_quote_publish.sql | QA09 | INV06 | IMPLEMENTED | Number, snapshot, slot, and PDF outbox in one TX. Approval request and email later. Not hosted-verified |
| QUO02A | 10-min preview; canonical bytes stored; PREVIEW_CHANGED | packages/domain | S11 | preview | documents.canonical_snapshot_bytes | packages/domain/src/snapshot.test.ts; apps/api/src/quotes.test.ts PREVIEW_CHANGED | QA30 | INV03 | IMPLEMENTED | Preview freeze + publish hash match. Official number is a document column. Not VERIFIED on device |
| QUO03 | Recipient change = withdraw+replace; signer immutable | apps/api | S12 | replace | approval_requests | — | QA17 | APR03 | PENDING | |
| CHG01 | Accepted quote, no invoice; one pending; rebase; invoice blocks drafts | apps/api | S13 S15 | changes | document_drafts | change_started | QA31 | — | PENDING | |
| CHG02 | Positive lines / positive net credits; mixed OK; reason if zero-value scope change | apps/api | S13 S14 | validation | document_lines | — | QA27 | — | PENDING | |
| CHG03 | Source remaining caps; recheck in txn | packages/domain apps/api | S14 | TX02 | scope_entries | — | QA28 F06 fixtures.test.ts | FIN03 | PENDING | Domain cap CREDIT_EXCEEDS_SOURCE verified; TX02 lock recheck still pending |
| CHG04 | CO-000001; previous/change/new totals; decline applies nothing | apps/api | S13 S26 | TX02 | documents | — | QA27 | — | PENDING | |
| CHG05 | No silent rollback; reverse via new reduction/addition | apps/api | S13 S14 | — | scope_entries | — | QA27 | SUB05 | PENDING | |
| APR01 | 256-bit token hashed; fragment URL; purge payload 24h; no-store | apps/portal apps/api | S25 | exchange | approval_requests | — | QA63 | SEC01 | PENDING | |
| APR01A | 20-min preverify; CSRF in memory; Origin check | apps/portal | S25 S26 | CSRF | approval_sessions | — | QA18 | — | PENDING | |
| APR02 | Pre-verify reveal only name/type/mask; OTP limits | apps/portal | S25 | code send | approval_challenges | — | QA19 | EMAIL03 | PENDING | |
| APR03 | 1h session; 90d access; rotate on replace; worker retry no rotate | apps/api | S25 S12 | sessions | approval_sessions | — | QA17 | — | PENDING | |
| APR04 | PDF ready + text + name + unticked consent; no marketing | apps/portal | S26 | TX02 | approval_decisions | approval_completed | QA24 | — | PENDING | |
| APR05 | Evidence fields; encrypted UA/IP; no GPS/contacts/biometrics | apps/api | S27 | — | approval_decisions | — | PRV02 | — | PENDING | |
| APR06 | Lock predicates; one decision; ALREADY_DECIDED; 409 race | apps/api | S26 | TX02 | approval_decisions | — | QA20 QA21 | — | PENDING | |
| APR07 | Decline comment 1000; no chat/price edit | apps/portal | S26 | TX02 | approval_decisions.comment | — | QA25 | — | PENDING | |
| APR08 | Owner+customer emails; failed receipt does not undo | apps/worker | S12 S27 | outbox | delivery_attempts | request_delivery_result | QA34 | EMAIL04 EMAIL05 | PENDING | |
| FIN01 | q*p half-up − d; tax half-up net*r/10000; no inclusive/compound | packages/domain | S10 | calculate | — | — | fixtures.test.ts F01–F03 | INV01 | VERIFIED | BigInt half-up; no Math.round |
| FIN02 | Operator rates; default 0 with confirm copy; group by rate | apps/mobile | S04 S10 | — | workspaces.default_tax_bp | — | packages/schemas/src/workspace-setup.test.ts; setup.tsx tax confirm | DEC09 | IMPLEMENTED | Setup default 0 + confirm copy. Line grouping already VERIFIED in domain |
| FIN03 | Cumulative tax reduction formula; cap C+x≤N | packages/domain | S14 S18 | calculate | scope_entries | — | fixtures.test.ts F05 F06 | — | VERIFIED | |
| FIN04 | Invoice lines from accepted residual; credits same method; three totals | packages/domain | S15 S18 | TX03 TX04 | document_lines | — | fixtures.test.ts F08 F12 | — | VERIFIED | Residual snapshot; TX03 issue still pending |
| FIN05 | Balance = invoice − credits − pays + refunds; never max(0) | packages/domain | S16 | TX04 | ledger_entries | — | fixtures.test.ts F07–F11 | — | VERIFIED | Signed balance; TX04 persistence still pending |
| F01 | Basic tax 25980 | packages/domain | S10 | calculate | — | — | fixtures.test.ts F01 | FIN01 | VERIFIED | |
| F02 | Qty rounding 333 | packages/domain | S10 | calculate | — | — | fixtures.test.ts F02 | FIN01 | VERIFIED | |
| F03 | Half cent tax 1 | packages/domain | S10 | calculate | — | — | fixtures.test.ts F03 | FIN01 | VERIFIED | |
| F04 | Addition 10825 / 36805 | packages/domain | S13 | calculate | — | — | fixtures.test.ts F04 | CHG | VERIFIED | |
| F05 | Sequential tax 3,2,3 | packages/domain | S14 | calculate | — | — | fixtures.test.ts F05 | FIN03 | VERIFIED | |
| F06 | Over reduction 422 | packages/domain apps/api | S14 | TX02 | — | — | fixtures.test.ts F06 | CREDIT_EXCEEDS_SOURCE | VERIFIED | Domain throws CREDIT_EXCEEDS_SOURCE; HTTP 422 mapping still apps/api |
| F07 | Partial pay 6000 | packages/domain | S16 | TX04 | — | — | fixtures.test.ts F07 | FIN05 | VERIFIED | |
| F08 | Credit after pay -2000 | packages/domain | S18 | TX04 | — | — | fixtures.test.ts F08 | FIN05 | VERIFIED | |
| F09 | Refund settles | packages/domain | S17 | TX04 | — | — | fixtures.test.ts F09 | FIN05 | VERIFIED | |
| F10 | Overpay refund_due | packages/domain | S17 | TX04 | — | — | fixtures.test.ts F10 | FIN05 | VERIFIED | |
| F11 | Reversal no dup refund | packages/domain apps/api | S16 | TX04 | ledger_entries | — | fixtures.test.ts F11 | BIL07 | VERIFIED | Domain reversal; ledger persistence still apps/api |
| F12 | Full reduce zero invoice | packages/domain apps/api | S15 | TX03 | documents | — | fixtures.test.ts F12 | BIL01 | VERIFIED | Zero invoice settled without payment; TX03 issue still apps/api |
| BIL01 | Issue rules; due options; deposit date after issue OK | apps/api | S15 | TX03 | documents | invoice_issued | QA31 | — | PENDING | |
| BIL02 | INV number+freeze one txn; PDF after; no second active | apps/api apps/worker | S15 S16 | TX03 | documents jobs | — | QA33 QA43 | INV06 | PENDING | |
| BIL03 | Void unpaid only; replacement new number | apps/api | S16 | void | documents | — | QA42 QA43 | — | PENDING | |
| BIL04 | CN-000001; caps; cannot delete issued credit | apps/api | S18 | TX04 | credit_allocations | — | QA38 | FIN03 | PENDING | |
| BIL05 | Payment fields; overpay confirm; Recorded by business | apps/api | S17 | TX04 | ledger_entries | payment_recorded | QA37 | DEC05 | PENDING | |
| BIL06 | Refund when negative; oldest-first allocations | apps/api | S17 | TX04 | ledger_refund_allocations | — | QA39 boundaries.test.ts | — | PENDING | Domain allocation/caps verified; API/UI still pending |
| BIL07 | One reversal; block if dependent refunds; no cosmetic void | apps/api | S16 | TX04 | ledger_entries | — | QA40 QA41 fixtures.test.ts F11 | — | PENDING | Domain reversal rules verified; API/UI still pending |
| BIL08 | Derived states; no late fees; credit-to-zero ≠ Paid | apps/api | S16 | derive | — | — | QA38 fixtures.test.ts | INV07 | PENDING | Domain deriveLedger verified; API/UI still pending |
| SUB01 | Entitlement pro; StoreKit prices; monthly default; no weekly/lifetime | apps/mobile | S21 | StoreKit | entitlement_snapshots | paywall_viewed | QA45 | SREF01 | PENDING | IDs provisional |
| SUB02 | 3 lifetime free; slot on first publish/direct issue; rollback if precommit fail | apps/api | S11 S21 | TX01 | job_allowances | document_published | apps/api/src/quotes.test.ts | QA10 | INV09 | IMPLEMENTED | Free-slot gate on first quote publish. Direct invoice issue later. Not hosted-verified |
| SUB03 | 14-day app-managed trial; explicit start; 20 jobs; never reset | apps/api | S21 | trial | job_allowances | trial_started | QA11 QA12 | — | PENDING | Not Apple intro offer |
| SUB04 | Pro fair-use 1000/30d 10GB; trial 500MB; free 250MB; completion remains | apps/api | S21 | quota | job_allowances | — | QA13 | — | PENDING | Not marketed unlimited |
| SUB05 | Completion rights on published jobs; no customer reset after publish | apps/api | S08 S21 | entitlement | jobs.completion_right | — | QA12 QA14 | INV08 | PENDING | |
| SUB06 | Login before purchase; stable UUID; no auto transfer | apps/mobile apps/api | S21 | RevenueCat | entitlement_snapshots | purchase_verified | QA47 | SREF04 | PENDING | |
| SUB07 | Client success provisional; webhook trigger only; nightly reconcile | apps/api apps/worker | S21 | TX05 | provider_events | purchase_verified | QA46 QA48 | SREF03 | PENDING | |
| SUB08 | No custom proration; StoreKit plan change; trial ≠ paid offer | apps/mobile | S21 | StoreKit | — | — | QA51 | SREF01 | PENDING | |
| SYNC01 | Encrypted per-owner SQLite; Expo dev builds; no plaintext | apps/mobile | all drafts | — | local DB | — | Stage 0 spike QA05 | SREF08 | PENDING | Engine TBD |
| SYNC02 | 500ms debounce; Saved after persist; Synced after ack | apps/mobile | S09 | PATCH | document_drafts | — | apps/mobile/src/quotes/form.test.ts; apps/api/src/drafts.test.ts If-Match | — | IMPLEMENTED | Debounced PATCH after persist. Encrypted local queue and Synced-after-ack later. Not VERIFIED on device |
| SYNC03 | If-Match; operation_id; no LWW; S23 on 409 | apps/mobile apps/api | S23 | PATCH | version | sync_conflict | QA07 QA08 | — | PENDING | |
| SYNC04 | UUID local IDs; dep order; pending asset blocks publish | apps/mobile | S11 | assets | assets | — | QA52 | DOC03 | PENDING | |
| SYNC05 | Retry jitter; no auto publish/approve/pay/delete | apps/mobile | S11 | — | — | — | QA06 | DEC10 | PENDING | |
| SYNC06 | Cache 90d/500 jobs/250MB; wipe on account switch | apps/mobile | S05 | — | local DB | — | QA05 | — | PENDING | |
| DOC01 | Versioned HTML-to-PDF A4; fonts; page X of Y | apps/worker | S11 S16 | PDF | artifacts | packages/domain/src/quote-html.test.ts; apps/worker/src/outbox.test.ts | QA54 | D-016 | IMPLEMENTED | Playwright 1.63.0 + Inter OFL + `quote-original-v1`. Device print QA later. Not VERIFIED on device |
| DOC02 | Status copies distinct; original bytes preserved | apps/worker | S26 S16 | artifacts | artifacts | — | QA30 | INV03 | PENDING | |
| DOC03 | JPEG/PNG/HEIC; 10 imgs 10MB; strip EXIF; no video | apps/mobile apps/worker | S13 | assets | assets | — | QA52 | — | PENDING | |
| DOC04 | Camera permission only on Take photo; internal never in PDF | apps/mobile | S13 | — | assets.visibility | — | DOC04 | — | PENDING | |
| DOC05 | Random keys; private buckets; 5-min signed URLs | apps/api | download | S3 | artifacts | apps/api/src/quotes.test.ts presigned GET; apps/api/src/documents-store.test.ts; apps/worker/src/keys.test.ts; packages/config/src/storage.test.ts | QA53 | D-016 | IMPLEMENTED | Private S3-compatible object keys and 5-minute API presign. Production R2; development MinIO. Hosted R2 not provisioned. Not hosted-verified |
| EXP01 | Authenticated ZIP; formula-safe CSV; cents columns | apps/worker | S24 | exports | exports | export_completed | QA55 QA56 | ACC02A | PENDING | |
| EXP02 | Consistent cutoff; 24h link; 7d delete; 2/day | apps/worker | S24 | exports | exports | — | QA56 | EMAIL10 | PENDING | |
| NTF01 | Email + in-app + share sheet; no SMS/push/marketing | apps/worker | S12 | Resend | delivery_attempts | request_delivery_result | NTF01 | — | PENDING | Push deferred |
| NTF02 | Verified domain SPF/DKIM/DMARC; From product-controlled | apps/worker | — | Resend | — | — | NTF02 | EMAIL* | PENDING | |
| NTF03 | Delivery states; retry schedule; bounce/complaint | apps/worker | S12 | webhooks/email | delivery_attempts | request_delivery_result | QA34 QA35 | — | PENDING | Accepted ≠ Delivered |
| NTF04 | Resend ≤3/day ≥10 min; reconcile before retry | apps/api | S12 | resend | delivery_attempts | — | QA34 | — | PENDING | |
| NTF05 | Exact offline/conflict/expiry/ledger/plan copy | apps/mobile apps/portal | S11 S23 S26 S17 S21 | — | — | — | Copy QA | — | PENDING | |
| EMAIL01 | Review quote {number} from {business} | apps/worker | S25 | outbox | delivery_attempts | request_delivery_result | QA09 | APR01 | PENDING | No tracking pixel |
| EMAIL02 | Review a change… | apps/worker | S25 | outbox | delivery_attempts | — | JRN03 | — | PENDING | |
| EMAIL03 | Verification code | apps/worker | S25 | OTP | — | — | QA19 | APR02 | PENDING | |
| EMAIL04 | Decision receipt | apps/worker | S27 | outbox | — | — | APR08 | — | PENDING | |
| EMAIL05 | Owner decision | apps/worker | S08 | outbox | — | — | APR08 | — | PENDING | |
| EMAIL06 | Invoice {number} | apps/worker | view_only | outbox | — | — | API05 | — | PENDING | |
| EMAIL07 | Credit note; does not confirm refund | apps/worker | view_only | outbox | — | — | BIL04 | — | PENDING | |
| EMAIL08 | Withdraw or replace | apps/worker | S25 | outbox | — | — | QA17 | — | PENDING | |
| EMAIL09 | Trial ends; no automatic charge | apps/worker | S21 | schedule | — | — | SUB03 | OPS08 | PENDING | |
| EMAIL10 | Export ready; no customer data in subject | apps/worker | S24 | outbox | exports | export_completed | QA56 | — | PENDING | |
| EMAIL11 | Deletion receipt | apps/worker | S24 | outbox | deletion_requests | — | QA57 | PRV06 | PENDING | |
| ARC01 | TS monorepo mobile/portal/admin/api/worker/domain; Supabase; Render; Resend; RC; Sentry; 1P analytics | repo | — | all | — | — | DEL01 | D-001 D-003 | PENDING | |
| ARC02 | No commercial Supabase REST writes; private schema; FORCE RLS | apps/api | — | RLS | all tenant tables | — | pnpm test:db; pnpm test:hosted-push; supabase/tests/0002_rls_force.sql; 0003_runtime_roles.sql; 0005_migrator_force_rls_policy.sql; 0006_migrator_ownership.sql; RESET ROLE before history insert (D-011); IPv4 session pooler apply bound to linked project-ref (D-012); `.github/workflows/hosted-development-migrations.yml`; hosted `migration list --linked` + catalog SELECT 2026-09-15; pnpm secret-scan | SREF07 D-010 D-011 D-012 | IMPLEMENTED | Local isolation tests pass. Hosted `fhgacxkpgjdcjuvanesv` catalog-verified 2026-09-15: `0001`–`0004` recorded, no pending local migrations, nine identity/commercial tables migrator-owned with FORCE RLS and table-scoped migrator policies, no unrestricted policy leak to runtime/client roles, `api_app`/`migrator`/`worker_app`/`purge_app` NOLOGIN NOSUPERUSER NOBYPASSRLS, `anon`/`authenticated` have no private schema or table grants, `provision_owner` and `complete_workspace_setup` are migrator-owned SECURITY DEFINER with locked `search_path` and `api_app`-only EXECUTE. Not VERIFIED: live hosted two-tenant isolation; hosted execution of those functions; hosted database lint; live OTP, API JWT, physical-device behavior. |
| ARC03 | JWT → tenant context per txn; portal/staff separate; no pool leak | apps/api | — | Fastify | — | — | pnpm test:db; apps/api/src/workspace.test.ts POST /workspace; physical Expo Go 2026-09-15 | AUTHZ01 | IMPLEMENTED | JWT + provision_owner + complete_workspace_setup. Hosted development executed both functions during physical Expo Go onboarding (GET /v1/me 200, S04 saved). Portal/staff later. Hosted two-tenant isolation unverified |
| ARC04 | Transactional outbox; SKIP LOCKED; no provider I/O in txn | apps/worker | — | outbox | outbox_tasks | apps/worker/src/outbox.test.ts claim/idempotency/retry; apps/api/src/quotes.test.ts | QA33 QA65 | D-016 | IMPLEMENTED | Claim SKIP LOCKED, 60s lease, 5 attempts, R2 PutObject outside the TX. Hosted worker not running. Not hosted-verified |
| ARC05 | Pin versions; lockfile CI; no invented patch numbers | repo | — | CI | — | — | QA68 | D-005 | PENDING | Stage 0 pin |
| DB01 | UUID, cents, numeric qty, composite tenant FKs, no cascade published | supabase | — | migrations | all | — | db-test.mjs logo_asset_id + jobs.customer_id + document_drafts.job_id + assets.draft_id + jobs.current_quote_id FKs; hosted catalog 2026-09-15 nine identity/commercial tables on `fhgacxkpgjdcjuvanesv` | — | PENDING | Identity/tenancy tables plus local `0005`–`0008`. Hosted `0005`/`0006`/`0007`/`0008` not applied. Remaining commercial entities later |
| DB02 | Required fields; version; schema-validated JSON; enum constraints | supabase | — | migrations | all | — | 0004_workspace_setup.sql completed-setup check | — | IMPLEMENTED | Completed workspace bounds + USD/tax/due/TZ format. Remaining JSON entities later |
| DB03 | Indexes; pending unique; active invoice unique | supabase | — | migrations | approval_requests jobs | — | QA16 QA43 | INV04 | PENDING | |
| DB04 | Immutable triggers; reversal checks; DB authz tests | supabase | — | triggers | documents ledger_entries | scripts/db-test.mjs issued documents and lines are immutable | QA26 | INV02 | IMPLEMENTED | Issued documents/lines reject UPDATE/DELETE except purge. Ledger reversal later. Not hosted-verified |
| DB05 | Privileged purge; deletion ledger on restore | apps/worker | S24 | purge | deletion_requests | — | QA58 | PRV | PENDING | |
| API01 | /v1 HTTPS JSON; Bearer/cookie; Idempotency-Key; If-Match | apps/api | — | Fastify | idempotency_records | — | apps/api/src/workspace.test.ts If-Match + Idempotency-Key; apps/api/src/drafts.test.ts PATCH If-Match | — | IMPLEMENTED | Bearer + Idempotency-Key on jobs/quotes; If-Match on workspace and quote drafts. Portal cookie later |
| API02 | Envelope; cursor lists; error shape; status mapping | apps/api | — | Fastify | — | — | apps/api/src/workspace.test.ts 401/403/409/422; apps/api/src/jobs.test.ts items/next_cursor; apps/api/src/auth.test.ts /v1/me 401 vs 503 | — | IMPLEMENTED | Auth, setup, and jobs envelopes. GET /v1/jobs is cursor-paginated. Portal cookie later |
| API03 | Reject unknown fields; server-owned calculated fields | apps/api | — | schemas | — | — | apps/api/src/workspace.test.ts owner_user_id/workspace_id/currency; packages/schemas/src/draft.test.ts total_cents | — | IMPLEMENTED | Enforced on analytics batch, POST /workspace, and quote draft payloads |
| API04 | Direct invoice via generic draft routes | apps/api | S06 S15 | drafts | document_drafts | invoice_issued | QA44 | JRN06 | PENDING | |
| API05 | view_only purpose; no decision; access expiry | apps/api apps/portal | S25–S27 | portal | approval_requests | — | API05 | EMAIL06 | PENDING | |
| TX01 | Publish algorithm | apps/api | S11 | publish | documents outbox_tasks | document_published | apps/api/src/quotes.test.ts | QA09 | QUO02 | IMPLEMENTED | Preview hash, slot, number, snapshot, draft preserved published, PDF queued. Approval request and email later. Not hosted-verified |
| TX02 | Approve algorithm | apps/api | S26 | decision | approval_decisions scope_entries | approval_completed | QA20–QA23 | APR06 | PENDING | |
| TX03 | Invoice issue algorithm | apps/api | S15 | issue | documents | invoice_issued | QA32 QA33 | BIL02 | PENDING | |
| TX04 | Credit/payment/refund/reversal algorithm | apps/api | S16–S18 | ledger | ledger_entries | payment_recorded | QA37–QA41 | BIL | PENDING | |
| TX05 | Billing webhook/reconcile algorithm | apps/worker | S21 | webhooks | provider_events | purchase_verified | QA48 | SUB07 | PENDING | |
| TX06 | Public link compromise | apps/api apps/admin | S12 S28 | revoke | approval_sessions | — | QA17 | APR03 | PENDING | |
| SEC01 | TLS HSTS CORS CSP; no tokens in storage/URL/logs; no 3p scripts on portal | all web | S25 | headers | — | — | packages/schemas/src/index.test.ts redaction; auth.test.ts | APR01 | PENDING | API redaction + no tokens in error bodies verified. HSTS/CSP/portal later |
| SEC02 | Tenant object checks; 120/min; 20 pub/h; email caps | apps/api | — | rate limit | — | — | QA03 QA04 | — | PENDING | |
| SEC03 | Isolated file validation; webhook fail-closed | apps/worker | — | assets webhooks | assets | — | QA52 | — | PENDING | |
| SEC04 | No secrets in git; public keys only on device | repo | — | secrets | — | — | QA68 | §33 | PENDING | |
| SEC05 | Staff MFA; 24h grant; reason+audit; two-person break-glass | apps/admin | S28 | staff | staff_access_grants | — | QA59 QA60 | — | PENDING | |
| SEC06 | Report a problem; no public directory; no training/ads licence | apps/portal | S25 | portal/report | support_cases | — | SEC06 | — | PENDING | |
| SEC07 | Scans + isolation + focused review; fix exploitable high/critical | ops | — | CI | — | — | SEC07 | Stage 5 | PENDING | Not claimed as pentest |
| PRV01 | Privacy notice; counsel reviews roles | legal | S22 | — | — | — | §34 | — | PENDING | Owner input |
| PRV02 | Retention windows; logs 30/90; evidence 90; metrics 13m | ops | — | jobs | — | — | PRV02 | APR05 | PENDING | |
| PRV03 | In-app deletion; reauth; type DELETE; Apple cancel separate | apps/mobile | S24 | deletion | deletion_requests | — | QA57 | SREF02 | PENDING | |
| PRV04 | Immediate revoke; purge 24h start / 30d complete; no blanket invoice keep | apps/worker | S24 | purge | deletion_requests | — | QA57 | DB05 | PENDING | Counsel categories |
| PRV05 | Backups ≤35d; deletion ledger on restore; purge objects | ops | — | restore | — | — | QA58 QA66 | OPS06 | PENDING | |
| PRV06 | No v1 cancel after confirm; receipt; trial abuse vs secret profiles | apps/api | S24 | deletion | deletion_requests | — | QA57 | EMAIL11 | PENDING | |
| NFR01 | WCAG 2.2 AA portal; VoiceOver/Dynamic Type/keyboard/reduced motion | apps/mobile apps/portal | all | — | — | — | QA61 | SREF05 UI01 | PENDING | |
| NFR02 | Device/browser matrix | apps/mobile apps/portal | all | — | — | — | Device QA | DEC01 | PENDING | |
| NFR03 | Load targets 100 owners / p95 read 500ms write 800ms; PDF 15s/60s | apps/api apps/worker | — | — | — | — | QA67 | — | PENDING | Targets not claimed current |
| NFR04 | 99.9% API/portal; RPO 15m RTO 4h; object restore verified | ops | — | backups | — | — | QA66 | OPS06 | PENDING | |
| NFR05 | Drafts survive terminate after Saved; no fake empty/success | apps/mobile apps/api | S09 S11 | — | — | — | QA05 QA06 | SYNC | PENDING | |
| NFR06 | Timeouts and no non-idempotent auto-retry | apps/mobile apps/api apps/worker | — | — | — | — | QA34 | ARC04 | PENDING | |
| ANA01 | First-party schema; forbid PII list | apps/api | — | batch | analytics_events | all events | packages/schemas/src/workspace-setup.test.ts; workspace.test.ts onboarding PII absent | DEC12 | IMPLEMENTED | signup_verified + onboarding_completed server-side; client PII and client onboarding_completed rejected |
| ANA02 | Server authoritative; batch 50/7d; exclude sandbox | apps/api | — | analytics | analytics_events | — | ANA02 | — | PENDING | |
| ANA03 | No ad SDK; experiments not on money/consent/entitlement | all | S21 | — | — | paywall_viewed | ANA03 | DEC12 | PENDING | |
| DEL01 | Owner-controlled repo lockfiles env templates Dockerfiles migrations | repo | — | — | — | — | Handover | ARC05 | PENDING | |
| DEL02 | OpenAPI 3.1 + ERD + migrations tested | apps/api | — | OpenAPI | all | — | Contract CI | API* | PENDING | |
| DEL03 | Editable UI source S01–S28 states prototype tokens | design apps | S01–S28 | — | — | — | Design signoff | UI | PENDING | |
| DEL04 | Feature done = tests+authz+states+a11y+analytics+logs+migrations | all | slices | — | — | — | Slice exit | Contract | PENDING | |
| DEL05 | Staging TestFlight runbooks secrets transfer demo | ops | — | — | — | — | Handover | REL | PENDING | |
| OPS01 | Separate env; sandbox≠prod; TEST watermark; no prod PII in dev | ops | — | — | — | — | OPS01 | — | PENDING | |
| OPS02 | CI gates + flags for publication/purchases | repo | — | CI | — | — | QA68 | — | PENDING | |
| OPS03 | Structured redacted logs; Sentry no replay; dashboards | all | — | Sentry | — | — | packages/schemas/src/index.test.ts redactText; apps/api/src/me-log.test.ts; apps/api/src/db.test.ts; apps/api/src/auth.test.ts /v1/me stages | — | PENDING | Redaction helpers exist. GET /v1/me emits allowlisted owner_me stages plus optional SQLSTATE. Sentry wiring and dashboards later |
| OPS04 | Sev1 alerts; staffed on-call | ops | — | alerts | — | — | OPS04 | §34 | PENDING | Owner staffing |
| OPS05 | Sev1 30m / Sev2 4h; no invented breach deadlines | ops | — | incidents | — | — | Runbook | — | PENDING | |
| OPS06 | Restore runbook; quarterly drill | ops | — | restore | — | — | QA58 QA66 | PRV05 | PENDING | |
| OPS07 | Deploy API→worker/portal→mobile; 90-day dual API | ops | — | — | — | — | OPS07 | — | PENDING | |
| OPS08 | Scheduled jobs with unique execution keys | apps/worker | — | cron | outbox_tasks | — | OPS08 | EMAIL09 | PENDING | |
| REL01 | Current Apple SDK; privacy labels; IAP not external purchase | apps/mobile | S21 | StoreKit | — | — | REL01 | SREF01 | PENDING | |
| REL02 | Owned accounts, URLs, screenshots, review identity, trial explanation | ops | — | — | — | — | Store package | §34 | PENDING | |
| REL03 | 15–25 TestFlight pilots then limited public; no scale ads until flows pass | ops | — | — | — | — | Pilot | MET | PENDING | |

## Coverage count

224 PRD IDs in this matrix (DEC through REL, including S01–S28, F01–F12, EMAIL01–11). QA01–QA68 are test evidence, not duplicate requirement rows. See [TEST_PLAN.md](TEST_PLAN.md).
