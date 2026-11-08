# Penpot backend mode

You work on Penpot files through the Penpot backend. The server reads and writes the file in the database, so no
browser tab must be open. Changes reach open tabs live.

Every tool takes explicit ids. Nothing is selected for you and nothing is remembered between calls.

## Discovery flow

Follow these steps in order. Each step gives the id that the next step needs.

1. `whoami`: shows the profile and the scopes of the token. Scopes are `mcp:read`, `mcp:write`, `mcp:manage` and
   `mcp:delete`. A call that needs a missing scope fails with the scope it needs.
2. `list_teams`: returns team ids.
3. `list_projects` with `teamId`: returns project ids.
4. `list_files` with `projectId`, or with `teamId` and `query`: returns file ids.
5. `get_file_outline` with `fileId`: returns page ids and the revision (`revn`). Keep the revision for writes.
6. `get_page_tree` with `fileId` and `pageId`: returns shape ids, types and geometry. Use `depth`, `fields` and `limit`
   to keep answers small. Pass `cursor` to read the next part of a truncated answer.
7. `get_shapes` with `fileId`, `pageId` and up to 200 `ids`: returns the attributes that `fields` names. Without `fields` it returns a short set: `id`, `name`, `type`, `parentId`, `x`, `y`, `width`, `height`, `hidden` and `shapes`.
   In both tools `x` and `y` are the top-left corner of the box around the shape's points, and `width` and `height`
   its size before rotation, as the plugin API gives them; `rotation` comes apart. `get_shapes` fills `hidden: false`,
   `blocked: false`, `opacity: 1`, stroke `strokeAlignment: "center"` and layout `layoutItemHSizing`/
   `layoutItemVSizing: "fix"` when the shape stores none. A text with `textSizeApproximate: true` has an estimated
   box (see "Text sizes").
8. `find_shapes`, `get_library` and `get_tokens`: search by name, type, component, text or color, and read the library
   and design tokens. `get_tokens` takes an optional `setId` to read one token set, and `format`: `tokens` (the default:
   sets, themes and tokens) or `dtcg` (the DTCG export instead). It returns only one of the two.

Write with `apply_operations`. Its operations use ids from the steps above.

## Ids and handles

- Every id is a UUID. Copy ids from a response. Do not invent them.
- A create operation can set `id` to a handle such as `$tmp:card`. Later operations in the same call then use
  `$tmp:card` wherever they need the shape id, for example as `parentId`.
- The response to a write maps each handle to the UUID that Penpot created in `createdIds`.
- `create_component` takes `id` as a handle too. Later operations in the same call can use it.
- Handles last for one call only. A later call needs the UUIDs.

## Writing with apply_operations

Operation parameters are camelCase. Coordinates are absolute page coordinates. Colors are hex strings.

Use `create_ellipse` for an ellipse. Results from `get_shapes`, `get_page_tree` and `find_shapes` call it `ellipse`, and
`find_shapes` also accepts `circle` as a type.

Use `create_board` for a board. Results call a board `frame`, and `find_shapes` accepts `board` as a type too. A board
and a frame are the same type.

`create_token` and `update_token` take the token type in Penpot form (`color`, `border-radius`, `font-size`) or in DTCG
form (`borderRadius`, `fontSize`, `boxShadow`, and so on). An unknown type fails.

Example 1: a board with a rectangle inside it, in one call.

```json
[
  {"op": "create_board", "pageId": "P", "id": "$tmp:card", "x": 0, "y": 0, "width": 320, "height": 200, "name": "Card"},
  {"op": "create_rect", "pageId": "P", "id": "$tmp:bg", "parentId": "$tmp:card", "x": 16, "y": 16,
   "width": 288, "height": 168, "props": {"fills": [{"fillColor": "#f5f5f5", "fillOpacity": 1}], "r1": 8, "r2": 8, "r3": 8, "r4": 8}}
]
```

Example 2: text. Set the characters on creation, or change them later with `set_text`. `fontFamily` takes the
family name of the font. Penpot's built-in Source Sans Pro has the family `sourcesanspro`. `create_text` also takes `fontId`, `fontVariantId`, `fontWeight` and `fontStyle`. The three variant fields must agree. For `sourcesanspro` the variant ids are `200`, `200italic`, `300`, `300italic`, `regular`, `italic`, `600`, `600italic`, `bold`, `bolditalic`, `black` and `blackitalic`. A weight and style pair maps to one of them, so `fontWeight` 700 with `fontStyle` `normal` gives `bold`.

