---
title: MCP in production
desc: Run the backend-native Penpot MCP for many users. Topology, operator settings, sizing, deploy, rollback and monitoring.
---

# Running the backend-native MCP in production

This guide is for the operator. It covers how the MCP runs for many users: what runs where, which settings
matter, how to size it, how to deploy and roll back, what to watch, and what to delete.

Each statement points at code or a doc in this repository. Numbers from the round-2 measurements (2026-11-08)
cite their source in the text. The run notes are in `mcp/packages/loadtest/results/2026-11-08-round2/run-notes.md`.

The code is on branch `perf/render-wasm-large-files`, at `e4084f80b2` plus uncommitted work. The state of each
track is in `mcp/docs/production-readiness.md`.

## 1. Topology

```
agents (MCP clients)
   |  TLS at your balancer (the sample stack has none)
balancer (nginx in mcp/deploy/nginx.conf: round robin, no sticky routing)
   |
adapters, N of them (penpot-mcp, PENPOT_MCP_MODE=backend) ----> Redis (rate limit, sandbox storage)
   |                 |
   |                 +------> exporter (one render per token)
   v                              |
backends, M of them (enable-mcp-backend) <----------------------+
   |
Postgres (all Penpot data)
```

Sources: `mcp/deploy/compose.two-adapters.yaml`, `mcp/deploy/nginx.conf`, `mcp/deploy/README.md`. The exporter gets
a render session from the backend and reads the file through it (`mcp/docs/backend-mode-contract.md`, 1.5).

Ports: the adapter serves MCP and its health and metrics endpoints on 4401
(`docs/technical-guide/configuration.md`, MCP health endpoints). The backend port is 6060
(`mcp/deploy/prometheus.yml`). The exporter default is `http://localhost:6061/` (`BackendSettings.ts`).

### 1.1 What state lives where

| State | Where it lives | Shared by all adapters | Source |
|---|---|---|---|
| Token check result | Adapter memory, keyed by token digest. 60 s for a good token, 5 s for a rejected one. | No. Backend tools see a revoked token at once: both adapters refused it 0.4 s after the row was deleted (measured 2026-11-08). The adapter-only tools (`describe_operations`, `penpot_api_info`, `high_level_overview`) can keep a good token for up to 60 s (not measured). | `backend/BackendTokenValidator.ts`, `PENPOT_MCP_TOKEN_CACHE_S` |
| Rate limit bucket | Redis key `penpot.mcp.ratelimit.<digest>` when `PENPOT_MCP_REDIS_URI` is set. Adapter memory otherwise. | Yes, with Redis | `backend/RedisRateLimiter.ts`, `backend/BackendServices.ts` |
| Sandbox runtime (one per token) | The adapter that serves the call | No | `sandbox/SandboxSessions.ts` |
| Sandbox `storage` | Redis key `penpot.mcp.sandbox.storage.<digest>`, expires after the idle eviction time (30 min). Adapter memory otherwise. | Yes, with Redis. A runtime reads the shared copy before each call. | `sandbox/StorageStore.ts`, `sandbox/SandboxSessions.ts` (before each call) |
| Write queue, one per token and file | Adapter memory | No. The backend file lock orders writes across adapters. | `backend/FileWriteQueue.ts`, `rpc/commands/mcp_write.clj` (15 s lock wait) |
| Render slots | One render per token and four per process, in adapter memory. With Redis set, `PENPOT_MCP_EXPORT_TOTAL_PERMITS` (default 4) is shared by every adapter on that Redis. Callers that wait for a shared slot are served in arrival order. | Yes, with Redis | `utils/ExportConcurrency.ts`, `utils/RedisExportPermits.ts` |
| Render session | Postgres row, 10 minutes. The adapter caches the session per token and file. | Rows are shared. The cache is per adapter. | contract 1.5, `backend/RenderSessionCache.ts` |
| Export and import files | Local disk of each adapter host, under the roots | Only if the hosts share a disk | `utils/ExportDirectory.ts`, `tools/backend/ImportDirectory.ts` |
| Files, changes, snapshots, tokens, audit rows | Postgres | Yes | contract, migrations `0158`, `0159` |
| Backend concurrency limits (`climit`) | Each backend process, in memory | No. Each backend process has its own permits. | `rpc/climit.clj` |
| Backend request limits (`rlimit`) | Redis, through the backend's scripts | Yes | `rpc/rlimit.clj` |

### 1.2 Why no sticky routing is needed once Redis is set

- The rate limit and the sandbox storage are in Redis. Any adapter gives the same answer for a token
  (`mcp/deploy/README.md`, "What it proves").
- A retry of a write on another adapter is a replay. The replay key is the token id, the request id and a digest
  of the payload, and the commit rows in Postgres hold it (contract 2.11).
- The backend file lock orders writes to one file across all backend processes. A write that waits 15 s for the
  lock fails with `mcp-file-busy`.

Still per adapter:

- The JavaScript state of a script. A later call on another adapter starts a fresh runtime. With Redis set, it gets
  the `storage` copy from Redis, not the variables. Without Redis, the storage stays in the first adapter's memory.
- The token check cache. Backend tools refuse a revoked token at once (0.4 s, measured 2026-11-08). The adapter-only tools (`describe_operations`, `penpot_api_info`, `high_level_overview`) can use a good token for up to 60 s.
- The write queue. Two calls from one token can run on two adapters at once. The file lock then decides the order.
  Round 2 measured this (`mcp/packages/loadtest/scripts/round2/cross-adapter-writes.mjs`): 200 of 200 writes at 10 a
  second and 40 of 40 at 18 a second committed, with `revn` strictly increasing and no `mcp-file-busy`. Test the order of
  writes from one token across adapters at your own rates before you rely on it.
- The export and import folders. Render slots are shared when Redis is set (section 3).

## 2. Flags and settings

### 2.1 Backend flags and keys

