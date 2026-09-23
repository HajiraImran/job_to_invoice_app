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
- `DATABASE_CONNECT_ATTEMPT_TIMEOUT_MS` / `DATABASE_CONNECT_DEADLINE_MS` — optional server-only API and worker pool timeouts in milliseconds. Defaults are `2000` and `5500` so a genuine outage fails fast. Empty means default. Values must be positive integers; attempt timeout max `30000`; deadline max `90000` and must be ≥ attempt timeout. For slow local/Supabase connections, `10000` and `25000` are a bounded starting point. Never `EXPO_PUBLIC_*`. Never log the values with connection strings.
- `DATABASE_URL_WORKER` — login role that may assume `worker_app` via `SET LOCAL ROLE worker_app`. Never `service_role`. `worker_app` itself stays `NOLOGIN`. All worker operations still use transaction-local role switching; do not connect as `worker_app` and do not use a persistent `SET ROLE`.
- `DATABASE_URL_MIGRATIONS` — local embedded Postgres, or for hosted apply from an IPv4-only network the **session** pooler URL (`postgres://postgres.<linked-ref>:<percent-encoded-password>@aws-0-<region>.pooler.supabase.com:5432/postgres`). Username must match `supabase/.temp/project-ref`. Port `5432` must be explicit. Never the IPv6-only `db.<ref>.supabase.co` host. Never port `6543`. Never query parameters such as `pgbouncer=true`. Never `service_role` (D-012). Reserved password characters must be percent-encoded. Do not put this URL in repository files.
- `STORAGE_ENDPOINT` — S3-compatible API endpoint used by the worker (D-016). Server only. Production/staging must be HTTPS on a public host. Development may use `http://127.0.0.1:9000` or another localhost/RFC1918 HTTP URL for private MinIO.
- `STORAGE_DOWNLOAD_ENDPOINT` — optional externally reachable endpoint used only when minting 5-minute presigned GET URLs. For Expo Go on a physical device, set this to the LAN URL of MinIO, not localhost. Production/staging must be HTTPS and must not use a local or RFC1918 host.
- `STORAGE_REGION` — S3 region. Use `auto` for Cloudflare R2. Use `us-east-1` for local MinIO unless your MinIO process requires another region.
- `STORAGE_DOCUMENTS_BUCKET` — required in staging; development defaults to `job-to-invoice-documents-development`; production defaults to `job-to-invoice-documents-production`. Never a public bucket.
- `STORAGE_FORCE_PATH_STYLE` — `true` for MinIO; `false` for Cloudflare R2.
- `STORAGE_WORKER_ACCESS_KEY_ID` / `STORAGE_WORKER_SECRET_ACCESS_KEY` — bucket-scoped Object Read & Write. Worker PutObject only. Never `EXPO_PUBLIC_*`. Must differ from the API pair.
- `STORAGE_API_ACCESS_KEY_ID` / `STORAGE_API_SECRET_ACCESS_KEY` — bucket-scoped Object Read-only. API 5-minute presigned GET only. Never `EXPO_PUBLIC_*`.

## Quote approval-request delivery (D-017)

Empty names only in `.env.example`. Never put values in git.

API process (`loadApiEnv`):

- `DATABASE_URL_API`
- `EMAIL_WEBHOOK_SECRET` — Resend/Svix signing secret with the `whsec_` prefix. Never load in the worker.
- `APPROVAL_TOKEN_HASH_KEY` — HMAC-SHA256 key for `token_hash`. Never load in the worker.
- `APPROVAL_DELIVERY_ENCRYPTION_KEY` — AES-256-GCM key for temporary delivery tokens and OTP ciphertext.
- `OTP_HASH_KEY` — HMAC for portal OTP codes, CSRF nonces, and session hashes. Independent of `APPROVAL_TOKEN_HASH_KEY`. Required in staging and production.
- `APPROVAL_EVIDENCE_ENCRYPTION_KEY` — AES-256-GCM for APR05 UA/IP evidence. Not used for EMAIL01. Required in staging and production.
- `PORTAL_ORIGIN` — CORS allowlist. Production and staging require HTTPS.

Development may start the API without the approval/OTP names so preview and `/v1/me` keep working. `POST /v1/drafts/{id}/publish` and `/v1/portal/*` then return `UNAVAILABLE` and emit allowlisted logs before opening extra secret material. Do not log the names or values.

Worker process (`loadWorkerEnv`):

- `DATABASE_URL_WORKER`
- `EMAIL_API_KEY` — Resend send credential. Never load in the API.
- `EMAIL_FROM_DOMAIN`
- `APPROVAL_DELIVERY_ENCRYPTION_KEY`
- `PORTAL_ORIGIN` — EMAIL01 href is exactly `{PORTAL_ORIGIN}/review#{token}`
- `PUBLIC_APP_NAME`

Purge process:

- `DATABASE_URL_PURGE`

Not used by this slice:

- RevenueCat, staff, backup, and later purchase keys

Portal Next.js BFF (`apps/portal`) reads process-local `API_BASE_URL` and `PORTAL_ORIGIN`. It sets the `jti_portal` HttpOnly SameSite=Lax host-only cookie on the portal origin after exchange/verify. Development HTTP may omit `Secure`. Production and staging require HTTPS + `Secure`. Do not post the session cookie to the API port.

