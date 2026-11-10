# Avalonia test run: improvements for the backend MCP and Penpot

This run built a pixel-exact Avalonia app (207 screens) from the Penpot page "Journeys - (800x600) - MEDIUM - VARS - Kiosk / Keyper / Dark". We treated it as a real-world test of the backend-only MCP (`33cb17b0d2`) and of Penpot. Each item says what happened, what it cost, and what would fix it. The app, its plan (`docs/kiosk-avalonia-plan.md`) and its reports live in the `kam-platform-poc` repo, under `avalonia-ui/`.

Status: **complete** (2026-11-10). The app is built, and it passed independent verification except for the real-window check, which waits until the Windows session is unlocked. See `avalonia-ui/design/report/verification.md` in `kam-platform-poc`.

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
