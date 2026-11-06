# Backend-mode MCP: interface contract

Status: implementation contract derived from `mcp/backend-write-mcp-plan.md`. Every backend command, every
adapter tool and every test is written against this document. Deviations from the plan are listed at the end.

All backend commands live under `POST /api/main/methods/<command>` (also `/api/rpc/command/<command>`). The
adapter always sends `Content-Type: application/json`, `Accept: application/json`, `X-Client: penpot-mcp`,
`Authorization: Token <mcp token>` (the backend accepts `Token` and `Bearer`). The backend middleware converts
JSON keys both ways: camelCase in requests becomes kebab-case keywords (`fileId` -> `:file-id`), and responses
are written back in camelCase. Keyword enum values travel as plain strings (`"frame"`, `"auto-width"`).
UUIDs travel as strings. Backend schemas therefore use kebab-case; the adapter uses camelCase.

Error payloads from the backend are JSON objects `{type, code, hint, ...}` with HTTP status 400 (validation),
401 (authentication), 403 (authorization), 404 (not found), 409 (conflict), 429 (rate limit), 500. The adapter
renders them as `Backend error <code>: <hint>` plus any `context`/`explain` field, never the raw stack.

## 1. Auth and scopes

### RPC metadata (backend `app.rpc`)

- `::rpc/token-type "mcp"` (existing): command requires an MCP token. Unchanged.
- `::rpc/allow-token-types #{"mcp"}` (new): an existing command additionally accepts MCP tokens while still
  accepting sessions and personal tokens.
- `::rpc/mcp-scope` (new): `"mcp:read" | "mcp:write" | "mcp:manage" | "mcp:delete"`, or a function
  `(fn [params] scope)` evaluated per request (used so that `dryRun` writes need only `mcp:read`). Checked only
  when the request authenticates with an MCP token. Session users and personal tokens are never affected.
  A command reachable by MCP tokens (either `::rpc/token-type "mcp"` or `::rpc/allow-token-types`) without
  `::rpc/mcp-scope` is treated as `"mcp:read"`.

### Scope semantics (`app.rpc.mcp-scope`)

- Token perms are the `perms` array of the `access_token` row. Scope entries are the strings above.
- Effective scopes of a token: the `mcp:*` entries of its perms. A token with no `mcp:*` entry (every token
  created before this change, and every new token by default) has exactly `#{"mcp:read"}`.
- `mcp:write`, `mcp:manage` and `mcp:delete` each imply `mcp:read`. Nothing else is implied. `mcp:write` does not
  imply `mcp:manage` or `mcp:delete`.
- Failure: `ex/raise :type :authorization :code :mcp-scope-required :hint "..." :required "<scope>"
  :granted [...]` (HTTP 403).

### Commands opted in with `::rpc/allow-token-types #{"mcp"}` (table 4.3 of the plan)

| scope | commands |
|---|---|
| `mcp:read` | `get-profile`, `get-teams`, `get-team`, `get-projects`, `get-all-projects`, `get-project`, `get-project-files`, `get-team-recent-files`, `get-team-deleted-files`, `get-file-info`, `search-files`, `get-file-stats`, `get-file-summary`, `get-file-tokens`, `get-file-plugin-data`, `get-file-libraries`, `get-team-shared-files`, `get-page`, `get-comment-threads`, `get-comments`, `get-comment-thread`, `get-file-snapshots`, `get-font-variants`, `export-binfile` |
| `mcp:manage` | `create-team`, `update-team`, `create-project`, `rename-project`, `update-project-pin`, `create-file`, `rename-file`, `set-file-shared`, `duplicate-file`, `duplicate-project`, `move-files`, `move-project`, `link-file-to-library`, `unlink-file-from-library`, `restore-deleted-team-files`, `import-binfile` |
| `mcp:delete` | `delete-project`, `delete-file` |
| `mcp:write` | `upload-file-media-object`, `create-file-media-object-from-url`, `create-comment-thread`, `create-comment`, `update-comment`, `update-comment-thread` (resolve/reopen), `update-comment-thread-status` (read state), `update-comment-thread-position`, `update-comment-thread-frame`, `delete-comment-thread`, `delete-comment`, `create-file-snapshot`, `restore-file-snapshot`, `update-file-snapshot`, `delete-file-snapshot`, `lock-file-snapshot`, `unlock-file-snapshot` |

Not opted in: `update-file`, `permanently-delete-team-files`, team membership, invitations, access-token,
webhook, `delete-team`, `leave-team`, profile/password/email commands. `send-mcp-feedback` keeps
`::rpc/token-type "mcp"` and needs no scope.

### Token management commands (session auth only, in `app.rpc.commands.access-token`)

- `update-mcp-token-scopes` `{scopes: [string]}`: replaces the `mcp:*` entries of the caller's current MCP token
  perms (other perms untouched). Allowed values: the four scopes. Returns `{id, scopes}`. Raises
  `:not-found :mcp-token-not-found` when the profile has no valid MCP token.
- `get-access-tokens` additionally returns `scopes` (vector) for rows of type `mcp`.
- Config `:mcp-token-max-age` (duration, optional, default nil = no expiry). When set, `create-access-token`
  and `ensure-mcp-access!` give MCP tokens `expires_at = now + max-age`.

### OAuth (`app.http.mcp-oauth`)

- `scopes_supported`: `["mcp" "mcp:read" "mcp:write" "mcp:manage" "mcp:delete"]`.
- `authorize` accepts `scope` as a space-separated subset of those; `"mcp"` means `mcp:read`. Default `"mcp"`.
- The staged request stores the requested scope list; the consent page already receives `:scope`.
- On approval the backend adds the requested scopes to the profile's MCP token perms (never removes any).
- The token response returns `scope` as the space-separated granted list.

