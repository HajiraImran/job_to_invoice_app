> Source: `docs/PRD.md` §§13, 26, 28, 30–32
> Android operator-app store QA is not a v1 product gate (DEC01, D-001). Physical iPhone QA is required.

# Test plan

Each QA ID is a developer/QA requirement, not a claim that the unbuilt app has passed. Link automated tests and manual evidence to IDs. Only VERIFIED in the requirements matrix counts as complete.

## Layers

| Layer | What | Must use |
| --- | --- | --- |
| Domain unit | FIN01–FIN05, fixtures, state machines | `packages/domain` only; no floats |
| Property | Nonnegative remaining source, full-credit tax reversal, summation associativity, retry invariance, mobile=server=PDF | Same package |
| Integration | Real PostgreSQL constraints, RLS, triggers, TX locks, composite FKs, `SET LOCAL` pool leak, role DSNs | Clean DB per run |
| API contract | OpenAPI 3.1, error codes, idempotency | No mocked authorization |
| Worker | Outbox claim, lease expiry, effect_key | Crash/restart |
| Portal E2E | JRN02–JRN04 | Controlled mailboxes |
| Maestro | Highest-value owner journeys on iPhone | Development/preview build, not Expo Go |
| Device | NFR02 matrix | Physical iPhone SE 3 + current iPhone |
| Drill | Backup restore, deletion ledger | Staging |
| Sandbox store | SUB purchase/restore | Apple + RevenueCat sandbox |

## Fixtures (must match exactly)

| ID | Inputs | Expected | Tests |
| --- | --- | --- | --- |
| F01 | q 2.5, p 10000, d 1000, r 825 bp | Gross 25000; net 24000; tax 1980; total 25980 | QA30 |
| F02 | q 0.333, p 1000, no tax | Gross/net 333 | QA30 |
| F03 | net 5, r 1000 bp | Tax 1; total 6 | QA30 |
| F04 | F01 + added net 10000 at 825 bp | Change 10825; new scope 36805 | QA30 |
| F05 | N 100, T 8; reduce 33, 33, 34 | Tax 3 then 2 then 3; remaining 0 | QA29 |
| F06 | remaining 34; request 35 | 422 CREDIT_EXCEEDS_SOURCE | QA29 |
| F07 | invoice 10000, pay 4000 | due 6000; partially_paid | QA37 |
| F08 | 10000 paid 10000, credit 2000 | balance -2000; refund_due | QA38 |
| F09 | F08 + refund 2000 | balance 0; settled | QA38 |
| F10 | pay 12000 on 10000 | -2000; refund_due; never paid-only | QA37 |
| F11 | pay 4000 then reverse | balance 10000; no duplicate refund | QA40 |
| F12 | full reduction before invoice | zero invoice; settled without fake payment | QA36 |

## Maestro (owner iPhone)

| Flow | Maps to | QA |
| --- | --- | --- |
| Fresh install → OTP → setup | JRN01 start | QA01 |
| Create quote draft → local save → kill app | JRN07 | QA05 |
| Publish quote (sandbox mailbox) | JRN01 | QA09 |
| Direct invoice | JRN06 | QA44 |
| Invoice issue after approved change | JRN05 | QA31 |
| Paywall on fourth free job | SUB02 | QA10 |
| Settings logout | ACC02 | Maestro `.maestro/auth-sign-in.yaml` is the public-screen smoke; full logout E2E needs a staging Auth project |

Do not automate every cosmetic case. Portal approval races stay in integration/E2E, not Maestro-only.

## Device matrix (NFR02)

- iPhone SE 3rd generation and a current standard iPhone
- Supported older iOS and latest stable iOS (minimum iOS 17 unless raised per DEC01)
- Low storage, airplane mode, interruption
- Safari iPhone; Chrome Android current and previous major (portal only); Chrome/Edge desktop current and previous; Safari macOS current
- No promised iPad operator layout

## Acceptance matrix

