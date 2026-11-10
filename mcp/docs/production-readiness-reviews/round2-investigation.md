# Round 2 investigation: lost human edits, file_change scans, file_change cleanup

Date: 2026-11-08. Branch `perf/render-wasm-large-files` at `e4084f80b2` with a dirty tree.
Evidence: `mcp/packages/loadtest/results/2026-11-08-round2/run-notes.md` and the "Round 2"
section of `mcp/docs/production-readiness.md`. No product code was changed. The only write to a
database was the file_change cleanup run in Q3, against `penpot_mcpdev`.

The tab in C3 and C5 ran the `penpotapp/frontend:2.18` image (`docker inspect penpot-mcp-frontend`),
not this checkout. The code cited below is this checkout; the same code is in tag `2.18.6` and on
`develop` (see "Origin" under Q1).

## Q1: why the human tab lost its own edits (R2-01, R2-13)

### Answer in short

The tab loses an edit when three things meet: a local edit is still in the 3 s save buffer, an
earlier local edit is still queued (its save has not returned), and a change from another session
arrives over the websocket. The frontend rebases its queued edits under the remote change, but
not the buffered one, and the rebase writes absolute geometry, so the buffered edit vanishes from
the tab's state while it is still sent to the server. The next nudge starts from the stale
geometry, re-sends the lost coordinate with its old value (the "positions going backwards"), and
one press is lost for good. Slow saves keep the queue non-empty, which is why C3 run 1 (save p95
5 s) lost 39 presses and the control run (save p95 0.6 s) lost none.

The MCP agent's profile plays no part: any other session's write to the file triggers it, from
an agent or from a second human. The one lost press in C5 is not this bug: it is a harness
readback that ran before the last save committed (below).

### The rebase code

1. Each local edit becomes a `::commit` event. For a remote commit only, the watch computes
   `pending` from the persistence queue and applies the remote changes inside an undo/redo of it:
   `frontend/src/app/main/data/changes.cljs:228-232` (`pending (when-not local? (get-pending-commits state))`),
   `get-pending-commits` at `changes.cljs:74-78` (reads `(:queue persistence)` and nothing else).
2. `apply-changes-localy` undoes every pending commit (in reverse commit order), applies the
   remote changes, then redoes every pending commit: `changes.cljs:122-148`.
3. Local commits do not enter the queue at once. They wait in `rx/buffer-until` until 3 s pass
   with no new local commit, or a force-persist: `frontend/src/app/main/data/persistence.cljs:863-877`
   (`rx/debounce 3000`) and `persistence.cljs:937-945` (`buffer-until`, `merge-commit`,
   `append-commit`). A commit in that buffer is already applied to the state but is not in
   `:queue`, so `get-pending-commits` does not see it.
4. The queue only shrinks when the server answers: `discard-commit` runs on `::commit-persisted`
   (`persistence.cljs:279-294`, `598-609`), and the queue sends one commit at a time
   (`run-persistence-task`, `persistence.cljs:581-615`). With a 5 s save, the previous nudge stays
   queued for 5 s.
5. Shape edits are absolute. `update-shapes` emits `:set` operations with the new value for every
   attribute that changed, and the undo holds the old value:
   `common/src/app/common/files/changes_builder.cljc:570` and `584-600`. A move changes `:x` or
   `:y`, plus `:selrect` and `:points`, which carry both coordinates.

The loss, step by step, for the C3 pattern (ArrowRight and ArrowDown alternate every 5 s,
`mcp/packages/loadtest/scripts/human-tab/human-tab.mjs:34`, `600-626`):

- t=0, press X: commit X (x 126 to 127). At t=3 it is flushed into the queue; its save takes ~5 s.
- t=5, press Y: commit Y (y 125 to 126) applied to the state; it sits in the buffer until t=8.
- t=5 to 8, an agent's file-change frame arrives (C3 had about 8 a second). `pending` = [X].
  Undo X sets `:selrect` and `:points` back to their values before X (y=125 in both); the remote
  change applies; redo X sets them to X's values (still y=125). `:y` itself stays 126, because
  X has no `:y` operation. The tab's geometry now says y=125 while the server will get y=126.
