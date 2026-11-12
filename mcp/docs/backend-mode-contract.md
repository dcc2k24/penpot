# Backend-mode MCP: interface contract

Status: this document describes the code on branch `perf/render-wasm-large-files`. The code is the source of truth.
Where an older version of this text disagrees with the code, the code wins. The deviations from the plan are
listed in section 5.

All backend commands live under `POST /api/main/methods/<command>` (also `/api/rpc/command/<command>`). The
adapter always sends `Content-Type: application/json`, `Accept: application/json`, `X-Client: penpot-mcp`,
`Authorization: Token <mcp token>` (the backend reads `Token` for an access token; section 1.8). The backend middleware converts
JSON keys both ways: camelCase in requests becomes kebab-case keywords (`fileId` -> `:file-id`), and responses
are written back in camelCase. Keyword enum values travel as plain strings (`"frame"`, `"auto-width"`).
UUIDs travel as strings. Backend schemas therefore use kebab-case; the adapter uses camelCase.

Error payloads from the backend are JSON objects `{type, code, hint, ...}`. The HTTP status follows the error
type (section 2.15). The adapter renders them as `Backend error <code>: <hint>` plus any `context`/`explain`
field, never the raw stack.

## 1. Auth, flags and scopes

### 1.1 RPC metadata (backend `app.rpc`)

- `::rpc/token-type "mcp"`: only an MCP token may run the command.
- `::rpc/allow-token-types #{"mcp"}`: an MCP token may also run the command, next to sessions and personal tokens.
- `::rpc/mcp-scope`: `"mcp:read" | "mcp:write" | "mcp:manage" | "mcp:delete"`, or a function `(fn [params] scope)`
  that runs per request. The scope check runs only when the request authenticates with an MCP token. Sessions and
  personal tokens skip it.
- Every command that an MCP token can reach must declare `::rpc/mcp-scope`. The server refuses to start when one
  does not. There is no default scope for a command.

### 1.2 Switches

| Switch | Default | Effect when off or unset |
|---|---|---|
| Flag `enable-mcp-backend` | off | An MCP token reaches only `send-mcp-feedback`. Every other MCP command answers `mcp-backend-disabled` (HTTP 400). |
| Flag `enable-mcp-raw-changes` | off | `mcp-apply-changes` answers `mcp-raw-changes-disabled` (HTTP 400). Typed operations still work. |
| Profile prop `mcp-enabled` | on (absent or `true`) | Set to `false`, every MCP-token call of the profile answers `mcp-disabled` (HTTP 400), except the bridge call `send-mcp-feedback`. The token lookup (`app.http.access-token`) reads the prop with each MCP token, on every call. `wrap-authentication` (`app.rpc`) refuses the call after the backend switch and the token-type rules (section 1.8). Each MCP read and write also runs `check-profile!` (`app.rpc.commands.mcp`), which refuses the same prop. An OAuth approval sets the prop to `true`. |

### 1.3 Scope semantics (`app.rpc.mcp-scope`)

- A token's scopes are the `mcp:*` entries of its `perms` array.
- A token with no `mcp:*` entry has exactly `mcp:read`. Every token created before scopes existed, and every new
  token by default, is in this group.
- `mcp:write`, `mcp:manage` and `mcp:delete` each imply `mcp:read`. Nothing else is implied. `mcp:write` does not
  imply `mcp:manage` or `mcp:delete`.
- A refused call answers HTTP 403 with `{type: "authorization", code: "mcp-scope-required", required: "<scope>",
  granted: [...]}`.
- A dry run of a write needs only `mcp:read` (section 2.11).

### 1.4 Commands an MCP token can reach

With `enable-mcp-backend` on, these are the MCP-reachable commands. The scope column is the `::rpc/mcp-scope`
of the command. "Opt-in" means the command has `::rpc/allow-token-types #{"mcp"}`. "MCP only" means the command
has `::rpc/token-type "mcp"`.

| Scope | How reached | Commands |
|---|---|---|
| `mcp:read` | opt-in | `get-teams`, `get-projects`, `get-project-files`, `get-team-shared-files`, `get-team-recent-files`, `get-team-deleted-files`, `search-files`, `get-file-snapshots`, `get-comment-threads`, `get-comments` |
| `mcp:read` | MCP only | `mcp-whoami`, `get-mcp-file-outline`, `get-mcp-page-tree`, `get-mcp-shapes`, `find-mcp-shapes`, `get-mcp-library`, `get-mcp-tokens`, `create-mcp-render-session`, `send-mcp-feedback`, `get-mcp-subtree`, `get-mcp-interactions`, `find-mcp-connectors`, `get-mcp-fonts`, `get-mcp-page-lint`, `find-mcp-similar-boards` |
| `mcp:write` | opt-in | `upload-file-media-object`, `create-file-media-object-from-url`, `create-comment-thread`, `update-comment-thread` (resolve or reopen), `create-comment`, `update-comment-thread-position`, `create-file-snapshot`, `update-file-snapshot`, `lock-file-snapshot`, `unlock-file-snapshot` |
| `mcp:write` | MCP only | `mcp-apply-changes`, `mcp-apply-operations`, `mcp-import-svg`. Their scope is `mcp:read` when `dryRun` is true, else `mcp:write`. |
| `mcp:manage` | opt-in | `create-team`, `update-team`, `create-project`, `rename-project`, `update-project-pin`, `create-file`, `rename-file`, `set-file-shared`, `duplicate-file`, `duplicate-project`, `move-files`, `move-project`, `link-file-to-library`, `unlink-file-from-library`, `restore-deleted-team-files`, `import-binfile` |
| `mcp:delete` | opt-in | `delete-project`, `delete-file`, `restore-file-snapshot`, `delete-file-snapshot`, `delete-comment-thread`, `delete-comment` |

That is 60 commands: 42 opt-in and 18 MCP only.

Not reachable by MCP tokens: `update-file` (the editor save), `update-comment`, `get-comment-thread`,
`update-comment-thread-status`, `update-comment-thread-frame`, `get-file-info`, `get-file-stats`,
`get-file-summary`, `get-file-tokens`, `get-file-libraries`, `get-page`, `get-team`, `get-all-projects`,
`export-binfile`, team membership, invitations, access tokens, webhooks, `delete-team`, `leave-team`,
`permanently-delete-team-files`, and profile, password and email commands.

### 1.5 Render sessions

`create-mcp-render-session` (section 2.9) mints a session for the exporter. The session is restricted:

- The session middleware shows it only to the RPC routes (`/api/main/methods`, `/api/rpc/command`,
  `/api/management/methods`) and to `/assets`. Every other route sees no session.
- The OAuth consent routes refuse it. A render session cannot approve a scope request.
- `/assets`: the file-media routes (`/assets/by-file-media-id/...`, and its thumbnail route) serve a render session only
  the media of the files the session covers (`render-covers?`, `app.http.assets`). The `/assets/by-id/` route does not
  make that check. It checks only authentication and, for owner-scoped buckets, the owner.
- A restricted session may call only these commands: `get-profile`, `get-team`, `get-font-variants`, `get-page`,
  `get-file`, `get-file-fragment` and `get-file-libraries`. `get-profile` needs no file. The others must name a file
  the session covers. `get-team` must leave out `id`. `get-font-variants` must leave out `team-id` and `project-id`.
  Any other call answers `session-restricted` (HTTP 403).
- A restricted session is never renewed.
- A restricted session stops working when any of these holds: its 10-minute lifetime has passed; its token row was
  deleted or has expired (the session carries `:token-id`); the profile has MCP switched off.
- The garbage collector deletes restricted sessions 10 minutes after they were created.

### 1.6 Token management (session auth only)

- `update-mcp-token-scopes` `{scopes: [string]}`: replaces the `mcp:*` entries of the caller's hand-made MCP token (the
  row with `client_id` null). Other perms stay, and client tokens are not touched. Allowed values: the four scopes;
  the schema refuses any other value. Returns `{id, scopes}`. A token caller gets `session-required` (HTTP 403). A
  profile with no valid hand-made MCP token gets `mcp-token-not-found` (HTTP 404).
- `get-access-tokens` returns `scopes` (vector) for rows of type `mcp`, and `clientId` and `clientName` for each row.
  It returns the `token` field only for the hand-made MCP token. Client tokens never show their secret.
- Client tokens in the settings page: `get-access-tokens` lists them. `delete-access-token` `{id}` revokes one row.
- One MCP token per OAuth client. The row carries `client_id` and `client_name` (migration
  `0158-add-client-to-access-token`). Re-approval of a client replaces that client's token. A profile holds at most 20
  client tokens. A further client is refused with `mcp-client-limit` (restriction); an OAuth approval answers
  `access_denied` instead.
- Config `:mcp-token-max-age` (duration, default 90 days). An MCP token created without an explicit expiry gets
  `expires_at = now + max-age`. Set the key to change the age.

### 1.7 OAuth (`app.http.mcp-oauth`)

- `scopes_supported`: `["mcp" "mcp:read" "mcp:write" "mcp:manage" "mcp:delete"]`.
- `authorize` takes `scope` as a space-separated list of those values. `mcp` means `mcp:read`. The default is `mcp`.
  An unknown value is an invalid request.
- On approval the backend replaces the token of that client (the row with its `client_id`) with exactly the approved
  scopes. It leaves the hand-made token and the tokens of other clients alone. The approval also sets `mcp-enabled`
  to `true` for the profile.
- The consent page shows the scopes the client token will hold: the requested scopes, with `mcp:read` implied.
- The token response returns `scope` as the space-separated list of every scope the client token holds.
- A render session cannot approve (section 1.5).

### 1.8 Token transport

- The agent sends the MCP token to the adapter as `Authorization: Bearer <token>`. The adapter reads that header
  (`McpAuthentication.ts`).
- The adapter sends the token to the backend as `Authorization: Token <token>` (`PenpotBackendClient.ts`).
- The backend reads `Token` as an access token, personal or MCP (`app.http.middleware`, `app.http.access-token`).
  It reads `Bearer` as a session token. The session decoder accepts only the `authentication` issuer
  (`app.http.session`), so an MCP token sent as `Bearer` does not authenticate.

## 2. Backend commands

### 2.1 Common rules

- Every MCP read and write checks the profile first, in `check-profile!` (`app.rpc.commands.mcp`). Blocked, inactive
  and MCP-off profiles are refused (section 1.2). The RPC wrapper refuses an MCP-off profile's MCP token before the
  command runs (section 1.2).
- Every MCP read and write then checks `files/check-read-permissions!`, or `check-edition-permissions!` for a write.
- Reads bind `pmap/*load-fn*` to `fdata/load-pointer` and load only the page pointers they need.
- Results are plain maps. Shapes keep their Penpot attribute names, which the JSON writer camelCases. Type names
  stay Penpot's: `frame`, `rect`, `circle`, `text`, `path`, `bool`, `group`, `image`, `svg-raw`. The adapter shows
  `circle` as `ellipse` (section 4).
- Every MCP call runs through one wrapper. The wrapper logs one line (`mcp-tool`, with the request id and a token
  fingerprint), records the timing and the error code, and attaches the audit props `{tool, file-id, page-ids,
  change-count, change-types, revn-before, revn-after, duration-ms, token-id}`.
- Metrics (names as Prometheus shows them):
  - `penpot_mcp_tool_duration_seconds{tool, outcome}` (histogram)
  - `penpot_mcp_changes_total{tool, change_type}` (counter, writes only)
  - `penpot_mcp_errors_total{tool, code}` (counter)
  - `penpot_mcp_refusals_total{reason}` (counter; reasons `backend-disabled`, `scope` and `restricted`)
- Writes set `::audit/skip false`. A write (not a dry run and not a replay) is logged as an `update-file` audit
  event, and the tool name stays in the props.
- Rate limits: section 2.10.
- The `X-Request-Id` header, when it holds 1 to 64 letters, digits, dots, underscores or dashes, becomes the request
  id in logs. It does not change the write idempotency rule (section 2.11).

### 2.2 `mcp-whoami` (read)

No params. Result:

`{profileId, fullname, email, scopes: [..], tokenId, expiresAt | null, version: {full, base}, features: [..],
contractVersion, operations: [..], limits: {maxOperations, maxPayloadBytes, maxCompiledChanges}}`

- `scopes` are the effective scopes of the token (section 1.3).
- `features` are the backend's supported features, sorted.
- `contractVersion` is the contract version (section 6).
- `operations` lists the operation names the compiler accepts (section 3).
- `limits` gives the write limits of section 2.11.

### 2.3 `get-mcp-file-outline` (read)

Params `{file-id}`. Result:

```
{id, name, revn, vern, version, features: [..], projectId, teamId, isShared, modifiedAt,
 pages: [{id, name, index, shapeCount, rootChildCount}],
 libraries: [{id, name}],
 warnings: [{kind: "font-unresolved", fontId, family, reason, pageId, runs, suggestedFontId?, suggestedFamily?}],
 warningsComplete: bool, warningsTruncated: bool,
 warningsPendingPages: [{pageId, shapeCount, reason: "page-too-large" | "time"}], warningsPendingTruncated: bool,
 warningsCompleteWith?: "list_fonts",
 components: n, deletedComponents: n, colors: n, typographies: n, media: n,
 tokens: {sets: n, themes: n, tokens: n, activeThemes: [..], activeSets: [..]} | null,
 pointerMap: bool}
```

- `shapeCount` is the shape count of the page, the root excluded.
- `warnings` is a list, empty when no font is unresolved. It holds one entry for each page and each unresolved font on
  that page: pages in order, fonts by runs. At most 50 entries come back, and `warningsTruncated` is true when more
  exist. The warnings cover the pages that one call reads within one second. A page of more than 5,000 shapes is covered
  only when its font usage is already cached, which a `get-mcp-fonts` read does. `warningsComplete` is false when some
  pages are not covered, so the list may be short. `reason` is one of the font reasons of section 2.8d. The `pages`
  entries do not change. Font usage has its own cache per page (10 minutes), so a second outline call reads further
  pages.
- `warningsPendingPages` lists the pages that the warnings do not cover, in page order: `{pageId, shapeCount, reason}`.
  `reason` is `page-too-large` (above 5,000 shapes and not cached) or `time` (the one second ran out before the page).
  At most 50 entries come back, and `warningsPendingTruncated` is true when more exist. `warningsComplete` is true
  exactly when the list is empty. When it is not empty, `warningsCompleteWith` is `list_fonts` (the adapter tool for
  `get-mcp-fonts`); the key is absent otherwise. A whole-file `get-mcp-fonts` reply that is not `truncated` is the
  complete font report of the file: a client that needs the full picture reads it there and does not call the outline
  again. The outline warnings are a fast first look, complete only when `warningsComplete` is true. After such a reply,
  the next outline in the same backend process reports `warningsComplete` true with an empty list, also for a page
  above 5,000 shapes. The usage cache lives in one process for 10 minutes, so with several backend processes the outline
  may stay incomplete after `list_fonts`.
- A warning carries `suggestedFontId` and `suggestedFamily` when a font that resolves has the same family (section
  2.8d).

### 2.4 `get-mcp-page-tree` (read)

Params `{file-id, page-id, root-id?, depth? (default 3, 1 to 20), fields? [name], limit? (default 500, 1 to 5000),
cursor?, estimate-size?}`.

- `fields` takes names from the shape attributes, except `content` and `position-data`. At most 64.
- Default fields: `id name type x y width height parent-id frame-id hidden blocked component-id main-instance
  component-root shape-ref`.
- Every node also carries `id`, `type`, `children` (nested) and `childCount`. A text node carries
  `textLayoutState`.
- Traversal is depth-first from `root-id` (default `uuid/zero`). The children of a flex or grid layout come in
  visual order, the reverse of `:shapes`. The children of every other shape keep their stored order (section 3.2).
- The box of a node is the one `get-mcp-shapes` reports (section 2.5).
- The reply holds at most `limit` nodes and at most about 1,000,000 characters of encoded tree. Past that, `truncated`
  is true and `nextCursor` continues the walk.
- `cursor` is a base64 string of a transit vector `[page-id version index root-id depth]`. `version` is the page
  pointer id, or the file revn for a plain page. A cursor of another page, root or depth answers
  `mcp-invalid-cursor`. A cursor whose page changed answers `mcp-stale-cursor`. A cursor past the end answers
  `mcp-invalid-cursor`.
- A missing `root-id` answers `shape-not-found` (HTTP 404).
- The walk of a page (`root-id`, `depth`) is cached per page version (the version of the cursor), so the windows of one read
  after the first cost no second walk. A write to the page changes the version and the walk is made again.
- `estimate-size` (default false) adds `totalShapes` (the entries of the whole walk) and `estimatedBytes` to the
  result: the size of those shapes as `get-mcp-shapes` returns them, comma included, in UTF-8 bytes of JSON written
  without `\uXXXX` or `\/` escapes (the bytes of `JSON.stringify`). It splits the walk into about 400 equal strata
  (every shape when the walk is shorter), encodes one shape in each, picked by a hash of the stratum and the page
  version, and counts the stratum's width times the size of its shape. The part of a sampled size above 20 medians of
  the sample counts once, so one giant shape cannot make a page that fits look too large. The same page state always
  gives the same estimate. The adapter asks for it on the first window of a whole-page load of `execute_code`, and
  refuses a page whose estimate is above 1.3 times the cap before it reads the rest of the tree; the error says
  "estimated at about". The `get_page_tree` tool never asks for it.
- Result: `{revn, pageId, root: node, truncated, nextCursor?, totalShapes?, estimatedBytes?}`.

### 2.5 `get-mcp-shapes` (read)

Params `{file-id, page-id, ids: [uuid] (1 to 200), fields?, include-children? (default false), include-ancestors?
(default false)}`. Result `{revn, shapes: [shape-map...], missing: [ids], truncated}`.

- `fields` takes names from the shape attributes. `content` and `position-data` come back only when named.
- Without `fields` a shape map carries every attribute except `thumbnail`, `content` and `position-data`.
- With `include-children`, the descendants come with the requested shapes. At most 2000 shapes come back in all.
  The page root cannot be requested with its children (`mcp-root-children-not-allowed`, HTTP 400).
- Order: the requested shapes in the order given, each followed by its descendants in stored child order, all the
  children of a shape before the descendants of its first child. It is not the visual order of `get-mcp-page-tree`: a
  flex or grid board lists its children reversed. A child id that the page does not hold is left out.
- With `include-ancestors`, the ancestors of the requested shapes come first, up to and including the page root, each
  chain top down and each shape once. A shape that the reply holds as a requested shape or a descendant is not
  repeated. They count in the 2000 shapes and the byte budget, so a cut reply drops the tail, not them.
- The reply stops at about 1,000,000 characters of encoded shapes. Then `truncated` is true. Ask again for the ids
  that are missing from the reply.
- Text shapes carry `characters` (plain text of `:content`) and `textLayoutState`. They carry
  `textSizeApproximate: true` when their box is an estimate (grow type `auto-width` or `auto-height`, and no
  `:position-data`). `fields` may name `text-layout-state` and `characters`, which the backend computes for every
  text; any other shape answers nil for them.

The box (`x`, `y`, `width`, `height`) is the one the plugin API reports, not the stored attributes. `x` and `y` are
the top-left corner of the bounding box of the shape's points. `width` and `height` are the size of its `selrect`,
before rotation. `rotation` is reported apart. A shape without points, such as the page root, keeps its stored
attributes. Ask for `selrect` or `points` in `fields` to see the raw geometry.

Attributes that a shape does not store come back with the value Penpot assumes for them:

| Attr | Default | When |
|---|---|---|
| `hidden` | `false` | every shape |
| `blocked` | `false` | every shape |
| `opacity` | `1` | every shape |
| `stroke-alignment` | `center` | each stroke in `strokes` |
| `layout-item-h-sizing` / `layout-item-v-sizing` | `fix` | a flex or grid board, and each child of one |

### 2.6 `find-mcp-shapes` (read)

Params `{file-id, page-id?, type?, name-regex?, name?, component-id?, has-token?, text-contains?, within-id?,
colors? [string] (at most 50), limit? (default 100, 1 to 1000), max-bytes? (1000 to 1,000,000, default 1,000,000),
cursor?}`.

- `type` takes one of `frame group bool rect path text circle svg-raw image`.
- Searches one page, or every page when `page-id` is absent, one page after the other. The whole search has a
  5 s budget. The budget starts when the first page is in memory, not at the call, so a slow first read of a large
  page does not spend it. A call examines at least one shape before it reads the clock, so every call moves on.
  `truncated: true` when the budget, the limit or the byte budget stops the search.
- `name` is an exact, case-sensitive match on the shape name.
- `name-regex` is a Java regular expression, at most 200 characters, searched in the shape name (`re-find`). An
  invalid expression answers `mcp-invalid-regex` (HTTP 400). A pattern that runs too deep answers
  `mcp-invalid-pattern` (HTTP 400).
- `text-contains` matches the characters of text shapes, ignoring case. `has-token` matches shapes with at least one
  applied token (`true`), or none (`false`). `colors` matches fill and stroke colors and the colors of local library
  references.
