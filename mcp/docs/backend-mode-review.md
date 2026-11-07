# Backend-native MCP: architecture and best-practice review

Date: 2026-11-06. Code reviewed: commits `2c33b0ff9a` and `541f965bf1` on `perf/render-wasm-large-files`.

This report judges the backend-native MCP against four questions: does it follow best practice, is it fast, does
it scale, and is it reliable. It adds to `backend-mode-report.md` and corrects it in two places (section 7).

## 1. Method and limits

- Six Fable 5.1 reviewers each read one area in full: the operation compiler, backend reads and auth, the
  backend write path, the TypeScript adapter, the `execute_code` sandbox, and the system as a whole.
- **Nothing was run.** No test, build, benchmark or exploit. "Confirmed" means the code was read end to end and
  shows the fault. "Suspected" means the code allows it and a run must settle it.
- The orchestrator read the code behind every critical and high finding. Section 3 says, per finding, what that
  second read covered.
- The reviewers raised 122 findings. Several name the same fault from two sides; section 3 merges those.
- The six full reviews, with scenarios, fixes, missing tests and open questions for each finding, are in
  `backend-mode-review/`.

## 2. Verdict

The core design is right and should stay: one typed operation model, compiled by shared `common` code, committed
through the same `update-file!` path as an editor save, in one transaction, with MCP tokens denied by default.

The parts around that core are not ready for shared or hosted use. Two faults let a token holder break a
boundary the feature depends on, one can delete user data on a call that reports success, and writes are not
safe against a retry.

| Question | Answer |
|---|---|
| Best practice | Good in the small: reuse of editor code, closed schemas, tokens never stored raw, careful tests. Weak at the edges: guards the editor has are missing, all errors become client errors, the same knowledge is kept by hand in up to five places. |
| Performance | Good on the paths that were measured. Several paths that were not measured scan a whole page, token library or linked library once per operation or per call. |
| Scalability | One adapter process and one busy file are the limits. Adapter state is per process, scripts run on the Node main thread, and a write holds the file lock, the project row and a connection for the whole call. |
| Reliability | Atomic inside one backend call. Not safe across the hop: no idempotency, no cancellation, and the sandbox reports saved writes as failed on common paths. |

Findings by area and severity, as the reviewers rated them:

| Area | Critical | High | Medium | Low | Total |
|---|---|---|---|---|---|
| Operation compiler (`CMP`) | 0 | 3 | 10 | 9 | 22 |
| Backend reads and auth (`BRA`) | 1 | 2 | 7 | 8 | 18 |
| Backend write path (`BWP`) | 0 | 3 | 9 | 6 | 18 |
| Adapter (`ADP`) | 0 | 2 | 11 | 9 | 22 |
| Sandbox (`SBX`) | 1 | 3 | 10 | 9 | 23 |
| System (`SYS`) | 0 | 4 | 12 | 3 | 19 |
| Total | 2 | 17 | 59 | 44 | 122 |

## 3. Critical and high findings, merged

"Second read" says what the orchestrator checked in the code after the reviewer.

### 3.1 Fix before anyone else uses it

**P1. A read-only token can grant itself every scope** (`BRA-01`, `SYS-01`). Critical.
`create-mcp-render-session` needs only `mcp:read` and returns a real session cookie for the profile. The
restriction on that session is enforced only inside the RPC wrapper (`backend/src/app/rpc.clj:274`). The OAuth
approval routes, `/ws/notifications` and `/dbg` see a normal login (`http/session.clj:283`,
`http/mcp_oauth.clj:176`). A token holder can mint a render session, start an authorization for write, manage
and delete, and approve it with the cookie. The scopes land on the token the caller already holds. No consent
page is shown.
Fix: in `session/wrap-authz`, treat a render session as unauthenticated unless the route opts in; refuse it in
`session-binding`; add tests on the four routes. Effort: small.
Second read: `assoc-session` sets the profile id for a render session, `session-binding` asks only for a
profile id, and the restriction lives only in `wrap-session-restriction`. The exploit was not run.

**P2. Two short scripts hang the adapter for every user** (`SBX-01`). Critical.
The host writes the script arguments to guest globals before the run starts
(`sandbox/SandboxRuntime.ts:285`, `:499`). The CPU interrupt returns false when no run is active (`:729`). A
script can define a setter on `__arg0` that loops for ever; the next call from the same token runs it with no
limit, on the Node main thread. Only a kill ends it, and the same two calls hang the restarted process.
Fix: pass the arguments as JSON literals in the evaluated source, and make the interrupt return true when no
run is active. Effort: small.
Second read: the call order and the interrupt rule are as described. That `setProp` runs a guest setter comes
from the reviewer's reading of the QuickJS library.

**P3. Four one-line scripts disable `execute_code` until restart** (`SBX-02`). High.
The host settles the script result through the guest's own `Promise.prototype.then`
(`sandbox/SandboxRuntime.ts:634-642`). A script that replaces `then` with a no-op makes the call wait for ever.
Its slot is never freed, and there are four slots.
Fix: read the string result directly, with no guest promise step, and add a host watchdog around the call.
Effort: small.
Second read: the source is `Promise.resolve(fn(...))` and `settle` awaits the library's `resolvePromise`.