| Setting | Default | Effect | Source |
|---|---|---|---|
| `enable-mcp` flag | off | Turns on the MCP integration and the frontend proxy | `docs/technical-guide/configuration.md` (MCP) |
| `enable-mcp-backend` flag | off | Off: every MCP command except `send-mcp-feedback` answers `mcp-backend-disabled` | contract 1.2 |
| `enable-mcp-raw-changes` flag | off | Off: `mcp-apply-changes` answers `mcp-raw-changes-disabled`. Typed operations still work. | contract 1.2, `rpc/commands/mcp_write.clj` |
| `enable-audit-log` flag | not set | Writes audit rows. Section 5.4 and the audit matrix use it. | `loggers/audit.clj` (`process-event`) |
| `webhooks` flag | not set | Sends webhook events for MCP writes | `loggers/audit.clj` (`process-event`) |
| `PENPOT_MCP_TOKEN_MAX_AGE` (`mcp-token-max-age`) | `2160h` (90 days) | Expiry of an MCP token created without an explicit expiry | `config.clj`, `rpc/commands/access_token.clj` |
| `PENPOT_MCP_MAX_COMPILED_CHANGES` (`mcp-max-compiled-changes`) | `100000` | Most changes one write call may compile to | `rpc/commands/mcp_limits.clj` |

Put the flags in `PENPOT_FLAGS` on each backend. Set the keys as environment variables on each backend.

### 2.2 Adapter settings

All values come from the environment at start. A bad value stops the start, and the error names the variable
(`backend/BackendSettings.ts`, `sandbox/SandboxSettings.ts`).

Mode and URIs:

| Variable | Default | Meaning |
|---|---|---|
| `PENPOT_MCP_MODE` | `bridge` | Set `backend` for the backend tools only. `both` also keeps the plugin tools. |
| `PENPOT_MCP_BACKEND_URI` | unset | Base URI of the backend. Needed for `backend` and `both`. |
| `PENPOT_MCP_EXPORTER_URI` | `http://localhost:6061/` | Base URI of the exporter |
| `PENPOT_MCP_ASSETS_URI` | unset | Public URI that serves `/assets/by-id/`. Unset: the exporter's origin is used. |
| `PENPOT_MCP_AUTH_URI` | unset | Turns on OAuth. Needs multi-user mode and HTTPS (or HTTP on loopback). |
| `PENPOT_MCP_REDIS_URI` | unset | `redis://` or `rediss://` URI. Read in `backend` and `both` mode only. Unset: each adapter limits on its own and keeps its own storage. |

Limits and timeouts:

| Variable | Default | Meaning |
|---|---|---|
| `PENPOT_MCP_RATE_LIMIT_RPS` | `10` | Calls per second for one token, all adapters together when Redis is set |
| `PENPOT_MCP_RATE_LIMIT_BURST` | `20` | Calls one token may send at once |
| `PENPOT_MCP_BACKEND_TIMEOUT_S` | `55` | Timeout of each backend call |
| `PENPOT_MCP_BACKEND_MAX_RESPONSE_MB` | `8` | Cap on one backend or exporter response |
| `PENPOT_MCP_MAX_TOOL_RESPONSE_KB` | `100` | Cap on one tool answer. Longer answers are cut. |
| `PENPOT_MCP_MAX_BODY_MB` | `32` | Request body cap after the token check. Before it, 4 MB (contract 4.8). |
| `PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS` | `4` in backend mode | Exports that run at once in one process. `0` means no limit. |
| `PENPOT_MCP_EXPORT_TOTAL_PERMITS` | `4` | Renders that run at once across all adapters that share `PENPOT_MCP_REDIS_URI`. Each permit lasts at most 65 s. If Redis fails, each process uses its own cap. |
| `PENPOT_MCP_EXPORT_BATCH_SIZE` | `10` | Shapes that one exporter request renders in a `shapeIds` batch, from 1 to 50. Each batch takes one render permit. |
| `PENPOT_MCP_EXPORT_CACHE_MB` | `64` | Memory of the render cache in each adapter process, in MB, from 0 to 4096. The cache holds the image bytes, so it sits near this size once full. `0` turns it off. |
| `PENPOT_MCP_TOKEN_CACHE_S` | `60` | How long a good token check is reused |
| `PENPOT_MCP_ALLOW_QUERY_TOKEN` | `false` in backend mode | Accepts the token in the URL. Keep it `false` (section 7). |

Sandbox (`execute_code`):

| Variable | Default | Meaning |
|---|---|---|
| `PENPOT_MCP_SANDBOX_TIMEOUT_S` | `3` | Guest CPU time of one call |
| `PENPOT_MCP_SANDBOX_WALL_S` | `120` | Wall clock time of one call |
| `PENPOT_MCP_SANDBOX_IDLE_MIN` | `30` | Idle minutes before a runtime and its storage are dropped |
| `PENPOT_MCP_SANDBOX_MAX_SESSIONS` | `20` | Live runtimes per process. The least recently used one is dropped first. |
| `PENPOT_MCP_SANDBOX_MAX_CONCURRENT` | `20` | Calls that run at once in one process. Set on its own: it does not follow `PENPOT_MCP_SANDBOX_MAX_SESSIONS`. |
| `PENPOT_MCP_SANDBOX_MAX_HOST_CALLS` | `1000` | Host calls one script may make |
| `PENPOT_MCP_SANDBOX_HOST_MS` | `30000` | Host time of one script, in milliseconds, backend and exporter waits included |
| `PENPOT_MCP_SANDBOX_PAGE_MB` | `16` | Page data one call may hold, as JSON |
| `PENPOT_MCP_SANDBOX_WORKERS` | `true` | Runs each guest in a worker thread. `false` runs it on the server thread. |

The wait for a free call slot is 60 s. That value is fixed in code (`SandboxSettings.DEFAULT_SLOT_WAIT_MS`).

Files:

| Variable | Default | Meaning |
|---|---|---|
| `PENPOT_MCP_EXPORT_DIR` | `penpot-exports` in the home directory of the server user | Export tools write only inside it. Paths through a symbolic link are refused. |
| `PENPOT_MCP_IMPORT_DIR` | `penpot-imports` in the home directory | Import tools read only files inside it |

Listening, metrics and logs:

