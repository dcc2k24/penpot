# Round-1 review: backend-native MCP production readiness

Reviewer: Fable (round-1 reviewer). Date: 2026-11-07. Tree: `perf/render-wasm-large-files` at `e4084f80b2` plus the
uncommitted round-1 work. Read-only review; no repo file was edited, nothing was run against the live stack.

Mechanical checks run (outputs in this folder):

- `tsc --noEmit` server and loadtest: clean (`tsc-server.txt`, `tsc-loadtest.txt`).
- Server unit suite: 1140 tests, 1129 pass, 0 fail, 11 skipped (7 need `PENPOT_MCP_TEST_REDIS_URI`) (`server-tests.txt`).
- `node --check` on every new `.mjs`, `bash -n` on every new `.sh`: all pass (`syntax.txt`).
- `docker compose config` on both compose files: valid (`compose-two.txt`, `compose-mon.txt`).
- `promtool check rules alerts.yml`: 6 rules, SUCCESS (`promtool-rules.txt`).

## Verdict

Round 1 built the right things and the code quality is good, but the shared-state track (T2) is not yet correct for
the deployment it exists for: with round-robin routing the sandbox `storage` loses updates between adapters, and a
Redis blip on load wipes a token's storage on the next save. The human-tab harness cannot produce a C3 verdict as
written (the edit cadence collides with the frontend's 3 s save debounce; the baseline window holds one save). The
chaos `redis-stopped` case tests the backend's valkey, not the adapter fallback, because the live adapter has no Redis.
Observability is close but the monitoring compose cannot reach the two-adapter stack as shipped, and the adapter
exports no process metrics, so the soak's "adapter RSS flat" claim cannot be read from Prometheus. Everything else is
medium or low. Fix F1-1, F1-2, F1-3, F1-4, F1-5 before round 2 runs; the rest can land with round 2.

## Findings

Severity: critical / high / medium / low. Confidence: high / medium / low. Effort: S (< 1 h), M (half a day), L (a day+).

### T2 shared state

**F1-1 — high, confidence high.** `mcp/packages/server/src/sandbox/SandboxSessions.ts:111-121` (`acquire`) and
`:299-325` (`createEntry`). Storage is loaded from the store only when a runtime is created. A live runtime is reused
without a reload. Behind round-robin nginx, calls of one token alternate between adapters A and B, each holding its own
live runtime for the token. Call 1 on A writes `storage.x = 1` (saved to Redis). Call 2 on B creates a runtime, loads
`x = 1`, writes `x = 2`, saves. Call 3 lands on A again: A's live runtime still holds `x = 1`, and its post-call save
overwrites Redis with `x = 1`. Last-writer-wins lost updates on every alternation. The deploy README's
"no sticky routing needed" (`mcp/deploy/README.md`, `nginx.conf:23`) and the `mcp/README.md` paragraph (line 414) rest
on this. The T2 test "storage set through one adapter is read through the other" passes only because the second
adapter has no live runtime yet. Fix (pick one): (a) reload storage at the start of every call when the store is
shared (`acquireTurn` → `store.load` → `runtime.restoreStorage`; the worker already takes `storage` per invoke, so the
cost is one Redis GET per call), or (b) hash-route by token in nginx (`hash $http_authorization consistent;`) and
document that the write queue and sandbox are then per adapter. (a) keeps the no-sticky claim true; (b) is a
one-line change but makes the balancer a correctness component. Effort: (a) M with a two-adapter alternation test,
(b) S.

**F1-2 — high, confidence high.** `mcp/packages/server/src/sandbox/StorageStore.ts:244-255` (`RedisStorageStore.load`
returns `undefined` on a Redis error) and `SandboxSessions.ts:311-318`. A failed load is indistinguishable from "no
storage". The new runtime starts empty, and the next `release()` saves that empty storage over the shared copy once
Redis answers again. A short Redis outage therefore deletes a token's storage. Fix: make `load` return a tri-state
(`{text} | {absent} | {failed}`); on `failed`, either refuse the acquisition with a retryable error ("sandbox storage
unavailable") or mark the runtime `storageUnverified` and skip saves until a later successful load proves the copy
is not newer. Add a unit test with a store that fails once. Effort: S/M.

**F1-3 — medium, confidence high.** `mcp/packages/server/src/PenpotMcpServer.ts:871-879` and
`RedisRateLimiter.ts:93-96`. `penpot_mcp_redis_up` is `!failing`, and `failing` is set only after a failed call. The
gauge reads 1 at startup with a dead Redis; `PenpotMcpServer.http.test.ts:265-278` asserts exactly this against
`redis://127.0.0.1:1`. An operator alert on this gauge would miss an outage until the first call. Fix: derive the gauge
from `client.status === "ready"` (ioredis), and keep `failing` for the fallback counter. Update the test expectation.
Effort: S.

**F1-4 — low, confidence high.** `PenpotMcpServer.ts:999-1000` and `SandboxSessions.ts:368-379`. `stop()` calls
`sandboxes.dispose()` (fire-and-forget saves) then `backendServices.close()`; `RedisStorageStore.close()` enqueues
`QUIT` before the saves reach `client.set` (they are behind `await this.ready`), so the dispose-time saves are refused
with "Connection is closed". Impact is small because every call already saves on release, but a call in flight at
shutdown loses its storage. Fix: `await sandboxes.flushStorage()` between dispose and close. Effort: S.

**F1-5 — low, confidence high.** `RedisRateLimiter.ts:107-114`. The token bucket itself is correct: one Lua script,
Redis server clock (`TIME`), refill `min(burst, tokens + elapsed*rate)`, wait `ceil((1-tokens)/rate)` with a 1 s
floor, key TTL `burst/rate + 1 s` (an expired key equals a full bucket), burst honoured on first use. Three small
points: (1) `client.eval` sends the full script text on every call; use `defineCommand` (EVALSHA with fallback).
(2) `TIME` followed by writes needs Redis ≥ 5 (script effects replication); the compose uses 7, but the operator guide
must state the floor. (3) The fallback bucket is cold while Redis works, so an outage grants every adapter a full
burst at once (N × burst). Document it beside the fallback paragraph in `mcp/README.md:303` (already partly there).
Effort: S.

**F1-6 — medium, confidence medium.** `mcp/deploy/build-image.sh:12` runs `mcp/scripts/build`, which does
`rm -rf node_modules` and `packages/server/node_modules` in the workspace. The dev adapter on 4405 and the unit suites
run from those folders, so building the image while the stack owner's runs are live breaks them (the README says
"must not run while tests run", which is not enough: the adapter is always running). Fix: build from a copy
(`git worktree add` or `pnpm deploy` into a temp dir) or at least refuse to run when port 4405 answers. Effort: S.

**F1-7 — low, confidence high.** `mcp/deploy/nginx.conf:58-60`. `proxy_read_timeout 300s` also bounds idle time on
the standalone MCP GET SSE stream (server notifications), which can be idle for longer; the SDK reconnects, but the
log shows a 499/504 every five idle minutes. Either raise it for `GET /mcp` or document the reconnect. Also add
`proxy_set_header Connection "";` with an upstream `keepalive 32;` to stop per-request upstream connections under
C1 at 100 agents. Buffering off, `Authorization` forwarded, body cap matching 32 MB: all right. Effort: S.

**F1-8 — low, confidence high.** `mcp/deploy/README.md:182`: "The Prometheus files are in `mcp/deploy/prometheus`";
they are in `mcp/deploy/`. `mcp/packages/loadtest/README.md:430-431`: "it has no rate-limit counter" is stale
(`penpot_mcp_rate_limit_fallback_total` exists now). Effort: S.

Checked and found right: Redis clients are two per adapter (limiter, store) and both are closed in `stop()`; the
`BackendSettings` URI check never echoes the value; the storage cap (8 MB) is enforced before every write; every
`rateLimiter.acquire` caller awaits (`BackendTool.ts:70`, `SandboxHost.ts:941`); the compose file does run this
branch (image built from the working tree, `PENPOT_MCP_SERVER_HOST=0.0.0.0`, healthchecks, Redis without ports).

### T4 chaos scripts

**F1-9 — medium, confidence high.** `mcp/packages/loadtest/scripts/chaos/redis-stopped.mjs:4-7, 70`. The case stops
`penpot-penpot-valkey-1`, the backend's valkey, and calls the dev adapter on 4405. The adapter log shows
"Multi-instance mode with Redis-backed transport: false": the live adapter has no `PENPOT_MCP_REDIS_URI`, so the
adapter fallback (the thing T2 built and T4 is meant to check) is never exercised. What the case does test is the
backend's own valkey dependence (`files_update.clj:1231` publishes to msgbus after commit; `rlimit` uses Redis), which
the failure-mode table does not describe and which may fail the "write answers ok" check for a backend reason. Fix:
run the case against the two-adapter stack (balancer on 4415, stop the stack's `redis` service) and record both
adapters' logs; keep a separate, clearly named `backend-valkey-stopped` case if the backend dependence is wanted.
Effort: S.

**F1-10 — medium, confidence high.** `chaos/lib.mjs:526-551` (`runCase`) and every case. No case has a cleanup path:
when a step throws after `docker stop` (exporter, valkey) or after the JVM kill, the body aborts, the result is
written, and the container stays stopped or the backend stays dead for the stack owner to notice. Fix: a `finally` in
`runCase` that calls an optional `c.cleanup` registered by the case (`exporter-stopped` registers `start`;
`backend-stopped-during-write` registers `restart-backend-dev` if `/readyz` is down). Effort: S.

**F1-11 — low, confidence high.** `chaos/slow-backend.mjs:7-10`. `SELECT ... FOR UPDATE` on the file row blocks the
`:lock-for-share?` read, which is inside the same `lock-wait!` call as `db/xact-lock!`
(`mcp_write.clj:548-593`); `SET LOCAL lock_timeout` precedes both, and the 55P03 handler is shared, so the error and
the wait are the ones the agent sees in production. The advisory-lock wait itself is not exercised, but it is the same
handler. A cheap second variant: two MCP writers on one file, the first with 2000 ops, so the second waits on the
advisory lock. Effort: S.

**F1-12 — low, confidence high.** `chaos/exporter-stopped.mjs:168-172`. The plan says `export_shape` "fails fast";
the check accepts up to 130 s. A stopped container refuses the connection at once; tighten to, say, 15 s so a hang is
a failure. `adapter-killed-during-flush.mjs:45-48`: `committedFrom` guesses the error text with a loose regex; read
`opsApplied`/`chunks` from the JSON when the answer is JSON. Effort: S.

Checked and found right: all waits are bounded (`waitFor` with timeouts, `Promise.race` with sleeps); the retry
after a backend kill is valid because the replay check reads `file_change` rows under the lock
(`mcp_write.clj:796-800`), which survive a restart; `--yes` gating; the scratch page keeps the test page clean.

### T5 upgrade scripts

**F1-13 — low, confidence high.** `upgrade/run-old-backend-tests.sh:60-99` (`--serve-old` checklist). The manual
token call runs the old backend with its own `PENPOT_SECRET_KEY` (`upgrade-lib.sh:122`), so a token issued by the dev
backend is refused for the key, not for the schema; the checklist already says to record that, which makes step 3 a
non-test. Fix: read the dev backend's secret from `penpot-tc` (`docker exec penpot-tc printenv PENPOT_SECRET_KEY`)
into the launcher, never into a log. Also check that the old backend accepts an MCP-scoped token on `get-profile`;
if it only accepts it on `mcp-*` commands, call `mcp-whoami` instead. Effort: S.

Checked and found right: `to-pre-upgrade.sql` is complete against 0158 (two columns, their CHECK constraints go with
the columns, the partial unique index) and 0159 (two indexes), and deletes the right `migrations` rows
(`module='main'`, `step` names match `migrations.clj:537-541`); it refuses to run on any database but the copy. The
old suite honours `PENPOT_TEST_DATABASE_URI`/`PENPOT_TEST_REDIS_URI` (old `helpers.clj:131-132`), so it does run
against the migrated schema in `penpot_upgrade_old_tests`. `run-new-migrations.sh` has a `trap cleanup EXIT`, refuses
to run when 0158/0159 are applied, and the `ROW EXCLUSIVE` probe with `lock_timeout 1s` is the right way to see
whether `CREATE INDEX` blocked writes. Note for the report: 0159 uses `IF NOT EXISTS`, so the documented pre-deploy
step is `CREATE INDEX CONCURRENTLY` of both indexes, after which the migration is a no-op.

### T6 observability

**F1-14 — medium, confidence high.** `mcp/deploy/prometheus.yml:30` targets `penpot-mcp-1:4401`, `penpot-mcp-2:4401`
on network `penpot_penpot` (`compose.monitoring.yaml:78-80`); the T2 stack's services are `penpot-mcp-a`,
`penpot-mcp-b` on the `deploy_default` network and are not on `penpot_penpot`. The monitoring stack cannot scrape the
two-adapter stack as shipped, and T6 is meant to watch T2's soak. Fix: one naming scheme, and add the two adapters to
the penpot network (or Prometheus to `deploy_default`). Effort: S.

**F1-15 — medium, confidence high.** Adapter metrics (`AdapterMetrics.ts`, `PenpotMcpServer.ts:838-880`) carry tool
counts, durations, sandbox counters, the fallback counter and the Redis gauge. There is no `process_resident_memory_bytes`,
heap, event-loop lag, open handles or worker count. The soak criterion "adapter RSS flat" and the question "is the
main thread stalling" cannot be answered from Prometheus; the loadtest README admits it (`README.md:430`). Fix: add
`process_resident_memory_bytes`, `nodejs_heap_used_bytes`, `nodejs_eventloop_lag_seconds{quantile}` (from
`perf_hooks.monitorEventLoopDelay`) and `penpot_mcp_sandbox_workers_live`; one alert each (RSS growth over 1 h, lag
p99 > 200 ms). Effort: S/M.

**F1-16 — medium, confidence high.** `mcp/deploy/alerts.yml`. Series and labels all match the code
(`penpot_mcp_tool_duration_seconds{tool,outcome}`, `penpot_mcp_errors_total{tool,code}`,
`penpot_mcp_refusals_total{reason}`, `penpot_rpc_climit_*`, `hikaricp_*`). Missing: Redis down
(`penpot_mcp_redis_up == 0` for 2 m, after F1-3), fallback in use (`rate(penpot_mcp_rate_limit_fallback_total[5m]) > 0`),
backend pool saturation (`hikaricp_pending_threads{pool="main"} > 0` for 5 m), climit rejections
(`rate(penpot_rpc_climit_rejected_total[5m]) > 0`), and the plan's "backend not ready" (scrape `up` is not
readiness; add a blackbox probe of `/readyz` or a readiness gauge). Worker terminations by reason (cpu/wall) are not
exported; `penpot_mcp_sandbox_calls_total{outcome="interrupted"}` is the nearest. Effort: S.

**F1-17 — low, confidence high.** `scripts/correlate-request-id.mjs:191` looks the audit row up in database `penpot`;
the dev stack's database is `penpot_mcpdev` (`chaos/lib.mjs:32`), so with `PENPOT_CORRELATE_PSQL_CONTAINER` the audit
source always reports `missing`. Add `PENPOT_CORRELATE_PSQL_DB`. Also record in the status doc that the correlation
for writes is blocked by the open `request-id=nil` finding. Effort: S.

Checked and found right: `check-metrics.mjs` is a sound parser (TYPE before samples, label consistency, cumulative
buckets, `+Inf` = `_count`, promtool through docker with a skip); the dashboard's series exist
(`penpot_mcp_tool_call_duration_seconds` on the adapter, `penpot_rpc_main_timing` histogram, Hikari `pool="main"`);
the CI `mcp` job runs `types:check` and `test` in the three packages from `mcp/` with `pnpm` on PATH as the other
modules assume, and the smoke is behind `--mcp-smoke` with `${VAR:?}` guards. One nit: no per-task timeout, so a hung
worker test hangs CI (low).

### T1 human tab

**F1-18 — high, confidence high.** `scripts/human-tab/human-tab.mjs:24, 465-490` and `run-c3.mjs:25-26, 141-153`.
The tab presses a key every 3 s and the README says "Penpot saves each one through update-file". The frontend
debounces persistence by 3 s (`frontend/src/app/main/data/persistence.cljs:874`), so presses at a 3 s cadence
coalesce unpredictably: the recorded run shows 60 presses and 10 saves in 180 s, one save in the 30 s baseline, and a
verdict of INCONCLUSIVE (`results/c3-human-tab-2026-11-07T22-51-36-050Z.json`). As written the C3 gate cannot pass or
fail. Fix: default `--interval-ms` to 5000 (one save per press), baseline ≥ 120 s or a separate tab-only run, and
require ≥ 20 saves per window; measure "save round trip" as press-to-200 (what the person feels), not HTTP
start-to-end, by stamping each press and matching the next `update-file`. Effort: M.

**F1-19 — medium, confidence high.** `run-c3.mjs:19, 162`. `readVarsFile` is called but not imported, so
`--fresh-file` crashes with a ReferenceError at run time (`node --check` cannot see it). The fresh file is the
documented way round the pre-existing `get-light` 429 on the test file, so the C3 run needs it. Effort: S.

**F1-20 — low, confidence medium.** `human-tab.mjs:396-404`. The websocket frame counter recorded 0 frames in a
3-minute workspace session, so it does not see Penpot's notifications socket (likely opened before the listener binds
or from a worker). The "agent changes reach the tab" signal is therefore absent. Either fix the capture (bind on
`context`, not `page`, before `goto`) or drop the field. `SAVE_PATH = "/update-file"` also matches
`update-file-library-sync-status` and `update-file-snapshot`; match `/update-file` followed by end or `?`. Effort: S.

