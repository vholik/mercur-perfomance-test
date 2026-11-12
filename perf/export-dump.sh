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

if [ "${KEEP_INDEX:-0}" = "1" ]; then
  # Keep the built Index. The restore's --clean emits a DROP CONSTRAINT for
  # every partition's inherited primary key, which Postgres refuses, so the
  # dump carries the parents' keys as unique indexes instead: the module's
  # upserts only need a unique (id, name), and pg_dump emits no drop for an
  # index partition.
  "$PG_BIN/psql" -q -v ON_ERROR_STOP=1 -d "$EXPORT_DB" <<'SQL'
ALTER TABLE public.index_data DROP CONSTRAINT index_data_pkey;
CREATE UNIQUE INDEX index_data_id_name_key ON public.index_data (id, name);
ALTER TABLE public.index_relation DROP CONSTRAINT index_relation_pkey;
CREATE UNIQUE INDEX index_relation_id_pivot_key ON public.index_relation (id, pivot);
ALTER TABLE public.index_relation
  DROP CONSTRAINT "IDX_index_relation_id_pivot_parent_name_child_name_parent_id_ch";
CREATE UNIQUE INDEX index_relation_parent_child_key
  ON public.index_relation (parent_id, child_id, child_name, parent_name, pivot);
SQL
else
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
fi

"$PG_BIN/pg_dump" -Fc --no-owner --no-acl -d "$EXPORT_DB" -f "$OUT"
echo "Wrote $OUT"
