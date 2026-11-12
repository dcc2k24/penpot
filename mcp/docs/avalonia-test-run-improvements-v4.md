# Avalonia test run v4: re-test of the v3 fixes on the real page

The v3 re-test ([avalonia-test-run-improvements-v3.md](avalonia-test-run-improvements-v3.md)) found R1 to R7 on the real Kiosk page and left N9 and N10 open. The plan to fix them is [avalonia-v3-improvement-plan.md](avalonia-v3-improvement-plan.md). Sonnet sub-agents built each package and Opus sub-agents reviewed it, and every package was checked live on the real page in the local devenv before it was committed. This file is the re-test of the result on Azure, run with the same scripts on the same file and page as v3.

## How it was tested

- **Commits.** Four commits on `perf/render-wasm-large-files`, all passing `scripts/check-commit`:
  - `766e9a18fc` `worldMatrix` of thin shapes (P1);
  - `0389c05dfe` board selection with wrappers and the `sibling-overlay` rule (P2 and P4);
  - `dbb13c09dc` `maxResponseKb` for `export_subtree`, with the later-window sizing fix (P5);
  - `e49532867d` documents (P6).
  - The Avalonia app change (P8) is in `kam-platform-poc`, which is not under git.
- **Deploy.** `e49532867d` on Azure (version `2.19.0-RC5-278-ge49532867d`).
  - Backend and MCP images were rebuilt; the frontend and exporter were re-tagged.
  - There were no migrations.
  - The backup before the deploy is `backups/2026-11-12T0026Z`.
  - The MCP has 31 tools, and `PENPOT_MCP_SUBTREE_MAX_REQUEST_KB` is unset (default 2000 kB).
- **Data.** Azure file `b48cc9bd-bdae-8000-8008-eb67a08dd490`, page `c54dcb4e-6001-5521-83dc-e18bd52d20ab`, as in v3. The truth comes from `kam-link-work/v3plan/truth.json`, built from the v3 results and corrected during the work (see R3).
- **Suites on the final code** (local devenv):
  - Backend MCP suite: 367 and 256 tests, 0 failures.
  - Adapter: 1,657 pass, 0 fail, 21 skipped.
  - Loadtest, design-parity and plugin: all pass.
  - Types checks: clean. `clj-kondo`: clean on every touched file.
- **Scripts and results.** `C:/dev/penpot-daryl/kam-link-work/v3plan/`, with the Azure run in `results-azure-v4/`.

## Scorecard

| Item | v3 on Azure | v4 on Azure | Target | Result |
|---|---|---|---|---|
| R1. `worldMatrix` misses | 155 of 26,097 (24 above 0.5 px, max 6.9 px) | **0 of 26,097**; 60 of 60 flipped shapes right | 0 | **Resolved** |
| R2. Wrappers by margin; connector ends | 1000×800 not a wrapper; 2 screen-to-screen connectors | 1000×800 reported as `wrapper` (173); **12** screen-to-screen | at least 14 | **Mostly resolved** (target missed, see below) |
| R3. `instance-only-board` "false positives" | 36 findings, 13 called false | 36 findings, all real blanks | exactly the real blanks | **Not a fault** (see below) |
| R4. Connector direction | all `none` | all `none`; documented as by design | documented | **Documented** |
| R5. Whole page through `export_subtree` | 183 calls, 5.3 min (gzip at 100 kB) | **9 calls, 40.7 s** with `maxResponseKb: 1000`; default gzip 90 calls, 3.8 min | ≤ 10 calls, ≤ 60 s | **Resolved** |
| R6. Selection picks sections and overlays | 221 boards | **exactly the 207 truth screens**; 0 findings on a non-screen board | 207 | **Resolved** |
| R7. Cold render variance | one batch 140 s | first batch after the deploy 106 s; the others 24 to 27 s | explained | **Explained, not fixed** (see below) |
| N9. App per-side strokes | median 0.753% | **median 0.312%** against the new renders; 8 screens over the 1% non-text gate, all named | ≤ 0.315% | **Resolved** (one new named exception) |
| N10. Overlays beside the screen | not reported | `sibling-overlay` finds **exactly the 3** truth overlays, each 100% over its screen | exactly 3 | **Resolved** |

