# Avalonia test run v2: re-test of the findings on the deployed fix

The first run ([avalonia-test-run-improvements.md](avalonia-test-run-improvements.md)) found 12 problems while building a 207-screen Avalonia app from the Kiosk journeys page. This re-test deployed the fixes (`ddf26eff8c`) to the Azure instance and ran the same work again through the backend MCP, on the same page, in multi-user mode. This file lists what is now resolved, what is left, and the new problems the re-test found.

## How it was tested

- **Deploy.** Frontend, backend and MCP images built from `ddf26eff8c`. The exporter image was unchanged, because no commit touched it. The deploy had no migrations and needed no restore. The backup before the deploy is `backups/2026-11-10T1526Z`. The MCP now has 31 tools, 6 of them new.
- **Data.** File `b48cc9bd-bdae-8000-8008-eb67a08dd490` (exported-views, revision 165), page `c54dcb4e-6001-5521-83dc-e18bd52d20ab`. This copy has the same data as the local binfile the app was generated from: on a sample screen, every point matched.
  - A first pass used the older Azure copy, `346a1245…` (revision 93). Its layout differs from the source on about 15,000 shapes, so that pass was thrown away. The tools gave the same answers on both files.
- **Method.**
  - Each original finding was re-run through the new tool, on all 207 screens.
  - The results were checked against the original ground truth: the binfile extract, the 207 reference renders, the reviewed navigation map (511 screen-to-screen links), and the known blank and copied screens.
- **Scripts and results.** They are in `C:/dev/penpot-daryl/kam-link-work/v2test/` (`results/*.json`). They are not in this repository.

## Scorecard

| # | Original finding | Now | Measured on the Kiosk page |
|---|---|---|---|
| 1 | `execute_code` can't load a large page | **Resolved** | The whole page is still refused (28,709 shapes, 31.9 MB, limit 16 MB). The message now names the limit and suggests `rootIds`. With `rootIds`, all 207 screens loaded in 11 calls of 20 roots, and every screen's shape count matched the extract. Slow: see N7. |
| 2 | No bulk "board as data" tool | **Resolved** (slow in bulk) | `export_subtree` returned all 26,097 shapes of the 207 screens: 0 missing, 0 extra. Every compared attribute matched the binfile (fills, strokes, path `content`, `positionData`, `points`, `selrect`, `transform`, shadows). The exceptions are explained below or under N1 and N2. 784 calls, 12.7 min, 48 MB. See N8. |
| 3 | No prototype links; no bulk read | **Tools resolved; data gap remains** | `get_interactions` answers in 0.9 s: 0 interactions, 0 flows (the design has none). `find_connectors` scans 2,878 candidates in 2.2 s and finds 54 connectors. Only 12 join two screens, against 511 links in the reviewed navigation map. See N6. Conditional interactions are still missing (3c). |
| 4 | Serial, slow batch rendering | **Resolved** | 207 boards rendered in **147 s** (the first run took 38 min, so about 15× faster). 0 failures. The exporter answered each chunk as one ZIP, so the one-request batch path works on this fork's exporter. A repeat call came from the cache in 20 s, byte-identical. |
| 5 | Geometry semantics undocumented | **Resolved** | `penpot_api_info {type: "Geometry"}` covers what the first run had to find in the source code: the ideographic baseline of `positionData`, `textLength` with `spacingAndGlyphs`, gradient points as fractions of `selrect` (with the skew between the two renderers), page-space path `content`, stroke alignment, per-side strokes, `worldMatrix`, and why stored `x`/`y` can be stale. |
| 6 | No font report | **Resolved** | `list_fonts` (1.7 s) reports `gfont-access-sans` as unresolved, `not-in-google-catalog`, 1 run. `get_file_outline` carries the same warning. See N3: the fix was already on the server, and no tool says so. |
| 7 | Missing fonts render silently | **Resolved in the MCP**; UI not re-tested | `export_shape` on `idle-custom-screensaver` adds "Font warning: … Access Sans (font gfont-access-sans, reason not-in-google-catalog) …". A screen without that font gets no warning. The workspace and export-dialog notices were not checked in a browser in this run. |
| 8 | No resolved-geometry export | **Resolved** | `export_subtree` gives `worldMatrix` for every shape. For 26,077 of 26,097 shapes, `worldMatrix` maps the `selrect` corners onto `points`. The 20 exceptions are N1. |
| 9 | Empty boards hard to find | **Resolved** (noisy) | `lint_page` (1.4 s, 208 boards) flagged all 23 blank screens that the first run found by eye. It also found 7 truly empty screens that the first run had not listed. It has false positives (N4). |
| 9b | Copied boards, invisible controls | **Resolved** | `find_similar_boards` (1.0 s) found the 6 copies of Main Menu Admin as one group, and each logging screen as an exact group of 3 (Logging, Check In and Check Out). `lint_page` flagged the Select button 81 px off cabinet-select (`clipped-control`, 45% visible). It also flagged the hidden Proximity row of settings-overview (`clipped-control` and `invisible-control`). |
| 9c | Frames don't record scrolling | **Partly resolved** | `overflowScroll` exists and reads back through `get_shapes`, but it is `null` on every frame of this design: nothing set it at Figma import. The generator still has to guess. `scroll-hidden-control` found 0, because no frame is marked. |
| 10 | Advisor tool fails for Haiku | **Not re-tested** | This is a harness fault, not a Penpot one. No Haiku subagents ran in this re-test. |
| 11 | Exporter ignores per-side strokes | **Resolved** | 178 of 207 screens changed against the original references, and 177 of them hold per-side strokes. The median change is 0.37% and the worst 1.25%, all on the per-side borders. The export now matches what the workspace draws. See N9 for what this means for the app. |
| 12 | Lessons for subagent work | n/a | Process notes. Nothing to re-test. |

