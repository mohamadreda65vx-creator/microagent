#!/usr/bin/env bash
# Daily PostgreSQL backup with rotation.  Cron example (as the microagent user):
#   15 3 * * *  /opt/microagent/infra/deploy/backup.sh >> /var/log/microagent-backup.log 2>&1
# Needs DATABASE_URL_OWNER in the environment (the owner role can read every table). Output files are chmod 600.
# IMPORTANT: the dump contains encrypted channel credentials; the key (CHANNEL_SECRET_KEY in .env) is NOT in the dump —
# back up .env separately and store it somewhere different from the dumps, or restored channels cannot be decrypted.
set -euo pipefail
DIR="${BACKUP_DIR:-/var/backups/microagent}"
KEEP_DAYS="${KEEP_DAYS:-14}"
[ -f /opt/microagent/.env ] && { set -a; . /opt/microagent/.env; set +a; }
: "${DATABASE_URL_OWNER:?DATABASE_URL_OWNER is not set}"
umask 077; mkdir -p "$DIR"
FILE="$DIR/microagent-$(date +%Y%m%d-%H%M%S).dump"
pg_dump --format=custom --no-owner --no-comments "$DATABASE_URL_OWNER" > "$FILE"
# sanity check: the archive must be readable
pg_restore --list "$FILE" > /dev/null
find "$DIR" -name 'microagent-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
# Copy $DIR off the server too (rclone / scp / Hostinger snapshot). A backup on the same disk is not a backup.