Unchanged from v3, as checked again:
- **Fonts:** `list_fonts` suggests `custom-8a4bc089…` (0.9 s).
- **`execute_code` with `rootIds`:** 207 screens in 59 s; the refusal comes in 2.8 s. 204 shape counts match; the 3 that differ are the Processing screens, whose extract now also holds the overlay.
- **Per-screen `export_subtree`:** 237 calls, 4.7 min, 7.9 MB, 0 missing, 0 extra.
- **Scroll candidates:** 19, including all 10 frames the generator made scroll lists.
- **`find_similar_boards`:** the 6 Main Menu Admin copies group, and 200 boards are compared with 7 skipped.
- **Progress:** 43 or 44 events per 40-screen batch, longest gap 5.9 s.

**Count:**
- Resolved: R1, R5, R6, N9 and N10.
- Mostly resolved: R2 (12 connectors against a target of 14).
- Not a fault: R3.
- Documented: R4.
- Explained, not fixed: R7.

## Notes on each item

### R2. 12 connectors, not 14

- **What changed.** Connector ends that land in a wrapper's margin now belong to that wrapper's screen. The nearest screen by true distance still wins.
- **What the misses are.** The P2 builder traced the 13 ends that still miss on the real data, against the frames:
  - several land in containers of 1300×1100 and 1448×2461 that hold several screens;
  - three sit on loose "Batch" or "CalloutLeft" frames;
  - one is 161 px from its screen;
  - four are 100 to 105 px from a screen, with the other end in a section.
- **Why the target was missed.** The 14 was the v3 count at `maxDistance: 150`, not a truth count. Reaching it at the default distance would need a looser reach rule. That was not done: it trades precision for count, and these arrows have no direction anyway (R4). At `maxDistance: 150` the new code finds 16 or 17.

### R3. The 13 "false positives" were real blanks

- **What was wrong.** A wrong v2 note called the 12 boot screens and admin-overview "a header plus one boot component". v3 and the truth file repeated it.
- **What the data shows.** The P3 builder showed that these boards have the same data as the other blanks: a Parent frame holding one 800×43 Header instance and nothing else. Their renders confirm it.
- **Outcome.** No code change was kept. `truth.json` now lists 36 real blanks, and `instance-only-board` matches them exactly. The three asset screens that v3 stopped flagging are real content screens, so that v2 to v3 change was correct.

### R5. Per-call cap for scripts

- **New parameter.** `export_subtree` takes `maxResponseKb`, only with `encoding: "gzip-base64"`, up to `PENPOT_MCP_SUBTREE_MAX_REQUEST_KB`.
- **Sizing fix.** The live check found that each reply held only one window. The estimate margin for later windows was applied twice, so a second window was read and then thrown away. After the fix:
  - a 1000 kB walk takes 9 calls;
  - default gzip calls also pack more, at 90 calls against 183 in v3;
  - plain-mode replies are byte-identical to before (a test pins them).

### R7. Why the cold renders vary

- **The 140 s batch in v3.** The exporter ran 26 jobs of about 4 s each, instead of 4 jobs of 10 screens. So the adapter rendered that chunk one screen per request. That is its documented fallback when a batch request fails, and the cause was not logged. Each single render pays about 4 s to load this 28,700-shape file.
- **Other slow calls.** The exporter's render worker is recycled every 5.5 minutes ("render worker exited", code 1), and a new browser starts. A call that starts at that moment pays the start-up. The 68.6 s cold probe in v3 matched one of those.
- **v4.** The first batch after the deploy took 106 s; the next four took 24 to 27 s each.
- **Next step, not done.** Log the cause of a batch fallback at warn level. Measure how often the worker recycle hits a render.

