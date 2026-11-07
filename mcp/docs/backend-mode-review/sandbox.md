# Review: the `execute_code` sandbox

Scope: `mcp/packages/server/src/sandbox/**`, `src/tools/backend/ExecuteCodeBackendTool.ts`, and their tests.
Method: read-only. Nothing was run. I also read the minified `quickjs-emscripten-core@0.32.0` and
`@jitl/quickjs-wasmfile-release-asyncify@0.32.0` in `mcp/node_modules/.pnpm` to check what the library calls do
(QuickJS 2025-09-13). Paths below are relative to `mcp/packages/server/` unless they start with `mcp/`.

"Confirmed" means confirmed by reading the code, not by a run.

## Verdict

The secrecy and authority boundary is sound: only strings cross it, the token never enters the guest, and the host
checks every operation again. The availability boundary is not: two short scripts can hang the whole Node process
(SBX-01), four one-line scripts can disable `execute_code` for every user until a restart (SBX-02), and any script
blocks every other user for up to 10 s at a time (SBX-03). The flush design also turns a saved write into a reported
failure on common paths (SBX-04, SBX-06, SBX-07), and the local model is true to the backend for five operation
kinds only (SBX-08).

## Findings at a glance

| ID | Severity | Confidence | Finding | Location |
|---|---|---|---|---|
| SBX-01 | critical | confirmed | A setter on `__arg0` runs with no CPU limit and hangs the process | `src/sandbox/SandboxRuntime.ts:285`, `:499`, `:729` |
| SBX-02 | high | confirmed | A no-op `Promise.prototype.then` makes a call hang for ever and leaks its slot | `src/sandbox/SandboxRuntime.ts:634-642` |
| SBX-03 | high | confirmed | Scripts run on the main thread; each blocks all users for up to 10 s | `src/sandbox/SandboxRuntime.ts:584`, `WORKER_THREADS.md` |
| SBX-04 | high | confirmed | Every flush reloads the page; a failed reload reports a saved write as failed | `src/sandbox/facade/CoreSource.ts:731-790` |
| SBX-05 | medium | confirmed | `applyToken` flushes and reloads once per call | `src/sandbox/facade/CoreSource.ts:23`, `:827` |
| SBX-06 | medium | confirmed | The rate limiter refuses mid-script and between chunks, leaving partial writes | `src/sandbox/SandboxHost.ts:412`, `:691` |
| SBX-07 | medium | confirmed | A write in flight at the wall-clock deadline commits but is reported as not applied | `src/sandbox/SandboxRuntime.ts:407-428` |
| SBX-08 | medium | confirmed | Reads after writes are true for five op kinds only; the rest read stale or `undefined` | `src/sandbox/facade/CoreSource.ts:478-522` |
| SBX-09 | medium | confirmed | One token can hold all four slots; the deadline counts queue time | `src/tools/backend/ExecuteCodeBackendTool.ts:125`, `:147` |
| SBX-10 | medium | confirmed (host cost suspected) | Result, console log and error text have no size cap | `src/sandbox/facade/CoreSource.ts:904-959` |
| SBX-11 | medium | suspected | Any read loads the whole page; the 50 MB cap does not fit in guest memory | `src/sandbox/SandboxHost.ts:83`, `:249` |
| SBX-12 | medium | confirmed | The facade is a 110 KB string with no check against the plugin types | `src/sandbox/facade/ApiSource.ts:11` |
| SBX-13 | medium | confirmed (effects suspected) | Runner and facade globals are writable and last between calls; guest code runs under sync library calls | `src/sandbox/facade/CoreSource.ts:1006-1010` |
| SBX-14 | medium | confirmed (geometry suspected) | A folded `appendChild` can jump over an op on an ancestor | `src/sandbox/facade/CoreSource.ts:650-675` |
| SBX-15 | low | suspected | Advancing `baseRevn` hides other users' changes from later writes | `src/sandbox/SandboxHost.ts:749-753` |
| SBX-16 | low | confirmed | After a failed chunk the guest never learns the ids that were created | `src/sandbox/facade/CoreSource.ts:760-769` |
| SBX-17 | low | confirmed | Facade deviations that fail silently (`addFlexLayout`, `textBounds`, unknown members) | `src/sandbox/facade/ApiSource.ts:425`, `:583`, `:1545` |
| SBX-18 | low | confirmed | Write options skip SVG imports, uploads and `rpc` writes; two doc claims are wrong | `src/sandbox/SandboxHost.ts:611-625` |
| SBX-19 | low | confirmed | Shapes below level 20 and missing ids vanish from the model without a warning | `src/sandbox/SandboxHost.ts:96`, `:305` |
| SBX-20 | low | suspected | Token values come from a catalogue that may be up to 120 s old | `src/sandbox/SandboxHost.ts:705-712` |
| SBX-21 | low | confirmed | Writes queued from a promise callback are dropped without a word | `src/sandbox/SandboxRuntime.ts:635` |
| SBX-22 | low | confirmed | No logging or counters; no cleanup on shutdown | `src/sandbox/SandboxSessions.ts`, `src/Tool.ts:80` |
| SBX-23 | low | confirmed (sizes suspected) | Avoidable costs per start, per read and per load | several |