**P4. An invalid move can delete shapes and report success** (`CMP-01`). High.
`move-shapes-change` calls `cls/generate-relocate` without the guards the editor applies first
(`common/src/app/common/mcp/operations.cljc:1670`; editor guards in
`frontend/src/app/main/data/workspace/shapes.cljs:617-621`). `generate-relocate` plans its side effects as if
the move will happen, including deleting a source group left empty. The move change itself refuses a move into
the shape's own subtree, in silence. So `move_shapes {ids: [A], parent-id: <child of A>}`, where a group holds
only A, deletes the group and all under it. The same missing check lets any shape, such as a rect, become a
parent.
Fix: one shared check before relocate, create, clone and instantiate: clean loops, refuse a parent inside the
moved set, follow the editor's rule for component copies, require a container parent. Effort: small to medium.
Second read: the guards are absent in the compiler and present in the editor; `groups-to-delete` and the silent
refusal in `:mov-objects` are as described. The deletion was traced, not run.

### 3.2 Data integrity and reliability

**P5. A retried write is applied twice; a client that gives up does not stop the work** (`ADP-01`, `BWP-04`,
`SYS-02`). High.
`requestId` only labels the snapshot and the session id (`mcp_write.clj:247`, `:580`). The adapter drops the
request's abort signal (`PenpotMcpServer.ts:490`) and a queued write cannot be withdrawn
(`backend/FileWriteQueue.ts:28`). Common clients time out at 60 s; the adapter waits 120 s. The write commits,
the agent sees a failure and retries, and the page holds every shape twice.
Fix: before compiling, look for a `file_change` row with the call's session id and answer "already applied";
send a stable `requestId` per tool call; pass the abort signal through and drop writes that have not started.
Effort: medium.
Second read: the tool callback ignores its second argument, and the queue has no cancel path.

**P6. The sandbox reports saved writes as failed** (`SBX-04`, `SBX-06`, `SBX-07`, `SYS-15`). High.
Every flush reloads the touched pages, also at the end of the script. If the reload fails, for example because
a person edited the file meanwhile, the script fails with "run the script again" although the write is saved
(`sandbox/facade/CoreSource.ts:731-790`). The rate limiter can refuse between two chunks of one flush
(`SandboxHost.ts:412`, `:691`), and a write in flight at the wall-clock deadline commits after the error is
returned (`SandboxRuntime.ts:407-428`). Chunks of one script share no id, so nothing groups them. Together with
P5 this makes duplicates likely on a busy file.
Fix: mark pages stale after a flush and reload on the next read; admit a whole flush before its first chunk;
let a write in flight finish before reporting; derive chunk ids from one script id. Effort: small each.
Second read: not checked beyond the reviewer's reading.

**P7. Every failure becomes a client validation error** (`CMP-02`). High.
`compile-op` and the reflow catch `Throwable` and raise `:validation` (`operations.cljc:3542`, `:3576`). A
compiler bug, a failed page load from the database or an interrupt reaches the agent as "invalid operation".
The server answers 400, so no alert fires.
Fix: catch `ExceptionInfo` with a client error type only; raise the rest as `:internal` with the index and op.
Effort: small.
Second read: confirmed.

### 3.3 Contention and scale

**P8. A write holds the file lock, the project row and a connection for the whole call** (`BWP-01`, `BWP-02`,
`BWP-03`, `SYS-07`). High.
The advisory lock is taken before the load and released at commit (`mcp_write.clj:458-471`), so the 300-object
split no longer bounds how long an editor save waits. Each batch calls `update-file!`, which reads and decodes
the file again and writes the whole touched page as a new row (`mcp_write.clj:349-373`). The first batch
updates the project row (`files_update.clj:484`), which blocks saves to other files of the project until the
commit. The reported 5,000-shape write took 9.5 s; a designer on that file, or on another file of the project,
would wait that long. This case was never measured.
Fix: a batch-aware entry point that decodes once, applies each batch, and persists once; touch the project as
the last statement; set a time budget and a `lock_timeout` for MCP calls. Effort: medium.
Second read: the lock, the per-batch `update-file!` call and the project update are as described. The wait
times are estimates.

**P9. Every write loads all pages of all linked libraries** (`BWP-06`, `SYS-04`). High.
`library-map` reads each linked library and realises every page before the compiler knows whether an operation
needs one (`mcp_write.clj:381-389`). It runs under the file lock, and twice on a dry run. Renaming one
rectangle in a file linked to a large design system pays the full load. No load-test scenario links a library,
so no gate saw this.
Fix: a lazy library map that loads a library, and its pages, on first use. Effort: small to medium.
Second read: confirmed. The cost is not measured.

**P10. The page cache is bounded by count, not memory** (`BRA-02`). High.
`page-cache` holds up to 256 decoded pages for 10 minutes, keyed by file revision
(`backend/src/app/rpc/commands/mcp.clj:204`). Each write makes the next read store a new copy. A write-then-read
loop on a large page can fill the heap, and a write to one page drops the cached copy of every other page.
Fix: key by the page's pointer id and bound the cache by weight. Effort: medium.
Second read: the key and the bound are as described. The heap size per page needs a run.

