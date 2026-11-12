#!/usr/bin/env bash
# Repeatable test of the data migration 20261112000000_normalize_schema on a throwaway database:
#   old schema (all earlier migrations) -> legacy fixture -> the migration -> assertions.
# Usage: scripts/test-migration.sh [database name]
# Override how psql is reached with PSQL, e.g. PSQL="docker exec -i <db container> psql -U pnl".
set -euo pipefail
cd "$(dirname "$0")/.."
name="${1:-pnl_migration_test}"
PSQL="${PSQL:-docker compose exec -T db psql -U pnl}"
TARGET=20261112000000_normalize_schema

$PSQL -d postgres -q -c "DROP DATABASE IF EXISTS \"$name\"" -c "CREATE DATABASE \"$name\""
# --single-transaction: all or nothing, like `prisma migrate deploy` (which sends the file as one batch)
run() { $PSQL -d "$name" -q -v ON_ERROR_STOP=1 --single-transaction < "$1" > /dev/null; }

for dir in $(ls prisma/migrations | grep -v migration_lock | sort); do
  [[ "$dir" < "$TARGET" ]] && run "prisma/migrations/$dir/migration.sql"
done
run prisma/migration-tests/normalize_schema.seed.sql
echo "legacy fixture loaded; applying $TARGET (it verifies its own counts and sums)..."
run "prisma/migrations/$TARGET/migration.sql"
run prisma/migration-tests/normalize_schema.assert.sql
echo "OK: $TARGET migrated the fixture and every expectation holds."
$PSQL -d postgres -q -c "DROP DATABASE \"$name\""