| Test | Scenario | Required outcome | Evidence |
| --- | --- | --- | --- |
| QA01 | New owner verifies email and sets up workspace | One workspace, defaults, allowances; restart resumes | E2E |
| QA02 | Wrong/expired owner code and resend flood | Generic error, cooldown, no enumeration. Email-change revokes prior refresh. Staff token on owner route → 401. | Integration |
| QA03 | Two owners request each other's IDs | 404; no leak in API, storage, logs | Isolation |
| QA04 | Cross-tenant line/asset ID in own draft | Rejected at composite FK and API before publication | Isolation |
| QA05 | App terminated after local save | Draft reappears exactly | Device |
| QA06 | Network removed during typing/publish | Local save visible; publish blocked or resolved | Device |
| QA07 | Two phones edit same monetary field | 409; both copies; no LWW | Local in-memory: `conflict-resolution.test.ts`. Hosted 409 and dual-device QA07 NOT VERIFIED. |
| QA08 | Replay draft operation 20 times | One mutation; stable version | Integration |
| QA09 | Publish timed out after commit and retried | One number, slot, request, outbox | Integration |
| QA10 | Fourth new free job | Paywall; draft kept; first three completable. Stage 2 integration against real `job_allowances` (no RevenueCat). No stub path. | Integration + E2E |
| QA11 | Trial replay/reinstall/email change | Original expiry/cap; no billing. Local: `apps/api/src/subscription.test.ts` second start keeps original dates. Reinstall/email-change device unverified. | Integration |
| QA12 | Trial expires during pending approval | Customer can approve; owner can finish. Local: expired trial blocks new jobs; existing trial job remains readable. Portal approve-after-expiry and device unverified. | Integration |
| QA13 | Paid owner downgrades with jobs | Completion/export; new-job gate | E2E |
| QA14 | Reset customer/site of published job | Blocked; new job required | API |
| QA15 | Edit catalogue price and business address | Issued docs unchanged | Integration; apps/api/src/items.test.ts catalogue price edit leaves canonical bytes and issued line price unchanged. Mobile copy-on-use independence is `apps/mobile/src/items/form.test.ts` and `apps/mobile/src/items/list.test.ts`. Business-address half remains S22. Not VERIFIED on device. Hosted APPLY_0020 not applied. Do not mark QA15 complete from Items tests alone. |
| QA16 | Publish replacement while old pending | Old superseded; one pending index | Concurrency |
| QA17 | Old recipient follows replaced link | Cannot decide; correct message. Revoke-after-approve leaves `approval_decisions` intact (TX06). | Portal | Local: `apps/api/src/requests.test.ts` + `openapi/v1.json` replace-link. Physical Android development build 2026-09-21: previous link rejected after replace-link; newest link opened the correct quote. TX06 revoke-after-approve, iOS/TestFlight, and production SPF/DKIM unverified. |
| QA18 | Link forwarded to unrelated person | No scope without bound-email code | Portal |
| QA19 | OTP brute force and resends | Limits; no raw codes logged | Isolation |
| QA20 | Approve twice concurrently | One decision and one scope apply | Concurrency |
| QA21 | Approve and withdraw race | One terminal outcome; loser conflict | Concurrency | Local: withdraw FOR UPDATE + terminal state in `apps/api/src/requests.test.ts`; openapi withdraw 409. Physical Android 2026-09-21 sequential withdraw succeeded (not a parallel race). Full QA21 parallel race/stress harness later. iOS/TestFlight unverified. |
| QA22 | Approve 1 ms after expiry | Rejected despite worker lag | Concurrency |
| QA23 | Opened before expiry, approved after | Rejected; no cached authority | Portal |
| QA24 | Consent unticked or hash altered | Rejected | Portal |
| QA25 | Declined quote revised and resent | New revision; old decision kept | E2E |
| QA26 | Accepted quote edited directly | Immutable write rejected API and DB, including `document_lines` and original PDF artifact | Integration; apps/api/src/invoices.test.ts quote snapshot bytes unchanged after invoice issue |
| QA27 | Addition then approved reduction | Ledger accurate; sources visible | Integration; apps/api/src/changes.test.ts. Approved extras appear once in invoice residual. Not VERIFIED on device |
| QA28 | Two reductions exceed remaining | Later invalid rejected atomically | Concurrency; domain F06 + TX02 P0051. Concurrent portal decision covered in changes.test.ts. Not VERIFIED on device |
| QA29 | F05 and F06 | Exact tax and cap | Domain |
| QA30 | F01–F12 mobile/server/PDF | Exact matching cents | Domain + PDF |
| QA31 | Invoice with pending or draft change | Block with resolution | API; apps/api/src/invoices.test.ts UNRESOLVED_CHANGES; apps/api/src/changes.test.ts pending change blocks invoice preview. Not VERIFIED on device |
| QA32 | Invoice raced with change publish | No inconsistent scope/invoice | Concurrency; invoice issue after invoice remains blocked for new change drafts. Full publish-vs-issue race not device-verified |
| QA33 | PDF worker crashes after invoice commit | Invoice issued; one artifact; no dup number | Worker; generate_original_pdf queued after commit. Crash/retry same artifact still local-only, not VERIFIED |
| QA34 | Email timeout after acceptance | Reconcile before retry | Worker; EMAIL06 claim waits for ready original PDF and does not blind-resend. Hosted Resend timeout unverified |
| QA35 | Permanent bounce | Not delivered; suppression path | Integration |
| QA36 | Full scope reduced to zero | Zero invoice; no fake payment | Domain |
| QA37 | Manual partial/overpayment | Derived balance; overpay confirm | API; apps/api/src/invoices.test.ts partial 4000 then unconfirmed overpay 422 then confirmed refund_due. Mobile `payment.test.ts` covers cents, partial, exact, and confirmed overpay. Not VERIFIED on device. Do not retry INV-000001. |
| QA38 | Credit after full payment | Negative balance; refund due; no money moved | API; apps/api/src/invoices.test.ts INV-000003 pay 25980 then CN-000001 credit 2000 net / 2165 total; refund_due; one payment entry only. Not VERIFIED on device. Do not use INV-000001. |
| QA39 | Refund exceeds available | Rejected; partial refund works | API; apps/api/src/invoices.test.ts REFUND_EXCEEDS_BALANCE then partial then settling refund. Not VERIFIED on device. |
| QA40 | Reverse payment once and retry | One reversal; ledger correct. Replay after simulated 31-day ephemeral cache expiry still one `operation_id`. | API; apps/api/src/invoices.test.ts second-owner INV-000001 pay 4000 then reverse; financial idempotency survives ephemeral delete. Not VERIFIED on device. Do not reuse hosted INV-000001. |
| QA41 | Reverse payment with dependent refund | Block or require correction | API; apps/api/src/invoices.test.ts second-owner INV-000002: reverse payment while refund allocated is 422, then refund reverse unlocks payment reverse. Not VERIFIED on device. |
| QA42 | Void with payment or issued credit | Rejected; history intact | API; apps/api/src/invoices.test.ts third-owner INV payment 4000 and CN credit 2000 both LEDGER_BLOCKS_VOID; original issued row and ledger/credit remain. Not VERIFIED on device. |
| QA43 | Unpaid void then replacement | New number; link; one active invoice | API; apps/api/src/invoices.test.ts third-owner INV-000001 voided then INV-000002 replacement with prior_document_id; concurrent void 200+409; EMAIL08 once; portal REQUEST_UNAVAILABLE. Not VERIFIED on device. |
| QA44 | Direct invoice without quote | No-prior-approval label; ordinary calc | API; apps/api/src/invoices.direct.test.ts issue without email, EMAIL06 only with recipient, concurrent first issue one INV, snapshot origin=direct. Not VERIFIED on device. Hosted APPLY_0019 not applied. |
| QA45 | Monthly purchase canceled/pending/success | No false Pro; success server-verified | Sandbox |
| QA46 | SDK success, backend unavailable | Pending verification UI; context kept | Device |
| QA47 | Restore receipt under another owner | No theft; recovery message | Sandbox |
| QA48 | Billing events duplicated/out of order | Current provider state wins | Worker |
| QA49 | Cancellation before expiry | Access until expiry | Sandbox |
| QA50 | Refund/revocation and grace | Correct entitlement; history kept | Sandbox |
| QA51 | Trial and purchase concurrently | No double trial; paid wins if verified | Integration |
| QA52 | Malformed/oversize/EXIF/GPS photo | Reject or sanitized; no metadata leak | Worker |
| QA53 | Signed URL expired or wrong tenant | Denied; no data. User JWT against Storage REST is denied. | Isolation |
| QA54 | PDF 100 lines, long names, 10 images | Legible; no clip; totals correct | Device |
| QA55 | Unicode names and CSV formula text | Correct display; safe export | Integration |
| QA56 | Export after subscription expiry | Authenticated export; checksums | E2E |
| QA57 | Deletion with active subscription | Accept; explain billing; revoke; purge | E2E |
| QA58 | Restore backup containing deleted owner | Deletion ledger reapplied first | Drill |
| QA59 | Staff access without owner grant | BLOCKED: no staff authentication. Expected later: metadata only; attempt audited | Isolation |
| QA60 | Staff grant expires/revoked | BLOCKED: no staff authentication. Expected later: content stops at next request | Isolation |
| QA61 | VoiceOver / Dynamic Type / keyboard / zoom | Core flows usable | Device |
| QA62 | Low disk during draft save | Failure; do not show Saved | Device |
| QA63 | Token in URL/error/analytics/referrer | Mailbox HTML uses `#` not `?token=`; after exchange logs contain only `token_hash`; no click-tracking rewrite | Isolation |
| QA64 | DST and timezone changes | Expiry invariant; due dates correct | Integration; invoice issue_date/due_date use workspace calendar dates in freeze/issue. DST/device unverified |
| QA65 | Worker double claim / lease expiry | One external effect; crash after provider 200 before DB write produces zero extra emails or tokens | Worker |
| QA66 | Backup and object restore drill | RPO/RTO measured; hashes verified | Drill |
| QA67 | Maximum supported load | NFR03 measured; backlog drains | Load |
| QA68 | No configured production secrets | CI/deploy fails safely | CI |

