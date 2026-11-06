# Parity notes: residual pixel diffs

This note gives the evidence for the pixel diffs that remain. Each path is relative to the package root. Each diff
image has a design image and an app image beside it, with the same prefix. The files in `out/compare/` come from the
scale 2 run. The glyph evidence below was judged by eye at scale 1, in an earlier run.

## Status at scale 2 (app screenshots in the exporter container)

- DOM check: 0 mismatches across 59 targets.
- Over budget: 0 targets (component budget 1.0 percent, screen budget 0.5 percent). Largest component percent: 0.24. Largest screen percent: 0.01.
- Real mismatch flag (largest cluster above 12 device px): 10 targets, all under budget. They are listed with a cause note in src/compare/PixelCauses.ts.
- Every target has a pixel result. The table below is generated from out/compare/report.json.

## Run after the natural child order change

The backend compiler now orders the children of flex and grid layouts in visual order. The planner matches it:

- `NATURAL_CHILD_ORDER` is `true`. The planner creates each flex board's children in spec order, with no reversal.
- The planner sets the flex layout after the children (`postOps`). So the compiler's one-time reversal of `:shapes`
  applies, and the spec order is the visual order. It does not use the index-0 insert path.
- `get_page_tree` lists the children in visual order. In the pulled model, the list order of all 50 flex boards equals
  their position order. The old pull had the reverse order for all 50. `verify` checks the 30 flex boards it walks
  against the spec in tree order, and all 30 pass.
- `verify` has a new row, `children in tree order`, for each flex board. The row `children` still compares the
  layout positions.
- Five ellipses read as `other` at first. The backend now returns the type `ellipse`, not `circle`, so the normaliser
  maps both names (KNOWN_GAPS.md, gap 13).
- `fixtures/design.json` is a copy of the new pull. The old copy had the reversed child order, so the golden file
  `src/generate/testdata/ButtonPrimaryMD.golden.tsx` was regenerated with `UPDATE_GOLDEN=1`. The diff changes only
  the node ids and the child indexes of the button.

Commands, run from `C:/dev/penpot/mcp`, output in the session scratchpad:

```sh
npx pnpm --filter mcp-design-parity run start build
npx pnpm --filter mcp-design-parity run start pull
npx pnpm --filter mcp-design-parity run start verify
npx pnpm --filter mcp-design-parity run start generate
npx pnpm --filter mcp-design-parity run start compare --scale 2 --app-browser docker:penpot-mcp-exporter
npx pnpm --filter mcp-design-parity run test
npx pnpm --filter mcp-design-parity run types:check
```

The app build was not run. The notes do not call for it, and `compare` starts its own Vite server.

Summary lines of this run:

- build: `known gaps 17 (see C:\dev\penpot\mcp\packages\design-parity\KNOWN_GAPS.md)`, with node counts Components 228,
  Journey: Onboarding 73, Journey: Dashboard 117, Journey: Settings 106, Journey: Checkout 88. The batches took 10673 ms
  in total.
- pull (second run, after the ellipse fix): `pulled 612 nodes into C:\dev\penpot\mcp\packages\design-parity\out\design.json in 995 ms`
- verify, first run (before the ellipse fix): `checks: 2240, passed: 2235, failed: 5`. The five failures were
  ellipse type checks.
- verify, second run: `checks: 2240, passed: 2240, failed: 0`. Five skipped notes, as before.
- generate: `generated 47 components and 12 screens into C:\dev\penpot\mcp\packages\design-parity\app`
- compare, scale 2, docker screenshots: `DOM mismatches: 0 across 59 targets, pixel over budget: 0 targets, real mismatches: 10 targets, budgets component 1 percent and screen 0.5 percent`.
  Largest component percent 0.24 (Button/Ghost/SM), then 0.17 (Button/Ghost/MD) and 0.12 (Button/Ghost/LG). Largest
  screen percent 0.01 (onboarding/sign-up, checkout/payment and checkout/confirmation). The table above matches
  `out/compare/report.json` row for row.
- test: 201 tests pass, 0 fail (198 before, plus one normaliser test for the ellipse type and two planner tests for
  the child order).
- types:check: exit 0.

## Scale and the screenshot

