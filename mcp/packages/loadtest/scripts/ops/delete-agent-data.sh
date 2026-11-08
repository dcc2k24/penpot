#!/usr/bin/env bash
# Removes the data that the backend-native MCP keeps for one profile outside Penpot's database:
#
#   1. Redis keys of the adapters, per MCP token digest (SHA-256 hex of the raw token):
#        penpot.mcp.sandbox.storage.<digest>   sandbox `storage` of execute_code (TTL: the idle eviction time)
#        penpot.mcp.ratelimit.<digest>         token bucket of the shared rate limit (TTL: a few seconds)
#   2. Files under the adapter's export and import roots (PENPOT_MCP_EXPORT_DIR, PENPOT_MCP_IMPORT_DIR), older than
#      a given age. The adapter does not record which profile wrote a file, so this step cannot pick the files of one
#      profile. It lists candidates by age only, and the operator decides.
#
# Penpot deletes its own rows. This script does not touch them (see docs/technical-guide/mcp-production.md, section 8).
#
# The digests come from the access_token table. Run the profile step BEFORE the profile row is hard-deleted: the
# foreign key cascades to access_token. Or pass the digests with --digest.
#
# Dry run is the default. Nothing is deleted without --yes.
#
# Usage:
#   delete-agent-data.sh --profile <uuid> [--digest <hex>]... [--files-older-than <days>] [--root <dir>]... [--dry-run | --yes]
#
# Environment:
#   OPS_PSQL              command that runs psql against the Penpot database, for example
#                         "docker exec -i penpot-penpot-postgres-1 psql -U penpot -d penpot" (default: psql, with the
#                         usual PG* variables). Needed for --profile when not a dry run. A dry run only prints the query.
#   PENPOT_MCP_REDIS_URI  Redis of the adapters, redis:// or rediss:// (the same value the adapters use).
#   OPS_REDIS_CLI         redis-cli command (default: redis-cli). For rediss:// set the TLS options your redis-cli needs.
#   PENPOT_MCP_EXPORT_DIR, PENPOT_MCP_IMPORT_DIR  roots to scan (default: penpot-exports and penpot-imports in the
#                         home directory, the adapter's own defaults). --root replaces them.
#
# Exit codes: 0 done (or dry run printed), 1 error, 2 usage error.

set -euo pipefail

USAGE="delete-agent-data.sh: removes the MCP Redis keys of a profile and, by age, files under the adapter's roots.
Options:
  --profile <uuid>          look up the MCP token digests of the profile (needs OPS_PSQL)
  --digest <sha256-hex>     a token digest to remove; repeatable
  --files-older-than <days> list (dry run) or delete (--yes) files under the roots older than this many days
  --root <dir>              a root to scan for --files-older-than; repeatable, replaces the defaults
  --dry-run                 print what would be removed (the default)
  --yes                     remove it
  -h, --help                show this help"

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

usage_error() {
    printf 'delete-agent-data.sh: %s\n\n%s\n' "$*" "$USAGE" >&2
    exit 2
}

PROFILE=""
DIGESTS=()
FILES_OLDER_THAN=""
ROOTS=()
DRY_RUN=1

while [ $# -gt 0 ]; do
    case "$1" in
        --profile)
            [ $# -ge 2 ] || usage_error "--profile needs a value"
            PROFILE="$2"
            shift 2
            ;;
        --digest)
            [ $# -ge 2 ] || usage_error "--digest needs a value"
            DIGESTS+=("$2")
            shift 2
            ;;
        --files-older-than)
            [ $# -ge 2 ] || usage_error "--files-older-than needs a value"
            FILES_OLDER_THAN="$2"
            shift 2
            ;;
        --root)
            [ $# -ge 2 ] || usage_error "--root needs a value"
            ROOTS+=("$2")
            shift 2
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --yes)
            DRY_RUN=0
            shift
            ;;
        -h | --help)
            printf '%s\n' "$USAGE"
            exit 0
            ;;
        *)
            usage_error "unknown option $1"
            ;;
    esac
done

if [ -z "$PROFILE" ] && [ "${#DIGESTS[@]}" -eq 0 ] && [ -z "$FILES_OLDER_THAN" ]; then
    usage_error "give --profile, --digest or --files-older-than"
fi

if [ -n "$PROFILE" ]; then
    printf '%s' "$PROFILE" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' ||
        usage_error "--profile is not a UUID"
fi

for digest in ${DIGESTS[@]+"${DIGESTS[@]}"}; do
    printf '%s' "$digest" | grep -Eq '^[0-9a-f]{64}$' || usage_error "--digest must be 64 lowercase hex characters"
done

if [ -n "$FILES_OLDER_THAN" ]; then
    printf '%s' "$FILES_OLDER_THAN" | grep -Eq '^[1-9][0-9]*$' || usage_error "--files-older-than must be a whole number of days, 1 or more"
fi

