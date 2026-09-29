> Source: `docs/PRD.md` §§06–08, 18 (NTF05), 27
> Routes are implementation mappings, not product changes.

# Screen map

## Navigation

Owner app (`apps/mobile`) has four bottom tabs: **Jobs**, **Customers**, **Items**, **Settings**. Jobs is the default. A prominent **New job** action stays on the Jobs screen. Do not use a floating control that obscures list content.

Job detail (S08) is one scrollable page: Overview, Documents, Activity. No dashboard of speculative revenue or “money recovered” claims.

Visual baseline: UI01–UI03 (San Francisco, 8 pt scale, navy `#17324D`, v1 light only, opt out of unsupported dark inversion). Portal: single column to 720 CSS px, usable at 320 CSS px and 200% zoom.

Every data screen implements UI04: loading, empty, loaded, refresh failure, offline, access-expired. Cached content stays visible during refresh with a timestamp. Inline validation keeps entered values and focuses the first invalid field. Retry only when safe.

## Required states (all data screens)

| State | Behaviour |
| --- | --- |
| Loading | Skeleton that does not shift primary controls dangerously |
| Empty | Explicit empty copy, not a blank list |
| Loaded | Current data |
| Refresh failure | Keep cache, show timestamp, Retry if safe |
| Offline | Cached read / local draft; disable live commands with NTF05 copy |
| Access-expired | Re-auth or generic unavailable; no private data leak |

## Owner app screens

| ID | Name | App | Route | Primary action | Journeys | Analytics | Opens on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S01 | Welcome | mobile | `/(public)/welcome` | Create my first quote; Sign in | JRN01 | — | Cold start, signed out |
| S02 | Email sign in | mobile | `/(public)/sign-in` | Send code | JRN01 | — | S01 Sign in / Create |
| S03 | Verify code | mobile | `/(public)/verify` | Submit code | JRN01 | `signup_verified` | S02 |
| S04 | Business setup | mobile | `/(onboarding)/setup` | Step 1 Basic info → in-wizard branding skip → Figma S06 timezone/defaults; save on last step | JRN01 | `onboarding_completed` | First session |
| S05 | Jobs | mobile | `/(tabs)/jobs` | New job; open job | JRN01, JRN07 | — | Default tab |
| S06 | Create job | mobile | `/(tabs)/jobs/new` | Quote or Direct invoice | JRN01, JRN06 | `job_created` | S05 New job |
| S07 | Customer form | mobile | `/(tabs)/customers/[id]?` or sheet | Save contact | JRN01 | — | S06, S19 |
| S08 | Job overview | mobile | `/(tabs)/jobs/[id]` | Next action by state | All owner journeys | — | S05 |
| S09 | Quote editor | mobile | `/(tabs)/jobs/[id]/quote` | Edit lines | JRN01, JRN06, JRN07 | — | S06 Quote, revision |
| S10 | Line editor | mobile | `/(tabs)/jobs/[id]/line` | Save line | JRN01, JRN03, JRN06 | — | S09, S13 |
| S11 | Preview and publish | mobile | `/(tabs)/jobs/[id]/publish` | Confirm publish | JRN01 | `document_published` | S09 |
| S12 | Request detail | mobile | `/(tabs)/jobs/[id]/request` | Status, resend, withdraw, replace-link | JRN01–JRN04 | `request_delivery_result` | S08 |
| S13 | Extra work editor | mobile | `/(tabs)/jobs/[id]/change` | Publish extra | JRN03 | `change_started` | S08 after accepted quote |
| S14 | Reduction editor | mobile | `/(tabs)/jobs/[id]/reduce` | Publish reduction | JRN04 | `change_started` | S08 |
| S15 | Invoice preview | mobile | `/(tabs)/jobs/[id]/invoice` | Issue invoice | JRN05, JRN06 | `invoice_issued` | S08 |
| S16 | Invoice detail | mobile | `/(tabs)/jobs/[id]/invoice/[invoiceId]` | Share, pay, credit, reverse, void, replace | JRN05 | `payment_recorded` `invoice_issued` | S08, S15 |
| S17 | Payment or refund | mobile | `/(tabs)/jobs/[id]/ledger/entry` | Confirm entry | JRN05 | `payment_recorded` | S16 |
| S18 | Credit note | mobile | `/(tabs)/jobs/[id]/credit` | Issue credit | JRN05 | — | S16 |
| S19 | Customers | mobile | `/(tabs)/customers` | Create / open | JRN01 | — | Tab |
| S20 | Items | mobile | `/(tabs)/items` | Add / archive | JRN01 | — | Tab |
| S21 | Subscription | mobile | `/(tabs)/settings/subscription` | Buy, restore, trial, manage | JRN01 slot, SUB | `paywall_viewed`, `trial_started`, `purchase_verified` | S11 ENTITLEMENT_REQUIRED |
| S22 | Settings | mobile | `/(tabs)/settings` | Defaults, support, sign out | — | `support_opened` | Tab |
| S23 | Conflict recovery | mobile | `/(tabs)/jobs/[id]/quote` | Keep server or save local copy | JRN07 | `sync_conflict` | VERSION_CONFLICT |
| S24 | Export and deletion | mobile | `/(tabs)/settings/data` | Export / type DELETE | PRV/EXP | `export_completed` | S22 |

