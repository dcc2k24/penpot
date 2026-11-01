//! Idle-time GPU program warm-up. Ganesh compiles a program the first time a
//! draw needs it, which stalls that frame. `run_step` draws one batch of the
//! effects the workspace renderer uses into a private surface and flushes it,
//! so the programs exist before a zoom or pan first needs them.
use skia_safe::{
    self as skia, canvas::SaveLayerRec, canvas::SrcRectConstraint, Canvas, Image, RRect, Rect,
    Surface,
};

use super::filters::compose_filters;
use super::fonts::default_font;
use super::gpu_state::GpuState;
use super::lod::draw_imposter;
use crate::globals::{get_gpu_state, get_resources, has_gpu_state, has_render_resources};
use crate::shapes::{
    merge_fills, Fill, Gradient, Shadow, ShadowStyle, SolidColor, Stroke, StrokeStyle,
};

pub const STEP_COUNT: u32 = 36;

/// Step after `step`, or 0 once every step has run (also for out-of-range input).
pub fn next_step(step: u32) -> u32 {
    if step.saturating_add(1) >= STEP_COUNT {
        0
    } else {
        step + 1
    }
}

pub(crate) struct WarmUpImages {
    pub mip: Image,
    pub plain: Image,
}

struct WarmUp {
    target: Surface,
    source: Surface,
    images: WarmUpImages,
}

static mut WARM_UP: Option<WarmUp> = None;

#[allow(static_mut_refs)]
fn warm_up_slot() -> &'static mut Option<WarmUp> {
    unsafe { &mut WARM_UP }
}

/// Drops the warm-up surfaces. Called before the GPU context is torn down.
pub(crate) fn reset() {
    *warm_up_slot() = None;
}

/// Draws one batch of the warm-up effects and flushes it. Returns the next
/// step, or 0 when done, out of range, or when there is no live GPU context.
pub(crate) fn run_step(step: u32) -> u32 {
    if step >= STEP_COUNT || !has_gpu_state() || !has_render_resources() {
        return 0;
    }
    let gpu = get_gpu_state();
    if gpu.context.abandoned() {
        reset();
        return 0;
    }
    let slot = warm_up_slot();
    if slot.is_none() {
        let Some(created) = WarmUp::create(gpu) else {
            return 0;
        };
        *slot = Some(created);
    }
    let Some(warm) = slot.as_mut() else {
        return 0;
    };
    let canvas = warm.target.canvas();
    canvas.clear(skia::Color::TRANSPARENT);
    draw_step(
        step,
        canvas,
        &mut warm.source,
        &warm.images,
        get_resources().fonts.font_collection(),
    );
    canvas.restore_to_count(1);
    canvas.reset_matrix();
    gpu.context.flush_and_submit_surface(&mut warm.target, None);
    next_step(step)
}

impl WarmUp {
    fn create(gpu: &mut GpuState) -> Option<Self> {
        let target = gpu.create_surface_with_dimensions(64, 64).ok()?;
        let mut source = gpu.create_surface_with_dimensions(32, 32).ok()?;
        {
            let canvas = source.canvas();
            canvas.clear(skia::Color::from_argb(255, 40, 120, 200));
            canvas.draw_rect(
                rect(4.0, 4.0, 16.0, 12.0),
                &fill_color(skia::Color::from_argb(255, 250, 200, 30), true),
            );
        }
        let plain = source.image_snapshot();

        let mut mip_surface = skia::gpu::surfaces::render_target(
            &mut gpu.context,
            skia::gpu::Budgeted::Yes,
            &skia::ImageInfo::new_n32_premul((16, 16), None),
            None,
            None,
            None,
            true,
            false,
        )?;
        mip_surface.canvas().draw_rect(
            rect(0.0, 0.0, 8.0, 8.0),
            &fill_color(skia::Color::from_argb(255, 200, 60, 120), true),
        );
        let mip = mip_surface.image_snapshot();

        Some(Self {
            target,
            source,
            images: WarmUpImages { mip, plain },
        })
    }
}

/// Transforms used by the warm-up steps. `S` is the default zoom-like
/// transform, `R` a rotation about (32, 32) plus scale.
#[derive(Clone, Copy)]
enum Xf {
    S,
    Down,
    Up,
    R,
    Two,
}

/// Runs `draw` with the transform applied, then restores the canvas.
fn under(canvas: &Canvas, xf: Xf, draw: impl FnOnce(&Canvas)) {
    canvas.save();
    match xf {
        Xf::S => {
            canvas.translate((3.0, 2.0));
            canvas.scale((1.5, 1.5));
        }
        Xf::Down => {
            canvas.scale((0.2, 0.2));
        }
        Xf::Up => {
            canvas.scale((4.0, 4.0));
        }
        Xf::R => {
            canvas.rotate(17.0, Some(skia::Point::new(32.0, 32.0)));
            canvas.scale((0.8, 0.8));
        }
        Xf::Two => {
            canvas.scale((2.0, 2.0));
        }
    }
    draw(canvas);
    canvas.restore();
}

