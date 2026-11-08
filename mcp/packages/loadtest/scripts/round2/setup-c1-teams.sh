#!/bin/bash
# Creates the five C1 teams (ten members each, one project each) on the dev stack
# (penpot-tc container, nREPL inside it) and writes c1-teams.json to OUT_DIR.
# The JSON holds team, project and profile ids and emails only; no token is read or printed.
# Usage: setup-c1-teams.sh <out-dir>
set -euo pipefail
if [ $# -lt 1 ]; then
  echo "usage: setup-c1-teams.sh <out-dir>" >&2
  exit 2
fi
OUT="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
MSYS_NO_PATHCONV=1 docker cp "$(cygpath -w "$HERE/setup-c1-teams.clj" 2>/dev/null || echo "$HERE/setup-c1-teams.clj")" penpot-tc:/tmp/r2-c1-teams.clj
MSYS_NO_PATHCONV=1 docker exec penpot-tc bash /tmp/nrepl.sh /tmp/r2-c1-teams.clj > "$OUT/setup-c1-teams.log" 2>&1 || true
if ! grep -q 'RESULT>>' "$OUT/setup-c1-teams.log"; then
  echo "setup failed, see $OUT/setup-c1-teams.log" >&2
  exit 1
fi
grep 'RESULT>>' "$OUT/setup-c1-teams.log"
MSYS_NO_PATHCONV=1 docker exec penpot-tc cat /tmp/r2-c1-teams.json > "$OUT/c1-teams.json"
MSYS_NO_PATHCONV=1 docker exec penpot-tc rm -f /tmp/r2-c1-teams.clj /tmp/r2-c1-teams.json
cat "$OUT/c1-teams.json"
