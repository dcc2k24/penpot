# Review: backend write path and storage (BWP)

Scope: `mcp_write.clj`, `files_update.clj`, `fdata.clj`, the objects map, `pointer_map.clj`, and their tests, at
commits `2c33b0ff9a` and `541f965bf1`. Read-only: nothing was run. "Confirmed" means the code shows it. "Suspected"
means the code allows it and a run must show the size or the timing.

## Verdict

The write path is atomic and correct in the cases I could trace: one transaction per call, side effects after commit,
no partial commit, no deadlock found. Its weak point is cost and contention. The call holds the file lock, a project
row lock and a pooled connection from the first read to the commit, and each batch reloads and rewrites the whole
touched page, so the 300-object split no longer buys what the plan wanted from it. Fix the batch loop (decode once,
persist once), move the project touch to the end, and add a duplicate-request check before more agents use it.

## Answers to the nine questions, in short

1. **Locks.** `pg_advisory_xact_lock(file)` is taken in `load-write-file` (`mcp_write.clj:468`) and again, re-entrant,
   in each `update-file!` (`files_update.clj:191`). It is released only at commit. From batch 1 the call also holds
   `FOR SHARE` then an update lock on the `file` row (`files_update.clj:465`, `binfile/common.clj:844`), an update
   lock on the `project` row (`files_update.clj:484`), and at times the `team` row (`files_update.clj:244`). The
   compiler, every decode and encode, validation and the snapshot all run under these locks, inside the transaction,
   on one pooled connection. No lock order cycle found. No retry: `::retry/enabled` is not set, so nothing is retried
   by the backend, and the adapter tells the agent not to retry blindly. See BWP-01, BWP-03, BWP-12.
2. **Editors.** MCP commits always extend the stored revn under the lock, so there is no lost update at the data
   level. `vern` is read at load and checked per batch, so a restore during the call fails the call cleanly
   (`:vern-conflict`). `base-revn` only drives a warning. An open tab gets one `file-change` message per batch with
   that batch's full changes; a shared library also sends them to the team topic. See BWP-08, BWP-10, BWP-11, BWP-14.
3. **Atomicity.** No partial commit is possible: every write uses the call's connection, the snapshot prune job is
   inserted in the same transaction (`jobs/submit` joins it), and msgbus and cache work run in `db/after-commit`.
   Audit and webhooks run outside `wrap-db-transaction`, so after commit. With the `storage` file-data backend,
   blobs are uploaded on another connection by design and are left for the storage GC on rollback. A retried call
   is not idempotent (BWP-04).
4. **Performance.** Loaded per call: the main blob K+1 times, each touched page K+1 times (K = batches), every page
   when a snapshot fires, every page of every linked library for `mcp-apply-operations`. Rewritten per batch: the
   whole fragment of each touched page plus the main blob. About 20 statements per batch. See BWP-02, BWP-06,
   BWP-07, BWP-09.
5. **Storage.** `file_change` rows expire after one hour. Each batch leaves one dead copy of each touched page in
   `file_data` until `file_gc` runs, and `file_gc` runs only on files idle for two days. Up to 20 `mcp/` snapshots
   per file, each a full copy. Media ownership is checked, but deleted media pass (BWP-16).
6. **`fdata` and the human path.** The "skip unloaded pointer page" rule is safe. A `PointerMap` loads itself on
   every `assoc` or `dissoc` (`pointer_map.clj:177-208`), so an unloaded page cannot have changed in the call, and
   the old code did not mark such a page as modified either (the `assoc` of an identical objects map returns
   `this`). One visible effect: a pointer-map file that gains `fdata/objects-map` now converts pages one by one as
   they are touched, where before the first save converted all of them. Readers guard with `objects-map?`
   (`files_thumbnails.clj:100`, `pages.cljs:118`, `api.cljs:2652`), so the mixed state is tolerated. No finding.
7. **Validation and caps.** Same checks as a human save, which with default flags means none (BWP-05). Caps: 2,000
   changes or operations, 8 MB, 100,000 compiled changes. No cap on duration or on bytes of compiled changes
   (BWP-13).