## Portal and admin screens

| ID | Name | App | Route | Primary action | Journeys | Analytics | Opens on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S25 | Customer access | portal | `/review` (`#token` only; never `?token=`) | Request / enter code | JRN02–JRN04 | — | EMAIL01/02/06 `{PORTAL_ORIGIN}/review#{token}` |
| S26 | Customer review | portal | `/review/document` | Approve or decline | JRN02–JRN04 | `approval_completed` | After OTP |
| S27 | Customer receipt | portal | `/review/receipt` | Download receipt | JRN02 | — | After decision; view_only metadata (API05) |
| S28 | Support console | admin | `/cases` | Lookup, granted actions | SEC05 | — | Staff MFA |

## Screen contracts

### S01 Welcome

Promise, sample document, Create my first quote, Sign in, terms/privacy. No purchase prompt. Demo uses fictional data and cannot send.

States: loaded only (static). Network not required.

### S02 Email sign in

Back, secure-sign-in context, lock mark, email, Send code, passwordless and six-digit/ten-minute explanation. No Settings.

States: generic code-sent (no enumeration), throttled, network failure, invalid email.

VAL01 email.

### S03 Verify code

Back, secure-verification context, shield mark, Check your email, PRD generic sent copy, masked email, six visual cells over one accessible input, paste guidance, resend countdown, Verify code, Change email, ten-minute note. No Settings. Explicit verify; no auto-submit.

States: empty/partial/complete, focused, loading, expired, incorrect, attempt limit, network/offline, resend cooldown/available/success/failure.

### S04 Business setup

Approved Figma node `31:4` is wizard step 1 (Basic info, 33%). Figma `39:5` / `39:65` is wizard step 3 (Timezone & defaults, 100%). PRD still requires legal name, trade, timezone confirmation, and logo skip. Contact and address live on step 1 with the authenticated owner email shown read-only/verified. Continue to branding advances in-route to the existing skip-logo step; there is no Branding screen. Step 3 uses a searchable timezone sheet, locked USD, integer tax basis points, due-day chips, and optional terms. POST `/v1/workspace` happens only after timezone/defaults. Back on later steps preserves data and does not return to OTP. Logo optional skip (upload is not in this slice; the owner must skip).

VAL01–VAL02. Default tax zero with “Confirm tax treatment for your business” (FIN02). Device IANA timezone is suggested and must be confirmed. Currency USD is displayed and not editable.

Implemented route: `/(onboarding)/setup`. Successful POST `/v1/workspace` routes to the S05 jobs list. S05/S06/S08 draft jobs, S09/S10 quote drafting, and S11 quote publish with original PDF download are implemented. Physical Expo Go (2026-09-16) generated and downloaded an original published-quote PDF in development (IMPLEMENTED evidence, not production VERIFIED). Email delivery and invoice editors are not. Figma `31:4` pixel match is unverified (no Figma MCP).


### S05 Jobs

Search, Active/Finished/Archived, cards, New job, draft-sync badges, cursor pagination.

Empty: first-job prompt. Offline: local/cached jobs, “Searching downloaded jobs” for remote search (SYNC06).

### S06 Create job

Figma `48:5` / `48:63`: billing-mode cards (Quote recommended, Invoice without a quote), searchable active-customer sheet, No site address by default, job title, sticky Continue to line items. Online active-customer search and Add a new customer. Offline keeps the customer name field. No forced contacts permission.

