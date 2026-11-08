# Round-2 review (Fable): fixes after the second production-readiness round

Date: 2026-11-08. Branch `perf/render-wasm-large-files` at `e4084f80b2`, dirty tree (the "Fixes after
round 2" of `mcp/docs/production-readiness.md`). Read-only review of `git diff` and the untracked files,
except `frontend/src/app/main/data/changes.cljs`, `persistence.cljs` and `frontend/test/` (another agent).

Checks run here: `pnpm run types:check` in `mcp/packages/server` (clean) and the server unit tests for
`RedisExportPermits`, `ExportConcurrency`, `CallSlots`, `SandboxSessions`, `ProcessMetrics` and
`BackendServices` (59 tests: 54 pass, 5 skipped for want of `PENPOT_MCP_TEST_REDIS_URI`). The backend
tests and the load tests were not run. "Verified" below means the claim was checked against the code
named; "not verified" means it rests on reading alone.

## Summary

| Severity | Count | Findings |
|---|---|---|
| blocker | 1 | F2-01 |
| major | 2 | F2-02, F2-03 |
| minor | 9 | F2-04 to F2-12 |
| note | 8 | F2-13 to F2-20 |

Confirmed defects: F2-01 to F2-05. Risks: F2-06 to F2-09. Doc mismatches: F2-10 to F2-12. Notes: F2-13
to F2-20.

The keep-alive question (area 3): the adapter keeps an idle connection 65 s by default
(`PenpotMcpServer.ts:81`, set at `:1076`), with `headersTimeout` at 66 s (`:1077`); nginx closes idle
upstream connections at 60 s (`mcp/deploy/nginx.conf:41`), with `proxy_http_version 1.1` and an empty
`Connection` header, which the `keepalive` directive needs. The server side stays open 5 s longer than
the proxy, and `headersTimeout` exceeds `keepAliveTimeout`, which Node requires. That holds. Verified.
The margin is only 5 s, and both values are set by hand in two places; an operator who raises the nginx
value without `PENPOT_MCP_KEEPALIVE_S` brings the 502s back (see F2-11 for the docs that should say so).

## Confirmed defects

### F2-01. A concurrent rate-limit wait leaks a global `execute_code` slot for good

- Severity: blocker. Area: adapter, sandbox.
- Files: `mcp/packages/server/src/sandbox/CallSlots.ts:106-139` (`SlotHolder`),
  `mcp/packages/server/src/sandbox/SandboxHost.ts:940-958` (`takeRateToken`),
  `mcp/packages/server/src/sandbox/SandboxWorkerRuntime.ts` (`serveHostCall`, `beginHostCall`).
- What is wrong: `SlotHolder.take()` does `this.release = await this.slots.acquire()`. It overwrites
  any release function it already holds. `yieldForWait()` calls `free()` (a no-op when nothing is held)
  and hands back `() => this.take()`. The worker runtime serves host calls concurrently: each
  `host-call` message runs `void this.serveHostCall(...)`, and `pendingHost` counts them
  (`beginHostCall` has `if (call.pendingHost === 1)`, so more than one is expected). A script that runs
  two primitives at once (`Promise.all` of two reads) and hits the rate limit on both calls
  `takeRateToken` twice at the same time. Each call sets `resume ??= this.waitHook?.()` on its own.
  The first `yieldForWait()` frees the slot; the second finds nothing to free but still returns
  `take`. When both waits end, `take()` runs twice: the second call overwrites the release function of
  the first, so one `CallSlots` permit is never given back. `slot.free()` in the tool's `finally`
  releases only the last one. Every such event removes one of the 20 global slots until the process
  restarts; after 20 of them every `execute_code` call waits 60 s and fails as busy.
- Evidence (`CallSlots.ts`):
  ```ts
  public async take(): Promise<void> {
      this.release = await this.slots.acquire();
  }
  public yieldForWait(): () => Promise<void> {
      this.free();
      return () => this.take();
  }
  ```
  and (`SandboxHost.ts:954`) `resume ??= this.waitHook?.();` inside a method that several primitives
  run at once.
- Verified: by reading the three files. The new test
  (`SandboxHost.test.ts`, "a rate-limit wait gives the script's global slot back") drives one flush
  only, so it does not reach the case.
- Fix: make the holder count its waiters. `yieldForWait()` increments a counter; it frees the slot only
  when the counter goes from 0 to 1. The returned resume decrements the counter and takes a slot only
  when it goes back to 0 and the holder holds none. Also make `take()` refuse (or return at once) when
  a slot is already held, so the invariant cannot be broken again from another call site.
- Test: yes. Two primitives that wait for a rate token at once; assert `slots.running` is 1 after both
  resume and 0 after `free()`. Repeat the pair 25 times against `CallSlots(20, ...)` and assert the
  21st script still gets a slot.

### F2-02. `unknown-shape` warnings fire for shapes the same call creates

- Severity: major. Area: backend, write path.
- Files: `backend/src/app/rpc/commands/mcp_write.clj:546-573` (`unknown-shape-warnings`), `:897`
  (its call site in the shared write body, used by all three write tools).
- What is wrong: the function flags every `:mod-obj` or `:del-obj` whose id is not in the page objects
  of `file`, the file as loaded before the call. Two documented, common cases modify a shape that the
  same call adds: a later operation that names a `$tmp:` handle of an earlier `create_*`
  (`mcp/docs/backend-mode-contract.md:487-488`: "later ops reference it"), and the layout reflow,
  which `reflow-pages` (`common/src/app/common/mcp/operations/state.cljc:458-473`) emits through
  `lm/generate-reflow` as `mod-obj` changes for the children of a new flex board. Both produce
  `{:kind "unknown-shape" ...}` warnings, and the docstring tells the agent "such a change changes
  nothing", which is false here.
- Evidence:
  ```clojure
  (when (and (contains? #{:mod-obj :del-obj} (:type change))
             (some? (:page-id change))
             (some? (objects (:page-id change)))
             (not (contains? (objects (:page-id change)) (:id change))))
    {:kind "unknown-shape" ...})
  ```
  where `objects` reads `(get-in file [:data :pages-index page-id])` of the pre-call file.
- Verified: by reading the code and the contract; not run.
- Fix: track the ids that earlier changes of the same call add (`:add-obj` ids, in order) and skip
  them; or compute the warning while the changes are applied, where the current objects are known. Keep
  the check for `mcp-apply-changes` (raw) where it was aimed; for the operation tools the compiler
  already refuses an unknown id (`:mcp-unknown-id`).
- Test: yes. An `apply_operations` call with `create_board` (flex layout) plus two `create_rect` children,
  and one with `create_rect` as `$tmp:a` followed by `set_name` on `$tmp:a`; assert no `unknown-shape`
  warning. Keep the existing raw-change test.

### F2-03. A read can migrate and persist a file outside a transaction

- Severity: major. Area: backend, reads.
- Files: `backend/src/app/rpc/commands/mcp.clj:227-251` (`get-file-root`);
  `backend/src/app/binfile/common.clj` (`migrate-file`, `update-migrated-file!`, `get-file` on
  `db/run!`); `common/src/app/common/files/migrations.cljc:58-64` (`need-migration?`).
- What is wrong: the six read commands lost `::db/transaction true`. `get-file-root` decides to open a
  transaction only when `(:version mfile) < fmg/version`. But `bfc/get-file` migrates when
  `fmg/need-migration?` is true, and that is also true when the file's `file_migration` rows lack a
  named migration, whatever the version. Named migrations ship without a version bump: `0033-normalize-main-instance-names`
  came in `a5f75c7394` and `cfd/version` stayed 67 (`defaults.cljc:12`). For such a file the read
  runs `bfc/get-file` through `db/run!` (one pooled connection, autocommit), `migrate-file` is not
  read-only there, and `update-migrated-file!` runs `UPDATE file`, `upsert-migrations!` and
  `fdata/upsert!` as separate statements. A failure between them leaves a file row that says the
  migration ran with data that does not match. The comment above the code says "Any other read stays
  out of one", so the gap is by design of the check, not an oversight of the author's intent, but the
  check is too narrow.
- Evidence (`mcp.clj:241-246`):
  ```clojure
  (let [migrate? (or (nil? mfile)
                     (< (:version mfile) fmg/version))
        file     (if migrate?
                   (db/tx-run! cfg (fn [cfg] (bfc/get-file cfg file-id)))
                   (bfc/get-file cfg file-id))]
  ```
  and `need-migration?`:
  ```clojure
  (or (nil? (:version file))
      (not= cfd/version (:version file))
      (boolean (->> (:migrations file #{}) (set/difference available-migrations) (not-empty))))
  ```
- Verified: code and git history. Not run.
- Fix: open the transaction on every cache miss (`db/tx-run!` around `bfc/get-file` whatever the
  version); a miss is rare once the root cache is warm, so the per-transaction cost the change wanted
  to avoid stays small. Or pass `:read-only? true` on the non-transactional path and let the write path
  persist the migration, if a stale `file_migration` set is acceptable until the next write.
- Test: yes. Delete one `file_migration` row of a fixture file at the current version, read it with
  `get-mcp-file-outline`, and assert (with `with-redefs` on `db/tx-run!` or on `update-migrated-file!`)
  that the persistence ran inside a transaction.

### F2-04. The project touch can move `modified_at` backwards

- Severity: minor. Area: backend, write path.
- Files: `backend/src/app/rpc/commands/files_update.clj:1100-1102` (`sql:touch-project`), `:1128-1131`.
- What is wrong: the statement writes the request timestamp (`::timestamp`, taken when the call
  started) whenever the stored stamp is older than 5 s. A long call (the budget allows 60 s) that starts
  at T, while another writer touches the project at T+50 s, writes T at T+60 s: the stamp goes back 50 s.
  The dashboard orders projects by this column.
- Evidence:
  ```sql
  UPDATE project SET modified_at = ?
   WHERE id = ? AND modified_at < now() - interval '5 seconds'
  ```
- Verified: by reading. The new test (`write-touches-the-project-only-when-its-stamp-is-stale`) covers
  the 5 s rule only.
- Fix: `SET modified_at = GREATEST(modified_at, ?)`, or write `now()`.
- Test: yes, one case with a stored stamp newer than the request timestamp but older than 5 s.

### F2-05. The zero-initialised label lists do not match what the code records

- Severity: minor. Area: backend, metrics.
- Files: `backend/src/app/main.clj:60-150`; `backend/src/app/rpc/commands/mcp.clj:87-90`
  (`error-code`), `mcp_write.clj:242-247` (`change-types`);
  `common/src/app/common/files/changes.cljc` (`process-change` methods).
- What is wrong: `mcp-change-types` lists `assign`, `set`, `set-touched` and `set-remote-synced`, which
  are operation types inside a `mod-obj`, not change types: `process-change` has no such methods, so
  those 12 series (3 tools) can never move. It misses `set-comment-thread-position`, which is a change
  type. `mcp-error-codes` lists `mcp-scope-required`, which `wrap-mcp-scope` raises before `run-tool`,
  so `record-error` never records it (11 dead series), and misses codes `run-tool` does record:
  `object-not-found` (from `check-read-permissions!`, `permissions.clj:92-94`), `profile-blocked`,
  `profile-not-active`, `mcp-compile-failed`, `mcp-invalid-operation`, `mcp-unknown-id`, `vern-conflict`
  and `revn-conflict`. For those, R2-12 (the first event after a restart is invisible to `rate()`) still
  holds. The cardinality is bounded (the codes come from code, not input), so this is a consistency
  gap, not a leak.
- Verified: `grep "defmethod process-change :"` (41 methods) against the list; `run-tool` and the
  permission helper.
- Fix: build the change-type list from `(keys (methods cpc/process-change))` and keep one shared
  vector of MCP error codes that `main.clj` and the raising sites both use. Until then, add a test that
  compares the three lists with the code.
- Test: yes. `(= (set mcp-change-types) (set (map name (keys (methods cpc/process-change)))))`, and a
  grep-style test over the `:code :mcp-*` literals of the two namespaces.

## Risks

### F2-06. The shared export cap drops silently and leaves no trace in `/metrics`

- Severity: minor. Area: adapter, export permits.
- Files: `mcp/packages/server/src/utils/RedisExportPermits.ts:166-193`, `:217-223`;
  `mcp/packages/server/src/PenpotMcpServer.ts:977-990` (metrics families);
  `mcp/deploy/alerts.yml:97-115`.
- What is wrong: when `store.take` throws, `acquire` returns a no-op release and the render goes on
  under the per-process gate alone, so N adapters send up to 4N renders. That is the documented choice.
  But the count (`fallbackCount`) is not exported, unlike `penpot_mcp_rate_limit_fallback_total`, and
  `penpot_mcp_redis_up` reads only the rate limiter's client (`RedisRateLimiter.available`). The permit
  store and the storage store have their own connections, so the alert `PenpotMcpRedisDown` ("cannot
  reach Redis for the rate limiter and sandbox storage") can stay green while exports have lost their
  shared cap, and nothing fires. A take that fails after earlier polls found the set full also lets the
  call through at once.
- Evidence (`RedisExportPermits.ts:175-180`):
  ```ts
  } catch (error) {
      this.recordFailure(error);
      return async () => undefined;
  }
  ```
- Verified: code. The behaviour itself is covered by the test "a take that throws lets the call go on".
- Fix: export `penpot_mcp_export_permit_fallback_total` from `RedisExportPermits.fallbackCount` and add
  it to `PenpotMcpRateLimitFallback` (or a sibling rule); make `penpot_mcp_redis_up` the AND of the
  three clients, or export one gauge per client.
- Test: yes, a `/metrics` test that the family exists when Redis is configured.

### F2-07. The write limiter looks the team up while it already holds three permits

- Severity: minor. Area: backend, climit.
- Files: `backend/src/app/rpc/commands/mcp_write.clj:1013-1026` (`team-of-file`, `team-key`), `:1036`,
  `:1064`, `:1093` (`::climit/id` vectors); `backend/src/app/rpc/climit.clj` (`wrap`, the `reduce`).
- What is wrong: `wrap` reduces over the declared limits in order, so the first declared is innermost.
  `[:mcp-apply/by-team team-key]` is declared first, so the request takes `mcp-update-file/by-profile`,
  `mcp-apply/global` and `mcp-apply/by-profile` before the team query runs. Each write therefore holds
  three permits for the duration of one indexed SQL round trip on the pool, and a slow pool wait for that
  query is charged to the limiters, not to the request. Correctness is fine: the key is a UUID or nil
  (unkeyed), and params are validated before `climit/wrap` runs (`rpc.clj:513-525`), so `(:file-id
  params)` is a UUID. Verified.
- Fix: declare `[:mcp-apply/by-team team-key]` last, so it is outermost and the lookup runs before any
  permit is taken; or resolve every key before the first acquisition in `climit/wrap`.
- Test: optional. The existing `write-commands-declare-the-team-limit` counts occurrences only.

### F2-08. The permit lease equals the render timeout to the millisecond

- Severity: minor. Area: adapter, export permits.
- Files: `mcp/packages/server/src/backend/BackendServices.ts:73-77` (lease =
  `ExportConcurrency.RENDER_TIMEOUT_MS`), `mcp/packages/server/src/utils/ExportConcurrency.ts:47`,
  `:106-124`, `:197-213`.
- What is wrong: a permit is taken after the slot waits and released by the `finally` at the 60 s
  deadline, so it is held at most 60 s minus the wait. The lease is 60 s. That fits, with no margin.
  The two values are separate constants; a later change of `RENDER_TIMEOUT_MS`, or a `timeoutMs` option
  above 60 s on a new call site of `withBackendPermit`, lets a permit expire while its render runs, and
  the cap is exceeded without a log line. Today no call site passes `timeoutMs` (verified by grep).
- Fix: derive the lease from the timeout in one place (`timeoutMs + 5_000`), and assert in
  `RedisExportPermits` that `leaseMs >= timeoutMs`.
- Test: a constructor test that a lease below the timeout throws.

### F2-09. `applyLoaded` keeps a runtime's storage when the shared copy is gone

- Severity: note. Area: adapter, sandbox storage.
- Files: `mcp/packages/server/src/sandbox/SandboxSessions.ts` (`applyLoaded`, `pendingText`).
- What is wrong: an `absent` load sets `storageHash` to undefined but leaves the runtime's storage. The
  next save writes it back. After a Redis restart (the sample Redis is not persistent) a warm runtime
  resurrects its storage while a fresh runtime on another adapter starts empty; whichever saves last
  wins. Not a loss of data the user saved on purpose, and the window is one call. Verified by reading.
- Fix: none needed; document it in the "Adapter Redis down" row of `system.md` section 4, or restore
  `{}` on `absent` when the runtime had a hash before.

## Doc mismatches

Every setting in `BackendSettings.ts`, `SandboxSettings.ts`, `ExportConcurrency.ts` and
`PenpotMcpServer.ts` was compared with the five documents named in the brief. The defaults that are
present agree. The gaps are coverage and stale numbers.

### F2-10. Two new settings are missing from most of the docs

- Severity: minor. Area: docs.
- `PENPOT_MCP_KEEPALIVE_S` (default 65, `PenpotMcpServer.ts:81`) is in
  `docs/technical-guide/configuration.md:1020` only. Missing from `mcp/docs/backend-mode-contract.md`
  section 4.6, `docs/technical-guide/mcp-production.md` section 2.2 and `mcp/README.md`.
- `PENPOT_MCP_EXPORT_TOTAL_PERMITS` (default 4, `BackendSettings.ts:26`) is in
  `mcp/docs/backend-mode-contract.md:815` only. Missing from `configuration.md`, `mcp-production.md`
  section 2.2 and `mcp/README.md`.
- Verified by grep over the six files.
- Fix: add both rows to each table; in the guide, say that `PENPOT_MCP_KEEPALIVE_S` must stay above the
  proxy idle timeout, and that nginx.conf uses 60 s.

### F2-11. The operator's guide still describes the state before the round-2 fixes

- Severity: minor. Area: docs, `docs/technical-guide/mcp-production.md`.
- `:49` "Render slots ... Shared by all adapters: No" and `:74`; `:184-186` "The code does not cap
  renders across adapters, so two adapters can send eight renders": stale since R2-05. With Redis the
  cap is `PENPOT_MCP_EXPORT_TOTAL_PERMITS` across adapters (`BackendServices.ts:66-82`).
- `:337` "Backend writes, per profile: Bucket of 120, refill 60 a minute (1 a second)": the code is
  `600/300/1m` (`backend/resources/rlimit.edn:341`), 5 a second.
- `:352` "4 calls at once per process" for the sandbox: the default is 20
  (`SandboxSettings.DEFAULT_MAX_CONCURRENT_CALLS`).
- `:353` "Export renders: One per token, four per process": add the shared cap.
- `:385` Redis commands for the ACL: add `ZREMRANGEBYSCORE`, `ZCARD`, `ZADD`, `ZREM` and `PEXPIRE` for
  the permits, and the key `penpot.mcp.export.permits` to `:391-392` and to table 8.1.
- `:390` "The code sets no minimum version ... Round 2 decides the floor" and `:542` "Redis version
  floor" open item: `mcp/README.md:303` already says "Requires Redis 5 or later". Both Lua scripts call
  `TIME` and then write, which Redis before 5 refuses, so the README is right; the guide should say so.
- `:286-287` "`compose.two-adapters.yaml` names them `penpot-mcp-a` and `penpot-mcp-b`": the compose
  file uses `penpot-mcp-1` and `penpot-mcp-2` (`compose.two-adapters.yaml:63,69`), the same as
  `alerts.yml` and `nginx.conf`. The warning is wrong; drop it.
- Verified against the code and files named.

### F2-12. Other stale sentences

- Severity: minor. Area: docs.
- `mcp/docs/backend-mode-review/system.md:175`: "It does not say the copy may be stale." The notice now
  reads "which may be stale" (`SandboxSessions.ts`, `STORAGE_UNAVAILABLE_NOTICE`); R2-07 is fixed.
- `system.md:171`: "`stop()` does not wait for sandboxes." `PenpotMcpServer.stop()` now awaits
  `sandboxes.shutdown()`, which saves every storage before disposing.
- `system.md:169`: "`export_shape` fails ... after 120 s when it hangs." The render timeout is 60 s
  (`ExportConcurrency.RENDER_TIMEOUT_MS`; contract `:789` says 60 s).
- `mcp/README.md:322`: `PENPOT_MCP_SANDBOX_MAX_CONCURRENT` "Defaults to `PENPOT_MCP_SANDBOX_MAX_SESSIONS`,
  so the slots follow the worker limit." The default is the constant 20; it does not follow a configured
  `MAX_SESSIONS` (`SandboxSettings.fromEnvironment`). The contract (`:823`) and `configuration.md:1014`
  say so; the README contradicts them.
- `PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS`: contract `:814` says default `4`; `configuration.md:1006`
  says "`0` (no limit), or `4` in backend mode"; README `:301` says `0`. The code has two defaults
  (bridge 0, backend 4). The contract row should say both.
- `mcp/deploy/prometheus.yml:38`: "The backend /metrics sends no Content-Type" is stale (R2-03 fixed,
  `metrics.clj:122`). Keep the fallback, fix the comment.
- `.serena/memories/backend/mcp.md`: still says `:mcp-write 120/60/1m`, lists no `:mcp-apply/by-team`
  limit, and says `rpc.clj` reads the profile once per call (`profile-mcp-disabled?`); the token lookup
  now reads it (`http/access_token.clj`, `profile-state`). Out of the brief's list, but the memory is
  the primary guidance for agents.

## Notes

### F2-13. Processor assertions on the operation tools are reported as the agent's mistake

- Severity: note. Area: backend, write path. `mcp_write.clj:527-545` (`raw-change-failure`), `:612`.
- `raw-change-failure` runs for every tool. For `mcp-apply-changes` an `:assertion` from the processor
  is a bad raw change, and `:validation :mcp-invalid-change` is right. For `mcp-apply-operations` and
  `mcp-import-svg` the changes come from the compiler, so the same assertion is a compiler fault, now
  reported with a change index the agent cannot map. Keep `:mcp-invalid-change` for the raw tool; keep
  `:internal` (or `:mcp-compile-failed`) for the others. Verified by reading.

### F2-14. The `bulk-allowsplit` fixture is right by number, wrong by reason

- Severity: note. Area: load test. `mcp/packages/loadtest/fixtures/scenarios/bulk-allowsplit.json`.
- `commits` is `(count batches)` (`mcp_write.clj:952`), the number of change rows, not the number of
  file writes. A call of 1,667 `create_rect` compiles to one batch under the 2,000-change bound, hence
  1. The new description says "the backend persists each call once, so each call is one commit", which
  conflates the single file write of `finish-batches!` with the batch count; a call above 2,000 changes
  still answers `commits: 2`. Fix the sentence. R2-09 is otherwise closed. Verified.

### F2-15. Ambiguous-literal check misses the trailing-dot form

- Severity: note. Area: backend, SSRF. `backend/src/app/util/ssrf.clj:195-206`.
- `str/split` drops trailing empty parts, so `127.0.0.1.` reads as canonical, is not an inet address
  for Guava, and goes to the resolver, which is the path the change wanted to avoid. The lookup fails
  (not a bypass: a resolved loopback is still refused). Use `(str/split host #"\." -1)` and treat an
  empty part as ambiguous. The new tests cover the octal, hex, short and mapped forms. Verified.

### F2-16. The same two values are exported under two names

- Severity: note. Area: adapter, metrics. `ProcessMetrics.ts:47-58` and `PenpotMcpServer.ts:927-938`.
- `process_resident_memory_bytes` and `penpot_mcp_process_resident_bytes` both carry `rss`;
  `nodejs_heap_used_bytes` and `penpot_mcp_process_heap_used_bytes` both carry `heapUsed`. The alerts
  and the dashboard use the `process_*`/`nodejs_*` names. Drop the `penpot_mcp_process_*` pair, or
  document which one is canonical.

### F2-17. The team limiter's error code is not named in the guide

- Severity: note. Area: docs. `mcp-production.md:338-343`.
- The table says "`Backend error <code>: concurrency limit reached` ... the value is not checked here".
  The alert `PenpotMcpClimitRejected` keys on `penpot_rpc_climit_rejected_total{name=~".*mcp.*"}` with
  `name` values such as `mcp-apply/by-team` (`climit.clj`, `id->str`); verified. Name the code the
  agent sees once, so the two layers can be matched.

### F2-18. `:mcp-disabled` inside `check-profile-state!` is dead on the request path

- Severity: note. Area: backend. `mcp.clj:178-192`, `rpc.clj:284-291`.
- `wrap-authentication` refuses `(false? (::mcp-enabled params))` before the command runs, with the flag
  the token lookup set, and the command then reads the same state from the request. The command-level
  check only runs when the request carries no profile (unit tests). Harmless; a comment would help.

### F2-19. After-commit callbacks swallow their errors

- Severity: note. Area: backend. `files_update.clj:1128-1131`, `db.clj` (`run-after-commit-callbacks`).
- The project touch, the change counters and the `mcp-tool` timing all run after the commit through a
  runner that logs a warning and goes on. A cfg without `::db/pool` (some test paths) means the touch
  never runs and nothing fails. In production the RPC cfg carries the pool (`tx-run!` keeps it); verified.
  Worth a `wrn` log check in the test of F2-04.

### F2-20. Lease and alert thresholds are untested against the C8 numbers

- Severity: note. Area: ops.
- Export p95 was 28.2 s with 3 timeouts in C8 (`production-readiness.md`, R2-05), before the shared cap.
  The cap of 4 across adapters was not re-run. The 60 s lease and the 30 s slot wait are plausible
  for that distribution; the plan's exit criteria want the number measured, not inferred.
