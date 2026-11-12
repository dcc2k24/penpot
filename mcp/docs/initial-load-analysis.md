# Initial load of a large file - analysis and plan

Date: 2026-11-12 (VM `Standard_D16ps_v6`, images `e49532867d`, frontend `eecd0ba8f7`).
Subject: Azure file `b48cc9bd-bdae-8000-8008-eb67a08dd490` ("exported-views"), page `c54dcb4e-6001-5521-83dc-e18bd52d20ab`
("Journeys - (800x600) - MEDIUM - VARS ..."), linked library "KAM - COMPONENTS" `b48cc9bd-bdae-8000-8008-eb67a08dd48f`.

No code, config, Azure resource or Penpot data was changed for this analysis, with one exception that was not intended.
The first browser trace (run A below) let the app send its own on-open `update-file`, which moved the file from revn 165 to 166.
That change was 2.7 KB, a fixup that the frontend makes when an editor opens the file. (Review: it was most likely position data, not a text resize. Run A's profile has about 0.3 s in `position-data` code just before it and no `resize-wasm-text`/`update-shapes` samples at all.)
All later runs blocked every write RPC. `revn` was re-checked afterwards and is still 166.

## 1. Summary

On this client, the user waits "a couple of minutes" on the tips screen because of **HTTP/3 over the Cloudflare WARP path**, not because of Penpot itself.
- Caddy advertises h3, and Chrome switches to QUIC after the first request.
- From this UK client, which goes out through Cloudflare WARP, the QUIC path runs at about **0.36 MB/s**. The review re-measured this on a static asset: 0.33-0.52 MB/s over h3, against 8-9 MB/s over h2.
- TCP (HTTP/2 or HTTP/1.1) runs at about **11-14 MB/s**. That is 20-40 times faster.
- So the 56 MB gzipped `get-file` takes **157 s** over h3, against **5.3 s** over h2.
- **The fault is on the path, not the VM.** Inside Caddy's network namespace, `UdpRcvbufErrors` and `UdpSndbufErrors` stay at 0 during h3 transfers. So it is not proven that a client off WARP sees slow h3. For such a client, the Penpot-side stages below are the whole story. Turning h3 off costs nothing either way (Q1).

With h3 out of the way, the file still takes **at least 58 s** until the UI stops freezing. The traces stopped as soon as the last big long task ended (see the caveats in section 2), so later work was not observed:

| Stage | Time |
|---|---|
| Tips screen | 14 s |
| Shape upload, which is held up by a 10-11 s library-sync check | 19 s more |
| Text relayout cascade after fonts arrive, which freezes the main thread | 17-27 s more |

Three things make every stage bigger than it needs to be:
- The file holds **12 pages and about 152,000 shapes** (324 MB of transit). The page being opened is only 19% of that.
- Penpot downloads every page, and the library-sync check walks every page.
- The browser does not cache the 56 MB encoded response, so every open downloads it again. Any write on open (revn bump) would also invalidate its ETag.

| Cold open (measured) | Tips screen hidden | First full frame | Main thread quiet ("usable") |
|---|---|---|---|
| Default browser, h3 (what the user sees) | **189 s** | 202 s | 215 s or later (trace stopped there) |
| Same, QUIC disabled (h2) | **14 s** | 36 s | **58 s or later** (trace stopped there) |
| Warm cache, QUIC disabled | 12 s (from tab open) | 34 s | 65 s or later (trace stopped there) |

## 2. How it was measured

| Tool | What it gave |
|---|---|
| Playwright (`playwright-core` 1.64.1, bundled Chromium, **real GPU**: NVIDIA RTX A2000 Laptop via ANGLE/D3D11, 1920x1080, headless) | Logged in through the API. Opened `/?screen=workspace&team-id=…&file-id=…&page-id=…` in a fresh context. Recorded CDP Network events (request start, headers received, end, encoded bytes, protocol), lifecycle marks (loader shown/hidden, `penpot:wasm:loaded`, `penpot:wasm:set-objects`, `penpot:wasm:tiles-complete`), long tasks (`PerformanceObserver`), and a main-thread CPU profile sampled at 1 ms. The run ends when set-objects and the first tiles are done and the main thread has been quiet for 8 s. |
| Node HTTPS client (HTTP/1.1) from the same UK laptop | Timing of the API calls one by one, plus static asset sizes, encodings and headers. |
| `az vm run-command` (read-only) | Postgres sizes and features, Caddy logs, nginx config inside the frontend container, sysctl, `docker stats`. |
| Local benchmarks on the downloaded `get-file` body (deleted afterwards) | gzip, brotli and zstd sizes and speeds; `JSON.parse` time; breakdown by page. |

Scripts (no secrets inside; the password is read from `backup/new-password.txt` at run time) are in `C:\Users\dacoll\AppData\Local\Temp\penpot-load\`:
- `trace.mjs` is the browser trace. Set `ARGS=--disable-quic` to force TCP.
- `api.mjs` times the API calls.
- `static.mjs` surveys the static assets.
- `prof.mjs` attributes the CPU profile by time window.

The raw `*-net.json`, `*-marks.json` and `*.cpuprofile` files are next to them.

Caveats:
- The trace polls the DOM once per animation frame to detect the loader. That costs about 1 s of main-thread time over a whole run.
- Playwright's `route()` turns off the HTTP cache, so run D's "warm" run is not really warm. Run C blocks writes through CDP `Fetch` instead and keeps the cache on.
- The client machine has a fast laptop GPU. A slower machine will be slower in the client stages.
- **The "quiet for 8 s" stop rule did not work** (found in review). A `page.evaluate` poll queued behind a long task returns before the `PerformanceObserver` records that task. So it sees the previous task as the last one and stops. Each CPU profile ends within about 1.5 s of the last big long task (run A at about 215 s, B at about 58 s). The "quiet"/"usable" times are lower bounds. Fix: poll from inside the page with `setTimeout` after the observer callback has run, or stop on wall-clock time.
- **`prof.mjs` counts each sample as 1 ms**, but under load Chrome sampled every 1.6 ms or so. Its "profile time" figures are about 40% too low. The review's numbers below come from weighting by `timeDeltas`.

### Runs

| Run | Protocol | Writes | Notes |
|---|---|---|---|
| A `az1` | default (h2 for the HTML, then **h3**) | not blocked | The user's experience. It sent the 2.7 KB `update-file`. |
| B `az3` cold | `--disable-quic` (h2) | blocked via CDP Fetch | Cold cache. |
| C `az3` warm | `--disable-quic` (h2) | blocked | New tab in the same context, so the disk cache is warm. |
| D `az2` cold | `--disable-quic` (h2) | blocked via `route()` | Repeat of B, which confirms B. |

## 3. Measured timelines (seconds from navigation)

### Run A - default browser (HTTP/3). This is what the user sees.

| t (s) | Event | Source |
|---|---|---|
| 0 - 3.06 | HTML (h2, first connection, TTFB 3.0 s) | measured, CDP |
| 3.0 - 10.1 | CSS and JS; `shared.js` 2.51 MB gz **took 6.4 s over h3** | measured |
| 10.8 - 11.1 | `get-environment-data`, `get-profile`, `get-teams`, `get-team-members` (about 70 ms each) | measured |
| 11.0 - 16.6 | `main-workspace.js` 0.87 MB gz, 5.5 s over h3 | measured |
| 11.1 - 26.4 | `render-wasm.wasm` 4.18 MB gz, **15.3 s over h3** | measured |
| 17.0 | Tips screen appears. `get-comment-threads`, `get-profiles-for-file-comments`, `get-font-variants` | measured |
| 26.5 | WASM module ready, **then** `get-file` is sent (it waits for the WASM) | measured |
| 27.7 | `get-file` first byte (1.2 s) | measured |
| 27.7 - 185.1 | `get-file` body: **56.2 MB gz (324.4 MB raw) in 157 s = 0.36 MB/s** | measured |
| 34 - 49 | `fonts-preview-sprite.svg` (2.6 MB gz) shares the same slow link | measured |
| 185.1 - 189.2 | Long task 3.7 s: `.text()`, transit decode (about 1.5 s of profile time) and page init | measured |
| 189.2 | **Tips screen hidden** | measured |
| 189.3 - 202.6 | Library `get-file`, 3.9 MB gz / 22.5 MB raw, 13.3 s over h3 (it only starts after the main file) | measured |
| 189.3 - 198.9 | WASM shape upload of 28.7k shapes; `set-objects` at 198.9 | measured |
| 201.5 | First full tile pass | measured |
| 204.5 - 215 | 10.5 s long task: library-sync check `generate-sync-file-changes`, about 10.3 s of it when weighted by sample time | measured |
| 204.5 | App POSTs `update-file` (2.7 KB, probably position data; see the note at the top), which created revn 166 | measured |
| about 215 | The trace stopped immediately because of the stop-rule bug. The text cascade seen in runs B-D was probably still to come. | measured stop; the cascade is a guess |

### Run B - cold cache, QUIC disabled (HTTP/2)

| t (s) | Event | Source |
|---|---|---|
| 0 - 0.95 | HTML, CSS, `libs.js`, `main.js`, `shared.js` (2.5 MB in 0.39 s) | measured |
| 1.6 - 2.1 | `get-environment-data`, `get-profile`, `get-teams`, `get-team-members`, `get-access-tokens` | measured |
| 2.1 - 3.0 | `main-workspace.js` (0.2 s), `render-wasm.wasm` (4.18 MB in 0.85 s) | measured |
| 3.0 | Tips screen shown; WASM ready at 3.1 | measured |
| 3.8 → 4.6 → 9.9 | `get-file`: first byte after 0.8 s, then **56.5 MB gz in 5.25 s (10.8 MB/s)** | measured |
| 9.9 - 14.0 | Long task 3.6 s: decode and page init | measured |
| **14.0** | **Tips screen hidden**. The layers panel is visible; the canvas is a solid-colour placeholder. | measured |
| 14.2 - 16.1 | Library `get-file` (3.95 MB gz) | measured |
| 17.3 - 28.4 | **11.1 s long task: library-sync check** (`maybe-sync` → `generate-sync-file-changes`, about 10.9 s of it time-weighted). It stalls the shape upload. | measured |
| 32.7 | `set-objects`: all 28.7k shapes uploaded to WASM | measured |
| 35.7 | First full frame | measured |
| 39.6 - 56.8 | **17.2 s long task: text resize cascade** (time-weighted: `apply-wasm-modifiers` 7.3 s, of which `calculate-ignore-tree-wasm` 7.1 s; `update-shapes` 5.3 s; lazy `transit/decode-str` of shapes 6.5 s; `aclone` 3.0 s; overlapping) | measured |
| **about 58** | The trace stopped (stop-rule bug). The main thread was not shown to be quiet afterwards. | measured stop |

Run D (the same conditions) gave: tips hidden at 13.3 s, `set-objects` at 29.7 s, long tasks of 10.3 s (sync) and 23.5 s (cascade), trace stopped at about 62 s.

### Run C - warm cache, QUIC disabled

- **Static assets:** all came from the disk cache (7-day `max-age` with a `?version=` query).
- **Library `get-file`:** revalidated by ETag, 0 bytes on the wire.
- **Main `get-file`:** downloaded again in full, 56.5 MB in 6 s. Chrome did not keep the 56 MB encoded entry in its HTTP cache (its per-entry limit is a fraction of the disk cache size, and the 3.95 MB library entry was kept), so the backend ETag never helps.
- **Timeline:**

  | t (s) | Event |
  |---|---|
  | 12.0 | Tips hidden |
  | 30.7 | `set-objects` |
  | 33.5 | First frame |
  | 36.6 | 26.5 s cascade long task starts (time-weighted: `apply-wasm-modifiers` 11.2 s, `update-shapes` 7.8 s, `decode-str` 8.3 s) |
  | about 65 | Trace stopped (stop-rule bug) |

  A warm cache saves only about 2 s.

## 4. Measurements by layer

### 4.1 Network (UK, Cloudflare WARP, to Sweden Central)

| Item | Value | Source |
|---|---|---|
| TCP connect | 65-80 ms. ICMP is blocked. | curl |
| Small RPC round trip on a warm connection | 41-50 ms | node, CDP |
| TCP throughput, one stream, uncompressed | 13.5-13.8 MB/s (shared.js 23.2 MB in 1.7 s, main-workspace 7.6 MB in 0.55 s) | node |
| `get-file` gzip stream over TCP | 10.8-11.1 MB/s of wire bytes | node, CDP |
| **HTTP/3 (QUIC) throughput** | **0.36-0.4 MB/s** (get-file, shared.js, wasm) | CDP run A |
| Path | The client egress IP is 104.28.x (Cloudflare WARP). The client reports `warp-cli status: Connected`. | measured |
| Caddy at startup | `failed to sufficiently increase receive buffer size (was: 1024 kiB, wanted: 7168 kiB, got: 2048 kiB)`. VM `net.core.rmem_max=1048576`, `wmem_max=4194304`. | VM logs |
| Protocols | Caddy v2.11.9 serves h1, h2 and h3 and sends `alt-svc: h3=":443"; ma=2592000`. Compose publishes `443:443/udp`. | measured |

The cause of the slow QUIC is not proven, but the review narrowed it down:
- **VM UDP buffers are not the cause.** The quic-go warning is about the *receive* buffer, which matters for uploads and ACKs, not for this download. Inside Caddy's network namespace (`nsenter -t <caddy pid> -n nstat`), `UdpRcvbufErrors`, `UdpSndbufErrors` and `UdpInErrors` stayed at **0** across a 6.7 MB h3 transfer that ran at 0.38 MB/s.
- **The path is the likely cause.** QUIC is carried end to end inside the WARP tunnel, which has a reduced MTU and can lose packets. TCP through WARP is probably proxied at Cloudflare's edge, which would explain why TCP is unaffected (likely, not verified).
- **A second, unexplained h3-mode effect.** With QUIC enabled, the very first request (HTML, or `config.js` in the review's probe) took 3.0-3.5 s, against 0.4 s with `--disable-quic`. This was seen twice. Q1's verification will show whether it goes away when the server stops advertising h3.

### 4.2 Static bundle (served by the frontend nginx, then Caddy)

| Asset | Raw | gzip on the wire | Cache-Control |
|---|---|---|---|
| `/` index.html | 0.30 MB | 73 kB | `no-store` |
| `css/main.css` | 1.91 MB | 146 kB | `public, max-age=604800` |
| `js/libs.js` | 5.98 MB | 1.69 MB | 7 days |
| `js/shared.js` | 23.2 MB | 2.51 MB | 7 days |
| `js/main.js` | 2.60 MB | 311 kB | 7 days |
| `js/main-workspace.js` | 7.58 MB | 864 kB | 7 days |
| `js/worker/main.js` | 4.07 MB | 932 kB | 7 days |
| `js/render-wasm.wasm` | 11.07 MB | 4.18 MB | 7 days |
| `js/render-wasm.js` | 113 kB | 23 kB | 7 days |
| `fonts/fonts-preview-sprite.svg` (loaded after the first frame) | 15.6 MB | 2.6 MB | 7 days |
| Text fonts (7 × `internal/gfonts`) + WorkSans | about 1.2 MB | about 0.9 MB | 7 days |

- **Total for a cold workspace boot:** about 13 MB on the wire (about 70 MB raw). Over h2 this takes about 1.5-2 s, against about 25 s over h3. On a warm cache it is 0.
- **Compression:**
  - nginx `gzip on; gzip_comp_level 6; gzip_proxied any; gzip_static on`.
  - `gzip_types` includes `application/transit+json` and `application/wasm`.
  - There are **no `.gz` files** in `/var/www/app/js`, so `gzip_static` has nothing to serve and everything is gzipped again on each request.
  - nginx has no brotli.
  - Caddy's `encode zstd gzip` never runs, because nginx has already compressed the response.
- **Bundle names** are not content-hashed. They carry `?version=<tag>` in the import map, which is enough for correct caching.
- **The 324 MB `get-file` is gzipped on the fly at level 6 on every request**, in one nginx worker.
  - About 62 MB/s raw goes in (10.8 MB/s on the wire × 5.74 ratio), so compression takes about 5 s, the same as the network transfer.
  - The `get-file` wire rate (10.8-11 MB/s) is below the plain TCP rate (13.5 MB/s), so the stream is limited by the producer, not the network. The producer is nginx gzip-6 **or** the backend's transit writer; the data does not separate the two. To tell them apart, time an uncompressed `get-file` from inside the VM.
  - Local benchmark on the same body: gzip-6 gives 54.6 MB in 6.8 s, gzip-1 gives 68.9 MB in 2.9 s, zstd-3 gives **45.2 MB in 1.9 s**, brotli-5 gives 33.9 MB in 7.2 s.

### 4.3 API calls during workspace init (run B order; all over one h2 connection)

| Call | When | Size | Server and network | Serial or parallel |
|---|---|---|---|---|
| `get-environment-data`, `get-profile` | 1.62 | under 5 kB | 80 ms | parallel |
| `get-teams` | 1.74 | under 5 kB | 50 ms | after the profile |
| `get-team-members`, `get-access-tokens` | 1.80 | under 5 kB | 90 ms | parallel |
| `get-comment-threads`, `get-profiles-for-file-comments`, `get-font-variants` | 2.56 | under 5 kB | 80 ms | parallel |
| **`get-file` (main)** | **3.82** | **56.5 MB gz / 324.4 MB** | **TTFB 0.8-1.0 s, body 5.1-5.3 s** | **Waits for the WASM module and `get-font-variants`** (`frontend/src/app/main/data/workspace.cljs:458-476`) |
| `get-file-object-thumbnails` | 3.82 | under 5 kB (11 frame thumbnails) | 60 ms | parallel with get-file |
| `get-project`, `get-file-libraries` | 12.28 | under 5 kB | 100 ms | **after the main file is decoded** |
| **`get-file` (library)** | **14.17** | 3.95 MB gz / 22.5 MB | TTFB 0.12 s, body 0.4-1.8 s | **after the main file** (`workspace.cljs:180-213, 482-499`) |
| `get-file-object-thumbnails` (library, `tag=component`) | 14.17 | small | 60 ms | parallel |
| Fonts, media thumbnails | about 30 | about 1.5 MB | under 1 s | after `set-objects` |

The same calls timed one by one from node over HTTP/1.1:
- Small RPCs take 46-50 ms each.
- The main `get-file` has a first byte at 973-981 ms and finishes at 6.0-6.2 s.
- The library `get-file` takes 121 ms to first byte and 0.5 s in total.

### 4.4 What `get-file` contains

| Item | Value |
|---|---|
| Stored main blob | `file_data` row (backend `db`): **46.2 MB**, blob v4 (zstd + fressian) |
| Library blob | 3.0 MB |
| File features | `fdata/objects-map`, `fdata/path-data`, `fdata/shape-data-type`, `components/v2`, `layout/grid`, `design-tokens/v1`, `variants/v1`. **No `fdata/pointer-map`.** |
| Team features | include `fdata/objects-map` and `render-wasm/v1`. So the client sends `fdata/objects-map`, and the backend does not have to convert objects (`files.clj:222-224`). |
| Response | `data.pages-index` is 324.38 MB of the 324.39 MB. Components are 0.01 MB. |
| Pages | **12 pages, 152,362 shapes** |
| Object encoding | Every shape is a separate nested transit string (objects-map v2), about **2.1 KB per shape** (324.4 MB / 152,362; the MEDIUM page gives 60.8 MB / 28,709 = 2.1 KB). Keys repeat in every shape. Escaping the quotes in the nested strings adds 36 MB (11%). |

| Page | Raw MB | Shapes |
|---|---|---|
| Journeys - (1280x800) - EXTRA LARGE | 62.1 | 28,939 |
| Journeys - (800x600) - LARGE | 61.9 | 28,673 |
| Journeys - (800x480) - SMALL | 61.2 | 28,909 |
| **Journeys - (800x600) - MEDIUM (the page opened)** | **60.8** | **28,709** |
| DO_NOT_USE_DESIGNER_DRAFTS | 58.8 | 27,636 |
| DO_NOT_USE_DESIGNER_PLAYGROUND | 15.0 | 7,422 |
| FIGMA USAGE AS DEV | 3.7 | 1,834 |
| Internal components, READ ME, Page 1, KAM INFORMATION ARCHITECTURE, KAM RESOLUTIONS | 0.8 | 240 |

So **81% of the bytes, and of every all-pages walk, belong to pages the user did not open.**

### 4.5 Backend cost of `get-file` (estimated from TTFB; there is no server-side breakdown)

Path:
1. `rpc/commands/files.clj:175-225`
2. → `binfile/common.clj get-file*` (one `file_data` row)
3. → `fdata/resolve-file-data` and `decode-file-data` (zstd + fressian of 46 MB)
4. → transit is streamed by `http/middleware.clj:195-271`, with no backend compression and no response cache
5. → nginx gzip
6. → Caddy

- **Before the first byte:** 0.8-1.0 s in total, including about 50 ms of RTT. That covers reading the DB row, decoding the blob, permission checks and the start of transit writing. The objects-map v2 strings are written out without re-encoding each shape.
- **After the first byte:** gzip CPU and the network share the cost at the same time, as described in 4.2.
- **The backend is a small part of the total.** Moving from 4 to 16 vCPU did not change any of this, because gzip is single-threaded and the client was the bottleneck.

### 4.6 Client-side costs (measured with the CPU profile and long tasks; code paths from reading the code)

| Stage | Main-thread cost | Notes |
|---|---|---|
| Boot: parse and run the JS bundles (malli schemas, instaparse) | about 2 s, mostly hidden behind the network | measured |
| `get-file` `.text()` and `t/decode-str` (`frontend/src/app/main/repo.cljs`, `util/http.cljs:215`) | **about 2.5 s** decode (time-weighted, `conditional-decode-transit`), inside a 3.6-3.7 s long task with page init | measured. objects-map keeps shapes as lazy strings, which is why the decode is not much larger. |
| Index worker `:index/initialize` (`frontend/src/app/worker/index.cljs:26-41`) | runs off the main thread | estimated. It decodes every shape of the page again in the worker. |
| WASM shape upload (`render_wasm/api.cljs` `set-objects-workers`, 512-shape chunks, upload worker pool) | **9.7 s wall** with nothing else running (run A); 16-19 s when the library-sync check lands in the middle (B, C, D). About 4.6 s of main-thread CPU (`apply-entries!`, per-shape FFI, shader compile `getProgramParameter` 0.5 s). | measured |
| First full tile pass after `set-objects` | 2.6-3.0 s | measured |
| **Library-sync check** (`workspace.cljs:155-171` → `workspace/libraries.cljs:1312-1381` `notify-sync-file`) | **10.0-10.9 s of CPU (time-weighted) on every open; it is essentially the whole 10.3-11.1 s long task.** Same in all four runs. | measured. It runs because the library's `modified_at` (2026-11-09 15:49) is later than `file_library_rel.synced_at` (2026-11-09 13:46), and `used-assets-changed-since` finds used assets changed since then. It is a dry-run `generate-sync-file-changes` with `early-return? true`, done only to decide whether to show the "there are updates" banner. The early return is checked only **between containers (pages)** (`common/.../logic/libraries.cljc:516-519`), so 10 s means it probably walked most or all 12 pages and found **no** change. In that case **no banner appears**, and the check repeats on every open until `synced_at` or `ignore_sync_until` moves. 87% of it is `generate-sync-shape-direct` on component copies. The `(rx/timer 0)` "defer" in the code does not split the work: it is still one synchronous task. |
| **Text resize cascade after fonts arrive** (`render_wasm/api.cljs:2052` `relayout-after-fonts!` → `sync-stale-text-selrects!` → `schedule-stale-selrect-sync!` (waits for tiles-complete, then idle) → data event `::stale-text-selrects` → `workspace.cljs:545` → `wasm_text.cljs:239` `resize-wasm-text-all` → `update-shapes` → `apply-wasm-modifiers` → `modifiers.cljs:95` `calculate-ignore-tree-wasm`) | **17-27 s long task** (B, C, D) | measured, time-weighted: `apply-wasm-modifiers` 7.3-11.2 s (almost all in `calculate-ignore-tree-wasm`), `update-shapes` 5.3-7.8 s, lazy `transit/decode-str` of shapes 6.5-8.3 s (the upload decoded them in workers, so the main thread still holds lazy strings), `aclone` 3 s. **It was not seen in run A**, which stopped early. **Convergence is unknown:** runs B-D blocked all writes, so a fix could never be saved, and repetition there proves nothing. The number of stale ids was not logged. |
| `fix-deleted-fonts`, `update-page-position-data`, `calculate-position-data` | under 0.3 s each | measured |
| Fonts | 7 TTFs, about 1 MB, under 1 s, fetched after `set-objects` | measured |
| Thumbnails | 11 frame thumbnails from `get-file-object-thumbnails`. No thumbnail generation on open (the classic watcher is off under WASM). | measured |

What hides the tips screen (`frontend/src/app/main/ui/workspace.cljs:337-343`, `:197-202`):
- It hides when the file has `:data` and the page is current.
- It does **not** wait for the WASM upload, the library or fonts.
- So after it hides, users see a solid-colour canvas for 20 s, then a frozen UI for 17-27 s more.
- The second clause (`(and wasm-renderer-enabled? (not file-loaded?) (not @first-frame-rendered?))`) is already covered by the first, so `first-frame-rendered?` has no effect (confirmed in code).

After the first frame, `warm-neighbour-pages` (`workspace/pages.cljs:254`) also **pre-decodes neighbour pages** that are already in memory, in `requestIdleCallback` chunks. It fetches nothing. It is chunked, so it should not create long tasks, but it adds main-thread work during the period the user is waiting.

## 5. Root causes ranked by seconds contributed (cold open, as the user sees it)

| # | Cause | Seconds | Evidence |
|---|---|---|---|
| 1 | **HTTP/3 (QUIC) through WARP to Caddy runs at about 0.36 MB/s** (WARP clients only, as far as is known) | **about 175 s** of tips screen (189 → 14 s). The per-request figures overlap: 152 s on get-file, 13 s on the library, 15 s on the WASM, about 10 s on the JS bundles. | Run A against runs B and D. Reproduced in review on a static asset. Not caused by VM UDP buffers (0 drops). |
| 2 | **Text resize cascade after load** (stale text selrects, then `update-shapes` and modifiers over a 28.7k-shape page, on every open with writes blocked) | **17-27 s** of frozen UI | Long tasks and profile in runs B, C and D |
| 3 | **Library-sync dry run over all 12 pages on every open** (probably finds no change, so no banner) | **10-11 s** long task, which also delays the shape upload | Profile `maybe-sync`. Postgres `synced_at` < library `modified_at`. |
| 4 | **The whole 12-page file (324 MB raw, 56 MB gz) is sent when one page (61 MB raw, about 10.5 MB gz estimated) is needed**, and it is not cacheable in the browser | **about 6 s** of transfer + TTFB, **about 2.5 s** of decode and init on the main thread, and about 5x more work in causes 2 and 3. Repeated on warm opens. | Run C: the full 56 MB is downloaded again. The page breakdown in 4.4. |
| 5 | WASM shape upload of 28.7k shapes, plus the first tile pass | **about 12-13 s** (9.7 s upload + 2.7 s first tiles) | Run A |
| 6 | On-the-fly gzip-6 of the 324 MB response | about 2 s more than zstd would cost (estimated) | Local benchmark plus wire rate |
| 7 | Serial chains: `get-file` waits for the WASM module and font list; the library waits for the main file | about 1 s cold over h2 (about 15 s over h3); about 0.5 s for the library | Run B timeline |
| 8 | Boot JS and the unhashed bundle | about 1-2 s cold, about 0 warm | Run B and C |
| 9 | Backend before the first byte | about 0.8-1.0 s | node and CDP |

For a client that is **not** on WARP, cause 1 may not apply at all. Its open is about 58 s or more, and causes 2, 3, 5 and 4 dominate in that order. That is why C1 and C2 (or the Q2 data fix) are worth doing whatever Q1 shows.

## 6. Plan, ordered by value against effort and risk

### 6.1 Quick config and data wins (no code)

**Q1. Turn off HTTP/3 in Caddy.** Saves **about 175 s** for WARP clients (tips screen 189 s → 14 s; usable about 215 s → 58 s or later). It is no-regret for everyone else, because h2 over TCP was 8-14 MB/s on the same path. This is the most valuable change for this user.
- **Change:** in `deploy-azure/Caddyfile`, add a global options block at the top. Also tell browsers to drop the 30-day h3 entry they have cached. With h3 off, Caddy no longer sets `Alt-Svc` itself, so this header is the only one sent.
  ```
  {
  	servers {
  		protocols h1 h2
  	}
  }

  {$PENPOT_DOMAIN} {
  	header Alt-Svc clear
  	encode zstd gzip
  	reverse_proxy penpot-frontend:8080
  }
  ```
  `servers { protocols ... }` is valid for the Caddy in use (`v2.11.9`, checked on the VM). Without `h3` in the list, Caddy does not start the UDP listener.
- **Compose:** remove `"443:443/udp"` from `penpot-caddy` in `deploy-azure/docker-compose.yaml`. This is optional once Caddy no longer listens, but it is tidy.
- **Deploy:** upload both to the blob `config/`, copy them to `/opt/penpot/`, and run `docker compose up -d penpot-caddy`. A recreate is needed for the port change; a `caddy reload` alone would not drop the published UDP port. Recreating Caddy alone is safe, because nothing caches Caddy's address, and the certificates are in the `caddy_data` volume. Expect a few seconds of downtime.
- **Risks:**
  - Very low.
  - Chrome clients with a cached `alt-svc` (`ma=2592000`) try QUIC once. They mark it broken when UDP 443 does not answer and use TCP, so the cost is at most one connection delay. `Alt-Svc: clear` removes the entry on the first response.
  - HTTP/2 multiplexing is unchanged.
- **Alternative (dropped by the review):** keep h3 and raise `net.core.rmem_max` and `wmem_max`. The review saw no UDP buffer drops on the VM, so this is unlikely to help.
- **Verify:**
  - `curl -sI https://…/js/config.js` shows `alt-svc: clear` and no `h3=`.
  - DevTools Protocol column shows `h2`.
  - Run `trace.mjs` **without** `ARGS=--disable-quic` (after fixing its stop rule): the tips screen should hide at about 14 s.
  - Check whether the 3 s first-request delay in default mode also goes away.

**Q2. Move the file's library sync mark past the library's `modified_at`, once.** Saves **about 10 s** of frozen main thread on every open, until the library is edited again.
- **First check whether a banner appears at all.** Open the file as an editor and wait about 30 s after the canvas draws. The code early-returns after the first page that yields a change, so a 10 s run suggests that nothing was found and that **no banner is shown**.
- **If a banner appears:** click **Update**, which syncs the copies and then calls `update-file-library-sync-status` (sets `synced_at`), or **Dismiss**, which calls `ignore-file-library-sync-status` (sets `ignore_sync_until`). Update changes the file's component copies; Dismiss does not.
- **If no banner appears:** there is nothing in the UI to click. The equivalent is one call of the RPC `update-file-library-sync-status` with `{file-id …490, library-id …48f}` as an editor. It writes only `file_library_rel.synced_at` and touches no file content. Since the dry run finds no change, this records what a sync would record.
- **This is a user decision** and a write on Azure. Back up first, and do it after the pending re-import of the views file finishes.
- **It does not last.** The next edit to KAM - COMPONENTS that touches a used asset re-arms the check. C2 is the durable fix.
- **Verify:**
  - `file_library_rel.synced_at` or `file.ignore_sync_until` is later than the library's `modified_at`.
  - The next trace has no `maybe_sync` in the profile.
  - The 10-11 s long task is gone.

**Q3. Remove or move the dead pages; ideally one resolution per file.** Saves about 80% of the bytes and of all-pages work.
- **What to move or remove:**
  - "DO_NOT_USE_DESIGNER_DRAFTS" (58.8 MB, 27.6k shapes) and "DO_NOT_USE_DESIGNER_PLAYGROUND" (15 MB): remove them, or move them to another file.
  - Even better, split the four "Journeys" resolutions into four files.
- **Expected for the MEDIUM file alone:**
  - `get-file` falls from 324 MB to about 65 MB raw, or about 11 MB gz. That takes about 1 s over TCP instead of 5-6 s.
  - Decode and init fall from about 3.6 s to about 1 s.
  - The sync dry run shrinks about 5x.
  - The response (about 10.5 MB encoded) is probably small enough for the browser to cache, so warm opens can get a 304 the way the 3.95 MB library already does. This only works if opens do not write: any `update-file` on open changes `revn`, and the ETag (`files.clj` `get-file-etag`) includes `revn` and `modified_at`.
  - The cascade (C1) and the upload scale with the page, not the file, so this alone does not shrink them.
  - Note: the pending re-import of the views file may change its pages. Re-check the page table in 4.4 after it.
- **Change:**
  - A Penpot data operation: duplicate the file, then delete pages from each copy, or move pages with copy and paste.
  - Use binfile export first as a backup.
- **Risks:**
  - IDs referenced by `kam-link-work` scripts, MCP prompts and `kam-platform` (file `…490`, page `c54dcb4e…`) may change; check whether duplicating keeps page and shape ids.
  - Library links must be kept for each file.
- **Verify:** `get-file` size, and a trace of the new file.

**Q4. Let Caddy compress `/api` with zstd instead of nginx gzip.** Saves an estimated 1-2 s on each full `get-file`, **if gzip and not the backend is the limit** (see 4.2). Estimated 45-50 MB instead of 56 MB, and about 3x less compression CPU.
- **Change:** in the frontend nginx `location /api`, set `gzip off;`.
  - That needs the template `docker/images/files/nginx.conf.template:163-167`, which means a frontend image rebuild.
  - The override hooks cannot target `/api` alone: `location.d` is included in another location, and `http.d` cannot repeat `gzip`.
  - A `server.d/*.conf` file with `gzip off;` (mounted into the frontend container) turns gzip off for **all** locations in that server. That also works, as long as Caddy's `match` below covers the static types.
- **Caddy:** replace `encode zstd gzip` with:
  ```
  encode {
  	zstd
  	gzip 5
  	match {
  		header Content-Type application/transit+json* application/json* text/* application/javascript* application/wasm* image/svg+xml*
  	}
  }
  ```
  `application/transit+json` must be listed, because Caddy's default match list does not include it.
- **Size estimate:** the 45.2 MB figure is from the zstd CLI at level 3. Caddy's zstd encoder uses a smaller window, so expect somewhat more. Measure it.
- **Browser support:** Chrome 123 and later and Firefox 126 and later accept zstd; others get gzip.
- **Risks:**
  - Low.
  - The hop from nginx to Caddy carries the full 324 MB uncompressed, but it is on the local Docker bridge.
  - Clients without zstd get gzip.
- **Verify:**
  - `content-encoding: zstd` on `get-file`.
  - Wire size about 45 MB.
  - Total time with `api.mjs`.

**Q5. Precompress static assets** (`.gz` at level 9, plus `.br` if a brotli module or Caddy precompressed serving is added). Saves under 0.5 s cold and nothing warm.
- **Change:** a build step in `deploy-azure/build-images.sh` that runs `gzip -9k` over `js/*.js`, `*.wasm` and `css/*.css` in the image. `gzip_static on` is already set.
- **Optional:** add `immutable` to the 7-day cache header for versioned URLs.
- **Risk:** minimal.

### 6.2 Code changes (fork `perf/render-wasm-large-files`)

**C1. Stop the post-load text cascade.** Saves **17-27 s** of frozen UI on every open.
- **Find the cause first, on the devenv** (never let it save on Azure). Log how many ids reach `schedule-stale-selrect-sync!` and `resize-wasm-text-all` on open, and which fonts are pending at upload. Then open once **with writes allowed** and open again. If the second open has no stale ids, the cascade converges, and the cost is the walk (fix with a/b). If ids are still stale, the stored selrects never match the WASM layout (fix the measurement or the tolerance). The original analysis said "it is not converging", but the evidence does not show that: B, C and D blocked writes, and run A's save was not the text resize.
- **Then:**
  - (a) Make the selrect sync write `:selrect`, `:points` and position data directly as one change set without modifier propagation. `calculate-ignore-tree-wasm` walks from the transformed shapes through their trees and calls `under-transform?` up the parents, which decodes lazily stored shapes on the main thread. That walk is 7-11 s of the cascade. A cheaper version only visits the subtrees of component copies that contain a resized text.
  - (b) Or chunk it with yields after the first frame.
  - (c) Make sure the result is saved, so the next open finds nothing stale.
- **Files:**
  - `frontend/src/app/render_wasm/api.cljs`: `relayout-after-fonts!` about 2052, `sync-stale-text-selrects!`, `sync-text-selrects-after-load!`
  - `frontend/src/app/main/data/workspace/wasm_text.cljs:63-170`
  - `frontend/src/app/main/data/workspace/modifiers.cljs:95`
  - `frontend/src/app/main/data/workspace/shapes.cljs` (`update-shapes`)
- **Risk:** medium, because text geometry correctness is involved. Cover it with the existing render-wasm Playwright specs.
- **Verify:** no long task over 1 s after the first tiles (with the fixed stop rule, which waits at least 30 s); the id count is logged; on the devenv the second open sends no `update-file`.

**C2. Make the library-sync check cheap and late.** Saves **10-11 s** on every open, whatever the data.
- **Changes:**
  - Run `check-libraries-synchronization` only after `set-objects` and the first tiles, during idle time. Today it fires 1 s after the libraries resolve, which lands in the middle of the upload.
  - **Restrict the dry run to the changed assets.** `assets-need-sync` already computes them through `used-assets-changed-since` and then throws the list away. Pass each changed component, colour or typography id as `asset-id`, so `uses-assets?` keeps only the shapes that use those assets.
  - **Record the result when nothing is found.** If the dry run gives no changes and the user can edit, call `update-file-library-sync-status`, so the next open takes the fast path. This makes the check converge.
  - Optionally check `early-return?` per shape inside `generate-sync-container` as well as per page, or yield between pages. Early return already exists, but only between pages; the original plan's "stop at the first change" was already done at that level.
- **Files:**
  - `frontend/src/app/main/data/workspace.cljs:155-171`
  - `frontend/src/app/main/data/workspace/libraries.cljs:1300-1381`
  - `common/src/app/common/logic/libraries.cljc` (`generate-sync-file-changes`)
- **Risk:** low to medium. The banner could show a few seconds later.
- **Verify:** no `maybe_sync` in the critical path; on the devenv, `synced_at` moves after an open whose dry run finds nothing; the banner still appears after a real change to a used component.

**C3. Remove serial gates.** Saves about 1 s cold over h2 and about 0.3 s warm.
- **Changes:**
  - Send `get-file` together with the WASM module and font-variant gate (`rx/zip`, not `rx/concat`) in `workspace.cljs:458-476`.
  - Start `get-file-libraries` and the library `get-file` together with the main `get-file`. Today they wait for `bundle-fetched`, in `workspace.cljs:180-213, 482-499`.
- **Risk:** low.
- **Verify:** in the CDP waterfall, `get-file` starts at about the same time as `render-wasm.wasm`.

**C4. Enable pointer-map; then lazy page loading.**
- **Step 1 (config and data), saves about 5-6 s on warm opens:**
  - Add `enable-feature-fdata-pointer-map` to `PENPOT_FLAGS`.
  - The next `update-file` on the file converts it (`files_update.clj:184-207` → `binfile/common.clj:788-806` → `fdata.clj:356-364`). Each page and `:components` becomes a `file_data` row of type `fragment`.
  - To convert at once, use the prepl: `(app.srepl.main/update-file! "<file-id>" (fn [f _] (update f :features conj "fdata/pointer-map")) :rollback? false)`.
  - The frontend then fetches every page with `get-file-fragment` in parallel. Fragments are immutable and sent with `cache-control: max-age=604800`, so warm opens get unchanged pages from the browser cache.
  - Cold opens move the same total number of bytes, so they gain little. They may gain about 1 s, because `resolve-file` fetches all fragments in parallel (`rx/merge-map`), so nginx can gzip them in several workers at once.
  - This only helps if opens do not write to the pages: fragments are content-addressed, so a page that is rewritten on every open gets a new fragment id and misses the cache.
  - **Risks:**
    - It is one-way in practice.
    - Back up first.
    - Test MCP backend mode, binfile export/import and `file-gc` on the devenv first.
    - The backend realizes pointers for clients that do not send the feature.
- **Step 2 (code), saves about 4-5 s cold, plus about 5x less all-pages work:**
  - In `frontend/src/app/main/features/pointer_map.cljs` (`resolve-file`) and `workspace.cljs` `fetch-bundle`, resolve only `:components` and the current page at open.
  - Resolve other pages on page switch (`workspace/pages.cljs` `initialize-page`) and inside every operation that walks all pages: library sync, find and replace, component main-instance lookup (components v2 keeps mains on pages), plugin and MCP APIs, multi-page export.
  - The branch's `warm-neighbour-pages` today only **decodes** pages that are already loaded, in idle time. It would have to be extended to fetch fragments as well.
  - **Risk:** high, because many code paths assume `pages-index` is complete.
  - **Verify:** only one fragment is fetched before the tips screen hides; switching page fetches the next one; the library-sync, components and MCP tests pass.

**C5. Upload what is visible first.** Saves an estimated 5-8 s to the first usable frame.
- **Change:** order `set-objects-workers` chunks by distance from the viewport. End the canvas transition and allow interaction after the visible boards are uploaded and drawn. Upload the rest in idle time.
- **Optional:** draw the existing 11 board thumbnails as placeholders.
- **Files:**
  - `frontend/src/app/render_wasm/api.cljs` (`set-objects-workers` about 2875-2992, `replay-chunks`, `finish-async-upload!` about 2277)
  - `frontend/src/app/main/ui/workspace/viewport_wasm.cljs:536-560`
- **Risk:** medium, because selection or hit-testing could happen before all shapes are present.

**C6. Make the tips screen honest.** Saves 0 s, but it is better UX.
- **Change:** keep the loader, or show progress text, until `set-objects` and the first tiles are done (`frontend/src/app/main/ui/workspace.cljs:337-343`). Today it hides about 20-45 s before the design responds.
- **Note:** the `first-frame-rendered?` clause there has no effect.
- **Verify:** in a trace, `loader-hidden` comes after `penpot:wasm:tiles-complete#1`.

**C7. Fix the measurement script before re-measuring** (new in review). Saves 0 s, but every "after" number in 6.3 depends on it.
- **Change:** in `trace.mjs`, stop only after a fixed wall-clock wait (for example 30 s after `tiles-complete#1`). Or read long tasks after one more `setTimeout` round inside the page, so the observer has delivered the last task.
- **Also:** weight `prof.mjs` samples by `timeDeltas` (the review's version is `%TEMP%\penpot-review\profwin.mjs` and `profw.mjs`).
- **Also:** log the stale-text id count and whether the sync banner was shown.
- **Verify:** the CPU profile runs at least 20 s past the last long task.

### 6.3 Expected result if the plan is followed (estimated)

All "usable" figures are subtractions of measured long tasks from a lower bound. Treat them as optimistic until C7 is done.

| After | Tips hidden | Usable |
|---|---|---|
| Today (h3, WARP) | 189 s | about 215-240 s or more |
| Q1 (or any client with working h3) | 14 s | about 58-65 s or more |
| + Q2 (or C2) | 14 s | about 45-50 s |
| + C1 | 14 s | about 22-28 s |
| + Q3 (MEDIUM page in its own file), or C4 step 2 | about 6 s | about 15-18 s |
| + C3, Q4 and C5 | about 4-5 s | about 8-12 s |

## 7. What cannot reasonably be fixed

- **A 28.7k-shape page has a floor.**
  - The page is about 61 MB of transit, or about 10 MB gz, which is under 1 s at 13 MB/s.
  - The upload costs about 1.5-2 s per 10k shapes on this laptop: 9.7 s measured for 28.7k, with the shapes decoded at least twice (index worker and upload workers).
  - Without visible-first upload (C5), this page will not be usable in 5 s. Even with C5, the full upload is still O(n) in the background.
- **The objects-map v2 format** stores each shape as its own transit string, about 2.1 KB per shape with keys repeated and quotes escaped. A more compact format is an upstream-level change and is out of scope for a fork.
- **Figma's 5 s** comes from loading pages on demand, a binary format and server-side preprocessing. Penpot's workspace (including upstream) loads every page at open; only `get-page` (exporter) and `get-file-data-for-thumbnail` (dashboard) are partial. Getting close needs C4 step 2 and C5.
- **The network:** RTT is about 45-50 ms through WARP to Sweden Central, and TCP throughput is about 13.5 MB/s per stream. Moving the VM to UK South would cut the RTT for the roughly 15 small serial RPCs, which is about 0.5 s. It does not change the byte cost much.
- **The VM size does not matter here.** The 16 vCPU / 64 GB resize does not help this path: the backend is about 1 s, nginx gzip is single-threaded per response, and everything else happens in the browser. This is reasoned, not measured: there are no 4-vCPU traces in the raw results to compare against.

## 8. Not measured, or measured only indirectly

- **The user's own browser and network.**
  - Assumed to match this laptop: Chrome, WARP connected, h3 in use.
  - The 189 s tips screen matches the user's "couple of minutes". The guide's earlier "12-14 s" for `get-file` was a TCP measurement.
  - Users who are not on WARP may get better h3 throughput. Not measured.
- **Whether the slow QUIC is WARP-specific.** VM-side UDP drops were ruled out in review (0 buffer errors), but h3 was not tested from a network without WARP. WARP and the VM were not changed.
- **A server-side breakdown inside the 0.8-1.0 s TTFB** (DB read, against zstd/fressian decode, against transit encode). It is estimated as a whole; there is no backend timing log for `get-file`.
- **The exact trigger set and the convergence of the text cascade (C1).** Only its cost and call path were measured.
- **Cold and warm behaviour with pointer-map,** because it is not enabled. Whether Chrome caches a fragment of about 10.5 MB encoded is assumed from the library (3.95 MB encoded, 22.5 MB raw) being revalidated with a 304, and from the 56 MB main response not being cached.
- **Slower client hardware.** All client numbers are from an RTX A2000 laptop.
- **The local devenv was not used.** The Azure VM was running, so every number above is from Azure.

## 9. Review notes (independent review, 2026-11-12)

### Recommended order after review

| Order | Item | Why this position |
|---|---|---|
| 1 | **Q1** h3 off, plus `Alt-Svc: clear` | Config only, no-regret, about 175 s for WARP clients |
| 2 | **C7** fix the trace stop rule and profile weighting | Without it, no "after" number can be trusted |
| 3 | **Q2** move `synced_at` once (after checking for a banner), then **C2** | About 10 s on every open; Q2 is one small write, C2 makes it converge |
| 4 | **C1** text resize cascade, starting with a convergence test on the devenv | 17-27 s; the biggest Penpot-side cost, but it needs the diagnosis first |
| 5 | **Q3** split the four resolutions into separate files (or **C4**) | About 80% of bytes and of all-pages work; a data and ID decision for the user |

After those: C3, Q4 (measure whether gzip or the backend is the limit first), C5, C6, Q5.

### What was checked
- **Raw results:** re-parsed all `*-net.json`, `*-marks.json` and `*.cpuprofile` files. Timings, protocols and sizes in sections 1-3 match. Shape and MB totals by page add up (152,362 shapes, 324.3 MB). The page share (18.7%) and the Q3 estimate (56.2 × 60.8/324.4 ≈ 10.5 MB gz) are arithmetic, not guesses.
- **Profiles:** re-attributed with sample-time weighting (scripts in `%TEMP%\penpot-review\`: `profw.mjs`, `profwin.mjs`).
- **h3:** re-measured on static assets only (`h3probe.mjs`, no login, no file access). h3 gave 0.33-0.52 MB/s and h2 gave 8-9 MB/s; WARP was on (`warp=on`, colo LHR).
- **VM (read-only `run-command`):** Caddy `v2.11.9`; the receive-buffer warning; `rmem_max` 1 MiB; MTU 1500; UDP and TCP counters inside Caddy's network namespace before and after an h3 transfer (0 buffer errors, 2 TCP retransmits in total).
- **Code (branch `perf/render-wasm-large-files`, `HEAD` one docs commit past `e49532867d`):**
  - `workspace.cljs` initialisation gates, `check-libraries-synchronization` and the stale-selrect watcher;
  - `notify-sync-file`, `assets-need-sync` and `sync-file` in `workspace/libraries.cljs`;
  - `generate-sync-file` and `generate-sync-file-changes` in `common/.../logic/libraries.cljc`;
  - `relayout-after-fonts!`, `schedule-stale-selrect-sync!` and `sync-stale-text-selrects!` in `render_wasm/api.cljs`;
  - `resize-wasm-text-all` and `calculate-ignore-tree-wasm`;
  - the loader condition in `ui/workspace.cljs`; `warm-neighbour-pages`;
  - the pointer-map frontend `resolve-file`; the backend `get-file`, `get-file-etag` and `get-file-fragment` (7-day `max-age`);
  - feature flags in `common/features.cljc` (`enable-feature-fdata-pointer-map` → `fdata/pointer-map`; not in `default-features`);
  - the nginx template and its override hooks; the Caddyfile and compose.

### What was changed, and why
1. **"Usable at 58 s" is now a lower bound.** `trace.mjs`'s 8-s-quiet rule fails: the poll returns before the observer records the long task, so every profile ends within about 1.5 s of the last big task. C7 was added to fix this.
2. **Profile seconds are corrected.** `prof.mjs` counts samples as 1 ms, but the real interval was about 1.6 ms. So the sync check is about 10-11 s of CPU, the whole long task, not 6.4 s. The get-file decode is about 2.5 s, not 1.5 s. The cascade components were rescaled.
3. **h3 is narrowed to the WARP path.** It was reproduced, and VM UDP buffers were ruled out. The `rmem_max` alternative was dropped. `Alt-Svc: clear` was added. A second, unexplained 3 s first-request delay in QUIC-enabled mode is recorded.
4. **The library sync: Q2 was likely not doable as written.** Early return already exists, but only between pages. A 10 s run means that probably no change was found, so no banner appears to click. Q2 now checks for the banner first and otherwise uses `update-file-library-sync-status`. C2 now restricts the dry run to the changed asset ids and records `synced_at` when nothing is found, which makes it converge.
5. **The text cascade: "not converging" was unsupported.** Runs B-D blocked writes, so any fix could never be saved. Run A's 2.7 KB `update-file` was not a text resize: there are no resize samples in its profile, and it was probably position data. C1 now starts with an id-count and a convergence test on the devenv.
6. **Smaller fixes:**
   - 2.1 KB per shape, not 1.8 KB.
   - The browser cache limit is about the 56 MB encoded size, not 324 MB.
   - `warm-neighbour-pages` decodes; it does not fetch.
   - Writes on open invalidate the `get-file` ETag (it includes `revn`) and would defeat the Q3 and C4 caching gains.
   - Q4: nginx `/api` cannot be targeted by an override file; the Caddy `encode` block is written out properly; Caddy's zstd window will make the size estimate optimistic; the get-file stream may be backend-bound rather than gzip-bound.
   - Added a non-WARP view of the ranking, and a verification step for C6.

### What could not be verified
- h3 from a network without WARP, and the user's own browser. Not changed and not tested.
- Whether the sync banner actually appears for this file. This is inferred from code and timing, not observed.
- The number of stale text ids, and whether the cascade converges when writes are allowed. That needs the devenv.
- Whether the get-file stream is limited by nginx gzip or by the backend's transit writer. A timed uncompressed `get-file` from inside the VM would show it; it was not run, to avoid putting credentials into run-command history.
- The exact origin and content of the 2.7 KB revn-166 change. The `file_change` blob was not decoded.
- Whether Caddy's zstd output matches the 45 MB CLI benchmark.
- The views file was **not** re-opened in a browser during the review, so as not to clash with the pending re-import. The page table in 4.4 may change after that import.
- No code, config, Azure resource, git state or Penpot data was changed by the review.