- Result `{matches: [{id, pageId, name, type, path: "Board / Group / Shape"}], truncated, scanned, reason?,
  nextCursor?, skipped?, skippedIds?, skippedLarge?, skippedLargeIds?}`. The path skips the page root and stops after 1000 ancestors. `scanned` counts
  the shapes the call examined. The search stops at the first match that fits alone but not next to the matches it
  holds, so it does not scan what the size cut would drop. That shape is the first one of the next call: over a
  walk that ends by size on every call, the sum of `scanned` is the number of shapes the search visits plus one per
  call after the first. `skipped` and `skippedIds` (at most 20 ids) appear only when the call left out a
  shape whose name ran the `name-regex` past the budget with nothing examined before it, which the call does to
  move on; the shape is not searched again. `skippedLarge` and `skippedLargeIds` (at most 20 ids) appear only when
  the call left out a match that alone does not fit in the `max-bytes` budget of an empty reply (a very long name or
  path). The count is exact. The cursor moves past such a match, so paging always goes on; read the shape with
  `get-mcp-shapes` or `get-mcp-subtree`. A search that ends early returns the matches it has, and `truncated` is true with a `reason` and a
  `nextCursor`: `size` (the matches reached `max-bytes`, counted as the UTF-8 bytes of their JSON, less 512 bytes for the rest of the
  reply; whole matches only), `limit` (more
  than `limit` matches exist) or `time` (the budget ran out). Send `nextCursor` back as `cursor`, with the same
  filters, to go on. The cursor has the shape of a page-tree cursor: page id, page version, entry index, root id, and
  in the last slot a hash of the filters and of the ordered page ids of the search. A cursor sent with other filters
  (`type`, `name`, `name-regex`, `component-id`, `has-token`, `text-contains`, `colors`, `page-id`), another
  `within-id` or junk answers `mcp-invalid-cursor`. A cursor whose page changed, or made when the file had other
  pages (added, removed or reordered), answers `mcp-stale-cursor`. The adapter sets `max-bytes` to 85 % of its
  response cap and the backend counts bytes as the adapter does, so the adapter's own cut does not apply.
- `within-id` limits the search to the subtree of one shape on the page.
- Matches come in stored `:shapes` order, not in visual order. Matches carry no box. Read the box with
  `get-mcp-shapes`.

### 2.7 `get-mcp-library` (read)

Params `{file-id, kinds? [components colors typographies media] (at most 4), include-deleted?, limit? (default 500,
1 to 5000)}`.

Result:

- `components`: `{id, name, path, mainInstanceId, mainInstancePage, variantId?, variantProperties?, deleted}`
- `colors`, `typographies`: the library maps, sorted by name
- `media`: `{id, name, width, height, mtype}`, sorted by name then id
- `totals`: the full count of each section, keyed `components`, `colors`, `typographies`, `media`
- `truncated`: true when any count is above `limit`

A section that `kinds` leaves out comes back empty. Each section holds at most `limit` items.

### 2.8 `get-mcp-tokens` (read)

Params `{file-id, set-id?, format? ("tokens" default, or "dtcg")}`. The schema refuses any other key, so `resolve` is
not accepted.

- `set-id` limits the sets and the tokens to one set. An unknown id answers `token-set-not-found` (HTTP 404).
- `format: "tokens"` returns the flat token list. `format: "dtcg"` returns the DTCG export under `dtcg`, with no flat
  list. The reply never carries both.
- Result: `{sets: [{id, name, active, tokenCount}], themes: [{id, group, name, sets, active}], activeThemes,
  activeSets, tokens: [{setId, id, name, type, value, description}]}`, or `dtcg` in place of `tokens`.

### 2.8a `get-mcp-subtree` (read)

Params `{file-id, page-id, root-id?, cursor? (string, at most 4096), limit? (int 1 to 5000, default 500),
max-bytes? (int 1000 to 1000000, default 1000000), max-json-bytes? (int 1000 to 4000000), compact? (boolean)}`.
`root-id` defaults to the page root (`uuid/zero`).

The walk is depth-first and pre-order, with the children in stored `:shapes` order (bottom first). The root is the
first shape, except the page root, which is skipped. The children of the page root then have depth 0. A shape that is
reached a second time, by a cycle in a corrupt child list or by a second parent, is listed once, at its first place, so
a cycle cannot loop the walk. A child id with no shape on the page is skipped, and not counted in `total`.

The walk of a root on one page version is cached for 10 minutes, so the windows of one export walk the page once. The
cache holds 400,000 entries in all. The version is part of the key, so a changed page walks again.

Each shape carries:

- every stored attribute except `thumbnail`, so `content`, `position-data`, `points`, `selrect`, `transform`,
  `transform-inverse`, `fills`, `strokes`, `shadow`, `blur`, `interactions`, `shapes`, `parent-id` and `frame-id`
  come too. A path's or boolean's `content` is its SVG path string in page space (absolute `M`, `L`, `C` and `Z`
  commands). A text's `content` is its tree of paragraphs;
- the defaults of section 2.5, and the box of section 2.5 (`x`, `y`, `width`, `height`);
- `characters` for a text shape;
- `depth` (0 for the first level of the walk) and `index` (its place in the whole walk, from 0);
- `world-matrix` `{a, b, c, d, e, f}` when the shape has a `selrect`: the affine matrix that maps the four corners of
  the `selrect` (top-left, top-right, bottom-right, bottom-left) onto the four `points` (index 0 to 3), in order. It is the
  candidate whose corners land nearest to the `points`, as below. On ordinary data the result is within 0.01 px of the
  `points` (measured on a page of 26,097 shapes), also for a shape with a zero or tiny side. A flat shape under a
  rotation that no longer matches its stored `transform` has no correct candidate and can be off.
  - The fit from the `points` (`transform-points-matrix` of `app.common.geom.shapes.transforms`) is used when both
    sides of the `selrect` are at least 0.05 px (`min-box-side`), the matrix is not singular (its determinant is not 0
    within 1e-9: two or more `points` coincide, or all lie on one line), and no corner is further than 0.01 px
    (`max-fit-residual`) from its point. For a flipped group it can differ from the stored `transform`: an import can
    keep an identity `transform` with mirrored `points`, and the matrix follows the `points`.
  - When the fit and the stored `transform` about the centre of the `selrect` move every corner by less than 0.05 px
    (`snap-distance`) of each other, the stored one is returned exactly, so plain shapes carry no float noise.
  - Otherwise (a side under 0.05 px, a singular or bad fit) the result is the candidate whose `selrect` corners land
    nearest to the `points`, the first of these on a tie: the stored `transform` about the centre; the fit, when the box
    is solid and the fit is not singular; and, for a degenerate box or a usable fit, the stored one mirrored about the
    centre on x, on y and on both. A mirrored ancestor mirrors the `points` of a flat shape, which cannot be fitted.
  - A shape with no four `points` has the stored `transform` about the centre. A shape without `selrect` has no
    `world-matrix`. The function is `get-world-matrix`.

Result `{revn, pageId, rootId, total, shapes, truncated, nextCursor?}`, and `compact` and `defaults` with `compact`.
`total` counts the whole walk.

Names that differ from the stored file. The command returns the stored names. The adapter shows these:

| Stored in the file | Shown by the tools | Notes |
|---|---|---|
| shape type `circle` | `ellipse` | `find_shapes` accepts `ellipse` or `circle` as `type`. The create op is `create_ellipse`. |
| shape type `frame` (a board) | `frame` | `find_shapes` accepts `board` or `frame` as `type`. The create op is `create_board`. |
| kebab-case attribute keys, such as `fill-color` | camelCase keys, such as `fillColor` | Every read tool and every write tool. |

Caps: a window holds at most `limit` shapes. It stops before the shape that would take its size past the budget. It
always holds one shape at least, so a walk always moves on. When shapes remain, `truncated` is true and `nextCursor` is
set.

- `max-bytes` (the default, 1000000) counts the transit text of each shape, which is not the size of the JSON reply.
- `max-json-bytes` counts the JSON text of the window as the HTTP layer writes it for a client that sends
  `Accept: application/json`: the same encoder, camelCase keys, and the commas and brackets of the array. The array of
  a window of two or more shapes is never longer than `max-json-bytes`. The hard maximum is 4000000. A window of one
  shape can be longer, since the shape is returned alone. A call gives `max-bytes` or `max-json-bytes`, not both
  (`mcp-invalid-window`). Cursors do not depend on the unit, so a walk may change it between windows.
- `compact: true` leaves out of each shape the keys whose value is `nil`, and the keys whose value is a default that
  section 2.5 adds: `hidden` false, `blocked` false and `opacity` 1. The `strokeAlignment` `center` of a stroke is left
  out of each stroke. The reply carries `compact: true` and `defaults`, `{hidden: false, blocked: false, opacity: 1,
  strokes: {strokeAlignment: "center"}}`. A consumer puts `hidden`, `blocked` and `opacity` back on a shape that lacks
  them, and `strokeAlignment: "center"` into each stroke of `strokes` that lacks it. `defaults.strokes` is not the value
  of a missing `strokes` key: a shape with no `strokes` key has none to adjust. A top-level key that is absent and has
  no default was nil or not stored. The sizing of layout items
  (`layoutItemHSizing`, `layoutItemVSizing`) depends on the parent, so it stays. Only the keys of the shape are
  looked at: a nil inside a fill or in a text's `content` stays. `max-json-bytes` measures the compact shapes.

Cursor: opaque. It encodes `[page-id version index root-id 0]`, where `version` is the page version (section 2.4).
A cursor of another page or root is `mcp-invalid-cursor`. A cursor whose version is not the page's is
`mcp-stale-cursor`. A cursor past the end is `mcp-invalid-cursor`. A root the page does not hold is
`shape-not-found` (HTTP 404).

Audit props: `file-id`, `page-ids`, `revn` and `token-id`. The command runs through `run-tool`.

### 2.8b `get-mcp-interactions` (read)

Params `{file-id, page-id, limit? (int 1 to 5000, default 1000)}`.

Result `{revn, pageId, flows, shapes, totalInteractions, totalShapes, truncated}`:

- `flows`: each flow of the page as `{id, name, startingFrame, startingFrameName}`. Flows are sorted by name, then id.
  `startingFrameName` is left out when the starting frame is not on the page.
- `shapes`: every shape with at least one interaction, in walk order (stored order, pre-order), as
  `{id, name, type, frameId, path, interactions}`. `path` is the one of section 2.6. The walk skips a repeated shape
  and a missing one, as section 2.8a does.
- Each interaction is the stored map, plus `destinationName` when its `destination` is a shape on the page. A point
  such as `overlay-position` (on an `open-overlay` or `toggle-overlay` action) comes as `overlayPosition: {x, y}`, in
  page coordinates.
- `totalInteractions` and `totalShapes` count the whole page.

Caps: at most `limit` shapes, and at most the response budget of about 1,000,000 encoded bytes. `truncated` is true
when either one cut the list.

### 2.8c `find-mcp-connectors` (read)

Params `{file-id, page-id, max-distance? (number 0 to 2000, default 64), limit? (int 1 to 2000, default 500),
offset? (int 0 or more, default 0), within-id? (uuid), depth? (int 1 to 12), mode? (depth or auto), board-name-regex? (string, 200 at most),
include-same-screen? (boolean, default false)}`. `within-id` limits the scan to the shapes under that shape; the shape
itself is not a candidate. A `within-id` that the page does not hold is `shape-not-found`. `depth`, `mode` and
`board-name-regex` select the screens exactly as in `get-mcp-page-lint` (2.8e): with none of them the mode is `auto`;
`mode` auto with `depth` is `mcp-invalid-board-selection`.

It finds the arrows and lines that run between two screens. Candidates are the visible `path` and `bool` shapes, and
the visible groups drawn as an arrow, the shallowest first, in walk order within a level. A candidate is skipped when
it is hidden, when a hidden ancestor hides it, when it is a child of a boolean (a boolean draws its children as one
shape), when it is a child of a group drawn as an arrow, or when `within-id` is set and it is not under that shape.

A group is drawn as an arrow when it has 2 to 6 visible children, all of type `rect`, `circle`, `path` or `bool` (so no
text, frame, image or group), and its box is elongated or thin: its longer side is at least 3 times its shorter side,
or its shorter side is at most 24 px. It also needs the anatomy of one arrow: one shaft, the child with the largest
ratio of length to width, that spans at least 0.7 of the longer side of the group, and every other child within twice
the shaft width of one of the two ends of the shaft (from the box of the child to the end point). Any other group, such
as a row of arrows or two opposite arrows side by side, is no arrow: its paths are candidates. A connector made of an
arrow group has `composed` true, and the id, name and type (`group`) of the group. Known limit: a `rect` is a candidate only inside a group, and a group is an arrow only with that anatomy, so an arrow
whose shaft is split in two pieces, or a group with a label rect in the middle of the shaft, is not read as an arrow:
only its head path stays a candidate.

Frames are the visible frames, measured by the true bounding box of their points, so a rotated frame counts as it is
drawn. The page root is not a frame. Screens are the boards that the selection gives (`select-boards`, as in 2.8e).

Ends of a candidate. An open path with a stroke (no close command): its first and last points. Any other shape (a
closed or filled path, a boolean, a group): the outline is flattened (every curve is cut into 8 straight pieces, or 1
above 1,500 segments), and the direction rules below give the ends. With no head, they are the two farthest points of
the outline, found by three farthest-point passes (the point farthest from the centroid, the point farthest from that,
and the point farthest from the second); above 400 points every k-th one is used.

Snap: each end snaps to the nearest frame within `max-distance`. The distance is 0 inside a frame. Frames that are
ancestors of the candidate are left out, and so are frames that hold both ends. Frames within 1 px of the nearest are
tied. Of those, the outermost frame wins (the one that is an ancestor of the others). If none is, the frame with the
largest area wins. A candidate whose two ends both lie inside its nearest ancestor frame is skipped when that frame
holds no frame: it is a shape inside one leaf frame. It is not counted in `same-screen-skipped`.

The screen of an end is found apart from its frame. The targets are the selected boards (the screens) and the loose
frames: visible frames that are neither selected nor inside a selected board, such as a decision frame between screens.
A frame that holds a selected board (a section, a journey group) is never a target. The end belongs to the nearest
target within `max-distance`, by the distance of the snap (0 inside). A screen's wrapper here is its parent frame when that
frame holds only that screen, centred within 2 px (`margin-tolerance`), with gaps up to 400 px (`max-centered-margin`).
This is not the wrapper of the board selection (2.8e), which is stricter: at most 200 px and at least 90 % of a size
class. An end within `max-distance` of the wrapper, or of one of the screen's overlays (step 8a), is a candidate for the
screen, and the nearest screen by true distance wins. The overlays and the frames inside them are no targets. `distance`
is measured to the screen and may exceed `max-distance`; when the end is not in a wrapper or overlay of the chosen
screen, the reported `distance` can still be the snapped frame's distance. On a tie a screen wins over a loose frame, then the smaller area, then walk order. A screen gives `screen-id` and `screen-name`. A loose frame, or no target within
reach, gives `non-screen` true and no screen keys. A grid over the targets keeps the look-up cheap on a page of many
screens. The snap of an end to a frame reads a grid over the frames in the same way, and chooses as a plain loop over
all frames would.

A candidate is a connector when both ends snap to a frame (`board-id`) and the targets of its ends differ. An arrow
drawn inside a screen is found too: when an end snaps to no frame (the screen is an ancestor of the arrow, and no other
frame is near) but both ends have a target, the connector is kept when the targets differ, and the `board-id` and
`board-name` of that end are those of its target. When both ends have the same screen as target and no frame, the
connector is in one screen and is counted as below. When both
ends belong to one screen and the frames differ, the connector is in one screen: it is dropped, and
`same-screen-skipped` counts it; with `include-same-screen` true it is returned, with `same-screen` true. When both ends
snap to one frame and belong to one target, the candidate is no connector and is not counted. When an end has no target,
the ends must snap to two different frames. A connector with one or two `non-screen` ends is kept.

Direction. Each connector has `direction` and `confidence`.

- `cap` (confidence `high`): exactly one end of an open path has an arrow cap on a stroke (`line-arrow` or
  `triangle-arrow`). That end is `to`. Caps count on open paths only. An open path with a stroke and no single cap has
  direction `none`.
- `shape`, `both` or `none`, for an outline. The outline is the flattened, simplified subpaths (points closer than
  0.05 px merged, points on a straight run dropped; a point goes only when it and the points dropped before it stay
  within 0.05 px of the chord to the next point, so a densely sampled curve keeps its shape). The shaft width `w` is
  twice the area over the perimeter; the area of a subpath wholly inside another (a hole) is taken off. A head tip is a
  vertex that lies on the convex hull of the outline, has an interior angle of at most 80 degrees, has both edges at
  least 1.2 `w` long, and is an extremity: no outline point lies beyond it along its outward bisector by more than
  10 % of the extent of the outline in that direction.
  - When no such sharp tip exists, a second rule looks for a rounded or blunt tip and for a wide one, always with
    confidence `medium`. Rule 2 runs only on an elongated outline: its length, the distance between its two farthest
    points, is at least 4 `w`. A capped tip: on the convex hull, two edges of at least 1.2 `w`, separated by a cap (one or
    more shorter edges, 0.75 `w` long together at most), whose lines meet beyond the cap at 20 to 100 degrees. The tip
    is the middle of the cap along its length, a point of the outline, and must be an extremity as above. A wide tip: a
    vertex as above with an angle above 80 and up to 100 degrees, on an outline at least 4 `w` long. Both must also
    lie on the axis: the inward bisector of the tip is within 20 degrees of the line to the outline point farthest
    from it. So the corners of a rectangle are no tips, and neither is the apex of a V of 90 degrees. A plain bar, a
    capsule, a circle and a square on its corner gain no tip.
  - One tip: `shape`. The tip is `to`, and `from` is the outline point farthest from it. Confidence `high` when the
    angle is at most 60 degrees and the outline is at least 1.5 `w` wide within 3 `w` of the tip, across the bisector;
    else `medium`.
  - Two or more tips: `both` only when the outline is elongated (at least 4 `w` long) and the two tips farthest apart
    are two heads: their outward bisectors point
    opposite ways (dot product of the unit vectors below -0.5), and each lies within 10 % of the extent of the outline,
    along the line through them, of an end. Those two are the ends, `from` the one further left (or, on the same x,
    further up). Confidence `medium`. Otherwise there is one head, the tip that the outline extends farthest behind
    along its own bisector, and the result is as for one tip. So a short arrow with a wide head is not `both`.
  - No tip: the ends are the two farthest points, the direction is `none` with confidence `none`, and `from` is the end
    further left, or on the same x, the one further up. A shape whose head cannot be read has direction `none`: take
    the direction then from other evidence, such as labels or the order of the screens. No other rule (such as the
    width of the ends) gives a direction, and `low` does not occur.
- A group drawn as an arrow is one outline made of its children (a rect as its four corners, a circle as 32 points, a
  path as its flattened subpaths). The shaft is the child with the largest ratio of length to width (an open stroked
  path has at least its stroke width as width), and its width is `w`. Hull and extremity are taken over all children,
  and a tip on the shaft does not count. The result is as for an outline.

Direction is read only from heads: arrow caps on strokes, a head shape on the path, or a head grouped with the line.
Bare bars and unions of rectangles read `none` by design. Designers who want machine-readable flows should use
`line-arrow` caps or prototype links.

Result `{revn, pageId, scanned, connectors, total, selection, deeper-boards?, same-screen-skipped, non-screen-ends,
truncated, next-offset?, timed-out?}`. `scanned` counts the candidates looked at. `selection` and `deeper-boards` are those of `select-boards`
(`deeper-boards` is left out when it has none). `non-screen-ends` counts the ends, in all the connectors found, that
are `non-screen`. Each connector is `{id, name, type, direction, confidence, length, from, to}`, with `same-screen`
true only when `include-same-screen` returned it, and `composed` true only for a group. `length` is the straight
distance between the two ends, not the length of the path. `from` and `to` are `{boardId, boardName, screenId?,
screenName?, nonScreen?, distance, x, y}`, where `boardId` is the snapped frame and `distance` is the distance of that
end to it.

Caps: the board selection and the scan of the candidates stop after 5 seconds. The building of the frames, the screens,
the grids and the candidates is linear in the shapes and does not check the clock.

Paging. The scan covers every candidate and does not stop at `limit`. The connectors come in a fixed order, the
shallowest level first and walk order within a level, which depends only on the file at one `revn` and on the params.
`total` counts all the connectors found. `scanned`, `same-screen-skipped`, `non-screen-ends` and `total` do not change
with `offset` or `limit`. `offset` skips that many connectors, then `limit` applies. `next-offset` is the `offset` of
the next page, and is there only when connectors remain after the ones returned and the scan did not time out. An
`offset` past the end gives an empty list and no `next-offset`. `truncated` is true when connectors remain or when the time limit cut the work.
`timed-out` is there, and true, only when the scan or the selection ran out of time: the list is then not complete,
`total` is what the scan found, and there is no `next-offset`, because each call selects its screens under its own
clock and a later page could come from another list. Start again with a narrower call (`within-id`,
`board-name-regex`).

### 2.8d `get-mcp-fonts` (read)

Params `{file-id, page-id?, root-ids? (vector of uuid, 1 to 200; needs page-id)}`.

The font of a text run is the `font-id` of its text leaf, `sourcesanspro` when the leaf names none. A leaf with no
characters is not a run. The variant of a run is its stored `font-variant-id`, else its style and weight.

Source of a font: `builtin` (a bundled family), `google` (an id that starts with `gfont-`), `custom` (an id that
starts with `custom-`), or `unknown`.

Resolution and `reason`. A font that does not resolve has `resolved` false and one of these reasons:

- `google-fonts-disabled`: the `google-fonts-provider` flag is off.
- `not-in-google-catalog`: the id is not in the catalogue that ships as `common/resources/fonts/gfonts.2025.11.28.json`.
- `custom-font-not-in-team`: the team of the file has no live font variant with that id.
- `unknown-font-id`: any other id. The editor draws it with the default font.

Resolution is read on every call and is not cached, because it depends on the flags and on the team's fonts.

A font that resolves can still have a run whose face the catalogue does not list. That variant has `resolved` false
and reason `variant-not-found`. The variants of a font that does not resolve carry the reason of the font.

Runs of one face are merged. A run names its face by its variant id, else by weight and style, and the runs of one face
form one variant entry under the catalogue's own variant id (for example `regular`).

