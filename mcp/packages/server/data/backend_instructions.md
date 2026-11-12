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
   box (see "Text sizes"). `fields` may also name `textLayoutState` and `characters`: a text always carries them, and
   any other shape answers null.
8. `find_shapes`, `get_library` and `get_tokens`: search by name, type, component, text or color, and read the library
   and design tokens. `get_tokens` takes an optional `setId` to read one token set, and `format`: `tokens` (the default:
   sets, themes and tokens) or `dtcg` (the DTCG export instead). It returns only one of the two.
   A `find_shapes` search that ends early still returns the matches it found. Then `truncated` is true, `reason` says
   why (`size`: the reply is full; `limit`: your `limit` is reached; `time`: the five-second search budget ran out),
   `scanned` counts the shapes the call looked at, and `nextCursor` goes back in `cursor`, with the same filters, for
   the next matches. A reply never holds half a match. A cursor with other filters, or after pages were added, removed or
   reordered, is refused: start again without a cursor. When `skipped` is present, the call left out that many shapes
   (`skippedIds` lists up to 20) whose name ran the regex out of time; search them with a simpler filter.

Write with `apply_operations`. Its operations use ids from the steps above.

## Ids and handles

- Every id is a UUID. Copy ids from a response. Do not invent them.
- A create operation can set `id` to a handle such as `$tmp:card`. Later operations in the same call then use
  `$tmp:card` wherever they need the shape id, for example as `parentId`.
- The response to a write maps each handle to the UUID that Penpot created in `createdIds`.
- `create_component` takes `id` as a handle too. Later operations in the same call can use it.
- Handles last for one call only. A later call needs the UUIDs.

## Bulk reads and checks

- `export_subtree` returns every attribute of every shape under `rootId`, or of the whole page when `rootId` is left out.
  A reply holds as many shapes as fit the response cap of the tool, and has `nextCursor` while shapes remain: pass it as
  `cursor` until there is none. Pass `filePath` to write the whole subtree to one JSON file in one call, and then read
  that file, not the reply. One shape above the cap comes back alone with its large attributes shown as omitted, listed
  in `oversize` with its real size; `nextCursor` goes on after it, and the note says how to get the whole shape (the
  operator raises `PENPOT_MCP_SUBTREE_MAX_RESPONSE_KB`, or use `filePath`). `compact: true` drops null keys and the
  top-level keys that hold their default (`defaults` lists them), and `strokeAlignment` when it is `center` inside
  each stroke. Do not ask for `encoding` or `maxResponseKb`: they are for scripts. `maxResponseKb` (whole kilobytes, 1 to
  10000) is the reply cap for that one call in place of the cap of the server; it is allowed only with
  `encoding: "gzip-base64"` and only inline (not with `filePath`), and not above the server maximum.
- `get_interactions` lists the flows and the prototype links of a page. `find_connectors` finds the arrows and lines
  that run between two screens, drawn as paths or as small groups of shapes. A group counts as one arrow only when it
  has a shaft and heads at its ends; a row of arrows in one group is read arrow by arrow. An arrow drawn inside a screen
  is found. A rounded or blunt head is read too, with `medium` confidence. A connector inside one screen is dropped
  (`includeSameScreen` returns it). An end in a frame that is no screen has `nonScreen`. `direction` says how the head
  was found, and `confidence` how sure that is: read `none` as "unknown": take the direction then from other evidence, such as labels or the order of the screens. Direction is read only from
  heads: arrow caps on strokes, a head shape on the path, or a head grouped with the line. Bare bars and unions of
  rectangles read `none` by design. Designers who want machine-readable flows should use `line-arrow` caps or prototype
  links. A screen's wrapper here is its parent frame when that frame holds only that screen, centred
  within 2 px with gaps up to 400 px (not the wrapper of the board selection, which is stricter). An end within
  `maxDistance` of the wrapper, or of one of the screen's overlays, is a candidate for the screen, and the nearest screen
  by true distance wins. `distance` is measured to the screen and may exceed `maxDistance`. It selects screens as `lint_page`
  does. On a large page, pass `withinId` to scan one part at a time.
