# Avalonia test run: improvements for the backend MCP and Penpot

This run built a pixel-exact Avalonia app (207 screens) from the Penpot page "Journeys - (800x600) - MEDIUM - VARS - Kiosk / Keyper / Dark". We treated it as a real-world test of the backend-only MCP (`33cb17b0d2`) and of Penpot. Each item says what happened, what it cost, and what would fix it. The app, its plan (`docs/kiosk-avalonia-plan.md`) and its reports live in the `kam-platform-poc` repo, under `avalonia-ui/`.

Status: **complete** (2026-11-10). The app is built, and it passed independent verification except for the real-window check, which waits until the Windows session is unlocked. See `avalonia-ui/design/report/verification.md` in `kam-platform-poc`. The findings were resolved on 2026-11-10, and the "Resolution" section at the end says how.

## Summary

**What worked well.**
- Penpot's data is complete and exact enough to rebuild 207 screens with 0 layout failures on 15,518 shapes and 3,026 text fragments, and a median pixel mismatch of 0.3%. Every value came from the file, and none from a screenshot.
- The backend MCP was fine for small reads and for discovery: outline, page trees and whoami. The binfile export was the right bulk path.
- `apply_operations` already has interaction and flow operations.

**What cost the most.**

| Item | Cost | Priority |
|---|---|---|
| 3. No prototype links in the source, and no bulk interaction read | 4 agents, 14 lead rules and 5 patches to rebuild navigation, with 258 controls unresolved at first | High |
| 1, 2. No subtree load or export through the MCP | Fell back to the binfile and parsed 28,700 files offline | High |
| 5. Undocumented geometry semantics (text baseline, textLength stretch, gradient units) | 4 generator iterations. Every gradient rendered flat until we read `gradients.cljs` | High |
| 9c. No scroll or overflow property on frames | Overflowing list rows unreachable until a heuristic was added | Medium |
| 6, 7. Missing fonts fall back silently | One screen renders "Customer Brand" in Liberation Serif, even in Penpot's own export | Medium |
| 4. Serial, slow exporter renders | 38 minutes for 207 references | Medium |
| 9, 9b. No lint for empty boards, copied boards or invisible controls | Found only by looking at renders, plus 2 lead patches | Low |
| 11. The exporter's SVG renderer ignores per-side strokes | References differ from the workspace's WASM renderer on 567 strokes | Low |

**Suggested first steps for the MCP** (smallest change, biggest gain):
1. A `rootId` option on `execute_code`.
2. An `export_subtree` tool that returns full attributes.
3. Documentation of `positionData`, `points` and gradient units in `penpot_api_info`.
4. `get_interactions` per page.

## Backend MCP

### 1. `execute_code` can't load a large page, and there is no subtree mode

- **What happened.** We ran a read-only inventory script on the Tablet and Kiosk pages, each 28,600 shapes and about 31.6 MB. It was refused: "execute_code loads a whole page; use apply_operations and get_shapes/find_shapes for a page this large, or raise PENPOT_MCP_SANDBOX_PAGE_MB".
- **Cost.** We fell back to a binfile export and parsed 28,700 shape JSON files offline.
- **Fix.**
  - Let `execute_code` take a `rootId` (or a list) and load only those subtrees. Most scripts only need one board.
  - Failing that, load a page lazily (shapes on first access).
  - Make the error message say how big the page is against the limit, and suggest `rootId`.

### 2. No bulk "give me this board as data" tool

- **What happened.** `get_page_tree` truncates (`truncated`, `nextCursor`) and returns only ids, names, types and boxes. `get_shapes` is capped at 200 ids per call. The 207 screens hold 26,011 shapes, with full attributes needed (fills, strokes, `points`, path `content`, text `positionData`).
- **Cost.** The MCP couldn't feed the generator, so we used `export-binfile` and a zip parser.
- **Fix.** Add `export_subtree` (shape id → every attribute of the subtree as one JSON document, streamed or chunked), or a `format: "full"` option on `get_page_tree`. The binfile layout, one JSON per shape, is already right: expose it per subtree.

### 3. Prototype interactions can't be read or written in bulk, and the source had none