## Stage gates

| Stage | Exit tests |
| --- | --- |
| 0 | Spike evidence only |
| 1 | QA01–QA08 + isolation including pool-leak and role tests |
| 2 | QA10 (allowances), QA16–QA26, quote journey, action-grant 403s |
| 3 | F01–F12 + invoice/ledger QA |
| 4 | QA11–QA13, QA45–QA51, QA56–QA57 |
| 5 | QA61, QA66–QA67, security review |
| 6 | All 68 executed; financial/isolation/approval concurrency automated |

## Isolation suite

User A cannot read or mutate User B's private data through API, storage URLs, logs or portal tokens. UI hiding is not authorization.

Required database-path cases:

- After a thrown command, the next pool borrower has no leftover `app.workspace_id` / `app.actor_id` GUC
- Worker payload with a forged `workspace_id` cannot change context
- `api_app` and `worker_app` cannot `SELECT` another tenant’s `documents` even with a forged GUC
- `purge_app` is unreachable from the API pool
- CI fails if `service_role` appears in app connection config
- Foreign `source_line_id` / `invoice_line_id` with the attacker’s `workspace_id` fails at composite FK
- SQL UPDATE clearing `jobs.completion_right` is rejected
- Concurrent fourth publish: one `ENTITLEMENT_REQUIRED`, `free_jobs_consumed=3`; failed TX01 leaves consumed unchanged