**P11. Scripts run on the Node main thread** (`SBX-03`, `SYS-10`, `ADP-11`). High.
One script may hold the event loop for its whole CPU budget, 10 s by default. No other request on that adapter
is served meanwhile. The write queue, the rate limiter, the sandbox `storage` and the export gate are per
process, so several adapters behind a round-robin balancer break promises the instructions make.
Fix: a worker thread per sandbox, which also gives a hard stop for P2 and P3. Until then, lower the CPU budget
and allow one running script per token; document routing by token. Effort: large; the interim steps are small.

**P12. Per-operation scans of the page** (`CMP-03`, `CMP-04`). High and medium.
A create without a name reads every shape name on the page to build a unique one (`operations.cljc:1036`),
though the contract says default names are plain. Text operations, `apply_token` with a size token, `align` and
`distribute` pass the whole page to the modifiers. The benchmark uses the one path that was tuned.
Fix: use the plain base name; give the three families the page subset `update_shape` already uses. Effort:
small.
Second read: `shape-name` calls `get-used-names` on the whole page.

### 3.4 Exposure and packaging

**P13. The adapter parses 32 MB bodies before it checks any credential** (`ADP-02`). High in multi-user mode.
The JSON parser limit went from 100 kB to 32 MB and runs before authentication (`PenpotMcpServer.ts:521`).
Anyone who can reach the port can stall every session.
Fix: check the `Authorization` header first; keep a small default limit. Effort: small.
Second read: confirmed.

**P14. One token for all OAuth clients, and scopes only grow** (`BRA-03`). High, by design.
Every client receives the profile's one MCP token. An approval adds scopes and nothing removes them, so a
client approved for read gains delete when the user approves another client for it. One client cannot be
revoked alone. The settings page shows a switch for write only (`BRA-09`).
Fix: one token row per approval, listed in settings. Short term: say so on the consent page. Effort: large;
the wording is small.

**P15. The root `start` script now also runs the two test harnesses** (`SYS-03`). High.
`mcp/package.json` runs `start` in every workspace package. The `loadtest` and `design-parity` packages now
define one; the second exits with an error when given no command. `bootstrap` also installs Playwright, Vite
and React for every user, and the published package would carry both harnesses.
Fix: rename the harness scripts or filter the root scripts; add a `files` list. Effort: small.
Second read: the scripts are as described. Whether the server goes down needs one run of `pnpm run start`.

## 4. Themes among the medium findings

- **Limits that disagree** (`BRA-05`, `BRA-08`, `SYS-11`, `BWP-12`). The adapter allows 10 requests a second;
  the backend read bucket refills under one a second, and with whole-second arithmetic it does not refill at
  all under steady use. MCP may hold 26 of the 40 root concurrency permits. An agent's writes share the
  one-permit limiter of its owner's editor saves.
- **No switch for backend mode** (`BRA-04`, `SYS-09`). The "MCP server" switch in settings does not stop a
  token. No backend flag gates the new commands. The adapter enters backend mode by itself when the backend URI
  is set, and renames the plugin tools.
- **Validation** (`BWP-05`). File validation follows deployment flags, which are off by default, yet the result
  says `validation: {ok: true}`.
- **Unbounded answers** (`BRA-06`, `ADP-05`, `ADP-06`, `ADP-07`, `SBX-10`). Replies are capped by item count or
  at 1 MB, not by a size an agent can use. SVG and PDF exports have no inline cap. A truncated page tree keeps a
  cursor that skips the dropped nodes.
- **Drift between copies** (`CMP-05`, `CMP-06`, `CMP-11`, `SYS-08`, `SYS-17`, `SBX-12`). The modifier and token
  rules exist in `common` and again in the frontend; the token copy already differs. The operation list is kept
  by hand in five places. The adapter and the backend have no version check. The sandbox facade is a 110 KB
  string with no check against the plugin types.
- **Stale applied tokens** (`CMP-05`). Layout and text handlers skip `generate-update-shapes`, so a value set
  by hand keeps its token and the editor later writes the token value back.
- **Reads after writes in a script** (`SBX-08`). The local model follows five operation kinds. Other reads
  return old values or `undefined`, with no error.
- **Observability** (`SYS-12`, `BRA-11`, `SBX-22`). No request id joins an adapter log line to a backend one.
  The adapter has no health or metrics endpoint. Scope refusals are not counted.
- **Evidence for the performance claim** (`SYS-05`, `SYS-06`, `SYS-14`, `CMP-13`, `BWP-18`). See section 7.

## 5. All findings

Full text for each is in the file named in the heading.

### 5.1 Operation compiler (`backend-mode-review/compiler.md`)

