# Backend-native MCP: production readiness plan

Date: 2026-11-07. Branch: `perf/render-wasm-large-files` at `e4084f80b2`.

Goal: enough evidence to deploy the backend-native MCP for many users on a hosted Penpot with more than one
adapter and more than one backend, and to know what to watch once it runs. The feature works and is verified on
one machine (`backend-mode-report.md`); this plan covers what that did not: the unmeasured performance gates,
shared state across adapters, failure injection, an adversarial pass, upgrade and rollback, a soak, capacity, and
the operator's guide.

The plan runs as rounds. Each round: implement (Haiku agents), run (Opus agents, who also review what they run),
review the round as a whole (a Fable agent), fix what the review finds, record the state in
`production-readiness.md`, repeat. A round ends only when its runs are recorded with the commit they ran on.

## Tracks

### T1. Unmeasured performance gates (`PERF-RUNBOOK.md`)

| Gate | How it will be measured |
|---|---|
| Cold-cache reads | Restart the dev backend inside the run; first page read and first outline after restart on the 5,000- and 100,000-shape files. |
| Large file without pointer-map | Restart the backend with `enable-feature-fdata-pointer-map` off; run S5 and S8 on a fresh large file. |
| S6 archive import | Export the 5,000-shape file with `export-binfile`, import it through `import_archive`, compare shape counts, time it. |
| C3 and C5 human half | A Playwright session logged in as the test profile edits the same file in the dev frontend while agents write; measure the tab's save round trip and whether its edits survive. |
| Plugin-bridge baseline | Bridge mode with a Playwright tab running the plugin, the same reads as S1; if the plugin cannot be driven headless, record why and skip. |
| SQL statements under load | Enable `pg_stat_statements` on the dev Postgres (needs a container restart) and count statements per call for one page read and one small write, then for C1 at 20 agents. |
| 4 h soak | The `soak-mixed` scenario for four hours with backend heap, adapter RSS, Postgres connections and `file_change` growth sampled every minute; nothing may grow without bound. |
| Capacity | C1 at 50 and 100 agents; C2 at 10 agents on a fresh file; where the limits trip, which error the agent sees. |

Every result records the commit, the flags, the pool size and whether the tree was dirty, and goes into the
runbook table with a pass, fail or not-measurable mark.

### T2. Shared state for several adapters

Today the write queue, the rate limiter and the sandbox `storage` live in one process. For N adapters behind a
round-robin balancer the limiter is N times too generous and `storage` disappears between calls.

- Rate limiter in Redis (token bucket in Lua, keyed by token digest), on when `PENPOT_MCP_REDIS_URI` is set;
  the in-process bucket stays as the fallback.
- Sandbox `storage` in Redis with a TTL, same switch.
- The write queue stays per process: the backend's file lock already serialises writes; the queue only avoids
  `climit` queue errors. Document this.
- A compose file with two adapters and an nginx round-robin in front, used by T4 and T6.
- Tests: the limiter and the storage against a real Redis; a two-adapter run where `storage` set through one
  adapter is read through the other, and where 20 calls a second from one token are refused past the shared
  limit.

### T3. Adversarial pass

An Opus agent writes and runs a hostile suite against the live adapter and backend: token and scope misuse
(read token on every write, manage and delete command; render-session cookie on every route; a revoked and an
expired token; a client token on another client's exchange), SSRF (image and archive URLs to loopback, link-local,
metadata addresses, DNS rebinding, redirects to private hosts), path traversal on export and import roots,
oversized and malformed bodies with and without a token, sandbox escapes (prototype tampering, promise tricks,
`storage` bombs, host-call floods, memory and CPU bombs in parallel from several tokens), replay with the same
and a changed payload, and rate-limit bypass with many tokens. Every attempt must be refused with a clear error
and leave the server healthy; `/readyz` and a control call are checked after each group.

### T4. Failure injection

Scripts that stop and start containers while scenarios run, and check the failure-mode table of the review:
backend stopped during a write (no partial commit; the agent sees a clear error; a retry with the same
`requestId` is a replay), adapter killed during an `execute_code` flush (no chunk after the one in flight; the
next call reports the committed count), Redis stopped (writes still commit; the limiter and `storage` fall back
or fail closed as documented), exporter stopped (`export_shape` fails fast, other tools unaffected), Postgres
restarted (calls fail then recover; no stuck connections), and a slow backend (a `tc`-style delay or a
`pg_sleep` in a hook) against the 55 s adapter timeout. Each case records what the agent saw and what the
database holds afterwards.

