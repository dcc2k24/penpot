# Backend-native MCP: production readiness status

Companion to `production-readiness-plan.md`. One row per track; updated at the end of every round. Everything
below is uncommitted work on top of `e4084f80b2` unless a commit is named.

## Round 1 (2026-11-07, overnight)

| Track | State | Notes |
|---|---|---|
| T1 gates | running | Opus agent owns the stack: SQL counts, S6, cold cache, no pointer-map, capacity |
| T1 human tab | running | tab alone: save p95 114 ms, no lost edits; C3 needs a 10 min window (saves are batched); C5 next |
| T2 shared state | built, fixing review items | Redis limiter and storage, two-adapter compose; F1-1 storage reload per call, F1-2 tri-state load in progress |
| T3 adversarial | run once: 282 cases, 242 pass, 13 fail, 27 not testable here | suite and `REPORT.md` under `loadtest/scripts/adversarial/`; scope, render-session, SSRF (56 targets), sandbox escape, replay and rate-limit cases all held; the 13 failures are being fixed (slot starvation by four tokens, Express error pages with stack traces, export wait deadline, an assertion leaking a shape record, small hints) |
| T4 failure injection | scripts built, fixing review items | run in round 2 by the stack owner |
| T5 upgrade and rollback | scripts built | run in round 2 by the stack owner |
| T6 observability | built, adding review items | Prometheus, 6 alerts (more coming), dashboard, request-id correlation, metrics check; CI `mcp` job |
| T7 guide and CI | CI in round 1, guide in round 2 | |
| T8 residuals | not started | stretch |

Go / no-go per track is filled in when its runs are recorded.

### Findings so far (round 1, not yet fixed)

- Backend `mcp-tool` log lines of `mcp-apply-operations` carry `request-id=nil`, which breaks correlation across the
  hop for writes (reads correlate). Owner: write path.
- One sandbox worker test ("100 create, invoke and dispose cycles") lost its worker once under a loaded machine.
  Owner: sandbox.
- Product, pre-existing: the `:get-light` rate bucket (`60/30/30s`) covers `get-file-fragment`, so a workspace load
  of a file with more than about 60 fragments (one per page) answers 429 and the editor never shows the canvas.
  The load-test file reached this after hundreds of runs. Worth a ticket; not changed here.
- `scripts/test_ci.py` fails on Windows because it executes `scripts/ci` directly (pre-existing).
- The backend's `penpot_jobs_dispatcher_ms` metric name fails promtool's unit check (pre-existing).

Round-1 Fable review: `production-readiness-reviews/round1-fable.md` (22 findings, 16 plan additions). The write
log now carries the request id; the flaky worker test is hardened.

### Gate run, round 1 (2026-11-07, stopped by a full disk)

Measured before the disk filled (commit `e4084f80b2`, dirty tree, pointer-map on, pool 8, `pg_stat_statements` on):

- SQL statements per call: page read 10.0 (budget under 10: fails by one; outline 13), small write 23.4
  (budget 25), writes under 20 agents 23.9. Top statement by time under 20 agents: `UPDATE project SET
  modified_at`, 123 s in all (98 % of database time), because the update runs inside the write transaction and
  holds the project row to commit. C1 at 20 agents p95 1,178 ms (243 ms on 11-05; budget 1.2 s).
- Not measured yet: S6 (archive ready), cold cache, no pointer-map, capacity (100 tokens ready), plugin-bridge
  baseline (not measurable without a plugin tab).
- Findings: the backend's write bucket (`120/60/1m`) refused 12,220 of 17,020 calls in a two-minute C1 while the
  adapter allows 10 a second; the profile is read twice per call; next.jdbc runs `SHOW TRANSACTION ISOLATION
  LEVEL` per transaction; every read writes an audit row; every write re-upserts the file migrations; one write
  in five takes an automatic snapshot; the adapter process held 2.5 GB after C1 (no scripts involved); Postgres
  `max_connections` 100 with 60 idle connections held by the production stack's own database.
- Left in place: `shared_preload_libraries = pg_stat_statements` in the dev Postgres; 80 profiles
  `mcpagent20..99@example.com` and about 136 `mcp-perf-gates-*` test files in `penpot_mcpdev`.

The disk: `C:\Users\colli\AppData\Local\Docker\wsl` holds 33.4 GB (the Docker VM image, which grew with the test
databases and the tree copies made inside the toolchain container); the Claude temp folder holds 0.8 GB; a
Visual Studio installer cache in `%TEMP%` holds 4.4 GB; npm and Playwright caches 3.1 GB. Nothing was deleted.

