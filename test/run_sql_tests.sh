#!/usr/bin/env bash
# Roda os testes SQL num Postgres local (precisa de um servidor em $PGHOST/$PGPORT).
set -euo pipefail
cd "$(dirname "$0")/.."
export PGHOST="${PGHOST:-/tmp/pg}" PGPORT="${PGPORT:-54329}" PGUSER="${PGUSER:-postgres}"
dropdb --if-exists tomei_test >/dev/null 2>&1
createdb tomei_test
psql -d tomei_test -v ON_ERROR_STOP=1 -q -f test/sql/00_stubs_supabase.sql
for m in supabase/migrations/*.sql; do
  case "$m" in *cron*) continue;; esac   # pg_cron/pg_net só existem no Supabase de verdade
  psql -d tomei_test -v ON_ERROR_STOP=1 -q -f "$m"
done
psql -d tomei_test -At -F ' | ' -f test/sql/10_schema_tests.sql 2>&1 \
 | grep -E '^[0-9]+ \|' \
 | awk -F' \\| ' '{ if ($3=="t") p++; else {f++; print "FALHOU: " $0} } END { print p+0 " passaram, " f+0 " falharam"; exit (f>0 || p==0) }'
