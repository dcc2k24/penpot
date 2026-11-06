# Design parity

This package builds a design file through the backend MCP. It generates a React app from that file. Then it checks
the app against the design.

## Prerequisites

- The backend MCP runs at `http://127.0.0.1:4405/mcp`. Set `PENPOT_MCP_URL` to use another address.
- A token file holds the MCP access token. Set `DESIGN_PARITY_TOKEN_FILE` to use another file. The package reads the
  token and never prints it.
- A vars file is a JSON object with a `projectId` string. Set `DESIGN_PARITY_VARS_FILE` to use another file.

The defaults are `mcp-token.txt` and `vars.json` in the session scratchpad folder. Both paths are in `src/Paths.ts`.

## Commands

Run every command from `C:/dev/penpot/mcp`:

```sh
npx pnpm --filter mcp-design-parity run start <command>
```

| Command    | Reads                                                | Writes                                |
| ---------- | ---------------------------------------------------- | ------------------------------------- |
| `build`    | token file, vars file, `out/ids.json`                | `out/ids.json`                        |
| `pull`     | `out/ids.json`                                       | `out/raw/*.json`, `out/design.json`   |
| `verify`   | `out/design.json`                                    | nothing                               |
| `generate` | `out/design.json`                                    | the generated files in `app/`         |
| `compare`  | `out/design.json`, `app/`                            | `out/compare/`                        |
| `loop`     | `out/design.json`, `app/`, `out/compare/report.json` | `app/`, `out/compare/`                |

Run the commands in this order: `build`, then `pull`, then `verify`.

### build

`build` creates a new file and fills it from the spec. It records the ids in `out/ids.json`. It first deletes the
file that the earlier build recorded, if there is one. `--reset` is accepted for compatibility and changes nothing.
At the end, `build` prints the file id, the node count of each page, the time of each batch and the number of known
gaps.

### pull

`pull` reads the file that the last build recorded. It deletes the old `out/raw/` folder, then writes one raw response
per file there. It writes the normalised model to `out/design.json`. It prints one line per step with its duration,
then the node count of each page and a total. It fails with a message when no build was recorded.

### verify

`verify` reads `out/design.json` and prints a table of checks with the columns check, expected, actual and status. It
prints a summary line, then one `skipped:` line for each value that the backend does not return. It exits with 1 when
a check fails, and with 0 otherwise. When `out/design.json` is missing, it prints `run pull first` and exits with 1.

`verify` reads the last pull only. After a new build, run `pull` again. Otherwise `verify` checks the file from the
older build.

### generate

`generate` writes the React app into `app/` from `out/design.json`. It writes:

- `src/components/`: one module per design component. The current design has 47.
- `src/screens/<Journey>/<Screen>.tsx`: one module per screen. The current design has 12.
- `src/tokens.css`, `src/typography.css`, `src/routes.tsx`, `src/runtime.ts` and `index.html`.
- `app/public/fonts/`: copies of the font files that the app uses.

`src/typography.css` starts with the `@font-face` rules for Source Sans Pro. The rules load the copies from `/fonts/`.
The generator copies the files from `PENPOT_FONT_DIR`, which defaults to `frontend/resources/fonts` in the Penpot
repository. It stops with a message when a file is missing. The copies are not committed, because `.gitignore` lists
`app/public/fonts/`.

It never touches `app/package.json`, `app/tsconfig.json`, `app/vite.config.ts` or `app/src/main.tsx`. The output is
deterministic: the same design gives the same bytes.

To build the app, run `npx pnpm --filter design-parity-app run build` from `C:/dev/penpot/mcp`.

### compare

`compare [--screen <name>] [--scale <1|2|3>] [--no-pixel]` starts the Vite dev server on a free port. It opens each route
at 1440x900 CSS pixels. For each design node, it finds the rendered element by `data-node-id`, then checks the element
against the model:

- position and size within 0.5 px
- colours exact, as `#RRGGBB` plus alpha
- corner radii exact
- font size, family, weight, line height, letter spacing, alignment and text content exact

A text box whose size differs gives an info line, not a mismatch. The backend does not return opacity (gap 12), so
opacity gives an info line too.

The exit code is the DOM gate. It is 0 when there are no DOM mismatches, and 1 otherwise.