---

## Findings in detail

### SBX-01 (critical, confirmed): guest code runs with no CPU limit when the host binds the arguments

Location: `src/sandbox/SandboxRuntime.ts:283-285` (`invoke`), `:499-505` (`bindArguments`), `:727-731`
(`shouldInterrupt`).

What is wrong. `invoke` calls `bindArguments` before `execute`. `bindArguments` calls
`context.setProp(global, "__arg0", …)`. The library maps that to `QTS_SetProp`, which is `JS_SetProperty`, so a setter
on the global object runs. At that point `activeRun` is `undefined`, and `shouldInterrupt` returns `false` when there
is no run. `__arg0` is an ordinary configurable property, and the runtime is kept for the token between calls.

Scenario. Call 1:

```js
Object.defineProperty(globalThis, "__arg0", { configurable: true, get() { return ""; }, set() { for (;;) {} } });
```

Call 2, same token: any script. The setter loops for ever on the Node main thread. No timer, signal handler, health
check or other session runs again. Only `SIGKILL` ends it, and the same two calls hang the restarted process. Any
token holder can do this.

Recommended change.
1. Do not write guest-visible properties outside a run. Put the arguments in the evaluated source as JSON string
   literals (`__runScript(${JSON.stringify(code)}, …)`), or set `activeRun` before `bindArguments`.
2. Make `shouldInterrupt` fail closed: return `true` when no run is active.
3. See SBX-13 (fresh context per call) and SBX-03 (a worker that can be terminated).

Effort: S.

### SBX-02 (high, confirmed): a script can make its call hang for ever, and the slot is never freed

Location: `src/sandbox/SandboxRuntime.ts:631-655` (`settle`), `src/tools/backend/ExecuteCodeBackendTool.ts:124-133`,
`src/sandbox/CallSlots.ts:41-61`.

What is wrong. `settle` calls `context.resolvePromise`. The library does this by reading `Promise`, `Promise.resolve`
and `then` from the guest and calling them. If the guest's `then` does nothing, the host promise never resolves. The
guard at `:639` passes, because the handle itself is fulfilled. `await outcome` at `:642` then waits for ever. Nothing
watches the call from outside: the wall-clock limit acts only through the interrupt handler and the host primitives.

Scenario. `Promise.prototype.then = function () {};` as the whole script. The call never returns. `executeBackend`
never reaches its `finally`, so the slot stays held and the runtime queue of the token stays blocked. Three more calls
(the same token is enough, see SBX-09) take the other three slots. From then on every user waits 60 s and gets
"execute_code is busy", until the process restarts. The idle sweep disposes the runtime entry but cannot free the slots.

Recommended change.
1. `__runScript` is synchronous, so drop the promise step: evaluate `__runScript(...)` and read the string from the
   value. If a promise must stay, read it with `getPromiseState` after `executePendingJobs`; that call runs no guest
   code.
2. Add a host watchdog: race `runtime.invoke` against `deadlineAt` plus a short grace. On expiry mark the runtime
   dead, drop it from the registry and release the slot.

Effort: S.

### SBX-03 (high, confirmed): scripts run on the Node main thread

Location: `src/sandbox/SandboxRuntime.ts:584` (`evalCodeAsync`), `src/sandbox/SandboxSettings.ts:4`,
`src/sandbox/WORKER_THREADS.md`. The file admits the problem; the report's open items do not list it.

What is wrong. Guest code runs synchronously between host calls. The interrupt handler stops a script but does not
yield. One script may hold the event loop for the whole CPU budget (10 s by default). Four slots let four such
stretches follow each other. While the loop is held, no HTTP request, token check, backend answer or timer is served.

Scenario. A user runs `for (;;) {}` in a loop of calls. Every other session stalls for 10 s per call. Another user's
script, waiting on a backend answer, loses that time from its own 120 s wall clock; when it trips, the error is fatal:
the runtime is discarded, `storage` is lost, and flushes already sent stay applied. `untilDeadline` timers of other
sandboxes also fire late.

Recommended change. Run each sandbox in a `worker_threads` worker. Serve host calls over a `SharedArrayBuffer` with
`Atomics.wait`, so the guest can call the host synchronously without asyncify (the plain build is smaller and
faster). `worker.terminate()` and `resourceLimits` then give a hard stop for CPU and memory, which also removes
SBX-01 and SBX-02 as process-wide risks. Until then: lower the default CPU budget to 2 or 3 s and admit one running
script per token.

Effort: L (interim steps: S).

### SBX-04 (high, confirmed): every flush reloads the touched pages, and a failed reload reports a saved write as failed