- Run `list_fonts` before an export or a code generation. A font that does not resolve renders with a fallback font.
  Such a font can carry `suggestedFontId`: a font of the same family that does resolve, often a team font uploaded under
  a longer name. `suggestedVariantsMissing` lists the faces that the text uses and that font lacks. When
  `get_file_outline` says `warningsComplete` false, `warningsPendingPages` names the pages its warnings miss: run
  `list_fonts` for the file. A `list_fonts` reply that is not `truncated` is the complete font report, so read it there; when `pagesRead` is below `pagesTotal`, call `list_fonts` again with the same arguments (the backend process keeps the pages it read for up to 10 minutes, so a call usually goes on from there, but behind several processes it may start again);
  do not call the outline again to confirm. The outline warnings are a fast first look, and with several backend
  processes they may stay incomplete after `list_fonts`.
- Run `lint_page` and `find_similar_boards` before you generate code from a page. Both find the screens by size. With
  no `depth`, `boardNameRegex` or `mode`, they first look for frames of a standard screen size (a phone, tablet,
  desktop or kiosk size) that occur at least three times, however deep they lie. If there are none, they use the
  nesting of repeated frame sizes. Frames under 200 px on a side are never screens. Standard sizes are always kept. Loose
  boards that are clearly not screens are dropped: a frame larger than the screens in both directions with at least 4
  times the area of the largest screen class (a section); a frame that holds exactly one loose board with a wrapper
  margin; a non-portrait frame that holds, or sits in, a frame of its own size (an annotation and its widget) and is
  under half the smallest screen class. An empty section 2 to 3 times the screen area is still a board. An overlay (a
  sibling frame of a screen inside its wrapper, with at least half of its own area over that screen) is not a board. `selection` in the reply says what
  was chosen, with `basis` (`standard-size`, `structure` or `depth-fallback`), and `otherSizes` lists up to 5 sizes
  that repeat on the page but were not chosen. A frame size is also a wrapper when at least 90% of its frames each hold exactly one screen, of any exact standard size, as a direct child, centred with equal gaps on opposite sides (within 2 px) of at most 200 px; the size appears in `otherSizes` with relation `wrapper`, and a class below 90% is reported `outside`. In mode `depth`, `deeperBoards` counts the repeated screen-sized frames
  below the chosen boards: when it is not 0, call again without `depth`, or with a larger one. To choose boards by hand,
  pass `mode: "depth"` with a `depth` up to 12, or a `boardNameRegex`. `mode: "auto"` does not take `depth`.
- `lint_page` finds empty boards, boards that hold only chrome (`instance-only-board`; chrome is the components that
  repeat in the same place across the screens and touch a screen edge or sit on most screens, such as a header, a
  footer or a side rail (a header that sits in different places is not chrome); the variants of a component count as one; `chromeComponents` lists them; an image, even a
  full-screen one, is content), and controls that are clipped or off their board. A control that its board hides, but that a
  scrolling board brings into view, is `scroll-hidden-control`. `sibling-overlay` (mode auto only) is a visible board or group, of any size,
  that is not a screen, is a child of a wrapper next to a screen, is not a component instance or inside one, and has at
  least half of its own area over that screen (the one it overlaps most), such as a "Verifying..." panel over a login
  screen. A shape that is not a sibling of the screen inside its wrapper (a section child laid over a screen) is not found. One finding for each overlay: `boardId` is the covered screen,
  `shapeId` and `shapeName` the overlay, and the detail has `coveredFraction` and `overlayBox`. Hidden overlays are not
  reported, and in mode `depth` the rule reports nothing.
- `scroll-candidate` names a clipping frame without `overflowScroll` whose content reaches past its right or bottom
  edge (a track that starts left of the frame counts; a background that covers the frame on both axes does not), and
  suggests `vertical`, `horizontal` or `both`. To set them, send one `apply_operations` call with one
  `update_shape` operation per reported frame, for example
  `[{"op": "update_shape", "pageId": "P", "id": "F1", "props": {"overflowScroll": "vertical"}}]`. A finding with
  `inComponentCopy` true is a copy: set the value on the main component instead, or it becomes an override.
- `find_similar_boards` finds copies, so that each repeated board is built once. It compares only boards with at least
  `minShapes` shapes; `skippedSmall` lists the others. A group whose boards have such overlays also has
  `overlays: [{boardId, shapeId}]`; the key is absent otherwise.