- **What happened.** The page has 0 interactions and 0 flows. The original Figma file has no `prototypeInteractions` either. Navigation is drawn as flattened arrows (filled outlines, no connector data) and as "is…?" decision frames.
- **Cost.** Four agents had to reconstruct navigation from labels, screen order, arrow geometry and annotations. That left more than 200 controls unresolved for a lead pass.
- **What the MCP already has.** `apply_operations` already has `add_interaction`, `remove_interaction`, `create_flow` and `remove_flow`. The reviewed navigation map (`design/nav/*.json`: 457 screen hotspots, 45 global, conditional branches) could be written back as real prototype links. Penpot interactions have no conditions, so the flag branches would become one flow per flag setting.
- **What's missing.**
  - A bulk read of a page's interactions and flows. Today it takes `get_shapes` over every shape.
  - A tool that returns a page's connector-like paths, with their end points snapped to the nearest boards. We computed this by hand.
  - Conditional or variable-driven interactions, which Figma has as prototype variables. The journeys' "is…?" decision frames are exactly that, drawn by hand.

### 4. Batch rendering of many boards is slow and serial

- **What happened.** Rendering 207 nested `Parent` boards through the exporter took about 6 to 7 s each, run serially (about 38 minutes), with retries for HTTP 500s.
- **Fix.** `export_shape` with a list of ids, which the exporter renders in one browser session. Thumbnails cached by revn. Progress events.

### 5. Text geometry semantics aren't documented

- **What happened.** Exact text placement needs `positionData`: its `y` is the ideographic baseline, which is the descent line, and Penpot's SVG renderer stretches each run to `width` with `textLength` and `lengthAdjust="spacingAndGlyphs"`. We found this by reading `svg_text.cljs`.
- **Fix.** Document `positionData`, `points`, `transform` and path `content` (page space, already transformed) in `penpot_api_info` and the backend instructions. These are the facts every code generator needs.
- **Gradients have the same problem.** `fillColorGradient.startX..endY` are SVG `objectBoundingBox` units. On a non-square box the gradient is skewed with the box, and paths get extra transform handling (`gradients.cljs`). Our first generator read the points the toolkit's way, and all 468 gradients rendered flat. The pixel check missed it, because pixelmatch at threshold 0.1 tolerates dark colour shifts. Document the gradient coordinate space too.

### 6. No font report or font download

- **What happened.** The page uses the font id `gfont-access-sans`, but that font isn't in Google Fonts. The exporter's Chromium silently fell back to Liberation Serif Bold, so the "Customer Brand" text renders in a serif in Penpot's own export. Nothing warned.
- **Fix.**
  - A `list_fonts` tool: families, weights and run counts per page; whether each one resolves (Google, team font, or missing); and download URLs for its TTFs or WOFF2s.
  - A warning in `get_file_outline` when a used font can't be resolved.

## Penpot

### 7. Missing fonts render silently with a fallback

See item 6. Penpot should show a "missing font" badge in the workspace and a warning in export results.

### 8. No native-code export of resolved geometry

- **What happened.** Penpot's code generation targets HTML and CSS. A non-web target (Avalonia XAML) needs every shape's resolved box, its world matrix and its paint. We built that generator ourselves: 26k shapes, absolute layout from resolved boxes.
- **Fix.** A documented "resolved geometry" export: per shape, its world matrix, box, fills, strokes (with alignment) and text fragments. A generator for any UI toolkit could then use it.

### 9. Empty placeholder boards aren't easy to find

- **What happened.** 8 Admin Actions screens and 16 Misc screens are a header with nothing else. The nav agents only found this by looking at renders.
- **Fix.** A lint, in the MCP or the workspace, that flags boards which are only an instance of a shared header, or have fewer than N visible shapes.

### 9b. Copied screens and invisible controls

- **What happened.** Journeys copy the same screen into several sections. "Main Menu Admin" appears 6 times, and the logging flow 3 times: in the Logging section, and inside the isLogging frames of both Check Out and Check In. The nav agents mapped the routing on one copy, so the canonical menu sent Return the wrong way until a lead patch copied the routing across.
- **Controls the user can't see.** Two mapped controls aren't visible as drawn. A Select button sits 81 px off the screen's right edge, and a settings row is clipped by its own frame.
- **Fix.**
  - A `find_similar_boards` tool, matching boards by component structure and text, so copies can be linked or flagged.
  - A lint for controls (component instances with a label) that are clipped away or lie outside their board.

### 9c. Penpot doesn't record which frames scroll

