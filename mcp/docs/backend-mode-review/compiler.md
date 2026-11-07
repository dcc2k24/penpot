# Review: the operation compiler (common module)

Scope: `common/src/app/common/mcp/operations.cljc` (read in full), `logic/modifiers.cljc`,
`logic/token_application.cljc`, `fonts/builtin.cljc`, the JVM-parity diffs in the flex and grid layout code,
`types/objects_map.cljc` (commit `2c33b0ff9a`), and the three test files. Commit under review: `541f965bf1`.
All line numbers are at that commit. Nothing was run; every claim comes from reading the code. "Confirmed" means
the code path was traced end to end. "Suspected" names what a run would settle.

Paths are relative to `C:\dev\penpot`. `ops` is short for `common/src/app/common/mcp/operations.cljc`.

## Verdict

The compiler has a sound core: one working copy of the file, one fresh changes builder per operation, the
editor's own generators for the hard parts (relocate, delete, duplicate, components, tokens, modifiers), and a
check of every changed shape. Its weak points are at the edges. It trusts the caller where the editor guards
(invalid moves can delete shapes and report success), it turns every failure into a client error, and several
operation families still scan the whole page or token library once per operation. The benchmark covers only the
one path that was tuned.

## Answers to the six questions

### 1. Architecture

- **Dispatch.** `compile-operations` (ops:3545) decodes and checks the whole vector against one `:multi` schema
  (ops:213-573), then folds `compile-op` over it. `compile-op` (ops:3528) looks the op name up in `op-registry`
  (ops:3385-3460, 75 names to 21 family functions). Each family function then runs a `case` on the op name again.
- **Validation.** Three layers: the vector schema; `decode-op-values` (ops:801) for the open maps (`props`,
  `interaction`, `grids`, `fills`) with coders built once; and `check-changed-shapes` (ops:3516) on the final
  state of each shape the op touched.
- **State.** A plain map (ops:835): the working `:file-data`, `:changes`, `:op-ranges`, `:created-ids`,
  `:warnings`, `:reflow` (page id to shape ids), `:touched-mains`, `:new-id-fn`, `:libraries`. Each op builds on
  `op-builder` (ops:862) and ends in `commit-builder` (ops:890), which applies the redo changes to the working
  copy. Undo changes are thrown away. Reflow runs once per page after the last op.
- **Is one namespace right?** It works, and the file reads in order. But 3,586 lines hold eight unrelated
  families, and an op is registered in three places (schema entry, registry entry, family `case`), plus the zod
  schema in the adapter and the contract table. The schema list and the registry agree today (75 and 75, checked
  by hand); no test holds them together. See CMP-21 for a split.
- **Adding an op** touches: schema entry, registry entry, `case` branch, handler, contract, adapter zod schema,
  sandbox facade, tests. Seven or eight places. A missing registry entry only shows at run time.

### 2. Reuse and duplication

Reused well: `cls/generate-relocate`, `cls/generate-delete-shapes`, `cls/generate-update-shapes`,
`cll/generate-*` for components, `clt/generate-*` for tokens, `pcb/*`, `ctl/*` cell helpers, `gal/*`.

Duplicated or reimplemented (risk in brackets):

| Compiler code | Editor code | Risk |
|---|---|---|
| `logic/modifiers.cljc` (`check-delta`, `calculate-ignore-tree`, `transform-attrs`) | `frontend/.../workspace/modifiers.cljs:66-104, 122+`, still in place and identical today | high: two copies of the touched rules (CMP-11) |
| `logic/token_application.cljc` | `frontend/.../tokens/application.cljs`, still in place | high: already differs (CMP-06) |
| `move-shapes-change`, group, ungroup, clone | `relocate-shapes` guards in `frontend/.../workspace/shapes.cljs:617-621` | high: guards missing (CMP-01) |
| `mask-change` (ops:1790) | `mask-group` / `unmask-group` in `frontend/.../groups.cljs:305-348` | medium (CMP-10) |
| `set-layout-child-change` (ops:1922) | `update-layout-child` in `frontend/.../shape_layout.cljs:597-627` | medium (CMP-05) |
| `compile-group-op` for booleans (ops:1515) | `create-bool` / `create-bool-shape` | low (CMP-18) |
| `compile-create-op` add path (ops:1466-1470) | `cfsh/prepare-add-shape` (`files/shapes_helpers.cljc:20`) | low |
| text ops (ops:2073, 2695) | `dwt` text events through `dwsh/update-shapes` | medium (CMP-05) |

### 3. Performance

N = shapes on the page, M = operations in the call, k = size of a subtree, d = depth, S = token sets,
T = tokens. "x2" means the builder applies the change to its local copy and `commit-builder` applies it again.