#### Resumed (2026-11-08, 07:35-08:00)

Run record: commit `e4084f80b2`, dirty tree (64 tracked files changed and 33 untracked at 08:00; fix agents were editing
during the run). Backend flags: the dev script set (pointer-map on, `rpc-climit`, `rpc-rlimit`, `quotes`,
`auto-file-snapshot`, `audit-log`, `file-validation`, `backend-asserts`, `mcp-backend`, `mcp-raw-changes`); the
no-pointer-map runs used the same set without `enable-feature-fdata-pointer-map`, and the backend went back to the full
set at 07:57. DB pool 8, `pg_stat_statements` on, adapter on `127.0.0.1:4405` (pid 25420). The toolchain container ran
three backend test namespaces at the same time, and Postgres twice answered `too many clients` (`max_connections` 100),
which cost the Postgres counters of the first S6 run. C: had 12 GB free throughout. Logs and pool samples are in
`mcp/packages/loadtest/results/2026-11-08-round1-resumed/`; result files are in `results/` with the date 2026-11-08.

| Gate | Measured | Budget | Result |
|---|---|---|---|
| S6 import through the MCP | `import_archive` fails on every archive: the adapter sends `version` as the multipart string `"3"` and the backend schema wants a number (`[:enum 1 3]`); 400 `params-validation` in 346 ms | < 30 s, counts equal | fail (R1-G1) |
| S6 import, backend half | `import-binfile` without `version`, a 5,000-shape, 21-page archive (4.0 MB, export of the medium file): 6.2 s; the new file holds 5,000 shapes in 21 pages (`get_file_outline`) | < 30 s, counts equal | pass; the plan's 2,446-shape archive is not on this machine, so this one is twice its size |
| Cold cache, metadata read | first `get_file_outline` after `restart-backend-dev`, four restarts: 845 and 901 ms (medium file first), 1,425 and 1,568 ms (100k file first) | p95 800 ms | fail (R1-G2) |
| Cold cache, page read | first `get_page_tree` 98-185 ms, first `get_shapes` 31-59 ms, same four restarts | p95 1 s | pass |
| Page read, 100k file without pointer-map | `s5-read-large` on an import of the 100k file into a team without pointer-map (272 calls): p50 351, p95 505, max 913 ms. Same file with pointer-map, same hour: p50 17, p95 82 ms | p95 6 s | pass |
| C1, 50 agents | p50 194, p95 507, max 3,211 ms; 1,070 of 2,500 calls refused with 429 (`mcp-apply/by-team`, queue full) | p95 1.2 s, no climit errors | fail (R1-G3) |
| C1, 100 agents | p50 512, p95 583, max 883 ms; 706 of 5,000 calls refused, same limiter | p95 1.2 s, no climit errors | fail (R1-G3) |
| C2, 10 agents, fresh file | p50 155, p95 198, max 234 ms; 0 errors; every agent's 100 rectangles present | p95 3 s, no lost writes | pass |

Statements per call (`pg_stat_statements`): page reads 7.5 with pointer-map and 9.7 without (budget under 10); C1 writes
14.3 at 50 agents and 19.8 at 100 (budget 25; the refused calls lower these averages); C2 writes 22.4.

Pool (8 connections), sampled every second: C1 at 50 agents reached 7 active, up to 30 pending (above 0 in 3 % of the
samples), acquire p95 up to 759 ms, no timeouts; C1 at 100 reached 8 active (2 % of the samples) and 5 pending; C2 at 10
had none pending. The pool is not the limit. Backend CPU averaged 6.8 cores of 12 (57 %) at C1-50 and 4.7 at C1-100.
Adapter RSS went from 106 MB at the start to 421 MB after C1-100.

Findings of the resumed run:

- R1-G1 (product, adapter): `import_archive` in backend mode cannot import anything. `ImportArchiveBackendTool` sends
  `version: "3"` as a multipart field; multipart values are strings, and the backend does not coerce them for
  `[:enum 1 3]`. The backend reads the version from the archive when the field is absent, so dropping the field should
  be enough. A direct `import-binfile` with `version=3` fails the same way. The unit tests mock the backend, so they did
  not catch it.