Location: `src/sandbox/facade/CoreSource.ts:731-749` (`reloadTouched`), `:773-785` (`flush`), `:788-790` (`end`),
`:225-234` (`reloadPage`); `src/sandbox/SandboxHost.ts:249-323` (`loadPage`), `:850-855` (`checkRevn`).

What is wrong. After a successful flush the core reloads each touched page in full. This also happens for the flush
at the end of the script, where nobody reads the result. The reload runs inside `flush`, so an error from it leaves
`flush` and `end`, and the script gets a failure envelope although the write is saved.

The reload can fail for reasons that have nothing to do with the write:
- another user changed the file between two of the reload's requests: "the file changed while the page was read; run
  the script again" (`SandboxHost.ts:852`);
- the byte cap, which adds up over reloads (`loadedBytes`, `SandboxHost.ts:316-319`): a page of 26 MB fails on its
  first reload, a page of 17 MB on its second;
- the rate limit or the wall clock (`admitPrimitive`).

It also burns the page-load cap: after 20 loads the core drops the page (`CoreSource.ts:227-230`) and the next read
fails with "execute_code loads at most 20 pages per script", in a script that touched one page.

Scenario. An agent adds 300 shapes to a page that a person is editing. The write commits. The reload sees a new revn
half way and throws. The agent reads "run the script again", runs it again, and the page now holds 600 shapes. The
"Applied before the failure" suffix is there, but it follows an instruction to retry.

Recommended change. After a successful flush, mark the touched pages stale (delete them from `state.pages`, as the
error path already does at `:764-766`) and load on the next read. Do nothing in `end()`. If a later read fails, say in
the error that the earlier write is saved. Count distinct pages, not loads, against the caps. Update
`Prelude.test.ts:329`.

Effort: S.

### SBX-05 (medium, confirmed): `applyToken` flushes and reloads once per call

Location: `src/sandbox/facade/CoreSource.ts:23` (`TOKEN_WRITE_PATTERN`), `:827-831` (`flushTokens`);
`src/sandbox/facade/ApiSource.ts:1474-1489`. The host has the right rule at `src/sandbox/ApplyTokenValues.ts:78-107`.
The test at `src/sandbox/facade/ApiSource.test.ts:771-797` records the behaviour as expected.

What is wrong. `flushTokens` flushes when a pending op name matches `/token|theme|toggle_set/`. `apply_token` matches,
so each `applyToken` after the first sends the one before it as its own write, then reloads the page (SBX-04). The
host copy of the rule leaves `apply_token` and `unapply_token` out; the guest copy does not.

Scenario. `shapes.forEach((s) => s.applyToken(token, ["fill"]))` over 100 shapes makes 99 writes and up to 19 full
page loads. It uses two rate-limit tokens per shape. On a fast backend the bucket (burst 20, 10 per second) runs dry
near shape 20 and the script stops with "rate limited", with part of the work saved. On a slow one it nears the wall
clock.

Recommended change. Leave `apply_token` and `unapply_token` out of the guest rule. Share one definition through the
prelude, as `PROPERTY_MAP` is shared, so the two copies cannot drift again.

Effort: S.

### SBX-06 (medium, confirmed): the rate limiter refuses in the middle of a script and between chunks

Location: `src/sandbox/SandboxHost.ts:412-414`, `:691-696`; `src/backend/TokenRateLimiter.ts:53-69`.

What is wrong. `admitPrimitive` charges the token bucket for each host call and for each chunk after the first. The
limiter throws when the bucket is empty; it does not wait. The same check refuses a chunk once the deadline has
passed. So a flush of several chunks can commit chunk 1 and lose chunk 2 for a reason unrelated to the data.

Scenario. A script reads `penpot.library.local.tokens` 25 times in a loop (each read is a host call, see SBX-23) and
then flushes 4,000 operations. The bucket is empty at chunk 2. 1,500 operations are saved, 2,500 are not.

Recommended change. Wait instead of throwing: the wait is host time, which the CPU budget already leaves out, and the
deadline bounds it. Admit a whole flush before its first chunk (charge all chunks, check that time remains), and do not
refuse between chunks.

Effort: S.

### SBX-07 (medium, confirmed): a write in flight at the deadline commits but is reported as not applied

Location: `src/sandbox/SandboxRuntime.ts:407-428` (`untilDeadline`), `:592-597`;
`src/tools/backend/ExecuteCodeBackendTool.ts:161-168`.

What is wrong. `untilDeadline` races every host call, writes included, against the wall clock. When the timer wins,
the guest is stopped and the tool reads `host.summary()` at once. The backend call is still running. Its commit lands
after the response, so `opsApplied`, `chunks` and `createdIds` leave it out. For a single-chunk flush the error has
no "Applied before the failure" part at all.

Scenario. A 1,500-operation flush on a slow file is in flight at second 120. The agent gets "The script exceeded the
wall-clock time limit" and no applied writes. The 1,500 shapes are there. The agent runs the script again.

