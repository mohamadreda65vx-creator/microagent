# MicroAgent

Multi-tenant SaaS platform to create, teach and manage **AI Employees** for businesses.
This repository currently contains **Part 1: Foundation & UI**. See [PROJECT_STATUS.md](PROJECT_STATUS.md) for exactly what is done and what is not.

## Stack

| Layer | Choice |
|---|---|
| API | Node.js 22, Fastify 5, TypeScript (modular monolith) |
| Database | PostgreSQL 16 (Row Level Security, plain-SQL migrations) |
| Web | React 19, Vite, Tailwind CSS 4, Motion, TanStack Query |
| Auth | Server-side sessions (opaque token, httpOnly cookie, hashed in DB), scrypt passwords |

Production = **one Node process** serving the API and the built web app. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- Node.js >= 20 and npm
- PostgreSQL >= 14 (tested on 16) with the `citext` extension (ships with PostgreSQL contrib)

## Run locally

```bash
npm install

# 1) Create the DB roles + databases (needs a postgres superuser on this machine)
OWNER_PW=... APP_PW=... PLATFORM_PW=... DB_NAMES="microagent_dev microagent_test" npm run db:setup

# 2) Configure
cp .env.example .env        # put the same passwords in the three DATABASE_URL_* lines

# 3) Create the tables
npm run db:migrate

# 4) Create the first Platform Admin (there is no public sign-up for this role)
ADMIN_PASSWORD='at-least-12-chars' npm run admin:create -- admin@your-domain.com "Your Name"

# 5) Start (two terminals)
npm run dev:api             # http://localhost:4000
npm run dev:web             # http://localhost:5173  <- open this one
```

Production-style (single process): `npm run build && npm start` then open http://localhost:4000
(set `NODE_ENV=production` and `APP_URL` to the public URL).

## Tests

```bash
npm test
```

Runs the API integration tests against the `microagent_test` database (235 tests: customers & campaigns (Part 4), channels & conversations (Part 3), authentication, RBAC,
tenant isolation through the API and directly in PostgreSQL, the AI provider layer, the permissions engine
and guards, business discovery, Teach & Correct, simulation and the activation gate). Tests use a local
stand-in for OpenRouter (`apps/api/test/fake-openrouter.ts`); they never call the real service.

## Channels & conversations (Part 3)

Set `CHANNEL_SECRET_KEY` (`openssl rand -base64 32`) before creating channels. Telegram needs a public HTTPS `APP_URL`.
WhatsApp (QR) needs your own Evolution API server (`EVOLUTION_API_URL`, `EVOLUTION_API_KEY`; unofficial).
Messenger/Instagram need a Meta app (`META_*`) and App Review; they are prepared, not verified.
Manual browser harness with stand-in providers: `cd apps/api && node --import tsx test/e2e-server.ts` after `npm run build` (serves on :5173).

## AI (OpenRouter)

Set `OPENROUTER_API_KEY` in the server `.env` (never in the web app). Without it the platform runs and
AI features say “AI not configured” instead of guessing. Other variables: `OPENROUTER_DEFAULT_MODEL`,
`OPENROUTER_MODELS` (optional allow-list), `AI_MONTHLY_TOKEN_LIMIT` (per company, overridable by the
platform admin), `AI_TIMEOUT_MS`, `AI_MAX_RETRIES`. See `.env.example`.

## Where to look

- `apps/api/src/modules/*` — one folder per business module
- `apps/api/migrations/*.sql` — database schema, RLS policies, auth functions
- `apps/web/src/pages/*` — screens; `apps/web/src/components/*` — shared UI
- `docs/ARCHITECTURE.md` — design decisions, schema, API list, security model
- `docs/DEPLOY_HOSTINGER.md` — how to deploy
- `PROJECT_STATUS.md` — status and known gaps
