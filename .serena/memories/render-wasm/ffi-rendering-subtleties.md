# render-wasm FFI and Rendering Subtleties

## FFI state and errors

- The renderer uses one unsafe global `STATE`; the `with_state*` macros currently panic on invalid state pointer. Treat state pointer validity as critical, not recoverable.
- `#[wasm_error]` clears the error code on entry. Recoverable errors set code `0x01`, critical errors/panics set `0x02`, free the byte buffer, then panic so the CLJS bridge can catch and inspect `_read_error_code`.
- The frontend bridge maps `0x01` to `:non-blocking` and `0x02` to `:panic` in ex-data (`:type :wasm-error`). Check actual bridge code if changing names; older comments/docs may use different labels.
- WASM byte transfer is a single global slot. A caller that receives a pointer result must read and free it before another byte payload is written; errors free the slot via `#[wasm_error]`.

## Shape pool and loading

- Shapes are UUID-indexed, and hierarchy/structure is tracked separately. `ShapesPool::get` may return a cached modified clone when modifiers, structure, scale-content, or bool handling apply; `get_raw` bypasses those derived values.
- Bulk loading uses a `loading` flag. `touch_current` / `touch_shape` avoid tile invalidation while loading; text layouts and final view setup must happen after loading ends.
- Many setters mutate only the current shape selected by `use_shape` / current-shape APIs. If no current shape is selected, some mutation blocks are skipped silently.
- `set_parent_for_current_shape` only sets parent metadata and invalidates parent geometry; children must be updated separately to avoid duplicate children.
- Child deletion marks descendants deleted and removes them from all indexed tiles, preserving undo/redo while avoiding stale pixels after panning.
- `:render-wasm-worker-upload` flag: `app.render-wasm.upload-pool` workers decode and encode a workspace page of >= 3000 shapes in a lazy `ObjectsMap`, over a raw JS-object protocol (not transit).
- `app.render-wasm.upload-entry/encode-entry` builds one entry per shape; `apply-entries!` replays entries with the same WASM calls and bytes as `process-shapes-chunk` (`frontend-tests.render-wasm.worker-upload-replay-test` compares the call logs).
- Any change to `set-object-host-attrs`, `serialize-shapes-batch` or `upload-text-content!` must be mirrored in `encode-entry` and `apply-entry-host-attrs`.
- Host 1 shapes (svg-raw with content, grid layout, text without content) keep their host attrs on the main thread; their entries carry no text or image data.
- Dirty rule: an id keeps its worker entry only while its raw `ObjectsMap` string is `identical?` to the one at load start. Any other id (changed, or raw value nil) is encoded on the main thread from the current page, or dropped when gone.
- Worker failure before the hints are attached falls back to `set-objects-async`; after that, the remaining chunks are encoded on the main thread.
- Store keeps faces across page switches, so a later page has no pending face for them. `sync-text-selrects-after-load!` checks exactly the texts that use a face the session fetched (`f/font-fetched?`) and no pending face. Texts using only the built-in face or a failed face stay unchecked, as upstream; widening this makes opening a file commit resizes upstream does not make. A page with a resize still waiting is not stashed.

## Tile/render behavior

- Raster `Fill::Image`: skip `save_layer` unless the shape has an image filter; plain
  Rect/Frame (no corners) also skip the container clip (`draw_image_fill` in fills.rs).
- `can_render_directly` paints onto Current (no Fills/Strokes blit) for plain geometry and
  for stroke-free text (SrcOver, no blur/shadows). Multi-style text is fine: span styles
  live in Paragraph `TextStyle`s. Text skips the `nested_fills` guard (fills are on spans).
  `draw_text` only `save_layer`s when stroke-group opacity is set; plain fill paint is direct.
- Plain text fill paint reuses `TextContent.layout` paragraphs when
  `has_usable_paint_layout` (paragraphs present + version match; during
  interactive transforms rotation/move skips width check via
  `modifier_changes_text_layout`, resize falls back to `layout_width` vs
  `get_width(selrect.width())`), via `text::try_paint_from_layout_cache`.
  The walker computes `text_layout_cache_rotation_only` from `tree` and
  passes it into `render_shape`; stroke/shadow paths pass `false`.
- `TextContentLayout` paragraphs are `Rc`-shared on `Clone` so modifier clones
  (rotate/pan) keep the paint cache; `needs_update` is paragraphs-empty only.
  Decorations are skipped when no span requests underline/strike.
- Zoom settle: visible tiles present via `FrameType::ViewportReady` before interest-ring
  work; crop-cache rebuild is deferred to the later `Full` so the soft→sharp snap is
  compose+present only.
- Interactive transforms are distinct from viewport fast mode. `set_modifiers_start` enables fast mode and interactive transform; interactive transform still flushes each animation frame.
- Drag crops: a stationary root crop stays in use while moved content overlaps it only if
  both crops are opaque (`Shape::is_opaque_for_drag_crop`: square axis-aligned board/rect,
  opaque solid fill, no strokes) and no moved shape was inside it before moving; roots in
  `modified_roots` (structure/scale edits inside) always render live
  (`stationary_crop_usable`).