## Release-critical automated gates (OPS02)

Merge to `main` must run, not skip:

- Lint and types
- Domain/financial tests including F01–F12
- Canonicalizer stability (same snapshot → identical bytes; no re-canonicalize for digest compare)
- API contract validation
- Migrations on a clean database
- Tenant isolation, pool-leak, role and composite-FK tests
- Financial idempotency including post-expiry replay
- Worker `effect_key` / lease tests
- Dependency and secret scans (`service_role` banned)
- Signed mobile build smoke on release candidates

## Auth slice commands

```sh
pnpm --filter @job-to-invoice/schemas test
pnpm --filter @job-to-invoice/api test
pnpm --filter @job-to-invoice/mobile test
pnpm test:db
pnpm migrate:clean
```

S02/S03 presentation contracts are covered by `apps/mobile/src/auth/presentation.test.ts` (S02 copy, S03 six-digit sanitize/paste/cells, explicit Verify code, timestamp 60s resend, masked email, change-email to S02, redaction). OTP send/verify, SecureStore, and VoiceOver remain device/staging evidence.

S04 Basic info presentation is covered by `apps/mobile/src/setup/basic-info.test.ts` (VAL01/VAL02 field rules, read-only email, E.164 vs national phone, `postal_code` payload, no Branding route, protected-route hold, redaction). Hosted POST `/v1/workspace`, VoiceOver, and Figma `31:4` pixel match remain device/staging evidence.