Recommended change. Do not abandon writes. Race only reads against the deadline; let a write finish (the HTTP
timeout bounds it), then stop the script. Or, on expiry, await the host call in flight before reading the summary.

Effort: S.

### SBX-08 (medium, confirmed): the local model follows five op kinds; other reads are stale or `undefined`

Location: `src/sandbox/facade/CoreSource.ts:478-522` (`applyLocal`), `:317-324` (`updateLocal`);
`src/sandbox/facade/ApiSource.ts:504-512`, `:738-742`, `:2020-2032`, `:585-588`. The tool description
(`ExecuteCodeBackendTool.ts:113`) and `data/backend_instructions.md:212` say a read after a write sees the change.

What is wrong. `applyLocal` handles creates, `update_shape`, `move_shapes`, `reorder`, `delete_shapes` and groups.
Every other op has no local effect until a flush. Even the handled ones merge props only: no reflow, no text size,
no move of children with their board, no `selrect` update.

Scenarios, all silent:
- `text.characters = "Hi"; return text.characters;` returns the old text.
- `const c = shape.clone(); c.width` is `undefined`; `c.children.length` throws a bare TypeError.
- `const i = component.instance(); i.x` is `undefined`.
- `board.addFlexLayout(); board.flex` is `null`.
- `shape.setPluginData("k", "v"); shape.getPluginData("k")` is `""`.
- `board.x += 100; child.x` is the old value, and `child.parentX` is off by 100.
- `shape.x = 5; shape.bounds` uses `record.selrect` when the record has one (`ApiSource.ts:505`), so it is unchanged.
- Two `addInteraction` calls before a flush both get the same `index` (`ApiSource.ts:2430-2433`), so `remove()` on
  the second removes the first.

An agent that computes positions from such reads writes wrong geometry and sees no error.

Recommended change. Track pages with a pending op that has no local effect. On the next read of such a page, flush
and reload (or throw an error that names `penpot.waitForLayoutUpdate()`). Give cheap ops a local effect (text, plugin
data, the layout flag, interactions). Correct the two descriptions.

Effort: M.

### SBX-09 (medium, confirmed): one token can hold every slot, and the deadline counts time in the queue

Location: `src/tools/backend/ExecuteCodeBackendTool.ts:125`, `:146-147`, `:161-168`;
`src/sandbox/SandboxRuntime.ts:283-284`; `src/sandbox/SandboxSessions.ts:180-196`.

What is wrong.
1. A call takes a global slot first and then queues on the runtime of its token. Four parallel calls of one token
   hold all four slots while one runs. Other users wait up to 60 s and then fail.
2. `deadlineAt` is set before the runtime queue. A call that waits behind a long call of the same token starts with
   little or no time. It trips the wall clock, which is fatal: the runtime is discarded and `storage` is lost.
   `backend_instructions.md:236` says the limit starts when the script starts to run.
3. A call queued behind a fatal one fails with "runtime was discarded" and is not retried on a fresh runtime. The
   same happens to a call queued on a runtime that the LRU rule evicts.

Scenario. An agent sends two `execute_code` calls in parallel, 70 s each. The second starts with 50 s left, fails at
the wall clock after saving part of its work, and wipes the `storage` the first call filled.

Recommended change. Take a per-token turn (one running script per token, short queue) before the global slot. Start
the wall clock inside the runtime task (pass `wallMs` to `invoke`). On "runtime was discarded", acquire again once.

Effort: S.

### SBX-10 (medium, confirmed; host memory cost suspected): no size cap on result, log or error text

Location: `src/sandbox/facade/CoreSource.ts:904-909` (`successEnvelope`), `:953-959` (`emit`);
`src/tools/backend/ExecuteCodeBackendTool.ts:167-183`, `:253-264`; `src/Tool.ts:80-81`;
`src/tools/backend/BackendTool.ts:152-158`.

What is wrong. The guest may return or log as much as its memory holds (128 to 256 MB). The host copies the envelope
out, parses it, splits the log, prints it with indentation, measures it, parses it again and runs a binary search of
re-prints to trim it. Only then does the 1 MB cap apply. On the error path there is no cap at all: the log and the
`createdIds` map are joined into the error message, sent to the client and written to the server log.

Scenario. `console.log("x".repeat(1e8)); throw new Error("e")`. The client receives a 100 MB error and the server log
gets the same text. Four such calls at once may cost the host several times 400 MB; that can end the process (a run
must confirm the numbers).

Recommended change. Cap the log (say 256 KB, head and tail kept) and the result (1 MB) inside the core. Check
`raw.length` on the host before `JSON.parse`. Trim error text in the tool. Validate the envelope with zod instead of
a cast (`:263`).

Effort: S.

### SBX-11 (medium, suspected): any read loads the whole page, and the page cap does not fit in guest memory

Location: `src/sandbox/SandboxHost.ts:83` (`MAX_LOAD_BYTES`), `:249-323`; `src/sandbox/facade/CoreSource.ts:183-210`;
`src/sandbox/facade/ApiSource.ts:271-281`, `:686-692`.

