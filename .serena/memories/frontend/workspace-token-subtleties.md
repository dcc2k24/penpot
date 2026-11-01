# Frontend Workspace Token Subtleties

## Token refs and visibility

- Workspace token refs intentionally hide the internal hidden theme from theme trees/lists and expose active tokens through `get-tokens-in-active-sets`.
- Token values stored on shapes are token names under `:applied-tokens`, not token ids. Renames/group renames must update those paths in common token logic.

## Token application

- Token application refuses to run while a text shape is in text-editing mode and shows a warning instead.
- Applying a token writes token names into shape `:applied-tokens`, resolves active tokens through Style Dictionary or `tokenscript` depending on feature flags, updates concrete shape attrs, and wraps the operation in an undo transaction.
- Applying composite typography removes atomic typography token attrs; applying atomic typography removes the composite typography token attr.
- Spacing tokens have a special split path: layout containers receive gap/padding updates, while immediate children of layouts receive margin updates.

## Propagation

- Token propagation (`propagate-workspace-tokens`) resolves active tokens and walks the current page first, then the other pages, in steps with pauses, so other events interleave. Invariants that keep this safe: run commits use `:save-undo? false` and `finish-run` adds one undo entry at the end (plus the event-path updates in the same transaction); `dwu/lock-undo` refuses undo/redo while a run is active; shapes are re-read when built (stored ids only); `watch-component-changes` holds component changes while `dwtp/running?` and replays them once per component after `::propagation-done`; a newer run or a tokens change closes the active run (`supersede-run`, `tokens-changed?`); `finish-propagation` completes it at once and is emitted before the workspace closes and before version snapshots; the run is in `st/ongoing-tasks`.
- Fills, stroke colours, radius, opacity, stroke widths and shadows (`fast-actions`) are built with the changes builder (`update-shapes*` mirrors a buffered `dwsh/update-shapes`) and committed in chunks (about 20 ms reading shapes, 60 ms building, read-but-unbuilt shapes wait in `:pending`), yielding with a 0 ms timer between steps; files under 50 shapes never yield. Pages are walked depth first from the root (viewport boards first on the current page) so each commit touches few boards; every 2 s a run sends `::dps/force-persist` so saves are spread out. On the current page each commit still costs a wasm re-render of the viewport, which dominates the run there. These commits carry `commit-tag` (`:token-propagation`), so `watch-component-changes` only touches the component (thumbnail, `:modified-at`) and does not sync copies: copies already got the same token values. Every other token kind still goes through the update events and the update buffer at the end, untagged, so component sync follows them.
- Text fills update `:position-data` in place (new fill on every entry) when every entry's `:fills` matches a text node; such commits also carry `:position-data` so the position data watcher skips them. Otherwise the position data is dropped; on the current page those texts go in an untagged commit so the watcher regenerates it, on other pages the next visit does. Shadow ids come from one `value->shadow` per value per run, so mains and copies match.