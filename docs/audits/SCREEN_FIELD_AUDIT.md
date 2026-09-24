# Screen field audit

Field-by-field comparison of PRD §08 / `docs/SCREEN_MAP.md` against the implementation at `184380a` on `main` (2026-09-23).

**Legend (Status):** `VERIFIED_COMPLIANT` | `IMPLEMENTED_UNVERIFIED` | `PARTIALLY_COMPLIANT` | `NON_COMPLIANT` | `MISSING` | `BLOCKED` | `SPEC_CONFLICT` | `NOT_APPLICABLE`

Physical/device column is empty unless this audit reproduced the check. Historical Expo Go / Android notes in the matrix are **not** treated as this-audit physical evidence.

Shared UI04 requirement (every data screen): loading, empty, loaded, refresh-failure, offline, access-expired. Most owner screens implement a subset only.

---

## S01 Welcome

**Route implemented:** `apps/mobile/app/(public)/welcome.tsx` → `/(public)/welcome`
**Copy:** `apps/mobile/src/i18n/en.ts`

| Required element | PRD label/copy | Implemented | Required type | Implemented type | Req/opt | Impl req/opt | Validation | Impl validation | Loading | Empty | Error | Offline | A11y | API | DB | Tests | Physical | Status | Discrepancy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Promise | Product promise | `Create professional quotes and invoices, then get them approved.` | text | text | required | present | — | — | n/a static | n/a | n/a | works offline | header role on title | none | none | none dedicated | none this audit | PARTIALLY_COMPLIANT | Copy is generic; not a signed design-frame match (DEL03) |
| Sample document | Sample document (fictional, cannot send) | Card: Example Handyman / Alex Rivera / Northside porch repair / $100.00 line + total; `Fictional data. This sample cannot be sent.` | visual sample | document card | required | present | demo cannot send | `sendAvailable: false`; no send control | n/a | n/a | n/a | ok | summary label includes cannot-send | none | none | `src/welcome/presentation.test.ts` | none this session | IMPLEMENTED | Device/VoiceOver still required. Integer-cent $100.00 is fictional demo data |
| Create my first quote | Create my first quote | Same label; navigates to sign-in | button | button 48pt | required | present | no paywall | no paywall | n/a | n/a | n/a | ok | button role | none | none | presentation.test.ts | none | IMPLEMENTED_UNVERIFIED | Auth-gated; both CTAs go to S02 |
| Sign in | Sign in | Same; `/(public)/sign-in` | button | text button | required | present | — | — | n/a | n/a | n/a | ok | button | none | none | none | none | IMPLEMENTED_UNVERIFIED | Device/VoiceOver unverified |
| Terms/privacy **links** | Terms and Privacy Notice links | `By continuing you agree to the Terms and Privacy Notice.` plain `Text` | links | static text | required links | not links | dest URLs | none | n/a | n/a | n/a | ok | not links | none | none | none | none | NON_COMPLIANT | Not tappable; no destinations; PRV01 notice missing |
| No purchase prompt | No paywall on welcome | No IAP UI | — | — | required | present | — | — | n/a | n/a | n/a | ok | — | none | none | visual | none | IMPLEMENTED_UNVERIFIED | |
| Demo cannot send | Demo cannot send | Sample card `sendAvailable: false`; no send control | — | — | required | present | — | no send | n/a | n/a | n/a | ok | announced in a11y label | none | none | presentation.test.ts | none | IMPLEMENTED_UNVERIFIED | Device confirmation remaining |

---

## S02 Email sign in

**Route:** `/(public)/sign-in`

