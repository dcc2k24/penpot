# Performance runbook

How to check the release gates of `mcp/backend-write-mcp-plan.md` section 8.9 with this harness, and what the last
run measured. Every command runs from `mcp/`. Use absolute paths for the tokens, vars and results files: the
`loadtest` script runs inside `packages/loadtest`.

## Stack and settings

| Item | Value on the reference stack (Windows host + Docker backend) |
|---|---|
| MCP endpoint | `http://127.0.0.1:4405/mcp` (the adapter in backend mode, on the host) |
| Backend metrics | `http://localhost:6061/metrics` (the backend's own HTTP port; `app.metrics/routes` mounts `/metrics` on the main router) |
| Postgres counters | `--pg-stats docker:penpot-penpot-postgres-1:penpot_mcpdev` |
| MCP server pid | `netstat -ano \| findstr :4405` (the LISTENING line, last column), passed as `--server-pid` |
| Tokens | one MCP token per agent profile, one per line (20 for C1 and C5) |
| Vars | `setup` output (`agentFileIds`, `agentPageIds`, `fileId`, `pageId`, `projectId`); `generate-large` output for the large file |

Common flags, written `$WATCH` below:

```sh
--url http://127.0.0.1:4405/mcp --metrics http://localhost:6061/metrics \
--pg-stats docker:penpot-penpot-postgres-1:penpot_mcpdev --results <abs>/packages/loadtest/results \
--machine-note "<code>, quiet stack, Windows host + docker backend"
```

Which figure answers which budget:

- Statements per request: the backend has no SQL statement counter, and Postgres on this stack does not load
  `pg_stat_statements` (`shared_preload_libraries` is empty), so `db statements` prints "not counted". The
  harness prints `db table scans` per call instead (from `pg_stat_user_tables`: one scan per table a statement
  reads; joins count more than once, inserts count none), plus transactions and rows written per call. For exact
  counts, add `pg_stat_statements` to `shared_preload_libraries` and restart Postgres (needs the user), then run
  `create extension pg_stat_statements` in the database; the harness picks it up with no change.
- Sequential scans on `file_change`: `file_change seq scans` in the summary.
- Backend heap: `backend heap` start, peak, end and max (`jvm_memory_bytes_used{area="heap"}`, sampled every 5 s).
  This is the heap in use at the sample, not the allocation per request.
- GC: `backend gc` count and seconds (`jvm_gc_collection_seconds_*`). The longest single pause is not exported.
- Backend CPU: `cpu ... cores on average` (`process_cpu_seconds_total`).
- MCP server memory: `mcp server rss` with `--server-pid`.
- P1 errors: `penpot_log_events_total` (WARN and ERROR log records) and `penpot_mcp_errors_total` in `metricsDelta`
  of the result file.

## Gates

Status: **pass** or **fail** (a run on this stack gave the figure), **partly** (the MCP half is measured, another
half is not), **not measurable here** (the harness or the stack cannot produce it), **needs the user** (a person
must act: a browser tab, a restart, an archive, a 4 h window).

Measured on 2026-11-05 with the final code (commit 27f3ec8e05 plus the working tree), machine note "final code,
quiet stack, Windows host + docker backend": Windows 11 host, 12 CPUs and 31 GB for Docker (no per-container
limit), backend JVM max heap 7,952 MB, Postgres 15 with `shared_buffers` 128 MB, DB pool 8. The large file is
`generate-large` with the defaults (100,000 shapes, 40 content pages + library, seed 1, pointer-map on, 47.3 MB
stored). The medium file is `generate-large --shapes 5000 --pages 20` (0.9 MB stored). Latencies are measured at
the harness, so they include the adapter.