Figma S06 / PRD S04 step 3 (timezone and defaults) is covered by `packages/schemas/src/timezone.test.ts` and `apps/mobile/src/setup/defaults.test.ts` (IANA storage, DST offset, picker confirm/cancel, tax/due/terms, redaction, post-save Jobs replace). Physical timezone picker, VoiceOver, and Figma `39:5`/`39:65` pixel match remain device/staging evidence.

PRD S06 Create job presentation is covered by `apps/mobile/src/jobs/create-job.test.ts` (quote default, mode cards, customer picker states, archived exclusion, add-customer hold, title validation, quote/direct continuation, offline `customer_name`, no Contacts path, redaction). Physical picker, VoiceOver, and Figma `48:5`/`48:63` pixel match remain device/staging evidence.

QA01 mailbox E2E, Maestro `.maestro/setup-onboarding.yaml`, VoiceOver, and physical SecureStore checks require `EXPO_PUBLIC_AUTH_PROJECT_URL` plus dashboard OTP settings from `docs/ENV.md`. They are not satisfied by unit mocks.

Signed-out protected jobs navigation is covered by `apps/mobile/src/session/logic.test.ts` (cold start `/(tabs)/jobs` → `/(public)/welcome`, hold while restoring, no replace loop). Do not add magic-link OTP. Maestro is not used for this check because it needs a staging Auth project for a live session.

Owner `GET /v1/me` client timeout is 15 seconds (`OWNER_ME_TIMEOUT_MS`); abort maps to `BOOTSTRAP_NETWORK`. Tests inject the timer and do not wait 15 real seconds.

The production draft-sync adapter is implemented (`LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED = true`) behind SQLCipher. Phase 0 device checks A–E are VERIFIED. Commercial SYNC01 remains **IMPLEMENTED** until the combined physical procedure below is fully recorded; do not mark combined QA05–QA08 **VERIFIED** from partial happy-path evidence alone.

## SYNC01 Phase 0 — SQLCipher foundation (EAS development build)

Automated orchestration only (does **not** prove encryption):

```sh
pnpm --filter @job-to-invoice/mobile test -- src/storage
pnpm --filter @job-to-invoice/mobile typecheck
pnpm --filter @job-to-invoice/mobile lint
```

Expo Go is **not** valid evidence. `Constants.appOwnership === "expo"` is `UNSUPPORTED_RUNTIME`.

### Manual verification (Windows PowerShell + physical device)

Do not record secrets, owner IDs, keys, paths, or probe values in tickets or chat.

1. From the repo root, create and install a **new** development client after `useSQLCipher: true` (native rebuild required):

