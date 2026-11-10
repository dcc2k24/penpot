# Backend MCP

Backend-native MCP: MCP tokens call RPC commands in the backend. Code: `app.rpc.commands.mcp`, `app.rpc.commands.mcp-write`, `app.rpc.commands.mcp-limits`, `app.rpc.mcp-scope`, `app.http.session` (render sessions).
Contract doc (may be rewritten; read it, do not copy it): `mcp/docs/backend-mode-contract.md`.
Token rules, including the one-token-per-OAuth-client rules: `mem:backend/auth-permissions-product-domains`. TS server modes: `mem:mcp/core`. Shared flags and types: `mem:common/core`.

## Flags

- `enable-mcp-backend` (`:mcp-backend`): off by default. Off: an MCP token reaches only `send-mcp-feedback`; other MCP commands answer `:mcp-backend-disabled` (`:restriction`). `rpc.clj` `wrap-authentication`.
- `enable-mcp-raw-changes` (`:mcp-raw-changes`): off by default. Gates `mcp-apply-changes` only: `:mcp-raw-changes-disabled`.
- Flags are declared in `common/src/app/common/flags.cljc` (`varia` set). Tests turn them on in `backend/test/backend_tests/helpers.clj`.

## Dispatch

- Every command with `::rpc/token-type "mcp"` or `::rpc/allow-token-types #{"mcp"}` is refused with `:mcp-backend-disabled` while the flag is off. The exception is `::rpc/mcp-bridge` (`send-mcp-feedback`).
- Profile switch: when the profile prop `:mcp-enabled` is `false`, every MCP-token call is refused with `:mcp-disabled` (`:restriction`), whatever the command. The bridge is exempt. This check runs before the flag check. The token lookup reads the state once per request (`profile-state`, `http/access_token.clj`), not once per call in `rpc.clj`. A profile row that cannot be read counts as off.
- `::rpc/token-type "mcp"`: only MCP tokens may run it. Sessions and personal tokens get `:token-auth-required`.
- `::rpc/allow-token-types #{"mcp"}`: MCP tokens may run it next to sessions and personal tokens. Scope is checked only for MCP tokens.
- Scope check: `wrap-mcp-scope` (`rpc.clj`), inside params validation. Sessions and personal tokens skip it.
- A command with MCP metadata and no `::rpc/mcp-scope` fails at startup (`check-mcp-scope!`). There is no default by name prefix.
- Refusals (flag and scope) are logged and counted by `note-refusal!` (`rpc.clj`).

## Commands open to MCP tokens (flag on)

Token-type `mcp` (MCP-only):
- `mcp-whoami`, `get-mcp-file-outline`, `get-mcp-page-tree`, `get-mcp-shapes`, `find-mcp-shapes`, `get-mcp-library`, `get-mcp-tokens`, `create-mcp-render-session`: `mcp:read`. Module `app.rpc.commands.mcp`.
- `get-mcp-subtree`: `mcp:read`. Module `app.rpc.commands.mcp-subtree`.
- `get-mcp-interactions`, `find-mcp-connectors`: `mcp:read`. Module `app.rpc.commands.mcp-prototype`.
- `get-mcp-fonts`: `mcp:read`. Module `app.rpc.commands.mcp-fonts`. Logic in `app.rpc.mcp-fonts`: pure, no require of `app.rpc.commands.mcp` (`mcp.clj` calls it for the outline warnings).
- `get-mcp-page-lint`, `find-mcp-similar-boards`: `mcp:read`. Module `app.rpc.commands.mcp-lint`.
- `mcp-apply-changes`, `mcp-apply-operations`, `mcp-import-svg`: `mcp:write`, or `mcp:read` for a dry run. Module `app.rpc.commands.mcp-write`.
- `send-mcp-feedback`: `mcp:read`, `::mcp-bridge`, works with the flag off.

