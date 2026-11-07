# Backend-native MCP: status report

Date: 2026-11-07 (first version 2026-11-05). Branch: `perf/render-wasm-large-files`. The feature is committed as
`2c33b0ff9a` and `541f965bf1`; the fix rounds that followed the architecture review are uncommitted on top.

This report says what was built, how it was checked, what the reviews found and what is left. The interface is
described in `backend-mode-contract.md`. The architecture review and its resolution are in `backend-mode-review.md`.
The plan is `../backend-write-mcp-plan.md`.

## What was built

- **Backend commands** (`backend/src/app/rpc/commands/mcp.clj`, `mcp_write.clj`, `mcp_limits.clj`,
  `app/rpc/mcp_scope.clj`): read commands (outline, page tree, shapes, find, library, tokens), write commands
  (`mcp-apply-changes`, `mcp-apply-operations`, `mcp-import-svg`), scopes (`mcp:read`, `mcp:write`, `mcp:manage`,
  `mcp:delete`), render sessions for the exporter, OAuth consent with one access token per client, limits, audit
  and webhook events. Backend mode sits behind the flag `enable-mcp-backend` (off by default); raw changes behind
  `enable-mcp-raw-changes`.
- **Operation compiler** (`common/src/app/common/mcp/operations.cljc` and the internal
  `app.common.mcp.operations.*` namespaces): a pure CLJC compiler from typed operations to Penpot changes. It
  covers pages, shapes, paths, text, images, layouts (flex and grid), components (create, instantiate with
  overrides, swap, detach, sync), tokens (sets, themes, apply, DTCG import), typographies, colours, interactions,
  plugin data and arrangement. Geometry goes through Penpot's own modifiers; structure moves follow the editor's
  rules.
- **Adapter** (`mcp/packages/server`): backend mode (`PENPOT_MCP_MODE=backend`) with one tool per command,
  `batch_create_shapes`, `describe_operations`, `export_shape` (through the exporter, no browser of its own),
  `import_svg`, `import_image`, `import_archive`, `manage_files`, `manage_versions`, `comments`, and
  `execute_code`: a QuickJS sandbox in a worker thread per token that runs plugin-API scripts and compiles them into
  operations. Health, readiness and metrics endpoints; a request id across the hop.
- **Harnesses**: `mcp/packages/loadtest` (scenarios S1 to S9, C1 to C7, soak, a large-file generator, a smoke
  script, open-loop and warm-up options, reliability marks on percentiles) and `mcp/packages/design-parity`
  (builds a component library and journey screens through the MCP, pulls them back, generates a React app and
  compares DOM and pixels, with the pixel step as a gate).

## Verification on the final code