| # | Gate (8.9) | Fixture and run | Measured | Target | Status |
|---|---|---|---|---|---|
| 1a | Metadata read (warm) | `s5-read-large`, outline step | 35 ms medium, 61 ms large (one call each); 722 ms p95 with 20 readers at once (C5) | p95 120 ms | pass (1 agent); one sample only |
| 1b | Metadata and page read, cold cache | first call after a backend restart | not run: a restart would disturb the shared stack | p95 800 ms / 1 s | needs the user |
| 1c | Page read, medium file | `s5-read-large --vars medium-vars.json` | p95: page tree 30 ms, get_shapes 18 ms, find_shapes 25 ms | p95 400 ms | pass |
| 1d | Page read, large file | `s5-read-large --vars large-vars.json` | p95: page tree 34 ms, get_shapes 22 ms, find_shapes 106 ms (first pass; 21 ms later) | p95 1.2 s | pass |
| 1e | Page read, large file without pointer-map | none | the backend sets pointer-map per flag and team, not per call | p95 6 s | not measurable here |
| 1f | Small write | `c1-different-files --agents 1` | p50 39 ms, p95 53 ms | p95 600 ms | pass |
| 1g | Batch write, 300 objects | `s2-reduced-shapes` (258 nodes per call); `generate-large` (300 nodes per call) | S2 p95 823 ms; generator about 1.5 s per call on pages 34-40 of the 100k file | p95 3 s | pass |
| 1h | Snapshot-triggered write, medium file; snapshot overhead | `s8-snapshot-cost --vars medium-vars.json --iterations 20` | snapshot true p50 314 / p95 339 ms; delete p50 323 / p95 375 ms; added p50 +234 ms (rename) and +250 ms (delete) | p95 2.5 s; overhead p95 < 500 ms | pass |
| 1i | Bulk write, 5,000 shapes with allowSplit | `bulk-allowsplit` | 9.5 s for the whole run (3 calls, p50 3.0 s, max 4.3 s) | 25 s p50 | pass |
| 1j | Token write; token apply to 500 shapes | `s3-tokens` | write 841 ms; apply p50 296 / p95 854 ms | p95 1.5 s; p95 3 s | pass |
| 1k | Export, one board PNG | `s5-read-exports` | not run in this round (the earlier A10 run gave p50 5.1 s with a 48 s outlier) | p95 5 s | not measured this round |
| 1l | `execute_code` | `s7-execute-code-grid` (792 rects, about 800 ops) | 3.6 s | 800 ops < 8 s (S7); 100 ops p95 2 s | pass (S7); 100-op row not run |
| 1m | Backend CPU with 20 agents; heap per request; MCP server RSS | `c1-different-files --agents 20`, `c5-large-readers`, `s9-hostile-code` | CPU 4.5 cores of 12 (37 %) for C1 with 20 agents; heap in use peaks 2.2 GB (C1-20), 1.3 GB (C5), 4.7 GB (S8 large); MCP server RSS 182 MB before S9, 2,132 MB after it, about 2.3-2.4 GB for the rest of the session | CPU < 70 %; RSS < 512 MB + 128 MB per sandbox, hard cap 2 GB | CPU pass; RSS **fail** (defect D1); heap per request not measurable (only heap in use is exported) |
| 1n | Postgres statements; no sequential scan on `file_change` | every run with `--pg-stats` | statements not counted (no `pg_stat_statements`); estimate per call: reads 18-20 table scans and 5.3 transactions; small writes 142-146 scans, 5.1 transactions; batch writes 230-270 scans. `file_change` seq scans: 0 in every run except S8 on the large file (20 in 100 calls) | < 10 per page read, < 25 per write commit; no seq scan | not measurable exactly; the estimates suggest the write budget is exceeded (table scans count index lookups, including foreign key checks, so they overstate statements); seq scan: see observation O2 |
| 2-S1 | S1 50 pages | `s1-create-pages` | 7.1 s, p95 344 ms, 0 errors | < 15 s | pass |
| 2-S2 | S2, zero errors, repeatable | `s2-reduced-shapes`, twice on the same file | both runs 0 errors; batch p95 823 / 817 ms; layouts 625 / 634 ms | bulk budget | pass (fresh page works) |
| 2-S3 | S3 token budgets | `s3-tokens` | as 1j | 8.1 rows | pass |
| 2-S4 | S4 edit step < 10 s, copies match | `s4-components` (200 components, 1,000 copies, no variants) | edit 20 mains + sync 623 ms; 120 boards show the new fill | < 10 s | pass; variants not covered (no MCP operation) |
| 2-S5 | S5 on the large file, 30 min, heap stable | `s5-read-large --vars large-vars.json` | one pass (272 calls, 43 s): p95 79 ms overall, 0 errors | large-file row, 30 min | partly: the 30 min run was not done |
| 2-S6 | S6 import < 30 s, counts equal | `s6-import-archive` | no 2,446-shape archive on this machine | < 30 s | needs the user |
| 2-S7 | S7 < 8 s | `s7-execute-code-grid` | 3.6 s | < 8 s | pass |
| 2-S8 | S8 snapshot cost on the large file | `s8-snapshot-cost --vars large-vars.json --iterations 20` | rename p50 458 ms; snapshot true p50 5,034 / p95 5,181 ms; delete p50 5,133 / p95 5,209 ms: a snapshot adds about 4.6 s; backend heap peak 4.7 GB; plain writes also hit 5 s at p95 | reported; gate set after the first run | reported; proposed gate: snapshot added time on the 100k file < 6 s p95 |
| 2-S9 | Hostile scripts stop cleanly; no RSS growth over 100 repetitions | `s9-hostile-code --iterations 3 --server-pid` | every script refused within its limit (loop 10.0 s, memory 6.1 s, stack 8 ms, 5001 ops 0.7-0.8 s, require/fetch/process/host/await under 30 ms); the plain script after each works; RSS 182 MB to 2,132 MB | stop at 10 s / 128 MB; no RSS growth | **fail** on RSS (defect D1); the limits pass |
| 2-C1 | C1 scales to 20 agents, p95 < 1.2 s, no climit errors | `c1-different-files --agents 1, 5, 10, 20` | p95 53 / 78 / 86 / 243 ms; 0 errors; 2,747 climit queue notices at WARN (enqueued/acquired, no rejection) at 20 agents | p95 < 1.2 s | pass |
| 2-C2 | C2 no lost writes, p95 < 3 s | `c2-same-file --agents 2` and `5` | all 100 rects present for every agent; write p95 648 ms (2 agents), 1,760 ms (5 agents) | p95 < 3 s | pass |
| 2-C3 | C3 human edits persist, human save p95 rise < 500 ms | `c3-agent-with-human` (agent side) | agent side 0 errors, batch p95 998 ms; no browser actor | see target | needs the user |
| 2-C4 | C4 last writer wins, conflict warning, convergence | `c4-same-shape` (MCP side) | revn-lag warning names the shape; failOnConflict refused (29 ms); last value read back | see target | partly: the human tab half needs a browser |
| 2-C5 | C5 heap < 80 % of -Xmx, no GC pause > 1 s | `c5-large-readers` (20 agents) | 1,840 calls, 0 errors, p95 62 ms; heap peak 1,316 MB of 7,952 MB (17 %); GC 10 collections, 0.1 s in all | < 80 %; no pause > 1 s | pass; the human open-time half needs a browser |
| 3 | 4 h soak | `soak-mixed --duration 4h` | not run | see 8.4 | needs the user |
| 4 | At least as fast as the plugin bridge; 3x on S2 and S5 | needs `baseline-plugin-bridge.json` | no baseline on this machine | see 8.5 | needs the user |
| 5 | Human-tab degradation under C3 | C3 with a browser actor | not run | < 500 ms | needs the user |
| 6 | No P1 error in logs | `metricsDelta` of every run, backend log | `penpot_log_events_total` rose only for climit queue notices (WARN) in C1-20 and C5; `penpot_mcp_errors_total` rose once, the conflict C4 asks for; no 5xx, no OOM, no validation failure | none | pass |

