# Design: scrolling boards in the viewer

Status: proposal for a decision. Branch `perf/render-wasm-large-files`. Nothing here is built.

## The decision

A board can now carry `:overflow-scroll` (`none`, `horizontal`, `vertical`, `both`). The workspace, the plugin API, the MCP and the CSS code generator know it. The viewer does not: a prototype of a scrolling list shows a cropped list. The schema comment says so (`common/src/app/common/types/shape.cljc:288-291`), and so does the tooltip in `frontend/translations/en.po:7930`.

Recommendation, in short: build vertical and horizontal scrolling of a non-rotated board in the SVG viewer, by moving the board's children with a `transform` inside the existing clip. When the viewer runs on the wasm renderer, draw a board that holds a scroller through the SVG path instead. Raise the attribute and this behaviour upstream before merging either, because the attribute itself is not upstream yet (`git show develop:common/src/app/common/types/shape.cljc` has no `overflow-scroll`).

## How the viewer draws a board today

### From the page to the SVG

1. `viewer-content*` (`frontend/src/app/main/ui/viewer.cljs:291`) picks the current root board by `index` from `(:frames page)` and computes its `size` with `calculate-size` (`viewer.cljs:55-66`). The size covers the board plus room for shadows, blur and strokes, scaled by `zoom`.
2. `viewer-wrapper` (`viewer.cljs:224-289`) places the board in a `div.viewport-container`, plus a second one for the board we come from during a navigate animation (`orig-frame`), plus one `viewer-overlay` per open overlay (`viewer.cljs:151-222`).
3. Each of these renders `interactions/viewport*` (`frontend/src/app/main/ui/viewer/interactions.cljs:129-191`). It picks `viewport-wasm*` or `viewport-svg*` (`interactions.cljs:141-142`, `177-191`).
4. `viewport-svg*` (`interactions.cljs:32-127`) moves every shape of the board so that the board sits at the origin of the view box (`vpc/prepare-objects`, `frontend/src/app/main/ui/viewer/viewport_common.cljs:17-26`). It then builds the shape tree with `shapes/frame-container-factory` (`frontend/src/app/main/ui/viewer/shapes.cljs:473-487`).
5. Every shape goes through `generic-wrapper-factory` (`shapes.cljs:368-433`). It wraps the shared renderer (`frontend/src/app/main/ui/shapes/*`) in a `g` that carries the pointer handlers of the shape's interactions, and draws the highlight rect of `interaction` (`shapes.cljs:282-295`).
6. A board is drawn by `frame-shape` (`frontend/src/app/main/ui/shapes/frame.cljs:177-194`) inside `frame-container` (`frame.cljs:60-123`).

### Clipping

All boards of a screen live in one SVG. `shape-container` writes a `clipPath` per board (`frontend/src/app/main/ui/shapes/shape.cljs:137`, `frame.cljs:31-56`): a rect or path with the board's `transform`, so a rotated board clips correctly. In `frame-container` the clip applies to a `g` holding the board's fills and its `g.frame-children` (`frame.cljs:106-118`). The board's own strokes are drawn after, outside the clip (`frame.cljs:120-123`). Shadows and blur are filters on wrapping groups, so the clip does not cut them (`frame.cljs:95-106`). A board with `:show-content true` has no clip.

### What already scrolls

- **The whole screen.** `section#viewer-section` has `overflow: auto` (`frontend/src/app/main/ui/viewer.scss:66-75`). A board taller or wider than the window scrolls with the browser's own scrolling. Wheel with the mod key zooms instead (`interactions.cljs:150-159`). The wheel handler in `viewer.cljs:386-408` acts only in inspect mode.
- **Scroll on navigate.** A navigate action resets the section's scroll to 0, or keeps it when `:preserve-scroll` is set (`shapes.cljs:58-66`). The value goes through `set-nav-scroll` (`frontend/src/app/main/data/viewer.cljs:592-597`) and an effect in `viewer.cljs:457-464`.
- **"Fix when scrolling".** A shape with `:fixed-scroll true` stays put while the section scrolls. `cfh/fixed-scroll?` accepts it only when its parent is a board and that board is not the root (`common/src/app/common/files/helpers.cljc:831-836`). The workspace sets it in the constraints menu (`frontend/src/app/main/ui/workspace/sidebar/options/menus/constraints.cljs:27`).