- R1-G2: the first outline after a restart costs 0.85-1.6 s. Most of it is process warm-up: a medium-file outline right
  after a 100k-file outline took 140 ms. Postgres was not restarted, so its cache stayed warm; a full cold start would be
  slower.
- R1-G3: the new `mcp-apply/by-team` limit (4 permits, queue 20) refuses C1 at 50 and 100 agents, because every test
  file sits in one team: at most 24 writes per team run or wait. Either the gate's agents belong in several teams, or
  the queue must hold the expected agents per team. Decide before round 2.
- R1-G4: without pointer-map each read decodes the whole 7.7 MB file blob: 20 times slower and 335 collections in 272
  calls, yet inside budget.
- Exporting the 100k file (`export-files!`, 81 MB archive) took 68 s; importing it took 34 s, over the S6 budget for a
  file 40 times larger than the plan's archive.
- Harness: the cold scenarios have no per-step rate cap, so one warm call met the adapter's 10 calls per second
  (`RateLimitError`); it is not a backend error.

Left in place: team `mcp-perf-no-pointer-map` (`e23a8316-5bc8-81ae-8008-e9cd1eb99cf0`, owner `mcpagent60`) and its
imported 100k file; one S6 direct import and one fresh C2 file in the Default project; the archives
`.mcp-dev-assets/gates/large-100k.penpot` (81 MB) and `medium-5000.penpot` (4 MB), excluded from git.

## Round 2 (2026-11-08)

Per-track results: the go/no-go table at the end of this file ("Go/no-go after round 2").

### Run record

- Commit `e4084f80b2` with a dirty tree (98 entries at 08:25). Backend dev flags as round 1. DB pool 8. `pg_stat_statements` on.
- Stack: Redis container `penpot-r2-redis`; two host adapters on 4406 and 4407 with Redis; nginx container `penpot-r2-nginx` on 127.0.0.1:4415.
- Time window: stack 08:26, runs 08:41 to 09:46, soak from 09:49:15 UTC.

### Findings