8. **Best practice.** See BWP-17.
9. **Tests.** See BWP-18.

## Findings

### BWP-01 (high, confirmed): the file lock and the transaction are held for the whole call

- Location: `backend/src/app/rpc/commands/mcp_write.clj:458-471` (lock, then load), `:473-481` (compile under the
  lock), `:334-377` (all batches in the same transaction); `backend/src/app/rpc/commands/files_update.clj:190-191`.
- What: the advisory lock is a transaction lock, so it lasts from `load-write-file` to the commit. The plan split
  bulk writes into 300-object commits "so a human tab is not blocked for long by the per-file lock" (plan lines
  730-731, 836-838: about 1.5 s per commit). An earlier review made the call one transaction. The split stayed, but
  it no longer releases the lock between batches.
- Scenario: the report measures 9.5 s for a 5,000-shape write. A designer on the same file saves during that call.
  The save waits on `pg_advisory_xact_lock` for up to 9.5 s, holding a pooled connection and an
  `update-file/global` permit. Nothing bounds this: no `lock_timeout`, only `statement_timeout = 300 s`
  (`db.clj:110`). A call near the 100,000-change cap could hold the lock for minutes. Agents of other users on the
  same file queue the same way, each holding one of the 10 `mcp-apply/global` permits, so one busy file can stall
  MCP writes on other files. The plan's gate (human save p95 up by less than 500 ms, test C3) was not measured.
- Recommend: (1) shorten the hold with BWP-02; (2) set a per-call time budget, checked between batches, that fails
  with a clear code; (3) `SET LOCAL lock_timeout` for MCP calls so a second agent fails fast with `:conflict`
  instead of waiting with a connection in hand; (4) later, compile outside the lock against revn R, then lock,
  re-check R and recompile if it moved.
- Effort: M (1 to 3), L (4).

### BWP-02 (high, confirmed): each batch reloads and rewrites the whole touched page

- Location: `mcp_write.clj:349-373`; `files_update.clj:193`, `:566-570` (blob decode per batch), `:413-427`;
  `backend/src/app/features/fdata.clj:293-303`; `backend/src/app/util/pointer_map.clj:177-190` (new id on first
  change); `backend/src/app/binfile/common.clj:827-849`.
- What: `commit-batches!` calls `update-file!` once per batch. Each call selects the file and its main blob again,
  decodes it, loads the touched page fragment, applies the batch, encodes the whole page, inserts it as a **new**
  `file_data` row (the pointer gets a new id), upserts the main blob, updates `file` and `project`, upserts about 90
  migration names, and selects and decodes its own change row (BWP-14). The compiler has already applied the same
  changes once in memory, so every change is processed twice.
- Cost: for K batches into one page, bytes encoded and written are the sum of the page size after each batch. A
  5,000-shape write in 17 batches writes about 9 times the final page, and leaves 16 dead fragments. A write of 17
  batches into a page that already holds 100,000 shapes writes that page 17 times. Statements: about 20 per batch.
  Dead fragments stay until `file_gc`, which only takes files not modified for two days
  (`tasks/file_gc_scheduler.clj:19-29`, `tasks/file_gc.clj:175-201`), so a file that agents write every day is
  never collected.
- Recommend: add a batch-aware entry point (`update-file-batches!`) that decodes once, then for each batch applies,
  validates, inserts the `file_change` row and queues the notification, and persists the file once at the end. This
  keeps small change rows and small messages, makes the encode O(page) per call, and cuts each extra batch to one
  insert. It also removes most of the lock time in BWP-01.
- Effort: M.

### BWP-03 (high, confirmed): a long call holds the project row and blocks saves to other files

- Location: `files_update.clj:484-487` (`persist-file!` updates `project.modified_at`), reached from batch 1.
- What: the `UPDATE project` takes a row lock that lasts until the commit. Every other save in the same project
  runs the same update and waits. For a human save the lock lasts milliseconds. For an MCP call it lasts from the
  end of batch 1 to the commit.