Implemented route: `/(tabs)/jobs/new`. Online quote continues to S09; online direct invoice continues to S15. Offline create still lands on S08. Figma pixel match unverified (no Figma MCP).

VAL01–VAL02. Explicit No site address. Direct invoice path is JRN06.

### S07 Customer form

Name, email, optional phone, billing address.

Duplicate normalized-email warning; archived restore. Email mandatory for approval, optional for manual-share direct invoice (VAL01).

Implemented routes: `/(tabs)/customers/new` and `/(tabs)/customers/[id]/edit`. Online only. Primary actions are at least 48 pt. Not VERIFIED on device or VoiceOver.

### S08 Job overview

Customer/site, scope total, current step, documents, activity. Next action varies by JOB01 state. No generic editable status.

Canceled jobs that retain a receivable must show it.

Implemented route: `/(tabs)/jobs/[id]`. Quote-mode drafts show Create/Open quote. After publish, S08 shows quote lifecycle (`issued` / `accepted` / `declined` / `expired` / `superseded` / `withdrawn`) from GET `/v1/jobs/{id}` on focus refresh. Declined/expired/superseded quotes can open a revision. After an unpaid void, S08 offers view of the voided invoice and Create replacement. Direct-invoice drafts show Create invoice and do not enter the quote editor. Draft jobs can be deleted. Active and invoiced jobs can be canceled with a reason; pending approvals are withdrawn. Canceled jobs offer Create linked job and show a remaining receivable. Invoiced jobs with a settled invoice can be finished. Non-draft jobs can be archived when no approval is pending, and archived jobs can be restored. No fake ledger totals.

### S09 Quote editor

Ordered line cards, Add item, notes, terms, expiry. Draft save indicators. Conflict recovery.

VAL03–VAL04. SYNC02 save copy. Offline publish disabled (NTF05).

Implemented route: `/(tabs)/jobs/[id]/quote`. Server-persisted editing draft; 500 ms debounce PATCH with If-Match. Review quote opens S11. Encrypted local SQLite is not in this slice.

### S10 Line editor

Description, quantity, unit, unit price, fixed discount, tax rate. Live subtotal/net/tax. Optional saved-item picker (copy, never live-link).

Line fields are edited on the S09 cards. Use saved item copies catalogue defaults into a new line and never stores a live catalogue id.

### S11 Preview and publish

Frozen-looking preview, expiry, confirm. Show slot/paywall before submit. Stale preview → PREVIEW_CHANGED.

Implemented route: `/(tabs)/jobs/[id]/publish`. Review uses `POST /drafts/{id}/preview`. Final confirm issues one `POST /drafts/{id}/publish` with `{preview_hash, recipient_email}` and an Idempotency-Key. Invalid email and API errors, including `Service unavailable.`, remain on the confirmation step with a single Back control that cancels confirmation. After success, mobile replaces to the job overview and refetches quote number, job state, PDF, and delivery. Physical Expo Go (2026-09-16) generated and downloaded an original published-quote PDF in development. That is IMPLEMENTED development evidence, not production VERIFIED. Live production delivery is not VERIFIED.

### S12 Request detail

Implemented route: `/(tabs)/jobs/[id]/request`. Delivery status plus owner Resend (NTF04), Withdraw (reason confirm), and Replace-link (fresh OTP → ACC02A grant → rotate). The screen shows the masked recipient, server delivery and request state, and activity only from `created_at`, `last_event_at`, `decided_at`, and a document issue date when `GET /v1/documents/{id}` returns one. Quote total and customer name appear only from that document response. Resend and withdraw reuse one `Idempotency-Key` until success or `IDEMPOTENCY_MISMATCH`. Resend queues a new review email and older links stop working. Online-only mutations; never queued in SYNC01 outbox. Queued/accepted is not Delivered (NTF03). The 2026-09-21 Android pass remains the device evidence. The visual restyle is not a new device pass. Live production email is not VERIFIED.

### S13 Extra work editor

Only after accepted quote and before invoice. Reason, added lines, old/change/new total.

Implemented route: `/(tabs)/jobs/[id]/change`. Online-only server draft via `POST /v1/jobs/{id}/changes` and `PATCH /v1/drafts/{id}` with `If-Match`. Accepted amount is `previous_total_cents`. Quote number comes from `GET /v1/jobs/{id}` when present. Review stays on this route. Continue saves, previews, then publishes through the existing draft preview and publish endpoints and returns to S08. There is no separate extra-work preview route and no offline draft. Photos/DOC03 excluded. Publishing is never queued in SYNC01 outbox. The visual restyle is not a device pass. Not VERIFIED on device.