## Defects and observations

- **D1 (product, MCP server): MCP server memory is never released after a memory bomb, and it exceeds the 2 GB
  cap.** Before S9 the adapter process (node.exe on port 4405) held 182 MB. One S9 run of 3 iterations (3 memory
  bombs: `const hoard = []; while (true) { hoard.push(new Array(1000000).fill(7)); }`) left it at 2,132 MB. The
  sandbox did stop each bomb with its memory-limit error after about 6 s, and later scripts worked. Three more runs
  of 2 bombs each held it at 2,249-2,383 MB, so it levels off rather than growing per bomb, but it never returns to
  the baseline (2.3 GB at the end of C5, with no script running). Plan 8.1 allows 512 MB + 128 MB per active
  sandbox and a hard cap of 2 GB. A likely cause is that the QuickJS WASM memory grows past the 128 MB guest limit
  and WASM memory never shrinks; it needs a look in `SandboxRuntime`/`SandboxSessions`.
- **O1: a snapshot on the 100k-shape file costs about 4.6 s and 4.7 GB of heap.** S8 on the large file:
  `snapshot: true` and delete writes p50 about 5.0-5.1 s against 458 ms without a snapshot; the heap went from 0.7 GB
  to a 4.7 GB peak and GC took 13.8 s over the run. Plain writes on the same file also reach 5 s at p95. 8.1 asks for
  "never a full realized copy of a pointer-map file"; the snapshot path seems to realise the file. Not a gate
  failure (S8 only reports), but the first gate for it should be set from these figures.
