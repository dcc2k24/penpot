use skia_safe::{self as skia, textlayout::FontCollection, Path, Point};
use std::collections::HashMap;

mod page_cache;
mod shapes_pool;
mod text_editor;
mod ui;
pub use page_cache::PageCache;
pub use shapes_pool::{ShapesPool, ShapesPoolMutRef, ShapesPoolRef};
pub use text_editor::*;
pub use ui::RulerState;
pub use ui::UIState;

use crate::error::{Error, Result};
use crate::render::raster::RasterFormat;
use crate::render::shape_paint_reach;
use crate::render::FrameType;
use crate::shapes::{grid_layout::grid_cell_data, FontFamily, Shape, Type};
use crate::uuid::Uuid;
use crate::{get_render_state, get_resources, has_render_state, tiles};

/// This struct holds the state of the Rust application between JS calls.
///
/// It is created by [init] and passed to the other exported functions.
/// Note that rust-skia data structures are not thread safe, so a state
/// must not be shared between different Web Workers.
pub(crate) struct State {
    pub current_id: Option<Uuid>,
    pub current_browser: u8,
    pub shapes: ShapesPool,
    pub saved_shapes: Option<ShapesPool>,
    /// True while the first bulk load of shapes is in progress.
    pub loading: bool,
    /// Progressive multi-page PDF export (begin / add-page / finish).
    pub pdf_export: Option<crate::render::pdf::PdfExportSession>,
}

impl State {
    pub fn new() -> Self {
        Self {
            current_id: None,
            current_browser: 0,
            shapes: ShapesPool::new(),
            saved_shapes: None,
            loading: false,
            pdf_export: None,
        }
    }

    // Creates a new temporary shapes pool.
    // Will panic if a previous temporary pool exists.
    pub fn start_temp_objects(&mut self) -> Result<()> {
        if self.saved_shapes.is_some() {
            return Err(Error::CriticalError(
                "Tried to start a temp objects while the previous have not been restored"
                    .to_string(),
            ));
        }
        self.saved_shapes = Some(std::mem::take(&mut self.shapes));
        Ok(())
    }

    // Disposes of the temporary shapes pool restoring the normal pool
    // Will panic if a there is no temporary pool.
    pub fn end_temp_objects(&mut self) -> Result<()> {
        self.shapes = self.saved_shapes.take().ok_or(Error::CriticalError(
            "Tried to end temp objects but not content to be restored is present".to_string(),
        ))?;
        Ok(())
    }

    pub fn render_from_cache(&mut self) {
        get_render_state().render_from_cache(&self.shapes);
    }

    pub fn present_frame(&mut self) {
        get_render_state().present_frame(&self.shapes);
    }

    pub fn render_ui_only(&mut self) {
        get_render_state().render_ui_only(&self.shapes);
    }

    pub fn render_blurred_snapshot(&mut self, blur_radius: f32) {
        get_render_state().render_blurred_snapshot(&self.shapes, blur_radius);
    }

    pub fn render_sync(&mut self, timestamp: i32) -> Result<FrameType> {
        get_render_state().start_render_loop(None, &self.shapes, timestamp, true)
    }

    pub fn render_sync_shape(&mut self, id: &Uuid, timestamp: i32) -> Result<FrameType> {
        let render_state = get_render_state();
        render_state.prepare_sync_shape_render();
        render_state.start_render_loop(Some(id), &self.shapes, timestamp, true)
    }

    pub fn render_shape_pixels(
        &mut self,
        id: &Uuid,
        scale: f32,
        timestamp: i32,
        format: RasterFormat,
    ) -> Result<(Vec<u8>, i32, i32)> {
        get_render_state().render_shape_pixels(id, &self.shapes, scale, timestamp, format)
    }

    pub fn render_shape_pdf(&mut self, id: &Uuid) -> Result<Vec<u8>> {
        crate::render::pdf::render_to_pdf(get_resources(), id, &self.shapes)
    }

    pub fn render_shapes_pdf(&mut self, ids: &[Uuid]) -> Result<Vec<u8>> {
        crate::render::pdf::render_to_pdf_multi(get_resources(), ids, &self.shapes)
    }

    pub fn pdf_export_begin(&mut self) -> Result<()> {
        crate::render::pdf::export_begin(&mut self.pdf_export)
    }