## Writing with apply_operations

Operation parameters are camelCase. Coordinates are absolute page coordinates. Colors are hex strings.

Use `create_ellipse` for an ellipse. Results from `get_shapes`, `get_page_tree` and `find_shapes` call it `ellipse`, and
`find_shapes` also accepts `circle` as a type.

Use `create_board` for a board. Results call a board `frame`, and `find_shapes` accepts `board` as a type too. A board
and a frame are the same type. Its `overflowScroll` (`none`, `horizontal`, `vertical` or `both`) marks a clipping board
as a scroll container. The viewer does not scroll it yet.

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

Replace a font on a page with `replace_font`. It needs `pageId`, `fromFontId` and `toFontId`. Take the ids from
`list_fonts`. It swaps the font of every text in one pass, so it is the call to use after a font fails to load.

```json
[{"op": "replace_font", "pageId": "P", "fromFontId": "gfont-access-sans", "toFontId": "custom-4f6d1b2a-7c3e-4a5b-9d80-1e2f3a4b5c6d"}]
```

- `toFontId` must resolve: a built-in font, a Google font (only when the deployment allows them) or a font of the team.
  The call fails when it does not, or when it equals `fromFontId`.
- The scope is one page. `rootIds` (1 to 500 shapes) limits it to those shapes and everything under them.
- A run changes when its font id is `fromFontId`. A run with no font id counts as `sourcesanspro`. The other runs of the
  same text stay as they are.
- A changed run gets `fontId`, `fontFamily`, `fontVariantId`, `fontWeight` and `fontStyle` of the target. The size,
  fills and spacing stay. The variant id is the one the workspace writes for that font: a table id for a built-in font
  (`bold`), `regular`, `italic`, `700` or `700italic` for a Google font, and `<style>-<weight>` for a team font
  (`normal-700`).
- A run with no weight of its own keeps the weight of its paragraph. A root or a paragraph set gives a run nothing: a
  run under a root of weight 700 renders at 400, and stays 400. A paragraph, paragraph set or root changes only its
  `fontId`, `fontFamily` and `fontVariantId`; its weight and style stay. A weight word such as `bold` gives way to a
  `fontVariantId` that names a face; with none it counts as the renderer reads it, case-sensitively (`bold` 700,
  `Bold` 400). `semibold` and `extrabold` are not mapped, and the call refuses them.
- `variantMatch` `exact` (the default) needs the target to hold each weight and style in use. If one is missing, the
  whole call fails, writes nothing, and the error names the missing pairs. `nearest` takes the closest weight instead;
  `variantsUsed` in the reply shows each pick, with `exact` false for a near one. Use a dry run to see the picks first.
- `maxTexts` (1 to 2000, default 1000) caps the texts one call changes. If more would change, the call fails and says
  how many. Narrow it with `rootIds`, or raise `maxTexts`.
- These texts are skipped, never written, and listed in the reply with a reason: `component-copy` (a text inside a
  component copy), `typography-ref` (a text linked to a typography) and `font-token` (a text with a font family, font
  weight or typography token applied). Detach or change those by hand, or swap the font in the main component.
- A text inside a main component of this file does change, and its component id is in `mainsChanged`. To carry the change
  to the copies, add `{"op": "sync_components"}` to the same call: with no ids it syncs the mains that the call touched.
  Do it in the same call: a later `sync_components` with no ids does not know which mains this call touched. Dry-run
  first when you want the lists. The op also stamps the changed components as modified, so other files see the change.
- A copy whose text was overridden in any way (colour, size, anything) keeps all its text attributes after the sync,
  the old font included. After the sync, run `list_fonts` again to see what is left. For a team font, reset the
  override with `reset_overrides` on the text shape in the copy (the id of the copy's top shape would drop every
  override in the copy), or set the font in the workspace; do not use `set_text_style` for a team font, which writes a
  plain weight such as `700` as the variant id. `replace_font` on the copy's own page skips it as `component-copy`.
  A main in another file is never written.
- Runs of other fonts under a changed paragraph that name no weight of their own are not written, but in the workspace
  they may show a different weight, because they take it from the paragraph's new font.
