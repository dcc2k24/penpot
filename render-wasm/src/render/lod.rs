//! Level-of-detail helpers for the viewport walk: size thresholds, root-board
//! eligibility, and a GPU-free cache of board pixels captured from tile surfaces.
//!
//! A root board is captured when it is drawn directly into a tile in a full-quality render.
//! Its pixels are copied out at the end of the tile. A later render of the same tile, at the
//! same scale and background, copies them back 1:1 when nothing painted earlier in the tile
//! touches the board. The copy then matches a direct draw bit for bit.

use skia_safe::{self as skia, Rect};
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::shapes::{BlendMode, Shape, Type};
use crate::state::ShapesPoolRef;
use crate::uuid::Uuid;

/// Upper bound on parent hops in [`root_child_of`]; guards against cycles.
const MAX_ANCESTOR_STEPS: usize = 4096;

/// Extra pixels kept around a board's extrect when its pixels are captured, so antialiased
/// edges and blur tails just outside the extrect are not lost.
pub const IMPOSTER_PAD_PX: i32 = 2;

/// Largest pixel coordinate kept when converting pixel bounds to `i32`.
const PIXEL_LIMIT: f32 = (1 << 24) as f32;

/// Whether a container's extrect is under `min_px` device px on both axes.
pub fn is_visually_insignificant(extrect: Rect, scale: f32, min_px: f32) -> bool {
    extrect.width() * scale < min_px && extrect.height() * scale < min_px
}

/// Whether a leaf shape can be skipped: either it is insignificant on both
/// axes, or its largest side is under `leaf_px` device px.
pub fn is_insignificant_leaf(extrect: Rect, scale: f32, min_px: f32, leaf_px: f32) -> bool {
    is_visually_insignificant(extrect, scale, min_px)
        || extrect.width().max(extrect.height()) * scale < leaf_px
}

/// Whether the shape is a board placed directly on the root.
pub fn is_root_board(shape: &Shape) -> bool {
    shape.parent_id == Some(Uuid::nil()) && matches!(shape.shape_type, Type::Frame(_))
}

/// Whether a board's extrect is small enough to be drawn from an imposter at
/// `scale`, and `scale` is at most `max_scale`. Empty, non-finite or
/// non-positive inputs never fit.
pub fn fits_imposter(extrect: Rect, scale: f32, max_screen_px: f32, max_scale: f32) -> bool {
    let finite = [extrect.left, extrect.top, extrect.right, extrect.bottom]
        .iter()
        .all(|v| v.is_finite());
    if !finite
        || !scale.is_finite()
        || scale <= 0.0
        || scale > max_scale
        || extrect.width() <= 0.0
        || extrect.height() <= 0.0
    {
        return false;
    }
    extrect.width().max(extrect.height()) * scale < max_screen_px
}

/// Whether even a large design-space drop shadow is under the minimum device size at `scale`.
pub fn skips_drop_shadows_at(scale: f32) -> bool {
    scale * crate::shapes::DROP_SHADOW_LARGE_DESIGN_PX < crate::shapes::DROP_SHADOW_MIN_DEVICE_PX
}

/// Pixel rect that `rect` (doc units) touches on a surface whose matrix is `scale` followed by
/// `translate(translation)`, i.e. doc point `p` lands on pixel `(p + translation) * scale`.
/// Rounded outward and grown by `pad` pixels on each side. Empty for non-finite input.
pub fn surface_irect(rect: Rect, translation: (f32, f32), scale: f32, pad: i32) -> skia::IRect {
    let l = ((rect.left + translation.0) * scale).floor();
    let t = ((rect.top + translation.1) * scale).floor();
    let r = ((rect.right + translation.0) * scale).ceil();
    let b = ((rect.bottom + translation.1) * scale).ceil();
    if ![l, t, r, b].iter().all(|v| v.is_finite()) {
        return skia::IRect::from_ltrb(0, 0, 0, 0);
    }
    let l = l.clamp(-PIXEL_LIMIT, PIXEL_LIMIT);
    let t = t.clamp(-PIXEL_LIMIT, PIXEL_LIMIT);
    let r = r.clamp(-PIXEL_LIMIT, PIXEL_LIMIT);
    let b = b.clamp(-PIXEL_LIMIT, PIXEL_LIMIT);
    if r <= l || b <= t {
        return skia::IRect::from_ltrb(0, 0, 0, 0);
    }
    skia::IRect::from_ltrb(
        l as i32 - pad,
        t as i32 - pad,
        r as i32 + pad,
        b as i32 + pad,
    )
}

/// Pixel rect of a board's capture on a tile surface: the board's padded surface rect clipped
/// to `surface` (the surface bounds). `None` when nothing is left.
pub fn capture_irect(
    board_extrect: Rect,
    translation: (f32, f32),
    scale: f32,
    surface: skia::IRect,
) -> Option<skia::IRect> {
    let padded = surface_irect(board_extrect, translation, scale, IMPOSTER_PAD_PX);
    if irect_empty(padded) {
        return None;
    }
    let left = padded.left.max(surface.left);
    let top = padded.top.max(surface.top);
    let right = padded.right.min(surface.right);
    let bottom = padded.bottom.min(surface.bottom);
    if left >= right || top >= bottom {
        return None;
    }
    Some(skia::IRect::from_ltrb(left, top, right, bottom))
}

/// Copies `image` 1:1 onto `canvas` with its top-left at the top-left of `rect`, in device
/// pixels (the canvas matrix is ignored). The copy replaces the pixels below it
/// (`BlendMode::Src`, nearest sampling), so it is bit-identical to the captured pixels.
pub fn draw_imposter(canvas: &skia::Canvas, image: &skia::Image, rect: skia::IRect) {
    let dst = Rect::from_xywh(
        rect.left as f32,
        rect.top as f32,
        image.width() as f32,
        image.height() as f32,
    );
    let sampling = skia::SamplingOptions::new(skia::FilterMode::Nearest, skia::MipmapMode::None);
    let mut paint = skia::Paint::default();
    paint.set_blend_mode(skia::BlendMode::Src);
    canvas.save();
    canvas.reset_matrix();
    canvas.draw_image_rect_with_sampling_options(image, None, dst, sampling, &paint);
    canvas.restore();
}

/// The ancestor-or-self of `id` whose parent is the root (nil id). Returns
/// `None` for the root id, unknown shapes, and chains that end without
/// reaching the root.
pub fn root_child_of(tree: ShapesPoolRef, id: &Uuid) -> Option<Uuid> {
    let root = Uuid::nil();
    if *id == root {
        return None;
    }
    let mut current = *id;
    for _ in 0..MAX_ANCESTOR_STEPS {
        let shape = tree.get_raw(&current)?;
        match shape.parent_id {
            Some(parent) if parent == root => return Some(current),
            Some(parent) => current = parent,
            None => return None,
        }
    }
    None
}

/// Whether a board can be drawn in isolation from the rest of the scene.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubtreeCheck {
    /// The board and every visible descendant can be drawn alone.
    Safe,
    /// A visible shape uses a blend mode or background blur that reads pixels
    /// outside the subtree.
    Unsafe,
    /// A child id is missing from the pool, so the subtree cannot be checked.
    Incomplete,
    /// The board has fewer visible descendants than the minimum, so walking it is cheaper
    /// than a texture.
    TooSimple,
}

fn breaks_isolation(shape: &Shape) -> bool {
    shape.blend_mode() != BlendMode::default() || shape.visible_background_blur().is_some()
}

/// Checks whether `board` can be drawn in isolation. Hidden subtrees are
/// skipped; masks are visited because hidden children are included. A board
/// with fewer than `min_descendants` visible descendants is `TooSimple`.
pub fn board_subtree_check(
    tree: ShapesPoolRef,
    board: &Shape,
    min_descendants: usize,
) -> SubtreeCheck {
    if breaks_isolation(board) {
        return SubtreeCheck::Unsafe;
    }
    let mut count: usize = 0;
    let mut stack: Vec<Uuid> = board.children_ids_iter(true).copied().collect();
    while let Some(id) = stack.pop() {
        let Some(child) = tree.get(&id) else {
            return SubtreeCheck::Incomplete;
        };
        if child.hidden {
            continue;
        }
        count += 1;
        if breaks_isolation(child) {
            return SubtreeCheck::Unsafe;
        }
        stack.extend(child.children_ids_iter(true).copied());
    }
    if count < min_descendants {
        return SubtreeCheck::TooSimple;
    }
    SubtreeCheck::Safe
}