| Required element | PRD | Implemented | Type | Impl type | Req | Impl | Validation req | Impl validation | Loading | Empty | Error | Offline | A11y | API | Tests | Physical | Status | Discrepancy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Email | Email input | `Email` | email ≤254 | string | required | required | VAL01 format, no enumeration | `Enter a valid email address.` | `Sending code` | n/a | invalid / network / throttle | `Could not reach the network. Try again.` | label present | Supabase OTP send | `auth.test.ts` | none this audit | IMPLEMENTED_UNVERIFIED | Dashboard 6/600s/60s/5 not independently verified |
| Send code | Send code | same + sending state | button | button | required | present | throttle | `Wait before requesting another code.` | disabled while sending | n/a | generic sent | network copy | button | Auth | auth tests | none | IMPLEMENTED_UNVERIFIED | |
| Passwordless explanation | explain passwordless | `We'll email a one-time code. There is no password.` | text | text | required | present | — | — | — | — | — | — | — | — | — | none | IMPLEMENTED_UNVERIFIED | |
| Generic code-sent | no account enumeration | `If that email can receive mail, we sent a code.` | text | text | required | present | generic | generic | — | — | — | — | — | — | schema/auth tests | none | IMPLEMENTED_UNVERIFIED | Provider timing side-channel not proven |

---

## S03 Verify code

**Route:** `/(public)/verify`

| Required element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| 6-digit code | Code field | `6-digit code` | IMPLEMENTED_UNVERIFIED | OS paste/autofill not device-proven |
| Masked email | masked email | presentation exists in verify flow | IMPLEMENTED_UNVERIFIED | |
| Resend countdown | 60s | client cooldown | IMPLEMENTED_UNVERIFIED | Provider limit unverified |
| Change email | Change email | same copy | IMPLEMENTED_UNVERIFIED | |
| Expired / incorrect / attempt limit | exact NTF/ACC copy | `That code didn't work…` / expired / too many | IMPLEMENTED_UNVERIFIED | |
| signup_verified | server event | server-side emit claimed | IMPLEMENTED_UNVERIFIED | Live analytics unverified |

---

## S04 Business setup

**Route:** `/(onboarding)/setup` — three steps in `setup.tsx`

| Field | PRD | Implemented label | Type / limits | Impl | Req | Impl req | Validation | Loading/empty/error/offline | API / DB | Status | Discrepancy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Business display name | 2–100, trim | `Business display name` | string | schema + form | required | required | VAL01 | offline local draft; generic save error | POST `/v1/workspace` → `workspaces` | IMPLEMENTED_UNVERIFIED | Device/VoiceOver unverified |
| Legal name | 2–150 | `Legal name` | string | yes | required | required | VAL01 | same | same | IMPLEMENTED_UNVERIFIED | |
| Trade | trade | `Trade` Handyman/Other | enum | yes | required | required | — | — | workspace | IMPLEMENTED_UNVERIFIED | PRD trade list not fully enumerated here |
| Logo | optional skip | `Skip logo for now` | skip only | skip only | optional | skip-only | — | hint: upload later | no upload | PARTIALLY_COMPLIANT | Upload path missing (documented as later) |
| Operator name | 2–100 | `Operator or contact name` | string | yes | required | required | VAL01 | — | contact | IMPLEMENTED_UNVERIFIED | |
| Contact email | ≤254 | `Contact email` | email | yes | required | required | VAL01 | — | — | IMPLEMENTED_UNVERIFIED | |
| Contact phone | optional E.164 | `Contact phone (optional)` | phone | optional | optional | optional | E.164-or-show-error | — | — | IMPLEMENTED_UNVERIFIED | Country guessing not audited on device |
| Address line1 | max 150 | `Address line 1` | US | yes | required | required | VAL02 | — | address_json | IMPLEMENTED_UNVERIFIED | |
| Address line2 | opt max 150 | `Address line 2 (optional)` | US | yes | optional | optional | VAL02 | — | — | IMPLEMENTED_UNVERIFIED | |
| City | max 80 | `City` | string | yes | required | required | VAL02 | — | — | IMPLEMENTED_UNVERIFIED | |
| State | 2-letter | `State` picker | US_STATES | yes | required | required | VAL02 | — | — | IMPLEMENTED_UNVERIFIED | |
| ZIP | 5 or 9 | `ZIP code` | string | yes | required | required | VAL02 | — | — | IMPLEMENTED_UNVERIFIED | |
| Timezone | device IANA + confirm | `Business timezone` + `This timezone is correct` | IANA | suggested + confirm | required confirm | present | VAL02 | — | workspaces.timezone | IMPLEMENTED_UNVERIFIED | |
| Currency USD locked | display only | `Currency is US dollar (USD) and cannot be changed.` | display | display | required | present | — | — | USD | IMPLEMENTED_UNVERIFIED | |
| Default tax | 0 + confirm | `Default tax rate (%)` + `Confirm tax treatment for your business` | bp | yes | required confirm | present | FIN02 | — | default_tax_bp | IMPLEMENTED_UNVERIFIED | |
| Default due days | defaults | `Default invoice due days` | enum/custom | yes | required | present | — | — | — | IMPLEMENTED_UNVERIFIED | |
| Default terms | 0–4000 | `Default commercial terms` | text | yes | optional | optional | VAL04 | — | — | IMPLEMENTED_UNVERIFIED | |
| Back preserves data | back keeps | local setup draft | — | yes | required | present | — | `Restored your saved setup draft.` | local | IMPLEMENTED_UNVERIFIED | |
| Save | Save three steps | `Save business setup` / `Saving…` | button | yes | required | present | first-field focus | conflict / offline / expired | Idempotency-Key | IMPLEMENTED_UNVERIFIED | |

