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

## Resolution (2026-11-11)

This section records, for each finding, what was done and how it was checked. Every point of the first list is fixed, documented, proposed or marked not ours. The real Kiosk file could not be used here, so all checks ran on three synthetic kiosk files built by `mcp/packages/loadtest/scripts/kiosk/build-kiosk-journeys.mjs`. Each is an 800 x 600 key-management kiosk with 12 views (login, screen saver, header and nine more), a Components page and a Journeys page:

- `kiosk-journeys-12`: 12 screens, 1,718 shapes.
- `kiosk-journeys-207`: 207 screens, 28,695 shapes, 209 connectors, 60 flipped shapes (20 of them groups that reproduce the N1 fault), 80 scroll candidates, 30 off-board controls, 64 clipped, 30 blank boards, 17 instance-only boards and 6 boards named `Single`.
- `kiosk-journeys-xl`: 830 screens, 115,219 shapes.

Each file has a truth manifest, and `verify-kiosk-journeys.mjs` compares tool answers with it. What remains is the re-run of the v2 scripts on the other deployment, on the real page. A rule tuned on synthetic files guards against regressions; only that re-run shows how it does on the designers' data.

### N1. `worldMatrix` of flipped groups

- **Fixed.** `export_subtree` now computes `worldMatrix` from the shape's `points`, so it carries the flip of every ancestor group. It falls back to the stored transform when the points give no usable matrix.
- **Also.** `update_shape` refuses `flipX`, `flipY` and `pageId` in props, and create operations refuse `rotation` in props. Both the adapter and the backend refuse, with a message that says what to do instead. Before, these were accepted and did nothing or did harm. This can break old scripts (see Other changes).

### N2. `circle` and `ellipse`

- **Documented, not changed.** Penpot's shape type is `circle`; `export_subtree` keeps the name `ellipse`, because a change would break current readers. The contract and the tool text now say so.

### N3. Fonts

- **Fixed.** `list_fonts` gives, for each unresolved font, `suggestedFontId`, the family and the reason, when a team or built-in font matches the name after weight and style words are stripped ("Access Sans Bold" gives "Access Sans", weight 700). The warning in `get_file_outline` carries the suggested font id and family only; `list_fonts` carries the full suggestion (reason, match, missing variants).
- **N3b, step 1 only.** `get_file_outline` reports `warningsComplete`, the pages read, the pages total and `warningsPendingPages`. A client finishes the warnings by calling `list_fonts`. The shared cache was not built, by decision.
- **N3c, `replace_font`.** A new operation in `apply_operations` swaps one font for another across a page or a file in one call. It keeps weight and style where the target has the variant, and reports per-operation results in `opResults`.
- **Limits.** It drops the stored text layout of the texts it changes (the editor lays them out again on open). It has no copy mode: it writes the mains, and reports and skips component copies; add `sync_components` to the same call to carry the change. Text operations older than `replace_font` can write a wrong variant id for team fonts.

### N4. `lint_page`

- **Fixed.** The default mode `auto` now reaches the screens (see Board selection). The reply says how the boards were chosen and lists other sizes or deeper boards that were left out.
- **`instance-only-board`.** It no longer fires for screens that hold only shared chrome (header, footer and the like). Chrome is found from component statistics: a component at the same edge on 70 % of the screens.
- **`off-board-control`.** It takes `tolerance` (default 0.5 px).
- **New rule `scroll-candidate`.** It reports boards whose content overflows by more than `minOverflow`.
- **Limits.** Chrome detection needs the component in the same place on most screens. A backdrop split into several shapes is not seen as a backdrop.

### N5. `find_similar_boards`

- **Fixed.** The cause was the minimum shape count, not depth. Blank and near-blank screens are now reported in `skippedSmall` instead of dropped silently, and the tool uses the same board selection as `lint_page`.
- **Limit.** At the default threshold, 5 of the 17 copy groups on kiosk-xl come out as exact groups; the other 12 join into larger groups at 0.904. Threshold 1 gives all 17. This is documented behaviour.

### N6. `find_connectors`