| Check | Result |
|---|---|
| Common suite, JVM (whole) | 1749 tests, 29212 assertions, 0 failures |
| Common suite, ClojureScript (whole) | 1685 tests, 29023 assertions, 0 failures, 0 errors |
| Backend suite, all namespaces | 2052 tests, 10145 assertions, 49 failures, 0 errors. All 49 are in `rpc-font-test` (42), `rpc-media-test` (4) and `storage-test` (3): the toolchain container used here has no font conversion tools and another ImageMagick build. Run them in the devenv to confirm. |
| Adapter (`mcp/packages/server`) | 1109 tests, 1105 pass, 4 skipped (plugin-types drift check without the package, a symlink test on this account, one skipped by design); `tsc` and prettier clean; the suite also passes with `PENPOT_MCP_SANDBOX_WORKERS=false` |
| Load-test harness | 182 tests pass; `tsc` clean |
| Design-parity harness | 226 tests pass; `tsc` clean |
| Frontend | `shadow-cljs compile main`: 1238 files, 0 warnings (in the toolchain container, with a stub for the render-wasm `shared.js`); frontend unit tests need the render-wasm build and were not run |
| clj-kondo and cljfmt on the 74 changed Clojure files | 0 errors; 25 warnings, all pre-existing in shared test files (`helpers.clj`, `rpc_test.clj`, `rpc_access_tokens_test.clj`); `scripts/check-fmt-clj` clean |
| Smoke, 21 steps end to end on the live stack | all pass (the `execute_code` step runs on a fresh page; the test file's main page has grown to about 59,000 shapes, above the sandbox page cap of 16 MB) |

Reviews: six Fable 5.1 reviewers (one per area) produced the architecture review; each area then had two Opus 5.5
review passes over the fixes, and every finding of those passes was fixed or recorded as open in
`backend-mode-review.md`, section 10.

## Design parity

The harness builds 47 components and 12 journey screens (612 nodes) through the MCP, pulls them back, generates
React and compares. On the final code (2026-11-07, outputs under the session scratchpad `live5/`):

- `build`, `pull`, `verify`, `generate` and `compare` all exit 0.
- Model check: 2240 of 2240 checks pass.
- DOM compare: 0 mismatches across 59 targets.
- Pixel compare at scale 2, now a gate: 0 targets over budget (components 1 %, screens 0.5 %). The worst component
  is Button/Ghost/SM at 0.24 %; screens are at 0.01 % or less.
- The puller requests its fields explicitly and re-chunks on the adapter's 100 kB answer cap; `build` backs off
  when the adapter rate-limits it.

Two causes of earlier mismatches are worth knowing. Built-in Source Sans Pro names its bold and black variants
`bold` and `black`, not `700` and `900`; the compiler derives the variant from the font table. Text rasterises one
pixel apart on Linux and Windows, so the compare screenshots the app inside the exporter container.

## Performance

All numbers are per call at the MCP boundary, on this machine (Windows host, backend in Docker), warm, with no
other load, on an uncommitted tree. Percentiles from fewer than 200 samples carry the harness's "unreliable" mark
and are the maximum of a handful of calls. The full gate table is in `../packages/loadtest/PERF-RUNBOOK.md`.

Measured on the final code (2026-11-07):

| Case | Measured | Plan target |
|---|---|---|
| 10 agents on separate files (C1), 500 calls | p50 320 ms, p95 2.19 s, 0 errors | p95 1.2 s (5 agents: p50 78 / p95 128 ms) |
| 5 agents on one file (C2), 2,545 calls, writes of 100 rectangles on a page of 59,000 shapes | p50 4.1 s, p95 6.2 s, 0 errors, nothing lost | p95 3 s |
| 2 agents on one file (C2), fresh file | p95 648 ms | p95 3 s |
| Snapshot write (S8), normal file, 100 calls | p50 1.07 s, p95 3.7 s (unreliable mark) | p95 2.5 s |
| `execute_code`, 50 rectangles under a board, small file | 283 ms | 100 ops p95 2 s |
| `execute_code` beside a read: a 2.5 s busy loop and a concurrent `get_file_outline` | the read answered in 86 ms | scripts must not block other calls |
| `for(;;){}` | refused after 3.0 s (CPU budget 3 s) | hard stop |
| Compiler lookups per operation on a 20,000-shape page | `update_shape` 28, unnamed `create_rect` 18 (was 20,040), `set_text` 22 (was 423), `apply_token` 45 | bound 200 |
| Single write through the adapter, 100 rectangles on the 59,000-shape page | 1.7 s (was 3.5 s before validation was limited to touched shapes) | reported |

Measured on `541f965bf1` (before the fix rounds; the paths did not get slower, but they were not all re-measured):
page read p95 18 to 30 ms on a 5,000-shape file and 22 to 106 ms on a 100,000-shape file; small write p95 53 ms;
batch write of 300 objects p95 823 ms; bulk write of 5,000 shapes 9.5 s; token write of 300 tokens 841 ms;
`execute_code` grid of 792 rectangles 3.6 s; adapter memory about 160 MB after hostile scripts; backend CPU 37 %
of 12 cores at 20 agents.

The C2 figure on the 59,000-shape page misses its 3 s bar: each write still decodes and encodes the whole touched
page (about 0.4 s each), and five agents queue on the file lock. On the file the scenario was written for (a fresh
file) the bar holds. Clearing it on such a page needs page splitting or partial re-encoding.

Not measured here, and why:

- Cold-cache reads: need a backend restart inside the run.
- Large file without pointer-map: the backend decides by feature flag, not per call.
- S6 archive import: no reference archive on this machine.
- C3 and C5 human half, human-tab slowdown: need a browser session editing the same file.
- 4 hour soak and the plugin-bridge baseline.
- Exact SQL statement counts under load: Postgres here does not load `pg_stat_statements`.

## Reviews and what they changed

The first Opus reviews (per block) and the Fable review of the whole change set are summarised in the first version
of this report; their fixes are in `541f965bf1`: the lazy objects map entry bug (also on `develop`), one
transaction per call, operation-boundary batches, bool subtrees, natural child order, font variants, DTCG token
types, the read box, whole-page export, `board` as a type name, `execute_code` folding, the sandbox memory cap,
the session expiry regression (caught by the whole backend suite), and saves that left unloaded pointer-map pages
alone.

The architecture review of 2026-11-06 (`backend-mode-review.md`) raised 122 findings: 2 critical, 17 high. All of
them were fixed in the rounds that followed, except the items listed in its section 10. The largest changes:

- Render sessions hidden from every route but RPC and `/assets`; one access token per OAuth client (migration
  `0158`); disabling MCP refuses every token call; backend mode behind a flag.
- Scripts in worker threads; arguments as JSON literals; a fail-closed interrupt; a watchdog; frozen facade
  objects; storage kept per token and capped.
- The write path decodes once and persists once, touches the project last, replays by request id and payload
  digest, bounds batches at 2,000 changes and 50 per call, validates touched shapes only, and loads libraries
  lazily. Two `file_change` indexes (migration `0159`).
- The compiler refuses the moves the editor refuses, reports server faults as `internal`, scans no page for
  default names, and is split into internal namespaces behind one public API. A shared `container.cljc` bug
  found on the way (a `take-while` predicate with the wrong arity) is fixed.
- The adapter authenticates before parsing bodies, never aborts a sent write, sends `requestId` and progress,
  caps answers at 100 kB in compact JSON, exposes `describe_operations`, `/healthz`, `/readyz` and `/metrics`,
  and ships a tarball with its lockfile and no tests.
- The harnesses mark unreliable percentiles, offer open-loop load and warm-up, record provenance, gate on pixels,
  and carry no machine paths; the generated app is untracked.

## Open items for the maintainer

1. Performance gates not measured here (list above). Decide whether to run them elsewhere or waive them.
2. Writes on a very large page (tens of thousands of shapes on one page) still decode and encode the whole page;
   the 3 s write bar does not hold with five agents on such a page. Page splitting or partial re-encoding is the
   next step.
3. `execute_code` loads a whole page into the guest; a page above the 16 MB cap (`PENPOT_MCP_SANDBOX_PAGE_MB`)
   is refused with a message that names it. A lazy facade that fetches shapes on demand would lift the cap.
4. Adapter state (write queue, rate limiter, sandbox `storage`) is per process; run one adapter or route by token.
5. The font table and the token resolver are kept in TypeScript as well as in `common`.
6. The editor's own snapshot path still realises the whole file (about 3.5 s on the 100,000-shape file).
7. Possible old bug, not introduced here: the snapshot of a file migrated in the same call may keep pointer
   references that `file_gc` later drops.
8. Text created by the backend has no `position-data` until a browser opens the file, so auto-sized text boxes
   are estimates (`textSizeApproximate` on reads).
9. `changes.cljc` drops an invalid `mov-objects` in silence; the compiler refuses the cases first, other callers
   do not.
10. The design-parity frontend validation step (open the file with the frontend's `validate-file`) is not built.
11. `mcp/pnpm-lock.yaml` changed (Playwright pinned for the parity harness; `undici` added to the server).
12. The 25 pre-existing clj-kondo warnings in shared backend test files.
