# Deploying MicroAgent on Railway (temporary, ~1 month)

Services: `Postgres` (Railway template) + `microagent` (this repo). Exactly ONE replica.

Variables on the `microagent` service (no secrets in git — set them in Railway):

| Variable | Value |
|---|---|
| NODE_ENV | production |
| TRUST_PROXY | true |
| APP_URL | exact public https URL of the service |
| CHANNEL_SECRET_KEY | `openssl rand -base64 32` (never lose it) |
| ADMIN_DATABASE_URL | `${{Postgres.DATABASE_URL}}` |
| OWNER_PW / APP_PW / PLATFORM_PW | random letters+digits, 16+ chars |
| PGSSL | leave unset on Railway private network |
| DATABASE_URL_OWNER / APP / PLATFORM | `postgresql://microagent_<role>:<PW>@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` |
| OPENROUTER_API_KEY | optional, add later yourself |

Start command runs: bootstrap roles -> migrations -> server. All steps are idempotent.
Create the platform admin once: `ADMIN_PASSWORD=... npm run admin:create -- you@example.com "Name"` (needs dev deps, run via `railway run`/shell).
Move to a Hostinger VPS later with `DEPLOYMENT_GUIDE.md`.