The fixed mechanism needs care, because the new feature must not break it:

- `vpc/get-fixed-ids` (`viewport_common.cljs:28-42`) collects every fixed shape of the page, their descendants and their ancestors. Note that this includes fixed shapes inside nested boards.
- SVG path: `viewport-svg*` draws the board twice (`interactions.cljs:104-127`). The first SVG holds the fixed shapes and their ancestors, with the board's fills removed (`interactions.cljs:86-89`), and has class `.fixed`, which is `position: fixed` (`frontend/src/app/main/ui/viewer/interactions.scss:80-87`). The second SVG holds the rest. When the section scrolls, the browser keeps the first SVG in place. The code calls this an emulation of CSS `sticky`.
- wasm path: `viewport-wasm*` (`frontend/src/app/main/ui/viewer/viewport_wasm.cljs:88-165`) renders two canvases with include masks (`viewport_wasm.cljs:67-86`). It does not use `position: fixed`; `use-fixed-scroll-sync!` translates the fixed layer by the section's scroll on every `scroll` event (`frontend/src/app/main/render_viewer_wasm.cljs:202-219`).

### When the viewer uses wasm

`viewport*` takes the wasm path when the feature `render-wasm/v1` is on and the flag `:available-viewer-wasm` is set (`interactions.cljs:141-142`). Both flags are in the default list (`common/src/app/common/flags.cljc:250` and `:257`), but so is `:render-switch` (`flags.cljc:252`). With `:render-switch`, the renderer comes from the user's profile and defaults to `:svg` (`frontend/src/app/main/features.cljs:35-58`). An anonymous viewer of a shared link has no profile, so it gets SVG. A user who chose wasm, or a URL with `?wasm=true`, gets the wasm canvas. In wasm mode the pixels come from one offscreen render of the board (`render_viewer_wasm.cljs:148-200`), serialised through one global queue (`render_viewer_wasm.cljs:22-30`), and the clickable areas are transparent SVG rects drawn on top (`viewport_wasm.cljs:27-44`, `shapes.cljs:297-366`).

### Thumbnails and exports

The viewer's thumbnail strip draws boards with `render/frame-svg` (`frontend/src/app/main/ui/viewer/thumbnails.cljs:117`), not with the viewer's components. The exporter and board thumbnails use the same `app.main.render`. Both share `frame.cljs`, so any change there must default to "no offset".

## What scrolling a nested board needs

A scrolling board needs: an offset per axis; a range for it (from 0 to the content's extent minus the board's size); input (wheel, touch, drag); content that moves under a clip that does not; hit-testing that follows the content; and the unscrolled state everywhere outside the viewer.

### Option A: an HTML scroll container per scrolling board

The board's children render in their own `svg`, inside a `div` with `overflow: auto`, laid over the parent.

- **Render tree.** The tree must split at each scroller. Shapes drawn after the scroller in its parent must go into a third layer above it, or they end up below it. Every nested scroller splits again. This is a rewrite of how `viewport-svg*` builds the tree.
- **Clipping.** Ancestor clip paths do not reach the `div`. It needs a CSS `clip-path` computed from each clipping ancestor.
- **Shadows, blur, strokes.** The board's own fills, strokes and shadow must stay in the parent layer and the children in the `div`, so the board is cut in two.
- **Rotation.** A CSS `transform` on the `div` works, but the split layers must match the SVG's transforms exactly.
- **Fixed shapes.** Each layer must be drawn twice again for the fixed emulation.
- **Input.** Native: wheel, touch, momentum, keyboard and scroll chaining come free.
- **wasm.** Each layer would need its own canvas render. The include masks exist (`render_viewer_wasm.cljs:81-96`), but the z-order split does not.
- **Cost.** Large. It breaks where siblings overlap the scroller, which is common (a header over a list, a scroll bar drawn as a shape).

### Option B: one SVG, children moved by a transform

`frame-shape` wraps `g.frame-children` of a scrolling board in a `g` with `transform="translate(-x -y)"`. The clip group around it stays still (`frame.cljs:107`), so the content moves under the clip.

