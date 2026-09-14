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
| Settings logout | ACC02 | — |

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
| QA07 | Two phones edit same monetary field | 409; both copies; no LWW | Integration |
| QA08 | Replay draft operation 20 times | One mutation; stable version | Integration |
| QA09 | Publish timed out after commit and retried | One number, slot, request, outbox | Integration |
| QA10 | Fourth new free job | Paywall; draft kept; first three completable. Stage 2 integration against real `job_allowances` (no RevenueCat). No stub path. | Integration + E2E |
| QA11 | Trial replay/reinstall/email change | Original expiry/cap; no billing | Integration |
| QA12 | Trial expires during pending approval | Customer can approve; owner can finish | Integration |
| QA13 | Paid owner downgrades with jobs | Completion/export; new-job gate | E2E |
| QA14 | Reset customer/site of published job | Blocked; new job required | API |
| QA15 | Edit catalogue price and business address | Issued docs unchanged | Integration |
| QA16 | Publish replacement while old pending | Old superseded; one pending index | Concurrency |
| QA17 | Old recipient follows replaced link | Cannot decide; correct message. Revoke-after-approve leaves `approval_decisions` intact (TX06). | Portal |
| QA18 | Link forwarded to unrelated person | No scope without bound-email code | Portal |
| QA19 | OTP brute force and resends | Limits; no raw codes logged | Isolation |
| QA20 | Approve twice concurrently | One decision and one scope apply | Concurrency |
| QA21 | Approve and withdraw race | One terminal outcome; loser conflict | Concurrency |
| QA22 | Approve 1 ms after expiry | Rejected despite worker lag | Concurrency |
| QA23 | Opened before expiry, approved after | Rejected; no cached authority | Portal |
| QA24 | Consent unticked or hash altered | Rejected | Portal |
| QA25 | Declined quote revised and resent | New revision; old decision kept | E2E |
| QA26 | Accepted quote edited directly | Immutable write rejected API and DB, including `document_lines` and original PDF artifact | Integration |
| QA27 | Addition then approved reduction | Ledger accurate; sources visible | Integration |
| QA28 | Two reductions exceed remaining | Later invalid rejected atomically | Concurrency |
| QA29 | F05 and F06 | Exact tax and cap | Domain |
| QA30 | F01–F12 mobile/server/PDF | Exact matching cents | Domain + PDF |
| QA31 | Invoice with pending or draft change | Block with resolution | API |
| QA32 | Invoice raced with change publish | No inconsistent scope/invoice | Concurrency |
| QA33 | PDF worker crashes after invoice commit | Invoice issued; one artifact; no dup number | Worker |
| QA34 | Email timeout after acceptance | Reconcile before retry | Worker |
| QA35 | Permanent bounce | Not delivered; suppression path | Integration |
| QA36 | Full scope reduced to zero | Zero invoice; no fake payment | Domain |
| QA37 | Manual partial/overpayment | Derived balance; overpay confirm | API |
| QA38 | Credit after full payment | Negative balance; refund due; no money moved | API |
| QA39 | Refund exceeds available | Rejected; partial refund works | API |
| QA40 | Reverse payment once and retry | One reversal; ledger correct. Replay after simulated 31-day ephemeral cache expiry still one `operation_id`. | API |
| QA41 | Reverse payment with dependent refund | Block or require correction | API |
| QA42 | Void with payment or issued credit | Rejected; history intact | API |
| QA43 | Unpaid void then replacement | New number; link; one active invoice | API |
| QA44 | Direct invoice without quote | No-prior-approval label; ordinary calc | E2E |
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
| QA59 | Staff access without owner grant | Metadata only; attempt audited | Isolation |
| QA60 | Staff grant expires/revoked | Content stops at next request | Isolation |
| QA61 | VoiceOver / Dynamic Type / keyboard / zoom | Core flows usable | Device |
| QA62 | Low disk during draft save | Failure; do not show Saved | Device |
| QA63 | Token in URL/error/analytics/referrer | Mailbox HTML uses `#` not `?token=`; after exchange logs contain only `token_hash`; no click-tracking rewrite | Isolation |
| QA64 | DST and timezone changes | Expiry invariant; due dates correct | Integration |
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

Missing named on-call contact blocks Stage 6 checklist only (owner §34 input). It is not invented here.
