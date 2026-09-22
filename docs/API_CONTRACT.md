> Source: `docs/PRD.md` §§21–23, ACC02A, API04, API05
> D-002 Resolved: both ACC02A `POST /account/action-grants` and every §22 route are required.
> Implemented owner routes use the `/v1` prefix documented in `openapi/v1.json`. S12 request controls and ACC02A `replace_link` grants are specified there; inventory rows without OpenAPI paths remain unimplemented.

# API contract

Base `/v1`, JSON UTF-8, HTTPS only.

## Conventions (API01–API03)

| Actor | Auth | Mutations |
| --- | --- | --- |
| Owner | Bearer access token | Idempotency-Key UUID + request ID; draft PATCH also If-Match |
| Portal | HttpOnly scoped cookie + X-CSRF-Token | Idempotency-Key + request ID |
| Staff | Separate staff auth + MFA | Reason required |
| Provider webhooks | Signature / webhook secret | Durable persist before ack |

- Reused idempotency key with a different body → 409 IDEMPOTENCY_MISMATCH
- Financial `operation_id` uniqueness is permanent on both `idempotency_records` (`permanence=financial`, never expires) and the money/effect row. Only non-financial cached response bodies expire at 30 days. Replay after cache expiry must return the original financial result, never a second write.
- Success: `{data, meta:{request_id, server_time}}`
- Lists: `items`, `next_cursor`; default 25, max 100; descending `(updated_at, id)`; cursor bound to filters
- Error: `{error:{code, message, field_errors, retryable}, meta:{request_id}}`
- No stack traces, SQL, provider tokens or tenant existence
- Unknown request fields rejected
- Client cannot set calculated totals, tenant ownership, approval state, invoice paid state, server issue time or entitlement
- Dates `YYYY-MM-DD`; timestamps ISO8601 with Z; currency `USD`
- Snapshot responses include server totals, `schema_version`, version or revision ID, digest where applicable

| HTTP | Meaning |
| --- | --- |
| 202 | Asynchronous accepted |
| 401 | Unauthorized |
| 403 | Permission / entitlement |
| 404 | Not found (also cross-tenant) |
| 409 | Stale / state conflict |
| 422 | Validation |
| 429 | Rate limit + Retry-After |
| 5xx retryable | May still be committed; resolve operation before replay |

## Draft payloads

Quote draft: `job_id`, `customer_snapshot {name,email?,phone?,billing_address?}`, `site_snapshot?`, `public_notes`, `terms`, `expiry_date`, `lines[]`.

Line: `client_line_id`, `description`, `quantity` (decimal string), `unit`, `custom_unit_label?`, `unit_price_cents`, `discount_cents`, `tax_bp`, `asset_ids[]`.

Internal notes live on the job only.

Change draft: `reason`, `expected_scope_version`, `additions[]`, `reductions[] {source_line_id, net_credit_cents}`, public asset IDs.

Direct invoice draft: normal lines, `direct_invoice true`, issue acknowledgement true, `due_date`, `payment_instructions`.

Quote-based invoice preview: no editable line prices; generated from scope.

Credit draft: `invoice_id`, `reason`, `allocations[] {invoice_line_id, net_credit_cents}`.

Payment body: `amount_cents`, `effective_date`, `method`, `reference?`, `note?`, `confirm_overpayment` default false.

Owner business snapshot is applied at publish from the reviewed preview. Defaults changing between preview and publish → 409 PREVIEW_CHANGED.

## Example request (unchanged from PRD)

`POST /v1/jobs/{job_id}/changes` with Idempotency-Key creates or reuses the editing change-order draft. It does not publish, email or approve. Line items, reason, and expected scope version are saved with `PATCH /v1/drafts/{id}` and If-Match. Preview and publish use the existing `/v1/drafts/{id}/preview` and `/v1/drafts/{id}/publish` routes and dispatch on `kind=change`.

```json
{
  "expected_scope_version": 1,
  "reason": "Customer requested replacement of a second handle",
  "additions": [{
    "client_line_id": "11111111-1111-4111-8111-111111111111",
    "description": "Supply and fit second door handle",
    "quantity": "1.000",
    "unit": "item",
    "unit_price_cents": 8500,
    "discount_cents": 0,
    "tax_bp": 0,
    "asset_ids": []
  }],
  "reductions": []
}
```

