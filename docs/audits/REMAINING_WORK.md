# Remaining work

Audited commit `184380a` on `main` (2026-09-23). Ordered so later slices do not invent staff identities, paid products, or hosted evidence.

Responsible-party key: **Cursor** (implementation), **Claude** (review), **Human** (config/legal/device/ops), **External** (Apple/RevenueCat/Resend/Supabase).

Completion criteria for the product remain SOP §42 + this audit’s eight-status rules: every applicable assertion `VERIFIED_COMPLIANT`, no HIGH/CRITICAL open, hosted + physical + external evidence present.

---

## 1. Implemented and fully compliant

Only pure domain calculation assertions earned `VERIFIED_COMPLIANT` in this audit (shared `packages/domain` + this-audit 51/51 domain tests). They are **not** a customer-visible journey.

| Requirement ID | Audit key | Issue | Evidence | Severity | Required fix | Packages | Tests | External | Party | Order | Completion criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FIN01 | FIN01.core | None for the calc rule | `packages/domain` fixtures; `pnpm --filter @job-to-invoice/domain test` 51 passed | — | Keep importing this package; never reimplement floats | domain | already present | none | — | — | Continues to pass F01–F03 |
| FIN03 | FIN03.core | None for the calc rule | F05/F06 fixtures | — | none | domain | present | none | — | — | F05/F06 stay exact |
| F01–F12 | F01.core … F12.core | None for domain fixtures | same | — | PDF/mobile must keep using same engine (QA30 still open) | domain | present | none | Cursor later | 8 | QA30 matching cents on mobile/server/PDF |

Do not treat quote/invoice screens as complete because these fixtures pass.

---

## 2. Implemented but unverified

Vertical paths exist in code + local tests. Missing hosted, device, live email, or production TLS.