- **R2-01.** Human edits lost when saves are slow. Pre-existing frontend defect (2023), not MCP code, and MCP load triggers it. It needs three things at once: a local edit in the 3 s save buffer, an earlier edit still in the save queue, and a change from another session. The tab then undoes and redoes only its queued edits. The buffered edit's geometry leaves the tab's state, but the server still gets it. The next nudge starts from the stale geometry and re-sends the old coordinate, so positions move backwards and a press is lost. Any other session triggers it, including a second person; the agent's profile plays no part. No MCP commit on this branch touches that code (`frontend/src/app/main/data/changes.cljs:74-78`, `122-148`, `228-232`; `persistence.cljs:863-877`, `937-945`). Reproducible without MCP: two tabs, 5 s HTTP throttling on one, one change from the other while a save is queued (recipe in the investigation). C3 run 1 (save p95 5 s) lost 39 of 120 presses; the control run (save p95 0.6 s) lost none. Status: fixed in `frontend/src/app/main/data/persistence.cljs` and `changes.cljs`. The persistence state now keeps the buffered local commits in `:buffer`; `get-pending-commits` returns the queued commits, then the buffered ones, so a remote change undoes and redoes both; a flush moves them from `:buffer` to `:queue` in one update; a merged commit's undo changes run in reverse commit order. Unit tests cover the order and the flush. Re-run on 2026-11-08 (evening) against a frontend built from this tree (`mcp/packages/loadtest/results/2026-11-08-round2/human/after-fix/`): C3 with five agents on the same file, 120 presses, 120 saves, 0 lost presses (160/160), and the decoded change rows of the tab never move backwards. Saves were fast in that run (p95 0.76 s), so a second pair of runs held every save response of the tab for 5 s (`--save-delay-ms 5000`): the fixed build still sends no backward coordinate, while the stock 2.18 frontend under the same load sends ten (the round 2 pattern). Both builds stall under 5 s saves (R2-15). Owner: frontend.
- **R2-02.** `nodejs_eventloop_lag_seconds` is a gauge with a quantile label, so promtool fails. The alert and dashboard use quantile 0.95, which is never exported, so the alert cannot fire. Owner: adapter.
- **R2-03.** The backend `/metrics` sends no Content-Type. Prometheus 3.5 refuses it, so `PenpotMcpBackendDown` would fire falsely. Owner: deploy config.
- **R2-04.** For backend tools, revocation reached both adapters in 0.4 s. The guide says up to 60 s. Owner (proposed): docs.
- **R2-05.** The exporter is the shared bottleneck: 0.51 exports/s, p95 28.2 s, 3 timeouts with 10 exporters. Each adapter sends 4 renders, so N adapters send 4N. Owner (proposed): adapter.
- **R2-06.** The startup log says "Max parallel exports: 0 (0 = unbounded)" in backend mode, where the backend gate is 4. Owner (proposed): adapter.
- **R2-07.** During a Redis outage a warm runtime returns its own storage copy, which may be stale. The notice does not say so. Owner (proposed): adapter.
- **R2-08.** A queue of 50 is enough at 50 agents in one team (no refusals, waiting peak 42). Limit: about 54 concurrent writers per team. Five teams did not lower p95. Owner (proposed): backend.
- **R2-09.** The bulk-allowsplit fixture expects 6 commits per call; the split now commits 1. The writes committed. Owner (proposed): fixture.
- **R2-10.** `host.docker.internal` gave nginx an unreachable IPv6 upstream in Docker Desktop. Use an IPv4 address or a resolver. Owner: ops.
- **R2-11.** The 16 GB dev DB needed dump exclusions. Migration 0159 took about 0.8 s; blocking was not observed. Checklist step 4 (get-file with an MCP token) is 403 by design. Owner (proposed): docs.
- **R2-12.** Zero-valued counters are absent until their first increment, so `rate()` misses the first events after a restart. Owner: backend (the three counters are backend series).
- **R2-14.** Four nginx 502s in the soak (142,276 calls): upstream keep-alive reuse of a connection the adapter had closed; `deploy/nginx.conf` needs an upstream `keepalive_timeout` below the adapter's keep-alive time, or the adapter a longer one. Owner: deploy config.
- **R2-13.** Save latency. C5's p95 of 19 s comes from the automatic snapshot, not from the 16 readers: the backend writes a snapshot on every fifth revision (`enable-auto-file-snapshot`). On the 100k-shape file, 11 of 59 saves took 6.8 to 19.8 s; the others took about 200 ms. This is pre-existing. C3's raw save p95 rose by 4.9 s under five agents writing the same small file (run 1; the control run rose by 0.54 s and is inconclusive). Gate 500 ms: C3 FAIL. C5's one lost press was the harness reading back before the last save finished; the harness now waits for the save responses. Owner (proposed): backend (snapshot cost) and frontend (save path).
- **R2-15.** (after-fix runs) With every save response of the tab held 5 s and five agents writing the same file, the tab stalls: its saves thin out from one per 5 s to one per 60-80 s, the backend drops websocket frames for it (5,383 received against 7,098 with fast saves), and presses in a second direction stop producing changes, because a keyboard nudge gesture stays open and a nudge in another direction is dropped while it is (`frontend/src/app/main/data/workspace/transforms.cljs`, `nudge-selected-shapes`). 48 of 120 presses reached the server on the fixed build, 51 on the stock 2.18 frontend: pre-existing, not caused by the fix. Profiled on 2026-11-09. The candidate cause, the rebase (`apply-changes-localy`), was wrong: it took about 1 % of main-thread time. The real cause has two parts. First, a remote commit with N pending local commits sent 2N+1 `:index/update` requests to the web worker (N for the undo changes, one for the remote change, N for the redo changes): 34,272 for 5,222 remote frames, and 36,049 requests were still waiting at the end of the run. Second, every worker reply was tested against every waiting request (`frontend/src/app/util/worker.cljs`). Reply matching took 9-14 % of main-thread time at +75 s and 66 % at +380 s, and timer lag reached 21 s. Status: fixed in `frontend/src/app/main/data/changes.cljs` and `frontend/src/app/util/worker.cljs`. The first fix sends one `:index/update` per commit. The second keeps each waiting request in a `js/Map` keyed by sender id, so a reply finds its request by lookup. The change adds 11 unit tests (5 in `changes_test.cljs`, 6 in `util_worker_test.cljs`); the full frontend suite passes with 1,716 tests, 6,880 assertions, 0 failures, 0 errors. Re-run on 2026-11-10, on a busier machine that sent 19-41 % of the agent calls of run `before2`: index requests 1.0 a frame; reply matching 0.4-4 % of main-thread time; most requests waiting 23, 1,069 and 150; saves in 8 min 83, 63 and 71 against 36 and 28; the tab received 99 % of the agents' changes against 64-72 %. Still open: the re-run load was lower, so a re-run on an idle machine is still to do; one of the three runs slowed for about three minutes on snap queries and rendering; rendering of remote changes is now the largest cost (33-56 % of main-thread time). Details: `production-readiness-reviews/round2-investigation.md`, 'Stall under slow saves'. Owner: frontend.

