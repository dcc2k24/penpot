# Operator scripts

Scripts for the people who run the backend-native MCP. They are not part of the load tests. Each one is a shell
script, has `--dry-run` (the default) and needs `--yes` to change anything. The operator's guide is
`docs/technical-guide/mcp-production.md` (section 8 covers the deletion cascade).

## delete-agent-data.sh

Removes the data that the MCP keeps outside Penpot's database for one profile.

- Redis keys of the adapters, by token digest: `penpot.mcp.sandbox.storage.<digest>` and
  `penpot.mcp.ratelimit.<digest>`. The digest is the SHA-256 hex of the raw MCP token. The token is the `token`
  column of the `access_token` row, so the script reads the digests from Postgres with `--profile`.
- Files under the export and import roots (`PENPOT_MCP_EXPORT_DIR`, `PENPOT_MCP_IMPORT_DIR`), older than a
  number of days. The adapter does not record which profile wrote a file, so this step lists every old file of
  the roots. It cannot select the files of one profile.

```sh
# Dry run: prints the digest query, the keys and the old files. Needs no Redis and no database.
scripts/ops/delete-agent-data.sh --profile <profile-uuid> --files-older-than 90

# Real run. Run it before the profile row is hard-deleted: the foreign key cascades to access_token.
OPS_PSQL="docker exec -i penpot-penpot-postgres-1 psql -U penpot -d penpot" \
PENPOT_MCP_REDIS_URI="redis://penpot-mcp-redis:6379" \
scripts/ops/delete-agent-data.sh --profile <profile-uuid> --yes

# Keys of tokens you know but the database no longer has: pass the digests.
scripts/ops/delete-agent-data.sh --digest <sha256-hex> --yes
```

Options: `--profile`, `--digest` (repeatable), `--files-older-than <days>`, `--root <dir>` (repeatable; replaces the
default roots), `--dry-run`, `--yes`. Environment: `OPS_PSQL`, `PENPOT_MCP_REDIS_URI`, `OPS_REDIS_CLI`, the two root
variables. The script refuses a root that is `/`, the home directory or a symbolic link, and it never follows links
while it searches (`find -P`, `-type f`).

What the script does not do: it does not delete Postgres rows, storage objects or snapshots. Penpot removes those
with its own deletion jobs (section 8 of the guide). Tokens that were replaced on re-approval keep their Redis keys
until the keys expire on their own; the script cannot find their digests once the rows are gone.

Checks made on the script: `bash -n`, dry runs with and without arguments, and a `--yes` run on a scratch root
(old files removed, new files kept). Not tested: real Redis keys, a real `OPS_PSQL` query, and symbolic links on
Windows.