| ID | Severity | Finding | Where |
|---|---|---|---|
| CMP-01 | high | A refused move still runs its side effects and can delete shapes; no parent-type check | `operations.cljc:1670`, `:969` |
| CMP-02 | high | `catch Throwable` turns server faults into `:validation` | `operations.cljc:3542`, `:3576` |
| CMP-03 | high | A create without a name scans every shape | `operations.cljc:1036` |
| CMP-04 | medium | Text ops, `apply_token`, `align`, `distribute` pass the full page to the modifiers | `operations.cljc:2024`, `:3276`, `:3357` |
| CMP-05 | medium | Layout and text handlers bypass `generate-update-shapes`; stale applied tokens | `operations.cljc:1927`, `:1852`, `:2095`, `:2710` |
| CMP-06 | medium | Token port records a token as applied when no value was written | `logic/token_application.cljc:131`, `:346` |
| CMP-07 | medium | Size step reads stale `:width` on paths and bools; may throw on a missing one | `operations.cljc:1097-1109` |
| CMP-08 | medium | Changes checked and applied twice; a new shape validated five or six times | `operations.cljc:890` |
| CMP-09 | medium | `props` can set `:layout`, `:touched`, `:content`, grid cells, variant keys | `operations.cljc:699-730` |
| CMP-10 | medium | `make_mask` and `remove_mask` only flip the flag; the group box is not updated | `operations.cljc:1790` |
| CMP-11 | medium | Modifier and touched rules exist in two copies | `logic/modifiers.cljc:28-158` |
| CMP-12 | medium | A schema error gives index and op but no reason | `operations.cljc:575-590` |
| CMP-13 | medium | Benchmark is wall-clock on root rects, which skip reflow; behaviours untested | `operations_test.cljc:2489-2535` |
| CMP-14 | low | Operation schema compiled on every call; token schema on every token op | `operations.cljc:572-596`, `:2864` |
| CMP-15 | low | `apply_token` merges all active tokens per op; linear lookups repeated | `operations.cljc:3243`, `:2896` |
| CMP-16 | low | Shapes with no layout in their chain go through the reflow | `operations.cljc:3462` |
| CMP-17 | low | "Pure" and `:new-id-fn` do not hold for component, clone, shadow, token ops | `operations.cljc:847` |
| CMP-18 | low | Boolean `:difference` mixes parent and index sources; one check is dead | `operations.cljc:1479`, `:1532` |
| CMP-19 | low | Auto-height text estimate ignores wrapping and line height | `operations.cljc:1083`, `:2009` |
| CMP-20 | low | JVM-parity patches change ClojureScript results; tests are smoke only | `flex_layout/layout_data.cljc` |
| CMP-21 | low | Each op is registered in three places; a split is proposed | `operations.cljc:213`, `:3385` |
| CMP-22 | low | Naming, `let` alignment, duplicate helpers, fragile `props-schema` | `operations.cljc:706`, `:924` |

### 5.2 Backend reads and auth (`backend-mode-review/backend-read-auth.md`)

| ID | Severity | Finding | Where |
|---|---|---|---|
| BRA-01 | critical | Render-session restriction holds only inside RPC; a read token gains all scopes | `rpc.clj:274`, `http/session.clj:283`, `http/mcp_oauth.clj:176` |
| BRA-02 | high | Page cache holds 256 decoded pages, keyed by revision, bounded by count | `rpc/commands/mcp.clj:204` |
| BRA-03 | high | One token for all OAuth clients; approvals only add scopes | `access_token.clj:131`, `mcp_oauth.clj:246` |
| BRA-04 | medium | The `mcp-enabled` switch is never checked by the backend; no flag for backend mode | `integrations.cljs:483`, `mcp.clj:165` |
| BRA-05 | medium | Hourly buckets get no refill under steady use; human buckets are shared | `rlimit.edn:318`, `rlimit/bucket.lua:23` |
| BRA-06 | medium | Replies bounded by item count, not bytes; `get-page` open to tokens | `mcp.clj:595`, `:685`, `:1043` |
| BRA-07 | medium | A page-tree cursor dies on any write to the file | `mcp.clj:567` |
| BRA-08 | medium | MCP can hold 26 of 40 root permits; no per-file limit; reads hold a transaction | `climit.edn:81` |
| BRA-09 | medium | Settings neither show nor remove `mcp:manage` and `mcp:delete` | `integrations.cljs:418` |
| BRA-10 | medium | File root read and decoded on every call; N+1 on a cold outline | `mcp.clj:187`, `:358`, `:407` |
| BRA-11 | low | Scope and limit refusals reach no metric, log line or audit event | `rpc.clj:432` |
| BRA-12 | low | An opened command without `::mcp-scope` defaults to read; no startup check | `rpc.clj:177` |
| BRA-13 | low | `mcp:write` also deletes comments and versions; 17 opened commands unused | `comments.clj:685`, `files_snapshot.clj:116` |
| BRA-14 | low | Library list has no `truncated` flag; `type` is a free keyword; `resolve` is dead | `mcp.clj:909`, `:994`, `:1041` |
| BRA-15 | low | Tokens do not expire by default, are stored in clear and travel in a URL | `access_token.clj:68` |
| BRA-16 | low | SSO check cached per profile, not per credential (suspected) | `rpc.clj:346` |
| BRA-17 | low | Render sessions outlive token revocation by up to 10 minutes | `session.clj:265`, `:382` |
| BRA-18 | low | Redundant `::audit/skip false`, duplicated helpers, `def` caches | `mcp.clj` |

### 5.3 Backend write path (`backend-mode-review/backend-write.md`)