- Hidden and locked texts change too, as in the workspace.
- Copies that the sync changes lose their `positionData` too; `layoutDropped` does not count them, and the svg export
  note below applies to them.
- Auto-width and auto-height texts keep their old box size until someone edits the text in the workspace, and layout
  parents do not reflow. `autoSizeTexts` and `autoSizeIds` in the reply name them.
- The call drops `positionData` from every text it changes, as the workspace does when a font changes, and it does not
  resize the text box. `layoutDropped` and `layoutDroppedIds` name those texts. Until someone opens the page in the
  workspace, which rebuilds the layout, an svg export of a shape that holds such a text fails with an exporter timeout,
  and `textLayoutState` is `approximate`. A png export works.
- A call that changes at least one text takes a snapshot first, unless you pass `snapshot: false`.
- The reply holds `opResults`, one entry per operation (null for an operation with no result). The entry for
  `replace_font` has `textsScanned`, `textsMatched`, `textsChanged`, `runsChanged`, `toFamily`, `variantsUsed`,
  `changedIds`, `layoutDropped`, `layoutDroppedIds`, `autoSizeTexts`, `autoSizeIds`, `mainsChanged` and `skipped` (`total`, `byReason`, and `items` with
  `id`, `reason` and `detail`). Each list of ids holds at most 100, and a `...Truncated` flag says when it was cut; the
  counts are always complete. A `dryRun` returns the same entry and writes nothing.
- A replay of the same `requestId` returns `alreadyApplied` true and the `opResults` of the first answer. Run it
  again as a dry run to see what is left.
- It does not change typographies of the file library that use the source font, texts on other pages, or texts in other
  files. Run it once per page. `set_text_style` and `create_text` still write a plain weight, such as `700`, as the
  variant id of a team font, which the workspace does not know.

Example 3: move shapes into another parent, in a given order.

```json
[{"op": "move_shapes", "pageId": "P", "ids": ["S1", "S2"], "parentId": "B1", "index": 0}]
```

Example 4: change the properties of a shape. Only the given keys change.

```json
[{"op": "update_shape", "pageId": "P", "id": "S1", "props": {"opacity": 0.5, "hidden": false}}]
```

`props` refuses the layout-item keys, the gap keys and the padding keys (`layout-gap`, `layout-padding` and their variants). Use `set_layout_child` for a child's layout item, and `set_flex_layout` or `set_grid_layout` for gap and padding.

`props` also refuses `flipX` and `flipY` on every create and update operation: a flip changes the transform and the
points, so the flag alone would leave a broken shape. No operation sets a flip. A create operation refuses `rotation`
in `props` too; create the shape, then turn it with `update_shape`.

A shadow in `props.shadow` needs `style` (`drop-shadow` or `inner-shadow`), `offsetX`, `offsetY`, `blur`, `spread`,
`hidden` and `color`. Its `id` is optional: a shadow without one gets a new id. A wrong shadow fails once, with the key
path, for example `props.shadow is invalid`.

```json
[{"op": "update_shape", "pageId": "P", "id": "S1", "props": {"shadow": [
  {"style": "drop-shadow", "offsetX": 0, "offsetY": 4, "blur": 8, "spread": 0, "hidden": false,
   "color": {"color": "#000000", "opacity": 0.25}}]}}]
```

A path made by `create_path` gets the default stroke of a path drawn in the workspace: a centered 1 px black stroke and
no fill. For a filled outline, such as an arrow, pass `"props": {"strokes": []}` and the fills you want.

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
- The reply of the repeat carries the `createdIds` (the `$tmp:` handle to id map) and the `opResults` of the first
  answer, so a retry of a create gives you the real ids. The server keeps up to 10,000 entries of `createdIds` and a
  reply of up to 1 MiB for about an hour, until the record expires. When it had to cut them, the repeat says `replayTruncated: true`: read the page to
  find the rest. A write that committed in several batches keeps one reply for the whole call.
- A response larger than 100 kB (`PENPOT_MCP_MAX_TOOL_RESPONSE_KB`) is cut, and the text says so. It is cut at whole
  items, and a cut answer has no `nextCursor`: repeat the call with a smaller `limit`. Narrow the request instead.
  `find_connectors` and `lint_page` are cut that way only when a single item does not fit, and that reply has no
  `nextOffset`. When their list does not fit, the reply holds whole items, `truncated` is true and `nextOffset` is set:
  call again with `offset` set to `nextOffset`, until no `nextOffset` comes back. That reads every item once while
  `revn` stays the same and no reply has `timedOut`. A reply with `timedOut` is not complete and cannot be continued:
  start again with a narrower call (fewer `rules`, `boardNameRegex`, `withinId`).