### N9. The app (kam-platform-poc)

- **References.** The design references are now the new exporter's renders. The old ones are kept in `design/reference-old-exporter/`.
- **Processing composites.** The three Processing references are composites made by the new `tools/overlay-refs.mjs`. Run against Azure, it reproduces them byte for byte.
- **Generator.** The generator now draws per-side stroke widths, with each rounded corner grown by its two adjacent sides.
- **Captures.** These freeze the spinner (`KIOSK_FREEZE_SPINNER=1`), so the pixel check repeats exactly.
- **Results.**
  - 22 app tests pass.
  - The median mismatch is 0.312% and the maximum 1.289%.
  - 8 screens are over the 1% non-text gate, all named. The new one is `check-in/islogging/logging-batch-post-overview-8` at 1.001%. It fell from 1.802%, and its two copies are at 0.996% and 0.991%.

### N10. `sibling-overlay`

- **What it reports.** A board or group of any size beside a screen in its wrapper, covering at least 50% of its own area over that screen. Each finding names the covered screen.
- **Where it applies.** Mode auto only.
- **Similar boards.** `find_similar_boards` lists such overlays per group.
- **Scale.** The scan uses a grid, is linear, and stops at the 5 s budget.

## What the review rounds changed

The Opus reviewers found real defects after the builders reported success. All were fixed and checked again:

- **P2, board selection.** P2 went through three review rounds, and each round's probes became tests.
  - **Mixed-size pages.** Its first filter for loose boards dropped real screens on pages of mixed device sizes: phones beside desktop pages, custom phone sizes, and a 1200×900 screen beside 1000×700 ones.
  - **Dialogs.** Its first wrapper rule turned a page of 1000×800 screens into "wrappers" when about half of them held a centred dialog.
  - **Overlay check.** Its overlay search had no overlap check, so a phone screen beside a tablet screen in one frame vanished from the selection.
  - **Speed.** Its second version was quadratic: 8,000 small frames took 16.9 s.
  - **Fragile overlay fix.** Its 90% wrapper share brought the R6 overlays back when two wrappers were 4 px off-centre.
- **P4, `sibling-overlay`.**
  - It first counted any section that holds screens as a wrapper.
  - It was quadratic per parent: 23.5 s for 6,000 screens in one section.
- **P1, `worldMatrix`.**
  - A solid box whose fit missed by more than 0.01 px lost its flip.
  - No test copied the real divider data. The real dividers are 0.01 px wide, not 0, which is why the old code fitted them.
  - A selrect given as x1..y2 threw an error.
- **P5, `maxResponseKb`.**
  - The advice in notes and errors named the wrong setting for a call that used `maxResponseKb`.
  - Refusals came in the wrong order.
  - A test meant to pin the default compared the new code with itself.
- **P8, the app.**
  - The generator was saved with CRLF line endings.
  - The app docs said false things.
  - The rotating spinner made the pixel check vary between runs.

## Still open

- **Navigation.** Connector direction stays `none` on this design (R4), so the reviewed navigation map is still the only navigation source. Conditional interactions (3c) and viewer scrolling (9c) are still proposals.
- **Renders.** The batch-fallback cause is not logged (R7).
- **Distance.** `find_connectors` can report the snapped frame's distance, not the screen's, for an end that is not inside the chosen screen's wrapper. This is documented.
- **Flaky test.** `rpc-mcp-write-batch-test/file-change-indexes-serve-the-replay-and-snapshot-queries` fails at times on the shared devenv test database. The Postgres planner picks `file_change__file_id__revn__idx` instead of the expected index. It is about the `file_change` indexes, which no package touched. The final suite run passed.
- **Not tested.** Writes on the real file (`replace_font` would fix the Access Sans text in one call; it needs the designers' go-ahead), and the missing-font badge in the layers panel (it needs a browser).
