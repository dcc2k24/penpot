#!/usr/bin/env bash
# Plan addition 7: a backup taken at any time (for example in the middle of the soak), restored into a copy, and used
# by a backend started against that copy.
#
# Steps:
#   1. count the rows of the key tables in penpot_mcpdev (before)
#   2. pg_dump penpot_mcpdev in custom format inside the Postgres container (a consistent snapshot; it does not stop the
#      live writes of the soak)
#   3. count the rows again (after)
#   4. restore the dump into penpot_backup_restore (sessions ended, database dropped and created first)
#   5. start this checkout's backend against the copy on port 6072 (the same launcher as run-new-migrations.sh) and wait
#      for /readyz
#   6. one token read (mcp-whoami) and one write (mcp-apply-operations: a new page) through that backend
#   7. stop the backend
#
# Checks:
#   - the copy's count of each table lies between the count before and the count after the dump, because the dump is
#     a snapshot taken between those two counts. A table that shrank in that window (garbage collection) fails the
#     check; rerun at a quieter moment and say so in the report;
#   - the token read answers 200 with scopes; the write answers 200 and the file's revn in the copy rises by one.
#
# Usage:
#   backup-restore.sh --dry-run [--vars <vars.json>]
#   backup-restore.sh --yes --token-file <file> --vars <vars.json> [--results-dir <dir>]
# The token is read from the first line of the token file into MCP_TOKEN for the docker client only: it is never
# printed, and it is not in a file or a command line.
#
# Results (default <loadtest>/results/upgrade/<stamp>/): backup-restore.txt (the counts and the checks) and
# backup-backend.log (the backend log of the copy).

USAGE="backup-restore.sh: dumps penpot_mcpdev, restores it into penpot_backup_restore, and checks one token read and one write
through a backend started against the copy.
Options: --dry-run | --yes (required to run), --token-file <file>, --vars <vars.json>, --results-dir <dir>"

# shellcheck source=upgrade-lib.sh
. "$(cd "$(dirname "$0")" && pwd)/upgrade-lib.sh"

BACKUP_PORT=6072
TOKEN_FILE="${PENPOT_LOADTEST_TOKEN_FILE:-}"
VARS="${PENPOT_LOADTEST_VARS_FILE:-}"
RESULTS_OPT=""
while [ $# -gt 0 ]; do
    if common_flag "$1"; then
        shift
        continue
    fi
    case "$1" in
        --token-file)
            TOKEN_FILE="$2"
            shift
            ;;
        --vars)
            VARS="$2"
            shift
            ;;
        --results-dir)
            RESULTS_OPT="$2"
            shift
            ;;
        *) die "unknown option $1" ;;
    esac
    shift
done

require_yes
guard_copy_db "$BACKUP_DB"

TABLES="file file_change project profile access_token"
COUNTS_SQL="select 'file', count(*) from file union all select 'file_change', count(*) from file_change union all select 'project', count(*) from project union all select 'profile', count(*) from profile union all select 'access_token', count(*) from access_token"

STAMP=$(date +%Y%m%dT%H%M%S)
RESULTS="${RESULTS_OPT:-$LOADTEST_DIR/results/upgrade/$STAMP}"
DUMP="/tmp/penpot_mcpdev-backup-$STAMP.dump"
REPORT="$RESULTS/backup-restore.txt"
FILE_ID=""
ALL_PASS=1

say_report() {
    if [ "$DRY_RUN" != 1 ]; then
        mkdir -p "$RESULTS"
        printf '%s\n' "$*" >>"$REPORT"
    fi
    printf '%s\n' "$*"
}