- **O2: 20 sequential scans on `file_change` during S8 on the large file.** Every other run, including S8 on the
  medium file with the same calls, shows 0. The harness cannot tell which statement did it, because
  `pg_stat_statements` is not loaded. 8.1 says no sequential scan on `file_change`.
- **O3: write cost grows with file size.** `generate-large` took 4.3-4.8 s per page (11 calls) on the first pages
  and 15-22 s per page on pages 34-40, with the same 2,497 shapes per page, so a 300-node batch costs about 3.5 times
  more on a 95k-shape file than on a 5k-shape file, although each page is its own pointer.
- **O4: concurrent writers on one file queue.** C2 write p95 grows from 648 ms (2 agents) to 1,760 ms (5 agents),
  as the per-file lock serialises them; inside the 3 s target.
- Fixture fixes made during the run: `s5-read-large` assumed 51 pages and 200 rects on page 0 (true for the old
  perf file only). It now spreads its 50 `find_shapes` calls over the first 20 pages in three passes and reads 200
  shapes of any type from page 0.

## How to read the table

- Sample rule: p50 needs at least 20 calls, and p95 and p99 need at least 200. A figure with fewer samples is printed
  with `(unreliable: n samples, needs m)` and is not a result. Read a p95 from 7 calls as the maximum, not as a tail.
  A comparison marks such a figure `NOT MEASURED`; it neither passes nor fails.
- Closed loop is the default: each agent waits for its last call. Under saturation this hides queueing delay. Runs
  with `--arrival-rate` are open loop, and their latency counts from the intended send time.
- Warm-up: the rows below were measured before `--warmup` and `--arrival-rate` existed. They are closed loop and
  include every call. A run with `--warmup` lists the excluded calls in its summary.
- Provenance: the commit is the tree that was tested. A run on an uncommitted tree is marked, and its figures are not
  reproducible from the commit alone. Compare two figures only when the commit, the backend flags, the DB pool size and
  the machine note match.

## Last run

Every run used `--metrics http://localhost:6061/metrics --pg-stats docker:penpot-penpot-postgres-1:penpot_mcpdev`
and the machine note "final code, quiet stack, Windows host + docker backend". Result files are in `results/` with
the date 2026-11-05. The stack was warmed with one C1 run (1 agent, p95 61 ms) before the first measured run.

`generate-large` (defaults): `page 1/40: 2497 shapes in 11 calls, 4.7 s` ... `page 40/40: 2467 shapes in 11
calls, 17.9 s (file total 100000 shapes, elapsed 7m24s)`; `shapes 100000`, `pointer map true`, `calls 449, duration
7m30s`, `seed 1`, `file size: 49561243 bytes (47.3 MB) of stored file data, from Postgres`.

`generate-large --shapes 5000 --pages 20`: `shapes 5000`, `pointer map true`, `calls 69, duration 0m10s`, `file
size: 913473 bytes (0.9 MB) of stored file data, from Postgres`.