- The backend has its own rate limit. When it refuses a call, the text says how long to wait. Wait, then send the same
  call again, with the same `cursor` if there was one: a cursor stays valid. An `export_subtree` call that the limit
  stops after some windows returns them, with a `nextCursor` and a note.

## Text sizes

Penpot does not measure text on the server. Text created or edited through the backend gets an estimated size, and
its `textLayoutState` is `approximate`. The estimate uses about 0.6 em per character and 1.2 em per line. Open the
file in a browser to correct the layout.

## Geometry semantics

These rules say what the numbers of a shape mean. Read them before you place shapes in another program. Positions are in
page coordinates unless a rule says otherwise. Penpot draws shapes with two renderers. The SVG renderer makes the
exporter's default render. The wasm renderer draws the workspace. Where they differ, the rule says so.

### Box

`x` and `y` are the top-left corner of the box around the shape's `points`. `width` and `height` are the size of its
`selrect`, before rotation. `rotation` is reported apart.

The `x`, `y`, `width` and `height` in the replies of `get_shapes` and `export_subtree` are this box. The stored values of
a rotated shape, or of a path or boolean whose content changed, can be stale.

### Points and selrect

`points` lists the four corners of the shape's rectangle in page space. Take the corners of the unrotated, unflipped
rectangle in the order top-left, top-right, bottom-right, bottom-left, and transform each one. A flipped shape therefore
has its first point at a corner that is not its visual top-left.

`selrect` is the unrotated rectangle. It has the same centre as the points, and its width and height are the lengths of
the sides.

### Transform

`transform` maps the `selrect` to the `points`. It works about the centre of the shape. `transformInverse` is its inverse.
A shape that is neither rotated nor flipped has the identity for both. A flipped shape has a mirror in `transform`.

`worldMatrix` maps the four corners of the `selrect` (top-left, top-right, bottom-right, bottom-left) onto the four
`points`, in that order. To draw a shape, draw its unrotated rectangle through it. `export_subtree` gives it for each
shape, with the values `a` to `f` in SVG order. It is the candidate whose `selrect` corners land nearest to the `points`:
the fit from the `points`, the `transform` about the centre, or, for a flat box (a side under 0.05 px), the `transform`
mirrored. The `transform` about the centre is `translate(centre) · transform · translate(-centre)`. When the fit and
that product agree within 0.05 px, the product is returned exactly. For a flipped group it can differ from the stored
`transform`: an import can leave the `transform` at the identity while the `points` are mirrored. On ordinary data the
result is within 0.01 px of the `points`. A flat shape under a rotation that no longer matches its `transform` can be
off. A shape without four `points` has the product. A shape without `selrect` has no `worldMatrix`.

The `content` of a path or a boolean is a string of absolute SVG commands `M`, `L`, `C` and `Z`, for example
`M10.0,20.0L110.0,20.0C...Z`. Its points are in page space with `transform` already applied. Do not apply `transform` to
it again. The `content` of a text is a tree of paragraphs and runs.

### Text

Each entry of `positionData` is one laid-out run of text. It has `x`, `y`, `width`, `height`, `text`, `direction`, `fills`
and the font properties.

`x` and `y` are in page coordinates, before the shape's rotation. The rotation is in the shape's `transform`.

`y` is the bottom of the run's box. It is the ideographic baseline, the descent line. It is not the alphabetic baseline.

Draw each run with `dominant-baseline: ideographic` at `x` and `y`. Set `textLength` to `width` with
`lengthAdjust: spacingAndGlyphs`, so that glyphs and spacing stretch to exactly `width`. Use `white-space: pre`. A run
with `direction` `rtl` is anchored at `x + width`.

Example: a run has `x` 100, `y` 74, `width` 120 and `height` 24. Its box runs from y 50 to y 74. Put the glyph bottoms on
y 74 and fit the run to 120 px. If you put the alphabetic baseline on y 74, the text sits lower by its descent.

