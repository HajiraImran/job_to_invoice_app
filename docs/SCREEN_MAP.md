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
| S04 | Business setup | mobile | `/(onboarding)/setup` | Save three steps | JRN01 | `onboarding_completed` | First session |
| S05 | Jobs | mobile | `/(tabs)/jobs` | New job; open job | JRN01, JRN07 | — | Default tab |
| S06 | Create job | mobile | `/(tabs)/jobs/new` | Quote or Direct invoice | JRN01, JRN06 | `job_created` | S05 New job |
| S07 | Customer form | mobile | `/(tabs)/customers/[id]?` or sheet | Save contact | JRN01 | — | S06, S19 |
| S08 | Job overview | mobile | `/(tabs)/jobs/[id]` | Next action by state | All owner journeys | — | S05 |
| S09 | Quote editor | mobile | `/(tabs)/jobs/[id]/quote` | Edit lines | JRN01, JRN06, JRN07 | — | S06 Quote, revision |
| S10 | Line editor | mobile | `/(tabs)/jobs/[id]/line` | Save line | JRN01, JRN03, JRN06 | — | S09, S13 |
| S11 | Preview and publish | mobile | `/(tabs)/jobs/[id]/publish` | Confirm publish | JRN01 | `document_published` | S09 |
| S12 | Request detail | mobile | `/(tabs)/jobs/[id]/request` | Read-only delivery status (resend/withdraw/replace later) | JRN01–JRN04 | `request_delivery_result` | S08 |
| S13 | Extra work editor | mobile | `/(tabs)/jobs/[id]/change` | Publish extra | JRN03 | `change_started` | S08 after accepted quote |
| S14 | Reduction editor | mobile | `/(tabs)/jobs/[id]/reduce` | Publish reduction | JRN04 | `change_started` | S08 |
| S15 | Invoice preview | mobile | `/(tabs)/jobs/[id]/invoice` | Issue invoice | JRN05, JRN06 | `invoice_issued` | S08 |
| S16 | Invoice detail | mobile | `/(tabs)/jobs/[id]/invoice/[invoiceId]` | Share, pay, credit, void | JRN05 | `payment_recorded` | S08, S15 |
| S17 | Payment or refund | mobile | `/(tabs)/jobs/[id]/ledger/entry` | Confirm entry | JRN05 | `payment_recorded` | S16 |
| S18 | Credit note | mobile | `/(tabs)/jobs/[id]/credit` | Issue credit | JRN05 | — | S16 |
| S19 | Customers | mobile | `/(tabs)/customers` | Create / open | JRN01 | — | Tab |
| S20 | Items | mobile | `/(tabs)/items` | Add / archive | JRN01 | — | Tab |
| S21 | Subscription | mobile | `/(tabs)/settings/subscription` | Buy, restore, trial, manage | JRN01 slot, SUB | `paywall_viewed`, `trial_started`, `purchase_verified` | S11 ENTITLEMENT_REQUIRED |
| S22 | Settings | mobile | `/(tabs)/settings` | Defaults, support, sign out | — | `support_opened` | Tab |
| S23 | Conflict recovery | mobile | `/(modal)/conflict` | Keep server or save local copy | JRN07 | `sync_conflict` | VERSION_CONFLICT |
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

Email, Send code, passwordless explanation.

States: generic code-sent (no enumeration), throttled, network failure.

VAL01 email.

### S03 Verify code

Code, masked email, resend countdown, Change email. OS paste/autofill.

States: expired, incorrect, attempt limit.

### S04 Business setup

Three steps: name/trade; contact/address; timezone and document defaults. Back preserves data. Logo optional skip (upload is not in this slice; the owner must skip).

VAL01–VAL02. Default tax zero with “Confirm tax treatment for your business” (FIN02). Device IANA timezone is suggested and must be confirmed. Currency USD is displayed and not editable.

Implemented route: `/(onboarding)/setup`. Successful POST `/v1/workspace` routes to the S05 jobs list. S05/S06/S08 draft jobs, S09/S10 quote drafting, and S11 quote publish with original PDF download are implemented. Physical Expo Go (2026-09-16) generated and downloaded an original published-quote PDF in development (IMPLEMENTED evidence, not production VERIFIED). Email delivery and invoice editors are not.


### S05 Jobs

Search, Active/Finished/Archived, cards, New job, draft-sync badges, cursor pagination.

Empty: first-job prompt. Offline: local/cached jobs, “Searching downloaded jobs” for remote search (SYNC06).

### S06 Create job

Customer, site, title, Quote or Direct invoice. Customer sheet. No forced contacts permission.

VAL01–VAL02. Explicit No site address. Direct invoice path is JRN06.

### S07 Customer form

Name, email, optional phone, billing address.

Duplicate normalized-email warning; archived restore. Email mandatory for approval, optional for manual-share direct invoice (VAL01).

### S08 Job overview

Customer/site, scope total, current step, documents, activity. Next action varies by JOB01 state. No generic editable status.

Canceled jobs that retain a receivable must show it.

Implemented route: `/(tabs)/jobs/[id]`. Quote-mode drafts show Create/Open quote. Direct-invoice jobs do not enter the quote editor. No fake ledger totals.

### S09 Quote editor

Ordered line cards, Add item, notes, terms, expiry. Draft save indicators. Conflict recovery.

VAL03–VAL04. SYNC02 save copy. Offline publish disabled (NTF05).