Result `{revn, fonts, unresolved, pagesRead, pagesTotal, truncated}`. `pagesRead` counts the pages that the read
covered and `pagesTotal` the pages it was asked for (one with `page-id`), so a client sees which pages a truncated read
left out. Each font is `{fontId, family, source, resolved, reason?, runs, shapes, pages, variants}`, plus the
suggestion keys below. `shapes` counts the text shapes that use the font. `pages` lists `{pageId, runs}`. Each variant is
`{variantId, weight, style, runs, resolved, reason?, url?}`. `unresolved` counts every font that does not resolve, also
those past the reply limit. Fonts sort by runs, descending, then by `fontId`. A reply holds at most 500 fonts.

`truncated` is true when the read was not complete, when the file has more than 500 fonts, or when the reply reached the
response budget. The fonts that were cut are not listed.

Suggestion. A font that does not resolve gets the font that would fix it, when a font that resolves has the same
family. Keys: `suggestedFontId`, `suggestedFamily`, `suggestedSource` (`custom`, `builtin` or `google`),
`suggestedMatch` (`exact` or `stem`) and `suggestedVariantsMissing` (`[{weight, style}]`: the faces the runs use and the
suggested font lacks; empty when it has them all). A font with no candidate has none of these keys, and a font that
resolves never has them. The suggestion is read on every call, like the resolution; it adds no database read.

- Names compared: the family of the font (the `font-family` of its runs) and its font id less a `gfont-` or `custom-`
  prefix, against the family of each candidate.
- Normal form of a name: lower case, split into words at spaces, hyphens, underscores and a lower-to-upper case change,
  less the weight and style words at its end (`thin`, `hairline`, `extralight`, `ultralight`, `light`, `regular`,
  `normal`, `book`, `roman`, `medium`, `semibold`, `demibold`, `bold`, `extrabold`, `ultrabold`, `black`, `heavy`,
  `italic`, `oblique`, and the pairs `extra light`, `ultra light`, `semi bold`, `demi bold`, `extra bold`,
  `ultra bold`), at least one word kept, then joined with no separator. `Access Sans Bold` and `AccessSans-Bold` both
  give `accesssans`.
- `exact`: the names are equal in lower case with the separators removed. `stem`: they are equal only in the normal
  form, so `Access Sans` matches the family `Access Sans Bold`.
- Candidates: the team's custom fonts, then the bundled fonts, then the Google catalogue (only when the Google
  provider is on). Ranking: `exact` before `stem`, then that source order, then the most of the used weight and style
  pairs, then the font id.
- The adapter tool does not rewrite these keys. To use the font, swap it with the font operation that
  `penpot_api_info` describes.

`url`, when there is one:

- a Google variant: the TTF URL of the catalogue;
- a custom variant: `<public-uri>/assets/by-id/<file-id>` of its TTF file, else of its OTF, WOFF2 or WOFF1 file;
- a bundled font: none.

Caps: the font usage of each whole page is cached for 10 minutes, keyed by the page. Without `page-id` every page is
read, in order, under a 5 second budget. The first page is always read. Past the budget no more pages are read, the
read is not complete, and `truncated` is true. A read with `root-ids` is not cached. `root-ids` limits the report to the
text under those shapes on the page. A root the page does not hold is `shape-not-found`.

A read with `pagesRead` below `pagesTotal` is finished by calling again with the same params. Each call reads at least
one page that is not cached, and the pages it finished stay cached for 10 minutes in the memory of that backend
process, so each call goes on from the last. This holds while the file is not edited: an edit changes the key of the
changed pages. When another backend process answers, or after the 10 minutes, the pages are read again. The adapter
tool adds a `note` to such a reply that says this.

### 2.8e `get-mcp-page-lint` (read)

Params `{file-id, page-id, depth? (int 1 to 12), mode? (depth or auto), board-name-regex? (string, at most 200),
min-shapes? (int 0 to 1000, default 3), rules? (vector of 1 to 9 rule names; default all eight), tolerance? (number 0
to 100, default 0.5), min-overflow? (number 0 to 1000, default 8), limit? (int 1 to 2000, default 500), offset? (int 0 or more, default 0)}`.

Boards. The selection is shared with `find-mcp-similar-boards` (section 2.8f) and is made by `app.rpc.mcp-boards`.

- Mode. With none of `depth`, `board-name-regex` and `mode`, the mode is `auto`. With `depth` or `board-name-regex`
  and no `mode`, it is `depth`. `mode` `auto` with `depth` is refused (`mcp-invalid-board-selection`, a validation
  error). `mode` `auto` with `board-name-regex` runs the automatic selection and keeps the boards whose name matches.
  An invalid expression is `mcp-invalid-regex`, with a hint that names `board-name-regex`. A pattern too deep for the
  names is `mcp-invalid-pattern`.
- Mode `depth`: the visible frames at most `depth` levels below the page root (default 1, the direct children of the
  page root), component instances included.
- Mode `auto` looks first for frames of a standard screen size that occur at least three times, and otherwise uses the
  nesting of repeated frame sizes. Sizes are in page px, from the boxes below.
  1. Candidates are the visible frames at level 1 to 12 that neither are nor lie inside a component instance, and whose
     width and height are both at least 200 px (`min-screen-side`). List rows, buttons, chips and small cards never
     form a class and are never loose boards.
  2. Two frames have the same size when their widths differ by at most 2 px and their heights differ by at most 2 px.
     Size classes are built in walk order, each frame joining the first class whose first member has its size.
  3. A class qualifies with at least 3 members. Only the 50 qualifying classes with the most members are weighed
     (`max-qualifying-classes`); a page with more sizes that repeat three times drops the rarest.
  4a. A class is standard when the width and the height of its first member are each within 2 px of an entry of a table
     of standard screen sizes (desktop, kiosk and embedded, tablet and phone presets; each entry counts in both
     orientations), or when its width is within 2 px of an entry's width and its height is above that entry's height (a
     screen made taller to hold scrolling content). The taller rule applies to an entry in its listed orientation only:
     the table lists desktop and kiosk entries in landscape, phone and tablet entries in portrait. Class A lies inside
     class B when more than half of the members of A have an ancestor that is a member of B. A class that is standard
     only by the taller rule is a wrapper class, not a screen class, when an exact standard class of the same width
     (within 2 px) exists such that the wrapper class is a little taller (its height is above that of the exact class
     and at most 1.25 times it) and more than half of the wrapper frames hold exactly one frame of the exact class
     (counted through all ancestors, so a wrapper around a wrapper around a screen holds that screen). An example is
     800 by 660 around 800 by 600 with a caption. A wrapper class is not chosen and hides no class inside it. A
     taller class that is not a wrapper class is a scrolling screen and stays: 390 by 2000 around 390 by 844 is 2.4
     times as tall, so it is not a wrapper. A frame size is also a wrapper class when at least 90 % (`wrapper-share`)
     of its frames each hold exactly one screen, of any exact standard size, as a direct child, centred with equal gaps
     on opposite sides (within 2 px, `margin-tolerance`) of at most 200 px (`max-wrapper-margin`). The class is not a
     standard size and is larger than that screen in both directions (`wrapper-margin?`). The size appears in
     `selection.otherSizes` with relation `wrapper`. A class that falls below 90 % is reported `outside`, but its
     overlays are still found frame by frame (step 8a). A standard qualifying
     class goes when it lies inside another standard class (a panel of a standard size in a screen), or inside a class
     of any size that has more members (a dialog in the screens; a one-to-one wrapper around each screen has as many
     members and does not hide them). When at least one standard class is left,
     the screen classes are exactly those, and steps 4 to 6 are skipped. `selection.basis` is `standard-size`.
  4. Otherwise the structure decides, on the candidates. The top classes are the qualifying classes that lie inside no
     other qualifying class.
  5. A top class with fewer members than 10 % of the members of the qualifying classes directly inside it (inside it
     and inside no other class that lies inside it) is a layer of containers, for example sections of equal size. It
     leaves the qualifying classes, the top classes are computed again, and this repeats until nothing changes.
  6. A top class whose area (width times height of its first member) is under 10 % of the area of the largest top class
     goes. `selection.basis` is `structure`.
  7. The boards are the members of the screen classes. Where a board holds another board, the inner one goes when they are in different classes.
     Boards of one size class that hold each other form a chain, and exactly one board of the chain stays, in this
     order: (1) with a board name regex in mode `auto`, the outermost member whose name matches (a name that runs the
     regex out of time counts as no match); (2) else the member named like the bare boards of its class, where a bare
     board is a selected board of the class in no chain: the member whose exact (case-sensitive) name is borne by the
     most bare boards wins, if at least one bears it, and the outermost of tied members; (3) else the outermost. A default frame name (`Board` or `Frame`, with an optional number as the editor adds) does not
     count in rule 2. When rule 1 or 2 leaves several outermost members (frames side by side), the top of the chain
     stays, so exactly one board stays per chain; a regex cannot pick two frames of one chain. So
     for bare `Parent` screens, some inside a same-size `Single`, the `Parent` frames stay; for `Parent` holding a
     same-size `Wrapper` on every screen, the outer `Parent` stays. When no member matches the regex, rules 2 and 3
     apply and the name filter then removes the board.
  8. Loose boards join: every candidate (so also at least 200 px on each side) that is neither above nor below a
     board, at a level not deeper than the shallowest board, with an area of at least 10 % of the area of the largest
     screen class. A flat page of boards of mixed sizes then gives the frames at depth 1. The boards of the automatic
     selection are the screens. Standard sizes are always kept. Loose boards that are clearly not screens
     (`not-a-screen?`) are dropped: a frame larger than the screen classes in both directions with at least 4 times
     (`far-larger-ratio`) the area of the largest screen class (a section); a frame that holds exactly one loose board
     with a wrapper margin; a non-portrait frame (under 1.5 times as tall as wide, `portrait-ratio`) that holds, or sits
     in, a frame of its own size (an annotation and its widget) and is under half (`pair-area-ratio`) the area of the
     smallest screen class. An empty section 2 to 3 times the screen area is still a board. The step checks the
     deadline; past it the result is the fallback of step 9.
  8a. Overlays are not boards. An overlay is a frame outside component instances that is a sibling of a screen inside
     its wrapper (a frame strictly larger than the screen that holds that one screen with a wrapper margin, or a member
     of a wrapper class, step 4a), is not a screen, and has at least 50 % (`overlay-min-share`) of its own area over that
     screen, such as a "Verifying..." panel over a login screen. With several screens in one wrapper it belongs to the
     screen it overlaps most (`find-overlays`). It is left out of the screen classes, the boards and the loose boards.
     A class of a non-standard size, most of whose frames are not overlays, is kept. The map `{overlay-id screen-id}` is
     the `overlays` of `select-boards`, and the wrapper frames are its `wrapper-ids` (mode `auto` only; mode `depth` has
     none), which `sibling-overlay` of `lint_page`, `find-mcp-similar-boards` and `find-mcp-connectors` read.
  9. When nothing is selected, the boards are the visible frames at depth 1, `selection.fallback` is true and
     `selection.basis` is `depth-fallback`.
- Known results of the structural rules (basis `structure`, that is, screens of a non-standard size): equal-sized
  sections that hold few screens, and equal-sized sections that each hold one equal-sized wrapper, are the boards
  instead of the screens. A known limit of the standard rule: a standard class beats a non-standard parent that has
  fewer members, so non-standard screens that each hold three phone mockups of a standard size give the mockups, not
  the screens. To choose boards by hand, use mode `depth` with `depth`, or `board-name-regex`.
- The reply has `selection` `{mode, depth?, fallback?, basis?, sizes?, sizesOmitted?, otherSizes?, nestedSameSize?,
  boards, minDepth, maxDepth}`. `mode` is `depth` or `auto`. `depth` is given for mode `depth`, and for a fallback (1). `fallback`,
  `basis`, `sizes`, `sizesOmitted` and `otherSizes` are given for mode `auto`: `basis` is `standard-size`, `structure`
  or `depth-fallback`, and `sizes` is a list of `{width, height, boards}`, one per size class of the selected boards,
  the most boards first, at most 20 (`sizesOmitted` is how many were left out). `otherSizes` lists up to 5 qualifying
  size classes that have no selected board, as `{width, height, boards, relation}`, the most boards first: `relation`
  is `inside` when more than half of the class lies inside the selected boards, `outside` otherwise; `wrapper` replaces both for a class that is a wrapper class (step 4a). A caller sees what
  else repeats on the page. `nestedSameSize` (mode `auto`, only when above 0) counts the
  boards that sit in a chain of frames of their own size; one frame of each chain is the board: the one that matches
  `boardNameRegex`, else the one named like the unwrapped boards of that size, else the outermost. `boards` is the count of selected boards. `minDepth` and `maxDepth` are their levels, null
  for none.
- `deeperBoards` is given in mode `depth` only (mode `auto` has none, and the reply leaves the key out). It is the
  number of frames below the selected boards that are screen-sized (candidates: outside component instances, at least
  200 px on both sides) and belong to a size class of at least 3 members. When it is not 0, repeated screen-sized
  frames exist deeper: call again without `depth` to let the selection find them, or with a larger `depth`.
- The selection stops at the deadline, and then `truncated` is true.

Boxes are the true bounding boxes of the points of a shape, so a rotated shape is measured as it is drawn. A shape with
no points uses its stored box.

Visible descendants of a board are its descendants that are not hidden and have no hidden ancestor below the board.
A control is a component instance head with at least one visible text descendant.

Rules:

- `empty-board`: the board has fewer visible descendants than `min-shapes`. A board that is, or lies inside, a
  component instance is skipped. Detail `{shapeCount, minShapes}`.