- t=8, Y is flushed and saved with y=126. The server is right; the tab is not.
- t=10, press X: the nudge applies a move modifier to the stale geometry
  (`frontend/src/app/main/data/workspace/transforms.cljs:1125-1207`), so the shape's derived
  `:y` is 125, which differs from the stored `:y` 126, and the diff adds `:y 125` to the commit.

This is exactly what the decoded rows of the C3 tab session show (nREPL, `blob/decode` of
`file_change` where `file_id = 26a47292-e218-8131-8008-e9dae51b2ad7` and
`session_id = 825d39a1-ab0f-80d9-8008-e9e17d9888ec`, `:x`/`:y` operations only):

```
[2711 [[:x 126]]] [2771 [[:y 126]]] [2823 [[:y 125] [:x 127]]] [2867 [[:y 126]]]
[3484 [[:x 137]]] [3562 [[:y 134]]] [3987 [[:x 138] [:y 135] [:x 137] [:x 138] [:y 135] [:x 139]]]
```

Row 2823 is an ArrowRight commit that also carries `:y 125`, the coordinate lost after row 2771.
The next ArrowDown (2867) sends y=126 again: one press lost. Rows with several operations
(3267, 3987, 4535) are buffers that merged several presses while the save queue was blocked.
Before agents started (revn 2 to 25) every row holds one coordinate that moves forward.

Other things checked:

- The tab never receives its own changes: the backend drops file-change messages whose
  session id equals the subscriber's (`backend/src/app/http/websocket.clj:182-188`,
  `(remove #(= (:session-id %) session-id))`). The `update-file` answer carries `:revn` (the revn
  before the update) and `:lagged` (`backend/src/app/rpc/commands/files_update.clj:470`,
  `983-996`); the frontend reads only `:revn` (`persistence.cljs:523-526`) and never `:lagged`
  (`grep -rn lagged frontend/src common/src` finds no use). So no echoed old state overwrites the
  tab; the stale geometry comes from the tab's own rebase.
- Profile: MCP writes carry a session id derived from token, request id and payload
  (`backend/src/app/rpc/commands/mcp_write.clj:346-356`), never the tab's. The frontend's
  file-change handler does not look at `:profile-id` (`frontend/src/app/main/data/workspace/notifications.cljs:256-280`
  turns every message into a `:source :remote` commit). An agent on the human's own profile is
  treated like any other session. C3b lost nothing because its saves were fast (raw save p95
  618 ms), so the queue was empty most of the time and `pending` was nil.
- `merge-commit` concatenates the undo changes of a merged buffer in commit order, not reverse
  order (`persistence.cljs:805-814`). Redo still ends at the right values, so this does not lose
  data today, but the undo of a merged commit lands on an intermediate value.
- The file subscription channel uses `(sp/dropping-buffer 64)` (`websocket.clj:187`). Under a
  burst of agent writes a slow tab can drop remote file-change frames and miss other shapes'
  changes. Not seen in this run and not the cause of the lost presses, but worth a look.

### C5: the one lost press is a harness readback race

C5 had no writer on the file, so no remote commit and no rebase. The lost press is the last one:

- 60 presses, the last (tick 59, ArrowDown) at 09:43:05.392; `expected 130/130, found 130/129`;
  `pressToSave.unmatchedPresses` 1 (`results/2026-11-08-round2/human/c5/human-tab-2026-11-08T09-43-14-191Z.json`).
- The save for that press did commit with y=130: `file_change` revn 791 of file
  `97d26ac4-fedc-8109-8008-e6b09bf8c998`, decoded `[791 [[:y 130]]]`. Its row carries the
  request timestamp 09:43:08.692, and the same request inserted an automatic snapshot (revn 790,
  `created_at` 09:43:13.085, which `fsnap/create!` stamps with `now`). So that save was still
  running at 09:43:13.1.
- The harness waits until no new save has *started* for 4 s, sleeps 1 s and reads back through
  MCP (`human-tab.mjs:628-640`, `660-664`). It does not wait for the save's response, so it read
  y=129 before the commit; the result file was written at 09:43:14.190.

Harness fix: before the readback, wait until every save request has answered, or poll the
board until it matches or a timeout passes.

### Why saves were slow on the 100k file (R2-13, C5)