## 2. Backend commands (new namespace `app.rpc.commands.mcp`, all `::rpc/token-type "mcp"`)

Common conventions:

- Every command checks `files/check-read-permissions!` or `check-edition-permissions!` exactly like the human
  path. Blocked/inactive profiles are rejected as in `send-mcp-feedback`.
- Reads bind `pmap/*load-fn*` to `fdata/load-pointer` and deref only the page pointers they need. `get-file` with
  realized data is never used.
- Results are plain maps; shapes are emitted with their Penpot attribute names (the JSON writer camelCases them).
  The type names stay Penpot's (`frame`, `rect`, `circle`, `text`, `path`, `bool`, `group`, `image`, `svg-raw`). The adapter shows `circle` as `ellipse` (section 4).
- Every command is `::audit/skip false` and attaches `::audit/replace-props` with
  `{tool, file-id, page-ids, change-count, change-types, revn-before, revn-after, duration-ms, token-id}`. It
  also records the Prometheus histogram `penpot_mcp_tool_duration_seconds{tool, outcome}` and counters
  `penpot_mcp_changes_total{tool, change_type}` and `penpot_mcp_errors_total{tool, code}` through `app.metrics`.
- Rate limits: `::climit/id [[:mcp-read/by-profile ::rpc/profile-id]]` on reads; writes use
  `[[:mcp-apply/by-profile ::rpc/profile-id] [:mcp-apply/global] [:update-file/by-profile ::rpc/profile-id]]`.
  `climit.edn` gains `:mcp-apply/by-profile {:permits 2 :queue 10 :timeout 60000}`,
  `:mcp-apply/global {:permits 10 :queue 50 :timeout 60000}`,
  `:mcp-read/by-profile {:permits 4 :queue 20 :timeout 30000}`. `rlimit.edn` gains a `#{:main/mcp-...}` entry
  per command with bucket `"6000/3000/1h"` for reads and `"1200/600/1h"` for writes.

### `mcp-whoami` (read)

Params: none. Result:
`{profileId, fullname, email, scopes: [..], tokenId, expiresAt|null, version: {full, base}, features: [..]}` where
`features` are the backend's supported features (`cfeat/supported-features`).

### `get-mcp-file-outline` (read)

Params `{file-id}`. Result:

```
{id, name, revn, vern, version, features: [..], projectId, teamId, isShared, modifiedAt,
 pages: [{id, name, index, shapeCount, rootChildCount}],
 libraries: [{id, name}],            ; from bfc/get-file-libraries
 components: n, deletedComponents: n, colors: n, typographies: n, media: n,
 tokens: {sets: n, themes: n, tokens: n, activeThemes: [..], activeSets: [..]} | null,
 pointerMap: bool}
```

Page summaries are cached in the backend in an `app.util.cache` LRU keyed `[file-id revn]` (max 4096 entries,
TTL 10 min). Building them derefs every page pointer once (deviation from the plan's "never deref pages";
the cache makes the cost a one-off per revn). `shapeCount` is `(dec (count objects))` (root excluded).

### `get-mcp-page-tree` (read)

Params `{file-id, page-id, root-id?, depth? (default 3, max 20), fields? [keyword], limit? (default 500, max 5000),
cursor?}`. Default fields: `id name type x y width height parent-id frame-id hidden blocked component-id
main-instance component-root shape-ref`. Always included: `id`, `type`, `children` (nested), `childCount`.
Traversal is depth-first in child order starting at `root-id` (default root `uuid/zero`). The children of a flex or grid layout come in visual order, the reverse of `:shapes`. Every other shape keeps `:shapes` order (section 3.2).
`cursor` is an opaque base64 string encoding `[page-id revn next-index]` over the pre-order sequence; a response
with `truncated: true` carries `nextCursor`. Result: `{revn, pageId, root: node, truncated, nextCursor?}`.
Text nodes expose `textLayoutState: "exact" | "approximate"` (approximate when `:position-data` is absent).
The box of a node is the one `get-mcp-shapes` reports (below), not the stored attrs.

### `get-mcp-shapes` (read)

Params `{file-id, page-id, ids: [uuid] (1..200), fields?, include-children? (default false)}`. Result
`{revn, shapes: [shape-map...], missing: [ids]}`. Shape maps are the full shape (all attrs) unless `fields`
limits them; `:thumbnail` is always dropped. With `include-children`, descendants are included in `shapes`.
Text shapes get `textLayoutState` and `characters` (plain text extracted from `:content`).

The box (`x`, `y`, `width`, `height`) is the one the plugin API reports, not the stored attrs: `x` and `y` are
the top-left corner of the bounding box of the shape's points, and `width` and `height` are the size of its
`selrect`, before rotation. `rotation` is reported separately. A shape without points (the page root) keeps its
stored attrs. The stored attrs go stale on a bool or path whose content changed and do not match the points of a
rotated shape; ask for `selrect` or `points` in `fields` to see the raw geometry.

Attrs that a shape does not store come back with the value Penpot assumes for them:

| Attr | Default | When |
|---|---|---|
| `hidden` | `false` | every shape |
| `blocked` | `false` | every shape |
| `opacity` | `1` | every shape |
| `stroke-alignment` | `center` (what the renderers assume) | each stroke in `strokes` |
| `layout-item-h-sizing` / `layout-item-v-sizing` | `fix` (what the plugin API reports) | a flex or grid board, and each child of one |

A text shape with `grow-type` `auto-width` or `auto-height` and no `:position-data` also gets
`textSizeApproximate: true`: its box is the backend's estimate (`create_text`, section 3) until a browser opens
the file and lays the text out.

