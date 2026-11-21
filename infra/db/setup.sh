#!/usr/bin/env bash
# MicroAgent — one-time PostgreSQL bootstrap (idempotent).
#
# Creates three LOGIN roles with different privileges and the databases:
#   microagent_owner    owns the schema, runs migrations. Never used by the running API.
#   microagent_app      used by the API for every tenant request. Row Level Security applies.
#   microagent_platform used ONLY by the Platform Admin module. Gets explicit, narrow policies.
#
# Usage:
#   OWNER_PW=... APP_PW=... PLATFORM_PW=... DB_NAMES="microagent_prod" bash infra/db/setup.sh
set -euo pipefail

: "${OWNER_PW:?OWNER_PW is required}"
: "${APP_PW:?APP_PW is required}"
: "${PLATFORM_PW:?PLATFORM_PW is required}"
DB_NAMES="${DB_NAMES:-microagent_dev}"

if [ "$(id -u)" -eq 0 ]; then
  PSQL=(runuser -u postgres -- psql -v ON_ERROR_STOP=1 -X)
else
  PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1 -X)
fi

"${PSQL[@]}" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'microagent_owner') THEN
    CREATE ROLE microagent_owner LOGIN PASSWORD '${OWNER_PW}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  ELSE
    ALTER ROLE microagent_owner PASSWORD '${OWNER_PW}';
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'microagent_app') THEN
    CREATE ROLE microagent_app LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  ELSE
    ALTER ROLE microagent_app PASSWORD '${APP_PW}';
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'microagent_platform') THEN
    CREATE ROLE microagent_platform LOGIN PASSWORD '${PLATFORM_PW}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  ELSE
    ALTER ROLE microagent_platform PASSWORD '${PLATFORM_PW}';
  END IF;
END
\$\$;
SQL

for db in $DB_NAMES; do
  exists="$("${PSQL[@]}" -tAc "SELECT 1 FROM pg_database WHERE datname = '${db}'")"
  if [ "$exists" != "1" ]; then
    "${PSQL[@]}" -c "CREATE DATABASE ${db} OWNER microagent_owner"
  fi
  "${PSQL[@]}" -d "$db" <<SQL
CREATE EXTENSION IF NOT EXISTS citext;
REVOKE ALL ON DATABASE ${db} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${db} TO microagent_owner, microagent_app, microagent_platform;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO microagent_app, microagent_platform;
SQL
  echo "database ready: ${db}"
done