11 of the 59 C5 saves took 6.8 to 19.8 s, one every 25 s, that is every fifth save; all others
took about 200 ms. The `file_change` rows of the C5 file show an automatic snapshot every fifth
revn (730, 735, ... 790), each inserted 4 to 9 s into one of those saves. The dev backend runs
with `enable-auto-file-snapshot` (`/usr/local/bin/run-backend-dev` in `penpot-tc`), and
`take-snapshot?` takes one whenever `revn mod 5 = 0` (`files_update.clj:970-980`,
`backend/src/app/config.clj:45` `:auto-file-snapshot-every 5`, same value on `develop`). On a
100k-shape file each snapshot costs most of a 19 s save. In C3 the file was small, so the 5 s
saves there come from contention with five agents on the same file, not from snapshots.

### Origin

- `get-pending-commits` and the remote-only rebase: `changes.cljs:74-78` and `228-232`, blame
  `b633093336` (2026-10-17 merge) on develop, earlier `6436ef334b` ":recycle: Refactor persistence
  layer" (2023-07-25), which `git log -S"get-pending-commits"` names as the origin.
- The 3 s buffer and `merge-commit`: `persistence.cljs:805-814` and `873-877`, blame `6436ef334b`
  (2023-07-25).
- The same code is in `2.18.6` (`git show 2.18.6:frontend/src/app/main/data/changes.cljs`, lines
  71 and 199-202; `persistence.cljs` lines 874, 942, 944).
- Our MCP commits `2c33b0ff9a..HEAD` touch the frontend in two commits only (`541f965bf1`,
  `8e2c662a2d`: MCP client keys and the shared modifier rules) and neither changes
  `persistence.cljs`, `changes.cljs` or `notifications.cljs`. The branch diff of `changes.cljs`
  against `develop` is render-wasm work (`de6057aee4`, `324ffba741`) and does not touch
  `get-pending-commits` or the rebase. `persistence.cljs` is identical to `develop`. The bug is
  upstream and old; the MCP agents only make it likely by writing to the file often.

### Reproduction without MCP

Manual, in two browser tabs (two sessions; same or different users):

1. Open one file in tabs A and B. Draw two rectangles, R1 and R2.
2. In tab A open DevTools, Network, and add a throttling profile with about 5,000 ms latency.
   Chrome's throttling delays HTTP but not the websocket, which is what we want: A's saves take
   ~5 s while remote changes still arrive at once.
3. In A select R1 and press ArrowDown. Wait 3.5 s (the edit leaves the buffer and its save is in
   flight). Press ArrowRight. Within 3 s, in B, move R2.
4. In A, R1 jumps back one unit to the left on the canvas (the geometry lost the ArrowRight).
   Press ArrowDown: the save carries the old x. Reload A: R1's x is one less than the presses.

Automated: a frontend unit test that emits a local commit, force-persists it against an
`update-file` stub that never answers, emits a second local commit for the same shape (it stays
buffered), then emits a `:source :remote` commit for another shape, and asserts that the shape's
`:selrect` still holds the second commit's value. It fails today.

### Recommended fix

Make the rebase in `dch/commit` cover every local commit that the server has not yet
acknowledged, not only the queued ones: keep the buffered commits in the store (for example a
`:buffer` list in `:persistence`, added to on each local commit and moved to `:queue` on flush),
have `get-pending-commits` return buffer and queue in apply order, and read `pending` inside the
`UpdateEvent` of `apply-changes-localy` from the state it is about to change, not in the `::commit`
watch, so a flush or append between the two cannot slip out of the rebase. While there, build the
undo list of `merge-commit` in reverse commit order. A cheaper stopgap is to skip the undo/redo
when the remote changes touch no shape that a pending or buffered commit touches, but that only
narrows the window. The harness should wait for save responses before its readback (C5 above).

### Fix (2026-11-08)

The frontend keeps the buffered local commits in `:persistence :buffer` (`persistence.cljs`).
`get-pending-commits` returns the queued commits, then the buffered ones, so a remote change undoes
and redoes both. A flush moves the flushed commits from `:buffer` to `:queue` in one update. A
merged commit's undo changes run in reverse commit order (`changes.cljs`). Unit tests cover the
order and the flush. The re-run under the C3 load is below. The harness readback race is fixed in
`human-tab.mjs`: it waits for the save responses before it reads back.

### Re-run under load (2026-11-08, evening)

