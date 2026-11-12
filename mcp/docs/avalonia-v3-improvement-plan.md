# Avalonia test run v3: improvement plan

Status: **implemented and re-tested** (2026-11-12). Commits `766e9a18fc`, `0389c05dfe`, `dbb13c09dc` and `e49532867d`, deployed to Azure. Results: [avalonia-test-run-improvements-v4.md](avalonia-test-run-improvements-v4.md). Revision 1 was written on 2026-11-11. Baseline commit `eecd0ba8f7` on `perf/render-wasm-large-files`, the version deployed on Azure. Source: [avalonia-test-run-improvements-v3.md](avalonia-test-run-improvements-v3.md), the re-run of the v2 scripts on the real Kiosk page.

## Goal

Close the problems that the v3 re-test found on the real page (R1 to R7, N10 and N9), then run the same re-test again and write the result as v4. Unlike v2, the fixes are checked on the **real page from the start**. The local devenv holds the same file with the same shape and page ids, so every package has an exact target from the real data, not only from synthetic files.

## What the plan covers

| Id | Problem (v3) | Package | Where | Size |
|---|---|---|---|---|
| R1 | `worldMatrix` wrong for zero-width or zero-height shapes (24 above 0.5 px, max 6.9 px), plus float noise on 131 more | P1 | `backend/src/app/rpc/commands/mcp_subtree.clj` (`get-world-matrix`) | Small |
| R2 | Wrappers with a 100 px margin (1000×800 around 800×600) are not taken as wrappers, so connector ends that land on them are lost | P2 | `backend/src/app/rpc/mcp_boards.clj` (`wrapper-classes`), `backend/src/app/rpc/commands/mcp_prototype.clj` (end snapping) | Small to medium |
| R6 | The default selection also picks 4 section frames and 3 overlay boards (221 boards, not 207) | P2 | `mcp_boards.clj` (`select-auto`, `candidate-frames`) | Small |
| R3 | `instance-only-board` flags the 12 boot screens and admin-overview (13 false positives) | P3 | `backend/src/app/rpc/commands/mcp_lint.clj` (chrome detection) | Small |
| N10 | Overlays drawn beside the screen board are not reported | P4 | `mcp_lint.clj` (new rule `sibling-overlay`), and the selection reply | Small to medium |
| R5 | A whole page at the default 100 kB cap takes 183 calls and 5.3 min | P5 | `mcp/packages/server/src/tools/backend/ExportSubtreeTool.ts`, config | Medium |
| R4 | No connector direction: the real arrows are bare bars | P6 (docs only) | contract and tool text | Very small |
| R7 | Cold render time varies (one batch 140 s) | P7 (lead investigates) | Azure exporter and backend logs | Small |
| N9 | The Avalonia generator ignores per-side strokes | P8 | `kam-platform-poc/avalonia-ui/tools/gen-axaml.mjs`, references | Small to medium |

Not in this plan:
- **3c conditional interactions and 9c viewer scrolling.** Proposals exist. They need a product decision first.
- **`replace_font` on the real file.** It writes the designers' file. It needs the user's go-ahead and is not part of the fixes.
- **The missing-font badge.** It needs a browser check. It is listed as a gap in v4 if it is still not done.

## How the work is run

- **Lead (this session).** It writes each brief, checks every result against its brief and the truth file, runs the suites and the live checks itself, commits after review, deploys, and runs the re-test. It writes no feature code.
- **Implementation: Sonnet sub-agents** (`model: "sonnet"`), one per package, as the user asked. Every brief carries the same parts:
  - the goal and the failing numbers;
  - the files to read first;
  - the exact behaviour wanted;
  - the tests to write first (red, then green);
  - the commands to run;
  - the live check on the real page, with its target from the truth file;
  - what done means;
  - the standing rules below.

  Agents do not commit and do not push. Each reports what it changed, the test results, and every number that missed its target. It does not loosen a target.
- **Review: Opus sub-agents** (`model: "opus"`), one per chunk, that built none of it. A reviewer gets the diff, the brief and the v3 text, but not the lead's opinion. It may run probes. It reports ranked findings with file, line and a failing scenario. The builder fixes them, and the reviewer checks the fixes.
  - **Chunk A:** P1 to P4, the backend.
  - **Chunk B:** P5 and P6, the adapter and the docs.
  - **Chunk C:** P8, the app.