---

## S05 Jobs list

**Route:** `/(tabs)/jobs`
**Tab bar:** Jobs present. SCREEN_MAP also requires Customers tab — missing (see S19).

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Search | Search | `Search jobs` | IMPLEMENTED_UNVERIFIED | Offline copy `Searching downloaded jobs.` present |
| Filter Active | Active | `Active` | IMPLEMENTED_UNVERIFIED | Maps to open lifecycle |
| Filter Finished | Finished | `Finished` | IMPLEMENTED_UNVERIFIED | |
| Filter Archived | Archived | `Archived` | IMPLEMENTED_UNVERIFIED | |
| Job cards | cards | list rows | IMPLEMENTED_UNVERIFIED | Design tokens unverified |
| New job | New job | `Create job` / navigation to `/jobs/new` | PARTIALLY_COMPLIANT | Label “Create job” vs SCREEN_MAP “New job” |
| Empty | first-job prompt | `No jobs yet. Create your first job…` | IMPLEMENTED_UNVERIFIED | |
| Draft-sync badges | badges | pending/synced copy exists | IMPLEMENTED_UNVERIFIED | Device unverified |
| Cursor pagination | cursor | API `next_cursor`; `Load more` | IMPLEMENTED_UNVERIFIED | |
| UI04 refresh-fail | keep cache + retry | load error + retry | PARTIALLY_COMPLIANT | Timestamp-on-cache not uniformly shown |
| Access-expired | reauth | session banners on some screens | PARTIALLY_COMPLIANT | Not proven on every list state |

---

## S06 Create job

**Route:** `/(tabs)/jobs/new`
**Form:** `apps/mobile/src/jobs/form.ts` — `customer_name`, title, site XOR no_site, internal notes, mode. **No customer_id, email, phone, billing address.**

| Field | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Customer (sheet → S07) | Customer creation sheet | Inline `Customer name` only | NON_COMPLIANT | PRD S06: “Customer creation sheet”; no S07 |
| Customer email | optional here; required later for approval | absent | MISSING | Cannot collect email on create |
| Site address | VAL02 | line1/2, city, state, ZIP | IMPLEMENTED_UNVERIFIED | Distinct from billing (no billing on job) |
| No site address | explicit choice | `No site address` + hint | IMPLEMENTED_UNVERIFIED | |
| Title | 1–120 | `Job title` | IMPLEMENTED_UNVERIFIED | |
| Quote or Direct invoice | mode | `Quote` / `Direct invoice` | IMPLEMENTED_UNVERIFIED | |
| No forced contacts permission | no contacts | no contacts API | IMPLEMENTED_UNVERIFIED | |
| Internal notes | 0–4000, never on PDF | `Internal notes (optional)` + hint | IMPLEMENTED_UNVERIFIED | |
| Offline create | ACC02 window | claimed in matrix | IMPLEMENTED_UNVERIFIED | Device unverified |
| job_created | server event | server-only claimed | IMPLEMENTED_UNVERIFIED | |