- **Render tree.** No split. The offset comes from a React context that only the viewer provides; elsewhere it is nil and nothing changes. Thumbnails and exports keep the unscrolled state for free.
- **Hit-testing.** SVG hit-testing follows transforms and does not reach clipped-out parts. Pointer handlers, the `cursor` and the highlight rects live in the moved `g`, so they follow.
- **Shadows, blur, strokes.** The board's own strokes and shadow stay in place. A child's shadow is clipped at the board edge, as today.
- **Rotation.** The offset is along the board's own axes. For a rotated board the translation is the offset run through the board's `transform` matrix. That is a few lines, but it needs tests.
- **Nested scrollers.** Transforms nest. Input goes to the innermost scroller that can still move in that direction, then to its parent, then to `viewer-section`.
- **Fixed shapes.** The board may be drawn in both the fixed and the not-fixed SVG, so the offset must live in shared state keyed by board id, not in the DOM. A `:fixed-scroll` child of a scrolling board must not take the offset, so the wrapper goes per child, not around all children.
- **Overlays.** An overlay board renders through the same `viewport*`, so it scrolls too. An overlay placed relative to a shape inside a scrolled board is placed at the unscrolled position, because `ctsi/calc-overlay-position` (`common/src/app/common/types/shape/interactions.cljc:494`) reads stored geometry.
- **Input.** All by hand: wheel with `passive: false` and `preventDefault` only when the scroller can move; touch and pointer drag; no momentum unless we write it.
- **The click problem.** A click interaction fires on `pointerdown` (`shapes.cljs:227-235`). A touch drag that starts on a list row would navigate before it scrolls. Inside a scroller, click interactions must move to `pointerup` with a small movement threshold. This applies to every option; native scrolling does not fix it either.
- **wasm.** The pixels come from a snapshot. To scroll, the board must be rendered again with the children moved. `render-viewer-frame*` reuses the uploaded shapes when the page is the same (`render_viewer_wasm.cljs:162`, `175-180`), so moved objects would not reach the renderer without the modifier API (`frontend/src/app/render_wasm/api.cljs:3400`). Each step is a full render through the global queue.
- **Cost.** Small to medium on the SVG path. The wasm path is a separate piece of work.

### Option C: `foreignObject`

A `foreignObject` in place of the board's children, holding a `div` with `overflow: auto` and an inner `svg`.

- **Render tree.** It stays in the tree, so z-order and ancestor clip paths hold.
- **Input.** Native, as in option A.
- **Where it breaks.** WebKit has long-standing bugs that misplace `foreignObject` content under transformed ancestors, and the viewer moves every shape. The inner SVG is a new root, so the zoom and `render-id` contexts and the `defs` it refers to need checking. The fixed emulation draws the board twice, so two native scrollers must be kept in step. A rotated scroller depends on the same WebKit behaviour. The wasm path is as hard as in option B.
- **Cost.** Medium, with a browser risk we cannot remove.

## Recommendation

Build option B on the SVG path.

**First slice:**
- Scroll on the axes `:overflow-scroll` names, for a board that clips content (`:show-content` not true) and is not rotated. Rotated boards keep today's crop.
- Wheel (shift+wheel for horizontal) and touch or pointer drag. No momentum.
- Range: from 0 to the bottom (or right) edge of the children's selrects minus the board's size. Content above or left of the board stays out of reach, as it is today.
- Click interactions inside a scroller fire on `pointerup` when the pointer moved less than a few pixels.
- Offsets reset on every navigation, on a page change and on the "go to first board" button. `:preserve-scroll` keeps only the section's scroll, as today.
- No scroll bars beyond any the designer drew. A shape drawn as a scroll bar does not move unless it is a child of the board.
- On the wasm path, `viewport*` draws a board that holds a scroller through `viewport-svg*`. That screen then shows the SVG renderer's known differences (linear gradients on non-square boxes, grid stacking order).
- A `:fixed-scroll` child of a scrolling board does not take the board's offset and keeps today's page-level pinning.

**Left out:** rotated scrollers; keyboard scrolling (the arrow keys already move between boards, `frontend/src/app/main/data/viewer/shortcuts.cljs:69-76`); momentum and overscroll; overlays placed relative to a scrolled shape; comment pins over scrolled content (they keep board coordinates); wasm-native scrolling; the inspect tab (it already shows `overflow` in CSS).

**Data model.** The existing attribute is enough for the slice. Later options, each a new optional board attribute: a scroll bar style (hidden, overlay, always); an initial offset; snap points or paging; and a "scroll to" action (Figma has one). Figma stores the same idea as the node property `overflowDirection` (none, horizontal, vertical, both), so an importer maps it one to one. I have not checked Figma's exact enum spelling against its current docs.