Frontend built from this tree (shadow-cljs release in `penpot-tc`, served on port 9003 through the
2.18 image's nginx; build notes and result files in
`mcp/packages/loadtest/results/2026-11-08-round2/human/after-fix/run-notes.md`). Harness:
`run-c3.mjs`, five agents (c2-same-file), 10 min, 120 s baseline, one adapter on 4405. The decoded
rows named below are in that folder (`human-rows-decoded.txt` in each run's directory).

- C3 with agents: 120 presses, 120 saves, 0 lost (160/160). The tab's 119 decoded rows carry one
  `:x` or `:y` each and every value is one above the previous. Save p95 was 0.76 s during the agents
  (round 2 run 1: 5 s), so the queue was mostly empty when a press landed in the buffer: the window
  described above opened rarely.
- Control, no agents: 120 presses, 120 saves, 0 lost.
- Slow saves on the fixed build (`--save-delay-ms 5000`: the harness holds each `update-file`
  response 5 s, the server commits at once): 43 saves, 48 `:x`/`:y` operations, none backwards and
  none repeated, last x=128 y=120. 72 presses never reached the server inside the run (the stall
  below).
- Slow saves on the stock 2.18 frontend (port 9002), same load: 40 rows, 51 operations, 10 not
  forward. Last x=117 y=131 against 160/160. This is the pattern of round 2 run 1; the fixed build
  does not show it under the same conditions.

```
[2970 [[:x 117] [:y 117] [:x 117] [:y 117] [:x 117] [:y 117] [:x 117]]]
[3437 [[:y 116] [:x 118]]]   after y=117
[3941 [[:y 118] [:x 117]]]   after x=118
[5221 [[:y 120] [:y 120]]] [5882 [[:y 121] [:y 121]]] [6521 [[:y 133] [:y 122]]]
```

Stall under slow saves, both builds: after the agents start, the tab's saves thin out. Fixed build
row times: 23:34:49, :54, :59, 35:04, :10, :16, :21, :27, :34, :42, :55, 36:16, 36:40, 37:09, 37:46,
38:33, 39:25, 40:33, 41:51 (gaps from 5 s to 78 s). Rows merge several presses (`[4081 [[:y 119] [:x
120] [:y 120] [:x 121]]]`, `[8072 [[:x 126] [:x 127] [:x 128]]]`), and from 37:09 the rows carry
only `:x`: `nudge-selected-shapes` (`frontend/src/app/main/data/workspace/transforms.cljs`) keeps a
gesture open until `finish-transform`, a nudge in another direction during an open gesture does
nothing (`::current-move-selected`), and same-direction presses join the open gesture. The gesture
closes 1 s after the last press, so this needs a main thread blocked for seconds. Websocket frames
received: 5,383 (fixed build) and 6,245 (stock) against 7,098 with fast saves, so the backend's
`dropping-buffer 64` dropped frames for the slow tab. Candidate cause: `apply-changes-localy` and
`update-indexes` run for every pending commit on every remote frame (about 9 a second here), and
with 5 s saves the pending set is never empty. Not measured; needs a profile. Pre-existing, since
2.18 stalls the same way. Recorded as R2-15 in `production-readiness.md`.

Measured on 2026-11-09 and fixed on 2026-11-10: the candidate cause was wrong. See 'Stall under slow
saves' below.

### Stall under slow saves: profile and fix (2026-11-09 and 2026-11-10)

**Method.** Headless Chromium runs `mcp/packages/loadtest/scripts/human-tab/run-c3.mjs --fresh-file
--agents 5 --minutes 8 --baseline-s 60 --save-delay-ms 5000 --frontend http://localhost:9003`. The
agents start at +60 s. A Node preload, kept outside the repo, takes 30 s CPU profiles of the tab's
main thread at +75 s, +200 s and +380 s after the first key press. Every 10 s it samples timer lag,
websocket frames delivered to the page, and requests sent to and answered by the web worker. Two
runs came before the fix (`before` and `before2`, 2026-11-09, frontend built from commit
`d42fc19da9`). Three runs came after it (`after`, `after2` and `after3`, 2026-11-10). Result files:
`mcp/packages/loadtest/results/2026-11-09-r2-15-stall/` (git-ignored, local).

**What the profile shows.** The candidate cause, the rebase, was wrong. `apply-changes-localy` took
1.1-1.2 % of main-thread time at +75 s and 0.2 % at +380 s. `update-indexes` took under 0.5 %. The
real cause has two parts.

- For a remote commit with N pending local commits, the `commit` event in
  `frontend/src/app/main/data/changes.cljs` emitted 2N+1 `update-indexes` events: N for undo, one
  for the remote change, and N for redo. Each one was an `:index/update` request to the web worker.
  Run `before2` sent 34,272 such requests for 5,222 remote frames: 5.0 requests a frame while two
  commits were pending, and up to 14.6 a frame as the save queue grew. The worker answered 60 to 120
  requests a second, so requests piled up. 218 waited 14 s after the agents started, and 36,049 were
  waiting at the end of the run. A reply came about 300 s after its request. Snap queries joined the
  pile (30,310 `:index/query-snap` requests in that run).
- `frontend/src/app/util/worker.cljs` gave every request its own `rx/filter` on one shared subject,
  so every worker reply was tested against every waiting request. That handler took 9.0 % (run
  `before`) and 13.7 % (run `before2`) of the main thread at +75 s, 49.8 % at +200 s, and 65.8 % and
  66.2 % at +380 s. UUID equality alone was 9.6 % of the samples at +200 s.

Other shares in run `before` at +75 s / +200 s / +380 s: React rendering 44.6 % / 30.1 % / 19.2 %;
the websocket message handler 19.8 % / 9.8 % / 4.7 %; idle 5.0 % / 0.2 % / 0.1 %.

**Effect.** Timer lag on the main thread reached 21.4 s (run `before`) and 17.3 s (run `before2`).
There were 36 and 28 saves in the 8 min. The longest gap between two save starts while the agents
wrote was 65 s and 49 s. The tab received 5,635 and 5,301 `file-change` frames for 7,859 and 8,317
agent calls (72 % and 64 %). The backend dropped the rest for the slow tab. The agents had 0 errors
and a p50 of 247 and 237 ms.

**The fix.** The fix was uncommitted at the time of writing, on branch
`perf/render-wasm-large-files`. In `frontend/src/app/main/data/changes.cljs` there is one
`update-indexes` per commit. `get-rebase-changes` builds one list: the undo changes of the pending
commits (latest first), the remote changes, then the redo changes of the pending commits in commit
order. The worker gets one `:index/update` request per page. `apply-changes-localy` and the file
data path are unchanged. In `frontend/src/app/util/worker.cljs`, each request waits in a `js/Map`
keyed by its sender id, and a reply is looked up by `reply-to`. The cost of a reply no longer grows
with the number of waiting requests. The public functions (`ask!`, `emit!`, `ask-many!`,
`ask-buffered!`, `init`) are unchanged. Unit tests: 5 in
`frontend/test/frontend_tests/data/changes_test.cljs` and 6 in
`frontend/test/frontend_tests/util_worker_test.cljs`. The full frontend suite passed with 1,716
tests, 6,880 assertions, 0 failures and 0 errors.

**Re-run.** Three runs on 2026-11-10 (`after`, `after2`, `after3`). The frontend was built from
`9362a12b75` plus the fix. This build also has the nudge fix `2706dfb8ed` and the save retry
`628365d39f`, which the `before` build did not have.

| | before | before2 | after | after2 | after3 |
|---|---|---|---|---|---|
| Agent calls (0 errors in all) | 7,859 | 8,317 | 3,373 | 3,170 | 1,597 |
| Agent p50, ms | 247 | 237 | 363 | 547 | 1,061 |
| `file-change` frames the tab received | 5,635 | 5,301 | 3,333 | 3,130 | 1,579 |
| `:index/update` requests | not counted | 34,272 | 3,429 | 3,208 | 1,675 |
| Most worker requests waiting | not counted | 36,049 | 23 | 1,069 | 150 |
| Longest timer lag, s | 21.4 | 17.3 | 2.3 | 8.2 | 4.1 |
| Saves in 8 min | 36 | 28 | 83 | 63 | 71 |
| Longest gap between save starts while agents wrote, s | 65 | 49 | 12 | 56 | 16 |
| Worker reply handler, share of main thread at +75 / +200 / +380 s, % | 9.0 / 49.8 / 65.8 | 13.7 / not taken / 66.2 | 0.6 / 0.4 / 0.7 | 4.0 / 2.6 / 0.9 | 1.3 / 1.4 / 1.1 |
| React rendering, same windows, % | 44.6 / 30.1 / 19.2 | 47.1 / not taken / 20.1 | 38.3 / 42.0 / 46.1 | 56.0 / 51.6 / 50.9 | 32.8 / 39.6 / 36.1 |

- Index requests per remote frame: 1.0 in all three runs (before: 5 to 14.6).
- The tab received 99 % of the agents' changes in each run (3,333 of 3,373; 3,130 of 3,170; 1,579 of
  1,597), against 72 % and 64 % before.