The UUID is fictional fixture data. Publish is a separate command binding `preview_hash`, recipient email and expiry. Replacing a pending quote also requires `replace_pending_request_id`.

## Error codes

| Code | Trigger | UI |
| --- | --- | --- |
| VALIDATION_FAILED | Invalid field or amount | Inline; keep draft |
| VERSION_CONFLICT | Stale mutable row | S23 |
| PREVIEW_CHANGED | Defaults or snapshot differ | Regenerate preview |
| SCOPE_CHANGED | Accepted scope version changed | Rebase change |
| APPROVAL_PENDING | Another request exists | S12 |
| REQUEST_EXPIRED | Commercial expiry passed | Owner creates revision |
| REQUEST_UNAVAILABLE | Revoked/unknown token | Generic unavailable |
| ALREADY_DECIDED | Terminal decision exists | S27, no new write |
| UNRESOLVED_CHANGES | Draft/pending changes at invoice | Resolve first |
| DOCUMENT_IMMUTABLE | Edit after publication | Revision/credit path |
| CREDIT_EXCEEDS_SOURCE | Reduction/credit over remaining | Show remaining |
| REFUND_EXCEEDS_BALANCE | Refund above refundable | Show maximum |
| ENTRY_ALREADY_REVERSED | Duplicate correction | Show original reversal |
| ENTITLEMENT_REQUIRED | New-job publication not entitled | S21 |
| QUOTA_EXCEEDED | Trial/fair-use/storage cap | Explain cap |
| ASSET_NOT_READY | Photo unfinished/rejected | Retry or remove |
| PURCHASE_ACCOUNT_MISMATCH | Restore belongs to another identity | Sign-in/support |
| OPERATION_PENDING | Command unresolved | Poll; disable duplicate |
| RATE_LIMITED | Abuse threshold | Retry-After |
| ACCOUNT_DELETING | Workspace locked for purge | Deletion status only |

## Endpoint inventory

All commands inherit authorization, idempotency, versioning, limits and errors. This is the minimum implementation contract, not raw CRUD on immutable tables.

### Action grants (ACC02A, D-002 Resolved)

Both texts are required. Keep every §22 route. `POST /account/action-grants` is the grant issuer. Export, deletion, email-change and replace-link **reject** without a valid unused hashed grant for that exact action.

| Method and route | Access | Input and result |
| --- | --- | --- |
| POST /account/action-grants | Owner after fresh OTP (not refresh) | `{action}` for export, deletion, email_change, replace_link; returns one-time grant for `X-Action-Grant`; 5-minute expiry; single use. **Implemented:** `POST /v1/account/action-grants` issues `replace_link` only when JWT `auth_time` is fresh (D-024); other actions return 422. |

Bearer-only (no grant) on those four commands → 403. Replayed grant → 403. Grant issued for `export` used on `replace_link` → 403.

### Section 22 inventory