### S14 Reduction editor

Eligible source line, net reduction, reason, tax/new total. Bound max. Block all-zero unless meaningful scope replacement with reason (CHG02).

Implemented route: `/(tabs)/jobs/[id]/reduce`. Same change draft as S13, but a draft that already contains additions is left unchanged and is not edited as a reduction. Reductions are positive `net_credit_cents` against approved source lines. Tax is calculated from the source. Preview and publish stay on the existing draft routes. Online only. Not VERIFIED on device.

### S15 Invoice preview

Source summary, lines, due date, instructions, issue. Block unresolved changes. Direct-invoice label (JRN06).

Implemented route: `/(tabs)/jobs/[id]/invoice`. Online-only quote-based residual preview, confirmation sheet, then issue. After issue the screen stays on S15 and polls `GET /v1/documents/{id}` and `GET /v1/documents/{id}/download` every 3 seconds, up to 20 times, while the PDF is preparing. Check again repeats that read. There is no PDF regenerate endpoint, so the failed state does not offer Retry PDF. Back to job uses `replace` to S08. An invoice that already exists on entry still opens S16. Direct-invoice jobs still edit lines, acknowledgement, due date, and optional customer email on the existing direct editor, then freeze via `/drafts/{id}/preview` and issue via `/jobs/{id}/issue-invoice`. Quote preview cannot change the recipient; issue accepts only `preview_hash`. Device 2026-09-21: quote preview and issue passed. This visual restyle, direct path, PDF readiness/open/share, EMAIL06, and worker completion are NOT VERIFIED. Do not retry INV-000001.

### S16 Invoice detail

PDF/share, issued total, credits, received/refunded/balance, ledger. Record payment, Credit, Record refund, Void if permitted.

Derived states: issued_unpaid, partially_paid, settled, overdue, refund_due, voided flag (BIL08).

Implemented route: `/(tabs)/jobs/[id]/invoice/[invoiceId]`. Issued, delivery-failed, and voided states use the server invoice number, integer-cent total, masked recipient, PDF state, and delivery state. There is no invoice resend endpoint, so Send again is hidden. Void still opens `invoice/void` with a required reason and idempotency. Replacement opens `invoice/replace` only when the job’s `permitted_actions` include `create_replacement`. A void keeps the original total. PDF download polls every 3 seconds, at most 20 times, while preparing. Ledger, payment, refund, credit, and reversal stay available when the existing server fields allow them. Device 2026-09-21: preview/issue passed; this restyle, PDF/share, EMAIL06, worker, reversal, void, and replacement are NOT VERIFIED. Do not retry INV-000001.

### S17 Payment or refund

Amount, date, method, reference, confirmation. Overpayment warning. Refund maximum. Online only. NTF05 ledger warning.

Implemented route: `/(tabs)/jobs/[id]/ledger/entry`. Payment entry, field validation, review, and a recorded state stay on this route. The amount, date, method, reference, and note use the ledger schema. Integer cents only. Mark paid opens the form with the current amount due; Record payment does not prefill it. Review does not post. Record payment posts once to `POST /v1/invoices/{id}/payments` with an idempotency key. An amount above the outstanding balance requires explicit `confirm_overpayment` and is not capped. The recorded state uses the payment response amount, status, and balance. Paid in full appears only when that status is `settled`. Partially paid appears only when that status is `partially_paid`. View invoice returns to S16. Back to job returns to S08. Refunds stay on this route with the refund maximum. Online only. Never queued in SYNC01 outbox. Reverse is S16. Not VERIFIED on device.

Refund recording uses the same route with `kind=refund` and the frames `153:5`, `153:36`, `153:68`, and `153:98`. The amount stays empty unless a route explicitly prefills it. Review refund does not post. Record refund posts once to `POST /v1/invoices/{id}/refunds`. An amount above `amount_to_refund_cents` is rejected and is not capped. Partial and fully refunded labels come from the server remainder. A refund does not reverse or delete a payment. Online only. Not VERIFIED on device.

### S18 Credit note