Allow-token-types `mcp` (product commands; still behind the flag):
- `mcp:read`: get-project-files, get-team-shared-files, get-team-recent-files, get-team-deleted-files, get-file-snapshots, get-comment-threads, get-comments, get-projects, search-files, get-teams.
- `mcp:write`: create-comment-thread, update-comment-thread, update-comment-thread-position, create-comment, create-file-snapshot, update-file-snapshot, lock-file-snapshot, unlock-file-snapshot, upload-file-media-object, create-file-media-object-from-url.
- `mcp:manage`: import-binfile, create-file, rename-file, set-file-shared, link-file-to-library, unlink-file-from-library, restore-deleted-team-files, duplicate-file, duplicate-project, move-files, move-project, create-project, update-project-pin, rename-project, create-team, update-team.
- `mcp:delete`: delete-file, delete-project, delete-comment-thread, delete-comment, restore-file-snapshot, delete-file-snapshot.
- Closed or removed commands are not on this list. The list comes from `git grep "::rpc/mcp-scope"` in `backend/src/app/rpc/commands`.

## Scopes

- Scopes are `mcp:read`, `mcp:write`, `mcp:manage`, `mcp:delete`. Stored as `mcp:*` strings in `access_token.perms`. `app.rpc.mcp-scope`.
- A token with no `mcp:*` entry holds `mcp:read` only. New tokens start that way.
- Any scope implies `mcp:read`. `write`, `manage` and `delete` do not imply each other.
- Grant: OAuth approval calls `grant-client-mcp-scopes`. The hand-made token's scopes change through `update-mcp-token-scopes`, which uses `replace-scopes` (`mcp_scope.clj`). Both are in `access_token.clj`. Unknown `mcp:*` values are dropped (`effective-scopes`).
- Missing scope: `:mcp-scope-required` (`:authorization`).

## Render sessions

- Made by `create-mcp-render-session` (`mcp:read`). The session props are `:mcp-render {:file-ids ...}` (the file and its libraries) and `:token-id` (the minting token). Lifetime 10 min (`mcp-render-max-age`, `http/session.clj`).
- Restricted: only routes with `::session/allow-restricted` see them. Those routes are `/api/main/methods`, `/api/management/methods`, `/api/rpc/command` (`rpc.clj`) and `/assets` (`http/assets.clj`). Every other route sees no session.
- Never renewed while restricted.
- Media: the file-media handler (`generic-handler`, `render-covers?` in `http/assets.clj`) serves a render session only the media of the files its `:file-ids` name: the file and its libraries. Other media answers 404.
- Die with their token: each use checks that the `access_token` row exists and is not expired. No `:token-id` fails closed.
- Die when MCP is off for the profile: the token lookup reads profile prop `:mcp-enabled` on each request. No profile row fails closed.
- Age: refused at 10 min. The session GC (`sql:delete-expired-v2`) deletes them once `created_at` is past 10 min. The GC runs on the daily cron, so the row can outlive the age, but auth refuses it at once. See `mem:backend/session-expiration`.

## Write path invariants

- One transaction per call (`::db/transaction true`). Every batch of one call commits in it.
- File lock: `SET LOCAL lock_timeout = '15s'`, then `xact-lock!` and the share lock on the file row (`load-write-file`). A lock wait over the limit (SQLState 55P03) is a `:conflict`: `:mcp-file-busy` for the file lock, `:mcp-lock-timeout` for any other lock wait inside the write (`lock-wait!` wraps the whole write). Only writes lock; dry runs do not.
- File decoded once (`begin-batches!`), written once (`finish-batches!` through `bfc/update-file!`). Each batch gets its own change row and revn (`apply-batch!`).
- Project row is updated last, just before the commit.
- Batches: a batch holds at most 2000 compiled changes of any kind (`notify-changes`). A call above 2000 changes, or with `allow-split`, is cut into batches (`batches-of`) at whole-operation edges (`split-batches`): an operation is never split, and one above 2000 gets a batch of its own. The layout reflow gets its own batch or batches when it would cross the bound. Max 50 batches per call (`:mcp-too-many-batches`, checked before the first write).
- Time budget: 60 s. Checked before each batch after the first. Over budget: `:mcp-time-budget-exceeded` (`:validation`). The transaction rolls back.
- Snapshot: one per call, taken with the first batch and never on a half-applied state. Rule: deletes always (delete types, and token changes with no `:attrs`), more than 100 operations or changes, or `snapshot: true` forces it; `snapshot: false` drops only the size rule. Keep 20.
- Validation forced: the affected-shape check always runs. The schema check runs for raw changes (`mcp-apply-changes`). Not a user flag.
- Dry runs: never write. They load read-only, skip the lock and return the validation result.
- Refused change types: `set-tokens-lib`, `purge-component`, `purge-typography`, `purge-color` (`:mcp-change-type-refused`).
- Media: must be in the file or a readable library (`:mcp-foreign-media`).
- Loader: `compile-ops!` binds `pmap/*load-fn*` to `feat.fdata/load-pointer-of-files` over the file id and its library ids, so a library page loads only when an operation reads it. Libraries come from `files-update/library-files`, each decoded with its pointers unloaded. The update path (`files_update.clj`) binds `pmap/*load-fn*` to `bfc/pointer-loader` for its own file.
- Revn: `base-revn` older than the stored revn gives a `revn-lag` warning. `fail-on-conflict` raises `:mcp-revn-conflict` when the overlap is not empty or the read was cut short.
- Webhooks and audit: a real write names its event `update-file`, batch key file, timeout 2 min. A dry run or a replay names no event. Metrics and the log line come after commit.
- Commit errors from `begin-batches!` keep the generic codes: `:vern-conflict`, `:revn-conflict`.
- Batch errors carry `:revn-before-call` (the file revn when the call started), `:failed-change-index`, and `:failed-operation-index` and `:failed-operation-last-index` when the batch holds an operation.
- `:conflict` errors answer HTTP 409, with `:state`, `:path` and `:context` removed (`app.http.errors`, `handle-error :conflict`).