| Family | Cost per op | Per-op scans found |
|---|---|---|
| Pages | O(1); `delete_page` O(N) once | `page-component-ids` (ops:1151) |
| `create_*` with a name | O(d + siblings), x2 | `ctst/add-shape` copies the parent's `:shapes` |
| `create_*`, group, boolean without a name | **O(N)** | `cfh/get-used-names` (CMP-03) |
| `create_group`, `create_boolean`, `move_shapes`, `ungroup` | O(N) worst case | `cfh/order-by-indexed-shapes` walks the layer tree until it has met every id |
| `update_shape` | O(k of the reflow root + d + group siblings) | none; about 1 ms measured |
| `delete_shapes`, `ungroup`, `delete_component` | **O(N)**, all pages when a main loses a shape | interaction scan over `(vals objects)` (`logic/shapes.cljc:321`) |
| `clone_shape`, `instantiate_component` | **O(N)** + k | `get-used-names` (`logic/libraries.cljc:3270`, `types/container.cljc:326`); overrides walk the copy once each |
| Layout ops | O(children) | none |
| `set_text`, `set_text_style`, `apply_typography` | O(nodes); **O(N)** when the text grows automatically | full `objects` to the modifiers (CMP-04) |
| `sync_components` | O(file) per component id | `generate-sync-file` reads every page |
| Colours, typographies, plugin data, flows, guides | O(1) | none |
| Token set, token, theme ops | O(S + T of the set), several times | linear `get-set` / `get-token` (CMP-15); a schema built per token op (CMP-14) |
| `apply_token` | **O(T active)**, plus **O(N)** for size or rotation | `get-tokens-in-active-sets`; full `objects` (CMP-04, CMP-15) |
| `align`, `distribute` | **O(N)** | full `objects` (CMP-04) |
| `import_tokens_dtcg` | O(document), JSON parsed twice, set order O(S^2) | `document-metadata?` (ops:3110) |
| Reflow | once per page: O(N) + the pending subtrees | fine; but see CMP-16 |
| Every op | changes schema-checked twice, applied twice; new shapes validated five or six times | CMP-08 |
| Every call | the operation schema is compiled for the decode and again for the check | CMP-14 |

### 4. Correctness and reliability

See CMP-01, 02, 05, 06, 07, 09, 10, 17, 18, 20. In short: ids and order are deterministic only for the ids the
compiler allocates itself; input data is never mutated; the failing op is always named for errors raised during
an op, but the error type is always `:validation`, even for server faults.

### 5. Best practice

See CMP-21 and CMP-22. Docstrings are good and say why. Schema use is careful for `props` and loose at the top.

### 6. Tests

173 tests, at least one per op, and most assert on outcomes (final shape state after `thf/apply-changes`, which
also runs the file validator). Gaps and the benchmark are in CMP-13.

---

## Findings

### CMP-01: A refused move still runs its side effects, and can delete shapes

- Severity: **high**. Confidence: **confirmed** by reading (not run).
- Location: `ops:1670-1681` (`move-shapes-change`), `ops:1585` (group and boolean), `ops:1760` (ungroup),
  `ops:1741-1743` (clone); `common/src/app/common/logic/shapes.cljc:476-502, 569-610`;
  `common/src/app/common/files/changes.cljc:775-793, 847`; `ops:969-978` (`resolve-parent-id`).
- What is wrong: `cls/generate-relocate` computes its side effects on the belief that the move will happen:
  it strips layout item data, resets constraints, detaches shapes that leave a copy, and deletes source groups
  that would be left empty (`groups-to-delete`). The `:mov-objects` change itself refuses, without an error, a
  move into the shape's own subtree, a move into or out of a component copy, and a nesting loop
  (`is-valid-move?`). The editor filters such ids first (`cfh/clean-loops`, `cfh/is-parent?` in
  `relocate-shapes`). The compiler does not. `resolve-parent-id` also accepts any existing shape as a parent,
  so a rect, text or path can receive children.
- Failure: group G holds only board A, and A holds B. `move_shapes {ids: [A], parent-id: B}` (or
  `parent-id: A`). The move is refused in silence. G is in `groups-to-delete`, so the op emits `:del-obj G`,
  and `ctst/delete-shape` removes G, A, B and everything under them. The call returns success. A second case:
  moving a child out of a component copy detaches it (`ctk/detach-shape`) while it stays in the copy.
  A third: `create_rect {parent-id: <a rect>}` gives a rect with children, which the editor never makes and
  the renderer does not draw.
