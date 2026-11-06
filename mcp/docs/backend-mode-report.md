# Backend-native MCP: status report

Date: 2026-11-05. Branch: `perf/render-wasm-large-files`.

This report says what was built, how it was checked, what the reviews found and what is left. The interface is
described in `backend-mode-contract.md`. The plan is `../backend-write-mcp-plan.md`.

## What was built

- **Backend commands** (`backend/src/app/rpc/commands/mcp.clj`, `mcp_write.clj`, `app/rpc/mcp_scope.clj`): read
  commands (outline, page tree, shapes, find, library, tokens), write commands (`mcp-apply-changes`,
  `mcp-apply-operations`, `mcp-import-svg`), scopes (`mcp:read`, `mcp:write`, `mcp:manage`, `mcp:delete`), render
  sessions for the exporter, OAuth consent with real scopes, limits, audit and webhook events.
- **Operation compiler** (`common/src/app/common/mcp/operations.cljc`): a pure CLJC compiler from typed operations
  to Penpot changes. It covers pages, shapes, text, paths, images, layouts (flex and grid), components (create,
  instantiate with overrides, swap, detach, sync), tokens (sets, themes, apply, DTCG import), typographies,
  colours, interactions, comments support data and plugin data. Geometry goes through Penpot's own modifiers.
- **Adapter** (`mcp/packages/server`): backend mode (`PENPOT_MCP_MODE=backend`) with one tool per command,
  `batch_create_shapes`, `export_shape` (through the exporter, no browser of its own), `import_svg`,
  `import_image`, `manage_files`, `manage_versions`, `comments`, and `execute_code`: a QuickJS sandbox that runs
  plugin-API scripts and compiles them into operations.
- **Harnesses**: `mcp/packages/loadtest` (scenarios S1 to S9, C1 to C5, soak, a large-file generator, a smoke
  script) and `mcp/packages/design-parity` (builds a component library and journey screens through the MCP,
  pulls them back, generates a React app and compares DOM and pixels).

## Verification on the final code

| Check | Result |
|---|---|
| Common suite, JVM | 1679 tests, 28767 assertions, 0 failures |
| Common suite, ClojureScript | 1609 tests, 28459 assertions, 0 failures, 0 errors |
| Backend MCP suites (8 namespaces) | 128 tests, 788 assertions, 0 failures (before the last write-path round) |
| Backend write suites after the last round | 47 tests, 241 assertions, 0 failures |
| Backend suite, all namespaces | 1938 tests, 9767 assertions, 49 failures, 0 errors. All 49 are in `rpc-font-test` (42), `rpc-media-test` (4) and `storage-test` (3): the toolchain container used here has no font conversion tools and another ImageMagick build. This work only added token metadata to those commands. Run them in the devenv to confirm. |
| Adapter (`mcp/packages/server`) | 897 tests, 896 pass, 1 skipped; types and prettier clean |
| Load-test harness | 154 tests pass |
| Design-parity harness | 201 tests pass |
| clj-kondo and cljfmt on the changed files | 0 errors, 0 warnings; formatted |
| Smoke, 20 tools end to end on the live stack | all pass |

The frontend was not compiled in full here (no frontend toolchain on this host). The token management UI and
the consent page changed; check them in a devenv before a release.

## Design parity

The harness builds 47 components and 12 journey screens (612 nodes) through the MCP, pulls them back, generates
React and compares.

- Model check: 2240 of 2240 checks pass.
- DOM compare: 0 mismatches across 59 targets.
- Pixel compare at scale 2: 0 targets over budget (components 1 %, screens 0.5 %). The worst component is
  Button/Ghost/SM at 0.24 %; screens are at 0.01 % or less.

Two causes of earlier mismatches are worth knowing. Built-in Source Sans Pro names its bold and black variants
`bold` and `black`, not `700` and `900`; the compiler now derives the variant from the font table. Text
rasterises one pixel apart on Linux and Windows, so the compare screenshots the app inside the exporter container.

## Performance

All numbers are per call at the MCP boundary, on this machine (Windows host, backend in Docker), warm, with no
other load. The full table with every gate of plan 8.9 is in `../packages/loadtest/PERF-RUNBOOK.md`.