- `instance-only-board`: the board holds chrome and nothing else. A board that is, or lies inside, a component
  instance is skipped. Chrome components are the components that repeat in the same place across the screens and touch
  a screen edge or sit on most screens, such as a header, a footer or a side rail. A component is chrome in a scan
  when all of these hold, over its instance heads (visible shapes with a component id, at any depth inside a selected
  board, sub-instances included): its instances occur in at least 3 selected boards and in at least 30 % of them; the
  mean box area of its instances is under half the mean box area of the selected boards (a full-screen template is not
  chrome); in at least 90 % of the boards that hold it, it occurs exactly once; in at least 80 % of those boards an
  instance sits at the same offset from the top-left corner of the board (offsets within 2 px are one offset: they
  are clustered greedily from the first member, and the largest cluster counts); and its instance, at that most common
  placement, touches an edge of its board in most of those boards (within 4 px of the top or bottom edge, or within
  4 px of the left or right edge and at least half the board high, as a side rail is; a full-width banner in the
  middle of the screen touches none), or the component occurs in at least 70 % of the selected boards (a keypad in the
  middle of 4 of 10 boards is content, a Back button on every board is chrome). Known limits: a header that sits at
  the top on 40 % of the boards and lower on the rest is not chrome, and neither is a variant set whose variants sit
  at different places, so a screen that holds only such a header is not reported. The variants of one component count as one component: heads are grouped by
  the variant container (`variant-id` of the component in the file's library) when the component belongs to a
  variant set, else by `component-id`; a component whose data is not in this file (an external library) is grouped
  by `component-id`. A logo inside the header is chrome too, which does no harm, as its shapes lie inside the header.
  The content of a board, outside chrome instances (a chrome instance and what lies inside it do not count), is: a
  visible shape of type `image` or any visible shape with an image fill (opacity above 0), whatever its size; a visible
  shape of another drawing type (`rect`, `circle`, `path`, `bool`, `text`, `svg-raw`), unless it is a backdrop whose
  box covers at least 90 % of the board (a background split into several shapes, each under 90 %, counts as content);
  and a visible frame or group with a visible fill, stroke or image fill of its own, that has no content and no chrome
  instance inside it and whose box is under 50 % of the board (a large empty filled panel is an empty panel). The
  rule reports a board that holds at least one chrome instance and has no content. So a header alone, a header and a
  footer, a template instance that holds only chrome and a background rect, and a wrapper frame that holds only
  chrome are reported; a header beside a red 400 by 300 block, a header and a button that is not chrome, and a menu of a
  header and six buttons are not. A board with no chrome instance is not reported; one with no visible descendant is
  `empty-board`. The finding is about the board (no shape keys). Detail `{chromeComponentIds, contentShapes}`:
  the chrome components present in the board, `contentShapes` 0. The percentages are the constants `backdrop-share`,
  `block-share` and the chrome constants of `mcp-lint`.
- `invisible-control`: a control has area and nothing of it is visible at rest. Detail `{visibleFraction,
  clippedBy}`, with `visibleFraction` 0: the rule judges the box shrunk by `tolerance`, so a sliver of the whole box
  can still show; when that share is above 0 the detail adds `rawVisibleFraction`.
- `clipped-control`: a control keeps more than 0 % and less than 99.9 % of its area at rest. Detail `{visibleFraction,
  clippedBy}`. `visibleFraction` has 0 to 1 and three decimals. `clippedBy` is the id of the clipping frame that keeps
  the least of the control.
- `scroll-hidden-control`: the control is hidden at rest, and a scroll container brings it into view. Detail
  `{scrolledBy, visibleFraction}`, where `scrolledBy` is the id of the scroll container and `visibleFraction` is the
  share at rest.
- `off-board-control`: a control whose box sticks out of the board by more than `tolerance` px on some side. Detail
  `{overflow: {left, top, right, bottom}}`, in px, 0 where it is inside. The detail keeps the raw overflow.
- `scroll-candidate`: a frame that clips its content (`show-content` is not true), has no `overflow-scroll` (absent or
  `none`), and has visible direct children that reach past its right or bottom edge by at least
  `min-overflow` px (default 8) and by more than `tolerance` px (an overflow of 0, or of float noise, never counts). A
  child that covers the frame on both axes is left out: it starts left of the left edge and above the top edge and
  ends right of the right edge and below the bottom edge, each beyond `tolerance` px, so a background that bleeds past
  a board on every side does not make it scroll, while a carousel track at x = -150 that overflows on one axis does.
  The rule looks at each selected board and at every visible frame inside
  it. A frame is reported once, under its innermost selected board. Boxes are those below, and only the right and
  bottom sides count, because content left of or above a frame cannot be scrolled to. Detail `{overflow: {right,
  bottom}, suggested, inComponentCopy}`: the overflow in raw px, `suggested` `vertical` (bottom only), `horizontal`
  (right only) or `both`, and `inComponentCopy` true when the frame is, or lies inside, a component copy. Writing
  `overflowScroll` there makes an override, so set it on the main component. The finding's shape is the frame.
- `sibling-overlay` (mode `auto` only): a visible board or group, of any size, that is not a screen, is a child of a
  wrapper (as the automatic board selection recognises it, `wrapper-ids`) next to a screen, is not a component instance
  or inside one, and has at least 50 % (`overlay-min-share`) of its own area over that screen (the one it overlaps
  most). One finding for each overlay: `boardId` is the covered screen, `shapeId` and `shapeName` the overlay. Detail
  `{coveredFraction, overlayBox {x, y, width, height}}`, with three decimals. Hidden overlays are not reported; mode
  `depth` reports none. It is in the default rule set, is counted in `counts` and `total`, and is paged by `offset`.
  The scan stops at the 5 s budget (`timedOut`). Out of scope: a shape that is not a sibling of the screen inside its
  wrapper (a section child laid over a screen, any shape in a section that holds screens directly), and a shape inside
  the screen (`find-sibling-overlays`).

`tolerance` keeps rounding noise out of the edge tests. `invisible-control` and `clipped-control` work on the share of
the control's area that stays visible, so the tolerance shrinks the control's box by `tolerance` px on each side before
the share is computed (`shrink-box`, applied in `get-visible-state`). A box whose width or height is not above twice
`tolerance` is used as it is. The reachability test of `scroll-hidden-control` allows `tolerance` px on the axis that
does not scroll, and `scroll-candidate` applies it as above. `visibleFraction` in a finding stays the share of the
whole box, except for `invisible-control` (0, see above). `tolerance` 0 gives the strict tests.

The model of the rest and the scroll rules:

- At rest, the clipping frames of a control are the frames between it and the board, the board included, that do not
  have `show-content` true. The visible share is the area of the control left inside all of them. Nothing scrolls yet.
- A control that is hidden at rest is checked for reachability. The nearest scroll container (`overflow-scroll` on a
  frame, with an axis) above it is the one that brings the control into view. The control takes the scroll container's
  extent on each axis that it scrolls. On the other axis, the control must fit inside the container, within `tolerance`
  px. The result is then
  clipped by the container and by the clipping frames above it, and it is reachable when some area is left. A
  reachable control gives `scroll-hidden-control`. Otherwise the rest rule applies.
- `off-board-control` applies only when no other rule applies.

Each control gets at most one finding, under its innermost selected board: a selected board between the control and
the board reports it, so the outer board does not. With `rules` given, the first asked rule that applies is reported,
in the order `invisible-control`, `clipped-control`, `scroll-hidden-control`, `off-board-control`.

Result `{revn, pageId, boards, selection, deeperBoards?, chromeComponents, findings, counts, total, truncated,
nextOffset?, timedOut?}`. `boards`
counts the boards checked. `selection` and `deeperBoards` are described above. `chromeComponents` is a list of `{id,
name, boards, variants?}`, at most 10, the most boards first (then the smaller mean area), each a chrome component (a
variant set counts once: `id` is then the variant container and `variants` the number of its component ids in the
scan, left out when 1) and the number of boards that hold it; it is empty when there is none or `instance-only-board` was not asked, and then the rule
reports nothing.
Each finding is `{rule, boardId, boardName, shapeId?, shapeName?, path?, detail}`. The `empty-board` and
`instance-only-board` findings carry no shape keys. A `sibling-overlay` finding has the covered screen as `boardId` and the overlay as `shapeId`. Findings come in board order, then walk order. `counts` holds one
total for each asked rule, over all findings of the scan, also when `limit` or `offset` cuts the list. `total` is the
sum of `counts`.

Caps: the scan stops after 5 seconds. `findings` holds at most `limit` entries.

Paging. The findings come in a fixed order, which depends only on the file at one `revn` and on the params. `offset`
skips that many findings, then `limit` applies. `nextOffset` is the `offset` of the next page, and is there only when
findings remain after the ones returned and the scan did not time out. An `offset` past the end gives an empty list
and no `nextOffset`. `counts`
and `total` do not change with `offset` or `limit`. `truncated` is true when findings remain or when the time limit
cut the scan. `timedOut` is there, and true, only when the scan or the selection ran out of time: `counts` and `total`
then cover what the scan reached, and there is no `nextOffset`, because each call selects its boards (and finds the
chrome components) under its own clock and a later page could come from another list. Start again with a narrower
call (fewer `rules`, `boardNameRegex`).

### 2.8f `find-mcp-similar-boards` (read)

Params `{file-id, page-id, depth? (int 1 to 12), mode? (depth or auto), board-name-regex? (string, at most 200),
threshold? (number 0.5 to 1, default 0.9), min-shapes? (int 1 to 1000, default 3), limit? (int 1 to 500, default 100)}`.

The boards are those of section 2.8e: the same selection, with the same parameters and the same refusals. Boards with
fewer visible descendants than `min-shapes` are left out of the comparison and are reported in `skippedSmall`.

A token is the type of a visible descendant, its component id (none when it has none), and, for a text, its characters
with whitespace runs collapsed and trimmed. A board's signature is the multiset of its tokens. Positions and names are
not part of it. A screen that holds a frame of its own size counts that frame too, so it is close to, but not an exact copy
of, the same screen without the frame.

Groups:

- Boards with equal signatures are exact copies. Their group has `similarity` 1 and `exact` true.
- Distinct signatures are linked when their Jaccard index is at least `threshold`. The index is the sum of the smaller
  counts over the sum of the larger ones. Links join groups, so a group can span a chain of links. A joined group has
  `exact` false, and its `similarity` is the lowest index among its linked pairs.

Pruning: the distinct signatures are sorted by size. A pair is not compared when the smaller size over the larger one is
already below `threshold`, because its index cannot reach it. The deadline is checked every 256 compared pairs.

Result `{revn, pageId, boards, selection, deeperBoards?, skippedSmall, compared, groups, truncated}`. `boards` counts the
boards compared. `selection` and `deeperBoards` are those of section 2.8e. `skippedSmall` is `{count, ids}`: the number
of selected boards left out for having fewer than `min-shapes` visible descendants, and the ids of the first 50 of them
in walk order. Every selected board is therefore compared or in `skippedSmall`, unless the scan was cut short
(`truncated`). `compared` counts the pairs whose index was computed. Each group is `{similarity, exact, boards: [{id, name, path, shapeCount}], overlays?}`. A group whose boards have such overlays (the
`sibling-overlay` shapes of section 2.8e) also has `overlays: [{boardId, shapeId}]`, one entry per overlay of a board of the
group; the key is absent otherwise. A timed-out overlay scan sets `truncated`. Only groups
of two or more boards come back. They sort by board count, largest first, then by similarity. At most `limit` groups
come back.

Caps: at most 1000 boards are compared. More set `truncated`. The scan stops after 5 seconds, which also sets
`truncated`. `truncated` is also set when more groups exist than `limit`.

### 2.9 `create-mcp-render-session` (read)

Params `{file-id}`. Checks read permission on the file. Mints a session row for the profile with a 10-minute
lifetime, the file and its linked libraries as the covered files, and the token id. The user agent is
`penpot-mcp-exporter`. Result `{token, expiresAt}`. The adapter uses the token as the `auth-token` cookie on exporter
calls. Restrictions: section 1.5.

### 2.10 Rate limits

Reads and writes count under the profile of the call. An MCP token call counts under `<profile-id>.mcp`, apart from
the owner's own calls.

| Limiter | Scope | Limit |
|---|---|---|
| rlimit `:mcp-read` | reads: `mcp-whoami`, `get-mcp-file-outline`, `get-mcp-page-tree`, `get-mcp-shapes`, `find-mcp-shapes`, `get-mcp-library`, `get-mcp-tokens`, `create-mcp-render-session`, and the six reads of sections 2.8a to 2.8f | 1200 calls per bucket, refill 600 per minute (`1200/600/1m`) |
| rlimit `:mcp-write` | `mcp-apply-changes`, `mcp-apply-operations`, `mcp-import-svg` | 600 calls per bucket, refill 300 per minute (`600/300/1m`) |
| rlimit `:access-token` | `update-mcp-token-scopes` | 60 per bucket, refill 30 per minute |
| climit `:mcp-read/by-profile` | reads | 4 permits, queue 20, timeout 30 s |
| climit `:mcp-read/global` | reads | 8 permits, queue 64, timeout 30 s |
| climit `:mcp-find/by-file` | `find-mcp-shapes`, `find-mcp-connectors` (2.8c), `get-mcp-fonts` (2.8d), `get-mcp-page-lint` (2.8e), `find-mcp-similar-boards` (2.8f) | 2 permits per file, queue 10, timeout 30 s |
| climit `:mcp-apply/by-profile` | writes | 1 permit, queue 5, timeout 60 s |
| climit `:mcp-apply/global` | writes | 6 permits, queue 50, timeout 60 s |
| climit `:mcp-update-file/by-profile` | writes: its own permit, so an agent write does not hold the owner's file-save permit | 1 permit, queue 5, timeout 60 s |
| climit `:mcp-apply/by-team` | writes, per team of the file | 4 permits, queue 50, timeout 60 s |

`get-mcp-subtree` (2.8a) and `get-mcp-interactions` (2.8b) take the two read limiters and no per-file limiter.

The six reads of sections 2.8a to 2.8f use the `:mcp-read` bucket, like the other reads. Every command in a set also
keeps the file's `:default` entry (`200000/h`).

The write limiters are taken in the order `mcp-apply/by-profile`, `mcp-apply/global`, `mcp-update-file/by-profile`,
`mcp-apply/by-team`.

### 2.11 Write rules (shared by the three write commands)

The three write commands (`mcp-apply-changes`, `mcp-apply-operations`, `mcp-import-svg`) share one path. It runs
as follows.

1. The call checks the size first: at most 2000 changes (or operations), and a payload of at most 8 MB. A larger
   call answers `mcp-batch-too-large` (HTTP 400) before the file is locked.
2. A write takes the file lock. The lock wait is at most 15 s; a longer wait answers `mcp-file-busy`. Any other lock
   wait in the call, such as a project or team row, is also capped at 15 s and answers `mcp-lock-timeout`. Both are
   conflicts (HTTP 409).
3. A call with a request id that already committed does not write again. See the idempotency rule below.
4. The changes are compiled (operations) or taken as they are (raw changes). Then the call runs these checks, in
   this order: refused change types; the compiled change count (100000 at most); foreign media; the revn lag and the
   conflict check (below). A failing check answers its error and writes nothing.
5. The changes are cut into commit batches. A batch holds at most 2000 compiled changes of any kind. An operation is
   never split across batches: an operation larger than 2000 changes gets a batch of its own. The layout reflow goes
   into the last batch when it fits. When it would cross the bound, it gets batches of its own, each at most 2000
   changes. A call of 2000 changes or fewer without `allowSplit` is one batch. Otherwise the cut falls on operation
   boundaries. A call takes at most 50 batches. More answers `mcp-too-many-batches`, before the first write. A dry
   run cuts no batches and skips this check.
6. Every batch commits in the one transaction of the call, so they commit together or not at all. The file is
   decoded once and written once. The project row is updated last.
7. Before each batch after the first, the call checks its time budget of 60 s. An exceeded budget answers
   `mcp-time-budget-exceeded` and the call rolls back.
8. A failed call changes nothing. Its file revn and its change rows stay as they were.
9. Open editor tabs get the notifications only after the transaction commits. The MCP session id makes the
   tabs apply the change live.

Rules for each write:

- **Refused change types** (raw changes and operations alike): `set-tokens-lib`, `purge-component`,
  `purge-typography`, `purge-color`. Answer `mcp-change-type-refused`.
- **Foreign media**: every media id the changes name must belong to this file, or to a library of the file that the
  profile can read. Else the call answers `mcp-foreign-media`. A deleted media row counts as missing.
- **Validation**: every MCP write runs the affected-shapes check. A raw change batch also runs the schema check.
  The file flags `file-validation` and `file-schema-validation` can add checks. A dry run reports each error with
  the code the commit would raise, `referential-integrity`, and the validator's own code as `detailCode`. On a
  commit, an affected-shapes error first starts the file's auto-repair of damage that was there before the call.
  The call fails with the error only when the repair does not recover the file. Soft validation only logs and is
  not part of the result.
- **Snapshot**: one snapshot per call, label `mcp/<tool>/<ISO timestamp>/<request-id>`, created inside the same
  transaction before the first batch. The call takes a snapshot when any change deletes (`del-obj`, `del-page`,
  `del-component`, `del-color`, `del-typography`, `del-media`, or a token change without attributes), or when the
  call has more than 100 changes or operations, or when `snapshot` is true, or when an operation asks for one
  (`replace_font` does when it changes at least one text). `snapshot: false` turns off only the "more than 100"
  trigger and the request of an operation. The snapshots of the file with an `mcp/` label are pruned to the 20 newest. A snapshot
  that fails answers `snapshot-failed` and the call rolls back.
- **Revn lag**: when `baseRevn` is lower than the stored revn, the result carries a warning
  `{kind: "revn-lag", baseRevn, storedRevn, changedShapeIds: [...]}`. The shape ids come from the change rows newer
  than `baseRevn`, read up to 500 rows and 16 MB. When that read stops early, the warning carries `truncated: true`,
  and the result carries `laggedTruncated: true`. A row that does not decode is skipped and logged. It never fails
  the write.
- **Conflict**: with `failOnConflict: true`, a non-empty overlap of the lagged shapes with the touched shapes answers
  `mcp-revn-conflict`. Its data holds `changedShapeIds` (the overlap) and `truncated`. A truncated read also answers it. A move or reorder touches its shapes and its parent. A
  `reg-objects` change touches no shape for this check.

Idempotency rule: the write's session id is `UUID.nameUUIDFromBytes("penpot-mcp:<token-id>:<request-id>:<digest>")`, a
version 3 UUID. The digest is the SHA-256 hex of the canonical text of the call's payload: the `changes`,
`operations`, `pageId`, `parentId`, `svg`, `x`, `y`, `name`, `allowSplit` and `snapshot` values. Canonical text sorts
map keys and leaves out nil values, so key order does not matter. A reused request id with another payload is a new
write. A call without a request id gets a new one, so it is never a replay. Under the lock, and before the changes
are compiled, the call looks for change rows with that session id. If it finds any, it writes nothing, sends no
event, and answers `alreadyApplied: true` with `commits: 0`, the change count and types of the earlier call, and an
empty `warnings` list. It also returns the reply data of the first answer, as the record kept it: `created-ids`
(the handle to id map) and `op-results` of `mcp-apply-operations`, and `root-id` and `shape-ids` of `mcp-import-svg`.
The first change row of the call keeps them in its `mcp_reply` column (migration `0160`), never in `data`: `data`
belongs to the legacy file data backend, and the restore of a file from the trash keeps every row that has it. A
row with `mcp_reply` and no label or `data` expires with the others: the reply lives as long as the record, from the
commit until the first collector run after one hour. The
reply keeps at most 10,000 entries of each list and at most 1 MiB encoded. A larger reply loses its `op-results`
first, then half of its ids at a time until it fits, and the replay says `replay-truncated: true`. A call that
committed in several batches keeps one reply for the whole call, on its first row. A record made before the reply was
kept (a row with no `mcp_reply`, or one written by an older backend process), or a call with no reply data,
answers without them. Each commit writes its change rows with a deletion time one hour after the commit
(`rpc/commands/files_update.clj`). The objects garbage collector (`tasks/objects_gc.clj`) deletes rows once that time
has passed. So the check finds the rows from the commit until the first collector run after that hour. Later, a retry
with the same request id and payload applies the changes again. A dry run skips the check. A retry that the stored
reply answers repeats the ids of the first call. If the file was restored from a snapshot older than that write in
the meantime, those shapes may no longer exist, so a client that restores a file must not reuse request ids from
before the restore.

Dry run (`dryRun: true`): reads the file with read permission only, takes no lock, and writes nothing. It applies the
changes in memory and runs the same checks as a commit, with the same forced and flag-driven choices. Its result
reports the errors that the commit would raise, and it leaves `revn` unchanged.

Limits: 2000 changes per raw call and 2000 operations per operation call (both checked before the lock), an 8 MB
payload, and 100000 compiled changes per call (config `mcp-max-compiled-changes`). `mcp-whoami` publishes the
operation, payload and compiled-change limits. The raw-change limit is not published.

A write that does not dry run emits the webhook event `update-file`, with the payload keys of the `update-file`
RPC and the MCP audit props. Events batch per file with a two-minute timeout. A dry run and a replay emit nothing.

### 2.12 `mcp-apply-changes` (write)

Params `{file-id, base-revn?, changes: [raw change records] (at most 2000), dry-run? (default false), snapshot?,
fail-on-conflict? (default false), request-id?}`. Requires `enable-mcp-raw-changes` (section 1.2).

### 2.13 `mcp-apply-operations` (write)

Params `{file-id, base-revn?, operations: [op...] (at most 2000), dry-run?, snapshot?, allow-split? (default false),
fail-on-conflict?, request-id?}`.

- The operations compile against the latest file data inside the lock, by `app.common.mcp.operations/compile-operations`
  (section 3). The compile counts toward the 100000-change limit of section 2.11.
- With `allow-split: true`, the batches are cut as in section 2.11 step 5: whole operations, at most 2000 changes
  each, an oversize operation in a batch of its own, and the layout reflow in the last batch or in batches of its own.
- Without `allow-split` the call still cuts batches on operation boundaries when it compiles to more than 2000
  changes.
- The compile raises the errors of section 3. A compiler bug answers `mcp-compile-failed` (type `internal`, HTTP 500).

Result `{revn, createdIds: {"$tmp:name": uuid, ...}, changeCount, changeTypes, commits: n, warnings, validation,
dryRun, snapshotId?, laggedTruncated?, opResults?}`. `opResults` is present when an operation reports a result. It is
a list with one entry per operation, in order, and null for an operation with none. Today only `replace_font` reports
(section 3.3a). A dry run returns the same `opResults` and writes nothing. A replay answers with the `opResults` of the first
call, unless the stored reply was too large to keep them (`replayTruncated`, see Replay).

A failed call answers the error with its data: `revnBeforeCall` (the revn the file had when the call started,
because no batch stays committed), `failedChangeIndex` (the index in the compiled changes of the first change of the
failed batch), and `failedOperationIndex` and `failedOperationLastIndex` (the first and last operation of that
batch). The two operation indexes are left out when the batch holds no operation. The backend names these fields
`revn-before-call`, `failed-change-index`, `failed-operation-index` and `failed-operation-last-index` before the
camelCase conversion. The field `last-committed-revn` no longer exists.

### 2.14 `mcp-import-svg` (write)

Params `{file-id, page-id, parent-id?, svg: string (at most 8 MB), x?, y?, name?, dry-run?, request-id?}`.

- The SVG is sanitized, then parsed. Text that is not an SVG document answers `mcp-invalid-svg`.
- The shapes go under a wrapper frame, as the frontend does it. A missing parent answers `shape-not-found`.
- Result `{revn, rootId, shapeIds: [...], changeCount, changeTypes, commits, warnings, validation, dryRun,
  snapshotId?, laggedTruncated?}`.
- Embedded raster images are not uploaded (deviation 4). Use `import_image` first, then `create_image`.

### 2.15 Error codes (MCP)

HTTP status follows the error type (`app.http.errors`):

| Type | HTTP | Notes |
|---|---|---|
| `authentication` | 401 | |
| `authorization` | 403 | scope, token, permission and session refusals |
| `restriction` | 400 | MCP switched off, backend off, raw changes off (405 only for `method-not-allowed`) |
| `validation` | 400 | input and operation errors. `vern-conflict` is 409 and `request-body-too-large` is 413. |
| `not-found` | 404 | |
| `conflict` | 409 | the caller's state against the stored one: a stale `revn`, a busy lock. Not logged as a server fault. The reply is the error data without `state`, `path` and `context`, with `type` set to `conflict`. |
| `rate-limit`, `concurrency-limit` | 429 | `concurrency-limit` carries `code` `capacity-limit-reached`, `limit` (the limit name, for example `mcp-apply/by-team`), `reason` (`queue-full` or `timeout`) and a `hint` that repeats them. |
| `internal` | 500 | the reply has `type` `server-error`. |

Codes raised by the MCP code, with type and location in the code:

| Code | Type | Raised when |
|---|---|---|
| `mcp-backend-disabled` | restriction | MCP token, backend flag off |
| `mcp-disabled` | restriction | profile has MCP switched off |
| `mcp-raw-changes-disabled` | restriction | raw changes flag off |
| `mcp-scope-required` | authorization | token lacks the scope (`required`, `granted`) |
| `session-restricted` | authorization | restricted render session calls a command it may not |
| `session-required` | authorization | `update-mcp-token-scopes` with a token |
| `mcp-token-not-found` | not-found | profile has no valid MCP token |
| `token-set-not-found` | not-found | `get-mcp-tokens` `set-id` names no set |
| `shape-not-found` | not-found | root or parent missing |
| `page-not-found` | not-found | page missing |
| `mcp-invalid-cursor` | validation | cursor malformed, of another page, root or depth, or past the end |
| `mcp-stale-cursor` | validation | page changed since the cursor was issued |
| `mcp-root-children-not-allowed` | validation | `get-mcp-shapes` asks for the root with children |
| `mcp-invalid-regex` | validation | `name-regex` is not a Java regular expression |
| `mcp-invalid-pattern` | validation | `name-regex` too deep for the names |
| `mcp-batch-too-large` | validation | call over the count, payload or compiled-change limit (also for dry runs) |
| `mcp-too-many-batches` | validation | call would take more than 50 commits |
| `mcp-change-type-refused` | validation | refused change type |
| `mcp-foreign-media` | validation | media not in the file or a readable library |
| `mcp-invalid-svg` | validation | SVG text cannot be parsed, or the root is not `svg` |
| `mcp-invalid-operation` | validation | operation invalid (`index`, `op`, `hint`, `cause-code`). Also a literal id already taken, and a move the editor refuses (section 3). |
| `mcp-client-limit` | restriction | the profile already holds 20 client tokens. An OAuth approval answers `access_denied` instead. |
| `mcp-unknown-id` | validation | a handle or id is not known |
| `mcp-compile-failed` | internal | compiler bug (`index`, `op`) |
| `mcp-time-budget-exceeded` | validation | a later batch starts after the 60 s budget |
| `mcp-batch-split-mismatch` | internal | batches do not hold every change (a bug) |
| `mcp-file-busy` | conflict | file lock wait ran out after 15 s |
| `mcp-lock-timeout` | conflict | a project or team row lock wait ran out after 15 s; another write holds the row |
| `mcp-revn-conflict` | conflict | `failOnConflict` and the lagged shapes overlap, or the lag read was cut short |
| `snapshot-failed` | internal | the snapshot before a write failed; the write is aborted |
| `profile-blocked`, `profile-not-active` | authorization | profile state |
| `missing-perms`, `token-auth-required` | authorization | token and permission checks |

## 3. Operation vocabulary (`common/src/app/common/mcp/operations.cljc`)

The public API is `app.common.mcp.operations`. The eleven `app.common.mcp.operations.*` sub-namespaces are internal
(`:no-doc`). The op table merges the families in them:
`arrange`, `components`, `layout`, `library`, `prototype`, `shapes`, `text` and `tokens`. The helpers are in `refs`,
`schema` and `state`.

`compile-operations` is pure: `(compile-operations file-data operations opts) -> {:changes [...] :created-ids
{"$tmp:x" uuid} :warnings [...] :touched-page-ids #{...} :summary {...} :op-ranges [[start end] ...]}`. `opts` carries
`{:new-id-fn uuid/next :libraries {lib-id lib-data}}`. Operations run in order against a working copy, so later
operations see earlier results. Any `id`, `parentId`, `childIds` or `shapeIds` value may be a `$tmp:<name>` handle.
A `create_*` op may set `id: "$tmp:<name>"`, and later ops reference it.

Errors: an unknown handle or id raises `mcp-unknown-id`. A schema violation, a literal id that is taken, or a rule
of the editor raises `mcp-invalid-operation`, with `{index, op, hint}`. A schema failure on the operations vector
reports the index and op of the first invalid operation. Any other failure while compiling one op raises
`mcp-compile-failed` (internal). The reflow phase reports `index` nil and `op` `"reflow"`.

`:op-ranges` holds one `[start end]` per operation, end exclusive, into `:changes`, in operation order. Reflow
changes after the last range belong to no operation.

Each op is a map `{op: "<name>", ...}`. Coordinates are absolute page coordinates. Shape props use Penpot attribute
names in kebab-case after JSON key conversion. Enum values are strings.

| op | params | built with |
|---|---|---|
| `create_page` | `id?, name, index?` | `cb/add-page` with `(ctp/make-empty-page id name)` |
| `update_page` | `id, name?, background?, background-token?` | `cb/mod-page` |
| `delete_page` | `id` | `cb/del-page`; refuses the last page; removes components whose main is on the page |
| `move_page` | `id, index` | `cb/move-page` |
| `create_board` / `create_rect` / `create_ellipse` / `create_text` / `create_path` / `create_image` / `create_svg_raw` | `page-id, id?, parent-id? (default root), index? (a visual index in a layout, see 3.2), name?, x, y, width, height (not for `create_path`, see below), props? (shape attrs, subject to the rules in 3.5)`, plus: text: `characters`, `grow-type?`, `font-size?`, `font-family?`, `font-id?`, `font-variant-id?`, `font-weight?`, `font-style?` (section 3.3), `fills?`; path: `content` (path content vector) or `d` (SVG path string); image: `media-id, media-width, media-height, media-mtype?`; svg_raw: `content` | `cts/setup-shape` (types: frame, rect, circle, text, path, image, svg-raw) with `:parent-id`, `:frame-id` resolved from the parent. Text content via `txt/change-text` on `cts/make-minimal-shape :text` content with `{:fills [{:fill-color "#000000" :fill-opacity 1}]}` default. Sizes for `auto-width` and `auto-height` are approximated as `width = 0.6*font-size*chars` and `height = 1.2*font-size*lines`, and flagged in `:warnings` as `text-size-approximate`. Later reads report `textSizeApproximate: true` until a browser lays the text out. Then `cb/add-object`. For `create_path`, the box comes from the content. The code rule (`shapes.cljc`) is: "A path has no position or size of its own: its selrect comes from the content." `x` and `y` are optional. When given, they move the content so its bounds start there. `width` and `height` are not read. The shape stores no `x`, `y`, `width` or `height`; its geometry is `selrect`, `points` and `content`. Default names are the plain base name, with no uniqueness suffix. |
| `create_group` | `page-id, id?, name?, child-ids` | group shape via `cts/setup-shape :group`, sized to the children's selrect. The parent is the parent of the first child; children with different parents are refused. Then `cb/add-object` and `cls/generate-relocate` of the children into it. |
| `create_boolean` | `page-id, id?, name?, bool-type (union/difference/intersection/exclude), child-ids` | like group with `:type :bool` and `path/update-bool-shape` content; boards are refused as children; the head child gives the styles |
| `update_shape` | `page-id, id, props` | `cls/generate-update-shapes`. Geometry (x, y, width, height, rotation) goes through modifiers (`lm/generate-apply-modifiers`). Moving or resizing a board or group moves its children and applies constraints. For a rotated shape, x and y come from the points rectangle, as the workspace does. Props are validated against a partial shape schema; structural keys are refused. |
| `move_shapes` | `page-id, ids, parent-id, index?` (visual in a layout, see 3.2) | `cls/check-structure-move` first, then `cls/generate-relocate`. Ids whose ancestor is also moved are dropped, since the ancestor takes them along. A parent that is one of the moved shapes, or lies under one, is refused (a loop). A move into or out of a component copy is refused. A move that would nest a component inside its own main is refused. The parent must be a board, a group or a boolean; any other parent is refused, for every op that takes a parent. Refusals answer `mcp-invalid-operation` (section 3.6). |
| `reorder` | `page-id, parent-id, ids` (new child order, full list; visual order for a flex or grid parent, see 3.2) | `cb/reorder-children` |
| `delete_shapes` | `page-id, ids` | `cls/generate-delete-shapes` |
| `clone_shape` | `page-id, id, parent-id?, new-id?` (`newId` in the adapter; a `$tmp:` handle for the clone root) | `cll/generate-duplicate-changes`. Without `parent-id` the clone goes where the source is, so a source inside a component copy is refused. A clone of a copy child needs a `parent-id` outside the copy (section 3.6). |
| `ungroup` | `page-id, id` | relocate children to the parent, then delete the group |
| `flatten` | `page-id, ids` | `path/convert-to-path` then update; removes the descendants; skips shapes inside component copies |
| `set_path_content` | `page-id, id, content` (path content vector) | `path/content` checked against the path schema. The content moves so that its bounds start at the origin of the path's `selrect`, so the path stays where it is. `selrect`, `points` and `content` come from the content and the shape's transform, which is kept, so a rotated path stays rotated. `x`, `y`, `width` and `height` are not read or written. Refuses a shape that is not a path, content that is not a valid path, and content without bounds. |
| `make_mask` / `remove_mask` | `page-id, group-id` | `:masked-group` attr via update-shapes |
| `set_flex_layout` | `page-id, id, layout attrs (layout-flex-dir, layout-wrap-type, layout-gap, layout-padding, layout-justify-content, layout-align-items, layout-align-content, layout-item-h-sizing, layout-item-v-sizing)` | `ctl/*` attrs on the board, `:layout :flex`; then reflow (section 3.1). `layout-gap` and `layout-padding` merge per side with the current values, so a side left out keeps its value. Other attrs left out reset to their initial values. It reverses `:shapes` once when the board has children and no layout yet (section 3.2). |
| `set_grid_layout` | `page-id, id, layout-grid-dir, layout-grid-rows, layout-grid-columns, layout-gap, layout-padding, layout-align-items, layout-justify-items, layout-align-content, layout-justify-content` | `:layout :grid` attrs, `ctl/assign-cell-positions`; reflow. `layout-gap` and `layout-padding` merge per side as in `set_flex_layout`. Other attrs left out reset to their initial values. |
| `remove_layout` | `page-id, id` | dissoc layout attrs |
| `set_layout_child` | `page-id, id, layout-item-* attrs` | update-shapes; reflow of the parent layout. The op for the `layout-item-*` attrs (section 3.5). |
| `set_grid_cell` | `page-id, grid-id, child-id, row, column, row-span?, column-span?` | `ctl/*` cell helpers; reflow |
| `set_text` | `page-id, id, characters` | `txt/change-text` keeping styles; approximate resize for auto grow types |
| `set_text_style` | `page-id, id, attrs (font-family, font-id, font-variant-id, font-size, font-weight, font-style, line-height, letter-spacing, text-transform, text-decoration, text-align, vertical-align, fills)` | attrs go to the root, paragraph or leaf nodes of `:content`, for the whole text shape (ranges are a deviation). Font fields follow section 3.3. |
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
| `import_tokens_dtcg` | `json: string, mode: "merge" or "replace"` | `ctob/parse-multi-set-dtcg-json` plus per-set and per-token `set-token-set` and `set-token` changes (replace deletes sets not in the document); reads `$metadata` (active themes and sets, set order) |
| `set_base_font_size` | `value: string` | `cb/set-base-font-size` |
| `apply_token` / `unapply_token` | `page-id, shape-ids, token-name, attributes: [attr]`, `resolved-value` (required for apply by the backend; the adapter fills it, see deviation 5) | `app.common.logic.token-application`. `apply-token-to-shape` takes the token name as its second argument. Also uses `token-geometry-changes` and `unapply-token-from-shape`. Sets `:applied-tokens` on each attribute and the attribute value to the resolved value. |
| `add_interaction` / `remove_interaction` | `page-id, id, interaction map` / `page-id, id, index` | `cls/add-new-interaction` / update |
| `create_flow` / `remove_flow` | `page-id, id?, name, starting-frame` / `page-id, id` | `cb/set-flow` |
| `add_ruler_guide` / `remove_ruler_guide` | `page-id, id?, axis, position, frame-id?` / `page-id, id` | `cb/set-guide` |
| `set_board_grid_guides` | `page-id, id, grids` | `:grids` attr |
| `set_plugin_data` | `target: file/page/shape/component/color/typography, id?, page-id?, namespace, key, value` | `cb/set-plugin-data` |
| `align` / `distribute` | `page-id, ids, axis (hleft hcenter hright vtop vcenter vbottom) / (horizontal vertical)` | `app.common.geom.align` helpers; moves go through modifiers |
| `replace_font` | `page-id, from-font-id, to-font-id, root-ids? (1 to 500), variant-match? (exact, nearest), max-texts? (1 to 2000, default 1000)` | One `pcb/update-shapes` over all chosen texts; writes the five font fields; drops `position-data`; stamps the `modified-at` of the changed mains' components; reports through `opResults`. Section 3.3a. |

### 3.1 Layout reflow

After compiling the operations, `app.common.logic.modifiers/generate-reflow` is called with the ids of every created,
moved, resized or layout-changed shape and their parents. It finds the layout containers involved (`ctl/any-layout?`
on the shape or on its parent, plus `gm/find-auto-layouts`), builds a modif-tree of `ctm/reflow-modifiers` from all
the given ids, runs `gm/set-objects-modifiers`, and appends `mod-obj` changes produced by `pcb/update-shapes` with
`gsh/transform-shape` (attrs limited to the transform attrs the workspace uses, `:ignore-touched true`, then
`:reg-objects` for the parents). This is the pure part of the frontend's `apply-modifiers*` and
`update-layout-positions`. The resolve-tree climbs to the reflow root. Standalone root-level rects and circles with no
children are left out of the reflow, because a reflow does not change them.

### 3.2 Child order in layouts

A flex or grid layout keeps its children in `:shapes` in the reverse of their visual order. The front child is the
first in `:shapes`. The rules below say which order each operation uses.

- `create_*` into a layout parent without `index` inserts at `:shapes` index 0, the last visual place. So creation
  order equals visual order.
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
`regular`, `italic`, `600`, `600italic`, `bold`, `bolditalic`, `black` and `blackitalic`. `700` and `900` are not ids.
A weight and style pair maps through that table: 700 normal is `bold`, and 900 italic is `blackitalic`. Any other font
follows the numeric rule: `regular` is 400 normal, `italic` is 400 italic, `W` is weight W in normal style, and
`Witalic` is weight W in italic. Disagreeing fields raise `mcp-invalid-operation` with a hint that lists the valid
ids. A shape created without any of the three keeps Penpot's defaults.

These rules write a plain weight, such as `700`, as the variant id of a team font, which the workspace does not know
(it writes `<style>-<weight>`, for example `normal-700`). `replace_font` writes the workspace form (section 3.3a).
The older ops are not changed.

### 3.3a `replace_font`

`replace_font {page-id, from-font-id, to-font-id, root-ids?, variant-match?, max-texts?}` swaps one font for another on
one page (`operations/replace_font.cljc`).

- **Target.** The backend builds a font lookup (`app.rpc.mcp-font-lookup`) only when the call holds a `replace_font`
  operation, and passes it to the compile as `:font-lookup`. A call without one builds no lookup, and reads no font
  row. The target resolves as a bundled font, a Google font (the `google-fonts-provider` flag must be on) or a font
  of the file's team. The team rows are read on the first team font asked for. A target that does not resolve, or
  equal to the source, refuses the call (`mcp-invalid-operation`). The source need not resolve.
- **Nodes.** A text leaf with the source font id changes. A leaf with no font id changes when the source is
  `sourcesanspro`, the font such a leaf renders in. A paragraph, a paragraph set or a root changes only when its own
  font id is the source. Other nodes of the same text are not touched.
- **Fields.** A changed node gets `font-id`, `font-family`, `font-variant-id`, `font-weight` and `font-style`. The
  family is the one the workspace writes: `sourcesanspro` for the bundled font, the family of a Google font, and the
  `font_family` of a team font. The variant id is the one the workspace writes: the table id for a bundled font,
  `regular`, `italic`, `700` and `700italic` for a Google font, and `<style>-<weight>` for a team font (`typography.cljs`
  and `data/fonts.cljs` in the frontend). A paragraph or root with no weight, style or variant of its own gets only the
  font id and family.
- **Face.** The face of a run is its own `font-weight`, else the `font-weight` of its paragraph, else the weight its own
  `font-variant-id` names, else 400. The style goes the same way, apart from the weight. A paragraph set or a root gives
  a run nothing. This follows the wasm renderer: `write-spans` (`render_wasm/text_content.cljs`) reads the weight of the
  run, else of the paragraph, and `normalize-span-font` takes the paragraph as the only fallback. So a run with no
  weight under a bold paragraph stays bold, and a run under a root that names 700 stays 400. A word weight is no number
  to the renderer's closest-variant rule, so a `font-variant-id` that names a face wins over it (`bold` with `regular`
  is 400). With no such id the word counts as the renderer reads it, and the tests are case-sensitive: `normal` and
  `regular` 400, `bold` 700, `thin` 100, `extralight` 200, `light` 300, `medium` 500, `black` 900, and a case variant
  such as `Bold` 400. Other words (`semibold`, `extrabold`) are not mapped, and the op refuses them as a face the
  target lacks.
