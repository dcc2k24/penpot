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