```json
[{"op": "create_text", "pageId": "P", "parentId": "$tmp:card", "x": 32, "y": 32, "width": 200, "height": 24,
  "characters": "Hello", "fontSize": "18", "fontFamily": "sourcesanspro"}]
```

Example 3: move shapes into another parent, in a given order.

```json
[{"op": "move_shapes", "pageId": "P", "ids": ["S1", "S2"], "parentId": "B1", "index": 0}]
```

Example 4: change the properties of a shape. Only the given keys change.

```json
[{"op": "update_shape", "pageId": "P", "id": "S1", "props": {"opacity": 0.5, "hidden": false}}]
```

`props` refuses the layout-item keys, the gap keys and the padding keys (`layout-gap`, `layout-padding` and their variants). Use `set_layout_child` for a child's layout item, and `set_flex_layout` or `set_grid_layout` for gap and padding.

Example 5: delete shapes.

```json
[{"op": "delete_shapes", "pageId": "P", "ids": ["S3"]}]
```

Example 6: group existing shapes.

```json
[{"op": "create_group", "pageId": "P", "id": "$tmp:grp", "name": "Icons", "childIds": ["S1", "S2"]}]
```

Example 7: put a flex layout on a board.

```json
[{"op": "set_flex_layout", "pageId": "P", "id": "B1", "layoutFlexDir": "row",
  "layoutGap": {"rowGap": 8, "columnGap": 8},
  "layoutPadding": {"p1": 16, "p2": 16, "p3": 16, "p4": 16}}]
```

Example 8: apply a design token to fills. Leave out `resolvedValue`: the server reads the token's value from the
active sets of the file, follows its references, and fails the call when the token is missing, sits only in an
inactive set, or has a reference cycle. A `resolvedValue` you pass is written as given, and the response adds a
`token-value-differs` warning when it is not the token's value. An `apply_token` that comes after an operation of the
same call that changes tokens, sets or themes must carry `resolvedValue`, or go in a later call.

```json
[{"op": "apply_token", "pageId": "P", "shapeIds": ["S1"], "tokenName": "color.brand", "attributes": ["fill"]}]
```

Example 9: a copy of a component with one label changed. A name in `overrides` must match exactly one shape inside the
copy.

```json
[{"op": "instantiate_component", "pageId": "P", "componentId": "C1", "id": "$tmp:btn", "x": 0, "y": 0,
  "overrides": [{"name": "Label", "characters": "Save"}]}]
```

Run a write with `dryRun: true` first. The response reports validation and the changes, and the file stays as it is.

## Child order in layouts

A flex or grid layout shows its children in visual order. Without `index`, a new child goes last. An `index` counts
visual places from the first child, so `index: 0` puts the child first. `reorder` takes the ids in visual order.
`get_page_tree` lists a layout's children in visual order too.

`set_flex_layout` on a board that already has children and no layout keeps their creation order as the visual order.
`remove_layout` does not undo that. `set_grid_layout` uses the creation order for the cells.

## Write options

Every write accepts these options:

- `dryRun`: validate and compute the result without saving. Needs only `mcp:read`.
- `baseRevn`: the revision you read. The response lists changes that happened since then, with the shape ids they
  touch.
- `failOnConflict`: with `baseRevn`, refuse the write when a change touches a shape that someone else changed since
  then.
- `snapshot`: take a version snapshot before the write. Deletions always take one.
- `allowSplit`: for `apply_operations` and `execute_code` only. Kept for older clients. A call above 2000 compiled changes is cut into batches of whole operations, each with at most 2000
  changes, even without this option. An operation that alone is larger gets a batch of its own. All batches commit in one
  transaction, so a failed call changes nothing.
- A call whose operations compile to more than 100000 changes fails before any write, with a hint. Split the work into
  several calls.
- `apply_operations` takes at most 2000 operations per call, and a call takes at most 50 batches. A call over either
  limit fails before any write, with `mcp-batch-too-large` or `mcp-too-many-batches`.

Each write returns the new `revn`. Use it as the `baseRevn` of the next write.

## Snapshots

Use `manage_versions` to list, create, pin, rename, restore and delete snapshots. Create a snapshot before a large
change. Restoring a snapshot replaces the current content of the file, so confirm with the user first.

## Scopes and limits

- Read tools need `mcp:read`. Write tools need `mcp:write`. File and team changes need `mcp:manage`. Deleting a file or
  project, and deleting a snapshot, need `mcp:delete`. Deleting shapes is a write.
- Team and file management (`manage_files`) and comments (`comments`) follow the same rules.
- Each token gets a rate limit: 10 requests per second by default, with bursts of 20. The server settings
  `PENPOT_MCP_RATE_LIMIT_RPS` and `PENPOT_MCP_RATE_LIMIT_BURST` change it. A refusal says how long to wait.