Lost-edit detection (start + presses versus `get_shapes` after the run) is sound when every press registers; the
recorded run shows 60/60 applied. A press the frontend drops would count as a lost edit, so record the press count
against the save count to separate the two.

### T3 adversarial suite

No REPORT.md exists yet; the suite was reviewed for coverage only. Against the plan's list: token and scope misuse
(g1 A–F: read token on every write/manage/delete tool and raw command, commands an MCP token must not reach, render
session on websocket/debug/assets routes, expired/revoked/switched-off tokens, OAuth client exchange with another
client's code), SSRF (g3: loopback, link-local, metadata, `0.0.0.0`, IPv4-mapped, `nip.io`, odd schemes, credentials in
URL, DNS rebinding probe, redirectors), path traversal on export and import roots (g4, Windows-specific cases included),
bodies (g5: 5 MB unauthenticated, 40 MB authenticated, malformed, batch of 1000, deep nesting, limit abuse), sandbox
(g6: prototype and promise tricks, CPU, recursion, host-call cap, reply cap, storage `toJSON` bomb, log flood, 10
parallel CPU burners from 10 tokens, slow scripts from 4 tokens with a probe token), replay and limits (g7: same id
same payload, same id other payload, burst per token, 20 tokens × 30 calls, turn queue, export permits), leaks (g8:
error texts, `/metrics` with forwarded headers, `X-Request-Id` injection). A health check follows every group. This
covers the plan list in full.