| ID | Severity | Finding | Where |
|---|---|---|---|
| BWP-01 | high | File lock and transaction last the whole call | `mcp_write.clj:458-471`, `:334-377` |
| BWP-02 | high | Each batch re-reads the file and rewrites the whole page as a new row | `mcp_write.clj:349-373`, `files_update.clj:566` |
| BWP-03 | high | `UPDATE project` in batch 1 blocks saves to other files of the project | `files_update.clj:484` |
| BWP-04 | medium | `request-id` detects no repeat; a retry duplicates shapes | `mcp_write.clj:247`, `:580` |
| BWP-05 | medium | Validation follows flags that are off by default; result says `ok` | `mcp_write.clj:644`, `files_update.clj:725` |
| BWP-06 | medium | Every call loads all pages of all linked libraries, twice on a dry run | `mcp_write.clj:381-389`, `:617` |
| BWP-07 | medium | After-commit callbacks keep each batch's decoded file until commit | `files_update.clj:921-948` |
| BWP-08 | medium | Publish buffer drops past 128 pending messages (suspected) | `msgbus.clj:72` |
| BWP-09 | medium | The automatic snapshot fires per batch inside a split call | `files_update.clj:576`, `:812` |
| BWP-10 | medium | Conflict check reads change rows that expire after an hour | `files_update.clj:855-888` |
| BWP-11 | medium | Migrate-on-read can overwrite a long MCP commit; a dry run can write (suspected) | `binfile/common.clj:240`, `mcp_write.clj:464` |
| BWP-18 | medium | Commit-path tests run with validation off and never under contention | `helpers.clj:83` |
| BWP-12 | low | The owner's own saves queue behind their agents | `climit.edn:18`, `:81` |
| BWP-13 | low | Size checks run after the lock and load; no cap on duration or SVG size | `mcp_write.clj:582`, `:108` |
| BWP-14 | low | `laggedCount` is 0 by construction, yet costs a read per batch | `mcp_write.clj:370` |
| BWP-15 | low | The forced-snapshot rule misses token, set and theme deletes | `mcp_write.clj:59` |
| BWP-16 | low | `check-media!` accepts media marked deleted | `mcp_write.clj:203` |
| BWP-17 | low | Error type of a failed snapshot, duplicated helper, unused hook, no timing log | `files_update.clj:544` |

The reviewer judged the "skip unloaded pointer page" rule in `fdata/enable-objects-map` safe for editor saves.

### 5.4 Adapter (`backend-mode-review/adapter.md`)

Paths are under `mcp/packages/server/src/`.

| ID | Severity | Finding | Where |
|---|---|---|---|
| ADP-01 | high | Abort signal dropped; no idempotency key | `PenpotMcpServer.ts:490`, `backend/FileWriteQueue.ts:28` |
| ADP-02 | high | 32 MB JSON body parsed before authentication | `PenpotMcpServer.ts:521` |
| ADP-03 | medium | Token catalogue read outside the write queue, in full, on every call | `tools/backend/ApplyOperationsTool.ts:104` |
| ADP-04 | medium | Queues and gates unbounded; waiting imports hold decoded archives | `backend/FileWriteQueue.ts:28` |
| ADP-05 | medium | Answers cut at 1 MB and pretty-printed; defaults too large for agents | `tools/backend/BackendTool.ts:19`, `:152` |
| ADP-06 | medium | PDF and SVG export uncapped inline; page export sequential | `tools/backend/ExportShapeBackendTool.ts:403` |
| ADP-07 | medium | Truncation keeps `nextCursor`, which skips the dropped nodes | `tools/backend/BackendTool.ts:152-205` |
| ADP-08 | medium | OAuth token checked only on `initialize`; no 401 on later expiry | `McpAuthentication.ts:243` |
| ADP-09 | medium | Query-string token allowed by default and named in an error text | `backend/BackendSettings.ts:58` |
| ADP-10 | medium | Operation parameter docs never reach the agent | `tools/backend/operations/OperationSchemas.ts:169` |
| ADP-11 | medium | Per-token state is per process | `backend/BackendServices.ts:38` |
| ADP-12 | medium | Export root defaults to the home directory; silent overwrite | `utils/ExportDirectory.ts:19-66` |
| ADP-13 | medium | A large backend answer is held in memory several times (suspected) | `PenpotBackendClient.ts:296` |
| ADP-14 | low | No Host or Origin check before the handler | `PenpotMcpServer.ts:496` |
| ADP-15 | low | `allowSplit` text says several transactions; the contract says one | `tools/backend/ApplyOperationsTool.ts:28` |
| ADP-16 | low | `get_page_tree` `depth` is off by one against the backend | `tools/backend/GetPageTreeTool.ts:18` |
| ADP-17 | low | No MCP tool annotations | `PenpotMcpServer.ts:471` |
| ADP-18 | low | Local mode: DNS re-resolution bypass, block-list gaps, unconfined reads | `tools/backend/ImportArchiveBackendTool.ts:252` |
| ADP-19 | low | Text and schema mismatches (image size, `type`, `resolve`) | `tools/backend/ImportImageBackendTool.ts:18` |
| ADP-20 | low | Default `fetch` timeouts of 300 s cut longer configured ones (suspected) | `PenpotBackendClient.ts:175` |
| ADP-21 | low | Unknown tokens bypass the rate limit; each costs a backend call | `tools/backend/BackendTool.ts:49` |
| ADP-22 | low | Configuration, shutdown and typing details | `PenpotMcpServer.ts:247`, `:577` |

### 5.5 Sandbox (`backend-mode-review/sandbox.md`)

Paths are under `mcp/packages/server/src/`.