```powershell
cd C:\Projects\Job_to_Invoice
pnpm --filter @job-to-invoice/mobile exec eas build --profile development --platform android
```

Install the resulting build on a physical device. Then start Metro against the **dev client**, not Expo Go:

```powershell
pnpm --filter @job-to-invoice/mobile dev
```

2. Exercise `apps/mobile/src/storage` on the installed development client (temporary diagnostics UI must not remain in the tree):
   - Confirm capability is `sqlcipher_native` (not Expo Go).
   - Open an encrypted diagnostics database, write a fixed non-sensitive probe, read it back, and close.
   - Force-quit the app, relaunch the same build, reopen with the **same** SecureStore key, and read the probe again.
   - Confirm a deliberately wrong key cannot read the database (`DATABASE_UNAVAILABLE` / wrong-key rejection).
   - Call `wipeOwnerEncryptedDatabase`, then confirm the SecureStore key entry is gone and remnant access fails safely.
   - Confirm Metro / device logs show no key material, owner IDs, database paths, SQLCipher pragmas with secrets, tokens, or emails.
   - Optional (still required before claiming full ciphertext proof): copy the `.sqlite` file off-device and open it with a normal SQLite viewer; it must **not** be readable as plaintext SQLite.

3. Record pass/fail only as device evidence notes. Phase 0 foundation checks may be marked VERIFIED when A–E pass on a physical EAS development build. Commercial SYNC01 code may be **IMPLEMENTED** after the vertical slice lands; do **not** mark **VERIFIED** until the combined physical procedure below passes.

### Physical evidence — Android EAS development build (2026-09-20)

Device: physical Android EAS development client with `useSQLCipher: true` (already installed; Metro JS reload only).

| Check | Result |
| --- | --- |
| A. Native capability | PASS (`native_capability_ok`) |
| B. Create and write probe | PASS (`probe_match`) |
| C. Reopen after force-close/relaunch | PASS (`probe_match`) |
| D. Wrong-key rejection | PASS (`wrong_key_rejected`) |
| E. Secure wipe | PASS (`wipe_ok`) |

Temporary diagnostics harness used for this pass was removed after evidence. Remaining unverified for Phase 0 ciphertext proof: normal-SQLite file extraction / plaintext viewer inspection (not performed).

## SYNC01 commercial offline persistence (post Phase 0)

Automated orchestration:

```sh
pnpm --filter @job-to-invoice/mobile test -- src/sync src/storage src/drafts src/session/sign-out.test.ts
pnpm --filter @job-to-invoice/mobile typecheck
pnpm --filter @job-to-invoice/mobile lint
```

### Combined physical-device procedure (required before VERIFIED)

On the installed Android EAS development client (SQLCipher already enabled):

1. Sign in → open Jobs → confirm online list caches.
2. Edit a quote draft → confirm **Saving locally** then **Saved on this device**; force-close → relaunch → draft intact (QA05).
3. Enable airplane mode within 7-day window → edit draft offline → reconnect → Settings → **Synchronize** must issue authenticated PATCH (even if SYNC05 backoff would otherwise delay) → **Synced** only after ack; publish remains blocked offline (QA06).
4. Create a job offline → pending badge → sync after reconnect.
5. Provoke 409 (second device or simulated) → Keep server / Save local copy; no silent merge (QA07).
6. Settings → unsynced alert → Stay leaves data; Synchronize drains then signs out only when outbox empty; Discard wipes DB+key and fails closed on wipe error.
7. Confirm Metro logs omit keys, owner IDs, paths, tokens, emails, commercial payloads. `__DEV__` may show `[sync.drain]` with stage/outcome/HTTP status only.
8. Optional: ADB pull `.sqlite` and open in plaintext SQLite viewer (must fail).

Do not mark SYNC01–SYNC06 / S23 / NFR05 / JRN07 **VERIFIED** until this combined pass is recorded.

