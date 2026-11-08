#!/usr/bin/env bash
# Shared helpers of the T5 upgrade and rollback scripts. Sourced by the other scripts in this folder; not run alone.
#
# These scripts change only the copy database penpot_upgrade_test (and the throwaway copy the old test suite uses).
# They never write to penpot_mcpdev. Every container action is limited to the toolchain container penpot-tc (it runs
# the backends) and to psql through docker exec on the Postgres container. Nothing here removes a volume.

export MSYS_NO_PATHCONV=1

PG_CONTAINER="penpot-penpot-postgres-1"
TC_CONTAINER="penpot-tc"
PG_USER="penpot"
SRC_DB="penpot_mcpdev"
COPY_DB="penpot_upgrade_test"
OLD_TESTS_DB="penpot_upgrade_old_tests"
BACKUP_DB="penpot_backup_restore"
UPGRADE_PORT=6070 # the backend of this checkout, started against the copy
UPGRADE_REDIS_DB=5
OLD_PORT=6071 # the previous backend (541f965bf1), started for the manual token call
OLD_REDIS_DB=7
OLD_COMMIT="541f965bf1"

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOADTEST_DIR="$(cd "$LIB_DIR/../.." && pwd)"

# Tables whose rows the dumps leave out (space separated), e.g. UPGRADE_DUMP_EXCLUDE="file_data_07 file_data_01". Round 2
# needed it: penpot_mcpdev held 16 GB, 15 GB of it in one file_data partition, and the host disk had 12 GB free. The
# schema of an excluded table is still dumped; only its rows are left out.
dump_exclude_args() {
    local table
    for table in ${UPGRADE_DUMP_EXCLUDE:-}; do
        [[ "$table" =~ ^[a-z_][a-z0-9_]*$ ]] || die "UPGRADE_DUMP_EXCLUDE: '$table' is not a table name"
        printf -- '--exclude-table-data=%s
' "$table"
    done
}

DRY_RUN=0
YES=0

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

# Handles the flags every script takes. Returns 0 when it consumed the argument, 1 otherwise.
common_flag() {
    case "$1" in
        --dry-run)
            DRY_RUN=1
            return 0
            ;;
        --yes)
            YES=1
            return 0
            ;;
        -h | --help)
            printf '%s\n' "$USAGE"
            exit 0
            ;;
    esac
    return 1
}

# Scripts that change the copy need --yes; a dry run needs nothing.
require_yes() {
    if [ "$DRY_RUN" != 1 ] && [ "$YES" != 1 ]; then
        printf '%s: this script changes the copy database (%s) and runs containers. Re-run with --yes, or --dry-run to print the steps.\n' "$(basename "$0")" "$COPY_DB" >&2
        exit 2
    fi
}

# Refuses any database but the copy.
guard_copy_db() {
    if [ "$1" != "$COPY_DB" ] && [ "$1" != "$OLD_TESTS_DB" ] && [ "$1" != "$BACKUP_DB" ]; then
        die "refusing to change database '$1': these scripts change only $COPY_DB, $OLD_TESTS_DB and $BACKUP_DB"
    fi
}

say_step() {
    printf '\n== %s\n' "$*"
}

note() {
    printf '   %s\n' "$*"
}

# Runs a command, or prints it in a dry run.
do_run() {
    if [ "$DRY_RUN" = 1 ]; then
        printf '   [dry-run] %s\n' "$*"
        return 0
    fi
    "$@"
}

# One SQL statement against a database of the dev Postgres. In a dry run it prints the statement.
psql_cmd() {
    local db="$1" sql="$2"
    if [ "$DRY_RUN" = 1 ]; then
        printf '   [dry-run] psql -d %s -c "%s"\n' "$db" "$sql" >&2
        return 0
    fi
    docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$db" -X -At -v ON_ERROR_STOP=1 -c "$sql"
}

# A SQL file into a database of the dev Postgres, through stdin. Extra psql arguments come after the fixed ones.
psql_file() {
    local db="$1" file="$2"
    shift 2
    if [ "$DRY_RUN" = 1 ]; then
        printf '   [dry-run] psql -d %s %s -f - < %s\n' "$db" "$*" "$file"
        return 0
    fi
    docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$db" -X -v ON_ERROR_STOP=1 "$@" -f - <"$file"
}

# Ends the sessions of one database, so it can be dropped or used as a template. Refuses any other database.
terminate_sessions() {
    local db="$1"
    guard_copy_db "$db"
    psql_cmd postgres "select count(pg_terminate_backend(pid)) from pg_stat_activity where datname = '$db' and pid <> pg_backend_pid()"
}

