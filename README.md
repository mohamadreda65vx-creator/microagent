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

Runs the API integration tests against the `microagent_test` database (35 tests: authentication, RBAC,
tenant isolation through the API, and tenant isolation directly in PostgreSQL).

## Where to look

- `apps/api/src/modules/*` — one folder per business module
- `apps/api/migrations/*.sql` — database schema, RLS policies, auth functions
- `apps/web/src/pages/*` — screens; `apps/web/src/components/*` — shared UI
- `docs/ARCHITECTURE.md` — design decisions, schema, API list, security model
- `docs/DEPLOY_HOSTINGER.md` — how to deploy
- `PROJECT_STATUS.md` — status and known gaps
