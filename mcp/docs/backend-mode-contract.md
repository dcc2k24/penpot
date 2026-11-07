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
| `mcp:read` | MCP only | `mcp-whoami`, `get-mcp-file-outline`, `get-mcp-page-tree`, `get-mcp-shapes`, `find-mcp-shapes`, `get-mcp-library`, `get-mcp-tokens`, `create-mcp-render-session`, `send-mcp-feedback` |
| `mcp:write` | opt-in | `upload-file-media-object`, `create-file-media-object-from-url`, `create-comment-thread`, `update-comment-thread` (resolve or reopen), `create-comment`, `update-comment-thread-position`, `create-file-snapshot`, `update-file-snapshot`, `lock-file-snapshot`, `unlock-file-snapshot` |
| `mcp:write` | MCP only | `mcp-apply-changes`, `mcp-apply-operations`, `mcp-import-svg`. Their scope is `mcp:read` when `dryRun` is true, else `mcp:write`. |
| `mcp:manage` | opt-in | `create-team`, `update-team`, `create-project`, `rename-project`, `update-project-pin`, `create-file`, `rename-file`, `set-file-shared`, `duplicate-file`, `duplicate-project`, `move-files`, `move-project`, `link-file-to-library`, `unlink-file-from-library`, `restore-deleted-team-files`, `import-binfile` |
| `mcp:delete` | opt-in | `delete-project`, `delete-file`, `restore-file-snapshot`, `delete-file-snapshot`, `delete-comment-thread`, `delete-comment` |

That is 54 commands: 42 opt-in and 12 MCP only.

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
 components: n, deletedComponents: n, colors: n, typographies: n, media: n,
 tokens: {sets: n, themes: n, tokens: n, activeThemes: [..], activeSets: [..]} | null,
 pointerMap: bool}
```

- `shapeCount` is the shape count of the page, the root excluded.
- Page summaries are cached in an LRU keyed by the page pointer id (or by file, vern, page and revn for a plain
  page). The cache holds up to 4096 entries for 10 minutes.

### 2.4 `get-mcp-page-tree` (read)

Params `{file-id, page-id, root-id?, depth? (default 3, 1 to 20), fields? [name], limit? (default 500, 1 to 5000),
cursor?}`.

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
- Result: `{revn, pageId, root: node, truncated, nextCursor?}`.

### 2.5 `get-mcp-shapes` (read)

Params `{file-id, page-id, ids: [uuid] (1 to 200), fields?, include-children? (default false)}`. Result
`{revn, shapes: [shape-map...], missing: [ids], truncated}`.

- `fields` takes names from the shape attributes. `content` and `position-data` come back only when named.
- Without `fields` a shape map carries every attribute except `thumbnail`, `content` and `position-data`.
- With `include-children`, the descendants come with the requested shapes. At most 2000 shapes come back in all.
  The page root cannot be requested with its children (`mcp-root-children-not-allowed`, HTTP 400).
- The reply stops at about 1,000,000 characters of encoded shapes. Then `truncated` is true. Ask again for the ids
  that are missing from the reply.
- Text shapes carry `characters` (plain text of `:content`) and `textLayoutState`. They carry
  `textSizeApproximate: true` when their box is an estimate (grow type `auto-width` or `auto-height`, and no
  `:position-data`).

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
colors? [string] (at most 50), limit? (default 100, 1 to 1000)}`.

- `type` takes one of `frame group bool rect path text circle svg-raw image`.
- Searches one page, or every page when `page-id` is absent, one page after the other. The whole search has a
  5 s budget. `truncated: true` when the budget or the limit stops the search.
- `name` is an exact, case-sensitive match on the shape name.
- `name-regex` is a Java regular expression, at most 200 characters, searched in the shape name (`re-find`). An
  invalid expression answers `mcp-invalid-regex` (HTTP 400). A pattern that runs too deep answers
  `mcp-invalid-pattern` (HTTP 400).
- `text-contains` matches the characters of text shapes, ignoring case. `has-token` matches shapes with at least one
  applied token (`true`), or none (`false`). `colors` matches fill and stroke colors and the colors of local library
  references.