- Scenario: an agent bulk-writes file A for 9 s. Two designers work on files B and C in the same project. Their
  saves pass their own file locks, then stop at `UPDATE project` until the agent commits. The same holds for the
  `team` row when the call first stores new features (`files_update.clj:236-247`). The "20 agents on separate
  files" figure used small writes, where this does not show.
- Recommend: touch the project once per call, as the last statement before commit (a flag on `update-file!` to
  skip it, then one update in `run-write`), or do it in `db/after-commit` on its own connection.
- Effort: S.

### BWP-04 (medium, confirmed): `request-id` gives no idempotency, so a retry duplicates shapes

- Location: `mcp_write.clj:247-252`, `:580`, `:625-634`; compiler ids from `uuid/next` at `:480`.
- What: `request-id` only feeds the session id and the snapshot label. No code looks for an earlier commit with the
  same id. When a response is lost after commit (proxy timeout, dropped connection) the adapter says "may or may
  not have been applied" (`PenpotBackendClient.ts:187`). An agent that sends the call again gets a second set of
  shapes with new ids.
- Recommend: under the file lock, look for a `file_change` row with this file id and the call's session id (it is
  a pure function of token and request id). If one exists, fail with `:conflict :mcp-duplicate-request` and the
  stored revn, or return the first result if it is stored. State the one-hour window in the contract. Make the
  adapter send a stable `request-id` per tool call.
- Effort: S to M.

### BWP-05 (medium, confirmed): MCP writes are validated only if deployment flags say so, yet report `ok`

- Location: `files_update.clj:725-732`, `:787-806`; `mcp_write.clj:644`; `common/src/app/common/flags.cljc:217-253`
  (neither `file-validation` nor `file-schema-validation` is a default flag).
- What: the human path can run without referential checks because the editor builds its changes. `mcp-apply-changes`
  takes raw change records from an agent. On a default deployment the only check is the change schema inside
  `process-changes`. The result still says `validation: {ok: true}`, hard-coded.
- Scenario: an agent sends an `add-obj` whose parent does not list it, or a copy without its main. The commit
  succeeds, the result says valid, and the editor later hits the broken tree.
- Recommend: force the affected-shapes check for MCP commits whatever the flags (a `::force-validate` param read
  by `process-changes-and-validate`), at least for `mcp-apply-changes`. Report which checks ran instead of a fixed
  `ok`.
- Effort: S.

### BWP-06 (medium, confirmed): every `mcp-apply-operations` call loads all pages of all linked libraries

- Location: `mcp_write.clj:381-389` (`library-map`), `:391-412`, `:481`, and again at `:617` for a dry run.
- What: `library-map` reads each library in the recursive library set and derefs its components and **every
  page**, before the compiler knows whether any operation needs a library. A dry run does it twice. The commit
  path already has a lazy answer for the same need: `bfc/get-resolved-file-libraries` returns a weak, load-on-read
  map.
- Scenario: a file linked to a 60 MB design-system library. Renaming one rectangle reads and decodes 60 MB, under
  the file lock. Twenty agents doing small edits each hold their own copy.
- Recommend: pass a lazy map (load a library on first lookup, load its pages on first deref), and build it once
  per call so the dry run reuses it.
- Effort: S to M.

### BWP-07 (medium, confirmed; size suspected): after-commit callbacks pin every batch's file in memory

- Location: `files_update.clj:921-948` (`send-notifications!`), `:890-919`, `:430-433`.
- What: each callback closes over `file` (the decoded file of that batch, with its loaded pages) and `params`
  (which holds `:file` with the raw main blob, `:team` and `:changes`). The callbacks live until the commit. Each
  batch decodes the file afresh, so the K copies share nothing.
- Scenario: 17 batches into a page with 100,000 shapes keep 17 decoded copies of that page alive until commit. At
  about 1 KB per stored shape that is over 1 GB for one call; ten such calls may run at once
  (`mcp-apply/global`).
- Recommend: read `file-id`, `revn`, `vern`, `is-shared`, `team-id`, `profile-id` and `session-id` into locals
  before building the callback, and close over those and `changes` only.
- Effort: S. Confirm the size with a heap histogram during a split write on the large file.