# The launcher that starts one backend against one database on one port. The placeholders are filled in by
# backend_start. It keeps the settings of penpot-tc's run-backend-dev, with the database, port and Redis database
# changed, and without the nREPL server, so it cannot clash with the dev backend.
launcher_text() {
    cat <<'LAUNCHER'
#!/usr/bin/env bash
# Upgrade-test backend, written by upgrade-lib.sh. Own database (@DB@), own port (@PORT@), own Redis database (@REDIS@).
export PENPOT_UPGRADE_TEST_PORT=@PORT@
export PENPOT_DATABASE_URI=postgresql://penpot-postgres/@DB@
export PENPOT_DATABASE_USERNAME=penpot
export PENPOT_DATABASE_PASSWORD=penpot
export PENPOT_DATABASE_MAX_POOL_SIZE=4
export PENPOT_DATABASE_MIN_POOL_SIZE=1
export PENPOT_REDIS_URI=redis://penpot-valkey/@REDIS@
# The secret of the dev backend, read inside the container: tokens of the dev stack validate here, and no copy of the
# value is written to the host or to a log.
export PENPOT_SECRET_KEY="$(grep -m1 '^export PENPOT_SECRET_KEY=' /usr/local/bin/run-backend-dev | cut -d= -f2-)"
[ -n "$PENPOT_SECRET_KEY" ] || { echo "no PENPOT_SECRET_KEY in run-backend-dev" >&2; exit 1; }
export PENPOT_PUBLIC_URI=http://localhost:9002
export PENPOT_HTTP_SERVER_HOST=127.0.0.1
export PENPOT_HTTP_SERVER_PORT=@PORT@
export PENPOT_OBJECTS_STORAGE_BACKEND=fs
export PENPOT_OBJECTS_STORAGE_FS_DIRECTORY=/work/.upgrade-test-assets
export PENPOT_EXPORTER_SHARED_KEY=upgrade-test-exporter-key
export PENPOT_TELEMETRY_ENABLED=false
export PENPOT_FLAGS="enable-login-with-password disable-email-verification disable-secure-session-cookies enable-mcp enable-access-tokens disable-telemetry enable-backend-asserts enable-feature-fdata-pointer-map enable-file-validation enable-rpc-climit enable-rpc-rlimit enable-quotes enable-auto-file-snapshot enable-audit-log disable-registration-captcha enable-registration disable-remote-media-processing enable-mcp-backend enable-mcp-raw-changes"
mkdir -p "$PENPOT_OBJECTS_STORAGE_FS_DIRECTORY"
cd @TREE@
exec clojure -A:dev -M -m app.main
LAUNCHER
}

# Writes the launcher into penpot-tc and starts it detached. Args: tree dir, database, port, Redis database.
backend_start() {
    local tree="$1" db="$2" port="$3" redis="$4"
    local script="/tmp/upgrade-backend-$port.sh" log="/tmp/upgrade-backend-$port.log"
    guard_copy_db "$db"
    if [ "$DRY_RUN" = 1 ]; then
        printf '   [dry-run] write %s in %s (tree %s, database %s, port %s, redis db %s) and start it detached\n' \
            "$script" "$TC_CONTAINER" "$tree" "$db" "$port" "$redis"
        printf '   [dry-run] its log goes to %s in %s\n' "$log" "$TC_CONTAINER"
        return 0
    fi
    if backend_answers "$port"; then
        die "something already answers /readyz on port $port in $TC_CONTAINER; stop it first"
    fi
    launcher_text |
        sed -e "s|@TREE@|$tree|g" -e "s|@DB@|$db|g" -e "s|@PORT@|$port|g" -e "s|@REDIS@|$redis|g" |
        docker exec -i "$TC_CONTAINER" bash -c "cat > $script"
    docker exec -d "$TC_CONTAINER" bash -c "bash $script > $log 2>&1"
}

# Stops every backend started by backend_start on that port: the match is the environment marker, so the dev
# backend (which has no such marker) is left alone.
backend_stop() {
    local port="$1"
    local script='for p in /proc/[0-9]*; do pid=${p#/proc/}; if tr "\0" "\n" < "$p/environ" 2>/dev/null | grep -qx "PENPOT_UPGRADE_TEST_PORT=PORT_HERE"; then kill "$pid" 2>/dev/null && echo "stopped $pid"; fi; done; sleep 3'
    script="${script//PORT_HERE/$port}"
    if [ "$DRY_RUN" = 1 ]; then
        printf '   [dry-run] stop the backend started on port %s in %s (matched by its environment marker)\n' "$port" "$TC_CONTAINER"
        return 0
    fi
    docker exec "$TC_CONTAINER" bash -c "$script"
}

# One /readyz probe from inside penpot-tc: true when it answers 200 now.
backend_answers() {
    local port="$1"
    docker exec "$TC_CONTAINER" bash -c "exec 3<>/dev/tcp/127.0.0.1/$port && printf 'GET /readyz HTTP/1.0\r\n\r\n' >&3 && read -r line <&3 && case \"\$line\" in *' 200 '*) exit 0;; esac; exit 1" >/dev/null 2>&1
}

# Waits for /readyz on the port, up to the limit in seconds. Returns 1 at the limit.
wait_backend_ready() {
    local port="$1" limit="$2" waited=0
    while [ "$waited" -lt "$limit" ]; do
        if backend_answers "$port"; then
            return 0
        fi
        sleep 5
        waited=$((waited + 5))
    done
    return 1
}
