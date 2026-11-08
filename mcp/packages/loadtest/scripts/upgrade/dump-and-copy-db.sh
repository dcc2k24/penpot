#!/usr/bin/env bash
# T5 step 1: dumps the dev database penpot_mcpdev and restores it into penpot_upgrade_test, then puts the copy back to
# the state before migrations 0158 and 0159 (to-pre-upgrade.sql), so run-new-migrations.sh has something to apply.
#
# Idempotent: an existing copy is dropped first (its sessions are ended). Never writes to penpot_mcpdev: pg_dump only reads.
#
# Usage:
#   dump-and-copy-db.sh --dry-run
#   dump-and-copy-db.sh --yes                       dump, restore, roll 0158 and 0159 back in the copy
#   dump-and-copy-db.sh --yes --keep-new-migrations restore only; use when the copy must match the dev database exactly
#
# Output: the dump lives in /tmp of the Postgres container (penpot_mcpdev-upgrade-test.dump).

USAGE="dump-and-copy-db.sh: copies penpot_mcpdev into penpot_upgrade_test (see the header of this file).
Options: --dry-run | --yes (required to run), --keep-new-migrations (do not roll 0158 and 0159 back in the copy)"

# shellcheck source=upgrade-lib.sh
. "$(cd "$(dirname "$0")" && pwd)/upgrade-lib.sh"

KEEP_NEW=0
for arg in "$@"; do
    if common_flag "$arg"; then
        continue
    fi
    case "$arg" in
        --keep-new-migrations) KEEP_NEW=1 ;;
        *) die "unknown option $arg" ;;
    esac
done

require_yes
guard_copy_db "$COPY_DB"
[ "$SRC_DB" != "$COPY_DB" ] || die "the source and the copy are the same database"

DUMP="/tmp/penpot_mcpdev-upgrade-test.dump"

say_step "1. dump $SRC_DB inside $PG_CONTAINER (custom format, read only)"
do_run docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$SRC_DB" -Fc $(dump_exclude_args) -f "$DUMP"
do_run docker exec "$PG_CONTAINER" ls -l "$DUMP"

say_step "2. end sessions on the old copy and drop it"
terminate_sessions "$COPY_DB"
psql_cmd postgres "DROP DATABASE IF EXISTS $COPY_DB"

say_step "3. create $COPY_DB and restore the dump into it"
psql_cmd postgres "CREATE DATABASE $COPY_DB OWNER $PG_USER"
restore_rc=0
if [ "$DRY_RUN" = 1 ]; then
    printf '   [dry-run] docker exec %s pg_restore -U %s -d %s --no-owner --no-privileges %s\n' \
        "$PG_CONTAINER" "$PG_USER" "$COPY_DB" "$DUMP"
else
    docker exec "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$COPY_DB" --no-owner --no-privileges "$DUMP" || restore_rc=$?
fi
note "pg_restore exit code: $restore_rc (1 can mean warnings only; the counts below decide)"

if [ "$KEEP_NEW" = 0 ]; then
    say_step "4. put the copy back to before 0158 and 0159 (copy only)"
    psql_file "$COPY_DB" "$LIB_DIR/to-pre-upgrade.sql"
else
    say_step "4. keep the migrations as the dump has them (--keep-new-migrations)"
fi

say_step "5. check the copy"
if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] compares table counts and migration counts of $SRC_DB and $COPY_DB"
    psql_cmd "$COPY_DB" "select count(*) from migrations where step like '015%'"
else
    src_tables=$(psql_cmd "$SRC_DB" "select count(*) from information_schema.tables where table_schema = 'public'")
    copy_tables=$(psql_cmd "$COPY_DB" "select count(*) from information_schema.tables where table_schema = 'public'")
    src_migrations=$(psql_cmd "$SRC_DB" "select count(*) from migrations")
    copy_migrations=$(psql_cmd "$COPY_DB" "select count(*) from migrations")
    copy_new=$(psql_cmd "$COPY_DB" "select count(*) from migrations where step in ('0158-add-client-to-access-token', '0159-add-file-change-indexes')")
    note "public tables: $SRC_DB=$src_tables copy=$copy_tables"
    note "migration rows: $SRC_DB=$src_migrations copy=$copy_migrations"
    note "0158 and 0159 rows in the copy: $copy_new (0 when rolled back, 2 with --keep-new-migrations)"
    if [ "$src_tables" != "$copy_tables" ]; then
        die "the copy has $copy_tables public tables, the source $src_tables: the restore is not complete"
    fi
fi

printf '\ndone: %s is ready. Next: seed.sh (optional), then run-new-migrations.sh.\n' "$COPY_DB"