---

## S07 Customer form

**PRD route:** `/(tabs)/customers/[id]?` or sheet
**Implemented route:** **none** (no `customers` segment under tabs)

| Field | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Name | 1–120 | — | MISSING | No screen |
| Email | ≤254; mandatory for approval | — | MISSING | |
| Phone | optional E.164 | — | MISSING | |
| Billing address | VAL02 | — | MISSING | |
| Duplicate email warning | warn, not silent merge | — | MISSING | |
| Archive restore | restore option | — | MISSING | |
| Save | Save contact | — | MISSING | |
| All UI04 states | required | — | MISSING | |

---

## S08 Job overview

**Route:** `/(tabs)/jobs/[id]`

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Customer / site | show | name + site from job row | PARTIALLY_COMPLIANT | Customer is a string, not S19 entity |
| Scope total | show | quote/invoice totals when loaded | IMPLEMENTED_UNVERIFIED | |
| Current step | no generic status | `Current step` + lifecycle labels | IMPLEMENTED_UNVERIFIED | |
| Document list | documents | published quote/invoice links | PARTIALLY_COMPLIANT | Activity feed completeness unverified |
| Activity | activity | limited | PARTIALLY_COMPLIANT | |
| Next actions by state | JOB01/JOB02 | quote/invoice/change/reduce/cancel/delete/archive/finish/linked job | IMPLEMENTED_UNVERIFIED | Device unverified |
| Ledger | no fake ledger | no fake totals claimed | IMPLEMENTED_UNVERIFIED | |
| Canceled receivable | show if retained | copy/path exists | IMPLEMENTED_UNVERIFIED | |

---

## S09 Quote editor

**Route:** `/(tabs)/jobs/[id]/quote`

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Ordered line cards | line cards | cards on this screen | IMPLEMENTED_UNVERIFIED | S10 not a separate route |
| Add item | Add item | add + catalogue picker | IMPLEMENTED_UNVERIFIED | |
| Notes | 0–2000 | public notes | IMPLEMENTED_UNVERIFIED | |
| Terms | 0–4000 | commercial terms | IMPLEMENTED_UNVERIFIED | |
| Expiry | 1–90 days default 14 | expiry_days | IMPLEMENTED_UNVERIFIED | |
| Save indicators | Saving / Saved / Synced / Offline / Conflict | presentation helpers | IMPLEMENTED_UNVERIFIED | Device unverified |
| Conflict actions | S23 | inline Keep server / Save local | PARTIALLY_COMPLIANT | No `/(modal)/conflict` route |
| Offline publish disabled | NTF05 | outbox forbids publish | IMPLEMENTED_UNVERIFIED | |
| Live totals | FIN01 | domain calc on cards | IMPLEMENTED_UNVERIFIED | |

---

## S10 Line editor

**PRD / SCREEN_MAP route:** `/(tabs)/jobs/[id]/line`
**Implemented:** fields on S09 (and change/invoice editors)

| Field | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Dedicated screen | S10 QA unit | no `/line` route | SPEC_CONFLICT | SCREEN_MAP later says fields live on S09 |
| Description | 1–500 | on card | IMPLEMENTED_UNVERIFIED | |
| Quantity | 0.001–999999.999 string | 3-decimal string | IMPLEMENTED_UNVERIFIED | Keyboard type device-unverified |
| Unit | enum + custom ≤20 | LINE_UNITS | IMPLEMENTED_UNVERIFIED | |
| Unit price | integer cents | cents | IMPLEMENTED_UNVERIFIED | |
| Fixed discount | ≤ gross | cents | IMPLEMENTED_UNVERIFIED | |
| Tax rate | operator bp | bp | IMPLEMENTED_UNVERIFIED | |
| Live subtotal/net/tax | live | liveTotals | IMPLEMENTED_UNVERIFIED | |
| Saved-item picker | copy-on-use | CatalogueItemPicker | IMPLEMENTED_UNVERIFIED | Never stores live catalogue id (unit-tested) |