/// Stroke miter joins reach up to this many stroke widths past a path (Skia's miter limit 4
/// gives 2 widths past the stroke's half width).
const MITER_REACH_WIDTHS: f32 = 2.0;

/// How far root shape `root` and its visible descendants may paint outside its extrect, or
/// `None` when that is unbounded (raw SVG). Content inside a board that clips its content is
/// held by that board's rect and counts as 0. `ink_reach` gives the glyph overhang of a text
/// shape (0 for other shapes). Stroked paths and bools add `MITER_REACH_WIDTHS` times their
/// widest stroke.
pub fn subtree_paint_reach(
    tree: ShapesPoolRef,
    root: &Shape,
    ink_reach: impl Fn(&Shape) -> f32,
) -> Option<f32> {
    let mut reach = 0.0_f32;
    let mut stack: Vec<&Shape> = vec![root];
    while let Some(shape) = stack.pop() {
        if shape.hidden {
            continue;
        }
        if matches!(shape.shape_type, Type::SVGRaw(_)) {
            return None;
        }
        reach = reach.max(ink_reach(shape));
        if matches!(shape.shape_type, Type::Path(_) | Type::Bool(_)) {
            let widest = shape.strokes.iter().map(|s| s.width).fold(0.0, f32::max);
            reach = reach.max(MITER_REACH_WIDTHS * widest);
        }
        // A clipping board holds everything under it inside its rect, so the children are
        // skipped entirely.
        let clips_children = matches!(shape.shape_type, Type::Frame(_)) && shape.clip();
        if clips_children {
            continue;
        }
        // Hidden children are pushed too, so masks are visited; hidden ones are skipped above.
        for id in shape.children_ids_iter(true) {
            if let Some(child) = tree.get(id) {
                stack.push(child);
            }
        }
    }
    Some(reach)
}

/// Whether a pixel rect has no pixels.
fn irect_empty(r: skia::IRect) -> bool {
    r.left >= r.right || r.top >= r.bottom
}

/// Whether two pixel rects share at least one pixel. Empty rects touch nothing.
fn touches(a: skia::IRect, b: skia::IRect) -> bool {
    !irect_empty(a)
        && !irect_empty(b)
        && a.left < b.right
        && b.left < a.right
        && a.top < b.bottom
        && b.top < a.bottom
}

/// Identifies one captured board: a root board in one tile at one exact scale over one
/// background color.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ImposterKey {
    pub board: Uuid,
    /// Tile column and row.
    pub tile: (i32, i32),
    /// `f32::to_bits` of the workspace scale.
    pub scale_bits: u32,
    /// The tile background color (`skia::Color` as u32).
    pub background: u32,
}

/// One cached imposter texture and the state needed to validate it.
pub struct ImposterEntry<T> {
    /// The cached texture (a `skia::Image` in production).
    pub payload: T,
    /// Pixel rect on the tile surface the payload covers.
    pub rect: skia::IRect,
    /// Board extrect when the texture was built; a different extrect means the entry is stale.
    pub board_extrect: Rect,
    /// Memory this texture counts against the cache budget.
    pub bytes: usize,
    last_used: u64,
    last_cycle: u64,
}

impl<T> ImposterEntry<T> {
    /// Creates an entry that has not been used yet.
    pub fn new(payload: T, rect: skia::IRect, board_extrect: Rect, bytes: usize) -> Self {
        Self {
            payload,
            rect,
            board_extrect,
            bytes,
            last_used: 0,
            last_cycle: 0,
        }
    }
}

/// The view of a key: its scale and background.
fn view_of(key: &ImposterKey) -> (u32, u32) {
    (key.scale_bits, key.background)
}

/// Byte-budgeted LRU cache of imposter textures, plus per-board eligibility
/// records. Entries used in the current render cycle are never evicted by
/// inserts. Also limited by entry count and by the number of views. Holds no
/// GPU state, so it can be tested without a GPU.
pub struct ImposterCache<T> {
    entries: HashMap<ImposterKey, ImposterEntry<T>>,
    /// The keys of each board's entries, so a board can be evicted without a full scan.
    by_board: HashMap<Uuid, HashSet<ImposterKey>>,
    /// Entry keys by their `last_used` clock value, oldest first.
    lru: BTreeMap<u64, ImposterKey>,
    /// Distinct views, most recently used first.
    views: Vec<(u32, u32)>,
    max_entries: usize,
    max_views: usize,
    eligibility: HashMap<Uuid, bool>,
    incomplete: HashSet<Uuid>,
    bytes: usize,
    in_use_bytes: usize,
    budget: usize,
    clock: u64,
    cycle: u64,
}

impl<T> ImposterCache<T> {
    /// Creates an empty cache that holds at most `budget` bytes, `max_entries` textures, and
    /// textures of at most `max_views` distinct views. A view is the `(scale_bits, background)`
    /// pair of a key.
    pub fn new(budget: usize, max_entries: usize, max_views: usize) -> Self {
        Self {
            entries: HashMap::new(),
            by_board: HashMap::new(),
            lru: BTreeMap::new(),
            views: Vec::new(),
            max_entries,
            max_views,
            eligibility: HashMap::new(),
            incomplete: HashSet::new(),
            bytes: 0,
            in_use_bytes: 0,
            budget,
            clock: 0,
            cycle: 0,
        }
    }

    /// Starts a render cycle: entries used from now on are protected from eviction by inserts
    /// until the next cycle. Also forgets which boards were incomplete.
    pub fn begin_cycle(&mut self) {
        self.cycle = self.cycle.wrapping_add(1);
        self.in_use_bytes = 0;
        self.incomplete.clear();
    }

    /// Bytes of the entries used in the current render cycle.
    pub fn in_use_bytes(&self) -> usize {
        self.in_use_bytes
    }

    /// Whether an entry of `bytes` for `key` could be inserted without evicting entries used in
    /// the current render cycle.
    pub fn can_fit(&self, key: ImposterKey, bytes: usize) -> bool {
        if bytes > self.budget {
            return false;
        }
        let replaced = match self.entries.get(&key) {
            Some(entry) if entry.last_cycle == self.cycle => entry.bytes,
            _ => 0,
        };
        self.in_use_bytes - replaced + bytes <= self.budget
    }

    /// Whether `board` was found incomplete (a child missing from the pool) in this render cycle.
    pub fn is_incomplete(&self, board: &Uuid) -> bool {
        self.incomplete.contains(board)
    }

    /// Records that `board` is incomplete for the rest of this render cycle.
    pub fn set_incomplete(&mut self, board: Uuid) {
        self.incomplete.insert(board);
    }

    /// Maximum total bytes the cache keeps.
    pub fn budget(&self) -> usize {
        self.budget
    }

    /// Changes the budget and evicts least recently used entries until the
    /// cache fits.
    pub fn set_budget(&mut self, budget: usize) {
        self.budget = budget;
        while self.bytes > self.budget {
            if !self.evict_lru(None, false) {
                break;
            }
        }
    }

