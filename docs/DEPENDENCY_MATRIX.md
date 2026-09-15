> Source: `docs/PRD.md` ARC01, ARC05, §33, SREF01–SREF08
> Foundation pins recorded 2026-09-14 (D-005). Encrypted SQLite and PDF remain TBD spikes.

# Dependency matrix

Substitution requires an architecture decision that preserves behaviour and acceptance tests (ARC01). CI must fail on incompatible lockfile changes (ARC05).

## Required components

| Component | Required capability | PRD IDs | Vendor default | Version | Environments | Secrets / config | Substitution |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TypeScript | Strict shared types across apps | ARC01 ARC05 | TypeScript | 5.9.3 | all | — | Must remain TS monorepo; not 7.x (D-006) |
| pnpm + Turborepo | Workspaces and task graph | ARC01 DEL01 | pnpm, turbo | pnpm 12.4.1, turbo 2.10.12 | dev CI | — | Equivalent monorepo tool OK (D-004) |
| React Native | iPhone owner UI | DEC01 ARC01 | React Native | 0.86.3 | mobile | — | No Android v1 product gate; must match Expo 57 |
| Expo + EAS | Dev/preview/production iOS builds; Expo Go is development preview only, not release | SYNC01 REL01 | Expo | 57.0.22 | mobile | EAS credentials | Must support encrypted SQLite spike |
| Expo Router | Owner navigation S01–S24 | ARC01 | Expo Router | 57.0.21 | mobile | — | — |
| Expo Notifications | Reserved; native push deferred | NTF01 | Expo Notifications | not shipped v1 | — | — | Do not add push in v1 |
| Next.js | Portal + admin (D-003) | DEC02 ARC01 S28 | Next.js | 16.3.5 | portal admin | PORTAL_ORIGIN | Admin framework reversible |
| Fastify | Domain REST /v1 | ARC01 API01 | Fastify | 5.12.4 | api | API_BASE_URL | Must stay server-side commercial writes |
| Node runtime | API and worker | ARC01 ARC05 | Node | 22.23.2 (engines >=22.13 <23) | api worker | — | Same LTS in all envs |
| packages/domain | Money, schemas, state | INV01 FIN* | first-party | repo | mobile api worker | — | No alternate money lib |
| PostgreSQL | Tenant schema, RLS, triggers | DB* ARC02 | Supabase Postgres | 16 (CI image) | all envs separate | DATABASE_URL_API, DATABASE_URL_WORKER, DATABASE_URL_PURGE, DATABASE_URL_MIGRATIONS | FORCE RLS; no service_role in apps |
| Supabase Auth | Owner email OTP | ACC01 | Supabase Auth | hosted project + JWKS | separate per env | AUTH_* ; dashboard OTP 6 / 600s / 60s / 5 fails (docs/ENV.md) | Verify SDK limits staging |
| Supabase Storage | Private objects; API-minted signed URLs only | DOC05 | Supabase Storage | TBD | separate | server-only signing via api_app/worker_app | No client Storage/Realtime/Edge; no user JWT |
| Encrypted SQLite | Per-owner local drafts | SYNC01 | SQLCipher or supported module | TBD spike | mobile | OS-secured key | Plaintext forbidden |
| HTML-to-PDF | DOC01 layout | DOC01 | TBD spike | TBD | worker | licensed fonts | Must pass QA54 |
| RevenueCat | Apple entitlement server | SUB* | RevenueCat | TBD | sandbox/prod separate | REVENUECAT_* | SREF03 SREF04 |
| StoreKit | Localized prices; IAP | SUB01 REL01 | Apple | current SDK | mobile | MONTHLY/ANNUAL_PRODUCT_ID | No external purchase exception |
| Resend | Transactional email | NTF02 EMAIL* | Resend | TBD | allowlist staging | EMAIL_* | SPF/DKIM/DMARC |
| Sentry | Crashes; no replay/screenshots | OPS03 | Sentry | TBD | all | ERROR_REPORTING_DSN | Not product analytics |
| First-party analytics | Event tables + batch API | ANA* DEC12 | first-party | repo | api | — | No PostHog, no ad SDK |
| Maestro | Critical owner E2E | TEST_PLAN | Maestro | TBD | CI/device | — | iPhone journeys |
| GitHub | Source of truth | DEL01 | GitHub | — | — | — | Owner-controlled |
| Render | Default US host API/web/worker | ARC01 | Render paid | TBD | staging/prod | — | Same-region substitute OK |
| Apple Developer | Signing, IAP, TestFlight | REL02 | Apple | — | — | owner account | §34 owner input |

## Configuration keys (PRD §33)

APP_ENV; PUBLIC_APP_NAME; SUPPORT_URL; OWNER_APP_BUNDLE_ID; API_BASE_URL; PORTAL_ORIGIN; AUTH_PROJECT_URL; AUTH_PUBLISHABLE_KEY; AUTH_ISSUER; AUTH_AUDIENCE; DATABASE_URL_API; DATABASE_URL_WORKER; DATABASE_URL_PURGE; DATABASE_URL_MIGRATIONS; APPROVAL_TOKEN_HASH_KEY; OTP_HASH_KEY; APPROVAL_EVIDENCE_ENCRYPTION_KEY (versioned envelope; decrypt only for export or live staff grant); REVENUECAT_PUBLIC_IOS_KEY; REVENUECAT_SECRET_KEY; WEBHOOK_AUTH_SECRET; MONTHLY_PRODUCT_ID; ANNUAL_PRODUCT_ID; EMAIL_API_KEY; EMAIL_WEBHOOK_SECRET; EMAIL_FROM_DOMAIN; ERROR_REPORTING_DSN; STAFF_AUTH_CONFIG; BACKUP_RETENTION_DAYS (≤35); FEATURE_NEW_PUBLICATION; FEATURE_PURCHASES; LIMITS_VERSION.

`STORAGE_SERVICE_KEY` and Supabase `service_role` are not application connection strings. CI fails if they appear in `apps/api` or `apps/worker` config.

Empty mandatory production values must prevent startup or deploy (QA68).

## Explicit non-goals (v1)

- PostHog or any tracking/advertising SDK (DEC12, D-001)
- Android operator App Store / Play listing as a product gate
- Customer-installable app
- Native push
- Payment-card collection
- Client-held service-role or RevenueCat secret keys
- `service_role` or `BYPASSRLS` in API or worker runtime pools

## Primary sources (recheck at pin and submission)

| ID | Source |
| --- | --- |
| SREF01 | Apple App Review Guidelines |
| SREF02 | Apple account deletion |
| SREF03 | RevenueCat webhooks |
| SREF04 | RevenueCat identifying customers |
| SREF05 | WCAG 2.2 |
| SREF06 | Supabase JWTs |
| SREF07 | Supabase RLS |
| SREF08 | Expo SQLite / encryption support |

Pinned 14 September 2026 for repository foundation. Recheck SQLCipher, PDF, RevenueCat SDK, and store submission separately. The lockfile is `pnpm-lock.yaml`.
