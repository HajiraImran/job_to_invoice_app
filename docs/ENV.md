# Environment and Auth configuration

Copy `.env.example` to `.env.local`. Do not put secrets in git.

## Mobile public values

These are the only Auth values that may ship in the iPhone app:

- `EXPO_PUBLIC_API_BASE_URL`
- `EXPO_PUBLIC_AUTH_PROJECT_URL` (Supabase project URL)
- `EXPO_PUBLIC_AUTH_PUBLISHABLE_KEY` (publishable / anon key, never `service_role`)

Expo CLI loads those names from untracked files in `apps/mobile` (`.env` / `.env.local`). It does not load the repository-root `.env.local` for the owner app. Do not commit those files. Do not put `service_role` in them. If any of the three names is missing, the app shows a configuration error that lists the missing names and never prints their values.

A physical device cannot reach `localhost` on the development machine. For Expo Go preview, `EXPO_PUBLIC_API_BASE_URL` must be a URL the phone can reach (for example a LAN address). The app still uses real Supabase Auth, OTP, API calls, SecureStore, provisioning, and onboarding. Do not replace SecureStore with AsyncStorage.

Expo Go development preview:

```sh
pnpm --filter @job-to-invoice/mobile dev:go
```

That command is `expo start --go`. It does not replace `pnpm --filter @job-to-invoice/mobile dev` (EAS development-client). Expo Go is for development preview only. It does not VERIFY:

- production signing
- native development builds
- physical Keychain/Keystore behavior
- background/offline production behavior

## API private values

- `AUTH_PROJECT_URL` — same project URL as mobile
- `AUTH_PUBLISHABLE_KEY` — not used by the API for commercial writes
- `AUTH_ISSUER` — `https://<project-ref>.supabase.co/auth/v1`
- `AUTH_AUDIENCE` — `authenticated`
- `DATABASE_URL_API` — login role that can `SET ROLE api_app`. Never `service_role`.
- `DATABASE_URL_MIGRATIONS` — local embedded Postgres, or for hosted apply from an IPv4-only network the **session** pooler URL (`postgres://postgres.<linked-ref>:<percent-encoded-password>@aws-0-<region>.pooler.supabase.com:5432/postgres`). Username must match `supabase/.temp/project-ref`. Port `5432` must be explicit. Never the IPv6-only `db.<ref>.supabase.co` host. Never port `6543`. Never query parameters such as `pgbouncer=true`. Never `service_role` (D-012). Reserved password characters must be percent-encoded. Do not put this URL in repository files.

Hosted apply from PowerShell, process environment only:

```powershell
$env:DATABASE_URL_MIGRATIONS = "<percent-encoded session-pooler URI>"
pnpm hosted:db-check
pnpm hosted:db-push
Remove-Item Env:DATABASE_URL_MIGRATIONS
```

`pnpm hosted:db-check` is `--dry-run` only and does not pass `--yes`. `pnpm hosted:db-push` applies with `--yes` so the CLI does not wait for a confirmation prompt. Neither prints the URL, password, argv, or raw CLI text; failures are an allowlisted category. Hosted migration commands use the root-pinned `supabase` 2.117.0 CLI. The wrapper resolves repository `supabase/dist/supabase.js` before any global npm PATH shim and launches it through `process.execPath` with `shell:false`. `.cmd`/`.ps1` shims are not used. Passing `--db-url` still exposes it on the local process list while the CLI runs.

Authorized hosted development apply from GitHub Actions is `.github/workflows/hosted-development-migrations.yml`. It is `workflow_dispatch` only. The confirmation input must be exactly `APPLY_0005` before the `development` Environment secret `DATABASE_URL_MIGRATIONS` is read. The pre-push check must report `pending: 0005_customers_jobs.sql`; the post-apply check must report `ok: true` and `pending: (none)`. Do not put that URI in repository files or workflow YAML.

The API verifies owner access tokens with the project JWKS:

`GET {AUTH_PROJECT_URL}/auth/v1/.well-known/jwks.json`

Hosted projects must use asymmetric JWT signing keys (SREF06). Shared-secret HS256 verification is not implemented.

## Supabase dashboard steps (ACC01) — unverified until staging evidence

Apply these in Authentication for each hosted project. Code cannot set hosted dashboard values.

1. Authentication → Providers → Email: enabled. Password sign-in may remain off; this app uses email OTP only.
2. Email OTP length: **6**.
3. Email OTP expiry: **600 seconds** (10 minutes). Default is 3600; change it.
4. Email send rate / max frequency: **60 seconds**.
5. Confirm failed OTP attempts per challenge are **5** or stricter. Record the observed provider setting in staging.
6. Confirm sign-up and sign-in share the same email OTP flow and do not disclose whether the email already exists.
7. Disable session replay in Sentry. Do not add Auth debug logging of codes or tokens.

Local `supabase/config.toml` records the same Auth profile for future CLI use:

```toml
[auth.email]
enable_signup = true
otp_length = 6
otp_expiry = 600
max_frequency = "1m0s"
```

Until a project URL and publishable key are present, `pnpm test:db` and API JWT tests still run against embedded PostgreSQL. Real OTP delivery, resend throttling, and mailbox E2E remain unverified.

## Expo SecureStore

Refresh tokens are stored by `@supabase/supabase-js` using `expo-secure-store` (`jti.supabase.session`). iOS uses the Keychain. Confirm on a physical iPhone that the session survives restart and is gone after sign-out (D-008).