- **Paragraph nodes.** A paragraph, paragraph set or root that uses the source font gets `font-id`, `font-family` and,
  when it names a face already, the target's `font-variant-id`. Its `font-weight` and `font-style` are never written:
  runs of other fonts under it that name no weight inherit them.
- **Variants.** `exact` (default) needs the same weight and style in the target. If any text that would change uses a
  pair the target lacks, the call refuses, writes nothing, and the hint names each missing pair and the target's
  variants. `nearest` picks by `app.common.fonts.variants/closest-variant`, the same rule as
  `app.common.fonts/closest-variant` that the workspace uses: an exact weight wins, otherwise the closest, the higher
  of two equal ones, and a matching style at the same weight.
- **Skipped.** A text is not written, and is listed with a reason, when it is in a component copy (`component-copy`,
  with the component id, the file and `mainInThisFile`), when any of its nodes links a typography (`typography-ref`),
  or when its shape has a `font-family`, `font-weight` or `typography` token applied (`font-token`, with the token
  kinds). The checks run in that order. A skipped shape is not touched at all, tokens and `touched` included.
- **Mains.** A text in a main component of this file is changed. The component ids go to `mainsChanged`, and the op
  sets `modified-at` of each of those components (`pcb/update-component`), as the workspace does when a main is edited,
  so other files that use the library see a change. The undo change of `update-component` does not carry
  `modified-at`, so a rollback by undo leaves the later stamp; the snapshot is the rollback. The caller adds
  `{op: "sync_components"}` to the same call to carry the change to the copies. Do it in the same call: with no ids,
  `sync_components` syncs the mains that its own call touched, so a later call must name them. A copy whose text was overridden in any way (colour,
  size, anything: each override of the text style touches `text-content-attribute`) keeps all its text attributes
  after the sync, the old font included (`text-change-value` in `logic/libraries.cljc`). After the sync, call
  `list_fonts` again to find what is left. For a team font, reset the override with `reset_overrides {page-id, id}`,
  where `id` is the text shape in the copy: that resets that text only, while the id of the copy's top shape drops
  every override in the copy. Or set the font by hand in the workspace. Do not use `set_text_style` for a team font:
  it writes a plain weight such as `700` as the variant id (see Not covered). For a bundled or Google font
  `set_text_style` writes the right ids. Its own page's `replace_font` skips it as `component-copy`. A main in another
  file is never written.
- **Runs of other fonts.** A paragraph that used the source font may hold runs of other fonts that name no weight of
  their own. The op does not write those runs. In the workspace they take their weight from the paragraph, which is
  now matched against the new font, so they may show a different weight. The reply does not list them.
- **Hidden and locked.** Hidden and locked texts change like any other, as in the workspace.
- **Auto-sized texts.** The op does not resize texts. The workspace resizes an auto-width or auto-height text on a font
  change; here the box keeps its size until someone edits the text in the workspace, and a layout parent does not
  reflow. The reply counts them: `autoSizeTexts`, `autoSizeIds`, `autoSizeIdsTruncated`.
- **Limits.** More texts to change than `max-texts` refuses the call, and the hint gives the count. Skipped texts do
  not count. A `root-ids` entry that is not on the page answers `mcp-unknown-id`.
- **Write.** One `pcb/update-shapes` over all the chosen texts, with `:attrs #{:content :position-data}`: one
  `mod-obj` per changed text. It does not use `generate-update-shapes`, so it does not unapply tokens and it checks the
  changes once. There is no refit and no reflow: the text box keeps its size.
- **Layout.** `position-data` is dropped on every changed text, as the workspace does on a font change. Until the page
  is opened in the workspace, an svg export of a shape that holds such a text fails ("Text sizes" in the instructions),
  and `textLayoutState` is `approximate`. A png export works.
- **Snapshot.** A call that changes at least one text takes a snapshot before it writes (`snapshot-hint`), unless
  `snapshot` is false.
- **Reply.** `opResults[i]` is `{op, pageId, fromFontId, toFontId, toFamily, textsScanned, textsMatched, textsChanged,
  runsChanged, variantsUsed: [{from: {weight, style}, to: {variantId, weight, style}, exact}], changedIds,
  changedIdsTruncated, layoutDropped, layoutDroppedIds, layoutDroppedIdsTruncated, autoSizeTexts, autoSizeIds,
  autoSizeIdsTruncated, mainsChanged,
  mainsChangedTruncated, skipped: {total, byReason: [{reason, count}], items: [{id, reason, detail}],
  itemsTruncated}}`. Each list of ids holds at most 100. Counts are complete. `runsChanged` counts the leaves that
  hold text. `textsMatched` counts the texts with a node on the source font, skipped ones included.
- **Replay.** A replayed `requestId` answers `alreadyApplied: true`, `commits: 0` and the `opResults` of the first
  answer (section 2.11).
  The caller runs a dry run to see what is left. So put `sync_components` in the same call as `replace_font`, and
  dry-run first to see the lists.
- **Copies in the sync.** The copies that the sync changes lose their `position-data` too, and `layoutDropped` does not
  count them. The svg export note under Layout applies to them.
- **Not covered.** Typographies of the file library that use the source font, other pages, other files, and the
  variant ids that `set_text_style` and `create_text` write for a team font.

### 3.4 Tokens and component overrides

`create_token` and `update_token` accept the Penpot type names (`color`, `border-radius`, `font-size`, ...) and the DTCG
and plugin names: `borderRadius`, `fontSizes`, `fontSize`, `fontFamilies`, `fontFamily`, `fontWeights`, `fontWeight`,
`letterSpacing`, `textCase`, `textDecoration`, `borderWidth`, `boxShadow`, `dimension`, `sizing`, `spacing`, `opacity`,
`rotation`, `number`, `string`, `boolean`, `other`, `typography` and `shadow`. An unknown type raises
`mcp-invalid-operation`.

`instantiate_component` takes `overrides`, an optional list of `{name?, path?, characters?, props?}`. The keys are
camelCase on the wire, and the backend converts them. Each entry names one shape of the copy with exactly one of
these:

- `name`: the name of a descendant. It must match exactly one descendant of the copy.
- `path`: the names from the copy's root child downwards, joined by ` / `.

`characters` sets the text of a text shape. `props` sets non-geometry shape attributes. Geometry keys (`x`, `y`,
`width`, `height`, `rotation`) are refused; set geometry with `update_shape` on the new shape. An ambiguous or missing
target raises `mcp-invalid-operation`.

### 3.5 Props rules

`props` on `create_*` and `update_shape` is decoded key by key and checked against the closed schema of the shape's
type. An attr of one type is refused on another type. A structural key is refused with `mcp-invalid-operation`. The
hint names the op that sets the key (`schema.cljc`, `structural-prop-hints`):

- links and ids: `id`, `type` (create ops); `parent-id`, `frame-id`, `shapes` (`move_shapes`, `reorder`);
  `component-id`, `component-file` (`instantiate_component`, `swap_component`); `component-root` (`create_component`,
  `detach`); `main-instance` (`create_component`); `shape-ref` (`instantiate_component`, `detach`); `touched`, `remote-synced`
  (`reset_overrides`, `update_main`, `sync_components`); `applied-tokens` (`apply_token`, `unapply_token`);
  `masked-group` (`make_mask`, `remove_mask`)
- geometry: `selrect`, `points`, `transform`, `transform-inverse` (set `x`, `y`, `width`, `height` and `rotation` in
  `update_shape`); `position-data` (`set_text`, `set_text_style`, `replace_font`)
- layout: `layout`, `layout-gap`, `layout-gap-type`, `layout-gap-col`, `layout-gap-row`, `layout-padding`,
  `layout-padding-type` (`set_flex_layout` or `set_grid_layout`); `layout-grid-rows`, `layout-grid-columns`
  (`set_grid_layout`); `layout-grid-cells` (`set_grid_cell`); every `layout-item-*` key (`set_layout_child`)
- content and state: `content` (`set_text`, `set_text_style`, `create_svg_raw`); `bool-type` (`create_boolean`);
  `metadata` (`create_image`); `interactions` (`add_interaction`, `remove_interaction`); `plugin-data`
  (`set_plugin_data`); `variant-id`, `variant-name`, `variant-error`, `is-variant-container` (the component ops)

`flip-x` and `flip-y` are refused in `props` of every create op, of `update_shape` and of a component override, with
`mcp-invalid-operation` and the hint "props cannot set :flip-x: a flip cannot be set through this operation". A flip
changes the `transform` and the `points`, so the flag alone left an inconsistent shape. No op sets a flip. A create op
refuses `rotation` in `props` for the same reason (it sets no transform); `update_shape` takes `rotation` through the
modifiers, which turn the points and the transform together. Other keys that may be set alone and that the schema
still accepts, which this contract does not judge: `proportion`, `svg-viewbox`, `svg-transform`, `svg-attrs`,
`svg-defs`, `rx`, `ry` and `page-id`.

A shadow in `props.shadow` needs no `id`: one without an id gets a new id from the id function of the compile, as the
workspace does when it adds a shadow. This holds for every op that takes `props`, a component override included. A
shadow that does not fit its schema fails once, as `props.shadow is invalid: [...]`, with the messages of each key,
each message once.

A path gets the stroke that `cts/setup-shape` gives a new path: a centered, solid, 1 px black stroke (`minimal-path-attrs`
in `types/shape.cljc`). The workspace's pencil, curve and line tools get the same one, so `create_path` keeps it. Pass
`strokes: []` in `props` for a filled outline.

`layout-gap*`, `layout-padding*` and `layout-item-*` keys are refused in `props` on purpose. Use `set_flex_layout`,
`set_grid_layout` or `set_layout_child` for them. `hide-in-viewer` is allowed on every type.

`overflow-scroll` (JSON `overflowScroll`) is a board prop. Its values are `none`, `horizontal`, `vertical` and `both`,
and an absent value means `none`. `create_board` takes it in `props`, and so does `update_shape` on a board. Any other
value answers a validation error, `mcp-invalid-operation`, before anything is written (test
`create-board-and-update-overflow-scroll-test`). It marks a clipping board as a scroll container for prototypes and
code export. The viewer does not scroll it yet. The reads return it. The plugin API has `board.overflowScroll`, and
`execute_code` reads and writes it. The `scroll-hidden-control` rule of `lint_page` (section 2.8e) uses it: a control
that is hidden only along the axis the board scrolls is not clipped.