- **Fixed.** Screens come from the shared board selection, and each end reports `screenId`. Lines inside one screen are left out and counted in `sameScreenSkipped`; `includeSameScreen` brings them back.
- **Direction.** It is read from the arrow head only: stroke caps, a wide head on a path, or a head shape grouped with the line. Each answer carries `confidence`. When no head can be read, the direction is `none`; the tool does not guess from line width.
- **Limits.** A shaft split into several shapes, a rounded tip whose radius is half the width, and a flat rhombus head read as `none` or `both`.

### N7. `execute_code` with `rootIds`

- **Fixed.** A call with `rootIds` loads only the asked roots, what is inside them, and their ancestors as stubs. 20 roots went from 34 backend calls to 2; a wide board went from 76 to 9.
- **Refusal.** A whole page that is too large is refused after one backend call instead of seven. The size comes from an estimate on a sample of the page; the refusal applies above 1.3 times the cap. The loader stops a partial load as soon as the bytes read pass the cap.
- **Measured.** 20 roots in 2.0 s; all 207 screens in 22.8 s; the refusal in 0.54 s warm.
- **Also.** In a script, `root.parent` is null, and a climb by `.parent` ends at the root.

### N8. A whole page through `export_subtree`

- **Fixed, option A.** There is no new access path and no download URL. One tool call now reads up to 24 backend windows, up to a cap set by `PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB`. `compact` drops default attributes, and `encoding: "gzip-base64"` packs the reply.
- **Cursor.** A reply cut at the cap always carries the cursor. Before, a cut reply could lose it and the walk dead-ended.
- **Backend rate limit.** When a walk reaches it, the error text gives the wait and says that a cursor from an earlier reply stays valid. A call that already held data returns it with `nextCursor` and a note.
- **Measured.** The 207 screens take 6 calls and 10.6 s with `gzip-base64` at a 1 MB cap; before, on Azure, 784 calls and 12.7 min.
- **Example.** On a 300-shape page: 72 calls at the 100 kB default, 7 at 1 MB.
- **Limit.** Under the default cap a model client still needs hundreds of calls for a 28,000-shape page. A script client should raise the cap.

### N9. Avalonia generator

- **Not ours.** The fix is in `kam-platform-poc`.

### 3c. Conditional interactions

- **Proposal only.** See `mcp/docs/proposal-conditional-interactions.md`.

### 9c. Scrolling

- **Documented in part.** The lint rule `scroll-candidate` (see N4) suggests `overflowScroll` for clipping frames whose content overflows. Viewer scrolling is a proposal: `mcp/docs/proposal-viewer-scrolling.md`.

### Progress events

- **Fixed.** The batch export now sends a heartbeat every 5 s between boards. The client must send a progress token to receive it.

### Font badge

- **Fixed.** A text layer with a missing font shows a warning mark in the layers panel, once the team fonts have loaded. Checked in a browser on a frontend built from this branch: a text with a font that is not installed shows the mark with the title "Missing font: <family>" and the text options show the notice; a text that uses a team font shows no mark; the rows keep their height. The export-dialog warning was not checked again in this round.

### Lazy loading of a whole page

- **Covered by N7.**

### Board selection

`lint_page`, `find_similar_boards` and `find_connectors` share one board selection.

- **Mode.** Default `auto` picks the screens by size: the standard device sizes, else the most common size among boards with sides of 200 px or more. It looks at any depth to 12. Mode `depth` keeps the old behaviour.
- **Wrapper rule.** A frame class at most a quarter taller than an exact standard screen of the same width, where more than half of the frames each hold exactly one such screen, is a wrapper. The screens inside it are the boards.
- **Same-size chain rule.** Of frames of one size that hold each other, one is the board: the one that matches `boardNameRegex` (mode `auto`), else the one named like the unwrapped boards of that size (the default names Board and Frame do not count), else the outermost.
- **`selection` reports.** How the boards were chosen (`basis`, `selection`) and `selection.nestedSameSize`, the count of such chains. `otherSizes` lists sizes and deeper boards left out; a wrapper size appears there with relation `wrapper`.

### Other changes