## Limits

- Rate limits (`backend/resources/rlimit.edn`, key `<profile-id>.mcp` from `rlimit.clj` `get-uid`; bucket is capacity/refill/interval):
  - `:mcp-read` `1200/600/1m` for the read commands.
  - The six new reads (`get-mcp-subtree`, `get-mcp-interactions`, `find-mcp-connectors`, `get-mcp-fonts`, `get-mcp-page-lint`, `find-mcp-similar-boards`) are in the `:mcp-read` list of `rlimit.edn`, with the other reads.
  - `:mcp-write` `600/300/1m` for the three write commands.
  - `update-mcp-token-scopes` uses `:access-token` `60/30/1m`.
- Concurrency (`backend/resources/climit.edn`, `app.rpc.climit`):
  - `:mcp-apply/by-profile` 1 permit, queue 5, timeout 60 s.
  - `:mcp-apply/global` 6 permits, queue 50, timeout 60 s.
  - `:mcp-apply/by-team` 4 permits, queue 50, timeout 60 s. Refusals name the limit in the `climit` metric and in the 429 body (`type` `concurrency-limit`, `code` `capacity-limit-reached`, `limit`, `reason`, hint). The frontend retries a save refused this way (`persistence/busy-server-error?`).
  - `:mcp-update-file/by-profile` 1 permit, queue 5, timeout 60 s. A write never holds the owner's own save slot.
  - `:mcp-read/by-profile` 4 permits, queue 20, timeout 30 s.
  - `:mcp-read/global` 8 permits, queue 64, timeout 30 s.
  - `:mcp-find/by-file` 2 permits, queue 10, timeout 30 s. Taken by `find-mcp-shapes`, `find-mcp-connectors`, `get-mcp-fonts`, `get-mcp-page-lint`, `find-mcp-similar-boards`. Not by `get-mcp-subtree` or `get-mcp-interactions`.
- Call size (`mcp_limits.clj`): 2000 items per call (`max-changes`, `max-operations`); payload 8 MB transit; compiled changes capped by `:mcp-max-compiled-changes` (default 100000), checked for dry runs too. A call commits at most 50 batches of 2000 changes (`max-batches`, `notify-changes` in `mcp_write.clj`).
- SVG: text at most 8 MB (`schema:mcp-import-svg`). Parse failure: `:mcp-invalid-svg`.
- Tokens: `:mcp-token-max-age` default 90 days (`config.clj`). Applied only when a new MCP token has no explicit expiry (`access_token.clj`). Nil means no expiry.

## Compiler (in `common`)

- Operations are compiled in `common/src/app/common/mcp/operations.cljc` and `operations/`. Its rules (ops, `props` refusals, move refusals, default names) live there, not here.

## Reads

