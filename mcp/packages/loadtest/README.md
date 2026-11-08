# mcp-loadtest

Performance and load test harness for the backend-native Penpot MCP server. It talks to the real MCP endpoint
over Streamable HTTP, so the tests cover the adapter, the token check and the serialization. Each simulated agent
has its own MCP session and its own token.

The plan this serves is `mcp/backend-write-mcp-plan.md`, sections 8.1, 8.4, 8.5 and 8.6. `PERF-RUNBOOK.md` lists
the release gates of section 8.9, the fixture that covers each one, the command that runs it, and the measured
status.

## Setup

From `mcp/`:

```sh
npx pnpm install
npx pnpm --filter mcp-loadtest run build
npx pnpm --filter mcp-loadtest run test
```

Run the harness from `mcp/` with the root script:

```sh
npx pnpm loadtest --help
```

## Get tokens

Each agent needs its own MCP token, because the server limits calls per token.

1. Sign in to Penpot as the user that owns the test team.
2. Open Settings, then Integrations, and copy the MCP key.
3. For more than one agent, create one test profile per agent and copy each profile's key. Put the keys in a
   text file, one per line. Lines that start with `#` and blank lines are skipped.

```text
# tokens.txt
<key for agent 0>
<key for agent 1>
```

Keep the tokens file out of git. The harness needs at least as many tokens as agents, or it stops before any call.

## Workflow

1. Create the files and read their ids once per backend:

   ```sh
   npx pnpm loadtest setup --url http://localhost:4401/mcp --tokens tokens.txt --out vars.json
   ```

   The command reads `whoami`, `list_teams` and `list_projects`, creates `mcp-perf-main` and one file per agent
   (`--files`, default 20), and writes the ids to `vars.json`. Use `--team-id` or `--project-id` to pick a team or
   project when the first one is not the right one.

2. Run a scenario:

   ```sh
   npx pnpm loadtest run s1-create-pages --url http://localhost:4401/mcp --tokens tokens.txt --vars vars.json
   ```

3. Build the large reference file once per backend (plan 8.6), then run the large-file scenarios with its vars
   file:

   ```sh
   npx pnpm loadtest generate-large --tokens tokens.txt --vars vars.json --out large-vars.json \
     --pg-stats docker:penpot-penpot-postgres-1:penpot_mcpdev
   npx pnpm loadtest run s5-read-large --tokens tokens.txt --vars large-vars.json
   ```

   See "Large reference file" below.

4. Compare with an earlier run:

   ```sh
   npx pnpm loadtest run s2-reduced-shapes --tokens tokens.txt --vars vars.json --compare results/<older>.json
   npx pnpm loadtest compare results/<older>.json results/<newer>.json
   ```

Each run writes two files to `results/`: `<date>-<commit>-<scenario>.json` and the same name with `.html`. The
HTML page has no external resources. The `results/` folder is git-ignored. Commit a result only after review.

### Command line

| Command | Options |
|---|---|
| `run <scenario>` | `--tokens <file>` (required), `--url <mcp url>` (default `http://localhost:4401/mcp`), `--vars <file>`, `--agents <n>` (default: the scenario's own count), `--iterations <n>` (default: the scenario's own count), `--rate <n>` (calls per second per agent, a cap on every step), `--duration <30m>` (repeat the step list until the time is up; a number without a unit means seconds), `--metrics <url>` (backend Prometheus endpoint), `--pg-stats docker:<container>:<database>[:<user>]` (Postgres counters through `docker exec psql`), `--server-pid <pid>` (MCP server process whose memory to watch), `--sample-interval <5s>`, `--pg-settle <11s>`, `--compare <result.json>`, `--fail-on-regression`, `--results <dir>`, `--machine-note <text>`, `--arrival-rate <n>` (open loop, calls per second per agent), `--warmup <n | 30s>`, `--backend-flags <text>`, `--db-pool-size <n>` |
| `compare <a.json> <b.json>` | `--threshold <0.2>`, `--fail-on-regression` |
| `setup` | `--tokens <file>` (required), `--url`, `--team-id`, `--project-id`, `--files <n>`, `--out <vars.json>` |
| `generate-large` | `--tokens <file>` (required, the first token is used), `--url`, `--vars <file>` or `--project-id <id>`, `--shapes <100000>`, `--pages <40>`, `--batch <300>`, `--components <50>`, `--instances <20>` (copies per page), `--seed <1>`, `--name <file name>`, `--out <large-vars.json>`, `--pg-stats <target>` (to print the stored size), `--without-pointer-map` (prints why the harness cannot build that variant) |

Environment variables can stand in for options: `PENPOT_LOADTEST_URL`, `PENPOT_LOADTEST_TOKENS`,
`PENPOT_LOADTEST_MACHINE_NOTE`, `PENPOT_LOADTEST_PG_STATS`. Each scenario variable can also come from the environment as
`PENPOT_LOADTEST_<NAME>`, for example `PENPOT_LOADTEST_FILE_ID` for `fileId`. A vars file value wins over the
environment.

## Plan scenarios and fixtures

