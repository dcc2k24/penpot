# Navigation perf benchmark

Measures how the WASM renderer keeps up while you pan and zoom a large page.
It is a measurement tool. It asserts no performance targets.

Run from `frontend/` (skipped without `PENPOT_PERF=1`):

    PENPOT_PERF=1 npx playwright test --project=render-wasm perf-navigation

Env vars: `PENPOT_PERF_DOUBLINGS=<n>` (default 6, select-all and duplicate
rounds) and `PENPOT_PERF_OUT=<dir>` (default `frontend/tmp/bench`).
Output: `perf-navigation-<timestamp>.json`, plus a console table.
`frontend/tmp/` is not git-ignored. Do not commit results by accident.

Scenarios:

- S1: wheel pan for 5 s, per zoom level.
- S2: space-drag pan, per zoom level.
- S3: ctrl-wheel zoom in and out, from fit.
- S4: Shift+1 and Shift+0, timed from the key press.

Zoom levels are approximate: 100%, about 45%, about 27%, fit.
Each "-" press divides zoom by 1.3, so exact 50% and 25% are not reachable.

Metrics:

- `frames.p50`, `p95`, `p99`, `max`: gaps between frames, in ms.
- `longTasks`: tasks over 50 ms on the main thread. Count and total ms.
- `timeToSharpMs`: last input to the next tiles-complete. Null if none in 10 s.
- `counters`: `window.penpotRenderCounters()`, if the page defines it.

## Real-file benchmark

The spec `perf-real-file.spec.js` in this folder runs against a real backend and a real saved file. It uses no RPC mocks.

Generate the file with `frontend/scripts/perf/generate-large-design.mjs`. The script writes the file-info JSON that `PENPOT_BENCH_FILE_INFO` points to.

Set these env vars:

- `PENPOT_PERF_REAL=1`: required. Without it the spec skips.
- `PENPOT_PERF_BASE_URL`: default `http://localhost:3450`.
- `PENPOT_BENCH_CREDENTIALS`: path to a JSON file with `email` and `password`.
- `PENPOT_BENCH_FILE_INFO`: path to the file-info JSON from the generator.
- `PENPOT_PERF_OUT`: optional. Default `frontend/tmp/bench`.
- `PENPOT_PERF_GROUPS`: optional. Comma list of `nav`, `pages`, `edit` and `theme`. Default is `nav`, `pages` and `edit`. `nav` runs S1 to S4, `pages` runs S6, `edit` runs S7 to S9 and `theme` runs T1 to T3. `theme` is not in the default.

Run from `frontend/`. In PowerShell, first set each variable with `$env:NAME = "value"`. Then run:

    PENPOT_PERF_REAL=1 PENPOT_PERF_BASE_URL=http://localhost:3450 PENPOT_BENCH_CREDENTIALS=<path> PENPOT_BENCH_FILE_INFO=<path> npx playwright test --project=render-wasm perf-real-file

The backend must run with the render-wasm flags on: `enable-feature-render-wasm` and `enable-render-wasm-dpr`. The spec does not set flags.

Output: `perf-real-file-<timestamp>.json`, with `coldOpen`, `scenarios` (S1 to S4), `pageSwitches` (S6), `editing` (S7 to S9) and `themeSwitches` (T1 to T3).

### Editing scenarios

The `edit` group picks one root board near the viewport centre, then zooms to about 45%. Each edit is undone, so the file stays unchanged. Penpot's undo stack may hold older entries. The spec presses undo only until its own edit is undone, and never more than a set maximum.

- S7: drags the selected board 400 px right and 200 px down, in 60 steps. Then it presses undo. The drop may put the board inside another board under the cursor, before the undo.
- S8: presses ArrowRight 20 times, 60 ms apart. Then it presses undo until the board is back, at most 20 times. Penpot merges quick nudges into one move, so few undo presses are needed.
- S9: presses "5" (opacity 50%), then "0" (opacity 100%), one second apart. Then it undoes both.

Edit results add fields such as `boardId`, `moved` (dx and dy in screen px), `restored`, and `undoPresses`.

Metrics for these scenarios:

- `settledMs`: from the input to the last tiles-complete, once no newer one arrives for 500 ms (800 ms for S8). Null on timeout (10 s) or if no tiles-complete comes after the input.

A skipped scenario has `skipped: true` and `reason`, and no metrics. A step skips when no board title is visible, the click does not select the board, or the step throws. Skips do not fail the test.

### Theme switch scenarios

The `theme` group changes the active token theme in the Tokens tab. It works on the cold page, with one board framed. It runs three switches:

- T1: Light to Dark.
- T2: Dark to Mid.
- T3: Mid to Light.

After each switch, the spec opens another Screens page and times how long that page takes to show the new theme. Names look like `T1 theme Light -> Dark` and `T1 other page in Dark`.

The file must come from the generator with `--themed`. Without the Light, Dark and Mid themes, the group records skipped scenarios.

Metrics for the switch scenarios:

- `firstChangeMs`: from the click to the first screenshot of a 160 px square at the viewport centre that differs from before. A screenshot waits for the main thread, so on a big file one shot can take as long as the longest task. `firstChangeAfterMs` is when the last unchanged shot returned: the change came between the two. `screenshotAvgMs` gives the cost of one shot. `timeToSharpMs` can come before the change, since the first render after the click may not show the new colours yet.
- `timeToSharpMs`: from the click to the next tiles-complete.
- `settledMs`: from the click to the last long task, long animation frame, tiles-complete or render-counter change. The timer stops once nothing happens for 1 s. It gives up after 10 min.
- `longestTaskMs` and `totalBlockingTimeMs`: the longest long task, and the sum of each long task's time over 50 ms.
- `longestLoafMs`, `loafBlockingMs` and `loafCount`: the same figures for long animation frames.
- `persistMs`: from the click to the end of the save. Null if no save starts within 15 s.
- `activeTheme` and `themeActive`: the selector label after the switch, and whether it shows the new theme.
- `canvasChanged`: whether the square differs from before the switch.

Metrics for the other-page scenarios:

- `timeToNewThemeMs`: from the page click to the first of two equal 240 px squares at the centre that differ from the page in the old theme. The spec polls every 150 ms, for up to 60 s.
- `newThemeShown`: whether the page at the end differs from the old theme.
- `matchesInitial` (on T3 only): whether the cold page and the other page look byte for byte as they did before the first switch. This is information only. When a page differs, the spec writes `theme-cold-before.png` and `theme-cold-after.png` (or `theme-other-...`) to the output folder.

To check that each theme shows the right tokens, run the generator with the same file-info JSON:

    node frontend/scripts/perf/generate-large-design.mjs --verify-theme <Name>

Results land in `frontend/tmp/bench` by default. Git does not ignore `frontend/tmp/`. Do not commit results.

The Playwright config still starts its web server on port 3000. Outside CI it reuses one that is already running. The real-file spec does not use port 3000; it only uses `PENPOT_PERF_BASE_URL`.
