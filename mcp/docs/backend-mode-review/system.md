# Backend-native MCP: system-level review

Scope: commits `2c33b0ff9a` and `541f965bf1` on `perf/render-wasm-large-files`. Read-only review. Nothing was
run: no tests, builds, REPL or network calls. Every claim below comes from reading the code and the documents.
"Confirmed" means the code path was read end to end. "Suspected" means the code suggests it and a run must settle it.

## Verdict

The design is sound at its core: one typed operation model, compiled by shared `common` code inside the backend,
committed through the same `update-file!` path as a human save, in one transaction. The seams around that core
are not ready for a hosted, multi-tenant release. A read-only token can grant itself every scope through the
render session, a write has no idempotency, the adapter holds per-process state that blocks scaling out, and the
package wiring may break the documented way to start the server. The performance claim rests on small samples,
on a fixture built by the system under test, and on a runbook that disagrees with the status report.

## 1. End-to-end traces

### 1.1 Read (`get_page_tree`)

1. Client -> nginx `/mcp/stream` -> adapter `/mcp` (`PenpotMcpServer.ts:498`). Token taken from the header or
   `?userToken=`; not checked here except at `initialize` when OAuth is on.
2. `BackendTool.executeCore` (`BackendTool.ts:41`): adapter rate limit (in-process bucket), then
   `BackendTokenValidator.validate` (`mcp-whoami`, cached 60 s), then the tool.
3. Tool: zod checks the arguments, maps `ellipse`/`board` names, calls `get-mcp-page-tree` with
   `Authorization: Token`.
4. Backend wrappers, outermost first (`rpc.clj:432-446`): authentication, params (malli), session restriction,
   MCP scope, audit, rlimit (Redis), metrics, climit (`:mcp-read/by-profile`, `:mcp-read/global`), DB transaction.
5. Command: `check-profile!`, `check-read-permissions!`, `bfc/get-file`, one page pointer loaded, cached in
   `page-cache` by `[file-id page-id revn]`, projection, cursor.
6. Adapter: JSON pretty print, cut to 1 MB with a truncation envelope.

### 1.2 Write (`apply_operations`)

1. Adapter: rate limit, whoami cache, `ApplyTokenValues.fill` (one `get-mcp-tokens` read when the call holds an
   `apply_token`), zod check of every operation, then `FileWriteQueue` (per token and file, in process), then
   `mcp-apply-operations`.
2. Backend: same wrappers; scope is `mcp:read` for a dry run, else `mcp:write`; climit
   `:mcp-apply/by-profile` (2), `:mcp-apply/global` (10), `:update-file/by-profile` (1).
3. `run-write` (`mcp_write.clj:568`): `check-profile!`, edit permission, file advisory lock, load the file,
   load and realise every linked library, compile (malli check per op, working copy, reflow), check change types,
   compiled count, media ownership, revn lag, split into batches, `update-file!` per batch (snapshot with the
   first), all in one transaction.
4. After commit: Redis cache invalidation and `:file-change` messages to open tabs. Audit event `update-file`
   and a webhook event.
5. Adapter: merges token warnings, returns JSON.

### 1.3 `execute_code`

1. Adapter: rate limit, whoami, one of 4 call slots, sandbox runtime of the token (QuickJS on the Node main
   thread).
2. The script queues operations in the guest; reads go out as host calls (each a backend RPC, up to 1000 per
   script).
3. `SandboxHost.flush`: fills token values, zod check, cuts into calls of at most 1500 operations, each a
   separate `mcp-apply-operations` transaction with its own `requestId`, under one hold of the write queue.
4. A failure in a later chunk leaves earlier chunks committed.

### 1.4 `export_shape`

1. Adapter: rate limit, whoami, `get-mcp-shapes` (existence check) or `get-mcp-page-tree` (page roots).
2. `RenderSessionCache.tokenFor`: `create-mcp-render-session` mints a real session row for the profile,
   restricted on RPC to seven read commands on the file and its libraries, 10 minutes.
3. Adapter posts to the exporter with that session as the `auth-token` cookie. The exporter opens a headless
   page, which reads the file through the backend with the cookie, renders, and uploads the result.
4. Adapter downloads the result from the origin the exporter names (or `PENPOT_MCP_ASSETS_URI`) with the cookie.
5. Up to 10 renders per `page` call, 4 at once per adapter process.

### 1.5 Where each duty sits

| Duty | Adapter | Backend | Verdict |
|---|---|---|---|
| Input validation | zod per op (loose objects) | malli per op (closed props), then file validation | Twice by design; the backend is the authority. Two hand-kept copies (SYS-08, SYS-17) |
| Authentication | whoami cache, 60 s | every RPC | Right. The adapter cache is an optimisation |
| Authorisation | none | scopes in `wrap-mcp-scope`, permissions per command | Right layer. Hole in the render session (SYS-01) |
| Rate limits | token bucket per process | rlimit (Redis, flag-gated), climit (per JVM) | Three layers with units that do not agree (SYS-11) |
| Write ordering | `FileWriteQueue` per process | file advisory lock, climit queue | Backend is enough for safety; the adapter queue only avoids queue errors and fails with N adapters |
| Batching | `execute_code` chunks of 1500; `batch_create_shapes` | `allow-split` batches of 300 creations | Two kinds of split with different atomicity: backend split is atomic, adapter chunks are not |
| Retries | none | none | Honest, but no idempotency either (SYS-02) |
| Token value resolution | TypeScript resolver, `rem` fixed at 16 px | trusts `resolved-value` | Wrong layer; a documented deviation (SYS-17) |
| Request correlation | none | own `::rpc/request-id` | Done nowhere across the hop (SYS-12) |
| Health and metrics | none | Prometheus, `/readyz` | Adapter half missing (SYS-12) |

### 1.6 Is the operation model the right abstraction?