    pub fn pdf_export_add_page(&mut self, id: &Uuid) -> Result<()> {
        crate::render::pdf::export_add_page(&mut self.pdf_export, get_resources(), id, &self.shapes)
    }

    pub fn pdf_export_finish(&mut self) -> Result<Vec<u8>> {
        crate::render::pdf::export_finish(&mut self.pdf_export, &self.shapes)
    }

    pub fn pdf_export_abort(&mut self) {
        crate::render::pdf::export_abort(&mut self.pdf_export)
    }

    pub fn render_shape_svg(&mut self, id: &Uuid, scale: f32) -> Result<Vec<u8>> {
        crate::render::svg::render_to_svg(get_resources(), id, &self.shapes, scale)
    }

    pub fn render_shapes_svg(&mut self, ids: &[Uuid], scale: f32) -> Result<Vec<u8>> {
        crate::render::svg::render_to_svg_multi(get_resources(), ids, &self.shapes, scale)
    }

    /// GPU-free counterpart of [`State::render_shape_pixels`]: encodes to
    /// `format` on a CPU raster surface, no GPU/WebGL.
    pub fn render_shape_raster(
        &mut self,
        id: &Uuid,
        scale: f32,
        format: RasterFormat,
    ) -> Result<(Vec<u8>, i32, i32)> {
        crate::render::raster::render_to_raster(get_resources(), id, &self.shapes, scale, format)
    }

    /// Distinct font families used by the (visible) subtree rooted at `id`, in
    /// first-seen order — the on-demand set the headless exporter provisions.
    pub fn fonts_used_by_shape(&self, id: &Uuid) -> Vec<FontFamily> {
        let Some(root) = self.shapes.get(id) else {
            return Vec::new();
        };

        let mut result: Vec<FontFamily> = Vec::new();
        for child_id in root.all_children_iter(&self.shapes, false, true) {
            if let Some(shape) = self.shapes.get(&child_id) {
                for family in shape.font_families() {
                    if !result.contains(&family) {
                        result.push(family);
                    }
                }
            }
        }
        result
    }

    pub fn start_render_loop(&mut self, timestamp: i32) -> Result<FrameType> {
        let render_state = get_render_state();
        // If zoom changed (e.g. interrupted zoom render followed by pan), the
        // tile index may be stale for the new viewport position. Rebuild the
        // index so shapes are mapped to the correct tiles. We use
        // rebuild_tile_index (NOT rebuild_tiles_shallow) to preserve the tile
        // texture cache — otherwise cached tiles with shadows/blur would be
        // cleared and re-rendered in fast mode without effects.
        if render_state.zoom_changed() {
            render_state.rebuild_tile_index(&self.shapes);
        }
        render_state.start_render_loop(None, &self.shapes, timestamp, false)
    }

    pub fn continue_render_loop(&mut self, timestamp: i32) -> Result<FrameType> {
        let allow_stop = true;
        get_render_state().continue_render_loop(None, &self.shapes, timestamp, allow_stop)
    }

    pub fn clear_focus_mode(&mut self) {
        get_render_state().clear_focus_mode();
    }

    pub fn set_focus_mode(&mut self, shapes: Vec<Uuid>) {
        get_render_state().set_focus_mode(shapes);
    }

    pub fn clear_include_filter(&mut self) {
        get_render_state().clear_include_filter();
    }

    pub fn set_include_filter(&mut self, shapes: Vec<Uuid>) {
        get_render_state().set_include_filter(shapes);
    }

    pub fn init_shapes_pool(&mut self, capacity: usize) {
        self.shapes.initialize(capacity);
    }

    /// Moves the shapes pool into `cache` under `page_id`, leaving an empty
    /// pool. Returns false, keeping the pool, while shapes are loading, while
    /// a temporary pool is active, when the pool has no root shape or when it
    /// does not fit in the cache.
    pub fn stash_page(&mut self, page_id: Uuid, cache: &mut PageCache) -> bool {
        if self.loading
            || self.saved_shapes.is_some()
            || !self.shapes.has(&Uuid::nil())
            || !cache.accepts_pool(&self.shapes)
        {
            return false;
        }

        let mut pool = std::mem::take(&mut self.shapes);
        // Modifiers only preview a gesture: the committed geometry is in the
        // shapes themselves, which is what a fresh upload would contain.
        pool.clean_all();
        // Cached text paints may hold image shaders bound to this renderer's
        // GL context, which `clean_up` is about to drop.
        for shape in pool.iter_mut() {
            if let Type::Text(content) = &mut shape.shape_type {
                // Decided by what the cached layout was built with: the
                // current fills may differ from it.
                if content.layout_has_image_shaders() {
                    content.detach_paint_cache();
                }
            }
        }
        self.current_id = None;
        cache.stash(page_id, pool)
    }

