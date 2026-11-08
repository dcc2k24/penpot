#!/usr/bin/env bash
# Round 2 run wrapper: one loadtest scenario with the round's settings, and the backend pool watch beside it.
# Adapted from scripts/gates/run2.sh and cap.sh (round 1). Writes <name>.log, <name>-pool.jsonl and
# <name>-pool-summary.json into R2_RESULTS. Stops when less than 5 GB is free on drive C.
#
# Usage: run-r2.sh <name> <scenario> --tokens <file> [--vars <file>] [more loadtest args]
# Environment:
#   R2_RESULTS  results folder (default: results/2026-11-08-round2/runs of this package)
#   R2_URL      MCP endpoint (default: the nginx balancer, http://127.0.0.1:4415/mcp)
#   SPID        Windows pid of one adapter, for --server-pid (RSS of that adapter only)
#   R2_NOTE     machine note
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"
L="${R2_RESULTS:-$PKG/results/2026-11-08-round2/runs}"
mkdir -p "$L"
name=$1; shift
free=$(df --output=avail -BG /c | tail -1 | tr -dc 0-9)
echo "free on C: ${free} GB at $(date +%T)" > "$L/$name.log"
if [ "$free" -lt 5 ]; then echo "STOP: under 5 GB free" >> "$L/$name.log"; exit 3; fi
rm -f "$L/$name-pool.stop" "$L/$name-pool.jsonl"
node "$PKG/scripts/gates/poolwatch.cjs" "$L/$name-pool.jsonl" "$L/$name-pool.stop" &
watch=$!
cd "$PKG/../.."
npx pnpm loadtest run "$@" --url "${R2_URL:-http://127.0.0.1:4415/mcp}" --metrics http://localhost:6061/metrics \
  --pg-stats docker:penpot-penpot-postgres-1:penpot_mcpdev --results "$(cygpath -m "$PKG/results" 2>/dev/null || echo "$PKG/results")" \
  --machine-note "${R2_NOTE:-round 2 2026-11-08, Windows host + docker backend, two adapters behind nginx with Redis, pg_stat_statements on}" \
  --backend-flags "dev script: pointer-map on, climit, rlimit, quotes, auto-file-snapshot, audit-log, file-validation, backend-asserts, mcp-backend, mcp-raw-changes" \
  --db-pool-size 8 ${SPID:+--server-pid $SPID} >> "$L/$name.log" 2>&1
code=$?
echo "exit $code at $(date +%T)" >> "$L/$name.log"
touch "$L/$name-pool.stop"; wait $watch
node "$PKG/scripts/gates/poolsum.cjs" "$(cygpath -m "$L/$name-pool.jsonl" 2>/dev/null || echo "$L/$name-pool.jsonl")" > "$L/$name-pool-summary.json" 2>&1
exit $code