### 3.6 Parent refusals

Any op that takes a parent (`create_*`, `instantiate_component`, `move_shapes`, `reorder`, `clone_shape` with a
`parent-id`) checks the parent in `resolve-parent-id` (`refs.cljc`). Each refusal is `mcp-invalid-operation`:

- The parent is inside a component copy: `parent <id> is inside a component copy; a shape cannot be added to it`.
  To add a shape there, `detach` the copy first. The message does not name `detach`.
- The parent is a variant container: `parent <id> is a variant container; it holds only variants`.
- The parent is not a board, a group or a boolean: `parent <id> is a <type> and cannot hold children`.
- `instantiate_component` puts the copy inside its own component, or inside one of its copies:
  `an instance cannot be placed inside its own component`.
- `move_shapes` (and `clone_shape` with a `parent-id`) runs the editor's move check (`logic/shapes.cljc`,
  `check-structure-move`). It refuses a shape that moves into itself or into one of its children, a shape that moves
  into or out of a component copy, and a component that nests inside its own main.
- `clone_shape` without `parent-id` puts the clone where the source is, so the source's parent gets the same check.
  A clone of a copy child therefore needs a `parent-id` outside the copy.

## 4. Adapter (TypeScript, `mcp/packages/server`)

### 4.1 Mode and tool names

`PENPOT_MCP_MODE` is `bridge` (default), `backend` or `both`. The backend modes need `PENPOT_MCP_BACKEND_URI`. Setting
that URI alone does not switch the mode: the mode stays `bridge`, and the adapter logs a warning that the backend
tools are off.

- `bridge`: only the plugin-bridge tools, with their plain names.
- `backend`: only the backend tools. The plugin bridge is off.
- `both`: the backend tools own the plain names. The bridge versions are registered as `execute_code_in_tab`,
  `export_shape_from_tab` and `import_image_in_tab`.

`high_level_overview`, `penpot_api_info` and `submit_feedback` are shared by all modes.

Backend tools: `whoami`, `list_teams`, `list_projects`, `list_files`, `get_file_outline`, `get_page_tree`,
`get_shapes`, `find_shapes`, `export_subtree`, `get_interactions`, `find_connectors`, `list_fonts`, `lint_page`,
`find_similar_boards`, `get_library`, `get_tokens`, `apply_operations`, `apply_raw_changes`,
`batch_create_shapes`, `manage_files`, `manage_versions`, `comments`, `import_image`, `import_svg`,
`import_archive`, `export_shape`, `execute_code`, `describe_operations`.

`penpot_api_info` takes a type name or a topic. The topic `Geometry` gives the rules of the box, the transform, the
text, the gradients, the strokes and the children of a shape. The same text is the "Geometry semantics" section of
`packages/server/data/backend_instructions.md`.

`describe_operations {ops}` takes a list of operation names and returns their parameters as JSON Schema, with the rules
that span operations. The adapter points to it when an operation is rejected.

Every backend-mode tool argument uses camelCase. Every write tool accepts `dryRun`, `snapshot`, `baseRevn`,
`failOnConflict` and `requestId`. `apply_operations` and `execute_code` also accept `allowSplit`.

Type naming: the backend stores an ellipse as type `circle` and a board as type `frame`. The adapter shows `ellipse` in
the `get_shapes`, `get_page_tree` and `find_shapes` results and keeps `frame` for boards. `find_shapes` accepts
`ellipse` and `circle`, and `board` and `frame`, as the same type.

### 4.2 Tool to backend command

| tool | backend |
|---|---|
| `whoami` | `mcp-whoami` |
| `list_teams` | `get-teams` |
| `list_projects {teamId}` | `get-projects` |
| `list_files {projectId}` or `{teamId, query}` | `get-project-files` or `search-files`; `deleted: true` goes to `get-team-deleted-files`. Takes `limit` (1 to 1000, default 100). |
| `get_file_outline {fileId}` | `get-mcp-file-outline`. The reply passes through, with `warningsPendingPages`, `warningsPendingTruncated`, `warningsCompleteWith` and the suggestion keys of the warnings (section 2.3). |
| `get_page_tree {fileId, pageId, rootId?, depth?, fields?, limit?, cursor?}` | `get-mcp-page-tree`. `limit` defaults to 100 (1 to 5000). Layout children come in visual order. |
| `get_shapes {fileId, pageId, ids, fields?, includeChildren?}` | `get-mcp-shapes`. Without `fields` the tool sends: `id name type parentId x y width height hidden shapes`. |
| `find_shapes {...}` | `find-mcp-shapes`. `limit` defaults to 100 (1 to 1000). Type `ellipse` or `board` is sent as `circle` or `frame`. Matches show `ellipse` and `frame`. |
| `export_subtree {fileId, pageId, rootId?, cursor?, limit?, filePath?, overwrite?, compact?, encoding?, maxResponseKb?}` | `get-mcp-subtree` (section 2.8a). Inline: the adapter reads as many windows as fit the cap of the tool (`PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB`, section 4.6), each asked for the room left in the reply with `max-json-bytes`, and returns them as one reply (below). `limit` is 1 to 5000 shapes per reply, default 5000. With `filePath`, every window is read into one file (below). `compact` is passed on (section 2.8a). `encoding: "gzip-base64"` is for scripts (below). `maxResponseKb` sets the reply cap of one call, for scripts (below). A whole-page walk costs many backend reads, and the backend rate limit can stop it (section 4.3). Shape types show as the other tools show them (`ellipse`, `frame`). A path's or boolean's `content` is an SVG path string in page space. A text's `content` is its tree of paragraphs. |
| `get_interactions {fileId, pageId, limit?}` | `get-mcp-interactions` (section 2.8b). `limit` is 1 to 5000, default 1000. Shape types show as in `get_shapes`. |
| `find_connectors {fileId, pageId, maxDistance?, withinId?, limit?, offset?, depth?, mode?, boardNameRegex?, includeSameScreen?}` | `find-mcp-connectors` (section 2.8c). `maxDistance` is 0 to 2000, default 64. `withinId` limits the scan to the shapes under one shape, and it must be on the page. `limit` is 1 to 2000, default 500. `offset` skips connectors, to page a long list (see the paging bullet in section 4.3). `depth` (1 to 12), `mode` (`depth` or `auto`) and `boardNameRegex` select the screens as `lint_page` does. `includeSameScreen` (default false) returns the connectors whose ends lie in one screen. |
| `list_fonts {fileId, pageId?, rootIds?}` | `get-mcp-fonts` (section 2.8d). `rootIds` is 1 to 200 shape ids and needs `pageId`. Without `pageId` every page is read. At most 500 fonts come back. The reply passes through, with `pagesRead`, `pagesTotal` and the suggestion keys (`suggestedFontId` and the others). When `pagesRead` is below `pagesTotal` the adapter adds a `note`: call again with the same arguments, which goes on from the pages already read (kept 10 minutes, section 2.8d). |
| `lint_page {fileId, pageId, depth?, mode?, boardNameRegex?, minShapes?, rules?, tolerance?, minOverflow?, limit?, offset?}` | `get-mcp-page-lint` (section 2.8e). `depth` is 1 to 12. `mode` is `depth` or `auto`; with none of `depth`, `boardNameRegex` and `mode` it is `auto`, and `auto` with `depth` is refused. `minShapes` is 0 to 1000, default 3. `tolerance` is 0 to 100 px, default 0.5. `minOverflow` is 0 to 1000 px, default 8. `rules` takes 1 to 9 of seven names: `empty-board`, `instance-only-board`, `clipped-control`, `invisible-control`, `scroll-hidden-control`, `off-board-control` and `scroll-candidate`. `limit` is 1 to 2000, default 500. `offset` skips findings, to page a long list (see the paging bullet in section 4.3). The reply has `selection` (with `otherSizes` in mode `auto`), `deeperBoards` (mode `depth` only), `chromeComponents` and `total`. |
| `find_similar_boards {fileId, pageId, depth?, mode?, boardNameRegex?, threshold?, minShapes?, limit?}` | `find-mcp-similar-boards` (section 2.8f). `depth` and `mode` are those of `lint_page`. `threshold` is 0.5 to 1, default 0.9. `minShapes` is 1 to 1000, default 3. `limit` is 1 to 500, default 100. The reply has `selection`, `deeperBoards` (mode `depth` only), `skippedSmall` (`{count, ids}`, at most 50 ids) and `compared`, the number of pairs compared. |
| `get_library {fileId, kinds?}` | `get-mcp-library` |
| `get_tokens {fileId, setId?, format?}` | `get-mcp-tokens` with `fileId`, `setId` (one set; left out for every set) and `format` (`tokens`, the default, or `dtcg`). |
| `apply_operations {fileId, operations, ...}` | `mcp-apply-operations`. Operation `op` names and camelCase params pass through. The adapter validates each op with zod and reports the `index` and `op` of the first invalid one. |
| `batch_create_shapes {fileId, pageId, parentId?, tree}` | expands a nested tree into `create_*` ops with `$tmp:` handles, then `mcp-apply-operations` |
| `apply_raw_changes {fileId, changes, ...}` | `mcp-apply-changes` (needs the raw changes flag) |
| `manage_files {action, ...}` | `create_team`, `rename_team`, `create_project`, `rename_project`, `pin_project`, `delete_project`, `create_file`, `rename_file`, `duplicate_file`, `duplicate_project`, `move_files`, `move_project`, `delete_file`, `restore_files`, `set_shared`, `link_library`, `unlink_library`, each to the matching command |
| `manage_versions {fileId, action: list/create/restore/pin/unpin/delete/rename}` | snapshot commands |
| `comments {fileId, action: list/get/create_thread/reply/resolve/reopen/move/delete_thread/delete}` | `list` goes to `get-comment-threads` and takes `limit` (1 to 1000, default 100). `get` goes to `get-comments`. `create_thread` goes to `create-comment-thread`. `reply` goes to `create-comment`. `resolve` and `reopen` go to `update-comment-thread`. `move` goes to `update-comment-thread-position`. `delete_thread` goes to `delete-comment-thread`. `delete` goes to `delete-comment`. |
| `import_image {fileId, base64? url? filePath?, mimeType?, name?, pageId?, parentId?, x?, y?, width?, height?, createShape?}` | multipart `upload-file-media-object` or `create-file-media-object-from-url`, then a `create_image` op |
| `import_svg {fileId, pageId, svg, parentId?, x?, y?}` | `mcp-import-svg` |
| `import_archive {projectId, base64? filePath? url?, name?}` | multipart `import-binfile` (the SSE reply is read to the end) |
| `export_shape {fileId, pageId, shapeId or "page" or shapeIds, format, scale?, mode, renderer?, refresh?, filePath?, outputDir?, overwrite?}` | section 4.5 |
| `execute_code {code, fileId, pageId?, rootIds?, snapshot?, baseRevn?, failOnConflict?, allowSplit?, requestId?}` | section 4.4 |

`export_subtree` with `filePath` reads every window (5000 shapes or 4000000 bytes of JSON each, the largest the command
takes; the byte budget is cut to half of `PENPOT_MCP_BACKEND_MAX_RESPONSE_MB` when that is below 8, and not below
64000) and streams one JSON document to the file: `{"fileId", "pageId", "rootId", "revn", "total", "shapes": [...]}`.
The shapes are in walk order, with the attributes of section 2.8a in camelCase. With `compact` the document also holds
`compact: true` and `defaults`, and the shapes are compact. `encoding` is refused with `filePath`: a file is plain
JSON. The path must lie inside the export directory (section 4.5), end in `.json`, and not
replace a file unless `overwrite` is true. `cursor` is refused with `filePath`. The reply is `{path, shapes, bytes,
revn, windows}`, and the tool reports progress after each window. When the page changes during the walk, the walk
starts again once from the beginning. A second stale cursor fails with a message that the page keeps changing. A
failed walk removes the partial file and the folders the call created. In multi-user mode a `filePath` is refused.

### 4.3 Replies, writes and errors

- Every tool reply is compact JSON text, unless it carries images. `export_shape` returns image blocks.
- A reply above the response cap of 100 kB (`PENPOT_MCP_MAX_TOOL_RESPONSE_KB`) is cut. The cut reply says
  `truncated`, keeps the first items of each array (the same count for every array), and names the arrays it cut.
  Its `nextCursor`, if any, is dropped, because it would skip the cut items. The note tells the caller to repeat the
  call with a smaller limit. `find_connectors` and `lint_page` are not cut this way: they page by `offset` (next
  bullet).
- `find_connectors` and `lint_page` page by `offset`. The adapter passes `offset` to the backend (sections 2.8c and
  2.8e). When the reply is above the cap of the tool, it keeps as many whole items as fit, with room for the other
  fields, and sets `truncated` true, `nextOffset` (the `offset` of the call plus the items kept) and a `note`. The
  generic cut applies to these lists only when a single item does not fit the cap, and that reply carries no
  `nextOffset` (the generic cut drops `nextOffset` as it drops `nextCursor`). A client that calls again with `offset`
  set to `nextOffset`, until no `nextOffset` comes back, reads every item once and in order while `revn` stays the
  same and no reply has `timedOut`. The reply carries `revn`, so a client sees a change. When the whole reply fits,
  the reply of the backend passes through, with its own `nextOffset` when items remain. A reply with `timedOut` true
  is not complete and cannot be continued: it has no `nextOffset`, also when the adapter cuts it to fit the cap. The
  adapter adds a `note` to every such reply, cut or not, that says to start again with a narrower call. A `note` of
  the backend stays in front of it.
- The backend rate limit (HTTP 429, type `rate-limit`, code `request-blocked`) reaches every backend tool as
  `backend rate limit reached, retry after N s. A cursor from an earlier reply stays valid.` N is the `retry-after`
  header of the refusal, rounded up to whole seconds and at most 10. For a bucket limit the backend sends the time
  until the whole bucket is full again (about 120 s for the read bucket), but a permit comes back every 100 ms, so the
  adapter does not state more than 10 s. With no usable header the text says `wait about 10 s and retry`. The
  refusal comes before the command runs, so nothing was changed. The other 429 refusals (`concurrency-limit`) keep
  their `Backend error <code>: <hint>` text.
- A whole-page `export_subtree` walk costs backend reads. A call reads from 1 to about 24 windows (and up to 8 more
  to shrink a first window that does not fit), and each read takes one permit of the `:mcp-read` bucket of the profile
  (1200, refilling 600 a minute). A page of 115,219 shapes walked at the default cap of 100 kB took 3,356 reads over
  818 tool calls, about 4 a call, and the backend refused the next read. When a later window of a call is refused on
  the rate limit, the call returns the windows it holds, with `nextCursor` and a `note` that the limit cut it. When
  the first window is refused, the call fails with the error above. A client should raise
  `PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB` (a larger cap means fewer reads for the same page), or send
  `encoding: "gzip-base64"` (the cap counts the compressed text, so more shapes fit in a reply), or wait the time
  named and send the same cursor again. A cursor stays valid while `revn` is unchanged.
- An inline `export_subtree` reply is never cut and never lacks a cursor while shapes remain. It holds whole shapes
  of one or more backend windows, as many as fit the cap of the tool: `PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB`, which is
  the shared cap when unset (section 4.6). The adapter measures the reply as it will send it. Its fields are those of
  section 2.8a, and `windows`, the number of backend windows it read. `nextCursor` is the cursor of the last window
  read, so the next call resumes at the next shape. The adapter stops before a window that would overflow the cap, and
  returns the cursor that resumes there. When the first window is above the cap, it asks again for the leading shapes
  that fit (a smaller `limit`). A single shape above the cap comes back alone, with its large attributes (`content`,
  `positionData`, `shapes`, then other long values) replaced by `{omitted: true, bytes}`. The reply lists it in
  `oversize` (`[{id, bytes, omitted}]`, `bytes` being the real size of the shape), keeps `nextCursor` after it, and
  carries a `note` that says how to get the whole shape: raise `PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB`, or in local mode
  write the subtree with `filePath`. With `encoding` the cut shape is inside the encoded array, and `oversize` and
  `note` stay plain. When the page changes after some windows were read, the reply holds those shapes and the cursor
  of the next window, which the next call refuses as stale: the walk starts again without a cursor. A window of
  another revision is never mixed into a reply: when the first window is asked for again to cut it and the page
  changed between the two answers, the reply takes the revision and total of the newer answer.
- `encoding: "gzip-base64"` is for scripts. A model should not ask for it: base64 text is waste in its context. The
  `shapes` of the reply become `{encoding, bytes, count, data}`: `data` is the base64 text of the gzip of the JSON array
  of the shapes, `bytes` its size before compression and `count` the number of shapes. The other fields and `nextCursor`
  stay plain. The cap applies to the reply as sent, so a reply holds the windows whose compressed size fits. The first
  window is compressed alone to find the ratio; the sizes of later windows are estimated from it, and the whole reply is
  compressed once and checked against the cap. Over it, whole trailing windows are left for the next call and the
  reply is compressed again, so the reply is never over the cap. Compression runs off the event loop. A call also
  gathers at most 16 MB of plain JSON text, whatever the encoding and the cap, and returns its cursor at that point.
  With `gzip-base64` the later windows of a reply are sized so that the reply fills toward the cap: a window after the
  first is asked for what fits at the measured ratio less a safety margin, so a default gzip call packs more shapes into
  one reply.
- `maxResponseKb` is for scripts. It is a whole number of kilobytes from 1 to 10000, and it is the reply cap for that
  one call in place of the cap of the tool. It is allowed only with `encoding: "gzip-base64"` and only inline (not
  with `filePath`). A call that leaves it out gets the cap of the tool, as before. It may not be above the server
  maximum, `PENPOT_MCP_SUBTREE_MAX_REQUEST_KB` (section 4.6). A refused call fails the tool with one of these texts:
  `maxResponseKb cannot be used with filePath: a file holds the whole subtree.`; `maxResponseKb can only be used with
  encoding "gzip-base64": it is for scripts, and a model client keeps the default cap.`; `maxResponseKb N is above the
  server maximum of M kB (PENPOT_MCP_SUBTREE_MAX_REQUEST_KB).` The advice in an `oversize` note or an error to raise the
  cap names `maxResponseKb` and the server maximum when the call set it; when the call already asked for the server
  maximum, it says that the shape does not fit even at the server maximum.
  It works with `compact`, in both modes.
- Every write sends a `requestId`. The caller may name it. Otherwise the adapter makes a UUID for the call. A retry
  of the same write must reuse the `requestId`. The same id with another payload is a new write on the backend. A repeat that the backend already applied returns `alreadyApplied:
  true`, a note that nothing changed, and the `createdIds` and `opResults` of the first answer. The idempotency window is set by the backend (section 2.11).
- A write is never cancelled by the caller once it is sent. A write still queued when its call is abandoned is
  skipped, and it never starts. The backend timeout (`PENPOT_MCP_BACKEND_TIMEOUT_S`, 55 s) still ends the wait for a
  sent write. The backend may commit the write after the adapter stops waiting.
- Writes to one `(token, fileId)` are serialized by an in-process queue.
- Backend errors render as `Backend error <code>: <hint>` (section 1 of this document).
- Every backend call sends `X-Request-Id` with the id of the tool call, so a backend log line and an adapter log line
  name the same call.

### 4.4 `execute_code` (sandbox)

`execute_code` runs a script in a QuickJS sandbox, in a worker thread by default (`PENPOT_MCP_SANDBOX_WORKERS`, section 4.6). The guest code folds the updates and `appendChild` calls of a new
board, rectangle or ellipse into its create op as the script queues them. Then the host sends the queued operations
to the backend.

Limits (defaults, all set by `PENPOT_MCP_SANDBOX_*`, section 4.6):

- guest CPU time of one call: 3 s (`PENPOT_MCP_SANDBOX_TIMEOUT_S`)
- wall-clock time of one call: 120 s (`PENPOT_MCP_SANDBOX_WALL_S`)
- host primitive calls per script: 1000 (`PENPOT_MCP_SANDBOX_MAX_HOST_CALLS`)
- operations per script: 5000, counted after folding
- live sandbox runtimes: 20 (`PENPOT_MCP_SANDBOX_MAX_SESSIONS`), evicted after 30 idle minutes
  (`PENPOT_MCP_SANDBOX_IDLE_MIN`)
- calls that run at once in one process: 20 (`PENPOT_MCP_SANDBOX_MAX_CONCURRENT`). A call that finds every slot taken
  waits up to 60 s for one.
