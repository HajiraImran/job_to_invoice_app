> Source: `docs/PRD.md` §§03, 27, DEC12
> Authority: first-party `analytics_events` only. No PostHog, tracking SDK or advertising identifier (D-001).

# Analytics

## Rules (ANA01–ANA03, DEC12)

Schema fields: `event_id` UUID, `event_name`, `schema_version`, `occurred_at`, `received_at`, pseudonymous owner ID, optional opaque job ID, app version, platform, allowlisted properties.

Never send:

- customer names or emails
- addresses
- note text
- invoice descriptions
- approval names
- URLs or tokens, including query-string `?token=` and click-tracking redirects
- photos
- payment references

Approval email hrefs are `{PORTAL_ORIGIN}/review#{token}`. Fragment tokens must never be copied into `analytics_events`, Sentry, or provider click-tracking that rewrites the href. After exchange, persist `token_hash` only.

Pseudonymous owner IDs are random mapped identifiers, not raw email hashes. Exports and deletion must account for the mapping.

Server business events are authoritative. Clients must not emit `onboarding_completed`, `purchase_verified`, or `document_published`. Offline UI events batch at most 50 and expire after seven days (`POST /analytics/batch`).

Conversion reports exclude demo/test/staff accounts and sandbox transactions. Cohort start: signup for activation; first verified paid transaction for subscription retention. Store invoices paid by operators' customers are unrelated to app subscription revenue.

V1 acquisition: campaign-level spend imports and self-reported source with unknown bucket. No deterministic install-to-ad promise. No ad SDKs. Experimentation is limited to pre-paywall copy and creative entry points, never calculation, consent or entitlement.

Sentry is error monitoring, not product analytics. Session replay and screenshots are disabled (OPS03).

## Event catalogue

| Event | Emit when | Allowed properties | Screen / flow | MET |
| --- | --- | --- | --- | --- |
| signup_verified | Provider verification and app bootstrap succeed | acquisition_source self_reported/unknown, app_version | S03 | MET01 denominator |
| onboarding_completed | Required setup saved (server) | trade, setup_duration_bucket | S04 | MET01 |
| job_created | Server draft job created | mode quote/direct | S06 | — |
| document_published | Snapshot commit succeeds | kind, entitlement_origin, line_count_bucket | S11 TX01 | MET01, MET03 |
| request_delivery_result | Verified provider event | result, template_id | S12 NTF03 | — |
| approval_completed | Server decision commits | approve/decline, document_kind, elapsed_bucket | S26 TX02 | MET02 |
| change_started | Change draft created | addition/reduction/mixed | S13 S14 | MET02 |
| invoice_issued | Invoice transaction commits | quote_based/direct, has_changes boolean | S15 TX03 | MET04 |
| payment_recorded | Manual payment commits | partial/full/overpaid only | S17 | — |
| trial_started | Server trial record first set | remaining_free_slots | S21 | MET06 context |
| paywall_viewed | S21 visible | entry_point, product_ids, experiment_id? | S21 | MET06 |
| purchase_verified | Server entitlement reconciled | product_id, initial/renewal, store_environment | TX05 | MET06, MET08 |
| subscription_expired | Verified state loses Pro | known_reason enum | S21 | MET08 |
| export_completed | Bundle ready | size_bucket, job_count_bucket | S24 | — |
| sync_conflict | Server draft conflict | resource_kind, client_version | S23 | — |
| support_opened | Case created | category | S22 | — |

No amount, reference, email or document text on any event.

## Metric instrumentation

| Metric | Definition | Events / source |
| --- | --- | --- |
| MET01 Activation | Real non-demo publish within 7 days of signup; target ≥35% hypothesis | signup_verified → document_published |
| MET02 Core workflow adoption | Approved change in 30 days among owners with an approved quote | approval_completed on change |
| MET03 Repeat job use | Another distinct real job in 30 days | second document_published new job |
| MET04 First invoice speed | Median active edit time preview→issue <2 min; idle >30s excluded | client timing buckets around invoice_issued |
| MET05 Reliability | Zero lost committed docs / duplicate financials / cross-tenant; crash-free ≥99.5% | Sentry + audit, not analytics PII |
| MET06 Monetization | Server-verified paid, first txn not refunded; after full trial observation | purchase_verified |
| MET07 Acquisition | CAC = media / non-refunded new paying owners; unknown separate | spend import + purchase_verified |
| MET08 Retention | Monthly renewal by cohort; weekly business activity | purchase_verified renewal; activity not annual purchase |

These metrics must never alter accounting calculations or app authorization.

## Implementation

- Persist via `analytics_events` and `POST /analytics/batch`
- Deduplicate `event_id`
- Allowlist event names in API
- Deletion removes or re-keys the owner mapping (PRV04)
- Daily deidentified cohort job (OPS08)