A text without `positionData` has no run positions. Its box is an estimate only when its grow type is also `auto-width`
or `auto-height`. See "Text sizes". A text created or changed through the MCP has no `positionData` until the file is
opened in the workspace. An svg export of a shape that holds such a text fails with an exporter timeout, while png
works.

### Gradients

`startX`, `startY`, `endX` and `endY` are fractions of the shape's `selrect`, measured in its unrotated frame. A value can
lie outside 0 to 1. They are not pixels, and they are not a direction in page space.

Example: a box of 200 by 100, with start (0, 0) and end (1, 1). The line runs from corner to corner. In pixels it goes from
(0, 0) to (200, 100), so its angle is about 26.6 degrees, not 45.

The two renderers differ on a box that is not square. The wasm renderer turns both points into pixels and draws the colour
bands perpendicular to the line. The SVG renderer works in the unit square and stretches the result with the box, so its
bands are skewed. At the corner (200, 0), t is 0.5 in the SVG renderer and 0.8 in the wasm renderer. Here t is 0 at start
and 1 at end.

- Linear: the gradient runs from start to end.
- Radial: the centre is the start point. `width` is a ratio. Across the axis, the radius is `width` times the radius along
  it. For a vertical axis in a W by H box, both renderers give a radius of |end - start| × H along the axis and
  |end - start| × width × W across it. For other axes the renderers differ.
- A stroke gradient on a path, in the SVG renderer, gets the shape's transform, applied about the centre of the path's
  bounding box.
- A text fill gradient, in the SVG renderer, uses the fractions of the shape's `selrect`. The gradient is anchored at each
  run's own box, so it restarts at each run.

### Strokes

`strokeAlignment` is `center`, `inner` or `outer`. A stroke that stores no alignment is drawn as `center`. An `inner`
stroke lies wholly inside the outline of the shape, and an `outer` stroke lies wholly outside it. On an open path, both are
drawn as `center`.

Rectangles and boards can store a width for each side on an entry of `strokes`: `strokeWidthTop`, `strokeWidthRight`,
`strokeWidthBottom` and `strokeWidthLeft`. A side without a value takes `strokeWidth`. Both renderers draw each side with
its own width, as the band between an outer and an inner rounded rectangle. With `inner` alignment the outer edge is the
box, so the band lies inside it. With `outer` the inner edge is the box, so the band lies outside it. With `center` each
edge moves half a side width. Corner radii grow with the outer edge and shrink with the inner edge. When two radii on one
side add up to more than that side, all radii scale down by one factor, as SVG and Skia do. The SVG renderer does not fit
a whole number of dashes into each side, and it does not mitre several per-side strokes that share a box, as the
workspace renderer does.

### Stacking and clipping

`shapes` lists a shape's children in stored order. Outside a layout, the last id is on top.

In a flex or grid layout, the stacking depends on the layout:

- Flex `row` or `column`: the first id in `shapes` is on top, in both renderers.
- Flex `row-reverse` or `column-reverse`: the last id is on top, in both renderers.
- Grid: the wasm renderer draws the last id on top. The SVG renderer draws the first id on top.

In both renderers, a child with a higher layout item z-index is drawn above the others. `get_page_tree` lists a layout's
children in visual order, which is the reverse of `shapes`. So the first id in `shapes` is listed last. See "Child order in
layouts".

A board clips its content unless `showContent` is true. The clip follows the board's corner radii.

A board can also carry `overflowScroll`: `none`, `horizontal`, `vertical` or `both`. Absent means `none`. It marks a
clipping board as a scroll container on the axes it names, for prototypes and code export: content past the board's edge
on those axes is meant to be reached by scrolling. The viewer does not act on it yet.

### Generator recipe

To place shapes in another program, read a board with `export_subtree`, with `rootId` set to the board's id.

1. Read every reply. Pass `nextCursor` as `cursor` while `truncated` is true.
2. Place each shape with its `worldMatrix`. A path and a boolean are the exception. Their `content` is already in page
   space, so draw it without `transform` and without `worldMatrix`. Use `points` for their box.
3. Paint each shape with its `fills`. For each stroke, use `strokeAlignment` and the side widths.
4. Draw each text from its `positionData`, as set out under Text.
5. Stack children as set out under Stacking and clipping.