`--screen` takes a route id, such as `onboarding/welcome`, or a target name, such as `Button/Primary/MD`. `--no-pixel`
skips the pixel step. `--scale` sets the device scale of the pixel step: 1, 2 or 3. The default is 2. The DOM check
always uses CSS pixels, with the 0.5 px tolerance.

The pixel step fetches the Penpot PNG of each board with `export_shape`, at the same scale. It takes a Playwright
screenshot of the same board, with the device scale factor set to the same scale. The clip stays in CSS pixels. The
step flattens both images over white, pads both to the larger size, and compares them with pixelmatch at threshold
0.1. Percentages are relative to the scaled image.

The budgets are 1.0 percent for a component and 0.5 percent for a screen. A target over its budget shows OVER BUDGET
in the table and in the HTML report. The report also shows the cause note from `src/compare/PixelCauses.ts`.

After pixelmatch, the mask holds the red pixels. Pure red marks a differing pixel. Yellow marks anti-aliasing and is not
in the mask. Connected pixels form clusters, with 8-neighbour connectivity. For each target, the step records the size
of the largest cluster in pixels (`largestCluster`) and the number of clusters (`clusters`). A target is a real
mismatch when its largest cluster is above 12 pixels at the scale used. The threshold is in `src/compare/Clusters.ts`
(`REAL_MISMATCH_CLUSTER`). It is a guess, not a calibrated value.

The real mismatch flag does not separate glyph anti-aliasing from real errors. Text-heavy targets form large clusters
even when the percent is small, so most targets are flagged. Read the flag as a sign to look, not a verdict. See
`PARITY-NOTES.md` for the table.

Chromium runs with LCD text off, so glyphs are greyscale like the Penpot export. The screenshot clip is the board grown
on each side by the stroke that lies outside it: `ceil(w/2)` for a centred stroke, `w` for an outer stroke and 0 for
any other. Penpot's export includes that outside part, so the two images match in size.

Pixel results never change the exit code. When the export returns an empty PNG (gap 15), the target shows as
unavailable.

### loop

`loop [--max <n>] [--all]` runs `generate`, then the DOM compare, and prints the mismatch count. It exits with 0 when
there are no DOM mismatches. The loop does not fail on pixel results.

By default the loop reruns only the targets that failed in the last report. A target failed when its DOM mismatch
count in `out/compare/report.json` is above 0. The new results merge into the report, so the targets that did not
rerun keep their old entries. The loop reruns every target when:

- no target failed in the last report,
- there is no usable report,
- the report comes from another pull, or
- the report lacks a target.

`--all` reruns every target on each iteration.

A test run planted one failing DOM entry for Stat in the report, not in the design. The loop reran 1 of 59 targets,
converged in 1 iteration and exited with 0. This is a note on the test run, not a feature of the loop. `PARITY-NOTES.md`
has the details.

When mismatches remain, it groups them by attribute and prints a class for each group. Position and size attributes
also get the hint `check flex layout`. Then it exits with 1. It does not fix anything. Change the generator or the
puller by hand, then run `loop` again.

`--max` sets the iteration limit. It takes a value from 1 to 20. The default is 5. Nothing changes between
iterations, so the loop stops at the first run that has mismatches.

## Reading the report

`out/compare/report.html` is self-contained. Open it in a browser. It has two tables:

- A summary row for each target. It shows the node count, the DOM mismatches, the info count and the pixel result.
  The pixel result is a percent, the reason the pixel step did not run, or a size note. A percent over the budget
  also shows OVER BUDGET.
- A row for each DOM mismatch. It shows the node id, the node name, the path, the attribute, the design value and the
  implemented value.

A real mismatch list follows the tables. It names each target whose largest cluster is above 12 pixels, with its
percent, its largest cluster and its cause note. A summary row also shows the largest cluster and the cluster count.
Each row carries a REAL MISMATCH flag when it applies.

`out/compare/report.json` holds the same data. Its `scale` field gives the device scale of the run. Each entry of the
`pixel` array has `percent`, `budget`, `overBudget`, `largestCluster`, `clusters`, `realMismatch`, `cause` and the
`files` of the run. Each diff image is `out/compare/<target>-diff.png`, with `<target>-design.png` and
`<target>-app.png` beside it. In the target name, `/` becomes `-`.

## Known differences

The DOM gate is exact. The pixel diff has known causes, so read the pixel percent with them in mind. `PARITY-NOTES.md`
gives the evidence for each cause.

- Strokes are box-shadows. The generator assumes a centred stroke, which is the Penpot default, because the backend
  does not return the stroke alignment (gap 16). The stroke geometry is the same as a centred stroke in Penpot.