- Writes by one token to one file run one after another in each server process. Writes from other tokens wait for the
  file lock in the backend. A write that waits 15 s for the file lock fails with `mcp-file-busy`; one that waits 15 s for
  another lock fails with `mcp-lock-timeout`. Both are conflicts (HTTP 409) and nothing is applied, so retry the write
  with the same `requestId`. Several server processes do not share the per-token queue, so do not send one file's writes
  to two of them at once.
- A write that you retry must reuse its `requestId` with the same payload. The server answers `alreadyApplied: true` for
  a repeat of that write within about an hour, and then nothing changes. A reused `requestId` with another payload is a
  new write and is applied. A call without a `requestId` gets a new one, so a retry of it is applied again.
- A response larger than 100 kB (`PENPOT_MCP_MAX_TOOL_RESPONSE_KB`) is cut, and the text says so. It is cut at whole
  items, and a cut answer has no `nextCursor`: repeat the call with a smaller `limit`. Narrow the request instead.

## Text sizes

Penpot does not measure text on the server. Text created or edited through the backend gets an estimated size, and
its `textLayoutState` is `approximate`. The estimate uses about 0.6 em per character and 1.2 em per line. Open the
file in a browser to correct the layout.

## When to use execute_code

Use `execute_code` for loops, conditions and changes to many shapes at once. It is a normal tool for those, not a last
resort. Use the typed tools for one or two simple changes. In `both` mode the plugin version is named
`execute_code_in_tab` and needs an open Penpot tab.

## Importing and exporting

`import_image` adds an image. Pass the image as `base64`, `url` or `filePath`. Use `filePath` only if the server can read files. It uploads the image as a media object. By default, it also places an image shape on the page. If `pageId` is missing, it uses the first page. Give one of `width` or `height` to keep the aspect ratio. Set `createShape` to `false` to skip the shape. PNG, JPEG, GIF and WEBP work, up to 50 MB from a `url` or `filePath`. Inline `base64` is limited to 24 MB of base64 text, about 18 MB of image. A `filePath` must lie inside the import directory (`PENPOT_MCP_IMPORT_DIR`, `penpot-imports` in the home directory by default). It returns `mediaId`, `width`, `height` and `mtype`. With a shape, it also returns `shapeId` and `revn`.

`import_svg` converts SVG text into shapes. It does not upload embedded raster images. Import them with `import_image` first, then place them with `apply_operations` and `create_image`.

`import_archive` imports a `.penpot` archive as new files in a project and returns their `fileIds`. Run `list_files` to see them. The limit is 200 MB. Inline `base64` is limited by the request body cap (32 MB by default), so an archive above the cap must be given as `filePath` or `url`. `url` is downloaded by the server in local mode only. A `filePath` must lie inside the import directory (`PENPOT_MCP_IMPORT_DIR`, `penpot-imports` in the home directory by default).

`export_shape` renders one shape. Pass `"page"` as `shapeId` to render the root shapes of the page, in page order, one image
each. The tool renders the first 10 root shapes and says how many it left out, so export the others by id. The images
stop before their total passes 8 MB. A page export does not take `filePath`, does not render the page as one image, and
fails when the page has no shapes. The default format is PNG. Other formats are SVG, JPEG, WEBP and PDF. The default `scale` is 1. Set `mode` to `"fill"` for the raw image of a shape's fill. PNG, JPEG and WEBP come back as an image, up to 8 MB; use `filePath` for a larger one. SVG comes back as text. PDF comes back as JSON with `base64`, unless you pass `filePath`. With `filePath`, the tool returns JSON with `savedTo`, `bytes` and `format`. A `filePath` must lie inside the export directory (`PENPOT_MCP_EXPORT_DIR`, `penpot-exports` in the home directory by default), end in the format's extension, and not replace an existing file unless `overwrite` is true. SVG and PDF come back inline only up to 256 kB; use `filePath` for a larger one. A raster may have at most 16 million pixels: the shape box times `scale`. Exports need the exporter service at `PENPOT_MCP_EXPORTER_URI`. The server downloads the rendered file from the origin of the URI that the exporter answers with. Set `PENPOT_MCP_ASSETS_URI` to override that base URI, for example when nginx serves `/assets/by-id/`. An answer of 204 or with an `x-accel-redirect` header fails, and the error names `PENPOT_MCP_ASSETS_URI`.

Write tools accept `dryRun`, which checks a change without saving it.

## Other tools