- Change: before `generate-relocate`, in one shared check: drop or refuse ids whose ancestor is also moved,
  refuse a parent that is one of the ids or under one, refuse moves into or out of a copy (or follow the
  editor's rule exactly), and require the parent to be the root, a board, a group or a boolean. Raise
  `:mcp-invalid-operation`. Add the same parent-type check to `compile-create-op`, `instantiate-change` and
  `clone-change`. Add tests for each case.
- Effort: S to M.

### CMP-02: Every failure becomes a client validation error

- Severity: **high**. Confidence: **confirmed**.
- Location: `ops:3542-3543`, `ops:3574-3577`, `ops:3491-3507`, `ops:3044-3047`.
- What is wrong: `compile-op` and the reflow catch `Throwable` and re-raise as `:type :validation`,
  `:code :mcp-invalid-operation`. That net also takes null pointer errors, class cast errors, stack overflow,
  out of memory, thread interrupts, and database errors: the backend binds `pmap/*load-fn*` around the compile
  (`backend/src/app/rpc/commands/mcp_write.clj:477`), so a lazy page load can fail inside the `try`. The hint
  is `(ex-message cause)`, which may be nil or a raw JVM message.
- Failure: a compiler bug or a database fault during a write reaches the agent as "invalid operation at
  index 7". The agent rewrites a correct operation. The server reports a 400, so no alert fires and the bug
  stays hidden. An interrupt meant to cancel the request is swallowed.
- Change: catch `ExceptionInfo` only. Keep the current mapping for errors whose `ex-data` has a Penpot
  `:type` of `:validation`, `:assertion` or `:not-found`. Re-raise everything else as `:type :internal` with
  `:index` and `:op` in the data, and never catch `VirtualMachineError` or `InterruptedException`. Keep the
  `Throwable` catch only around the DTCG parser, where the comment explains it, and narrow it to
  `AssertionError` plus `Exception`.
- Effort: S.

### CMP-03: A create without a name scans the page, and the scan implements a rule the contract denies

- Severity: **high** (performance). Confidence: **confirmed** for the complexity; the time needs a run.
- Location: `ops:1036-1042` (`shape-name`), used at `ops:1461`, `1563`, `1570`;
  `common/src/app/common/files/helpers.cljc:449-456, 502-509`.
- What is wrong: with no `name` in the op or in `props`, `shape-name` calls
  `(cfh/generate-unique-name base (cfh/get-used-names objects))`. `get-used-names` reads `:name` from every
  shape of the page into a new set, and `generate-unique-name` copies that set again. On the lazy objects map
  this decodes every shape of the page. The result is "Rectangle 1", "Rectangle 2"; the contract (deviation 9)
  says default names are plain, "with no uniqueness suffixes". No test asserts a default name.
- Cost: M unnamed creates on a page of N shapes read N names M times and build 2M sets of N strings. For
  N = 20,000 and M = 2,000 that is 40 million name reads and 80 million set inserts, against about 2 s for the
  tuned `update_shape` path. `bulk-create-300-rects-under-two-seconds` uses unnamed rects on an empty page, so
  it cannot see this.
- The same scan sits in reused editor code, once per op: `instantiate_component`
  (`types/container.cljc:326`), `clone_shape` (`logic/libraries.cljc:3270`), the interaction scan of
  `delete_shapes` (`logic/shapes.cljc:321`), and the layer walk of `order-by-indexed-shapes` in
  `generate-relocate` (`logic/shapes.cljc:459`).
- Change: use the plain base name, as the contract says; that removes the scan. If unique names are wanted,
  keep one name set per page in the state, built on first use and updated on each create, and pass it to the
  editor generators that accept one. Add a test that pins the default name.
- Effort: S for the compiler's own scan; M to cache for the reused generators.

### CMP-04: Three families give the whole page to the modifiers

- Severity: **medium**. Confidence: **confirmed**.
- Location: `ops:2024-2028` (`refit-text`), `ops:3276-3280` (`apply-token-geometry`), `ops:3357-3360`
  (`move-to-changes`); `common/src/app/common/geom/bounds_map.cljc:19-23`; `common/src/app/common/data.cljc:1019`.
- What is wrong: `gm/set-objects-modifiers` starts with `cgb/objects->bounds-map objects`, which builds one
  delay per key of `objects`. `update_shape` avoids this with `modifier-objects` (ops:1600). The text ops,
  `apply_token` with a size or rotation token, `align` and `distribute` pass the full page.
- Cost: 2,000 `set_text` ops on auto-width texts on a 20,000-shape page allocate 40 million delays and build
  2,000 maps of 20,000 entries. `instantiate_component` with text overrides pays it once per override.
- Change: give `modifier-objects` a version that takes several ids (the union of the per-id parts) and use it
  in all three places. The existing subset-against-full tests (`modifier-objects-subset-matches-full-objects`)
  are the right model for the new callers.
- Effort: S.

### CMP-05: Handlers that skip `generate-update-shapes` leave stale applied tokens and skip the editor's fix-ups

- Severity: **medium**. Confidence: **confirmed**.
- Location: `ops:1927-1929` (`set_layout_child`), `ops:1852-1859` (`set_flex_layout`), `ops:1893-1903`
  (`set_grid_layout`), `ops:2095-2097` (`set_text`, `set_text_style`), `ops:2710-2712` (`apply_typography`);
  compare `common/src/app/common/logic/shapes.cljc:28-111` and
  `frontend/src/app/main/data/workspace/shape_layout.cljs:597-627`.
- What is wrong: these handlers call `pcb/update-shapes` directly. The editor goes through
  `cls/generate-update-shapes`, which removes the applied token of every attribute that was set by hand
  (`generate-unapply-tokens`), and applies typography-token rules for text. `update-layout-child` also runs
  `fix-child-sizing` and `fix-parent-sizing` and reassigns grid cells. `update_shape` in the compiler does use
  `generate-update-shapes`, so the compiler is not consistent with itself.
- Failure: a board has a spacing token on its gap. An agent calls `set_flex_layout` with a new gap. The value
  changes but `:applied-tokens` still names the token. The next token propagation in the editor (a theme
  switch, a token edit) writes the token value back over the agent's value. The same holds for a font-size
  token after `set_text_style`, and for typography tokens after `apply_typography`. A child set to `fill`
  inside an `auto` parent keeps a pair the editor would have corrected.
- Change: route these updates through `cls/generate-update-shapes` with the right `:attrs` and
  `:changed-sub-attr`. Move `fix-child-sizing` and `fix-parent-sizing` to `app.common.types.shape.layout` and
  call them from both sides.
- Effort: M.

### CMP-06: The token application port has already drifted from the editor

- Severity: **medium**. Confidence: **confirmed**.
- Location: `common/src/app/common/logic/token_application.cljc:131-140, 245-257, 346-352, 359-368`;
  `ops:3287-3313`; editor side `frontend/src/app/main/data/workspace/tokens/application.cljs:160-171, 287, 427`.
- What is wrong:
  1. `apply-token-to-shape` writes `:applied-tokens` for every applicable attribute, whether or not
     `apply-values` wrote a value. `parse-color` knows hex and `rgb()` only (the editor uses tinycolor). `x`
     and `y` (`ctt/axis-keys`), font family and font weight are never written. So a token resolved to
     `hsl(...)` or a named colour, or a dimension token on `x`, is recorded as applied while the shape keeps
     its old value.
  2. When the attributes do not fit the token type or the shape, the function returns the shape unchanged.
     The op succeeds with no change and no warning.
  3. `value->shadow` calls `uuid/next`, so shadow ids ignore `:new-id-fn`; the namespace docstring says "pure".
  4. `attributes` is `[:vector :string]` and is keyworded with no check (ops:3292).
- Failure: an agent applies a colour token whose resolved value is `hsl(210 50% 40%)`. The result reports
  success; the fill is unchanged; the shape claims the token.
- Change: record only the attributes that were written. Return the written set so the op can add a warning
  (`token-not-applied`) or raise when nothing was written. Take the id function as an argument. Then make the
  frontend call this namespace, so one copy remains.
- Effort: M.

### CMP-07: Geometry steps read attributes that are stale or absent

- Severity: **medium**. Confidence: **confirmed** for the stale read; **suspected** for the JVM error and for
  rotation.
- Location: `ops:1097-1109` (`size-step`, `rotation-step`);
  `common/src/app/common/geom/shapes/transforms.cljc:326-331, 364-369`; `common/src/app/common/math.cljc:204-209`.
- What is wrong: `size-step` compares the wanted value with `(get shape :width)`. `transform-shape` does not
  refresh `:x`, `:y`, `:width`, `:height` on paths and booleans (the report's item 8 names booleans only, and
  only for the read side). So the compiler decides "no change" from a stale number. `rotation-step` reads
  `:rotation`, which the editor's own comment says the WASM transform path does not refresh
  (`frontend/.../modifiers.cljs:150-151`).
- Failure (confirmed by reading): `create_path` gives `:width 100`. `update_shape {width: 200}` resizes the
  selrect to 200 and leaves `:width 100`. A second `update_shape {width: 100}` finds 100 close to 100 and does
  nothing; the path stays 200 wide.
- Failure (suspected): a path drawn in the editor has no `:width`. `(mth/close? 100 nil)` throws on the JVM,
  and CMP-02 turns it into "invalid operation". A test with `(cts/setup-shape {:type :path :content ...})`
  and `update_shape {width}` would settle it.
- Change: read width and height from `:selrect`, as `ctm/change-dimensions-modifiers` already does, and
  derive the current angle from `:transform`.
- Effort: S.

### CMP-08: Each change is checked twice and applied twice; a new shape is validated five or six times

- Severity: **medium** (constant factor on the hot path). Confidence: **confirmed**.
- Location: `ops:890-900` (`commit-builder`), `ops:3516-3526`;
  `common/src/app/common/files/changes_builder.cljc:185-207, 452`;
  `common/src/app/common/files/changes.cljc:191-195, 521-533, 619-622`.
- What is wrong: for one `create_rect` on the JVM the shape passes the shape schema in `cts/check-shape`
  (`pcb/add-object`), in `cfc/check-changes` (`[:obj cts/schema:shape]`) and in `validate-shape` when the
  builder applies the change to its local copy, then in `check-changes` and `validate-shape` again when
  `commit-builder` calls `(cfc/process-changes before changes)` with `verify?` true, then in
  `check-changed-shapes`. The backend then checks and applies the same changes a third time. The report's
  "validation once per shape" holds for `check-changed-shapes` only.
- Cost: the 5,000-shape write measures 1.9 ms per shape. Shape validation is the costly step in each pass.
- Change: call `(cfc/process-changes before changes false)` in `commit-builder`; the builder has checked the
  changes already, and `check-changed-shapes` checks the final shapes. Measure before and after. A larger
  step is a builder option that skips `verify?` in `apply-changes-local`.
- Effort: S.

### CMP-09: `props` can set attributes that the dedicated operations own

- Severity: **medium**. Confidence: **confirmed** that the keys are open; the damage of each key is suspected.
- Location: `ops:699-730` (`structural-prop-keys`, `props-schema`), `ops:1646`.
- What is wrong: the closed `props` schema is the union of the attributes of every shape type, less 16
  structural keys. It still admits `:layout`, `:layout-grid-cells`, `:layout-grid-rows`, `:touched`,
  `:remote-synced`, `:masked-group`, `:interactions`, `:plugin-data`, `:content`, `:bool-type`, `:metadata`,
  `:hide-in-viewer` and the variant keys. It also admits an attribute of one type on another type (a rect with
  `:content` or `:layout`), since the final shape schemas are open maps.
- Failure: `update_shape {props: {layout: "flex"}}` on a board gives a layout with no direction, gap or
  padding, without the child reversal and the constraint drop that `set_flex_layout` does. This is the likely
  source of the nil paddings that the JVM-parity patches defend against. `props: {touched: [...]}` rewrites
  override state; `props: {content: ...}` on a text skips the position-data drop and the refit.
- Change: build the `props` schema per shape type (one closed schema per branch of `cts/schema:shape-attrs`)
  and extend the refused set with the keys that have an op of their own. Name the op to use in the hint.
- Effort: S to M.

### CMP-10: `make_mask` and `remove_mask` only flip the flag

- Severity: **medium**. Confidence: **confirmed**.
- Location: `ops:1790-1802`; editor `frontend/src/app/main/data/workspace/groups.cljs:305-319, 343-348`.
- What is wrong: the editor sets the group's `:selrect`, `:points`, `:transform` and `:transform-inverse` to
  those of the mask shape and calls `pcb/resize-parents`; unmask resizes again. The compiler sets or removes
  `:masked-group` and nothing else, and marks no reflow.
- Failure: after `make_mask` the group keeps the box of all its children. The read tools report that box, a
  flex parent sizes the group by it, and an export of the group uses it, until some later op on a descendant
  happens to resize the group. The test `make-and-remove-mask` asserts the flag only.
- Change: do what the editor does, in a helper in `app.common.logic.shapes` that both sides call, and mark
  the group and its parent for reflow.
- Effort: S.

### CMP-11: Two copies of the modifier and touched rules

- Severity: **medium**. Confidence: **confirmed**.
- Location: `common/src/app/common/logic/modifiers.cljc:28-158`;
  `frontend/src/app/main/data/workspace/modifiers.cljs:66-104, 122-190`.
- What is wrong: `transform-attrs`, `check-delta` and `calculate-ignore-tree` were copied to common. The
  frontend still has its own. The two are equal today. Nothing but `app.common.mcp.operations` and its test
  requires the new namespace.
- Failure: the next change to the touched rules or to the list of transform attributes lands in the frontend
  only. Backend writes then mark component copies touched (or not) by the old rules, and the two writers
  disagree on the same file.
- Change: delete the frontend copies and require `app.common.logic.modifiers` there. Add unit tests for the
  common namespace itself; today it is tested only through the compiler.
- Effort: M (needs a frontend build).

### CMP-12: A schema failure tells the agent where, not what

- Severity: **medium**. Confidence: **confirmed**.
- Location: `ops:575-590` (`check-operations`).
- What is wrong: the error has `:hint "invalid operations"`, `:index` and `:op`, and drops the explain data.
  `props` errors do carry a humanized explanation (ops:774-775), so the two paths differ.
- Failure: `{op: "create_rect", y: 0, width: 1, height: 1}` fails with "invalid operations", index 0. The
  agent cannot see that `x` is missing and must guess.
- Change: build the explainer once, keep the errors whose `:in` starts with the failing index, and put
  `(sm/simplify ...)` of them in the hint or in a `:details` key.
- Effort: S.

### CMP-13: The benchmark is not a sound gate, and important behaviour has no test

- Severity: **medium**. Confidence: **confirmed**.
- Location: `common/test/common_tests/mcp/operations_test.cljc:2489-2535`.
- The benchmark:
  - It measures wall time in a unit test: about 2 s idle against a 5 s limit. It can fail on a loaded
    machine and still pass after a twofold regression. It prints with `println`.
  - It uses 20,000 rects at the root, in a plain map. Root rects are exactly the shapes that
    `reflow-pending-ids` drops and for which the second step of `update_shape` is skipped, so the reflow and
    the attribute step cost nothing in it. It never touches the lazy objects map.
  - `bulk-create-300-rects-under-two-seconds` starts from an empty page, so no scan can show.
- Missing tests:
  - invalid structure: a move into the shape's own subtree, into a copy, under a rect (CMP-01);
  - any use of `:libraries` (instantiate, swap, `apply_typography` and `set_tokens_source` from a library);
  - a page held in the lazy objects map as the compiler input;
  - default names; the mask box; resize of a path twice; `set_flex_layout` on a board with a gap token;
  - schema names against registry names;
  - the same call compiled twice with a counting `:new-id-fn` giving the same changes;
  - an error inside the reflow; a non-validation fault inside an op;
  - the container geometry tests (`ops_test:738-935`) run on the JVM only.
- Change: replace time with counts. Wrap the page objects in a map that counts `valAt` calls and assert an
  upper bound per op; assert the number of shapes passed to the modifiers. Add cases for unnamed creates,
  text ops and `apply_token` on a large page, and for shapes inside a board and inside a layout.
- Effort: M.

### CMP-14: The operation schema is compiled on every call, and a token schema on every token op

- Severity: **low to medium**. Confidence: **confirmed** by reading; the cost needs a run.
- Location: `ops:572-596`, `ops:2864-2872`; `common/src/app/common/schema.cljc:61-74, 222-226`;
  `common/src/app/common/files/tokens.cljc:131-141`.
- What is wrong: `schema:operations` is a raw vector. `sm/decode`, `sm/validate` and `sm/explain` hand it to
  malli, which builds the 75-branch schema and its decoder anew on each call. `decode-operations` also builds
  a new JSON transformer, though one is defined at ops:696. `check-token-value` builds a `:multi` schema and
  validates through it for each `create_token` and `update_token`. The same file takes care to precompile
  the `props` coders.
- Cost: a fixed charge on every call, which matters most for small writes (53 ms p95), and one schema build
  per token in a 300-token write.
- Change: `(def ^:private decode-ops (sm/decoder schema:operations json-transformer))`, a validator and a
  lazy explainer; memoize the token value validator by token type.
- Effort: S.

### CMP-15: Token operations rescan the library

- Severity: **low to medium**. Confidence: **confirmed**.
- Location: `ops:3243-3254` (`token-type-of`), `ops:2736-2755`, `ops:2896-2932`;
  `common/src/app/common/files/tokens.cljc:756-767`; `common/src/app/common/types/tokens_lib.cljc:290-293, 1132-1135`.
- What is wrong: `apply_token` merges every token of every active set into an ordered map to read one type.
  `ctob/get-set` and `get-token-` are linear scans (their own TODO says so), and one `create_token` calls
  them three to five times: set lookup, id check, name check, then the builder and the two applications.
  The id check runs even when the id was just generated.
- Cost: 1,500 `apply_token` ops against 3,000 active tokens merge 4.5 million entries into ordered maps.
  2,000 `create_token` ops into a set of 5,000 tokens scan about 50 million entries.
- Change: look the name up set by set, last active set first, with no merge. Skip the existence check for a
  generated id. Resolve the set once per op and pass it down.
- Effort: S.

### CMP-16: Shapes with no layout in their chain are sent to the reflow

- Severity: **low**. Confidence: **suspected**; a profile of 5,000 creates inside a plain board would settle it.
- Location: `ops:902-908` (`mark-reflow`, called by nearly every handler), `ops:3462-3474`.
- What is wrong: `reflow-pending-ids` leaves out only childless rects and circles at the root. A text at the
  root, or a rect in a plain board or group, goes through `set-objects-modifiers` and
  `calculate-ignore-tree` (one `transform-shape` per descendant per key) though no layout can move it.
- Change: keep an id only when the shape is a layout, or an ancestor up to its reflow root is one.
- Effort: S.

### CMP-17: "Pure" and `:new-id-fn` promise more than the code gives

- Severity: **low**. Confidence: **confirmed**.
- Location: `ops:847, 3545-3567`; `common/src/app/common/types/container.cljc:273`;
  `common/src/app/common/logic/libraries.cljc:2766, 2970, 3022, 3276`;
  `common/src/app/common/types/tokens_lib.cljc:80-90`; `token_application.cljc:249`;
  `changes_builder.cljc:104`; `ops:3476-3489`.
- What is wrong: `:new-id-fn` covers only the ids that `alloc-id` and the token import hand out. The ids of
  copy children, clones, new components, flows and shadows come from `uuid/next`, and tokens, sets and themes
  take `ct/now`. The reflow iterates a map of sets, so the order of its changes follows uuid hash order.
  The namespace docstring and the contract call the compiler pure.
- Failure: a test or a retry that wants the same changes for the same input cannot have them for component
  or clone ops.
- Change: say so in the docstring and the contract, or thread the id function into the generators that
  accept an ids map. Sort the reflow ids.
- Effort: S for the wording, M to thread it.

### CMP-18: `create_boolean` details differ from the editor, and one check is dead

- Severity: **low**. Confidence: **confirmed**.
- Location: `ops:1479-1484, 1527, 1532, 1544-1551, 1554`.
- What is wrong: for `:difference` the head is the bottom child, but the parent and frame come from the
  front child and the index from the head's place in the head's own parent. The editor takes parent, frame
  and index all from the head. With children in two parents the boolean lands at an index that means nothing
  in its parent. `check-children` repeats what `resolve-shape-ids` has already raised for, so it never fires.
  Repeated ids in `child-ids` or `ids` are not refused. Children inside a component copy are not filtered,
  as the editor does with `has-any-copy-parent?` (this part overlaps CMP-01).
- Change: take parent and frame from the head; delete `check-children`; refuse repeated ids.
- Effort: S.

### CMP-19: The text size estimate ignores what it knows

- Severity: **low**. Confidence: **confirmed**. Adds to the report's open item 7.
- Location: `ops:1078-1089, 2009-2022, 1993-1999`.
- What is wrong: for `:auto-height` the width is fixed and known, yet the height is 1.2 em times the number
  of explicit line breaks. `:line-height` and `:letter-spacing` of the content are not read, and the font
  size comes from the first text node only.
- Failure: 400 characters in a 200 px wide auto-height text at 14 px get one line (16.8 px) where about 17
  lines are needed. In a flex column every later child sits about 270 px too high until a browser opens the
  file.
- Change: for `:auto-height`, count `ceil(0.6 * size * chars / width)` lines per paragraph, and use the
  node's `:line-height` when it is set.
- Effort: S.

### CMP-20: The JVM-parity patches are point fixes in shared layout code, tested by smoke

- Severity: **low**. Confidence: **suspected**.
- Location: `common/src/app/common/geom/shapes/flex_layout/layout_data.cljc:151-157, 234-247, 374-396`;
  `flex_layout/positions.cljc:48-66, 101-126`; `grid_layout/layout_data.cljc:102-106, 376-399, 517-538`;
  `common/test/common_tests/geom_flex_layout_jvm_test.cljc`.
- What is wrong:
  1. The guards change ClojureScript results too. A single child with `space-between` used to get a gap of
     Infinity or NaN and now gets the layout gap; a grid span with zero flex total used to divide by zero.
     The new values look right, but the editor's output for these cases changed and no frontend test was run.
  2. Hazards of the same kind may remain. `(pos? value)` at grid `layout_data.cljc:399` throws on the JVM
     for a flex track with a nil value in old data (the compiler fills the value, the editor's files may not
     have it). `=` between a long and a double is false on the JVM and true in ClojureScript; one such case
     was fixed (`zero? free-frs`), and the rest of the layout code was not searched.
  3. Most tests assert "does not throw" and "finite". None compares the numbers of the two runtimes.
- Change: keep a small set of layouts with expected child boxes as data and assert them on both runtimes.
  Search the layout namespaces for `(= x 0)` on computed values.
- Effort: M.

### CMP-21: Registration in three places; one namespace for eight families

- Severity: **low**. Confidence: **confirmed**.
- Location: `ops:213-573, 3385-3460`, each `compile-*-op`; `ops:573` and
  `backend/src/app/rpc/commands/mcp_write.clj:49` (the limit 2000 twice); `ops:206` (500).
- Proposal, if the file keeps growing:
  - `app.common.mcp.operations`: `compile-operations`, the state, `commit-builder`, reflow, errors.
  - `app.common.mcp.operations.schema`: the groups, the op schemas, decode and check.
  - `app.common.mcp.operations.refs`: `resolve-*`, `alloc-id`, handles.
  - One namespace per family: `shapes` (create, update, structure, groups), `layout`, `text` (with font
    variants), `components`, `library` (colours, typographies), `tokens`, `prototype` (interactions, flows,
    guides, plugin data), `arrange`.
  - Each family exports a map `{"op_name" {:schema [...] :compile fn}}`. The top namespace merges the maps
    and derives both the `:multi` schema and the dispatch from them. An op is then declared once, the second
    `case` goes away, and a schema entry without a handler cannot exist.
- Worth it? Not as a goal in itself. Do it when the next family (variants) lands, or together with CMP-01
  and CMP-05, which touch most handlers anyway. Until then, add one test that the schema names equal the
  registry names.
- Effort: M, mostly mechanical.

### CMP-22: Smaller points against the project's conventions

- Severity: **low**. Confidence: **confirmed**.
- `mem:clojure/design-rules` asks that functions which obtain data start with `get-`. `page-of` (ops:924),
  `page-objects` (928), `libraries-of` (856), `file-record` (850), `state-token-lib` (2722),
  `token-type-of` (3243), `typography-source` (2680) do not.
- `critical-info` asks for aligned `let` values. Many handlers are not aligned (ops:1450-1470, 1522-1586,
  1672-1678, 1716-1746, 1845-1859), while others are (ops:1640-1665).
- `resolve-board-id` (ops:1819) and `resolve-board` (ops:2123) do the same thing with two messages.
- `without-keys` (ops:1026) and `strip-geometry` (ops:1022) are `(apply dissoc m ks)`.
- `props-schema` (ops:706-727) walks `cts/schema:shape-attrs` by position: multi, then merge, then map
  entries. A change in how the shape schema is nested breaks it at load, or drops attributes without a word.
  Add a test on the resulting key set.
- `token_application.cljc:11` says the port is "without re-frame"; Penpot uses potok.
- `(str number)` gives "16.0" on the JVM and "16" in ClojureScript for a double (ops:1365, 2031-2038);
  `weight-str` guards against this, font size, line height and letter spacing do not.
- `document-metadata?` (ops:3110) parses the whole document again to test one key.
- Effort: S.

---

## Strengths worth keeping

- The editor's generators do the hard work. Relocate, delete, duplicate, component and token logic are
  called, not rewritten.
- One working copy and one fresh builder per op. Later ops see earlier results, and `:op-ranges` lets the
  backend cut batches and name the failed op.
- All geometry goes through the modifiers, so children, constraints and touched flags follow.
- `modifier-objects` with tests that compare the subset against the full page, change for change. This is
  the right way to prove an optimisation.
- `check-changed-shapes` validates the final state once per changed shape, with a readable hint.
- The closed `props` schema with per-key coders built once.
- The tests apply the compiled changes through `thf/apply-changes`, which runs the file validator, and they
  assert on the resulting shapes, not on the shape of the changes.
- The font variant rules, with errors that list the valid ids.
- The layout tests assert that output numbers are doubles or integers, so ratios are watched for.
- Docstrings and comments say why (the page move index, the flex reversal, the grid order).

## Questions only a run could settle

1. How long do 2,000 unnamed `create_rect` ops take on a 20,000-shape page (CMP-03), and 2,000 `set_text`
   ops on auto-width texts on the same page (CMP-04)?
2. Does the CMP-01 scenario delete the group as the reading says? One test with
   `move_shapes {ids: [A], parent-id: B}` settles it.
3. What is the fixed cost of the schema build per call (CMP-14), and what does `verify? false` in
   `commit-builder` save on the 5,000-shape write (CMP-08)?
4. Does `update_shape {width}` on an editor-drawn path throw on the JVM (CMP-07)?
5. How many shapes of a lazy objects map does each op family decode? A counting wrapper would give the
   number per op.
6. Does any emitted change hold a `clojure.lang.Ratio`? `::sm/safe-number` accepts one
   (`schema.cljc:868-881`), and `Rect` and `Point` are untyped records. The layout outputs are tested; the
   outputs of `align`, `distribute` and integer-only inputs through the whole compiler are not. A walk over
   `:changes` asserting long or double would close it.
7. Do the frontend layout results change for a single child with `space-between`, and for grid tracks with
   a zero flex value (CMP-20)?
8. How much of the final reflow time goes to shapes that no layout can move (CMP-16)?