| Plan item | Fixture | What it does |
|---|---|---|
| Setup | `setup` | Finds the team and project, creates the files, reads the page ids |
| Large file | `generate-large` command | Builds the reference large file through the MCP (see below) |
| S1 | `s1-create-pages` | 50 `apply_operations` calls, each creates a page and a board |
| S2 (reduced) | `s2-reduced-shapes` | A fresh page, then 4 `batch_create_shapes` calls, 258 nodes each (about 1,030 in total). Four levels, about 29 % of the non-root nodes in flex layouts |
| S3 | `s3-tokens` | A fresh page, then one `apply_operations` call with 10 sets, 300 tokens and 10 themes (set and theme names carry the run id). Then 500 rectangles and 20 token applications |
| 8.1 bulk write | `bulk-allowsplit` | A fresh page, then 3 `apply_operations` calls of 1,667 rects with `allowSplit: true` (about 5,000 shapes in 18 commits) |
| S4 (no variants) | `s4-components` | A new file per run, 200 components, 1,000 copies, then one call that edits 20 mains and syncs their copies (under 10 s). The MCP has no variant operation, so the 100 components with 3 variants each are not built |
| S5 read | `s5-read-large` | Outline, 20 page trees, 200 `get_shapes` calls and 50 `find_shapes` calls. Run it on the large file, with `--duration 30m` for the full 30 minutes |
| S5 with exports | `s5-read-exports` | The read path, then 10 PNG exports of whole pages (`export_shape`) |
| S6 | `s6-import-archive` | `import_archive` of `${archivePath}` (under 30 s), then checks that the new file holds `${archiveShapeCount}` shapes. The archive must come from you (see `PERF-RUNBOOK.md`) |
| S7 | `s7-execute-code-grid` | One `execute_code` script that builds a 12-column grid of 792 rectangles |
| S8 | `s8-snapshot-cost` | On the large file, per iteration: a rename without and with `snapshot: true`, a rect create, and its delete (which always snapshots). The added cost is step 2 minus step 1, and step 4 minus step 3 |
| S9 | `s9-hostile-code` | Infinite loop, memory bomb, deep recursion, 5001 operations, `require`, `fetch`, `process`, the host handle and `await`, each refused; a plain script between them must still work |
| C1 | `c1-different-files` | N agents, one file each. Each agent makes 50 small writes at 10 per second |
| C2 | `c2-same-file` | N agents, one file, one board each. Each agent makes 100 rectangles and checks that all are present |
| C3 (agent side) | `c3-agent-with-human` | The S2 trees on `${pageId}` with names that carry the run id, while a person edits the same file in a tab. The harness has no browser actor |
| C4 (MCP side) | `c4-same-shape` | Two writers on one fill: the stale write gets a `revn-lag` warning that names the shape, `failOnConflict` is refused, the last writer wins. The human tab half needs a browser |
| C5 | `c5-large-readers` | 20 agents read the large file (outline, 20 page trees, 50 `get_shapes`, 20 `find_shapes` each). Run with `--metrics` for the heap peak |
| Soak | `soak-mixed` | 5 agents, 70 % reads, 25 % small writes, 5 % batch writes of 300 shapes, one export a minute. Run with `--duration 4h` |
| C6 | `c6-linked-library` | Links a new file to the large library (`${libraryId}`), then 100 small writes at 10 per second. Needs `libraryId` in the vars file or `PENPOT_LOADTEST_LIBRARYID`, and `projectId` |
| C7 | `c7-shared-profile` | 10 agents on one profile: put the same token on every line of the tokens file. Needs the `setup` vars file (`agentFileIds`, `agentPageIds`) for 10 agents |

Not covered: the browser actor of C3, C4 and C5 (the human edits, the human save p95 and the human open time),
component variants in S4, the archive of S6, and a large file without pointer-map (see below). C6 and C7 are written but
not yet run against a live stack.

C6 and C7 need these inputs. C6 links the run file to an existing library, so it needs the large file id as
`libraryId`, and a `projectId`; it creates its own file. C7 reuses the setup files, so run `setup` with at least as
many `--files` as agents. Its tokens file repeats one token on each line, so the agents share one profile and
one set of per-profile limits.

## Human tab (browser half of C3 and C5)

`scripts/human-tab/` holds a headless browser that logs in as the test profile and edits one board every 3 s while
the agents work on the same stack. It records the save round trip (`update-file`) and checks that the last edit
survived. Set `PENPOT_HUMAN_PASSWORD` first (the password is not in the repo). Details: `scripts/human-tab/README.md`.

- `node scripts/human-tab/human-tab.mjs --tokens <file> --vars <vars.json> --minutes 3` runs the tab alone.
- `node scripts/human-tab/run-c3.mjs --tokens <file> --vars <vars.json> --agents 5` runs `c2-same-file` 30 s into
  the tab's edits and prints the C3 verdict. The gate: the save p95 rises by less than 500 ms, and no edit is lost.
- For C5, run the tab with `--vars <large-vars.json>` while `c5-large-readers --agents 16` runs in another terminal.
  Results go to `results/human-tab-*.json` and `results/c3-human-tab-*.json`.

## Large reference file

`generate-large` builds the reference file of plan 8.6 through the MCP itself, with the first token of the tokens
file. The plan asks for a generator that writes the `.penpot` archive directly with the `common` builders; this one
uses the system under test instead, as the plan's own S1-S4 seeding does. It is seeded (`--seed`), so the same
settings give the same names, texts, colours and layout choices.

- It creates the file in `projectId` from `--vars` (or `--project-id`), a `Library` page with `--components`
  components (a board, a rect and a text each), and `--pages` content pages. The library page ends up last.
- Each content page gets `--instances` component copies in one `apply_operations` call (`allowSplit: true`), then
  sections through `batch_create_shapes`, one tree of at most `--batch` nodes per call: a root board, a title text
  and up to three rows of cards (a board with a rect, an ellipse and a text with real words). Every third section
  gets flex layouts on its rows, and every fifth section a grid layout on its root, in one more call per page.
