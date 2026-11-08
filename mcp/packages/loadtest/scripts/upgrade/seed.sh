#!/usr/bin/env bash
# T5 step 2: inserts 100,000 synthetic file_change rows for one file into penpot_upgrade_test (seed-file-change.sql).
# Run after dump-and-copy-db.sh and before run-new-migrations.sh, so the migrations meet a table of realistic size.
#
# Usage:
#   seed.sh --dry-run --vars <vars.json>
#   seed.sh --yes --vars <vars.json>
#   seed.sh --yes --file-id <uuid>
# The file id is --file-id, else the fileId of the vars file (--vars, else PENPOT_LOADTEST_VARS_FILE).
# The file must exist in the copy; a copy of the dev database has the same ids as the dev database.

USAGE="seed.sh: inserts 100,000 synthetic file_change rows for one file into penpot_upgrade_test (see the header of this file).
Options: --dry-run | --yes (required to run), --vars <vars.json>, --file-id <uuid>"

# shellcheck source=upgrade-lib.sh
. "$(cd "$(dirname "$0")" && pwd)/upgrade-lib.sh"

VARS="${PENPOT_LOADTEST_VARS_FILE:-}"
FILE_ID=""
while [ $# -gt 0 ]; do
    if common_flag "$1"; then
        shift
        continue
    fi
    case "$1" in
        --vars)
            VARS="$2"
            shift
            ;;
        --file-id)
            FILE_ID="$2"
            shift
            ;;
        *) die "unknown option $1" ;;
    esac
    shift
done

require_yes
guard_copy_db "$COPY_DB"

if [ -z "$FILE_ID" ]; then
    if [ "$DRY_RUN" = 1 ] && [ -z "$VARS" ]; then
        FILE_ID="<fileId from the vars file>"
    else
        [ -n "$VARS" ] || die "give --file-id, or --vars with a vars file (PENPOT_LOADTEST_VARS_FILE also works)"
        [ -f "$VARS" ] || die "vars file not found: $VARS"
        FILE_ID=$(node -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(v.fileId || "")' "$VARS")
    fi
fi

if [ "$DRY_RUN" != 1 ]; then
    [[ "$FILE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "not a file id: $FILE_ID"
fi

say_step "1. check that the file exists in $COPY_DB"
exists=$(psql_cmd "$COPY_DB" "select count(*) from file where id = '$FILE_ID'")
if [ "$DRY_RUN" != 1 ] && [ "$exists" != "1" ]; then
    die "file $FILE_ID is not in $COPY_DB (run dump-and-copy-db.sh first, or pick a file of the dev database)"
fi

say_step "2. insert 100,000 synthetic file_change rows for file $FILE_ID"
psql_file "$COPY_DB" "$LIB_DIR/seed-file-change.sql" -v "file_id=$FILE_ID"

printf '\ndone: the synthetic rows are in %s. Next: run-new-migrations.sh.\n' "$COPY_DB"