| ID | Severity | Finding | Where |
|---|---|---|---|
| SBX-01 | critical | A setter on `__arg0` runs with no CPU limit and hangs the process | `sandbox/SandboxRuntime.ts:285`, `:729` |
| SBX-02 | high | A no-op `Promise.prototype.then` hangs the call; the slot is never freed | `sandbox/SandboxRuntime.ts:634-642` |
| SBX-03 | high | Scripts run on the main thread; each blocks all users for up to 10 s | `sandbox/SandboxRuntime.ts:584` |
| SBX-04 | high | Every flush reloads the page; a failed reload reports a saved write as failed | `sandbox/facade/CoreSource.ts:731-790` |
| SBX-05 | medium | `applyToken` flushes and reloads once per call | `sandbox/facade/CoreSource.ts:23`, `:827` |
| SBX-06 | medium | The rate limiter refuses mid-script and between chunks | `sandbox/SandboxHost.ts:412`, `:691` |
| SBX-07 | medium | A write in flight at the deadline commits but is reported as not applied | `sandbox/SandboxRuntime.ts:407-428` |
| SBX-08 | medium | Reads after writes are true for five op kinds only | `sandbox/facade/CoreSource.ts:478-522` |
| SBX-09 | medium | One token can hold all four slots; the deadline counts queue time | `tools/backend/ExecuteCodeBackendTool.ts:125` |
| SBX-10 | medium | No size cap on result, log or error text | `sandbox/facade/CoreSource.ts:904-959` |
| SBX-11 | medium | Any read loads the whole page; the 50 MB cap exceeds guest memory (suspected) | `sandbox/SandboxHost.ts:83`, `:249` |
| SBX-12 | medium | The facade is a 110 KB string with no check against the plugin types | `sandbox/facade/ApiSource.ts:11` |
| SBX-13 | medium | Runner globals are writable and last between calls | `sandbox/facade/CoreSource.ts:1006` |
| SBX-14 | medium | A folded `appendChild` can jump over an op on an ancestor | `sandbox/facade/CoreSource.ts:650-675` |
| SBX-15 | low | Advancing `baseRevn` hides others' changes (suspected) | `sandbox/SandboxHost.ts:749` |
| SBX-16 | low | After a failed chunk the guest never learns the created ids | `sandbox/facade/CoreSource.ts:760` |
| SBX-17 | low | Silent facade deviations (`addFlexLayout`, `textBounds`, unknown members) | `sandbox/facade/ApiSource.ts:425` |
| SBX-18 | low | Write options skip SVG imports, uploads and `rpc` writes | `sandbox/SandboxHost.ts:611` |
| SBX-19 | low | Shapes below level 20 vanish without a warning | `sandbox/SandboxHost.ts:96`, `:305` |
| SBX-20 | low | Token catalogue may be 120 s stale (suspected) | `sandbox/SandboxHost.ts:705` |
| SBX-21 | low | Writes from promise callbacks are dropped in silence | `sandbox/SandboxRuntime.ts:635` |
| SBX-22 | low | No logging or counters; no cleanup on shutdown | `sandbox/SandboxSessions.ts` |
| SBX-23 | low | Avoidable costs per start, read and load | `sandbox/SandboxRuntime.ts:201` |

The reviewer judged the secrecy boundary sound: only strings cross it, the token stays on the host, and the
host checks every operation again.

### 5.6 System (`backend-mode-review/system.md`)

| ID | Severity | Finding | Where |
|---|---|---|---|
| SYS-01 | high | Same fault as BRA-01 | `http/mcp_oauth.clj:176-262` |
| SYS-02 | high | No write idempotency (same as ADP-01, BWP-04) | `mcp_write.clj:580` |
| SYS-03 | high | Root `start` and `bootstrap` run the harness CLIs and install Playwright | `mcp/package.json:13-15` |
| SYS-04 | high | Every write realises all linked libraries (same as BWP-06) | `mcp_write.clj:381-412` |
| SYS-05 | medium | Runbook contradicts the status report; measured on an uncommitted tree | `loadtest/PERF-RUNBOOK.md:49`, `:70`, `:93` |
| SYS-06 | medium | p95 from 1 to 7 samples, closed loop, fixture built through the MCP | `loadtest/PERF-RUNBOOK.md:131` |
| SYS-07 | medium | Lock and transaction held through compile (same as BWP-01) | `mcp_write.clj:458` |
| SYS-08 | medium | No version or capability check; zod and malli are hand-kept copies | `backend/BackendTokenValidator.ts:6` |
| SYS-09 | medium | Backend mode implied on upgrade; no backend flag or kill switch | `PenpotMcpServer.ts:142` |
| SYS-10 | medium | Per-process queue, limiter and `storage`; sandbox blocks the event loop | `backend/BackendServices.ts` |
| SYS-11 | medium | Adapter 10 requests a second against backend 0.83 reads a second | `backend/BackendSettings.ts:6`, `rlimit.edn` |
| SYS-12 | medium | No shared request id; no adapter health or metrics endpoint | `PenpotBackendClient.ts:158` |
| SYS-13 | medium | Exports lack per-tenant fairness; the sandbox path uses the unbounded gate | `utils/ExportConcurrency.ts`, `sandbox/SandboxHost.ts:492` |
| SYS-14 | medium | Parity gates compare the system with itself; machine paths committed | `design-parity/src/Paths.ts:26-39` |
| SYS-15 | medium | `execute_code` chunks are not atomic and not grouped in audit | `sandbox/SandboxHost.ts:77-92` |
| SYS-16 | medium | Compose file, operator docs and agent memories are stale | `docker/images/docker-compose.yaml:216` |
| SYS-17 | low | Operation list in five places, fonts in three, token resolver in TypeScript | `operations/OperationSchemas.ts` |
| SYS-18 | low | `apply_raw_changes` exposes the internal change format under `mcp:write` | `mcp_write.clj:679-698` |
| SYS-19 | low | One notification may carry 100,000 changes (suspected) | `mcp_write.clj:143`, `:308` |

