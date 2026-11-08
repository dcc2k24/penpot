#!/usr/bin/env bash
# T5 step 3: runs the migrations of this checkout (/work/backend in penpot-tc) against penpot_upgrade_test, and measures
# them.
#
# The backend runs its migrations when it starts. This script starts it once on port 6070 against the copy, waits for
# /readyz, and stops it again. While it runs, the script samples the locks on file_change and probes whether a write
# can take ROW EXCLUSIVE on the table. Migration 0159 builds two indexes inside a transaction with a plain CREATE INDEX,
# which takes SHARE on the table: the probe shows whether writes waited for it.
#
# Precondition: 0158 and 0159 are not applied in the copy. dump-and-copy-db.sh puts them back; the script refuses to
# run otherwise, so the measurement always covers a real upgrade.
#
# Usage:
#   run-new-migrations.sh --dry-run
#   run-new-migrations.sh --yes [--results-dir <dir>]
#
# Results (default <loadtest>/results/upgrade/<stamp>/):
#   timing.txt    start and ready times, and the migration rows of 0157, 0158 and 0159 with their times
#   locks.log     one line per sample (about every 1.5 s): the write probe verdict and the locks on file_change
#   indexes.txt   the indexes of file_change after the run
#   backend.log   the log of the backend started by this script

USAGE="run-new-migrations.sh: runs this checkout's migrations against penpot_upgrade_test, times them, samples the locks.
Options: --dry-run | --yes (required to run), --results-dir <dir>"

# shellcheck source=upgrade-lib.sh
. "$(cd "$(dirname "$0")" && pwd)/upgrade-lib.sh"

RESULTS_OPT=""
while [ $# -gt 0 ]; do
    if common_flag "$1"; then
        shift
        continue
    fi
    case "$1" in
        --results-dir)
            RESULTS_OPT="$2"
            shift
            ;;
        *) die "unknown option $1" ;;
    esac
    shift
done

require_yes
guard_copy_db "$COPY_DB"

STAMP=$(date +%Y%m%dT%H%M%S)
RESULTS="${RESULTS_OPT:-$LOADTEST_DIR/results/upgrade/$STAMP}"
STOP_FILE="$RESULTS/.sampling"
SAMPLER_PID=""
NEW_STEPS="'0158-add-client-to-access-token', '0159-add-file-change-indexes'"

# Samples the locks on file_change and a write probe until the stop file is removed. Runs in the background.
sample_locks() {
    local out="$1" stop="$2"
    while [ -e "$stop" ]; do
        local now locks probe verdict
        now=$(date +%H:%M:%S.%3N)
        locks=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$COPY_DB" -X -At \
            -c "select coalesce(string_agg(l.mode || ' ' || case when l.granted then 'granted' else 'waiting' end || ' ' || a.state, '; '), 'none') from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.relation = 'file_change'::regclass" 2>&1 | tr '\n' ' ')
        probe=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$COPY_DB" -X -At \
            -c "set lock_timeout = '1s'" -c "begin" -c "lock table file_change in row exclusive mode" -c "rollback" 2>&1 | tr '\n' ' ')
        case "$probe" in
            *"lock timeout"* | *"canceling statement"*) verdict="write-blocked" ;;
            *ERROR* | *error*) verdict="probe-error" ;;
            *) verdict="write-ok" ;;
        esac
        printf '%s %s locks[%s]\n' "$now" "$verdict" "$locks" >>"$out"
        sleep 1
    done
}

cleanup() {
    [ "$DRY_RUN" = 1 ] && return 0
    rm -f "$STOP_FILE"
    if [ -n "$SAMPLER_PID" ]; then
        wait "$SAMPLER_PID" 2>/dev/null || true
    fi
    backend_stop "$UPGRADE_PORT" >/dev/null 2>&1 || true
}

say_step "0. preflight"
exists=$(psql_cmd postgres "select count(*) from pg_database where datname = '$COPY_DB'")
if [ "$DRY_RUN" != 1 ] && [ "$exists" != "1" ]; then
    die "$COPY_DB does not exist: run dump-and-copy-db.sh first"