**F1-21 — low, confidence high.** `g3-ssrf.mjs:328-329` depends on `httpbin.org` for the redirect cases, and g6/g7
need 19 agent tokens and files. When the suite is committed "as a test the CI can run against a stack" (exit
criterion), the redirect cases must use a local redirector container and the token requirements must be set up by
`setup-dev.sh`, else they are `not-testable` in CI and the exit criterion is met only on paper. Effort: S/M.

### The plan and the status document

**F1-22 — low, confidence high.** `production-readiness.md` records T1 human tab as "building" though it has
already produced results (three runs on 2026-11-07), and the T4 table in the loadtest README names a Redis case that
the live stack cannot exercise (F1-9). The status doc should also carry the two open correctness items above (F1-1,
F1-2) as round-1 findings for round 2 to verify. Effort: S.

## Plan additions

What round 1 does not cover but a multi-user, multi-adapter deployment needs. Effort as above.

1. **Storage consistency across adapters (fix F1-1, F1-2) and a test that alternates two adapters on one token for 50
   calls with a counter in `storage`; the final value must equal the call count.** M.
2. **Per-profile and per-team ceilings.** The limiter is per token and a profile may hold 20 client tokens, so one
   person gets 20 × (10 rps, burst 20). Define a per-profile ceiling (the backend's `rlimit` is per profile; confirm
   it covers `mcp-*` commands) and a per-team write budget (ops/min, bytes/h, export pixels/min), then test the
   20-token bypass in g7 against the ceiling, not only per token. M.