    /// Replaces the shapes pool with the pool `cache` holds for `page_id`.
    /// Returns false, changing nothing, when the page is not cached, while
    /// shapes are loading or while a temporary pool is active.
    pub fn restore_page(&mut self, page_id: &Uuid, cache: &mut PageCache) -> bool {
        if self.loading || self.saved_shapes.is_some() {
            return false;
        }

        let Some(pool) = cache.take(page_id) else {
            return false;
        };
        self.shapes = pool;
        // Imposters belong to the previous pool.
        if has_render_state() {
            get_render_state().clear_imposters();
        }
        self.current_id = None;
        true
    }

    pub fn use_shape(&mut self, id: Uuid) {
        if !self.shapes.has(&id) {
            self.shapes.add_shape(id);
        }
        self.current_id = Some(id);
    }

    pub fn has_shape(&mut self, id: Uuid) -> bool {
        self.shapes.has(&id)
    }

    pub fn delete_shape_children(&mut self, parent_id: Uuid, id: Uuid) {
        // We don't really do a self.shapes.remove so that redo/undo keep working
        let Some(shape) = self.shapes.get(&id) else {
            return;
        };

        // Only remove the children when is being deleted from the owner
        if shape.parent_id.is_none() || shape.parent_id == Some(parent_id) {
            // Tile invalidation only applies to the on-screen render state; the
            // headless export path has none, so skip it there.
            if has_render_state() {
                let render_state = get_render_state();
                render_state.mark_imposter_dirty(parent_id);
                // Do NOT use `get_tiles_for_shape` (interest-clipped). Evict by
                // document coverage so cached tiles outside the interest area
                // cannot keep pixels of the deleted shape.
                let indexed_tiles: Vec<tiles::Tile> = render_state
                    .tiles
                    .get_tiles_of(shape.id)
                    .map(|t| t.iter().copied().collect())
                    .unwrap_or_default();
                let scale = render_state.get_scale();
                let dirty = indexed_tiles
                    .iter()
                    .fold(shape.extrect(&self.shapes, 1.0), |acc, tile| {
                        tiles::join_nonempty(acc, tiles::get_tile_rect(*tile, scale))
                    });
                render_state.surfaces.invalidate_cached_tiles_intersecting(
                    dirty,
                    !render_state.options.is_interactive_transform(),
                );
                for tile in indexed_tiles {
                    render_state.tiles.remove_shape_at(tile, shape.id);
                }
            }

            if let Some(shape_to_delete) = self.shapes.get(&id) {
                let to_delete = shape_to_delete.all_children(&self.shapes, true, true);
                for shape_id in to_delete {
                    if let Some(shape_to_delete) = self.shapes.get_mut(&shape_id) {
                        shape_to_delete.set_deleted(true);
                    }
                    if has_render_state() && get_render_state().show_grid == Some(shape_id) {
                        get_render_state().show_grid = None;
                    }
                }
            }
        }
    }

    pub fn current_shape_mut(&mut self) -> Option<&mut Shape> {
        self.shapes.get_mut(&self.current_id?)
    }

    pub fn current_shape(&self) -> Option<&Shape> {
        self.shapes.get(&self.current_id?)
    }

    pub fn set_background_color(&mut self, color: skia::Color) {
        get_render_state().set_background_color(color);
    }

    pub fn set_browser(&mut self, browser: u8) {
        self.current_browser = browser;
    }

