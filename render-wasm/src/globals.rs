use macros::wasm_error;

#[cfg(target_arch = "wasm32")]
use crate::emscripten::init_gl;

use crate::mem;
use crate::render::{gpu_state::GpuState, FontStore, RenderResources, RenderState};
use crate::state::{PageCache, State, TextEditorState, UIState};

static mut DESIGN_STATE: *mut State = std::ptr::null_mut();
static mut PAGE_CACHE: *mut PageCache = std::ptr::null_mut();
static mut GPU_STATE: *mut GpuState = std::ptr::null_mut();
static mut RENDER_STATE: *mut RenderState = std::ptr::null_mut();
static mut UI_STATE: *mut UIState = std::ptr::null_mut();
static mut TEXT_EDITOR_STATE: *mut TextEditorState = std::ptr::null_mut();
static mut RENDER_RESOURCES: *mut RenderResources = std::ptr::null_mut();

/// Font store of the renderer that `clean_up` dropped. It is kept for the next
/// `init` while the page cache holds pages: the cached text layouts of those
/// pages were built from its font collection. Keeping it also avoids parsing the
/// fonts again.
static mut RETAINED_FONTS: Option<FontStore> = None;

#[allow(static_mut_refs)]
fn retained_fonts_slot() -> &'static mut Option<FontStore> {
    unsafe { &mut RETAINED_FONTS }
}

/// Drops the retained font store. Called when the page cache is cleared.
pub(crate) fn drop_retained_fonts() {
    *retained_fonts_slot() = None;
}

pub(crate) fn get_design_state() -> &'static mut State {
    unsafe {
        debug_assert!(!DESIGN_STATE.is_null(), "Design State is null");
        &mut *DESIGN_STATE
    }
}

/// Shapes pools of recently visited pages. Unlike the other globals it is not
/// rebuilt by `init` / `clean_up`, which run on every page switch, so it is
/// created on first use and only emptied on request.
pub(crate) fn get_page_cache() -> &'static mut PageCache {
    unsafe {
        if PAGE_CACHE.is_null() {
            PAGE_CACHE = Box::into_raw(Box::new(PageCache::new()));
        }
        &mut *PAGE_CACHE
    }
}

#[inline(always)]
pub(crate) fn get_gpu_state() -> &'static mut GpuState {
    unsafe {
        assert!(
            !GPU_STATE.is_null(),
            "GPU State is null (headless instance?)"
        );
        &mut *GPU_STATE
    }
}

#[inline(always)]
pub(crate) fn get_render_state() -> &'static mut RenderState {
    unsafe {
        // Null between `clean_up` and `init`: fail loudly, never read freed memory.
        assert!(!RENDER_STATE.is_null(), "Render State is null");
        &mut *RENDER_STATE
    }
}

#[inline(always)]
pub(crate) fn current_browser() -> u8 {
    unsafe {
        if DESIGN_STATE.is_null() {
            0
        } else {
            (*DESIGN_STATE).current_browser
        }
    }
}

#[inline(always)]
pub(crate) fn has_render_state() -> bool {
    unsafe { !RENDER_STATE.is_null() }
}

#[inline(always)]
pub(crate) fn has_gpu_state() -> bool {
    unsafe { !GPU_STATE.is_null() }
}

#[inline(always)]
pub(crate) fn has_render_resources() -> bool {
    unsafe { !RENDER_RESOURCES.is_null() }
}

#[inline(always)]
pub(crate) fn get_resources() -> &'static mut RenderResources {
    unsafe {
        assert!(!RENDER_RESOURCES.is_null(), "Render Resources is null");
        &mut *RENDER_RESOURCES
    }
}

#[inline(always)]
pub(crate) fn get_text_editor_state() -> &'static mut TextEditorState {
    unsafe {
        assert!(!TEXT_EDITOR_STATE.is_null(), "Text Editor state is null");
        &mut *TEXT_EDITOR_STATE
    }
}