- Every write sends `snapshot: false`, so the generator never takes a file snapshot.
- It prints one progress line per page, then the shape count, the pointer-map flag, the call count, the time, and
  the stored file size when `--pg-stats` is set (`file_data` rows plus `file.data`, from Postgres; the MCP tools
  do not report a size).
- It writes `fileId`, `projectId`, `pageId` (the first content page), `pageIds` (the content pages),
  `libraryPageId`, `componentIds`, `largeShapeCount` and a `generator` block (seed, settings, time, calls,
  `fileDataBytes`) to `--out`. It writes the file also when a call fails, and then exits with 1.

Without pointer-map: the backend decides pointer-map for a new file from its feature flag
(`enable-feature-fdata-pointer-map`) and from the team's features, not per call. The harness cannot build that
variant. Restart the backend without the flag and use a team that does not have the feature, then run
`generate-large` again. `--without-pointer-map` prints this note and exits with 2.

## Backend figures

With `--metrics`, `--pg-stats` or `--server-pid`, the runner samples before the run, every `--sample-interval`
(heap and memory peaks) and after the run, and prints and stores:

- From the backend metrics (`/metrics` on the backend HTTP port; `http://localhost:6061/metrics` on this stack):
  JVM heap start, peak and end (`jvm_memory_bytes_used{area="heap"}`) and its max, GC count and seconds
  (`jvm_gc_collection_seconds_*`), backend CPU seconds and average cores (`process_cpu_seconds_total`), RPC
  requests (`penpot_rpc_main_timing_count`), MCP commands (`penpot_mcp_tool_duration_seconds_count`), pool
  checkouts (`hikaricp_connection_usage_millis_count`), and the change of every `penpot_*` counter.
- The backend has no SQL statement counter. With `--pg-stats`, the runner reads `pg_stat_statements` when Postgres
  loads it (exact statements), and always `pg_stat_database` and `pg_stat_user_tables`: transactions, rows read
  and written, table scans (one per table that a statement reads, so joins count more than once and inserts count
  none), and the `file_change` sequential and index scans. It prints each per call. The final Postgres sample waits
  `--pg-settle` (11 s), because Postgres flushes the stats of an idle connection within 10 s. Other work on the
  same database in that window counts too, so run on a quiet stack.
- With `--server-pid`, the resident memory of the MCP server process (`tasklist` on Windows, `/proc` on Linux,
  `ps` elsewhere).

A source that fails adds a warning and leaves its figures out; the run goes on.

## Scenario format

A scenario is a JSON file:

```json
{
  "name": "example",
  "description": "What the scenario checks.",
  "agents": 5,
  "iterations": 1,
  "steps": [
    {
      "name": "create the board",
      "tool": "apply_operations",
      "rateLimitPerSecond": 10,
      "args": {
        "fileId": "${fileId}",
        "operations": [
          { "op": "create_board", "id": "$tmp:board", "pageId": "${pageId}", "name": "Agent ${agent}", "x": 0, "y": 0, "width": 100, "height": 100 }
        ]
      },
      "capture": { "boardId": "$.result.createdIds[\"$tmp:board\"]" }
    }
  ]
}
```

- `agents` and `iterations` are defaults. `--agents` and `--iterations` override them, and `--duration` replaces
  the iteration count.
- `repeat` (optional, default 1) runs a step several times per agent. It can also be a placeholder such as
  `"${fileCount}"`. Inside the arguments, `${index}` is the copy number, counted from 0.
- `rateLimitPerSecond` (optional) caps the calls of one step for each agent. The lower of this and `--rate` wins.
- `${name}` takes the value from, in order: a loop variable or built-in (`agent`, `index`, `iteration`, `runId`),
  values captured by earlier steps (setup steps included), the vars file, then the `PENPOT_LOADTEST_*` environment. A
  placeholder that is the whole string keeps its type. `${list[index]}` and `${list[agent]}` pick one element of
  an array. An index past the end is an error; indexes do not wrap.
- `{ "$repeat": 300, "as": "k", "value": { ... } }` expands to 300 copies inside a list or an object, with `${k}`
  set to the copy number. An array value splices several items into the list for each copy. Repeats nest.
- `capture` maps a variable name to a JSONPath over the parsed tool result. The path root is `$.result`. Supported
  syntax: `.key`, `["key"]`, `[n]` and `[*]`. A step that repeats collects the captures into an array.
- `expect` (optional) checks the result: one object or a list of objects, each with a `path` and any of `equals`
  (a value), `length` and `maxLength` (of an array or string), `sum` (of an array of numbers) and `contains` (an
  element of an array, compared as JSON). Placeholders in it are resolved like the arguments. A failed check counts
  as an error. The C2 fixture uses it to check that no write was lost.
- `expectError` (optional) is a regular expression, matched without regard to case. The call must fail with a
  message that matches; then it counts as a success. A step with `expectError` has no `capture` or `expect`. S9
  uses it.
- `maxDurationMs` (optional): a call slower than this counts as an error. S4, S6 and S9 use it for their time
  limits.
- `everyMs` (optional): an agent skips the step when it ran it less than this many milliseconds ago. The soak uses
  it for one export every five minutes.

Scenario-level options:

- `setup` (optional) is a list of steps in the same format, run before each iteration, or only before the first
  iteration of each agent when `setupPer` is `"agent"`. Their calls are left out of the latency figures and listed
  apart as `setupSteps` in the result; their failures count as errors (with the prefix `setup: `) and stop the
  iteration. S4 creates its own file there, and S8 finds its target shape.