## Files, size and risks

| File | Change | Size |
|---|---|---|
| `frontend/src/app/main/ui/shapes/frame.cljs` | Wrap each child of a scrolling board in an offset `g` when a viewer context gives an offset | Small |
| `frontend/src/app/main/ui/viewer/scroll.cljs` (new) | Offset state per board id, range from children selrects, wheel, touch and drag handling, chaining to `viewer-section` | Medium |
| `frontend/src/app/main/ui/viewer/interactions.cljs` | Provide the context in `viewport-svg*`; SVG fallback in `viewport*` when the board holds a scroller | Small |
| `frontend/src/app/main/ui/viewer/shapes.cljs` | Clicks inside a scroller on `pointerup` with a threshold | Small to medium |
| `frontend/src/app/main/data/viewer.cljs` | Reset offsets in `go-to-frame`, `go-to-frame-by-index` and on page change | Small |
| `frontend/src/app/main/ui/viewer/interactions.scss` | `touch-action` on scrollers | Small |
| `common/src/app/common/types/shape.cljc:288-291`, `frontend/translations/en.po:7930`, `docs/user-guide/prototyping-testing/prototyping.njk:203` | Drop "does not scroll yet"; document the behaviour | Small |

Total: medium. A rough guess is one to two weeks for one engineer who knows the viewer, review included.

Main risks:
- **Offset state and render cost.** A store update per wheel event re-renders every viewer viewport. Set the `transform` through the DOM, as `use-fixed-scroll-sync!` does, and keep the store for resets.
- **The pointer-down change.** Moving clicks to `pointerup` inside scrollers changes timing for `:mouse-press` pairs and for nested shapes. The existing test of a child click under a parent with `mouse-leave` (`frontend/playwright/ui/specs/viewer-content.spec.js:14-46`) must still pass.
- **`touch-action` on SVG elements.** I am not sure every browser honours it on a `g`. The fallback is a non-passive `touchmove` listener that calls `preventDefault`.
- **The fixed layer.** A scroller that is an ancestor of a fixed shape is drawn in both SVGs, and both must move together.
- **The wasm fallback.** It mixes renderers in one session. Upstream may not want a new reason to bypass wasm.

## Tests

- **Unit** (`frontend/test/frontend_tests/`): the range from children, the rotated-matrix helper even if unused in the slice, the chaining rule, and that `frame-shape` adds no `g` without the context. The tests in `frontend/test/frontend_tests/ui/shapes_per_side_stroke_test.cljs` show how to render a shape and read the markup.
- **Component:** a viewer viewport with a scrolling board: the offset `g` exists, the fixed child has none, and the fallback picks SVG when the wasm flags are on.
- **End to end:** view mode has Playwright specs with mocked bundles (`frontend/playwright/ui/specs/viewer-content.spec.js`, `frontend/playwright/ui/pages/ViewerPage.js`, fixtures under `frontend/playwright/data/viewer/`). Add a fixture with a vertical list board. Check that a wheel over the list moves a row into view and does not scroll the section; that a wheel at the end scrolls the section; that a click on a scrolled row navigates; that a short drag does not; and that the offset resets after navigation.

**Not verifiable on this machine:** anything on the wasm path. There is no emsdk here, so the wasm renderer cannot be built, and neither the fallback in a real wasm session nor a future wasm-native scroll can be seen. Touch input also needs a real device or Playwright's touch emulation, which is weaker than a phone.

## Upstream first

This is Penpot's viewer, the surface every shared prototype link uses, and the attribute it reads is not upstream. Merging it only here would fork the file format and the viewer's behaviour. Raise one proposal that covers the attribute (already built here) and the viewer slice, with this document as the design.

A maintainer upstream would likely ask:
- Why not wasm first, since the renderer is moving there? Answer: the SVG path is the default for shared links today; the wasm work needs the modifier path and a toolchain.
- Whether `overflow-scroll` belongs on the board or should come with Figma's other prototype settings (fixed children, scroll behaviour) as one group.
- Whether click on `pointerdown` can change for all shapes, not only inside scrollers.
- How it affects the Figma importer they maintain outside this repository.
- Naming of the attribute and its values, and the workspace UI ("Scrolling" select in the measures options).
