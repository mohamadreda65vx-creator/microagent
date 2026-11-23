# Deploying MicroAgent on Hostinger

## Which Hostinger plan

PostgreSQL is **not supported** on Hostinger Web/Cloud hosting. Per Hostinger's support article, it is only available on **VPS hosting**. MicroAgent needs PostgreSQL (Row Level Security is part of the tenant isolation design), so **use a Hostinger VPS** (Ubuntu 22.04/24.04).

> Not tested on a real Hostinger VPS yet: these steps were validated on Ubuntu 24.04 / PostgreSQL 16 / Node 22 in the build environment. Treat the first deploy as a rehearsal.

## One-time server setup

```bash
sudo apt update && sudo apt install -y postgresql postgresql-contrib nginx git
# Node 22 (e.g. via NodeSource or nvm), then:
sudo npm i -g pm2
```

## Database

```bash
git clone <your repo> /opt/microagent && cd /opt/microagent
npm ci
OWNER_PW=$(openssl rand -hex 16) APP_PW=$(openssl rand -hex 16) PLATFORM_PW=$(openssl rand -hex 16)
# keep these three values: they go into .env
OWNER_PW=$OWNER_PW APP_PW=$APP_PW PLATFORM_PW=$PLATFORM_PW DB_NAMES=microagent_prod bash infra/db/setup.sh
```

## Configure `.env`

Copy `.env.example` to `.env` and set:

- `NODE_ENV=production`
- `APP_URL=https://your-domain.com` (must match the public URL exactly: used for CSRF origin checks and email links)
- `TRUST_PROXY=true` (the app sits behind nginx, so rate limiting sees real client IPs)
- the three `DATABASE_URL_*` values pointing at `microagent_prod`
- `SMTP_*` (password reset and invitations are not delivered without it)
- `OPENROUTER_API_KEY` (server only; without it AI features report "AI not configured" and employees cannot be activated). Optional: `OPENROUTER_DEFAULT_MODEL`, `OPENROUTER_MODELS`, `AI_MONTHLY_TOKEN_LIMIT`, `AI_TIMEOUT_MS`, `AI_MAX_RETRIES`. **Not tested against the real OpenRouter yet**: after setting the key, run one Playground test and one simulation suite before going live.
- `CHANNEL_SECRET_KEY` (**required for channels**; 32 random bytes in base64: `openssl rand -base64 32`; back it up: if it changes, saved channel credentials become unreadable).
- Telegram: needs the public HTTPS `APP_URL` above (the webhook is registered automatically). The server must reach `api.telegram.org`.
- WhatsApp via QR (unofficial): `EVOLUTION_API_URL` and `EVOLUTION_API_KEY` of your own Evolution API v2 server, which must be able to reach back to `APP_URL/api/v1/webhooks/`.
- Messenger/Instagram: `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`; in the Meta app set the webhook to `APP_URL/api/v1/webhooks/meta` and the OAuth redirect to `APP_URL/api/v1/channels/meta/oauth/callback`. Needs App Review and business verification before real customers can use it.
- Run ONE API process (the retry worker and AI queue are in-process).
- The server must be able to reach `openrouter.ai` and the customer websites it crawls (outbound HTTPS).

`chmod 600 .env`

## Build, migrate, start

```bash
npm run build
npm run db:migrate
ADMIN_PASSWORD='long-random-password' npm run admin:create -- you@your-domain.com "Your Name"
pm2 start "npm start" --name microagent && pm2 save && pm2 startup
```

## nginx + HTTPS

```nginx
server {
  server_name your-domain.com;
  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Then `sudo certbot --nginx -d your-domain.com`. HTTPS is required in production because the session cookie is `Secure`.

## Updating

```bash
git pull && npm ci && npm run build && npm run db:migrate && pm2 restart microagent
```

Migrations are forward-only; never edit an applied migration (the runner refuses and tells you to add a new one).

## Backups

`pg_dump -Fc microagent_prod > backup.dump` on a schedule, stored off the server.