- one running script per token. Up to 2 more calls of the same token may wait in a short queue.
- the log, the result and the error text are each capped at 256 kB
- `storage` (the script's own data) is kept per MCP token, across files. It holds JSON values only: a cycle or a
  function is lost on save. Its saved JSON is capped at 8 MB. A larger save keeps the last copy that fit and adds a
  note to the reply.

Partial loads (`rootIds` with `pageId`):

- `rootIds` names 1 to 20 shapes of the page, not the page root. The host fixes the roots for the call, so script code
  cannot change them. Each root loads with its subtree, and a deep subtree loads past depth 20.
- Every ancestor of a root loads too, up to the page root. An ancestor loaded only to reach a root is a stub: its
  `ancestorOnly` is true, and its child list is partial (`childrenPartial` true). The page root is partial too, when it
  loads with stubs. `children` returns the stubs, so a walk from the root reaches the loaded shapes. `findShapes` and
  `penpotUtils.findShapes` skip stubs in their results.
- Shapes outside the roots are not in the model. `penpot.root` lists the loaded shapes only.
- The call fails before anything loads when `pageId` is not a page of the file: the error reads `pageId <id> is not a page of file <id>`. A root that is not a shape of
  that page fails the call, and the error names the root.
- A root that the script removes is dropped at the next refresh. Each flush reloads the page from the roots again,
  which takes one rate-limit token. The first load of a page takes one token for each root, whatever the number of
  backend calls it makes.
- The roots load through `get-mcp-shapes` with `include-children` and `include-ancestors`, not through the page tree:
  one call names every root, and the ancestors come in the same reply. A reply cut at 2000 shapes or about 1 MB is
  followed by rounds that ask for the ids still absent (the roots not returned, the children of returned shapes not
  returned), split in calls of at most 200 ids, at most 2 calls at a time (the backend lets one profile run 4 MCP reads
  at once), and at most 100 rounds. The backend lists the children of a shape before the descendants of its first
  child, so a cut leaves the children of later siblings absent. A loaded shape none of whose children has loaded, and
  that no earlier reply has returned after a request of its own, is asked for in place of its children (one id, with
  `include-children`). Any other absent id is asked for by id. A board of 130 groups of 129 leaves (16,900 shapes)
  loads in 9 calls. A round that brings nothing new fails the load, except a round that asked for such a shape: its
  children are then asked for by id. The adapter rebuilds the tree order from the child lists (reverse for a flex or grid
  board). A load of 20 roots with 2,600 shapes takes 2 calls, the least that the 2000-shape reply cap allows.
- A whole-page load reads the first tree window with `estimate-size`. A page whose estimate is above 1.3 times
  `PENPOT_MCP_SANDBOX_PAGE_MB` is refused after that one call, with the message of the later check but for the words
  "estimated at about", and the later check still guards a page that the estimate rated too low.
- A shape nested more than 20 levels below a root now comes in document order, in place. Before, such branches were
  listed after all the roots.
- A parent whose child list did not load in full, and a stub, refuse the operations that need every child: an insert at
  an index, a z-order move of a child (`setParentIndex`, `bringToFront`, `sendToBack`, `bringForward`,
  `sendBackward`), the `parentIndex` read of a child, and `remove`, `ungroup` and `flatten` of the shape. A stub cannot
  be moved either. `penpotUtils.addFlexLayout` checks the same rule before it writes anything. The error reads:
  `<operation> needs every child of <parent>, and rootIds did not load them all. Add that shape's id to rootIds, or run
  without rootIds.` An append on top with no index stays allowed.
- A reference to a shape outside the roots is a placeholder. As JSON it is `{id, loaded: false}`. Any other read of it
  throws `shape <id> is not loaded: rootIds loads only the given subtrees`.
- `swapComponent` on a root gives the root a new id that the model does not learn, and the old root is dropped at the next
  refresh. Pass the parent of the instance as the root when swapping components.
- The reply carries a warning `{code: "partial-page", pageId, rootIds, shapes, ancestors}`. `shapes` counts the loaded
  shapes, and `ancestors` lists the ancestor-only ids. A whole load can add two warnings: `shapes-below-depth-limit`,
  for shapes nested deeper than 20 levels that are not in the model, and `shapes-missing`, for shapes that the backend
  reported missing.

Flushes:

- A flush sends its operations in calls of at most 2000 operations. A flush of up to 2000 operations is one call. A
  larger flush goes in calls of 1500, in order. Each later call names the shapes that an earlier call created, by
  their ids.
- All calls of one flush hold the write queue of the file from the first call to the last.
- Before the first call, the host checks every operation, fills the `apply_token` values, and admits all the calls of
  the flush together. So a rate limit does not stop a flush half way.
- A dry run (`file.validate()`) goes in one call and is refused above 2000 operations.
- Each call's `requestId` is the script's `requestId` for the first call of the first flush. Every other call derives
  its id from the script id and its position, as a hash of `<scriptId>/<flush>/<call>`. A retry of the same script with
  the same `requestId` therefore reuses the same ids.
- If a later call fails, the error names that call, the operations that the earlier calls committed, and says that
  those calls stay applied. A later chunk's failure returns the saved ids.
- The response counts `flushes` (whole flushes and SVG imports), `chunks` (successful calls) and `opsApplied`.

Snapshot (`snapshot` argument):

- Unset: the backend rule applies to each call (section 2.11).
- `false`: no call takes a snapshot.
- `true`: the first write of the script takes a snapshot. Later calls send `snapshot: false`. A call that the backend
  rule would snapshot anyway, such as a delete, still takes one.

Reads: a read of a page whose queued operations the local model cannot show flushes those operations first. Other
attribute reads come from the local model, which is a working copy without the `common` build. Derived geometry is
refreshed from the backend after each flush (deviation 8).

The sandbox facade maps the layout setters to backend ops: `layoutItem*` setters emit `set_layout_child`, and
`path.content` emits `set_path_content`.

### 4.5 `export_shape` (exporter)

- Formats: `png`, `jpeg`, `webp` return an image of at most 8 MB, and at most 16 million pixels (the box times the
  scale). `svg` and `pdf` return text (pdf as base64 inside JSON), at most 256 kB (256 000 bytes). Larger output
  needs `filePath`.
- An `svg` export of a shape that holds a text created or changed through the MCP fails with an exporter timeout until
  the file is opened in the workspace, because such a text has no `positionData`. This failure is not retried. The error
  then says to export `png` or to open the file once and retry.
- `filePath` writes the file inside the export root, `PENPOT_MCP_EXPORT_DIR`, which defaults to `penpot-exports` in the
  home directory. A file is not replaced unless `overwrite` is true. The path must end in the format's extension.
- `shapeId: "page"` exports the first 10 root shapes of the page, in page order, one call of the exporter per shape.
  The total image output stays under 8 MB. The reply says how many were rendered, and that the rest must be exported
  by id. `filePath` is refused with `shapeId: "page"`: export one shape by id to save it to a file.
- Concurrency: each token gets one render at a time. The whole process runs at most 4 renders against the backend at a
  time (`PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS`; 0 means no limit). A render waits at most 60 s. With Redis, the renders of all adapters share `PENPOT_MCP_EXPORT_TOTAL_PERMITS` permits, and callers that wait for one are served in arrival order.
- The render session cookie is taken from `create-mcp-render-session` (section 2.9).
- `shapeIds` (1 to 200 ids, not with `shapeId`) exports several shapes in one call. The ids are lower-cased. They go to the
  exporter in chunks of `PENPOT_MCP_EXPORT_BATCH_SIZE` (section 4.6). Each chunk is one exporter request under one render
  permit. The exporter answers a ZIP for a chunk of two or more shapes. The adapter reads it, checks every entry against
  its CRC-32, and maps each entry back to its shape id. Its size cap is the cap of one file for each shape of the chunk,
  plus 1 MB for the archive headers. A chunk of one shape is a plain file. `shapeId: "page"` uses the same path for its
  first 10 root shapes.
- Each render is cached as soon as its bytes arrive, before it is written or reported. It stays for 15 minutes, whatever
  its fonts. The key is the file id, the file revision, the page id, the shape id, the format, the scale and the renderer.
  A render is not cached when the file revision is unknown. `refresh: true` renders the shape again and replaces its
  cached render.
- The font check is separate. After the renders, the tool asks `get-mcp-fonts` for the shapes that it served, with a
  wait of 3 s at most. The check only makes the notice. A JSON reply (with `outputDir`) gets `warnings`, one
  `{kind: "font-unresolved", fontId, family, reason, runs}` for each unresolved font. An inline reply gets a text item.
  The notice names each font and says to run `list_fonts`. It also says that the renders are kept for up to 15 minutes,
  so pass `refresh: true` after the font is fixed. A late or failed check adds nothing.
- Failure policy of a batch:
  - A busy exporter (HTTP 429, or a wait for a permit that runs past its limit) and a cancelled call end the call. The
    shapes not reached fail with the stop text. There is no fallback.
  - A chunk that runs past its render deadline, an answer too large for its cap, and a ZIP that does not map back to the
    shapes switch the rest of the call to one shape per request.
  - Any other failure of a batch (a 5xx, or another error) renders the chunk one shape per request. Only when every
    shape of the chunk then renders, the exporter is recorded as refusing batches for 10 minutes. The record is kept per
    exporter client in the process, and no batch goes to that exporter in that time.
  - A breaker stops a failure that keeps coming back. When every shape of a chunk fails with the same class of error
    (authentication, HTTP 401 or 403; network, an unreachable exporter or a render deadline; or a 5xx), and the first
    request of the next chunk fails with that class again, the call stops. The shapes not yet rendered fail with that
    error.
- Progress: a client must send a progress token to see progress. The call then reports each finished shape (`progress`
  is the number of shapes done, `total` the number of shapes). While one chunk request is in flight, it also sends a
  notification every 5 s that says in `message` which chunk of how many is rendering. Its `progress` is the shapes done
  plus n / (n + 1), where n counts the heartbeats since a shape last finished, so it rises with each notification and stays
  below the next shape. The server drops any progress notification that is not above the last one of its request. The
  timer stops when the chunk returns or fails, and nothing is sent after the reply. A call with no token sends nothing.
- A single render that answers 5xx is tried once more after 500 ms. A 4xx answer is not retried.
- The call budget is 10 minutes. Past it, the call starts no more renders, and the shapes left are not rendered.
- Inline replies: an image too large on its own is not returned (the reply says so and names `outputDir` or
  `filePath`). An image that does not fit the 8 MB total left is not returned. When less than 256 kB of the total is
  left, the total is full: the shapes after it are listed as not rendered, with the text "the inline total is full; pass
  outputDir to save every shape, or ask for fewer shapes". An svg or pdf above 256 kB is not returned.
- With `outputDir`, each file is written through a temporary file, then renamed when `overwrite` is true. Without
  `overwrite`, an existing file is refused. The reply is JSON: `{rendered, cached, failed: [{shapeId, error}], files:
  [{shapeId, path, bytes}], notRendered: [{shapeId, reason}]}`, plus `warnings` when a font does not resolve.
- Stop texts. A stop of a call with `outputDir` adds "call again with overwrite: true", since the files already written
  are refused without it. The other stop texts read:
  - "export is busy, retry later; call again; the shapes already rendered come from the cache." (a busy exporter)
  - "the call was cancelled; call again; the shapes already rendered come from the cache."
  - "the call ran out of time; call again; the shapes already rendered come from the cache." (the 10 minute budget)
  - "an earlier shape failed, so the shapes after it were not rendered." (`shapeId: "page"` only, which stops at the
    first failure)
  A shape that fails alone keeps its own error, and a breaker stop uses the error of the failure.

### 4.6 Adapter settings

All values are read from the environment at start. A malformed value stops the start, and the error names the
variable.

| Variable | Default | Meaning |
|---|---|---|
| `PENPOT_MCP_MODE` | `bridge` | `bridge`, `backend` or `both` (section 4.1) |
| `PENPOT_MCP_BACKEND_URI` | unset | Penpot backend URI. Needed for `backend` and `both`. |
| `PENPOT_MCP_ASSETS_URI` | unset | Public URI that serves `/assets/by-id/`. When unset, the exporter's origin is used. |
| `PENPOT_MCP_EXPORTER_URI` | `http://localhost:6061/` | Exporter base URI |
| `PENPOT_MCP_AUTH_URI` | unset | Enables OAuth. Needs multi-user mode and an HTTPS URI (HTTP on loopback). |
| `PENPOT_MCP_BACKEND_TIMEOUT_S` | `55` | Timeout of each backend command, in seconds |
| `PENPOT_MCP_BACKEND_MAX_RESPONSE_MB` | `8` | Cap on one backend response |
| `PENPOT_MCP_RATE_LIMIT_RPS` | `10` | Sustained requests per second per MCP token |
| `PENPOT_MCP_RATE_LIMIT_BURST` | `20` | Requests per MCP token that may be sent at once |
| `PENPOT_MCP_TOKEN_CACHE_S` | `60` | Seconds a good token check is reused. A rejected token is kept 5 s. Any positive number. |
| `PENPOT_MCP_ALLOW_QUERY_TOKEN` | `true` in bridge mode, `false` otherwise | Accepts `?userToken=`. When `true`, a warning is logged once per token. |
| `PENPOT_MCP_MAX_BODY_MB` | `32` | Request body limit after authentication. Before it, the limit is 4 MB. |
| `PENPOT_MCP_MAX_TOOL_RESPONSE_KB` | `100` | Cap on a tool reply (1 to 10000) |
&
| `PENPOT_MCP_SUBTREE_MAX_REQUEST_KB` | the larger of 2000 and the default reply cap | The largest `maxResponseKb` that one `export_subtree` call may ask for, whole kB from 1 to 10000. Set below the default reply cap it fails the tool at start, so that a script can always ask for the default size. |
| `PENPOT_MCP_EXPORT_DIR` | `~/penpot-exports` | Export root for `export_shape` `filePath` |
| `PENPOT_MCP_IMPORT_DIR` | `~/penpot-imports` | Import root for `filePath` arguments |
| `PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS` | `0` in bridge mode, `4` in backend mode | Renders at once in one process against the backend; 0 means no limit |
| `PENPOT_MCP_EXPORT_TOTAL_PERMITS` | `4` | Renders at once across all adapters that share `PENPOT_MCP_REDIS_URI`. Needs Redis. |
| `PENPOT_MCP_EXPORT_BATCH_SIZE` | `10` | Shapes that one exporter request renders in a `shapeIds` batch, 1 to 50 (section 4.5). |
| `PENPOT_MCP_EXPORT_CACHE_MB` | `64` | Size of the in-memory cache of rendered shapes in each adapter process, in MB, 0 to 4096. `0` turns it off (section 4.5). |
| `PENPOT_MCP_SANDBOX_TIMEOUT_S` | `3` | Guest CPU time of one `execute_code` call |
| `PENPOT_MCP_SANDBOX_WALL_S` | `120` | Wall-clock limit of one call |
| `PENPOT_MCP_SANDBOX_IDLE_MIN` | `30` | Idle minutes before a session sandbox is evicted |
| `PENPOT_MCP_SANDBOX_MAX_HOST_CALLS` | `1000` | Host primitive calls per script |
| `PENPOT_MCP_SANDBOX_HOST_MS` | `30000` | Host time of one script, in milliseconds. It counts backend and exporter calls, rate-limit waits included. |
| `PENPOT_MCP_SANDBOX_PAGE_MB` | `16` | Page data one call may hold, in MB of JSON |
| `PENPOT_MCP_SANDBOX_MAX_SESSIONS` | `20` | Live sandbox runtimes |
| `PENPOT_MCP_SANDBOX_MAX_CONCURRENT` | `20` | Calls that run at once in one process. Set on its own: it does not follow `PENPOT_MCP_SANDBOX_MAX_SESSIONS`. |
| `PENPOT_MCP_SANDBOX_WORKERS` | `true` | Runs each guest in a worker thread. `false` or `0` runs it on the main thread. Any other value that is not true or false stops the start. |
| `PENPOT_MCP_SERVER_HOST` | `localhost` | Listen host |
| `PENPOT_MCP_SERVER_PORT` | `4401` | Listen port |
| `PENPOT_MCP_KEEPALIVE_S` | `65` | Seconds the server keeps an idle HTTP connection open. Keep it above the idle timeout of the proxy in front (`deploy/nginx.conf` uses 60 s). |
| `PENPOT_MCP_WEBSOCKET_PORT` | `4402` | Plugin bridge port (bridge mode) |
| `PENPOT_MCP_TOOL_TIMEOUT_S` | `120` | Plugin bridge tool timeout (bridge mode) |
| `PENPOT_MCP_REDIS_URI` | unset | `redis://` or `rediss://` URI. In backend and both modes it shares the rate limit and the sandbox storage between instances, whatever the multi-user setting. Unset: each instance keeps its own. In bridge and both modes, with multi-user, it routes plugin tasks between instances. |
| `PENPOT_MCP_REMOTE_MODE` | `false` | `true` enables remote mode. Only the exact value `true` enables it. |
| `PENPOT_MCP_REPL_ENABLE` | unset | `true` or `false` sets whether the REPL starts. When unset, the REPL starts only if `PENPOT_MCP_DEVENV` is `true`, in single-user mode. |
| `PENPOT_MCP_REPL_HOST` / `PENPOT_MCP_REPL_PORT` | `localhost` / `4403` | REPL listen address |
| `PENPOT_MCP_DEVENV` | unset | `true` starts the REPL, unless `PENPOT_MCP_REPL_ENABLE` says otherwise |
| `PENPOT_MCP_LOG_LEVEL` | `info` | Log level |
| `PENPOT_MCP_LOG_DIR` | unset | Log directory. Logging to a file is on only when it is set. |

### 4.7 Health, metrics and contract check

- `GET /healthz` answers that the adapter is up.
- `GET /readyz` answers whether the backend can serve calls. It exists when a backend is configured.
- `GET /metrics` serves the adapter's Prometheus metrics: tool call counts and timings, the sandbox counters, and the
  export counters. `penpot_mcp_export_busy_total{gate}` counts the exports refused as busy, by the `token`, `process` or
  `shared` gate. The gauge `penpot_mcp_export_permits_held{gate}` shows the permits that this process holds, for the
  `process` and `shared` gates. Summed over the adapters, the `shared` gauge against `PENPOT_MCP_EXPORT_TOTAL_PERMITS`
  shows how full the render cap is. The endpoint answers without a token only to a client on this machine. The adapter
  must bind a loopback host, and the request must carry no forwarding header (`X-Forwarded-For`, `X-Forwarded-Host`,
  `X-Real-IP` or `Forwarded`). Any other request needs a valid token.
- Package: the root package (`mcp/package.json`) ships `pnpm-lock.dist.yaml`. The `prepack` script copies it from
  `pnpm-lock.yaml`, and `postpack` removes it. Its `files` list leaves out the test files (`*.test.ts`), the backend
  test helpers and the integration scripts.
- Server bundle: `pnpm build:server` in `mcp/packages/server` runs esbuild with two entries, `dist/index.js` and
  `dist/SandboxWorkerThread.js`. The sandbox worker must sit next to `dist/index.js`; `scripts/copy-resources.js`
  checks for it.
- Before the adapter serves backend tools, it reads `contractVersion` from `mcp-whoami` (on first use of a token). A
  backend that reports no version, or one below 1 (the version this adapter needs), is refused for backend mode.
  The adapter logs an error that asks for a backend upgrade.

### 4.8 Adapter auth and limits

- `BackendTokenValidator`: on first use of a token (and at most every 60 s afterwards) calls `mcp-whoami`. The cache
  key is the SHA-256 hex of the token. A 401 answers the tool error "The MCP token was rejected by the backend". The
  HTTP layer answers 401 with `WWW-Authenticate` when OAuth is enabled.
- `TokenRateLimiter`: a token bucket per token fingerprint, refilled at `PENPOT_MCP_RATE_LIMIT_RPS` (10) per second, with
  a burst of `PENPOT_MCP_RATE_LIMIT_BURST` (20). The refusal text is "rate limited, retry after N s".
- Body limits: a request is read up to 4 MB before it is authenticated. After authentication the limit is
  `PENPOT_MCP_MAX_BODY_MB` (32 MB by default).
- Writes on one `(token, fileId)` run one at a time (section 4.3).

## 5. Deviations from the plan (and why)

1. Page summaries are cached per page pointer (or per file revn for a plain page). No index table (plan D11).
2. Text sizes are heuristic: 0.6 em per character, 1.2 em per line. No JVM font measurer and no reflow job yet.
   Shapes carry `textLayoutState: "approximate"` until a browser session reflows them.
3. `set_text_style` applies to the whole text shape. Range styling is not implemented.
4. `import_svg` does not upload embedded raster images.
5. Token value resolution happens in the adapter for `apply_token`. The backend takes `resolvedValue`. Both write
   paths, `apply_operations` and the flushes of `execute_code`, use one resolver (`sandbox/ApplyTokenValues.ts` over
   `sandbox/TokenResolver.ts`). An `apply_token` without `resolvedValue` gets the token's value from the active sets of
   a `get-mcp-tokens` read, made once per call and only when the call holds an `apply_token`. A token that is missing,
   only in an inactive set, in a reference cycle or an unsupported expression fails the call before any write. A
   caller's `resolvedValue` is kept as an override. The result then carries a `token-value-differs` warning when it is
   not the resolved value, or `token-value-unchecked` when the token does not resolve. An `apply_token` after a token,
   set, theme or base-font-size write of the same call must carry `resolvedValue`, since the catalogue read is older
   than that write. `rem` uses 16 px, because the catalogue does not carry the file's base font size.
6. `combine_as_variants` and `switch_variant` are not implemented (frontend-only logic not yet ported).
7. `mcp-token-max-age` defaults to 90 days. A token created with no expiry gets that age. Operators can change it.
8. `execute_code` previews attribute reads from the working copy without the ClojureScript `common` build. Derived
   geometry is refreshed from the backend after each flush.
9. Parity decisions: match the Plugin API, not the UI. Default names are the plain base name ("Rectangle", "Board",
   "Text") with no uniqueness suffix, and `create_text` without width or height uses `grow-type auto-width`.
   `set_flex_layout` and `set_grid_layout` merge the initial layout and do not run `calculate-params` (the plugin
   passes `calculate-params? false`). They clear the children's constraints, as the frontend layout initializer does.
   `create_group` sets the children's constraints to `:scale` and takes the last child's grid cell.
10. Deferred, not implemented: variant ops (`combine_as_variants` and the other variant ops), `duplicate_component`,
    `sync_library_consumers`, and automatic sync of copies after editing a main. Agents call `sync_components` instead.
11. `import_tokens_dtcg` does not refuse duplicate token names inside one set. The DTCG parser merges same-named tokens
    before the op sees them. `create_token`, `update_token` and renames refuse duplicate names.
12. The props schema is closed. An unknown key fails with `mcp-invalid-operation`. A structural key fails too, and its
    hint names the op that sets it. The full list is in section 3.5. The `layout-gap*`, `layout-padding*` and
    `layout-item-*` keys are refused in `props`; use `set_flex_layout`, `set_grid_layout` or `set_layout_child`.
    `hide-in-viewer` is allowed.
13. `set_text_style` and `apply_typography` apply to the whole text shape, not to ranges. See item 3.
14. `apply_token` looks up the token type by name in the active sets. An unknown name raises `mcp-unknown-id`. Token
    values are checked against the schema for their type.
15. Every error from a failed op carries `:type :validation`, `:code :mcp-invalid-operation` (or `:mcp-unknown-id` for an
    unknown id, also with `:type :validation`), `:index` (the op index, `nil` for the reflow phase), `:op` (the op name,
    `"reflow"` for the reflow phase), and `:cause-code` (the original code). A literal id that already exists in its
    collection raises `mcp-invalid-operation` with the hint "id already exists". A handle or id that is not known raises
    `mcp-unknown-id`.
16. Performance: the benchmark test `bench-2000-update-shape-on-20000-shapes` (2000 `update_shape` ops on a page of
    20,000 shapes) must finish under 5 s on the JVM. Props are decoded per key. Geometry updates receive only the
    shape's reflow subtree, its ancestors, and the immediate children of its group-like ancestors, not the whole page.
17. `delete_page` on a page whose components are used elsewhere: components whose main is on the page are deleted with
    it, as the frontend does.

## 6. Contract version

- `mcp-whoami` reports `contractVersion`. The value is `1` (`mcp-contract-version` in `mcp.clj`).
- The backend code gives this rule for a bump: bump the version when a reply or a command changes shape in a way the
  adapter must notice. The adapter reads the value from `mcp-whoami` before it serves tools.
- The adapter needs version 1 or later (`SUPPORTED_CONTRACT_VERSION`). A backend that reports less is refused for
  backend mode. An adapter that needs version 1 works with this backend.
- Additions do not bump the version. New fields in a reply, new ops, new optional params and new error codes are
  compatible additions. Round 2 added such items and kept the version at 1. Round 2 also renamed a failure field
  (`last-committed-revn` to `revn-before-call`); the adapter does not read that field, so no bump was made.
  Round 4 is the same kind of change: six read commands, two adapter settings, a `warnings` field in the outline and
  new optional arguments. These are additions, so `contractVersion` stays at 1.
- Whether a change of a command's behaviour, without a change of shape, needs a bump is not defined in code. Round 2
  changed behaviour (the 50-batch limit, the replay key, the lock codes) without a bump.

## 7. Changes

### Round 1

- Backend switch: `enable-mcp-backend` is off by default. MCP tokens reach only `send-mcp-feedback` until it is on.
- Raw change batches need `enable-mcp-raw-changes`.
- Render sessions are restricted to the RPC routes and `/assets`, and to seven read commands on their own files. They
  end with their token and with the profile's MCP switch, and the garbage collector deletes them after 10 minutes.
- The OAuth consent routes refuse render sessions.
- Scopes: every MCP command declares its scope, and the server refuses to start without one. Snapshot restores and
  snapshot deletes need `mcp:delete`. `restore-deleted-team-files` stays at `mcp:manage`. Commands that the earlier
  text listed as reachable, such as `get-team` and `update-file`, are not reachable by MCP tokens (section 1.4).
- Reads: page cache keyed by page pointer id and bounded by shape count. Cursors bind to the page pointer id. Replies
  are capped at about 1 MB of encoded data, with `truncated`.
- Reads take `fields` by name only, with `content` and `position-data` named on their own. `get-mcp-tokens` takes
  `set-id` and `format`. `get-mcp-library` reports totals and `truncated`. `find-mcp-shapes` takes `type` as an enum.
- `mcp-whoami` reports `contractVersion`, `operations` and `limits`.
- Limits: read and write buckets per profile; climit permits for reads, applies and find (section 2.10).
- Limits: the write limiters are declared in the order `mcp-apply/by-profile`, `mcp-apply/global`,
  `mcp-update-file/by-profile` (section 2.10).
- Writes: one transaction per call. The file is decoded once and written once. Batches are cut above 2000 changes and
  capped at 100 per call. A lock wait ends after 15 s (`mcp-file-busy`). A call ends after 60 s
  (`mcp-time-budget-exceeded`).
- Replays: a repeat of a committed request id answers `alreadyApplied`, with the `createdIds` and `opResults` of the
  first answer, and writes nothing.
- Validation: MCP writes always run the affected-shapes check. Dry runs run the same checks as commits.
- Libraries load their roots when a call needs them. Their pages load when an operation reads them.
- Snapshots: a delete, including a token delete, always takes one. Dry runs never write.
- Session id: a version 3 UUID.
- The mode default is `bridge`. Query tokens are off outside bridge mode.
- `laggedCount` is gone. `laggedTruncated` remains and appears only when the lag read was cut short.
- `mcp-token-max-age` defaults to 90 days.
- Metrics and refusals: `penpot_mcp_refusals_total` is new.
- New error codes: `mcp-backend-disabled`, `mcp-disabled`, `mcp-file-busy`, `mcp-time-budget-exceeded`,
  `mcp-too-many-batches`, `mcp-revn-conflict`, `mcp-invalid-pattern`, `mcp-raw-changes-disabled`, `mcp-compile-failed`.
- The adapter caps replies at 100 kB, drops `nextCursor` on a cut reply (`find_connectors` and `lint_page` page by
  `offset` instead), sends `requestId` on every write, and
  surfaces `alreadyApplied`. It limits request bodies before and after authentication.
- The adapter has health, readiness and metrics endpoints, and the `describe_operations` tool.
- Export caps: 256 kB for inline SVG and PDF, 16 million pixels for raster output, the `overwrite` flag, and the export
  and import roots.
- `execute_code`: 3 s CPU budget, one running script per token, `requestId` on every call, a snapshot option, 256 kB
  caps on text, and an error that names the committed chunks.

### Round 2

- Write batches hold at most 2000 compiled changes of any kind. The 300-object-creation rule is gone.
- An operation is never split across batches. An operation over 2000 changes gets a batch of its own.
- The layout reflow goes in the last batch, or in batches of its own when it would cross the bound.
- A call takes at most 50 batches (`mcp-too-many-batches`). The limit was 100.
- The replay key includes a SHA-256 digest of the payload. A reused request id with another payload is a new write.
- The failure field `revn-before-call` replaces `last-committed-revn`.
- `mcp-file-busy` is the file lock wait. `mcp-lock-timeout` is any other lock wait of a write. Both are 409.
- `conflict` answers HTTP 409. The reply drops `state`, `path` and `context`.
- MCP writes load libraries through a loader bound to the file and its libraries. The editor save keeps its lazy
  loader, which reads the file first and the libraries on a miss.
- One MCP token per OAuth client. Migration `0158` adds `client_id` and `client_name`. Re-approval replaces the
  client's token. A profile holds at most 20 client tokens.
- The settings page lists client tokens with `get-access-tokens` and revokes one with `delete-access-token`.
- `get-access-tokens` returns the secret only for the hand-made MCP token.
- An OAuth approval replaces the client's token with exactly the approved scopes. It no longer adds scopes to the
  profile's token.
- The consent page shows the requested scopes, with `mcp:read` implied.
- `mcp-enabled` set to `false` refuses every MCP-token call except `send-mcp-feedback`. The check is in `rpc.clj`.
- The file-media routes of `/assets` serve a render session only the media of its files. `/assets/by-id/` is not
  limited that way.
- New op `set_path_content {page-id, id, content}`.
- `props` refuses `layout-gap*`, `layout-padding*` and `layout-item-*` keys. It allows `hide-in-viewer`.
- `move_shapes` refuses a move into its own subtree, into or out of a component copy, under a non-container parent,
  and a nest of a component in its own main. Each refusal is `mcp-invalid-operation`.
- `execute_code` runs each guest in a worker thread. `PENPOT_MCP_SANDBOX_WORKERS` defaults to `true`.
- `execute_code` storage is kept per MCP token, JSON only, capped at 8 MB.
- The session cap `PENPOT_MCP_SANDBOX_MAX_SESSIONS` defaults to 20.
- The facade's `layoutItem*` setters emit `set_layout_child`, and `path.content` emits `set_path_content`.
- `/metrics` answers without a token only to a loopback client with no forwarding header.
- The published package ships `pnpm-lock.dist.yaml` and no tests.
- `contractVersion` stays at 1. Additions are compatible.

### Round 3

Compatible additions and fixes. `contractVersion` stays at 1.

- `set_path_content` takes the origin from the path's `selrect` and keeps the shape's transform. It no longer uses `x`
  and `y`.
- `create_path` writes no `x`, `y`, `width` or `height`. `x` and `y`, when given, move the content. `width` and
  `height` are not read.
- `set_flex_layout` and `set_grid_layout` merge the `layout-padding` sides, as they merge `layout-gap`. Other layout
  attrs left out reset to their initial values.
- Parent refusals are listed in section 3.6: a variant container, a component copy, and an instance inside its own
  component.
- `clone_shape` without `parent-id` refuses a source inside a component copy. Give a `parent-id` outside the copy.
- The eleven `app.common.mcp.operations.*` namespaces are internal (`:no-doc`). The public API is
  `app.common.mcp.operations`.
- The MCP-off check runs after the backend switch and the token-type rules (section 1.2). Section 1.8 covers the
  token transport: `Bearer` from the agent to the adapter, `Token` from the adapter to the backend.
- `get_tokens` takes `setId` and `format` (section 4.2). The server build has two entries (section 4.7).

### Round 4 (Avalonia test run)

Compatible additions. `contractVersion` stays at 1.

- Six read commands, all `mcp:read` and MCP-only: `get-mcp-subtree` (section 2.8a), `get-mcp-interactions` (2.8b),
  `find-mcp-connectors` (2.8c), `get-mcp-fonts` (2.8d), `get-mcp-page-lint` (2.8e) and `find-mcp-similar-boards`
  (2.8f). Their adapter tools are `export_subtree`, `get_interactions`, `find_connectors`, `list_fonts`, `lint_page`
  and `find_similar_boards` (section 4.2).
- `get-mcp-file-outline` adds `warnings`, one `font-unresolved` entry for each unresolved font on each page (section 2.3).
- `execute_code` takes `rootIds`, which loads only the subtrees of those shapes, and it reports a `partial-page`
  warning (section 4.4).
- `export_shape` takes `shapeIds`, `outputDir`, `renderer` and `refresh`. Exports run in batches, retry a 5xx once, keep
  a render cache, and report unresolved fonts (section 4.5). A `shapeId: "page"` export uses the same batch path.
- `export_subtree` writes a whole subtree to a JSON file in windows (sections 4.2 and 4.3). An inline reply holds as many
  windows as fit its own cap, never lacks a cursor while shapes remain, and returns a single shape above the cap alone,
  cut, listed in `oversize`. It takes `compact` and `encoding`. `get-mcp-subtree` takes `max-json-bytes` and `compact`.
- Two adapter settings: `PENPOT_MCP_EXPORT_BATCH_SIZE` and `PENPOT_MCP_EXPORT_CACHE_MB` (section 4.6).
- The six reads of sections 2.8a to 2.8f use the `:mcp-read` bucket of `rlimit.edn`, like the other reads.
- Board attribute `overflow-scroll` (JSON `overflowScroll`): `none`, `horizontal`, `vertical` or `both`; absent means
  `none`. It is a board prop of `create_board` and `update_shape` (section 3.5). The reads return it, the plugin API
  and `execute_code` read and write it, and `lint_page` uses it for `scroll-hidden-control`. The viewer does not act on it.
- Section 2.10 now documents the `:mcp-apply/by-team` limit and the `find` limiter of the four scan commands. It also
  corrects the figure of the `:mcp-write` bucket, which `rlimit.edn` has always set to `600/300/1m`.
- Connectors: `find-mcp-connectors` takes `within-id`, and the screen selection of `lint_page` (`depth`, `mode`,
  `boardNameRegex`). Frames use the true bounding box of their points. Candidates are taken shallowest first, and
  boolean children, hidden shapes and shapes under a hidden ancestor are skipped. A group of 2 to 6 drawing shapes with
  a long thin box is one candidate (`composed`). The cap rule applies to open paths only; an outline gets its direction
  from the head tips of the flattened outline, with a `confidence`. Each end reports its screen, or `nonScreen`.
  Connectors inside one screen are dropped and counted (`includeSameScreen` returns them). `length` is the straight
  distance between the ends. A shape inside a frame that holds no frame is skipped.
- Interactions: flows sort by name, then id. `overlayPosition` comes as `{x, y}`.
- Fonts and the outline: font usage has its own cache per page. The outline computes its warnings under a one-second
  budget, and it does not scan a page of more than 5,000 shapes unless that usage is cached. The outline adds
  `warningsComplete` and `warningsTruncated` (at most 50 warnings). `get-mcp-fonts` returns at most 500 fonts and stays
  within the reply budget. Runs of one face merge under the font's own variant id, and an empty text leaf is not a run.
  Resolution is read on every call.
- Lint: boxes are the true bounding boxes of the points. The scroll rule works from the model in section 2.8e. A control
  is reported once, under its innermost selected board. With `rules`, the first asked rule that applies is reported.
  `counts` are totals over all findings.
- Similar boards: size-ratio pruning, a deadline check every 256 compared pairs, and the result field `compared`.
- Execute code: partial loads keep the ancestors as stubs, and the refusals of section 4.4 cover ungroup, flatten and
  `addFlexLayout`. A root removed by the script is dropped at the next refresh. A deep subtree loads past depth 20.
- Export: the cache key includes the page id, and a render is cached as soon as it arrives, whatever its fonts. The font
  check is separate and only makes the notice. Batch ZIPs have their own size cap and CRC-checked entries. The
  exporter refusal is recorded only when every shape of its chunk then renders. A breaker stops a failure that keeps
  coming back. Ids are lower-cased. Writes go through a temporary file.
- Metrics: the gauge `penpot_mcp_export_permits_held{gate}` is new, and the busy counter is described in section 4.7.
- Board attribute `overflow-scroll` (`overflowScroll`), described in section 3.5.

## 8. Audit matrix

This section says what each MCP command writes to the audit log, and whether the request id is in it. Read it with
section 5.4 of `docs/technical-guide/mcp-production.md`. Every statement points at code. The rules come first.

### 8.1 How an event is written

- Every command runs through the audit wrapper (`rpc.clj`, `wrap-audit`). Commands marked `::audit/skip true` are not
  wrapped. The wrapper submits an event only when the command returns. A command that throws writes no event.
- The event name is `::audit/name` when the result sets it. Otherwise it is the command name.
- The props are `::replace-props` when the result sets them. Otherwise they are the command params, without the
  qualified keys, merged with the props the command adds (`loggers/audit.clj`, `prepare-rpc-event` and `clean-props`).
- The context holds `request-id` for every event (`loggers/audit.clj`, `prepare-rpc-event`).
- Rows reach `audit_log` only when the `audit-log` flag is on. Webhook events are sent only when the `webhooks` flag
  is on and the command marks `::webhooks/event? true` (`loggers/audit.clj`, `process-event`).
- A refusal before the command runs writes no event. It writes a log line `mcp refused` with the reason, the command,
  the token fingerprint and the request id, and it counts in `penpot_mcp_refusals_total` (`rpc.clj`, `note-refusal!`).
- The `mcp-tool` log line and the tool timing and error metrics come only from the fourteen read commands that call
  `run-tool` and from the three write commands (`rpc/commands/mcp.clj`, `mcp_write.clj`).

### 8.2 The commands

"Context" means `context.request-id`. "Props" means `props.request-id`. "Webhook" means a webhook event on success.

| Command | Scope | Event name on success | Props | Request id | Webhook | Notes |
|---|---|---|---|---|---|---|
| `mcp-whoami`, `get-mcp-file-outline`, `get-mcp-page-tree`, `get-mcp-shapes`, `find-mcp-shapes`, `get-mcp-library`, `get-mcp-tokens`, `create-mcp-render-session` | read | The command name | `tool`, `file-id`, `page-ids`, `change-count` (0), `change-types` ({}), `revn-before`, `revn-after`, `token-id`, `duration-ms`, `request-id` (from `audit-props` in `mcp.clj`). Nil values are dropped. | Context and props | No | Through `run-tool`: one `mcp-tool` line and timing metrics. A failed call has the line and the error metric, and no event. |
| `get-mcp-subtree`, `get-mcp-interactions`, `find-mcp-connectors`, `get-mcp-fonts`, `get-mcp-page-lint`, `find-mcp-similar-boards` | read | The command name | As the row above: `tool`, `file-id`, `page-ids`, `change-count` (0), `change-types` ({}), `revn-before`, `revn-after`, `token-id`, `duration-ms`, `request-id`. Nil values are dropped. | Context and props | No | Through `run-tool`, so each has an `mcp-tool` line and timing metrics. Round 4 additions (section 7). |
| `get-teams`, `get-projects`, `get-project-files`, `search-files`, `get-team-shared-files`, `get-team-recent-files`, `get-team-deleted-files`, `get-file-snapshots`, `get-comment-threads`, `get-comments` | read | The command name | The params without qualified keys, for example `team-id`, `project-id`, `file-id` | Context only | No | Not through `run-tool`: no `mcp-tool` line and no tool metric. **Gap G3.** |
| `send-mcp-feedback` | read (bridge) | `send-mcp-feedback` | None. The command sets empty props (`feedback.clj`). | Context | No | The subject and the text are not logged, by design. |
| `mcp-apply-changes`, `mcp-apply-operations`, `mcp-import-svg`, committed | write | `update-file` | `tool`, `file-id`, `id`, `name`, `features`, `project-id`, `team-id`, `page-ids`, `change-count`, `change-types`, `revn-before`, `revn-after`, `revn`, `modified-at`, `snapshot-id` (when a snapshot was taken), `token-id`, `request-id`, `duration-ms` | Props and context | Yes, batched per file for two minutes | The name is the same as an editor save. Filter on `props.tool`. **Gap G4.** |
| The same three, dry run | write (read scope) | The command name | As above, without a new `modified-at` | Props and context | No | No change is written. **Gap G4.** |
| The same three, replay (`alreadyApplied`) | write | The command name | As above, with the revn of the file | Props and context | No | Nothing is written. The counts come from the earlier change rows, and the reply data from the first row. |
| The same three, failed | write | None | None | Log line only | No | The `mcp-tool` line has `outcome=error`. The error counter has the code. **Gap G1.** |
| `upload-file-media-object` | write | The command name | `name`, `file-id`, `team-id`, `is-local`, `size`, `mtype` (`media.clj`). No content. | Context | No | |
| `create-file-media-object-from-url` | write | The command name | `name`, `file-id`, `is-local`, `mtype` (`media.clj`) | Context | No | |
| `create-comment-thread`, `create-comment` | write | The command name | The params, plus the thread or comment row and `team-id` (`comments.clj`) | Context | Yes | |
| `update-comment-thread`, `update-comment-thread-position`, `delete-comment-thread`, `delete-comment` | write, delete | The command name | The params | Context | No | |
| `create-file-snapshot`, `update-file-snapshot`, `lock-file-snapshot`, `unlock-file-snapshot`, `restore-file-snapshot`, `delete-file-snapshot` | write, delete | The command name | The params | Context | No | |
| `create-team`, `update-team`, `restore-deleted-team-files` | manage | The command name | The params | Context | No | |
| `create-project`, `rename-project`, `update-project-pin`, `create-file`, `rename-file`, `set-file-shared`, `duplicate-file`, `duplicate-project`, `move-files`, `move-project`, `link-file-to-library`, `unlink-file-from-library` | manage | The command name | The params, plus the row props the command sets | Context | Yes. `update-project-pin` is batched for 5 s. | |
| `import-binfile` | manage | `import-binfile`, written by the command itself (`binfile.clj`). The wrapper is skipped. | The params without `file`, plus `generated-by`, `referer`, `file-ids`, `file-count` and `status` (`completed` or `failed`). Each new file also gets a `create-file` event. | Context | Yes | Records a failed import as `status: failed`. The one exception to Gap G1. |
| `delete-project`, `delete-file` | delete | The command name | The params, plus the row props the command sets | Context | Yes | |
| `update-mcp-token-scopes` | session only | The command name | The params | Context | No | Not reachable with an MCP token. |

Commands that run only in the adapter, with no backend command (`contract` section 4.2): `describe_operations`,
`penpot_api_info`, `high_level_overview`. `submit_feedback` calls `send-mcp-feedback`.

### 8.3 Gaps

- **G1. Failed calls write no event.** Only the `mcp-tool` line and the error counter record them. The exception is
  `import-binfile`, which records `status: failed`.
- **G2. Refused calls write no event.** Token, scope, profile, flag and RPC rate-limit refusals stop before the command
  runs. The backend logs `mcp refused` and counts `penpot_mcp_refusals_total`.
- **G3. Opt-in commands have no tool line and no tool metric.** The reads and writes that are not in `run-tool` or
  `write-command` write no `mcp-tool` line and no `penpot_mcp_tool_*` sample. Their request id is in the event context
  only, so a request id search must check the audit table.
- **G4. MCP writes share the editor's event name.** A committed MCP write is `update-file`. A dry run and a replay are
  named after the command and send no webhook. Filter on `props.tool` to find MCP writes.
- **G5. Adapter actions leave no backend event.** The adapter writes export files to its disk, reads import files, runs
  sandbox scripts and keeps sandbox `storage`, and refuses calls at its own rate limit. These appear only in the
  adapter log (`mcp/packages/server`, `PENPOT_MCP_LOG_DIR`).
- **G6. Renders by the exporter are not linked to the MCP call.** The exporter reads the file with the restricted
  render session. Each of its reads is a command, and the wrapper gives it an event unless the command skips audit.
  I did not check each read command. Whether the exporter sends the request id is not confirmed in the code.
- **G7. The feedback event holds no text, by design.** It names the sender and nothing else (`feedback.clj`).