3. **Tenant isolation beyond file permissions.** Add to the adversarial suite: `storage` of token A is not visible to
   token B of the same profile and of another profile; a revoked token's Redis storage key cannot be read by a new
   token; the exporter cookie of session A cannot fetch assets of file B after the token dies on the other adapter. S.
4. **Token revocation propagation.** The validator caches `mcp-whoami` for 60 s per adapter; a revoked token works
   for up to 60 s on each adapter it has touched. Measure, document, and consider a Redis pub/sub revoke signal. S.
5. **Audit completeness matrix.** One row per write/manage/delete tool and action with the audit `name`, `request-id`,
   `token-fp` and `client_id` present; fix the open `request-id=nil` on `mcp-apply-operations` first. S/M.
6. **GDPR-style deletion.** Test `delete-profile` cascades to `access_token` (with `client_*`), audit rows that name
   the profile, Redis storage (TTL 30 min, keyed by token digest: confirm no profile id in values), and agent exports
   on adapter disk (`PENPOT_MCP_EXPORT_DIR` persists per adapter; the guide must say so and give a retention job). S.
7. **Backup and restore with agent data.** Take a `pg_dump` during the soak, restore to a copy, open the test file
   with the old and the new backend, and run `validate` on it; agent writes use the same tables as human writes, so
   this is a check, not a design. S.