`system.md` also holds a failure-mode table (backend down, database slow, exporter down, Redis down, adapter
restart, client disconnect, retry, clock skew, a human on the same file) and a check of 15 contract statements
against the code: 11 match, 4 drift, none a behaviour bug.

## 6. Strengths to keep

- One commit path for people and agents, so lock, revision checks, validation, audit and webhooks cannot drift.
- One transaction per backend call; notifications and cache work after the commit. No reviewer found a partial
  commit or a deadlock.
- The compiler reuses the editor's own generators for relocate, delete, duplicate, components and tokens, and
  sends all geometry through the modifiers.
- MCP tokens are denied by default; opened commands reuse the human handlers, so permission logic exists once.
- The adapter never stores or logs a raw token and never retries a write.
- The sandbox passes only strings across its boundary and the host validates every operation again.
- OAuth: exact redirect match, S256 only, single-use codes bound to client and verifier.
- Tests assert on outcomes, through the file validator, for at least one case per operation.
- Errors name the failed operation; a contract document exists and mostly matches the code.

## 7. Corrections to `backend-mode-report.md`

1. **The gate table.** The report says the full gate table is in `PERF-RUNBOOK.md`. The runbook was not
   updated after the last two fix rounds. It still marks the adapter memory gate as failed at 2,132 MB with
   defect D1 open, and gives large-file writes as p50 522 ms and p95 5,206 ms. The report's later figures
   (about 160 MB; 205 ms and 1.86 s) have no run record in the runbook. The export gate is unmeasured, and the
   earlier run (p50 5.1 s against a p95 target of 5 s) points to a fail.
2. **Strength of the performance claim.** Several p95 figures come from 1 to 7 samples; with so few, the p95
   is the maximum. The load is closed-loop, so queueing delay under saturation is hidden. The large file was
   built through the MCP, so it holds only what the MCP can make: no linked library, no editor-made text or
   paths. Each test agent had its own profile, which avoids every per-profile limit. All runs were on an
   uncommitted tree. Read the figures as "fast on the measured paths on one machine", not as passed gates.
3. **Design parity.** The model check and the DOM check compare the MCP's reads with the MCP's writes, and the
   generated app with the model it came from. The one independent check, the pixel compare against the
   exporter, never changes the exit code. `design-parity/src/Paths.ts` defaults to paths on the machine that
   built it.

## 8. Suggested order of work

| Step | Items | Effort |
|---|---|---|
| 1. Close the holes | P1 render session; P2 and P3 sandbox hang and slot leak; P4 move guards; P13 body limit before auth | small each |
| 2. Make writes safe to retry | P5 idempotency and cancellation; P6 sandbox flush reporting; P7 error types | small to medium |
| 3. Cut contention | P8 decode once and persist once, project touch last, lock timeout; P9 lazy libraries; P10 cache by weight; P12 scans | medium |
| 4. Fix packaging and docs | P15 start scripts; `Paths.ts` defaults; runbook; compose file; agent memories (`SYS-16`) | small |
| 5. Switches and limits | backend flags and the settings switch; one rate-limit policy; per-token export share; validation for raw changes | small to medium |
| 6. Measure | human save during an agent write (C3); a write on a file with a large linked library; open-loop load with 200 samples per percentile; heap of the page cache | medium |
| 7. Structural | worker thread per sandbox (P11); per-client tokens (P14); one source for the operation list and a version check; shared modifier and token code with the frontend | large |

Steps 1 and 2 should come before any use by people other than the developer. Step 6 needs a running stack and
a browser.

## 9. What only a run can settle

- Does the render-session cookie get a 200 from the OAuth `request` and `decision` routes (P1)?
- Do the two sandbox scripts hang the process as read (P2, P3)?
- Does the invalid move delete the group (P4)? One compiler test settles it.
- How long does an editor save wait during a 5,000-shape agent write on the same file, and on another file of
  the project (P8)?
- What does one small write cost on a file linked to a 100,000-shape library (P9)?
- How much heap does one cached 100,000-shape page hold (P10)?
- Does `pnpm run start` keep the server up (P15)?
- Are notifications dropped for a call with more than 128 batches (`BWP-08`)?
- With `rpc-rlimit` on, when does a normal agent session run dry (`BRA-05`)?

## 10. Resolution, 2026-11-07

Every finding in sections 3 to 5 was worked on after this review, in three waves of Haiku implementers with Opus
reviews between them (two passes per area). The code is uncommitted on top of `541f965bf1`. Status per
merged item:

