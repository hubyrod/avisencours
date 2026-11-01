#!/usr/bin/env bash
# Runs the tests the way CI does, on a throwaway Postgres:
#   1. every src/*.integration.test.ts alone, each on a freshly created database —
#      proves no test file depends on tables, rows or env left by another one
#      (Bun does not order test files; this bit CI on 2026-11-01);
#   2. the whole suite on a fresh database.
# TEST_DATABASE_URL defaults to the local throwaway database. The server must be
# reachable and the URL's user must be allowed to create databases.
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${TEST_DATABASE_URL:-postgresql://localhost:5432/avis_test}"
DB="${URL##*/}"
ADMIN="${URL%/*}/postgres"

fresh() {
  psql "$ADMIN" -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB\"" -c "CREATE DATABASE \"$DB\""
}

for f in src/*.integration.test.ts; do
  echo "=== $f alone, empty database ==="
  fresh
  TEST_DATABASE_URL="$URL" bun test "$f"
done

echo "=== full suite, empty database ==="
fresh
TEST_DATABASE_URL="$URL" bun test