| Method and route | Access | Input and result |
| --- | --- | --- |
| GET /me | Owner | User/workspace/bootstrap, workspace version, and entitlement summary |
| POST /workspace | Owner | Completes the already-provisioned workspace. Setup fields; Idempotency-Key UUID; If-Match current version. Does not create a second workspace. Creates `job_allowances` if missing. Server sets `setup_completed_at`. |
| PATCH /workspace | Owner | Defaults with If-Match; future drafts only |
| POST /account/email-change | Owner + X-Action-Grant email_change | New email; provider verification; revoke prior refresh tokens |
| GET /customers | Owner | Search/filter/page |
| POST /customers | Owner | Customer fields |
| PATCH /customers/{id} | Owner | Mutable contacts, If-Match |
| POST /customers/{id}/archive | Owner | archived boolean |
| DELETE /customers/{id} | Owner | Unreferenced only; else 409 |
| GET /items | Owner | Catalogue search/page. **Implemented.** Blank query lists most recently updated active items. |
| POST /items | Owner | Catalogue fields. **Implemented.** Idempotency-Key; integer cents; client UUID. |
| GET /items/{id} | Owner | Member read for S20 edit. **Implemented.** Cross-tenant 404. |
| PATCH /items/{id} | Owner | Versioned defaults. **Implemented.** If-Match. |
| POST /items/{id}/archive | Owner | archived boolean. **Implemented.** If-Match. |
| GET /jobs | Owner | Search, state, archive, page |
| POST /jobs | Owner | Client UUID, customer, title, site, mode; draft. Optional `related_job_id` when the source job is canceled (JOB02). **Implemented.** |
| GET /jobs/{id} | Owner | Overview, permitted_actions, scope, ledger summary |
| PATCH /jobs/{id} | Owner | Title/notes; customer/site only before publication |
| POST /jobs/{id}/archive | Owner | Archive/restore; no pending request. **Implemented:** `POST /v1/jobs/{jobId}/archive`; `{ archived: boolean }`; Idempotency-Key; APPROVAL_PENDING when a request is pending; does not change financial status. |
| POST /jobs/{id}/cancel | Owner | Reason; withdraw pending; retain receivable. **Implemented:** `POST /v1/jobs/{jobId}/cancel`; Idempotency-Key; EMAIL08 on pending approval withdraw only. |
| POST /jobs/{id}/finish | Owner | Settlement/credit check. **Implemented:** `POST /v1/jobs/{jobId}/finish`; Idempotency-Key; invoiced jobs only when the active invoice ledger balance is zero. |
| DELETE /jobs/{id} | Owner | Draft-only. **Implemented:** `DELETE /v1/jobs/{jobId}`; Idempotency-Key; published jobs 409 JOB_NOT_DELETABLE. |
| POST /jobs/{id}/quote | Owner | Draft or next revision |
| POST /jobs/{id}/changes | Owner | Create/reuse editing change draft. **Implemented.** Eligible after accepted quote and before any invoice. Integer-cent lines are saved via PATCH `/drafts/{id}`. |
| GET /drafts/{id} | Owner | Payload and version |
| PATCH /drafts/{id} | Owner | Full payload; If-Match |
| POST /drafts/{id}/discard | Owner | Discarded; audit kept |
| POST /drafts/{id}/preview | Owner | preview_hash + rendered preview |
| POST /drafts/{id}/publish | Owner | preview_hash, recipient, expiry, replace_pending_request_id?; 202 delivery |
| GET /documents/{id} | Owner | Immutable snapshot + live status |
| GET /documents/{id}/download | Owner | Artifact state or five-minute signed URL |
| POST /requests/{id}/resend | Owner | Bounded retry; no expiry extension. **Implemented:** `POST /v1/requests/{requestId}/resend`; Idempotency-Key; APR03 rotate; NTF04 caps + Retry-After. |
| POST /requests/{id}/withdraw | Owner | Reason; terminal withdrawal. **Implemented:** `POST /v1/requests/{requestId}/withdraw`; Idempotency-Key; EMAIL08. |
| POST /requests/{id}/replace-link | Owner + X-Action-Grant replace_link | Rotate token_hash and sessions; preserve decisions. **Implemented:** `POST /v1/requests/{requestId}/replace-link`; Idempotency-Key + X-Action-Grant. |
| POST /jobs/{id}/invoice-preview | Owner | Due date/instructions; preview_hash |
| POST /jobs/{id}/issue-invoice | Owner | preview_hash; immutable invoice |
| POST /invoices/{id}/void | Owner | Reason; strict ledger conditions. **Implemented:** `POST /v1/invoices/{invoiceId}/void`; Idempotency-Key; unpaid only; EMAIL08 no new link; view_only revoked; LEDGER_BLOCKS_VOID 409. |
| POST /invoices/{id}/replacement-preview | Owner | Voided source; permitted identity fields. **Implemented:** `POST /v1/invoices/{invoiceId}/replacement-preview`; customer/due/instructions overlay only. |
| POST /invoices/{id}/issue-replacement | Owner | preview_hash; new number. **Implemented:** `POST /v1/invoices/{invoiceId}/issue-replacement`; Idempotency-Key; new INV; prior_document_id; EMAIL06 + original PDF; `invoice_issued`. |
| POST /invoices/{id}/credits/preview | Owner | Allocations/reason. **Implemented:** `POST /v1/invoices/{invoiceId}/credits/preview`; integer-cent allocations; CREDIT_EXCEEDS_SOURCE 422. |
| POST /invoices/{id}/credits | Owner | preview_hash; issue + notify. **Implemented:** `POST /v1/invoices/{invoiceId}/credits`; Idempotency-Key; financial permanence; CN-00000N; EMAIL07 + original PDF queued. |
| GET /invoices/{id}/ledger | Owner | Entries and derived balance. **Implemented:** `GET /v1/invoices/{invoiceId}/ledger`; derived payment_status including issued credits; credit_sources remaining net. |
| POST /invoices/{id}/payments | Owner | Manual payment. **Implemented:** `POST /v1/invoices/{invoiceId}/payments`; Idempotency-Key; financial permanence; overpay confirm; `payment_recorded` settlement only. |
| POST /invoices/{id}/refunds | Owner | Manual refund. **Implemented:** `POST /v1/invoices/{invoiceId}/refunds`; Idempotency-Key; REFUND_EXCEEDS_BALANCE; oldest-first allocations. |
| POST /ledger/{id}/reverse | Owner | Reason; one reversal. **Implemented:** `POST /v1/ledger/{entryId}/reverse`; Idempotency-Key; financial permanence; ENTRY_ALREADY_REVERSED 409; dependent refunds 422. |
| POST /documents/{id}/send | Owner | Recipient or verified view_only link |
| POST /assets/upload-url | Owner | Signed upload; display filename only |
| POST /assets/{id}/complete | Owner | Enqueue validation |
| GET /assets/{id} | Owner | State; authorized thumbnail if ready |
| DELETE /assets/{id} | Owner | Unpublished unused only |
| POST /subscription/trial | Owner | Explicit start; once |
| GET /subscription | Owner | Entitlement, trial, usage |
| POST /subscription/reconcile | Owner | Provider hint; authoritative fetch |
| POST /webhooks/revenuecat | Provider auth | Durable event; async process |
| POST /webhooks/email | Provider signature | Delivery dedup |
| POST /exports | Owner + X-Action-Grant export | Cutoff; 202 export ID |
| GET /exports/{id} | Owner | Status/manifest/download |
| POST /account/deletion | Owner + X-Action-Grant deletion | Confirmation phrase; lock and revoke refresh tokens |
| GET /account/deletion | Owner limited session | Deletion state |
| POST /support/cases | Owner | Category/message; optional content grant |
| GET /operations/{id} | Same initiating actor | Pending or durable result |
| POST /analytics/batch | Owner | Allowlisted events, max 50 |
| POST /portal/exchange | Request token | Scope cookie; no private data yet |
| POST /portal/code/send | Preverified session | OTP to bound email; generic response |
| POST /portal/code/verify | Preverified session | One-hour recipient session |
| GET /portal/document | Recipient | Bound snapshot and allowed_actions |
| POST /portal/decision | Recipient + CSRF | decision, name, consent_version, snapshot_hash |
| GET /portal/receipt | Recipient | Decision or view_only metadata (API05) |
| GET /portal/download | Recipient | Authorized artifact link |
| POST /portal/report | Scoped or preverified | Abuse reason |
| GET /admin/cases | Staff | Metadata-only search |
| POST /admin/cases/{id}/access | Supervisor | Owner grant + reason |
| POST /admin/requests/{id}/revoke | Supervisor | Incident reason; no money change |
| POST /admin/tasks/{id}/retry | Staff | Idempotent retry; reason logged |