What is wrong. The first read of any shape property loads every shape of the page: the tree in pages of 5,000, then
the shapes in batches of 200, one after another. Setting `fills` also reads the record (`ApiSource.ts:687`), so a
script that only writes still loads the page. The cap is 50 MB of JSON, but the guest must hold the text and the
parsed objects inside a memory that stops at 256 MB and is spent above 128 MB. A page far below 50 MB is likely to
run out of memory. A 100,000-shape page needs about 500 `get-mcp-shapes` calls and may pass the 50 MB cap, so
`execute_code` cannot work on the files this branch is about.

What would confirm it: load pages of 5, 15, 30 and 50 MB in the sandbox and record time and memory.

Recommended change. Load by need: one shape and its children by id (`get-mcp-shapes`), searches through
`find-mcp-shapes`, an LRU of records. Do not read a record to route a `fills` write. As a first step, set the byte
cap to what the guest can parse and say so in the error.

Effort: L (first step: S).

### SBX-12 (medium, confirmed): the facade is a string, with no check against the plugin API

Location: `src/sandbox/facade/ApiSource.ts:11` (110 KB in `String.raw`), `CoreSource.ts:10`, `UtilsSource.ts:9`;
`src/sandbox/facade/ApiSource.test.ts:221-237`, `UtilsSource.test.ts:202-218`, `src/sandbox/Prelude.test.ts:178`.

What is wrong.
- No type check, lint or editor help reaches the facade source. A `${` or a backtick typed into it breaks or changes
  the module at load.
- Nothing ties it to `@penpot/plugin-types`. The package is not a dependency of the server, and no test compares
  member lists. A new plugin API release changes nothing here until an agent's script fails.
- The facade tests run the source in Node's `vm` (V8), not in QuickJS. Engine differences are not tested.
- Coverage is partial and the gaps do not report themselves (SBX-17).

Recommended change.
1. Write the guest as TypeScript modules under `src/sandbox/guest/`, with a `tsconfig` that has `lib: ["ES2020"]`
   and no Node or DOM types.
2. Type the public objects against the plugin types: `satisfies` for what is built, and a typed list of what is not
   available. Drift then fails the type check.
3. Bundle with esbuild (already a dev dependency) to one IIFE file at build time; the prelude reads that file.
4. Add a parity test: read the members of `Penpot`, the shape types, `Page`, `File`, the library and layout types
   from the `.d.ts` (or from `data/api_types.yml`, which the server already ships) and require each to be built or
   listed as not available.
5. Run the facade tests in QuickJS.

Effort: L.

### SBX-13 (medium, confirmed; effects suspected): runner and facade globals are writable and last between calls

Location: `src/sandbox/facade/CoreSource.ts:1006-1010`, `src/sandbox/facade/ApiSource.ts:3225-3238`;
`src/sandbox/SandboxRuntime.ts:485-492` (`readBoolean`), `:681-683` (`failure`), `:341`, `:362` (`newError`).

What is wrong.
1. `__core`, `__host`, `__runScript`, `__drainLog`, `console`, `penpot`, the built-in prototypes and `JSON` are plain
   writable values in a context that serves every later call of the token for up to 30 minutes. A script can replace
   the runner or the facade for the scripts that follow. This gives no new authority (the token is the same, and the
   host checks every op again), but it lets one script change what later scripts do and report. The `fileId` argument
   of the tool is a convenience, not a limit: a script can call `__host.flush(otherFileId, …)`.
2. The host runs guest code under library calls that must not suspend. `readBoolean` calls `context.dump` on the third
   argument of `__host.flush`; an object there runs its `toJSON`. `failure` dumps the thrown value, which runs its
   getters. `newError` sets `name` and `message`, which runs a setter on `Error.prototype`. If that code calls
   `__host.*`, the library throws "Function unexpectedly returned a Promise" with an asyncify unwind pending. From
   the code, the result is a fatal error and a discarded runtime, and the orphan backend call still completes (a write
   may commit after the error is reported). The `runningJobs` guard at `:340` covers the job queue only.

Recommended change. Use a fresh context for each call and keep `storage` as size-capped JSON on the host (it then
survives recycling and fatal errors too). If that costs too much, define the runner globals as non-writable and
non-configurable, freeze the core, the host object and the facade objects, and capture `JSON` and `Promise` in
closures. Do not `dump` guest values: check `typeof` first or pass booleans as strings, and have a frozen guest
helper describe errors as a string.

Effort: M.

### SBX-14 (medium, confirmed for the reorder; geometry suspected): a folded `appendChild` can jump over an op on an ancestor

Location: `src/sandbox/facade/CoreSource.ts:650-675` (`foldMove`), `:668`.

What is wrong. A move folds into its create when no later op names the child, and no op at or after the create names
the parent. An op that names neither can still change the result: an update of an ancestor of the parent, a delete of
an ancestor, a duplicate of a sibling.

