# Avalonia test run v2: improvement plan

Implemented and reviewed, and checked live on the synthetic kiosk files. The full suites and the timings have run, and the budgets are met. The layers-panel badge is checked in a browser. What remains is the Azure re-run. Results are in the Resolution section of [avalonia-test-run-improvements-v2.md](avalonia-test-run-improvements-v2.md#resolution-2026-11-11).

Status: **plan, revision 3, implemented** (2026-11-11). Baseline commit `f8533fb0e9` on `perf/render-wasm-large-files`. Source: [avalonia-test-run-improvements-v2.md](avalonia-test-run-improvements-v2.md), the re-test of the first findings on the Azure deployment of `ddf26eff8c`.

Revision 2 follows an independent review of revision 1 by an Opus 5.5 sub-agent, which checked every stated cause against the code. The review found that revision 1 would not have closed the findings: one fix could not work (the download URL), one fixture did not reproduce its fault, one cause was probably wrong, one matching rule missed the very case it was for, and one feature already existed. Each point was checked again in the code and is folded in below. The section "What the review changed" lists them.

## Goal

Close every open point of the v2 re-test: the new problems N1 to N8, the points left from the first run, and the items the re-test could not check. Each change is tested at more than one level, reviewed by a model that did not write it, and proved in the end by the same re-test on Azure.

## What the plan covers

| Id | Problem | Phase | Size | Before code |
|---|---|---|---|---|
| N1 | `worldMatrix` ignores the flip of flipped groups | 1 | Small | |
| N2 | The Geometry topic does not say that `circle` is shown as `ellipse` | 1 | Small | |
| N4c | `off-board-control` fires on a 0.00005 px overflow | 1 | Small | |
| N4a | `lint_page` and `find_similar_boards` defaults reach only the section frames | 2 | Medium | |
| N5 | `find_similar_boards` compared 201 of 207 screens | 2 | Small | |
| N4b | `instance-only-board` has 17 false positives against 23 real blanks | 2 | Small to medium | Three hypothesis fixtures |
| 9c-a | Nothing sets `overflowScroll`; no tool suggests it | 2 | Small | |
| N3 | `list_fonts` does not point to a team font that would fix a missing font | 3 | Small | |
| N3b | A client cannot tell when the font warnings are final | 3 | Small, Medium with Redis | |
| N3c | No one-call font swap | 3 | Medium to large | Design note |
| N6 | `find_connectors`: same-screen noise, wrong or missing direction, low recall | 4 | Medium | |
| N7 | `execute_code` with `rootIds` takes 22 to 30 s a call; the whole-page refusal takes 14.6 s | 5 | Medium to large | Profile |
| N8 | A whole page through `export_subtree` takes 784 calls in multi-user mode | 5 | Large | Spike on the fetch path |
| 4 | A 40-shape export is silent for about 27 s | 5 | Very small | |
| 7 | No missing-font badge in the layers panel; UI notices not re-tested | 6 | Small | |
| 9c-b | The viewer does not scroll a board with `overflowScroll` | 6 | Large | Design note, decision |
| 3c | No conditional or variable-driven interactions | 7 | Large | Proposal, decision |

Not in this plan, with the reason:

- **N9.** The Avalonia generator follows the old exporter. The fix is in `kam-platform-poc`, not here.
- **10.** The advisor tool fault is in the agent harness.
- **1, lazy loading of a whole page.** `rootIds` covers the need, and the v2 file agrees. N7 makes it fast.

## How the work is run

- **Lead (this session).** Plans, writes each brief, checks every result against the brief, runs the suites and the live checks itself, and commits. It writes no feature code.
- **Implementation: Sonnet 5.5 sub-agents** (`model: "sonnet"`). The user chose Sonnet for this work; this overrides the standing rule that names Haiku, for this plan only. One agent per work package. Each brief gives the goal, the files, the exact behaviour, the tests to write, the commands to run and what done means. Every brief still carries the line that forbids the advisor tool. Agents do not commit and do not push.
- **Review: Opus 5.5 sub-agents** (`model: "opus"`), in large chunks. One reviewer reads the whole diff of a chunk, so it sees how the parts fit. The reviewer built none of it. It gets the code, the brief and the v2 text, but not the lead's opinion, and it may run probes. It reports ranked findings with file, line and a failing scenario. Sonnet fixes them, and the reviewer checks the fixes.
- **Gates.** A phase is done when its unit tests, the suites of every module it touched, the linters, a live check on the dev stack and the Opus review all pass. A number that misses its budget is reported, not loosened.
- **Shared documents.** Phases 1 to 4 all touch `api_topics.yml`, `backend_instructions.md` and `backend-mode-contract.md`. In each phase one package, the last one, owns the document edits; the others hand it their sentences. A new or changed parameter always comes with its adapter schema, its tool description and its contract line in the same package.
- **Standing rules.** No `git push`. No edits to `CHANGES.md`. Test output goes to a file before it is read. Backend test runs set `PENPOT_DATABASE_MAX_POOL_SIZE=16`. One frontend compile at a time. No clicks on export buttons in the browser pane. Commit messages pass `scripts/check-commit`.

## Test data: a synthetic kiosk journeys file

The Penpot files of the re-test cannot be brought to this machine, and neither can its raw results. So the work is tested on a file built here that copies the real one in kind and in size: the journeys of a standalone 800 by 600 kiosk that people use to manage keys. A generator script builds it and writes a manifest of the truth beside it, so every test knows the right answer exactly.

**The twelve views.** Each is a distinct 800 by 600 screen, built from shared components:

1. Screen saver, with a brand text in a font that does not resolve (`gfont-access-sans`), while the team holds the real font under a family name that carries its weight.
2. Login, with a PIN pad and a card prompt.
3. Login failure.
4. Main menu.
5. Main menu admin.
6. Cabinet select, with a Select button 81 px past the right edge.
7. Check out, with a key list whose rows run past the bottom of a clipping frame.
8. Check in.
9. Logging.
10. Settings overview, with one row clipped away by its own frame.
11. Boot and asset screens, drawn in three structures (see N4b).
12. Admin actions: a header and nothing else.

A shared Header component sits on every view.

**The journeys around them.**

- 12 section frames at depth 1, one per journey.
- The screens as `Parent` boards at depth 5, six of them inside `Single` frames at depth 6, and seven of them empty.
- Copies: Main menu admin six times, and the logging flow three times (in Logging, Check in and Check out).
- Blank screens and instance-only screens in the numbers the v2 file gives.
- "is…?" decision frames between screens.
- Navigation drawn as flattened, filled arrow outlines in several styles (triangle head, swept barbs, round tail dot, curved shaft), plus dividers and icons that look like connectors inside one screen.
- Repeated frames inside the screens (list rows, buttons, cards), so that screens are not the most common frame.
- 60 flipped shapes, 20 of them groups whose `transform` is the identity while their `points` are mirrored. `apply_operations` cannot make such a group, because Penpot recomputes the transform from the points; the generator writes those shapes as raw changes.
- Circles, per-side strokes, gradients on non-square boxes.

**Realistic weight.** The Azure page is about 1.1 kB a shape (31.9 MB for 28,709 shapes). A text created through the MCP has no `positionData`, so a generated file is much lighter and would make the N7 and N8 timings look better than they are. The generator's last step opens the file once in the workspace so that the texts are laid out, and every timing is reported with its bytes per shape.

**Sizes.** One page each:

| File | Screens | Shapes on the page | Purpose |
|---|---|---|---|
| `kiosk-journeys-12` | 12 | about 1,700 | Unit and command tests |
| `kiosk-journeys-207` | 207 | about 28,700 | Matches the Azure page; every budget is measured here |
| `kiosk-journeys-xl` | about 830 | about 115,000 | Four times the size |
| `kiosk-journeys-cliff` | about 1,500 | above 200,000 | The backend page cache holds 200,000 shapes; above that a page is never cached. This file shows what happens past that line |

**The manifest.** `kiosk-journeys-*.truth.json` lists what the generator drew: the screens and their sections, the blank and instance-only boards, the copy groups, every connector with its true direction and the two screens it joins, the flipped shapes with their expected matrices, the scroll frames, the off-board and clipped controls, and the fonts. Tests compare tool replies with it.

**Two backends.** The page, root, walk and font-usage caches are each held by one backend process. The Azure deployment may run several. The phase 5 timings and every "on any replica" check run against two dev backends behind a round-robin proxy.

**What this cannot prove.** The generator draws what the v2 file describes, not what the designers drew. A rule tuned here (the `instance-only-board` line, the arrow direction test) is a guard against regressions. It is proved on real data only by the Azure re-run at the end.

## Facts we will not get

The session that ran the re-test holds sensitive data in Penpot and in Azure and cannot disclose anything from it: no files, no structure, no numbers beyond what the v2 file says. So nothing in this plan waits on it. Where revision 2 asked a question, the package now covers every plausible answer:

| Question | How the plan copes without the answer |
|---|---|
| Replica count and per-call times | Every timing runs on one backend and on two behind a proxy. Budgets are met locally with realistic bytes per shape, then checked on Azure by the other session |
| Structure of the flagged boot boards (N4b) | Three fixtures, one per plausible structure: a single template instance that holds header and content, a board whose header is hidden, and a wrapper frame. The rule must be right on all three and on the blanks |
| Depth of the six screens (N5) | Both causes are fixed: the depth range grows, and boards dropped for being small are reported |
| The team font's family string (N3) | The match handles a weight or style word in the family name, which is the reported case, and is tested on a list of real-world naming patterns |
| Whether the client sends a progress token (item 4) | The heartbeat is built. The contract says that a client must send a token to see it |
| How the other navigation links are drawn (N6) | Not knowable here. The package fixes direction and noise, widens the candidate scan to the arrow styles the kiosk files draw, and says in the write-up that recall on the real page is for the re-run to measure |

The handover to the other session is the finished branch plus the write-up. Its re-run of the v2 scripts is the final proof.

## Phase 0. Fixtures, measurements and three spikes

Nothing is fixed in this phase. It builds what the later phases test against, and settles three designs before any brief is written.

- **Generator (Medium).** A script in `mcp/packages/loadtest/scripts/` builds the kiosk files in chunks and writes their manifests. It is deterministic: the same seed gives the same file.
- **Baselines.** On the 207-screen file, time the whole-page refusal, a `rootIds` call with 20 roots, a full `export_subtree` walk, `lint_page`, `find_similar_boards` and `find_connectors`, on one backend and on two.
- **Spike 1, the N7 profile.** Timers around each backend call of a `rootIds` load and of a whole-page refusal: access check, file load, page cache hit or miss, tree walk, encode. The review found one cost already: every `get-mcp-page-tree` window recomputes the page's preorder over the whole subtree and encodes nodes for its size budget (`mcp.clj` around line 870), uncached.
- **Spike 2, the N8 fetch path.** A written decision on how an MCP client fetches a large export (see N8).
- **Spike 3, the `replace_font` design note.** See N3c.

Done when: the files load, each v2 problem reproduces on the 207-screen file and matches its manifest entry, the baseline table is filled, and the three spikes have a reviewed result.

## Phase 1. Wrong answers in the data (N1, N2, N4c)

### N1. `worldMatrix` of flipped groups

- **Cause, confirmed.** `get-walk-shape` in `backend/src/app/rpc/commands/mcp_subtree.clj` sets `:world-matrix` from `gsh/transform-matrix`, which reads the shape's `:transform`. An imported flipped group keeps an identity `:transform` while its `:points` are mirrored.
- **Change.** `worldMatrix` becomes the affine map that takes the corners of `selrect` onto `points`, in order. Penpot already has this: `transform-points-matrix` and `calculate-transform` in `common/src/app/common/geom/shapes/transforms.cljc` derive a transform from points 0, 1 and 3, and return nil for a box with no width or height, which is where the old value stays as the fallback. The point order is one Penpot's own transform code relies on for every shape type.
- **Docs.** Four places define `worldMatrix` as translate, transform, translate and must change: `api_topics.yml`, `backend_instructions.md`, the contract and the description in `ExportSubtreeTool.ts`. They must also say that for such a group `worldMatrix` differs from the stored `transform`.
- **Tests.** The existing helper `same-points?` in `rpc_mcp_subtree_test.clj` compares point sets in any order, so a mirrored group with an identity matrix passes it today. Every `worldMatrix` test compares points in order. Cases: plain, rotated, flipped-x, flipped-y and doubly flipped shapes and groups, a zero-height line, and a child placed under a flipped group through `W_parent⁻¹ · W_child`. A property test over random boxes, rotations and flips.
- **Done when.** On Azure all 26,097 shapes satisfy the rule (today 26,077).
- **Outcome:** `update_shape` also refuses `flipX`, `flipY` and `pageId` in props, and create operations refuse `rotation` in props, in both the adapter and the backend. This can break old scripts.

### N2. `circle` and `ellipse`

- **Cause.** By design: `BackendShapeTypes.ts` shows `circle` as `ellipse` in every read tool, filter and create path. The `export_subtree` description already says so. The Geometry topic and the contract do not.
- **Change.** Keep the name. Add a short table "Names that differ from the stored file" to the Geometry topic and the contract. The N8 download must apply the same mapping.
- **Tests.** The API docs test asserts that the topic names the mapping.

### N4c. Tolerance for `off-board-control`

- **Cause, confirmed.** `get-control-finding` in `mcp_lint.clj` fires on any positive overflow.
- **Change.** A `tolerance` parameter in pixels, default 0.5, range 0 to 100. An overflow at or below it is no finding. The clip test works on a share of the area, not on pixels, so for it the control's box is shrunk by the tolerance on each side before the share is computed.
- **Tests.** Overflows of 0.00005, 0.5, 0.51 and 81 px; a control cut by 0.3 px is not `clipped-control`; tolerance 0 restores today's behaviour.

## Phase 2. Finding the real boards (N4a, N5, N4b, 9c-a)

### N4a. One board selection for `lint_page`, `find_similar_boards` and `find_connectors`

- **Cause, confirmed.** Both lint commands default to `depth` 1 and accept at most 5.
- **Change.**
  - One shared selection function for the three commands.
  - `depth` accepts 1 to 12.
  - A `mode` parameter: `depth` (today's behaviour) or `auto`. With no `depth`, no `boardNameRegex` and no `mode`, the mode is `auto`.
  - **Auto selection, with guards.** "The most common frame size" alone picks list rows and buttons, which outnumber screens. So: among frames outside component instances, take the sizes that occur at least three times, allow a tolerance of a few pixels and a taller height for scrolling screens, drop sizes whose area is small against the largest candidate, and choose the largest of what is left. When a chosen frame holds a same-sized frame, the outer one is the screen. When no size qualifies, fall back to depth 1.
  - Every reply states what was selected: `selection: {mode, depth, size, boards}` and `deeperBoards`, the number of frames below the selected ones.
- **Fallback.** If the guards cannot be made sound on the row-heavy and mixed-size fixtures, the default stays depth 1 and the reply gives `deeperBoards` and a suggested call. The package reports which way it went.
- **Existing tests.** The backend lint tests use depth 1 in 15 places. Small fixtures fall back to depth 1, so they should hold; any that move are reported, not rewritten in silence.
- **Tests.** Fixture layouts: flat boards, the journeys nesting, row-heavy screens, mixed mobile and desktop sizes, no repeated size, screens of unequal height, a wrapper of the same size. The three commands return the same board ids for the same arguments.
- **Done when.** On Azure the default call reaches the screens in all three tools.
- **Outcome:** `auto` was built and is the default; the depth 1 fallback applies only when the size rules select nothing (`basis` `depth-fallback`). Two rules were added to the selection: a wrapper rule (a frame class at most a quarter taller than an exact standard screen, holding one such screen in more than half of its frames, is a wrapper) and a same-size chain rule (of nested frames of one size, the one matching `boardNameRegex`, else the one named like the unwrapped boards, else the outermost). The reply reports `basis`, `selection` and `otherSizes`. `lint_page` and `find_connectors` also page by offset, so a cut list can continue.

### N5. `find_similar_boards` compared 201 of 207 screens

- **Cause, revised.** Revision 1 blamed the depth limit. The numbers point elsewhere: `lint_page` at depth 5 reached 208 boards, the v2 file reports 7 truly empty screens, and 208 less 7 is 201. `find_similar_boards` drops a board with fewer than `minShapes` visible shapes (default 3). The other session cannot confirm it, so both causes are fixed.
- **Change.** The reply reports `skippedSmall`, the boards left out for being below `minShapes`, with their ids up to a limit. The depth range grows with N4a in any case.
- **Budget.** Not "207 of 207": an empty screen is not a copy of anything. The target is that every screen is either compared or listed in `skippedSmall`.

### N4b. `instance-only-board` false positives

- **Cause, not yet known.** The rule fires only when a board has exactly one visible child and that child is a component instance (`get-board-findings`, `mcp_lint.clj`). The v2 file describes the boot screens as "a header plus one boot component", which is two children and would not be flagged. So the 17 flagged boards have some other structure: one template instance that holds header and content, a hidden header, or a wrapper.
- **No data to settle it.** The other session cannot describe the boards. So the fixtures draw the three plausible structures, and the rule must be right on all of them.
- **Change.** A full-size template instance cannot be told from a header-only template by how much of the board it covers. The rule looks inside the single instance: it reports the board only when the instance has no visible content outside its header band, where the header is the instance of the component that the most boards on the page share. A board with a hidden second child is judged the same way, on what is visible.
- **Tests.** The three structures as fixtures: none of the content boards and all of the blanks are reported.
- **Outcome:** Chrome is found from component statistics: a component at the same edge on 70 % of the screens, not "the component that the most boards share".

### 9c-a. Suggest `overflowScroll`

- **Change.** A new lint rule `scroll-candidate`: a clipping frame whose visible content runs past its edge by at least `minOverflow` pixels (default 8) on an axis, and that has no `overflowScroll`. The finding gives the axis, the overflow and the suggested value. A frame inside a component copy is reported with a flag, because writing to it would create an override; the main is the place to set it. The contract shows the one `apply_operations` call that sets the value on all reported frames.
- **Default set.** The rule joins the default rules, which adds a key to `counts` in every reply. Tests that assert exact counts are updated in the same package.
- **Done when.** On Azure the rule reports the scroll lists the generator guesses today, and after one write `scroll-hidden-control` finds the hidden rows.

## Phase 3. Fonts (N3, N3b, N3c)

### N3. Suggest a team font

- **Cause, confirmed.** `get-font-reason` in `backend/src/app/rpc/mcp_fonts.clj` reports why a font does not resolve and stops there. The team's fonts are already in the font context.
- **Change.** For a font that does not resolve, look for a team font, then a builtin and a Google font, with the same family. The match lower-cases both names, strips spaces and hyphens, and strips weight and style words (thin to black, regular, italic, oblique), because an uploaded single-weight font often carries its weight in its family name: the team font in the v2 file is "Access Sans Bold". An exact match ranks above a match on the stem. The reply gives `suggestedFontId`, `suggestedFamily`, its variants, and whether the weight and style in use exist there. The outline warning carries the same suggestion.
- **Outcome:** The outline warning carries the suggested font id and family only; `list_fonts` carries the full suggestion.
- **Tests.** "Access Sans" against "Access Sans Bold"; exact match; case and spacing; the weight in use missing from the suggestion (runs at 400, team font 700 only); two candidates; none.

### N3b. Font warnings that a client can finish

- **Cause, corrected.** The outline never scans a page above 5,000 shapes itself (`mcp_fonts.clj`). Only `get-mcp-fonts` on a whole file fills the usage cache, in one process, for ten minutes. So a repeated outline never becomes complete, on any number of replicas, and nothing tells the client what to do.
- **Change, in two steps.**
  - **Step 1, the contract.** The outline lists the pages it did not cover as `warningsPendingPages` and says in one field that `list_fonts {fileId}` completes them. This alone answers the v2 complaint.
  - **Step 2, optional.** Share the page usage between replicas through Redis, following the pattern the code base already has for the library summary (`rpc/commands/files.clj`): behind the `:redis-cache` flag, tenant in the key, transit encoding, and the in-process cache as the fallback. Both key forms the code uses today, pointer id and revision, are safe to share. Step 2 is built only if the two-backend check shows that step 1 leaves a client looping.
- **Tests.** Unit tests with a fake cache; the two-backend check: outline, `list_fonts`, outline again.
- **Outcome:** Step 1 only. The shared cache was not built, by decision. The two-backend check passed.

### N3c. Font swap in one call (`replace_font`)

This is a write across a whole page and the package most able to damage data in silence. It starts with a design note (spike 3), reviewed before the brief.

The note must settle:

- **Which runs.** Today `set_text_style` merges attributes onto every leaf (`common/src/app/common/mcp/operations/text.cljc`). A swap needs a filter on `font-id`, applied at root, paragraph and leaf level.
- **What changes.** `font-id`, `font-family` and `font-variant-id`, with weight and style kept.
- **Variant ids.** The existing helper gives non-bundled fonts ids such as `"700"`, while team fonts are reported as `normal-700`. A swap to a team font must write an id that the font report and the workspace both recognise.
- **Layout.** `set-text-content` drops `position-data`. A page-wide swap would strip the layout from every changed text: a generator loses its text placement, and an svg export of those shapes then fails with the exporter timeout this branch already documents. The choice is between rewriting the font fields inside `position-data` (old metrics, but present) and dropping it with a clear statement that the file must be opened in the workspace. The reply reports how many texts lost their layout.
- **Component copies.** Writing to the copies of a shared component marks an override on each one and cuts their text off from the main. The operation needs a mode that changes the mains in the file and reports the copies, and a report, not a write, when the main lives in another library.
- **Typographies and tokens.** A run tied to a typography, or to a font-family token, would be reverted by the next sync. The choice per case: change the typography, detach, or report and skip.
- **Adapter.** `OperationSchemas.ts`, the sample operations and the topic documents.

- **Tests.** Mixed-run texts, each copy mode, a main in another library, typography and token cases, a missing variant, dry run, the layout count.
- **Done when.** On Azure one call gives the Kiosk text the real Access Sans, `list_fonts` reports nothing unresolved, and the png and svg exports of that screen still work.
- **Outcome:** `replace_font` has no copy mode. It writes the mains, and reports and skips component copies; adding `sync_components` to the same call carries the change. It drops the stored text layout of changed texts. It was not checked live on component copies; backend tests cover them.

## Phase 4. Connectors (N6)

- **Cause, confirmed in part.** `find-connector` in `mcp_prototype.clj` treats every visible frame as a board, so a divider between two nested frames of one screen counts. `outline-head` names as the head the end whose band is wider. Why the tool finds 54 connectors against 511 links in the reviewed map is not known and cannot be learned here.
- **Change.**
  - **Screens.** The command uses the board selection of phase 2. A connector whose two ends lie in the same screen is dropped and counted in `sameScreenSkipped`; `includeSameScreen: true` returns them, flagged. An end on a frame that is not a screen (a decision frame) is flagged `nonScreen`.
  - **Direction.** Three things the first design got wrong. Curves must be flattened first: the path helper returns segment end points only, so a round dot made of four curves is four points. The outline must be sliced along its centre line, not across the chord between its ends, or a curved shaft measures its sag. And a round tail dot also rises and falls, so the head is defined as a sudden widening at the shaft followed by a near-straight taper to the tip, and a dot as an even bulge. Two heads give `both`. The reply keeps `direction` and adds `confidence`.
  - **Recall.** The candidate scan is checked against every arrow style of the kiosk files, and widened where it misses one. Recall on the real page is for the re-run to measure.
- **Tests.** Synthetic arrows: triangle head, swept barbs, round tail dot, two heads, curved shaft, a plain bar; every connector of the manifest.
- **Done when.** On Azure the same-screen items are gone from the default reply, and the connectors that match the navigation map point the right way.
- **Outcome:** Direction is read from the arrow head only. When no head can be read it is `none`; there is no guess from line width. A shaft split into several shapes, a rounded tip whose radius is half the width and a flat rhombus head read as `none` or `both`.

## Phase 5. Speed (N7, N8, item 4)

### N7. `rootIds` load and whole-page refusal

- **Cause, confirmed in part.** `SandboxHost.loadPartial` makes about 20 tree calls (one per root), then about 13 shape batches of 200, then one call per ancestor level, all in sequence. Each tree window recomputes the page's preorder. The page caches are per process, so each replica decodes the page cold. The rate limit is not the cause.
- **Change.**
  - **Load.** Revision 1 proposed the subtree walk. That would change what scripts see: the walk returns `content`, `positionData`, `worldMatrix`, `depth` and `index`, uses stored order where the tree uses visual order for layouts, and grows the payload against the 16 MB cap. The simpler path keeps the model: `get-mcp-shapes` with `include-children` already returns a root with its descendants through the same shape form, up to 2,000 shapes. Call it per root, three or four at a time, and fetch again the children a truncated reply left out. The tree calls go away; ancestor stubs and `partialChildren` stay as they are.
  - **Refusal.** A shape count alone cannot refuse this page: 28,709 shapes at a safe floor of 250 bytes is 7 MB, under the cap, and a floor high enough to refuse it would refuse pages of small shapes that fit. The backend returns a byte estimate with the count, from an encoding of about 100 sampled shapes, and the adapter refuses on that before any load.
  - **Backend.** Fix the per-window preorder cost that the profile confirms, since it taxes every tree read.
- **Tests.** The existing `rootIds` tests stay green unchanged. New tests for the load path with a truncated reply, for the estimate, and a timing test on the 207-screen file with one and with two backends.
- **Outcome:** The refusal estimates size from a sample and refuses above 1.3 times the cap; the loader stops a partial load once the bytes read pass the cap.
- **Budget.** 20 roots in 5 s or less on Azure. The refusal in under 1 s on a warm replica; the cold figure is measured and stated.

### N8. A whole subtree in few calls

- **What revision 1 got wrong.** It copied `export-binfile` and returned an asset URL. An MCP client cannot fetch that URL: `/assets/by-id` needs a session or an access token, the temp bucket is scoped to its owner (`backend/src/app/http/assets.clj`), and an MCP token is honoured only on RPC routes. In multi-user mode the agent often never sees its token at all. `export-binfile` is also the weak template: it stores no owner, so its objects fall into a legacy branch that any signed-in user with the id can read.
- **Spike 2 decides the fetch path** before any brief. The options:
  - **A capability URL.** An unguessable id, a life of 15 minutes or less, bound to the profile and the token, a cap on size and on how many a profile may hold. Any HTTP client can fetch it. This is a new kind of access and needs the closest review.
  - **An RPC that streams the object** to a caller with the MCP token. Safer, but it helps only a client that can send the token.
  - **Larger windows.** Raise the reply cap for this tool, or let the adapter write gzipped windows. The smallest change, and the smallest gain.
- **Whatever the path:** the object records its owner, as the exporter and font code do; the export has its own concurrency limit class; the type and key mapping (`ellipse`, camelCase) lives in one shared place so the download equals the windowed walk; and the export is a job with start, poll and fetch, because one request that walks and gzips 26,000 shapes, or 115,000, runs into the backend's request timeout of about 55 s. On S3 a presigned redirect lives a day, which the life of the object must allow for.
- **Tests.** The download equals the windowed walk shape for shape; the caps; expiry; a file changed during the write; a fetch by another profile, by another team's token and with no credentials.
- **Budget.** The 26,097 shapes of the 207 screens in 60 s or less, in a handful of calls (today 784 calls, 12.7 min).
- **Outcome:** Option A, larger windows. One tool call reads up to 24 backend windows, up to a cap set by `PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB`; `compact` drops default attributes and `encoding: "gzip-base64"` packs the reply. There is no download URL, no job and no new access path. Under the default cap a model client still needs hundreds of calls for a 28,000-shape page.

### Item 4. Silence during a batch export

- **What revision 1 got wrong.** Progress events already exist: `PenpotMcpServer.progressReporterOf` sends them when a request carries a progress token, `export_shape` reports each shape and `export_subtree` each window. The silence has one of two causes: the client sends no token, or one exporter chunk is a single request and nothing can be sent until it returns.
- **Change.** A heartbeat during a chunk: a progress notification every 5 s that says which chunk of how many is rendering. If the client sends no token, no server change helps, and the contract says so in the `export_shape` section.
- **Tests.** A fake client with and without a token; the heartbeat stops when the chunk returns.

## Phase 6. Penpot interface (7, 9c-b)

- **Missing-font badge (Small).** A warning icon on a text layer in the layers panel when the text uses a font that is not installed, with the family name as its title. It uses `app.main.data.fonts-missing`, memoised per shape. Unit tests and a browser check.
- **UI notices re-test.** A browser check of the text-options notice and the export-dialog warning, which the re-test skipped.
- **Viewer scrolling (Large).** A design note first: how a scrolling board sits with "Fix when scrolling", with boards taller than the viewport, and with overlays. The reviewer's advice is to raise this upstream before building it on this branch. The note is written here; building waits for the user's decision.

## Phase 7. Conditional interactions (3c): proposal only

This is a product feature: the file data model, the viewer, the workspace editor, the plugin API and the MCP operations all move. The plan writes a proposal and stops: prototype variables per file, a condition on an interaction, the smallest useful slice (a boolean variable, set-variable, navigate-if), the migration, and how the journeys' "is…?" frames map onto it. The user decides whether to build the slice, raise it upstream, or leave it. Until then the guidance of the first run holds: one flow per flag setting.

## Testing

Every work package ships with tests at each level that applies. The lead runs the suites itself; an agent's report of a pass is not the gate.

| Level | What | Where |
|---|---|---|
| Unit | Pure functions: matrix, selection, lint rules, font matching, outline profile, font swap | `backend/test/backend_tests/rpc_mcp_*`, `common/test/common_tests/mcp/` |
| Property | The `worldMatrix` rule, points in order; the three commands select the same boards | same |
| Manifest | Tool replies against the truth file of each kiosk file | loadtest scripts, dev stack |
| Command | Each backend command through its RPC, with limits, scopes and budgets | backend tests |
| Adapter | Tool schemas and descriptions for every new parameter, mapping, errors, multi-user refusals, heartbeat | `mcp/packages/server/src/**/*.test.ts`, with Redis on port 6390 |
| Sandbox | The existing `rootIds` tests unchanged; the new load path | adapter tests |
| Frontend | Badge | `frontend/test`, one compile at a time |
| Suites | Backend whole suite (49 known failures of this machine), common, frontend, adapter, cljfmt, clj-kondo, prettier, `tsc` | toolchain container |
| Live | Each tool on the kiosk files and the 100,000-shape file | adapter 4405 |
| Two backends | Phase 5 timings and the font-warning check behind a round-robin proxy | dev stack |
| Security | The N8 fetch path: other profile, other team, no credentials, expiry, caps | backend tests, live |
| Speed | The budgets below, on an idle machine, three runs each, with bytes per shape | dev stack, then Azure |
| Browser | Notices and badge on a frontend built from the branch | port 9003 |
| Regression | The live checks of the first round, re-run unchanged | scratch scripts |
| Azure | The v2 re-test, same scripts, same page | other session |

### Budgets

| Measure | v2 on Azure | Target | Result (2026-11-11) |
|---|---|---|---|
| Whole-page refusal of `execute_code` | 14.6 s | under 1 s warm; cold figure stated | 0.54 s warm; 4.9 s cold |
| `rootIds` call, 20 roots | 22 to 30 s | 5 s or less | 2.0 s |
| 207 screens through `rootIds` | 5.6 min | 1 min or less | 22.8 s |
| 207 screens through `export_subtree` | 784 calls, 12.7 min | a handful of calls, 60 s or less | 6 calls, 10.6 s |
| `lint_page`, default call | reaches 12 boards | reaches the screens | reaches the 207 screens |
| `find_similar_boards` | 201 of 207 screens | every screen compared or listed in `skippedSmall` | 200 compared, 7 in `skippedSmall` |
| `instance-only-board` | 17 false positives | 0, with all blanks still found | 0; all 23 blanks found |
| Screen-to-screen connectors that match the map, direction right | 4 of 10 | 10 of 10 | 193 of 193 synthetic; real map for the re-run |
| Same-screen connectors in the default reply | 35 | 0 | 0 |
| Shapes whose `worldMatrix` maps `selrect` onto `points`, in order | 26,077 of 26,097 | all | 60 of 60; 240 of 240 on xl |
| Font warnings | a client cannot finish them | pending pages named; complete after `list_fonts` | met |
| Silence during a 40-shape export | about 27 s | a notification at least every 5 s, when the client sends a token | longest gap 3.7 s |

The Timings subsection of the Resolution gives the detail.

## Review

- **Chunk 1, after phases 1 and 2.** Matrix, lint and selection code, their tests, the adapter tools and the documents. This chunk changes default behaviour, so its reviewer reads the v2 text beside the briefs.
- **Chunk 2, `replace_font` alone.** It writes data across a page: copies, tokens, typographies, layout.
- **Chunk 3, the rest of phases 3 and 4.** Font suggestion, pending pages, the optional Redis cache, connectors.
- **Chunk 4, after phase 5.** The load path, the export job and its fetch path, the heartbeat. The security review of N8 is part of it.
- **Chunk 5, after phase 6.** The frontend changes.
- **Final pass.** A reviewer that saw none of the above goes through this plan and the v2 file item by item, as a checklist, against the branch diff. It reads in full only the risky files: the export fetch path, the sandbox loader and the text operation.

Each chunk review answers: is it correct, does it match the brief, do the tests test behaviour, what case has no test, and what would break on a file ten times larger.

## Order and dependencies

1. Phase 0 first, with its three spikes.
2. Phase 1 can run beside phase 0.
3. Phase 2 before phase 4: connectors use the board selection.
4. Phase 3: N3 and N3b beside phase 2. N3c after its design note.
5. Phase 5 after the profile and the fetch-path decision.
6. Phase 6 runs alone, because it needs the frontend compile.
7. Phase 7's proposal can be written at any time.

At most three Sonnet agents work at once, and never two on the same file.

**Most likely to go wrong:** N8 (a new way to reach data), then N3c (silent damage across a page), then the auto selection of N4a (a changed default).

## What the review changed

| # | Revision 1 | Revision 2 |
|---|---|---|
| 1 | N8 returned an asset URL like `export-binfile` | No MCP client can fetch that URL. The fetch path is a spike with three options; the export is a job; the object records its owner |
| 2 | N4b tuned a coverage line on "a header plus one instance" | The rule cannot fire on two children, so that fixture tested nothing. Blocked on the real structure |
| 3 | N5 blamed the depth limit | The numbers match the `minShapes` filter. Report `skippedSmall`; no 207 of 207 target |
| 4 | N3c was Small | Medium to large, with a design note: per-run filter, variant ids, layout loss, copies, typographies, tokens |
| 5 | N3 matched lower-cased family names | That misses "Access Sans Bold". Weight and style words are stripped |
| 6 | Progress events were to be added | They exist. The work is a heartbeat, and a question about the client's token |
| 7 | N7 loaded roots through the subtree walk and refused on a shape count | The walk changes what scripts see; `get-mcp-shapes` with `include-children` does not. A count cannot refuse this page; a sampled byte estimate can |
| 8 | N1 fitted a new matrix | Reuse `calculate-transform`. The test helper ignored point order. The generator cannot make the fault through `apply_operations` |
| 9 | N4a chose "the most common frame size" | That picks rows and buttons. Guards, a `mode` parameter and a stated fallback |
| 10 | N6 used a width profile across the chord | Flatten curves, slice along the centre line, tell a dot from a head. Recall is now a question |
| 11 | N3b put usage in Redis | The contract change answers the complaint. Redis is optional and follows the existing flag pattern |
| 12 | One backend, light shapes | Two backends, laid-out text, bytes per shape with every timing, a file past the 200,000-shape cache line |
| 13 | Four review chunks | Five, with `replace_font` alone, and a checklist final pass |

## Open decisions for the user

1. **N2.** Keep `ellipse` everywhere and document it. Planned, and the reviewer agrees: every read tool, filter and create path already uses the name. **Decided:** kept and documented.
2. **N4a.** Auto selection as the default, with guards and a `mode` parameter, falling back to depth 1 plus `deeperBoards` if the guards do not hold. Planned, and the reviewer agrees. **Decided:** `auto` is the default, with the wrapper and same-size chain rules.
3. **Viewer scrolling and 3c.** The reviewer advises raising both upstream first. Planned: a design note and a proposal here, no code until you decide.
4. **N8 fetch path.** A capability URL, a token-bound streaming RPC, or only larger windows. Spike 2 gives the evidence. The lead builds the option that opens no new way to reach data unless you choose otherwise, and flags the choice in the write-up. **Decided:** option A, larger windows.

## Done

The plan is done when every row of the first table is fixed or has a recorded decision, every budget is met or its miss is explained with numbers, the five chunk reviews and the final pass have no open finding, and the Azure session's re-run of the v2 scripts reports the scorecard with no new problem of the kinds found here. The result is written up as a Resolution section in the v2 file.

Status:

- [x] N1, N2, N3, N3b (step 1), N3c, N4, N5, N6, N7, N8 (option A), item 4 and the font badge are built, and reviewed in six chunks plus a final pass (the plan said five).
- [x] Live checks on the synthetic kiosk files.
- [x] 3c and viewer scrolling: proposals written.
- [x] Timings against the budgets, on an idle machine.
- [x] Full backend, common and adapter suites.
- [x] Two-backend check.
- [x] Browser check of the layers-panel badge and the text-options notice (the export-dialog warning was not checked again).
- [ ] The Azure re-run of the v2 scripts.