# HTTP POST to the backend under test, from inside penpot-tc. The body goes in on stdin; the token is passed by name, so
# its value is not on any command line. Prints the raw answer.
http_post() {
    local path="$1" body="$2"
    if [ "$DRY_RUN" = 1 ]; then
        printf '   [dry-run] POST http://127.0.0.1:%s%s (Authorization: Token <MCP_TOKEN>) with the JSON body on stdin\n' "$BACKUP_PORT" "$path"
        return 0
    fi
    printf '%s' "$body" | MCP_PATH="$path" MCP_PORT="$BACKUP_PORT" docker exec -i \
        -e MCP_TOKEN -e MCP_PATH -e MCP_PORT "$TC_CONTAINER" bash -c '
MCP_BODY=$(cat)
exec 3<>/dev/tcp/127.0.0.1/$MCP_PORT
printf "POST %s HTTP/1.0\r\nHost: localhost\r\nAuthorization: Token %s\r\nContent-Type: application/json\r\nContent-Length: %s\r\n\r\n%s" "$MCP_PATH" "$MCP_TOKEN" "${#MCP_BODY}" "$MCP_BODY" >&3
cat <&3'
}

# Table counts as "table|count" lines, one per table.
counts_of() {
    psql_cmd "$1" "$COUNTS_SQL"
}

count_of() { # counts-text table
    printf '%s\n' "$1" | awk -F'|' -v t="$2" '$1 == t { print $2 }'
}

cleanup() {
    [ "$DRY_RUN" = 1 ] && return 0
    backend_stop "$BACKUP_PORT" >/dev/null 2>&1 || true
}