| Item | Status | What landed |
|---|---|---|
| P1 render session | fixed | `session/wrap-authz` hides a render session unless the route opts in (RPC routes and `/assets`); `session-binding` refuses it; `/assets` serves only the session's files; the session dies with its token, when the token expires, when MCP is switched off, and after 10 minutes (GC). Route-level tests on OAuth, websocket, `/dbg`, `/assets`. |
| P2, P3 sandbox hangs | fixed | Arguments passed as JSON literals; the interrupt fails closed; the result is read without the guest's `Promise`; a watchdog frees the slot and the per-token turn; every script now runs in a `worker_threads` worker (`PENPOT_MCP_SANDBOX_WORKERS`, default on) with a main-thread CPU backstop and `resourceLimits`. |
| P4 move guards | fixed | `logic/shapes.cljc check-structure-move`: loops, parent inside the moved set, copy rules, nesting loops, container parents only, variant containers refused; shared with the editor's rules. |
| P5 retry safety | fixed | `requestId` always sent; the backend answers `alreadyApplied` for a replay (session id = token id + request id + payload digest, one hour); the request's abort signal reaches queued writes and never a sent write; writes outside the file queue are `abortable: false`. |
| P6 sandbox flush | fixed | Pages marked stale instead of reloaded; a flush is admitted whole; a write in flight finishes before the deadline error; chunk ids derive from the script id; a later chunk's failure returns the saved ids; `abandon()` stops a flush the watchdog gave up on. |
| P7 error types | fixed | Only client-error `ExceptionInfo` maps to `:validation`; everything else is `:internal :mcp-compile-failed`; interrupts and VM errors pass through. |
| P8 lock hold | fixed | `begin-batches!` / `apply-batch!` / `finish-batches!`: decode once, one change row per batch, persist once, project touched last; `lock_timeout` 15 s (`:mcp-file-busy`, `:mcp-lock-timeout`); a 60 s budget; MCP writes validate touched shapes only (the page-wide check cost 1.6 s on a 59,000-shape page). |
| P9 linked libraries | fixed | Libraries load lazily through a loader bound to the file and its libraries; the editor keeps its own lazy loader; a load scenario with a linked library was added. |
| P10 page cache | fixed | Keyed by pointer id, bounded by shape weight (200,000), `expireAfterAccess`; cached roots never hold loaded pages; cursors bound to the pointer id. |
| P11 main thread, per-process state | mostly fixed | Worker threads (above). Per-process queue, limiter and `storage` remain per process; routing by token is documented. |
| P12 per-op scans | fixed | Plain default names; `modifier-objects-of` for text, token geometry, align and distribute; reflow only for shapes under a layout; lookup-count gates replace the wall-clock benchmark (unnamed create: 20,040 lookups to 18). |
| P13 body before auth | fixed | Auth gate before the parser; 4 MB for everyone, 32 MB only for a backend-validated token. |
| P14 shared token | fixed | One access token per OAuth client (migration `0158`: `client_id`, `client_name`, partial unique index, byte bounds); replace on re-approval; at most 20 per profile; settings list and revoke; exchange checks `client_id`; disabling MCP refuses every token call. |
| P15 packaging | fixed | Positive package filters, harness scripts renamed to `cli`, `files` list with the lockfile (`prepack`) and no tests, second esbuild entry for the worker. |

Also fixed: every medium and low finding of sections 4 and 5 except those listed below, the harness findings
(`SYS-05`, `SYS-06`, `SYS-14`: sample marks, open-loop mode, warm-up, provenance, the pixel gate, no machine paths,
generated app untracked), the docs and memories (`SYS-16`), `set_path_content` as a new operation, a `describe_operations`
tool, `/healthz`, `/readyz`, `/metrics`, a request id across the hop, backend flags `enable-mcp-backend` and
`enable-mcp-raw-changes` (off by default), the compiler split into `app.common.mcp.operations.*` (behaviour-neutral,
checked schema by schema), and a shared bug in `types/container.cljc` (`get-nesting-level-delta` crashed on two
non-empty head lists; the editor's clipboard path hit it too).

Left open, with the reason:

- Per-process adapter state (`ADP-11`, `SYS-10`): the write queue, the limiter and `storage` are per process; run
  one adapter or route by token. A Redis-backed limiter and queue were not built.
- `SYS-17` duplicated knowledge: the operation list is now derived on both sides and pinned by a test; the font table
  and the token resolver are still kept in TypeScript as well as in `common`.
- `SYS-14` frontend validation step in design parity: not built (needs a headless frontend).
- `BWP-02` residue: a write still decodes and encodes the whole touched page (about 0.4 s each on a 59,000-shape
  page). Clearing the 3 s write bar on such a page needs page splitting or partial re-encoding.
- `changes.cljc` drops an invalid `mov-objects` in silence (shared code); the compiler now refuses the cases before
  they reach it, other callers do not.
- `BRA-13` scope names: `mcp:write` still covers comment edits; the deletes and restores moved to `mcp:delete`.
- Validation flags: the editor's own path still follows the deployment flags; only MCP writes force the touched-shape
  check.
- 25 pre-existing clj-kondo warnings in shared test files (`helpers.clj`, `rpc_test.clj`, `rpc_access_tokens_test.clj`).

Verification on the final tree: `backend-mode-report.md`, section "Verification on the final code".