if [ "$DRY_RUN" = 1 ]; then
    MODE="dry run: nothing is removed (pass --yes to remove)"
else
    MODE="removing"
fi
printf '== delete-agent-data (%s)\n' "$MODE"

# --- 1. token digests of the profile

if [ -n "$PROFILE" ]; then
    SQL="SELECT encode(sha256(convert_to(token, 'UTF8')), 'hex') FROM access_token WHERE profile_id = '$PROFILE' AND type = 'mcp' ORDER BY created_at"
    printf '\n-- token digests of profile %s\n' "$PROFILE"
    if [ -z "${OPS_PSQL:-}" ]; then
        if [ "$DRY_RUN" = 1 ]; then
            printf '   OPS_PSQL is not set; a real run would run:\n   %s\n' "$SQL"
        else
            die "OPS_PSQL is not set: the digests of --profile cannot be read. Set it, or pass --digest."
        fi
    else
        # shellcheck disable=SC2086
        LOOKED_UP=$($OPS_PSQL -X -At -c "$SQL") || die "the digest query failed"
        if [ -z "$LOOKED_UP" ]; then
            printf '   no MCP token rows for this profile (already removed, or never had one)\n'
        fi
        while IFS= read -r digest; do
            if [ -n "$digest" ]; then
                DIGESTS+=("$digest")
            fi
        done <<<"$LOOKED_UP"
    fi
fi

# --- 2. Redis keys

if [ "${#DIGESTS[@]}" -eq 0 ] && [ -n "$FILES_OLDER_THAN" ]; then
    :
elif [ "${#DIGESTS[@]}" -eq 0 ]; then
    printf '\n-- Redis keys\n   no digests, no keys\n'
else
    printf '\n-- Redis keys\n'
    REDIS_URI="${PENPOT_MCP_REDIS_URI:-}"
    REDIS_CLI="${OPS_REDIS_CLI:-redis-cli}"
    if [ -z "$REDIS_URI" ] && [ "$DRY_RUN" = 0 ]; then
        printf '   PENPOT_MCP_REDIS_URI is not set: the adapters did not use Redis, so there are no shared keys to remove\n'
    fi
    for digest in "${DIGESTS[@]}"; do
        for prefix in penpot.mcp.sandbox.storage penpot.mcp.ratelimit; do
            key="$prefix.$digest"
            if [ "$DRY_RUN" = 1 ] || [ -z "$REDIS_URI" ]; then
                printf '   %s\n' "$key"
                continue
            fi
            exists=$($REDIS_CLI -u "$REDIS_URI" EXISTS "$key") || die "Redis EXISTS failed for $key"
            if [ "$exists" = "1" ]; then
                $REDIS_CLI -u "$REDIS_URI" DEL "$key" >/dev/null || die "Redis DEL failed for $key"
                printf '   deleted %s\n' "$key"
            else
                printf '   absent  %s\n' "$key"
            fi
        done
    done
    if [ "$DRY_RUN" = 1 ]; then
        if [ -n "$REDIS_URI" ]; then
            printf '   (dry run: the keys above are not checked against Redis)\n'
        else
            printf '   (dry run, PENPOT_MCP_REDIS_URI not set: keys listed, none checked)\n'
        fi
    fi
fi

# --- 3. files under the roots, by age

if [ -n "$FILES_OLDER_THAN" ]; then
    printf '\n-- files older than %s days under the export and import roots\n' "$FILES_OLDER_THAN"
    printf '   These files are not tied to a profile. Every file of a root that is older than the age is a candidate.\n'
    if [ "${#ROOTS[@]}" -eq 0 ]; then
        ROOTS=("${PENPOT_MCP_EXPORT_DIR:-$HOME/penpot-exports}" "${PENPOT_MCP_IMPORT_DIR:-$HOME/penpot-imports}")
    fi
    for root in "${ROOTS[@]}"; do
        case "$root" in
            /* | [A-Za-z]:[\\/]*) ;;
            *) die "root must be an absolute path: $root" ;;
        esac
        if [ "$root" = "/" ] || [ "$root" = "$HOME" ] || [ "$root" = "$HOME/" ]; then
            die "refusing the root $root"
        fi
        if [ -L "$root" ]; then
            die "refusing a root that is a symbolic link: $root"
        fi
        if [ ! -d "$root" ]; then
            printf '   %s: not a directory, skipped\n' "$root"
            continue
        fi
        # -P: find never follows a link. -type f: links and directories are never candidates.
        mapfile -t FOUND < <(find -P "$root" -type f -mtime "+$FILES_OLDER_THAN")
        printf '   %s: %s file(s)\n' "$root" "${#FOUND[@]}"
        for file in ${FOUND[@]+"${FOUND[@]}"}; do
            if [ "$DRY_RUN" = 1 ]; then
                printf '     %s\n' "$file"
            else
                rm -f -- "$file"
                printf '     deleted %s\n' "$file"
            fi
        done
    done
fi

printf '\n== done (%s)\n' "$MODE"