Implemented route: `/(tabs)/jobs/[id]/credit`. Frames `158:5`, `158:36`, `158:68`, and `158:98`. The owner credits remaining net on invoice lines. Tax is calculated by the server. Reason is required, 5 to 500 characters. There is no effective date or note field on the credit schema. Review posts `POST /v1/invoices/{id}/credits/preview` and does not issue. Issue posts `POST /v1/invoices/{id}/credits` with `preview_hash` and an idempotency key. A line amount above the remaining net is rejected. A credit that leaves a negative balance is allowed when the line remainder allows it, because that is refund due. The issued number, total, and PDF state come from the server. View credit note opens a ready download only. Back returns to S16. Online only. Not VERIFIED on device.

### S19 Customers

Search/list, create, detail with jobs. Archive not destructive when referenced.

Implemented route: `/(tabs)/customers`. Frames `167:5`, `167:50`, `167:76`, `167:95`, and `167:129`. Search, Active, Archived, and All stay on `GET /v1/customers` with cursor pagination. A failed refresh keeps the last successful rows for that search and filter. Offline hides records and Create. Access expiry clears protected data and the existing guard returns to sign-in. Detail is `/(tabs)/customers/[id]` via `GET /v1/customers/{id}` and `GET /v1/jobs?customer_id=`. Job rows show title and lifecycle. Amounts are omitted because the job list does not return them. List rows mask email or phone and omit job counts unless the response includes them. Create and edit stay on S07. Archive and restore use `POST /v1/customers/{id}/archive` without If-Match. Delete uses `DELETE /v1/customers/{id}` after confirmation. A referenced 409 keeps the customer and explains that delete is unavailable. Online only. Not VERIFIED on device. Hosted `APPLY_0027` is not dispatched.

### S20 Items

Search/list, defaults, add/edit/archive. Changes never alter existing documents.

Implemented route: `/(tabs)/items`. Frames `170:6`, `170:72`, `170:94`, `170:111`, and `170:152`. Search is debounced. Active is the default filter. Cursor pagination stays bound to search and state. A failed refresh keeps the last successful rows for that search and filter. Offline hides records and Add. Access expiry clears previously loaded rows and the existing guard returns to sign-in. Add is `/(tabs)/items/new`. Edit, archive, and restore are `/(tabs)/items/[id]` with If-Match. Archive and restore ask for confirmation. There is no item delete. Workspace setup seeds five zero-price examples. Copy-on-use stays on the S10 and S15 picker and does not store a catalogue id. Online-only mutations; never queued in SYNC01 outbox. Not VERIFIED on device. Hosted `APPLY_0020` is not applied.

### S21 Subscription

Implemented route: `/(tabs)/settings/subscription`. Free usage and app-managed 14-day trial start/status (`0023_app_managed_trial.sql`). StoreKit monthly/annual prices, buy/restore/manage, and paid billing states remain later. Never show purchase success on cancel/pending.

### S22 Settings

Business defaults, notifications, support, privacy/export/deletion, sign out. Sensitive actions reauthenticate. Logo/address updates apply to future drafts only. Switching accounts locks and wipes the previous encrypted local database after unsynced-work confirmation (SYNC06).

Implemented overview: `/(tabs)/settings`. Frames `175:6`, `175:48`, `175:93`, `175:136`, `175:185`, and `175:217`. Account email comes from bootstrap display email. Access expiry hides the email, synchronization details, and child-route rows; the root guard returns to the public flow. Synchronize is shown only when a draft controller can run. Sign-out uses a bottom sheet: stay, synchronize then sign out, or discard local drafts. Ordinary sign-out does not erase drafts. There is no workspace profile editor. Not VERIFIED on device.

Implemented support route: `/(tabs)/settings/support`. Owner files a case with category, message, and optional 24-hour content grant. Online only. No 24-hour reply claim. Public support address is shown only when `SUPPORT_URL` is configured. S28 staff console is BLOCKED.

### S23 Conflict recovery

Rendered inline on `/(tabs)/jobs/[id]/quote` when that quote draft is in `sync_state = conflict`. There is no `/(modal)/conflict` route and no conflict list. Frames `189:21`, `189:53`, and `189:88`. The screen does not show customer, job, money, lines, versions, devices, timestamps, or a field comparison, because a 409 response does not include the server draft. Keep server fetches `POST /v1/jobs/{id}/quote` and then applies that full draft locally. Save local copy stores the shelved local payload under a new local id. Offline save leaves the original conflict and paused outbox in place. Access expiry hides draft content and does not start its own sign-in navigation. Back returns to `/(tabs)/jobs/[id]` without resolving. NTF05 sentence is exact. Not VERIFIED on device. Dual-device QA07, hosted 409, physical SQLCipher, VoiceOver, and Dynamic Type remain open. See D-044.