**Count:**
- 9 resolved: 1, 2, 4, 5, 6, 8, 9, 9b, 11;
- 2 partly resolved: 3 (the tools are there, but the source data has no links and there are no conditional interactions) and 9c (the attribute exists, but nothing sets it);
- 1 resolved in the MCP only: 7 (the UI was not re-tested);
- 2 not applicable: 10 and 12.

## What is left from the first run

1. **Conditional or variable-driven interactions (3c).** This is still the main navigation gap. The "is…?" decision frames can't be expressed as prototype links.
2. **Nothing sets `overflowScroll` (9c).**
   - The Figma importer is outside this repository, so the attribute arrives `null`. A generator must still guess scroll lists from clipping and overflow.
   - The viewer does not scroll such a board yet.
   - A small tool or lint rule could suggest `overflowScroll` for clipping frames whose content overflows by at least N px. That would let a designer mark them in one pass.
3. **Progress events during a batch export (4).** These were not seen in this run. A 40-shape call is silent for about 27 s.
4. **Missing-font badge on the canvas or in the layers panel (7).** It is not done, and the existing UI notices were not checked in this run.
5. **Lazy loading of a whole page (1).** It is not done, but `rootIds` covers the need.

## New problems found by the re-test

### N1. `worldMatrix` ignores the flip of flipped groups

- **What.** 20 of the 60 flipped shapes are groups. Their `worldMatrix` is the identity, while their `points` are mirrored, so the first point is the top-right corner. The other 40 flipped shapes are correct.
- **Effect.** A generator that nests children through `W_parent⁻¹ · W_child` gets the wrong child placement under a flipped group if it trusts `worldMatrix`.
- **Fix.** Fold `flipX`/`flipY` into a group's `worldMatrix`, the same way it is done for other shapes.

### N2. `export_subtree` reports `circle` as `ellipse`

- **What.** All 531 stored `circle` shapes come back as `type: "ellipse"`. That is the plugin API name, but the stored data and the binfile say `circle`, and the Geometry topic doesn't mention the rename.
- **Effect.** A generator ported from the binfile silently loses its circle handling.
- **Fix.** Return the stored type, or document the mapping in the Geometry topic and in the tool description.

### N3. `list_fonts` doesn't point to a font that would fix the problem

- **What.** The text uses `gfont-access-sans`, and it is reported as unresolved. But the same server holds the real **Access Sans Bold** as a team custom font (`custom-8a4bc089…`). The older copy `346a1245…` already uses it, and `list_fonts` gives its download URL. The file is the genuine ASSA ABLOY font from 2024.
  - The first run swapped in Liberation Serif. That was never needed: the font was on the server all along.
- **Fix.**
  - When a font doesn't resolve, have `list_fonts` look for a team font with the same family name, and report it as a `suggestedFontId`.
  - Offer a one-call fix through `apply_operations`, such as a font swap across a page.

**Also.** `warningsComplete` was still `false` on the second `get_file_outline` call (both runs). A client can't tell when the font warnings are final.