#[inline(always)]
pub(crate) fn get_ui_state() -> &'static mut UIState {
    unsafe {
        assert!(!UI_STATE.is_null(), "UI State is null");
        &mut *UI_STATE
    }
}

// FIXME: These with_state* macros should be using our CriticalError instead of expect.
// But to do that, we need to not use them at domain-level (i.e. in business logic), just
// in the context of the wasm call.
#[macro_export]
macro_rules! with_state {
    ($state:ident, $block:block) => {{
        use $crate::globals::get_design_state;
        let $state = get_design_state();
        $block
    }};
}

#[macro_export]
macro_rules! with_current_shape_mut {
    ($state:ident, |$shape:ident: &mut Shape| $block:block) => {
        use $crate::globals::get_design_state;
        let $state = get_design_state();
        $state.touch_current();
        if let Some($shape) = $state.current_shape_mut() {
            $block
        }
    };
}

#[macro_export]
macro_rules! with_current_shape {
    ($state:ident, |$shape:ident: &Shape| $block:block) => {
        use $crate::globals::get_design_state;
        let $state = get_design_state();
        if let Some($shape) = $state.current_shape() {
            $block
        }
    };
}

/// Scoped override of the global render resources pointer for unit tests.
#[cfg(test)]
pub(crate) struct TestRenderResourcesGuard {
    prev: *mut RenderResources,
    _lock: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
static TEST_RENDER_RESOURCES_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
impl TestRenderResourcesGuard {
    pub(crate) fn install(resources: &mut RenderResources) -> Self {
        let lock = TEST_RENDER_RESOURCES_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let prev = unsafe { RENDER_RESOURCES };
        unsafe { RENDER_RESOURCES = resources as *mut _ };
        Self { prev, _lock: lock }
    }
}

#[cfg(test)]
impl Drop for TestRenderResourcesGuard {
    fn drop(&mut self) {
        unsafe { RENDER_RESOURCES = self.prev };
    }
}

/// Initializes GPUState.
fn gpu_init() {
    unsafe {
        let gpu_state = GpuState::try_new().expect("Cannot initialize GPU State");
        GPU_STATE = Box::into_raw(Box::new(gpu_state));
    }
}

/// Initializes RenderState.
fn render_init(width: i32, height: i32) {
    unsafe {
        let render_state =
            RenderState::try_new(width, height).expect("Cannot initialize RenderState");
        RENDER_STATE = Box::into_raw(Box::new(render_state));
    }
}

/// Initializes the interactive RenderResources (GPU image store). Reuses the
/// retained font store when the page cache still holds pages.
fn resources_init() {
    unsafe {
        let fonts = retained_fonts_slot()
            .take()
            .filter(|_| !get_page_cache().is_empty());
        let resources =
            RenderResources::try_new_with_fonts(fonts).expect("Cannot initialize RenderResources");
        RENDER_RESOURCES = Box::into_raw(Box::new(resources));
    }
}

/// Initializes GPU-free RenderResources for the headless export path.
fn resources_init_headless() {
    unsafe {
        let resources = RenderResources::try_new_headless()
            .expect("Cannot initialize headless RenderResources");
        RENDER_RESOURCES = Box::into_raw(Box::new(resources));
    }
}

/// Initializes DesignState.
fn design_init() {
    unsafe {
        let design_state = State::new();
        DESIGN_STATE = Box::into_raw(Box::new(design_state));
    }
}

/// Initializes TextEditorState.
fn text_editor_init() {
    unsafe {
        let text_editor_state = TextEditorState::new();
        TEXT_EDITOR_STATE = Box::into_raw(Box::new(text_editor_state));
    }
}

/// Initializes UIState.
fn ui_init() {
    unsafe {
        let ui_state = UIState::new();
        UI_STATE = Box::into_raw(Box::new(ui_state));
    }
}

/// Frees every renderer global except the page cache. Null globals are skipped.
///
/// `release_gpu` also releases the GL objects that Skia caches. Pass false when
/// the previous GL context may not be current: the context is only abandoned.
///
/// The order matters. The render state, surfaces, images and caches are dropped
/// while the GL context is still live, so Skia deletes their GL objects.
/// `release_resources_and_abandon` then deletes the cached programs and buffers
/// and abandons the context, so dropping the context issues no GL calls.
fn free_states(release_gpu: bool) {
    crate::render::warmup::reset();
    unsafe {
        if !release_gpu && !GPU_STATE.is_null() {
            (*GPU_STATE).context.abandon();
        }
        if !RENDER_STATE.is_null() {
            let mut render_state = Box::from_raw(RENDER_STATE);
            render_state.prepare_context_loss_cleanup();
            drop(render_state);
            RENDER_STATE = std::ptr::null_mut();
        }
        if !TEXT_EDITOR_STATE.is_null() {
            drop(Box::from_raw(TEXT_EDITOR_STATE));
            TEXT_EDITOR_STATE = std::ptr::null_mut();
        }
        if !UI_STATE.is_null() {
            drop(Box::from_raw(UI_STATE));
            UI_STATE = std::ptr::null_mut();
        }
        if !DESIGN_STATE.is_null() {
            drop(Box::from_raw(DESIGN_STATE));
            DESIGN_STATE = std::ptr::null_mut();
        }
        if !RENDER_RESOURCES.is_null() {
            let resources = Box::from_raw(RENDER_RESOURCES);
            RENDER_RESOURCES = std::ptr::null_mut();
            if get_page_cache().is_empty() {
                drop(resources);
            } else {
                *retained_fonts_slot() = Some(resources.fonts);
            }
        }
        if !GPU_STATE.is_null() {
            let mut gpu_state = Box::from_raw(GPU_STATE);
            if release_gpu && !gpu_state.context.abandoned() {
                gpu_state.context.release_resources_and_abandon();
            } else {
                gpu_state.context.abandon();
            }
            drop(gpu_state);
            GPU_STATE = std::ptr::null_mut();
        }
    }
}

#[no_mangle]
#[wasm_error]
pub extern "C" fn init(width: i32, height: i32) -> Result<()> {
    free_states(false);
    mem::free_bytes()?;
    #[cfg(target_arch = "wasm32")]
    init_gl!();
    gpu_init();
    resources_init();
    render_init(width, height);
    text_editor_init();
    design_init();
    ui_init();
    Ok(())
}

/// Boots the engine for headless export with no GPU/WebGL context: only
/// `RenderResources` (GPU-free) + the design state. The export (raster/PDF)
/// paths render onto their own surface; the interactive render loop is not
/// available on an instance initialized this way. `width`/`height` are kept for
/// API symmetry with `init` but unused — the export sizes from shape bounds.
#[no_mangle]
#[wasm_error]
pub extern "C" fn init_headless(_width: i32, _height: i32) -> Result<()> {
    resources_init_headless();
    design_init();
    Ok(())
}

#[no_mangle]
#[wasm_error]
pub extern "C" fn clean_up() -> Result<()> {
    // Frees the renderer, keeps the page cache.
    free_states(true);
    mem::free_bytes()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_up_frees_renderer_globals() {
        let _lock = TEST_RENDER_RESOURCES_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        resources_init_headless();
        design_init();
        clean_up();

        unsafe {
            assert!(DESIGN_STATE.is_null());
            assert!(RENDER_RESOURCES.is_null());
            assert!(RENDER_STATE.is_null());
            assert!(GPU_STATE.is_null());
            assert!(UI_STATE.is_null());
            assert!(TEXT_EDITOR_STATE.is_null());
        }
        if get_page_cache().is_empty() {
            assert!(retained_fonts_slot().is_none());
        }
    }
}