Yes. Raw changes would make the internal change format the public interface and move geometry, layout and
component logic into the client. Finer RPC calls would lose the single transaction and multiply round trips.
The operation model keeps Penpot's own `common` code as the only writer of changes and gives the agent one
atomic call with `$tmp:` handles.

Two things weaken it. `apply_raw_changes` exposes the internal format anyway, under the same `mcp:write` scope
(SYS-18). And `execute_code` chunking brings back non-atomic writes one layer up.

## 2. Contract spot-check

| # | Contract statement | Code | Result |
|---|---|---|---|
| 1 | Adapter sends `Content-Type`, `Accept`, `X-Client: penpot-mcp`, `Authorization: Token` | `PenpotBackendClient.ts:158-165` | matches |
| 2 | Reads use `[[:mcp-read/by-profile ...]]` | every read also takes `[:mcp-read/global]` (16 permits), `mcp.clj:375` and `climit.edn` | drift: contract omits the global limit |
| 3 | Page summaries cached by `[file-id revn]` | keyed `[file-id vern pointer-id modified-at]` for pointer pages, `mcp.clj:429-447` | drift (code is better) |
| 4 | MCP session id is `uuid/v5 ns-mcp (token-id "/" request-id)` | `UUID/nameUUIDFromBytes` (v3) of `"penpot-mcp:" token-id ":" request-id`, `mcp_write.clj:247-252` | drift, harmless |
| 5 | Render session: "a real session row for the profile", 10 min | also restricted to 7 read commands on the file and its libraries, `rpc.clj:252-289` | contract omits the restriction, and its limits (SYS-01) |
| 6 | Change cap 2000, payload 8 MB, compiled cap 100000 by config | `mcp_write.clj:48-50, 143-157` | matches |
| 7 | Snapshot on delete, over 100 items, or `snapshot: true`; keep 20 | `mcp_write.clj:258-267`, `files_update.clj` `create-mcp-snapshot!` | matches |
| 8 | Token validation cached 60 s by SHA-256; 401 gives the rejection text | `BackendTokenValidator.ts`; 403 is mapped to the same rejection | matches, plus an undocumented 403 mapping |
| 9 | Adapter limit 10 rps, burst 20, "rate limited, retry after N s" | `TokenRateLimiter.ts`, `BackendSettings.ts:6-8` | matches |
| 10 | `PENPOT_MCP_MODE` default `both` | `both` only when `PENPOT_MCP_BACKEND_URI` is set, else `bridge`, `PenpotMcpServer.ts:142-155` | drift (README is right) |
| 11 | `get-mcp-shapes` result `{revn, shapes, missing}` | also `truncated`, and a cap of 2000 shapes with children, `mcp.clj:693-736` | drift |
| 12 | rlimit buckets `6000/3000/1h` reads, `1200/600/1h` writes | `rlimit.edn` | matches |
| 13 | Audit props and three Prometheus series | `mcp.clj:53-105`, `main.clj:87-104` | matches |
| 14 | `execute_code`: 5000-op cap, calls of 1500, dry run refused over 2000 | `SandboxHost.ts:85-92` | matches |
| 15 | Write tools accept `dryRun`, `snapshot`, `baseRevn`, `failOnConflict` | also `requestId`, `WriteOptions.ts:37-39` | contract omits `requestId` on tools |

Eleven of fifteen match. No mismatch is a behaviour bug by itself. The contract has no version number and no
change log, and the code does not check it (SYS-08).

## 3. State and scale

### 3.1 State that lives in one process

| State | Where | Effect with N instances |
|---|---|---|
| Write queue per token and file | adapter, `FileWriteQueue.ts` | parallel writes reach the backend; the sixth queued write per profile gets a climit error |
| Rate-limit buckets | adapter, `TokenRateLimiter.ts` | the limit becomes N times 10 rps |
| Sandbox runtime and `storage` per token | adapter, `SandboxSessions.ts` | `storage` appears empty when a call lands on another adapter |
| Render sessions | adapter, `RenderSessionCache.ts` | one more session row per adapter, file and token every 9 minutes |
| whoami cache | adapter | harmless |
| Export semaphores | adapter, `ExportConcurrency.ts` | export load on the one exporter grows with N |
| Sandbox call slots (4) and session cap (50) | adapter | per process |
| `page-cache` (256 entries), `outline-cache` (4096) | backend JVM, `mcp.clj:204, 398` | hit rate falls with N backends; bounded by count, not bytes |
| climit permits | backend JVM | "global" means per JVM |
| rlimit counters | Redis | truly global (when the `rpc-rlimit` flag is on) |
| Sessions, tokens, snapshots, file lock | Postgres | global |

### 3.2 What N adapters and N backends need

- Adapters: sticky routing by token (for `storage`, the write queue and the rate limit), or move those three
  out of the process. A health endpoint for the load balancer. Neither exists or is documented.
- Backends: nothing new for correctness. The file lock and the session rows are in Postgres. Caches and climit
  are per JVM, which is acceptable for heap protection but means the database sees N times the load.

### 3.3 The bottleneck as agents grow from 20 to 2,000

1. The adapter event loop. `execute_code` runs guest code on the Node main thread
   (`sandbox/WORKER_THREADS.md`). One script may use 10 s of CPU, and four may be admitted at once. While one
   runs, no other request on that adapter is served. This is the first thing to break in a shared adapter.
2. Sandbox memory: 50 sessions per adapter, each up to 256 MB hard, recycled above 128 MB (report open item 6).
3. `:mcp-apply/global`: 10 permits, queue 50, 60 s timeout per JVM. At 20 agents on separate files the run
   already logged 2,747 queue notices (`PERF-RUNBOOK.md:81`). Past about 60 writers per JVM, calls are refused.
4. The exporter: one shared service, also used by human exports, with no per-tenant fairness (SYS-13).

### 3.4 The bottleneck as files grow

