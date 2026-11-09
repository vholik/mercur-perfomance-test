#!/usr/bin/env bash
# Dumps a seeded load-test database in a form Medusa Cloud can import.
#
#   perf/export-dump.sh <database> [output.dump]
#
# Medusa Cloud runs Postgres 16 and restores with --clean over a database that
# already ran migrations. Two things break that restore, so the dump drops them:
# - Postgres 17+ archives: the dump must come from pg_dump 16.
# - Index module objects (index_* tables, their cat_* partitions and the
#   update_document_tsv trigger function): Postgres refuses to drop a
#   partition's inherited constraints or a function a trigger still uses. The
#   index is derived data, so the target keeps its own copy.
set -euo pipefail

DB="${1:?usage: perf/export-dump.sh <database> [output.dump]}"
OUT="${2:-${DB}.dump}"
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
EXPORT_DB="${DB}_export"

"$PG_BIN/pg_dump" --version | grep -q " 16\." || {
  echo "pg_dump in $PG_BIN is not version 16" >&2
  exit 1
}

"$PG_BIN/dropdb" --if-exists "$EXPORT_DB"
"$PG_BIN/createdb" -T "$DB" "$EXPORT_DB"
trap '"$PG_BIN/dropdb" --if-exists "$EXPORT_DB"' EXIT

"$PG_BIN/psql" -q -v ON_ERROR_STOP=1 -d "$EXPORT_DB" <<'SQL'
SET client_min_messages = warning;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('index_data', 'index_relation', 'index_metadata', 'index_sync')
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS public.update_document_tsv() CASCADE;
SQL

"$PG_BIN/pg_dump" -Fc --no-owner --no-acl -d "$EXPORT_DB" -f "$OUT"
echo "Wrote $OUT"