### More facts a generator needs

- A boolean's children appear in the walk, but the boolean draws only its own path.
- A hidden shape appears in the walk and is not drawn.
- In a masked group, the first id in `shapes` is the mask.
- `fills[0]` is on top of the other fills, in both renderers. In the SVG renderer `strokes[0]` is on top of the other strokes, and hidden strokes are not drawn.
- Corner radii are `r1` top-left, `r2` top-right, `r3` bottom-right and `r4` bottom-left.
- The blur of a drop shadow or an inner shadow has standard deviation `blur / 2`. A layer blur uses `value` as its standard deviation. These are the SVG renderer's values.
- Opacity and blend mode of a group apply to the group with all its children.
- An image fill with `keepAspectRatio` covers the box and is centred, so the parts outside are cut away. Without it, the image is stretched to the box.
- In `positionData`, `fontSize`, `letterSpacing` and the other font values are strings, such as `"14px"`.
- `text` in `positionData` is not case-transformed. Apply `textTransform` yourself.
- `x1`, `y1`, `x2` and `y2` in a run come from the browser's layout. They do not move with the shape, so ignore them.

### Names that differ from the stored file

The tools show some names in a form that differs from the stored file. A generator ported from a binfile must map them.

| Stored in the file | Shown by the tools | Notes |
|---|---|---|
| shape type `circle` | `ellipse` | `find_shapes` accepts `ellipse` or `circle` as `type`. The create op is `create_ellipse`. |
| shape type `frame` (a board) | `frame` | `find_shapes` accepts `board` or `frame` as `type`. The create op is `create_board`. |
| kebab-case attribute keys, such as `fill-color` | camelCase keys, such as `fillColor` | Every read tool and every write tool. |

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

`export_shape` with `shapeIds` (1 to 200 ids) renders many shapes in one call, in batches. One failed shape does not stop
the others. With `outputDir`, a folder inside the export directory, each image is saved as `<shapeId>.<extension>` and
the reply lists the files. Without it, the images come back inline, up to 8 MB in total. `renderer` `"wasm"` renders
with the workspace's renderer, when the exporter has it. `refresh` `true` skips the render cache, which keeps a render
for 15 minutes. Each render is kept for 15 minutes, whatever its fonts. When a font did not resolve, the reply names it: run `list_fonts`, fix the font, then pass `refresh` `true`.

Write tools accept `dryRun`, which checks a change without saving it.

## Other tools

- `comments`: list threads, read them, create a thread on a frame, reply, resolve or reopen, move and delete.
- `manage_files`: create, rename, move, duplicate, pin, share, delete and restore teams, projects and files, and link
  libraries.
- `apply_raw_changes`: raw Penpot change records. Use it only when `apply_operations` cannot express the change.
- `batch_create_shapes`: a nested tree of shapes, created in one write. It builds the operations for you.
- `describe_operations`: the parameters of up to 20 named `apply_operations` ops, as JSON Schema.
- `penpot_api_info`: pass `Geometry` as the type to read the rules of the box, the transform, the text, the gradients,
  the strokes and the children. The rules are in "Geometry semantics" below.

## execute_code in backend mode

`execute_code` runs a short JavaScript script on one file. Use it for loops, conditions and many shapes at once.
Use the typed tools for one or two simple changes.

- `fileId` names the file. Penpot calls use it, so the script does not name the file again.
- `pageId` sets `penpot.currentPage`. Leave it out to use the first page.
- `rootIds` (1 to 20 shape ids, with `pageId`) loads only those boards or groups, and their ancestors. Shapes outside them
  are not in the model: `findShapes` does not see them, and a reference to one reads as `{id, loaded: false}`. A parent
  whose children did not all load refuses an insert at an index, a z-order move of its children, a `parentIndex` read of
  a child, and `remove` or `ungroup` of itself. Add that shape's id to `rootIds`, or leave `rootIds` out. An append on
  top still works. The ancestors of the roots are stubs: `children` lists them, and `findShapes` does not. The reply carries a `partial-page` warning.
  A page above the 16 MB cap fails at once when its estimated size is clearly over: the error says "estimated" and asks
  for `rootIds`.
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
