#!/usr/bin/env bash
# Samples a Postgres server every few seconds while a k6 run is going, so the
# server side of a stall can be lined up with the k6 timeline afterwards.
#
#   DATABASE_URL=postgres://... perf/db-sample.sh <seconds> <out.csv> [interval]
#
# Against the primary it records sessions, active queries and wait events;
# against a read replica only the replay lag and the connect time mean much.
set -euo pipefail

DURATION=${1:?seconds}
OUT=${2:?out.csv}
INTERVAL=${3:-5}
: "${DATABASE_URL:?DATABASE_URL}"
PSQL=${PSQL:-psql}

ms() { node -e 'process.stdout.write(String(Date.now()))'; }

echo "epoch connect_ms lag_s sessions active idle_in_tx waits" > "$OUT"
END=$(( $(date +%s) + DURATION ))
while [ "$(date +%s)" -lt "$END" ]; do
  T0=$(ms)
  ROW=$("$PSQL" "$DATABASE_URL" -Atc "
    select
      coalesce(round(extract(epoch from now() - pg_last_xact_replay_timestamp())::numeric, 2), 0),
      count(*),
      count(*) filter (where state = 'active'),
      count(*) filter (where state = 'idle in transaction'),
      coalesce(string_agg(wait_event_type || ':' || wait_event, ','), '-')
    from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid()" 2>&1 | head -1 | tr '|' ' ')
  T1=$(ms)
  echo "$(date +%s) $((T1 - T0)) $ROW" >> "$OUT"
  sleep "$INTERVAL"
done