- **Retried writes.** An `apply_operations` call retried with the same request id now answers with the same created ids and per-operation results, and says `alreadyApplied`. The reply is stored in a new nullable column `file_change.mcp_reply`: one migration, `0160-add-mcp-reply-to-file-change`.
- **`find_shapes`.** It reports `scanned`, a `reason` when it stops early, `skipped`, and `skippedLarge` for a match too large to fit a reply (the cursor moves past it). Its byte limit counts UTF-8 bytes. Its cursor works only with the filter and page it came from; any other use is refused.
- **Write refusals.** Create operations refuse `rotation` in props; `update_shape` refuses `flipX`, `flipY` and `pageId`. Old scripts that set these will now fail.
- **Translations.** Nine translation keys that had English only now have Spanish.

### Review

Every piece was reviewed by an Opus sub-agent that built none of it, in six chunks plus a final pass over the whole branch. The final pass found no gap against the plan. An independent verifier ran the live checks below in three passes, and each pass checked the fixes of the one before. The first pass found: a wrapper picked instead of the screens; cut lists of `find_connectors` and `lint_page` with no way to continue (offset paging added); a backend rate limit refusal with no wait hint; `find_shapes` scanning rows twice; `list_fonts` giving no hint when partial; and `root.parent` in `execute_code`.

### Test results

#### Live checks

Numbers are kiosk-207 / kiosk-xl unless one is given.

| Check | Result |
|---|---|
| Outline | 28,695 and 115,219 shapes, exact. On kiosk-xl the first outline had `warningsComplete` false and named `list_fonts`; after `list_fonts` it was complete and carried the font |
| `list_fonts` | Unresolved font exact (2 texts / 8 texts). After a team font "Access Sans" 700 was uploaded, `suggestedFontId` was given and the match was exact |
| `list_fonts` after a restart (xl) | 1 of 2 pages with a note to call again; the second call was complete |
| Default `lint_page` selection | 207 / 830 screens of 800x600, basis standard-size; the 800x660 size listed with relation wrapper; `nestedSameSize` 12 / 48 |
| `empty-board` | 7 / 28, exact |
| `instance-only-board` | Exactly the 23 / 92 blank screens, by manifest id; none of the 17 / 68 instance-only screens |
| `off-board-control` | 30 of 30 with 81 px; `tolerance` 100 leaves only overhangs above 100 |
| `clipped-control` | All 32 half-clipped controls, plus the 30 off-board ones that the board edge clips |
| `scroll-candidate` | 80 of 80; `minOverflow` 450 gives 19 of 19 |
| `invisible-control` | 402 on kiosk-207: all 32 fully clipped controls plus the 370 list rows below the edge of their scroll frames |
| Depth mode | Reports deeper boards (654) |
| Board ids | Every finding's board id and every connector `screenId` is a manifest screen handle (0 exceptions) |
| `find_similar_boards` | kiosk-207: 200 compared + 7 skipped, 5 of 5 copy groups exact, the 6 screens inside `Single` frames are compared. kiosk-xl: 802 compared + 28 skipped, 5 of 17 copy groups exact at the default threshold and 17 of 17 at threshold 1 (see N5) |
| `find_connectors` | 209 / 915, 0 missing, 0 extra, all directions right across six arrow styles; the decision-frame ends right; 2 divider lines only with `includeSameScreen`; chevrons never |
| `find_connectors` paging (default cap) | 209 / 915 in 2 / 5 pages |
| `lint_page` paging (default cap) | All 604 / 2,427 findings; each item once, total stable; offset past the end gives an empty list |
| `lint_page` walk on xl, limit 25, under load | 80 pages with a stable total, then a page with `timedOut` true and no `nextOffset`. Never a changed total with a `nextOffset` present |
| N1 | `worldMatrix` right for 60 of 60 flips (240 of 240 on xl) |
| `execute_code` | Whole page refused with the limit and the way out; 20 roots give 2,835 shapes, equal to truth and to `export_subtree`; ancestors load as stubs; a shape outside the roots is absent; `root.parent` is null |
| `find_shapes` | Text walk 9,209 of 9,209 in 22 calls (36,983 on xl), none twice; sum of `scanned` 28,748 / 115,489 for pages of 28,695 / 115,219 shapes (was 2.4 times); a cursor used with another filter or page is refused |