## API04 Direct invoice

`POST /jobs` with mode `direct_invoice` creates the job and initial invoice draft. Preview: `/drafts/{id}/preview` (dispatches on `kind=invoice`). Issue: `/jobs/{id}/issue-invoice` with that `preview_hash`. `GET /jobs/{id}` includes `invoice_draft` and document summaries. Customer email is optional; EMAIL06/`view_only` is queued only when present. After issue, amount changes use credit/replacement only. Hosted `0019_direct_invoice.sql` is not applied in this slice.

## API05 view_only

Invoice/credit access uses the same request/session machinery with `purpose=view_only`. **Implemented for invoices (EMAIL06) and credit notes (EMAIL07):** issue inserts a 90-day `view_only` request; `pending` means access enabled; no decision. Do not expire via the approval-expiry worker; use access expiry (default 90 days). `GET /portal/document` returns `allowed_actions=[download,report]`. `POST /portal/decision` returns 403. Pending uniqueness for approvals excludes view_only. Must be in migration and OpenAPI, not inferred from UI. Live portal credit review is not device-verified.

## Transaction algorithms

**TX01 Publish:** verify owner and draft version; lock job, allowances and current request; on first publication consume one new-job slot or return ENTITLEMENT_REQUIRED; on a later command for the same job verify `completion_right` and do not consume another slot; set `jobs.completion_right=true` write-once on first success; reject unrelated pending approval; if `replace_pending_request_id` matches the current quote request and expected version, supersede it and invalidate sessions; recalculate with `packages/domain`; match preview hash against stored canonical bytes; validate ready assets; allocate number/revision; insert snapshot/lines/assets; create tokenized request and outbox; mark draft published and job active; commit. Return IDs immediately. Precommit failure rolls back all side effects including slot counters. No external email inside the transaction. No stub may skip slot consumption.