say_step "0. preflight"
if [ "$DRY_RUN" != 1 ]; then
    [ -n "$TOKEN_FILE" ] && [ -f "$TOKEN_FILE" ] || die "give --token-file (the first line is the MCP token)"
    [ -n "$VARS" ] && [ -f "$VARS" ] || die "give --vars (the fileId is read from it)"
    FILE_ID=$(node -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(v.fileId || "")' "$VARS")
    [[ "$FILE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "vars file has no fileId uuid"
    MCP_TOKEN=$(head -n 1 "$TOKEN_FILE" | tr -d '\r')
    [ -n "$MCP_TOKEN" ] || die "the token file is empty"
    export MCP_TOKEN
    mkdir -p "$RESULTS"
    : >"$REPORT"
    trap cleanup EXIT
    backend_answers "$BACKUP_PORT" && die "something already answers /readyz on port $BACKUP_PORT: stop it first"
fi

say_step "1. count the key tables in $SRC_DB (before the dump)"
if [ "$DRY_RUN" = 1 ]; then
    counts_of "$SRC_DB" >/dev/null
    BEFORE=""
else
    BEFORE=$(counts_of "$SRC_DB")
    say_report "before: $(echo "$BEFORE" | tr '\n' ' ')"
fi

say_step "2. dump $SRC_DB inside $PG_CONTAINER (custom format; pg_dump only reads)"
do_run docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$SRC_DB" -Fc $(dump_exclude_args) -f "$DUMP"
do_run docker exec "$PG_CONTAINER" ls -l "$DUMP"

say_step "3. count the key tables in $SRC_DB (after the dump)"
if [ "$DRY_RUN" = 1 ]; then
    counts_of "$SRC_DB" >/dev/null
    AFTER=""
else
    AFTER=$(counts_of "$SRC_DB")
    say_report "after:  $(echo "$AFTER" | tr '\n' ' ')"
fi

say_step "4. restore the dump into $BACKUP_DB"
terminate_sessions "$BACKUP_DB" >/dev/null
psql_cmd postgres "DROP DATABASE IF EXISTS $BACKUP_DB"
psql_cmd postgres "CREATE DATABASE $BACKUP_DB OWNER $PG_USER"
restore_rc=0
if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] pg_restore -d $BACKUP_DB $DUMP inside $PG_CONTAINER"
else
    docker exec "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$BACKUP_DB" --no-owner --no-privileges "$DUMP" || restore_rc=$?
fi
note "pg_restore exit code $restore_rc (1 can mean warnings; the counts decide)"

say_step "5. count the key tables in the copy"
if [ "$DRY_RUN" = 1 ]; then
    counts_of "$BACKUP_DB" >/dev/null
else
    COPY_COUNTS=$(counts_of "$BACKUP_DB")
    say_report "copy:   $(echo "$COPY_COUNTS" | tr '\n' ' ')"
fi

say_step "6. start this checkout's backend against the copy on port $BACKUP_PORT and wait for /readyz"
backend_start /work/backend "$BACKUP_DB" "$BACKUP_PORT" "$UPGRADE_REDIS_DB"
if [ "$DRY_RUN" != 1 ]; then
    wait_backend_ready "$BACKUP_PORT" 900 || die "the backend did not answer /readyz in 15 min: see /tmp/upgrade-backend-$BACKUP_PORT.log in $TC_CONTAINER"
fi

say_step "7. one token read (mcp-whoami) through the copy's backend"
WHOAMI=$(http_post "/api/rpc/command/mcp-whoami" "{}")
say_report "mcp-whoami: $(printf '%s' "$WHOAMI" | head -n 1 | tr -d '\r')"

say_step "8. one write (mcp-apply-operations: a new page) through the copy's backend"
REV_BEFORE=""
if [ "$DRY_RUN" != 1 ]; then
    REV_BEFORE=$(psql_cmd "$BACKUP_DB" "select revn from file where id = '$FILE_ID'")
fi
WRITE_BODY="{\"file-id\": \"$FILE_ID\", \"operations\": [{\"op\": \"create_page\", \"id\": \"\$tmp:backup-check\", \"name\": \"backup check $STAMP\"}], \"snapshot\": false}"
WRITE=$(http_post "/api/rpc/command/mcp-apply-operations" "$WRITE_BODY")
say_report "mcp-apply-operations: $(printf '%s' "$WRITE" | head -n 1 | tr -d '\r')"
REV_AFTER=""
if [ "$DRY_RUN" != 1 ]; then
    REV_AFTER=$(psql_cmd "$BACKUP_DB" "select revn from file where id = '$FILE_ID'")
    say_report "revn of the file in the copy: $REV_BEFORE -> $REV_AFTER"
fi

say_step "9. stop the backend and save its log"
backend_stop "$BACKUP_PORT"
if [ "$DRY_RUN" != 1 ]; then
    docker exec "$TC_CONTAINER" cat "/tmp/upgrade-backend-$BACKUP_PORT.log" >"$RESULTS/backup-backend.log" 2>/dev/null || true
fi

say_step "10. checks"
if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] each table: before <= copy <= after; token read 200 with scopes; write 200 and revn +1 in the copy"
    printf '\ndry run: nothing was dumped, restored or started.\n'
    exit 0
fi
for table in $TABLES; do
    b=$(count_of "$BEFORE" "$table")
    a=$(count_of "$AFTER" "$table")
    c=$(count_of "$COPY_COUNTS" "$table")
    if [ -n "$b" ] && [ -n "$a" ] && [ -n "$c" ] && [ "$b" -le "$c" ] && [ "$c" -le "$a" ]; then
        say_report "PASS $table: before=$b copy=$c after=$a"
    else
        say_report "FAIL $table: before=$b copy=$c after=$a (the copy must lie between them)"
        ALL_PASS=0
    fi
done
if printf '%s' "$WHOAMI" | head -n 1 | grep -q " 200 "; then
    say_report "PASS token read: mcp-whoami answered 200"
else
    say_report "FAIL token read: mcp-whoami did not answer 200 (see the answer above and the backend log)"
    ALL_PASS=0
fi
if printf '%s' "$WRITE" | head -n 1 | grep -q " 200 " && [ "$REV_AFTER" = "$((REV_BEFORE + 1))" ]; then
    say_report "PASS write: mcp-apply-operations answered 200 and revn rose by one"
else
    say_report "FAIL write: answer or revn ($REV_BEFORE -> $REV_AFTER) does not match; the operation shape may be wrong for this backend: see the log"
    ALL_PASS=0
fi
say_report "report: $REPORT"
[ "$ALL_PASS" = 1 ] || exit 1