### `find-mcp-shapes` (read)

Params `{file-id, page-id?, type?, name-regex?, name?, component-id?, has-token?, text-contains?, within-id?,
colors? [string], limit? (default 100, max 1000)}`. Searches one page, or all pages when `page-id` is absent
(pages iterated one by one, 5 s budget, `truncated: true` when the budget or limit is hit). Result
`{matches: [{id, pageId, name, type, path: "Board / Group / Shape"}], truncated}`. `name` is an exact,
case-sensitive match on the shape name; `name-regex` is a Java regular expression searched in the shape name
(`re-find`), so a partial pattern matches. Matches come in stored `:shapes` order, not visual order.
Matches carry no box; read it with `get-mcp-shapes`, which reports the box of the shape's points as the plugin
API does, with `rotation` apart.

### `get-mcp-library` (read)

Params `{file-id, kinds? [components colors typographies media], include-deleted? , limit? (default 500)}`.
Result `{components: [{id, name, path, mainInstanceId, mainInstancePage, variantId?, variantProperties?, deleted}],
colors: [...library color maps], typographies: [...], media: [{id, name, width, height, mtype}]}`.

### `get-mcp-tokens` (read)

Params `{file-id, resolve? (default false)}`. Result `{sets: [{id, name, active, tokenCount}], themes: [{id, group,
name, sets, active}], tokens: [{setId, id, name, type, value, description}], activeThemes, activeSets, dtcg}` where
`dtcg` is the `export-dtcg-json` document. `resolve: true` is accepted but resolution is adapter-side
(see deviations).

### `mcp-apply-changes` (write, scope fn: `mcp:read` when `dry-run`, else `mcp:write`)

Params `{file-id, base-revn?, changes: [raw change records], dry-run? (default false), snapshot? (bool, optional),
fail-on-conflict? (default false), request-id? (uuid)}`.

Rules:
- `skip-validate` is never forwarded (forced false).
- Refused change types: `:set-tokens-lib`, `:purge-component`, `:purge-typography`, `:purge-color` ->
  `:validation :mcp-change-type-refused`.
- `:add-media`/`:mod-media` and `:add-obj` fills/strokes with `fill-image`/`stroke-image` must reference media of
  this file or of a library the profile can read -> else `:validation :mcp-foreign-media`.
- Change count cap 2000 and payload cap 8 MB -> `:validation :mcp-batch-too-large`. A call may compile to at most 100000
  changes by default (config key `mcp-max-compiled-changes`). A call that compiles to more fails before any write with
  `:validation :mcp-batch-too-large` and a hint. Dry runs fail the same way.
- Snapshot policy (one per call): taken when the call contains any `:del-obj`/`:del-page`/`:del-component`/
  `:del-color`/`:del-typography`/`:del-media` change, or has more than 100 changes, or `snapshot` is true;
  `snapshot: false` only disables the ">100 changes" trigger, never the delete trigger. Label
  `mcp/<tool>/<ISO timestamp>/<request-id>`, `created-by "system"`, created inside the same transaction before the
  commit; the file's `mcp/`-labelled snapshots are pruned to the 20 newest first. A snapshot failure aborts the
  write with `:validation :snapshot-failed`. The snapshot holds the whole file: its pointer-map fragments are loaded
  into it, while its objects maps stay in their stored form, which restores to the same data. The automatic snapshot
  that the `auto-file-snapshot` flag takes during an MCP write is built the same way. On the 100,000-shape reference
  file this costs about 1.3 to 1.7 s per snapshot.
- Commit path: a public `files-update/update-file!` function (extracted from the `::update-file` method body) takes
  `cfg` and `{id, revn, vern, session-id, changes, features, skip-validate false, ::mcp-write? true}`. It runs the same lock,
  vern/revn checks, features, `update-file*`, `file-change` row, persist and notifications. Every call commits in one
  transaction. Its batches, if it has any, commit together or not at all. A failed call changes nothing: the file revn
  and its change rows stay as they were. Notifications to open tabs go out only after the transaction commits. The MCP
  session id is `(uuid/v5 ns-mcp (str token-id "/" request-id))` so open tabs apply the change live.
- `base-revn` is informational: when provided and lower than the stored revn, `warnings` lists `{kind: "revn-lag",
  baseRevn, storedRevn, changedShapeIds: [...]}` computed from the `file_change` rows newer than `base-revn`. The lag
  read covers at most 500 of those rows. When the read stops at that limit, or a stored row does not decode (that row is
  skipped and logged), the `revn-lag` warning carries `truncated: true`. The shapes it lists may be incomplete, so the
  overlap check may miss a conflict. A decode failure never fails the write. With `fail-on-conflict: true` and a
  non-empty intersection with the touched shape ids, the call fails with `:conflict :mcp-revn-conflict`. A move
  (`mov-objects`) or reorder (`reorder-children`) change touches its shapes and its parent, so both count as touched. A
  `reg-objects` change touches no shape for conflict purposes and never causes a conflict.
- Result `{revn, laggedCount: n, changeCount, changeTypes: {type: n}, snapshotId?, warnings: [...], dryRun, validation:
  {ok: true} | {ok: false, errors: [...]}}`. `dryRun` applies the changes to the loaded data in memory and runs the same
  checks as the commit path, chosen by the same feature flags. It runs the affected-shapes check when the
  `file-validation` flag is on, and the schema check when the `file-schema-validation` flag is on. It reports each error
  with the code the commit would raise. An affected-shape error carries `referential-integrity`, the code the commit
  raises, and the validator's own code as `detailCode`. Caveat: a dry run does not run the commit's auto-repair of
  pre-existing damage, so it can report an error that a commit would repair. The soft validation flags only log, so a
  dry run reports nothing for them. A dry run returns without touching the DB (`file.revn` unchanged). `laggedCount` is
  the number of change rows of other sessions committed after the call loaded the file. When the lag read is truncated
  (see the `base-revn` bullet), the result carries `laggedTruncated: true`. The flag is absent when the read is
  complete. The call's own rows are not counted and not returned. `dryRun` reports `laggedCount: 0`.