Scenario. Board `A` holds board `B`, both saved.

```js
const r = penpot.createRectangle(); r.x = 10;   // create at the root, x 10
A.x = A.x + 100;                                 // names A only
B.appendChild(r);                                // folds: the create now has parent B
```

In order: `r` is made at 10, `A` moves, `r` goes into `B` and stays at 10. Folded: `r` is made inside `B` at 10, then
`A` moves and takes `r` to 110. This assumes that the compiler moves children with their board and that a move keeps
the absolute position; the backend reviewer can confirm. A deleted ancestor gives a second case: in order the move
fails; folded, the script succeeds and the new shape is gone.

Recommended change. Fold a move only when every op kept after the create is itself a create. That still covers the
grid case (`ExecuteCodeScenarios.test.ts:332`). Add a test with an op on an ancestor between the create and the move.

Effort: S.

### SBX-15 (low, suspected): advancing `baseRevn` hides other users' changes from later writes

Location: `src/sandbox/SandboxHost.ts:741-755`, `:460-462`.

What is wrong. After each commit the base becomes the revn of that commit. A change by someone else that landed
between the caller's base and the script's first commit is older than the new base. A later flush or chunk that
touches the same shape sees no conflict, also with `failOnConflict: true`.

What would confirm it: how the backend picks the changes it compares (the write-path reviewer knows).

Recommended change. Keep the caller's base and let the backend leave out the script's own commits (for example by a
list of its revns), or advance only when the answer shows that no foreign change lies between.

Effort: M.

### SBX-16 (low, confirmed): after a failed chunk the guest never learns the ids that were created

Location: `src/sandbox/facade/CoreSource.ts:760-769`; `src/sandbox/SandboxHost.ts:420-425`, `:778-793`.

What is wrong. A chunk failure throws, so the core gets no `createdIds` for the chunks that were saved. Proxies of
those shapes keep handles that no alias resolves. A script that catches the error cannot use them; a later op that
names one fails as an unknown id. Separately, `withIds` replaces any string equal to a created handle anywhere in a
later chunk, text and names included.

Recommended change. Return a structured failure that carries the ids of the saved chunks; the core sets the aliases
and then throws. Limit `withIds` to the id fields of each op.

Effort: S.

### SBX-17 (low, confirmed): facade deviations that fail silently

- `addFlexLayout` and `addGridLayout` return nothing (`ApiSource.ts:1545-1550`); the plugin API returns the layout.
  `const flex = board.addFlexLayout(); flex.dir = "column"` throws a bare TypeError. Not in `backend_instructions.md`.
- `textBounds` returns the raw `positionData` (`ApiSource.ts:583-584`), not a rectangle, and nothing for text made
  by the backend. `penpotUtils.getBounds` and `isContainedIn` use it for text (`UtilsSource.ts:211-227`).
- An unknown shape member reads as `undefined` (`ApiSource.ts:425`); a missing method fails as "not a function" with
  no hint. Examples: `getRange`, `applyTypography`, `isMask`, `toD`.
- `penpot.selection` returns `[]` although the table lists it as not available (`ApiSource.ts:3089-3091`).
- Library colours and typographies are raw records without `asFill`, `asStroke` or `applyToText`.
- No `setTimeout`: a script that uses it gets a bare ReferenceError.

Recommended change. Make the proxy throw the "not available in backend mode" error for an unknown string key (keep
`then` and symbols as `undefined`). Return the layout view from `addFlexLayout`. Build `textBounds` from the box.

Effort: S each.

### SBX-18 (low, confirmed): write options skip some writes, and two claims in the docs are wrong

Location: `src/sandbox/SandboxHost.ts:611-625`, `:556-602`, `:639-660`; `src/backend/FileWriteQueue.ts:28-29`;
`ExecuteCodeBackendTool.ts:109-112`.

`snapshot`, `baseRevn` and `failOnConflict` go to `mcp-apply-operations` only. An SVG import, a media upload and an
`rpc` write do not carry them, yet the description says they "apply to every call". The description also says no
other write of this server lands between chunks; the queue key holds the token digest, so a write by another token
through the same server can.

Recommended change. Pass the options to `mcp-import-svg`, or say which writes they cover. Reword the second claim.

Effort: S.

### SBX-19 (low, confirmed): deep shapes and missing ids vanish without a warning

Location: `src/sandbox/SandboxHost.ts:96`, `:240`, `:305-312`.

The tree is read to depth 20, the backend maximum. Shapes below that are not in the model: `getShapeById` returns
`null` and `children` skips them. Ids that `get-mcp-shapes` reports as missing are skipped too. Nothing tells the
script.

Recommended change. Add a warning to the call when the depth limit is hit or an id is missing.

Effort: S.

### SBX-20 (low, suspected): token values may be stale, and errors name a batch index only

Location: `src/sandbox/SandboxHost.ts:705-712`, `src/sandbox/ApplyTokenValues.ts:51-61`, `:137-144`.

