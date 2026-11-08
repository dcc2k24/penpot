#!/usr/bin/env bash
# Builds the adapter image of the two-adapter stack from the working tree.
# Run once, and again after code changes. Needs pnpm and network access.
set -euo pipefail

# mcp/ is the parent of this deploy folder. Work out the paths from this script.
MCP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$MCP_DIR/.." && pwd)"
BUNDLE_DIR="$REPO_DIR/docker/images/bundle-mcp"

# The bundle is made in a temporary copy. scripts/build removes mcp/node_modules
# and mcp/dist, so running it in place would break a live adapter and the tests.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Copies a tree without its top-level node_modules, dist and .git.
copy_tree() {
  local src="$1" dst="$2"
  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude=/node_modules --exclude=/dist --exclude=/.git "$src/" "$dst/"
  else
    (cd "$src" && tar --anchored --exclude='./node_modules' --exclude='./dist' --exclude='./.git' -cf - .) \
      | (cd "$dst" && tar -xf -)
  fi
}

# scripts/build-types reads ../../plugins, so the copy keeps plugins/ next to mcp/.
copy_tree "$MCP_DIR" "$WORK/mcp"
copy_tree "$REPO_DIR/plugins" "$WORK/plugins"

# Tell the user when an adapter answers on the host port. The copy is safe to build anyway.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:4405/healthz 2>/dev/null || true)"
if [[ "$code" == "200" ]]; then
  echo "note: an adapter answers on port 4405. The build runs in a copy, so the live adapter keeps running." >&2
fi

# Makes the bundle in the copy. It runs pnpm install there, so it is slow and needs network access.
(cd "$WORK/mcp" && ./scripts/build)

if [[ ! -f "$WORK/mcp/dist/setup" || ! -f "$WORK/mcp/dist/package.json" ]]; then
  echo "error: dist/setup or dist/package.json is missing after the build in the copy" >&2
  exit 1
fi

# Copies the bundle to where the Dockerfile reads it. The bundle is gitignored.
rm -rf "$BUNDLE_DIR"
cp -r "$WORK/mcp/dist" "$BUNDLE_DIR"

# Builds the image only. No container is started.
cd "$MCP_DIR"
docker compose -f deploy/compose.two-adapters.yaml build
