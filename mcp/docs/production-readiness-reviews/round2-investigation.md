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

The frontend keeps the buffered local commits in `:persistence :buffer` (`persistence.cljs`). `get-pending-commits`
returns the queued commits, then the buffered ones, so a remote change undoes and redoes both. A flush moves the
flushed commits from `:buffer` to `:queue` in one update. A merged commit's undo changes run in reverse commit order
(`changes.cljs`). Unit tests cover the order and the flush. The fix is not re-run under the C3 load; that needs a
frontend build. The harness readback race is fixed in `human-tab.mjs`: it waits for the save responses before it
reads back.

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