The catalogue is read once per call and file and dropped only after the script's own token writes. A script may run
for 120 s. A token or set that someone else changes in that time is applied with the old value, and no warning says
so. Separately, errors name "operation 37" of the folded batch, which the script author cannot map to a line.

Recommended change. Tie the catalogue to a revn and read it again when a write answer shows a foreign change. Keep,
per queued op, the facade call and shape name, and add them to flush errors.

Effort: M.

### SBX-21 (low, confirmed): writes queued from a promise callback are dropped

Location: `src/sandbox/SandboxRuntime.ts:635` (`runJobs` after the script's last flush), `:340-343`.

`AwaitRewriter` refuses `await` and async functions, but not `Promise.resolve().then(cb)`. The callback runs in
`runJobs`, after `end()` has flushed. Ops it queues are never sent, and host calls in it are refused inside the job.
The call reports success.

Recommended change. After the jobs run, check for pending ops and fail the call with a clear message, or refuse
`.then` in the rewriter.

Effort: S.

### SBX-22 (low, confirmed): no logging or counters, and no cleanup on shutdown

Location: all of `src/sandbox/*.ts` (no logger); `src/Tool.ts:80`; `src/PenpotMcpServer.ts:577`;
`src/sandbox/FontCatalog.ts:24`.

The sandbox logs nothing: not a limit trip, a poisoned or recycled runtime, an eviction, nor the CPU time, host calls
and memory of a call. An operator cannot see who trips limits. The only log line is the full error text in `Tool.ts`,
which may hold console output with design data. `PenpotMcpServer.stop()` does not dispose the sandboxes, so a
shutdown can cut a flush between two chunks. `FontCatalog` reads `data/fonts.json` from the working directory at
import time and throws there if the directory is wrong.

Recommended change. Log one structured line per call (token fingerprint prefix, CPU ms, wall ms, host calls, ops,
WebAssembly bytes, outcome) and count limit trips. On stop, refuse new calls, wait for running flushes, then dispose.

Effort: S.

### SBX-23 (low, confirmed; sizes suspected): avoidable costs

- Start: each runtime loads and compiles the 1 MB WebAssembly file and parses about 165 KB of prelude
  (`SandboxRuntime.ts:201-217`). The library takes a shared compiled module (`wasmModule`); the code does not pass
  one. A script that grows past 128 MB pays this again on the next call.
- Page load: batches of 200 ids are sent one by one; each batch is serialised only to count bytes, then the whole
  page is serialised again (`SandboxHost.ts:296`, `:314`). No cache by revn, so every script and every flush reads the
  page anew.
- Property read: each read builds the page key with `JSON.stringify` (`CoreSource.ts:114-116`, reached from
  `ApiSource.ts:271-281`).
- `detachChild` scans the sibling list (`CoreSource.ts:252-260`). A new shape is last in the root list, so each
  folded `appendChild` scans the whole root: quadratic on a page with many top-level shapes.
- `penpotUtils.findShapeById` loads every page and walks proxies (`UtilsSource.ts:137-173`); a file with more than
  20 pages hits the page cap. The model has a map.
- `penpot.library.local.tokens` makes a backend call on every access (`ApiSource.ts:2642-2652`); the helpers in
  `UtilsSource.ts:358-385` call it in loops. Each call also costs a rate-limit token.
- `decodeBase64` runs in guest JavaScript, with `indexOf` per character and a plain array of bytes
  (`ApiSource.ts:2623-2637`). An 8 MB export may use much of the CPU budget and memory. Hand the bytes over as an
  ArrayBuffer instead.
- `restackShape` sends the whole child list for each `bringToFront` (`ApiSource.ts:771-786`).

Effort: S each; a revn cache is M.

---

## Answers to the questions

1. **Isolation.** Eight host functions on `__host` (`SandboxRuntime.ts:118-127`). All take strings, one takes a
   boolean, all return strings. The guest has no Node API, no module loader, no timers and no network of its own. It
   reaches the backend only under the caller's token, through fixed commands and an allow-list of 18 `rpc` names
   (`SandboxHost.ts:114-137`). The token stays on the host. Runtimes are keyed by token digest and a host object is
   made per call, so one user cannot reach another's data or state. Marshalling is JSON text both ways; I found no
   host prototype pollution (a `__proto__` key in `withIds` changes one copy only). The facade is injected as source
   and the script can change all of it, but the host validates every op and the backend enforces the token, so a
   script cannot write where the token cannot. Open points: `uploadMediaUrl` lets a script make the backend fetch any
   http(s) address (data can leave that way; the backend's address policy is the control), SBX-13, and the size of
   strings (SBX-10).
2. **Limits.** CPU: wall time minus host time, checked by the interrupt handler; a tight loop stops after the budget;
   a promise that never settles is reported; but see SBX-01 and SBX-02 for two paths with no limit. Memory: a hard
   256 MB WebAssembly maximum per sandbox, which holds for every allocation in the instance; not for host copies
   (SBX-10). Stack: 256 KB, catchable in the guest. Output and log: no cap (SBX-10). Operations: 5,000, counted in
   guest and host. Pending promises: bounded by memory only; no timers exist. When a limit trips, that token's
   runtime is discarded and `storage` is lost; other sessions feel it only through the blocked event loop (SBX-03).
3. **Lifecycle.** One runtime per token, at most 50 (least recently used goes first), four calls at once, 60 s queue.
   A runtime is replaced when disposed, poisoned or idle above 128 MB, and evicted after 30 idle minutes (sweep every
   60 s). Nothing is disposed on shutdown (SBX-22). Leaks: SBX-02. Blocking: SBX-03.
4. **Flush.** Yes, a later chunk can fail after earlier ones commit; the error names the chunk and the count, and the
   summary keeps the ids. The guest drops the batch and its page cache, so a later read is true to the backend, but
   handles of saved shapes are dead (SBX-16). Order inside the queue is submission order per token and file. Reads
   after writes: SBX-08. Related: SBX-04, SBX-06, SBX-07, SBX-15.
5. **Fidelity.** SBX-12 and SBX-17.
6. **`FoldIndex` and `ApplyTokenValues`.** The update fold is safe as built, because creates are always at the root
   and a folded move seals the shape. The move fold has one gap (SBX-14). Token values: SBX-05 and SBX-20.
7. **Performance.** SBX-04, SBX-05, SBX-11, SBX-23.
8. **Practice.** `strict` is on. One cast hides a non-promise return (`SandboxRuntime.ts:342`); the envelope is cast,
   not validated (`ExecuteCodeBackendTool.ts:263`). Handle disposal is right on the normal paths. One error class
   with a `fatal` flag serves well. No logging (SBX-22).
9. **Tests.** See the list below.

## Strengths worth keeping

- A string-only boundary, with the token and every backend call on the host side.
- The host trusts nothing from the guest: it counts operations, pages, bytes, host calls and exports itself, and
  validates each op with zod before anything is sent.
- A separate `WebAssembly.Memory` with a hard maximum per sandbox, and the recycle rule. This is the limit that holds.
- The CPU budget leaves out host time; the wall clock is separate; a fatal error poisons the runtime.
- The `runningJobs` guard shows the asyncify hazard was understood; it needs to cover the other entry points.
- `AwaitRewriter` parses with acorn and keeps offsets, so line numbers stay true.
- `FoldIndex` is linear, conservative (sealing, parent order) and tested.
- Chunk failure messages are exact, and each call carries a `requestId`.
- The tests cover the CPU, memory, wall-clock, host-call and chunk paths well.
- The docs are frank about when `storage` is lost.

## Tests that are missing

- Tampering: redefine `__runScript`, `__host`, `__core`, `Promise`, `Promise.prototype.then`; an accessor on
  `__arg0`; a setter on `Error.prototype.message`; a thrown object with getters; `__host.flush("f", "[]", { toJSON })`.
- Absence of `require`, `process`, `fetch`, `setTimeout` and dynamic `import()`.
- Regular-expression backtracking and long built-in calls against the CPU limit.
- Size of result, log and error text.
- Two calls of one token at once; slot fairness between tokens; the deadline of a queued call; a call queued behind
  a fatal one; eviction of a runtime that is running.
- A reload that fails after a commit; reloads against the 20-load and 50 MB caps.
- A rate-limit or deadline refusal between chunks; a write in flight at the deadline.
- A fold with an op on an ancestor in between; a fold at a chunk boundary.
- Reads after `clone`, `instance`, `set_text`, plugin data and layout ops.
- The facade in QuickJS, and a member-list check against the plugin types.
- Writes queued from a promise callback.

## Questions that only a run can settle

1. Do the SBX-01 and SBX-02 scripts hang as the code says?
2. Does the interrupt handler fire inside regular-expression backtracking, `String.prototype.repeat`, `sort` and
   `JSON.stringify` in this QuickJS build? What is the longest stretch without a check?
3. What does a runtime cost to create with the real prelude, and how much does a shared compiled module save?
4. What is the largest page the guest can load, in bytes and shapes, and how long do 5,000, 20,000 and 100,000
   shapes take?
5. What is the host's peak memory when a script returns or logs 100 MB?
6. What does the engine do when guest code reaches `__host.*` inside `dump`, `newError` or `resolvePromise`: a clean
   error, or a damaged instance?
7. Does a flush sent as two calls give the same geometry as one call when a layout board is filled across the
   boundary?
8. Are module instances collected after dispose over 1,000 cycles that each grow to 256 MB?
9. Does `newString` fail cleanly when the text is larger than the free WebAssembly memory?
10. For SBX-14 and SBX-15: does `update_shape` on a board move its children, does `move_shapes` keep the absolute
    position, and which changes does the conflict check compare?
11. How much CPU and memory does `decodeBase64` use for an 8 MB export?
