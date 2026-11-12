#!/bin/bash
# Runs one benchmark on the load generator inside tmux, so a dropped SSH
# session does not end it. Usage: ./run.sh <label> [SCALE] [extra env...]
#   ./run.sh large-420vu-euc1 1
#   ./run.sh large-210vu-euc1 0.5
# Needs ADMIN_PASSWORD in the environment (or ~/.perf-admin-password).
set -euo pipefail

LABEL=${1:?label}
SCALE=${2:-1}
cd "$(dirname "$0")/../.."
git pull --ff-only -q || true

ADMIN_PASSWORD=${ADMIN_PASSWORD:-$(cat ~/.perf-admin-password 2>/dev/null || true)}
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD or ~/.perf-admin-password}"

mkdir -p perf/results
tmux new-session -d -s "$LABEL" \
  "DATASET=${DATASET:-large} SCALE=$SCALE ADMIN_EMAIL=admin@mercur.dev ADMIN_PASSWORD='$ADMIN_PASSWORD' \
   k6 run --summary-export perf/results/$LABEL-summary.json --out csv=perf/results/$LABEL.csv \
   perf/k6/mercur-marketplace.js 2>&1 | tee perf/results/$LABEL.log; touch perf/results/$LABEL.done"
echo "started tmux session $LABEL; attach with: tmux attach -t $LABEL"