- `freshPage: true` (or `{ "fileId": "...", "name": "..." }`) puts a setup step first that creates a new page in
  `${fileId}` and binds `${pageId}` to it, so a scenario that counts shapes passes on every run. S2, S3, C4 and
  `bulk-allowsplit` use it. The scenario name stays the same, so results stay comparable.

A step that fails, or a capture that finds nothing, counts as an error. A failed capture stops the rest of that
iteration for that agent, because the later steps need the value.

## Results

Each result file follows the schema in `src/ResultFile.ts` (`schemaVersion` 1):

- `scenario`, `description`, `commit` (git HEAD of this checkout, or `unknown`), `startedAt`, `finishedAt`,
  `durationMs`, `agents`, `iterations`, `rateLimitPerSecond`.
- `machineSpec`: platform, architecture, CPU model and core count, memory, Node.js version and an optional note.
  Compare results only when their machine specs match. Record Docker limits and backend settings in
  `--machine-note`.
- `calls`, `errors`, `bytes`, and `p50`, `p95`, `p99`, `max` over all calls, in milliseconds.
- `heap` and `rss`: each has `startBytes`, `endBytes` and `peakBytes` for the load driver process.
- `metricsDelta`, `backendHeap`, `gc`, `backendCpuSeconds`, `backendRequests`, `mcpCommands`,
  `connectionCheckouts` when `--metrics` is set; `pg` with `--pg-stats`; `serverRss` with `--server-pid` (see
  "Backend figures"). `dbStatements` is the change of a metric whose name ends in `statement_total` or
  `statements_total` (the backend has none today), else the `pg_stat_statements` count; `dbStatementsSource` says
  which.
- `setupSteps`: per setup step, the same figures as `steps`.
- `steps`: per step, the name, tool, calls, errors, payload bytes and the four latency figures.
- `errorSamples` (up to 50 distinct failure messages) and `warnings`.

Percentiles use the nearest rank over all samples. `--compare` flags a latency figure that rises by more than 20 %,
and any rise in the error count.

### Sample rule and warm-up

A percentile needs enough samples to mean something: p50 needs 20 and p95 and p99 need 200. With fewer, the summary and
the step table print the value with `(unreliable: n samples, needs m)`. A comparison does not pass or fail such a figure:
it is marked `NOT MEASURED`, and `--fail-on-regression` exits 1 for it.

`--warmup <n | 30s>` leaves out the first calls of the run: a whole number counts calls over all agents, and a time with a
unit (`s`, `m`, `h`) counts the calls that finish before it ends. The warm-up calls still run and their captures still
count. The result records the setting and how many calls it excluded.

### Open loop

By default each agent waits for its last call before it sends the next one (closed loop). `--arrival-rate <n>` sets
a fixed schedule of n calls per second for each agent: call k is due at start + k / n, and its latency counts from the
due time, so a call that starts late shows the wait it had. `--rate` still caps the calls.

### Provenance

Every result records the commit, whether the git tree was dirty (`treeDirty`; a warning is printed), `backendFlags`
(from `--backend-flags` or `PENPOT_LOADTEST_BACKEND_FLAGS`, else `unknown`), and `dbPoolSize` when `--db-pool-size` is given.
Figures from an uncommitted tree are not reproducible from the commit alone.

## Assumptions about tool results

The fixtures were written from the contract (`mcp/docs/backend-mode-contract.md`) and the tool sources. Some result
shapes were not checked against a live server. Check them on the first run and fix the fixture if needed:

- `list_teams` returns an array of teams with `id`. The setup takes the first team.
- `list_projects` returns an array of projects with `id`. The setup takes the first project.
- `manage_files` with `create_file` returns the file with `id`.
- `get_file_outline` returns `pages`, each with `id`.
- `apply_operations` returns `createdIds`, which maps each `$tmp:` handle to a UUID.
- `find_shapes` returns `matches`, each with `id`. The C2 check assumes `withinId` returns the nested shapes only.
- `batch_create_shapes` accepts `props` such as `layout: "flex"`, `layoutFlexDir`, `layoutGap` and `layoutPadding`
  for the flex containers in S2. If the backend ignores them, the flex share of S2 is zero.
- `apply_token` accepts the attribute `fill-color` in S3.
- `execute_code` uses the facade methods `createBoard`, `createRectangle`, `resize`, `appendChild` and the
  properties `name`, `x` and `y`, as in the server's sandbox tests.

## Failure injection and upgrade checks (T4, T5)

Two folders hold the scripts for the production readiness tracks T4 (failure injection) and T5 (upgrade and rollback).
The stack owner runs them against the live stack when it is free. Every script has `--dry-run`, which prints the steps
and runs nothing. A run that changes anything needs `--yes`, and each wait has a timeout.

Common setup: `PENPOT_LOADTEST_TOKEN_FILE` (the MCP token, first line), `PENPOT_LOADTEST_VARS_FILE` (the vars file of
`setup`, for `fileId`), `PENPOT_LOADTEST_URL` (default `http://127.0.0.1:4405/mcp`) and optionally
`PENPOT_LOADTEST_ADAPTER_LOG` (the adapter log, so the Redis case can copy the lines it wrote). The chaos results are JSON
files in `results/`, or in `--results-dir`. Each file has `case`, `steps`, `observed`, `expected`, `checks`, `commit` and `pass`.

### scripts/chaos (T4)