fi
applied=$(psql_cmd "$COPY_DB" "select step from migrations where step in ($NEW_STEPS)")
if [ "$DRY_RUN" != 1 ] && [ -n "$applied" ]; then
    die "0158 or 0159 is already applied in $COPY_DB ($applied): run dump-and-copy-db.sh first, so the upgrade is real"
fi
if [ "$DRY_RUN" != 1 ] && backend_answers "$UPGRADE_PORT"; then
    die "something already answers /readyz on port $UPGRADE_PORT: stop it first"
fi

if [ "$DRY_RUN" != 1 ]; then
    mkdir -p "$RESULTS"
    : >"$STOP_FILE"
    trap cleanup EXIT
fi

say_step "1. start the lock sampler (writes $RESULTS/locks.log)"
if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] sample pg_locks on file_change and a ROW EXCLUSIVE probe (lock_timeout 1 s) about every second"
else
    sample_locks "$RESULTS/locks.log" "$STOP_FILE" &
    SAMPLER_PID=$!
fi

say_step "2. start the backend of this checkout against $COPY_DB on port $UPGRADE_PORT"
T0=$(date +%s%3N)
backend_start /work/backend "$COPY_DB" "$UPGRADE_PORT" "$UPGRADE_REDIS_DB"

say_step "3. wait for /readyz (the migrations run before it answers; up to 15 min)"
if [ "$DRY_RUN" != 1 ]; then
    wait_backend_ready "$UPGRADE_PORT" 900 || die "the backend did not answer /readyz in 15 min; see backend.log in $RESULTS"
    T1=$(date +%s%3N)
    note "ready after $(((T1 - T0) / 1000)) s"
else
    note "[dry-run] wait for /readyz on port $UPGRADE_PORT, up to 900 s"
fi

say_step "4. stop the backend and the sampler, and save the logs"
if [ "$DRY_RUN" != 1 ]; then
    rm -f "$STOP_FILE"
    wait "$SAMPLER_PID" 2>/dev/null || true
    SAMPLER_PID=""
fi
backend_stop "$UPGRADE_PORT"
if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] save the backend log to $RESULTS/backend.log"
else
    docker exec "$TC_CONTAINER" cat "/tmp/upgrade-backend-$UPGRADE_PORT.log" >"$RESULTS/backend.log"
fi

say_step "5. timing and index state"
if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] timing.txt from the migrations table (0157, 0158, 0159) and indexes.txt from pg_indexes"
else
    {
        printf 'start_ms=%s ready_ms=%s seconds_to_ready=%s\n' "$T0" "$T1" "$(((T1 - T0) / 1000))"
        psql_cmd "$COPY_DB" "select step || ' applied at ' || to_char(created_at, 'HH24:MI:SS.US') from migrations where step in ('0157-add-audit-log-pending-table', '0158-add-client-to-access-token', '0159-add-file-change-indexes') order by created_at"
    } >"$RESULTS/timing.txt"
    psql_cmd "$COPY_DB" "select indexname from pg_indexes where tablename = 'file_change' order by 1" >"$RESULTS/indexes.txt"
    after=$(psql_cmd "$COPY_DB" "select count(*) from migrations where step in ($NEW_STEPS)")
    [ "$after" = "2" ] || die "after the run $after of 0158 and 0159 are applied, expected 2: see $RESULTS/backend.log"
    blocked=$(grep -c "write-blocked" "$RESULTS/locks.log" 2>/dev/null || true)
    samples=$(wc -l <"$RESULTS/locks.log" 2>/dev/null || echo 0)
    note "samples: $samples, write probe blocked in $blocked of them"
    note "timing: $RESULTS/timing.txt"
    note "locks:  $RESULTS/locks.log"
    note "indexes: $RESULTS/indexes.txt"
fi

printf '\ndone: migrations of this checkout are applied to %s. Next: run-old-backend-tests.sh.\n' "$COPY_DB"
