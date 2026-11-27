# MicroAgent — Deployment Guide (Hostinger VPS)

> **Status: prepared, NOT deployed.** Nothing in this project has been deployed to any Hostinger account. The steps below were rehearsed on a local Ubuntu machine with PostgreSQL 16 and Node 22 (production build, migrations on an empty database, admin creation, boot, health check, backup + restore into a spare database). The first real deployment on Hostinger should be treated as a rehearsal. **Do the deployment only after you approve it.**

## 1. Which Hostinger product? (checked against Hostinger's own help pages)
| Product | Can it run MicroAgent? | Why |
|---|---|---|
| Shared / Web hosting | **No** | Hostinger states PostgreSQL "is not offered on Web or Cloud hosting. It is available only on VPS Hosting" ([source](https://www.hostinger.com/support/1583659-is-postgresql-supported-at-hostinger/)). MicroAgent needs PostgreSQL: tenant isolation uses Row Level Security and three database roles. |
| Cloud hosting | **No** | Same statement as above. (Cloud/Business plans can run a Node.js app, per [Hostinger](https://www.hostinger.com/support/1583661-is-node-js-supported-at-hostinger/), but without PostgreSQL and root access they cannot run this platform.) |
| Agency hosting | **No** | Static front-end Node.js projects only, no persistent server process. |
| **VPS** | **Yes — required** | Root access: PostgreSQL, Node.js, nginx, always-on background workers (the campaign sender, workflow engine and message-retry queue run inside the API process). |
No Redis is needed: queues are stored in PostgreSQL.

**Size:** not proven. Measurements on a 2-vCPU / 8 GB machine are in `docs/LOAD_TEST_REPORT.md`. Start with 2 vCPU / 4 GB, run `apps/api/test/load.ts` on the VPS, and decide from your numbers. Do not promise customers a capacity before that.

## 2. What you need before starting
- A Hostinger **VPS** with a plain Ubuntu 22.04/24.04 OS (root/SSH access).
- A domain (e.g. `app.your-domain.com`) — see §5.
- Credentials (see `ENVIRONMENT_VARIABLES.md`): OpenRouter API key, SMTP account for emails, optional Telegram/WhatsApp(Evolution)/Meta credentials. None are included in the project.

## 3. One-time server setup
```bash
adduser --disabled-password --gecos "" microagent
apt update && apt install -y postgresql postgresql-contrib nginx git ufw certbot python3-certbot-nginx
# Node 22: install from NodeSource or nvm, then verify: node -v   (must be >= 20)
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable     # PostgreSQL stays closed to the internet (listens on localhost)
```

## 4. Install, configure, build, migrate
```bash
git clone <your private repo or upload the ZIP> /opt/microagent && chown -R microagent: /opt/microagent
su - microagent -c 'cd /opt/microagent && npm ci'      # full install (the build needs dev dependencies)

# Database roles + database (3 random passwords – keep them for .env).
# NOTE: PostgreSQL roles are per server, not per database: this script (re)sets the passwords of microagent_owner/app/platform, so run it on a dedicated VPS only.
OWNER_PW=$(openssl rand -hex 16); APP_PW=$(openssl rand -hex 16); PLATFORM_PW=$(openssl rand -hex 16)
OWNER_PW=$OWNER_PW APP_PW=$APP_PW PLATFORM_PW=$PLATFORM_PW DB_NAMES=microagent_prod bash /opt/microagent/infra/db/setup.sh
echo "$OWNER_PW $APP_PW $PLATFORM_PW"    # copy into .env, then clear your terminal history

cp /opt/microagent/.env.production.example /opt/microagent/.env && chmod 600 /opt/microagent/.env
nano /opt/microagent/.env       # fill EVERY value (APP_URL must be the exact https URL users will open)
openssl rand -base64 32          # -> CHANNEL_SECRET_KEY   (back it up!)

su - microagent -c 'cd /opt/microagent && npm run build && npm run db:migrate:prod'
su - microagent -c "cd /opt/microagent && ADMIN_PASSWORD='a-long-random-password' npm run admin:create -- you@your-domain.com 'Your Name'"
```
**Database migration instructions:** migrations are plain SQL files in `apps/api/migrations/` (0001…0012), applied in order, each in its own transaction, with a checksum recorded in `schema_migrations`. The runner refuses to continue if an applied file was edited. They are forward-only: to change the schema, add a new file. Run `npm run db:migrate:prod` after every update. Always take a backup first (§8).

## 5. Start the service
Choose ONE: **systemd** (recommended)
```bash
cp /opt/microagent/infra/deploy/microagent.service /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now microagent && systemctl status microagent
```
or **pm2**: `su - microagent -c 'cd /opt/microagent/apps/api && pm2 start dist/server.js --name microagent && pm2 save'` then `pm2 startup`.
**Run exactly ONE API process.** The workers are in-process; a second instance was not load-tested (the workers use `SKIP LOCKED` and are designed to be safe, but that is unproven).

## 6. Domain, nginx and HTTPS
1. In Hostinger **hPanel → Domains → DNS / Nameservers → DNS records**, add an **A record**: name `app` (or `@`) → your VPS IPv4 address. Wait for it to propagate (`dig +short app.your-domain.com`).
2. `cp infra/deploy/nginx.conf /etc/nginx/sites-available/microagent`, replace `app.example.com`, `ln -s` it into `sites-enabled`, `nginx -t && systemctl reload nginx`.
3. HTTPS: `certbot --nginx -d app.your-domain.com` (free Let's Encrypt; auto-renews through a systemd timer — check with `certbot renew --dry-run`).
4. **HTTPS is mandatory**: in production the session cookie is `Secure`, so login does not work over plain HTTP. `APP_URL` must be the `https://` URL, and `TRUST_PROXY=true`.
5. Webhooks: Telegram's webhook is registered automatically from `APP_URL`; Meta needs `APP_URL/api/v1/webhooks/meta` and its OAuth callback configured in the Meta app.

## 7. Health checks and monitoring
- `GET /api/v1/health` → `{"status":"ok"}` (checks the database; 503 when it is unreachable). Script: `infra/deploy/healthcheck.sh` (cron every 2 minutes, mail yourself on failure) or any external uptime monitor pointed at the URL.
- Logs: `journalctl -u microagent -f` (JSON lines; cookies/authorization headers are redacted).
- In-app: the **Super Admin dashboard** shows failed messages/campaign messages/workflow runs, webhook errors, channels in error and 5xx errors (`system_errors`), plus per-company usage vs. limits.
- Also watch: disk space (`df -h`), `systemctl is-active postgresql`, certificate expiry, and your OpenRouter spend limit.
- Not included (be aware): no external alerting service, no metrics/tracing stack. These are manual/cron checks.

## 8. Backups
```bash
mkdir -p /var/backups/microagent && chown microagent: /var/backups/microagent
crontab -u microagent -e     # add:  15 3 * * *  /opt/microagent/infra/deploy/backup.sh >> /var/log/microagent-backup.log 2>&1
```
`backup.sh` writes a compressed `pg_dump`, verifies it can be read, keeps 14 days (`KEEP_DAYS`). **Copy the folder off the server** (rclone/scp, plus Hostinger VPS snapshots if your plan has them). Back up `/opt/microagent/.env` **separately** (it holds `CHANNEL_SECRET_KEY`: without it restored channel credentials cannot be decrypted).
**Restore** (tested on a spare database): create an empty database with `infra/db/setup.sh` (`DB_NAMES=microagent_restore_test`), then `infra/deploy/restore.sh file.dump` with `DATABASE_URL_OWNER` pointing at it, then `npm run db:migrate:prod`. After restoring, Row Level Security and role grants were verified to be intact (app role sees 0 rows without a tenant context). Test a restore before you need one.

## 9. Updating
```bash
infra/deploy/backup.sh && cd /opt/microagent && git pull && npm ci && npm run build && npm run db:migrate:prod && systemctl restart microagent && infra/deploy/healthcheck.sh
```

## 10. Production checklist
- [ ] VPS, Ubuntu, firewall on (22/80/443 only), SSH keys, root login disabled
- [ ] `.env` filled, `chmod 600`, backed up off-server; **no secrets in git or in any ZIP**
- [ ] `APP_URL` https, `TRUST_PROXY=true`, certificate valid
- [ ] SMTP works (send yourself a password reset) — without it invitations and resets are not delivered
- [ ] OpenRouter key set with a spending limit on the OpenRouter side
- [ ] Admin account created; owner passwords unique
- [ ] First backup taken **and restore tested**
- [ ] Health check scheduled; someone is notified when it fails
- [ ] Plan limits reviewed (`apps/api/src/shared/plans.ts` are placeholder defaults) and subscription handled manually (no payment processor)
- [ ] Load test run on the real VPS before onboarding customers