- `comments`: list threads, read them, create a thread on a frame, reply, resolve or reopen, move and delete.
- `manage_files`: create, rename, move, duplicate, pin, share, delete and restore teams, projects and files, and link
  libraries.
- `apply_raw_changes`: raw Penpot change records. Use it only when `apply_operations` cannot express the change.
- `batch_create_shapes`: a nested tree of shapes, created in one write. It builds the operations for you.
- `describe_operations`: the parameters of up to 20 named `apply_operations` ops, as JSON Schema.

## execute_code in backend mode

`execute_code` runs a short JavaScript script on one file. Use it for loops, conditions and many shapes at once.
Use the typed tools for one or two simple changes.

- `fileId` names the file. Penpot calls use it, so the script does not name the file again.
- `pageId` sets `penpot.currentPage`. Leave it out to use the first page.
- Calls return values at once, so `await` is not needed. The sandbox removes an `await` in front of a call to `penpot`,
  `penpotUtils` or `penpotMgmt`, or in front of `.export(...)` or `.exportImage(...)`. Any other `await` fails. An
  async function fails.
- Writes collect in a batch. A flush sends the batch to the backend as one `mcp-apply-operations` call. A flush of more
  than 2000 operations takes several calls of 1500 operations each, sent one after another. No other write of this server to the file lands
  between them; an edit in an open Penpot tab still can. A flush runs at the end of the script and at each
  `penpot.waitForLayoutUpdate()`. A read after a write sees the change before the flush. The updates and the
  `appendChild` of a new board, rectangle or ellipse go into its create operation as the script queues them, so a
  grid of new shapes needs fewer operations. The limit of 5000 operations counts the operations after that.
- `file.validate()` checks the pending writes without saving them, in one dry-run call. It takes at most 2000 pending
  operations; above that it fails and asks you to check a smaller part of the script.
- `baseRevn`, `failOnConflict` and `allowSplit` go with every call of every flush. Unset `snapshot` leaves each call to
  the backend's rule. `true` takes one snapshot, on the first write of the script. `false` takes none. `baseRevn` is the revision you read: the first write of the script checks against it, and each later
  write checks against the script's own last write, so the script's own changes do not count as conflicts.
- `applyToken` sends the token name; the server fills the value from the active sets, as for `apply_operations`.
- Each operation is checked before a flush sends the batch. A bad operation stops the flush. The error gives the index
  of the operation, its op name and the field that is wrong.
- New shapes get temporary ids. `createdIds` in the response maps them to real ids.
- The `result` field holds the return value, as JSON. Console output appears in `console`, one line per entry. The result,
  the console and the error text are cut at 256 kB. Do not log values that you also return.
- A script that fails keeps only the writes flushed before the failure. Unflushed writes are lost. If a flush ran, the
  error also lists `opsApplied`, `flushes`, `chunks`, `revn` and `createdIds`. If a batch fails between its calls, the
  error names the call that failed and the operations that the earlier calls committed. Those calls stay applied.
- `storage` is an object for your own data. It keeps its data per MCP token, not per session. Calls with the same
  token share it, in any file. The sandbox drops the data after 30 minutes without a call from that token. The server
  keeps at most 20 such stores and drops the least recently used first. The saved copy is JSON text, capped at 8 MB: a
  larger storage is not saved, and the saved copy stays at its last size that fit. Values that JSON cannot hold, such as
  functions and cycles, last only while the sandbox worker lives. A server restart clears the stores. A fatal sandbox
  error or a runtime recycled for memory keeps the storage for the next call.
- Limits per call: 5000 operations, 20 pages loaded, 16 MB of page data, 1000 host calls, 20 exports and media
  uploads, 120 s of wall-clock time, 3 s of CPU time and 128 MB of memory. The sandbox stops a script with an
  out-of-memory error at 256 MB.
- The CPU limit leaves out the time that a script waits for the server. The wall-clock limit starts when the script
  starts to run.
- A host call is a `penpot`, `penpotUtils`, `penpotMgmt` or `rpc` call that reaches the server. It counts against the
  token's rate limit (10 per second, burst 20).
- One script runs at a time for each token, and two more of that token may wait. At most 20 scripts run at once, and a script may spend 30 s in backend and exporter calls before its next call fails. A script that waits more than 60 s for a free slot fails with a busy error.
- Not available: selection, viewport, `ui`, events, `openPage`, `openViewer`, `createImage`, `createVariantContainer`,
  variants, `generateMarkup`, `generateStyle`, `generateFontFaces`, `penpotMgmt.listDeletedProjects`, `penpotMgmt.on`
  and `penpotMgmt.off`. Reading selection or viewport gives empty values. Use `manage_files` for other file work.