- Result `{matches: [{id, pageId, name, type, path: "Board / Group / Shape"}], truncated}`. The path skips the page
  root and stops after 1000 ancestors.
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
| rlimit `:mcp-read` | reads: `mcp-whoami`, `get-mcp-*`, `find-mcp-shapes`, `create-mcp-render-session` | 1200 calls per bucket, refill 600 per minute (`1200/600/1m`) |
| rlimit `:mcp-write` | `mcp-apply-changes`, `mcp-apply-operations`, `mcp-import-svg` | 120 calls per bucket, refill 60 per minute (`120/60/1m`) |
| rlimit `:access-token` | `update-mcp-token-scopes` | 60 per bucket, refill 30 per minute |
| climit `:mcp-read/by-profile` | reads | 4 permits, queue 20, timeout 30 s |
| climit `:mcp-read/global` | reads | 8 permits, queue 64, timeout 30 s |
| climit `:mcp-find/by-file` | `find-mcp-shapes` | 2 permits per file, queue 10, timeout 30 s |
| climit `:mcp-apply/by-profile` | writes | 1 permit, queue 5, timeout 60 s |
| climit `:mcp-apply/global` | writes | 6 permits, queue 50, timeout 60 s |
| climit `:mcp-update-file/by-profile` | writes: its own permit, so an agent write does not hold the owner's file-save permit | 1 permit, queue 5, timeout 60 s |