---

## S11 Preview and publish

**Route:** `/(tabs)/jobs/[id]/publish`

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Frozen preview | frozen-looking | preview hash | IMPLEMENTED_UNVERIFIED | |
| Recipient email | required for approval | confirm field | IMPLEMENTED_UNVERIFIED | |
| Expiry display | show | from preview | IMPLEMENTED_UNVERIFIED | MM/DD/YYYY presentation unverified |
| Slot/paywall before submit | show condition | ENTITLEMENT_REQUIRED path | PARTIALLY_COMPLIANT | Paid paywall missing; free/trial only |
| Confirm publish | confirm | confirmation step | IMPLEMENTED_UNVERIFIED | |
| Stale recovery | PREVIEW_CHANGED | API + stay on confirm | IMPLEMENTED_UNVERIFIED | |
| Errors stay on confirm | stay | documented | IMPLEMENTED_UNVERIFIED | |

---

## S12 Request detail

**Route:** `/(tabs)/jobs/[id]/request`

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Status / revision / sent-to | show | present | IMPLEMENTED_UNVERIFIED | |
| Delivery events | NTF03 queued ≠ delivered | copy/API | IMPLEMENTED_UNVERIFIED | Live webhook unverified |
| Resend | ≤3/day ≥10 min | API + UI | IMPLEMENTED_UNVERIFIED | |
| Withdraw | reason confirm | API + UI | IMPLEMENTED_UNVERIFIED | |
| Replace recipient | ACC02A OTP grant | API + UI | IMPLEMENTED_UNVERIFIED | email_change grant not used here |
| Online only | never outbox | outbox rules | IMPLEMENTED_UNVERIFIED | |

---

## S13 Extra work

**Route:** `/(tabs)/jobs/[id]/change`

| Field | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Reason | 5–500 if required | reason field | IMPLEMENTED_UNVERIFIED | |
| Added lines | S10 fields | editor | IMPLEMENTED_UNVERIFIED | |
| Photo attachments | JPEG/PNG/HEIC, 10×10MB, EXIF strip | **none** | MISSING | DOC03/DOC04/QA52 absent |
| Old/change/new totals | show | presentation | IMPLEMENTED_UNVERIFIED | |
| Gate after accept before invoice | gate | API P0034/P0044 | IMPLEMENTED_UNVERIFIED | |
| Camera permission only on Take photo | DOC04 | no camera | MISSING | |

---

## S14 Reduction

**Route:** `/(tabs)/jobs/[id]/reduce`

| Field | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Eligible source line | select | remaining caps | IMPLEMENTED_UNVERIFIED | |
| Reduction amount | integer cents | cents | IMPLEMENTED_UNVERIFIED | |
| Reason | 5–500 | required | IMPLEMENTED_UNVERIFIED | |
| Tax / new total | FIN03 | domain | IMPLEMENTED_UNVERIFIED | |
| Bound max | cap | CREDIT_EXCEEDS_SOURCE | IMPLEMENTED_UNVERIFIED | |
| Block all-zero | unless CHG02 reason | schema | IMPLEMENTED_UNVERIFIED | |

---

## S15 Invoice preview

**Route:** `/(tabs)/jobs/[id]/invoice` (+ `direct-screen.tsx`)

| Field | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Source summary | show | residual / direct lines | IMPLEMENTED_UNVERIFIED | |
| Line details | show | yes | IMPLEMENTED_UNVERIFIED | |
| Due date | ≥ issue ≤365 | options | IMPLEMENTED_UNVERIFIED | |
| Payment instructions | text | `Payment instructions` | IMPLEMENTED_UNVERIFIED | |
| Direct-invoice label | explicit | `This invoice was not preceded by in-app scope approval.` + ack | IMPLEMENTED_UNVERIFIED | Device unverified |
| Optional customer email | optional share | `Customer email (optional)` | IMPLEMENTED_UNVERIFIED | |
| Block unresolved changes | block | UNRESOLVED_CHANGES | IMPLEMENTED_UNVERIFIED | |
| Issue | online only | issue-invoice | IMPLEMENTED_UNVERIFIED | |