- `compare --scale <1|2|3>` sets the device scale. The default is 2.
- The export asks Penpot for the same scale. The screenshot uses the same device scale factor.
- The clip stays in CSS pixels. The DOM check also uses CSS pixels, with a 0.5 px tolerance.
- Percentages and cluster sizes count pixels in the scaled image. At scale 2, a cluster of 12 pixels is 12 device pixels,
  which is 3 CSS pixels of area.

## Real mismatch flag

After pixelmatch, the mask holds the red pixels. Pure red marks a differing pixel. Yellow marks anti-aliasing and is not
in the mask. Connected pixels form clusters, using 8-neighbour connectivity. A target is a real mismatch when its
largest cluster is above 12 pixels at the scale used. The threshold is in `src/compare/Clusters.ts`
(`REAL_MISMATCH_CLUSTER`). It is a guess. It is not calibrated.

The measure does not separate glyph anti-aliasing from real errors. Text-heavy targets form large clusters even when
the percent is small. Card has 0.46 percent and a largest cluster of 123 pixels. onboarding/welcome has 0.32 percent
and a largest cluster of 850 pixels. So most targets are flagged. Read the flag as a sign to look, not a verdict.

## Table of targets at scale 2

The table is written from `out/compare/report.json`, the `pixel` array. A target is over budget when its percent is
above its budget. Its real mismatch flag shows whether its largest cluster is above 12 pixels.

| Target | Percent | Largest cluster (px) | Clusters | Real mismatch | Over budget |
| --- | ---: | ---: | ---: | --- | --- |
| Alert/Error | 0.07 | 40 | 2 | yes | no |
| Alert/Info | 0.07 | 40 | 2 | yes | no |
| Alert/Success | 0.07 | 40 | 2 | yes | no |
| Alert/Warning | 0.07 | 40 | 2 | yes | no |
| Avatar/LG | 0 | 0 | 0 | no | no |
| Avatar/MD | 0 | 0 | 0 | no | no |
| Avatar/SM | 0 | 0 | 0 | no | no |
| Badge/Danger | 0 | 0 | 0 | no | no |
| Badge/Primary | 0 | 0 | 0 | no | no |
| Badge/Success | 0 | 0 | 0 | no | no |
| Badge/Warning | 0 | 0 | 0 | no | no |
| Breadcrumb | 0 | 0 | 0 | no | no |
| Button/Danger/LG | 0 | 0 | 0 | no | no |
| Button/Danger/MD | 0 | 0 | 0 | no | no |
| Button/Danger/SM | 0 | 0 | 0 | no | no |
| Button/Ghost/LG | 0.12 | 3 | 24 | no | no |
| Button/Ghost/MD | 0.17 | 3 | 24 | no | no |
| Button/Ghost/SM | 0.24 | 3 | 24 | no | no |
| Button/Primary/LG | 0 | 0 | 0 | no | no |
| Button/Primary/MD | 0 | 0 | 0 | no | no |
| Button/Primary/SM | 0 | 0 | 0 | no | no |
| Button/Secondary/LG | 0 | 0 | 0 | no | no |
| Button/Secondary/MD | 0 | 0 | 0 | no | no |
| Button/Secondary/SM | 0 | 0 | 0 | no | no |
| Card | 0.01 | 3 | 23 | no | no |
| Checkbox/Checked | 0 | 0 | 0 | no | no |
| Checkbox/Unchecked | 0.01 | 1 | 1 | no | no |
| EmptyState | 0 | 0 | 0 | no | no |
| Input/Default | 0 | 0 | 0 | no | no |
| Input/Error | 0.03 | 3 | 24 | no | no |
| Input/Focused | 0.04 | 3 | 24 | no | no |
| Modal | 0.01 | 3 | 24 | no | no |
| NavBar | 0 | 0 | 0 | no | no |
| NavItem/Active | 0 | 0 | 0 | no | no |
| NavItem/Inactive | 0 | 0 | 0 | no | no |
| Pagination | 0 | 0 | 0 | no | no |
| ProgressBar | 0 | 0 | 0 | no | no |
| SideBar | 0 | 0 | 0 | no | no |
| Stat | 0 | 0 | 0 | no | no |
| Table | 0 | 0 | 0 | no | no |
| TableRow/Default | 0 | 0 | 0 | no | no |
| TableRow/Header | 0 | 0 | 0 | no | no |
| TableRow/Selected | 0 | 0 | 0 | no | no |
| Tabs | 0 | 0 | 0 | no | no |
| Toggle/Off | 0 | 0 | 0 | no | no |
| Toggle/On | 0 | 0 | 0 | no | no |
| Tooltip | 0 | 0 | 0 | no | no |
| onboarding/welcome | 0 | 0 | 0 | no | no |
| onboarding/sign-up | 0.01 | 114 | 24 | yes | no |
| onboarding/verify-email | 0 | 0 | 0 | no | no |
| onboarding/done | 0 | 40 | 2 | yes | no |
| dashboard/overview | 0 | 0 | 0 | no | no |
| dashboard/detail | 0 | 3 | 23 | no | no |
| settings/profile | 0 | 48 | 4 | yes | no |
| settings/team | 0 | 0 | 0 | no | no |
| settings/billing | 0 | 40 | 27 | yes | no |
| checkout/cart | 0 | 0 | 0 | no | no |
| checkout/payment | 0.01 | 48 | 7 | yes | no |
| checkout/confirmation | 0.01 | 76 | 35 | yes | no |

