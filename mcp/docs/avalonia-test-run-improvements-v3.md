# Avalonia test run v3: re-test of the v2 fixes on the real page

The v2 re-test ([avalonia-test-run-improvements-v2.md](avalonia-test-run-improvements-v2.md)) listed new findings N1 to N10 and five items left from the first run. The v2 fixes were checked on synthetic kiosk files only. Its open items included "the re-run of the v2 scripts on the other deployment, on the real page". This file is that re-run. It lists what is resolved on the real data, what is not, and the new problems found.

## How it was tested

- **Deploy.** `eecd0ba8f7` on the Azure instance (version `2.19.0-RC5-274-geecd0ba8f7`).
  - Frontend, backend and MCP images were rebuilt. The exporter is unchanged and was re-tagged.
  - Migration `0160-add-mcp-reply-to-file-change` (a nullable column) ran at backend start, with no backend errors.
  - The backup before the deploy is `backups/2026-11-11T2011Z`.
  - The MCP still has 31 tools.
  - `PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB` was left unset, so the 100 kB default applies: the instance also serves model clients.
- **Data.**
  - File `b48cc9bd-bdae-8000-8008-eb67a08dd490` (revision 165), page `c54dcb4e-6001-5521-83dc-e18bd52d20ab`: the same file and page as v2.
  - Ground truth as in v2: the binfile extract the app was built from, the 207 reference renders and the reviewed navigation map. The v2 results serve as the baseline.
- **Method.** The v2 scripts were re-run unchanged where possible. They were extended for the new options: `gzip-base64`, offset paging, default board selection, progress tokens, and font suggestions.
- **Scripts and results.** `C:/dev/penpot-daryl/kam-link-work/v2test/`: `results/` for v3, `results-v2/` for the baseline. They are not in this repository.

## Scorecard

| Item | Now | Measured on the Kiosk page |
|---|---|---|
| N1. `worldMatrix` of flipped groups | **Resolved; regression elsewhere** | 60 of 60 flipped shapes are right (v2: 40 of 60). But 155 other shapes now miss, against 0 in v2. 24 of them are off by more than 0.5 px (max 6.9 px): see R1. |
| N2. `circle` reported as `ellipse` | **Resolved** (documented) | The Geometry topic has the mapping. Still 531 circles as `ellipse`, by design. |
| N3. No suggested font | **Resolved** | `list_fonts` gives `suggestedFontId: custom-8a4bc089…`, the team's real Access Sans Bold, and the outline warning carries it too. |
| N3b. `warningsComplete` never true | **Resolved** | The outline names the pending pages (`page-too-large`). One whole-file `list_fonts` (5.1 s, 12 of 12 pages) makes the next outline complete. |
| N4. Lint defaults and noise | **Mostly resolved** | The default call reaches all 207 screens (2.1 s, 204 findings, one page). `off-board-control` now fires only on two 1 px overhangs (the 0.00005 px case is gone). New `scroll-candidate`: 19 findings, including all 10 frames the generator made scroll lists. `instance-only-board`: all 23 blanks are still found, and the false positives fell from 17 to 13. See R3. |
| N5. `find_similar_boards` depth | **Resolved** | 213 boards, 8 in `skippedSmall`, 448 pairs, 1.0 s. The 6 Main Menu Admin copies group (0.989), and each logging screen forms an exact group of 3. |
| N6. Connector noise and direction | **Partly resolved** | Same-screen lines are left out (84 in `sameScreenSkipped`). But the default call finds only 23 connectors, and 2 of them join two screens (v2: 12). All 23 have direction `none`. See R2 and R4. |
| N7. `rootIds` speed and refusal | **Resolved** (targets near) | The refusal comes in 2.5 s (v2: 14.6 s) and names the limit and `rootIds`. 207 screens load in 11 calls and 60 s (v2: 5.6 min). A call takes 2.5 to 8.2 s; 5 of the 11 are above the 5 s target. 207 of 207 shape counts match. |
| N8. Bulk `export_subtree` | **Improved; target not met at the default cap** | Per screen: 239 calls, 4.9 min, 8 MB (v2: 784 calls, 12.7 min, 48 MB). Whole page: `gzip-base64` 183 calls, 5.3 min, 8.5 MB; plain 528 calls, 18.3 min, 52 MB. 28,708 of 28,708 shapes, none twice, no rate-limit stop. See R5. |
| N9. Generator per-side strokes | **Open** (ours) | Not done in `kam-platform-poc`. |
| N10. Overlays beside the screen board | **Open** | Not in the v2 plan. The 3 overlay boards (480×460) are now picked as boards of their own, unrelated to the screen they cover. No rule reports them. See R6. |
| 3c. Conditional interactions | Proposal only | `proposal-conditional-interactions.md` |
| 9c. Scrolling | **Helped** | `scroll-candidate` lists the frames to mark. Nothing sets `overflowScroll` yet, and the viewer does not scroll. |
| Progress during a batch export | **Resolved** | A cold 40-screen call sent 44 notifications, with the longest gap 5.9 s (v2: about 27 s of silence). The client must send a progress token. |
| Missing-font badge in the layers panel | Not checked | It needs a browser. Not done in this run. |
| Lazy whole-page load | Covered by N7 | |
| Batch render (first run, item 4) | **Still works; slower this run** | 207 cold renders in 251 s (v2: 147 s). One 40-screen batch took 140 s, and a later cold one 68.6 s; the others took about 25 s. From the cache: 18.7 s. 206 of 207 renders are pixel-identical to v2, and the last differs by 0.001%. See R7. |