    /// Sets the parent for the current shape and updates the parent's extended rectangle
    ///
    /// When a shape is assigned a new parent, the parent's extended rectangle needs to be
    /// invalidated and recalculated to include the new child. This ensures that frames
    /// and groups properly encompass their children.
    pub fn set_parent_for_current_shape(&mut self, id: Uuid) {
        // Reparent preview during drag is handled by structure modifiers only.
        // Headless export has no render state and never runs interactive drags.
        if has_render_state() && get_render_state().options.is_interactive_transform() {
            return;
        }

        let Some(shape) = self.current_shape_mut() else {
            panic!("Invalid current shape")
        };

        // If the shape already has the same parent, do nothing
        if shape.parent_id == Some(id) {
            return;
        }

        let old_parent = shape.parent_id;
        shape.set_parent(id);

        if has_render_state() {
            let render_state = get_render_state();
            if let Some(old) = old_parent {
                render_state.mark_imposter_dirty(old);
            }
            render_state.mark_imposter_dirty(id);
        }

        // Note: We don't call parent.add_child() here because we are
        // asuming the parent is updating its children list via set_children() calls.
        // Calling add_child here would create duplicates.

        // Invalidate parent's extrect so it gets recalculated to include the new child
        if let Some(parent) = self.shapes.get_mut(&id) {
            parent.invalidate_extrect();
        }
    }

    pub fn rebuild_tiles_shallow(&mut self) {
        get_render_state().rebuild_tiles_shallow(&self.shapes);
    }

    pub fn rebuild_tiles(&mut self) {
        get_render_state().rebuild_tiles_from(&self.shapes, None);
    }

    pub fn rebuild_tiles_from(&mut self, base_id: Option<&Uuid>) {
        get_render_state().rebuild_tiles_from(&self.shapes, base_id);
    }

    pub fn rebuild_touched_tiles(&mut self) {
        get_render_state().rebuild_touched_tiles(&self.shapes);
    }

    pub fn render_preview(&mut self, timestamp: i32) {
        let _ = get_render_state().render_preview(&self.shapes, timestamp);
    }

    pub fn rebuild_modifier_tiles(&mut self, ids: &[Uuid]) -> Result<()> {
        get_render_state().rebuild_modifier_tiles(&mut self.shapes, ids)
    }

    pub fn font_collection(&self) -> &FontCollection {
        get_resources().fonts.font_collection()
    }

    pub fn get_grid_coords(&self, pos_x: f32, pos_y: f32) -> Option<(i32, i32)> {
        let shape = self.current_shape()?;
        let bounds = shape.bounds();
        let position = Point::new(pos_x, pos_y);

        let cells = grid_cell_data(shape, &self.shapes, true);

        for cell in cells {
            let points = &[
                cell.anchor,
                cell.anchor + bounds.hv(cell.width),
                cell.anchor + bounds.hv(cell.width) + bounds.vv(cell.height),
                cell.anchor + bounds.vv(cell.height),
            ];

            let polygon = Path::polygon(points, true, None, None);

            if polygon.contains(position) {
                return Some((cell.row as i32 + 1, cell.column as i32 + 1));
            }
        }

        None
    }

    pub fn set_modifiers(&mut self, modifiers: HashMap<Uuid, skia::Matrix>) {
        self.shapes.set_modifiers(modifiers);
    }

    /// Replace the current shape's children list (same semantics as `_set_children`).
    pub fn set_current_shape_children(&mut self, entries: Vec<Uuid>) -> Result<()> {
        let (parent_id, deleted) = {
            let Some(shape) = self.current_shape_mut() else {
                return Err(Error::RecoverableError(
                    "set_current_shape_children: no current shape".to_string(),
                ));
            };

            let id = shape.id;
            let (_, deleted) = shape.compute_children_differences(&entries);
            shape.children = entries.clone();
            (id, deleted)
        };

        // The children list changed: the old board of a moved-out child loses its imposter.
        if has_render_state() {
            get_render_state().mark_imposter_dirty(parent_id);
        }

        for id in &entries {
            self.touch_shape(*id);
            if let Some(children_shape) = self.shapes.get_mut(id) {
                children_shape.set_deleted(false);
            }
        }

        for id in deleted {
            self.delete_shape_children(parent_id, id);
            self.touch_shape(id);
        }

        Ok(())
    }

    pub fn touch_current(&mut self) {
        if let Some(current_id) = self.current_id {
            self.touch_shape(current_id);
        }
    }