- Page cache: `page-cache` in `mcp.clj`. Pointer pages are keyed by pointer id (fixed content, survives writes). Plain pages by file revn. Weight is the shape count; budget about 200,000 shapes; 10 min keepalive.
- Root cache: 10 min, 256 entries, keyed by file id, revn and vern. Outline cache: 10 min, 4096 entries.
- Cursors: base64 `[page-id version index root-id depth]`. Version is a pointer id or a revn. Wrong page, root or depth: `:mcp-invalid-cursor`. Version changed: `:mcp-stale-cursor`. Past end: `:mcp-invalid-cursor`.
- Reply budget: 1,000,000 bytes. A cut reply sets `truncated`; tree walks add `nextCursor`.
- Search: 5 s budget across pages; timeout sets `truncated`.
- `get-mcp-subtree`: `limit` 1-5000 (default 500), `max-bytes` 1000-1000000 (default 1 MB). Root default is the page root (`uuid/zero`), skipped in the walk. Pre-order, stored child order, `depth` and `index`. Walk cached per (file, page, version, root) in `walk-cache` (keepalive 10 min, weight = entries, budget 400000). A repeated id is listed once and a missing id is skipped, so a cycle cannot loop. Cursor `[page-id version index root-id 0]`. Missing root: `:shape-not-found`. A window always keeps one shape.
- `get-mcp-interactions`: `limit` 1-5000 (default 1000), about 1 MB encoded. `flows` sorted by name, then id. `totalInteractions` and `totalShapes` count the whole page. Walk is cycle-safe (`get-walk-entries`). `overlay-position` is a point map `{x, y}`.
- `find-mcp-connectors`: `max-distance` 0-2000 (default 64), `limit` 1-2000 (default 500), `within-id` (not on page: `:shape-not-found`). Candidates `:path` and `:bool`, shallowest first; skipped when hidden, under a hidden ancestor or under a boolean. Boards use the true bounding box of the points (`shape-rect`). Ends: open path with stroke = first and last point; otherwise `farthest-pair` (three farthest-point passes; its docstring still says two). Sampling 400 points. Cap rule for open paths only. A candidate inside its nearest ancestor frame, with no board in that frame, is skipped (`inside-own-frame?`). `length` = straight distance. 5 s budget (`search-budget-ns`) covers boards and candidates.
- `get-mcp-fonts`: `root-ids` 1-200, needs `page-id`. Usage cached per page key in `usage-cache` (10 min, weight = fonts, budget 200000); resolution read on every call (`get-font-context`). Without `page-id`: 5 s budget (`scan-budget-ns`), first page always read, `complete` false when cut. Reply at most 500 fonts and within the response budget; `unresolved` counts all fonts. Runs of one face merge under the listed variant id (`get-variant-reports`). Empty text leaves are not runs (`get-text-runs`). Google catalogue `common/resources/fonts/gfonts.2025.11.28.json` via `fonts/load-gfonts` in a `delay`; a read failure is logged once and the index is empty. Reasons: `google-fonts-disabled`, `not-in-google-catalog`, `custom-font-not-in-team`, `unknown-font-id`, `variant-not-found`. A variant of an unresolved font takes the font's reason.
- `get-mcp-page-lint`: `depth` 1-5 (default 1), `min-shapes` 0-1000 (default 3), `rules` 1-8 of six names, `limit` 1-2000 (default 500), `board-name-regex` max 200 (bad regex: `mcp-invalid-regex`, hint names `board-name-regex`). 5 s budget (`budget-ns`). Boxes are the point bounds (`get-box`). Rest rules use full frame boxes; `show-content` exempts a frame (`clips?`). Scroll rule: `get-scroll-frame` and `reachable?` (nearest scrolling ancestor; outer frames clip its viewport). One finding per control: `inside-selected?` keeps the innermost selected board. Rule order `control-rule-order`. `counts` total all findings (`count-lint-findings`); `findings` cut at `limit`.
- `find-mcp-similar-boards`: `threshold` 0.5-1 (default 0.9), `min-shapes` 1-1000 (default 3), `limit` 1-500 (default 100). At most 1000 boards (`max-similar-boards`). Tokens: type, component id, collapsed text. Distinct signatures interned and sorted by size; size-ratio pruning in `find-similar-pairs`; deadline checked every 256 pairs (`pair-check-interval`); single link. Result `compared`. 5 s budget.
- Outline `warnings`: `get-mcp-file-outline` adds `warnings` (at most 50, `warningsTruncated`) and `warningsComplete` (false when pages were left out). One-second budget (`outline-budget-ns`); a page above 5000 shapes (`outline-max-shapes`) is scanned only when its usage is cached. Usage is cached per page in `usage-cache`, not with the page summary; page summaries carry no `:fonts`. `pages` keys do not change.
- Board `overflow-scroll` (`:none`, `:horizontal`, `:vertical`, `:both`; JSON `overflowScroll`; absent is `:none`): frame attr in `schema:frame-attrs` (`common/types/shape.cljc`). Accepted by `create_board` and `update_shape` props; an invalid value is a validation error. Marks a scroll container only: the viewer does not scroll it. `get-mcp-page-lint` `scroll-hidden-control` reads it: a control hidden at rest that the nearest scrolling ancestor brings into view (`reachable?`). Sandbox reads and writes it (`PropertyMap.ts`).