### Partial commercial physical evidence — Android EAS development client (2026-09-20)

Recorded on the same SQLCipher development client after D-021/D-022/D-023 JS fixes (Metro reload). Status for the commercial slice remains **IMPLEMENTED**, not combined **VERIFIED**.

| Check | Result |
| --- | --- |
| Quote draft **Saved on this device** | PASS |
| Draft survived force-close / relaunch | PASS |
| Hydration kept pending local draft (no silent server overwrite) | PASS |
| Manual Settings → Synchronize after reconnect | PASS (authenticated PATCH, HTTP 200 ack) |
| Settings sync status showed synchronized after ack | PASS |

Deferred / not yet recorded on device (do not invent evidence):

- Offline job creation and restart
- Publish blocked while offline
- Automatic reconnect drain without pressing Synchronize
- Dual-device 409 Keep server / Save local copy
- Sign-out Stay / Synchronize / Discard (including wipe confirmation)
- Combined QA05–QA08 pass
- Optional ADB normal-SQLite plaintext inspection

External note: intermittent Supabase Session Pooler `ETIMEDOUT` on port 5432 (`sslmode=require`) is a network-routing issue and is not SYNC01 verification evidence. Do not change pooler port or timeout architecture for this slice.

## S12 owner request controls — Android development build (2026-09-21)

Physical evidence on a development-build Android operator client. Status remains **IMPLEMENTED**, not **VERIFIED**. Do not treat this as iOS/TestFlight, production SPF/DKIM, or full QA21 parallel-race evidence.

| Check | Result |
| --- | --- |
| Resend: replacement email received | PASS |
| Resend: new link opened the correct quote | PASS |
| Immediate second resend blocked | PASS |
| Resend: no worker database error | PASS |
| Replace-link: returned to the same request after one OTP | PASS |
| Replace-link: success message displayed | PASS |
| Replace-link: replacement email received | PASS |
| Replace-link: previous link rejected | PASS |
| Replace-link: newest link opened the correct quote | PASS |
| Replace-link: `replace_succeeded` observed | PASS |
| Replace-link: repeated 403 loop stopped | PASS |
| Withdraw: confirmation displayed | PASS |
| Withdraw: status changed to Withdrawn | PASS |
| Withdraw: portal displayed “This review link is no longer available” | PASS |
| Withdraw: withdrawal email received | PASS |
| After withdraw: Resend unavailable | PASS |
| After withdraw: Replace link unavailable | PASS |
| Withdraw: no worker database error | PASS |

The later visual restyle of S12 is covered by `apps/mobile/src/quotes/request-actions.test.ts` for presentation, permitted actions, idempotency reuse, offline, and access expiry. That suite does not replace the Android evidence above and does not verify production email delivery.

S13 extra-work presentation, integer-cent totals, validation, idempotency retention, stale-response checks, offline preview blocking, and access-expired hiding are covered by `apps/mobile/src/changes/presentation.test.ts`. That suite does not verify a physical device, staging publication, or customer delivery. The API change-order contract remains `apps/api/src/changes.test.ts`.

S14 reduction presentation in the same file covers source-line net credits, tax, the accepted-amount boundary, incompatible extra-work drafts, and offline preview blocking. It does not verify a physical device or staging publication.

S15 invoice preview presentation in `apps/mobile/src/invoices/presentation.test.ts` covers integer-cent totals, hidden invoice numbers before allocation, recipient validation, idempotency retention, PDF versus delivery phases, offline blocking, and access-expired hiding. It does not verify a physical device, PDF generation, or email delivery.

S16 invoice detail presentation in the same file covers the server invoice number, integer-cent totals, masked recipients, PDF and delivery phases, permitted actions, the absence of an invoice resend route, void-reason validation, retention of the original invoice, and a distinct replacement number. It does not verify device PDF, email, void, or replacement.