1. Linked libraries: every write realises every library in full (SYS-06). Not measured.
2. Write cost grows with file size even on one page (runbook O3: 3.5 times slower at 95k shapes).
3. The file lock is held through compile and validation (SYS-07).
4. `page-cache` is keyed by revn and bounded by count. A write/read loop on a large page puts a new decoded
   page in the cache per revn, up to 256 of them, for 10 minutes each (SYS-10).

## 4. Failure modes

| Failure | What happens now | Acceptable? |
|---|---|---|
| Backend down | Every call fails fast with `got no response ... may or may not have been applied`, reads included (`PenpotBackendClient.ts:175-190`). At `initialize` the token check logs a warning and lets the session start. No circuit breaker, no adapter health endpoint to show it. | Yes for behaviour. The message misleads on reads. |
| Backend slow | The adapter waits up to 120 s, then aborts its request. Nothing cancels the backend call, so a write may commit after the adapter gave up. Later writes to the same file wait behind it in the adapter queue. | No, without idempotency (SYS-02). |
| Database slow | climit queues fill; calls fail after 30 s (reads) or 60 s (writes). A write holds the file lock and a pool connection through compile; human saves on that file wait. Reads hold a connection for their whole run, up to the 5 s search budget. | Partly. Not measured (C3). |
| Exporter down | `export_shape` fails on connect, or after 120 s when it hangs. Each attempt holds one of 4 export permits per adapter, so a hung exporter stalls all exports. Other tools are not affected. | Yes, with a shorter export timeout. |
| Redis or msgbus down | The write commits. The after-commit publish fails, is logged at WARN and dropped (`db.clj:598-599`). Open tabs do not see the change until their next save or a reload. rlimit and the OAuth state also use Redis; their behaviour was not traced. | Yes for data. Silent for users; needs a metric. |
| Adapter restart in a write | One `apply_operations` call: the backend finishes or rolls back as a unit; the client sees a dropped connection and cannot tell which. `execute_code` with several chunks: earlier chunks stay committed, later ones are lost, nothing records it. `storage` and the write queue are lost. `stop()` does not wait for sandboxes. | No for `execute_code`; unknown outcome for all writes (SYS-02). |
| Client disconnect in a call | The adapter runs the tool to the end; no abort reaches the backend. The write lands and the result is dropped. | Same as above. |
| Duplicate delivery or client retry | Applied twice. `request-id` is a label only (`mcp_write.clj:580`). Creates with `$tmp:` handles make duplicates. Creates with literal ids fail with "id already exists", which is accidental protection. | No (SYS-02). |
| Clock skew | Render session reuse compares the adapter clock with the backend's `expiresAt`; a wrong reuse is caught and re-minted (`recoverRenderSession`). Token expiry and the session age are judged by the backend. | Yes. |
| Human editing the same file | The file lock serialises commits; the agent compiles against the latest data inside the lock, so no change is lost. Attributes are last writer wins. `baseRevn` warnings are opt-in, read at most 500 rows, and `failOnConflict` is off by default. The tab gets the change live through msgbus. The browser half (C3, C4) was never run. One call may publish up to 100,000 changes in one message (SYS-19). | Design is right; unverified in a browser. |

## 5. Findings

Severity order. Effort: S under a day, M a few days, L a week or more.

### SYS-01. A read-only token can grant itself every scope through the render session

- Severity: high. Confidence: confirmed by reading; the exploit was not run.
- Location: `backend/src/app/http/mcp_oauth.clj:176-182` (`session-binding`), `:227-262` (`decision`),
  `:394-399` (routes behind `session/authz`); `backend/src/app/rpc.clj:252-289` (the restriction, RPC only);
  `backend/src/app/rpc/commands/mcp.clj:1102-1138`; `backend/src/app/http/session.clj:283-294`.
- What is wrong: `create-mcp-render-session` needs only `mcp:read`. It returns a real session token for the
  profile (`iss "authentication"`). The restriction on that session lives in `wrap-session-restriction`, which
  only RPC commands run. The OAuth consent endpoints `/api/mcp/oauth/request` and `/decision` authenticate with
  `session/authz` and `session/get-session` and never look at the restriction. The `Origin` check
  (`same-origin?`) is a browser defence; any HTTP client can set the header. The CSRF value is handed to the
  same session by the `request` endpoint.
- Failure scenario: a holder of an `mcp:read` token calls `create-mcp-render-session` for any file it can
  read, starts an authorization with `scope=mcp:write mcp:manage mcp:delete` (client registration is public),
  fetches `/request` with the cookie, then posts `/decision` with `decision=approve`. `grant-mcp-scopes`
  (`access_token.clj:131-145`) adds the scopes to the profile's one MCP token, which is the token the caller
  already holds. A stolen or over-shared read-only token becomes a delete-capable token. The scope model, the
  main new authorisation boundary of this feature, does not hold.
- Also exposed to the restricted session: `/ws/notifications` (`websocket.clj:306-353`), `/assets`, the OIDC
  routes, `/dbg`. None checks the restriction.
- Recommended change: enforce the restriction in `session/authz` itself. A session with `:mcp-render` props
  should be dropped from the request unless the route opts in (the RPC routes). Add a test that a render session
  gets 401 on `/api/mcp/oauth/request`, `/decision` and `/ws/notifications`. Longer term, give the exporter a
  token type of its own instead of a user session.
- Effort: S for the fix and tests.

### SYS-02. Writes have no idempotency; `request-id` is only a label

- Severity: high. Confidence: confirmed.
- Location: `backend/src/app/rpc/commands/mcp_write.clj:580` (default `uuid/next`), `:247-256` (used for the
  session id and snapshot label only); `mcp/packages/server/src/PenpotBackendClient.ts:175-190`;
  `mcp/packages/server/src/tools/backend/WriteOptions.ts:37-39`; `mcp/packages/server/src/sandbox/SandboxHost.ts:452`.