---

## S16 Invoice detail

**Route:** `/(tabs)/jobs/[id]/invoice/[invoiceId]`
**Related:** `void.tsx`, `replace.tsx`, `ledger/reverse.tsx`

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| PDF / share | open + share sheet | path exists | PARTIALLY_COMPLIANT | Device/share/EMAIL06 unverified |
| Issued total / credits / received / refunded / balance | derived | presentInvoice | IMPLEMENTED_UNVERIFIED | |
| Ledger list | entries | list | IMPLEMENTED_UNVERIFIED | |
| Record payment | S17 | navigates | IMPLEMENTED_UNVERIFIED | |
| Record refund | S17 | navigates | IMPLEMENTED_UNVERIFIED | |
| Issue credit | S18 | navigates | IMPLEMENTED_UNVERIFIED | |
| Reverse | one reversal | confirm route | IMPLEMENTED_UNVERIFIED | |
| Void if unpaid | reason | void route | IMPLEMENTED_UNVERIFIED | |
| Replacement after void | new INV | replace route | IMPLEMENTED_UNVERIFIED | |

---

## S17 Payment or refund

**Route:** `/(tabs)/jobs/[id]/ledger/entry`

| Field | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Amount | integer cents | cents | IMPLEMENTED_UNVERIFIED | |
| Date | workspace TZ window | date | IMPLEMENTED_UNVERIFIED | MM/DD/YYYY unverified |
| Method | enum | enum | IMPLEMENTED_UNVERIFIED | |
| Optional reference | text | present | IMPLEMENTED_UNVERIFIED | |
| Overpay warning | confirm | confirm | IMPLEMENTED_UNVERIFIED | |
| Refund maximum | block over | API 422 | IMPLEMENTED_UNVERIFIED | |
| Recorded by business | copy | NTF05 ledger warning | IMPLEMENTED_UNVERIFIED | |
| Online only | no outbox | rules | IMPLEMENTED_UNVERIFIED | |

---

## S18 Credit note

**Route:** `/(tabs)/jobs/[id]/credit`

| Field | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Select invoice lines | select | allocations | IMPLEMENTED_UNVERIFIED | |
| Net credit amounts | cents | cents | IMPLEMENTED_UNVERIFIED | |
| Reason | 5–500 | required | IMPLEMENTED_UNVERIFIED | |
| Preview / issue | CN-000001 | API | IMPLEMENTED_UNVERIFIED | |
| Irreversible + no-refund copy | required | present | IMPLEMENTED_UNVERIFIED | |
| Tax / caps | FIN03 | CREDIT_EXCEEDS_SOURCE | IMPLEMENTED_UNVERIFIED | |

---

## S19 Customers list/detail

**PRD route:** `/(tabs)/customers`
**Implemented:** **no tab, no routes**

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Tab | Customers | absent in `_layout.tsx` | MISSING | SCREEN_MAP four tabs vs three |
| Search / list / create / detail / jobs | required | — | MISSING | |
| Archive vs delete | CUS02 | — | MISSING | |

---

## S20 Items

**Routes:** `/(tabs)/items`, `/items/new`, `/items/[id]`

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Search / list | yes | yes | IMPLEMENTED_UNVERIFIED | |
| Add / edit / archive | yes | yes | IMPLEMENTED_UNVERIFIED | Hosted 0020 unverified |
| Default price/unit/tax | copy-on-use | form | IMPLEMENTED_UNVERIFIED | |
| Five $0 seeds | CAT01 | setup seed | IMPLEMENTED_UNVERIFIED | |
| Never alter issued docs | required | API test | IMPLEMENTED_UNVERIFIED | Device unverified |

---

## S21 Subscription