**Count against v2's open list:**
- Resolved: N2, N3, N3b, N5, N7 and progress.
- Mostly resolved: N4.
- Resolved with a regression: N1 (R1).
- Improved but short of target: N8.
- Partly resolved: N6.
- Open: N9 (ours) and N10.
- Not checked: the font badge.

## New problems found by the re-test

### R1. `worldMatrix` is wrong for degenerate shapes (regression)

- **What.** `worldMatrix` is now computed from `points`. On shapes with zero width or height, the fit gives a wrong translation. One example is the 0×1 vertical dividers of cabinet-select: the matrix is the identity plus (−1.7, −1.3).
  - 24 shapes are off by more than 0.5 px, with a maximum of 6.9 px. All of them were exact in v2.
  - A further 131 are off by 0.01 to 0.05 px, which is float noise from the fit on page coordinates near −56,000.
- **Effect.** A generator that trusts `worldMatrix` places these dividers and their paths a few pixels off.
- **Fix.**
  - Fall back to the stored transform when the box is degenerate, as the resolution note says it should. The fallback does not trigger for a zero-width box.
  - Round the fitted translation, or snap to the stored transform when the two agree within 0.05 px.

### R2. The wrapper rule misses this design's wrappers, so connectors lose their ends

- **What.** Every screen sits in a 1000×800 wrapper with a 100 px margin. The wrapper rule accepts a frame "at most a quarter taller" than the screen, and 800 / 600 is 1.33, so the wrappers are not taken as wrappers. The selection reports them as `otherSizes`, relation `outside`. An arrow that ends on a wrapper's edge lies 100 px from the screen, beyond the default `maxDistance` of 64, so the end counts as non-screen.
- **Measured.**

  | Call | Connectors | Screen-to-screen |
  |---|---|---|
  | Default | 23 | 2 |
  | `maxDistance: 150` | 30 | 14 |
  | Depth mode with `^Parent$`, `maxDistance: 150` | 32 | 10 |

- **Fix.**
  - Accept a wrapper by margin as well as by ratio, for example a frame that holds exactly one screen with an even margin of 200 px or less.
  - Or snap an end that lands on a frame holding exactly one screen to that screen.

### R3. `instance-only-board` still flags the boot screens