    /// Number of cached textures.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Total bytes of the cached textures.
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// True when there are no textures, eligibility records or incomplete records.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty() && self.eligibility.is_empty() && self.incomplete.is_empty()
    }

    /// Looks up an entry without marking it as recently used.
    pub fn peek(&self, key: ImposterKey) -> Option<&ImposterEntry<T>> {
        self.entries.get(&key)
    }

    /// Looks up an entry and marks it as most recently used and in use this cycle.
    pub fn get(&mut self, key: ImposterKey) -> Option<&ImposterEntry<T>> {
        self.clock += 1;
        let clock = self.clock;
        let cycle = self.cycle;
        let entry = self.entries.get_mut(&key)?;
        let old_clock = entry.last_used;
        entry.last_used = clock;
        Self::mark_used(entry, cycle, &mut self.in_use_bytes);
        self.lru.remove(&old_clock);
        self.lru.insert(clock, key);
        self.touch_view(key);
        self.entries.get(&key)
    }

    /// Stores an entry used in this cycle, replacing any entry with the same key, then evicts
    /// least recently used entries not used in this cycle until the budget and the entry cap
    /// hold. Returns false and stores nothing when the entry does not fit next to the entries
    /// used in this cycle.
    pub fn insert(&mut self, key: ImposterKey, mut entry: ImposterEntry<T>) -> bool {
        if !self.can_fit(key, entry.bytes) {
            return false;
        }
        self.remove_entry(&key);
        self.clock += 1;
        entry.last_used = self.clock;
        entry.last_cycle = self.cycle;
        self.bytes += entry.bytes;
        self.in_use_bytes += entry.bytes;
        self.lru.insert(entry.last_used, key);
        self.by_board.entry(key.board).or_default().insert(key);
        self.entries.insert(key, entry);
        self.touch_view(key);
        while self.bytes > self.budget || self.entries.len() > self.max_entries {
            if !self.evict_lru(Some(key), true) {
                break;
            }
        }
        true
    }

    /// Removes every level of `board` and its eligibility and incomplete records.
    pub fn evict_board(&mut self, board: &Uuid) {
        if let Some(keys) = self.by_board.remove(board) {
            for key in keys {
                self.remove_entry(&key);
            }
        }
        self.eligibility.remove(board);
        self.incomplete.remove(board);
    }

    /// Removes all textures, eligibility records and incomplete records.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.by_board.clear();
        self.lru.clear();
        self.views.clear();
        self.eligibility.clear();
        self.incomplete.clear();
        self.bytes = 0;
        self.in_use_bytes = 0;
    }

    /// The recorded eligibility of `board`, if any.
    pub fn eligibility(&self, board: &Uuid) -> Option<bool> {
        self.eligibility.get(board).copied()
    }

    /// Records whether `board` may use an imposter.
    pub fn set_eligibility(&mut self, board: Uuid, eligible: bool) {
        self.eligibility.insert(board, eligible);
    }

    /// Removes the entry for `key`, keeping the byte totals right. Returns whether an
    /// entry was removed.
    fn remove_entry(&mut self, key: &ImposterKey) -> bool {
        match self.entries.remove(key) {
            Some(entry) => {
                self.bytes -= entry.bytes;
                if entry.last_cycle == self.cycle {
                    self.in_use_bytes -= entry.bytes;
                }
                self.lru.remove(&entry.last_used);
                let board_empty = match self.by_board.get_mut(&key.board) {
                    Some(keys) => {
                        keys.remove(key);
                        keys.is_empty()
                    }
                    None => false,
                };
                if board_empty {
                    self.by_board.remove(&key.board);
                }
                true
            }
            None => false,
        }
    }

    /// Moves the view of `key` to the front of the view list. When more than `max_views`
    /// views are listed, drops the oldest views and every entry that uses them. The view of
    /// `key` is never dropped, so at least one view is always kept.
    fn touch_view(&mut self, key: ImposterKey) {
        let view = view_of(&key);
        if let Some(pos) = self.views.iter().position(|v| *v == view) {
            self.views.remove(pos);
        }
        self.views.insert(0, view);
        let keep = self.max_views.max(1);
        if self.views.len() <= keep {
            return;
        }
        let dropped = self.views.split_off(keep);
        let doomed: Vec<ImposterKey> = self
            .entries
            .keys()
            .filter(|k| dropped.contains(&view_of(k)))
            .copied()
            .collect();
        for k in doomed {
            self.remove_entry(&k);
        }
    }

    /// Marks `entry` as used in `cycle`, counting its bytes as in use the first time.
    fn mark_used(entry: &mut ImposterEntry<T>, cycle: u64, in_use_bytes: &mut usize) {
        if entry.last_cycle != cycle {
            entry.last_cycle = cycle;
            *in_use_bytes += entry.bytes;
        }
    }

    /// Removes the least recently used entry other than `keep`. When
    /// `protect_in_use` is set, entries used in this cycle are not candidates.
    /// Returns false when no candidate exists.
    fn evict_lru(&mut self, keep: Option<ImposterKey>, protect_in_use: bool) -> bool {
        let cycle = self.cycle;
        let victim = self
            .lru
            .values()
            .find(|key| {
                if Some(**key) == keep {
                    return false;
                }
                if !protect_in_use {
                    return true;
                }
                self.entries
                    .get(*key)
                    .is_some_and(|entry| entry.last_cycle != cycle)
            })
            .copied();
        match victim {
            Some(key) => self.remove_entry(&key),
            None => false,
        }
    }
}

/// A board walked directly in the current tile whose pixels may be captured when the tile ends.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaptureCandidate {
    pub key: ImposterKey,
    /// Pixel rect on the tile surface to capture.
    pub rect: skia::IRect,
    /// Board extrect at the time of the walk.
    pub board_extrect: Rect,
}

/// Per-tile record of the root shapes painted so far (as padded pixel rects, in paint order)
/// and of the boards that may be captured when the tile ends.
#[derive(Debug, Default)]
pub struct TileImposters {
    painted: Vec<(Uuid, skia::IRect)>,
    candidates: Vec<CaptureCandidate>,
}

impl TileImposters {
    /// Forgets everything; called when a tile starts.
    pub fn reset(&mut self) {
        self.painted.clear();
        self.candidates.clear();
    }

    /// Forgets the capture candidates only (the tile can no longer be captured).
    pub fn drop_candidates(&mut self) {
        self.candidates.clear();
    }

    /// Records that root shape `id` paints inside `rect` in this tile. Empty rects are ignored.
    pub fn record_painted(&mut self, id: Uuid, rect: skia::IRect) {
        if !irect_empty(rect) {
            self.painted.push((id, rect));
        }
    }

    /// Whether a shape other than `id` painted so far in this tile touches `rect`.
    pub fn painted_below(&self, rect: skia::IRect, id: Uuid) -> bool {
        self.painted
            .iter()
            .any(|(painted_id, painted_rect)| *painted_id != id && touches(*painted_rect, rect))
    }

    /// Adds a board that may be captured when the tile ends.
    pub fn add_candidate(&mut self, candidate: CaptureCandidate) {
        self.candidates.push(candidate);
    }