- The worker's pile no longer grows without end. It peaks and returns to 0-5 waiting requests.
- Remaining cost after the fix: React rendering of the remote changes is the largest share (33-56
  %); the websocket handler takes 8-15 %; the rebase 1-2 %.

**What the re-run does not show.**

1. The load was lower in the `after` runs. The machine ran at 90-100 % CPU on 2026-11-10 (a game and
   other test sessions ran on it), so the agents were slower and sent 41 %, 38 % and 19 % of the
   calls of run `before2`. Run `after` also overlapped a Postgres incident (connection limit reached
   09:17-09:23 UTC). So the runs show the cause removed and the stall reduced. They do not show the
   tab at the frame rate of 2026-11-09. A re-run on an idle machine is still to do.

2. Run `after2` still slowed for about three minutes (+68 s to +260 s): timer lag up to 8.2 s, save
   starts at 61, 70, 94, 124 and 180 s, then one every 6-8 s again. In that stretch the tab sent up
   to 1,230 `:index/query-snap` requests in 10 s (40 in 10 s without agents), and 1,069 requests
   waited. Index updates stayed at one a frame. React rendering was 52-56 % of the main thread, and
   the thread had no idle time. The tab recovered without help; the `before` runs never did. Not
   investigated: where the snap queries come from while a nudge gesture is open and remote frames
   arrive.