- **What happened.** Lists are drawn as clipping frames whose content runs past the bottom edge, with a scrollbar drawn as a shape. Penpot keeps only "clip content", so a generator can't tell a scroll list from a plain crop. In the first build, the overflowing rows (for example Settings → Proximity Card Enrollment) were unreachable. The generator now guesses, treating a clipping frame with at least 8 px of vertical overflow as a scroll list.
- **Fix.** Add a frame overflow property (none, vertical, horizontal or both), as Figma's prototype "overflow scrolling" has. Expose it through the MCP, and carry it over in the Figma importer.

### 11. Export and workspace render strokes differently

- **What happened.** 567 strokes in the journeys have per-side widths. The exporter uses the SVG renderer, which ignores them (as `penpot-render-boards.mjs` already notes). The workspace's WASM renderer draws them. Our generator first drew them per side, as the data says, and moved further from the references: non-text drift went from a median of 0.36% to 0.78%. It now follows the exporter.
- **Fix.** Make the exporter render with the same renderer as the workspace, or have the SVG renderer support per-side strokes. Until then, a design looks different in the workspace from its export.

## Agent tooling (not Penpot)

### 10. The advisor tool fails for Haiku subagents

- **What happened.** A Haiku 5.5 subagent that called the advisor tool died with "This model does not support assistant message prefill". It had to be resumed with "don't call the advisor".
- **Fix.** Hide the advisor tool from models that can't use it, or make the error recoverable.

### 12. Lessons for running this with small-model subagents

- **What worked.** Haiku 5.5 subagents did every phase: extract, scaffold, generator, navigation, wiring, verification and docs. They worked well when each had a written brief, a measurable gate, and the rule "report, don't loosen the gate".
- **What the gates missed, and the lead review caught.** Outer strokes rendered as filled discs, subpixel text, every gradient flat, and an unreachable scroll-list row. Each one passed the gate in force at the time. The lesson is to measure more than one thing (pixelmatch, colour drift, layout boxes, a navigation walk), and to have a reviewer look at zoomed side-by-sides, not only the numbers.
- **The independent verifier** (a fresh agent that built nothing) found 7 real defects after the builders reported success.

## Resolution (2026-11-10)

This section records, for each finding, what was done and how it was checked. Live checks ran against the dev backend built from this branch, with the rebuilt adapter, on a small fixture file and on the 100,000-shape test file. The dev exporter and the dev frontend on this machine are the stock 2.18 images, so the browser checks used a frontend built from this branch.

| Item | Status | What exists now | Left open |
|---|---|---|---|
| 1. `execute_code` subtree mode | Done | `rootIds` option on `execute_code` | Lazy loading of a whole page |
| 2. Bulk board export | Done | `export_subtree` tool | Nothing |
| 3. Prototype interactions in bulk | Done in part | `get_interactions` and `find_connectors` tools | Conditional or variable-driven interactions |
| 4. Batch rendering of boards | Done in part | `export_shape` with `shapeIds`, `outputDir`, `renderer` and `refresh` | Progress events; batch path and `renderer: "wasm"` not verified here |
| 5. Geometry semantics documented | Done | "Geometry semantics" section in `penpot_api_info` | Side-by-side check of two renderer differences |
| 6. Font report and warnings | Done | `list_fonts` tool and `warnings` in `get_file_outline` | Nothing |
| 7. Missing font warnings | Done in part | Notices in the text options and the export dialog; font warning in `export_shape` | Badge on the canvas or in the layers panel |
| 8. Resolved geometry export | Done | Per-shape fields in `export_subtree` | Nothing |
| 9. Empty placeholder boards | Done | `lint_page` rules `empty-board` and `instance-only-board` | Nothing |
| 9b. Copied boards and hidden controls | Done | `find_similar_boards` tool and control rules in `lint_page` | Nothing |
| 9c. Frames that scroll | Done in part | `overflowScroll` board attribute | Viewer does not scroll such a board; Figma importer carry-over not done |
| 11. Per-side strokes in the exporter | Done in part | SVG renderer draws per-side stroke widths | Some corner and dash cases; no pixel comparison with wasm |
| 10. Advisor tool with Haiku subagents | Not a Penpot change | Workaround: briefs tell subagents not to call the advisor tool | The fault in the agent harness remains |
| 12. Lessons for subagent work | Applied | Written briefs, several measures per package, independent reviewers | Nothing |

### 1. `execute_code` subtree mode