A call that writes (not a dry run) emits the same webhook event as the `update-file` RPC. The event name is
`update-file`, with the same payload keys (`id`, `name`, `features`, `project-id`, `team-id`, `revn`, `modified-at`)
plus the MCP audit props. Events are batched per file, with a two minute timeout. A dry run emits no event. The audit
log entry of a write is also named `update-file`; the tool name stays in the props as `tool`.

### `mcp-apply-operations` (write, same scope rule)

Params `{file-id, base-revn?, operations: [op...] (max 2000), dry-run?, snapshot?, allow-split? (default false),
fail-on-conflict?, request-id?}`. The operations are compiled by `app.common.mcp.operations/compile-operations` (section
3) against the latest file data inside the transaction, then committed through the same path as `mcp-apply-changes`
(same snapshot policy, counting operations instead of changes). With `allow-split: true` the compiled changes are split
at operation boundaries. A batch holds whole operations. It takes the next operation unless that would push its object
creations (`:add-obj` changes) past 300, and an operation that alone exceeds 300 goes in a batch of its own. The layout
reflow after the last operation goes into the last batch. Without `allow-split` the whole call is one batch. The batches
of a call still commit in one transaction, so they commit together or not at all, and the call makes one snapshot. Each
batch extends the revn the previous batch stored, with no read of the file in between. On a
failed call nothing changes. The error data carries `lastCommittedRevn`, the revn the file had when the call started,
because no batch is kept, and `failedChangeIndex`, the index in the compiled changes of the first change of the failed
batch. It also carries `failedOperationIndex` and `failedOperationLastIndex`, the first and the last operation of the
failed batch. Both are left out when the batch holds no operation.

The operations of one call compile to at most 100000 changes by default (config key `mcp-max-compiled-changes`). A call
that compiles to more fails before any write with `:validation :mcp-batch-too-large` and a hint. Dry runs fail the same
way.

Result `{revn, createdIds: {"$tmp:name": uuid, ...}, changeCount, changeTypes, commits: n, laggedCount, snapshotId?,
warnings, validation, dryRun}`. `laggedCount` is as in `mcp-apply-changes`, and `laggedTruncated: true` is set when that
read was truncated.

### `mcp-import-svg` (write)

Params `{file-id, page-id, parent-id?, svg: string, x?, y?, name?, dry-run?}`. Uses
`app.common.files.shapes-builder/create-svg-shapes` (parse with `app.common.svg/parse` on the JVM) and commits the
resulting `add-obj` changes through the same path. Result `{revn, rootId, shapeIds: [...], changeCount, laggedCount}`,
where `laggedCount` is as in `mcp-apply-changes`, and `laggedTruncated: true` is set when that read was truncated.
Embedded raster images are not uploaded (deviation; `import_image` first, then `create_image`).

### `create-mcp-render-session` (read)

Params `{file-id}`. Checks read permission on the file and mints a real session row for the profile with a
10-minute expiry (`:exp` claim), user agent `penpot-mcp-exporter`. Result `{token, expiresAt}`. The adapter uses
it as the `auth-token` cookie on exporter calls. Sessions are reused by the adapter until 1 minute before expiry.

## 3. Operation vocabulary (`common/src/app/common/mcp/operations.cljc`)

`compile-operations` is pure: `(compile-operations file-data operations opts) -> {:changes [...] :created-ids
{"$tmp:x" uuid} :warnings [...] :touched-page-ids #{...} :summary {...} :op-ranges [[start end] ...]}`. `opts` carries `{:new-id-fn uuid/next
:libraries {lib-id lib-data}}`. Operations run in order against a working copy (the changes builder with
`with-file-data`, applying each change locally) so later operations see earlier results. Any `id`/`parentId`/
`childIds`/`shapeIds` value may be a `$tmp:<name>` handle; a `create_*` op may set `id: "$tmp:<name>"` and later
ops reference it. Unknown handles, unknown real ids and schema violations raise
`:validation :mcp-invalid-operation` with `{index, op, hint}`. A schema failure on the operations vector reports the `index` and `op` of the first invalid operation. `:op-ranges` holds one `[start end]` per operation, end exclusive, into `:changes`, in operation order. Reflow changes after the last range belong to no operation.

Each op is a map `{op: "<name>", ...}`. Coordinates are absolute page coordinates. Shape props use Penpot attribute
names in kebab-case after JSON key conversion; the adapter documents them in camelCase. Enum values are strings.

