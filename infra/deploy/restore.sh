#!/usr/bin/env bash
# Restore a dump into an EMPTY database prepared by infra/db/setup.sh.  Usage: restore.sh /path/to/file.dump
# Test it on a spare database first (e.g. DB_NAMES=microagent_restore_test) — an untested backup is a hope, not a backup.
set -euo pipefail
FILE="${1:?usage: restore.sh dump-file}"
[ -f /opt/microagent/.env ] && { set -a; . /opt/microagent/.env; set +a; }
: "${DATABASE_URL_OWNER:?}"
pg_restore --no-owner --exit-on-error --dbname="$DATABASE_URL_OWNER" "$FILE"
echo "restore finished; now run: npm run db:migrate:prod  (applies any newer migrations)"
