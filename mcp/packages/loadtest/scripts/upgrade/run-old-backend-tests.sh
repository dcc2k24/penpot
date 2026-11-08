#!/usr/bin/env bash
# T5 step 4: the previous backend (541f965bf1) against the migrated copy.
#
# Modes:
#   (default)      run the previous backend's test suite (clojure -M:dev:test, kaocha) with its test database set to a
#                  throwaway copy of penpot_upgrade_test. Takes a long time: run it on its own.
#   --serve-old    start the previous backend on port 6071 against penpot_upgrade_test (the migrated copy), for the
#                  manual token call. Prints the checklist.
#   --stop-old     stop that backend.
#   --checklist    print the manual token call checklist only.
#
# The worktree /tmp/old (inside penpot-tc, of the repository at /work) is created at 541f965bf1 if it is missing. It is a
# detached worktree, so no branch is made. The worktree adds an entry under .git/worktrees of the host repository.
#
# The suite's test helpers reset the database they are given: backend/test/backend_tests/helpers.clj (database-reset)
# deletes every row of every table except migrations. So the suite never gets penpot_upgrade_test itself: it gets
# penpot_upgrade_old_tests, a copy made from penpot_upgrade_test just before the run. The migrated copy stays as it is
# for the token call.
#
# Usage:
#   run-old-backend-tests.sh --dry-run
#   run-old-backend-tests.sh --yes [--results-dir <dir>]
#   run-old-backend-tests.sh --yes --serve-old
#   run-old-backend-tests.sh --stop-old
#   run-old-backend-tests.sh --checklist

USAGE="run-old-backend-tests.sh: the previous backend (541f965bf1) against the migrated copy.
Options: --dry-run | --yes (required for the suite and --serve-old), --results-dir <dir>, --serve-old, --stop-old, --checklist"

# shellcheck source=upgrade-lib.sh
. "$(cd "$(dirname "$0")" && pwd)/upgrade-lib.sh"

MODE=suite
RESULTS_OPT=""
while [ $# -gt 0 ]; do
    if common_flag "$1"; then
        shift
        continue
    fi
    case "$1" in
        --serve-old) MODE=serve ;;
        --stop-old) MODE=stop ;;
        --checklist) MODE=checklist ;;
        --results-dir)
            RESULTS_OPT="$2"
            shift
            ;;
        *) die "unknown option $1" ;;
    esac
    shift
done

print_checklist() {
    cat <<CHECKLIST

Manual token call checklist: the previous backend ($OLD_COMMIT) on the migrated copy ($COPY_DB)

Precondition: run-new-migrations.sh has finished, so 0158 and 0159 are applied in $COPY_DB.

1. Start the previous backend: run-old-backend-tests.sh --yes --serve-old. It answers /readyz on port $OLD_PORT inside
   $TC_CONTAINER (the port is not published to the host). Record the time it took to be ready.
2. Take one MCP token: the first line of the loadtest token file (PENPOT_LOADTEST_TOKEN_FILE). Do not print it into a log.
3. Profile call, inside $TC_CONTAINER (curl if the image has it, else bash /dev/tcp):
     POST http://127.0.0.1:$OLD_PORT/api/rpc/command/get-profile
     header: Authorization: Token <token>     (the old middleware accepts Token or Bearer; middleware.clj)
     body:   {}
   Expect: HTTP 200 and the profile of the token's owner. Record the status and the profile id.
4. File call with the same header:
     POST http://127.0.0.1:$OLD_PORT/api/rpc/command/get-file
     body:   {"id": "<fileId from the vars file>"}
   Expect: HTTP 200 and "revn" equal to the copy's revision:
     docker exec $PG_CONTAINER psql -U $PG_USER -d $COPY_DB -At -c "select revn from file where id = '<fileId>'"
5. Record the server log: docker exec $TC_CONTAINER cat /tmp/upgrade-backend-$OLD_PORT.log > <results dir>/old-backend.log
   Expect: no "Caused by" or "Exception" lines from the migrations or the calls.
6. Stop the previous backend: run-old-backend-tests.sh --stop-old.

The previous backend reads PENPOT_SECRET_KEY from run-backend-dev inside penpot-tc (upgrade-lib.sh launcher), the same key
as the dev stack, so a token issued by the dev stack validates here. A refusal in step 3 is then a finding about the schema or
the scope, not about the key. The old get-profile accepts an MCP token with scope mcp:read (profile.clj at 541f965bf1). If it
refuses the token for that call, call mcp-whoami instead (POST /api/rpc/command/mcp-whoami, body {}) and record both answers.

CHECKLIST
}

ensure_old_tree() {
    local script="cd /work && if ! git worktree list | grep -q '^/tmp/old '; then git worktree add --detach /tmp/old $OLD_COMMIT >/dev/null 2>&1; fi && cd /tmp/old && git rev-parse --short=10 HEAD"
    if [ "$DRY_RUN" = 1 ]; then
        note "[dry-run] in $TC_CONTAINER: $script"
        return 0
    fi
    local head
    head=$(docker exec "$TC_CONTAINER" bash -c "$script")
    [ "$head" = "$OLD_COMMIT" ] || die "/tmp/old is at '$head', expected $OLD_COMMIT"
    note "/tmp/old is at $head"
}

