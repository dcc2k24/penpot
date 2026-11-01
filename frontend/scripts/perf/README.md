# Large design generator

## What it builds

The script makes a new file in your default project. It runs the large-design plugin on that file.

- Design System page: 37 components, from buttons and badges up to tables, a calendar, kanban columns and popups.
- Screen pages: `--screen-pages` (default 4, may be 0). Each page has `--screens-per-page` screens (default 30). Screen pages cycle through these screen kinds in this order: Dashboard, Users, Wizards, Settings, Login / Onboarding, Detail, Kanban, Calendar and Reports.
- Popups: about 30% of screens show an open popup: a dropdown menu, a tooltip, a notification list or a date picker.
- Table rows: `--table-rows` (default 12).
- Enterprise app page: `--single-page-screens` (default 0). It adds one page named "Enterprise app" with that many screens of every kind. The screens sit on one canvas, grouped by kind into titled sections. Screens are 1440 px wide; most are 1800 px tall, while Login / Onboarding, Kanban, Calendar and Detail screens are shorter.

## How to run it

Start the Penpot backend and frontend first. They must answer at `PENPOT_BASE_URL` (default `http://localhost:3450`). Run this from the repo root:

    node frontend/scripts/perf/generate-large-design.mjs --screens-per-page 30

For a quick test, run the small form:

    node frontend/scripts/perf/generate-large-design.mjs --screen-pages 1 --screens-per-page 2 --table-rows 3

Flags:

- `--screen-pages N`: screen pages to create (default 4, may be 0).
- `--screens-per-page N`: screens on each screen page (default 30).
- `--table-rows N`: rows in each table (default 12).
- `--single-page-screens N`: screens on the extra "Enterprise app" page (default 0). Fine for small pages, up to about 50 screens.
- `--seed N`: random seed (default 42).
- `--build-single-page N`: build an Enterprise app page of N screens in batches. Needs `PENPOT_BENCH_FILE_INFO`. See the batched section below.
- `--batch N`: screens per batch for `--build-single-page` (default 50).
- `--append-to PATH`: add one batch of screens to the file described by the file info JSON at `PATH`.
- `--append-screens N`: screens to add with `--append-to` (default 50).
- `--themed`: add token themes Light, Dark and Mid. Binds colour and radius tokens to the shapes it makes. Light matches the unthemed colours. See "Themed files".
- `--verify-theme NAME`: check the file at `PENPOT_BENCH_FILE_INFO` against theme NAME. Checks every page, exits `1` on any mismatch and changes nothing. See "Themed files".
- `--headed`: show the browser window.
- `--help`: print the usage and exit.

`--build-single-page` and `--append-to` cannot be used together. `--verify-theme` cannot be used with either of them.

Install `@playwright/test` where Node can find it from this folder. Or set `PENPOT_BENCH_NODE_MODULES` to a folder whose `node_modules` holds it.

## Recipes

Run these from the repo root.

Very large, 120 screens on four pages:

    node frontend/scripts/perf/generate-large-design.mjs --screen-pages 4 --screens-per-page 30

Extreme single canvas, 300 screens on one page: use the batched build below. A single run of that size fails to save.

A single run with more than 200 screens gets a 3 hour plugin timeout and a 30 minute save wait. Runs with 200 or fewer keep the 60 minute plugin timeout and the 10 minute save wait.

## Themed files

`--themed` adds three token themes: Light, Dark and Mid. Each theme has a token set with 20 colour tokens and 4 radius tokens. The themes sit in the group "Mode". Light is active.

The script binds the tokens to the shapes:

- Design System components. Copies of a component inherit the bound tokens.
- Shapes on the screens.
- Text, fill and stroke colours, icons included.

Gradients and shadows stay fixed.

The script makes the tokens and binds them only after every screen exists, one page at a time, Design System first. Copies get the bindings from their components through component sync. It waits because Penpot runs a token update over the whole file each time a component copy is made, once the file has tokens. Binding during the build made a 10-screen page take 300 s instead of 110 s, and a 120-screen build ran past the 60 minute timeout. For the same reason, `--append-to` on a themed file is slow: every copy it makes runs that update.

Build the 120-screen themed file (bash):

    PENPOT_BENCH_FILE_INFO=~/penpot-bench/themed-file.json node frontend/scripts/perf/generate-large-design.mjs --screen-pages 4 --screens-per-page 30 --themed

Build the 120-screen themed file (PowerShell):

    $env:PENPOT_BENCH_FILE_INFO = "$HOME\penpot-bench\themed-file.json"
    node frontend/scripts/perf/generate-large-design.mjs --screen-pages 4 --screens-per-page 30 --themed