- **Parallel work.** P1, P3 and P5 touch different files and run at the same time. P2 then P4 run in sequence, because P4 uses the selection that P2 changes. P8 runs at any time; it is in another repository.
- **The shared devenv** (revision 1.1, after phase 0). Agents never restart the devenv backend or MCP server. They run unit tests and suites in separate processes, and every backend test run takes the lock `flock /tmp/backend-tests.lock`, because all runs share the instance's test database. The lead restarts the backend and the MCP server after a package and runs its live check and the synthetic regression check.
- **Gates.** A package is done when all of these pass:
  - its new unit tests and the MCP suites of every module it touched (`backend/scripts/run-mcp-tests-local`, `mcp/scripts/run-tests-local`);
  - the linters;
  - the synthetic kiosk check, so v2's gains don't regress (`mcp/packages/loadtest/scripts/kiosk/verify-kiosk-journeys.mjs` on `kiosk-journeys-207`);
  - its live check on the real page;
  - the Opus review.

### Standing rules (in every brief)

- No `git push`, no remote changes, no commits: the lead commits.
- No edits to `CHANGES.md`, the v2 or v3 result files, or this plan.
- Test output goes to a file before it is read.
- Backend test runs set `PENPOT_DATABASE_MAX_POOL_SIZE=16`.
- Read-only on the real file: no write tool, no `apply_operations`, no `replace_font` on file `346a1245…` or any designer file. Writes go only to the synthetic kiosk files or to new scratch files.
- Never print tokens, passwords or `.env` values. Read the token from its file.
- Do not call the advisor tool.
- Shared documents (`api_topics.yml`, `backend_instructions.md`, `backend-mode-contract.md`) are edited only in P6. Other packages hand P6 their sentences in their report.

## Environment (phase 0, lead)

1. Bring the devenv checkout `~/penpot-daryl` (WSL) to the baseline: `git fetch /mnt/c/dev/penpot-daryl/penpot perf/render-wasm-large-files`, then a new branch `fix/avalonia-v3` at `eecd0ba8f7`. The untracked local scripts stay. No remote is added or changed.
2. Restart the devenv backend (tmux window `backend`; migration `0160` runs), then rebuild and restart the MCP server (`mcp/scripts/start-mcp-backend-local`).
3. Reproduce the v3 faults locally with the v3 scripts (`kam-link-work/v3plan/*.mjs`, `MCP_URL=http://localhost:4401/mcp`, token `mcp-local-test/token-local.txt`, file `346a1245-d382-806c-8008-dfd3c561a4b4`). Each package starts only when its fault reproduces locally. A fault that does not reproduce is reported to the user, not worked around.
4. Truth file: `kam-link-work/v3plan/truth.json`, built from the v3 results. It holds:
   - the 207 screens with board, wrapper and boxes;
   - the 23 real blanks and the 13 false positives;
   - the 10 scroll frames of the generator;
   - the 3 overlays with the screens they cover;
   - the 155 `worldMatrix` misses;
   - the connector counts.

## Packages

### P1. `worldMatrix` for degenerate boxes (R1)

- **Cause to confirm.** `get-world-matrix` fits the matrix from `points`. With a zero-width or zero-height `selrect` the fit is singular. The stored-transform fallback is not taken, so the translation comes out wrong, for example (−1.7, −1.3) on the 0×1 dividers of cabinet-select. On large page coordinates (about −56,000) the fit leaves 0.01 to 0.05 px of noise.
- **Wanted.**
  - When a side of the box is below a small epsilon, or the fit's residual is above 0.01 px, use the stored transform about the centre. That path was right for all non-flipped shapes in v2.
  - When the fitted and the stored matrices agree within 0.05 px, return the stored one exactly.
  - Flipped shapes and groups keep the v2 fix.
- **Tests first.** Add to `backend/test/backend_tests/rpc_mcp_subtree_test.clj`:
  - a 0×1 and a 1×0 path and frame inside a flipped and an unflipped group;
  - a shape at page coordinates near −56,000;
  - the existing flip cases.