### T5. Upgrade and rollback

Dump the dev database, restore it into a copy, run the new backend's migrations (`0158`, `0159`) on it, then run
the previous backend (`541f965bf1`, in a git worktree inside the toolchain container) against the migrated
database: its test suite and a manual token call must pass. Record the time the migrations took on a table of
realistic size (generate 100,000 `file_change` rows first) and whether `CREATE INDEX` blocked writes.

### T6. Observability

Scrape `/metrics` of both adapters and the backend with a Prometheus container for the soak; check every series
is well formed (`promtool check metrics`); write the alert rules an operator needs (adapter down, backend not
ready, sandbox terminations per minute, `penpot_mcp_refusals_total` rate, lock timeouts, write latency p95) and
a Grafana dashboard JSON. Check that one tool call's `X-Request-Id` appears in the adapter log, the backend log
and the audit row.

### T7. Operator's guide and CI

`docs/technical-guide/mcp-production.md`: topology (adapters, backends, exporter, Redis, Postgres), sizing from
the soak and capacity numbers, flags, settings, the upgrade and rollback order, the alert rules, the known limits
(very large pages, the sandbox page cap, per-client tokens replacing on re-approval), and the smoke to run after a
deploy. A CI job (`scripts/ci`) that runs the MCP unit suites and, behind a flag, the smoke against a compose
stack.

### T8. Residual items from the review

Where the night allows: the font table served from the backend (`SYS-17`), a lazy `execute_code` facade that
fetches shapes on demand (lifts the page cap), and partial re-encoding of large pages on write (`BWP-02`
residue). These are stretch items; they start only when T1 to T7 have landed.

## Order of work

1. Round 1 (parallel): T1 gates that need no new code (Opus runs them, one agent owns the stack); T2 Redis
   state (Haiku); T3 adversarial suite (Opus writes and runs it early, before latency runs); T4 and T5 scripts
   (Haiku write them; the stack owner runs them when the stack is free); T6 rules and checks (Haiku).
2. Fable review of round 1; fixes.
3. Round 2: two-adapter runs, failure injection, upgrade and rollback, capacity, then the 4 h soak overnight.
4. Fable review of round 2; fixes; the operator's guide written from the measured numbers.
5. Final verification: all suites, the live smoke on two adapters, the readiness report
   (`production-readiness.md`) with a go or no-go per track.

## Exit criteria

- Every gate in the runbook has a mark and a commit; none is "not measured" without a written reason.
- Two adapters behind a balancer pass the smoke, the parity build and C2 with 5 agents, with shared limits and
  `storage`.
- The adversarial suite passes in full and is committed as a test the CI can run against a stack.
- Each failure case behaves as the failure-mode table says, and the table is updated where it did not.
- The previous backend runs against the migrated database.
- The soak shows flat memory, bounded `file_change` growth and no errors for four hours.
- The operator's guide exists and a reader can deploy from it.

## Additions after the round-1 review

The round-1 Fable review (`production-readiness-reviews/round1-fable.md`) added these to the plan:

1. Storage consistency across adapters: reload per call from the shared store; a 50-call alternation test. (T2)
2. Per-team write ceiling, beside the per-profile one. (backend)
3. Tenant isolation test of `storage` and render cookies across tokens and adapters. (T2)
4. Token revocation propagation across adapters within the validator cache time; a setting to shorten it. (T2)
5. Audit completeness matrix per tool. (T7)
6. Deletion cascade for agent-written data: Redis storage keys and exports on adapter disk when a profile is
   deleted. (T7, scripts)
7. Backup and restore of a mid-soak dump, opened by the old and the new backend. (T5)
8. Contract version across a rolling deploy: order and a mixed-version smoke. (T7, round 2)
9. Exporter as a shared bottleneck: an export-heavy capacity scenario; a permit in Redis or sizing. (T1)
10. DB pool metrics in capacity runs; an alert on pending connections. (T6)
11. `file_change` growth per 1,000 operations; the GC keeps up; the replay window fits the retention. (T1)
12. Write ordering across adapters: measure, then choose a Redis queue or routing by file id. (T1, T2)
13. Redis operations: TLS, ACL, maxmemory, version floor, sizing. (T7)
14. Balancer-tier failure cases: an adapter down behind nginx, an nginx reload, Redis stopped on the two-adapter
    stack. (T4)
15. The adversarial suite runnable in CI against a compose stack. (T3, T7)
16. Pre-deploy `CREATE INDEX CONCURRENTLY` step in the upgrade order. (T5, T7)
