# Known gaps in the backend-mode MCP

Found while building the Design Lab file with `tsx src/index.ts build`. Each entry names the tool, the input, the
symptom and the workaround used in this package. Probe scripts and logs are in the scratchpad folder.

## Gaps

### 1. Stroke style, stroke alignment and shadow are rejected

- Tool: `apply_operations`, ops `create_rect` and `create_board`.
- Input: `props.strokes: [{"strokeColor": "#000000", "strokeOpacity": 1, "strokeWidth": 2, "strokeStyle": "solid"}]`.
  The same error comes from `"strokeAlignment": "inner"`. A `props.shadow` list fails the same way.
- Error: `Backend error mcp-invalid-operation: expected valid shape`.
- Workaround: strokes carry only `strokeColor`, `strokeOpacity` and `strokeWidth`. No shadows are used.
- Evidence: `probe/bisect.log`, `probe/bisect2.log`, `probe/bisect3.log`.

### 2. `create_component` returns no id

- Tool: `apply_operations`, op `create_component`.
- Input: `{"op": "create_component", "shapeIds": ["$tmp:n5"], "name": "SM", "path": "Button/Primary"}`.
- Symptom: the response has no `createdIds` entry for the component.
- Workaround: read the library with `get_library` and match each component by its full name. The `mainInstanceId`
  is the root board.

### 3. Library path of a component name (not reproduced in the final build)

- Tool: `apply_operations`, op `create_component`.
- Input used by the first probe: `{"name": "Button/Primary/SM"}` with no `path`, on a board named "Btn".
- Result of the probe: `get_library` gave path `Button / Primary` and name `MD`, so the slash path split correctly.
- A separate observation said the path came back doubled (`Button / Primary / Button / Primary`). The final build
  passes the leaf in `name` and the branch in `path`, and `get_library` lists `Button / Danger` with name `LG`
  for the 47 components. The doubling was not reproduced in the final build.
- Workaround kept: pass the leaf in `name` and the branch in `path`.

### 4. Flex layout lists children in reverse order (closed)

- Status: closed. The backend compiler now applies natural child ordering for flex and grid layouts. Creation order
  is the visual order, and `get_page_tree` lists the children of a flex board in visual order.
- Former symptom: three rects A, B, C created in that order inside a board, then `set_flex_layout` with
  `layoutFlexDir: "row"`. `get_page_tree` listed A, B, C, but the layout placed A on the right and C on the left.
- Former workaround: children of a flex board were created in reverse order. This is removed.
- Switch: the flag `NATURAL_CHILD_ORDER` in `src/OperationPlanner.ts` is `true`. The planner creates the children in
  spec order, then sets the flex layout. The compiler reverses the stored children once at that point, so the spec
  order is the visual order.
- Check: `verify` has a row `children in tree order` for each flex board. It compares the list order of
  `get_page_tree` with the spec. A second row `children` compares the layout positions.
- Evidence of the old behaviour: `probe/flexorder.log` in the scratchpad.

### 5. The default page must be renamed

- Tool: `manage_files` with `create_file`.
- Symptom: a new file has one page named `Page 1`. There is no way to create the file without it.
- Workaround: `update_page {id, name: "Components"}` in the first batch. The journey pages are then created with
  `create_page`.

### 6. Token type names in camel case are rejected

- Tool: `apply_operations`, op `create_token`.
- Input: `{"type": "borderRadius", ...}`, `{"type": "fontSizes", ...}` or `{"type": "lineHeights", ...}`.
- Error: `Backend error mcp-invalid-operation: expected valid params for token`.
- Cause: the compiler reads `type` as a keyword, so the backend names are needed. These are `border-radius`
  and `font-size`. Source: `token-type->dtcg-token-type` in `common/src/app/common/types/token.cljc`.
