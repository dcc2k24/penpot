use skia_safe as skia;

use crate::error::Result;

use super::{FontStore, ImageStore};

/// Render dependencies that the export (PDF) path needs independently of the
/// surface/tile/GPU machinery in [`RenderState`]: the font store, the
/// decoded-image store, and the default sampling options.
///
/// Splitting these out keeps the vector/PDF export path (which takes
/// `&mut RenderResources`) decoupled from the interactive renderer, and gives a
/// single source of truth reached through `get_resources()`.
pub(crate) struct RenderResources {
    pub fonts: FontStore,
    pub images: ImageStore,
    pub sampling_options: skia::SamplingOptions,
}

impl RenderResources {
    /// Interactive resources. Uses `fonts` when given, otherwise creates a new
    /// font store.
    pub fn try_new_with_fonts(fonts: Option<FontStore>) -> Result<Self> {
        Self::build(fonts, ImageStore::new())
    }

    /// Headless export resources: CPU-only image store, no GPU/WebGL.
    pub fn try_new_headless() -> Result<Self> {
        Self::build(None, ImageStore::new_without_gpu())
    }

    fn build(fonts: Option<FontStore>, images: ImageStore) -> Result<Self> {
        let fonts = match fonts {
            Some(fonts) => fonts,
            None => FontStore::try_new()?,
        };
        Ok(Self {
            fonts,
            images,
            sampling_options: skia::SamplingOptions::new(
                skia::FilterMode::Linear,
                skia::MipmapMode::Nearest,
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{FontFamily, FontStyle};
    use crate::uuid::Uuid;

    // `try_new_with_fonts` needs a GPU for its image store, so the test goes
    // through `build` with a GPU-free image store.
    #[test]
    fn build_reuses_given_font_store() {
        let mut fonts = FontStore::try_new().expect("font store");
        let alias = FontFamily::new(Uuid::nil(), 400, FontStyle::Normal).alias();
        fonts.set_source_url(&alias, "https://x/y.ttf".to_string());

        let resources = RenderResources::build(Some(fonts), ImageStore::new_without_gpu())
            .expect("render resources");

        assert_eq!(resources.fonts.source_url(&alias), Some("https://x/y.ttf"));
    }
}