- Each call that is not available fails with the typed tool or member to use instead.

Coverage of the Plugin API:

- Shapes: create, read, geometry, fills, strokes, text, groups, booleans, paths, SVG import, clone, remove, move and
  stacking order.
- Layout: `addFlexLayout`, `addGridLayout`, and the `flex` and `grid` objects. A layout object reads its fields and
  queues the whole layout when a field changes. Grids take `addRow`, `addRowAtIndex`, `removeRow`, `addColumn`,
  `addColumnAtIndex` and `removeColumn`. `layoutChild` sets a child of a flex or grid board. `layoutCell` sets the
  cell of a child of a grid board. `remove()` drops the layout.
- Prototyping: `interactions` reads them. `addInteraction(trigger, action, delay)` adds one, and
  `removeInteraction` or `interaction.remove()` removes one by its index. Ruler guides are added and removed on a page
  or a board. `createFlow` and `removeFlow` handle flows.
- Align and distribute: `alignHorizontal`, `alignVertical`, `distributeHorizontal`, `distributeVertical`.
  `shapesColors` lists the colours and `replaceColor` swaps one.
- Search: `penpotUtils.findShapes(predicate)` searches the current page. `penpotUtils.findShapes(predicate, root)`
  searches inside `root`.
- Tokens: `penpot.library.local.tokens` lists sets, themes and tokens. It finds a token with `findByName` or `findById`,
  and adds sets, themes and tokens. Sets and themes toggle and remove. `applyToken` and `applyToShapes` apply a token
  to shapes. The value comes from the token catalogue, and references such as `{spacing.base}` are followed. Set
  `library.tokensSource` to change the token source.
- Colors and typographies: `penpot.library.local.createColor({ name, color, opacity, path })` and
  `createTypography({ name, path, fontId, fontFamily, fontVariantId, fontSize, fontWeight, fontStyle, lineHeight,
  letterSpacing, textTransform })`. All options are optional. `opacity` is a number and the others are text. The color
  defaults to `#000000`. The name defaults to `Color` or `Typography`. Setting a field on the returned object changes
  the entry. `remove()` deletes it.
- Plugin data: on a shape, `setPluginData(key, value)` and `getPluginData(key)` use the namespace `plugin/mcp`.
  `setSharedPluginData(namespace, key, value)` and `getSharedPluginData(namespace, key)` use `shared/<namespace>`.
  Values are text. A key that is not set reads as an empty string. `getPluginDataKeys` and `getSharedPluginDataKeys`
  list the keys.
- Media: `uploadMediaUrl` and `uploadMediaData` store an image at once. A fill takes the result as `fillImage`.
  `penpotUtils.importImage` places an image. `shape.export({ type, scale })` renders a shape as png, svg, jpeg, webp or
  pdf. It is the same render as `export_shape`, and a result above 8 MB is an error. `penpotUtils.exportImage` gets
  the stored image of a fill.
- Components: `component()`, `componentRoot()`, `componentHead()`, `componentRefShape()`, `isComponentHead()`,
  `mainInstance()` and `instance(x, y)`.
- Management: `penpotMgmt.createTeam`, `penpotMgmt.listDeletedFiles`, `library.availableLibraries` and
  `library.connectLibrary`.

Gaps:

- `applyToken(token, attributes)` needs a list of attribute names, such as `["fill"]`. An empty list throws. `all`
  stands for every attribute of the token type. Plugin names such as `borderRadiusTopLeft`, `paddingLeft`,
  `marginTop`, `fontFamily` and `strokeWidth` map to the names that the backend uses. `strokeWidth` covers all four
  sides.
- Token values come from the active token sets of the file. Only active sets count. When two active sets hold one
  name, the later set in the list wins. A `px` value or a plain number is used as it is. `rem` is multiplied by 16.
  `%` is a fraction, so 50% is 0.5. Expressions use `+`, `-`, `*`, `/` and parentheses, with numbers and token
  references such as `{spacing.base}`.
- `flipX` and `flipY` cannot be set. Setting one throws. To mirror a shape, create it again with the wanted geometry.
- Guides, flows and the token source cannot be read. Add them with the members above.

Example: a board with one background rectangle.

```js
const board = penpot.createBoard();
board.name = "Card";
board.x = 0;
board.y = 0;
board.resize(320, 200);

const background = penpot.createRectangle();
background.name = "Background";
background.x = 16;
background.y = 16;
background.resize(288, 168);
background.fills = [{ fillColor: "#f5f5f5", fillOpacity: 1 }];
board.appendChild(background);

return "created";
```