- **Live target.**
  - Real page, all 207 screens through `export_subtree`: `worldMatrix` maps `selrect` onto `points` within 0.01 px for all 26,097 shapes.
  - 0 of the 155 ids in `truth.worldMatrixMissesV3` miss, and 60 of 60 flipped shapes are right.
  - `t2-wm.mjs` reports `bad: 0`.

### P2. Board selection: wrappers by margin; no section or overlay boards (R2, R6)

- **Cause to confirm.**
  - `wrapper-classes` accepts a frame at most 1.25 times the height of the standard screen it holds. This design's wrapper is 1000×800 around 800×600, a ratio of 1.33.
  - `select-auto` also keeps a few boards of other sizes: the 10600×5880 and 9645×6924 section frames and the 480×460 overlays.
- **Wanted.**
  - A frame class is a wrapper also when most of its frames hold exactly one screen with an even margin on every side, of at most 200 px and within 2 px of each other.
  - The selection's boards are the screens. A board larger than the page's screen size in both directions is not a board. The overlay boards are not boards either (P4 reports them).
  - The reply keeps saying how the boards were chosen. The wrapper size appears in `otherSizes` with relation `wrapper`.
  - In `find_connectors`, an end that lands within `maxDistance` of a wrapper snaps to the one screen inside it, with `screenId` set and `distance` measured to the screen.
- **Tests first.** In the `mcp_boards` and `mcp_prototype` tests:
  - a page with margin wrappers (100 px on all sides), section frames 10 times the screen size, and overlay boards beside a screen inside the wrapper;
  - a connector that ends on a wrapper edge.
- **Live target.**
  - Real page, default `lint_page`: exactly the 207 boards of `truth.screens`, and no finding on a non-screen board. The wrapper size 1000×800 is reported as `wrapper`.
  - Default `find_connectors`: at least 14 screen-to-screen connectors, the count with `maxDistance: 150` in v3, and 0 screen ids outside `truth.screens`.
  - `kiosk-journeys-207`: selection and connector checks unchanged from the v2 resolution (207 screens; 209 connectors, 0 missing, 0 extra).

### P3. Chrome per section in `instance-only-board` (R3): dropped, not a fault

**Outcome (revision 1.1).** The P3 builder found that the 12 boot screens and admin-overview have the same structure as the other blanks: a Parent frame holding one 800×43 Header instance and nothing else. Their renders confirm it. The v2 note that called them "a header plus one boot component" was wrong, and v3 and the truth file repeated it. The three asset screens that v3 stopped flagging are real content screens. So on the real page `instance-only-board` is already right: 36 findings, all real blanks. The P3 change was reverted, so the diff holds only real fixes, and `truth.json` now lists 36 blanks. The original text of the package follows for the record.

- **Cause to confirm.** Chrome is a component at the same edge on 70% of the screens of the page. The boot screens' Header appears on the 12 boot screens only (one section), so it is not chrome there. The boot component is the content.
- **Wanted.**
  - Chrome is also a component at the same edge on 70% of the screens of one top-level section, counted in that section only.
  - A board whose only non-chrome content is a single instance that covers at least 50% of the board's area is not instance-only: the instance is the content.
  - The 23 real blanks keep firing.
- **Tests first.** A page with:
  - a section of 12 screens that are a section-only header plus one large boot component;
  - placeholder screens that are a header plus one small text;
  - the existing chrome cases.
- **Live target.**
  - Real page, default call: `instance-only-board` fires on exactly the 23 boards of `truth.blankScreens`, and on none of `truth.instanceOnlyFalsePositivesV3`.
  - `empty-board` stays at the 7 screens of v3, without the section frame (P2).
  - `kiosk-journeys-207`: still exactly the 23 blanks and none of the 17 instance-only screens.

### P4. Rule `sibling-overlay` (N10)

- **Wanted.**
  - A new lint rule. It reports a visible board or group that is not a screen, overlaps a screen board by at least 50% of its own area, and is not inside that screen.
  - The finding names the screen board (`boardId`), the overlay (`shapeId`, `shapeName`) and the covered fraction.
  - In `find_similar_boards`, a group whose boards carry such overlays says so (`overlays: [{boardId, shapeId}]`), so a reader can tell the copies apart.
  - The rule is in the default rule set and takes part in offset paging.