- **What.** 36 findings: the 23 real blanks (16 misc and 7 admin-actions placeholders) plus 13 false positives. These are the 12 boot screens (a header and one boot component) and admin-overview. The three asset screens no longer fire.
- **Why.** Chrome detection needs a component at the same edge on 70% of the screens. The boot Header appears only on the boot screens, so it is not taken as chrome.
- **Fix.** Count chrome per section as well as page-wide. Or skip a board whose single non-chrome instance covers most of the board: the boot component is the content.

### R4. No connector direction on the real arrows

- **What.** All 114 candidates (with `includeSameScreen`) read `none` or `both`. The journeys' lines are bare filled bars or unions of 5 px rectangles. Examples: a 10×348 bar, and a 22-segment bus line. No head is grouped with them, and no small shape lies within 40 px of their ends.
- **Assessment.** The tool is now honest. v2 guessed from width, and 6 of its 10 directions were wrong. But on this file it gives no navigation evidence: the reviewed navigation map stays the only source.
- **Fix.** None on the tool side, unless heads exist elsewhere. Designers who want machine-readable flows should use stroke caps (`line-arrow`), or the prototype links proposed in 3c.

### R5. A whole page at the default cap is still minutes, not seconds

- **What.** At the 100 kB default, a whole page takes 183 calls and 5.3 min with `gzip-base64`. Plain takes 528 calls and 18.3 min. That is fewer calls than v2's 784, but a longer wall time, because each call reads up to 24 windows.
- **Context.** The 10.6 s figure in the resolution was measured at a 1 MB cap on a laptop. A binfile export of the same file took 49 s.
- **Fix.** Either raise `PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB` on this instance, a deployment choice (model clients would then get 1 MB replies), or let a script client ask for a larger cap per call, within a server maximum. The cap is a server setting today.

### R6. Overlays are picked as boards of their own (follows N10)

- **What.** The default selection lists 221 boards:
  - the 207 screens;
  - 3 boards of 480×460, the "Verifying …" panels laid over the three login Processing screens;
  - 4 section frames (10600×5880 and 9645×6924);
  - 7 component-sized boards.
- **Effect.** One `empty-board` finding is a section frame ("Check Out - Lot Blocking"), not a screen. The overlays are linted as boards, but nothing says which screen they cover. `find_similar_boards` still groups Login with the three Processing screens at 0.989.
- **Fix.**
  - Leave out boards larger than the page's screens.
  - Report a board that overlaps a screen board by most of its own area as an overlay of that screen: rule `sibling-overlay`, as proposed in v2 N10.

### R7. Cold render time varies

- **What.** With the same exporter image as v2, most 40-screen batches took about 25 s, as before. One took 140 s, and a later cold batch took 68.6 s. The first run after a deploy also starts with an empty render cache. The cause is not known.
- **Next step.** Check the exporter's queue and permit logs (`Report held export permits`, `9ced853298`) for a hold during those calls.

## Priorities

| Item | Why | Size |
|---|---|---|
| R1. Degenerate-box fallback in `worldMatrix` | A silent geometry error that v2 did not have | Small |
| R2. Wrapper by margin, or snap to the only screen | Connectors are useless on this file without it | Small |
| R3. Chrome per section | 13 false positives on a typical journeys page | Small |
| R6 and N10. Overlay rule; leave out boards larger than the screens | Modals beside the screen are lost, and section frames are linted as screens | Small to medium |
| R5. Per-call subtree cap for scripts | Bulk reads in seconds without changing the cap for model clients | Medium |
| R7. Cold render variance | Look at the permit logs first | Small to investigate |
| 3c and 9c | Product features, still the largest gaps for code generation | Large |

## Not tested

- Writes on the real file: a retried `requestId`, the new refusals and `replace_font`. One `replace_font` call (`gfont-access-sans` to `custom-8a4bc089…`) would fix the font on this page. It was not run, because it changes the designers' file.
- The missing-font badge in the layers panel (it needs a browser).