3. The readback at the end found fewer presses than sent in every `after` run: x/y found 143/142,
   148/147 and 140/139, against 148/148 expected. With each save response held 5 s, a save takes
   5.8-6.9 s (p50). The tab presses a key every 5 s, and each flush is one save, so the queue grows.
   The harness waits at most 60 s after the last press and then closes the browser. Saves were still
   starting every 5-7 s when it closed (run `after`: 485, 492, 499, 508, 516, 523 and 529 s; the
   last press was at 475 s). The decoded `file_change` rows were not checked in these runs, so
   "queued, not lost" is the likely reading, not a proven one. The fix does not touch the file data
   path.

**Side findings.** Both are pre-existing and not fixed.

- The worker message codec (`frontend/src/app/worker/messages.cljs`, `encode`/`decode`) does not
  carry the `:dropped` flag that `app.worker` sets when it drops a buffered request. The caller of a
  dropped request gets a reply with no payload instead of an empty stream.
- `mcp/packages/loadtest/scripts/human-tab/README.md` says the harness reads `PENPOT_HUMAN_EMAIL`,
  but `human-tab.mjs` reads only the `--email` flag.

## Q2: the 138 sequential scans on file_change in the soak

### Answer in short

The sequential scans come from the soak sampler's own `select count(*) from file_change`, run once
a minute (`mcp/packages/loadtest/scripts/round2/soak-sampler.mjs:412`). That is harness, not
product code. Every product statement on `file_change` uses an index; no new index is needed.

### Evidence

`pg_stat_statements` is filtered to `penpot_mcpdev` (`join pg_database d on d.oid = s.dbid where
d.datname = 'penpot_mcpdev' and s.query ilike '%file_change%'`); stats reset at 04:49:36 UTC.

