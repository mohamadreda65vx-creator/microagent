#!/usr/bin/env bash
# Exit 0 if the API answers and can reach the database, 1 otherwise. Use from cron/uptime monitors:
#   */2 * * * * /opt/microagent/infra/deploy/healthcheck.sh || echo "MicroAgent DOWN $(date -Is)" | mail -s "MicroAgent down" you@example.com
URL="${HEALTH_URL:-http://127.0.0.1:4000/api/v1/health}"
BODY="$(curl -fsS --max-time 5 "$URL")" || { echo "health check failed: no answer from $URL"; exit 1; }
echo "$BODY" | grep -q '"status":"ok"' || { echo "health check failed: $BODY"; exit 1; }
echo "ok"