The `export_subtree` walk reads all 28,695 shapes of kiosk-207 in every variant, none twice, with the same ids and order. Calls and bytes:

| File | Cap | Plain | Compact | `gzip-base64` |
|---|---|---|---|---|
| kiosk-207 | default | 366 calls, 36.2 MB | 346 calls, 34.2 MB | 127 calls, 2.83 MB |
| kiosk-207 | 1 MB | 36 calls | 34 calls | 6 calls, 2.62 MB |
| kiosk-xl | default | 1,472 calls | not completed | 520 calls, 11.3 MB |
| kiosk-xl | 1 MB | 143 calls, 145.4 MB | 135 calls | 24 calls, 10.4 MB |

The plain default-cap walk of kiosk-xl reached the backend rate limit after about 865 calls. The error text read "backend rate limit reached, retry after 10 s. A cursor from an earlier reply stays valid." After the 10 s wait the same cursor worked at once, and the full walk read 115,219 shapes, none twice, in 1,472 calls and 3,349 backend reads.

Write checks on kiosk-12:

- A retry with the same `requestId` answers `alreadyApplied` with the same id and no second shape.
- Flip and create-with-rotation are refused with clear words; the adapter itself refuses `props.pageId` and create with `props.rotation`.
- A shadow without an id gets one.
- `replace_font` to `sourcesanspro` kept weight 700 as bold; `list_fonts` then shows 0 unresolved.
- `replace_font` on component copies was not checked live (no such text in the kiosk files); backend tests cover it.

Suites, all on the final code:

- Common: 1,826 tests, 29,559 assertions, 0 failures.
- Backend: 2,502 tests, 17,624 assertions, 49 failures. All 49 are the known failures of the toolchain container, which has no font and image tools (font 42, media 4, storage 3). The first full run had one more failure: two new error codes (`mcp-invalid-window`, `mcp-invalid-board-selection`) were missing from the listed set in `backend/src/app/main.clj`. That is fixed, and the namespaces that raise them pass (168 tests, 0 failures).
- Adapter (`mcp/packages/server`): 1,657 tests, 1,652 pass, 0 fail, 5 skipped.
- Loadtest package: 214 tests, 0 failures.
- Frontend: 1,750 tests, 6,952 assertions, 0 failures.

#### Timings

Measured on 2026-11-11 on the development laptop when idle, with the backend and adapter built from this branch, one backend process unless said. Each time is the median of three runs, with the range where it matters, and includes any wait on a rate limit. The "v2 on Azure" figures come from another deployment on other hardware, so they show direction, not a ratio. Figures are for kiosk-207 (28,695 shapes, 207 screens).

| Measure | v2 on Azure | Target | Here |
|---|---|---|---|
| Whole-page refusal of `execute_code` | 14.6 s | under 1 s warm; cold figure stated | 0.54 s warm (0.34 to 0.69); 4.9 s for the first call after a backend restart |
| `rootIds` call, 20 roots | 22 to 30 s | 5 s or less | 2.0 s (1.1 to 2.6) |
| 207 screens through `rootIds` | 5.6 min | 1 min or less | 22.8 s in 11 calls of 20 roots |
| 207 screens through `export_subtree` | 784 calls, 12.7 min | a handful of calls, 60 s or less | 6 calls, 10.6 s with `gzip-base64` at a 1 MB cap |
| `lint_page`, default call | reaches 12 boards | reaches the screens | reaches the 207 screens (0.56 s) |
| `find_similar_boards` | 201 of 207 screens | every screen compared or listed in `skippedSmall` | 200 compared, 7 in `skippedSmall` (0.28 s) |
| `instance-only-board` | 17 false positives | 0, with all blanks still found | 0 false positives, all 23 blanks found |
| Screen-to-screen connectors that match the map, direction right | 4 of 10 | 10 of 10 | 193 of 193 on the synthetic file (0.40 s); the real map of 10 is for the Azure re-run |
| Same-screen connectors in the default reply | 35 | 0 | 0 (2 counted in `sameScreenSkipped`) |
| Shapes whose `worldMatrix` maps `selrect` onto `points`, in order | 26,077 of 26,097 | all | 60 of 60 flipped shapes; 240 of 240 on kiosk-xl |
| Font warnings | a client cannot finish them | pending pages named; complete after `list_fonts` | met |
| Silence during a 40-shape export | about 27 s | a notification at least every 5 s, when the client sends a token | 40 notifications for 40 screens, longest gap 3.7 s (25 rendered, 15 from the cache; 85 s in all) |