| Script | What it stops or does | Expected |
|---|---|---|
| `backend-stopped-during-write.mjs` | kills the dev backend JVM during a 300-rectangle write, restarts it with `restart-backend-dev`, retries with the same `requestId` | the file holds the whole write or none; the retry applies once or answers `alreadyApplied`; never two copies |
| `adapter-killed-during-flush.mjs` | a manual kill of the adapter during a 4,000-operation `execute_code` (the operator does it; the case prints the step and waits for the adapter) | the shape count is 0, 1,500, 3,000 or 4,000; no change 15 s later; the next call agrees |
| `backend-valkey-stopped.mjs` | stops `penpot-penpot-valkey-1` (the backend's valkey) while the adapter has no Redis | the write commits; the backend log names the dropped notifications; reads work; a write after the restart commits |
| `adapter-redis-stopped.mjs` | stops the stack's Redis (`--redis`, default `deploy-redis-1`) behind the balancer | both adapters' fallback counters rise and the burst answers without 5xx; storage does not return the old value; the outage is logged; after the restart storage works and no counter rises |
| `adapter-down-behind-nginx.mjs` | stops one adapter container (`--adapter`, default `deploy-penpot-mcp-a-1`) behind nginx | at most one of 40 calls fails; the other adapter serves them; storage survives (Redis); the restarted adapter takes calls again |
| `nginx-reload.mjs` | `nginx -s reload` (`--nginx`, default `deploy-nginx-1`) while four callers run | at most one call fails across the run |
| `exporter-stopped.mjs` | stops `penpot-mcp-exporter`, then `export_shape` and `get_file_outline` | the export fails within 120 s with a clear error; the outline works; an export works after the restart |
| `postgres-restarted.mjs` | `docker restart` of `penpot-penpot-postgres-1` under a read probe | errors during the restart carry text; recovery within 60 s; no session idle in a transaction for over 60 s |
| `slow-backend.mjs` | holds the file row lock (`SELECT ... FOR UPDATE`) in psql for 20 s while an agent writes | `mcp-file-busy` after about 15 s, not a 500; nothing applied; the next write works |
| `run-all.mjs` | runs the cases above in that order | `--include-manual` adds the adapter case |

Order for the stack owner: `run-all.mjs --dry-run --include-manual --include-two-adapter` first, then the cases one by one
with `--yes`, the adapter kill last (it needs an operator at the adapter). The two-adapter cases need the stack of
`mcp/deploy` up; pass `--url` for the balancer (default `http://127.0.0.1:4415/mcp`) and the container names when the stack
was started with another compose project name (the defaults assume the project name `deploy`). Each case undoes what it
stopped when it fails (`--no-cleanup` keeps the stop, for debugging, and prints what to restore by hand). Run them when no other run writes to the test file. `backend-stopped-during-write`
and `postgres-restarted` restart the backend or Postgres: check `/readyz` first.

### scripts/upgrade (T5)

Run in this order. Each script names the database it changes; none writes to `penpot_mcpdev`.

1. `dump-and-copy-db.sh --yes`: dumps `penpot_mcpdev` inside the Postgres container, restores it into
   `penpot_upgrade_test`, and rolls migrations 0158 and 0159 back in the copy (`to-pre-upgrade.sql`), because the dev
   database already has them. `--keep-new-migrations` skips the roll-back.
2. `seed.sh --yes --vars <vars.json>`: inserts 100,000 synthetic `file_change` rows for the file (optional, but it
   gives the index builds a table of realistic size).
3. `run-new-migrations.sh --yes`: starts this checkout's backend on port 6070 against the copy, waits for `/readyz`
   (the migrations run first), stops it. It refuses to run when 0158 or 0159 is already applied. It writes
   `timing.txt` (seconds to ready, and the time of each migration row), `locks.log` (a write probe on `file_change`
   about once a second; `write-blocked` lines show writes that waited for the index build) and `indexes.txt`.
4. `run-old-backend-tests.sh --yes`: creates the worktree `/tmp/old` at `541f965bf1` in `penpot-tc` if missing, copies
   the migrated copy to `penpot_upgrade_old_tests` (the suite resets the rows of the database it gets), and runs
   `clojure -M:dev:test` there. Takes hours. The summary goes to `old-backend-summary.txt`.
5. `run-old-backend-tests.sh --yes --serve-old`: starts the previous backend on port 6071 against the migrated copy and
   prints the manual token call checklist (profile and file calls, expected statuses). `--stop-old` stops it. Both
   backends of this step read the dev stack's `PENPOT_SECRET_KEY` inside `penpot-tc`, so the dev tokens validate.
6. `backup-restore.sh --yes --token-file <file> --vars <vars.json>`: takes a dump of `penpot_mcpdev` at any time (the soak
   is fine), restores it into `penpot_backup_restore`, starts a backend on port 6072 against it, and makes one token read
   (`mcp-whoami`) and one write (`mcp-apply-operations`, a new page). It checks that each table's count in the copy lies
   between the counts before and after the dump. Results: `backup-restore.txt`.

### Pre-deploy index step (installations with a large file_change table)

Migration 0159 builds two indexes with a plain `CREATE INDEX IF NOT EXISTS`, inside the migration transaction. A plain
build takes a lock that blocks every file save for its whole length (`run-old-backend-tests.sh` and `run-new-migrations.sh`
measure it on the synthetic table; `locks.log` shows the blocked writes). On a large installation, build both indexes
first, with `CONCURRENTLY`, before the new backend starts. The migration then finds them and skips them.

Run with psql in autocommit mode, one statement at a time (CONCURRENTLY cannot run inside a transaction), before the new
backend starts:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS file_change__file_id__session_id__idx
    ON file_change (file_id, session_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS file_change__file_id__created_at__labelled__idx
    ON file_change (file_id, created_at)
 WHERE label IS NOT NULL;
```

Then check that both are valid. `IF NOT EXISTS` skips an index that has the same name even when a failed build left it
INVALID, so the migration would not repair it:

```sql
SELECT indexrelid::regclass AS index_name, indisvalid
  FROM pg_index
 WHERE indexrelid IN ('file_change__file_id__session_id__idx'::regclass,
                      'file_change__file_id__created_at__labelled__idx'::regclass);
```

Both rows must show `indisvalid = t`. For a row that shows `f`, run `DROP INDEX CONCURRENTLY IF EXISTS <index_name>;` and
then the matching `CREATE INDEX CONCURRENTLY` again. Do not start the backend until both are valid.

Expected outcomes: the migrations finish with 0158 and 0159 applied; `locks.log` shows `write-blocked` only during the
index build (CREATE INDEX blocks writes; say so in the readiness report if it does); the previous backend's suite and the
token call pass. A failure at step 4 or 5 is a finding about the migrations, not about the scripts; keep the logs.

## Tests

```sh
npx pnpm --filter mcp-loadtest run test
```

The unit tests cover the variable substitution and `$repeat` expansion, JSONPath, the percentile math, the result
schema, the comparison and regression rule, the fixtures, the setup and check options, the metrics parser, the
Postgres and process samplers (with fake commands), the backend watch, the large-file generator (with a fake
server) and the HTML report. The integration
test starts a stub MCP server (`src/testing/StubMcpServer.ts`) with fake `whoami` and `apply_operations` tools. It
runs a two-step scenario with three agents, checks that each agent sent its own token, and checks the result file.

## Metrics, request ids and monitoring

Three tools check and watch the metrics of a deployment. None of them changes data.

`scripts/check-metrics.mjs` reads one `/metrics` endpoint and checks the text format: one `# TYPE` per family, samples
under a declared family, no duplicate samples, the same label names in every sample of a family, finite values, and
cumulative histogram buckets whose `+Inf` bucket equals `_count`. It lists the families and exits 1 on a defect. It also
runs `promtool check metrics` in the `prom/prometheus` image through docker, unless `--no-promtool` is given; without
docker that step is reported as skipped.

```sh
node scripts/check-metrics.mjs http://127.0.0.1:4405/metrics
node scripts/check-metrics.mjs http://localhost:6061/metrics --no-promtool
```

The adapter serves `/metrics` without a token only to a client on its own machine. From another host, Prometheus
(see below) presents a token; the script itself sends none.

`scripts/correlate-request-id.mjs` follows one tool call by its request id. The adapter makes the id for each call and
sends it to the backend as `X-Request-Id`. The script finds the id on the adapter's `Tool execution ... request=` lines,
on the backend's `mcp-tool` line and, when `PENPOT_CORRELATE_DATABASE_URL` or `PENPOT_CORRELATE_PSQL_CONTAINER` is set,
in the `props` of the `audit_log` row. It prints the matches and exits 1 when a source is missing. By default it follows
the newest `get_file_outline` call in `mcp-backend-mode.log` and reads the dev backend log from
`penpot-tc:/tmp/backend-dev.log`. Options: `--request-id`, `--tool`, `--backend-docker <container>`, `--backend-log <file>`.
With `--call`, it first makes one `get_file_outline` call; set `PENPOT_MCP_TOKEN_FILE` (a file with one MCP key) and
`PENPOT_MCP_FILE_ID`. The audit database defaults to `penpot_mcpdev` (the dev stack); set `PENPOT_CORRELATE_PSQL_DB`
to change it. Audit rows exist only for writes and only when the `audit-log` flag is on, so a read reports
`audit: missing`. Writes are not yet traceable end to end, because some backend `mcp-tool` lines log `request-id=nil`.

```sh
node scripts/correlate-request-id.mjs
PENPOT_CORRELATE_PSQL_CONTAINER=penpot-penpot-postgres-1 node scripts/correlate-request-id.mjs --request-id <uuid>
```

`mcp/deploy/compose.monitoring.yaml` starts Prometheus (127.0.0.1:9090), Grafana (127.0.0.1:3000) and a blackbox
exporter on the penpot network. Prometheus scrapes `penpot-mcp-1` and `penpot-mcp-2` on port 4401 and `penpot-backend`
on port 6060 every 15 seconds. The blackbox exporter probes `/readyz` of both adapters and of the backend, which gives
`probe_success`. `mcp/deploy/alerts.yml` holds the rules, each with a runbook annotation:

- `PenpotMcpAdapterDown`, `PenpotMcpBackendDown`: scrape `up` is 0 for 2 minutes.
- `PenpotMcpAdapterNotReady`, `PenpotMcpBackendNotReady`: `probe_success` is 0 for 2 minutes.
- `PenpotMcpRedisDown`: `penpot_mcp_redis_up` is 0 for 2 minutes.
- `PenpotMcpRateLimitFallback`: the in-process limiter served calls for 5 minutes.
- `PenpotMcpSandboxTerminationsHigh`: sandbox runtimes disposed above 5 per minute.
- `PenpotMcpRefusalsHigh`: backend refusals above 0.5 per second.
- `PenpotMcpLockTimeouts`: `mcp-file-busy` or `mcp-lock-timeout` above 1 per minute.
- `PenpotMcpWriteLatencyP95High`: write tools with p95 above 3 s for 10 minutes.
- `PenpotMcpBackendPoolSaturated`: calls waiting for a Postgres connection for 5 minutes.
- `PenpotMcpClimitRejected`: the backend's concurrency limiter rejects MCP commands.
- `PenpotMcpAdapterMemoryHigh`: adapter resident memory above 1.5 GB for 10 minutes.
- `PenpotMcpAdapterEventLoopLag`: event loop lag p95 above 200 ms for 5 minutes.

`mcp/deploy/grafana-mcp-dashboard.json` is the dashboard; Grafana provisions it.

Before the first start:

1. Put an MCP key of an operator profile in `mcp/deploy/secrets/mcp-metrics-token`, one line. Do not commit it.
2. Set `GRAFANA_ADMIN_PASSWORD`. There is no default.
3. Set `PENPOT_NETWORK` to the penpot network name (`docker network ls`; the stack from this checkout is `penpot_penpot`).

```sh
docker compose -f mcp/deploy/compose.monitoring.yaml up -d
docker run --rm -v "$PWD/mcp/deploy:/cfg:ro" --entrypoint promtool prom/prometheus:v3.5.0 check rules /cfg/alerts.yml
```

`promtool check config` needs the token file in place too, because Prometheus reads it at config check time.

The adapter's own process series (`process_resident_memory_bytes`, `nodejs_heap_used_bytes`,
`nodejs_eventloop_lag_seconds`, `penpot_mcp_sandbox_workers`) are exported by the adapter once the shared-state work
lands; until then the adapter process panels are empty. The adapter counts the calls that used the in-process limiter
(`penpot_mcp_rate_limit_fallback_total`); the rate-limit refusals themselves are not exported.

### Pool saturation in capacity runs

The capacity report (C1 at 20, 50 and 100 agents, C2 at 5 and 10) records these series for each backend, over the run
window. Scrape `penpot-backend` every 15 seconds, or read them from the backend's `/metrics`:

| Series | What the report keeps |
|---|---|
| `hikaricp_max_connections{pool="main"}` | the pool size, once per run |
| `hikaricp_active_connections{pool="main"}` | the maximum, and the share of the window at the maximum |
| `hikaricp_connections{pool="main"}` | the maximum (open connections) |
| `hikaricp_pending_threads{pool="main"}` | the maximum, and the share of the window above 0 |
| `rate(hikaricp_connection_timeout_total[window])` | the total timeouts |
| `hikaricp_connection_acquired_nanos` | the acquire time at the 95th percentile |
| `penpot_rpc_climit_waiting` | the maximum |
| `rate(penpot_rpc_climit_rejected_total{name=~".*mcp.*"}[window])` | the total rejections, by name and reason |
| `penpot_mcp_tool_duration_seconds` (write tools) | the p95 per tool |

Reading the pool:

- The pool is the limit when active stays at the maximum and pending is above 0 for most of the window, while the
  backend and Postgres CPU are below half. Pending rising with the agent count is the signature.
- The pool is not the limit when pending stays at 0, even if active is high. Then look at the write latency and at
  Postgres.
- A timeout is a failure, not a slow call. Any timeout in a run is a finding for the report, whatever the latency.
- Concurrency-limit rejections (`penpot_rpc_climit_rejected_total`) come before the pool fills in a healthy run: the
  limiter refuses calls that would wait. Rejections with a flat pool mean the limiter is too tight for the agent count.

Write the pool size and the expected agents per backend into the operator's guide. A run at 100 agents against one
backend with a pool of 10 cannot pass unless the pending series stays at 0, which the report must show, not assume.

## Round 2 measurements

Round 2 measures four things: exporter load with exports and reads at the same time, storage growth per 1,000 operations, whether an old and a new adapter work on one backend, and whether two adapters can write to one file without a shared queue. The stack owner runs these scripts against a live stack. Nothing in this section was run against a live stack.

The scripts live in `scripts/round2/`. Run them from the package root. Each one has `--help`, and most have `--dry-run`.

| Script | Measures | Command | Expected result |
|---|---|---|---|
| `export-capacity.mjs` | Export latency, render timeouts and read latency with 10 exporting agents and 3 reading agents at once | `node scripts/round2/export-capacity.mjs --tokens <file> --vars <file> --duration 3m` | A summary per run. Any render timeout is recorded as a finding. |
| `file-change-growth.mjs` | Rows and bytes added to `file_change`, `file_data` and snapshots, per 1,000 operations | `node scripts/round2/file-change-growth.mjs --file-id <uuid> --vars <file> --tokens <file>` | Growth per 1,000 operations, used to budget storage. |
| `mixed-version-smoke.mjs` | Four basic calls against an old and a new adapter on one backend | `node scripts/round2/mixed-version-smoke.mjs --old-url <url> --new-url <url> --token-file <file> --vars <file>` | Exit 0 on both adapters. A new adapter on an old backend fails as a contract mismatch. |
| `cross-adapter-writes.mjs` | Whether 200 interleaved writes from two adapters all land, with a rising `revn` | `node scripts/round2/cross-adapter-writes.mjs --url-a <url> --url-b <url> --token-file <file> --vars <file>` | 200 present, `revn` strictly increasing, zero `mcp-file-busy` at the default rate. Any busy error is recorded. |

### export-capacity.mjs

Runs scenario C8. The exporting agents run `c8-export-heavy.json` and the reading agents run `c8-export-heavy-reads.json`, both at the same time, for the length set by `--duration`.

```
node scripts/round2/export-capacity.mjs --tokens <file> --vars <file> [--url <mcp url>] [--duration 3m] [--export-agents 10] [--read-agents 3] [--results <dir>]
node scripts/round2/export-capacity.mjs --dry-run --tokens <file> --vars <file>
node scripts/round2/export-capacity.mjs --summarize <dir>
```

- `--url` defaults to `http://localhost:4401/mcp`. `--duration` defaults to `3m`. A number without a unit means seconds.
- Agent i uses token i. The exporting agents take the first tokens and the reading agents take the tokens after them, so no token is shared. The tokens file needs at least `--export-agents` plus `--read-agents` lines.
- Token values are never printed.

What the backend does:

- Each token allows one render at a time (`ExportConcurrency.RENDERS_PER_TOKEN` is 1).
- The whole process runs 4 backend exports at once by default. `PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS` changes that number.
- A call that waits for a render slot has no timeout. Queueing shows as latency, not as an error.
- A render that runs past 60 seconds fails with "The export did not finish within 60 seconds." The summary counts that as a render timeout.

### file-change-growth.mjs

Measures how much storage one file uses, runs a scenario, measures again, and prints the growth per 1,000 operations.

```
node scripts/round2/file-change-growth.mjs --file-id <uuid> [--vars <file>] [--tokens <file>] [--url <mcp url>]
node scripts/round2/file-change-growth.mjs --file-id <uuid> --measure-only --operations <n>
node scripts/round2/file-change-growth.mjs --file-id <uuid> --dry-run
node scripts/round2/file-change-growth.mjs --file-id <uuid> --run bulk-allowsplit --out <json file>
node scripts/round2/file-change-growth.mjs --file-id <uuid> --run-command "<shell command>" --operations <n>
```

- `--file-id` can come from `--vars` instead.
- The default scenario is `bulk-allowsplit`, which writes 5,001 operations. Pass `--operations` with `--run-command` and with `--measure-only`. The 5,001 default applies only to `bulk-allowsplit`.
- `--container` defaults to `penpot-penpot-postgres-1`, `--database` to `penpot_mcpdev` and `--user` to `penpot`.
- Each query runs through `docker exec <container> psql`.

It counts these rows and bytes for one file:

- `file_change` rows and bytes.
- `file_data` rows and bytes. Fragments have type `fragment`.
- Snapshot rows: `file_change` rows with a `label`.

Retention decides what a measurement shows:

- The objects GC runs daily at 00:00. It hard-deletes rows whose `deleted_at` is now or earlier. This covers `file_change`, `file_data` and other tables.
- An MCP write revision gets `deleted_at` one hour after the write.
- A snapshot gets `deleted_at` seven days after the write (the deletion delay).
- `file_gc` runs daily at 02:00. It does not delete `file_change`, snapshot or `file_data` rows. It only marks unused media, thumbnails and fragments.
- The replay check reads `file_change` rows by session id. A replay works for at least one hour after the write, and until the objects GC removes the row. That can take up to about a day.

So a run's rows stay until the next daily GC after their one-hour mark. A measurement taken right after a run shows the full growth. Use growth per 1,000 operations as the number to budget storage with.

### mixed-version-smoke.mjs

Runs `whoami`, `get_file_outline`, one `apply_operations` call that adds a rectangle, and `find_shapes`, against each URL. It starts nothing. It calls only the two endpoints it is given.

```
node scripts/round2/mixed-version-smoke.mjs --old-url http://localhost:4401/mcp --new-url http://localhost:4402/mcp --token-file <file> --vars <file>
node scripts/round2/mixed-version-smoke.mjs --dry-run --old-url <url> --new-url <url> --token-file <file> --vars <file>
```

- Exit code 1 when any step fails on either adapter. Otherwise it exits 0.
- A failure whose text contains "backend too old for backend mode" is labelled "contract mismatch".

### cross-adapter-writes.mjs

Sends 200 writes. Even writes go to adapter A and odd writes go to adapter B. Each write creates one rectangle named `xa-seq-` plus a four-digit sequence number. Then it reads the page back.

```
node scripts/round2/cross-adapter-writes.mjs --url-a <url> --url-b <url> --token-file <file> --vars <file> [--writes 200] [--per-second 10] [--lanes 2] [--out <json file>]
node scripts/round2/cross-adapter-writes.mjs --dry-run --url-a <url> --url-b <url> --token-file <file> --vars <file>
```

- `--writes` takes 1 to 9999. `--per-second` caps the send rate across both lanes. `--lanes 1` uses adapter A only.
- Use a page with no `xa-seq-` shapes. Otherwise the presence check counts the old shapes too.
- The report gives the present count, whether `revn` rises strictly (from the top-level `revn` of `apply_operations`), the `mcp-file-busy` count, other errors, and p50 and p95 per adapter.
- Exit code 1 on a write error other than busy, a missing row, or a `revn` that does not rise.

The check tests two protections together. Each adapter process has its own write queue. The backend has a file lock, and a write that waits about 15 seconds for that lock fails with `mcp-file-busy`. The check shows whether those two are enough without a shared queue.

### Deploy order

Deploy the backend first, then the adapters. Roll back in the reverse order: adapters first, then the backend.

Two cases matter:

1. **Old adapter, new backend.** The contract allows additions. The old adapter runs and ignores the new fields. The smoke test should pass on the old adapter.
2. **New adapter, old backend.** The old backend's `whoami` does not report `contractVersion`. The new adapter throws "backend too old for backend mode: it reports contract version none, this adapter needs <N> or later. Upgrade the Penpot backend." on every backend call. It logs that once, and every call then fails with that one error. The smoke test reports it as a contract mismatch. Deploy the backend first to avoid this.

### Not measured here

No round 2 script was run against a live stack for this section. The numbers come from the stack owner's runs. Do not quote figures from this README as measured results.
