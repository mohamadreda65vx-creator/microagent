# Environment variables

Read from the process environment or a `.env` file (nearest `.env` walking up from the working directory). Template for production: `.env.production.example`. Development template: `.env.example`. **Never commit or ZIP a real `.env`.** The server refuses to start on invalid values.

| Variable | Required | Default | Meaning / notes |
|---|---|---|---|
| `NODE_ENV` | yes (prod) | development | `production` enables HSTS and `Secure` cookies (HTTPS required). |
| `HOST` / `PORT` | no | 0.0.0.0 / 4000 | Bind address. Behind nginx use `127.0.0.1`. |
| `APP_URL` | yes | http://localhost:5173 | Exact public URL. Used for the CSRF Origin check, email links, and Telegram webhook registration. |
| `TRUST_PROXY` | prod: yes | false | `true` behind nginx so rate limits see real client IPs. |
| `DATABASE_URL_OWNER` | yes | – | Owner role. Migrations and `admin:create` only; also backups. |
| `DATABASE_URL_APP` | yes | – | App role used for every tenant request (Row Level Security enforced). |
| `DATABASE_URL_PLATFORM` | yes | – | Platform role for the super-admin module (narrow policies/functions). |
| `DB_POOL_MAX` | no | 10 | Max connections of the app pool. In the load test raising it to 30 did not help. |
| `TEST_DATABASE_NAME` | tests only | microagent_test | |
| `SESSION_TTL_DAYS` | no | 14 | 1–90. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | prod: yes | – / 587 | Without `SMTP_HOST` emails are only stored in `email_outbox`, never sent. |
| `OPENROUTER_API_KEY` | for AI | – | Server-side only. Without it AI features report "AI not configured". |
| `OPENROUTER_BASE_URL` | no | https://openrouter.ai/api/v1 | |
| `OPENROUTER_DEFAULT_MODEL` | no | openai/gpt-4o-mini | |
| `OPENROUTER_MODELS` | no | – | Comma-separated allow-list for the model picker. |
| `AI_MONTHLY_TOKEN_LIMIT` | no | 2,000,000 | Per-company default budget; a platform admin can override per company; 0 disables AI. |
| `AI_TIMEOUT_MS` / `AI_MAX_RETRIES` / `AI_RETRY_BASE_MS` | no | 45000 / 3 / 400 | |
| `CHANNEL_SECRET_KEY` | for channels | – | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts channel credentials (AES-256-GCM). **Changing or losing it makes saved credentials unreadable.** |
| `TELEGRAM_API_BASE` | no | https://api.telegram.org | |
| `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` | WhatsApp QR | – | Your own Evolution API v2 server (unofficial WhatsApp). |
| `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN` | Messenger/Instagram | – | Needs Meta App Review; not verified against real Meta. `META_GRAPH_BASE`, `META_GRAPH_VERSION` (v21.0) optional. |
| `WEB_DIST_DIR` | no | apps/web/dist | Location of the built web app. |
| `ALLOW_PRIVATE_FETCH` | no | false | **Leave off in production.** Allows the website crawler to fetch private/internal addresses (SSRF protection is on by default); only for tests. |
| `DEBUG_ERRORS` | no | – | Dev only: prints 5xx errors to the console. |
| `ADMIN_PASSWORD` | one-off | – | Only for `npm run admin:create`; do not keep it in `.env`. |

Plan limits (AI employees, channels, monthly messages) are not environment variables: defaults live in `apps/api/src/shared/plans.ts` and can be overridden per company by the platform admin in the Super Admin dashboard.

## Credentials still needed from you (none are in the project)
OpenRouter API key · SMTP account · domain/DNS access · VPS access · (optional) Telegram bot tokens (entered per channel in the UI) · Evolution API server · Meta developer app + App Review/business verification.