| Run | Summary line (agents, iterations, calls, errors; p50, p95, p99, max) | Backend lines |
|---|---|---|
| S1 | agents 1, iterations 1, calls 50, errors 0; p50 97.9 ms, p95 343.8 ms, p99 363.6 ms, max 363.6 ms | heap 338 / 637 / 552 MB; cpu 8.9 s (1.3 cores); 247.1 scans, 29.0 rows written, 6.3 transactions per call |
| S5 large | agents 1, iterations 1, calls 272, errors 0; p50 15.9 ms, p95 78.8 ms, p99 97.9 ms, max 154.3 ms | heap 3,090 / 3,954 / 3,298 MB; 19.9 scans, 5.4 transactions per call; file_change seq 0 |
| S5 medium | agents 1, iterations 1, calls 272, errors 0; p50 15.8 ms, p95 22.8 ms, p99 31.1 ms, max 35.5 ms | 19.8 scans, 5.3 transactions per call |
| S8 medium | agents 1, iterations 20, calls 100, errors 0; p50 94.9 ms, p95 357.0 ms, p99 381.8 ms, max 408.1 ms | heap peak 1,101 MB; 148.4 scans, 68.8 rows written per call; file_change seq 0 |
| S8 large | agents 1, iterations 20, calls 100, errors 0; p50 521.9 ms, p95 5205.9 ms, p99 5266.1 ms, max 7621.8 ms | heap 710 / 4,734 / 3,086 MB; gc 254, 13.8 s; cpu 456.9 s; 1,321.4 rows written per call; file_change seq 20 |
| S9 (3 iterations) | agents 1, iterations 3, calls 42, errors 0; p50 5.5 ms, p95 10005.3 ms, p99 10009.7 ms, max 10009.7 ms | mcp server rss 182.3 / 2,132.1 / 2,132.1 MB |
| C1 1 agent | agents 1, iterations 1, calls 50, errors 0; p50 38.5 ms, p95 52.8 ms, p99 111.6 ms, max 111.6 ms | 146.1 scans, 9.1 rows written, 5.4 transactions per call |
| C1 5 agents | agents 5, iterations 5, calls 250, errors 0; p50 48.3 ms, p95 77.7 ms, p99 107.3 ms, max 126.6 ms | cpu 2.0 cores |
| C1 10 agents | agents 10, iterations 10, calls 500, errors 0; p50 55.6 ms, p95 86.1 ms, p99 134.4 ms, max 194.0 ms | cpu 3.4 cores |
| C1 20 agents | agents 20, iterations 20, calls 1000, errors 0; p50 176.8 ms, p95 243.0 ms, p99 321.2 ms, max 418.8 ms | heap peak 2,161 MB; cpu 4.5 cores; 142.2 scans per call; rss 2,220 / 2,290 MB |
| C2 2 agents | agents 2, iterations 2, calls 204, errors 0; p50 482.0 ms, p95 648.3 ms, p99 703.0 ms, max 718.4 ms | 243.3 scans, 111.0 rows written per call |
| C2 5 agents | agents 5, iterations 5, calls 510, errors 0; p50 1604.9 ms, p95 1760.1 ms, p99 1810.5 ms, max 1844.3 ms | gc 1,019, 6.2 s; cpu 2.7 cores |
| C5 20 agents | agents 20, iterations 20, calls 1840, errors 0; p50 32.6 ms, p95 61.9 ms, p99 665.8 ms, max 725.4 ms | heap 546 / 1,316 / 679 MB; gc 10, 0.1 s; cpu 2.6 cores; 18.1 scans per call |
| S4 | agents 1, iterations 1, calls 11, errors 0; p50 480.0 ms, p95 1747.4 ms, p99 1747.4 ms, max 1747.4 ms | 196.8 scans, 81.5 rows written per call |
| C4 | agents 1, iterations 1, calls 5, errors 0; p50 103.8 ms, p95 366.1 ms, p99 366.1 ms, max 366.1 ms | 1 mcp error (the expected conflict) |
| bulk-allowsplit | agents 1, iterations 1, calls 3, errors 0; p50 3049.0 ms, p95 4285.2 ms, p99 4285.2 ms, max 4285.2 ms | run 9.5 s; 1,498 scans, 730.7 rows written per call |
| S2 first | agents 1, iterations 1, calls 7, errors 0; p50 698.2 ms, p95 822.7 ms, p99 822.7 ms, max 822.7 ms | 232.7 scans per call |
| S2 second | agents 1, iterations 1, calls 7, errors 0; p50 745.3 ms, p95 817.2 ms, p99 817.2 ms, max 817.2 ms | 232.6 scans per call |
| S3 | agents 1, iterations 1, calls 24, errors 0; p50 301.0 ms, p95 853.9 ms, p99 884.0 ms, max 884.0 ms | 271.3 scans per call |
| S7 | agents 1, iterations 1, calls 1, errors 0; p50 3609.3 ms, p95 3609.3 ms, p99 3609.3 ms, max 3609.3 ms | 32 backend calls for one script |
| C3 agent side | agents 1, iterations 1, calls 7, errors 0; p50 970.7 ms, p95 1569.8 ms, p99 1569.8 ms, max 1569.8 ms | 199.3 scans per call |

Every run printed `db statements: not counted (pg_stat_statements is not loaded)`. A near-idle run (one
`whoami`, 12 s window) counted 23 table scans and 35 transactions, so background work adds little to these
figures. The first S5 runs (before the fixture fix) and the S9 memory-bomb probes are left out of the table.