| op | params | built with |
|---|---|---|
| `create_page` | `id?, name, index?` | `cb/add-page` with `(ctp/make-empty-page id name)` |
| `update_page` | `id, name?, background?, background-token?` | `cb/mod-page` |
| `delete_page` | `id` | `cb/del-page`; refuses the last page; removes components whose main is on the page |
| `move_page` | `id, index` | `cb/move-page` |
| `create_board` / `create_rect` / `create_ellipse` / `create_text` / `create_path` / `create_image` / `create_svg_raw` | `page-id, id?, parent-id? (default root), index? (a visual index in a layout, see 3.2), name?, x, y, width, height, props? (any shape attrs), plus: text -> `characters`, `grow-type?`, `font-size?`, `font-family?`, `font-id?`, `font-variant-id?`, `font-weight?`, `font-style?` (section 3.3), `fills?`; path -> `content` (path content vector) or `d` (SVG path string); image -> `media-id, media-width, media-height, media-mtype?`; svg_raw -> `content` | `cts/setup-shape` (types: frame, rect, circle, text, path, image, svg-raw) with `:parent-id`, `:frame-id` resolved from the parent; text content via `txt/change-text` on `cts/make-minimal-shape :text` content with `{:fills [{:fill-color "#000000" :fill-opacity 1}]}` default; sizes for `auto-width`/`auto-height` approximated as `width = 0.6*font-size*chars`, `height = 1.2*font-size*lines` and flagged in `:warnings` as `text-size-approximate`, and on later reads by `textSizeApproximate: true` in `get-mcp-shapes` until a browser lays the text out; then `cb/add-object`. For `create_path`, x, y, width and height come from the content bounds. |
| `create_group` | `page-id, id?, name?, child-ids` | group shape via `cts/setup-shape :group` sized to the children's selrect; the parent is the parent of the first child, and children with different parents are refused; `cb/add-object` then `cls/generate-relocate` of the children into it |
| `create_boolean` | `page-id, id?, name?, bool-type (union/difference/intersection/exclude), child-ids` | like group with `:type :bool` and `path/update-bool-shape` content; boards are refused as children; the head child gives the styles |
| `update_shape` | `page-id, id, props` | `cls/generate-update-shapes`. Geometry (x, y, width, height, rotation) goes through modifiers (`lm/generate-apply-modifiers`). Moving or resizing a board or group moves its children and applies constraints. For a rotated shape, x and y come from the points rectangle, as the workspace does. Props are validated against a partial shape schema; structural keys are refused. |
| `move_shapes` | `page-id, ids, parent-id, index?` (visual in a layout, see 3.2) | `cls/generate-relocate` |
| `reorder` | `page-id, parent-id, ids` (new child order, full list; visual order for a flex or grid parent, see 3.2) | `cb/reorder-children` |
| `delete_shapes` | `page-id, ids` | `cls/generate-delete-shapes` |
| `clone_shape` | `page-id, id, parent-id?, new-id?` (`newId` in the adapter; a `$tmp:` handle for the clone root) | `cll/generate-duplicate-changes` |
| `ungroup` | `page-id, id` | relocate children to the parent then delete the group |
| `flatten` | `page-id, ids` | `path/convert-to-path` then update; removes the descendants; skips shapes inside component copies |
| `make_mask` / `remove_mask` | `page-id, group-id` | `:masked-group` attr via update-shapes |
| `set_flex_layout` | `page-id, id, layout attrs (layout-flex-dir, layout-wrap-type, layout-gap, layout-padding, layout-justify-content, layout-align-items, layout-align-content, layout-item-h-sizing, layout-item-v-sizing)` | `ctl/*` attrs on the board, `:layout :flex`; then reflow (section 3.1). It reverses `:shapes` once when the board has children and no layout yet (section 3.2) |
| `set_grid_layout` | `page-id, id, layout-grid-rows, layout-grid-columns, gaps, paddings, align/justify` | `:layout :grid` attrs, `ctl/assign-cell-positions`; reflow |
| `remove_layout` | `page-id, id` | dissoc layout attrs |
| `set_layout_child` | `page-id, id, layout-item-* attrs` | update-shapes; reflow of the parent layout |
| `set_grid_cell` | `page-id, grid-id, child-id, row, column, row-span?, column-span?` | `ctl/*` cell helpers; reflow |
| `set_text` | `page-id, id, characters` | `txt/change-text` keeping styles; approximate resize for auto grow types |
| `set_text_style` | `page-id, id, attrs (font-family, font-id, font-variant-id, font-size, font-weight, font-style, line-height, letter-spacing, text-transform, text-decoration, text-align, vertical-align, fills)` | attrs are routed to the root, paragraph or leaf nodes of `:content`, for the whole text shape (ranges are a deviation). Font fields follow section 3.3 |
| `apply_typography` | `page-id, id, typography-id, library-id?` | typography attrs routed to the root, paragraph or leaf nodes, plus `typography-ref-id/file` |
| `create_component` | `page-id, shape-ids, name?, path?, id?` | `cll/generate-add-component`. `id` must be a `$tmp:` handle. It resolves to the new component id in `createdIds`, and later ops in the same call may use it. |
| `instantiate_component` | `page-id, component-id, library-id?, parent-id?, x, y, id?, overrides?` | `cll/generate-instantiate-component`, `overrides` as in section 3.4 |
| `detach` | `page-id, ids` | `cll/generate-detach-component` |
| `swap_component` | `page-id, id, component-id, library-id?` | `cll/generate-component-swap` |
| `reset_overrides` | `page-id, id` | `cll/generate-reset-component` |
| `update_main` | `page-id, id` | `cll/generate-sync-shape-inverse` |
| `rename_component` | `component-id, name, path?` | `cll/generate-rename-component` |
| `delete_component` | `component-id` | `cb/delete-component`; also deletes the main instance root |
| `restore_component` | `component-id, page-id?` | `cll/generate-restore-component` |
| `sync_components` | `component-ids?` (default all touched mains) | `cll/generate-sync-file` per component; with no ids, syncs only the mains touched in the same call |
| `create_color` / `update_color` / `delete_color` | library color map / `id` | `cb/add-color` / `update-color` / `delete-color` |
| `create_typography` / `update_typography` / `delete_typography` | typography map (font fields as in section 3.3) / `id` | `cb/add-typography` / ... |
| `create_token_set` / `update_token_set` / `delete_token_set` / `move_token_set` | `id?, name, active?` / `id, name?` / `id` / `id, before-id?` | `cb/set-token-set`, `clt/generate-move-token-set`; `create_token_set` with `active: true` enables the set after it is committed |
| `create_token` / `update_token` / `delete_token` | `set-id, id?, type` (names in section 3.4), `name, value, description?` | `cb/set-token` (nil token deletes) |
| `create_theme` / `update_theme` / `delete_theme` / `activate_theme` / `deactivate_theme` | `id?, group, name, sets: [set-names]` / `id` | `cb/set-token-theme`, `clt/generate-activate-theme` |
| `toggle_set` / `set_tokens_status` | `set-id` / `theme-ids, set-ids` | `clt/generate-toggle-token-set`, `cb/set-tokens-status` |
| `set_tokens_source` | `library-id` or null | `clt/generate-set-tokens-source` |
| `import_tokens_dtcg` | `json: string, mode: "merge" or "replace"` | `ctob/parse-multi-set-dtcg-json` + per-set/token `set-token-set`/`set-token` changes (replace deletes sets not in the document); reads `$metadata` (active themes and sets, set order) |
| `set_base_font_size` | `value: string` | `cb/set-base-font-size` |
| `apply_token` / `unapply_token` | `page-id, shape-ids, token-name, attributes: [attr]` , `resolved-value` (required for apply by the backend; the adapter fills it, see deviation 5) | `app.common.logic.token-application`. `apply-token-to-shape` takes the token name as its second argument. Also uses `token-geometry-changes` and `unapply-token-from-shape`. Sets `:applied-tokens` on each attribute and the attribute value to the resolved value (dimension/spacing/radius/color/opacity/rotation/stroke-width/sizing) |
| `add_interaction` / `remove_interaction` | `page-id, id, interaction map` / `page-id, id, index` | `cls/add-new-interaction` / update |
| `create_flow` / `remove_flow` | `page-id, id?, name, starting-frame` / `page-id, id` | `cb/set-flow` |
| `add_ruler_guide` / `remove_ruler_guide` | `page-id, id?, axis, position, frame-id?` / `page-id, id` | `cb/set-guide` |
| `set_board_grid_guides` | `page-id, id, grids` | `:grids` attr |
| `set_plugin_data` | `target: file/page/shape/component/color/typography, id?, page-id?, namespace, key, value` | `cb/set-plugin-data` |
| `align` / `distribute` | `page-id, ids, axis (hleft hcenter hright vtop vcenter vbottom) / (horizontal vertical)` | `app.common.geom.align` helpers; moves go through modifiers |

### 3.1 Layout reflow

After compiling the operations, `app.common.logic.modifiers/generate-reflow` is called with the ids of every
created, moved, resized or layout-changed shape and their parents. It finds the layout containers involved
(`ctl/any-layout?` on the shape or on its parent, plus `gm/find-auto-layouts`), builds a modif-tree of
`ctm/reflow-modifiers` from all the given ids, runs `gm/set-objects-modifiers`, and appends `mod-obj` changes produced by
`pcb/update-shapes` with `gsh/transform-shape` (attrs limited to the transform attrs the workspace uses,
`:ignore-touched true`, then `:reg-objects` for the parents). This is the pure part of the frontend's
`apply-modifiers*` / `update-layout-positions`. The resolve-tree climbs to the reflow root.
Standalone root-level rects and circles with no children are left out of the reflow, because a reflow does not
change them.

### 3.2 Child order in layouts

A flex or grid layout keeps its children in `:shapes` in the reverse of their visual order. The front child is the first
in `:shapes`. The rules below say which order each operation uses.

- `create_*` into a layout parent without `index` inserts at `:shapes` index 0, the last visual place. So creation order
  equals visual order.
- An explicit `index` on `create_*` and `move_shapes` into a layout is a visual index, counted from the first visual
  child. The `:shapes` index is the child count before the insert minus `index`, and never below 0.
- `reorder` takes the ids in visual order for a layout parent. The compiler reverses them into `:shapes`.
- `set_flex_layout` on a board that has children and no layout yet reverses `:shapes` once, so the children keep their
  creation order as their visual order. A board that already has a layout is not reversed. `remove_layout` does not
  reverse back, so a board that gets a layout again is reversed again.
- `set_grid_layout` never reverses. Grid cells come from the order of `:shapes`.
- The reversal on `set_flex_layout` is an MCP rule. The Penpot UI does not have it.
- `get-mcp-page-tree` returns the children of a layout in visual order. `find-mcp-shapes` walks stored order.

### 3.3 Font variants

`create_text`, `set_text_style`, `create_typography` and `update_typography` take `font-id` and the variant fields
`font-variant-id`, `font-weight` and `font-style`. The three variant fields must agree, and any one of them fills the
others. For the bundled font `sourcesanspro` the valid variant ids are `200`, `200italic`, `300`, `300italic`,
`regular`, `italic`, `600`, `600italic`, `bold`, `bolditalic`, `black` and `blackitalic`. `700` and `900` are not ids. A
weight and style pair maps through that table: 700 normal is `bold`, and 900 italic is `blackitalic`. Any other font
follows the numeric rule: `regular` is 400 normal, `italic` is 400 italic, `W` is weight W in normal style, and
`Witalic` is weight W in italic. Disagreeing fields raise `:mcp-invalid-operation` with a hint that lists the valid ids.
A shape created without any of the three keeps Penpot's defaults.

### 3.4 Tokens and component overrides

`create_token` and `update_token` accept the Penpot type names (`color`, `border-radius`, `font-size`, ...) and the DTCG
and plugin names: `borderRadius`, `fontSizes`, `fontSize`, `fontFamilies`, `fontFamily`, `fontWeights`, `fontWeight`,
`letterSpacing`, `textCase`, `textDecoration`, `borderWidth`, `boxShadow`, `dimension`, `sizing`, `spacing`, `opacity`,
`rotation`, `number`, `string`, `boolean`, `other`, `typography` and `shadow`. An unknown type raises
`:mcp-invalid-operation`.

`instantiate_component` takes `overrides`, an optional list of `{name?, path?, characters?, props?}`. The keys are
camelCase on the wire, and the backend converts them. Each entry names one shape of the copy with exactly one of these:

- `name`: the name of a descendant. It must match exactly one descendant of the copy.
- `path`: the names from the copy's root child downwards, joined by ` / `.

`characters` sets the text of a text shape. `props` sets non-geometry shape attributes. Geometry keys (`x`, `y`,
`width`, `height`, `rotation`) are refused; set geometry with `update_shape` on the new shape. An ambiguous or missing
target raises `:mcp-invalid-operation`.

## 4. Adapter tools (TypeScript, `PENPOT_MCP_MODE=backend|bridge|both`, default `both`)

Backend-mode tools are registered when the mode includes `backend` and `PENPOT_MCP_BACKEND_URI` is set. Bridge
tools (`execute_code`, `export_shape`, `import_image` through the plugin) keep their current names only when the
mode is `bridge`; in `both` mode the backend versions own the plain names and the bridge versions are registered
as `execute_code_in_tab`, `export_shape_from_tab`, `import_image_in_tab`. `high_level_overview`, `penpot_api_info`
and `submit_feedback` are shared.

Every backend-mode tool argument uses camelCase. Every write tool accepts `dryRun`, `snapshot`, `baseRevn`,
`failOnConflict`. Every tool response is JSON text (pretty printed) unless it carries images: `export_shape` returns one image block for a shape, or a count line followed by an id line and an image block per exported root shape for a page.

Type naming: the backend stores an ellipse as type `circle` and a board as type `frame`. The adapter shows `ellipse` in the
`get_shapes`, `get_page_tree` and `find_shapes` results and keeps `frame` for boards. `find_shapes` accepts `ellipse` and
`circle`, and `board` and `frame`, as the same type.

| tool | backend |
|---|---|
| `whoami` | `mcp-whoami` |
| `list_teams` | `get-teams` |
| `list_projects {teamId}` | `get-projects` |
| `list_files {projectId}` or `{teamId, query}` | `get-project-files` / `search-files`; `deleted: true` -> `get-team-deleted-files` |
| `get_file_outline {fileId}` | `get-mcp-file-outline` |
| `get_page_tree {fileId, pageId, rootId?, depth?, fields?, limit?, cursor?}` | `get-mcp-page-tree`; layout children in visual order |
| `get_shapes {fileId, pageId, ids, fields?, includeChildren?}` | `get-mcp-shapes` |
| `find_shapes {...}` | `find-mcp-shapes`; type `ellipse`, `circle`, `board` or `frame`; sent as `circle` or `frame`; matches show `ellipse` and `frame` |
| `get_library {fileId, kinds?}` | `get-mcp-library` |
| `get_tokens {fileId}` | `get-mcp-tokens` |
| `apply_operations {fileId, operations, ...}` | `mcp-apply-operations` (operation `op` names and camelCase params pass through; the adapter validates with zod per op, and reports the `index` and `op` of the first invalid one) |
| `batch_create_shapes {fileId, pageId, parentId?, tree}` | expands a nested tree into `create_*` ops with `$tmp:` handles, then `mcp-apply-operations` |
| `apply_raw_changes {fileId, changes, ...}` | `mcp-apply-changes` |
| `manage_files {action, ...}` | `create_team`, `rename_team`, `create_project`, `rename_project`, `pin_project`, `delete_project`, `create_file`, `rename_file`, `duplicate_file`, `duplicate_project`, `move_files`, `move_project`, `delete_file`, `restore_files`, `set_shared`, `link_library`, `unlink_library` -> the matching RPC |
| `manage_versions {fileId, action: list/create/restore/pin/unpin/delete/rename}` | snapshot RPCs |
| `comments {fileId, action: list/get/create_thread/reply/resolve/reopen/move/delete_thread/delete}` | comments RPCs |
| `import_image {fileId, base64? url? filePath?, mimeType?, name?, pageId?, parentId?, x?, y?, width?, height?, createShape?}` | multipart `upload-file-media-object` or `create-file-media-object-from-url`, then `create_image` op |
| `import_svg {fileId, pageId, svg, parentId?, x?, y?}` | `mcp-import-svg` |
| `import_archive {projectId, base64? filePath? url?, name?}` | multipart `import-binfile` (SSE response consumed to completion) |
| `export_shape {fileId, pageId, shapeId or "page", format png/svg/jpeg/webp/pdf, scale?, mode shape/fill, filePath?}` | exporter `POST /export` `{cmd: "export-shapes", wait: true, profileId, exports: [{fileId, pageId, objectId, type, suffix: "", scale, name}]}` with cookie `auth-token=<create-mcp-render-session>`, then the resource download; `mode: fill` downloads the media object via `/assets/by-id/<media-id>` with the render-session cookie. A `shapeId` other than `page` is first read with `get-mcp-shapes` (`fields: ["id"]`); a shape that the page does not hold fails before the export. `shapeId: "page"` (not with `mode: fill` or `filePath`) first reads the root shapes with `get-mcp-page-tree` (`depth: 2`, `limit: 5000`, `fields: ["name"]`); a page with no root shapes fails before the export. Then one `export-shapes` call per root shape, with that shape id as `objectId`, for the first 10 in page order; the images stop before their total passes 8 MB. The exporter renders one object per export, so there is no whole-page image |
| `execute_code {code, fileId, pageId?, snapshot?, baseRevn?, failOnConflict?, allowSplit?}` | QuickJS sandbox facade (separate brief). The guest core (`CoreSource.ts`) folds the updates and `appendChild` of a new board, rectangle or ellipse into its create op as the script queues them, so the 5000-operation cap counts operations after folding. `SandboxHost.flush` fills `apply_token` values, checks every operation, then sends the batch in `mcp-apply-operations` calls of at most 1500 operations each, in order, under one hold of the per-file write queue; a later call gets the ids that an earlier call created. Every call carries the write options; `baseRevn` advances to the revn of the script's last commit. A dry run (`file.validate()`) goes in one call and is refused above 2000 operations. A failed later call names its chunk and the operations committed before it. The response counts `flushes` (whole flushes and SVG imports), `chunks` (successful calls) and `opsApplied` |

### Adapter auth and limits

- `BackendTokenValidator`: on first use of a token (and at most every 60 s afterwards) calls `mcp-whoami`; the
  cache key is the SHA-256 hex of the token. 401 -> tool error "The MCP token was rejected by the backend"
  and the HTTP layer answers 401 with `WWW-Authenticate` when OAuth is enabled.
- `TokenRateLimiter`: token bucket per token fingerprint, 10 requests/s, burst 20; refusal text
  "rate limited, retry after N s".
- Writes on one `(token, fileId)` are serialised by an in-process queue so parallel tool calls never hit the
  backend `:update-file/by-profile` queue limit.
- `PENPOT_MCP_ALLOW_QUERY_TOKEN` (default `true`): when `false`, `?userToken=` is rejected with 401. When `true` a
  warning is logged once per token fingerprint.

## 5. Deviations from the plan (and why)

1. Page summaries deref every page once per revn and cache the result; no index table (plan D11).
2. Text sizes are heuristic (0.6 em per character, 1.2 em per line); no JVM font measurer and no reflow job yet.
   Shapes carry `textLayoutState: "approximate"` until a browser session reflows them.
3. `set_text_style` applies to the whole text shape; range styling is not implemented.
4. `import_svg` does not upload embedded raster images.
5. Token value resolution happens in the adapter for `apply_token`; the backend takes `resolvedValue`. Both write
   paths, `apply_operations` and the flushes of `execute_code`, use one resolver (`sandbox/ApplyTokenValues.ts` over
   `sandbox/TokenResolver.ts`): an `apply_token` without `resolvedValue` gets the token's value from the active sets
   of a `get-mcp-tokens` read, made once per call and only when the call holds an `apply_token`. A token that is
   missing, only in an inactive set, in a reference cycle or an unsupported expression fails the call before any
   write. A caller's `resolvedValue` is kept as an override; the result then carries a `token-value-differs` warning
   when it is not the resolved value, or `token-value-unchecked` when the token does not resolve. An `apply_token`
   after a token, set, theme or base-font-size write of the same call must carry `resolvedValue`, since the catalogue
   read is older than that write. `rem` uses 16px, because the catalogue does not carry the file's base font size.
6. `combine_as_variants` / `switch_variant` are not implemented (frontend-only logic not yet ported).
7. `mcp-token-max-age` defaults to no expiry so the settings UI text stays true; operators can set it.
8. `execute_code` previews attribute reads from the working copy without the ClojureScript `common` build;
   derived geometry is refreshed from the backend after each flush.
9. Parity decisions: match the Plugin API, not the UI. Default names are plain ("Rectangle", "Board", "Text") with no uniqueness suffixes, and `create_text` without width or height uses `grow-type auto-width`. `set_flex_layout` and `set_grid_layout` merge the initial layout and do not run `calculate-params` (the plugin passes `calculate-params? false`); they clear the children's constraints, as the frontend layout initializer does; `create_group` sets the children's constraints to `:scale` and takes the last child's grid cell.
10. Deferred, not implemented: variant ops (`combine_as_variants` and the other variant ops), `duplicate_component`, `sync_library_consumers`, and automatic sync of copies after editing a main. Agents call `sync_components` instead.
11. `import_tokens_dtcg` does not refuse duplicate token names inside one set. The DTCG parser merges same-named tokens before the op sees them. `create_token`, `update_token` and renames refuse duplicate names.
12. The props schema is closed. Operations that use an unknown key or a structural key fail with `:mcp-invalid-operation`. The structural keys are `id`, `type`, `parent-id`, `frame-id`, `shapes`, `component-id`, `component-file`, `component-root`, `main-instance`, `shape-ref`, `applied-tokens`, `position-data`, `selrect`, `points`, `transform`, `transform-inverse`.
13. `set_text_style` and `apply_typography` apply to the whole text shape, not to ranges. See item 3.
14. `apply_token` looks up the token type by name in the active sets. An unknown name raises `:mcp-unknown-id`. Token values are checked against the cfo schema for their type.
15. Every error from a failed op carries `:type :validation`, `:code :mcp-invalid-operation` (or `:mcp-unknown-id` for an unknown id, also with `:type :validation`), `:index` (the op index, `nil` for the reflow phase), `:op` (the op name, `"reflow"` for the reflow phase), and `:cause-code` (the original code). A literal id that already exists in its collection raises `:mcp-invalid-operation` with the hint "id already exists". A handle or id that is not known raises `:mcp-unknown-id`.
16. Performance: the benchmark test `bench-2000-update-shape-on-20000-shapes` (2000 `update_shape` ops on a page of 20,000 shapes) must finish under 5 s on the JVM. Props are decoded per key. Geometry updates receive only the shape's reflow subtree, its ancestors, and the immediate children of its group-like ancestors, not the whole page.
17. `delete_page` on a page whose components are used elsewhere: components whose main is on the page are deleted with it, as the frontend does.