- Line height is valid only inside a composite token, so the line height tokens use `number` with numeric values.
- Workaround: one function maps the spec token types to the backend names, `backendTokenType` in
  `src/TokenTypes.ts`. It maps `borderRadius` to `border-radius` and `fontSizes` to `font-size`. It maps `lineHeights`
  to `number`. `color`, `spacing` and `number` pass through unchanged.

### 7. Text sizes are approximate

- Tool: `get_page_tree` and `get_shapes`, every text node.
- Symptom: `textLayoutState: "approximate"`.
- Workaround: none needed. This is the documented behaviour in the contract. Text boxes keep the sizes in the spec.

### 8. `get_page_tree` depth and fields

- Tool: `get_page_tree`.
- Symptom: the default depth is 3, so deeper children are missing. The default fields omit `fills`, `strokes`,
  `radius` and `characters`.
- Workaround: every read uses `depth: 20` and `limit: 5000`. Text values come from `get_shapes`. Tree positions are
  absolute page coordinates.

### 9. Instance children need a second write for text overrides

- Tool: `apply_operations`, op `set_text`.
- Symptom: children of an instance are not in `createdIds`, so their ids are not known when the instance is created.
- Workaround: after the write, `get_page_tree` at depth 20 finds the instance by name and its occurrence. Then
  `set_text` runs on the child with the same name, one batch per page. Overrides worked for the names used here:
  `Label`, `Helper`, `Placeholder`, `Title`, `Message`, `Initials`, `Body text`, `Action Label`, `Cell 1` to `Cell 4`
  and `Value`, `Delta`.

### 10. Transient failures were not seen in this build

- Tools: any call. The spec lists `mcp-whoami got no response (TypeError)` as a transient failure.
- Symptom: none in this build. The retry and state-check paths are in `McpSession.ts` and `DesignBuilder.ts`, but
  they have not run against a real failure.

### 11. Flex child sizing is not returned

- Tool: `get_shapes` and `get_page_tree`.
- Symptom: a child of an auto layout board has no sizing field, so `hSizing` and `vSizing` never appear. The model keeps `layoutItem` as `null` for every node.
- Workaround: the verifier checks the size of flex children, not how they size.
- Evidence: `shapes-probe.json` in the scratchpad `parity` folder (see the `shapesSample` keys).

### 12. Hidden and opacity are not returned

- Tool: `get_shapes`.
- Symptom: a default board read by `get_shapes` has no `hidden` or `opacity` key. The model keeps both as `null`.
  Non-default values were not tested, because a probe with `opacity` on a board failed to apply.
- Workaround: the verifier skips both and prints a skipped note.
- Evidence: `shapes-probe.json` in the scratchpad `parity` folder.

### 13. Ellipses read back as "circle" (changed)

- Tool: `get_page_tree` and `get_shapes`.
- Symptom: a spec ellipse had the type `"circle"` in the tree and in the shape list. In the run of the natural child
  order change, the backend returns `"ellipse"`. Then the normaliser read five ellipses as `other` and `verify`
  failed five type checks: the two Toggle knobs, the NavBar avatar, the EmptyState illustration and the Verify Email
  illustration.
- Workaround: the normaliser maps both `"ellipse"` and `"circle"` to `"ellipse"`. A test in `src/Normaliser.test.ts`
  covers both names.
- Evidence: `shapes-probe.json` in the scratchpad `parity` folder. The `ellipse` case is in `out/raw/shapes-*.json`.

### 14. Paragraph line height can differ from its text run

- Tool: `get_shapes`, text content.
- Symptom: the paragraph `lineHeight` is `"1.2"`, but the text run inside it has `"1.4"` for the body-sm style.
- Workaround: the model reads the run value. The verifier compares the run value with the typography.
- Evidence: `shapes-probe.json` in the scratchpad `parity` folder.

### 15. `export_shape` returned an empty PNG (resolved after an adapter restart)