- Preserve-target renders over an unchanged view (shape edits, text-editor keystrokes,
  `SyncTiles`) run in one call (`progressive_render_allowed`): the caret overlay waits on
  `render-pending?` and the next keystroke would restart a yielding render. Pan/zoom ends
  (`view_moved_since_render`) and interactive transforms yield.
- During interactive transform, modifier tile invalidation is deferred to `render()` once per rAF. Outside interactive transform, `set_modifiers` rebuilds modifier tiles immediately.
- `set_modifiers_end` disables fast/interactive state and cancels pending async render; the caller must request the final full-quality render.
- Plain viewport fast mode (`options.is_viewport_interaction()`) renders from cache and does not flush target output inside `process_animation_frame`; interactive transforms do flush.
- Zoom settle wipes the tile texture cache in `set_view_end`. Mid-zoom overlays
  key tiles by scale; shape edits must `invalidate_cached_tiles_intersecting`
  the old∪new extrect so those overlays do not keep pre-edit pixels.
- Partial tile repaint: outside interactive transforms, `invalidate_cached_tiles_intersecting`
  turns a cached tile stale (`TileTextureCache::mark_stale`: out of the cache, slot and
  pixels kept, changed doc rect joined) instead of evicting it. The tile walk then repaints
  only the shapes reaching the changed pixels and copies the rest back from the old slot
  (`copy_stale_slot_outside`, `BlendMode::Src`). `begin_partial_tile` sets
  `render_area_with_margins` to the changed pixels plus `AA_REACH_PX`; in partial mode every
  node is culled by extrect (own effects and ancestor layer blur), grown by
  `shape_paint_reach` (glyphs of texts, miter joins of stroked paths and bools); containers
  and roots by the largest `shape_paint_reach` under the tile's roots (`RootPaint`, cached
  per root). Whole repaint when the change covers > 75% of the
  tile, slots are packed (< 512 px), in fast mode / viewer / include filter, or a root on the
  tile holds a visible background blur or raw SVG (`RootPaint::whole_tiles`). An atlas
  repack forgets the in-flight tile and makes the next render start over. Anything a shape
  paints outside its extent must be in both the dirty rect and the cull test, or stale
  pixels survive next to the change.
- Edit dirty rect = prev∪new extrect, each grown by `shape_paint_reach`, all by `AA_REACH_PX`,
  then by ancestor drop shadows (`with_ancestor_drop_shadows`). A filled frame with a drop
  shadow draws it by a path that depends on its descendants; when that path switches
  (`switched_shadow_containers`, last path per container in `shadow_paths`, unknown counts
  as switched) its whole extrect is dirtied. The indexed tiles join only when no prev extent
  is known (nested shapes can stay indexed at an older zoom's scale). Touch before mutating
  so the prev extent is recorded (`update_shape_text_layout_for`). `touch_shape` grows the
  recorded prev extent by the old shape's `shape_paint_reach`, since that shape is gone
  after the mutation.
- `set-guides` (CLJS) skips the call when guides and their boards are unchanged:
  `_set_guides` presents a frame, and the viewport called it on every commit.
- Component thumbnails (`thumbnails-wasm/render-thumbnail`): UI renders run inside an idle
  turn (`wait-idle-turn`: one at a time in request order, in an idle period with no canvas
  render pending, or after `idle-turn-timeout-ms` = 3 s between frames; a turn given up early
  still releases the next one in order). `:persist?` renders skip the queue (own setTimeout
  task) so a file close does not lose them. Off-page components are uploaded into the live
  pool with `set-objects`, so that path taints the resident page (`page-cache/taint-resident!`).
  `render_shape_to_export_image` saves and restores the canvas render state.
- Pending tile priority is intentionally reversed by pop order; check the queue construction before changing tile scheduling.
- Frames with a fill may use `render_frame_container_drop_shadow` (direct rrect +
  blur saveLayer on `DropShadows`) when `uses_direct_container_drop_shadow` is true.
- Imposters (`render/lod.rs`, `try_draw_board_imposter`): root boards under
  `imposter_max_screen_px` (256 device px), scale <= 0.5, >= 24 visible descendants. After a
  full-quality tile walk, `capture_tile_imposters` copies each walked board's pixels out of
  `Current` (key: board, tile, scale bits, background) unless another root shape painted in
  the tile touches them. Later renders of that tile copy them back 1:1 (`BlendMode::Src`) when
  nothing painted earlier touches them, so the settled image is bit-identical to a direct walk
  whatever is cached. Never resample or build boards off-tile: that broke determinism. No
  captures in fast mode, interactive transforms or partial tile repaints. Evicted per root
  board via `mark_imposter_dirty`; cleared on context loss, loading, page restore and
  `rebuild_tiles_from`. Boards with pending modifiers are walked live. Off in export, viewer,
  focus mode, include filter and preview. Frontend flag `render-wasm-board-thumbnails`.