## Confirmed cause: the rasteriser of the operating system

The remaining 1 CSS px offsets came from the operating system's text rasteriser. The model, the generated DOM and the
layout match. The app's screenshot must be taken in the same environment as the export, so the pixel step now
screenshots the app in the exporter container (`--app-browser docker:penpot-mcp-exporter`).

Measured on the same page, the Badge/Primary label, at scale 2, `--disable-lcd-text`, element screenshot of the board:

| Where the screenshot is taken | Ink rows (device px) | Ink columns |
| --- | ---: | ---: |
| Exporter container (Linux, Playwright 1.62.1, Chrome 151) | 11 to 27 | 46 to 98 |
| Exporter PNG (the design side) | 11 to 27 | 46 to 98 |
| Windows host Chromium (151 and 153 give the same rows) | 13 to 29 | 46 to 98 |

- The DOM of the exporter's render page is the same as the app's: the same root, paragraph-set, p and span. The p top is
  4.797 CSS px in both. The computed boxes match.
- Playwright and Chromium versions do not explain the difference. The host Chromium gives rows 13 to 29 with the pinned
  Playwright 1.62.1 (Chrome 151) as well. Only the operating system differs.
- Linux FreeType and Windows DirectWrite round the font metrics differently by one device pixel. The labels that were 1 CSS px
  off (Badge, Avatar, Button SM, Tooltip) all had the offset on the host and none in the container.

Consequences:
- The DOM gate (0.5 px, CSS) is the exact check for geometry. It reports 0 mismatches.
- The pixel diff is the raster check. It is only meaningful when the screenshot and the export use the same rasteriser,
  so the app screenshots run in the exporter container, with the same Chromium build and Playwright version as the exporter image.
- The container reaches the host's Vite server at `host.docker.internal`. Vite therefore listens on 0.0.0.0 and accepts that host name
  (`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`).
- The earlier causes below are superseded where they name a glyph, sub-pixel or Chromium-build cause.

## Earlier causes (superseded)

### 1. Glyph differences in text

- Evidence: the diff of Button/Ghost/MD shows differences on the text glyph edges. The label glyph shapes differ
  slightly. The diff of Avatar/SM shows differences on the edges of the initials. Diff images:
  `out/compare/Button-Ghost-MD-diff.png` and `out/compare/Avatar-SM-diff.png`.
- Cause: Penpot exports text in greyscale. Chromium draws the same text with its own glyph shapes and placement. The
  two do not match glyph for glyph. We judged this by eye from the diff image at scale 1. No glyph test was run.
- Other text-bearing targets: 22 over-budget targets carry text. Their notes in `src/compare/PixelCauses.ts` say they
  were not inspected one by one. The same cause may apply to them, but this was not shown for each.

### 2. Sub-pixel placement

- Evidence: in Checkbox/Unchecked, the label Accept terms sits a fraction of a pixel off. Diff image:
  `out/compare/Checkbox-Unchecked-diff.png`. Judged by eye at scale 1.
- The DOM check allows 0.5 px for position and size. A shift below that passes the DOM check, but it still shows in the
  pixel diff.

### 3. Corner edges of rounded boxes

- Evidence: in Checkbox/Unchecked, the corners of the box smooth differently (antialiasing). Diff image:
  `out/compare/Checkbox-Unchecked-diff.png`. Judged by eye at scale 1.
- The DOM check requires the corner radii to match exactly. The radius values match, so the difference is in how the
  edge is drawn.