### BWP-08 (medium, suspected): a burst of batch notifications can be dropped, and message size has no cap

- Location: `backend/src/app/msgbus.clj:72-75` (publish channel is a dropping buffer of 128), `:110-112`
  (`put!` never blocks); `files_update.clj:927-948`.
- What: a split call queues K callbacks and fires K `pub!` calls back to back after commit. If more than 128
  messages are pending, the rest are dropped without a log line. The editor applies `file-change` messages as they
  come and has no gap check, so a tab that misses one batch drifts from the stored file. Each message carries the
  batch's full changes; a call without `allow-split` puts up to 100,000 changes in one message and one
  `file_change` row. For a shared library the same changes also go to the team topic, so every open tab of the
  team receives them (`library-change?` includes `add-obj`, `mod-obj`, `del-obj`).
- Scenario: 1,500 operations that each instantiate a 30-shape component give about 150 batches. Twenty agents
  writing in bursts compete for the same 128 slots while each publish sends megabytes to Redis.
- Recommend: bound batches per call below the buffer, or send one "file changed, reload from revn N" message when
  a call has more than a set number of changes; log a drop. Cap compiled changes by bytes as well as count.
- Effort: M. Confirm by counting messages received for a call with more than 128 batches.

### BWP-09 (medium, confirmed): the automatic snapshot fires per batch inside a split call

- Location: `files_update.clj:576-578`, `:812-823`; `mcp_write.clj:360-362`; default `auto-file-snapshot-every 5`
  (`backend/src/app/config.clj:45`).
- What: this adds to open item 2. The MCP snapshot goes with batch 0 only, so `take-snapshot?` is live for batches
  1 to K-1, and each batch bumps the revn. With the default of 5, a 17-batch call takes about three automatic
  snapshots. Each loads every page and stores a full copy of the file. Each holds a half-applied call, a state the
  user never saw; restoring `internal/snapshot/<revn>` from the middle gives half a bulk write.
- Recommend: pass a `::skip-auto-snapshot` flag for every batch of a call that takes or has taken its MCP
  snapshot, or for all batches after the first.
- Effort: S.

### BWP-10 (medium, confirmed): the conflict check reads change rows that expire, and bounds rows, not bytes

- Location: `mcp_write.clj:229-245`; `files_update.clj:362-363` (rows are dated one hour ahead), `:855-888`;
  `backend/src/app/tasks/objects_gc.clj:675-678`.
- What: (a) `file_change` rows are deleted by the objects GC after their date. A `base-revn` older than that reads
  fewer rows than `stored-revn - base-revn`, but `truncated?` stays false. `fail-on-conflict` then passes although
  a human changed the same shapes. (b) The cap is 500 rows. MCP rows can be megabytes each, so one lag read can
  fetch and decode hundreds of megabytes, under the file lock, to build a warning.
- Recommend: select `revn` with the rows and set `truncated?` when the lowest revn read is above `since + 1` or
  rows are missing; with `fail-on-conflict` and a truncated read, fail with `:mcp-revn-conflict` (or a new code)
  instead of passing. Add a byte budget using `octet_length(changes)`.
- Effort: S.

### BWP-11 (medium, suspected): migrate-on-read can overwrite a long MCP commit; a dry run can write

- Location: `backend/src/app/binfile/common.clj:240-259`, `:827-849`; `mcp_write.clj:464-471`.
- What: `bfc/get-file` migrates and persists a file on read, with no advisory lock and no revn guard; the human
  `get-file` command does the same (`files.clj:200`). This is old behaviour, but the window was a few
  milliseconds. Now: an MCP call on a file that needs migration runs for seconds. A user opens the file meanwhile.
  Their read loads the old row, migrates it, and its `UPDATE file` waits on the MCP row lock. After the MCP commit
  the update runs with the stale row (data and revn), so the agent's commit is lost while its `file_change` rows
  remain. Also, the dry-run path calls `bfc/get-file` without `:read-only? true`, so a dry run with `mcp:read`
  and viewer rights persists a migration, without the file lock. The contract says a dry run does not touch the
  database.