| Requirement ID | Audit key | Exact issue | Evidence | Severity | Required fix | Likely files | Required tests | External | Party | Order | Completion criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S02/S03/ACC01 | S02.field.email | OTP UI exists; production Keychain + dashboard caps unverified | `welcome`/`sign-in`/`verify`; historical Expo Go only | HIGH | Native session storage QA; confirm provider 6/600s/60s/5 | mobile session, Supabase dashboard | QA01 QA02 on device | Supabase Auth | Human + Cursor | 3 | Device OTP + secure storage PASS |
| S04/VAL01/VAL02 | S04.field.* | Setup form+API+DB local | setup.tsx, workspace tests | HIGH | Device + hosted `complete_workspace_setup` | mobile setup, 0004 | QA01 | Hosted DB | Human | 3 | Setup on iPhone + hosted function |
| S05/S06/S08/JOB* | S05.core | Jobs list/create/lifecycle local | jobs screens + lifecycle tests | HIGH | Device QA; hosted 0005+0021+0022 | mobile jobs, api jobs | QA14 device | Hosted | Human + Cursor | 4 | JOB01/02 on device + hosted |
| S09–S12/QUO*/APR* | S09.core | Quote edit/publish/request local | quote.tsx, requests tests | HIGH | iOS + production email | mobile quotes, worker email | QA09 live mailbox | Resend | Human | 5 | One real review email + portal approve |
| S13/S14/CHG* | S13.core | Extra/reduce without photos | change/reduce screens | HIGH | Device + live CO email; photos are §4 | mobile changes, 0018 | QA27–28 device | Hosted 0018, Resend | Cursor + Human | 6 | Change approved on portal |
| S15–S18/BIL*/TX03–04 | S15.core | Invoice/ledger local API | invoices.test.ts | HIGH | Device PDF/share/pay/credit/void | mobile invoices, worker PDF | QA37–43 device | R2, Resend | Cursor + Human | 7 | Full JRN05 on device |
| JRN06/API04 | JRN06.core | Direct invoice API tests | invoices.direct.test.ts | HIGH | Device + hosted 0019 | direct-screen | QA44 device | Hosted | Human | 7 | Direct issue + label on device |
| S20/CAT01 | S20.core | Items tab local | 0020, items tests | MEDIUM | Hosted 0020 + device | mobile items | QA15 device | Hosted | Human | 4 | Seeds + copy-on-use on device |
| SUB03/S21 trial | S21.field.trial | Trial start local | 0023, subscription tests | MEDIUM | Device + EMAIL09 mailbox | subscription.tsx | QA11–12 device | Resend | Human | 8 | Trial start on iPhone |
| S22 support / DEC13 | S22.field.support | Owner case POST local | 0026, support.tsx | MEDIUM | Device; SUPPORT_URL if public address wanted | support.tsx | QA59 owner half | SUPPORT_URL | Human | 9 | Case stored; no SLA claim |
| S24/EXP/PRV03 | S24.core | Export/delete local | exports/deletion tests | HIGH | Physical ZIP, EMAIL10/11, purge | worker export | QA56–57 live | R2, Resend | Human | 10 | ZIP download + deletion receipt |
| S25–S27 | S25.core | Portal local + Android 2026-09-21 historical | portal review.ts | HIGH | Browser matrix QA61; hosted 0011 | portal | QA18–25 live | Hosted, Resend | Human | 5 | Safari/Chrome matrix PASS |
| SYNC01–06 | SYNC01.core | SQLite/outbox unit + partial Android | sync/* | HIGH | Combined QA05–08, dual-device 409 | mobile sync | QA05–08 | Devices | Human | 4 | Both phones + airplane mode |
| ARC02/DB04 | ARC02.core | Local RLS/immutability tests | supabase/tests | CRITICAL | Hosted catalog + two-tenant live | hosted project | QA03 hosted | Hosted | Human | 2 | Catalog through 0026 + two-tenant 404 |
| EMAIL01–11 | EMAIL01.core | Templates + outbox | worker email tests | HIGH | Production domain auth | worker | mailbox | SPF/DKIM | Human | 5 | NTF02 verified |
| ANA01 | ANA01.core | Allowlist local | analytics schema | MEDIUM | Live funnel without PII | api analytics | QA63 live | none | Cursor + Human | 11 | Staging events reviewed |

---

## 3. Partially compliant

| Requirement ID | Audit key | Exact issue | Evidence | Severity | Required fix | Packages | Tests | External | Party | Order | Completion criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S01 | S01.sample_document | Fictional sample quote card now renders; cannot send | welcome.tsx + `src/welcome/presentation.ts` | LOW | Device/VoiceOver confirmation | mobile welcome | `presentation.test.ts` passed | none | Human | 3 | Sample visible on iPhone; send still impossible |
| S01 | S01.terms_privacy_links | Plain text, not links | en.ts `terms` | HIGH | Real Terms + Privacy URLs (after PRV01) | mobile welcome | a11y link roles | Legal URLs | Human + Cursor | 11 | Tappable notices |
| S06 | S06.customer_sheet | Inline name, no S07 sheet | jobs/form.ts | HIGH | Wire S07 after customers exist | jobs/new.tsx | CUS tests | none | Cursor | 1 | Sheet opens S07 |
| S10 | S10.route | No `/line` route | SCREEN_MAP vs quote.tsx | LOW | Either dedicated screen or recorded PRD/SCREEN_MAP decision | mobile | S10 QA | none | Human + Cursor | 4 | One authoritative mapping |
| S11 | S11.paywall | Free/trial gate only | subscription screen | HIGH | Paid StoreKit paywall | S21 | QA10+QA45 | RevenueCat | External + Cursor | 12 | Fourth job shows real prices |
| S16 | S16.pdf_share | PDF/share not device-proven | matrix | HIGH | Open/share official PDF | mobile export | QA54 device | R2 | Human | 7 | Share sheet shows official bytes |
| S21 | S21.billing_states | Only free/trial/ended | subscription.tsx | HIGH | All PRD billing states | mobile + api TX05 | QA45–51 | Apple | Cursor + External | 12 | Each state reachable in sandbox |
| S22 | S22.profile_defaults | No defaults/notifications/privacy/email-change | settings/index.tsx | HIGH | Implement remaining S22 | mobile settings, ACC03 | ACC03 tests | none | Cursor | 11 | All S22 sections present |
| S23 | S23.route | Inline vs modal | conflict.ts + quote.tsx | LOW | Dedicated modal or decision record | mobile | QA07 | two devices | Cursor | 4 | Conflict UX matches PRD |
| S26 | S26.attachments | No photos | portal | MEDIUM | After DOC03 | portal | QA52 | storage | Cursor | 6 | Attachments visible post-verify |
| DEC13 | DEC13.core | Owner intake yes; staff/public address no | 0026 + empty SUPPORT_URL | MEDIUM | Staffing + URL | admin, env | QA59 | SUPPORT_URL | Human | 13 | Public address or documented omission |
| NFR06 | NFR06.core | Partial timeouts | bootstrap 15s | MEDIUM | Remaining mobile command timeouts | mobile api client | timeout tests | none | Cursor | 5 | All mutation timeouts documented |
| DB05/PRV05 | PRV05.core | Objects purge local; restore ledger ops | deletion worker | HIGH | Restore runbook + provider deletes | ops, worker | QA58 QA66 | backups | Human | 14 | Quarterly drill recorded |
| UI01–UI02 | UI02.hit_target | 44pt vs 48pt | theme + screens | MEDIUM | 48pt primary buttons; VoiceOver | mobile theme | QA61 | devices | Cursor + Human | 11 | QA61 PASS |
| NTF05 | NTF05.core | Some copy present | en.ts / portal | MEDIUM | Remaining surfaces | i18n | copy QA | none | Cursor | 5 | Every listed NTF05 string |
| SOP.matrix | SOP42.matrix_update | Matrix overstates VERIFIED; not updated this audit | REQUIREMENTS_MATRIX.md | MEDIUM | Reconcile matrix to this ledger | docs | none | none | Human + Cursor | 15 | Matrix matches audit statuses |
| ACC02A | ACC02A.email_change | Issuer exists; email_change deferred | D-002 vs D-024 | HIGH | Implement ACC03 grants | action-grants | ACC03 tests | none | Cursor | 11 | Email change with grant |

---

## 4. Non-compliant

Implementation contradicts the PRD (not merely unverified).

| Requirement ID | Audit key | Exact issue | Evidence | Severity | Required fix | Packages | Tests | External | Party | Order | Completion criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S01 | S01.terms_privacy_links | Required links are static text | welcome.tsx:25 | HIGH | Links to published notices | mobile | a11y | Legal | Human + Cursor | 11 | Links open notices |
| S06 | S06.customer_sheet | No customer sheet | jobs/new.tsx, form.ts | HIGH | S07 integration | mobile | CUS01 | none | Cursor | 1 | Create job uses customer record |
| S19 / SCREEN_MAP | S19.tab | Three tabs vs four | `_layout.tsx` vs SCREEN_MAP | HIGH | Customers tab | mobile tabs | nav test | none | Cursor | 1 | Four tabs; Customers reachable |
| S07 | S07.* | Entire screen absent | no customers routes | HIGH | Build S07 | mobile, api, db | CUS01 | none | Cursor | 1 | All S07 fields |
| VAL01 customer email | VAL01.customer_email | Cannot capture on create | job form | HIGH | Customer email on S07 | schemas | VAL01 tests | none | Cursor | 1 | Approval has mandatory email from customer |
| UI04 | UI04.core | Not all data screens implement all six states | various screens | MEDIUM | State matrix per screen | all apps | Screen QA | none | Cursor | 5 | SCREEN_MAP state table complete |
| MATRIX INV01 | INV01.duplicate | Duplicate row | REQUIREMENTS_MATRIX.md:35–36 | LOW | Deduplicate when docs allowed | docs | none | none | Human | 15 | Single INV01 row |

---

## 5. Missing

No genuine implementation in this repository.

| Requirement ID | Audit key | Exact issue | Evidence | Severity | Required fix | Packages | Tests | External | Party | Order | Completion criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S07 CUS01 | S07.field.name | Customer form absent | no routes | HIGH | CRUD + duplicate warn | api customers, mobile | CUS01 QA15 | none | Cursor | 1 | Vertical customer path |
| S19 CUS02 | S19.core | Customers tab absent | `_layout.tsx` | HIGH | List/detail/archive | mobile, api | CUS02 | none | Cursor | 1 | Archive ≠ history rewrite |
| DOC03 DOC04 | S13.field.photos | No camera/HEIC/EXIF | grep photo = 0 in mobile | HIGH | Asset pipeline | mobile, worker, storage | QA52 | bucket | Cursor | 6 | 10 images sanitized |
| ACC03 | ACC03.core | Email change absent | matrix PENDING | HIGH | Reauth + notify old email | api, S22 | QA02 email-change | Auth | Cursor | 11 | UUID stable; old email notified |
| SUB01 SUB06–08 | S21.field.storekit | No purchases SDK | no package | HIGH | RevenueCat + StoreKit | mobile, worker TX05 | QA45–51 | Apple, RC | External + Cursor | 12 | Sandbox purchase verified |
| TX05 | TX05.core | No billing webhook algorithm | no RC webhook handler productized | HIGH | provider_events + nightly reconcile | api webhooks, worker | QA48 | RC secret | Cursor | 12 | Dup events idempotent |
| S28 SEC05 | S28.core | Admin placeholder | admin/page.tsx | HIGH | After staff IdP | admin, api | QA59–60 | Staff IdP | Human then Cursor | 13 | MFA console |
| TX06 | TX06.core | Public link compromise staff path | PENDING | HIGH | Staff revoke + evidence | admin, api | QA17 TX06 | staff | Cursor | 13 | Revoke after approve keeps decision |
| PRV01 | PRV01.core | No privacy notice | no notice URL | HIGH | Counsel text + S22/S01 links | legal, mobile | none | Counsel | Human | 11 | Published notice |
| DEL03 | DEL03.core | No Figma/prototype signoff | PRD §08 | MEDIUM | Design deliverables | design | UI signoff | none | Human | 11 | Editable source S01–S28 |
| MET01–08 | MET01.core | No cohort/SLO/CAC jobs | no reports | MEDIUM | Analytics jobs | worker/ops | cohort | none | Human | 14 | Hypotheses measured not claimed |
| OPS04–07 REL* | REL01.core | No store/on-call/TestFlight | none | HIGH | Ops + store package | ops | REL checklist | Apple | Human | 14 | TestFlight RC |
| QA61 NFR01 | NFR01.core | No a11y harness | none | HIGH | VoiceOver + WCAG portal | mobile, portal | QA61 | devices | Human + Cursor | 11 | AA + VoiceOver notes |
| customers API | API.customers | No module registered | api index | HIGH | `/v1/customers` | api | isolation tests | none | Cursor | 1 | Cross-tenant 404 |

---

## 6. Blocked externally

| Requirement ID | Audit key | Exact issue | Evidence | Severity | Required fix | Packages | Tests | External | Party | Order | Completion criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S28 SEC05 QA59–60 | S28.staff_auth | No staff IdP/MFA/roles/STAFF_AUTH_CONFIG | empty staff config; admin placeholder | CRITICAL | Provision staff auth; do not invent users | admin, api, env | QA59–60 | IdP | Human | 13 | MFA login works |
| SUB01/06–08 QA45–51 | SUB01.products | No Apple products / RC / SDK | no packages; provisional IDs | HIGH | App Store Connect + RC + webhook | mobile, worker | sandbox | Apple, RC | Human | 12 | Real localized prices |
| DEC13 public address | DEC13.support_url | SUPPORT_URL empty | .env.example | LOW | Set URL or keep in-app only | env | none | mailbox | Human | 9 | Address monitored |
| Hosted 0005–0026 | HOSTED.apply | Workflow still pending-gates 0026; catalog proof stops at 0004 (2026-09-15) | hosted-development-migrations.yml; DATABASE.md | CRITICAL | Authorized APPLY_* only; then catalog SELECT | supabase | hosted list | Supabase | Human | 2 | schema_migrations includes 0026 |
| DOC05 production | DOC05.r2 | Hosted R2 not provisioned | matrix | HIGH | Provision private bucket | config | presign | R2 | Human | 7 | 5-min signed URLs prod |
| NTF02 | NTF02.domain | Domain auth unverified | none live | HIGH | SPF/DKIM/DMARC | DNS, Resend | mailbox headers | DNS | Human | 5 | Authenticated From |
| PRV04 Auth revoke | PRV04.service_role | Cannot revoke refresh without service_role | matrix PRV04 | HIGH | Supported Auth admin path that is not service_role-in-app | api | deletion | Supabase | Human + Cursor | 10 | Sessions die after lock |
| Android operator app | DEC01.android | D-001 defers operator Android | D-001 | NOT_APPLICABLE product | Do not build Android operator app for v1 | — | SOP store Android if distributed | — | Human | — | Decision stands |

---

## 7. Tests still required

| Requirement ID | Audit key | Exact issue | Evidence | Severity | Required fix | Packages | Tests | External | Party | Order | Completion criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| QA03 hosted | QA03.hosted | No live two-tenant hosted | local only | CRITICAL | Hosted isolation | api | QA03 | Hosted | Human | 2 | 404 no leak |
| QA05–08 | QA05.device | Combined offline not verified | partial Android only | HIGH | Device script | mobile | QA05–08 | 2 iPhones | Human | 4 | Exact restore + 409 |
| QA21 parallel | QA21.race | Sequential only | requests.test.ts | HIGH | Parallel stress | api | QA21 | none | Cursor | 5 | One terminal winner |
| QA30 PDF | QA30.pdf | Domain only | fixtures | HIGH | PDF bytes match F01–F12 | worker, domain | QA30 | none | Cursor | 7 | Exact cents in PDF |
| QA45–51 | QA45.iap | No sandbox tests | missing SDK | HIGH | After IAP | mobile | QA45–51 | Apple | Cursor | 12 | No false Pro |
| QA52 | QA52.photos | Feature missing | no tests | HIGH | After DOC03 | worker | QA52 | none | Cursor | 6 | EXIF gone |
| QA61 | QA61.a11y | No harness | none | HIGH | VoiceOver + 200% | mobile portal | QA61 | devices | Human | 11 | Recorded PASS |
| QA63–68 | QA63.ops | Analytics/load/secret program incomplete | secret-scan 353 this audit only | MEDIUM | Staging program | ci | QA68 | none | Human | 14 | QA68 production values |
| API this-audit | TEST.api_skipped | `jobs.lifecycle.test.ts` 5 skipped after 120s PG init this run | terminal | MEDIUM | Re-run api tests without contention | api | full api suite | none | Cursor | 2 | 0 skipped unexpected |
| test:db | TEST.db_not_rerun | Not re-run this audit | — | MEDIUM | `pnpm test:db` locally | supabase | privilege | none | Cursor | 2 | Pass recorded |

---

## 8. Physical / device verification still required

| Requirement ID | Audit key | Exact issue | Evidence | Severity | Required fix | Packages | Tests | External | Party | Order | Completion criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NFR02 | NFR02.matrix | SE + current iPhone, airplane, low storage | none this audit | HIGH | Device matrix | mobile | NFR02 | devices | Human | 3 | Checklist signed |
| JRN01–07 | JRN01.device | No this-audit device run | historical notes only | HIGH | Reproduce journeys | all | journey list | devices | Human | 3–10 | Each journey PASS |
| VoiceOver | UI01.vo | Unverified | none | MEDIUM | VO pass | mobile | QA61 | iPhone | Human | 11 | Focus order |
| Keychain | ACC01.secure | Expo Go ≠ production | matrix | HIGH | Dev-client / TestFlight | mobile | ACC01 | Apple | Human | 3 | Tokens not in logs |
| Dual-device | DEC04.two_phones | Unverified | none | HIGH | Two signed-in iPhones | mobile | DEC04 | 2 phones | Human | 4 | No cross-wipe bugs |
| ADB/plaintext | SYNC01.inspect | SQLite not inspected this audit | none | HIGH | Encrypted-at-rest check | storage | SYNC01 | device | Human | 4 | No plaintext PII |

---

## 9. Live external-service verification still required

| Requirement ID | Audit key | Exact issue | Evidence | Severity | Required fix | Packages | Tests | External | Party | Order | Completion criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hosted migrations | HOSTED.catalog | 0026 not proven | workflow pending grep | CRITICAL | Authorized apply + catalog | supabase | list | Supabase | Human | 2 | 0026 in history |
| Resend | EMAIL*.live | No mailbox this audit | templates only | HIGH | Send to allowlisted box | worker | headers | Resend | Human | 5 | EMAIL01–11 received |
| R2 | DOC05.prod | Not provisioned | docs | HIGH | Provision | config | GetObject | R2 | Human | 7 | PDF download prod |
| RevenueCat | SUB07.live | Absent | none | HIGH | Webhook + sandbox | worker | QA48 | RC | Human | 12 | purchase_verified server |
| Sentry | OPS03.sentry | Wiring later | redaction tests only | MEDIUM | Wire no replay | all | OPS03 | Sentry | Human | 14 | No PII in events |
| Apple IAP | REL01 | No store | none | HIGH | Privacy labels + IAP | mobile | REL01 | Apple | Human | 14 | Submission package |

---

## 10. Claude work still required

See `CLAUDE_RESPONSIBILITY_AUDIT.md`.

| Requirement ID | Audit key | Exact issue | Evidence | Severity | Required fix | Packages | Tests | External | Party | Order | Completion criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SOP §16 | CLAUDE.SOP16 | No architecture review artifact | no report | HIGH | Read-only review | docs | none | none | Claude | 1 | Dated BLOCKER/HIGH list |
| SOP §39 | CLAUDE.SOP39 | No adversarial review | no report | HIGH | Review mode | all | none | none | Claude | 2 | Findings with files |
| SOP §41 | CLAUDE.SOP41 | No hostile security review | no report | CRITICAL | After hosted + staff | api, db | none | none | Claude | 13 | Authz/RLS signed |
| SOP §42 | CLAUDE.SOP42 | Cursor substitute; matrix not updated | this folder | HIGH | Accept or re-audit; update matrix later | docs | none | none | Human + Claude | 15 | Matrix = VERIFIED material |
| SOP §43 | CLAUDE.SOP43 | No fix verification loop | n/a | HIGH | After Cursor fixes | all | regression | none | Claude | 16 | BLOCKER/HIGH closed |

---

## 11. Human / manual work still required

| Requirement ID | Audit key | Exact issue | Evidence | Severity | Required fix | Packages | Tests | External | Party | Order | Completion criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PRV01 | PRV01.counsel | Counsel notice | missing | HIGH | Draft + review | legal | none | Counsel | Human | 11 | Published |
| OPS04 | OPS04.staff | On-call | missing | HIGH | Staff or no 24h claim | ops | none | Human | Human | 13 | Runbook |
| REL02–03 | REL02.store | Store identity / pilots | missing | HIGH | Accounts, screenshots, 15–25 pilots | ops | REL | Apple | Human | 14 | Pilot started |
| APPLY_0026 | HOSTED.confirm | Human confirmation string | workflow | CRITICAL | Type APPLY_0026 only when pending matches | ci | workflow tests | Supabase | Human | 2 | Apply recorded |
| Dirty files | TREE.dirty | tsconfig + next-env dirty | git status | LOW | Owner decide; do not mix into product PRs | those two files | none | none | Human | 15 | Clean or dedicated commit |
| Customer teammate | CUS.handoff | Claimed other teammate; absent here | no code | HIGH | Merge or implement | api/mobile | CUS | none | Human | 1 | Code on main |

---

## 12. SOP corrections still required

| Requirement ID | Audit key | Exact issue | Evidence | Severity | Required fix | Packages | Tests | External | Party | Order | Completion criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SOP source PDF | SOP.source | `docs/source/` absent | glob 0 files | MEDIUM | Restore PDF or record conversion provenance | docs | none | none | Human | 15 | Source locatable |
| SOP vs PRD clock/PostHog/Android | SPEC.D001 | SOP text still generic | SOP §17/§37 | LOW | Annotate SOP with D-001 pointers | docs/SOP.md | none | none | Human | 15 | No reader confusion |
| Status vocabulary | SPEC.matrix.verbs | Three vocabularies | matrix vs SOP42 vs this audit | MEDIUM | One glossary | docs | none | none | Human | 15 | Shared statuses |
| DATABASE.md hosted narrative | SPEC.hosted | APPLY_0010 leftover vs APPLY_0026 | DATABASE.md | HIGH | Rewrite hosted evidence from a live list | docs | none | Hosted | Human | 2 | Doc matches catalog |
| SOP §42 matrix update | SOP42.update | Not done this audit | user constraint | MEDIUM | After acceptance, update matrix honestly | REQUIREMENTS_MATRIX | none | none | Cursor later | 15 | No false VERIFIED |
| Fabricated evidence risk | SOP.honesty | Historical device dates not reproduced | matrix | HIGH | Keep IMPLEMENTED vs VERIFIED honest | docs | none | none | All | always | No new false VERIFIED |

---

## Recommended execution order (summary)

1. **Customers vertical (S07/S19/CUS/API)** — highest product hole on main.
2. **Prove hosted catalog** (authorized apply only) + two-tenant isolation + re-run skipped API/db tests.
3. **Device auth/setup/jobs/offline** on iPhone (NFR02).
4. **Live email + portal browser matrix** for quotes/changes.
5. **Photos DOC03** then change-order attachments.
6. **Invoice PDF/share/ledger device** + QA30 PDF cents.
7. **Export/deletion live** without using production customer data.
8. **Trial device + EMAIL09**.
9. **S22 remainder + ACC03 + privacy/terms links** after counsel.
10. **Paid IAP** only after Apple/RC exist.
11. **S28** only after staff MFA exists.
12. **Claude §16/§39/§41**, then Cursor BLOCKER/HIGH fixes, then Claude §43.
13. **Ops/store/MET/a11y**.
14. **Reconcile docs** (matrix, DATABASE.md, SOP glossary).

Until that list is done, the application remains **NOT COMPLETE**.