| Case | Measured | Plan target |
|---|---|---|
| Page read, 5,000-shape file (p95) | 18 to 30 ms | 400 ms |
| Page read, 100,000-shape file (p95) | 22 to 106 ms | 1.2 s |
| Small write (p95) | 53 ms | 600 ms |
| Batch write, 300 objects (p95) | 823 ms | 3 s |
| Bulk write, 5,000 shapes | 9.5 s | 25 s |
| Token write, 10 sets + 300 tokens + 10 themes | 841 ms | 1.5 s (p95) |
| `execute_code`, 792-rectangle grid | 3.6 s | 8 s |
| 20 agents on separate files (p95) | 243 ms, 0 errors | 1.2 s |
| 5 agents on one file (p95) | 1.76 s, nothing lost | 3 s |
| Snapshot write, 5,000-shape file (p95) | 150 ms | 2.5 s |
| Write on the 100,000-shape file (p50 / p95, snapshots included) | 205 ms / 1.86 s | reported |
| Compiler: 2,000 `update_shape` on a 20,000-shape page | 1.9 s | 5 s |
| Adapter memory after hostile scripts | about 160 MB | 2 GB cap |
| Backend CPU at 20 agents | 37 % of 12 cores | 70 % |

Not measured here, and why:

- Cold-cache reads: need a backend restart inside the run.
- Large file without pointer-map: the backend decides by feature flag, not per call.
- S6 archive import: no reference archive on this machine.
- C3 and C5 human half, human-tab slowdown: need a browser session editing the same file.
- 4 hour soak and the plugin-bridge baseline.
- Exact SQL statement counts under load: Postgres here does not load `pg_stat_statements`. Counted through
  the REPL for one call: 24 statements per write, 4 to 5 per page read (budgets 25 and 10).

## Reviews and what they changed

Opus reviews ran after each large block; a final Fable review covered the whole change set
(findings F1 to F9). Every finding below is fixed unless the last section says otherwise.

- Lazy objects map: `entryAt` built entries with swapped fields in both implementations, so `find` and
  `select-keys` on a map loaded from the database returned garbage and `update_shape` did nothing on committed
  shapes. This bug is also on `develop`. The type now behaves as a plain map (equality, `merge`, metadata,
  `nil` values), on the JVM and in ClojureScript.
- Write path: one transaction per call, notifications and cache invalidation after commit, bounded lag read,
  conflict check that counts parents of moves, a cap on compiled changes, batches cut at operation boundaries,
  `failedOperationIndex` from operation ranges.
- Compiler: bool ancestors in the geometry subset, natural child order in layouts, font variants, DTCG token
  type names, instantiate overrides, a grid `auto` track crash on the JVM, per-operation cost (validation once
  per shape, precompiled decoders).
- Read path (F5, F8): the box is the one the plugin API reports (position from the points, size from the
  `selrect`); common defaults are filled in.
- Adapter (F1, F2, F3, F7): whole-page export, `board` as a type name, `execute_code` folding setters into the
  create and sending at most 1,500 operations per call, token values resolved for `apply_token`.
- Sandbox memory: the QuickJS memory limit did not hold in this build; each sandbox now has a hard 256 MB
  WebAssembly memory and is recycled once it grows past 128 MB.
- Sessions: the 10 minute absolute age meant for MCP render sessions applied to every cookie session, so any
  user would have lost the session 10 minutes after login. No review caught it; the whole backend suite did
  (`http-middleware-test`). The check now applies to render sessions only.
- Large files: every save of a pointer-map file loaded every page (`fdata/enable-objects-map`); it now leaves
  unloaded pages alone, which also speeds up the editor's own saves. MCP snapshots no longer realise the whole
  file.

## Open items for the maintainer

1. Performance gates not measured here (list above). Decide whether to run them elsewhere or waive them.
2. `auto-file-snapshot-every` also fires on MCP writes, which have their own snapshot rule. Every fifth MCP
   write on a large file pays about 1.5 s for it. Decide whether MCP writes should skip it.
3. The editor's own snapshot path still realises the whole file (about 3.5 s on the 100,000-shape file).
4. Possible old bug, not introduced here: the snapshot of a file migrated in the same call may keep pointer
   references that `file_gc` later drops.
5. A partial index on `file_change (file_id, created_at) where label is not null` would stop the planner from
   choosing a sequential scan for the snapshot listing. It needs a migration.
6. Sandbox memory in the worst case: 50 idle sandboxes may each hold up to 128 MB.
7. Text created by the backend has no `position-data` until a browser opens the file, so auto-sized text boxes
   are estimates (`textSizeApproximate` on reads).
8. Bool shapes keep stale `x`, `y`, `width`, `height` attributes after a child moves (shared code, also in the
   editor); the read tools report the box from the points instead.
9. `frontend/translations/es.po` lacks the `mcp.oauth.*` keys.
10. `mcp/pnpm-lock.yaml` changed (Playwright pinned to 1.62.1 for the parity harness).