    /// Removes all candidates and returns those whose rect touches no painted shape other than
    /// their own board (any shape painted before or after it in this tile).
    pub fn take_capturable(&mut self) -> Vec<CaptureCandidate> {
        let candidates = std::mem::take(&mut self.candidates);
        candidates
            .into_iter()
            .filter(|candidate| {
                !self.painted.iter().any(|(painted_id, painted_rect)| {
                    *painted_id != candidate.key.board && touches(*painted_rect, candidate.rect)
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::render::RenderResources;
    use crate::shapes::{
        Fill, Frame, Group, Path, Rect as RectType, SolidColor, Stroke, StrokeStyle, Type,
    };
    use crate::state::ShapesPool;
    use crate::utils::uuid_from_u32_quartet;
    use std::collections::BTreeSet;

    use super::super::vector;

    /// Byte budget for the test caches. Large enough that nothing is evicted.
    const CACHE_BYTES: usize = 1 << 30;

    /// Tile size in device pixels, as the renderer uses it.
    const TILE: f32 = 512.0;
    /// Device pixels kept around each tile, as the renderer uses it.
    const MARGIN: i32 = 256;
    /// Side of a tile surface in device pixels.
    const SURF: i32 = 1024;

    fn uid(n: u32) -> Uuid {
        uuid_from_u32_quartet(0, 0, 0, n)
    }

    fn rect(l: f32, t: f32, r: f32, b: f32) -> Rect {
        Rect::from_ltrb(l, t, r, b)
    }

    #[test]
    fn leaf_culled_below_half_device_px() {
        // 0.4 x 0.3 device px: the container rule does not apply with a
        // 0.25 px minimum, so only the leaf rule can cull it.
        assert!(is_insignificant_leaf(
            rect(0.0, 0.0, 0.4, 0.3),
            1.0,
            0.25,
            0.5
        ));
        assert!(!is_visually_insignificant(
            rect(0.0, 0.0, 0.4, 0.3),
            1.0,
            0.25
        ));
    }

    #[test]
    fn thin_text_leaf_is_not_culled() {
        // 300 x 14 doc units at scale 0.05 is 15 x 0.7 device px.
        assert!(!is_insignificant_leaf(
            rect(0.0, 0.0, 300.0, 14.0),
            0.05,
            2.0,
            0.5
        ));
    }

    #[test]
    fn container_size_rule_needs_both_axes_small() {
        assert!(is_visually_insignificant(
            rect(0.0, 0.0, 1.5, 1.5),
            1.0,
            2.0
        ));
        assert!(!is_visually_insignificant(
            rect(0.0, 0.0, 1.0, 3.0),
            1.0,
            2.0
        ));
    }

    #[test]
    fn leaf_with_max_side_exactly_threshold_is_not_culled() {
        // Use a 0.25 px minimum so the container rule does not cull it either.
        assert!(!is_insignificant_leaf(
            rect(0.0, 0.0, 0.5, 0.2),
            1.0,
            0.25,
            0.5
        ));
    }

    #[test]
    fn fits_imposter_rejects_empty_and_non_finite_inputs() {
        assert!(fits_imposter(rect(0.0, 0.0, 100.0, 50.0), 1.0, 256.0, 1.0));
        assert!(!fits_imposter(rect(0.0, 0.0, 300.0, 50.0), 1.0, 256.0, 1.0));
        assert!(!fits_imposter(rect(0.0, 0.0, 0.0, 50.0), 1.0, 256.0, 1.0));
        assert!(!fits_imposter(rect(0.0, 0.0, 10.0, 10.0), 0.0, 256.0, 1.0));
        assert!(!fits_imposter(
            rect(0.0, 0.0, f32::NAN, 10.0),
            1.0,
            256.0,
            1.0
        ));
    }

    #[test]
    fn fits_imposter_needs_scale_at_or_below_max_scale() {
        let small = rect(0.0, 0.0, 20.0, 20.0);
        assert!(fits_imposter(small, 0.5, 256.0, 0.5));
        assert!(fits_imposter(small, 0.25, 256.0, 0.5));
        // A 20 px icon at scale 4 is 80 device px, under the size limit, but too close in.
        assert!(!fits_imposter(small, 4.0, 256.0, 0.5));
        assert!(!fits_imposter(small, 0.51, 256.0, 0.5));
    }

    #[test]
    fn surface_irect_rounds_outward_and_pads() {
        let r = rect(10.3, 20.7, 110.2, 60.1);
        // Scaled: 5.15 .. 55.1 by 10.35 .. 30.05, rounded out to 5..56 by 10..31, padded by 2.
        assert_eq!(
            surface_irect(r, (0.0, 0.0), 0.5, 2),
            skia::IRect::from_ltrb(3, 8, 58, 33)
        );
        // The translation moves the rect before it is scaled: left 0.3, right 100.2.
        assert_eq!(
            surface_irect(r, (-10.0, 0.0), 0.5, 2),
            skia::IRect::from_ltrb(-2, 8, 53, 33)
        );
        // Zero-width and non-finite input give an empty rect.
        assert!(irect_empty(surface_irect(
            rect(5.0, 5.0, 5.0, 9.0),
            (0.0, 0.0),
            1.0,
            2
        )));
        assert!(irect_empty(surface_irect(
            rect(0.0, 0.0, f32::NAN, 10.0),
            (0.0, 0.0),
            1.0,
            2
        )));
    }

    #[test]
    fn capture_irect_is_clipped_to_the_surface() {
        let surface = skia::IRect::from_wh(1024, 1024);
        let partly = rect(-50.0, 900.0, 100.0, 1100.0);
        assert_eq!(
            capture_irect(partly, (0.0, 0.0), 1.0, surface),
            Some(skia::IRect::from_ltrb(0, 898, 102, 1024))
        );
        let outside = rect(2000.0, 2000.0, 2100.0, 2100.0);
        assert_eq!(capture_irect(outside, (0.0, 0.0), 1.0, surface), None);
    }

    fn key(board: u32, n: i32) -> ImposterKey {
        ImposterKey {
            board: uid(board),
            tile: (n, 0),
            scale_bits: 0.25f32.to_bits(),
            background: 0xFFFF_FFFF,
        }
    }

    fn entry(bytes: usize) -> ImposterEntry<()> {
        let r = rect(0.0, 0.0, 10.0, 10.0);
        ImposterEntry::new((), skia::IRect::from_wh(10, 10), r, bytes)
    }

    #[test]
    fn cache_evicts_least_recently_used_first() {
        let mut cache: ImposterCache<()> = ImposterCache::new(100, usize::MAX, usize::MAX);
        cache.begin_cycle();
        assert!(cache.insert(key(1, 0), entry(40)));
        cache.begin_cycle();
        assert!(cache.insert(key(2, 0), entry(40)));
        cache.begin_cycle();
        assert!(cache.insert(key(3, 0), entry(40)));
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.bytes(), 80);
        assert!(cache.peek(key(1, 0)).is_none());

        // B becomes most recently used, so inserting D evicts C.
        cache.begin_cycle();
        assert!(cache.get(key(2, 0)).is_some());
        cache.begin_cycle();
        assert!(cache.insert(key(4, 0), entry(40)));
        assert!(cache.peek(key(2, 0)).is_some());
        assert!(cache.peek(key(3, 0)).is_none());
        assert!(cache.peek(key(4, 0)).is_some());
        assert_eq!(cache.bytes(), 80);
    }

    /// Key for board `board` at workspace scale `scale`, in tile `(n, 0)`.
    fn key_at(board: u32, n: i32, scale: f32) -> ImposterKey {
        ImposterKey {
            board: uid(board),
            tile: (n, 0),
            scale_bits: scale.to_bits(),
            background: 0xFFFF_FFFF,
        }
    }

    #[test]
    fn cache_entry_cap_evicts_least_recently_used() {
        let mut cache: ImposterCache<()> = ImposterCache::new(CACHE_BYTES, 2, usize::MAX);
        cache.begin_cycle();
        assert!(cache.insert(key(1, 0), entry(10)));
        cache.begin_cycle();
        assert!(cache.insert(key(2, 0), entry(10)));
        cache.begin_cycle();
        assert!(cache.insert(key(3, 0), entry(10)));
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.bytes(), 20);
        assert!(cache.peek(key(1, 0)).is_none());
        assert!(cache.peek(key(2, 0)).is_some());
        assert!(cache.peek(key(3, 0)).is_some());
    }

    #[test]
    fn cache_keeps_at_most_max_views() {
        let (a, b, c, d) = (0.1f32, 0.2f32, 0.3f32, 0.4f32);
        let mut cache: ImposterCache<()> = ImposterCache::new(CACHE_BYTES, usize::MAX, 2);
        cache.begin_cycle();
        assert!(cache.insert(key_at(1, 0, a), entry(10)));
        assert!(cache.insert(key_at(2, 0, a), entry(10)));
        cache.begin_cycle();
        assert!(cache.insert(key_at(3, 0, b), entry(10)));
        assert!(cache.insert(key_at(4, 0, b), entry(10)));
        cache.begin_cycle();
        assert!(cache.insert(key_at(5, 0, c), entry(10)));
        // A third view appears, so view A is dropped with its entries.
        assert!(cache.insert(key_at(6, 0, c), entry(10)));
        assert_eq!(cache.len(), 4);
        assert!(cache.peek(key_at(1, 0, a)).is_none());
        assert!(cache.peek(key_at(2, 0, a)).is_none());
        assert!(cache.peek(key_at(3, 0, b)).is_some());
        assert!(cache.peek(key_at(4, 0, b)).is_some());
        assert!(cache.peek(key_at(5, 0, c)).is_some());
        assert!(cache.peek(key_at(6, 0, c)).is_some());

        // Using B makes it the newest view, so the new view D drops C instead.
        cache.begin_cycle();
        assert!(cache.get(key_at(3, 0, b)).is_some());
        assert!(cache.insert(key_at(7, 0, d), entry(10)));
        assert!(cache.peek(key_at(5, 0, c)).is_none());
        assert!(cache.peek(key_at(6, 0, c)).is_none());
        assert!(cache.peek(key_at(3, 0, b)).is_some());
        assert!(cache.peek(key_at(4, 0, b)).is_some());
        assert!(cache.peek(key_at(7, 0, d)).is_some());
        assert_eq!(cache.len(), 3);
    }

    #[test]
    fn cache_evict_board_uses_index() {
        let mut cache: ImposterCache<()> = ImposterCache::new(CACHE_BYTES, usize::MAX, usize::MAX);
        for board in 1..=3 {
            for n in 0..3 {
                assert!(cache.insert(key(board, n), entry(10)));
            }
        }
        assert_eq!(cache.len(), 9);
        assert_eq!(cache.bytes(), 90);

        cache.evict_board(&uid(2));
        assert_eq!(cache.len(), 6);
        assert_eq!(cache.bytes(), 60);
        assert_eq!(cache.by_board.len(), 2);
        for n in 0..3 {
            assert!(cache.peek(key(2, n)).is_none());
            assert!(cache.peek(key(1, n)).is_some());
            assert!(cache.peek(key(3, n)).is_some());
        }

        // Reinserting into the evicted board works and is indexed again.
        assert!(cache.insert(key(2, 0), entry(25)));
        assert_eq!(cache.len(), 7);
        assert_eq!(cache.bytes(), 85);
        assert_eq!(cache.by_board.len(), 3);
        cache.evict_board(&uid(2));
        assert_eq!(cache.len(), 6);
        assert_eq!(cache.bytes(), 60);
    }

    #[test]
    fn cache_lru_order_follows_get() {
        let mut cache: ImposterCache<()> = ImposterCache::new(30, usize::MAX, usize::MAX);
        cache.begin_cycle();
        assert!(cache.insert(key(1, 0), entry(10)));
        cache.begin_cycle();
        assert!(cache.insert(key(2, 0), entry(10)));
        cache.begin_cycle();
        assert!(cache.insert(key(3, 0), entry(10)));

        // Using 1 makes it the newest entry, so 2 is now the oldest.
        cache.begin_cycle();
        assert!(cache.get(key(1, 0)).is_some());
        cache.begin_cycle();
        assert!(cache.insert(key(4, 0), entry(10)));
        assert_eq!(cache.len(), 3);
        assert_eq!(cache.bytes(), 30);
        assert!(cache.peek(key(2, 0)).is_none());
        assert!(cache.peek(key(1, 0)).is_some());
        assert!(cache.peek(key(3, 0)).is_some());
        assert!(cache.peek(key(4, 0)).is_some());
    }

    #[test]
    fn cache_rejects_entry_larger_than_budget() {
        let mut cache: ImposterCache<()> = ImposterCache::new(100, usize::MAX, usize::MAX);
        assert!(cache.insert(key(1, 0), entry(40)));
        assert!(!cache.insert(key(2, 0), entry(101)));
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.bytes(), 40);
    }

    #[test]
    fn cache_reinsert_adjusts_bytes() {
        let mut cache: ImposterCache<()> = ImposterCache::new(100, usize::MAX, usize::MAX);
        assert!(cache.insert(key(1, 0), entry(40)));
        assert!(cache.insert(key(1, 0), entry(60)));
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.bytes(), 60);
    }

    #[test]
    fn cache_evict_board_removes_levels_and_eligibility() {
        let mut cache: ImposterCache<()> = ImposterCache::new(1000, usize::MAX, usize::MAX);
        assert!(cache.insert(key(7, 0), entry(40)));
        assert!(cache.insert(key(7, 1), entry(40)));
        assert!(cache.insert(key(8, 0), entry(40)));
        cache.set_eligibility(uid(7), true);

        cache.evict_board(&uid(7));
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.bytes(), 40);
        assert_eq!(cache.eligibility(&uid(7)), None);
        assert!(cache.peek(key(8, 0)).is_some());
    }