- **Tests first.** One overlay beside its screen in a wrapper. A sibling that overlaps by only 30%. A hidden overlay. An overlay already inside the screen, which is not reported.
- **Live target.**
  - Real page: exactly 3 findings, the 3 entries of `truth.overlays`, each with its covering screen.
  - No other finding moves.
  - `kiosk-journeys-207`: 0 findings.

### P5. Per-call subtree cap for scripts (R5)

- **Wanted.**
  - `export_subtree` takes `maxResponseKb`, from 1 up to a server maximum `PENPOT_MCP_SUBTREE_MAX_REQUEST_KB` (default 2000). Above the server maximum it is refused with the limit named.
  - The parameter is allowed only with `encoding: "gzip-base64"`, so a model client that leaves `encoding` out keeps today's default cap.
  - `PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB` stays the default.
  - The tool text says it is for scripts.
- **Tests first.** In the adapter tests (`mcp/packages/server`):
  - the schema accepts and refuses the parameter;
  - the cap is applied;
  - it is refused without `encoding`;
  - the default stays when it is left out.
- **Live target.**
  - Real page, local devenv, whole-page walk with `encoding: "gzip-base64", maxResponseKb: 1000`: 10 calls or fewer, 60 s or less, 28,708 shapes, none twice.
  - The default call is unchanged (`t8-page.mjs` plain and gzip numbers within 10%).

### P6. Documents (R4 and the sentences from P1 to P5)

- **Contract** (`backend-mode-contract.md`), `api_topics.yml` and `backend_instructions.md`. Write:
  - the degenerate-box fallback of `worldMatrix`;
  - the wrapper-by-margin rule;
  - which boards are left out;
  - the end snapping;
  - chrome per section;
  - `sibling-overlay`;
  - `maxResponseKb`.
- **R4.** One paragraph: connector direction is read only from heads (caps, head shapes, grouped heads). Bare bars and unions of rectangles read `none` by design. Designers who want machine-readable flows should use `line-arrow` caps or prototype links.
- **Live target.** Every new parameter appears in the adapter schema, the tool description and the contract, in the same words.

### P7. Cold render variance (R7, lead)

- Read the exporter and backend logs on the Azure VM for the window of the v3 render (2026-11-11, about 20:52 to 21:00 UTC). Look for held export permits, browser restarts and queue waits.
- Write down the cause, or that it was not found. A code fix follows only if a cause is found. It is then a new package with its own brief.

### P8. Per-side strokes in the Avalonia generator (N9, kam-platform-poc)

- **Wanted.**
  - Replace the references with the new exporter's renders (`kam-link-work/v2test/renders/v3cold`). Keep the overlay composites of the three login Processing screens, built again on the new base renders with `overlay-refs.mjs`.
  - Switch per-side stroke widths back on in `tools/gen-axaml.mjs`. The code is there; `sideWidths` is read but the exporter-matching path ignores it.
  - Regenerate, then run the pixel and layout check.
- **Tests.** The app's test suite (`dotnet test`) and `tools/diff-screens.mjs --all`.
- **Live target.**
  - App against the new references: median mismatch at or below 0.315% (the v2 figure against the old references), and every screen within its gates.
  - The 177 screens with per-side strokes improve, or none gets worse by more than 0.05 points.

## Re-test (phase 9, lead)

1. Commit each package after its review, with one commit per package and messages that pass `scripts/check-commit`. Then bring the commits into the Windows repo with a local fetch from the WSL checkout (no remote is added).
2. Build and deploy to Azure as in the deployment guide: backup first, images, migration check, verification. The VM stops at 22:00 UK time. A deploy after that starts the VM by hand.
3. Run the v3 scripts again on Azure with the same file and page.
4. Write `avalonia-test-run-improvements-v4.md`. Score each R item and N9/N10 against the targets above, and list anything new. Each number comes from the run, and a target that is missed is reported as missed.

## Cost and order

- **Agents.** About 6 Sonnet builders (P1, P2, P3, P4, P5 with P6, P8) and 3 Opus reviewers (chunks A, B, C), plus fix rounds.
- **Order.**
  - P1, P3, P5 and P8 start together.
  - P2 starts after P1's backend restart slot.
  - P4 starts after P2.
  - P6 follows P1 to P5.
  - The reviews follow each chunk.
