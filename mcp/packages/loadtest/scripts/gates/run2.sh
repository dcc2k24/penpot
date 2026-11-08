#!/usr/bin/env bash
# usage: run2.sh <logname> <scenario> [args...]  (round 1, resumed)
L=/c/dev/penpot/mcp/packages/loadtest/results/2026-11-08-round1-resumed
name=$1; shift
free=$(df --output=avail -BG /c | tail -1 | tr -dc 0-9)
echo "free on C: ${free} GB at $(date +%T)" > $L/$name.log
if [ "$free" -lt 5 ]; then echo "STOP: under 5 GB free" >> $L/$name.log; exit 3; fi
cd /c/dev/penpot/mcp
npx pnpm loadtest run "$@" --url http://127.0.0.1:4405/mcp --metrics http://localhost:6061/metrics \
  --pg-stats docker:penpot-penpot-postgres-1:penpot_mcpdev --results C:/dev/penpot/mcp/packages/loadtest/results \
  --machine-note "T1 gates round 1 resumed 2026-11-08, Windows host + docker backend, pg_stat_statements on, toolchain container shared with 3 backend test runs" \
  --backend-flags "dev script: pointer-map on, climit, rlimit, quotes, auto-file-snapshot, audit-log, file-validation, backend-asserts, mcp-backend, mcp-raw-changes" \
  --db-pool-size 8 --server-pid ${SPID:-25420} >> $L/$name.log 2>&1
echo "exit $?" >> $L/$name.log