| calls | buffers | statement | source | plan |
|---|---|---|---|---|
| 233 | 1,702,520 | `select count(*) from file_change` | sampler, `soak-sampler.mjs:412` | Seq Scan (EXPLAIN ANALYZE: 107,682 rows, 14,349 buffers, 55 ms) |
| 1,165 | 3,456,686 | `select count(*) from file_change where file_id = $1` | sampler, per-file rows, `soak-sampler.mjs:419` (5 files x 233) | Index Only Scan `file_change__file_id__session_id__idx` |
| 65,425 | 186,755 | `select 1 from file_change c where c.file_id = $1 and c.session_id = $2 limit 1` | MCP replay check, `mcp_write.clj:374-387` | Index Only Scan `file_change__file_id__session_id__idx`, both columns as Index Cond, 3 buffers, 0.06 ms |
| 209 | 1,594 | `... where s.file_id = $1 and s.revn > $2 order by s.revn, s.created_at` | `get-lagged-changes`, `files_update.clj:983-996` | Index Scan `file_change__file_id__revn__idx` |
| 14,210 | 26,101,051 | `select c.id ... where c.file_id = $1 and c.created_by = $3 and c.label like $4 and (c.deleted_at is null or c.deleted_at >= $2) order by c.created_at, c.id` | MCP snapshot pruning, `files_update.clj:539-546` | Bitmap Index Scan on `file_change__file_id__created_at__labelled__idx` |
| 28,206 | 635,841 | `UPDATE file_change SET deleted_at = $1 WHERE id = $2 AND file_id = $3` | snapshot pruning | `file_change_pkey` |
| 65,632 + 24,538 | | the two `INSERT INTO file_change` | change rows and snapshots | n/a |

`pg_stat_user_tables` (`select seq_scan, seq_tup_read, idx_scan from pg_stat_user_tables where
relname = 'file_change'`): 146 seq scans and 11,719,800 tuples read since the reset, about
80,000 tuples a scan, the table's average size during the soak (45,200 to 107,682 rows): every
seq scan read the whole table, which only an unfiltered count does.

Why 138 and not ~230 (one per sample): the planner picks between a seq scan and an index-only scan
of the whole `file_change__data_ref_id__idx` for that count. Now they cost 15,694 and 15,919
(`explain select count(*) from file_change`, then the same with `set enable_seqscan = off`), and
the balance moves with `relallvisible` (10,978 of 14,338 pages now) after each autovacuum.
`file_change__data_ref_id__idx` shows 97 index scans, close to the 92 samples that did not
seq-scan (the index may also serve other lookups, so this match is close but not proof).

Migration 0159 (`backend/src/app/migrations/sql/0159-add-file-change-indexes.sql`) adds
`(file_id, session_id)` for the replay check and `(file_id, created_at) WHERE label IS NOT NULL`
for the snapshot listings. The existing `(file_id, revn)` serves `get-lagged-changes`, and the
objects GC uses `file_change__deleted_at__idx` (`explain select id from file_change where
deleted_at is not null and deleted_at <= now() order by deleted_at`: Index Only Scan).

Not a seq scan, but the costliest product statement on `file_change`: the MCP snapshot pruning
query. It ran 14,210 times, used 51 s of database time and read 1,837 buffers per call, to return
20 rows a call. EXPLAIN ANALYZE on the busiest soak file: 4,245 labelled rows found through the
partial index, 3,963 filtered out (`created_by`, `label like 'mcp/%'`, `deleted_at`), 3,363 heap
blocks visited, 15.6 ms. The labelled rows are mostly automatic snapshots (`internal/snapshot/...`,
13,897 rows in the table), which the `label like 'mcp/%'` filter rejects only after the heap visit.
A narrower partial index, `(file_id, created_at) WHERE created_by = 'system' AND label LIKE 'mcp/%'`,
would let the query skip them. Optional; it does not affect plan 8.1.

To keep the plan 8.1 check about product code, the sampler should read `n_live_tup` from
`pg_stat_user_tables` (or `reltuples`) instead of `count(*)`, or the report should subtract the
sampler's own scans.

## Q3: file_change growth and the nightly cleanup

### Answer in short

The objects GC runs once a day at 00:00 and deletes every `file_change` row whose `deleted_at` has
passed. Change rows get `deleted_at` one hour after the write; automatic snapshot rows get the
team deletion delay (7 days on this database). Run now against `penpot_mcpdev`, it deleted
86,305 expired rows in 28.8 s (about 3,000 rows a second). At 15,600 rows an hour a day is about
375,000 rows, about two minutes of GC: it keeps up with a wide margin. Between runs the table
holds up to 25 hours of change rows (about 390,000 at the soak rate). The soak did not see it
because the GC runs only at midnight and does not catch up a missed run.

### Where it is

- Schedule: `backend/src/app/main.clj:1006-1007`, `{:cron #penpot/cron "0 0 0 * * ?" :job :objects-gc}`
  (daily at 00:00, server time).