- Recommend: pass `:read-only? true` in the dry-run branch of `load-write-file` (S). For the race, make the
  migration write conditional (`WHERE id = ? AND revn = ?`) or take `pg_try_advisory_xact_lock` and skip the write
  when busy (M, shared code). The same guard closes a smaller gap: the MCP load reads the file before it holds the
  row lock, so `file_gc` could rewrite the file between load and batch 1.
- Effort: S + M. Confirm with two sessions on a file that needs migration.

### BWP-12 (low, confirmed): climit ids make the owner's own saves wait behind their agents

- Location: `backend/resources/climit.edn:18-19`, `:81-85`; `mcp_write.clj:684-686`, `:709-711`, `:738-740`.
- What: MCP writes also take `update-file/by-profile` (1 permit). The token's profile is the human owner, so
  while an agent call runs, that person's saves on **any** file wait for the permit (queue 5, 60 s, then 429).
  The plan's aim was that an agent cannot starve human edits; for the owner it does the reverse. Also
  `mcp-apply/by-profile` (2 permits) can never run two calls, and a waiting call holds an `mcp-apply/global`
  permit. Two deployment facts: limits are per backend instance, and an id missing from the production climit
  file runs with no limit (stated in the file header); with default flags there is no climit at all.
- Recommend: drop `update-file/by-profile` from MCP writes or give MCP its own single permit; set
  `mcp-apply/by-profile` to what is meant; add the new ids to the production file before release.
- Effort: S.

### BWP-13 (low, confirmed): size checks run after the lock and the load; no cap on time or SVG size

- Location: `mcp_write.clj:582-583` (load, then `derive`), `:697`, `:722`, `:751` (`check-size!` inside
  `derive`), `:108-112` (`payload-bytes` encodes the whole payload again to measure it), `:99` (`[:svg :string]`).
- What: an oversized call takes the file lock, loads and decodes the file (and may migrate it) before it is
  refused. Every call pays a second transit encode of its payload. The SVG text is bounded only by the HTTP body
  limit and is parsed twice under the lock.
- Recommend: run `check-size!` before `load-write-file`; measure by request content length or a counting stream;
  give `:svg` a `:max`.
- Effort: S.

### BWP-14 (low, confirmed): `laggedCount` cannot be other than 0, and costs a read per batch

- Location: `mcp_write.clj:370-372`; `files_update.clj:440`, `:825-838`.
- What: the call reads the revn under the file lock and commits on it, so no other session can have a row above
  it. `get-lagged-changes` returns only the batch's own row, which is selected and blob-decoded, then filtered
  out. The one case that counts is the server's own repair row (`repair-session-id`), which is not "another
  session". The contract's definition (rows "committed after the call loaded the file") cannot happen.
- Recommend: skip the lagged read for MCP calls and drop the field, or define it as rows between `base-revn` and
  the stored revn, which `revn-lag` already reads.
- Effort: S.

### BWP-15 (low, confirmed): the forced-snapshot rule misses token deletes

- Location: `mcp_write.clj:59-61`, `:258-267`; `common/src/app/common/files/changes.cljc:1029-1068`.
- What: `:set-token`, `:set-token-set` and `:set-token-theme` with nil `:attrs` delete a token, a whole set or a
  theme. They are not in `delete-types`, so a call that deletes a token set with `snapshot: false`, or with fewer
  than 101 operations, takes no snapshot.
- Recommend: treat those three types with nil `:attrs` as deletes.
- Effort: S.

### BWP-16 (low, confirmed): `check-media!` accepts media marked as deleted

- Location: `mcp_write.clj:203-206`.
- What: `sql:media-owners` has no `deleted_at IS NULL`. `file_gc` marks unused media as deleted and the objects
  GC removes them later. A shape can be pointed at a media row that is about to go.
- Recommend: add the filter and report such an id as `:mcp-foreign-media` or a clearer code.
- Effort: S.

### BWP-17 (low, confirmed): idiom and hygiene

- `files_update.clj:544-549`: a failed snapshot is raised as `:type :validation` and the `catch` takes
  `Throwable`. A storage or SQL failure is not the caller's fault; use `:internal` (or `:restriction`) and catch
  `Exception`.