preflight_copy() {
    local exists applied
    exists=$(psql_cmd postgres "select count(*) from pg_database where datname = '$COPY_DB'")
    if [ "$DRY_RUN" != 1 ] && [ "$exists" != "1" ]; then
        die "$COPY_DB does not exist: run dump-and-copy-db.sh and run-new-migrations.sh first"
    fi
    applied=$(psql_cmd "$COPY_DB" "select count(*) from migrations where step = '0159-add-file-change-indexes'")
    if [ "$DRY_RUN" != 1 ] && [ "$applied" != "1" ]; then
        die "0159 is not applied in $COPY_DB: run run-new-migrations.sh first (the old backend runs against the migrated copy)"
    fi
}

case "$MODE" in
    checklist)
        print_checklist
        exit 0
        ;;
    stop)
        say_step "stop the previous backend on port $OLD_PORT"
        backend_stop "$OLD_PORT"
        exit 0
        ;;
    serve)
        require_yes
        say_step "1. preflight and the previous tree"
        preflight_copy
        ensure_old_tree
        if [ "$DRY_RUN" != 1 ] && backend_answers "$OLD_PORT"; then
            die "something already answers /readyz on port $OLD_PORT: stop it first (--stop-old)"
        fi
        say_step "2. start the previous backend on $COPY_DB, port $OLD_PORT"
        backend_start /tmp/old/backend "$COPY_DB" "$OLD_PORT" "$OLD_REDIS_DB"
        if [ "$DRY_RUN" != 1 ]; then
            say_step "3. wait for /readyz (up to 15 min)"
            wait_backend_ready "$OLD_PORT" 900 || die "the previous backend did not answer /readyz in 15 min: see /tmp/upgrade-backend-$OLD_PORT.log in $TC_CONTAINER"
            note "ready"
        else
            note "[dry-run] wait for /readyz on port $OLD_PORT, up to 900 s"
        fi
        print_checklist
        exit 0
        ;;
esac

# ---- suite ----
require_yes
guard_copy_db "$COPY_DB"
STAMP=$(date +%Y%m%dT%H%M%S)
RESULTS="${RESULTS_OPT:-$LOADTEST_DIR/results/upgrade/$STAMP}"
TESTS_LOG="/tmp/old-backend-tests.log"

say_step "1. preflight and the previous tree"
preflight_copy
ensure_old_tree

say_step "2. give the suite its own copy of the migrated database ($OLD_TESTS_DB)"
terminate_sessions "$COPY_DB"
psql_cmd postgres "DROP DATABASE IF EXISTS $OLD_TESTS_DB"
psql_cmd postgres "CREATE DATABASE $OLD_TESTS_DB TEMPLATE $COPY_DB OWNER $PG_USER"
note "the suite's database-reset deletes the rows of $OLD_TESTS_DB; $COPY_DB is untouched"
# The dev database has pg_stat_statements (round 1 gates), so the copies do too, and the suite's database-reset tries to
# DELETE from its views. The throwaway test copy does not need it.
psql_cmd "$OLD_TESTS_DB" "DROP EXTENSION IF EXISTS pg_stat_statements"

say_step "3. run the previous backend's suite (clojure -M:dev:test) in $TC_CONTAINER, log in $TESTS_LOG"
note "this takes a long time; the wrapper timeout is 4 h. A timeout ends the docker client only, not the test JVM."
# OLD_TESTS_FOCUS (space separated namespaces, e.g. "backend-tests.rpc-mcp-scope-test") runs only those namespaces
# (kaocha --focus). Round 2 used the MCP and access-token namespaces: the full suite takes hours on this host.
focus_args=""
for ns in ${OLD_TESTS_FOCUS:-}; do
    [[ "$ns" =~ ^[a-z0-9.-]+$ ]] || die "OLD_TESTS_FOCUS: '$ns' is not a namespace name"
    focus_args="$focus_args --focus $ns"
done
suite_script="cd /tmp/old/backend && clojure -M:dev:test$focus_args > $TESTS_LOG 2>&1; echo exit=\$?"
if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] docker exec -e PENPOT_TEST_DATABASE_URI=postgresql://penpot-postgres/$OLD_TESTS_DB -e PENPOT_TEST_DATABASE_USERNAME=$PG_USER -e PENPOT_TEST_DATABASE_PASSWORD=<set in the container> -e PENPOT_TEST_REDIS_URI=redis://penpot-valkey/$OLD_REDIS_DB -e PENPOT_FLAGS=enable-backend-asserts $TC_CONTAINER bash -c '$suite_script'"
else
    mkdir -p "$RESULTS"
    suite_out=$(timeout 14400 docker exec \
        -e "PENPOT_TEST_DATABASE_URI=postgresql://penpot-postgres/$OLD_TESTS_DB" \
        -e "PENPOT_TEST_DATABASE_USERNAME=$PG_USER" \
        -e "PENPOT_TEST_DATABASE_PASSWORD=penpot" \
        -e "PENPOT_TEST_REDIS_URI=redis://penpot-valkey/$OLD_REDIS_DB" \
        -e "PENPOT_FLAGS=enable-backend-asserts" \
        "$TC_CONTAINER" bash -c "$suite_script" 2>&1 || true)
    note "$suite_out"
    docker exec "$TC_CONTAINER" cat "$TESTS_LOG" >"$RESULTS/old-backend-tests.log" 2>/dev/null || true
fi

say_step "4. summary"
if [ "$DRY_RUN" != 1 ]; then
    note "log: $RESULTS/old-backend-tests.log"
    grep -E "Ran [0-9]+ tests|failures|errors" "$RESULTS/old-backend-tests.log" >"$RESULTS/old-backend-summary.txt" 2>/dev/null || true
    cat "$RESULTS/old-backend-summary.txt" 2>/dev/null || true
fi

print_checklist