Check the themed file against a theme (bash):

    PENPOT_BENCH_FILE_INFO=~/penpot-bench/themed-file.json node frontend/scripts/perf/generate-large-design.mjs --verify-theme Dark

Check the themed file against a theme (PowerShell):

    $env:PENPOT_BENCH_FILE_INFO = "$HOME\penpot-bench\themed-file.json"
    node frontend/scripts/perf/generate-large-design.mjs --verify-theme Dark

Verify checks every page. It prints:

- the theme, with its `checked` and `mismatched` counts
- coverage: how many coloured shapes have a colour token
- one line for each page
- up to 10 mismatch examples

Verify changes nothing, and it does not write the file info. It exits `0` when every checked colour matches. It exits `1` on any mismatch, or when no bound shape is found.

## Extreme single canvas (batched)

One browser tab cannot build and save a 300-screen page. Saves slow down as the tab grows. Reading a file that big back over JSON also breaks Node's string size limit. So the script builds the page in batches. Each batch runs in a fresh browser. After each batch, the script counts the screens on the page. A batch that does not add the expected number of screens fails the run.

Build 300 screens in batches of 50 (bash):

    PENPOT_BENCH_FILE_INFO=~/penpot-bench/extreme-file.json node frontend/scripts/perf/generate-large-design.mjs --build-single-page 300 --batch 50

Build 300 screens in batches of 50 (PowerShell):

    $env:PENPOT_BENCH_FILE_INFO = "$HOME\penpot-bench\extreme-file.json"
    node frontend/scripts/perf/generate-large-design.mjs --build-single-page 300 --batch 50

What a run does:

- The first run makes a file in your default project. It builds the Design System page and an empty Enterprise app page. It writes the file info to the path in `PENPOT_BENCH_FILE_INFO`.
- Each batch adds `--batch` screens. The last batch may be smaller. After each batch, the script saves the file info and prints `[bench] progress N/300 screens`.
- When the count reaches the target, the script prints `[bench] verified COUNT 300` and the file info as the last line.

To resume, run the same command again. The script reads the saved file info, counts the screens on the page and continues from that count. The seed, table rows and layout capacity come from the saved file info, so every batch of one file uses the same values.

To add more screens later, run one batch with `--append-to`:

    node frontend/scripts/perf/generate-large-design.mjs --append-to ~/penpot-bench/extreme-file.json --append-screens 100

In PowerShell, use `--append-to "$HOME\penpot-bench\extreme-file.json"`.

### File info fields

The file info is a JSON file with these fields:

- `fileId`, `teamId`, `projectId`: ids of the file, its team and its project.
- `url`: opens the Enterprise app page.
- `pages`: the pages that the init run reported.
- `seed`, `tableRows`: values for the plugin. Every batch uses them.
- `layoutCapacity`: the screen count the sections were sized for. The first build sets it. If you build more screens later than this count, the script prints a `[bench] warning:` line.
- `enterprisePageId`: id of the Enterprise app page.
- `enterpriseScreens`: screens on that page after the last batch.
- `batches`: batches added so far.
- `generationSeconds`: total time of the init run and the batches.
- `themed`, `themes`: set by `--themed`. `themes` lists the theme names.

## Settings

- `PENPOT_BASE_URL`: the app address.
- `PENPOT_BENCH_CREDENTIALS`: the login file. Default `~/penpot-bench/bench-user.json`. If it is missing, the script creates it and registers a new user.
- `PENPOT_BENCH_FILE_INFO`: a path. The script also writes the result there. `--build-single-page` needs it, and it holds the file info for the batched build. `--verify-theme` only reads it.
- `PENPOT_BENCH_NODE_MODULES`: a folder with a `node_modules` that holds `@playwright/test`.

## Output

The last stdout line is one JSON object: `fileId`, `teamId`, `projectId`, `pages`, `url` and `generationSeconds`. With `--themed`, it also has `themed` and `themes`. With `--build-single-page` or `--append-to`, the last line is the file info instead. With `--verify-theme`, the last line is the verify result, and the file info is not written. `generationSeconds` is the time from plugin start to the end of the backend check, in seconds. Earlier lines start with `[large-design]` (plugin), `[large-design-warn]` (plugin warnings) or `[bench]` (script). The plugin prints a `[large-design] progress N/M screens` line every 25 screens.

## Exit codes

- `0`: the plugin finished and all saves finished. With `--verify-theme`, every checked colour matches.
- `1`: the plugin failed, a step timed out, or another error happened. With `--verify-theme`, a colour does not match, or no bound shape is found.
- `2`: bad arguments. `--help` prints the usage and exits `0`.