const SAMPLE_TEXT: &str = "Hamburgefonstiv 0123";
const SMALL: f32 = 10.0;
const LARGE: f32 = 150.0;

fn rect(x: f32, y: f32, w: f32, h: f32) -> Rect {
    Rect::from_xywh(x, y, w, h)
}

fn rrect(x: f32, y: f32, w: f32, h: f32, radius: f32) -> RRect {
    RRect::new_rect_xy(rect(x, y, w, h), radius, radius)
}

fn uneven_rrect(x: f32, y: f32, w: f32, h: f32) -> RRect {
    let radii = [
        skia::Point::new(2.0, 2.0),
        skia::Point::new(8.0, 8.0),
        skia::Point::new(16.0, 16.0),
        skia::Point::new(0.0, 0.0),
    ];
    RRect::new_rect_radii(rect(x, y, w, h), &radii)
}

fn fill_color(color: skia::Color, aa: bool) -> skia::Paint {
    let mut paint = skia::Paint::default();
    paint.set_color(color);
    paint.set_anti_alias(aa);
    paint
}

fn fill(aa: bool) -> skia::Paint {
    fill_color(skia::Color::from_argb(255, 40, 110, 220), aa)
}

fn stroke(width: f32, aa: bool) -> skia::Paint {
    let mut paint = fill(aa);
    paint.set_style(skia::PaintStyle::Stroke);
    paint.set_stroke_width(width);
    paint
}

fn blur_filter(sigma: f32) -> Option<skia::ImageFilter> {
    skia::image_filters::blur((sigma, sigma), None, None, None)
}

fn filter_paint(filter: Option<skia::ImageFilter>) -> skia::Paint {
    let mut paint = skia::Paint::default();
    paint.set_image_filter(filter);
    paint
}

fn blend_paint(mode: skia::BlendMode) -> skia::Paint {
    let mut paint = skia::Paint::default();
    paint.set_blend_mode(mode);
    paint
}

fn triangle(size: f32) -> skia::Path {
    let mut pb = skia::PathBuilder::new();
    pb.move_to((0.0, -size));
    pb.line_to((size, size));
    pb.line_to((-size, size));
    pb.close();
    pb.detach()
}

fn star(size: f32) -> skia::Path {
    let mut pb = skia::PathBuilder::new();
    for i in 0..10u32 {
        let radius = if i % 2 == 0 { size } else { size * 0.4 };
        let angle = -std::f32::consts::FRAC_PI_2 + i as f32 * std::f32::consts::PI / 5.0;
        let point = (radius * angle.cos(), radius * angle.sin());
        if i == 0 {
            pb.move_to(point);
        } else {
            pb.line_to(point);
        }
    }
    pb.close();
    pb.detach()
}

fn blob(size: f32) -> skia::Path {
    let mut pb = skia::PathBuilder::new();
    pb.move_to((0.0, -size));
    pb.cubic_to((size, -size), (size * 1.4, size), (0.0, size));
    pb.cubic_to((-size * 1.4, size), (-size, -size * 0.2), (0.0, -size));
    pb.close();
    pb.detach()
}

fn open_cubic(size: f32) -> skia::Path {
    let mut pb = skia::PathBuilder::new();
    pb.move_to((-size, 0.0));
    pb.cubic_to((-size * 0.3, -size), (size * 0.3, size), (size, 0.0));
    pb.detach()
}

fn draw_paths(canvas: &Canvas, size: f32, aa: bool) {
    let paint = fill(aa);
    canvas.draw_path(&triangle(size), &paint);
    canvas.draw_path(&star(size), &paint);
    canvas.draw_path(&blob(size), &paint);
}

fn draw_rrects_and_ovals(canvas: &Canvas) {
    for aa in [true, false] {
        let paint = fill(aa);
        canvas.draw_rrect(rrect(0.0, 0.0, 40.0, 30.0, 6.0), &paint);
        canvas.draw_rrect(uneven_rrect(50.0, 0.0, 40.0, 30.0), &paint);
        canvas.draw_oval(rect(0.0, 40.0, 20.0, 20.0), &paint);
        canvas.draw_oval(rect(30.0, 40.0, 40.0, 16.0), &paint);
    }
}

fn stops(count: usize) -> Vec<(skia::Color, f32)> {
    let last = (count.max(2) - 1) as f32;
    (0..count)
        .map(|i| {
            let color = skia::Color::from_argb(
                255,
                (i * 67 % 256) as u8,
                (i * 131 % 256) as u8,
                (i * 29 % 256) as u8,
            );
            (color, i as f32 / last)
        })
        .collect()
}

fn linear(stops: &[(skia::Color, f32)], opacity: u8) -> Fill {
    Fill::LinearGradient(Gradient::new((0.0, 0.5), (1.0, 0.5), opacity, 1.0, stops))
}

fn radial(stops: &[(skia::Color, f32)], width: f32) -> Fill {
    Fill::RadialGradient(Gradient::new((0.5, 0.5), (1.0, 0.5), 255, width, stops))
}