Implemented route: `/(tabs)/jobs/[id]/quote`. Server-persisted editing draft; 500 ms debounce PATCH with If-Match. Review quote opens S11. Encrypted local SQLite is not in this slice.

### S10 Line editor

Description, quantity, unit, unit price, fixed discount, tax rate. Live subtotal/net/tax. Optional saved-item picker (copy, never live-link).

Line fields are edited on the S09 cards in this slice. Catalogue copy-on-use is not in this slice.

### S11 Preview and publish

Frozen-looking preview, expiry, confirm. Show slot/paywall before submit. Stale preview → PREVIEW_CHANGED.

Implemented route: `/(tabs)/jobs/[id]/publish`. Review uses `POST /drafts/{id}/preview`. Final confirm issues one `POST /drafts/{id}/publish` with `{preview_hash, recipient_email}` and an Idempotency-Key. Invalid email and API errors, including `Service unavailable.`, remain on the confirmation step with a single Back control that cancels confirmation. After success, mobile replaces to the job overview and refetches quote number, job state, PDF, and delivery. Physical Expo Go (2026-09-16) generated and downloaded an original published-quote PDF in development. That is IMPLEMENTED development evidence, not production VERIFIED. Live production delivery is not VERIFIED.

### S12 Request detail

Implemented route: `/(tabs)/jobs/[id]/request`. Read-only delivery status with masked recipient, quote number/revision, and states Loading, Queued, Sending, Accepted by email provider — not yet confirmed delivered, Delivered, Bounced, Complained, Failed, Offline, Retry status check. Retry issues one GET. Resend, withdraw, and replace remain later. Queued/accepted is not Delivered (NTF03).

### S13 Extra work editor

Only after accepted quote and before invoice. Reason, added lines, photos, old/change/new total.

### S14 Reduction editor

Eligible source line, net reduction, reason, tax/new total. Bound max. Block all-zero unless meaningful scope replacement with reason (CHG02).

### S15 Invoice preview

Source summary, lines, due date, instructions, issue. Block unresolved changes. Direct-invoice label (JRN06).

### S16 Invoice detail

PDF/share, issued total, credits, received/refunded/balance, ledger. Record payment, Credit, Record refund, Void if permitted.

Derived states: issued_unpaid, partially_paid, settled, overdue, refund_due, voided flag (BIL08).

### S17 Payment or refund

Amount, date, method, reference, confirmation. Overpayment warning. Refund maximum. Online only. NTF05 ledger warning.

### S18 Credit note

Select invoice lines, net credits, reason, preview/issue. Tax calculated. Cumulative caps. Irreversible issue warning.

### S19 Customers

Search/list, create, detail with jobs. Archive not destructive when referenced.

### S20 Items

Search/list, defaults, add/edit/archive. Changes never alter existing documents.

### S21 Subscription

Free usage/trial date, StoreKit monthly/annual prices, buy/restore/manage. States: pending, active, canceled-but-active, expired, refund, sync failure. Never show purchase success on cancel/pending.

### S22 Settings

Business defaults, notifications, support, privacy/export/deletion, sign out. Sensitive actions reauthenticate. Logo/address updates apply to future drafts only. Switching accounts locks and wipes the previous encrypted local database after unsynced-work confirmation (SYNC06).

### S23 Conflict recovery

Local vs server values and times. Keep server or Save local as draft copy. Preserve both copies. Never last-write-wins for amounts, recipients, terms or site identity (SYNC03). Pause that resource’s draft queue until the owner chooses. No automatic replacement of sent documents. Authoritative commands are never auto-issued from the offline queue (SYNC05). NTF05 conflict copy.

### S24 Export and deletion

Export status/download. Deletion consequences, type DELETE, progress, retained-record explanation. Reauthentication. Manage subscription shown; deletion does not cancel Apple billing (PRV03).

### S25 Customer access

Route is `/review` with the raw token only in the URL fragment (`#token`). Email and share links are exactly `{PORTAL_ORIGIN}/review#{token}`. Never a query parameter. Exchange via POST then clear the fragment. Business display name, document type, masked email, request/enter code. Invalid/expired/revoked → generic unavailable. No private scope before verification.

### S26 Customer review

Full snapshot, prices, attachments, consent/name, approve/decline. Requires ready original PDF. Unticked acknowledgement (APR04). States: loading, read-only decided, superseded, expired, revoked. view_only: no approve controls (API05).

### S27 Customer receipt

Decision/time/revision, downloads, business contact. Approval does not claim payment. view_only returns access metadata, not a consent receipt (API05).

### S28 Support console

Case lookup, bounded metadata, allowed operational actions. Staff MFA, reason required, access expires, immutable audit.

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
| CREDIT_EXCEEDS_SOURCE | S14 / S18 remaining amount |
| REFUND_EXCEEDS_BALANCE | S17 |
| ENTRY_ALREADY_REVERSED | S16 |
| ENTITLEMENT_REQUIRED | S21 |
| QUOTA_EXCEEDED | S21 / upload UI |
| ASSET_NOT_READY | S11 remove or retry |
| PURCHASE_ACCOUNT_MISMATCH | S21 |
| OPERATION_PENDING | Disable submit; poll |
| RATE_LIMITED | Retry-After |
| ACCOUNT_DELETING | S24 / support |

## Design deliverable

S01–S28 are required design frames and QA units. Matching Figma (or equivalent), core-flow prototype, and all state variants are part of the development contract (PRD §08). They are not claimed attachments to the PRD.