- **Done.** `execute_code` takes `rootIds` (1 to 20 shape ids) with `pageId`. Only those subtrees load, with a stub for each ancestor. A script sees the roots and their descendants. An ancestor stub has `childrenPartial` set to true. An operation that needs every child of a partly loaded parent (reorder, remove, z-order) is refused, and the message says what to add to `rootIds`. A reference to a shape outside the roots returns `{id, loaded: false}`. The reply carries a `partial-page` warning. The page-size refusal names the page size, the limit and `rootIds`.
- **Checked.** With roots [List], 11 shapes loaded. `bringToFront` and removing an ancestor were refused with the named message. A rename inside the root applied (2 operations, revn 3 to 4). An interaction destination outside the roots came back as `{id, loaded: false}`. An unknown `pageId` was refused.
- **Not done.** Lazy loading of a whole page (shapes on first access). `rootIds` covers the need.

### 2. Bulk board export

- **Done.** The new tool `export_subtree {fileId, pageId, rootId?, cursor?, limit?, filePath?}` uses the new backend command `get-mcp-subtree`. It returns every attribute of each shape in walk order, with `depth`, in windows with a cursor. In local mode, `filePath` writes the whole subtree to one JSON file. Path `content` is an SVG path string. Shapes carry `points`, `selrect`, `transform`, and strokes and fills as stored.
- **Checked.** The fixture page (32 shapes) was written to one file in 168 ms. On the large file, one page of 2,498 shapes came back in 48 windows: 5.3 s in all, worst window 206 ms, 3 MB.

### 3. Prototype interactions in bulk

- **Done.** `get_interactions {fileId, pageId}` returns the flows and every shape that has interactions, with destination names. `find_connectors {fileId, pageId, withinId?}` returns connector-like paths. Both ends snap to the nearest boards. Each path gives its direction (from a stroke cap or from the geometry) and its snap distances. Writing interactions in bulk already worked through `apply_operations` (`add_interaction`, `create_flow`).
- **Checked.** `get_interactions` found 1 flow and 1 navigate interaction, with `destinationName "Home"`, in 124 ms on a 2,498-shape page. `find_connectors` found the arrow from Login to Home, with direction from the cap and snap distances of 5 px.
- **Not done.** Conditional or variable-driven interactions (3c). This is a product feature: a new interaction model, its viewer logic and its editor. Until Penpot has it, write one flow per flag setting.

### 4. Batch rendering of boards

- **Done.** `export_shape` takes `shapeIds` (up to 200), `outputDir` (local mode), `renderer` (`browser` or `wasm`) and `refresh`. Renders are cached for 15 minutes, by file, page, revision, shape, format, scale and renderer. The adapter asks the exporter for the batch in one request and reads the ZIP reply, with a CRC check. If the exporter cannot do that, the adapter falls back to one request per shape, with a circuit breaker and a 10-minute budget. A fair queue for the shared export permit, a busy counter and an alert were added in the same work (see `production-readiness.md`, "After F2-20").
- **Checked.** On the stock 2.18 exporter, the one-request batch fails with HTTP 500, so the fallback ran. Four boards inline: 2 rendered, 2 from the cache, 25.6 s. A repeat single export came from the cache in 101 ms (the first took 6.9 s). `refresh: true` rendered again. `outputDir` wrote 4 PNG files and reported the one unknown id as failed. In multi-user mode, `outputDir` and `filePath` are refused. The live check also found that an svg export of a shape holding a text that no browser has laid out fails with an exporter timeout. A text created through the MCP is such a text. A png export of the same shape worked. After the file was opened once in the workspace, the same svg export took 3 s. `export_shape` now adds a hint to that error and does not retry it, so the answer came in 33 s, inside the 60 s timeout of an MCP client. The backend instructions and the contract say so.
- **Not done.** Progress events during a batch.
- **Not verified.** The one-request batch path against an exporter built from this branch. `renderer: "wasm"`: the stock exporter ignores it, and there is no emsdk on this machine to build the wasm renderer.

### 5. Geometry semantics documented

- **Done.** A new section, "Geometry semantics", is in the backend instructions. `penpot_api_info {type: "Geometry"}` serves it. It covers `positionData` (y is the baseline the SVG renderer uses, and `textLength` stretches the text), `points`, `selrect`, `transform`, path `content` (page space), gradient units (objectBoundingBox, the skew on a non-square box, the path case), stroke alignment and per-side strokes, and a recipe for a code generator. A text created through the MCP has no `positionData` until a browser lays it out, and the section says so.
- **Checked.** The reviewer traced each claim to the renderer code. The reviewer found two differences between the wasm and the SVG renderer (linear gradients on non-square boxes, and grid stacking order) and wrote them down.
- **Not verified.** The two differences were traced in code. They were not rendered side by side.