- `mcp_write.clj:391-412` repeats `fdata/realize-pointers` (`fdata.clj:317-323`); `library-map` can call that.
- `files_update.clj:346-351`, `:444-446`: the `::changed-shape-ids-since` hook is used by one test and no caller;
  the docstring at `:166` says "Two optional MCP hooks" and lists three.
- `::mcp-write?` names the caller, not the behaviour. It only means "snapshot loads pointers only". That choice is
  right for every caller, so making it the rule would also close open item 3.
- `files_update.clj:256-272`: the success timing log hangs on `rph/with-defer`, which fires only for an RPC
  response. MCP batches read `::stored-revn` from the result and drop it, so MCP commits log no `update-file`
  timings.
- `mcp_write.clj:636-637` and `mcp.clj:138-145`: change metrics and the "ok" log line are written before the
  commit.
- `mcp_write.clj:251`: the session id is a version 3 UUID; the contract says version 5.
- `mcp_write.clj:273-306`: `split-batches` trusts that the ranges are contiguous from 0. A check that the batch
  sizes sum to `(count changes)` would stop a silent loss if the compiler ever changes.
- Effort: S for all.

### BWP-18 (medium, confirmed): the commit path is tested with validation off and never under contention

- Location: `backend/test/backend_tests/helpers.clj:83-89` (`:disable-file-validation`);
  `rpc_mcp_write_path_test.clj:152-179`, `:452`.
- Missing tests:
  - a split commit with `file-validation` on (each batch is validated on a half-built state; only the dry run is
    tested with the flag);
  - two writers on one file, and a human `update-file` during an MCP call (lock wait, lagged rows, what the tab
    receives);
  - a real failure in batch k, not a stub of `update-file!`: assert that `file_data` fragment rows, the snapshot
    row and the prune job are gone, not just the revn and change rows;
  - the same `request-id` sent twice;
  - a restore or a migration between load and commit (`vern-conflict`, BWP-11);
  - the automatic snapshot inside a split call (BWP-09);
  - a human `update-file` on a pointer-map file with unloaded pages, and a pointer-map file whose pages still hold
    plain-map objects when `fdata/objects-map` arrives (the two `fdata` tests go through MCP commands only);
  - the real caps (8 MB, 100,000 changes) rather than a redefined cap of 3; the `storage` file-data backend.
- Effort: M.

## Strengths worth keeping

- One commit path for humans and agents (`update-file!`), so lock, revn, vern, features and notifications cannot
  drift.
- True all-or-nothing: no code path commits part of a call; the prune job joins the transaction; msgbus and cache
  work wait for the commit, which also fixed the human path.
- Operations compile against the stored data under the lock, so stale agent reads cannot corrupt the file.
- `vern` is taken at load and checked per batch, so a concurrent restore fails the call instead of mixing states.
- Pointer-only snapshots and the "skip unloaded page" rule are sound and well argued; both have tests.
- `batch-failure` keeps the original error and adds operation indexes without touching the database.
- Bounded lag read that never fails the write on a bad row; media ownership check at any depth.
- The limiter sits outside the transaction, so a queued call holds no connection.

## Questions only a run can settle

1. How long does a human save wait during a 5,000-shape and a 20,000-shape MCP write on the same file, and on
   another file of the same project (BWP-01, BWP-03)?
2. Heap held at commit time for a split write into the 100,000-shape page (BWP-07).
3. Are notifications dropped for a call with more than 128 batches, or with 20 agents in bursts (BWP-08)? What is
   the largest message Redis and the websocket carry before a tab stalls?
4. WAL volume and `file_data` growth for a 17-batch write, before and after `file_gc` (BWP-02).
5. Does the migrate-on-read race lose the MCP commit as read (BWP-11)?
6. With `file-validation` on, does a split write of interdependent operations pass per-batch validation?
7. With the `storage` backend, how many objects does a rolled-back split call leave, and does the storage GC
   remove them?
8. Behaviour with two backend instances: per-instance climit totals, and message order across instances.