fn sampling(filter: skia::FilterMode, mipmap: skia::MipmapMode) -> skia::SamplingOptions {
    skia::SamplingOptions::new(filter, mipmap)
}

fn draw_fill_shapes(canvas: &Canvas, paint: &skia::Paint, bounds: Rect) {
    canvas.draw_rect(bounds, paint);
    canvas.draw_rrect(RRect::new_rect_xy(bounds, 6.0, 6.0), paint);
    canvas.draw_path(&star(20.0), paint);
}

fn blurred_layer(canvas: &Canvas, sigma: f32) {
    canvas.save_layer(&SaveLayerRec::default().paint(&filter_paint(blur_filter(sigma))));
    canvas.draw_rrect(rrect(10.0, 10.0, 80.0, 60.0, 8.0), &fill(true));
    canvas.restore();
}

/// Backdrop blur layer. Mode 0 clips to an rrect, 1 to a star, 2 to an rrect
/// with a DstIn mask layer inside the backdrop layer.
fn backdrop_layer(canvas: &Canvas, mode: u8) {
    let Some(filter) = skia::image_filters::blur((4.0, 4.0), skia::TileMode::Clamp, None, None)
    else {
        return;
    };
    canvas.save();
    if mode == 1 {
        canvas.clip_path(&star(40.0), skia::ClipOp::Intersect, true);
    } else {
        canvas.clip_rrect(
            rrect(10.0, 10.0, 80.0, 60.0, 8.0),
            skia::ClipOp::Intersect,
            true,
        );
    }
    canvas.reset_matrix();
    let paint_src = blend_paint(skia::BlendMode::Src);
    let rec = SaveLayerRec::default()
        .backdrop(&filter)
        .backdrop_tile_mode(skia::TileMode::Clamp)
        .paint(&paint_src);
    canvas.save_layer(&rec);
    if mode == 2 {
        canvas.save_layer(&SaveLayerRec::default().paint(&blend_paint(skia::BlendMode::DstIn)));
        canvas.draw_oval(rect(10.0, 10.0, 60.0, 60.0), &fill(true));
        canvas.restore();
    } else {
        canvas.draw_rect(rect(0.0, 0.0, 200.0, 200.0), &fill(true));
    }
    canvas.restore();
    canvas.restore();
}

fn blend_layers(canvas: &Canvas, modes: &[skia::BlendMode]) {
    canvas.draw_rect(rect(0.0, 0.0, 200.0, 200.0), &fill(true));
    for mode in modes {
        let mut paint = skia::Paint::default();
        paint.set_blend_mode(*mode);
        paint.set_alpha_f(0.8);
        canvas.save_layer(&SaveLayerRec::default().paint(&paint));
        canvas.draw_rrect(rrect(20.0, 20.0, 120.0, 80.0, 10.0), &fill(true));
        canvas.restore();
    }
}

fn clipped_fill(canvas: &Canvas, clip: impl FnOnce(&Canvas)) {
    canvas.save();
    clip(canvas);
    canvas.draw_rect(rect(0.0, 0.0, 100.0, 100.0), &fill(true));
    canvas.restore();
}

fn paragraph(
    text: &str,
    size: f32,
    paint: &skia::Paint,
    fonts: &skia::textlayout::FontCollection,
) -> skia::textlayout::Paragraph {
    let paragraph_style = skia::textlayout::ParagraphStyle::new();
    let mut text_style = skia::textlayout::TextStyle::new();
    let families = vec![default_font()];
    text_style.set_font_families(&families);
    text_style.set_font_size(size);
    text_style.set_foreground_paint(paint);
    let mut builder = skia::textlayout::ParagraphBuilder::new(&paragraph_style, fonts);
    builder.push_style(&text_style);
    builder.add_text(text);
    let mut paragraph = builder.build();
    paragraph.layout(400.0);
    paragraph
}