    #[test]
    fn cache_set_budget_shrinks_and_clear_empties() {
        let mut cache: ImposterCache<()> = ImposterCache::new(1000, usize::MAX, usize::MAX);
        assert!(cache.insert(key(1, 0), entry(40)));
        assert!(cache.insert(key(2, 0), entry(40)));
        assert!(cache.insert(key(3, 0), entry(40)));

        cache.set_budget(40);
        assert_eq!(cache.budget(), 40);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.bytes(), 40);

        cache.clear();
        assert_eq!(cache.len(), 0);
        assert_eq!(cache.bytes(), 0);
        assert!(cache.is_empty());
    }

    #[test]
    fn cache_is_not_empty_with_only_an_eligibility_record() {
        let mut cache: ImposterCache<()> = ImposterCache::new(100, usize::MAX, usize::MAX);
        assert!(cache.is_empty());
        cache.set_eligibility(uid(1), false);
        assert!(!cache.is_empty());
        assert_eq!(cache.len(), 0);
        assert_eq!(cache.eligibility(&uid(1)), Some(false));
    }

    #[test]
    fn cache_never_evicts_entries_used_this_cycle() {
        let mut cache: ImposterCache<()> = ImposterCache::new(100, usize::MAX, usize::MAX);
        cache.begin_cycle();
        assert!(cache.insert(key(1, 0), entry(40)));
        assert!(cache.insert(key(2, 0), entry(40)));
        assert!(!cache.insert(key(3, 0), entry(40)));
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.bytes(), 80);
        assert!(!cache.can_fit(key(3, 0), 40));
        assert!(cache.can_fit(key(3, 0), 20));

        // A is used again, B is not, so inserting C evicts B.
        cache.begin_cycle();
        assert!(cache.get(key(1, 0)).is_some());
        assert!(cache.insert(key(3, 0), entry(40)));
        assert!(cache.peek(key(2, 0)).is_none());
        assert!(cache.peek(key(1, 0)).is_some());
        assert!(cache.peek(key(3, 0)).is_some());
        assert_eq!(cache.bytes(), 80);
        assert_eq!(cache.in_use_bytes(), 80);
    }

    #[test]
    fn cache_reinsert_in_same_cycle_reuses_own_bytes() {
        let mut cache: ImposterCache<()> = ImposterCache::new(100, usize::MAX, usize::MAX);
        cache.begin_cycle();
        assert!(cache.insert(key(1, 0), entry(60)));
        assert!(cache.can_fit(key(1, 0), 100));
        assert!(cache.insert(key(1, 0), entry(100)));
        assert_eq!(cache.bytes(), 100);
        assert_eq!(cache.in_use_bytes(), 100);
    }

    #[test]
    fn cache_evict_board_releases_in_use_bytes() {
        let mut cache: ImposterCache<()> = ImposterCache::new(100, usize::MAX, usize::MAX);
        cache.begin_cycle();
        assert!(cache.insert(key(1, 0), entry(40)));
        cache.evict_board(&uid(1));
        assert_eq!(cache.in_use_bytes(), 0);
        assert_eq!(cache.bytes(), 0);
    }

    #[test]
    fn cache_incomplete_records_last_one_cycle() {
        let mut cache: ImposterCache<()> = ImposterCache::new(100, usize::MAX, usize::MAX);
        cache.set_incomplete(uid(1));
        assert!(cache.is_incomplete(&uid(1)));
        assert!(!cache.is_empty());

        cache.begin_cycle();
        assert!(!cache.is_incomplete(&uid(1)));
        cache.set_incomplete(uid(2));
        cache.evict_board(&uid(2));
        assert!(!cache.is_incomplete(&uid(2)));

        cache.set_incomplete(uid(3));
        cache.clear();
        assert!(cache.is_empty());
    }

    #[test]
    fn tile_imposters_track_paint_order() {
        let (a, b, c, d) = (uid(1), uid(2), uid(3), uid(4));
        let rect1 = skia::IRect::from_ltrb(0, 0, 10, 10);
        let rect2 = skia::IRect::from_ltrb(20, 20, 30, 30);
        let overlapping = skia::IRect::from_ltrb(5, 5, 8, 8);
        let board_extrect = rect(0.0, 0.0, 10.0, 10.0);

        let mut tile = TileImposters::default();
        tile.record_painted(a, rect1);
        tile.record_painted(b, rect2);
        assert!(tile.painted_below(overlapping, c));
        // A shape never blocks its own board.
        assert!(!tile.painted_below(rect1, a));

        // A is free to capture. D touches B, which was painted before it, so D is dropped.
        tile.add_candidate(CaptureCandidate {
            key: key_for(a, (0, 0), 0.5),
            rect: rect1,
            board_extrect,
        });
        tile.add_candidate(CaptureCandidate {
            key: key_for(d, (0, 0), 0.5),
            rect: skia::IRect::from_ltrb(25, 25, 40, 40),
            board_extrect,
        });
        let taken = tile.take_capturable();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].key.board, a);
        assert!(tile.take_capturable().is_empty());

        tile.reset();
        assert!(!tile.painted_below(overlapping, c));
    }

    fn add_frame(pool: &mut ShapesPool, id: Uuid, parent: Uuid) {
        let s = pool.add_shape(id);
        s.set_parent(parent);
        s.set_shape_type(Type::Frame(Frame::default()));
        s.set_selrect(0.0, 0.0, 100.0, 100.0);
    }

    fn add_rect(pool: &mut ShapesPool, id: Uuid, parent: Uuid) {
        let s = pool.add_shape(id);
        s.set_parent(parent);
        s.set_shape_type(Type::Rect(RectType::default()));
        s.set_selrect(10.0, 10.0, 20.0, 20.0);
    }

    #[test]
    fn root_child_of_walks_to_the_root_child() {
        let root = Uuid::nil();
        let board = uid(1);
        let group = uid(2);
        let leaf = uid(3);
        let orphan = uid(4);
        let missing = uid(99);

        let mut pool = ShapesPool::new();
        pool.add_shape(root);
        add_frame(&mut pool, board, root);
        {
            let g = pool.add_shape(group);
            g.set_parent(board);
            g.set_shape_type(Type::Group(Group::default()));
        }
        add_rect(&mut pool, leaf, group);
        {
            let o = pool.add_shape(orphan);
            o.set_shape_type(Type::Rect(RectType::default()));
        }

        assert_eq!(root_child_of(&pool, &leaf), Some(board));
        assert_eq!(root_child_of(&pool, &board), Some(board));
        assert_eq!(root_child_of(&pool, &root), None);
        assert_eq!(root_child_of(&pool, &missing), None);
        assert_eq!(root_child_of(&pool, &orphan), None);
    }

    fn add_plain_board(pool: &mut ShapesPool, id: Uuid, children: &[Uuid]) {
        add_frame(pool, id, Uuid::nil());
        for child in children {
            pool.get_mut(&id).expect("board").add_child(*child);
        }
    }

    #[test]
    fn board_subtree_plain_children_are_safe() {
        let board = uid(1);
        let child = uid(2);
        let mut pool = ShapesPool::new();
        add_rect(&mut pool, child, board);
        add_plain_board(&mut pool, board, &[child]);

        let shape = pool.get_raw(&board).expect("board");
        assert_eq!(board_subtree_check(&pool, shape, 0), SubtreeCheck::Safe);
    }

    #[test]
    fn board_subtree_blend_child_is_unsafe_unless_hidden() {
        let board = uid(1);
        let child = uid(2);
        let mut pool = ShapesPool::new();
        add_rect(&mut pool, child, board);
        pool.get_mut(&child)
            .expect("child")
            .set_blend_mode(BlendMode(skia::BlendMode::Multiply));
        add_plain_board(&mut pool, board, &[child]);

        let shape = pool.get_raw(&board).expect("board");
        assert_eq!(board_subtree_check(&pool, shape, 0), SubtreeCheck::Unsafe);

        pool.get_mut(&child).expect("child").set_hidden(true);
        let shape = pool.get_raw(&board).expect("board");
        assert_eq!(board_subtree_check(&pool, shape, 0), SubtreeCheck::Safe);
    }

    #[test]
    fn board_subtree_missing_child_is_incomplete() {
        let board = uid(1);
        let mut pool = ShapesPool::new();
        add_plain_board(&mut pool, board, &[uid(99)]);

        let shape = pool.get_raw(&board).expect("board");
        assert_eq!(
            board_subtree_check(&pool, shape, 0),
            SubtreeCheck::Incomplete
        );
    }

    #[test]
    fn board_subtree_own_blend_is_unsafe() {
        let board = uid(1);
        let mut pool = ShapesPool::new();
        add_plain_board(&mut pool, board, &[]);
        pool.get_mut(&board)
            .expect("board")
            .set_blend_mode(BlendMode(skia::BlendMode::Multiply));

        let shape = pool.get_raw(&board).expect("board");
        assert_eq!(board_subtree_check(&pool, shape, 0), SubtreeCheck::Unsafe);
    }

    #[test]
    fn board_subtree_with_few_children_is_too_simple() {
        let board = uid(1);
        let mut pool = ShapesPool::new();
        add_rect(&mut pool, uid(2), board);
        add_rect(&mut pool, uid(3), board);
        add_rect(&mut pool, uid(4), board);
        add_rect(&mut pool, uid(5), board);
        pool.get_mut(&uid(5)).expect("child").set_hidden(true);
        add_plain_board(&mut pool, board, &[uid(2), uid(3), uid(4), uid(5)]);

        // Three visible children; the hidden one does not count.
        let shape = pool.get_raw(&board).expect("board");
        assert_eq!(
            board_subtree_check(&pool, shape, 4),
            SubtreeCheck::TooSimple
        );
        assert_eq!(board_subtree_check(&pool, shape, 3), SubtreeCheck::Safe);
        assert_eq!(board_subtree_check(&pool, shape, 0), SubtreeCheck::Safe);
    }

    /// A board at `uid(1)` with one rect child at `uid(2)`. `clip` sets whether the board clips.
    fn reach_board(clip: bool) -> ShapesPool {
        let board = uid(1);
        let child = uid(2);
        let mut pool = ShapesPool::new();
        add_rect(&mut pool, child, board);
        add_plain_board(&mut pool, board, &[child]);
        pool.get_mut(&board).expect("board").set_clip(clip);
        pool
    }

    #[test]
    fn subtree_reach_counts_children_of_a_non_clipping_board() {
        let pool = reach_board(false);
        let shape = pool.get_raw(&uid(1)).expect("board");
        let reach = subtree_paint_reach(&pool, shape, |s| if s.id == uid(2) { 7.0 } else { 0.0 });
        assert_eq!(reach, Some(7.0));
    }

    #[test]
    fn subtree_reach_ignores_children_of_a_clipping_board() {
        let pool = reach_board(true);
        let shape = pool.get_raw(&uid(1)).expect("board");
        let reach = subtree_paint_reach(&pool, shape, |s| if s.id == uid(2) { 7.0 } else { 0.0 });
        assert_eq!(reach, Some(0.0));
    }

    #[test]
    fn subtree_reach_counts_the_root_even_when_it_clips() {
        let pool = reach_board(true);
        let shape = pool.get_raw(&uid(1)).expect("board");
        let reach = subtree_paint_reach(&pool, shape, |s| if s.id == uid(1) { 5.0 } else { 0.0 });
        assert_eq!(reach, Some(5.0));
    }

    #[test]
    fn subtree_reach_is_unbounded_for_visible_raw_svg() {
        let board = uid(1);
        let child = uid(2);
        let mut pool = ShapesPool::new();
        add_rect(&mut pool, child, board);
        pool.get_mut(&child)
            .expect("child")
            .set_shape_type(Type::SVGRaw(crate::shapes::SVGRaw::default()));
        add_plain_board(&mut pool, board, &[child]);
        pool.get_mut(&board).expect("board").set_clip(false);

        let shape = pool.get_raw(&board).expect("board");
        assert_eq!(subtree_paint_reach(&pool, shape, |_| 0.0), None);

        pool.get_mut(&child).expect("child").set_hidden(true);
        let shape = pool.get_raw(&board).expect("board");
        assert_eq!(subtree_paint_reach(&pool, shape, |_| 0.0), Some(0.0));
    }

    #[test]
    fn subtree_reach_adds_miter_reach_for_stroked_paths() {
        let board = uid(1);
        let child = uid(2);
        let mut pool = ShapesPool::new();
        add_rect(&mut pool, child, board);
        {
            let c = pool.get_mut(&child).expect("child");
            c.set_shape_type(Type::Path(Path::default()));
            let stroke = Stroke::new_center_stroke(3.0, StrokeStyle::Solid, None, None, None, None);
            c.add_stroke(stroke);
        }
        add_plain_board(&mut pool, board, &[child]);
        pool.get_mut(&board).expect("board").set_clip(false);

        let shape = pool.get_raw(&board).expect("board");
        assert_eq!(subtree_paint_reach(&pool, shape, |_| 0.0), Some(6.0));
    }

    /// Small deterministic generator so the test scene is stable across runs.
    struct Lcg(u32);

    impl Lcg {
        fn next(&mut self) -> u32 {
            self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            self.0 >> 8
        }
    }

    /// Adds a white board at `origin` of `size` doc units, with 30 varied child rects
    /// (ids from `child_base`) and one stroked rect. `seed` picks the layout.
    fn add_scene_board(
        pool: &mut ShapesPool,
        board: Uuid,
        child_base: u32,
        origin: (f32, f32),
        size: (u32, u32),
        seed: u32,
    ) {
        let (bl, bt) = origin;
        add_frame(pool, board, Uuid::nil());
        {
            let b = pool.get_mut(&board).expect("board");
            b.set_selrect(bl, bt, bl + size.0 as f32, bt + size.1 as f32);
            b.set_fills(vec![Fill::Solid(SolidColor(skia::Color::WHITE))]);
        }

        let mut rng = Lcg(seed);
        for i in 0..30u32 {
            let id = uid(child_base + i);
            let x = bl + (rng.next() % (size.0 - 40)) as f32 + 0.25;
            let y = bt + (rng.next() % (size.1 - 100)) as f32 + 0.5;
            let w = match rng.next() % 3 {
                0 => 2.0 + (rng.next() % 3) as f32,
                1 => 10.0 + (rng.next() % 290) as f32,
                _ => 40.0 + (rng.next() % 400) as f32,
            };
            let h = match rng.next() % 3 {
                0 => 2.0 + (rng.next() % 3) as f32,
                1 => 10.0 + (rng.next() % 200) as f32,
                _ => 40.0 + (rng.next() % 300) as f32,
            };
            let color = skia::Color::from_rgb(
                (rng.next() % 256) as u8,
                (rng.next() % 256) as u8,
                (rng.next() % 256) as u8,
            );
            add_rect(pool, id, board);
            {
                let c = pool.get_mut(&id).expect("child");
                c.set_selrect(x, y, x + w, y + h);
                c.set_fills(vec![Fill::Solid(SolidColor(color))]);
                if i == 5 {
                    let mut stroke =
                        Stroke::new_center_stroke(1.0, StrokeStyle::Solid, None, None, None, None);
                    stroke.fill = Fill::Solid(SolidColor(skia::Color::BLACK));
                    c.add_stroke(stroke);
                }
            }
            pool.get_mut(&board).expect("board").add_child(id);
        }
    }

    /// A root with four 1440 x 1800 boards, in paint order: A, B, D, C, E. Board D overlaps
    /// board B and comes after it. Returns the pool and the root boards in paint order.
    fn equivalence_scene() -> (ShapesPool, Vec<Uuid>) {
        let mut pool = ShapesPool::new();
        pool.add_shape(Uuid::nil());
        let boards = [
            (uid(1), 100, (4900.3, 6500.9), 0x9e37_79b9),
            (uid(2), 200, (2100.4, 300.2), 0x2545_f491),
            (uid(4), 300, (2800.4, 1200.2), 0x6a09_e667),
            (uid(3), 400, (6800.9, 1100.6), 0xbb67_ae85),
            (uid(5), 500, (9000.4, 9000.6), 0x3c6e_f372),
        ];
        for (board, child_base, origin, seed) in boards {
            add_scene_board(&mut pool, board, child_base, origin, (1440, 1800), seed);
            pool.get_mut(&Uuid::nil()).expect("root").add_child(board);
        }
        let roots = boards.iter().map(|entry| entry.0).collect();
        (pool, roots)
    }

    fn raster(w: i32, h: i32) -> skia::Surface {
        skia::surfaces::raster_n32_premul((w, h)).expect("raster surface")
    }

    /// Reads the `w` x `h` pixels at `(x, y)` of `surface`, 4 bytes per pixel.
    fn read_rgba(surface: &mut skia::Surface, x: i32, y: i32, w: i32, h: i32) -> Vec<u8> {
        let info = skia::ImageInfo::new_n32_premul((w, h), None);
        let mut buf = vec![0u8; (w * h * 4) as usize];
        assert!(surface.read_pixels(&info, &mut buf, (w * 4) as usize, (x, y)));
        buf
    }

    /// Packs a color as `0xAARRGGBB`, the layout used for the cache key.
    fn color_bits(c: skia::Color) -> u32 {
        ((c.a() as u32) << 24) | ((c.r() as u32) << 16) | ((c.g() as u32) << 8) | c.b() as u32
    }

    /// The tile background used by the walker tests.
    fn background() -> skia::Color {
        skia::Color::from_rgb(230, 231, 232)
    }

    fn key_for(board: Uuid, tile: (i32, i32), scale: f32) -> ImposterKey {
        ImposterKey {
            board,
            tile,
            scale_bits: scale.to_bits(),
            background: color_bits(background()),
        }
    }

    /// Draws the cached capture for `key` when its extrect still matches. Returns whether it drew.
    fn draw_cached(
        canvas: &skia::Canvas,
        cache: &mut ImposterCache<skia::Image>,
        key: ImposterKey,
        extrect: Rect,
    ) -> bool {
        match cache.get(key) {
            Some(entry) if entry.board_extrect == extrect => {
                draw_imposter(canvas, &entry.payload, entry.rect);
                true
            }
            _ => false,
        }
    }

    /// Renders one tile the way the renderer will. Root boards are walked in paint order. A board
    /// is copied from `cache` when nothing painted earlier in the tile touches it. When `capture`
    /// is set, walked boards are captured at the end of the tile if nothing else touches them.
    /// Returns the whole tile surface and the number of boards copied.
    fn render_tile(
        pool: &ShapesPool,
        roots: &[Uuid],
        tile: (i32, i32),
        scale: f32,
        cache: &mut ImposterCache<skia::Image>,
        capture: bool,
        resources: &mut RenderResources,
    ) -> (Vec<u8>, usize) {
        let size = 1.0 / scale * TILE;
        let left = tile.0 as f32 * size;
        let top = tile.1 as f32 * size;
        let translation = (-left + MARGIN as f32 / scale, -top + MARGIN as f32 / scale);
        let bounds = skia::IRect::from_wh(SURF, SURF);

        cache.begin_cycle();
        let mut surface = raster(SURF, SURF);
        let mut tiles = TileImposters::default();
        let mut copies = 0;
        {
            let canvas = surface.canvas();
            canvas.clear(background());
            canvas.reset_matrix();
            canvas.scale((scale, scale));
            canvas.translate(translation);

            for id in roots {
                let shape = pool.get_raw(id).expect("root board");
                let extrect = shape.extrect(pool, scale);
                let painted = surface_irect(extrect, translation, scale, IMPOSTER_PAD_PX);
                if let Some(rect) = capture_irect(extrect, translation, scale, bounds) {
                    let key = key_for(*id, tile, scale);
                    if !tiles.painted_below(rect, *id) && draw_cached(canvas, cache, key, extrect) {
                        copies += 1;
                        tiles.record_painted(*id, painted);
                        continue;
                    }
                    if capture {
                        tiles.add_candidate(CaptureCandidate {
                            key,
                            rect,
                            board_extrect: extrect,
                        });
                    }
                }
                vector::render_tree(resources, canvas, id, pool, scale, extrect)
                    .expect("direct render");
                tiles.record_painted(*id, painted);
            }
        }
        for candidate in tiles.take_capturable() {
            let r = candidate.rect;
            if let Some(image) = surface.image_snapshot_with_bounds(r) {
                let bytes = ((r.right - r.left) * (r.bottom - r.top) * 4) as usize;
                cache.insert(
                    candidate.key,
                    ImposterEntry::new(image, r, candidate.board_extrect, bytes),
                );
            }
        }
        (read_rgba(&mut surface, 0, 0, SURF, SURF), copies)
    }

    /// Tiles covered by the extrects of the root boards at `scale`, sorted.
    fn touched_tiles(pool: &ShapesPool, roots: &[Uuid], scale: f32) -> Vec<(i32, i32)> {
        let mut tiles = BTreeSet::new();
        for id in roots {
            let e = pool.get_raw(id).expect("root board").extrect(pool, scale);
            let x0 = (e.left * scale / TILE).floor() as i32;
            let x1 = (e.right * scale / TILE).floor() as i32;
            let y0 = (e.top * scale / TILE).floor() as i32;
            let y1 = (e.bottom * scale / TILE).floor() as i32;
            for x in x0..=x1 {
                for y in y0..=y1 {
                    tiles.insert((x, y));
                }
            }
        }
        tiles.into_iter().collect()
    }

    /// Fails when two pixel buffers differ, reporting how many pixels differ.
    fn assert_same_pixels(actual: &[u8], expected: &[u8], what: &str) {
        assert_eq!(actual.len(), expected.len(), "{what}: size");
        let differing = actual
            .chunks_exact(4)
            .zip(expected.chunks_exact(4))
            .filter(|(a, b)| a != b)
            .count();
        assert!(differing == 0, "{what}: {differing} pixels differ");
    }

    #[test]
    fn draw_imposter_replaces_pixels_one_to_one() {
        let mut tex = raster(4, 4);
        {
            let canvas = tex.canvas();
            canvas.clear(skia::Color::TRANSPARENT);
            for y in 0..4i32 {
                for x in 0..4i32 {
                    // Texel (1, 1) stays fully transparent.
                    if (x, y) == (1, 1) {
                        continue;
                    }
                    let mut paint = skia::Paint::default();
                    paint.set_color(skia::Color::from_rgb((x * 60) as u8, (y * 60) as u8, 200));
                    canvas.draw_rect(Rect::from_xywh(x as f32, y as f32, 1.0, 1.0), &paint);
                }
            }
        }
        let image = tex.image_snapshot();
        let tex_px = read_rgba(&mut tex, 0, 0, 4, 4);

        let mut surface = raster(8, 8);
        {
            let canvas = surface.canvas();
            canvas.clear(skia::Color::BLUE);
            // The canvas matrix must not change the copy.
            canvas.scale((3.0, 3.0));
            draw_imposter(canvas, &image, skia::IRect::from_xywh(2, 1, 4, 4));
        }
        let px = read_rgba(&mut surface, 0, 0, 8, 8);

        for y in 0..4usize {
            for x in 0..4usize {
                let t = (y * 4 + x) * 4;
                let c = ((y + 1) * 8 + (x + 2)) * 4;
                assert_eq!(&px[c..c + 4], &tex_px[t..t + 4], "texel ({x}, {y})");
            }
        }
        // The transparent texel replaces the blue fill.
        let hole = (2 * 8 + 3) * 4;
        assert_eq!(&px[hole..hole + 4], &[0u8, 0, 0, 0]);

        // Pixels outside the copy keep the blue fill.
        let mut blue_ref = raster(1, 1);
        blue_ref.canvas().clear(skia::Color::BLUE);
        let blue = read_rgba(&mut blue_ref, 0, 0, 1, 1);
        for (x, y) in [(0usize, 0usize), (1, 1), (6, 1), (7, 7)] {
            let p = (y * 8 + x) * 4;
            assert_eq!(&px[p..p + 4], blue.as_slice(), "pixel ({x}, {y})");
        }
    }

    #[test]
    fn captured_boards_match_direct_draw_at_several_tile_offsets() {
        let (pool, roots) = equivalence_scene();
        let mut resources = RenderResources::try_new_headless().expect("headless resources");
        let _guard = crate::globals::TestRenderResourcesGuard::install(&mut resources);

        // 0.1 gives 512 doc units per tile, 0.0731 gives 7003 (awkward), so both straddle tiles.
        for scale in [0.1f32, 0.0731] {
            let tiles = touched_tiles(&pool, &roots, scale);
            assert!(tiles.len() >= 4, "tiles at scale {scale}: {tiles:?}");
            let mut copies_total = 0;
            let mut overlapping_tiles = 0;
            for tile in tiles {
                let mut captured = ImposterCache::new(CACHE_BYTES, usize::MAX, usize::MAX);
                let (first, _) = render_tile(
                    &pool,
                    &roots,
                    tile,
                    scale,
                    &mut captured,
                    true,
                    &mut resources,
                );
                // Where board B (uid 2) and D (uid 4) overlap on this tile surface, neither is
                // captured.
                let size = 1.0 / scale * TILE;
                let translation = (
                    -(tile.0 as f32 * size) + MARGIN as f32 / scale,
                    -(tile.1 as f32 * size) + MARGIN as f32 / scale,
                );
                let surface_rect = |id: Uuid| {
                    let e = pool.get_raw(&id).expect("board").extrect(&pool, scale);
                    capture_irect(e, translation, scale, skia::IRect::from_wh(SURF, SURF))
                };
                if let (Some(b), Some(d)) = (surface_rect(uid(2)), surface_rect(uid(4))) {
                    if touches(b, d) {
                        overlapping_tiles += 1;
                        assert!(
                            captured.peek(key_for(uid(2), tile, scale)).is_none(),
                            "board B captured at tile {tile:?}"
                        );
                        assert!(
                            captured.peek(key_for(uid(4), tile, scale)).is_none(),
                            "board D captured at tile {tile:?}"
                        );
                    }
                }

                let (second, copies) = render_tile(
                    &pool,
                    &roots,
                    tile,
                    scale,
                    &mut captured,
                    false,
                    &mut resources,
                );
                copies_total += copies;

                let mut empty = ImposterCache::new(CACHE_BYTES, usize::MAX, usize::MAX);
                let (direct, _) = render_tile(
                    &pool,
                    &roots,
                    tile,
                    scale,
                    &mut empty,
                    false,
                    &mut resources,
                );
                assert_same_pixels(
                    &first,
                    &direct,
                    &format!("capture pass, {tile:?} at {scale}"),
                );
                assert_same_pixels(&second, &direct, &format!("copy pass, {tile:?} at {scale}"));
            }
            assert!(copies_total > 0, "no board was copied at scale {scale}");
            assert!(
                overlapping_tiles > 0,
                "B and D never overlap at scale {scale}"
            );
        }
    }

    #[test]
    fn tile_pixels_do_not_depend_on_which_boards_are_cached() {
        // Eight 1000 x 1200 boards on a grid, none overlapping.
        let mut pool = ShapesPool::new();
        pool.add_shape(Uuid::nil());
        let mut roots = Vec::new();
        for i in 0..8u32 {
            let board = uid(10 + i);
            let origin = (
                100.0 + (i % 4) as f32 * 1100.0,
                100.0 + (i / 4) as f32 * 1300.0,
            );
            add_scene_board(
                &mut pool,
                board,
                1000 + i * 100,
                origin,
                (1000, 1200),
                0x1000 + i,
            );
            pool.get_mut(&Uuid::nil()).expect("root").add_child(board);
            roots.push(board);
        }

        let scale = 0.1f32;
        let tile = (0, 0);
        let mut resources = RenderResources::try_new_headless().expect("headless resources");
        let _guard = crate::globals::TestRenderResourcesGuard::install(&mut resources);

        let (direct, _) = render_tile(
            &pool,
            &roots,
            tile,
            scale,
            &mut ImposterCache::new(CACHE_BYTES, usize::MAX, usize::MAX),
            false,
            &mut resources,
        );

        // Every board cached.
        let mut all = ImposterCache::new(CACHE_BYTES, usize::MAX, usize::MAX);
        render_tile(&pool, &roots, tile, scale, &mut all, true, &mut resources);
        let (with_all, copies_all) =
            render_tile(&pool, &roots, tile, scale, &mut all, false, &mut resources);
        assert!(copies_all > 0, "no board was cached");
        assert_same_pixels(&with_all, &direct, "all boards cached");

        // Every other board cached.
        let mut half = ImposterCache::new(CACHE_BYTES, usize::MAX, usize::MAX);
        render_tile(&pool, &roots, tile, scale, &mut half, true, &mut resources);
        for board in roots.iter().skip(1).step_by(2) {
            half.evict_board(board);
        }
        let (with_half, _) =
            render_tile(&pool, &roots, tile, scale, &mut half, false, &mut resources);
        assert_same_pixels(&with_half, &direct, "every other board cached");

        // No boards cached.
        let (with_none, copies_none) = render_tile(
            &pool,
            &roots,
            tile,
            scale,
            &mut ImposterCache::new(CACHE_BYTES, usize::MAX, usize::MAX),
            false,
            &mut resources,
        );
        assert_eq!(copies_none, 0);
        assert_same_pixels(&with_none, &direct, "no boards cached");
    }
}