8. **Contract version across a rolling deploy.** Mixed backend versions behind one balancer: the adapter checks
   `contractVersion` once per token. Define the order (backends first, adapters second; a backend below the adapter's
   minimum is refused) and test new adapter + old backend and old adapter + new backend with the smoke. M.
9. **Exporter as a shared bottleneck.** Each adapter allows 4 renders, so N adapters put 4N on one exporter and the
   per-token permit is per adapter too. Add an export-heavy scenario (20 tokens × `export_shape page`) to capacity,
   record exporter CPU and queue, and either size the exporter or move the permit to Redis. M.
10. **DB pool under 100 agents.** Record `hikaricp_pending_threads`, `hikaricp_active_connections` and
    `penpot_rpc_climit_waiting` in the capacity runs; alert on pending threads; state the pool size per backend and the
    expected agents per backend in the guide. S.
11. **`file_change` growth and GC.** Every MCP batch writes one change row plus snapshots. In the soak, record rows per
    1000 operations, confirm `objects-gc` deletes them on schedule and the 0159 indexes keep the replay check flat as
    the table grows; state the retention and the replay window (1 h) relation. S.
12. **Write queue across adapters.** Two adapters writing one file contend on the backend lock and see
    `mcp-file-busy` after 15 s; measure C2 at 5 agents split over two adapters (already planned) and decide between
    a Redis per-file queue and routing by `fileId`. Record the decision. M.
13. **Redis operations.** `rediss://`, an ACL user limited to the two key prefixes, `maxmemory` with
    `volatile-ttl`, Redis ≥ 5, and sizing: live tokens × up to 8 MB storage. Sample Redis memory and key count in the
    soak. S.
14. **Chaos cases for the balancer tier.** One adapter down behind nginx (passive failover, in-flight requests),
    nginx reload, Redis stopped against the two-adapter stack (replaces F1-9), and an adapter restart with 20 live
    sandboxes (storage recovery). S.
15. **CI-runnable adversarial suite.** Local redirector container, `setup-dev.sh` provisioning the 19 agent tokens,
    and the suite in `scripts/ci --mcp-adversarial`. S/M.
16. **Pre-deploy index step.** The guide's upgrade order must run `CREATE INDEX CONCURRENTLY` for both 0159 indexes
    before the backend starts; T5 measures the blocking build, the guide must prescribe the non-blocking one. S.