| Variable | Default | Meaning |
|---|---|---|
| `PENPOT_MCP_SERVER_HOST` | `localhost` | Listen address. The compose files set `0.0.0.0` inside the container. |
| `PENPOT_MCP_SERVER_PORT` | `4401` | Listen port |
| `PENPOT_MCP_KEEPALIVE_S` | `65` | Seconds the server keeps an idle HTTP connection open. Keep it above the idle timeout of the proxy in front. `deploy/nginx.conf` sets an upstream `keepalive_timeout` of 60 s. |
| `PENPOT_MCP_LOG_LEVEL` | `info` | Log level |
| `PENPOT_MCP_LOG_DIR` | unset | Log folder. Logs go to a file only when this is set. |

## 3. Sizing

Round 2 measured these values on 2026-11-08, with one backend, two adapters, Redis and one exporter. Source:
`mcp/packages/loadtest/results/2026-11-08-round2/run-notes.md`.

| Input | Round-2 value | Source |
|---|---|---|
| Agents per adapter | Two adapters carried 50 writers in one team (p95 946 ms, 0 errors) and the 5-agent soak (142,276 calls in 4 h, p95 138 ms). No load run used one adapter alone. | C1-50; soak |
| Writers per team | 50 in one team: no refusals, and the wait queue peaked at 42. About 54 concurrent writers in one team are refused. Five teams of 10 did not lower p95 (930 ms against 946 ms). | C1-50 |
| Agents on one file | 5 agents on one fresh file: 510 calls, 0 errors, p95 181 ms. Two adapters writing one file at 10 a second (200 writes) and 18 a second (40 writes): all committed, no `mcp-file-busy`. More agents on one file were not run. | C2; cross-adapter writes |
| Backend processes | One backend. Its CPU: 4.5 cores at 50 writers, 0.4 cores on average in the soak. Two or more backends were not run. | C1-50; soak |
| Postgres pool per backend | 8 connections. Soak: at most 7 active, 0 waiting. Five teams at 50 writers: up to 11 waiting in 40 % of samples, acquire p95 16 ms. | C1-50; soak |
| Sandbox runtimes per adapter, at peak | 0 active in the soak samples. Peak under heavy `execute_code` load was not measured. | soak sampler |
| Adapter memory, at peak | Soak: resident memory peaked at 514 MB (adapter 4406) and 373 MB (adapter 4407). Heaps stayed flat for 4 h. | soak sampler |
| Exporter processes | One exporter. 0.51 exports a second for the stack, measured before the shared cap (two adapters, 4 render permits each). Export p95 28.2 s. 3 of 97 exports timed out at the exporter, with 10 export tokens. | C8 |

Rules behind the values:

- Sandbox workers. One runtime per active token, up to `PENPOT_MCP_SANDBOX_MAX_SESSIONS` (20). An idle worker
  holds about 60 MB. Each runtime's WebAssembly memory grows to 256 MB, and a runtime above 128 MB is dropped when
  idle. Twenty idle workers take about 1.2 GB. Twenty busy at their maximum take about 6.3 GB
  (`mcp/packages/server/src/sandbox/WORKER_THREADS.md`).
- Adapter memory alert. `PenpotMcpAdapterMemoryHigh` fires above 1.5 GB (`mcp/deploy/alerts.yml`). The soak peak was
  514 MB, so the threshold leaves room. Tune it with your own load.
- Backend concurrency. The `climit` permits live in each backend process (`rpc/climit.clj`), so the total for the
  deployment is the per-process permits times the number of backends. The MCP permits per process are listed in
  section 6.
- Team write queue. The by-team limit (`mcp-apply/by-team`) admits its permits and its queue callers at once:
  4 + 50 = 54 with the shipped `climit.edn`. The 55th concurrent call is refused, and the body names
  `mcp-apply/by-team`. Raise the `:queue` of `:mcp-apply/by-team` in the production climit file when one team runs
  more agents than that. Watch `penpot_rpc_climit_waiting` for that limit before you raise `:permits`.
- Postgres pool. No default is set in the code (`database-max-pool-size` in `config.clj` has no default). The pool
  should cover the MCP calls that can run at once, plus the editor. Round 2 found the pool of 8 and the CPU as the
  limit, at about 42 writes a second on that host.
- Exporter. One render per token (`RENDERS_PER_TOKEN` is 1). Four renders per adapter process by default. With
  Redis set, `PENPOT_MCP_EXPORT_TOTAL_PERMITS` (default 4) caps the renders of all adapters on that Redis. Callers that
  wait for a shared slot are served in arrival order. Each permit is held for at most 65 s. If Redis fails, each
  adapter falls back to its own four, so two adapters can send eight renders at once. Plan one exporter per four
  concurrent renders.

## 4. Deploy order and rollback

### 4.1 Before the deploy: build the two `file_change` indexes