The write limiters are taken in the order `mcp-apply/by-profile`, `mcp-apply/global`, `mcp-update-file/by-profile`.

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
  call has more than 100 changes or operations, or when `snapshot` is true. `snapshot: false` turns off only the
  "more than 100" trigger. The snapshots of the file with an `mcp/` label are pruned to the 20 newest. A snapshot
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
empty `warnings` list. The window lasts while those change rows exist. The code comment says about one hour. The
garbage collector sets the exact time. A dry run skips the check.

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
dryRun, snapshotId?, laggedTruncated?}`.

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
| `rate-limit`, `concurrency-limit` | 429 | |
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
- geometry: `selrect`, `points`, `transform`, `transform-inverse` (`update_shape`); `position-data` (`set_text`,
  `set_text_style`)
- layout: `layout`, `layout-gap`, `layout-gap-type`, `layout-gap-col`, `layout-gap-row`, `layout-padding`,
  `layout-padding-type` (`set_flex_layout` or `set_grid_layout`); `layout-grid-rows`, `layout-grid-columns`
  (`set_grid_layout`); `layout-grid-cells` (`set_grid_cell`); every `layout-item-*` key (`set_layout_child`)
- content and state: `content` (`set_text`, `set_text_style`, `create_svg_raw`); `bool-type` (`create_boolean`);
  `metadata` (`create_image`); `interactions` (`add_interaction`, `remove_interaction`); `plugin-data`
  (`set_plugin_data`); `variant-id`, `variant-name`, `variant-error`, `is-variant-container` (the component ops)

`layout-gap*`, `layout-padding*` and `layout-item-*` keys are refused in `props` on purpose. Use `set_flex_layout`,
`set_grid_layout` or `set_layout_child` for them. `hide-in-viewer` is allowed on every type.

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
`get_shapes`, `find_shapes`, `get_library`, `get_tokens`, `apply_operations`, `apply_raw_changes`,
`batch_create_shapes`, `manage_files`, `manage_versions`, `comments`, `import_image`, `import_svg`,
`import_archive`, `export_shape`, `execute_code`, `describe_operations`.

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
| `get_file_outline {fileId}` | `get-mcp-file-outline` |
| `get_page_tree {fileId, pageId, rootId?, depth?, fields?, limit?, cursor?}` | `get-mcp-page-tree`. `limit` defaults to 100 (1 to 5000). Layout children come in visual order. |
| `get_shapes {fileId, pageId, ids, fields?, includeChildren?}` | `get-mcp-shapes`. Without `fields` the tool sends: `id name type parentId x y width height hidden shapes`. |
| `find_shapes {...}` | `find-mcp-shapes`. `limit` defaults to 100 (1 to 1000). Type `ellipse` or `board` is sent as `circle` or `frame`. Matches show `ellipse` and `frame`. |
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
| `export_shape {fileId, pageId, shapeId or "page", format, scale?, mode, filePath?, overwrite?}` | section 4.5 |
| `execute_code {code, fileId, pageId?, snapshot?, baseRevn?, failOnConflict?, allowSplit?, requestId?}` | section 4.4 |

### 4.3 Replies, writes and errors

- Every tool reply is compact JSON text, unless it carries images. `export_shape` returns image blocks.
- A reply above the response cap of 100 kB (`PENPOT_MCP_MAX_TOOL_RESPONSE_KB`) is cut. The cut reply says
  `truncated`, keeps the first items of each array (the same count for every array), and names the arrays it cut.
  Its `nextCursor`, if any, is dropped, because it would skip the cut items. The note tells the caller to repeat the
  call with a smaller limit.
- Every write sends a `requestId`. The caller may name it. Otherwise the adapter makes a UUID for the call. A retry
  of the same write must reuse the `requestId`. The same id with another payload is a new write on the backend. A repeat that the backend already applied returns `alreadyApplied:
  true` and a note that nothing changed. The idempotency window is set by the backend (section 2.11).
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
- calls that run at once: 4 (`PENPOT_MCP_SANDBOX_MAX_CONCURRENT`), with a 60 s wait for a slot
- one running script per token. Up to 2 more calls of the same token may wait in a short queue.
- the log, the result and the error text are each capped at 256 kB
- `storage` (the script's own data) is kept per MCP token, across files. It holds JSON values only: a cycle or a
  function is lost on save. Its saved JSON is capped at 8 MB. A larger save keeps the last copy that fit and adds a
  note to the reply.

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
- `filePath` writes the file inside the export root, `PENPOT_MCP_EXPORT_DIR`, which defaults to `penpot-exports` in the
  home directory. A file is not replaced unless `overwrite` is true. The path must end in the format's extension.
- `shapeId: "page"` exports the first 10 root shapes of the page, in page order, one call of the exporter per shape.
  The total image output stays under 8 MB. The reply says how many were rendered, and that the rest must be exported
  by id. `filePath` is refused with `shapeId: "page"`: export one shape by id to save it to a file.
- Concurrency: each token gets one render at a time. The whole process runs at most 4 renders against the backend at a
  time (`PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS`; 0 means no limit). A render waits at most 60 s.
- The render session cookie is taken from `create-mcp-render-session` (section 2.9).

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
| `PENPOT_MCP_ALLOW_QUERY_TOKEN` | `true` in bridge mode, `false` otherwise | Accepts `?userToken=`. When `true`, a warning is logged once per token. |
| `PENPOT_MCP_MAX_BODY_MB` | `32` | Request body limit after authentication. Before it, the limit is 4 MB. |
| `PENPOT_MCP_MAX_TOOL_RESPONSE_KB` | `100` | Cap on a tool reply (1 to 10000) |
| `PENPOT_MCP_EXPORT_DIR` | `~/penpot-exports` | Export root for `export_shape` `filePath` |
| `PENPOT_MCP_IMPORT_DIR` | `~/penpot-imports` | Import root for `filePath` arguments |
| `PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS` | `4` | Renders at once against the backend; 0 means no limit |
| `PENPOT_MCP_SANDBOX_TIMEOUT_S` | `3` | Guest CPU time of one `execute_code` call |
| `PENPOT_MCP_SANDBOX_WALL_S` | `120` | Wall-clock limit of one call |
| `PENPOT_MCP_SANDBOX_IDLE_MIN` | `30` | Idle minutes before a session sandbox is evicted |
| `PENPOT_MCP_SANDBOX_MAX_HOST_CALLS` | `1000` | Host primitive calls per script |
| `PENPOT_MCP_SANDBOX_MAX_SESSIONS` | `20` | Live sandbox runtimes |
| `PENPOT_MCP_SANDBOX_MAX_CONCURRENT` | `4` | Calls that run at once |
| `PENPOT_MCP_SANDBOX_WORKERS` | `true` | Runs each guest in a worker thread. `false` or `0` runs it on the main thread. Any other value that is not true or false stops the start. |
| `PENPOT_MCP_SERVER_HOST` | `localhost` | Listen host |
| `PENPOT_MCP_SERVER_PORT` | `4401` | Listen port |
| `PENPOT_MCP_WEBSOCKET_PORT` | `4402` | Plugin bridge port (bridge mode) |
| `PENPOT_MCP_TOOL_TIMEOUT_S` | `120` | Plugin bridge tool timeout (bridge mode) |
| `PENPOT_MCP_REDIS_URI` | unset | Redis for the bridge |
| `PENPOT_MCP_REMOTE_MODE` | unset | `true` enables remote mode |
| `PENPOT_MCP_REPL_ENABLE` | unset | `true` or `false` sets whether the REPL starts. When unset, the REPL starts only if `PENPOT_MCP_DEVENV` is `true`, in single-user mode. |
| `PENPOT_MCP_REPL_HOST` / `PENPOT_MCP_REPL_PORT` | `localhost` / `4403` | REPL listen address |
| `PENPOT_MCP_DEVENV` | unset | `true` starts the REPL, unless `PENPOT_MCP_REPL_ENABLE` says otherwise |
| `PENPOT_MCP_LOG_LEVEL` | `info` | Log level |
| `PENPOT_MCP_LOG_DIR` | unset | Log directory. Logging to a file is on only when it is set. |

### 4.7 Health, metrics and contract check

- `GET /healthz` answers that the adapter is up.
- `GET /readyz` answers whether the backend can serve calls. It exists when a backend is configured.
- `GET /metrics` serves the adapter's Prometheus metrics: tool call counts and timings, and the sandbox counters. It
  answers without a token only to a client on this machine. The adapter must bind a loopback host, and the request
  must carry no forwarding header (`X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP` or `Forwarded`). Any other
  request needs a valid token.
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
- Replays: a repeat of a committed request id answers `alreadyApplied`, and writes nothing.
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
- The adapter caps replies at 100 kB, drops `nextCursor` on a cut reply, sends `requestId` on every write, and
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