/// Draws the warm-up batch for `step` into `canvas`. `source` is a 32x32
/// surface used as an image for compose steps.
pub(crate) fn draw_step(
    step: u32,
    canvas: &Canvas,
    source: &mut Surface,
    images: &WarmUpImages,
    fonts: &skia::textlayout::FontCollection,
) {
    match step {
        // Geometry, solid paint.
        0 => {
            for xf in [Xf::S, Xf::R] {
                under(canvas, xf, |c| {
                    for aa in [true, false] {
                        c.draw_rect(rect(0.0, 0.0, 2.0, 3.0), &fill(aa));
                        c.draw_rect(rect(10.0, 10.0, 300.0, 200.0), &fill(aa));
                    }
                });
            }
        }
        1 => under(canvas, Xf::S, draw_rrects_and_ovals),
        2 => under(canvas, Xf::R, draw_rrects_and_ovals),
        3 => under(canvas, Xf::S, |c| {
            for aa in [true, false] {
                draw_paths(c, SMALL, aa);
            }
        }),
        4 => under(canvas, Xf::S, |c| {
            for aa in [true, false] {
                draw_paths(c, LARGE, aa);
            }
        }),
        5 => under(canvas, Xf::R, |c| {
            for size in [SMALL, LARGE] {
                draw_paths(c, size, true);
            }
        }),
        // Strokes.
        6 => under(canvas, Xf::S, |c| {
            let cases = [
                (1.0, true),
                (1.0, false),
                (6.0, true),
                (6.0, false),
                (0.0, true),
                (0.0, false),
                (0.3, true),
            ];
            for (width, aa) in cases {
                c.draw_rect(rect(0.0, 0.0, 40.0, 30.0), &stroke(width, aa));
            }
            let mut bevel = stroke(6.0, true);
            bevel.set_stroke_join(skia::paint::Join::Bevel);
            c.draw_rect(rect(50.0, 0.0, 40.0, 30.0), &bevel);
        }),
        7 => under(canvas, Xf::S, |c| {
            for width in [1.0, 6.0] {
                c.draw_rrect(rrect(0.0, 0.0, 40.0, 30.0, 6.0), &stroke(width, true));
                c.draw_rrect(uneven_rrect(50.0, 0.0, 40.0, 30.0), &stroke(width, true));
                for aa in [true, false] {
                    c.draw_oval(rect(0.0, 40.0, 20.0, 20.0), &stroke(width, aa));
                    c.draw_oval(rect(30.0, 40.0, 40.0, 16.0), &stroke(width, aa));
                }
            }
        }),
        8 => under(canvas, Xf::S, |c| {
            let small = open_cubic(12.0);
            let large = open_cubic(LARGE);
            c.draw_path(&small, &stroke(1.0, true));
            let mut round = stroke(8.0, true);
            round.set_stroke_cap(skia::paint::Cap::Round);
            round.set_stroke_join(skia::paint::Join::Round);
            c.draw_path(&small, &round);
            c.draw_path(&large, &round);
            let mut square = stroke(8.0, true);
            square.set_stroke_cap(skia::paint::Cap::Square);
            c.draw_path(&large, &square);
            let mut bevel = stroke(8.0, true);
            bevel.set_stroke_join(skia::paint::Join::Bevel);
            c.draw_path(&large, &bevel);
            c.draw_path(&large, &stroke(8.0, false));
        }),
        9 => under(canvas, Xf::S, |c| {
            let bounds = rect(0.0, 0.0, 80.0, 40.0);
            for style in [StrokeStyle::Dashed, StrokeStyle::Dotted] {
                let stroke = Stroke::new_center_stroke(2.0, style, None, None, None, None);
                let paint = stroke.to_paint(&bounds, None, true);
                c.draw_rect(bounds, &paint);
                c.draw_path(&open_cubic(60.0), &paint);
            }
        }),
        // Shaders.
        10 => under(canvas, Xf::S, |c| {
            let bounds = rect(0.0, 0.0, 60.0, 40.0);
            for count in [2, 3, 4] {
                let paint = linear(&stops(count), 255).to_paint(&bounds, true);
                draw_fill_shapes(c, &paint, bounds);
            }
        }),
        11 => under(canvas, Xf::S, |c| {
            let bounds = rect(0.0, 0.0, 60.0, 40.0);
            let hard = [
                (skia::Color::from_argb(255, 220, 40, 40), 0.0),
                (skia::Color::from_argb(255, 40, 40, 220), 0.5),
                (skia::Color::from_argb(255, 40, 200, 40), 0.5),
                (skia::Color::from_argb(255, 0, 0, 0), 1.0),
            ];
            let cases = [
                linear(&stops(5), 255),
                linear(&stops(8), 255),
                linear(&stops(12), 255),
                linear(&hard, 255),
                linear(&stops(3), 128),
            ];
            for fill_case in cases {
                c.draw_rect(bounds, &fill_case.to_paint(&bounds, true));
            }
        }),
        12 => under(canvas, Xf::S, |c| {
            let bounds = rect(0.0, 0.0, 60.0, 40.0);
            for count in [2, 3, 5] {
                for width in [0.6, 1.0] {
                    let paint = radial(&stops(count), width).to_paint(&bounds, true);
                    c.draw_rect(bounds, &paint);
                    c.draw_oval(bounds, &paint);
                }
            }
        }),
        13 => under(canvas, Xf::S, |c| {
            let bounds = rect(0.0, 0.0, 60.0, 40.0);
            let solid = Fill::Solid(SolidColor(skia::Color::from_argb(255, 30, 30, 30)));
            let lin = linear(&stops(3), 255);
            let rad = radial(&stops(3), 1.0);
            let combos = [
                vec![solid.clone(), lin.clone()],
                vec![lin.clone(), rad.clone()],
                vec![solid, rad, lin],
            ];
            for fills in combos {
                let paint = merge_fills(&fills, bounds);
                c.draw_rect(bounds, &paint);
                c.draw_rrect(RRect::new_rect_xy(bounds, 6.0, 6.0), &paint);
            }
        }),
        // Images.
        14 => {
            let src = rect(0.0, 0.0, 16.0, 16.0);
            let linear_mip = sampling(skia::FilterMode::Linear, skia::MipmapMode::Nearest);
            for xf in [Xf::Down, Xf::Up] {
                under(canvas, xf, |c| {
                    for alpha in [255u8, 128] {
                        for aa in [true, false] {
                            let mut paint = skia::Paint::default();
                            paint.set_alpha(alpha);
                            paint.set_anti_alias(aa);
                            c.draw_image_rect_with_sampling_options(
                                &images.mip,
                                Some((&src, SrcRectConstraint::Strict)),
                                rect(0.0, 0.0, 200.0, 200.0),
                                linear_mip,
                                &paint,
                            );
                        }
                    }
                });
            }
            canvas.save();
            canvas.clip_rrect(rrect(0.0, 0.0, 100.0, 100.0, 10.0), None, true);
            canvas.draw_image_rect_with_sampling_options(
                &images.mip,
                Some((&src, SrcRectConstraint::Strict)),
                rect(0.0, 0.0, 100.0, 100.0),
                linear_mip,
                &skia::Paint::default(),
            );
            canvas.restore();
            let mut oval_builder = skia::PathBuilder::new();
            oval_builder.add_oval(rect(0.0, 0.0, 100.0, 100.0), None, None);
            let oval = oval_builder.detach();
            canvas.save();
            canvas.clip_path(&oval, None, true);
            canvas.draw_image_rect_with_sampling_options(
                &images.mip,
                Some((&src, SrcRectConstraint::Strict)),
                rect(0.0, 0.0, 100.0, 100.0),
                linear_mip,
                &skia::Paint::default(),
            );
            canvas.restore();
            canvas.save_layer(&SaveLayerRec::default().paint(&filter_paint(blur_filter(2.0))));
            canvas.draw_image_rect_with_sampling_options(
                &images.mip,
                Some((&src, SrcRectConstraint::Strict)),
                rect(0.0, 0.0, 100.0, 100.0),
                linear_mip,
                &skia::Paint::default(),
            );
            canvas.restore();
        }
        15 => {
            let linear_mip = sampling(skia::FilterMode::Linear, skia::MipmapMode::Nearest);
            let matrix = skia::Matrix::scale((4.0, 4.0));
            let Some(image_shader) = images.mip.to_shader(
                (skia::TileMode::Clamp, skia::TileMode::Clamp),
                linear_mip,
                &matrix,
            ) else {
                return;
            };
            let alpha = skia::shaders::color(skia::Color::from_argb(128, 255, 255, 255));
            let masked = skia::shaders::blend(
                skia::Blender::mode(skia::BlendMode::DstIn),
                image_shader.clone(),
                alpha,
            );
            let mut paint = skia::Paint::default();
            paint.set_shader(Some(masked));
            canvas.draw_rect(rect(0.0, 0.0, 120.0, 80.0), &paint);

            let solid = skia::shaders::color(skia::Color::from_argb(255, 200, 60, 60));
            let layered = skia::shaders::blend(
                skia::Blender::mode(skia::BlendMode::SrcOver),
                image_shader,
                solid,
            );
            let mut layered_paint = skia::Paint::default();
            layered_paint.set_shader(Some(layered));
            canvas.draw_rrect(rrect(0.0, 80.0, 120.0, 80.0, 8.0), &layered_paint);

            canvas.save_layer(&SaveLayerRec::default());
            canvas.draw_rect(rect(0.0, 0.0, 120.0, 80.0), &stroke(6.0, true));
            let mut image_paint = skia::Paint::default();
            image_paint.set_blend_mode(skia::BlendMode::SrcIn);
            image_paint.set_anti_alias(true);
            canvas.draw_image_rect_with_sampling_options(
                &images.mip,
                Some((&rect(0.0, 0.0, 16.0, 16.0), SrcRectConstraint::Strict)),
                rect(0.0, 0.0, 120.0, 80.0),
                linear_mip,
                &image_paint,
            );
            canvas.restore();
        }
        16 => {
            draw_imposter(
                canvas,
                &images.plain,
                skia::IRect::from_xywh(3, 2, images.plain.width(), images.plain.height()),
            );
        }
        // Compose.
        17 => {
            let nearest = sampling(skia::FilterMode::Nearest, skia::MipmapMode::None);
            let linear = sampling(skia::FilterMode::Linear, skia::MipmapMode::None);
            let linear_mip = sampling(skia::FilterMode::Linear, skia::MipmapMode::Nearest);
            let src = rect(0.0, 0.0, 32.0, 32.0);
            under(canvas, Xf::S, |c| {
                c.save();
                c.clip_rect(rect(0.0, 0.0, 60.0, 60.0), None, false);
                c.scale((1.7, 1.7));
                source.draw(c, (0.0, 0.0), nearest, None);
                c.restore();
            });
            source.draw(canvas, (0.0, 0.0), linear, None);
            source.draw(
                canvas,
                (0.0, 0.0),
                linear_mip,
                Some(&skia::Paint::default()),
            );
            source.draw(
                canvas,
                (0.0, 0.0),
                linear,
                Some(&blend_paint(skia::BlendMode::Src)),
            );
            canvas.save();
            canvas.scale((2.0, 2.0));
            canvas.draw_image_rect(
                &images.plain,
                Some((&src, SrcRectConstraint::Fast)),
                rect(0.0, 0.0, 64.0, 64.0),
                &skia::Paint::default(),
            );
            canvas.restore();
            canvas.save();
            canvas.clip_rect(rect(70.0, 0.0, 60.0, 60.0), None, false);
            canvas.clip_rect(
                rect(72.0, 2.0, 56.0, 56.0),
                Some(skia::ClipOp::Difference),
                false,
            );
            source.draw(canvas, (70.0, 0.0), nearest, None);
            canvas.restore();
        }
        18 => {
            let xforms = [
                skia::RSXform::new(1.0, 0.0, (0.0, 0.0)),
                skia::RSXform::new(1.0, 0.0, (40.0, 0.0)),
                skia::RSXform::new(0.5, 0.0, (0.0, 40.0)),
                skia::RSXform::new(0.5, 0.0, (40.0, 40.0)),
            ];
            let texs = [
                rect(0.0, 0.0, 16.0, 16.0),
                rect(16.0, 0.0, 16.0, 16.0),
                rect(0.0, 16.0, 16.0, 16.0),
                rect(16.0, 16.0, 16.0, 16.0),
            ];
            let linear = sampling(skia::FilterMode::Linear, skia::MipmapMode::None);
            let nearest = sampling(skia::FilterMode::Nearest, skia::MipmapMode::None);
            canvas.draw_atlas(
                &images.plain,
                &xforms,
                &texs,
                None,
                skia::BlendMode::SrcOver,
                linear,
                None,
                None,
            );
            canvas.draw_atlas(
                &images.plain,
                &xforms,
                &texs,
                None,
                skia::BlendMode::SrcOver,
                nearest,
                None,
                None,
            );
        }
        // Image filters through save_layer.
        19 => {
            for sigma in [0.5, 2.0] {
                blurred_layer(canvas, sigma);
            }
        }
        20 => {
            for sigma in [6.0, 20.0] {
                blurred_layer(canvas, sigma);
            }
        }
        21 => {
            blurred_layer(canvas, 60.0);
            for mode in [0u8, 1, 2] {
                backdrop_layer(canvas, mode);
            }
        }
        // Drop shadows from the real type.
        22 => {
            for (blur, spread) in [(4.0, 0.0), (24.0, 6.0)] {
                let shadow = Shadow::new(
                    skia::Color::from_argb(160, 0, 0, 0),
                    blur,
                    spread,
                    (4.0, 4.0),
                    ShadowStyle::Drop,
                    false,
                );
                canvas.save_layer(
                    &SaveLayerRec::default().paint(&filter_paint(shadow.get_drop_shadow_filter())),
                );
                canvas.draw_rrect(rrect(10.0, 10.0, 80.0, 50.0, 8.0), &fill(true));
                canvas.draw_path(&star(30.0), &fill(true));
                canvas.restore();
            }
        }
        // Inner shadows.
        23 => {
            for spread in [0.0, 3.0] {
                let shadow = Shadow::new(
                    skia::Color::from_argb(200, 0, 0, 0),
                    6.0,
                    spread,
                    (0.0, 0.0),
                    ShadowStyle::Inner,
                    false,
                );
                canvas.draw_rect(
                    rect(0.0, 0.0, 100.0, 60.0),
                    &shadow.get_inner_shadow_paint(true, None),
                );
            }
            let shadow = Shadow::new(
                skia::Color::from_argb(200, 0, 0, 0),
                6.0,
                0.0,
                (0.0, 0.0),
                ShadowStyle::Inner,
                false,
            );
            let blur = blur_filter(3.0);
            canvas.draw_rect(
                rect(0.0, 0.0, 100.0, 60.0),
                &shadow.get_inner_shadow_paint(true, blur.as_ref()),
            );
            let layer_filter =
                compose_filters(blur.as_ref(), shadow.get_inner_shadow_filter().as_ref());
            canvas.save_layer(&SaveLayerRec::default().paint(&filter_paint(layer_filter)));
            canvas.draw_path(&star(60.0), &stroke(8.0, true));
            canvas.restore();
        }
        // Masked group.
        24 => {
            let black = skia::Color::from_argb(255, 0, 0, 0);
            let drop = Shadow::new(black, 6.0, 4.0, (2.0, 2.0), ShadowStyle::Drop, false);
            let inner = Shadow::new(black, 6.0, 0.0, (0.0, 0.0), ShadowStyle::Inner, false);
            let merged = skia::image_filters::merge(
                vec![
                    drop.get_layer_drop_shadow_filter(),
                    None,
                    inner.get_inner_shadow_filter(),
                ],
                None,
            );
            let group_filter = skia::image_filters::blur((3.0, 3.0), None, merged, None);
            let bounds = rect(0.0, 0.0, 200.0, 200.0);
            canvas.save_layer(
                &SaveLayerRec::default()
                    .bounds(&bounds)
                    .paint(&filter_paint(group_filter)),
            );
            canvas.draw_rect(rect(10.0, 10.0, 100.0, 80.0), &fill(true));
            canvas.save_layer(&SaveLayerRec::default().paint(&blend_paint(skia::BlendMode::DstIn)));
            canvas.draw_oval(rect(40.0, 40.0, 80.0, 80.0), &fill(true));
            canvas.restore();
            canvas.restore();
            if let Some(erode) = skia::image_filters::erode((1.0, 1.0), None, None) {
                canvas.save_layer(&SaveLayerRec::default().paint(&filter_paint(Some(erode))));
                canvas.draw_rect(rect(10.0, 10.0, 100.0, 80.0), &fill(true));
                canvas.restore();
            }
        }
        // Drop-shadow compose.
        25 => {
            let linear_mip = sampling(skia::FilterMode::Linear, skia::MipmapMode::Nearest);
            let bounds = rect(0.0, 0.0, 200.0, 200.0);
            canvas.save_layer(
                &SaveLayerRec::default()
                    .bounds(&bounds)
                    .paint(&skia::Paint::default()),
            );
            canvas.draw_rect(rect(0.0, 0.0, 200.0, 200.0), &fill(true));
            let mut color_paint = skia::Paint::default();
            color_paint.set_color(skia::Color::from_argb(255, 0, 0, 0));
            color_paint.set_blend_mode(skia::BlendMode::SrcIn);
            canvas.draw_paint(&color_paint);
            canvas.restore();

            canvas.save();
            canvas.clip_rrect(rrect(10.0, 10.0, 80.0, 60.0, 8.0), None, true);
            source.draw(canvas, (0.0, 0.0), linear_mip, None);
            canvas.restore();

            under(canvas, Xf::Two, |c| {
                for filter in [None, blur_filter(3.0)] {
                    c.draw_image_rect_with_sampling_options(
                        &images.plain,
                        None,
                        rect(0.0, 0.0, 64.0, 64.0),
                        linear_mip,
                        &filter_paint(filter),
                    );
                }
            });
        }
        // Layers and blend modes.
        26 => {
            let mut alpha_paint = skia::Paint::default();
            alpha_paint.set_alpha_f(0.5);
            canvas.save_layer(&SaveLayerRec::default().paint(&alpha_paint));
            canvas.draw_rect(rect(0.0, 0.0, 60.0, 40.0), &fill(true));
            canvas.restore();
            for mode in [
                skia::BlendMode::DstIn,
                skia::BlendMode::SrcIn,
                skia::BlendMode::SrcOut,
                skia::BlendMode::DstOver,
                skia::BlendMode::Src,
            ] {
                canvas.save_layer(&SaveLayerRec::default().paint(&blend_paint(mode)));
                canvas.draw_rect(rect(0.0, 0.0, 60.0, 40.0), &fill(true));
                canvas.restore();
            }
            canvas.save_layer(&SaveLayerRec::default());
            canvas.draw_rect(rect(0.0, 0.0, 100.0, 100.0), &fill(true));
            let mut clear_paint = stroke(10.0, true);
            clear_paint.set_blend_mode(skia::BlendMode::Clear);
            canvas.draw_path(&star(40.0), &clear_paint);
            canvas.restore();
        }
        27 => blend_layers(
            canvas,
            &[
                skia::BlendMode::Multiply,
                skia::BlendMode::Screen,
                skia::BlendMode::Overlay,
                skia::BlendMode::Darken,
                skia::BlendMode::Lighten,
            ],
        ),
        28 => blend_layers(
            canvas,
            &[
                skia::BlendMode::ColorDodge,
                skia::BlendMode::ColorBurn,
                skia::BlendMode::HardLight,
                skia::BlendMode::SoftLight,
                skia::BlendMode::Difference,
            ],
        ),
        29 => blend_layers(
            canvas,
            &[
                skia::BlendMode::Exclusion,
                skia::BlendMode::Hue,
                skia::BlendMode::Saturation,
                skia::BlendMode::Color,
                skia::BlendMode::Luminosity,
            ],
        ),
        // Clips.
        30 => {
            under(canvas, Xf::R, |c| {
                clipped_fill(c, |inner| {
                    inner.clip_rect(rect(0.0, 0.0, 60.0, 60.0), None, true);
                });
            });
            under(canvas, Xf::S, |c| {
                for aa in [true, false] {
                    clipped_fill(c, |inner| {
                        inner.clip_rrect(rrect(0.0, 0.0, 60.0, 60.0, 10.0), None, aa);
                    });
                }
            });
            under(canvas, Xf::R, |c| {
                clipped_fill(c, |inner| {
                    inner.clip_rrect(rrect(0.0, 0.0, 60.0, 60.0, 10.0), None, false);
                });
            });
            under(canvas, Xf::S, |c| {
                for aa in [true, false] {
                    clipped_fill(c, |inner| {
                        inner.clip_path(&star(40.0), None, aa);
                    });
                }
                clipped_fill(c, |inner| {
                    inner.clip_path(&star(40.0), skia::ClipOp::Difference, true);
                });
                clipped_fill(c, |inner| {
                    inner.clip_rrect(rrect(0.0, 0.0, 60.0, 60.0, 10.0), None, true);
                    inner.clip_path(&star(40.0), None, true);
                });
            });
        }
        // Text.
        31 => {
            for size in [12.0, 24.0] {
                let para = paragraph(SAMPLE_TEXT, size, &fill(true), fonts);
                para.paint(canvas, (0.0, 0.0));
                under(canvas, Xf::S, |c| para.paint(c, (0.0, 40.0)));
            }
        }
        32 => {
            for size in [64.0, 300.0] {
                paragraph(SAMPLE_TEXT, size, &fill(true), fonts).paint(canvas, (0.0, 0.0));
            }
            under(canvas, Xf::R, |c| {
                paragraph(SAMPLE_TEXT, 14.0, &fill(true), fonts).paint(c, (0.0, 0.0));
            });
        }
        33 => {
            let stroke_paint = stroke(2.0, true);
            for size in [14.0, 200.0] {
                paragraph(SAMPLE_TEXT, size, &stroke_paint, fonts).paint(canvas, (0.0, 0.0));
            }
            let gradient = linear(&stops(3), 255).to_paint(&rect(0.0, 0.0, 200.0, 30.0), true);
            paragraph(SAMPLE_TEXT, 18.0, &gradient, fonts).paint(canvas, (0.0, 0.0));
        }
        34 => {
            let fill_para = paragraph(SAMPLE_TEXT, 40.0, &fill(true), fonts);
            let stroke_para = paragraph(SAMPLE_TEXT, 40.0, &stroke(3.0, true), fonts);
            canvas.save_layer(&SaveLayerRec::default());
            fill_para.paint(canvas, (0.0, 0.0));
            canvas.save_layer(&SaveLayerRec::default().paint(&blend_paint(skia::BlendMode::SrcIn)));
            stroke_para.paint(canvas, (0.0, 0.0));
            canvas
                .save_layer(&SaveLayerRec::default().paint(&blend_paint(skia::BlendMode::DstOver)));
            fill_para.paint(canvas, (0.0, 0.0));
            canvas.restore();
            canvas.restore();
            canvas.restore();

            canvas.save_layer(&SaveLayerRec::default());
            fill_para.paint(canvas, (0.0, 0.0));
            canvas
                .save_layer(&SaveLayerRec::default().paint(&blend_paint(skia::BlendMode::SrcOut)));
            stroke_para.paint(canvas, (0.0, 0.0));
            canvas.restore();
            canvas.restore();
        }
        35 => {
            let para = paragraph(SAMPLE_TEXT, 24.0, &fill(true), fonts);
            canvas.save_layer(
                &SaveLayerRec::default()
                    .bounds(&rect(0.0, 0.0, 300.0, 60.0))
                    .paint(&filter_paint(blur_filter(3.0))),
            );
            para.paint(canvas, (0.0, 0.0));
            canvas.restore();

            let shadow = Shadow::new(
                skia::Color::from_argb(180, 0, 0, 0),
                4.0,
                0.0,
                (2.0, 2.0),
                ShadowStyle::Drop,
                false,
            );
            canvas.save_layer(
                &SaveLayerRec::default().paint(&filter_paint(shadow.get_drop_shadow_filter())),
            );
            para.paint(canvas, (0.0, 0.0));
            canvas.restore();

            if let Some(erode) = skia::image_filters::erode((1.0, 1.0), None, None) {
                canvas.save_layer(&SaveLayerRec::default().paint(&filter_paint(Some(erode))));
                para.paint(canvas, (0.0, 0.0));
                canvas.restore();
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_step_visits_every_step_in_order_then_stops() {
        let mut seen = Vec::new();
        let mut step = 0;
        loop {
            step = next_step(step);
            if step == 0 {
                break;
            }
            seen.push(step);
        }
        assert_eq!(seen, (1..STEP_COUNT).collect::<Vec<u32>>());
        assert_eq!(next_step(STEP_COUNT), 0);
        assert_eq!(next_step(u32::MAX), 0);
    }

    #[test]
    fn run_step_without_gpu_returns_zero() {
        assert_eq!(run_step(0), 0);
        assert_eq!(run_step(STEP_COUNT - 1), 0);
    }

    #[test]
    fn every_step_draws_on_raster_surfaces() {
        let fonts = crate::render::FontStore::try_new().expect("font store");
        let mut target = skia::surfaces::raster_n32_premul((64, 64)).expect("target surface");
        let mut source = skia::surfaces::raster_n32_premul((32, 32)).expect("source surface");
        let mut mip_surface = skia::surfaces::raster_n32_premul((16, 16)).expect("mip surface");
        let mut plain_surface = skia::surfaces::raster_n32_premul((16, 16)).expect("plain surface");
        let images = WarmUpImages {
            mip: mip_surface.image_snapshot(),
            plain: plain_surface.image_snapshot(),
        };
        for step in 0..STEP_COUNT {
            let canvas = target.canvas();
            canvas.clear(skia::Color::TRANSPARENT);
            draw_step(step, canvas, &mut source, &images, fonts.font_collection());
        }
    }
}