Migration `0159` builds two indexes with a plain `CREATE INDEX`. That blocks writes on `file_change` while it
runs, and every save writes a row there (`backend/src/app/migrations/sql/0159-add-file-change-indexes.sql`).
Build both before the deploy, outside a transaction:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS file_change__file_id__session_id__idx
    ON file_change (file_id, session_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS file_change__file_id__created_at__labelled__idx
    ON file_change (file_id, created_at)
 WHERE label IS NOT NULL;
```

Run them in `psql` one at a time. `CONCURRENTLY` cannot run inside a transaction. Then check both:

```sql
SELECT indexrelid::regclass AS index, indisvalid
  FROM pg_index
 WHERE indexrelid IN ('file_change__file_id__session_id__idx'::regclass,
                      'file_change__file_id__created_at__labelled__idx'::regclass);
```

If an index shows `indisvalid = false`, drop it with `DROP INDEX CONCURRENTLY` and build it again. `IF NOT EXISTS`
skips an invalid index, so the migration would not fix it. This is standard PostgreSQL behaviour. Not tested here.

Migration `0158` adds two nullable columns and a partial unique index on `access_token`
(`0158-add-client-to-access-token.sql`). It uses a plain `CREATE UNIQUE INDEX`. Its lock time has not been measured.
Check the row count of `access_token` before the deploy.

### 4.2 Deploy order

1. Back up the database (section 8.3).
2. Build the two `file_change` indexes (section 4.1).
3. Deploy every backend. The migrations run when the backend starts
   (`mcp/packages/loadtest/scripts/upgrade/run-new-migrations.sh`, header). Check `/readyz` on each backend.
4. Check `mcp-whoami` on one backend: `contractVersion` must be `1` or later
   (`mcp/docs/backend-mode-contract.md`, 6). Do not use `get-file` with an MCP token: it answers 403 by design
   (contract 1.4). Read a file with `get-mcp-file-outline` instead.
5. Deploy the adapters one at a time behind the balancer. After each one, check `/readyz` and run the smoke test
   (section 10).
6. Watch the metrics for one hour (section 10).

### 4.3 Mixed versions

| Pair | What happens | Source |
|---|---|---|
| Old and new adapters on one Redis | Work together. An old adapter takes a free permit without queuing, so the cap still holds. Arrival order holds only once every adapter is upgraded. | `utils/RedisExportPermits.ts` |
| Old adapter, new backend | Works. The old adapter ignores new fields. Behaviour changes in the backend can still show as new error codes (the 50-batch limit, the replay key, the lock codes). | contract 6; `mcp/packages/loadtest/README.md`, "Deploy order" |
| New adapter, old backend | Refused on every call with "backend too old for backend mode". The adapter needs `contractVersion` 1 or later. | contract 4.7; `mcp/packages/loadtest/README.md` |

Deploy the backends first, so that no adapter runs against a backend that is too old.

### 4.4 Rollback

Roll back the adapters first, then the backends.

When you roll back the backend, these stay. They are harmless, as the configuration guide says:

- the `client_id` and `client_name` columns of `access_token` and the unique index from `0158`;
- the `mcp:*` scopes in the token rows;
- the render props of the session rows.

The two `file_change` indexes from `0159` also stay. The old backend does not use them, and they still take space
and slow writes a little. Drop them only if you have a reason.

Round 2 ran the previous backend (`541f965bf1`) against a migrated copy of the database (T5): 143 tests with no
failures, and its MCP calls passed except `get-file`, which answers 403 by design. Not run: the new adapter against the
old backend. The rollback order (adapters first) keeps that pair apart.

## 5. Monitoring

### 5.1 Alert rules

These rules are in `mcp/deploy/alerts.yml`. The thresholds are starting points. Tune them from the soak and capacity
numbers. Each rule has a runbook note in the file. The first step is below.

| Alert | Fires when | First step |
|---|---|---|
| `PenpotMcpAdapterDown` | An adapter is not scraped for 2 min | `docker compose ps`, then `logs`. Restart it if it exited. Check the nginx upstream. |
| `PenpotMcpBackendDown` | A backend is not scraped for 2 min | Check the backend, Postgres and Valkey. `/readyz` on port 6060 shows the state. |
| `PenpotMcpSandboxTerminationsHigh` | More than 5 sandbox runtimes disposed per minute, for 10 min | Read `penpot_mcp_sandbox_memory_recycles_total` and `penpot_mcp_sandbox_calls_total{outcome="interrupted"}`. A flood of recycles means heavy `execute_code` work. |
| `PenpotMcpRefusalsHigh` | Backend refusals above 0.5 per second for 10 min | Find `mcp refused` lines in the backend log (`reason`, `cmd`, `token-fp`). A scope refusal usually means a read token tried a write. |
| `PenpotMcpLockTimeouts` | `mcp-file-busy` or `mcp-lock-timeout` above 1 per minute for 10 min | Find the file (`file-id` in the log). More than one agent writing one file is the usual cause. |
| `PenpotMcpWriteLatencyP95High` | Write tools p95 above 3 s for 10 min | Check `penpot_rpc_climit_waiting`, `penpot_rpc_climit_rejected_total`, the Postgres connections and the `mcp-tool` durations. |
| `PenpotMcpAdapterNotReady` | `/readyz` of an adapter fails for 2 min | Check the adapter log for the backend URI and the token check. Then check the backend. |
| `PenpotMcpBackendNotReady` | `/readyz` of a backend fails for 2 min | Check Postgres and Valkey. Read the backend log for the shutdown reason. |
| `PenpotMcpRedisDown` | `penpot_mcp_redis_up` is 0 for 2 min | Check Redis and `PENPOT_MCP_REDIS_URI`. Without Redis, limits and storage are per process. |
| `PenpotMcpRateLimitFallback` | An adapter used the in-process limiter for 5 min | See the Redis alert. While the fallback runs, the limit is about N times too generous. |
| `PenpotMcpBackendPoolSaturated` | Calls wait for a Postgres connection for 5 min | Compare `hikaricp_active_connections` with `hikaricp_max_connections`. Look for slow queries. |
| `PenpotMcpClimitRejected` | The backend refuses MCP calls at its concurrency limit | Raise the limit only if the pool and the write latency look healthy. Otherwise lower the agents per backend. |
| `PenpotMcpExportCapFull` | More than one export a minute refused as busy by the process or the shared cap, summed over all adapters, for 10 min (`sum(rate(penpot_mcp_export_busy_total{gate=~"process|shared"}[5m])) * 60 > 1`). One stray refusal does not fire it. `gate="token"` is one client and is not part of this alert. | Check the exporter CPU and the export duration. Compare `sum(penpot_mcp_export_permits_held{gate="shared"})` with `PENPOT_MCP_EXPORT_TOTAL_PERMITS`. If the exporter has room, raise `PENPOT_MCP_EXPORT_TOTAL_PERMITS` and `PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS`. If not, add exporter capacity or lower the export load. |
| `PenpotMcpAdapterMemoryHigh` | Adapter resident memory above 1.5 GB for 10 min | Compare `nodejs_heap_used_bytes` with `penpot_mcp_sandbox_workers`. A flat heap and rising RSS is a native leak. A rising heap is a cache or sandbox leak. |
| `PenpotMcpAdapterEventLoopLag` | Event loop lag p99 above 200 ms for 5 min | Look for large JSON bodies, or a sandbox that runs on the server thread. |

One thing to know before you use the rules:

- The adapter series `nodejs_*` and `process_*` appear once the adapter exports them. The loadtest README says the
  adapter process panels are empty until then (`mcp/packages/loadtest/README.md`, "Metrics, request ids and monitoring").

### 5.2 Dashboard

`mcp/deploy/grafana-mcp-dashboard.json` is provisioned by `mcp/deploy/compose.monitoring.yaml`. It shows the
tool p95, refusals by reason (with the export refusals by gate), errors by code, Postgres pool use and waiting threads, Redis state, the fallback count,
the concurrency rejections and the panel "Shared export permits held", which sums `penpot_mcp_export_permits_held{gate="shared"}` over the adapters against `PENPOT_MCP_EXPORT_TOTAL_PERMITS`.

Prometheus scrapes the adapters with an MCP token. `/metrics` answers without a token only when the adapter binds a loopback address, the client is on the same
machine, and the request has no forwarding header (contract 4.7). The balancer adds
`X-Forwarded-For` to every request (`mcp/deploy/nginx.conf`). So a scrape through the balancer always needs a token.

### 5.3 The request id across the hop

- The adapter makes an id for each tool call. It sends it to the backend as `X-Request-Id` (contract 4.3).
- The backend uses it as the request id. Each `mcp-tool` log line carries it (`rpc/commands/mcp.clj`, `run-tool`).
- Each audit row carries it in `context.request-id`. Events from the MCP tool wrapper (`run-tool`, and the three
  writes) also carry it in `props.request-id`.
- `mcp/packages/loadtest/scripts/correlate-request-id.mjs` follows one call through the adapter log, the backend log
  and the audit row.

Known gap: the opt-in commands (the reads and writes listed in the audit matrix) do not write an `mcp-tool` line.
Section 5.4 and the appendix list the gaps.

### 5.4 The audit log

Audit rows exist only when `enable-audit-log` is on. Each MCP write that commits is recorded as `update-file`, the same
name as an editor save. To tell them apart, filter on `props.tool`. The full table of events per command, with the gaps, is the
"Audit matrix" in `mcp/docs/backend-mode-contract.md`.

Gaps to know about:

- A failed call writes no audit row. Only the `mcp-tool` line and the error counter record it. The one exception is
  `import-binfile`, which records `status: failed`.
- A call refused before the command runs (token, scope, profile, flag, rate limit) writes no audit row. The
  backend logs an `mcp refused` line with the reason and the request id, and counts it in
  `penpot_mcp_refusals_total`.
- The adapter's own actions (writing an export file, reading an import file, the sandbox storage) have no backend
  audit row. They appear only in the adapter log.

## 6. Limits and quotas

There are two layers of limits. The adapter limits each token. The backend limits each profile, and each process.

| Layer | Limit | What the agent sees when it trips | How to retry |
|---|---|---|---|
| Adapter, per token | 10 calls a second, burst 20 (`PENPOT_MCP_RATE_LIMIT_*`). Shared through Redis when set. | `rate limited, retry after N s` | Wait N seconds |
| Backend reads, per profile | Bucket of 1200, refill 600 a minute (10 a second). `rlimit` `:mcp-read` (`backend/resources/rlimit.edn`). | `Backend error request-blocked: rate limit reached` (HTTP 429) | Back off, then retry |
| Backend writes, per profile | Bucket of 600, refill 300 a minute (5 a second). `rlimit` `:mcp-write` (`backend/resources/rlimit.edn`) | Same as above | Back off. Retry a write with the same `requestId`. |
| Backend reads per profile, in flight | 4 at once, queue 20, 30 s (`:mcp-read/by-profile`) | HTTP 429 naming the limit (see the note below the table) | Retry later |
| Backend reads, all profiles, per process | 8 at once, queue 64, 30 s (`:mcp-read/global`) | Same | Retry later |
| Scans per file, per process: `find_shapes`, `find_connectors`, `list_fonts`, `lint_page`, `find_similar_boards` | 2 at once, queue 10, 30 s (`:mcp-find/by-file`) | Same | Retry later |
| `export_subtree`, `get_interactions`, `get_shapes` and the other reads | The read limits above. The six new reads use the same `:mcp-read` bucket as the other reads. | Same | Retry later |
| Writes, per profile, per process | 1 at once, queue 5, 60 s (`:mcp-apply/by-profile`) and 1 for `update-file` (`:mcp-update-file/by-profile`) | Same | Retry later |
| Writes, per team, per process | 4 at once, queue 50, 60 s (`:mcp-apply/by-team`) | HTTP 429 with the limit in the body. The adapter shows `Backend error capacity-limit-reached: concurrency limit mcp-apply/by-team reached (queue-full), retry later`. | Retry later |
| Writes, all profiles, per process | 6 at once, queue 50, 60 s (`:mcp-apply/global`) | Same | Retry later |
| File lock | 15 s wait for the file lock | `mcp-file-busy` (HTTP 409) | Re-read `revn`, then retry with the same `requestId` |
| Row or project lock | 15 s | `mcp-lock-timeout` (HTTP 409) | Retry later |
| Write size | 2000 changes or operations per call, 8 MB payload, 100000 compiled changes | `mcp-batch-too-large` (HTTP 400) before the file is locked | Split the call |
| Batches | 50 commits per call, 60 s budget for the batches after the first | `mcp-too-many-batches`, `mcp-time-budget-exceeded` | Split the call. Use `allowSplit` for `apply_operations`. |
| Tool answers | 100 kB (`PENPOT_MCP_MAX_TOOL_RESPONSE_KB`) | The answer is cut. It says `truncated`, and its `nextCursor` is dropped. | Repeat the call with a smaller `limit` |
| Backend answers | 8 MB (`PENPOT_MCP_BACKEND_MAX_RESPONSE_MB`) | An error | Narrow the request |
| Backend call | 55 s (`PENPOT_MCP_BACKEND_TIMEOUT_S`) | A timeout error. A sent write may still commit. | Check the file state before you retry the write |
| Client tokens per profile | 20 (`mcp-client-limit`) | `mcp-client-limit` (restriction). An OAuth approval answers `access_denied`. | Revoke a client token |
| Sandbox | CPU 3 s, wall 120 s, 1000 host calls, 20 calls at once per process (`PENPOT_MCP_SANDBOX_MAX_CONCURRENT`), 16 MB of page data, 8 MB of `storage` | Interrupted, refused or capped, with a message that names the limit | Split the work. Use `storage` for state that must survive a call. |
| Export renders | One per token. Four per process. With Redis, four across all adapters on it (`PENPOT_MCP_EXPORT_TOTAL_PERMITS`). | A call waits up to 30 s for a slot. With Redis, waiting calls get slots in arrival order. Then it answers `export is busy, retry later`. A render over 60 s fails. | Retry the export later |
| Export batch | 200 shapes per call (`shapeIds`). The ids go to the exporter in chunks of `PENPOT_MCP_EXPORT_BATCH_SIZE` (default 10, from 1 to 50), one render permit for each chunk. | A shape that fails is listed under `failed` and does not stop the others. A failure that keeps coming back, the same error class on the first request of two chunks in a row, stops the call. | Export the failed shapes again |
| Export call budget | 10 minutes per call. Past it, the call starts no more renders. | The shapes left are listed as not rendered: `the call ran out of time; call again; the shapes already rendered come from the cache.` | Call again. The rendered shapes come from the cache. |
| Export batch refusal | An exporter that answers a batch with a 5xx, or a ZIP that does not map back to the shapes, gets one shape per request for 10 minutes in that process. This applies when the single renders of that chunk all succeed. | None. The call goes on one shape at a time. | None |
| Export retry | A single render that answers 5xx is tried once more after 500 ms. A 4xx answer is not retried. | The shape's error, for example the exporter's 4xx text | Fix the call, or retry later |
| Export cache | `PENPOT_MCP_EXPORT_CACHE_MB` (64 MB by default) for each adapter process, 15 minutes for each render. Each render is kept as soon as it arrives, whatever its fonts. The key includes the page. A render is not kept when the file revision is unknown. | None. A cached shape is not rendered again. | `refresh: true` renders it again. |

Export answers name the cause in text. These are the texts a client may see:

- `export is busy, retry later; call again; the shapes already rendered come from the cache.` The render slots are full and the call stops. A call with `outputDir` says `call again with overwrite: true` as well.
- `the call was cancelled; call again; the shapes already rendered come from the cache.` The client went away.
- `the call ran out of time; call again; the shapes already rendered come from the cache.` The 10 minute budget is spent.
- `the inline total is full; pass outputDir to save every shape, or ask for fewer shapes.` Less than 256 kB of the 8 MB inline total is left, so the shapes after it are listed as not rendered.
- `too large for an inline reply on their own, not returned` An image over 8 MB is skipped. Pass `outputDir` or `filePath`.
- `an earlier shape failed, so the shapes after it were not rendered.` Only a `shapeId: "page"` export stops at a failed shape.
- `Font warning: these fonts did not resolve, so the render used a fallback font: ... These renders are kept for up to 15 minutes; after the font is fixed, pass refresh: true to render again.` The reply names each font with its reason, in `warnings` (with `outputDir`) or as a text item. The check runs within 3 s and only adds this notice. Run `list_fonts` to see the font.

The concurrency limits answer HTTP 429 with a body whose `type` is `concurrency-limit` and whose `code` is
`capacity-limit-reached`. The body names the `limit` (for example `mcp-apply/by-team`) and the `reason`
(`queue-full` or `timeout`). The `hint` repeats both in a sentence (`http/errors.clj`, `:concurrency-limit`).
The backend logs and counts each refusal as `capacity-limit-reached`, with the limit name (`rpc/climit.clj`). The
alert `PenpotMcpClimitRejected` keys on `penpot_rpc_climit_rejected_total{name=~".*mcp.*"}`, so match the limit name
(for example `mcp-apply/by-team`) to tell the layers apart. The frontend retries a save refused this way; a
frontend older than 2026-11-09 retried only a 429 with no body, so deploy the frontend with or before the backend.

Rules for the agent (put them in the agent's instructions):

- Retry a read after the wait the error gives.
- Retry a write with the same `requestId`. A repeat that the backend already applied answers `alreadyApplied: true`
  and changes nothing (contract 2.11).
- Do not retry a validation error. Fix the call.
- A `revn` conflict means the file moved on. Read the file again.

Round 2 measures how these limits behave under load (section 3).

## 7. Security operations

- Token lifetime. A token created without an expiry lasts 90 days (`PENPOT_MCP_TOKEN_MAX_AGE`). Set a shorter age if
  your policy needs one (`rpc/commands/access_token.clj`).
- One token per client. Each OAuth client gets one token per profile. Approval again replaces that client's token
  and gives it the approved scopes. The hand-made token is not touched (contract 1.6, 1.7).
- Revocation. `delete-access-token` removes the row. Each adapter keeps a good token check for up to 60 s, so a
  revoked token can work on an adapter for that time. Rejected checks are kept for 5 s. A profile with MCP switched
  off is refused by the backend on every call, not only after the cache expires (contract 1.2).
- Render sessions. A render session lasts 10 minutes and is never renewed. It can call only the commands in
  contract 1.5. It cannot approve an OAuth request. The backend deletes it 10 minutes after it was created.
- `/metrics`. Do not expose it to the public. See section 5.2 for the rule.
- Tokens in URLs. Keep `PENPOT_MCP_ALLOW_QUERY_TOKEN` at `false` in backend mode. A token in a URL can end up in proxy
  logs and shell history (`backend/BackendSettings.ts`).
- Logs carry a fingerprint of a token, never the token (`backend/TokenDigest.ts`).
- Redis:
  - Use `rediss://` with TLS. The URI can carry a password, and the code accepts it (`backend/BackendSettings.ts`).
    The sample stack has no TLS.
  - Give the adapter a Redis user with only the commands it needs. The rate limit script uses `EVALSHA` and falls
    back to the full script when Redis does not know it (`backend/RedisRateLimiter.ts`). It also reads the time with
    `TIME`, and uses `HMGET`, `HSET` and `PEXPIRE`. The storage uses `GET`, `SET ... PX` and `DEL`
    (`sandbox/StorageStore.ts`). The export permits use `EVALSHA` (with `EVAL` as the fallback), `TIME`, `ZADD`,
    `ZREM`, `ZCARD`, `ZRANK`, `ZSCORE`, `ZRANGEBYSCORE`, `ZREMRANGEBYSCORE` and `PEXPIRE`
    (`utils/RedisExportPermits.ts`). The ops script also uses `EXISTS` (section 8.4).
  - Eviction. Every MCP key has a time to live. Under memory pressure, a `volatile-*` policy can evict MCP keys. With
    `noeviction`, a full Redis makes writes fail: the limiter falls back to its own bucket, and a storage save fails
    and is logged once. This is a recommendation. The code does not set a policy.
  - Version. Redis 5 or later. Both Lua scripts call `TIME` and then write, which Redis before 5 refuses. The sample
    stack uses `redis:7-alpine`.
  - Key prefixes, so you can scope an ACL and find the keys: `penpot.mcp.ratelimit.` and
    `penpot.mcp.sandbox.storage.`, each followed by the SHA-256 hex of the token. The export permits use three keys:
    `penpot.mcp.export.permits` (the permits), `{penpot.mcp.export.permits}:waiters` (waiting callers by arrival
    time) and `{penpot.mcp.export.permits}:seen` (the same callers by the time they last asked). The braces put all
    three in one Redis Cluster slot, so the scripts run on a cluster too.
  - The sample stack's Redis is not persistent (`mcp/deploy/compose.two-adapters.yaml`). A restart clears the limits
    and the storage.
- Secrets to keep out of git: the metrics token file (`mcp/deploy/secrets/mcp-metrics-token`), the Grafana password,
  the backend secret key.

## 8. Data

### 8.1 What agents write, and where

| Written by | Where | Notes |
|---|---|---|
| Every commit of a write | `file_change` row | One row per commit batch (`rpc/commands/files_update.clj`, `commit-batch!`) |
| A write that deletes or is large | Snapshot row. Label `mcp/<tool>/<time>/<request-id>` | Snapshots with an `mcp/` label are pruned to the 20 newest (contract 2.11) |
| Automatic snapshots and repairs | Snapshot row labelled `internal/...` | Deleted seven days after the write (`get-deletion-delay`, default 7 days) |
| `upload-file-media-object`, `create-file-media-object-from-url` | `file_media_object` and the object storage | Media of the file (`rpc/commands/media.clj`) |
| Client and hand-made tokens | `access_token` | The `token` column holds the raw token (`rpc/commands/access_token.clj`) |
| Render sessions | Session rows (the backend's session store) | Ten minutes. The backend deletes them after that (contract 1.5). |
| Audit rows and webhook events | `audit_log` | Only with the flags in section 2.1 |
| Limits | Redis, `penpot.mcp.ratelimit.*` | Expires after a few seconds |
| Sandbox `storage` | Redis, `penpot.mcp.sandbox.storage.*`, capped at 8 MB per token | Expires after the idle time (30 min) |
| Exports | Adapter disk, under `PENPOT_MCP_EXPORT_DIR` | Nothing removes them |

### 8.2 Growth and garbage collection

- `file_change`. Each commit batch writes a row with `deleted_at` one hour after the write
  (`files_update.clj`, `commit-batch!`). The objects GC runs daily at 00:00 and deletes rows whose `deleted_at` has
  passed (`tasks/objects_gc.clj`, `main.clj`). So a row lasts at least one hour and at most about a day, more if a run is missed.
- Cleanup timing. The objects GC runs at 00:00 server time and does not catch up a missed run. A backend that is down
  at midnight keeps about a day more of rows: about 375,000 more at the soak rate. With the run on time, a row lasts up
  to 25 hours, about 390,000 change rows at the soak rate.
- GC rate. A manual run deleted 86,305 expired rows in 28.8 s, about 3,000 rows a second. That is well above the soak
  write rate of about 15,600 rows an hour.
- Automatic snapshots are the larger growth under heavy agent writes. The backend takes one on every fifth revision
  (`enable-auto-file-snapshot`), and each one keeps a `file_data` payload for 7 days. The soak made about 1,420 an hour.
  Size for them when you enable the flag; it is not in the default flag set.
- The replay window. A repeated `requestId` is a replay while its `file_change` rows exist. That is at least one hour
  after the write, and up to the next daily GC run. Contract 2.11 quotes a code comment that says "about one hour".
  One hour is the minimum, not the maximum. Plan retries with that in mind.
- `file_gc` runs daily at 02:00. It does not delete `file_change`, snapshot or `file_data` rows. It marks unused media,
  thumbnails and fragments (`tasks/file_gc_scheduler.clj`, `tasks/file_gc.clj`).
- Growth, measured in round 2 (`mcp/packages/loadtest/scripts/round2/file-change-growth.mjs`). A bulk write of 5,001
  operations added 8 `file_change` rows and 143 KB: 1.6 rows and 28.6 KB per 1,000 operations. Under the soak mix,
  `file_change` grew by about 15,600 rows an hour (about 37 MB). The objects GC deletes these rows nightly. The soak ended before
  a scheduled run, so budget storage from the soak rate, not from the bulk figure.
- Export and import files are never removed by Penpot. Remove them yourself (section 8.4).

### 8.3 Backup and restore

- A Postgres dump holds the raw MCP tokens (`access_token.token`). Treat every dump as a secret.
- Redis is not in the Postgres dump. After a restore, the limits and the sandbox storage start empty.
- Tokens are signed with the backend's secret key (`rpc/commands/access_token.clj`). A restore into a backend with a
  different key makes the tokens fail.
- Round 2 restored a mid-soak dump (10:01 UTC) and ran the new backend on the copy: the whoami read and a write passed.
  The old backend was not run against that dump.

### 8.4 Deletion cascade

What Penpot does on its own:

- Deleting a profile (`rpc/commands/profile.clj`, `delete-profile`): the profile is marked deleted, its sessions are
  ended, and its owned teams are deleted with their projects and files (`tasks/delete_object.clj`). The change rows
  of those files are marked deleted (`delete_object.clj`, `:file`). The objects GC removes the marked rows on its next
  daily run.
- The token rows of a profile go when the profile row is removed. The foreign key cascades (migration `0099`).
- A deleted profile is refused. `check-profile!` finds no active profile and answers `profile-not-active`
  (`rpc/commands/mcp.clj`).
- Deleting a team deletes its projects and files in the same way (`delete_object.clj`, `:team`).

What Penpot does not do, and you must:

- Redis keys. They are named by the token digest. The ops script computes the digest from the `access_token` row,
  so it must run while that row exists.
- Export and import files on the adapter disks.
- Log files and any data your webhook consumers keep.

The script `mcp/packages/loadtest/scripts/ops/delete-agent-data.sh` removes the first two for one profile. Run it
before the profile is hard-deleted, because the digests come from the `access_token` rows. The guide's order:

1. Dry run: `delete-agent-data.sh --profile <uuid> --files-older-than <days>`. It prints the digests, the Redis keys
   and the old files, and changes nothing.
2. Check the list. The file step cannot pick the files of one profile. It lists old files under the roots. Decide
   whether to remove them.
3. Real run: the same command with `--yes`, with `OPS_PSQL` and `PENPOT_MCP_REDIS_URI` set.

For a team, run the script for each member profile. Read `mcp/packages/loadtest/scripts/ops/README.md` for the
options.

## 9. Known limits

- Very large pages. A write decodes and encodes the whole page it touches. On a page of about 59,000 shapes, a write
  takes about 0.4 s. Five agents writing that page miss the 3 s target (`mcp/docs/backend-mode-report.md`, open item
  2). Page splitting or partial re-encoding is the next step.
- The `execute_code` page cap. A page above 16 MB of JSON is refused with a message that names the page. The sandbox
  loads whole pages. A lazy facade would lift the cap (`mcp/docs/backend-mode-report.md`, open item 3).
- Text sizes are estimates. The backend has no font measurer. A text box carries `textLayoutState: "approximate"`
  until a browser opens the file and reflows it (contract 5, item 2).
- `set_text_style` and `apply_typography` change the whole text shape. Ranges are not styled (contract 5, items 3
  and 13).
- Variants. `combine_as_variants`, `switch_variant` and the other variant operations are not implemented (contract 5,
  items 6 and 10).
- Embedded raster images in an SVG are not uploaded by `import_svg`. Upload them with `import_image` (contract 2.14).
- `import_tokens_dtcg` does not refuse duplicate token names within a set (contract 5, item 11).
- Backend mode has no selection or viewport tools (contract 4.1).
- The font table and the token resolver live in TypeScript and in `common` (`mcp/docs/backend-mode-report.md`,
  open item 5).
- Write order across adapters was tested in round 2 at 10 and 18 writes a second (section 1.2). Higher rates were not run.
- Human edits. A second session that writes to a file while a person's tab has a queued save can make the tab drop one
  of its own buffered edits. The tab then sends stale coordinates on its next move. This is a pre-existing frontend
  defect (2023), not MCP code, and MCP load triggers it. In round 2 a human tab lost edits while five agents wrote to the
  same file; raw save p95 rose from 139 ms to 5,046 ms (gate 500 ms). The frontend fix is in `persistence.cljs` and
  `changes.cljs`. It is not re-run under load (C3 needs a frontend build). Until C3 passes, do not let agents write
  to a file that a person is editing.
- The snapshot path in the editor still builds the whole file. It takes about 3.5 s on a 100,000-shape file
  (`mcp/docs/backend-mode-report.md`, open item 6).
- Automatic snapshots cost a save on large files. In round 2 every fifth save on a 100,000-shape file took 6.8 to 19.8 s
  (11 of 59 saves); the others took about 200 ms. Size for this before you enable `enable-auto-file-snapshot`.

## 10. After a deploy

Smoke test:

1. Balancer health: `curl -s -i http://<balancer>/lb-healthz` returns `200` and `ok`
   (`mcp/deploy/README.md`, step a).
2. Each adapter: `/healthz` and `/readyz`.
3. The full smoke, from `mcp/packages/loadtest` after its build: `node scripts/smoke.mjs <mcp-url> <token-file> <vars.json>`.
4. Round-robin storage check, if you run two adapters: a value stored through one adapter is read back through
   the other (`mcp/deploy/README.md`, step c).
5. The rate limit check: 25 calls at once from one token admit about 20, not about 40 (`mcp/deploy/README.md`,
   step d).
6. Metrics: `node scripts/check-metrics.mjs <adapter-metrics-url>` in `mcp/packages/loadtest`, for each adapter.

Watch for one hour after each step:

- `probe_success` for both adapters and the backend (readiness).
- `penpot_mcp_redis_up` and `penpot_mcp_rate_limit_fallback_total`. Both should stay flat.
- `penpot_mcp_refusals_total` by reason. A rise means a client is trying what it should not.
- `penpot_mcp_export_busy_total` by gate. `process` and `shared` rises mean the render cap is full.
- `penpot_mcp_export_permits_held` by gate. The `shared` sum over the adapters, against `PENPOT_MCP_EXPORT_TOTAL_PERMITS`, shows how full the cap is.
- `penpot_mcp_errors_total` by code. Watch `mcp-file-busy` and `mcp-lock-timeout` most closely.
- `penpot_mcp_tool_duration_seconds` p95 for the write tools.
- `hikaricp_pending_threads` and `penpot_rpc_climit_rejected_total`.
- `penpot_mcp_sandbox_runtimes_disposed_total` rate and `penpot_mcp_active_sandboxes`.
- Adapter memory and event loop lag.
- The count of `file_change` rows for the busiest file. It should not rise without bound.

Stop and roll back if readiness fails on a backend and it does not recover, or if write errors rise together with
p95 latency.

## Open items

- The mixed-version and cross-adapter write results (section 4.3 and section 9).
- The rollback test with the previous backend, and the mid-soak dump (section 4.4 and section 8.3).
