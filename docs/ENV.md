# Environment and Auth configuration

Copy `.env.example` to `.env.local`. Do not put secrets in git.

## Mobile public values

These are the only Auth values that may ship in the iPhone app:

- `EXPO_PUBLIC_API_BASE_URL`
- `EXPO_PUBLIC_AUTH_PROJECT_URL` (Supabase project URL)
- `EXPO_PUBLIC_AUTH_PUBLISHABLE_KEY` (publishable / anon key, never `service_role`)

## API private values

- `AUTH_PROJECT_URL` — same project URL as mobile
- `AUTH_PUBLISHABLE_KEY` — not used by the API for commercial writes
- `AUTH_ISSUER` — `https://<project-ref>.supabase.co/auth/v1`
- `AUTH_AUDIENCE` — `authenticated`
- `DATABASE_URL_API` — login role that can `SET ROLE api_app`. Never `service_role`.

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
