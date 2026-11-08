#!/bin/bash
# Creates the adversary profiles and tokens on the dev stack (penpot-tc
# container, nREPL on 6064 inside it) and writes one token per file to
# OUT_DIR: adv-read.txt, adv-off.txt, adv-exp.txt, adv-revoked.txt,
# adv-outsider.txt, plus adv-ids.json. Tokens are never printed.
# Usage: setup-dev.sh <vars.json> <out-dir>
set -euo pipefail
VARS="$1"; OUT="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
TEAM_ID="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).teamId)' "$VARS")"
sed "s/@TEAM_ID@/$TEAM_ID/" "$HERE/setup-dev.clj" > "$OUT/setup-dev.run.clj"
MSYS_NO_PATHCONV=1 docker cp "$(cygpath -w "$OUT/setup-dev.run.clj" 2>/dev/null || echo "$OUT/setup-dev.run.clj")" penpot-tc:/tmp/adv-setup.clj
MSYS_NO_PATHCONV=1 docker exec penpot-tc bash /tmp/nrepl.sh /tmp/adv-setup.clj > "$OUT/setup-dev.log" 2>&1 || true
if ! grep -q 'RESULT>>' "$OUT/setup-dev.log"; then
  echo "setup failed, see $OUT/setup-dev.log" >&2; exit 1
fi
MSYS_NO_PATHCONV=1 docker exec penpot-tc cat /tmp/adv-tokens.edn > "$OUT/adv-tokens.edn"
MSYS_NO_PATHCONV=1 docker exec penpot-tc cat /tmp/adv-ids.json > "$OUT/adv-ids.json"
MSYS_NO_PATHCONV=1 docker exec penpot-tc rm -f /tmp/adv-tokens.edn /tmp/adv-setup.clj
node -e '
const fs=require("fs"),path=require("path");
const edn=fs.readFileSync(process.argv[1],"utf8");
for (const m of edn.matchAll(/:(\w+) "([^"]+)"/g)) fs.writeFileSync(path.join(process.argv[2],"adv-"+m[1]+".txt"), m[2]+"\n");
fs.unlinkSync(process.argv[1]);
' "$OUT/adv-tokens.edn" "$OUT"
grep 'RESULT>>' "$OUT/setup-dev.log"