**Route:** `/(tabs)/settings/subscription`

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Free usage | used of 3 | `Free published jobs used: {used} of {limit}.` | IMPLEMENTED_UNVERIFIED | |
| Start 14 day trial | exact disclosure | `Try all features on up to 20 jobs for 14 days. No card and no automatic charge.` + `Start 14 day trial` | IMPLEMENTED_UNVERIFIED | Device unverified |
| Monthly/annual StoreKit prices | localized StoreKit | **no SDK** | MISSING / BLOCKED | Hardcoded prices forbidden; nothing to display |
| Buy / restore / manage | required | Manage copy only for deletion disclaimer | MISSING / BLOCKED | |
| States pending/active/canceled/expired/refund/sync-fail | required | trial/free/ended only | PARTIALLY_COMPLIANT | Paid states absent |
| paywall_viewed / purchase_verified | events | trial_started local | PARTIALLY_COMPLIANT | |

---

## S22 Settings

**Route:** `/(tabs)/settings`
**Also:** `support.tsx`, `subscription.tsx`, export/deletion route

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Business defaults editor | defaults | **absent** | MISSING | Display email only |
| Notifications | notifications | **absent** | MISSING | |
| Support | support | Support button → case form | IMPLEMENTED_UNVERIFIED | |
| Privacy notice | privacy | **absent** | MISSING | |
| Export / deletion | S24 | Export and deletion button | IMPLEMENTED_UNVERIFIED | |
| Sign out + unsynced | Stay / Synchronize / Discard | Alert.alert flow | IMPLEMENTED_UNVERIFIED | |
| Reauth for sensitive | ACC02A | export/deletion grants; not email-change | PARTIALLY_COMPLIANT | ACC03 missing |
| Logo/address future-only updates | required | no editor | MISSING | |
| Support category | required | picker | IMPLEMENTED_UNVERIFIED | |
| Support message | min length | `Describe the problem` | IMPLEMENTED_UNVERIFIED | |
| 24h content grant | optional | checkbox + help | IMPLEMENTED_UNVERIFIED | Staff cannot consume |
| No 24h SLA | DEC13 | `We do not promise a 24-hour reply.` | IMPLEMENTED_UNVERIFIED | |
| Public support URL | when set | `Open the public support address` if SUPPORT_URL | BLOCKED / empty | `.env.example` SUPPORT_URL empty |

---

## S23 Conflict recovery

**PRD route:** `/(modal)/conflict`
**Implemented:** inline on quote editor + `sync/conflict.ts`

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Dedicated modal | route | no modal route | PARTIALLY_COMPLIANT | Behavior exists inline |
| Local vs server values + time | show | JSON/payload compare | PARTIALLY_COMPLIANT | Time presentation unverified |
| Keep server | required | yes | IMPLEMENTED_UNVERIFIED | Dual-device unverified |
| Save local as draft copy | required | new draft id | IMPLEMENTED_UNVERIFIED | |
| No auto replace sent docs | required | pause queue | IMPLEMENTED_UNVERIFIED | |

---

## S24 Export and deletion

**Route:** settings data/export screen (`export/presentation.ts`)

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Export start / progress / download 24h | required | copy + API | IMPLEMENTED_UNVERIFIED | Physical ZIP unverified |
| Reauth | ACC02A | grant | IMPLEMENTED_UNVERIFIED | |
| Type DELETE | exact | `Type DELETE to confirm` | IMPLEMENTED_UNVERIFIED | |
| Consequences copy | lock, links, 30d, no cancel, Apple separate | present in i18n | IMPLEMENTED_UNVERIFIED | Live EMAIL11 unverified |
| Online only | no outbox | copy + rules | IMPLEMENTED_UNVERIFIED | |

---

## S25 Customer access (portal)