### 6. Font report and warnings

- **Done.** The new tool `list_fonts {fileId, pageId?, rootIds?}` reports, per font, the source (builtin, Google, team font or missing), whether it resolves and why not, runs and shapes, pages, variants and download URLs. `get_file_outline` has `warnings` for fonts that do not resolve, with `warningsComplete` and `warningsTruncated`.
- **Checked.** Both tools reported `gfont-access-sans` with reason `not-in-google-catalog`. On the 100,000-shape file, the outline spends at most 1 s on fonts per call, and it says `warningsComplete false` until the file has been read. `list_fonts` reads at most 5 s per call and says `truncated`. Each call caches the pages it read. Once the file was read, `list_fonts` took 0.4 s and the outline took 44 ms, with `warningsComplete true`.

### 7. Missing font warnings

- **Done.** The workspace text options show a notice when the selected text uses a font that does not resolve. The export dialog warns when a shape to export uses such a font. `export_shape` adds a font warning to its result.
- **Checked.** Live, `export_shape` added the font warning, and a board without that font got none. On a frontend built from this branch, selecting the text showed "Missing font: Access Sans. This text is drawn with a fallback font, here and in exports." in the text options. The export dialog (Ctrl+Shift+E) showed "Some text uses fonts that are not available (Access Sans). The export will draw it with a fallback font."
- **Not done.** A badge on the canvas or in the layers panel.
- **Not verified.** The export dialog looks up shapes when it opens outside the workspace page. Only unit tests cover that path. In the browser, the inspect panel started the export without opening the dialog, so that path was not seen.

### 8. Resolved geometry export

- **Done.** `export_subtree` gives each shape its box, `points`, `worldMatrix`, fills, strokes (with alignment and per-side widths) and text fragments (`positionData`). Together with the "Geometry semantics" section, this is the documented export the finding asks for.

### 9. Empty placeholder boards

- **Done.** `lint_page {fileId, pageId, depth?, boardNameRegex?, minShapes?, rules?, limit?}` runs the rules `empty-board` (fewer visible shapes than `minShapes`, default 3) and `instance-only-board` (the board holds only one component instance, such as a shared header). Both rules skip a board that is, or lies inside, a component instance, so the board of a component is not reported.
- **Checked.** The one empty screen of the fixture was reported. The board of the Button component and its copies were not. The check took 195 ms on a 2,498-shape page.

### 9b. Copied boards and hidden controls

- **Done.** `find_similar_boards {fileId, pageId, threshold?, ...}` groups boards by component structure and text. `lint_page` has rules for controls (component instances with a visible text): `off-board-control`, `clipped-control`, `invisible-control` and `scroll-hidden-control`.
- **Checked.** The board and its copy came back as one exact group, in 168 ms on the large page. A button 81 px past the right edge was reported as `off-board-control` with overflow right 81. A half-clipped control was reported as `clipped-control` 0.5. A row below the fold of a scroll list was reported as `scroll-hidden-control`.

### 9c. Frames that scroll

- **Done.** New board attribute `overflowScroll` with the values `none`, `horizontal`, `vertical` and `both`. It is in the shape schema, in component sync (in its own override group, apart from clip content), in the workspace (a "Scrolling" select in the measures options of a board), in the plugin API, in `apply_operations` and in the MCP reads (`export_subtree`, and `get_shapes` when `fields` names it). `lint_page` uses it for `scroll-hidden-control`. The CSS code generator in the inspect tab emits it for a clipping board: `overflow: hidden auto` (vertical), `auto hidden` (horizontal), `auto` (both). `update_shape` accepts `overflowScroll` on a shape that is not a board, because the shape schema is open. Nothing reads it there.
- **Checked.** Live, a board created through the MCP with `overflowScroll: "vertical"` read back with that value. In the browser, on a frontend built from this branch, the select showed "Vertical" for that board. Changing it to "Both directions" read back as `both` through the MCP. The inspect code tab showed `overflow: auto`.
- **Not done.** The viewer does not scroll such a board yet. The attribute is data for generators and lint. The Figma importer is not in this repository, so the carry-over is not done.

### 11. Per-side strokes in the exporter