- Threshold: `execute-objects-gc` uses `(ct/now)` unless `:skip-delay` is passed
  (`backend/src/app/tasks/objects_gc.clj:756-767`); the file_change section selects
  `deleted_at IS NOT NULL AND deleted_at <= ?` ordered by `deleted_at` (`objects_gc.clj:675-679`),
  locks each chunk with `FOR UPDATE SKIP LOCKED` (`681-687`) and deletes row by row, one
  transaction per chunk of 100 (`689-725`, chunk size `732-734`).
- Expiry of change rows: `deleted-at (ct/plus timestamp (ct/duration {:hours 1}))` and the insert
  at `backend/src/app/rpc/commands/files_update.clj:356` and `399-411`.
- Expiry of automatic snapshots: `snapshot-deleted-at (ct/plus timestamp (ldel/get-deletion-delay team))`
  (`files_update.clj:355`, `370-376`); `get-deletion-delay` returns the configured default for a
  team with no subscription (`backend/src/app/features/logical_deletion.clj:16-32`). On this
  database the remaining snapshot rows expire between 2026-11-11 and 2026-11-15, 7 days after
  creation.
- No catch-up: the cron schedules the next valid instant from now (`backend/src/app/worker/cron.clj:134-150`).
  The `job` table shows the last `objects-gc` run on this database at 2026-11-06 00:00:03 to
  00:00:07 UTC, result `{"processed": 4637}`; none on 11-07 or 11-08. The current backend JVM started
  at 08:55 UTC today (`/proc` start time in `penpot-tc`), after the chaos restart.

### The run

Run through nREPL in `penpot-tc` (the job's own file_change section, with the job's threshold and
chunk size; the other sections of the job, such as files, teams and file_data, were not run so
that nothing else in the dev database changed):

```clojure
(let [pool (:app.db/pool app.system/system)
      cfg  {:app.db/pool pool ::ogc/threshold (ct/now) ::ogc/chunk-size 100}]
  (#'ogc/delete-file-changes cfg))
```

Result at 14:08:16 to 14:08:45 UTC:

| measure | value |
|---|---|
| rows before | 107,682 |
| expired rows before (`deleted_at <= now()`) | 86,305 |
| deleted | 86,305 |
| run time | 28.8 s (about 3,000 rows/s, 864 chunks of up to 100) |
| rows after | 21,377 |
| expired after | 83 (rows that expired during the run) |

The 21,377 rows left: 7,313 change rows written in the last hour of the soak (expire by 14:49) and
14,064 snapshot rows (13,897 automatic `internal/snapshot`, 167 MCP), which expire 7 days after
creation (`select changes is not null, label is not null, count(*), min(deleted_at), max(deleted_at)
from file_change group by 1, 2`). `pg_stat_user_tables` afterwards: `n_dead_tup` 0 (autovacuum
ran), `file_change__deleted_at__idx` used for the candidate scan, `file_change_pkey` for the lock
and the row deletes.

### Does it keep up

Yes for change rows: about 375,000 rows a day at the soak rate is about 125 s of GC at the
measured speed, once a night. The cost is the steady state between runs, up to 25 hours of rows
(1 hour of life plus up to 24 hours of waiting), about 390,000 rows and 0.9 GB at 37 MB an hour,
not the GC run. The automatic snapshots are the slower part: 5,678 were created in the soak
(1,420 an hour, one per five revisions with `enable-auto-file-snapshot`), each with a `file_data`
payload, and they live for the deletion delay (7 days here, 30 or 90 for paid plans) rather than
one hour. At the soak rate that is about 240,000 snapshot rows on a seven-day plateau. That flag
is on in the dev script but is not in the default flag set (`common/src/app/common/flags.cljc:227-257`);
operators who enable it should size for it.

## Commands and files

All in `C:/Users/colli/AppData/Local/Temp/claude/2f4543b12a7f72c0/367536da-914a-442d-83aa-fee0ff1931ef/scratchpad/`
(session scratchpad, not kept):

- Decoding of change rows and the GC run: nREPL scripts `dec.clj`, `dec3.clj`, `gc.clj`, run with
  `/tmp/nrepl.sh` in `penpot-tc`; outputs `dec.out`, `dec3.out`, `gc.out`.
- SQL outputs: `q2a.txt` to `q2e.txt`, `q3a.txt` to `q3g.txt`, `c5rows.txt`, `c5snaps.txt`.