S17 payment presentation in `apps/mobile/src/invoices/payment.test.ts` covers integer-cent parsing, zero and negative amounts, partial and exact payments, explicit overpayment confirmation, date and method and reference rules, review-before-submit, idempotency reuse, balance-change revalidation, offline and void blocking, access-expired hiding, and server-status navigation. It does not verify a physical device or a staging ledger entry.

Refund recording in the same file covers the server refundable balance, partial and exact refunds, over-refund rejection, date and method and reference rules, review-before-submit, idempotency, a changed refundable balance, and the distinction from a reversal. It does not verify a physical device or a staging ledger entry.

S18 credit-note presentation in `apps/mobile/src/invoices/credit-note.test.ts` covers integer-cent line caps, reason rules, preview-before-issue, idempotency, refund-due credits, PDF phases, and separation from refund, reversal, and void. It does not verify a physical device, staging issuance, or PDF generation.

Still unverified after this pass:

- Full QA21 parallel race/stress testing
- Production SPF/DKIM verification
- iOS / TestFlight evidence
- TX06 revoke-after-approve
- Any scenario not physically executed above

### Physical evidence — invoice issue (2026-09-21)

Quote-based invoice preview and issue passed on device. Status remains **IMPLEMENTED**, not **VERIFIED**. Do **not** modify or retry invoice `INV-000001`.

| Check | Result |
| --- | --- |
| Invoice preview | PASS |
| Invoice issue | PASS |
| PDF readiness | NOT VERIFIED (intermittent network/database) |
| PDF open/share | NOT VERIFIED (intermittent network/database) |
| EMAIL06 delivery | NOT VERIFIED (intermittent network/database) |
| Worker completion | NOT VERIFIED (intermittent network/database) |
| Record payment / refund (S17) | NOT VERIFIED |

## Customer slice

Automated evidence is IMPLEMENTED, not VERIFIED. Do not mark QA03, QA08, QA14, QA55, or QA61 complete from these tests alone. Hosted `APPLY_0027` is not dispatched. Physical iPhone and VoiceOver remain open.

| Check | Evidence |
| --- | --- |
| Schema, email normalization, E.164, postal_code | `packages/schemas/src/customer.test.ts` |
| API envelopes, idempotency, duplicate confirmation, archive, delete, cross-tenant 404, job binding, issued snapshot bytes | `apps/api/src/customers.test.ts` |
| Privilege, tenant isolation, FORCE RLS | `supabase/tests/0028_customers.sql` via `pnpm test:db` |
| Mobile form, offline denial, accessibility state | `apps/mobile/src/customers/form.test.ts` |
| S19 list and detail presentation | `apps/mobile/src/customers/list.test.ts` |
| S20 list, validation, archive, copy-on-use | `apps/mobile/src/items/list.test.ts`; `apps/mobile/src/items/form.test.ts` |
| S22 overview, email privacy, sync honesty, sign-out sheets | `apps/mobile/src/settings/presentation.test.ts`; `apps/mobile/src/session/sign-out.test.ts`. Local automated evidence only. Does not verify QA05, QA06, QA15, QA02, or physical secure storage. |
| Customer mutations excluded from SYNC01 | `apps/mobile/src/sync/sync01.test.ts` |
| OpenAPI | `pnpm validate:openapi` |
| S24 export, deletion, grants, and outbox exclusion | `apps/mobile/src/export/presentation.test.ts`; `apps/mobile/src/deletion/presentation.test.ts`; `apps/mobile/src/sync/sync01.test.ts`. Local presentation evidence only. Does not verify QA55 ZIP bytes, QA56 download, QA57 purge, QA58 restore, QA61 VoiceOver or Dynamic Type, QA13 completion rights, or QA66 object restore. |
| Hosted workflow phrase | `node scripts/hosted-development-migrations.workflow.test.mjs` |

## Setup slice commands

```sh
pnpm --filter @job-to-invoice/schemas test
pnpm --filter @job-to-invoice/api test
pnpm --filter @job-to-invoice/mobile test
pnpm test:db
pnpm validate:openapi
```