### 4. Stroke ring

- Evidence: in Button/Ghost/MD, the ring of the stroke differs. Diff image: `out/compare/Button-Ghost-MD-diff.png`.
  Judged by eye at scale 1.
- The generator draws each stroke as a `box-shadow` with the centred geometry that Penpot uses. The DOM check matches
  the stroke width. We saw the ring difference only by eye. We did not measure it further.

### 5. Digits in Stat/Value were wider in the app (fixed)

- Fixed: the variant id for weight 700 is "bold", not "700". Stat/Value went from 2.18 to 0.60 percent. Stat is still flagged real by the cluster rule (largest cluster 82 px).
- The earlier evidence follows.

- Evidence: in the Stat target, the digits of the Value text are drawn wider in the app than in the design export. Diff
  image: `out/compare/Stat-diff.png`. Judged by eye.
- The raw leaf of the text is bold 700. Its `fontVariantId` was "700", which Penpot does not know; the id for 700 is "bold".
- Cause: not found. Candidates: the font face of the export, or Penpot's baseline metrics.

### 6. Tooltip/Label sits lower in the app

- Evidence: in the Tooltip target, the app text of the Label sits about 2 CSS px lower than the design text. Diff image:
  `out/compare/Tooltip-diff.png`. Judged by eye.
- The caption is 12 px with a line height of 1.4, in a 16 px box.
- Cause: not fixed. The candidate is Penpot's baseline placement.

### What the DOM check rules out

The DOM check passes on every target. So the positions, sizes, colours, corner radii and text properties match the
design model. The pixel diffs come from how the browser draws the same model, not from a wrong layout or a wrong value.

## Snapping hypothesis: tested, not confirmed

The hypothesis: the 0.8 px centring offset of a 14.4 px line in a 16 px box is snapped to the device grid differently in the export and in the app. The test changed the line box to an integer and checked whether the 1 CSS px offset went away. It did not.

Measured at scale 2 (device px; CSS px in brackets). Design boxes are relative to the board, from the pulled model.

- Badge/Primary, design: label box y 4, height 16 (integer). Ink top 11 device px (5.5 CSS). Ink left 46, right 98.
- Badge/Primary, app before: root top 4, height 16. Paragraph top 4.797, height 14.39, line-height 1.2. Span line-height 14.4 px. Ink top 13 device px (6.5 CSS). Ink left 46, right 98.
- Badge/Primary, variant A (paragraph line-height 1.3333, line box 16 px): paragraph top 4.000, height 15.98, span line-height 15.9996 px. Ink top still 13 device px. Offset still 1 CSS px.
- Avatar/SM, design: initials box 24 by 24, integer. Ink top 15 device px (7.5 CSS).
- Avatar/SM, app before: root 24 high, span font 10 px, line-height 12 px. Ink top 17 device px (8.5 CSS).
- Avatar/SM, variant A (paragraph line-height 2.4, line box 24 px): span line-height 24 px. Ink top still 17 device px. Offset still 1 CSS px.
- Variant B (Badge font 14 px, line-height 1.142857): the font size changed, so the glyphs no longer match in width (ink 42 to 102 against the design 46 to 98). This run does not test position and is not used.

Conclusion: with an integer line box equal to the box height, the offset stays at 1 CSS px. The 0.8 px centring is not what moves the glyphs. The glyphs sit about 1 CSS px lower in the app than in the export, inside the same box. The mechanism is not identified. This is not confirmed as a renderer snapping difference. Candidate causes not tested: baseline placement from the font's ascent and descent, which Penpot's exporter may compute differently.

The model is not wrong on geometry: the DOM check finds box top, height and left within 0.5 px. The pixel diff is the raster check and shows this glyph offset.

Nothing in the spec or the generator was changed for this test. The generated app was restored by regenerating, and the full compare was rerun: DOM 0 mismatches, 11 components over budget.

## foreignObject test: not confirmed

Question: does Chromium lay out HTML inside an svg foreignObject differently from plain HTML, and so explain the 1 CSS px offset? The test put the app's Badge/Primary label markup in two pages, with the same CSS, the same font faces, Chromium with `--disable-lcd-text` and device scale 2.

- Page A: the app's board as rendered (plain HTML).
- Page B: a clone of the same label root inside `<svg width="72" height="24" viewBox="0 0 72 24"><foreignObject x="8" y="4" width="56" height="16">`, in a 72 by 24 box with the same background, with the position styles removed and the xmlns set.

