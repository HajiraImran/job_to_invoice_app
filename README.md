# Job to Invoice

Production iPhone app and customer approval website for US solo service businesses. This repository currently contains the ARC01 foundation plus owner email authentication. Jobs, quotes, approvals, and invoices are not implemented.

## Authority

- `ENGINEERING_CONTRACT.md`
- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/REQUIREMENTS_MATRIX.md`

## Requirements

- Node.js 22.13+ (this repo is developed on 22.23.2)
- pnpm 12.4.1 (`corepack enable`)

## Commands

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm validate:openapi
pnpm secret-scan
```

`pnpm migrate:clean` applies `supabase/migrations` to an empty PostgreSQL database using `DATABASE_URL_MIGRATIONS`. `pnpm test:db` reapplies those migrations and runs tenant isolation tests. Do not use a `service_role` connection string. If `DATABASE_URL_MIGRATIONS` is unset, the scripts start a project-local PostgreSQL 16 cluster and stop it when they finish.

Hosted `db push --linked` dials an IPv6-only Postgres endpoint. From an IPv4-only network, after `supabase link`, set a process-local session-pooler URL and run `pnpm hosted:db-push` (D-012). Percent-encode reserved password characters. Never put the URL in repository files. Never print it. `--db-url` is still visible on the local process list while the CLI runs.

```powershell
$env:DATABASE_URL_MIGRATIONS = "<percent-encoded session-pooler URI>"
pnpm hosted:db-push
Remove-Item Env:DATABASE_URL_MIGRATIONS
```

Portal and admin Next.js builds do not require production credentials. EAS production signing credentials are not stored in this repository.

## Apps

| Path | Role |
| --- | --- |
| `apps/mobile` | Expo development-build owner app |
| `apps/portal` | Next.js customer portal |
| `apps/admin` | Next.js staff console |
| `apps/api` | Fastify `/v1` |
| `apps/worker` | Background worker |

Copy `.env.example` to `.env.local` for local development. Auth OTP settings are in `docs/ENV.md`. Production configuration must not contain placeholder values (QA68).