None of these names may enter `EXPO_PUBLIC_*`. Logs must redact configuration and secret material. Webhook verification uses official Svix headers (`svix-id`, `svix-timestamp`, `svix-signature`) with a five-minute timestamp tolerance in every `APP_ENV`. Do not fall back to an arbitrary shared-secret header.

Do not use `STORAGE_SERVICE_KEY` or Supabase `service_role` for document PDFs. Production remains private Cloudflare R2. Development may use private MinIO on the same S3 API. `R2_ACCOUNT_ID` may derive `https://<account>.r2.cloudflarestorage.com` when `STORAGE_ENDPOINT` is unset; R2 defaults are region `auto` and `STORAGE_FORCE_PATH_STYLE=false`.

If MinIO is already running locally (`http://127.0.0.1:9000`, private bucket `job-to-invoice-documents-development`, console `http://127.0.0.1:9001`), do not recreate the bucket. Point API and worker at it with process-local variables only. The console is operator-only on loopback; the physical phone uses `STORAGE_DOWNLOAD_ENDPOINT` on port 9000, never 9001.

Local MinIO is development-only. Do not create repository env files. Supply credentials from the launching process with `Read-Host -AsSecureString`. Do not print them, do not write them to disk, and do not use `minioadmin` or any default password. MinIO root password must be at least eight characters.

```powershell
function Set-ProcessSecret([string]$Name) {
  $secure = Read-Host -Prompt $Name -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    Set-Item -Path "Env:$Name" -Value ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr))
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) | Out-Null
  }
}

Set-ProcessSecret MINIO_ROOT_USER
Set-ProcessSecret MINIO_ROOT_PASSWORD
Set-ProcessSecret STORAGE_WORKER_ACCESS_KEY_ID
Set-ProcessSecret STORAGE_WORKER_SECRET_ACCESS_KEY
Set-ProcessSecret STORAGE_API_ACCESS_KEY_ID
Set-ProcessSecret STORAGE_API_SECRET_ACCESS_KEY

$env:APP_ENV = "development"
$env:STORAGE_ENDPOINT = "http://127.0.0.1:9000"
$env:STORAGE_REGION = "us-east-1"
$env:STORAGE_DOCUMENTS_BUCKET = "job-to-invoice-documents-development"
$env:STORAGE_FORCE_PATH_STYLE = "true"
# Physical iPhone: set the LAN address of this machine, not localhost.
$env:STORAGE_DOWNLOAD_ENDPOINT = "http://<lan-ip>:9000"

docker compose -f docker-compose.minio.yml up -d
pnpm --filter @job-to-invoice/api dev
pnpm --filter @job-to-invoice/worker dev
pnpm --filter @job-to-invoice/mobile dev:go
```

`EXPO_PUBLIC_API_BASE_URL` must be the same LAN host the phone can reach. Do not put storage keys in `EXPO_PUBLIC_*`. Stop MinIO with `docker compose -f docker-compose.minio.yml down`. Unset the process secrets when finished:

```powershell
Remove-Item Env:MINIO_ROOT_USER, Env:MINIO_ROOT_PASSWORD, Env:STORAGE_WORKER_ACCESS_KEY_ID, Env:STORAGE_WORKER_SECRET_ACCESS_KEY, Env:STORAGE_API_ACCESS_KEY_ID, Env:STORAGE_API_SECRET_ACCESS_KEY, Env:STORAGE_ENDPOINT, Env:STORAGE_DOWNLOAD_ENDPOINT, Env:STORAGE_REGION, Env:STORAGE_DOCUMENTS_BUCKET, Env:STORAGE_FORCE_PATH_STYLE
```

Hosted apply from PowerShell, process environment only:

```powershell
$env:DATABASE_URL_MIGRATIONS = "<percent-encoded session-pooler URI>"
pnpm hosted:db-check
pnpm hosted:db-push
Remove-Item Env:DATABASE_URL_MIGRATIONS
```

`pnpm hosted:db-check` is `--dry-run` only and does not pass `--yes`. `pnpm hosted:db-push` applies with `--yes` so the CLI does not wait for a confirmation prompt. Neither prints the URL, password, argv, or raw CLI text; failures are an allowlisted category. Hosted migration commands use the root-pinned `supabase` 2.117.0 CLI. The wrapper resolves repository `supabase/dist/supabase.js` before any global npm PATH shim and launches it through `process.execPath` with `shell:false`. `.cmd`/`.ps1` shims are not used. Passing `--db-url` still exposes it on the local process list while the CLI runs.

Authorized hosted development apply from GitHub Actions is `.github/workflows/hosted-development-migrations.yml`. It is `workflow_dispatch` only. The confirmation input must be exactly `APPLY_0010` before the `development` Environment secret `DATABASE_URL_MIGRATIONS` is read. The pre-push check must report `pending: 0010_quote_approval_request.sql`; the post-apply check must report `ok: true` and `pending: (none)`. Do not put that URI in repository files or workflow YAML.

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