### S24 Export and deletion

Implemented route: `/(tabs)/settings/data`. Frames `195:36`, `195:75`, `195:110`, `195:147`, `195:178`, `195:206`, `195:243`, and `195:284`. Overview, preparing, ready, fresh six-digit verification, exact `DELETE` confirmation, locked/purging/completed/exception status, offline, and access expired. Export uses an export action grant, then one `POST /v1/exports` (`{}` or `{ newer: true }`), and polls every 2.5 seconds until ready, failed, or expired. Download opens the authenticated URL outside the app and does not display the URL, hash, byte count, or a fabricated expiry. A failed refresh keeps the last loaded bundle. Deletion uses a deletion grant and `{ "confirmation": "DELETE" }`. There is no in-app cancel. Manage subscription opens `https://apps.apple.com/account/subscriptions`. Empty `retained_categories` stays empty. Access expiry hides export, download, deletion, grant, and commercial details and does not start its own sign-in navigation. Mobile does not emit `export_completed`. Not VERIFIED: hosted `APPLY_0024` and `APPLY_0025`, a real ZIP, EMAIL10/EMAIL11 mailboxes, 1000-job timing, QA58 restore, provider deletion, VoiceOver, Dynamic Type, and a physical device. See D-045.

### S25 Customer access

Implemented route: `/review` (`#token` only; never `?token=`). Email and share links are exactly `{PORTAL_ORIGIN}/review#{token}`. Exchange via POST through the portal BFF, then `history.replaceState` drops the fragment. Business display name, document type, masked email, request/enter code. Invalid/expired/revoked → generic unavailable. No private scope before verification.

### S26 Customer review

Implemented route: `/review/document`. Full snapshot, prices, consent/name, approve/decline. Change orders show previous/change/new totals and APR04 change consent. Requires ready original PDF. Unticked acknowledgement (APR04). States: loading, read-only decided, superseded, expired, revoked. view_only: no approve controls (API05).

### S27 Customer receipt

Implemented route: `/review/receipt`. Decision/time/revision, PDF download, no payment claim. view_only returns access metadata, not a consent receipt (API05).

### S28 Support console

Case lookup, bounded metadata, allowed operational actions. Staff MFA, reason required, access expires, immutable audit. **BLOCKED:** staff authentication, MFA, roles, and `STAFF_AUTH_CONFIG` are unavailable.

## Error-code to screen

| Code | Screen / resolution |
| --- | --- |
| VALIDATION_FAILED | Inline on current form |
| VERSION_CONFLICT | S23 |
| PREVIEW_CHANGED | S11 / S15 regenerate |
| SCOPE_CHANGED | S13/S14 rebase |
| APPROVAL_PENDING | S12 |
| REQUEST_EXPIRED | S25/S26 NTF05 expired copy |
| REQUEST_UNAVAILABLE | S25 generic |
| ALREADY_DECIDED | S27 |
| UNRESOLVED_CHANGES | S15 / S08 |
| DOCUMENT_IMMUTABLE | S08 permitted path |
| JOB_NOT_ARCHIVABLE | S08 archive/restore |
| JOB_NOT_FINISHABLE | S08 finish after settlement |
| CREDIT_EXCEEDS_SOURCE | S14 / S18 remaining amount |
| REFUND_EXCEEDS_BALANCE | S17 |
| ENTRY_ALREADY_REVERSED | S16 |
| ENTITLEMENT_REQUIRED | S21 |
| EXPORT_LIMIT | S24 |
| QUOTA_EXCEEDED | S21 / upload UI |
| ASSET_NOT_READY | S11 remove or retry |
| PURCHASE_ACCOUNT_MISMATCH | S21 |
| OPERATION_PENDING | Disable submit; poll |
| RATE_LIMITED | Retry-After |
| ACCOUNT_DELETING | S24 / support |

## Design deliverable

S01–S28 are required design frames and QA units. Matching Figma (or equivalent), core-flow prototype, and all state variants are part of the development contract (PRD §08). They are not claimed attachments to the PRD.