**TX02 Approve:** verify recipient session and CSRF; lock request and job; compare now with expiry, state, document hash and expected scope version; verify source reduction caps; insert unique decision; apply append-only scope entries; mark accepted; increment `scope_version`; commit receipt/notification tasks. Never accept after expiry based on page-open time.

**TX03 Invoice issue:** lock job; verify scope/preview hash and absence of pending/unresolved changes; validate direct-mode exception; enforce one active invoice via pointer **and** partial unique index; first publication of a direct-invoice job uses the same slot and `completion_right` rules as TX01; insert snapshot/lines and number; set active invoice pointer/lifecycle; append audit/outbox; commit. Timeout recovery through `operation_id`. Worker failure cannot duplicate the invoice.

**TX04 Credit/payment/refund/reversal:** lock invoice; load effective ledger and cumulative credits; validate caps; insert append-only entry or credit snapshot with permanent `operation_id`; recompute derived balance; append audit/outbox; commit. Concurrent commands serialize on the invoice and must not both spend the same remaining capacity.

**TX05 Billing:** authenticate and store webhook by provider/external ID; acknowledge only after durable persistence. Worker retrieves current provider subscriber state, validates environment and user mapping, compares effective dates, updates entitlement snapshot. If provider unavailable, retry without revoking previously valid access prematurely. Nightly reconciliation repairs missed events.

**TX06 Public link compromise:** revoke tokens and sessions; block future decisions on the compromised pending request; preserve committed decisions; issue a fresh request when appropriate; never erase historical approval evidence; notify owner with incident ID.

## Rate limits (SEC02)

- Owner API: 120 requests/minute/user
- Publication: 20/hour/workspace
- Daily email: 100 free/trial, 500 paid
- Public OTP: separately stricter (APR02)

Completion rights do not bypass abuse limits.

## Session and grant rules

- Portal cookies: `Secure`, `HttpOnly`, `SameSite=Lax` or Strict, host-only, one request.
- Staff credentials on owner routes → 401. Owner Bearer on portal/staff routes → 401.
- Email-change and deletion lock revoke existing owner refresh tokens.
- OTP and action-grant secrets hashed only; five failures lock the challenge; never log raw codes.
- Approval links in email and share sheet are exactly `{PORTAL_ORIGIN}/review#{token}`. Never `?token=`. After `POST /portal/exchange`, the fragment is discarded. Do not emit `Location` or logs containing the raw token. Disable click-tracking that rewrites hrefs.

## OpenAPI

DEL02 requires executable OpenAPI 3.1 for every endpoint, examples and error codes matching this PRD, and generated or validated mobile client types.
