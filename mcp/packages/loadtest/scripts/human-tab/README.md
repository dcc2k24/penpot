# Human tab

A headless browser that acts as a person. It logs in to the dev frontend as the test profile, opens one file, and
edits one board every 3 s while the agents write to the same stack. It measures how long each save takes and whether
the last edit survived. It covers the human half of the C3 and C5 gates in `PERF-RUNBOOK.md`.

## Before you run it

- Dev backend answers `http://localhost:6061/readyz`, and the MCP adapter answers `http://127.0.0.1:4405/readyz`.
  Both scripts wait up to 10 minutes for them.
- Set the test profile's password in the environment. It is not in the repo or the vars file:

  ```text
  PENPOT_HUMAN_PASSWORD=...
  ```

  Optional: `PENPOT_HUMAN_EMAIL` (default `mcpdev@example.com`).
- `npx playwright install chromium` must have run for the Playwright version in `package.json` (1.62.1).
- Vars file: the `setup` output (`fileId`, `pageId`, `teamId`, `projectId`). For C5, the `generate-large` output.
- The harness works with both routers of the dev frontend. It accepts the hash router (`#/dashboard/...`) and the query-string router (`?screen=...`).

## Human tab alone

From `C:\dev\penpot\mcp\packages\loadtest`:

```text
node scripts/human-tab/human-tab.mjs --tokens <tokens.txt> --vars <vars.json> --minutes 3
```

The run creates one board named `human-<run id>` through the MCP, selects it in the layers panel, and presses
ArrowRight or ArrowDown once every 3 s. Each press is one change, and Penpot saves each one through the
`update-file` RPC. At the end the script reads the board back through the MCP and compares its position with the
start position plus the presses.

Other options: `--interval-ms`, `--frontend`, `--backend`, `--mcp`, `--results`, `--headed` (show the browser),
`--login-only` (log in, open the workspace, stop: a check that needs no MCP token), `--save-delay-ms` (holds each
save response for that many milliseconds, so the tab sees slow saves while the server commits at once).

Output: `results/human-tab-<timestamp>.json` with `saves` (count, errors, p50, p95, max), `notifications` (websocket
frames, and those whose text contains `file-change`), `lostEdits` (expected and actual position, `count` of
mismatched axes) and `errors`. Exit code 1 when any error or lost edit is recorded.

## C3: the human tab with agents on the same file

```text
node scripts/human-tab/run-c3.mjs --tokens <tokens.txt> --vars <vars.json> --agents 5 --minutes 3
```

The orchestrator starts the human tab, waits 30 s after editing starts (`--baseline-s`), then runs `c2-same-file`
with the given number of agents (`--scenario` picks another). It compares the save p95 before and during the agent
run.

Gate: the save p95 during the agent run is less than 500 ms above the baseline, no edit is lost, and no save fails.
The verdict is `PASS`, `FAIL`, or `INCONCLUSIVE` (fewer than 5 saves in either window). The summary goes to
`results/c3-human-tab-<timestamp>.json`.

The baseline is the 30 s before the agents start, in the same run. For a stricter check, run the tab alone first
and compare its p95 with the C3 run.

## C5: the tab stays usable while 16 agents read

Start the tab in one terminal, and the readers in another, on the same large file:

```text
node scripts/human-tab/human-tab.mjs --tokens <tokens.txt> --vars <large-vars.json> --minutes 5
npx pnpm loadtest run c5-large-readers --agents 16 --tokens <tokens.txt> --vars <large-vars.json> --metrics http://localhost:6061/metrics
```

The tab's result holds `login.ms` and `open.ms` (from the first request to the canvas), and its save p95. Usable
means the open time and the save p95 stay in line with the tab run alone. The readers' heap and GC figures come
from the `c5-large-readers` run as usual.

## What the tab does not cover

- It edits by keyboard, not by mouse drag. A nudge is one exact change, so the lost-edit check can compare
  positions to the pixel.
- Websocket delivery of agent changes: the tab counts frames that mention `file-change`. It does not time them
  against the agents' writes.
- Open time is the time from `goto` to the canvas, with a warm browser cache. It is one sample per run.