- **Done.** The SVG renderer draws per-side stroke widths on rects and boards. It paints one rect through a clip of the band between the outer and the inner rounded rect. Dashed, dotted and mixed styles also mask it with one line per side. A gradient or image paint maps to the box of the shape, as for a uniform stroke. A stroke with equal sides renders as before. The exporter still uses the SVG renderer; `renderer: "wasm"` is passed through for an exporter that supports it.
- **Checked.** Through the stock exporter, with a frontend built from this branch, a rect with side widths 2, 4, 6 and 8 came out with those widths. Through the stock 2.18 frontend, the same rect came out with a uniform 2 px stroke. Six more cases were rendered in Chromium and looked at: dashed at half opacity, dashed with a gradient, solid gradient with outer alignment, rounded corners with inner alignment, dotted, and a uniform gradient stroke for comparison. The workspace (SVG renderer) and view mode draw them too.
- **Not done.** Mitred corners where several strokes stack, fitting a whole number of dashes to a side, and the solid corner patches of dashed strokes on rounded corners, which the wasm renderer draws. Dotted strokes look untidy where two sides of different width meet.
- **Not verified.** Not compared pixel by pixel against the wasm renderer. This machine cannot build it.

### 10. Advisor tool with Haiku subagents

- **Done.** Workaround: every brief for a Haiku subagent says not to call the advisor tool.
- **Not done.** The fault stays. It is in the agent harness, and nothing in this repository can fix it.

### 12. Lessons for subagent work

- **Done.** Each work package had a written brief and more than one measure (unit tests, type check, linters, a live call).
- **Checked.** Independent reviewers that built nothing reviewed every package. Their findings are under Review.

### Review

- **Product changes.** An independent reviewer that built nothing read the commit for items 7, 9c and 11. It found seven defects, and all were fixed and re-tested: the per-side stroke component crashed on render (a hiccup vector bound to a local; the unit tests caught it too); dashed per-side strokes with a gradient or image paint drew nothing; translucent dashed strokes painted the corners twice; a gradient on a solid band mapped to the wrong box; the scroll attribute shared its override group with clip content; the scroll tooltip promised code export that did not exist; the export dialog could not find shapes outside the workspace page.
- **Independent reviewers (item 12).** Reviewers that built nothing reviewed every work package. They found real defects after the builders reported success: the render cache key lacked the page id; a stub ancestor could be deleted through `rootIds`; the font scan made a cold outline of a large file take 40 s, now bounded to 1 s; rotated shapes were boxed wrongly in the lint. All were fixed and re-tested.
- **Plugin API surface.** The file `plugins/apps/plugin-api-test-suite/src/generated/api-surface.json` was not regenerated. A fresh run also brings in unrelated earlier drift (444 changed lines). The plugins team should run `pnpm run gen:api`.

### Test results

- Common (JVM): 1,770 tests, 29,277 assertions, 0 failures.
- Frontend: 1,741 tests, 6,937 assertions, 0 failures, 0 errors.
- Backend, whole suite: 2,209 tests, 10,983 assertions, 49 failures. All 49 are the known failures of this machine (font, media and storage tests that need image tools the test container lacks). None is in an MCP namespace.
- Adapter: 1,536 tests, 1,531 pass, 0 failures, 5 skipped. Type check and prettier clean.
- Alert rules: `promtool check rules` passes (16 rules), and the new `promtool test rules alerts_test.yml` passes.
- Linters: cljfmt and clj-kondo clean on every Clojure file touched.

### Open items

- Item 1: lazy loading of a whole page (not done).
- Item 3: conditional or variable-driven interactions, 3c (not done).
- Item 4: progress events during a batch (not done).
- Item 4: the one-request batch path against an exporter built from this branch (not verified).
- Item 4: `renderer: "wasm"` (not verified; the stock exporter ignores it, and there is no emsdk on this machine).
- Item 5: two renderer differences, traced in code only and not rendered side by side (not verified).
- Item 7: a badge on the canvas or in the layers panel (not done).
- Item 7: the export dialog for shapes outside the workspace page (not verified in the browser).
- Item 9c: the viewer does not scroll such a board (not done).
- Item 9c: the Figma importer carry-over (not done; the importer is not in this repository).
- Item 10: the fault in the agent harness remains (not done).
- Item 11: mitred corners, dash fitting, corner patches and untidy dotted corners (not done).
- Item 11: pixel comparison with the wasm renderer (not verified; this machine cannot build it).
- Review: the plugin API surface file was not regenerated (not done).