Full record: `mcp/packages/loadtest/results/2026-11-08-round2/run-notes.md` (the stack owner's notes) and the result files beside it.

Soak: see "Round 2 soak" below (pass on memory, connections and adapter errors; 4 nginx 502s, R2-14).

### Fixes after round 2

Changed after the runs. The runs were not repeated for these changes.

- R2-02: event-loop lag exported as gauges; the adapter alert and dashboard use p99.
- R2-03: the backend `/metrics` sends a Content-Type; `deploy/prometheus.yml` sets a Prometheus fallback protocol.
- R2-04: guide text on revocation. For backend tools the run saw 0.4 s.
- R2-05: export permits are shared in Redis (`PENPOT_MCP_EXPORT_TOTAL_PERMITS`, default 4, lease 65 s). If Redis fails, each adapter process falls back to its own permits.
- R2-06: the startup log line in backend mode.
- R2-07: the stale-storage notice says the value may be stale.
- R2-09: the bulk-allowsplit fixture.
- R2-10: nginx note: use an IPv4 upstream, not `host.docker.internal`.
- R2-11: guide text. Checklist step 4 uses `get-mcp-file-outline`, not `get-file`.
- R2-12: the three MCP counters start at zero.
- R2-14: adapter keep-alive 65 s (`PENPOT_MCP_KEEPALIVE_S`); nginx `keepalive_timeout` 60 s.
- R2-01: frontend fix for lost human edits (see Findings). Re-run under the C3 load on a frontend built from this tree: 0 lost presses of 120.

Not fixed in this round: R2-08 (queue limit), R2-13 (snapshot cost; the operations guide now states it).

### Fixes after the C3 re-run (2026-11-09)

- R2-08: the refusal names its limit and reason in the 429 body (`type` `concurrency-limit`, `code`
  `capacity-limit-reached`, `limit`, `reason`, and a `hint`), so an agent sees `concurrency limit mcp-apply/by-team
  reached (queue-full), retry later` instead of `HTTP 429: no details were returned`. The frontend retries a save
  refused this way. The operations guide states the sizing rule: permits plus queue writers per team, 54 with the
  shipped file. The queue size itself is unchanged.
- R2-15, in part: a keyboard nudge in a second direction while a nudge gesture is open joins the gesture instead of
  being dropped (`transforms.cljs`, `nudge-selected-shapes`; unit tests cover two directions and mixed step sizes).
  The stall is profiled and fixed on 2026-11-10 (see R2-15 in Findings).
- F2-19: the MCP write test checks that no after-commit callback failed.
- Live check of R2-08 on the restarted dev backend: twelve writes at once from one token to twelve files, through
  the adapter. Six committed (one running, five queued) and six answered `Backend error capacity-limit-reached:
  concurrency limit mcp-apply/by-profile reached (queue-full), retry later`.
  `penpot_rpc_climit_rejected_total{name="mcp-apply/by-profile",reason="queue-full"}` counted 6.
- Not re-run: the load scenarios. These changes alter no limit and no save path timing.

#### F2-20: full C8 run against the shared export cap (2026-11-09)

The full C8 scenario, 3 minutes, on the round-2 stack rebuilt for the run: Redis, two host adapters (4406 and 4407)
with `PENPOT_MCP_EXPORT_TOTAL_PERMITS=4`, nginx in front, and Prometheus with `deploy/alerts.yml` unchanged.
10 exporters with one token each and 3 readers, at commit c07e1083e4. Record:
`mcp/packages/loadtest/results/2026-11-09-f2-20-c8-shared-cap/` (`run-notes.md`, `permit-report.txt`).

- Exports: 141 calls, 133 rendered, 8 refused as busy (5.7 %). No exporter timeout and no 60 s render timeout.
  0.71 exports a second, against 0.51 in round 2 without the shared cap.
- Call time, wait and render together (nearest-rank; under 200 samples, so p95 is a rough figure):

  | Adapter | Calls | Busy | p50 | p95 | max |
  |---|---|---|---|---|---|
  | 4406 | 71 | 2 | 10.7 s | 31.1 s | 34.7 s |
  | 4407 | 70 | 6 | 11.9 s | 30.1 s | 33.5 s |
  | both | 141 | 8 | 11.5 s | 30.1 s | 34.7 s |

- Render time, measured as the time each permit was held (Redis MONITOR log): 133 permits taken, 133 given back;
  p50 5.5 s, p95 6.9 s, max 7.5 s.
- The 30 s wait: 8 calls ended with "export is busy, retry later", seven after 30 s and one after 24.7 s (what was
  left of its 30 s after the process gate). 6 more calls took 30 to 35 s: a wait of 23 s or more, then the render.
  With 5.5 s renders on four slots, callers served in arrival order would wait about 8 s. The shared permit has no
  queue: each waiter asks Redis again every 20 to 250 ms (2,579 refused requests in the run) and the first to ask
  after a release gets the permit. That is the likely cause of the long waits; this run did not isolate it.
- Permit count, sampled every 250 ms (852 samples): 4 in 702 samples, 3 in 14, 2 in 1, 1 in 6, and 0 in 129 (before
  the first take and after the last release). Never above 4. Four permits were held for 183 of the 188 s between the
  first take and the last release. The set was empty at the last release and stayed empty.
- Lease: holds. The longest hold was 7.5 s, 12 % of the 65 s lease. No permit expired while held, so no render
  exceeded the lease. The longest call took 34.7 s of the 60 s call limit, so no call reached the deadline that the
  lease is sized for. No change.
- Alerts: the 15 rules loaded; none was pending or firing during the run.
  - `PenpotMcpExportPermitFallback` would not fire. The fallback counter stayed at 0 on both adapters, and Redis
    answered all 2,712 permit requests.
  - Export latency: `alerts.yml` has no export latency rule. Its one latency rule covers the write tools, and the
    adapter's duration histogram has no tool label, so there is no threshold to tune. A full export cap raises no
    alert: four permits were held for 97 % of the run and 5.7 % of the calls were refused.
  - Other rules, peak against threshold: event-loop lag p99 53 ms against 200 ms; adapter resident memory 647 MiB
    against 1.5 GiB; pool pending 0; concurrency-limit rejections 0. No change to the thresholds.
  - Adapter memory rose from 141 and 189 MiB at the start of the run to 566 and 647 MiB at its end. Three minutes
    do not show whether it levels off.
- Readers: 11,438 calls, of which the per-token rate limit (10 a second) refused 6,051. The fixture's readers run
  with no pacing, and reads were faster than in round 2. The 5,387 reads that ran: page tree p95 135 ms, find p95
  56 ms (round 2: 297 and 128 ms).
- Verdict: the 65 s lease and the alert thresholds stand, and nothing was changed. Two gaps are left for later: no
  alert on a full export cap, and no arrival order among callers that wait for the shared permit.

#### After F2-20: arrival order and a busy counter (2026-11-10)

- The shared export permit now serves waiting callers in arrival order. A refused caller joins a queue in Redis,
  beside the permit set. A caller that has not asked for 3 s loses its place, so a crashed adapter cannot block the
  queue. Arrival order holds once every adapter is upgraded.
- The likely cause of the long waits in the F2-20 run: a caller fresh from the process gate asked Redis right after
  a release, and so beat callers that had waited longer.
- `penpot_mcp_export_busy_total{gate}` counts exports refused as busy, by the gate that refused them (`token`,
  `process` or `shared`). The alert `PenpotMcpExportCapFull` fires on the `process` and `shared` gates.
- The permit report script reads the three-key take, so the waiter keys do not count as takes or releases.
- Re-measure (2026-11-10, the same C8 run on the new code; record in
  `mcp/packages/loadtest/results/2026-11-10-fair-permits-c8/`): 100 exports, none refused as busy, against 8 of 141
  on 2026-11-09. Call time p50 17.8 s, p95 24.3 s, max 28.6 s; no call took 30 s or more, against 14. Renders were
  slower on this day (permit held p50 7.7 s against 5.5 s; another test run shared the machine), which is why
  fewer exports ran; the four permits were held for 182 of 197 s. The wait for the shared permit, from the first
  ask to the take, was p50 7.6 s and at most 9.5 s: about one render. No waiter key was left in Redis.
- The counter, live: an overload run (24 exporters, 75 s) ended 6 of 76 calls as busy, and
  `penpot_mcp_export_busy_total{gate="shared"}` read 4 on one adapter and 2 on the other.
- Not checked: an older adapter and a new one on the same Redis, and the alert firing in Prometheus (the rule
  passes `promtool check rules`; 16 rules).

### Checks after the fixes (2026-11-08, evening)

- Backend restarted with the metrics fixes. `/metrics` answers `Content-Type: text/plain; version=0.0.4; charset=utf-8`.
  The four `penpot_mcp_refusals_total` series and the other MCP counters exist at 0 from startup. Prometheus (the
  `r2mon` stack) shows all 7 targets up, the 4 zero-valued refusal series and 2 `nodejs_eventloop_lag_p99_seconds` series.
- Shared state across the two adapters (4406, 4407) on the new build:
  - Storage alternation: values 1 to 50 in order across both adapters. Pass.
  - Rate limit shared: burst admitted 20 of 40 (refused 20; limit 24). Sustained admitted 52 (limit 75). Pass.
  - Result: `mcp/packages/loadtest/results/2026-11-08-round2/t2/shared-state-after-fixes.json`.
- Export capacity through nginx 4415, with the shared Redis permits: 90 s, 10 exporters (one token each), 2 readers.
  - 43 export calls, 10 errors. Every error reads "export is busy, retry later: no slot was free for N seconds", the fixed
    30 s permit wait (`ExportConcurrency.PERMIT_WAIT_MS`). p50 22.9 s, max 30.3 s. No exporter-side timeouts.
  - The Redis permit set, sampled about every 2 s: 45 samples at 4, 1 at 3, 8 at 0, never above 4. The cap of 4 across
    both adapters holds.
  - Readers: 658 calls, 0 errors, p95 599 ms.
  - The exporter stays the bottleneck. The cap turns exporter timeouts into an explicit busy error.
  - Results: `mcp/packages/loadtest/results/2026-11-08-round2/export/after-fixes/`.
- The Fable round-2 review (`production-readiness-reviews/round2-fable.md`): 1 blocker, 2 major, 9 minor, 8 notes.
  The code findings F2-01 to F2-08, F2-13, F2-15, F2-16 and F2-18 are fixed in this tree. The doc findings F2-09 to
  F2-12, F2-14 and F2-17 are fixed in the docs.

### Left in place

The stack will be torn down at the end of the session. This list is the record of what existed.

- Database `penpot_upgrade_test` (469 MB; the throwaway copies `penpot_upgrade_old_tests` and `penpot_backup_restore` and both dump files were removed to free disk).
- Containers `penpot-r2-redis` and `penpot-r2-nginx`; compose project `r2mon` with its volumes.
- Teams `mcp-r2-c1-team-0` to `-4` and the round 2 files (listed in run-notes.md).
- The old adapter build `C:/dev/r2-old-adapter` and the worktree `/tmp/old` inside `penpot-tc`.

### Round 2 soak (2026-11-08, 09:49-13:49 UTC)

`soak-mixed`, 5 agents, five fresh files, through nginx and both adapters with Redis; samples every minute
(`results/2026-11-08-round2/soak/samples.jsonl`, summary `samples-summary.txt`).

- 142,276 calls, 4 errors; p50 41 ms, p95 138 ms, p99 230 ms; the 9.3 s maximum is a board export (export p95 7.6 s).
- The 4 errors are nginx 502s ("upstream prematurely closed connection") within 40 ms of the request. nginx reused an
  idle upstream connection that the adapter had just closed, and nginx does not retry a POST. The adapter closed idle
  connections after Node's default 5 s, while nginx kept them longer (R2-14). Fixed after the soak: the adapter keeps
  idle connections 65 s (`PENPOT_MCP_KEEPALIVE_S`) and nginx `keepalive_timeout` is 60 s. Not re-run.
- Flat for four hours: backend heap (mean 934 MB in the first 30 minutes, 831 MB in the last), threads, pool (pending 0),
  adapter RSS (4406 509 to 512 MB, 4407 362 to 366 MB), sandboxes (0), validator and render-session caches, Postgres
  connections (69 to 75).
- Growing by design: `file_change` rows 45,200 to 107,682 (15,600 an hour, 37 MB an hour) and the database by 1.0 GB.
  The objects GC clears these rows; the soak ended before a scheduled run (see below).
- Alerts: none pending or firing during the soak.
- Verdict: pass on memory, connections and errors at the adapters. The 502s are fixed in config and not re-run.
  `file_change` growth is by design and bounded by the nightly GC; a manual GC run was checked (below).

### file_change cleanup (checked after the soak)

- The objects GC runs daily at 00:00 (server time). It deletes change rows one hour after the write, and automatic
  snapshots at the team's deletion delay (7 days on this database).
- It does not catch up a missed run. A backend that is down at midnight keeps about a day more of rows: about 375,000
  more at the soak rate.
- A manual run on the soak database deleted 86,305 expired rows in 28.8 s, about 3,000 rows a second. That is well
  above the write rate (about 15,600 rows an hour).
- Steady state with the run on time: up to 25 hours of change rows, about 390,000 at the soak rate.
- Automatic snapshots are the larger growth under heavy agent writes: about 1,420 an hour in the soak, each with a
  `file_data` payload, kept 7 days. Size for them when the flag is on. `enable-auto-file-snapshot` is not in the
  default flag set (`common/src/app/common/flags.cljc`).

### file_change sequential scans (checked after the soak)

- The 138 sequential scans came from the soak sampler's own `select count(*) from file_change`, run once a minute.
  That is harness load, not product code. The sampler now reads `n_live_tup` from `pg_stat_user_tables`.
- Every product statement on `file_change` uses an index, so no new index is needed. The four that matter:
  the MCP replay check (`file_change__file_id__session_id__idx`, migration 0159); `get-lagged-changes`
  (`file_change__file_id__revn__idx`); the MCP snapshot pruning query (`file_change__file_id__created_at__labelled__idx`,
  migration 0159); and the objects GC scan (`file_change__deleted_at__idx`).
- The costliest product statement on the table is the MCP snapshot pruning query: 51 s of database time over the soak,
  1,837 buffers per call. It reads automatic snapshots it then rejects. An optional partial index,
  `(file_id, created_at) WHERE created_by = 'system' AND label LIKE 'mcp/%'`, would skip them. Optional; not needed for
  the plan 8.1 check.

## Go/no-go after round 2

| Track | Verdict | Basis |
|---|---|---|
| T1 gates | Go for S6, C1 and C2. Export capacity (C8): go with the shared cap and the busy error documented. | S6 pass through nginx; C1 at 50 agents pass (one team and five teams); C2 pass. C8 is bounded by the exporter; the cap of 4 holds (checks above). |
| T1 human tab | Go on lost edits. The save-latency gate stays failed (R2-13) and the stall under 5 s saves is fixed, with a re-run at full load still to do (R2-15). | C3 re-run on a frontend built from this tree: 0 lost presses of 120 with five agents; control 0 lost. Round 2's loss is reproduced on the stock 2.18 frontend with 5 s saves and absent on the fixed build. R2-15 re-run on 2026-11-10: 63 to 83 saves in 8 min against 28 to 36, at a lower agent load. |
| T2 shared state | Go | shared-state.mjs 5 of 5; cross-adapter writes 200 of 200 and 40 of 40; revocation 0.4 s; storage and rate limit checks pass after the fixes. |
| T4 failure injection | Go. The postgres-restart case is weak. | Nine cases pass after reruns. |
| T5 upgrade and rollback | Go with the gaps below. | Migrations 0158 and 0159 ran on a copy; old-backend tests 143 tests, 0 failures. Not run: new adapter against old backend; old backend on the backup. |
| T6 observability | Go after the Content-Type and lag fixes. | Checked after the fixes (above). |

Still open:

- R2-08: the queue limit stands (about 54 writers per team), the refusal now names the limit, and the guide gives the sizing rule.
- R2-13: snapshot cost on 100k-shape files. Pre-existing.
- R2-15: the cause is removed and the stall reduced in three runs at a lower load; still to do: a re-run on an idle machine at the frame rate of 2026-11-09; open costs: rendering of remote changes (33-56 % of the main thread) and bursts of snap queries while a nudge gesture is open.
- F2-20 is closed: the full 3 min C8 run measured the lease and the alert thresholds (see "F2-20" above). Both gaps are closed in code (see "After F2-20").

Recommended next:

- Re-run `run-c3.mjs --save-delay-ms 5000` on an idle machine to confirm R2-15 at full agent load, and check the decoded rows for the presses missing at readback.
- Find where the snap queries come from while a nudge gesture is open and remote frames arrive (R2-15, run `after2`), and carry the `:dropped` flag in the worker message codec.
- Decide the snapshot policy for large files (R2-13: a lower `auto-file-snapshot-every` for agent writes, or a snapshot taken off the save path, is a product decision).