### N4. `lint_page` defaults miss the screens, and some rules are noisy

- **Depth default.** With the default depth, `lint_page` and `find_similar_boards` look at 12 boards, which are only the section frames. They reach the screens only with `depth: 5` and `boardNameRegex: "^Parent$"`. The defaults should either reach the real boards, or the reply should say that deeper boards exist.
- **`instance-only-board` false positives.** It fires where the single instance *is* the content. The 12 boot screens are a header plus one boot component, and three asset screens and admin-overview are flagged the same way: 17 false positives against 23 real blanks. It should skip a board whose one instance covers most of the board, or a header-like instance should be told apart.
- **`off-board-control` on noise.** On the older file it fired on a 0.00005 px overflow (`login/failure`). It needs a tolerance, such as 0.5 px.

### N5. `find_similar_boards` stops at depth 5

The tool accepts at most depth 5, which reaches 201 of the 207 screens. The six deeper screens sit inside `Single` frames, so they are never compared. Allow a deeper scan, or use the same board selection as `lint_page`, which reached 208.

### N6. `find_connectors` direction and noise

- **Noise.** Of the 54 connectors found:
  - 35 start and end on the same screen (icons and dividers);
  - 6 touch decision frames;
  - 1 is something else.
- **Direction.**
  - 43 of the 54 have direction `none`, so the tool could not tell which end is the head.
  - Of the 12 that join two screens, 10 match a link in the reviewed navigation map, but 6 of those 10 point the wrong way.
  - The journeys draw their arrows as flattened filled outlines, and the head detection reads them backwards.
- **Fix.**
  - Drop connectors whose two ends land on the same top-level screen, or flag them.
  - For filled arrow outlines, find the head from the end whose geometry tapers to a point, rather than from the width.

### N7. `execute_code` with `rootIds` is slow, and the refusal is slow

- **Slow loads.** Each call with 20 roots took 22 to 30 s, and 207 screens took 5.6 min. `export_subtree` returns the same screens in under 4 s each.
- **Slow refusal.** The whole-page refusal takes 14.6 s to arrive, because the page is loaded before it is measured.
- **Fix.**
  - Measure the page from its shape count before loading it.
  - Profile the root load: the shapes of 20 screens (about 2,500) should not take 25 s.

### N8. A whole page through `export_subtree` is slow in multi-user mode

- **What.** In multi-user mode `filePath` is refused, so the reply cap of 100 kB (`PENPOT_MCP_MAX_TOOL_RESPONSE_KB`) sets the window size. The 207 screens took **784 calls, 12.7 min and 48 MB**. A binfile export of the whole file from the same server took 49 s.
- **Effect.** For a one-off bulk extract, the binfile is still about 15× faster. `export_subtree` is the right tool for a single board or a handful of boards.
- **Fix.** Return a short-lived download URL for the whole subtree, written by the backend as gzipped JSON, the way `export-binfile` returns an asset URL. That keeps the MCP reply small and needs no file path on the client.

### N9. On our side: the Avalonia generator now follows the old exporter

This is not a Penpot defect, but it follows from item 11:
- The generator ignores per-side stroke widths, to match the old exporter.
- Against the new renders, the app's median mismatch went from 0.315% to 0.753%, and its maximum from 1.289% to 1.557%. It still passes its gates (2% max, 1% median).
- The fix is in `kam-platform-poc`: switch per-side strokes back on in `gen-axaml.mjs`, and re-render the references with the batch export.

## Priorities

| Item | Why | Size |
|---|---|---|
| N3. Suggest a matching team font in `list_fonts` | The real fix existed and nobody saw it. The first run shipped a stand-in font. | Small |
| N4. `lint_page` and `find_similar_boards` depth defaults; `instance-only-board` false positives | With the defaults, both tools miss every screen on a typical journeys page. | Small |
| N1 and N2. `worldMatrix` of flipped groups; the `circle`/`ellipse` rename | Silent errors in generated code | Small |
| N6. Connector direction and same-screen noise | Turns `find_connectors` into usable navigation evidence | Medium |
| N7. `rootIds` load time | 25 s a call makes scripted reads impractical | Medium |
| N8. Download URL for large subtrees | Bulk extracts through the MCP without a binfile | Medium |
| 3c. Conditional interactions; 9c. something that sets `overflowScroll` | Product features. These are still the largest gaps for code generation. | Large |