## Idempotency

- `request-id` (optional, UUID). Without one, the server makes a fresh id, so no replay protection.
- Session id = UUID of `penpot-mcp:<token-id>:<request-id>:<digest>`. The digest is the SHA-256 of the canonical text of the payload (`payload-of`: `changes`, `operations`, `page-id`, `parent-id`, `svg`, `x`, `y`, `name`, `allow-split`, `snapshot`). The token id is part of it, so another token cannot replay. A reused request id with another payload gets another session id: a new write.
- Replay: checked under the file lock, before the compile (`applied-before?`). If the file has change rows with that session id, the answer is `already-applied: true`, `commits: 0`, the counts from the old rows. Nothing is written or notified.
- Window: change rows get `deleted_at` = commit + 1 h (`files_update.clj`). The objects GC deletes them after that. A retry after that window applies again.
- Dry runs skip the replay check.

## Errors

- `:mcp-backend-disabled` (restriction, `rpc.clj`). `:mcp-raw-changes-disabled` (restriction, `mcp_write.clj`). `:mcp-disabled` (restriction, `rpc.clj` and `mcp.clj`; profile prop `mcp-enabled` false).
- `:mcp-scope-required` (authorization, `mcp_scope.clj`). `:token-auth-required` (authorization, `rpc.clj`).
- `:profile-blocked`, `:profile-not-active` (authorization, `check-profile!`).
- `:mcp-token-not-found` (`access_token.clj`).
- `:mcp-invalid-cursor`, `:mcp-stale-cursor`, `:mcp-root-children-not-allowed`, `:mcp-invalid-regex`, `:mcp-invalid-pattern` (reads, `mcp.clj`).
- `:mcp-batch-too-large`, `:mcp-change-type-refused`, `:mcp-too-many-batches`, `:mcp-foreign-media`, `:mcp-invalid-svg`, `:mcp-time-budget-exceeded`, `:mcp-file-busy`, `:mcp-lock-timeout`, `:mcp-revn-conflict` (writes, `mcp_write.clj`). The two lock codes and `:mcp-revn-conflict` are `:conflict` (HTTP 409).
- `:mcp-batch-split-mismatch` (internal; a bug in the splitter).
- Compiler codes come through the writes: `:mcp-invalid-operation` and `:mcp-unknown-id` (`:validation`), `:mcp-compile-failed` (`:internal`, a fault in the compiler). Defined in `common/src/app/common/mcp/operations/state.cljc`.
- Metrics on errors: `mcp-errors-total` by tool and code; `mcp-refusals-total` by reason.

## Tests

- `backend/test/backend_tests/rpc_mcp_guard_test.clj` (flag gates), `rpc_mcp_scope_test.clj`, `rpc_mcp_read_test.clj`, `rpc_mcp_write_test.clj`, `rpc_mcp_write_path_test.clj`, `rpc_mcp_write_batch_test.clj`, `rpc_file_update_commit_test.clj`.
- Commands and tests: `mem:backend/testing`. Shared operations: `common/test/common_tests/mcp/operations_test.cljc`.
- Write redirected test output to a file and read that file. Do not pipe it.