`get_file_outline` took 28 ms and `list_fonts` 32 ms warm.

`export_subtree` whole-page walk, calls / time:

| File | Cap | Plain | Compact | `gzip-base64` |
|---|---|---|---|---|
| kiosk-207 | 1 MB | 36 / 12.1 s | 34 / 11.6 s | 6 / 10.6 s |
| kiosk-207 | default (100 kB) | 366 / 35.9 s | not timed | 127 / 46.7 s |
| kiosk-xl | 1 MB | 143 / 48 s | 135 / 46 s | 24 / 42 s |
| kiosk-xl | default (100 kB) | not timed | not timed | 520 / 192 s |

The kiosk-xl runs are one run each.

kiosk-xl (115,219 shapes, 830 screens):

- Whole-page refusal: 0.27 s warm; 7.8 s for the first call after a restart.
- `rootIds`, 20 roots: 2.1 s. All 830 screens through `rootIds`: 91 s in 42 calls.
- `lint_page` default call 1.8 s (2.4 s cold); `find_similar_boards` 0.94 s; `find_connectors` 1.2 s.

#### Two backend processes

Two backend processes ran behind a round-robin proxy, so each request went to the other process.

- Font warnings: the first `list_fonts` read 1 of 2 pages and carried the note; the second read 2 of 2. After that `get_file_outline` was complete on both processes.
- `find_connectors` (209) and `lint_page` (604) by offset, and `find_shapes` (9,209 texts) by cursor: every item once, totals stable.
- A write retried with the same `requestId` answered `alreadyApplied` with the same id from the other process, because the reply is stored in the database.
- Timings as with one process: refusal 0.30 s, `rootIds` with 20 roots 2.0 s, 207 screens through `rootIds` 22.9 s, whole page with `gzip-base64` at 1 MB in 6 calls and 11.0 s.

### Known limits

- Auto board selection: non-standard screen sizes that sit under sections of equal size, and files with fewer than three tall screens per section, may need `mode: "depth"` or `boardNameRegex`.
- A call with `boardNameRegex` and no `mode` uses depth mode at depth 1, as in v1. Pass `mode: "auto"` with the regex to filter the automatic selection.
- A screen with a same-size inner frame counts that frame as a shape (`empty-board` threshold, similarity).
- Chrome detection needs the component in the same place on most screens; a backdrop split into several shapes is not seen as a backdrop.
- `lint_page` and `find_connectors` redo the whole scan on every page. On a 115,000-shape page under load a page can time out (`timedOut` true, no `nextOffset`): narrow the call.
- A cold backend can time out the first lint of an 830-screen page.
- `list_fonts` keeps read pages in one backend process for 10 minutes.
- `replace_font` drops the stored text layout of changed texts and skips component copies. Text operations older than `replace_font` can write a wrong variant id for team fonts.
- Connector direction: a shaft split into several shapes, a rounded tip whose radius is half the width, and a flat rhombus head read as `none` or `both`.
- Under the default cap a model client still needs hundreds of calls to walk a 28,000-shape page; a script client should raise the cap. The stated rate-limit wait is capped at 10 s by the adapter; the backend header gives the time to a full bucket.
- Writes on pages above about 70,000 shapes can pass the adapter's 55 s timeout.
- The plugin API surface file was not regenerated.

### Open items

- The plugin API surface file (not regenerated).
- Viewer scrolling and conditional interactions: proposals only.
- The re-run of the v2 scripts on the other deployment, on the real page.