- Status: the coordinator restarted the adapter with `PENPOT_MCP_ASSETS_URI` and moved the backend storage. Later
  calls returned real PNG bytes (1.2 KB to 88 KB in the same probe). The pixel compare now uses the export. The
  earlier empty results came from the asset download step, which failed without an error.
- Tool: `export_shape`.
- Input: `{"fileId": "ce1379a2-f81f-8121-8008-e4ecc4f2956a", "pageId": "ce1379a2-f81f-8121-8008-e4ecc51b3161", "shapeId": "ce1379a2-f81f-8121-8008-e4eccc0265bf", "format": "png", "scale": 1}`
  (the Welcome screen board). The same call fails in the same way for the component board
  `ce1379a2-f81f-8121-8008-e4ecc6ad54f9` on the Components page, for a child rect of the Welcome screen, and for the
  Welcome board at `"scale": 2`.
- Output: `content` holds one block `{"type": "image", "data": "", "mimeType": "image/png"}`. `isError` is absent and
  no text block comes back. The call takes about 5 seconds.
- Symptom: the PNG has no bytes, so no pixel can be compared. The tool does not report an error.
- Workaround: the pixel compare reports each export as unavailable with this reason. The DOM compare does not use the
  export, so the gate runs without it.
- Evidence: `probe-export.log` and `probe-export2.log` in the scratchpad folder.

### 16. Stroke alignment is not returned

- Tool: `get_shapes` and `get_page_tree`.
- Symptom: a node has no stroke alignment in the read. The model cannot say whether a stroke is inside, centred or
  outside the shape edge.
- Evidence: Penpot draws a stroke with no alignment as centred. See `common/src/app/common/geom/shapes/bounds.cljc`
  line 135 and `frontend/src/app/main/ui/shapes/custom_stroke.cljs`. The Penpot export of a board with a 1 px stroke
  is 2 px wider and 2 px taller than its box, 1 px on each side. A 144x40 board with a 1 px centred stroke exports at
  146x42. Other examples: `Button/Ghost/LG` exports 178x50 for a 176x48 box, and `NavBar` exports 1442x66 for 1440x64.
- Workaround: the generator assumes a centred stroke. Each stroke is drawn as a `box-shadow`, not as a border or an
  outline, so the box and the child positions do not change. Inner: inset spread `w`. Centre: inset `w/2` plus outer
  `w/2`. Outer: outer spread `w`. A CSS outline was rejected. Blink stores `outline-offset` as an integer, so a centred
  1 px stroke reads as -1 px. The pixel clip grows by the stroke extent, so the export and the screenshot match in size.

### 17. Text alignment is stored on the paragraph, not the run

- Tool: `get_shapes` and `get_page_tree`, text content.
- Symptom: the text run of a centred text says `left`, even when its paragraph says `center`. Reading the run alone
  left centred labels aligned to the left.
- Workaround: the Normaliser reads `textAlign` from the first paragraph that has one, then from the run. It also reads
  `verticalAlign` of the text content root. A centred text span centres its lines vertically (flex column, justify
  centre).
- Evidence: before this fix, `verify` failed 23 `textAlign` checks. The Badge, Avatar and Pagination labels rendered
  left-aligned in the app.

## Behaviour checked

- `apply_typography` links the text to the library. The link sits on each text leaf of `content` as
  `typographyRefId`.
- A later `set_text_style` with `fontSize` keeps that link.
- `set_text_style` with `textAlign: "center"` and `verticalAlign: "center"` works.
- `fills: []` on a board gives a board with no fill.
- `delete_file` on the file recorded by an earlier build works.

## Spec interpretations

- Screen body coordinates are relative to the screen origin, because the spec says "absolute" for children of Body.
  The Body board uses `coordinates: "frame"` for this.
- The tooltip arrow sits inside the 32 px box, so the containment rule holds.
- Button labels have fixed boxes. "Back to dashboard" in Ghost/MD is wider than its box and may wrap.
- Alert titles use the body style with weight 600 through a text style override.
