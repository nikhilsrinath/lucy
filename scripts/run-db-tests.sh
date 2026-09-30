#!/usr/bin/env bash
# Rebuilds a throwaway Postgres database from scratch, applies the local
# Supabase harness and every migration in order, then runs every file in
# supabase/tests/. Requires Docker.
#
#   docker run -d --name edgeos-pg -e POSTGRES_PASSWORD=pg postgres:15   # once
#   bash scripts/run-db-tests.sh
#
#   CONTAINER=other-pg bash scripts/run-db-tests.sh
#   UPTO=0025 bash scripts/run-db-tests.sh      # stop after this migration
#
# Without Docker, against any local Postgres 15+ (a scratch cluster is fine):
#   PGHOST=/var/run/postgresql PGPORT=5432 LOCAL=1 bash scripts/run-db-tests.sh
#
# Assertion files print PASS/FAIL lines and raise on the first failure.
# 02_access_matrix.sql prints the effective access matrix instead; it is diffed
# against tests/expected/day_one_access.out.
set -euo pipefail
cd "$(dirname "$0")/.."
C=${CONTAINER:-edgeos-pg}
DB=edgeos_test
UPTO=${UPTO:-9999}
if [ -n "${LOCAL:-}" ]; then
  psql_c() { psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
  pg_isready -U postgres -q
else
  psql_c() { docker exec -i "$C" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
  docker exec "$C" pg_isready -U postgres -q
fi
psql_c -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null

psql_c -d "$DB" < supabase/tests/00_harness.sql >/dev/null
for f in supabase/migrations/*.sql; do
  n=$(basename "$f" | cut -c1-4)
  if [ "$n" \> "$UPTO" ]; then break; fi
  if ! mout=$(psql_c -d "$DB" < "$f" 2>&1); then
    echo "migration FAILED: $f"; grep -E -A3 "ERROR" <<<"$mout" | head -20; exit 1
  fi
  echo "migrated $(basename "$f")"
done

status=0
total_pass=0
for t in supabase/tests/0[1-9]*.sql supabase/tests/[1-9][0-9]*.sql; do
  name=$(basename "$t")
  if [ "$name" = "02_access_matrix.sql" ]; then
    if psql_c -d "$DB" < "$t" > /tmp/access_matrix.out 2>/tmp/access_matrix.err; then
      if diff -u supabase/tests/expected/day_one_access.out /tmp/access_matrix.out > /tmp/access_matrix.diff; then
        echo "test     $name: identical to day_one_access.out ($(wc -l < /tmp/access_matrix.out) rows)"
      else
        echo "test     $name: DIFFERS from day_one_access.out"; head -60 /tmp/access_matrix.diff; status=1
      fi
    else
      echo "test     $name: ERROR"; cat /tmp/access_matrix.err | head; status=1
    fi
    continue
  fi
  out=$(psql_c -d "$DB" < "$t" 2>&1) || status=1
  pass=$(grep -c "PASS" <<<"$out" || true)
  fail=$(grep -c "FAIL" <<<"$out" || true)
  total_pass=$((total_pass + pass))
  echo "test     $name: $pass PASS, $fail FAIL"
  if [ "$fail" != 0 ] || grep -q "ERROR" <<<"$out"; then grep -E "FAIL|ERROR|CONTEXT" <<<"$out" | head -20; status=1; fi
done
echo "total    $total_pass PASS"
exit $status