    pub fn touch_shape(&mut self, id: Uuid) {
        self.shapes.invalidate_ancestors_extrect(&id);
        if self.loading || !has_render_state() {
            return;
        }
        // The shape still holds its old stroke widths and font sizes here, so the recorded
        // extent is grown by the reach it had before the mutation.
        let prev = self.shapes.get(&id).map(|shape| {
            let extrect = shape.extrect(&self.shapes, 1.0);
            let reach = shape_paint_reach(shape);
            if extrect.is_empty() || reach <= 0.0 {
                extrect
            } else {
                extrect.with_outset((reach, reach))
            }
        });
        get_render_state().mark_touched_with_prev(id, prev);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Rect;
    use crate::shapes::{
        Fill, FontStyle, GrowType, ImageFill, Paragraph, TextAlign, TextContent, TextDirection,
        TextSpan,
    };
    use std::rc::Rc;

    fn state_with_page(child: Uuid) -> State {
        let mut state = State::new();
        state.init_shapes_pool(2);
        state.shapes.add_shape(Uuid::nil());
        state.shapes.add_shape(child);
        state
    }

    #[test]
    fn stash_then_restore_round_trip() {
        let page = Uuid::new_v4();
        let child = Uuid::new_v4();
        let mut cache = PageCache::new();

        let mut state = state_with_page(child);
        assert!(state.stash_page(page, &mut cache));
        assert_eq!(state.shapes.len(), 0);
        assert!(cache.contains(&page));

        let mut other = State::new();
        assert!(other.restore_page(&page, &mut cache));
        assert!(other.shapes.has(&child));
        assert!(other.shapes.has(&Uuid::nil()));
        assert!(!cache.contains(&page));
    }

    #[test]
    fn restore_unknown_page_keeps_pool() {
        let child = Uuid::new_v4();
        let mut cache = PageCache::new();

        let mut state = state_with_page(child);
        assert!(!state.restore_page(&Uuid::new_v4(), &mut cache));
        assert!(state.shapes.has(&child));
    }

    #[test]
    fn stash_refused_while_loading() {
        let page = Uuid::new_v4();
        let child = Uuid::new_v4();
        let mut cache = PageCache::new();

        let mut state = state_with_page(child);
        state.loading = true;
        assert!(!state.stash_page(page, &mut cache));
        assert!(state.shapes.has(&child));
        assert!(cache.is_empty());
    }

    #[test]
    fn stash_refused_with_temp_pool() {
        let page = Uuid::new_v4();
        let child = Uuid::new_v4();
        let mut cache = PageCache::new();

        let mut state = state_with_page(child);
        state.start_temp_objects().unwrap();
        assert!(!state.stash_page(page, &mut cache));
        assert!(cache.is_empty());

        state.end_temp_objects().unwrap();
        assert!(state.shapes.has(&child));
    }

    #[test]
    fn stash_refused_without_root() {
        let page = Uuid::new_v4();
        let child = Uuid::new_v4();
        let mut cache = PageCache::new();

        let mut state = State::new();
        state.init_shapes_pool(1);
        state.shapes.add_shape(child);
        assert!(!state.stash_page(page, &mut cache));
        assert!(state.shapes.has(&child));
        assert!(cache.is_empty());
    }

    #[test]
    fn stash_refused_when_pool_does_not_fit() {
        let page = Uuid::new_v4();
        let child = Uuid::new_v4();
        let mut cache = PageCache::with_limits(3, 1, 1);

        let mut state = state_with_page(child);
        assert!(!state.stash_page(page, &mut cache));
        assert!(state.shapes.has(&child));
        assert!(cache.is_empty());
    }

    #[test]
    fn stash_refused_when_page_too_heavy() {
        let page = Uuid::new_v4();
        let child = Uuid::new_v4();
        // Root (1) + text (8) = weight 9 > 5.
        let mut cache = PageCache::with_limits(3, 5, 100);

        let mut state = state_with_page(child);
        state
            .shapes
            .get_mut(&child)
            .unwrap()
            .set_shape_type(Type::Text(TextContent::default()));
        assert!(!state.stash_page(page, &mut cache));
        assert!(state.shapes.has(&child));
        assert!(cache.is_empty());
    }

    #[test]
    fn stash_drops_modifiers() {
        let page = Uuid::new_v4();
        let child = Uuid::new_v4();
        let mut cache = PageCache::new();

        let mut state = state_with_page(child);
        let modifiers = HashMap::from([(child, skia::Matrix::translate((10.0, 0.0)))]);
        state.shapes.set_modifiers(modifiers);
        assert!(state.shapes.has_pending_modifiers());
        assert!(state.stash_page(page, &mut cache));

        let mut other = State::new();
        assert!(other.restore_page(&page, &mut cache));
        assert!(!other.shapes.has_pending_modifiers());
    }

    #[test]
    fn restore_refused_while_loading() {
        let page = Uuid::new_v4();
        let child = Uuid::new_v4();
        let mut cache = PageCache::new();

        let mut source = state_with_page(child);
        assert!(source.stash_page(page, &mut cache));

        let mut state = State::new();
        state.loading = true;
        assert!(!state.restore_page(&page, &mut cache));
        assert!(cache.contains(&page));
    }

    /// Text whose only span has an image fill and whose cached layout matches.
    fn text_with_image_span() -> TextContent {
        let image = Fill::Image(ImageFill::new(Uuid::nil(), 255, 100, 100, true));
        let span = TextSpan::new(
            "image".to_string(),
            FontFamily::new(Uuid::nil(), 400, FontStyle::Normal),
            14.0,
            1.2,
            0.0,
            None,
            None,
            TextDirection::LTR,
            400,
            Uuid::nil(),
            vec![image],
        );
        let paragraph = Paragraph::new(
            TextAlign::Left,
            TextDirection::LTR,
            None,
            None,
            1.2,
            0.0,
            vec![span],
        );
        let mut content =
            TextContent::new(Rect::from_xywh(0.0, 0.0, 200.0, 100.0), GrowType::Fixed);
        // Pushed directly so the content version stays 0, the same as the layout
        // version of a new content. The cached layout then matches.
        content.paragraphs.push(paragraph);
        content.layout.paragraphs = Rc::new(vec![vec![]]);
        // The layout stands for one built with the image fill.
        content.layout.has_image_shaders = true;
        content
    }

    fn text_cache_matches(shape: &Shape) -> bool {
        match &shape.shape_type {
            Type::Text(content) => content.layout_cache_versions_match(),
            _ => panic!("expected a text shape"),
        }
    }

    #[test]
    fn stash_detaches_text_image_paint_cache() {
        let page = Uuid::new_v4();
        let child = Uuid::new_v4();
        let mut cache = PageCache::new();

        let mut state = state_with_page(child);
        let text = Type::Text(text_with_image_span());
        state.shapes.get_mut(&child).unwrap().set_shape_type(text);
        assert!(text_cache_matches(state.shapes.get(&child).unwrap()));

        assert!(state.stash_page(page, &mut cache));

        let mut other = State::new();
        assert!(other.restore_page(&page, &mut cache));
        assert!(!text_cache_matches(other.shapes.get(&child).unwrap()));
    }

    #[test]
    fn stash_keeps_text_cache_built_without_image_shaders() {
        let page = Uuid::new_v4();
        let child = Uuid::new_v4();
        let mut cache = PageCache::new();

        let mut state = state_with_page(child);
        let mut content = text_with_image_span();
        content.layout.has_image_shaders = false;
        state
            .shapes
            .get_mut(&child)
            .unwrap()
            .set_shape_type(Type::Text(content));
        assert!(text_cache_matches(state.shapes.get(&child).unwrap()));

        assert!(state.stash_page(page, &mut cache));

        let mut other = State::new();
        assert!(other.restore_page(&page, &mut cache));
        assert!(text_cache_matches(other.shapes.get(&child).unwrap()));
    }

    #[test]
    fn stash_detaches_by_layout_flag_not_current_fills() {
        let page = Uuid::new_v4();
        let child = Uuid::new_v4();
        let mut cache = PageCache::new();

        let mut state = state_with_page(child);
        // The image fill is gone, but the cached layout was built with it.
        // Fields are used directly so the content version stays unchanged.
        let mut content = text_with_image_span();
        content.paragraphs[0].children_mut()[0].fills =
            vec![Fill::Solid(crate::shapes::SolidColor(skia::Color::BLACK))];
        assert!(!content.has_image_fills());
        state
            .shapes
            .get_mut(&child)
            .unwrap()
            .set_shape_type(Type::Text(content));
        assert!(text_cache_matches(state.shapes.get(&child).unwrap()));

        assert!(state.stash_page(page, &mut cache));

        let mut other = State::new();
        assert!(other.restore_page(&page, &mut cache));
        assert!(!text_cache_matches(other.shapes.get(&child).unwrap()));
    }
}