**Route:** `/review` + `#token` fragment
**Copy:** `apps/portal/src/review.ts`

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Business / type / masked email | pre-verify only | portal kinds | IMPLEMENTED_UNVERIFIED | Hosted 0011 unverified |
| Request / enter code | 6-digit | `Send verification code` / `Enter the 6-digit code` | IMPLEMENTED_UNVERIFIED | Live EMAIL03 unverified |
| Invalid / expired / revoked | copy | `This review link is no longer available.` etc. | IMPLEMENTED_UNVERIFIED | |
| No private scope before verify | required | BFF + API | IMPLEMENTED_UNVERIFIED | Browser QA unverified |
| Token never `?token=` | fragment only | `readFragmentToken` | IMPLEMENTED_UNVERIFIED | |

---

## S26 Customer review

**Route:** `/review/document`

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Full snapshot + price summary | required | document view | IMPLEMENTED_UNVERIFIED | Live PDF unverified |
| Attachments | photos | none (DOC03 missing) | MISSING | |
| Consent unticked | APR04 text | exact consentLabel `apr04.v1` | IMPLEMENTED_UNVERIFIED | |
| Signer name | 2–100 | `Your name` | IMPLEMENTED_UNVERIFIED | |
| Approve / Request changes | buttons | `Approve` / `Request changes` | IMPLEMENTED_UNVERIFIED | PRD “decline” vs label “Request changes” — SCREEN_MAP/portal aligned; PRD table says approve/decline |
| Confirm dialogs | required | confirmAccept/Reject | IMPLEMENTED_UNVERIFIED | |
| Comment optional 1000 | decline | `Comment (optional, 1000 characters)` | IMPLEMENTED_UNVERIFIED | |
| PDF ready gate | approve unavailable | pdfFailure copy | IMPLEMENTED_UNVERIFIED | |
| Superseded / expired / decided | states | copy present | IMPLEMENTED_UNVERIFIED | |
| This is not a payment | required | accepted copy | IMPLEMENTED_UNVERIFIED | |

---

## S27 Customer receipt

**Route:** `/review/receipt`

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Decision / time / revision | required | receipt view | IMPLEMENTED_UNVERIFIED | Browser unverified |
| Download receipt + document | required | Download PDF | PARTIALLY_COMPLIANT | Live artifact unverified |
| Business contact | required | depends on payload | IMPLEMENTED_UNVERIFIED | |
| No payment claim | required | copy | IMPLEMENTED_UNVERIFIED | |
| Invoice view_only | API05 | invoice_ready hides approve | IMPLEMENTED_UNVERIFIED | |

---

## S28 Support console (admin)

**PRD route:** `/cases`
**Implemented:** `apps/admin/app/page.tsx` placeholder only. OpenAPI: no `/admin` paths.

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Case lookup | required | “Staff console screens are not implemented.” | BLOCKED / MISSING | Staff auth/MFA absent |
| Bounded metadata | required | — | BLOCKED | |
| Allowed operational actions | SEC05 | — | BLOCKED | |
| Staff MFA | required | — | BLOCKED | |
| Reason + 24h grant + audit | required | owner can **store** optional grant; staff cannot consume | BLOCKED | |
| Two-person break-glass | required | — | BLOCKED | |

---

## Portal “Report a problem” (SEC06, not a separate PRD screen ID)

| Element | PRD | Implemented | Status | Discrepancy |
| --- | --- | --- | --- | --- |
| Report a problem | SEC06 | portal copy `Report a problem` + `POST /v1/portal/report` reasons `unexpected` / `wrong_recipient` / `suspicious` | IMPLEMENTED_UNVERIFIED | Staff case queue missing |
| No public directory | required | no listing | IMPLEMENTED_UNVERIFIED | |

---

## Cross-cutting field notes

1. **Money** is integer cents in domain/API; mobile uses string/cents helpers. No JavaScript float money engine found in domain package. Device keyboards unverified.
2. **Dates:** VAL02 requires MM/DD/YYYY presentation — not proven on device.
3. **Trimming:** schema tests cover many fields; not every screen documents trim-on-blur.
4. **48pt vs 44pt:** UI02 48pt buttons vs many `minHeight: 44` — PARTIALLY_COMPLIANT / LOW–MEDIUM.
5. **Customers teammate claim:** no code in this repo. Treat S07/S19 as MISSING, not deferred-to-another-branch.