- What is wrong: neither side can tell that a write was already applied. The adapter is honest about it ("may
  or may not have been applied; check the file before retrying"), but an agent has no cheap way to check, and
  MCP clients and proxies retry on their own.
- Failure scenario: a 5,000-shape `execute_code` flush. The second chunk takes 121 s under load; the adapter
  aborts; the backend commits it anyway. The script fails with "no response", the agent runs it again, and the
  page holds 1,500 to 3,000 duplicate shapes. Nothing in the audit trail links the two runs.
- Recommended change: the commit already stores a session id derived from `(token-id, request-id)` in
  `file_change`. Before compiling, look for a row with that session id on the file; if one exists, return
  `{revn, alreadyApplied: true}`. Make the adapter send a stable `requestId` per tool call (and per chunk index
  in `execute_code`), and document that a client retry must reuse it. `file_change` rows expire, so state the
  window.
- Effort: M.

### SYS-03. The root `start` script now also runs the two harness CLIs

- Severity: high. Confidence: wiring confirmed; the effect on the running server is suspected and needs one run
  of `pnpm run start`.
- Location: `mcp/package.json:13` (`"start": "pnpm -r --parallel run start"`) and `:15` (`bootstrap`);
  `mcp/packages/loadtest/package.json:13`, `mcp/packages/design-parity/package.json:13` (both define `start`);
  `mcp/packages/design-parity/src/index.ts:322-327` (no command prints usage and returns failure);
  `mcp/bin/mcp-local.js:86` and `mcp/scripts/start-mcp-devenv` (both call `bootstrap`);
  `mcp/pnpm-workspace.yaml` (three new workspace packages); `mcp/scripts/build:24`.
- What is wrong: before this change only `server` and `plugin` had a `start` script. Now `pnpm run start`,
  `pnpm run bootstrap` and `npx @penpot/mcp` also start `mcp-loadtest` (prints usage, exits 0) and
  `mcp-design-parity` (prints usage, exits 1). A failing script in a recursive pnpm run normally fails the run.
  `bootstrap` also runs `pnpm -r install` and `pnpm -r run build`, so every local user now installs Playwright,
  Vite and React and builds the generated parity app. The Docker bundle script installs them too
  (`--filter "!mcp-plugin"`). `npm pack` has no `files` list and no `.npmignore`, so the published package
  carries both harnesses, a 22,196-line fixture, the generated app and the plan documents.
- Failure scenario: a user runs `npx -y @penpot/mcp@latest` after the next release; the server starts, then
  pnpm tears the run down because a sibling `start` exited 1. Or it survives, and the user has paid for a
  Playwright install to run an MCP server.
- Recommended change: rename the harness scripts (`cli`, not `start`), or filter the root scripts to
  `mcp-server` and `mcp-plugin`. Move the harnesses out of the default workspace install, or exclude them from
  `bootstrap`, `scripts/build` and the packed files. Add a `files` list to `mcp/package.json`.
- Effort: S.

### SYS-04. Every `apply_operations` call realises every linked library in full, inside the file lock

- Severity: high. Confidence: code path confirmed; the cost is suspected, since no scenario links a library.
- Location: `backend/src/app/rpc/commands/mcp_write.clj:381-389` (`library-map`), `:391-412`
  (`realize-pointers` derefs every file-level pointer and every page), `:473-481` (`compile-ops!` calls it on
  every call), `:617` (a dry run calls it a second time).
- What is wrong: the compiler receives every library of the file, each loaded with `bfc/get-file` and all its
  pages decoded, whether or not an operation uses a component or typography of a library. This runs after the
  file lock is taken, inside the transaction, under one of ten `:mcp-apply/global` permits.
- Cost scenario: a product file linked to a design-system library the size of the 100,000-shape reference
  file. The runbook measured that realising that file costs about 4.6 s and a 4.7 GB heap peak
  (`PERF-RUNBOOK.md:101-105`). Every one-rectangle write on the product file would pay a cost of that order,
  and ten concurrent writers would each hold a full copy. Linked libraries are the normal case for real teams.
  The load-test fixtures contain no linked library (`link_library` appears in no scenario), so no gate saw it.
- Recommended change: pass the compiler a lazy library lookup. Load a library only when an operation names it
  (`instantiate_component`, `swap_component`, `apply_typography`, `sync_components`, `set_tokens_source`), and
  load only `:components`, `:colors`, `:typographies` and the pages those components live on. Cache by
  `(library-id, revn)`. Add a load scenario with a large linked library.
- Effort: M.

### SYS-05. The runbook and the status report disagree, and the measured tree cannot be rebuilt

- Severity: medium. Confidence: confirmed.
- Location: `mcp/packages/loadtest/PERF-RUNBOOK.md:49` ("commit 27f3ec8e05 plus the working tree"), `:70`,
  `:79-80`, `:93-105`; `mcp/docs/backend-mode-report.md:60-78`; `mcp/docs/backend-mode-contract.md:197-198`.
- What is wrong: the report says the full gate table is in the runbook. The runbook says: MCP server RSS
  **fail** at 2,132 MB with defect D1 open; a snapshot on the large file adds about 4.6 s; large-file writes
  p50 522 ms, p95 5,206 ms. The report says: about 160 MB after hostile scripts; snapshot 1.3 to 1.7 s; large
  writes 205 ms and 1.86 s. The later figures have no run record in the runbook. The runbook was measured on an
  uncommitted tree, so no one can check out the code that produced any figure. Export (gate 1k) was "not
  measured this round"; the earlier run gave a p50 of 5.1 s against a p95 target of 5 s, which is a likely fail
  left unmarked.
- Cost: a maintainer cannot tell which gates passed on the committed code.
- Recommended change: re-run the gates on `541f965bf1`, record the commit in each result, update the runbook
  table and mark D1, O1 and O2 closed with their evidence. Mark the export gate as failing or re-measure it.
- Effort: S for the documents, M with the re-run.

### SYS-06. The load-test method does not support percentile claims

- Severity: medium. Confidence: confirmed.
- Location: `mcp/packages/loadtest/PERF-RUNBOOK.md:131-153`; `mcp/packages/loadtest/src/Runner.ts:349`,
  `:511-516`; `mcp/packages/loadtest/src/Statistics.ts`; `mcp/packages/loadtest/README.md:126`.
- What is wrong:
  - Sample counts. "Batch write p95 823 ms" comes from 7 calls, "bulk write" from 3, `execute_code` from 1,
    S4 from 11, the metadata read from "one sample only". With nearest-rank percentiles, p95 of 7 samples is
    the maximum.
  - Closed loop. Each agent sends its next call when the last returns, with an optional cap. Under saturation
    this hides queueing delay (coordinated omission). There is no open-loop arrival rate.
  - Warm-up is one manual C1 run, not a harness phase, and is not excluded per scenario.
  - One host runs the load generator, the adapter, the backend and Postgres. The DB pool was 8, below the 16
    read permits; `shared_buffers` 128 MB.
  - The large file is built through the MCP itself. Plan 8.6 asked for a generator built on `common`, "NOT
    through the system under test". The file therefore holds only what the MCP can make: no laid-out text, no
    human-made paths or images, no variants, no linked library.
  - Not covered: linked libraries, the `rpc-rlimit` flag (its state is not recorded), cold caches, files
    without pointer-map, the human tab, export, the soak, the plugin-bridge baseline, more than 20 agents, and
    agents that share one profile (each test agent has its own profile, which avoids every per-profile limit).
- Recommended change: set a minimum sample count per percentile (for example 200 for p95), add an open-loop
  mode with latency taken from the intended send time, add a warm-up phase that is not recorded, record the
  flags and pool size in the result, and add scenarios for a linked library and for many agents on one profile.
- Effort: M.

### SYS-07. A write holds the file lock, a transaction and its permits through CPU work

- Severity: medium. Confidence: confirmed; the effect on human saves is unmeasured (gate C3).
- Location: `backend/src/app/rpc/commands/mcp_write.clj:458-471` (lock before load), `:568-634`;
  read commands with `::db/transaction true`, for example `backend/src/app/rpc/commands/mcp.clj:605-620, 919-934`.
- What is wrong: the advisory lock is taken before the file and the libraries load and before the compile. A
  2,000-operation call may compile for seconds (the benchmark allows 5 s for 2,000 `update_shape`). For that
  time a human save on the same file waits on the lock while holding its own permit and connection. Reads also
  run in a transaction and hold a pool connection for their whole computation, including the 5 s search budget.
- Failure scenario: an agent bulk-writes a file a designer has open. Each designer save waits behind each agent
  call; the editor shows a long "saving" state. With SYS-04 the wait includes the library load.
- Recommended change: compile outside the lock against revn N, then take the lock, and recompile only if the
  revn moved. Run reads without a long transaction: read the file row and the fragments, release, then compute.
  Run C3 with a browser before release.
- Effort: M to L.

### SYS-08. No version or capability check between adapter and backend

- Severity: medium. Confidence: confirmed.
- Location: `backend/src/app/rpc/commands/mcp.clj:371-394` (whoami returns `version` and `features`);
  `mcp/packages/server/src/backend/BackendTokenValidator.ts:6-23` (typed, never read; no code under
  `mcp/packages/server/src` uses them); `mcp/docs/backend-mode-contract.md` (no version);
  `mcp/packages/server/src/tools/backend/operations/OperationSchemas.ts:1-10`.
- What breaks:
  - Adapter first, backend old: backend tools register, every call fails at `mcp-whoami` with a 404 that does
    not say "backend too old". In the implied `both` mode the plain names `execute_code`, `export_shape` and
    `import_image` now point at tools that cannot work.
  - Rolling backend deploy: calls land on old and new instances in turn and fail at random.
  - Backend first: safe. The old adapter does not call the new commands.
  - A new operation added to the compiler cannot be used through `apply_operations` until the adapter's zod
    list is updated. Drift fails closed, since the backend decides.
- The zod and malli schemas are two hand-kept copies. `sample-operations.json` is read only by the adapter
  test; no test feeds the same samples to the compiler.
- Recommended change: add `contractVersion` (an integer) and the list of operation names to `mcp-whoami`. The
  adapter checks it on first validation, logs a clear error and hides tools the backend lacks. Add a shared
  conformance fixture that both the common test suite and the adapter test read. Consider generating the zod
  shapes from the malli schema.
- Effort: M.

### SYS-09. Backend mode turns on by itself, and the backend half has no switch

- Severity: medium. Confidence: confirmed.
- Location: `mcp/packages/server/src/PenpotMcpServer.ts:142-155`; `docker/images/docker-compose.yaml:216-225`;
  `backend/src/app/http/access_token.clj:56-59`; `backend/src/app/rpc/mcp_scope.clj:31-38`;
  `docker/images/docker-compose.yaml:27` (`enable-mcp` in the default flags).
- What is wrong: an unset `PENPOT_MCP_MODE` means `both` when `PENPOT_MCP_BACKEND_URI` is set. Operators set
  that variable for `submit_feedback`. On upgrade, their plugin tools are renamed (`execute_code` becomes
  `execute_code_in_tab`) and `execute_code` becomes the sandbox facade. Only a log warning says so. On the
  backend, no flag gates the new commands. Once deployed, every existing MCP token holds `mcp:read` on the
  direct API for all files of its profile, `export-binfile` included, whether or not any adapter runs backend
  mode. Tokens do not expire by default, and they may sit in proxy logs (`?userToken=` is accepted by default,
  and nginx logs the request line).
- Failure scenario: a token that leaked into an access log last year could only reach a connected plugin tab.
  After the upgrade it reads every file of the profile offline, and with SYS-01 it can write and delete.
- Recommended change: add backend flags (for example `enable-mcp-backend` and `enable-mcp-backend-write`),
  off by default, checked in `run-tool` and in the `allow-token-types` branch of `wrap-authentication`. Make
  the adapter default `bridge` unless the mode is set. Note the change in the release notes through the normal
  changelog flow.
- Effort: S to M.

### SYS-10. Adapter state is per process and the sandbox blocks the event loop

- Severity: medium. Confidence: confirmed.
- Location: `mcp/packages/server/src/backend/BackendServices.ts:32-48`; `FileWriteQueue.ts`;
  `TokenRateLimiter.ts`; `sandbox/SandboxSessions.ts`; `sandbox/WORKER_THREADS.md`;
  `tools/backend/ExecuteCodeBackendTool.ts:115, 145`; `backend/src/app/rpc/commands/mcp.clj:204-205`.
- What is wrong: see section 3. Three points matter most. A CPU-bound script stalls every other tenant on the
  adapter for up to 10 s. `storage` is promised to last 30 minutes per token, which is false behind a
  round-robin load balancer. `page-cache` is bounded by 256 entries, not bytes, and keyed by revn, where the
  plan asked for a 512 MB bound.
- Recommended change: run each sandbox in a worker thread (the planned follow-up). Document sticky routing by
  token hash as a requirement, or drop the adapter-side queue and limiter in favour of the backend's. Bound
  `page-cache` by weight, and key pointer pages by fragment id and modification time, as the outline cache does.
- Effort: L for worker threads, S for the cache and the documentation.

### SYS-11. Three rate-limit layers with units that do not agree

- Severity: medium. Confidence: the configuration is confirmed; the behaviour with `rpc-rlimit` on is suspected.
- Location: `mcp/packages/server/src/backend/BackendSettings.ts:6-8`; `backend/resources/rlimit.edn:310-334`;
  `backend/resources/climit.edn:80-91`; `mcp/packages/server/src/sandbox/SandboxSettings.ts:10`.
- What is wrong: the adapter allows 10 requests per second per token (36,000 per hour). The backend bucket for
  reads holds 6,000 and refills 3,000 per hour, about 0.83 per second; writes refill 600 per hour, one per six
  seconds. One `execute_code` script may make 1,000 host calls. The whoami refresh also draws on the read
  bucket.
- Failure scenario: on a deployment with `rpc-rlimit` on, an agent that reads twice a second runs dry after
  about 85 minutes and then gets 429 errors, which the adapter shows as a generic backend error with no retry
  hint. An agent that writes once every three seconds runs dry after about two hours.
- Recommended change: pick one layer as the policy (the backend, since it is global) and derive the adapter's
  figures from it, or pass the backend's retry hint through. Record the flag state in every load-test result.
- Effort: S.

### SYS-12. No request id across the hop; the adapter has no health or metrics endpoint

- Severity: medium. Confidence: confirmed.
- Location: `mcp/packages/server/src/PenpotBackendClient.ts:158-165` (no id header);
  `mcp/packages/server/src/PenpotMcpServer.ts:421-426, 496-516` (one route, `/mcp`);
  `mcp/packages/server/src/backend/TokenDigest.ts` (12 hex of the SHA-256 of the token);
  `backend/src/app/rpc/commands/mcp.clj:115-122` (8 hex of the SHA-256 of the token id);
  `backend/src/app/rpc.clj:118` (the backend's own request id); `docker/images/docker-compose.yaml:216-225`.
- What is wrong: the adapter log line carries tool, token fingerprint, duration and outcome. The backend line
  carries tool, profile, file and a fingerprint of a different value. No field joins the two. The MCP
  `requestId` exists only on writes and is not in the backend log line. The adapter exposes no `/healthz`,
  `/readyz` or `/metrics`; plan 8.7 listed adapter metrics that were not built. The compose service has no
  health check. Backend metrics lack database time, cache hits and conflict counts from the plan.
- Cost: an operator asked "why did this agent's write take 40 s" must match log lines by time.
- Recommended change: generate a request id per tool call in the adapter, send it as `X-Request-Id`, log it on
  both sides and put it in the audit props. Use the token id from whoami for the adapter fingerprint so both
  sides print the same value. Add `/healthz` (process up) and `/readyz` (backend reachable) and a small
  `/metrics`.
- Effort: M.

### SYS-13. Exports have no per-tenant fairness and share the exporter with people

- Severity: medium. Confidence: the adapter side is confirmed; exporter capacity is suspected.
- Location: `mcp/packages/server/src/utils/ExportConcurrency.ts` (one static semaphore of 4 per process);
  `mcp/packages/server/src/tools/backend/ExportShapeBackendTool.ts:160, 210, 307`;
  `mcp/packages/server/src/sandbox/SandboxHost.ts:492, 532` (uses `withPermit`, the plugin-bridge semaphore,
  which is unbounded by default, not `withBackendPermit`).
- What is wrong: one rate-limited tool call with `shapeId: "page"` makes up to ten renders, each a headless
  page load of the file. The four permits are shared by all tokens on the adapter with no per-token share. The
  sandbox export path takes the other semaphore, so by default it is not bounded at all. The exporter is the
  same service that serves exports from the editor.
- Failure scenario: one agent loops page exports of a large file. It holds all four permits; other agents'
  exports queue; human exports from the editor slow down. With N adapters the exporter sees 4N renders at once.
- Recommended change: a per-token export limit (for example 1 at a time), `withBackendPermit` in the sandbox
  path, a shorter export timeout, and a concurrency limit in the exporter for MCP render sessions.
- Effort: S to M.

### SYS-14. The design-parity gates compare the system with itself

- Severity: medium. Confidence: confirmed.
- Location: `mcp/packages/design-parity/README.md:44-110`; `mcp/packages/design-parity/src/Paths.ts:26-39`;
  `mcp/packages/design-parity/app/src/` (59 generated files); `mcp/.prettierignore`.
- What is wrong:
  - `verify` checks the model pulled through the MCP read tools against the spec that was written through the
    MCP write tools. A fault shared by the write and read paths passes. The DOM gate checks the generated app
    against the model it was generated from, so it tests the generator, not the MCP.
  - The one independent oracle is the pixel step, which compares the exporter's render with the app. Its result
    "never changes the exit code", and its real-mismatch flag is "a guess, not a calibrated value".
  - Nothing opens the file in the editor, runs the frontend's validation, or compares with a twin built through
    the plugin, as plan 9.3 asked.
  - `Paths.ts` defaults to `C:/Users/colli/AppData/Local/Temp/claude/.../scratchpad/mcp-token.txt`, a vars file
    in the same session folder, and `C:/dev/penpot/frontend/resources/fonts`. The README tells the reader to
    run from `C:/dev/penpot/mcp`. The committed app holds the UUIDs of one build on one machine.
- CI: the unit tests run in CI today. The real run needs a live backend and exporter, a seeded profile and
  token, Playwright browsers and a container for screenshots; none of that is scripted.
- What to commit: `fixtures/design.json` and the four smaller fixtures are test inputs and belong in the repo,
  though a trimmed design fixture would do. The generated `app/src/components`, `app/src/screens`, the CSS and
  `index.html` are build output and should be ignored; keep the one golden file.
- Recommended change: make the pixel step a gate with a calibrated budget, add a frontend validation step
  (load the file with the frontend's `validate-file` in a headless run), remove the machine paths (require the
  environment variables), and stop committing generated output.
- Effort: M.

### SYS-15. `execute_code` is not atomic above 1,500 operations, and nothing records a partial run

- Severity: medium. Confidence: confirmed (the contract states the behaviour; the gap is the missing record).
- Location: `mcp/packages/server/src/sandbox/SandboxHost.ts:77-92, 329-441`.
- What is wrong: `apply_operations` promises one transaction. `execute_code`, the tool most agents will reach
  for, commits in chunks, each its own transaction and its own snapshot decision. A failure or adapter restart
  between chunks leaves a half-built design. Each chunk has a random `requestId`, so the chunks of one script
  cannot be found as a group in snapshots, the audit log or `file_change`.
- Recommended change: derive the chunk ids from one script id (`<script-id>/<n>`), put the script id in the
  audit props, and take the snapshot before the first chunk so one restore undoes the whole script. Consider
  sending large flushes as one `allow-split` call, which the backend already commits atomically.
- Effort: S to M.

### SYS-16. Deployment, operator documents and agent memories were not updated

- Severity: medium. Confidence: confirmed.
- Location: `docker/images/docker-compose.yaml:216-225` (no backend-mode settings);
  `mcp/packages/server/src/backend/BackendSettings.ts:10` (exporter default `http://localhost:6061/`);
  `.serena/memories/mcp/core.md:116-123`; `.serena/memories/backend/auth-permissions-product-domains.md:18`;
  `docs/mcp/index.md` and `docs/technical-guide/configuration.md` (no change); `mcp/README.md:292-316`.
- What is wrong:
  - In the shipped compose file the exporter is `penpot-exporter:6061`. With the default, `export_shape` fails
    out of the box. No compose entry shows `PENPOT_MCP_MODE`, `PENPOT_MCP_EXPORTER_URI` or the internal backend
    URI.
  - The memories, which `AGENTS.md` names as the primary guidance, still say an MCP token "reaches only
    commands with `::rpc/token-type "mcp"` ... Currently only `send-mcp-feedback`", and that the only backend
    tool is `SubmitFeedbackTool`. About sixty commands now opt in (the table in contract section 1). The next agent to touch auth will read a false
    security statement.
  - The backend keys `mcp-token-max-age` and `mcp-max-compiled-changes` are in no operator document. The README
    omits `PENPOT_MCP_SANDBOX_WALL_S`, `_MAX_HOST_CALLS`, `_MAX_SESSIONS` and `_MAX_CONCURRENT`.
  - No rollback note: a rollback of the backend leaves `mcp:*` entries in `perms` and `props` on session rows,
    both harmless, but nobody wrote that down.
- Recommended change: add the backend-mode block to the compose file, update the two memories and add a
  `backend/mcp` memory, document the config keys, and add an upgrade and rollback section to the README.
- Effort: S.

### SYS-17. The same knowledge is kept by hand in several languages

- Severity: low. Confidence: confirmed.
- Location and copies:
  - Operation vocabulary, five places: `common/src/app/common/mcp/operations.cljc` (malli),
    `mcp/packages/server/src/tools/backend/operations/OperationSchemas.ts` (zod),
    `mcp/docs/backend-mode-contract.md:281-331`, the description string in `ApplyOperationsTool.ts:78-102`,
    `mcp/packages/server/data/backend_instructions.md`.
  - Fonts, three places: `common/src/app/common/fonts/builtin.cljc`, `mcp/packages/server/data/fonts.json`
    (a hand-cut list of Google fonts), `mcp/packages/design-parity/src/FontMap.ts`.
  - Token type aliases: the compiler, `mcp/packages/design-parity/src/TokenTypes.ts`.
  - Token value resolution: `mcp/packages/server/src/sandbox/TokenResolver.ts` (511 lines, `rem` fixed at
    16 px) next to the frontend's resolver. The backend trusts the `resolved-value` the client sends.
  - Limits: 2000 operations (backend, zod, sandbox dry run), 1500 and 5000 (sandbox), 200 ids (malli and zod),
    8 MB (backend) against 32 MB (adapter body) and 64 MB (adapter response).
  - Type aliases: `BackendShapeTypes.ts` against the backend type names.
- Cost: each new operation or font needs up to five edits; a missed one fails closed at best and misleads the
  agent at worst (the description string is what the model reads).
- Recommended change: serve the operation list, the limits and the font table from the backend (a
  `get-mcp-capabilities` command, or more fields on whoami) and build the tool description from it. Resolve
  token values in the backend once the resolver exists in `common`.
- Effort: M.

### SYS-18. `apply_raw_changes` makes the internal change format a public interface

- Severity: low. Confidence: confirmed.
- Location: `backend/src/app/rpc/commands/mcp_write.clj:55-57, 679-698`;
  `mcp/packages/server/src/tools/backend/ApplyRawChangesTool.ts`.
- What is wrong: with `mcp:write` a caller may send any change type but four. The change schema is internal
  and moves with file migrations. The raw path skips the operation-level rules: structural keys, token value
  checks, layout order, reflow. File validation still runs.
- Recommended change: put it behind its own scope (for example `mcp:raw`) or a backend flag, off by default,
  and say in the contract that the change format is not stable.
- Effort: S.

### SYS-19. One notification may carry up to 100,000 changes

- Severity: low. Confidence: suspected; a run with an open tab settles it.
- Location: `backend/src/app/rpc/commands/mcp_write.clj:143-157, 308-319`;
  `backend/src/app/rpc/commands/files_update.clj` (`send-notifications!`).
- What is wrong: without `allow-split` the whole call is one batch, so one `file_change` row and one
  `:file-change` message hold every compiled change, up to the cap. The message goes through Redis pub/sub and
  a websocket frame to every open tab, which applies it on the main thread. Plan 8.3 asked for this to be
  measured in C3; it was not.
- Recommended change: cap the changes per notification (send "reload" above a threshold), or always split the
  commit at a size bound. Measure tab apply time.
- Effort: S to M.

## 6. Operability summary

| Topic | State |
|---|---|
| Metrics | Backend: three MCP series plus the existing RPC and update-file series. Adapter: none. |
| Logs | One line per tool call on each side; no shared id (SYS-12). Tokens are never logged; fingerprints differ. |
| Audit | Good. Writes appear as `update-file` with `tool`, `token-id`, revn before and after; webhooks match the human path. Chunks of one script are not grouped (SYS-15). |
| Tracing | None across the hop. |
| Health | Backend `/readyz`. Adapter: none. |
| Configuration | Adapter validates most values at start and fails with the variable name. `PENPOT_MCP_BACKEND_MAX_RESPONSE_MB` falls back silently. Sandbox values are read when the services are built. |
| Unsafe defaults | `PENPOT_MCP_ALLOW_QUERY_TOKEN=true`; MCP tokens never expire; mode implied as `both`; no backend flag; exporter URI default wrong for compose; `PENPOT_MCP_EXPORT_DIR` defaults to the home directory. |
| Secrets | Raw tokens live only in the request context; caches key on SHA-256. Render-session tokens are cached in memory. Good. |
| Deployment | Image exists (`docker/images/Dockerfile.mcp`); compose has no backend-mode settings (SYS-16). |
| Upgrade and rollback | Backend first is safe. No version check (SYS-08). No written rollback. |
| Kill switch | Adapter: `PENPOT_MCP_MODE=bridge` hides the tools. Backend: only `enable-mcp`, which also stops the plugin bridge (SYS-09). |

## 7. Security posture

- Trust boundaries: client to adapter (token only), adapter to backend (the token is passed through; the
  backend re-checks every call, which is right), adapter to exporter (render session cookie), exporter to
  backend (cookie plus shared key).
- A stolen MCP token: reads every file of every team of the profile, exports them as archives, and, through
  SYS-01, writes and deletes. Without SYS-01 the scope model would hold.
- A compromised adapter: sees every token that passes through it and every render session. It holds no
  credential of its own, which limits the damage to the users who connect while it is compromised.
- Tenant isolation: data isolation rests on the backend's permission checks per command, which is the same
  code as the human path. Availability isolation is weak in the adapter: shared event loop, shared export
  permits, shared sandbox slots (SYS-10, SYS-13).
- Abuse cost: bounded for writes (caps on operations, payload and compiled changes; climit). Not well bounded
  for library-linked writes (SYS-04), exports (SYS-13) and `export-binfile` with `mcp:read`.

## 8. Strengths worth keeping

- One commit path. `update-file!` serves human and MCP writes, so the lock, revn and vern checks, validation,
  audit and webhooks cannot drift apart.
- One transaction per call, with notifications and cache invalidation after the commit. This also fixed a
  latent fault in the human path.
- The compiler is pure CLJC, runs on the JVM and in ClojureScript, and reuses the editor's own geometry,
  layout and component code.
- Scopes fail closed: an old token holds read only, and a dry run needs read only.
- The adapter never retries a write and says plainly when the outcome is unknown.
- The adapter never stores a raw token; it keys every cache on a digest.
- Response and body caps on both sides; SSRF rules on URL imports; the export directory check.
- The climit design leaves room for people: MCP takes at most two of the six per-profile update slots.
- A failed call names the operation that failed; the error codes are stable.
- The contract document exists and is mostly true to the code.

## 9. Questions only a run can settle

1. Does `pnpm run start` (and so `npx @penpot/mcp`) still keep the server up now that two more packages
   define `start`? (SYS-03)
2. Does the render-session cookie get a 200 from `/api/mcp/oauth/request` and `/decision`? (SYS-01)
3. What does one small write cost on a file linked to a 100,000-shape library? (SYS-04)
4. How long does a human save wait while an agent bulk-writes the same file, and how long does a tab take to
   apply a 300-object and a 10,000-change notification? (SYS-07, SYS-19)
5. When the adapter aborts at its timeout, does the backend commit the write? (SYS-02)
6. With `rpc-rlimit` on, when does a normal agent session hit the bucket, and what does the agent see? (SYS-11)
7. While one script burns its 10 s CPU budget, what is the latency of another agent's `whoami`? (SYS-10)
8. With an old backend, what does an agent see from the new adapter in `both` mode? (SYS-08)
9. With Redis down, does a write succeed, and does rlimit fail open or closed?
10. How much heap do 256 `page-cache` entries of a 2,500-shape page take? (SYS-10)
11. Export p95 on the committed code, the 4 hour soak, and the plugin-bridge baseline (report open item 1).