Ink measured at scale 2 (device px; CSS px in brackets). Ink bounds are the non-background pixels of the label:

| Markup | Alignment | Ink top | Ink bottom |
| --- | --- | ---: | ---: |
| A, app HTML | centred (model) | 13 (6.5) | 29 (14.5) |
| B, foreignObject | centred (model) | 13 (6.5) | 29 (14.5) |
| A, app HTML | top | 11 (5.5) | 27 (13.5) |
| B, foreignObject | top | 11 (5.5) | 27 (13.5) |
| Export (design PNG) | as exported | 11 (5.5) | 27 (13.5) |

Reading:
- Page B does not change the glyph position. Centred, it matches page A and the app. The foreignObject wrapper is not the cause.
- The export matches the top-aligned layout, in both pages. So for this label the exporter drew the text at the top of the box, although the model and the raw data say the content root has `verticalAlign: center`.
- The 1 CSS px offset is therefore a difference in vertical alignment, not a difference in layout inside the foreignObject. The generator follows the model, which says centred. The export does not.
- Not tested: whether the exporter ignores the centre alignment for every text, or only for some. Avatar/SM was not run in this test. Tooltip's top-aligned label measured 2 CSS px lower in the app in an earlier run, which this explanation does not account for, so Tooltip has a second cause that is not identified.

Decision: the foreignObject mechanism is not confirmed, so PixelCauses.ts is unchanged and no spec or generator change was made in this step.

## Browser build pin: tested, no change

Playwright is pinned to 1.62.1, which runs Chromium 151.0.7922.34. The exporter image (penpotapp/exporter:2.18) uses the same version. The pin is kept so that the compare and the exporter move together.

The pin was tested as a cause of the 1 CSS px label offset and did not explain it:

- Compare at scale 2, all 59 targets, with the pinned build: DOM 0 mismatches. The pixel percent and largest cluster of every target are the same as with the earlier build, to two decimals.
- Badge/Primary ink, scale 2, pinned build: app rows 13 to 29 (device px), design (export) rows 11 to 27. Avatar/SM: app rows 17 to 29, design rows 15 to 27. The offset is still 2 device px (1 CSS px).

Reading: the same Chromium build as the exporter gives the same app rendering as before the pin. The browser build alone does not move the label. The export is still higher than the app for the centred labels. The coordinator's report is that the exporter page, rendered in the host Chromium, shows rows 13 to 29, and the exporter container output shows 11 to 27. That is consistent with a difference between the exporter's container and this checkout, which this run did not reproduce. The cause is not identified. Not confirmed here: the DOM dump and the exporter container run were not repeated in this checkout.

## What was tried

- LCD text off. Chromium runs with `--disable-lcd-text`. LCD text adds colour fringes that the greyscale Penpot export
  does not have. The glyph shapes still differ (cause 1).
- Device scale 2 by default. The export and the screenshot use the same scale, so both images share one pixel grid.
- Clip grown by the stroke extent. The screenshot clip is the board grown on each side by the stroke outside it:
  `ceil(w/2)` for a centred stroke, `w` for an outer stroke and 0 otherwise. Penpot's export includes that outside
  part. A 144x40 board with a 1 px centred stroke exports at 146x42 at scale 1, and the clip makes the screenshot the
  same size.
- Box-shadow strokes, not outline or border. A CSS outline was rejected. Blink stores `outline-offset` as an integer,
  so a centred 1 px stroke reads as -1 px. A CSS border changes the box and the child positions. A box-shadow keeps
  both. Inner: inset spread `w`. Centre: inset `w/2` plus outer `w/2`. Outer: outer spread `w`.

## Test run: one planted failure

- The loop ran end to end once. A failing DOM entry for Stat was planted in `out/compare/report.json`. The failure was
  planted in the report, not in the design.
- Result: the loop reran 1 of 59 targets, which was Stat. It converged in 1 iteration and exited with 0.
- This checks the selective rerun and the merge of the report. It is a test of the loop, not a feature.

## Not fixed

No target is over its pixel budget. The ten real-mismatch flags are small edge and antialiasing differences under budget,
with a cause note in `src/compare/PixelCauses.ts`. The budgets stay at 1.0 percent for components and 0.5 percent for screens.