- Text glyphs are drawn differently. Penpot exports greyscale text. Chromium draws the same text with its own glyph
  shapes and placement. LCD text is off in the screenshot, so the glyphs have no colour fringes.
- Corner edges of some rounded boxes are smoothed differently (antialiasing).
- Fonts are local files, not Google Fonts. The app loads Source Sans Pro from `/fonts/`, so the result does not depend
  on the network.

At scale 2, 18 components are over their 1.0 percent budget, and all 12 screens are under 0.5 percent. The causes above
are not fixed. `PARITY-NOTES.md` lists the causes and the per-target table.

## Where the app is screenshotted

The pixel step takes the app's screenshots in the exporter container, so that the app and the Penpot export are
rendered by the same browser and the same operating system. The default is `--app-browser docker:penpot-mcp-exporter`
when that container is running. Otherwise the screenshots use the local Chromium. Pass `--app-browser local` to force
the local Chromium, which is not comparable with the export on Windows, or `--app-browser docker:<container>` for another container.

Why: the Linux text rasteriser and the Windows one round glyph metrics one device pixel apart. A screenshot taken on
the Windows host therefore differs from the export by one device pixel for labels. The DOM gate is unaffected.

How the container run works:
- The app is served by Vite on 0.0.0.0, so that the container can reach it at `http://host.docker.internal:<port>`.
  Vite must accept that host name. The package sets `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=host.docker.internal` for the
  server, otherwise Vite answers 403 to the container.
- A small ESM worker is copied into the container under `/tmp/design-parity/<run id>`. It runs with the Playwright
  of the exporter image at `/opt/penpot/exporter/node_modules/playwright/index.mjs`, uses one browser for all targets,
  waits for the board and `document.fonts.ready`, and writes one PNG per target. The folder is copied back and removed in the container.
- The DOM compare keeps using the host's Chromium on `127.0.0.1`. It is unaffected by this change.

The pixel screenshots use a viewport of 1456 by 916 CSS px (`PIXEL_VIEWPORT` in `src/Targets.ts`), 16 px larger than the
DOM viewport. The app body has the browser's 8 px margin, so a 1440 by 900 board would otherwise run past the viewport and its
edge would be cut off.

## Browser build

The pixel step uses Playwright, which is pinned to exactly 1.62.1 in `package.json`. That version ships Chromium
151.0.7922.34. The exporter image (penpotapp/exporter:2.18) also ships Playwright 1.62.1, so the compare and the
exporter run the same browser build. The two must move together: when the exporter moves to another Playwright
version, change this pin in the same change, then reinstall the browser with
`npx pnpm --filter mcp-design-parity exec playwright install chromium`.

The pin does not move the pixels by itself. The offset of some labels comes from the operating system's text rasteriser, and the pixel step therefore runs in the exporter container (see "Where the app is screenshotted" above). See `PARITY-NOTES.md`.

## Tests

Run the tests from `C:/dev/penpot/mcp`:

```sh
npx pnpm --filter mcp-design-parity run test
```

Run the type check from `C:/dev/penpot/mcp`:

```sh
npx pnpm --filter mcp-design-parity run types:check
```

## Known gaps

`KNOWN_GAPS.md` lists what the backend MCP does not do, or does in a way that differs from the spec. Each entry names
the tool, the input, the symptom and the workaround. Gaps 7, 11 and 12 cause the `skipped:` notes that `verify`
prints.

The gaps that shape the generated app are:

- Gap 4, flex child order, is closed. The flag `NATURAL_CHILD_ORDER` in `src/OperationPlanner.ts` is `true`: the
  compiler and the planner both use creation order as visual order.
- Gap 6, token types. One function, `backendTokenType` in `src/TokenTypes.ts`, maps the spec names.
- Gap 16, stroke alignment. The generator assumes a centred stroke.
- Gap 17, text alignment. The backend stores it on the paragraph, and the Normaliser reads the paragraph.

## Layout

`src/index.ts` routes the commands. `src/LoopCommand.ts` runs the loop. `src/compare/` holds the compare, and
`src/generate/` holds the generator. `src/Paths.ts` holds the file paths. The spec is in `src/DesignSpec.ts`, the
builder in `src/DesignBuilder.ts`, the puller in `src/Puller.ts` and the verifier in `src/Verifier.ts`.
