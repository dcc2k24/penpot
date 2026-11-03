;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.render-wasm.api
  "A WASM based render API"
  (:require
   ["react-dom/server" :as rds]
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.exceptions :as ex]
   [app.common.files.focus :as cpf]
   [app.common.files.helpers :as cfh]
   [app.common.fonts :as cfnt]
   [app.common.logging :as log]
   [app.common.math :as mth]
   [app.common.render-wasm.api.props :as props]
   [app.common.render-wasm.api.select :as wselect]
   [app.common.render-wasm.api.upload :as upload]
   [app.common.render-wasm.helpers :as h]
   [app.common.render-wasm.mem :as mem]
   [app.common.render-wasm.mem.heap32 :as mem.h32]
   [app.common.render-wasm.serialize-shape :as serialize-shape]
   [app.common.render-wasm.serializers :as sr]
   [app.common.render-wasm.serializers.color :as sr-clr]
   [app.common.render-wasm.svg-derived :as svg-derived]
   [app.common.render-wasm.text-content :as rtc]
   [app.common.render-wasm.wasm :as wasm]
   [app.common.transit :as transit]
   [app.common.types.color :as clr]
   [app.common.types.fills :as types.fills]
   [app.common.types.objects-hints :as ohints]
   [app.common.types.objects-map :as omap]
   [app.common.types.path :as path]
   [app.common.types.path.impl :as path.impl]
   [app.common.types.shape.layout :as ctl]
   [app.common.types.text :as txt]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.data.helpers :as dsh]
   [app.main.data.notifications :as ntf]
   [app.main.data.render-wasm :as drw]
   [app.main.data.workspace.texts-v3 :as texts]
   [app.main.fonts :as fonts]
   [app.main.refs :as refs]
   [app.main.router :as rt]
   [app.main.store :as st]
   [app.main.ui.shapes.text]
   ;; Required for side effects: binds the generated enums.
   [app.render-wasm.api.enums]
   [app.render-wasm.api.fonts :as f]
   [app.render-wasm.api.texts :as t]
   [app.render-wasm.api.webgl :as webgl]
   [app.render-wasm.deserializers :as dr]
   [app.render-wasm.gesture :as wasm-gesture]
   [app.render-wasm.page-cache :as page-cache]
   [app.render-wasm.performance :as perf]
   [app.render-wasm.rulers-state :as rulers-state]
   [app.render-wasm.text-editor :as text-editor]
   [app.render-wasm.text-paste :as text-paste]
   [app.render-wasm.upload-entry :as ue]
   [app.render-wasm.upload-pool :as pool]
   [app.util.debug :as dbg]
   [app.util.dom :as dom]
   [app.util.functions :as fns]
   [app.util.globals :as ug]
   [app.util.i18n :refer [tr]]
   [app.util.modules :as mod]
   [app.util.text.content :as tc]
   [app.util.timers :as timers]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]
   [promesa.core :as p]
   [rumext.v2 :as mf]))

(def use-dpr? (contains? cf/flags :render-wasm-dpr))

(defn- wasm-get-numeric-value
  "Read a positive numeric query param (e.g. `?dpr=2`)."
  [name]
  (when-let [raw (let [p (rt/get-params @st/state)]
                   (get p name))]
    (let [n (if (string? raw) (js/parseFloat raw) raw)]
      (when (and (number? n) (not (js/isNaN n)) (pos? n))
        n))))

;; --- Page transition state (WASM viewport)
;;
;; Goal: avoid showing tile-by-tile rendering during page switches (and initial load),
;; by keeping a blurred snapshot overlay visible until WASM dispatches
;; `penpot:wasm:tiles-complete`.
;;
;; - `page-transition?`: true while the overlay should be considered active.
;;   Pan/zoom into WASM is frozen until `tiles-complete` (atlas still empty).
;; - `transition-image*`: image shown by the UI overlay (usually an `ImageBitmap`
;;   snapshot of the WebGL canvas; on initial load it may be a tiny SVG data-url
;;   string derived from the page background color).
;; - `transition-epoch*`: monotonic counter used to ignore stale async work/events
;;   when the user clicks pages rapidly (A -> B -> C).
;; - `transition-tiles-handler*`: the currently installed DOM event handler for
;;   `penpot:wasm:tiles-complete`, so we can remove/replace it safely.
(defonce page-transition? (atom false))
(defonce context-loss-overlay? (atom false))
;; Skipped set-view-box during transition; flushed when the overlay ends.
(defonce ^:private viewport-dirty-during-transition? (atom false))
;; When true (initial load) the overlay clips out the ruler strips so the live
;; rulers show through. False (page switch / context loss) keeps the snapshot's
;; baked-in rulers full-bleed to avoid a blank-strip flicker on canvas remount.
(defonce transition-reveal-rulers? (atom false))
(defonce transition-image* (atom nil))
(defonce transition-epoch* (atom 0))
(defonce transition-tiles-handler* (atom nil))
(defonce snapshot-tiles-handler* (atom nil))

(def ^:private snapshot-capture-debounce-ms 1000)
;; Guards against stacking readbacks: one capture may still be in flight when
;; the next `tiles-complete` arrives.
(defonce ^:private snapshot-capture-in-flight? (atom false))


(defn initialized?
  "True when the WASM render context is safe for normal application calls.
  False while missing/lost or while `reload-renderer!` is reconstructing it.

  App/data code and tests should use this (tests can `set!` it). Prefer
  `(initialized?)` over `(wasm/ready?)` inside this namespace so readiness
  stays mockable; use `wasm/live?` for reload-internal ops."
  []
  (wasm/ready?))

(declare sync-workspace-local-viewport!)


(defn set-transition-image-from-background!
  "Sets `transition-image*` to a data URL representing a solid background color."
  [background]
  (when (string? background)
    (let [svg (str "<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'>"
                   "<rect width='1' height='1' fill='" background "'/>"
                   "</svg>")]
      (reset! transition-image*
              (str "data:image/svg+xml;charset=utf-8," (js/encodeURIComponent svg))))))

(defn begin-page-transition!
  []
  (reset! page-transition? true)
  (reset! viewport-dirty-during-transition? false)
  (swap! transition-epoch* inc))

(defn end-page-transition!
  []
  (reset! page-transition? false)
  (when-let [prev @transition-tiles-handler*]
    (.removeEventListener ^js ug/document "penpot:wasm:tiles-complete" prev))
  (reset! transition-tiles-handler* nil)
  (reset! transition-image* nil)
  ;; Keyboard/wheel may have moved workspace-local while WASM was frozen.
  (when (and (initialized?) @viewport-dirty-during-transition?)
    (reset! viewport-dirty-during-transition? false)
    (sync-workspace-local-viewport! @st/state)))

(defn- set-transition-tiles-complete-handler!
  "Installs a tiles-complete handler bound to the current transition epoch.
   Replaces any previous handler so rapid page switching doesn't end the wrong transition."
  [epoch f]
  (when-let [prev @transition-tiles-handler*]
    (.removeEventListener ^js ug/document "penpot:wasm:tiles-complete" prev))
  (letfn [(handler [_]
            (when (= epoch @transition-epoch*)
              (.removeEventListener ^js ug/document "penpot:wasm:tiles-complete" handler)
              (reset! transition-tiles-handler* nil)
              (f)))]
    (reset! transition-tiles-handler* handler)
    (.addEventListener ^js ug/document "penpot:wasm:tiles-complete" handler)))

(defn arm-page-transition-end!
  "Arms the end of an active page transition: installs a `tiles-complete` handler
   (bound to the current epoch) that ends the transition on the next full frame.

   Called once the target page's shapes have been loaded into WASM, so the
   earlier/empty frames rendered while the previous page is still mounted and
   while the fresh canvas re-initializes cannot dismiss the blur prematurely.
   No-op when no transition is active."
  []
  (when @page-transition?
    (set-transition-tiles-complete-handler! @transition-epoch* end-page-transition!)))

(defn start-initial-load-transition!
  "Starts a page-transition workflow for initial file open.

   - Sets `page-transition?` to true
   - Uses a solid background-color placeholder as the transition image
   - The tiles-complete handler that ends the transition is armed later, once
     the page's shapes are loaded (see `arm-page-transition-end!`)"
  [background]
  (reset! transition-reveal-rulers? true) ; reveal the live rulers
  ;; If something already toggled `page-transition?` (e.g. legacy init code paths),
  ;; ensure we still have a deterministic placeholder on initial load.
  (when (or (not @page-transition?) (nil? @transition-image*))
    (set-transition-image-from-background! background))
  (when-not @page-transition?
    ;; Start the transition. The tiles-complete → end handler is armed later,
    ;; once the target page's shapes are loaded (see `arm-page-transition-end!`),
    ;; so an earlier/empty frame can't dismiss the overlay prematurely.
    (begin-page-transition!)))

(defn- start-context-loss-overlay!
  []
  (reset! context-loss-overlay? true))

(defn- end-context-loss-overlay!
  []
  (reset! context-loss-overlay? false)
  (when-not @page-transition?
    (reset! transition-image* nil)))

(defn listen-tiles-render-complete-once!
  "Registers a one-shot listener for `penpot:wasm:tiles-complete`, dispatched from WASM
  when a full tile pass finishes."
  [f]
  (.addEventListener ^js ug/document
                     "penpot:wasm:tiles-complete"
                     (fn [_]
                       (f))
                     #js {:once true}))

(defn text-editor-wasm?
  []
  (or (contains? cf/flags :feature-text-editor-wasm)
      (let [runtime-features (get @st/state :features-runtime)
            enabled-features (get @st/state :features)]
        (or (contains? runtime-features "text-editor-wasm/v1")
            (contains? enabled-features "text-editor-wasm/v1")))))

(def ^:const UUID-U8-SIZE 16)
(def ^:const UUID-U32-SIZE (/ UUID-U8-SIZE 4))

;; FIXME: Migrate this as we adjust the DTO structure in wasm
(def ^:const MODIFIER-U8-SIZE 40)
(def ^:const MODIFIER-U32-SIZE (/ MODIFIER-U8-SIZE 4))
(def ^:const MODIFIER-TRANSFORM-U8-OFFSET-SIZE 16)
(def ^:const INPUT-MODIFIER-U8-SIZE 44)
(def ^:const INPUT-MODIFIER-U32-SIZE (/ INPUT-MODIFIER-U8-SIZE 4))

(def ^:const GRID-LAYOUT-ROW-U8-SIZE 8)
(def ^:const GRID-LAYOUT-COLUMN-U8-SIZE 8)
(def ^:const GRID-LAYOUT-CELL-U8-SIZE 36)

(def ^:const DEBOUNCE_DELAY_MS 100)

(defonce ^:private view-interaction-active? (atom false))

;; Threshold below which we use synchronous processing (no chunking overhead)
(def ^:const ASYNC_THRESHOLD 100)

;; Text editor events.
(def ^:const TEXT_EDITOR_EVENT_NONE 0)
(def ^:const TEXT_EDITOR_EVENT_CONTENT_CHANGED 1)
(def ^:const TEXT_EDITOR_EVENT_SELECTION_CHANGED 2)
(def ^:const TEXT_EDITOR_EVENT_STYLES_CHANGED 3)
(def ^:const TEXT_EDITOR_EVENT_NEEDS_LAYOUT 4)

;; Re-export public WebGL functions
(def draw-thumbnail-to-canvas webgl/draw-thumbnail-to-canvas)

;; Re-export public text editor functions
(def text-editor-apply-theme text-editor/text-editor-apply-theme)
(def text-editor-focus text-editor/text-editor-focus)
(def text-editor-blur text-editor/text-editor-blur)
(def text-editor-set-cursor-from-offset text-editor/text-editor-set-cursor-from-offset)
(def text-editor-set-cursor-from-point text-editor/text-editor-set-cursor-from-point)
(def text-editor-toggle-overtype-mode text-editor/text-editor-toggle-overtype-mode)
(def text-editor-pointer-down text-editor/text-editor-pointer-down)
(def text-editor-pointer-down-extend text-editor/text-editor-pointer-down-extend)
(def text-editor-pointer-move text-editor/text-editor-pointer-move)
(def text-editor-pointer-up text-editor/text-editor-pointer-up)
(def text-editor-get-current-styles text-editor/text-editor-get-current-styles)
(def text-editor-has-focus? text-editor/text-editor-has-focus?)
(def text-editor-has-selection? text-editor/text-editor-has-selection?)
(def text-editor-get-active-shape-id text-editor/text-editor-get-active-shape-id)
(def text-editor-select-all text-editor/text-editor-select-all)
(def text-editor-select-word-boundary text-editor/text-editor-select-word-boundary)
(def text-editor-select-paragraph text-editor/text-editor-select-paragraph)
(def text-editor-sync-content text-editor/text-editor-sync-content)


(defn get-dpr
  "Returns the current device pixel ratio. Use instead of `dpr` wherever
   the value must reflect browser-zoom changes that happen after load.

   Override with query param `?dpr=2` (or any positive number) for HiDPI repro
   without relying on the real `devicePixelRatio`."
  []
  (or (wasm-get-numeric-value :dpr)
      (if use-dpr?
        (let [d (.-devicePixelRatio ^js ug/window)]
          ;; In workers `ug/window` is a mock without `devicePixelRatio`,
          ;; so guard against nil/NaN/non-positive values.
          (if (and (number? d) (pos? d)) d 1.0))
        1.0)))

(def noop-fn
  (constantly nil))

;;
(def shape-wrapper-factory nil)

(defn- yield-to-browser
  "Returns a promise that resolves after yielding to the browser's event loop.
   Uses MessageChannel for near-zero delay (avoids setTimeout's 4ms minimum
   after nesting depth > 5). Same technique used by React's scheduler. Each
   call has its own channel, closed once it has fired."
  []
  (p/create
   (fn [resolve _reject]
     (let [^js ch (js/MessageChannel.)]
       (set! (.-onmessage (.-port1 ch))
             (fn [_]
               (.close (.-port1 ch))
               (.close (.-port2 ch))
               (resolve nil)))
       (.postMessage (.-port2 ch) nil)))))

;; Based on app.main.render/object-svg
(mf/defc object-svg*
  [{:keys [shape]}]
  (let [objects (mf/deref refs/workspace-page-objects)
        shape-wrapper
        (mf/with-memo [shape]
          (shape-wrapper-factory objects))]

    [:svg {:version "1.1"
           :xmlns "http://www.w3.org/2000/svg"
           :xmlnsXlink "http://www.w3.org/1999/xlink"
           :fill "none"}
     [:& shape-wrapper {:shape shape}]]))

(defn is-text-editor-wasm-enabled
  [state]
  (let [runtime-features (get state :features-runtime)
        enabled-features (get state :features)]
    (or (contains? runtime-features "text-editor-wasm/v1")
        (contains? enabled-features "text-editor-wasm/v1"))))

(defn get-static-markup
  [shape]
  (->
   (mf/element object-svg* #js {:shape shape})
   (rds/renderToStaticMarkup)))

;; forward declare helpers so render can call them
(declare request-render)
(declare set-shape-vertical-align fonts-from-text-content)
(declare reload-renderer!)
(declare request-render-preserving-target)
(declare render-pending?)

(defn- needs-more-render-frames?
  "True when WASM still has progressive tile work (visible or interest ring)."
  []
  (or (= wasm/internal-frame-type wasm/FRAME_TYPE_PARTIAL)
      (= wasm/internal-frame-type wasm/FRAME_TYPE_VIEWPORT_READY)))

(defn- internal-render
  ([]
   (internal-render 0))
  ([timestamp]
   (internal-render timestamp wasm/internal-frame-type))
  ([timestamp flags]
   (set! wasm/internal-frame-type (h/call wasm/internal-module "_render" timestamp flags))
   (when (needs-more-render-frames?)
     (request-render "frame-type-partial"))))

(defn- build-reload-payload
  "Builds renderer reload payload from current application state.
   Avoids keeping heavyweight object snapshots in memory."
  []
  (let [state      @st/state
        file-id    (:current-file-id state)
        page-id    (:current-page-id state)
        page       (dsh/lookup-page state file-id page-id)
        objects    (dsh/lookup-page-objects state file-id page-id)
        focus      (:workspace-focus-selected state)
        local      (:workspace-local state)
        zoom       (:zoom local)
        vbox       (:vbox local)
        canvas     wasm/canvas
        background (get page :background clr/canvas)]
    {:canvas canvas
     :base-objects (cpf/focus-objects objects focus)
     :page-id page-id
     :zoom zoom
     :vbox vbox
     :background background}))

(declare set-rulers-colors!
         set-rulers-visible!
         set-rulers-frame-visible!
         set-rulers-offsets!
         set-rulers-selection!)

(defn push-ruler-theme-colors!
  []
  (if-let [{:keys [bg border label accent]} (rulers-state/theme-colors)]
    (set-rulers-colors! bg border label accent)
    (js/console.error "Failed to resolve ruler CSS colors")))

(defn- sync-rulers-to-wasm!
  [{:keys [show-rulers? frame-visible? offset-x offset-y ruler-selection push-colors?]
    :or {push-colors? true frame-visible? true}}]
  (when push-colors? (push-ruler-theme-colors!))
  (set-rulers-frame-visible! frame-visible?)
  (set-rulers-visible! show-rulers?)
  (when show-rulers?
    (set-rulers-offsets! offset-x offset-y)
    (set-rulers-selection! ruler-selection)))

(defn free-gpu-resources
  []
  ;; Do not use `wasm/live?` here: after `webglcontextrestored` we keep
  ;; `context-lost?` true until re-init, but the browser context is usable again
  ;; and must release GPU objects before `_clean_up` / context deletion.
  (when (and wasm/context-initialized? (wasm/module-ready?))
    (h/call wasm/internal-module "_free_gpu_resources")))

;; When set, the next render keeps the previously presented frame on screen
;; while the new tiles are rasterized, instead of clearing the canvas first.
;; See `request-render-preserving-target`.
(defonce ^:private preserve-target-render? (atom false))

(defn- drain-text-editor-events!
  "Pop and handle every pending text-editor event.

   StylesChanged syncs the caret's current styles to the toolbar. Returns true
   when some event needs a full shape re-render (content or layout changed)."
  []
  (loop [needs-render? false]
    (let [ev (text-editor/text-editor-poll-event)]
      (if (or (nil? ev) (= ev TEXT_EDITOR_EVENT_NONE))
        needs-render?
        (do
          (when (= ev TEXT_EDITOR_EVENT_STYLES_CHANGED)
            (let [current-styles (text-editor/text-editor-get-current-styles)
                  shape-id (text-editor/text-editor-get-active-shape-id)]
              ;; Keep the caret color matching the text at the caret position.
              (text-editor/text-editor-apply-caret-color (:fills current-styles))
              (st/emit! (texts/v3-update-text-editor-styles shape-id current-styles))))
          (recur (or needs-render?
                     (= ev TEXT_EDITOR_EVENT_CONTENT_CHANGED)
                     (= ev TEXT_EDITOR_EVENT_NEEDS_LAYOUT))))))))

;; This should never be called from the outside.
(defn- render
  [timestamp]
  (when (wasm/live?)
    ;; SYNC-TILES makes WASM keep the last presented frame while the new tiles
    ;; are rasterized, rather than clearing to the background first. The flag is
    ;; one-shot on both sides: WASM clears it when the render loop starts, so
    ;; the progressive continuation frames behave normally.
    (if (compare-and-set! preserve-target-render? true false)
      (internal-render timestamp (bit-or wasm/internal-frame-type wasm/RENDER_FLAG_SYNC_TILES))
      (internal-render timestamp))

    ;; Update text editor blink (so cursor toggles) using the same timestamp
    (try
      (when (is-text-editor-wasm-enabled @st/state)
        (text-editor/text-editor-update-blink timestamp)
        ;; The editor overlay is painted by the WASM frame composition; only
        ;; content/layout changes need a full shape re-render here.
        (when (drain-text-editor-events!)
          (request-render-preserving-target "text-editor-content")))
      (catch :default e
        (js/console.error "text-editor overlay/update failed:" e)))

    (set! wasm/internal-frame-id nil)
    (ug/dispatch! (ug/event "penpot:wasm:render"))))

(defn render-ui-only
  "Renders only the canvas background and UI surface (rulers/frame) without
   rebuilding shape tiles. Fast synchronous call used to show the viewport
   frame immediately before a potentially slow tile rebuild."
  []
  (when (wasm/live?)
    (h/call wasm/internal-module "_render_ui_only")))

(defn render-from-backbuffer!
  "Re-present the last fully rendered frame with the UI overlay (rulers,
   selection band) redrawn on top, reusing the crisp Backbuffer instead of
   rebuilding it from the scale-capped document atlas.

   For UI-only updates that must not kick off a progressive shape re-render. The
   alternative — blitting shapes from the cached tile atlas (WASM
   `_render_from_cache`, what pan/zoom uses in `set-view-box`) — is fine at
   normal zoom, but on a zoomed-in view (>1000%) it is a heavy upscale that
   flashes crisp->blurry->crisp. Reusing the Backbuffer is pixel-identical at
   any zoom. Only valid on a stable viewbox; pan/zoom must keep using the atlas
   blit, whose preview tracks the moving viewport."
  []
  (when (wasm/live?)
    (h/call wasm/internal-module "_render_from_backbuffer")))

(defn render-text-editor-overlay!
  "Repaint the text-editor caret and selection over the last fully rendered
   frame, without a full (tile-rebuilding) render.

   Caret/selection changes — the blink, clicks, drag-selection, arrow-key
   navigation — never alter the shapes. `text-editor-render-caret` re-composes
   the frame from the Backbuffer (which still holds the last complete render)
   and draws the caret/selection overlay on top, so the shapes are pixel
   identical to the last full render at any zoom level. A full `request-render`
   would instead blank the canvas and re-rasterize tiles progressively, which
   flashes on zoomed-in views; blitting from the cached tile atlas
   (`_render_from_cache`) would instead look softer when upscaled (the atlas is
   scale-capped), so the blink would alternate crisp/soft — a subtler flash.
   Pending editor events are still drained so the style toolbar stays in sync; a
   full render is only requested when content or layout actually changed."
  []
  (when (and (wasm/live?)
             ;; Skip when a render is already pending: `text-editor-render-caret`
             ;; composes from the Backbuffer, but a progressive render (multiple
             ;; rAF frames at high zoom) is still rebuilding it. Compositing then
             ;; would show a half-built frame — a sparse, timing-dependent flash.
             ;; The in-flight render draws the overlay itself when it completes.
             (not (render-pending?)))
    (when (is-text-editor-wasm-enabled @st/state)
      (text-editor/text-editor-update-blink (js/performance.now))
      ;; Drain before painting so the caret color (updated on StylesChanged when
      ;; the caret crosses into differently-colored text) is applied before the
      ;; overlay is drawn, instead of lagging a frame behind.
      (let [needs-render? (drain-text-editor-events!)]
        (text-editor/text-editor-render-caret)
        (when needs-render?
          (request-render-preserving-target "text-editor-content"))))))

;; CSS-pixel blur radius for the page-transition snapshot (DPR-scaled in WASM).
(def ^:private TRANSITION_BLUR_RADIUS 4.0)

(defn render-blurred-snapshot!
  "Blurs the current page into the canvas so a following
   `capture-canvas-snapshot` grabs an already-blurred transition frame."
  []
  (when (wasm/live?)
    (h/call wasm/internal-module "_render_blurred_snapshot" TRANSITION_BLUR_RADIUS)))

(defn render-sync
  []
  (when (initialized?)
    (h/call wasm/internal-module "_render_sync")
    (set! wasm/internal-frame-id nil)))

(defn render-sync-shape
  [id]
  (when (initialized?)
    (let [buffer (uuid/get-u32 id)]
      (h/call wasm/internal-module "_render_sync_shape"
              (aget buffer 0)
              (aget buffer 1)
              (aget buffer 2)
              (aget buffer 3))
      (set! wasm/internal-frame-id nil))))

(defn render-preview!
  "Render a lightweight preview without tile caching.
   Used during progressive loading for fast feedback."
  []
  (when (initialized?)
    (h/call wasm/internal-module "_render_preview")))


(defonce pending-render (atom false))
(defonce shapes-loading? (atom false))
(defonce deferred-render? (atom false))

;; Each `request-render` captures this number. `stop-progressive-render!`
;; increments it so already-scheduled rAFs become no-ops.
;;
;; Why: ViewportReady asks for another frame for the interest ring. If the
;; page changes before that frame runs, `_init` leaves an empty shapes pool
;; and `_render` panics ("Root shape not found"). Cancel alone is not enough
;; when the current `_render` itself schedules the next rAF after we cancelled.
(defonce ^:private render-seq* (atom 0))

(defn render-pending?
  "True while a render has been scheduled but not yet completed — including the
   frames of an in-progress progressive render."
  []
  @pending-render)

(defn capture-canvas-snapshot
  "Captures the viewport canvas into `wasm/canvas-snapshot` (an `ImageBitmap`)
   and closes the replaced snapshot unless the transition overlay is still
   showing it (a replaced snapshot can never become displayed again, so closing
   it is safe). Returns a promise resolving to the bitmap (or nil)."
  []
  (let [^js prev wasm/canvas-snapshot]
    (-> (webgl/capture-canvas-snapshot)
        (p/then (fn [^js bitmap]
                  (when (and (some? prev)
                             (some? bitmap)
                             (not (identical? prev bitmap))
                             (not (identical? prev @transition-image*)))
                    (.close prev))
                  bitmap)))))

(defn- canvas-snapshot-capture-idle?
  "The capture is a full GPU readback of the canvas. On Firefox (out-of-process
  WebGL) `createImageBitmap` blocks the main thread on a synchronous
  `Msg_ReadPixels` until the whole queued GL command backlog has drained, so it
  must never run while more frames are still coming."
  []
  (and (initialized?)
       (some? wasm/canvas)
       (not @snapshot-capture-in-flight?)
       (not @view-interaction-active?)
       (not @shapes-loading?)
       (not @page-transition?)
       (not (render-pending?))))

(declare schedule-canvas-snapshot-capture!)

(defn- capture-canvas-snapshot-when-idle!
  []
  ;; Retry instead of waiting for another `tiles-complete`: WASM notifies once
  ;; per render cycle (`ViewportReady` sets `viewport_presented`, so the
  ;; interest-ring `Full` stays silent), and that notification is what armed us.
  (if-not (canvas-snapshot-capture-idle?)
    (schedule-canvas-snapshot-capture!)
    (timers/schedule-on-idle
     (fn []
       (if-not (canvas-snapshot-capture-idle?)
         (schedule-canvas-snapshot-capture!)
         (do
           (reset! snapshot-capture-in-flight? true)
           (-> (capture-canvas-snapshot)
               (p/catch (fn [_] nil))
               (p/finally (fn [_ _] (reset! snapshot-capture-in-flight? false))))))))))

(defonce ^:private schedule-canvas-snapshot-capture!
  (fns/debounce capture-canvas-snapshot-when-idle! snapshot-capture-debounce-ms))

(defn- start-canvas-snapshot-listener!
  []
  (when-let [prev @snapshot-tiles-handler*]
    (.removeEventListener ^js ug/document "penpot:wasm:tiles-complete" prev))
  (let [handler (fn [_] (schedule-canvas-snapshot-capture!))]
    (reset! snapshot-tiles-handler* handler)
    (.addEventListener ^js ug/document "penpot:wasm:tiles-complete" handler)))

(defn- stop-canvas-snapshot-listener!
  []
  (when-let [prev @snapshot-tiles-handler*]
    (.removeEventListener ^js ug/document "penpot:wasm:tiles-complete" prev))
  (reset! snapshot-tiles-handler* nil)
  (reset! snapshot-capture-in-flight? false)
  (when-let [cancel (unchecked-get schedule-canvas-snapshot-capture! "cancel")]
    (cancel)))

;; Skia compiles GPU programs on first use, which stalls the first zoom.
;; This compiles them one small batch per idle callback instead. The programs
;; belong to the GL context, so this runs once per context: it is armed in
;; `init-canvas-context` and removed in `clear-canvas` and on context loss.
;; A step takes 50-250 ms of main thread, so it also waits until the user
;; has paused: no pointer, key or wheel input for
;; `shader-warmup-input-quiet-ms`.
(defonce ^:private shader-warmup-tiles-handler* (atom nil))
(defonce ^:private shader-warmup-idle-id* (atom nil))
(defonce ^:private shader-warmup-epoch* (atom 0))
(def ^:private shader-warmup-min-idle-ms 8)
(def ^:private shader-warmup-input-quiet-ms 2000)
;; `performance.now()` of the last user input, or nil before any.
(defonce ^:private shader-warmup-last-input* (atom nil))
(def ^:private shader-warmup-input-events
  #js ["pointerdown" "pointermove" "keydown" "wheel"])

(defn- shader-warmup-input-wait-ms
  "Milliseconds left before the input pause that a warm-up step needs, given
  the time `now` and the time `last-input` of the last input (nil when there
  was none). 0 when a step may run."
  [now last-input]
  (if (nil? last-input)
    0
    (mth/max 0 (- (+ last-input shader-warmup-input-quiet-ms) now))))

(defn- note-shader-warmup-input!
  [_]
  (reset! shader-warmup-last-input* (js/performance.now)))

;; Stable identity, so `removeEventListener` matches across hot reloads.
(defonce ^:private shader-warmup-input-listener
  (fn [event] (note-shader-warmup-input! event)))

(defn- listen-shader-warmup-input!
  []
  (doseq [event shader-warmup-input-events]
    (.addEventListener ^js ug/document event shader-warmup-input-listener
                       #js {:capture true :passive true})))

(defn- unlisten-shader-warmup-input!
  []
  (doseq [event shader-warmup-input-events]
    (.removeEventListener ^js ug/document event shader-warmup-input-listener
                          #js {:capture true})))

(defn- idle-callback-supported?
  []
  (and (exists? js/globalThis)
       (fn? (unchecked-get js/globalThis "requestIdleCallback"))
       (fn? (unchecked-get js/globalThis "cancelIdleCallback"))))

(defn- shader-warmup-busy?
  []
  (or (not (initialized?))
      @view-interaction-active?
      @shapes-loading?
      @page-transition?
      (render-pending?)))

(defn- cancel-shader-warmup!
  []
  (swap! shader-warmup-epoch* inc)
  (when-let [id @shader-warmup-idle-id*]
    (when (fn? (unchecked-get js/globalThis "cancelIdleCallback"))
      (.cancelIdleCallback js/globalThis id)))
  (reset! shader-warmup-idle-id* nil))

(defn- schedule-shader-warmup-step!
  [epoch step]
  (let [wait-ms (shader-warmup-input-wait-ms (js/performance.now)
                                             @shader-warmup-last-input*)]
    (if (pos? wait-ms)
      ;; Recent input: come back once the pause is long enough.
      (timers/schedule wait-ms
                       #(when (= epoch @shader-warmup-epoch*)
                          (schedule-shader-warmup-step! epoch step)))
      (reset! shader-warmup-idle-id*
              (.requestIdleCallback
               js/globalThis
               (fn [^js deadline]
                 (reset! shader-warmup-idle-id* nil)
                 (when (= epoch @shader-warmup-epoch*)
                   (cond
                     (or (shader-warmup-busy?)
                         (pos? (shader-warmup-input-wait-ms
                                (js/performance.now)
                                @shader-warmup-last-input*))
                         (< (.timeRemaining deadline) shader-warmup-min-idle-ms))
                     (schedule-shader-warmup-step! epoch step)

                     ;; Stale WASM build without the export: stop.
                     (not (fn? (unchecked-get wasm/internal-module "_warm_up_shaders")))
                     nil

                     :else
                     (let [result (try
                                    (h/call wasm/internal-module "_warm_up_shaders" step)
                                    (catch :default cause
                                      (log/warn :hint "shader warm-up failed" :cause cause)
                                      nil))]
                       (when (and (number? result) (pos? result))
                         (schedule-shader-warmup-step! epoch result)))))))))))

(defn- stop-shader-warmup!
  []
  (when-let [handler @shader-warmup-tiles-handler*]
    (.removeEventListener ^js ug/document "penpot:wasm:tiles-complete" handler))
  (reset! shader-warmup-tiles-handler* nil)
  (unlisten-shader-warmup-input!)
  (cancel-shader-warmup!))

(defn- start-shader-warmup-listener!
  []
  (stop-shader-warmup!)
  (when (idle-callback-supported?)
    (listen-shader-warmup-input!)
    (let [handler (fn handler [_]
                    (.removeEventListener ^js ug/document "penpot:wasm:tiles-complete" handler)
                    (reset! shader-warmup-tiles-handler* nil)
                    (schedule-shader-warmup-step! @shader-warmup-epoch* 0))]
      (reset! shader-warmup-tiles-handler* handler)
      (.addEventListener ^js ug/document "penpot:wasm:tiles-complete" handler))))

(defn- stop-progressive-render!
  "Cancel the pending tile-pass rAF and invalidate any follow-ups it may schedule."
  []
  (swap! render-seq* inc)
  (when-let [frame-id wasm/internal-frame-id]
    (timers/cancel-af! frame-id)
    (set! wasm/internal-frame-id nil))
  (reset! pending-render false)
  (set! wasm/internal-frame-type wasm/FRAME_TYPE_NONE))

(defn- register-deferred-render!
  []
  (reset! deferred-render? true))

(defn request-render
  [_requester]
  ;; Use `wasm/live?` (not `wasm/ready?`) so reload-internal
  ;; renders can run while `reloading?` still blocks external mutations.
  (when (and (wasm/live?) (not @wasm/disable-request-render?))
    (if @shapes-loading?
      (register-deferred-render!)
      (when-not @pending-render
        (reset! pending-render true)
        (let [seq-n    @render-seq*
              frame-id (timers/raf
                        (fn [ts]
                          ;; Dropped if `stop-progressive-render!` ran since we scheduled.
                          (when (= seq-n @render-seq*)
                            (reset! pending-render false)
                            (set! wasm/internal-frame-id nil)
                            (try
                              (render ts)
                              (catch :default e
                                ;; A failed render (e.g. a WASM panic) must not strand an
                                ;; active page-transition. Force ending of it so the
                                ;; workspace is shown without a blur.
                                (end-page-transition!)
                                (throw e))))))]
          (set! wasm/internal-frame-id frame-id))))))

(defn request-render-preserving-target
  "Like `request-render`, but keeps the previously presented frame on screen
   while the new tiles are rasterized instead of blanking the canvas first.

   A plain `request-render` goes through WASM's `reset_canvas`, which clears to
   the background colour and then fills the viewport tile by tile. When that
   rasterization spans more than one frame — as it does on zoomed-in views,
   where glyphs are expensive to raster — the cleared canvas is visible as a
   flash. Preserving the target is what the renderer already does after a
   pan/zoom gesture for exactly this reason.

   Use for shape edits on a stable viewbox (typing in the text editor), where
   the previous frame is a good stand-in until the new one is ready."
  [requester]
  (reset! preserve-target-render? true)
  (request-render requester))

(defn- begin-shapes-loading!
  []
  (reset! shapes-loading? true)
  (let [was-pending @pending-render]
    (stop-progressive-render!)
    (reset! deferred-render? was-pending)))

(defn- end-shapes-loading!
  []
  (let [was-loading (compare-and-set! shapes-loading? true false)]
    (reset! deferred-render? false)
    ;; Always trigger a render after loading completes
    ;; This ensures shapes are displayed even if no deferred render was requested
    (when was-loading
      (request-render "set-objects:flush"))))

(declare get-text-dimensions)

(defn has-shape
  [id]
  (when (wasm/live?)
    (let [buffer (uuid/get-u32 id)

          result
          (h/call wasm/internal-module "_has_shape"
                  (aget buffer 0)
                  (aget buffer 1)
                  (aget buffer 2)
                  (aget buffer 3))]
      (= result 1))))

(defn- write-text-content!
  "Push every paragraph of `content` to the current WASM text shape."
  [content]
  (let [paragraph-set (first (get content :children))
        paragraphs    (get paragraph-set :children)]
    (doseq [paragraph paragraphs
            :let [spans (get paragraph :children)]
            :when (seq spans)]
      (let [text (apply str (map :text spans))]
        (t/write-shape-text spans paragraph text)))))

(defn- text-content-fonts
  "Faces used by `content` (`:fonts`) and the fallback faces (emoji, Noto,
   ...) its text needs (`:fallback-fonts`). Pure: computed once per text
   during a bulk upload and shared by the font-state and upload steps."
  [content]
  {:fonts          (f/get-content-fonts content)
   :fallback-fonts (fonts-from-text-content content false)})

(defn- upload-text-content!
  "Body of `set-shape-text-content`. `text-fonts` (from `text-content-fonts`)
   lets the bulk upload reuse the faces it already resolved; nil computes
   them here. Kept apart from the public fn so that one stays single-arity
   (tests replace it with a single-arity mock)."
  [shape-id content text-fonts]
  ;; Cache content for text editor sync
  (text-editor/cache-shape-text-content! shape-id content)

  ;; Skip when the GL/WASM context is not usable. Use `wasm/live?` (not
  ;; `initialized?`) so context-restore reload can re-upload text while
  ;; `reloading?` still blocks external app callers. Geometry shapes already
  ;; use `live?` via `set-shape-base-props`; text must match that path.
  (when (wasm/live?)
    (h/call wasm/internal-module "_clear_shape_text")

    (set-shape-vertical-align (get content :vertical-align))

    (let [text-fonts     (or text-fonts (text-content-fonts content))
          fonts          (:fonts text-fonts)
          fallback-fonts (:fallback-fonts text-fonts)
          result         (f/store-fonts (concat fonts fallback-fonts))]
      (write-text-content! content)
      (f/load-fallback-fonts-for-editor! fallback-fonts)
      (h/call wasm/internal-module "_update_shape_text_layout")
      result)))

(defn- upload-text-bytes!
  "Body of `upload-text-content!` for a text entry (see `upload-entry`). The
   vertical align and the paragraph bytes come from the entry `text`. Does not
   fill the text editor cache: it drops the cached content of the shape
   `shape-id`, so the content is read from the page instead."
  [shape-id ^js text text-fonts]
  (text-editor/drop-cached-content! shape-id)
  (when (wasm/live?)
    (h/call wasm/internal-module "_clear_shape_text")

    (h/call wasm/internal-module "_set_shape_vertical_align" (unchecked-get text "va"))

    (let [fonts          (:fonts text-fonts)
          fallback-fonts (:fallback-fonts text-fonts)
          result         (f/store-fonts (concat fonts fallback-fonts))]
      (doseq [paragraph (array-seq (unchecked-get text "paras"))]
        (rtc/upload-paragraph-bytes! paragraph))
      (f/load-fallback-fonts-for-editor! fallback-fonts)
      (h/call wasm/internal-module "_update_shape_text_layout")
      result)))

(defn set-shape-text-content
  "This function sets shape text content and returns a stream that loads the needed fonts asynchronously"
  [shape-id content]
  (upload-text-content! shape-id content nil))

(defn apply-styles-to-selection
  "Apply style attrs to the currently selected text spans.
   Updates the cached content, pushes to WASM, and returns {:shape-id :content} for saving.
   `:with-fills?` also returns the selection's `:fills`."
  [styles & [opts]]
  (let [result (text-editor/apply-styles-to-selection styles wselect/use-shape set-shape-text-content opts)]
    (request-render "apply-styles-to-selection")
    result))

(defn apply-paragraph-attrs-to-selection
  "Apply paragraph attrs to the paragraphs the editor selection touches.
   Returns {:shape-id :content} for saving."
  [attrs]
  (let [result (text-editor/apply-paragraph-attrs-to-selection attrs wselect/use-shape set-shape-text-content)]
    (request-render "apply-paragraph-attrs-to-selection")
    result))

(defn apply-pending-caret-styles!
  "Apply the shape's pending caret style over `range` (the just-typed text) and
   clear it; returns {:shape-id :content} or nil when there is none."
  [shape-id range]
  (when-let [styles (text-editor/get-pending-caret-styles shape-id)]
    (let [result (text-editor/apply-styles-to-range
                  shape-id range styles wselect/use-shape set-shape-text-content)]
      (text-editor/clear-pending-caret-styles!)
      (request-render "apply-pending-caret-styles")
      result)))

(defn apply-paste-styles
  "Restyle the text just pasted at `start` with `fragment`: its overrides, or its full
   styles when copied in Penpot. Nil when the shape has no cached content."
  [shape-id fragment start penpot?]
  (when-let [content (text-editor/get-cached-content shape-id)]
    (let [content (if penpot?
                    (text-paste/apply-content-styles content fragment start)
                    (text-paste/apply-fragment-styles content fragment start))]
      (wselect/use-shape shape-id)
      (set-shape-text-content shape-id content)
      (request-render "apply-paste-styles")
      {:shape-id shape-id
       :content  content})))

(defn set-parent-id
  [id]
  (let [buffer (uuid/get-u32 id)]
    (h/call wasm/internal-module "_set_parent"
            (aget buffer 0)
            (aget buffer 1)
            (aget buffer 2)
            (aget buffer 3))))

(defn set-shape-clip-content
  [clip-content]
  (h/call wasm/internal-module "_set_shape_clip_content" clip-content))

(defn set-shape-type
  [type]
  (h/call wasm/internal-module "_set_shape_type" (sr/translate-shape-type type)))

(defn set-masked
  [masked]
  (props/set-masked masked))

(defn set-shape-selrect
  [selrect]
  (h/call wasm/internal-module "_set_shape_selrect"
          (dm/get-prop selrect :x1)
          (dm/get-prop selrect :y1)
          (dm/get-prop selrect :x2)
          (dm/get-prop selrect :y2)))

(defn set-shape-transform
  [transform]
  (h/call wasm/internal-module "_set_shape_transform"
          (dm/get-prop transform :a)
          (dm/get-prop transform :b)
          (dm/get-prop transform :c)
          (dm/get-prop transform :d)
          (dm/get-prop transform :e)
          (dm/get-prop transform :f)))

(defn set-shape-rotation
  [rotation]
  (h/call wasm/internal-module "_set_shape_rotation" rotation))

(defn set-shape-children
  [children]
  (perf/begin-measure "set-shape-children")
  (let [children (into [] (filter uuid?) children)]
    (if (empty? children)
      (h/call wasm/internal-module "_set_children_0")
      (let [size   (mem/get-alloc-size children UUID-U8-SIZE)
            offset (mem/alloc->offset-32 size)
            heap   (mem/get-heap-u32)]
        (reduce
         (fn [offset id]
           (mem.h32/write-uuid offset heap id))
         offset
         children)
        (h/call wasm/internal-module "_set_children"))))
  (perf/end-measure "set-shape-children")
  nil)


(defn- get-texture-id-for-gl-object
  "Registers a WebGL texture with Emscripten's GL object system and returns its ID"
  [texture]
  (let [gl-obj (unchecked-get wasm/internal-module "GL")
        textures (.-textures ^js gl-obj)
        new-id (.getNewId ^js gl-obj textures)]
    (aset textures new-id texture)
    new-id))

(defn- svg-blob?
  [^js blob]
  (str/starts-with? (.-type blob) "image/svg"))

(defn- store-svg-image
  "Sends raw SVG bytes to WASM so Skia parses and rasterizes them there.
   Browsers reject SVG blobs in `createImageBitmap`, so SVGs skip the
   shared-texture path."
  [shape-id image-id thumbnail? ^js blob]
  (-> (.arrayBuffer blob)
      (p/then
       (fn [buffer]
         ;; The fetch can finish after `_clean_up` freed the image store.
         (when (wasm/live?)
           (let [image-bytes (js/Uint8Array. buffer)
                 ;; Header: 16 bytes shape uuid + 16 bytes image uuid
                 ;; + 4 bytes thumbnail flag, then the raw SVG payload.
                 offset (mem/alloc (+ 36 (.-byteLength image-bytes)))
                 heap   (mem/get-heap-u8)
                 dview  (mem/get-data-view)]
             (-> offset
                 (mem/write-uuid dview shape-id)
                 (mem/write-uuid dview image-id)
                 (mem/write-u32 dview (if thumbnail? 1 0))
                 (mem/write-buffer heap image-bytes))
             (h/call wasm/internal-module "_store_image")
             true))))))

(defn- store-image-url!
  "Registers the public URL an image was loaded from so SVG export can emit a
   linked `<image href>` instead of a Skia base64 embed."
  [image-id url]
  (when (and (wasm/live?) (some? url) (not (str/blank? url)))
    (let [buffer (uuid/get-u32 image-id)
          encoder (js/TextEncoder.)
          encoded (.encode encoder url)
          size (.-byteLength encoded)
          offset (mem/alloc size)
          heap (mem/get-heap-u8)]
      (.set heap encoded offset)
      (h/call wasm/internal-module "_store_image_url"
              (aget buffer 0)
              (aget buffer 1)
              (aget buffer 2)
              (aget buffer 3))
      true)))

(defn- store-image-texture
  "Creates a WebGL texture from a decoded image and passes the texture ID to
   WASM. This avoids decoding the image twice (once in browser, once in WASM)."
  [shape-id image-id thumbnail? img]
  (when-let [gl (webgl/get-webgl-context)]
    (let [texture (webgl/create-webgl-texture-from-image gl img)
          texture-id (get-texture-id-for-gl-object texture)
          width  (.-width ^js img)
          height (.-height ^js img)
          ;; Header: 32 bytes (2 UUIDs) + 4 bytes (thumbnail)
          ;;     + 4 bytes (texture ID) + 8 bytes (dimensions)
          total-bytes 48
          offset (mem/alloc->offset-32 total-bytes)
          heap32 (mem/get-heap-u32)]

      ;; 1. Set shape id (offset + 0 to offset + 3)
      (mem.h32/write-uuid offset heap32 shape-id)

      ;; 2. Set image id (offset + 4 to offset + 7)
      (mem.h32/write-uuid (+ offset 4) heap32 image-id)

      ;; 3. Set thumbnail flag as u32 (offset + 8)
      (aset heap32 (+ offset 8) (if thumbnail? 1 0))

      ;; 4. Set texture ID (offset + 9)
      (aset heap32 (+ offset 9) texture-id)

      ;; 5. Set width (offset + 10)
      (aset heap32 (+ offset 10) width)

      ;; 6. Set height (offset + 11)
      (aset heap32 (+ offset 11) height)

      (h/call wasm/internal-module "_store_image_from_texture")
      true)))

(defn- fetch-image
  "Loads an image and hands it to WASM. Raster images are decoded by the
   browser and shared as a WebGL texture; SVG images are sent as raw bytes
   so Skia rasterizes them."
  [shape-id image-id thumbnail?]
  (let [url (cf/resolve-file-media {:id image-id} thumbnail?)]
    (store-image-url! image-id url)
    {:key url
     :thumbnail? thumbnail?
     :callback
     (fn []
       (->> (rx/from (-> (js/fetch url)
                         (p/then (fn [^js response] (.blob response)))))
            (rx/mapcat
             (fn [^js blob]
               (rx/from
                (if (svg-blob? blob)
                  (store-svg-image shape-id image-id thumbnail? blob)
                  (p/then (js/createImageBitmap blob)
                          (partial store-image-texture shape-id image-id thumbnail?))))))
            (rx/catch
             (fn [cause]
               (log/error :hint "Could not fetch image"
                          :image-id image-id
                          :thumbnail? thumbnail?
                          :url url
                          :cause cause)
               (rx/empty)))))}))

(defn- image-fetch
  "Registers the URL of the image `image-id` and returns its fetch when the
   image is not cached in WASM yet, else nil."
  [shape-id image-id thumbnail?]
  (let [buffer        (uuid/get-u32 image-id)
        cached-image? (h/call wasm/internal-module "_is_image_cached"
                              (aget buffer 0)
                              (aget buffer 1)
                              (aget buffer 2)
                              (aget buffer 3)
                              thumbnail?)]
    ;; Always register the URL (SVG export needs it even when bytes are cached).
    (store-image-url! image-id (cf/resolve-file-media {:id image-id} thumbnail?))
    (when (zero? cached-image?)
      (fetch-image shape-id image-id thumbnail?))))

(defn- get-fill-images
  [leaf]
  (filter :fill-image (:fills leaf)))

(defn- process-fill-image-id
  "Same as `image-fetch`: the fetch of the image `image-id` of a text span."
  [shape-id image-id thumbnail?]
  (image-fetch shape-id image-id thumbnail?))

(defn- process-fill-image
  [shape-id fill thumbnail?]
  (when-let [image (:fill-image fill)]
    (process-fill-image-id shape-id (get image :id) thumbnail?)))

(defn set-shape-text-images
  ([shape-id content]
   (set-shape-text-images shape-id content false))
  ([shape-id content thumbnail?]
   (let [paragraph-set (first (get content :children))
         paragraphs (get paragraph-set :children)]
     (->> paragraphs
          (mapcat :children)
          (mapcat get-fill-images)
          (map #(process-fill-image shape-id % thumbnail?))))))

(defn set-shape-fills
  "Writes fill records (unless `write?` is false) and returns pending image
   fetches. When fills were already uploaded in `_set_shapes_batch`, pass
   `write?` false so only image fetches remain."
  ([shape-id fills thumbnail?]
   (set-shape-fills shape-id fills thumbnail? true))
  ([shape-id fills thumbnail? write?]
   (let [fills (if write?
                 (props/write-shape-fills! fills)
                 (when (seq fills)
                   (types.fills/coerce fills)))]
     (when fills
       (keep #(image-fetch shape-id % thumbnail?)
             (types.fills/get-image-ids fills))))))

(defn set-shape-strokes
  "Writes stroke records (unless `write?` is false) and returns pending image
   fetches for stroke image fills."
  ([shape-id strokes thumbnail?]
   (set-shape-strokes shape-id strokes thumbnail? true))
  ([shape-id strokes thumbnail? write?]
   (let [image-ids (if write?
                     (props/write-shape-strokes! strokes)
                     (ue/stroke-image-ids strokes))]
     (keep #(image-fetch shape-id % thumbnail?)
           image-ids))))

(defn set-shape-svg-attrs
  [attrs]
  (props/set-shape-svg-attrs attrs))

(defn set-shape-path-content
  "Upload path content in chunks to WASM."
  [content]
  (props/set-shape-path-content content))

(defn set-shape-svg-raw-content
  [content]
  (props/set-shape-svg-raw-content content))

(defn set-shape-blend-mode
  [blend-mode]
  (when (initialized?)
    ;; These values correspond to skia::BlendMode representation
    ;; https://rust-skia.github.io/doc/skia_safe/enum.BlendMode.html
    (h/call wasm/internal-module "_set_shape_blend_mode" (sr/translate-blend-mode blend-mode))))

(defn set-shape-vertical-align
  [vertical-align]
  (h/call wasm/internal-module "_set_shape_vertical_align" (sr/translate-vertical-align vertical-align)))

(defn set-shape-opacity
  [opacity]
  (h/call wasm/internal-module "_set_shape_opacity" (or opacity 1)))

(defn set-constraints-h
  [constraint]
  (when constraint
    (h/call wasm/internal-module "_set_shape_constraint_h" (sr/translate-constraint-h constraint))))

(defn set-constraints-v
  [constraint]
  (when constraint
    (h/call wasm/internal-module "_set_shape_constraint_v" (sr/translate-constraint-v constraint))))

(defn set-shape-constraints
  [constraint-h constraint-v]
  (h/call wasm/internal-module "_clear_shape_constraints")
  (set-constraints-h constraint-h)
  (set-constraints-v constraint-v))

(defn set-shape-hidden
  [hidden]
  (h/call wasm/internal-module "_set_shape_hidden" hidden))

(defn clear-shape-fills!
  "Clear the fills of the currently-selected shape (call `use-shape` first).
  Equivalent to `set-shape-fills` with an empty collection."
  []
  (when (initialized?)
    (h/call wasm/internal-module "_clear_shape_fills")))

(defn set-shape-bool-type
  [bool-type]
  (props/set-shape-bool-type bool-type))

(defn set-shape-blur
  [blur]
  (props/set-shape-blur blur))

(defn set-shape-background-blur
  [background-blur]
  (props/set-shape-background-blur background-blur))

(defn set-shape-corners
  [corners]
  (let [[r1 r2 r3 r4] (map #(d/nilv % 0) corners)]
    (h/call wasm/internal-module "_set_shape_corners" r1 r2 r3 r4)))

(defn set-flex-layout
  [shape]
  (let [dir        (-> (get shape :layout-flex-dir :row)
                       (sr/translate-layout-flex-dir))
        gap        (get shape :layout-gap)
        row-gap    (get gap :row-gap 0)
        column-gap (get gap :column-gap 0)

        align-items     (-> (get shape :layout-align-items) sr/translate-layout-align-items)
        align-content   (-> (get shape :layout-align-content) sr/translate-layout-align-content)
        justify-items   (-> (get shape :layout-justify-items) sr/translate-layout-justify-items)
        justify-content (-> (get shape :layout-justify-content) sr/translate-layout-justify-content)
        wrap-type       (-> (get shape :layout-wrap-type) sr/translate-layout-wrap-type)

        padding         (get shape :layout-padding)
        padding-top     (get padding :p1 0)
        padding-right   (get padding :p2 0)
        padding-bottom  (get padding :p3 0)
        padding-left    (get padding :p4 0)]

    (h/call wasm/internal-module
            "_set_flex_layout_data"
            dir
            row-gap
            column-gap
            align-items
            align-content
            justify-items
            justify-content
            wrap-type
            padding-top
            padding-right
            padding-bottom
            padding-left)))

(defn set-grid-layout-data
  [shape]
  (let [dir        (-> (get shape :layout-grid-dir :row)
                       (sr/translate-layout-grid-dir))
        gap        (get shape :layout-gap)
        row-gap    (get gap :row-gap 0)
        column-gap (get gap :column-gap 0)

        align-items     (-> (get shape :layout-align-items) sr/translate-layout-align-items)
        align-content   (-> (get shape :layout-align-content) sr/translate-layout-align-content)
        justify-items   (-> (get shape :layout-justify-items) sr/translate-layout-justify-items)
        justify-content (-> (get shape :layout-justify-content) sr/translate-layout-justify-content)

        padding         (get shape :layout-padding)
        padding-top     (get padding :p1 0)
        padding-right   (get padding :p2 0)
        padding-bottom  (get padding :p3 0)
        padding-left    (get padding :p4 0)]

    (h/call wasm/internal-module
            "_set_grid_layout_data"
            dir
            row-gap
            column-gap
            align-items
            align-content
            justify-items
            justify-content
            padding-top
            padding-right
            padding-bottom
            padding-left)))

(defn set-grid-layout-rows
  [entries]
  ;; Only allocate when there are entries; an empty list would alloc 0 bytes.
  ;; The wasm side reads an empty buffer as zero rows.
  (when (seq entries)
    (let [size    (mem/get-alloc-size entries GRID-LAYOUT-ROW-U8-SIZE)
          offset  (mem/alloc size)
          dview   (mem/get-data-view)]

      (reduce (fn [offset {:keys [type value]}]
                (-> offset
                    (mem/write-u8 dview (sr/translate-grid-track-type type))
                    (+ 3) ;; padding
                    (mem/write-f32 dview value)
                    (mem/assert-written offset GRID-LAYOUT-ROW-U8-SIZE)))

              offset
              entries)))

  (h/call wasm/internal-module "_set_grid_rows"))

(defn set-grid-layout-columns
  [entries]
  ;; Only allocate when there are entries; an empty list would alloc 0 bytes.
  ;; The wasm side reads an empty buffer as zero columns.
  (when (seq entries)
    (let [size   (mem/get-alloc-size entries GRID-LAYOUT-COLUMN-U8-SIZE)
          offset (mem/alloc size)
          dview  (mem/get-data-view)]

      (reduce (fn [offset {:keys [type value]}]
                (-> offset
                    (mem/write-u8 dview (sr/translate-grid-track-type type))
                    (+ 3) ;; padding
                    (mem/write-f32 dview value)
                    (mem/assert-written offset GRID-LAYOUT-COLUMN-U8-SIZE)))
              offset
              entries)))

  (h/call wasm/internal-module "_set_grid_columns"))

(defn set-grid-layout-cells
  [cells]
  ;; Only allocate when there are cells; an empty collection would alloc 0
  ;; bytes. The wasm side reads an empty buffer as zero cells.
  (when (seq cells)
    (let [size    (mem/get-alloc-size cells GRID-LAYOUT-CELL-U8-SIZE)
          offset  (mem/alloc size)
          dview   (mem/get-data-view)]

      (reduce-kv (fn [offset _ cell]
                   (let [shape-id  (-> (get cell :shapes) first)]
                     (-> offset
                         (mem/write-i32 dview (get cell :row))
                         (mem/write-i32 dview (get cell :row-span))
                         (mem/write-i32 dview (get cell :column))
                         (mem/write-i32 dview (get cell :column-span))

                         (mem/write-u8 dview (sr/translate-align-self (get cell :align-self)))
                         (mem/write-u8 dview (sr/translate-justify-self (get cell :justify-self)))

                         ;; padding
                         (+ 2)

                         (mem/write-uuid dview (d/nilv shape-id uuid/zero))
                         (mem/assert-written offset GRID-LAYOUT-CELL-U8-SIZE))))

                 offset
                 cells)))

  (h/call wasm/internal-module "_set_grid_cells"))

(defn set-grid-layout
  [shape]
  (set-grid-layout-data shape)
  (set-grid-layout-rows (get shape :layout-grid-rows))
  (set-grid-layout-columns (get shape :layout-grid-columns))
  (set-grid-layout-cells (get shape :layout-grid-cells)))

(defn set-layout-data
  [shape]
  (let [margins       (get shape :layout-item-margin)
        margin-top    (get margins :m1 0)
        margin-right  (get margins :m2 0)
        margin-bottom (get margins :m3 0)
        margin-left   (get margins :m4 0)

        h-sizing      (-> (get shape :layout-item-h-sizing) sr/translate-layout-sizing)
        v-sizing      (-> (get shape :layout-item-v-sizing) sr/translate-layout-sizing)
        align-self    (-> (get shape :layout-item-align-self) sr/translate-align-self)

        max-h         (get shape :layout-item-max-h)
        has-max-h     (some? max-h)
        min-h         (get shape :layout-item-min-h)
        has-min-h     (some? min-h)
        max-w         (get shape :layout-item-max-w)
        has-max-w     (some? max-w)
        min-w         (get shape :layout-item-min-w)
        has-min-w     (some? min-w)
        is-absolute   (boolean (get shape :layout-item-absolute))
        z-index       (get shape :layout-item-z-index)]
    (h/call wasm/internal-module
            "_set_layout_data"
            margin-top
            margin-right
            margin-bottom
            margin-left
            h-sizing
            v-sizing
            has-max-h
            (d/nilv max-h 0)
            has-min-h
            (d/nilv min-h 0)
            has-max-w
            (d/nilv max-w 0)
            has-min-w
            (d/nilv min-w 0)

            (d/nilv align-self 0)
            is-absolute
            (d/nilv z-index 0))))

(defn has-any-layout-prop? [shape]
  (some #(and (keyword? %)
              (str/starts-with? (name %) "layout-"))
        (keys shape)))

(defn clear-layout
  []
  (h/call wasm/internal-module "_clear_shape_layout"))

(defn- set-shape-layout
  [shape]
  (clear-layout)
  (when (ctl/flex-layout? shape)
    (set-flex-layout shape))

  (when (ctl/grid-layout? shape)
    (set-grid-layout shape)))

(defn set-shape-shadows
  [shadows]
  (props/set-shape-shadows shadows))

(defn fonts-from-text-content
  "Fallback faces of `content` when `fallback-fonts-only?` is false (pure, see
   `f/text-fallback-fonts`). When true, writes the text of `content` to the
   current WASM shape and returns every face the text uses."
  [content fallback-fonts-only?]
  (if-not fallback-fonts-only?
    (f/text-fallback-fonts content)
    (let [paragraph-set (first (get content :children))
          paragraphs    (get paragraph-set :children)
          total         (count paragraphs)]
      (loop [index  0
             emoji? false
             langs  #{}]

        (if (< index total)
          (let [paragraph (nth paragraphs index)
                spans    (get paragraph :children)]
            (if (empty? (seq spans))
              (recur (inc index)
                     emoji?
                     langs)

              (let [text   (apply str (map :text spans))
                    emoji? (if emoji? emoji? (cfnt/contains-emoji? text))
                    langs  (cfnt/collect-used-languages langs text)]

                ;; FIXME: this should probably be somewhere else
                (t/write-shape-text spans paragraph text)

                (recur (inc index)
                       emoji?
                       langs))))

          (-> #{}
              (cond-> ^boolean emoji? (cfnt/add-emoji-font))
              (cfnt/add-noto-fonts langs)))))))

(defn set-shape-grow-type
  [grow-type]
  (when (initialized?)
    (props/set-shape-grow-type grow-type)))

(defn get-text-dimensions
  ([id]
   (wselect/use-shape id)
   (get-text-dimensions))
  ([]
   (if-not (initialized?)
     {:x 0 :y 0 :width 0 :height 0 :max-width 0}
     (let [ptr (h/call wasm/internal-module "_get_text_dimensions")]
       ;; NULL pointer when there is no current shape or it is not a text.
       (when-not (zero? ptr)
         (let [offset    (mem/->offset-32 ptr)
               heapf32   (mem/get-heap-f32)
               width     (aget heapf32 (+ offset 0))
               height    (aget heapf32 (+ offset 1))
               max-width (aget heapf32 (+ offset 2))

               x (aget heapf32 (+ offset 3))
               y (aget heapf32 (+ offset 4))]
           (mem/free)
           {:x x :y y :width width :height height :max-width max-width}))))))

(defn intersect-position-in-shape
  [id position]
  (if (initialized?)
    (let [buffer (uuid/get-u32 id)
          result
          (h/call wasm/internal-module "_intersect_position_in_shape"
                  (aget buffer 0)
                  (aget buffer 1)
                  (aget buffer 2)
                  (aget buffer 3)
                  (:x position)
                  (:y position))]
      (= result 1))
    false))

(defn view-interaction-start!
  []
  (when (and (initialized?)
             (not @page-transition?)
             (not @view-interaction-active?))
    (h/call wasm/internal-module "_set_view_start")
    (reset! view-interaction-active? true)
    ;; A new pan or zoom cancels the tile pass still in flight, because its
    ;; tiles are never shown.
    (stop-progressive-render!)))

(defn view-interaction-end!
  []
  (when (and (initialized?) @view-interaction-active?)
    (perf/begin-measure "render-finish")
    (h/call wasm/internal-module "_set_view_end")
    (perf/end-measure "render-finish")
    (reset! view-interaction-active? false)))

(defn- view-gesture-active?
  "True while a pointer-driven pan or zoom gesture is in progress."
  []
  (let [local (get @st/state :workspace-local)]
    (or (:panning local) (:zooming local))))

(defn finalize-view-interaction!
  "Ends an in-progress pan/zoom view interaction and triggers a full-quality
   render. No-ops when no view interaction is active.

   `finish-panning` runs on every pointerup, so without this guard we would
   call `internal-render` (and WASM `reset_canvas`) on plain clicks."
  []
  (when (and @view-interaction-active? (initialized?))
    (view-interaction-end!)
    ;; Preserve the last presented frame while the new one renders. A plain render
    ;; goes through WASM `reset_canvas`, which clears to the background and
    ;; re-rasterizes the viewport tile by tile — a visible flash on zoomed-in
    ;; views. The content is unchanged across a view-interaction end (only the
    ;; view moved), so there is nothing to clear; SYNC-TILES sets `preserve_target`
    ;; and lets the new tiles replace the old frame in place. Zoom-end already did
    ;; this implicitly (`zoom_changed`); this extends it to pan/resize-triggered
    ;; ends (e.g. selecting a shape opens the options panel and resizes the
    ;; viewport), which previously blanked.
    (internal-render (js/performance.now) wasm/RENDER_FLAG_SYNC_TILES)))

(def render-finish
  (letfn [(do-render []
            ;; Check if context is still initialized before executing
            ;; to prevent errors when navigating quickly
            (when (and (initialized?)
                       (not (view-gesture-active?)))
              ;; The gesture is still open, so do not render. Tiles drawn in
              ;; fast mode are never presented. The gesture end runs the
              ;; full-quality render.
              (finalize-view-interaction!)))]
    (fns/debounce do-render DEBOUNCE_DELAY_MS)))

(defn set-view-box
  [zoom vbox]
  ;; Frozen during page transition: tile atlas is empty/incomplete and
  ;; render_from_cache would present a blank workspace.
  (if @page-transition?
    (reset! viewport-dirty-during-transition? true)
    (when (initialized?)
      (perf/begin-measure "set-view-box")
      (view-interaction-start!)
      (h/call wasm/internal-module "_set_view" zoom (- (:x vbox)) (- (:y vbox)))
      (perf/end-measure "set-view-box")

      (perf/begin-measure "render-from-cache")
      (h/call wasm/internal-module "_render_from_cache" 0)
      (render-finish)
      (perf/end-measure "render-from-cache"))))

(defn sync-workspace-local-viewport!
  "Pushes `[:workspace-local :zoom]` and `:vbox` into WASM."
  [state]
  (when (initialized?)
    (let [zoom (get-in state [:workspace-local :zoom])
          vbox (get-in state [:workspace-local :vbox])]
      (when (and zoom vbox)
        (set-view-box zoom vbox)))))

(defn- ensure-text-content
  "Guarantee that the shape always sends a valid text tree to WASM. When the
  content is nil (freshly created text) we fall back to
  tc/default-text-content so the renderer receives typography information."
  [content]
  (or content (tc/v2-default-text-content)))

;; The worker upload does not fill the text editor cache, so the editor reads
;; the content of a missing shape from the page. Texts with nil content keep
;; the empty template (see `text-editor-sync-content`).
(text-editor/set-content-fallback!
 (fn [shape-id]
   (when (contains? cf/flags :render-wasm-worker-upload)
     (let [shape (get (dsh/lookup-page-objects @st/state) shape-id)]
       (when (and (cfh/text-shape? shape) (some? (:content shape)))
         (:content shape))))))

(def ^:private empty-text-font-state
  {:font-index {} :pending-faces #{}})

(defn- text-layout-fonts
  "Content and fallback faces (emoji, Noto, ...) that `set-shape-text-content`
  uploads, must match that path for pending-face tracking. `text-fonts` comes
  from `text-content-fonts`."
  [{:keys [fonts fallback-fonts]}]
  (into #{} (concat fonts fallback-fonts)))

(defn- text-font-face-keys-state
  "All font-face keys for a text content's `text-content-fonts` map, and the
  subset not WASM-ready yet."
  [text-fonts]
  (reduce
   (fn [acc font]
     (let [font-data (f/make-font-data font)
           key       (f/font-data-key font-data)
           pending?  (not (f/font-ready? font-data))]
       (-> acc
           (update :font-face-keys conj key)
           (cond-> pending?
             (update :pending-font-face-keys conj key)))))
   {:font-face-keys #{} :pending-font-face-keys #{}}
   (text-layout-fonts text-fonts)))

(defn- acc-text-font-state
  [{:keys [font-index pending-faces]} id font-face-keys pending-font-face-keys]
  {:font-index (reduce (fn [idx face]
                         (update idx face (fnil conj #{}) id))
                       font-index
                       (or font-face-keys #{}))
   :pending-faces (into (or pending-faces #{})
                        (or pending-font-face-keys #{}))})

(defn text-font-state-for-shape
  "Build the font-face index for a single text shape (incremental updates)."
  [shape]
  (if (cfh/text-shape? shape)
    (let [content (ensure-text-content (:content shape))
          {:keys [font-face-keys pending-font-face-keys]}
          (text-font-face-keys-state (text-content-fonts content))]
      (acc-text-font-state empty-text-font-state
                           (:id shape)
                           font-face-keys
                           pending-font-face-keys))
    empty-text-font-state))

(defn- shape-ids-for-pending-fonts
  [{:keys [font-index pending-faces]}]
  (when (seq pending-faces)
    (into #{}
          (mapcat #(get font-index % []))
          pending-faces)))

(defn- set-object-host-attrs
  "Host-specific attrs after structural upload (text/svg-raw/grid; optionally
   fills/strokes). When `skip-layout?` is true, flex+layout-item were already in
   the batch; only grid tracks/cells are applied here. When
   `skip-fills-strokes?` is true, fill/stroke records were already in the batch;
   only image fetches remain.

   Always `use-shape` first: after a multi-shape batch the WASM current shape is
   the last record in the chunk, not this shape."
  [shape skip-layout? & {:keys [skip-fills-strokes?] :or {skip-fills-strokes? false}}]
  (let [id      (dm/get-prop shape :id)
        type    (dm/get-prop shape :type)
        fills   (get shape :fills)
        strokes (if (= type :group) [] (get shape :strokes))
        content (let [content (get shape :content)]
                  (if (= type :text)
                    (ensure-text-content content)
                    content))
        write-fills-strokes? (not skip-fills-strokes?)
        needs-current? (or write-fills-strokes?
                           (= type :text)
                           (and (some? content) (= type :svg-raw))
                           (if skip-layout?
                             (ctl/grid-layout? shape)
                             true))]

    (when needs-current?
      (wselect/use-shape id))

    (when (and (some? content) (= type :svg-raw))
      (set-shape-svg-raw-content (get-static-markup shape)))

    (if skip-layout?
      (when (ctl/grid-layout? shape)
        (set-grid-layout shape))
      (do (set-shape-layout shape)
          (set-layout-data shape)))

    (let [is-text?   (= type :text)
          text-fonts (when is-text? (text-content-fonts content))
          {:keys [font-face-keys pending-font-face-keys]}
          (when is-text? (text-font-face-keys-state text-fonts))
          text-content-pending (when is-text? (upload-text-content! id content text-fonts))
          pending-thumbnails (into [] (concat
                                       text-content-pending
                                       (when is-text? (set-shape-text-images id content true))
                                       (set-shape-fills id fills true write-fills-strokes?)
                                       (set-shape-strokes id strokes true write-fills-strokes?)))
          pending-full (into [] (concat
                                 (when is-text? (set-shape-text-images id content false))
                                 (set-shape-fills id fills false write-fills-strokes?)
                                 (set-shape-strokes id strokes false write-fills-strokes?)))]
      {:thumbnails pending-thumbnails
       :full pending-full
       :font-face-keys (or font-face-keys #{})
       :pending-font-face-keys (or pending-font-face-keys #{})})))

(defn set-object
  [shape]
  (if-not (and shape (wasm/live?))
    {:thumbnails [] :full [] :font-face-keys #{} :pending-font-face-keys #{}}
    (do
      (perf/begin-measure "set-object")
      (let [prepared (serialize-shape/serialize-shape shape)
            result (set-object-host-attrs prepared false)]
        (perf/end-measure "set-object")
        result))))

(defn- apply-entry-host-attrs
  "Host attrs of the host 0 upload entry `e` (see `upload-entry`). Makes the
   same WASM calls, in the same order, as `set-object-host-attrs` with
   `skip-layout?` and `skip-fills-strokes?` true. The text bytes, fonts and
   image ids come from the entry."
  [^js e]
  (let [id         (uuid/uuid (unchecked-get e "id"))
        ^js text   (unchecked-get e "text")
        is-text?   (some? text)
        text-fonts (when is-text?
                     {:fonts          (unchecked-get text "fonts")
                      :fallback-fonts (unchecked-get text "fallback")})
        _          (when is-text? (wselect/use-shape id))
        {:keys [font-face-keys pending-font-face-keys]}
        (when is-text? (text-font-face-keys-state text-fonts))
        text-content-pending (when is-text? (upload-text-bytes! id text text-fonts))
        timg       (some-> (unchecked-get e "timg") array-seq)
        fimg       (unchecked-get e "fimg")
        simg       (some-> (unchecked-get e "simg") array-seq)
        ->id       (fn [image-id]
                     (when (some? image-id)
                       (uuid/uuid image-id)))
        pending-thumbnails
        (into [] (concat
                  text-content-pending
                  (when is-text? (map #(process-fill-image-id id (->id %) true) timg))
                  (when fimg (keep #(image-fetch id (->id %) true) (array-seq fimg)))
                  (keep #(image-fetch id (->id %) true) simg)))
        pending-full
        (into [] (concat
                  (when is-text? (map #(process-fill-image-id id (->id %) false) timg))
                  (when fimg (keep #(image-fetch id (->id %) false) (array-seq fimg)))
                  (keep #(image-fetch id (->id %) false) simg)))]
    {:thumbnails pending-thumbnails
     :full pending-full
     :font-face-keys (or font-face-keys #{})
     :pending-font-face-keys (or pending-font-face-keys #{})}))

(defn- shape-resources
  "Returns the data that `collect-page-resources` needs for `shape`: its fonts,
   its image ids and, for a text, its grow type and box. Returns nil when the
   shape needs nothing, which is when it is not a text and has no fill or
   stroke image."
  [shape]
  (let [id         (dm/get-prop shape :id)
        type       (dm/get-prop shape :type)
        text?      (= type :text)
        fills      (get shape :fills)
        strokes    (if (= type :group) [] (get shape :strokes))
        content    (when text? (ensure-text-content (get shape :content)))
        text-fonts (when text? (text-content-fonts content))
        timg       (when text?
                     (->> (get (first (get content :children)) :children)
                          (mapcat :children)
                          (mapcat get-fill-images)
                          (mapv #(get-in % [:fill-image :id]))))
        fimg       (when (seq fills)
                     (vec (types.fills/get-image-ids (types.fills/coerce fills))))
        simg       (ue/stroke-image-ids strokes)]
    (when (or text? (seq fimg) (seq simg))
      {:id             id
       :text?          text?
       :fonts          (vec (:fonts text-fonts))
       :fallback-fonts (vec (:fallback-fonts text-fonts))
       :timg           timg
       :fimg           fimg
       :simg           simg
       :grow-type      (when text? (:grow-type shape))
       :selrect        (when text? {:width  (get-in shape [:selrect :width])
                                    :height (get-in shape [:selrect :height])})})))

(defn- entry-resources
  "Returns the data that `collect-page-resources` needs for the host 0 upload
   entry `e`, the same as `shape-resources` gives for its shape. The faces are
   the ones `set-font-vectors!` set. Returns nil when the shape needs nothing."
  [^js e]
  (let [id       (uuid/uuid (unchecked-get e "id"))
        ^js text (unchecked-get e "text")
        text?    (some? text)
        ->id     (fn [image-id]
                   (when (some? image-id)
                     (uuid/uuid image-id)))
        ->ids    (fn [^js arr]
                   (mapv ->id (array-seq arr)))
        timg     (when text? (->ids (unchecked-get e "timg")))
        fimg     (some-> (unchecked-get e "fimg") ->ids)
        simg     (->ids (unchecked-get e "simg"))]
    (when (or text? (seq fimg) (seq simg))
      {:id             id
       :text?          text?
       :fonts          (vec (when text? (unchecked-get text "fonts")))
       :fallback-fonts (vec (when text? (unchecked-get text "fallback")))
       :timg           timg
       :fimg           fimg
       :simg           simg
       :grow-type      (when text? (some-> (unchecked-get text "grow") keyword))
       :selrect        (when text? {:width  (unchecked-get text "w")
                                    :height (unchecked-get text "h")})})))

(defn- apply-entries!
  "Replays the upload of `entries`, the upload entries of one chunk in upload
   order (see `upload-entry`), with the WASM calls of `process-shapes-chunk`.
   `host-shapes` maps the id of each host 1 entry to its svg-derived shape.

   Returns {:thumbnails .. :full .. :text-font-state .. :shapes .. :resources ..}.
   `shapes` holds the text shapes of host 1 entries, and for host 0 texts a stub
   with their id, type, grow type and box: the finalize step reads only these.
   `resources` holds the resource data of every entry (see `shape-resources`),
   in order, without the entries that need nothing."
  [entries host-shapes thumbnails-acc full-acc font-state-acc]
  (f/call-with-batch-memo
   (fn []
     (upload/upload-records! (mapv #(unchecked-get % "rec") entries))

     (doseq [^js e entries
             :let [svg  (unchecked-get e "svg")
                   path (unchecked-get e "path")]
             :when (or (some? svg) (some? path))]
       (wselect/use-shape (uuid/uuid (unchecked-get e "id")))
       (when (some? svg)
         (props/set-shape-svg-attrs-values svg))
       (when (some? path)
         (props/upload-path-bytes! path)))

     (loop [index    0
            t-acc    (transient thumbnails-acc)
            f-acc    (transient full-acc)
            font-acc font-state-acc
            shapes   (transient [])]
       (if (< index (count entries))
         (let [^js e           (nth entries index)
               id              (unchecked-get e "id")
               host1?          (= 1 (unchecked-get e "host"))
               shape           (when host1? (get host-shapes id))
               {:keys [thumbnails full font-face-keys pending-font-face-keys]}
               (if host1?
                 (set-object-host-attrs shape true :skip-fills-strokes? true)
                 (apply-entry-host-attrs e))
               stub            (if host1?
                                 (when (cfh/text-shape? shape) shape)
                                 (when-let [^js text (unchecked-get e "text")]
                                   {:id        (uuid/uuid id)
                                    :type      :text
                                    :grow-type (some-> (unchecked-get text "grow") keyword)
                                    :selrect   {:width  (unchecked-get text "w")
                                                :height (unchecked-get text "h")}}))]
           (recur (inc index)
                  (reduce conj! t-acc thumbnails)
                  (reduce conj! f-acc full)
                  (acc-text-font-state font-acc
                                       (uuid/uuid id)
                                       font-face-keys
                                       pending-font-face-keys)
                  (cond-> shapes
                    (some? stub) (conj! stub))))
         {:thumbnails (persistent! t-acc)
          :full (persistent! f-acc)
          :text-font-state font-acc
          :shapes (persistent! shapes)
          :resources (into []
                           (keep (fn [^js e]
                                   (if (= 1 (unchecked-get e "host"))
                                     (some-> (get host-shapes (unchecked-get e "id"))
                                             shape-resources)
                                     (entry-resources e))))
                           entries)})))))

(defn- update-text-layouts
  "Synchronously update text layouts for all shapes and send rect updates
   to the worker index."
  [text-ids]
  (run! f/update-text-layout text-ids))

(defn- force-update-text-layouts
  "Like update-text-layouts but forces a relayout. Use after pending fonts
   resolve so layouts (and the extrect/tiles derived from them) use real glyph
   metrics instead of fallback-font estimates."
  [text-ids]
  (run! f/force-update-text-layout text-ids))

(defn- text-selrect-stale?
  "Check if the WASM-measured dimensions of an auto-grow text shape differ
   from its stored selrect (same 0.1px tolerance as the classic renderer)."
  [{:keys [id selrect grow-type]}]
  (when-let [{:keys [width height]} (get-text-dimensions id)]
    (case grow-type
      :auto-width  (or (not (mth/close? width (:width selrect) 0.1))
                       (not (mth/close? height (:height selrect) 0.1)))
      :auto-height (not (mth/close? height (:height selrect) 0.1))
      false)))

(defonce ^:private pending-stale-selrect-ids (atom #{}))
(defonce ^:private stale-selrect-sync-token (atom 0))

(defn- flush-stale-selrect-sync!
  []
  (when-let [ids (seq (first (reset-vals! pending-stale-selrect-ids #{})))]
    (st/emit! (ptk/data-event ::stale-text-selrects {:ids (vec ids)}))))

(defn- schedule-stale-selrect-sync!
  "Coalesce stale-selrect emissions and defer until the first viewport tile
   pass completes, then run on idle so page load can paint first."
  [stale-ids]
  (swap! pending-stale-selrect-ids into stale-ids)
  (let [token (swap! stale-selrect-sync-token inc)
        flush-on-idle!
        (fn []
          (when (= token @stale-selrect-sync-token)
            (timers/schedule-on-idle
             (fn []
               (when (= token @stale-selrect-sync-token)
                 (flush-stale-selrect-sync!))))))]
    (listen-tiles-render-complete-once! flush-on-idle!)))

(defn- sync-stale-text-selrects!
  "Emit the ids of auto-grow text shapes whose selrect no longer matches the
   measured layout, so the workspace resizes them (data-event instead of a
   direct call to avoid a circular dependency; see the watcher in
   `app.main.data.workspace/initialize-workspace`)."
  [shapes]
  (let [stale-ids (into []
                        (comp (filter cfh/text-shape?)
                              (filter (comp #{:auto-width :auto-height} :grow-type))
                              (filter text-selrect-stale?)
                              (map :id))
                        shapes)]
    (when (seq stale-ids)
      (schedule-stale-selrect-sync! stale-ids))))

(defn- relayout-after-fonts!
  "Relayout text shapes once their pending fonts have resolved. Font fetches
   are deduped per URL, so only shapes that use a not-yet-ready face at upload
   time need a forced relayout; then re-sync selrects that drifted for those
   shapes only."
  [shapes text-font-state]
  (let [text-ids (into [] (comp (filter cfh/text-shape?) (map :id)) shapes)
        affected-ids (or (shape-ids-for-pending-fonts text-font-state) #{})
        shapes-by-id (d/index-by :id shapes)]
    (when (seq text-ids)
      (if (seq affected-ids)
        (let [affected-shapes (into [] (keep shapes-by-id) affected-ids)]
          (force-update-text-layouts affected-ids)
          (sync-stale-text-selrects! affected-shapes))
        (update-text-layouts text-ids)))))

(defn process-pending
  [shapes thumbnails full text-font-state on-complete]
  (let [pending-thumbnails
        (d/index-by :key :callback thumbnails)

        pending-full
        (d/index-by :key :callback full)]

    ;; Run text layouts synchronously so shapes are immediately correct.
    (let [text-ids (into [] (comp (filter cfh/text-shape?) (map :id)) shapes)]
      (when (seq text-ids)
        (update-text-layouts text-ids)))

    (if (or (seq pending-thumbnails) (seq pending-full))
      (->> (rx/concat
            (->> (rx/from (vals pending-thumbnails))
                 (rx/merge-map (fn [callback] (if (fn? callback) (callback) (rx/empty))))
                 (rx/reduce conj [])
                 (rx/catch #(rx/empty)))
            (->> (rx/from (vals pending-full))
                 (rx/mapcat (fn [callback] (if (fn? callback) (callback) (rx/empty))))
                 (rx/reduce conj [])
                 (rx/catch #(rx/empty))))
           (rx/subs!
            noop-fn
            noop-fn
            (fn []
              (relayout-after-fonts! shapes text-font-state)
              (request-render "images-loaded")
              (when (fn? on-complete) (on-complete)))))
      ;; No pending images — complete immediately.
      (when on-complete (on-complete)))))

(defn process-objects
  "Takes multiple shapes, calling `set-object` for each one and accumulating
  their thumbnails, full-image callbacks, and text font state. Then calls
  `process-pending` once for the whole batch, so text layouts are updated for
  all shapes after pending fonts and images are processed."
  [shapes]
  (let [total-shapes (count shapes)
        {:keys [thumbnails full text-font-state]}
        (loop [index 0
               thumbnails-acc (transient [])
               full-acc (transient [])
               font-state-acc empty-text-font-state]
          (if (< index total-shapes)
            (let [shape (nth shapes index)
                  {:keys [thumbnails full font-face-keys pending-font-face-keys]}
                  (set-object shape)]
              (recur (inc index)
                     (reduce conj! thumbnails-acc thumbnails)
                     (reduce conj! full-acc full)
                     (acc-text-font-state font-state-acc
                                          (:id shape)
                                          font-face-keys
                                          pending-font-face-keys)))
            {:thumbnails (persistent! thumbnails-acc)
             :full (persistent! full-acc)
             :text-font-state font-state-acc}))]
    (process-pending shapes thumbnails full text-font-state noop-fn)))

;; --- Page cache (see `app.render-wasm.page-cache`)

(defn- page-cache-epoch
  "What a stashed page pool depends on besides the page version: the file,
  its version (a restored version reloads the data) and the version preview
  on screen."
  []
  (let [state   @st/state
        file-id (:current-file-id state)]
    [file-id
     (:vern (dsh/lookup-file state file-id))
     (dm/get-in state [:workspace-global :preview-id])]))

(defn- register-resident!
  "Records the page in `resident` (built by `initialize-viewport`, nil for
  other loads) as the page the renderer holds, now that its shapes are in
  WASM. A load with `:cache?` false (focus filter, renderer reload) is not
  recorded. A commit to the page during the load may have missed WASM (the
  chunks upload a snapshot), so such a page is never stashed."
  [{:keys [token page-id epoch version cache?]}]
  (when (and (some? page-id) cache?)
    (page-cache/set-resident! token page-id epoch)
    (when (and (= page-id (page-cache/resident-page-id))
               (not= version (page-cache/version page-id)))
      (page-cache/taint-resident!))))

(defn- stash-resident-page!
  "Ends the residency of the page the renderer holds. When `stash?` is true
  and nothing on screen differs from the file data (no shapes loading, no
  text being edited, no temporary property preview, the file data is still
  loaded), keeps its shapes pool in WASM for a later `initialize-viewport` of
  the same page. Must run before `_clean_up`."
  [stash?]
  (when (wasm/module-ready?)
    (try
      (page-cache/stash! (page-cache-epoch)
                         (and stash?
                              (wasm/ready?)
                              ;; Finalize may drop the file data before the viewport unmounts.
                              (some? (dsh/lookup-file-data @st/state))
                              (not @shapes-loading?)
                              (empty? (:wasm-props @st/state))
                              (nil? (text-editor/text-editor-get-active-shape-id)))
                         ;; The page being switched to is not evicted to make room.
                         (:current-page-id @st/state))
      (catch :default cause
        (log/error :hint "could not stash the page shapes" :cause cause)))))

(defn- set-objects-event
  "The `penpot:wasm:set-objects` event that ends a load. Its detail names
  the page and the load token of `resident` (see `initialize-viewport`),
  both nil for loads that are not a workspace page (thumbnails, viewer)."
  [resident]
  (ug/event "penpot:wasm:set-objects"
            #js {:pageId (:page-id resident)
                 :token  (:token resident)}))

(defn page-upload-event?
  "True when `event`, a `penpot:wasm:set-objects` event, ends the latest
  load of the workspace page `page-id` into the renderer. False for the
  late event of a page left before its upload ended, of an older load of
  the same page, or of a load that is not a page (thumbnails)."
  [event page-id]
  (let [detail (unchecked-get event "detail")]
    (and (some? detail)
         (some? page-id)
         (= page-id (unchecked-get detail "pageId"))
         (= (page-cache/latest-load-token) (unchecked-get detail "token")))))

(defn- fail-shapes-loading!
  "Ends an async upload that failed: leaves the WASM loading state, clears
  `shapes-loading?`, ends a page transition (the shapes-ready callback that
  arms its end never ran) and logs `cause`. `load-token` is the
  `page-cache/latest-load-token` when the upload started: when a newer load
  has begun since, that state is the newer load's, so only the error is
  logged. No `penpot:wasm:set-objects` event is sent: the page is not fully
  in WASM."
  [cause load-token]
  (when (= load-token (page-cache/latest-load-token))
    (when (wasm/live?)
      (h/call wasm/internal-module "_end_loading"))
    (end-shapes-loading!)
    (end-page-transition!))
  (js/console.error "Async WASM shape loading failed" cause))

(def ^:private ^:const BATCH_MAX_SHAPES 512)

(defn- process-shapes-chunk
  "Process the shapes of `chunk` (a vector of at most `BATCH_MAX_SHAPES`).

   Structural attrs are uploaded in one `_set_shapes_batch` FFI per chunk;
   host-specific attrs (fills/strokes/text/grid/path) stay per-shape.

   Returns {:thumbnails [...] :full [...] :text-font-state {...}}"
  [chunk thumbnails-acc full-acc text-font-state-acc]
  ;; One font memo per synchronous chunk (see f/call-with-batch-memo).
  (f/call-with-batch-memo
   (fn []
     (let [prepared (serialize-shape/serialize-shapes-batch
                     chunk
                     {:include-layout? true
                      :include-fills-strokes? true})]

       (loop [xs prepared
              t-acc (transient thumbnails-acc)
              f-acc (transient full-acc)
              font-state-acc text-font-state-acc]
         (if-let [shape (first xs)]
           (let [{:keys [thumbnails full font-face-keys pending-font-face-keys]}
                 (set-object-host-attrs shape true :skip-fills-strokes? true)]
             (recur (next xs)
                    (reduce conj! t-acc thumbnails)
                    (reduce conj! f-acc full)
                    (acc-text-font-state font-state-acc
                                         (:id shape)
                                         font-face-keys
                                         pending-font-face-keys)))
           {:thumbnails (persistent! t-acc)
            :full (persistent! f-acc)
            :text-font-state font-state-acc}))))))

(defn- finish-async-upload!
  "Ends an async upload once every chunk is in WASM: finishes the view and the
  text layouts, registers the page as resident, renders and dispatches the
  set-objects event. Starts the image and font fetches in the background.
  `resolve` is called once the page is loaded."
  [shapes thumbnails-acc full-acc text-font-state-acc render-callback
   on-shapes-ready resident resolve]
  (perf/end-measure "set-objects")

  ;; Notify that shapes are loaded and tiles rebuilt
  (when on-shapes-ready (on-shapes-ready))
  (if-not (wasm/live?)
    (do
      (end-shapes-loading!)
      (resolve nil))
    (do
      ;; Show shapes immediately: end loading overlay + unblock rendering
      (h/call wasm/internal-module "_end_loading")
      (end-shapes-loading!)

      ;; Rebuild the tile index so _render knows which shapes
      ;; map to which tiles after a page switch.
      (h/call wasm/internal-module "_set_view_end")
      (reset! view-interaction-active? false)

      ;; Text layouts must run after _end_loading (they
      ;; depend on state that is only correct when loading
      ;; is false).  Each call touch_shape → touched_ids.
      (let [text-ids (into [] (comp (filter cfh/text-shape?) (map :id)) shapes)]
        (when (seq text-ids)
          (update-text-layouts text-ids)))

      (let [pending-thumbnails (d/index-by :key :callback thumbnails-acc)
            pending-full       (d/index-by :key :callback full-acc)
            pending?           (or (seq pending-thumbnails) (seq pending-full))]
        ;; Text layouts are final when no font or image is pending.
        (register-resident! resident)
        (if render-callback
          (render-callback)
          (request-render "set-objects-complete"))
        (ug/dispatch! (set-objects-event resident))
        (resolve nil)

        ;; Kick off image fetches in the background.
        ;; The promise is already resolved so these don't
        ;; block the caller.
        (when pending?
          (->> (rx/concat
                (->> (rx/from (vals pending-thumbnails))
                     (rx/merge-map
                      (fn [callback]
                        (if (fn? callback) (callback) (rx/empty))))
                     (rx/reduce conj []))
                (->> (rx/from (vals pending-full))
                     (rx/mapcat
                      (fn [callback]
                        (if (fn? callback) (callback) (rx/empty))))
                     (rx/reduce conj [])))
               (rx/subs!
                noop-fn
                noop-fn
                (fn []
                  (relayout-after-fonts! shapes text-font-state-acc)
                  (request-render "images-loaded")))))))))

(defn- set-objects-async
  "Asynchronously process shapes in chunks of `BATCH_MAX_SHAPES`, yielding
   to the browser between chunks so the UI stays responsive. `next-shapes!`
   returns the next shapes to upload, at most the given count, and an empty
   vector when none are left (see `tree-order-source`), so each chunk looks
   up (and decodes) only its own shapes.
   Returns a promise that resolves when all shapes are processed, and
   rejects when any chunk, or the final step, throws. When a newer load
   begins, or WASM is no longer live, it resolves nil before the next chunk
   and does not finish the upload."
  [next-shapes! render-callback on-shapes-ready resident]
  (p/create
   (fn [resolve* reject]
     (let [load-token  (page-cache/latest-load-token)
           resolved?   (volatile! false)
           resolve     (fn [value]
                         (vreset! resolved? true)
                         (resolve* value))
           superseded? (fn []
                         (or (not= load-token (page-cache/latest-load-token))
                             (not (wasm/live?))))]
       (letfn [(process-next-chunk [shapes thumbnails-acc full-acc text-font-state-acc]
                 ;; Every chunk after the first runs in a `p/then` whose
                 ;; promise nobody holds: catch here so its errors reach the
                 ;; returned promise. Errors after the promise resolved (the
                 ;; image fetches set-up) can only be logged.
                 (try
                   (process-chunk shapes thumbnails-acc full-acc text-font-state-acc)
                   (catch :default cause
                     (if @resolved?
                       (js/console.error "WASM shape loading follow-up failed" cause)
                       (reject cause)))))

               (process-chunk [shapes thumbnails-acc full-acc text-font-state-acc]
                 ;; A superseded load stops here and is not finished: the
                 ;; newer load, or the canvas teardown, owns the WASM state.
                 (if (superseded?)
                   (resolve nil)
                   (let [chunk (next-shapes! BATCH_MAX_SHAPES)]
                     (if (seq chunk)
                       ;; Process one chunk
                       (let [{:keys [thumbnails full text-font-state]}
                             (process-shapes-chunk chunk thumbnails-acc full-acc text-font-state-acc)
                             shapes (into shapes chunk)]
                         ;; Yield to browser, then continue with next chunk
                         (-> (yield-to-browser)
                             (p/then (fn [_]
                                       (process-next-chunk shapes thumbnails full text-font-state)))
                             (p/catch reject)))
                       ;; All chunks done - finalize
                       (finish-async-upload! shapes thumbnails-acc full-acc text-font-state-acc
                                             render-callback on-shapes-ready resident resolve)))))]
         (process-next-chunk [] [] [] empty-text-font-state))))))


;; This is a version of process-pending that doesn't have sideffects
;; with like request render or update layout.
(defn- process-pending-no-sideffects
  [thumbnails full on-complete]
  (let [pending-thumbnails
        (d/index-by :key :callback thumbnails)

        pending-full
        (d/index-by :key :callback full)]

    (if (or (seq pending-thumbnails) (seq pending-full))
      (->> (rx/concat
            (->> (rx/from (vals pending-thumbnails))
                 (rx/merge-map (fn [callback] (if (fn? callback) (callback) (rx/empty))))
                 (rx/reduce conj [])
                 (rx/catch #(rx/empty)))
            (->> (rx/from (vals pending-full))
                 (rx/mapcat (fn [callback] (if (fn? callback) (callback) (rx/empty))))
                 (rx/reduce conj [])
                 (rx/catch #(rx/empty))))
           (rx/subs!
            noop-fn
            noop-fn
            (fn []
              (when (fn? on-complete) (on-complete)))))
      ;; No pending images — complete immediately.
      (when on-complete (on-complete)))))

(defn set-objects-callback
  "Sets the shapes and when the async operations are done calls the callback. Won't
  interact with the rendering pipeline, this call is only to set the model (used currently
  in the viewer)."
  [shapes set-objects-cb]
  (let [total-shapes (count shapes)
        {:keys [thumbnails full]}
        (loop [index 0 thumbnails-acc (transient []) full-acc (transient [])]
          (if (< index total-shapes)
            (let [shape (nth shapes index)
                  {:keys [thumbnails full]} (set-object shape)]
              (recur (inc index)
                     (reduce conj! thumbnails-acc thumbnails)
                     (reduce conj! full-acc full)))
            {:thumbnails (persistent! thumbnails-acc) :full (persistent! full-acc)}))]

    (process-pending-no-sideffects thumbnails full set-objects-cb)))

(defn- set-objects-sync
  "Synchronously process all shapes (for small shape counts)."
  [shapes render-callback on-shapes-ready resident]
  (let [{:keys [thumbnails full text-font-state]}
        (f/call-with-batch-memo
         (fn []
           (let [prepared     (serialize-shape/serialize-shapes-batch
                               shapes
                               {:include-layout? true
                                :include-fills-strokes? true})
                 total-shapes (count prepared)]
             (loop [index 0
                    thumbnails-acc (transient [])
                    full-acc (transient [])
                    font-state-acc empty-text-font-state]
               (if (< index total-shapes)
                 (let [shape (nth prepared index)
                       {:keys [thumbnails full font-face-keys pending-font-face-keys]}
                       (set-object-host-attrs shape true :skip-fills-strokes? true)]
                   (recur (inc index)
                          (reduce conj! thumbnails-acc thumbnails)
                          (reduce conj! full-acc full)
                          (acc-text-font-state font-state-acc
                                               (:id shape)
                                               font-face-keys
                                               pending-font-face-keys)))
                 {:thumbnails (persistent! thumbnails-acc)
                  :full (persistent! full-acc)
                  :text-font-state font-state-acc})))))]
    (perf/end-measure "set-objects")
    (when on-shapes-ready (on-shapes-ready))
    (when (wasm/live?)
      ;; Rebuild the tile index so _render knows which shapes
      ;; map to which tiles after a page switch.
      (h/call wasm/internal-module "_set_view_end")
      (reset! view-interaction-active? false)
      (register-resident! resident)
      (process-pending shapes thumbnails full text-font-state
                       (fn []
                         ;; Runs once fonts and images are in and texts laid out again.
                         (if render-callback
                           (render-callback)
                           (request-render "set-objects-sync-complete"))
                         (ug/dispatch! (set-objects-event resident)))))))

(defn- shapes-in-tree-order
  "Returns shapes sorted in tree order (parents before children).
   This ensures parent shapes are processed before their children,
   maintaining proper shape reference consistency in WASM."
  [objects]
  ;; Get IDs in tree order starting from root (uuid/zero)
  ;; If root doesn't exist (e.g., filtered thumbnail data), fall back to
  ;; finding top-level shapes (those without a parent in objects) and
  ;; traversing from there.
  (if (contains? objects uuid/zero)
    ;; Normal case: traverse from root
    (let [ordered-ids (cfh/get-children-ids-with-self objects uuid/zero)]
      (into []
            (keep #(get objects %))
            ordered-ids))
    ;; Fallback for filtered data (thumbnails): find top-level shapes and traverse
    (let [;; Find shapes whose parent is not in the objects map (top-level in this subset)
          top-level-ids (->> (vals objects)
                             (filter (fn [shape]
                                       (not (contains? objects (:parent-id shape)))))
                             (map :id))
          ;; Get all children in order for each top-level shape
          all-ordered-ids (into []
                                (mapcat #(cfh/get-children-ids-with-self objects %))
                                top-level-ids)]
      (into []
            (keep #(get objects %))
            all-ordered-ids))))

(defn- vector-source
  "Returns a `next-shapes!` function (see `set-objects-async`) over the
  `shapes` vector."
  [shapes]
  (let [index (volatile! 0)]
    (fn [n]
      (let [start @index
            end   (min (count shapes) (+ start n))]
        (vreset! index end)
        (into [] (subvec shapes start end))))))

(defn- tree-walk-source
  "Returns a `next-shapes!` function (see `set-objects-async`) that walks the
  tree from `root`, at most `n` values per call, and an empty vector when none
  are left. `children-of` returns the child ids of an id, `resolve` the value
  of an id: an id resolving to nil is skipped.

  The walk visits the root, then for each id all its children before the
  children's own subtrees, and an id seen again on its own path is skipped."
  [root children-of resolve]
  (let [;; Ids still to yield: the children of the last expanded shape.
        queue (volatile! (list root))
        ;; Shapes whose children are still to read, with the ids of their
        ;; path (the `processed` set of `cfh/get-children-ids`).
        stack (volatile! (list [root #{}]))]
    (fn [n]
      (loop [out (transient [])]
        (cond
          (>= (count out) n)
          (persistent! out)

          (seq @queue)
          (let [id (first @queue)]
            (vswap! queue rest)
            (recur (if-let [value (resolve id)]
                     (conj! out value)
                     out)))

          (seq @stack)
          (let [[id processed] (peek @stack)]
            (vswap! stack pop)
            (when-not (contains? processed id)
              (let [children  (vec (children-of id))
                    processed (conj processed id)]
                (vreset! queue (seq children))
                (vswap! stack into
                        (map (fn [child-id] [child-id processed]))
                        (rseq children))))
            (recur out))

          :else
          (persistent! out))))))

(defn- tree-order-source
  "Returns a `next-shapes!` function (see `set-objects-async`) that yields
  the shapes of `objects` in the same order as `shapes-in-tree-order` does
  for a map holding the root (`uuid/zero`), at most `n` per call, and an
  empty vector when none are left.

  It walks the tree as `cfh/get-children-ids-with-self` does (the root, then
  for each shape all its children before the children's own subtrees, a
  shape seen again on its own path skipped) and drops ids missing from
  `objects`. Each shape is looked up only when it is yielded or its
  children are read, so a lazy objects map is decoded chunk by chunk
  instead of in one task before the first chunk."
  [objects]
  (tree-walk-source uuid/zero
                    #(dm/get-in objects [% :shapes])
                    #(get objects %)))

(defn- drain-source
  "Returns all the shapes left in `next-shapes!`, as a vector."
  [next-shapes!]
  (loop [shapes []]
    (let [chunk (next-shapes! BATCH_MAX_SHAPES)]
      (if (seq chunk)
        (recur (into shapes chunk))
        shapes))))

(defn- prepend-source
  "Returns a `next-shapes!` function that yields the `head` shapes before
  the ones of `next-shapes!`, keeping the size of every chunk."
  [head next-shapes!]
  (let [head (volatile! head)]
    (fn [n]
      (if-let [shapes @head]
        (do
          (vreset! head nil)
          (into shapes (next-shapes! (max 0 (- n (count shapes))))))
        (next-shapes! n)))))

;; --- Worker upload
;;
;; A large workspace page is uploaded with the upload workers (see
;; `app.render-wasm.upload-pool`). The workers decode the shapes and read the
;; child ids and the hint of every shape; the main thread attaches the hints to
;; the page objects. The chunks in tree order are then encoded by the worker
;; that owns their shapes, and the main thread replays the entries with the
;; WASM calls of `process-shapes-chunk`. A shape changed since the load began,
;; or kept on the main thread, is encoded on the main thread from the current
;; page instead. A worker failure before the hints falls back to
;; `set-objects-async`; after that, the rest of the chunks are encoded on the
;; main thread.

(def ^:private ^:const worker-upload-min-shapes 3000)
(def ^:private ^:const worker-upload-inflight 3)

;; The summary of a worker upload is kept by the page cache (see
;; `page-cache/set-summary!`). `restore-page!` reads a record only for a shape
;; whose raw value is still the summary's `raw`. A page loaded any other way
;; drops its summary (see `initialize-viewport`).
(defn- make-summary
  "Returns the summary of a worker upload of a page: `raw` is the snapshot the
  load began from, `records` the `shape-resources` of its shapes by id, and
  `db` the fonts DB the texts were read with (nil when the DB changed during
  the upload, so every text is read again). `:no-nils?` tells whether `raw`
  has no nil entry. An ObjectsMap keeps its raw map identical after it sets
  an entry that is nil already, so only a raw map with no nil entry proves
  that no shape changed."
  [raw records db]
  {:raw      raw
   :db       db
   :records  records
   :no-nils? (not-any? nil? (vals raw))})

(defn worker-upload-enabled?
  "True when `objects` is a large page that the upload workers should load."
  [objects]
  (and (contains? cf/flags :render-wasm-worker-upload)
       (omap/objects-map? objects)
       (contains? objects uuid/zero)
       (>= (count objects) worker-upload-min-shapes)
       (pool/available?)))

(defn prewarm-upload-workers!
  "Starts the upload workers ahead of the first load of the page `page-id`
  with the shapes `objects`, when that load would use them. Skipped when the
  page can be restored from the page cache."
  [objects page-id]
  (when (and (worker-upload-enabled? objects)
             (not (page-cache/restorable? page-id (page-cache-epoch))))
    (pool/prewarm!)))

(defn- partition-ids
  "Splits the entries of the raw data `raw` between `n` workers, round robin.
  Returns {:parts .. :owner ..}. `parts` holds the `ids` and `strs` arrays of
  each worker. `owner` maps every id string to its worker index, or to -1 when
  the shape is kept on the main thread (its raw value is nil)."
  [raw n]
  (let [parts (mapv (fn [_] #js {:ids #js [] :strs #js []}) (range n))
        owner (js/Map.)]
    (reduce-kv
     (fn [i uid s]
       (let [id (str uid)]
         (if (some? s)
           (let [w    (mod i n)
                 part (nth parts w)]
             (.push (unchecked-get part "ids") id)
             (.push (unchecked-get part "strs") s)
             (.set owner id w)
             (inc i))
           (do
             (.set owner id -1)
             i))))
     0
     raw)
    {:parts parts :owner owner}))

(defn- index-structures
  "Reads the `replies` to the load requests, one per worker in the order of
  `parts`. Returns {:children .. :frames .. :texts ..}. `children` maps every
  id string to the JS array of its child id strings, or nil. `frames` and
  `texts` map the uuid of each frame and text to its hint data. A shape kept
  on the main thread (nil raw value) is read from `objects`, with no hint."
  [replies parts raw objects]
  (let [children (js/Map.)
        frames   (volatile! {})
        texts    (volatile! {})]
    (doseq [[^js reply ^js part] (map vector replies parts)
            :let [structure (unchecked-get reply "structure")
                  ids       (unchecked-get part "ids")]]
      (dotimes [i (alength ids)]
        (let [id          (aget ids i)
              ^js entry   (aget structure i)
              [kind data] (ue/hint->entry (aget entry 1))]
          (.set children id (aget entry 0))
          (case kind
            :frame (vswap! frames assoc (uuid/uuid id) data)
            :text  (vswap! texts assoc (uuid/uuid id) data)
            nil))))
    (doseq [[uid s] raw
            :when (nil? s)]
      (.set children (str uid) (aget (ue/shape-structure (get objects uid)) 0)))
    {:children children
     :frames @frames
     :texts @texts}))

(defn- drain-id-chunks
  "Returns the ids of `next-ids!` as a vector of chunks of at most
  `BATCH_MAX_SHAPES` ids."
  [next-ids!]
  (loop [chunks []]
    (let [chunk (next-ids! BATCH_MAX_SHAPES)]
      (if (seq chunk)
        (recur (conj chunks chunk))
        chunks))))

(defn- set-font-vectors!
  "Replaces the `fonts` and `fallback` arrays of the text of the upload entry
  `e` by vectors, with every element mapped by `f`."
  [^js e f]
  (when-let [^js text (unchecked-get e "text")]
    (unchecked-set text "fonts" (mapv f (array-seq (unchecked-get text "fonts"))))
    (unchecked-set text "fallback" (mapv f (array-seq (unchecked-get text "fallback"))))))

(defn- fetch-entries
  "Asks the workers that own `ids` to encode their shapes. Resolves to
  #js {:entries .. :db ..}: `entries` is a js/Map from the id string of each
  shape to its upload entry (see `upload-entry`), and `db` is the fonts DB the
  entries are encoded with (`fonts/fontsdb` at the request). The font faces of
  the texts are read from the font table of each worker."
  [job owner ids]
  (let [groups (reduce (fn [groups id]
                         (let [w (.get owner id)]
                           (if (>= w 0)
                             (update groups w (fnil conj []) id)
                             groups)))
                       {}
                       ids)
        ;; Messages to one worker keep their order, so the workers apply the
        ;; fonts DB before these encode requests. Its promise is not waited on.
        _     (p/catch (pool/configure-fonts!) (fn [_] nil))
        db    @fonts/fontsdb]
    (-> (p/all (mapv (fn [[w wids]]
                       (pool/request! w #js {:op "encode"
                                             :job job
                                             :ids (into-array wids)}
                                      nil))
                     groups))
        (p/then (fn [replies]
                  (let [entries (js/Map.)]
                    (doseq [^js reply replies
                            :let [table (transit/decode-str (unchecked-get reply "fontTable"))
                                  ^js batch (unchecked-get reply "entries")]]
                      (dotimes [i (alength batch)]
                        (let [^js e (aget batch i)]
                          (set-font-vectors! e #(nth table %))
                          (.set entries (unchecked-get e "id") e))))
                    #js {:entries entries :db db}))))))

(defn- request-chunk
  "Starts the encode request of the chunk `ids` (see `fetch-entries`). Resolves to
  nil when the workers fail: `failed?` is then set, and no later chunk is sent
  to them. Never rejects."
  [job owner ids failed?]
  (if @failed?
    (p/resolved nil)
    (-> (fetch-entries job owner ids)
        (p/catch (fn [cause]
                   (vreset! failed? true)
                   (js/console.error "WASM worker upload failed" cause)
                   nil)))))

(defn- request-ahead!
  "Starts the encode requests of the chunks up to `k` and of the
  `worker-upload-inflight` chunks after it."
  [{:keys [chunks requests job owner failed?]} k]
  (let [upto (min (count chunks) (+ k worker-upload-inflight 1))]
    (doseq [i (range (count @requests) upto)]
      (vswap! requests conj (request-chunk job owner (nth chunks i) failed?)))))

(defn- replay-chunk
  "Returns {:entries .. :host-shapes ..} for the ids `ids` of a chunk, in order.
  An id is clean when its worker entry is present and the page still holds the
  raw value it had when the load began: its entry is used. A text entry is not
  clean when `fonts-changed?` is true, as the fonts DB changed since the entry
  was encoded. Any other id is encoded on the main thread from `current`, the
  current page, or from `objects` when there is no current page. An id whose
  shape is gone is dropped. `host-shapes` maps the id of each host 1 entry to
  its svg-derived shape."
  [ids owner raw objects current worker-map fonts-changed?]
  (reduce
   (fn [acc id]
     (let [uid    (uuid/uuid id)
           w      (.get owner id)
           entry  (some-> worker-map (.get id))
           clean? (and (>= w 0)
                       (some? entry)
                       (some? current)
                       (not (and fonts-changed? (some? (unchecked-get entry "text"))))
                       (identical? (get raw uid) (omap/raw-value current uid)))]
       (if clean?
         (cond-> (update acc :entries conj entry)
           (= 1 (unchecked-get entry "host"))
           (assoc-in [:host-shapes id] (svg-derived/apply-svg-derived (get current uid))))
         (let [shape (get (or current objects) uid)]
           (if (nil? shape)
             acc
             (let [entry (ue/encode-entry shape identity)]
               (set-font-vectors! entry identity)
               (cond-> (update acc :entries conj entry)
                 (= 1 (unchecked-get entry "host"))
                 (assoc-in [:host-shapes id] (svg-derived/apply-svg-derived shape)))))))))
   {:entries [] :host-shapes {}}
   ids))

(defn- replay-chunks
  "Replays the chunks of `ctx` from the chunk `k` on, after the state `state`
  ({:thumbnails .. :full .. :text-font-state .. :shapes .. :records ..}, the
  `:records` map the resources of the replayed shapes by id). Resolves to the
  state after the last chunk, or to nil when a newer load has begun or WASM
  is no longer live. The reply of a replayed chunk is dropped from `requests`."
  [{:keys [chunks requests load-token file-id page-id raw objects owner] :as ctx} k state]
  (if (>= k (count chunks))
    (p/resolved (when (and (= load-token (page-cache/latest-load-token))
                           (wasm/live?))
                  state))
    (do
      (request-ahead! ctx k)
      (-> (nth @requests k)
          (p/then
           (fn [reply]
             (if-not (and (= load-token (page-cache/latest-load-token))
                          (wasm/live?))
               (p/resolved nil)
               (let [current        (dsh/lookup-page-objects @st/state file-id page-id)
                     ;; The entries are encoded with the fonts DB of their request.
                     fonts-changed? (and (some? reply)
                                         (not (identical? (unchecked-get reply "db")
                                                          @fonts/fontsdb)))
                     {:keys [entries host-shapes]}
                     (replay-chunk (nth chunks k) owner raw objects current
                                   (some-> reply (unchecked-get "entries"))
                                   fonts-changed?)
                     state'  (if (seq entries)
                               (let [done (apply-entries! entries host-shapes
                                                          (:thumbnails state)
                                                          (:full state)
                                                          (:text-font-state state))]
                                 {:thumbnails (:thumbnails done)
                                  :full (:full done)
                                  :text-font-state (:text-font-state done)
                                  :shapes (into (:shapes state) (:shapes done))
                                  :records (into (:records state)
                                                 (map (juxt :id identity))
                                                 (:resources done))})
                               state)]
                 (vswap! requests assoc k nil)
                 (-> (yield-to-browser)
                     (p/then (fn [_]
                               (replay-chunks ctx (inc k) state'))))))))))))

(defn- set-objects-workers
  "Uploads the workspace page `objects` with the upload workers. Returns a
  promise that resolves when the page is in WASM, like `set-objects-async`.
  Until the hints are attached, a failure falls back to `set-objects-async`
  (unless a newer load has begun). A later failure rejects. The loading state
  is already begun when this is called."
  [objects render-callback on-shapes-ready resident]
  (p/create
   (fn [resolve reject]
     (let [load-token    (page-cache/latest-load-token)
           file-id       (:current-file-id @st/state)
           page-id       (:page-id resident)
           db0           @fonts/fontsdb
           job           (str (uuid/next))
           raw           (omap/raw-data objects)
           open?         (volatile! false)
           loaded?       (volatile! false)
           end-job!      (fn []
                           (when @open?
                             (vreset! open? false)
                             (pool/release! job)
                             (pool/job-ended!)))
           current-load? (fn []
                           (= load-token (page-cache/latest-load-token)))
           fallback!     (fn []
                           (-> (set-objects-async (tree-order-source objects)
                                                  render-callback on-shapes-ready resident)
                               (p/then resolve)
                               (p/catch reject)))]
       (try
         (vreset! open? true)
         (pool/job-started!)
         (let [workers (pool/ensure-pool!)
               {:keys [parts owner]} (partition-ids raw (count workers))]
           (-> (pool/configure-fonts!)
               (p/then
                (fn [_]
                  (p/all (into []
                               (map-indexed
                                (fn [w ^js part]
                                  (pool/request! w #js {:op "load"
                                                        :job job
                                                        :ids (unchecked-get part "ids")
                                                        :strs (unchecked-get part "strs")}
                                                 nil)))
                               parts))))
               (p/then
                (fn [replies]
                  (let [{:keys [children frames texts]}
                        (index-structures replies parts raw objects)

                        chunks (drain-id-chunks
                                (tree-walk-source (str uuid/zero)
                                                  #(some-> (.get children %) array-seq)
                                                  #(when (.has owner %) %)))]
                    (if-not (current-load?)
                      (do
                        (end-job!)
                        (resolve nil))
                      (do
                        (vreset! loaded? true)
                        (st/emit! (drw/set-page-objects-hints file-id page-id
                                                              {:raw raw
                                                               :frames frames
                                                               :texts texts}))
                        (-> (replay-chunks {:job job
                                            :owner owner
                                            :raw raw
                                            :objects objects
                                            :file-id file-id
                                            :page-id page-id
                                            :chunks chunks
                                            :requests (volatile! [])
                                            :failed? (volatile! false)
                                            :load-token load-token}
                                           0
                                           {:thumbnails []
                                            :full []
                                            :text-font-state empty-text-font-state
                                            :shapes []
                                            :records {}})
                            (p/then
                             (fn [state]
                               (end-job!)
                               (if (some? state)
                                 (do
                                   (when (some? page-id)
                                     (page-cache/set-summary!
                                      page-id
                                      (make-summary raw
                                                    (:records state)
                                                    (when (identical? db0 @fonts/fontsdb)
                                                      db0))))
                                   (finish-async-upload! (:shapes state)
                                                         (:thumbnails state)
                                                         (:full state)
                                                         (:text-font-state state)
                                                         render-callback on-shapes-ready
                                                         resident resolve))
                                 (resolve nil))))))))))
               (p/catch
                (fn [cause]
                  (end-job!)
                  (if @loaded?
                    (reject cause)
                    (do
                      (log/warn :hint "worker upload failed, using the main thread"
                                :cause cause)
                      (if (current-load?)
                        (fallback!)
                        (resolve nil))))))))
         (catch :default cause
           (end-job!)
           (log/warn :hint "worker upload failed, using the main thread"
                     :cause cause)
           (if (current-load?)
             (fallback!)
             (resolve nil))))))))

(defn set-objects
  "Set all shape objects for rendering.

   Shapes are processed in tree order (parents before children)
   to maintain proper shape reference consistency in WASM.

   on-shapes-ready is an optional callback invoked right after shapes are
   loaded into WASM (and tiles rebuilt for async). It fires before image
   loading begins, allowing callers to reveal the page content during
   transitions.

   `resident`, when given, describes the workspace page being loaded (see
   `initialize-viewport`); once loaded it becomes the page the page cache
   may stash."
  ([objects]
   (set-objects objects nil nil false nil))
  ([objects render-callback]
   (set-objects objects render-callback nil false nil))
  ([objects render-callback on-shapes-ready force-sync]
   (set-objects objects render-callback on-shapes-ready force-sync nil))
  ([objects render-callback on-shapes-ready force-sync resident]
   (when (wasm/live?)
     (perf/begin-measure "set-objects")
     ;; A large workspace page goes to the upload workers, which read no
     ;; shape on the main thread. Otherwise only the first `ASYNC_THRESHOLD`
     ;; shapes are read here, enough to choose the sync or async path; the
     ;; async path reads the rest chunk by chunk.
     (let [workers?     (and (not force-sync)
                             (some? (:page-id resident))
                             (worker-upload-enabled? objects))
           next-shapes! (when-not workers?
                          (if (contains? objects uuid/zero)
                            (tree-order-source objects)
                            (vector-source (shapes-in-tree-order objects))))
           head         (when-not workers?
                          (next-shapes! ASYNC_THRESHOLD))]
       (if (and (not workers?)
                (or force-sync (< (count head) ASYNC_THRESHOLD)))
         (set-objects-sync (into head (drain-source next-shapes!))
                           render-callback on-shapes-ready resident)
         (do
           (begin-shapes-loading!)
           (h/call wasm/internal-module "_begin_loading")
           ;; NOTE: to render a loading overlay in the future
           ;;  (when-not on-shapes-ready
           ;;    (h/call wasm/internal-module "_render_loading_overlay"))
           (let [load-token (page-cache/latest-load-token)]
             (try
               (-> (if workers?
                     (set-objects-workers objects render-callback on-shapes-ready resident)
                     (set-objects-async (prepend-source head next-shapes!)
                                        render-callback on-shapes-ready resident))
                   (p/catch (fn [error]
                              (fail-shapes-loading! error load-token))))
               (catch :default error
                 (fail-shapes-loading! error load-token)
                 (throw error))))
           nil))))))

(defn- collect-page-resources
  "Stores the fonts of the resources `resources` (see `shape-resources`) and
  registers their image URLs in WASM, as `set-object-host-attrs` does, without
  writing any shape data. A restored page has its shapes back in WASM, but the
  renderer was rebuilt with empty font and image stores.

  Returns {:fonts [...] :thumbnails [...] :full [...] :text-font-state {...}
  :image-text-ids [...] :texts [...]}: the font and image fetches still to run,
  the faces of each text (read before storing, so every face the new renderer
  lacks is pending), the texts with image fills (their stashed layouts may have
  been dropped, see `detach_paint_cache` in render-wasm), and the stubs of the
  texts (id, type, grow type and box) that the relayout steps read."
  [resources]
  (f/call-with-batch-memo
   (fn []
     (reduce
      (fn [acc {:keys [id text? fonts fallback-fonts timg fimg simg grow-type selrect]}]
        (let [text-fonts (when text? {:fonts fonts :fallback-fonts fallback-fonts})
              ;; Read before storing, as `set-object-host-attrs` does.
              {:keys [font-face-keys pending-font-face-keys]}
              (when text? (text-font-face-keys-state text-fonts))]
          (when text?
            (f/load-fallback-fonts-for-editor! fallback-fonts))
          (-> acc
              (cond-> (and text? (or (seq fimg) (seq timg)))
                (update :image-text-ids conj id))
              (cond-> text?
                (-> (update :fonts into (f/store-fonts (concat fonts fallback-fonts)))
                    (update :texts conj {:id        id
                                         :type      :text
                                         :grow-type grow-type
                                         :selrect   selrect})))
              (update :thumbnails into
                      (concat (when text? (map #(process-fill-image-id id % true) timg))
                              (when fimg (keep #(image-fetch id % true) fimg))
                              (keep #(image-fetch id % true) simg)))
              (update :full into
                      (concat (when text? (map #(process-fill-image-id id % false) timg))
                              (when fimg (keep #(image-fetch id % false) fimg))
                              (keep #(image-fetch id % false) simg)))
              (update :text-font-state acc-text-font-state id font-face-keys pending-font-face-keys))))
      {:fonts []
       :thumbnails []
       :full []
       :text-font-state empty-text-font-state
       :image-text-ids []
       :texts []}
      resources))))

(defn- run-resource-callbacks!
  [entries]
  (if (seq entries)
    (p/create
     (fn [resolve _reject]
       (->> (rx/from (vals (d/index-by :key :callback entries)))
            (rx/merge-map (fn [callback] (if (fn? callback) (callback) (rx/empty))))
            (rx/reduce conj [])
            (rx/subs! (fn [_] (resolve nil))
                      (fn [_cause] (resolve nil))
                      (fn [] (resolve nil))))))
    (p/resolved nil)))

(defn- relayout-when-fonts-stored!
  "Once every pending face of `text-font-state` is stored in WASM or has
  failed, lays out again the texts that use those faces, which also redraws
  their tiles. Listens to the font streams, so a face fetched by a request
  started before the restore counts too. Does nothing when the page of load
  `token` is no longer resident. Stops listening after 60 seconds. `texts` are
  the text stubs of the page (see `collect-page-resources`)."
  [token texts {:keys [pending-faces] :as text-font-state}]
  (when (seq pending-faces)
    (->> (rx/merge f/font-stored-stream f/font-storage-failed-stream)
         (rx/take-until (rx/timer 60000))
         (rx/filter pending-faces)
         (rx/scan disj pending-faces)
         (rx/filter empty?)
         (rx/take 1)
         (rx/subs!
          (fn [_]
            (when (and (wasm/live?)
                       (= token (page-cache/resident-token)))
              (relayout-after-fonts! texts text-font-state)
              (request-render "fonts-loaded")))))))

(defn- restore-resources
  "The resource maps (see `shape-resources`) of the page `base-objects`, in
  map order. With the `summary` of its last worker upload, a shape whose raw
  value is still the one the summary was made from reuses its record, so it
  is not decoded. A text is read again when the fonts DB is no longer
  `fonts-db`, the one its record was made with. Without a summary every
  shape is read."
  [summary base-objects fonts-db]
  (if (some? summary)
    (let [same-db?  (identical? (:db summary) fonts-db)
          ;; No shape changed since the upload: skip the per-shape check. An
          ;; edit can keep the raw map identical (see `make-summary`), so the
          ;; shortcut needs a raw map with no nil entry.
          same-raw? (and (:no-nils? summary)
                         (identical? (:raw summary) (omap/raw-data base-objects)))
          hints     {:raw (:raw summary)}]
      (into []
            (keep (fn [id]
                    (let [record (get (:records summary) id)]
                      (if (and (or same-raw? (ohints/known? hints base-objects id))
                               (or same-db? (not (:text? record))))
                        record
                        (shape-resources (get base-objects id))))))
            (keys base-objects)))
    (into [] (keep shape-resources) (vals base-objects))))

(defn- restore-page!
  "Finishes loading a page whose shapes pool came back from the page cache,
  in place of `set-objects`. The renderer was rebuilt with an empty image
  store; it keeps the font store while the page cache holds pages, but a
  page's fonts may not all be in it yet. So before the first frame this
  stores the page's fonts, registers its image URLs and starts the font
  fetches. Until the fonts are stored, text passes that build paragraphs from
  the font store (strokes, shadows, texts without a usable cached layout) use
  fallback faces, so once they are stored every text whose faces were missing
  is laid out again and its tiles redrawn. Images load in idle time.

  The resources come from the summary that the last worker upload of the page
  left (see `page-cache/summary`). A shape whose raw value is still the one the
  summary was made from reuses its record. Any other shape is read again."
  [base-objects resident render-callback on-shapes-ready]
  (perf/begin-measure "restore-page")
  (let [token     (:token resident)
        resources (restore-resources (page-cache/summary (:page-id resident))
                                     base-objects
                                     @fonts/fontsdb)
        current?  (fn []
                    (and (wasm/live?)
                         (= token (page-cache/resident-token))))
        {:keys [fonts thumbnails full text-font-state image-text-ids texts]}
        (collect-page-resources resources)]
    (when on-shapes-ready (on-shapes-ready))
    (h/call wasm/internal-module "_set_view_end")
    (reset! view-interaction-active? false)
    ;; The stash dropped the cached layouts of the texts with image fills, so
    ;; they are laid out now, before the first frame. Same order as
    ;; `finish-async-upload!`: after `_set_view_end`.
    (force-update-text-layouts image-text-ids)
    (perf/end-measure "restore-page")
    (register-resident! resident)
    ;; Listen before the fetches start, so no stored face is missed.
    (relayout-when-fonts-stored! token texts text-font-state)
    (run-resource-callbacks! fonts)
    (if render-callback
      (render-callback)
      (request-render "restore-page"))
    (ug/dispatch! (set-objects-event resident))
    (timers/schedule-on-idle
     (fn []
       ;; Skip when the page was left, or loaded again, before this ran.
       (when (current?)
         (process-pending-no-sideffects
          thumbnails full
          (fn []
            (when (current?)
              ;; Their layouts were rebuilt when their images arrived, maybe
              ;; before their fonts.
              (force-update-text-layouts image-text-ids)
              (request-render "images-loaded")))))))))

(defn clear-focus-mode
  []
  (when (initialized?)
    (h/call wasm/internal-module "_clear_focus_mode")
    (request-render "clear-focus-mode")))

(defn set-focus-mode
  [entries]
  (when (and (initialized?) (not ^boolean (empty? entries)))
    (let [size   (mem/get-alloc-size entries UUID-U8-SIZE)
          offset (mem/alloc->offset-32 size)
          heap   (mem/get-heap-u32)]

      (reduce (fn [offset id]
                (mem.h32/write-uuid offset heap id))
              offset
              entries)

      (h/call wasm/internal-module "_set_focus_mode")
      (request-render "set-focus-mode"))))

(defn clear-render-include-filter!
  "Clear the viewer include filter (render all shapes in the subtree again)."
  []
  (when (initialized?)
    (h/call wasm/internal-module "_clear_render_include_filter")))

(defn set-render-include-filter!
  "Restrict the next render to `shape-ids` and descendants of whitelisted nodes.
  Used for viewer fixed-scroll layers; does not change shape hidden flags."
  [shape-ids]
  (when (and (initialized?) (seq shape-ids))
    (let [ids    (vec shape-ids)
          size   (mem/get-alloc-size ids UUID-U8-SIZE)
          offset (mem/alloc->offset-32 size)
          heap   (mem/get-heap-u32)]
      (reduce (fn [offset id]
                (mem.h32/write-uuid offset heap id))
              offset
              ids)
      (h/call wasm/internal-module "_set_render_include_filter"))))

(defn set-structure-modifiers
  [entries]
  (when (and (initialized?) (not ^boolean (empty? entries)))
    (let [size    (mem/get-alloc-size entries 44)
          offset  (mem/alloc->offset-32 size)
          heapu32 (mem/get-heap-u32)
          heapf32 (mem/get-heap-f32)]


      (reduce (fn [offset {:keys [type parent id index value]}]
                (-> offset
                    (mem.h32/write-u32 heapu32 (sr/translate-structure-modifier-type type))
                    (mem.h32/write-u32 heapu32 (d/nilv index 0))
                    (mem.h32/write-uuid heapu32 parent)
                    (mem.h32/write-uuid heapu32 id)
                    (mem.h32/write-f32 heapf32 value)))
              offset
              entries)

      (h/call wasm/internal-module "_set_structure_modifiers"))))

;; Axes the pixel grid rounds, as `propagate_modifiers` expects them.
(def ^:private pixel-precision
  {:disabled 0
   :both     1
   :only-x   2
   :only-y   3})

(defn- pixel-precision-mode
  "Encodes the pixel grid snapping for the renderer. `snap-ignore-axis`
  names the axis to leave alone (`:x`, `:y` or nil)."
  [snap-pixel? snap-ignore-axis]
  (pixel-precision
   (cond
     (not snap-pixel?)       :disabled
     (= :x snap-ignore-axis) :only-y
     (= :y snap-ignore-axis) :only-x
     :else                   :both)))

(defn propagate-modifiers
  "Propagates geometry modifiers through the WASM shape tree.

  Rounds the resulting geometry to the pixel grid when `snap-pixel?` is set,
  skipping the axis named by `snap-ignore-axis` (`:x`, `:y` or nil).

  Always returns a vector. When the context is not ready (lost / mid-reload)
  or `entries` is empty, returns `[]` so callers never receive `nil` (which
  would trip `set-modifiers`' vector assert)."
  [entries snap-pixel? snap-ignore-axis]
  (if-not (and (initialized?) (not ^boolean (empty? entries)))
    []
    (let [size    (mem/get-alloc-size entries INPUT-MODIFIER-U8-SIZE)
          offset  (mem/alloc->offset-32 size)
          heapf32 (mem/get-heap-f32)
          heapu32 (mem/get-heap-u32)]

      (reduce (fn [offset [id data]]
                (let [transform (:transform data)
                      kind (:kind data)]
                  (-> offset
                      (mem.h32/write-uuid heapu32 id)
                      (mem.h32/write-matrix heapf32 transform)
                      (mem.h32/write-u32 heapu32 (sr/translate-transform-entry-kind kind)))))
              offset
              entries)

      (let [precision  (pixel-precision-mode snap-pixel? snap-ignore-axis)
            offset     (-> (h/call wasm/internal-module "_propagate_modifiers" precision)
                           (mem/->offset-32))
            ;; The call above may have grown the memory: take fresh views.
            heapf32    (mem/get-heap-f32)
            heapu32    (mem/get-heap-u32)
            length     (aget heapu32 offset)
            max-offset (+ offset 1 (* length MODIFIER-U32-SIZE))
            result     (loop [result (transient [])
                              offset (inc offset)]
                         (if (< offset max-offset)
                           (let [entry (dr/read-modifier-entry heapu32 heapf32 offset)]
                             (recur (conj! result entry)
                                    (+ offset MODIFIER-U32-SIZE)))
                           (persistent! result)))]

        (mem/free)
        result))))

(defn get-selection-rect
  [entries]

  (when (and (initialized?) (not ^boolean (empty? entries)))
    (let [size    (mem/get-alloc-size entries UUID-U8-SIZE)
          offset  (mem/alloc->offset-32 size)
          heapu32 (mem/get-heap-u32)]

      (reduce (fn [offset id]
                (mem.h32/write-uuid offset heapu32 id))
              offset
              entries)

      (let [offset (-> (h/call wasm/internal-module "_get_selection_rect")
                       (mem/->offset-32))
            ;; The call above may have grown the memory: take a fresh view.
            heapf32 (mem/get-heap-f32)
            result (dr/read-selection-rect heapf32 offset)]
        (mem/free)
        result))))

(defn set-canvas-background
  [background]
  (when (initialized?)
    (let [rgba (sr-clr/hex->u32argb background 1)]
      ;; Background is baked into every tile. Cancel Partial/ViewportReady so we
      ;; do not continue a progressive pass whose tile cache was just cleared —
      ;; that drops already-finished tiles from the queue and leaves bg-only holes.
      (stop-progressive-render!)
      (h/call wasm/internal-module "_set_canvas_background" rgba)
      (request-render "set-canvas-background"))))

(defn clean-modifiers
  []
  (when (initialized?)
    (h/call wasm/internal-module "_clean_modifiers")))

(defn set-modifiers-start
  "Enter interactive transform mode (drag / resize / rotate). Enables
   fast-mode effect skipping in the renderer and activates an atlas
   backdrop so tiles do not appear sequentially or flicker while the
   gesture is in progress."
  []
  (when (initialized?)
    (h/call wasm/internal-module "_set_modifiers_start")))

(defn set-modifiers-end
  "Leave interactive transform mode. Cancels any pending async render
   scheduled under it; the caller is expected to trigger a full-quality
   render (via `request-render`) once the gesture is committed."
  []
  (when (initialized?)
    (h/call wasm/internal-module "_set_modifiers_end")))

(defn set-modifiers
  [modifiers]
  (when (initialized?)
    ;; Assert only when we would touch WASM; callers may still build
    ;; modifiers while the context is unavailable.
    (assert (vector? modifiers) "expected a vector for `set-modifiers`")

    (let [length (count modifiers)]
      (when (pos? length)
        (let [offset  (mem/alloc->offset-32 (* MODIFIER-U8-SIZE length))
              heapu32 (mem/get-heap-u32)
              heapf32 (mem/get-heap-f32)]

          (reduce (fn [offset [id transform]]
                    (-> offset
                        (mem.h32/write-uuid heapu32 id)
                        (mem.h32/write-matrix heapf32 transform)))
                  offset
                  modifiers)

          (h/call wasm/internal-module "_set_modifiers")

          (request-render "set-modifiers"))))))

(defn initialize-viewport
  "Loads `base-objects` into a freshly initialized renderer.

  `page-id` is given only for a workspace page. It names the page in the
  `penpot:wasm:set-objects` event that ends the load (see
  `page-upload-event?`). When `page-cache?` is true (the default) and
  `base-objects` are all the page objects (no focus filter), the page's
  stashed shapes pool is restored when it still matches the data, skipping
  the upload, and the page becomes the one the next page switch may stash."
  [base-objects zoom vbox &
   {:keys [background background-opacity on-render on-shapes-ready force-sync page-id page-cache?]
    :or {background-opacity 1
         page-cache? true}}]
  (when (wasm/live?)
    (let [rgba         (when background (sr-clr/hex->u32argb background background-opacity))
          total-shapes (count (vals base-objects))
          token        (page-cache/begin-load!)
          resident     (when (some? page-id)
                         {:token   token
                          :page-id page-id
                          :cache?  (boolean page-cache?)
                          :epoch   (page-cache-epoch)
                          :version (page-cache/version page-id)})]

      ;; Stop Partial/ViewportReady follow-ups before we clear the shapes pool.
      (stop-progressive-render!)
      ;; A load this one supersedes stops without leaving the loading state
      ;; (see `begin-load!`): leave it here, or a restore or a small page
      ;; would stay in it.
      (when @shapes-loading?
        (h/call wasm/internal-module "_end_loading")
        (reset! shapes-loading? false)
        (reset! deferred-render? false))
      (when rgba (h/call wasm/internal-module "_set_canvas_background" rgba))
      (h/call wasm/internal-module "_set_view" zoom (- (:x vbox)) (- (:y vbox)))
      (if (and (:cache? resident)
               (some? (page-cache/restore! page-id (:epoch resident))))
        (restore-page! base-objects resident on-render on-shapes-ready)
        (do
          ;; The upload below replaces the summary of the page, or leaves none
          ;; when it runs on the main thread. An older one must not be used.
          (when (some? page-id)
            (page-cache/drop-summary! page-id))
          (h/call wasm/internal-module "_init_shapes_pool" total-shapes)
          (set-objects base-objects on-render on-shapes-ready force-sync resident))))))

(defn- replay-font-resources!
  [fonts]
  (let [pending (into [] (f/store-fonts fonts))]
    (run-resource-callbacks! pending)))

(defn- derive-font-resources
  [base-objects payload-fonts]
  (let [object-fonts
        (->> (vals base-objects)
             (filter cfh/text-shape?)
             (mapcat (fn [shape]
                       (let [content (ensure-text-content (:content shape))
                             direct-fonts (f/get-content-fonts content)
                             ;; `true` would call `write-shape-text`, which requires
                             ;; an active current shape in WASM and can panic during
                             ;; reload pre-processing. We only need fallback font
                             ;; discovery here, so use side-effect free mode.
                             fallback-fonts (fonts-from-text-content content false)]
                         (concat direct-fonts fallback-fonts))))
             (into #{}))]
    (into [] (set (concat payload-fonts object-fonts)))))

(defn- replay-image-resources!
  [image-resources]
  (let [pending
        (into []
              (keep (fn [{:keys [shape-id image-id thumbnail?]}]
                      (when (and (uuid? image-id) (or (nil? shape-id) (uuid? shape-id)))
                        (fetch-image (or shape-id uuid/zero) image-id (boolean thumbnail?)))))
              image-resources)]
    (run-resource-callbacks! pending)))

(defn- wait-next-frame!
  []
  (p/create
   (fn [resolve _reject]
     (timers/raf (fn [] (resolve nil))))))

(defn resize-viewbox
  "Resizes the WASM viewbox. No-ops unless the GL context is live
  (`wasm/live?`), so callers cannot hit `_resize_viewbox` during
  teardown / pre-init after WebGL context loss. Allowed during reload
  once re-init has succeeded."
  [width height]
  (when (wasm/live?)
    (h/call wasm/internal-module "_resize_viewbox" width height)))

(defn set-viewer-viewport!
  "Update viewer zoom/pan and rebuild the tile index (frame hops in the viewer).
  `vbox` must have at least `:x` and `:y` keys (design-space top-left corner)."
  [zoom vbox]
  (when (initialized?)
    (h/call wasm/internal-module "_set_view" zoom (- (:x vbox)) (- (:y vbox)))
    (h/call wasm/internal-module "_set_view_end")
    (reset! view-interaction-active? false)))

(defn- debug-flags
  []
  (cond-> 0
    (dbg/enabled? :wasm-viewbox)
    (bit-or 2r00000000000000000000000000000001)
    (text-editor-wasm?)
    (bit-or 2r00000000000000000000000000000100)
    (contains? cf/flags :render-wasm-info)
    (bit-or 2r00000000000000000000000000001000)
    (not (contains? cf/flags :render-wasm-board-thumbnails))
    (bit-or 2r00000000000000000000000000010000)))

(defn set-render-options!
  "Updates WASM render options with a new DPR value."
  [new-dpr]
  (when (wasm/live?)
    (h/call wasm/internal-module "_set_render_options" (debug-flags) new-dpr)))

(defn resize-offscreen-canvas!
  "Resize a persistent OffscreenCanvas to new physical-pixel dimensions and
  update the WASM render surfaces accordingly (via `_resize_viewbox`). The
  design state (shape pool) is preserved so `set-objects` is not needed again."
  [canvas new-physical-w new-physical-h]
  (when (wasm/live?)
    (let [dpr     (get-dpr)
          [pw ph] (webgl/clamp-physical-size new-physical-w new-physical-h)]
      (set! (.-width canvas) pw)
      (set! (.-height canvas) ph)
      (set-render-options! dpr)
      (resize-viewbox (/ new-physical-w dpr) (/ new-physical-h dpr)))))

(defn resize-canvas!
  "Sizes the canvas drawing buffer, the WASM render surface and the DPR from a
   single source of truth (the canvas CSS client size) so the GL framebuffer
   and the Skia target surface stay the same size. A size mismatch leaves an
   unpainted strip on the top/right edges because the GL framebuffer origin is
   bottom-left, so a smaller Skia surface is anchored to the bottom-left of the
   larger drawing buffer."
  ([canvas]
   (resize-canvas! canvas (get-dpr)))
  ([canvas new-dpr]
   (when (wasm/live?)
     (let [[css-w css-h]   (webgl/canvas-css-size canvas new-dpr)
           css-w           (mth/max 1 css-w)
           css-h           (mth/max 1 css-h)
           [phys-w phys-h] (webgl/clamp-physical-size
                            (mth/floor (* css-w new-dpr))
                            (mth/floor (* css-h new-dpr)))]
       (set! (.-width ^js canvas) phys-w)
       (set! (.-height ^js canvas) phys-h)
       (set-render-options! new-dpr)
       (resize-viewbox css-w css-h)))))

(defn- on-webgl-context-lost
  [event]
  (dom/prevent-default event)
  ;; End any in-flight page transition
  (end-page-transition!)
  (stop-shader-warmup!)
  ;; Keep the last rendered pixels visible while context is lost/recovering.
  (reset! transition-reveal-rulers? false) ; snapshot has rulers baked in
  (start-context-loss-overlay!)
  ;; The renderer will be rebuilt from the file data: drop the stashed pages.
  (page-cache/clear!)
  (when-let [snapshot wasm/canvas-snapshot]
    (reset! transition-image* snapshot))
  (reset! wasm/context-lost? true)
  (st/async-emit!
   (ntf/show {:content (tr "webgl.webgl-context-lost.toast")
              :type :toast
              :level :warning
              :timeout 5000}))
  (st/emit! (drw/context-lost)))

(defn- on-webgl-context-restored
  [event]
  (dom/prevent-default event)
  ;; Keep `context-lost?` / `:render-state :lost` until reload finishes.
  ;; Emitting `context-restored` early flips the UI out of inspect/read-only,
  ;; which can call into WASM while `reload-renderer!` is still between
  ;; `clear-canvas` and re-init (panic). `reloading?` is owned by
  ;; `reload-renderer!`.
  (let [payload (build-reload-payload)]
    (-> (reload-renderer! payload)
        (p/then (fn [_]
                  ;; `init-canvas-context` already cleared the lost atom; emit
                  ;; only after the full reload so layout/viewport sync runs
                  ;; against a live renderer with `wasm/ready?` true.
                  (st/emit! (drw/context-restored))
                  (listen-tiles-render-complete-once! end-context-loss-overlay!)
                  (st/async-emit!
                   (ntf/show {:content (tr "webgl.webgl-context-recovered.toast")
                              :type :toast
                              :level :success
                              :timeout 3000}))))
        (p/catch (fn [cause]
                   (end-context-loss-overlay!)
                   (log/error :hint "wasm reload after context restore failed"
                              :cause cause)
                   nil)))))

;; Stable listener identities, so `removeEventListener` matches across hot reloads
(defonce ^:private webgl-context-lost-listener
  (fn [event] (on-webgl-context-lost event)))

(defonce ^:private webgl-context-restored-listener
  (fn [event] (on-webgl-context-restored event)))

;; The guides and boards last sent by `set-guides`. `_init` starts the engine
;; without guides, so it is reset there.
(defonce ^:private sent-guides* (atom nil))

(defn init-canvas-context
  [canvas]
  (if-not (wasm/module-ready?)
    false
    ;; A failed `init-context` releases the renderer, so clear the flag first.
    (let [_          (set! wasm/context-initialized? false)
          flags      (debug-flags)
          context-id (if (dbg/enabled? :wasm-gl-context-init-error) "fail" "webgl2")
          browser    (sr/translate-browser cf/browser)
          dpr        (get-dpr)
          [css-w css-h] (webgl/canvas-css-size canvas dpr)
          ;; Avoid 0×0 Skia/GL surfaces (crashes on some browsers).
          css-w      (mth/max 1 css-w)
          css-h      (mth/max 1 css-h)
          params     {:antialias_threshold              (wasm-get-numeric-value :antialias_threshold)
                      :viewport_interest_area_threshold (wasm-get-numeric-value :viewport_interest_area_threshold)
                      :max_blocking_time_ms             (wasm-get-numeric-value :max_blocking_time_ms)
                      :node_batch_threshold             (wasm-get-numeric-value :node_batch_threshold)
                      :blur_downscale_threshold         (wasm-get-numeric-value :blur_downscale_threshold)}
          result     (webgl/init-context canvas {:module     wasm/internal-module
                                                 :context-id context-id
                                                 :css-width  css-w
                                                 :css-height css-h
                                                 :dpr        dpr
                                                 :flags      flags
                                                 :browser    browser
                                                 :params     params})
          context-init? (some? result)
          can-listen? (fn? (.-addEventListener ^js canvas))]
      (when result
        (let [{:keys [context handle]} result]
          (set! wasm/gl-context-handle handle)
          (set! wasm/gl-context context)
          (reset! sent-guides* nil)

          ;; `init-context` already ran `_init` through `_set_browser` in
          ;; order. Publish the handles, then mark live before sizing so the
          ;; guarded `resize-*` helpers can run (they require `wasm/live?`,
          ;; which is true here even while `reloading?` still blocks app callers).
          (set! wasm/canvas canvas)
          ;; Add event listeners for WebGL context lost
          (when can-listen?
            (.addEventListener canvas "webglcontextlost" webgl-context-lost-listener)
            (.addEventListener canvas "webglcontextrestored" webgl-context-restored-listener))
          (start-canvas-snapshot-listener!)
          (start-shader-warmup-listener!)
          (reset! wasm/context-lost? false)
          (set! wasm/context-initialized? true)

          ;; DOM canvas: keep drawing buffer synced to CSS size.
          ;; OffscreenCanvas: no CSS size, so only sync WASM viewbox.
          (if (and (number? (.-clientWidth ^js canvas))
                   (pos? (.-clientWidth ^js canvas)))
            (resize-canvas! canvas dpr)
            (resize-viewbox css-w css-h))))

      context-init?)))

(defn clear-canvas
  ([]
   (clear-canvas {}))
  ([{:keys [lose-browser-context? stash-page?]
     :or {lose-browser-context? true
          stash-page? false}}]
   (try
     ;; Keep (page switch) or forget the shapes of the page on screen, before
     ;; `_clean_up` drops them.
     (stash-resident-page! stash-page?)
     ;; Stop the upload that may still run: its chunks would go to a renderer
     ;; that is being torn down.
     (page-cache/invalidate-loads!)

     ;; Release GPU objects while the context is still current.
     (free-gpu-resources)

     (set! wasm/context-initialized? false)

     (stop-progressive-render!)

     ;; Reset remaining render flags so teardown cannot schedule work.
     (reset! shapes-loading? false)
     (reset! deferred-render? false)
     (reset! view-interaction-active? false)

     ;; Remove listener before losing/deleting context.
     (when wasm/canvas
       (.removeEventListener wasm/canvas "webglcontextlost" webgl-context-lost-listener)
       (.removeEventListener wasm/canvas "webglcontextrestored" webgl-context-restored-listener))
     (stop-canvas-snapshot-listener!)
     (stop-shader-warmup!)

     (when (wasm/module-ready?)
       (h/call wasm/internal-module "_clean_up"))

     ;; Ensure the WebGL context is properly disposed so browsers do not keep
     ;; accumulating active contexts between page switches.
     (when-let [handle wasm/gl-context-handle]
       (try
         ;; For hard teardown we can explicitly lose browser context.
         ;; For reload->reinit flows we skip this because immediate context
         ;; recreation may fail on some browsers/GPUs while context is lost.
         (when lose-browser-context?
           (when-let [ctx wasm/gl-context]
             (when-let [lose-ext (.getExtension ^js ctx "WEBGL_lose_context")]
               (.loseContext ^js lose-ext))))
         (webgl/delete-context! wasm/internal-module handle)
         (catch :default dispose-error
           (.error js/console dispose-error))))

     (wasm-gesture/reset-after-wasm-reload!)
     (wasm/reset-context-state!)
     true

     ;; If this panics we don't want to crash. This happens sometimes with
     ;; hot-reload in development.
     (catch :default error
       (.error js/console error)
       (wasm-gesture/reset-after-wasm-reload!)
       (wasm/reset-context-state!)
       false))))

(defn reload-renderer!
  [{:keys [canvas
           base-objects
           page-id
           zoom
           vbox
           fonts
           image-resources
           background
           background-opacity
           on-render
           on-shapes-ready
           force-sync]
    :or {fonts []
         image-resources []
         background-opacity 1
         force-sync false}
    :as payload}]
  (ug/dispatch! (ug/event "penpot:wasm:reload-start"))
  (reset! wasm/reloading? true)
  ;; A reload rebuilds the renderer from the file data: drop the stashed pages.
  (page-cache/clear!)
  (let [fonts (derive-font-resources base-objects fonts)]
    (-> (p/resolved nil)
        ;; Keep teardown strict (`_clean_up` + deleteContext) but do not
        ;; force `loseContext` because we immediately create a new context.
        (p/then (fn [_]
                  (let [was-cleared? (clear-canvas {:lose-browser-context? false})]
                    (when-not was-cleared?
                      (ex/raise :type :wasm-error
                                :code :wasm-reload-context-failure
                                :hint "WASM renderer cleanup failed")))))
        ;; Give browser a frame to settle context deletion before init.
        (p/then (fn [_] (wait-next-frame!)))
        (p/then (fn [_]
                  (let [context-ready? (init-canvas-context canvas)]
                    (when-not context-ready?
                      (ex/raise :type :wasm-error
                                :code :wasm-reload-context-failure
                                :hint "WASM renderer could not create a new WebGL context"))
                    ;; Gesture bookkeeping (`modifiers.cljs`) uses compare-and-set on an atom
                    ;; that survives WASM teardown; reset so it matches fresh `_init` state.
                    (wasm-gesture/reset-after-wasm-reload!))))
        ;; Ensure render surfaces are blank before replay to avoid overpainting.
        (p/then (fn [_] (h/call wasm/internal-module "_reset_canvas")))
        (p/then (fn [_] (replay-font-resources! fonts)))
        (p/then (fn [_] (replay-image-resources! image-resources)))
        (p/then
         (fn []
           ;; The page id only names the page in the
           ;; `penpot:wasm:set-objects` event: the page cache was cleared
           ;; above, so the reloaded page is not made resident.
           (initialize-viewport base-objects zoom vbox
                                :background background
                                :background-opacity background-opacity
                                :on-render on-render
                                :on-shapes-ready on-shapes-ready
                                :force-sync force-sync
                                :page-id page-id
                                :page-cache? false)
           (sync-rulers-to-wasm! (rulers-state/from-store @st/state))
           (request-render "reload-renderer")
           (ug/dispatch! (ug/event "penpot:wasm:reload-complete"))
           (reset! wasm/reloading? false)
           payload))
        (p/catch
         (fn [cause]
           (ug/dispatch! (ug/event "penpot:wasm:reload-failed"))
           (reset! wasm/reloading? false)
           (reset! wasm/context-lost? true)
           (clear-canvas)
           (p/rejected cause))))))

(defn show-grid
  [id]
  (when (initialized?)
    (let [buffer (uuid/get-u32 id)]
      (h/call wasm/internal-module "_show_grid"
              (aget buffer 0)
              (aget buffer 1)
              (aget buffer 2)
              (aget buffer 3)))
    (request-render "show-grid")))

(defn set-rulers-visible!
  [visible?]
  (when (wasm/live?)
    (h/call wasm/internal-module "_set_rulers_visible" (if visible? 1 0))))

(defn set-rulers-frame-visible!
  [visible?]
  (when (wasm/live?)
    (h/call wasm/internal-module "_set_rulers_frame_visible" (if visible? 1 0))))

(defn set-rulers-offsets!
  [offset-x offset-y]
  (when (wasm/live?)
    (h/call wasm/internal-module "_set_rulers_offsets"
            (or offset-x 0) (or offset-y 0))))

(defn set-rulers-selection!
  [rect]
  (when (wasm/live?)
    (if (some? rect)
      (h/call wasm/internal-module "_set_rulers_selection" 1
              (or (:x rect) 0) (or (:y rect) 0)
              (or (:width rect) 0) (or (:height rect) 0))
      (h/call wasm/internal-module "_set_rulers_selection" 0 0 0 0 0))))

(defn set-rulers-colors!
  "Push ruler chrome / accent colors as ARGB u32. Inputs are hex strings
   (e.g. \"#181818\"); call once on theme change."
  [bg-hex border-hex label-hex accent-hex]
  (when (wasm/live?)
    (h/call wasm/internal-module "_set_rulers_colors"
            (sr-clr/hex->u32argb bg-hex 1)
            (sr-clr/hex->u32argb border-hex 1)
            (sr-clr/hex->u32argb label-hex 1)
            (sr-clr/hex->u32argb accent-hex 1))))

(defn clear-grid
  []
  (when (initialized?)
    (h/call wasm/internal-module "_hide_grid")
    (request-render "clear-grid")))

;; Ruler guides ----------------------------------------------------------------

(defn set-guides
  "Serializes the page guides and sends them to the render engine.
  `guides` is the page `:guides` map (id -> guide); `objects` is the page
  objects map, used to resolve each guide's board clip range.

  Does nothing when the guides and their boards are the ones sent last: the
  viewport calls it on every change of the page objects, and the engine
  presents a frame for each call."
  [guides objects]
  (when (initialized?)
    (let [sent [guides (mapv #(get objects (:frame-id %)) (vals guides))]]
      (when-not (= sent @sent-guides*)
        (let [size    (sr/get-guides-byte-size guides)
              offset  (mem/alloc->offset-32 size)
              heapu32 (mem/get-heap-u32)
              heapf32 (mem/get-heap-f32)]
          (sr/write-guides guides objects heapu32 heapf32 offset)
          (h/call wasm/internal-module "_set_guides")
          (reset! sent-guides* sent)
          (request-render "set-guides"))))))

;; Screen-space hit tolerance for ruler guides. Must match
;; `guide-active-area` in `app.main.ui.workspace.viewport.guides`.
(def ^:private guide-active-area 16)

(defn find-guide-at
  "Returns the serialized guide index at `position` (viewport coordinates),
  or -1 when no guide is within the hit tolerance."
  [position zoom]
  (if (initialized?)
    (h/call wasm/internal-module "_find_guide_at"
            (:x position)
            (:y position)
            zoom
            guide-active-area)
    -1))

(defn get-grid-coords
  [position]
  (when (initialized?)
    (let [offset  (h/call wasm/internal-module
                          "_get_grid_coords"
                          (get position :x)
                          (get position :y))
          heapi32 (mem/get-heap-i32)
          row     (aget heapi32 (mem/->offset-32 (+ offset 0)))
          column  (aget heapi32 (mem/->offset-32 (+ offset 4)))]
      (mem/free)
      [row column])))

(defn shape-to-path
  [id]
  (when (initialized?)
    (wselect/use-shape id)
    (try
      (let [offset (-> (h/call wasm/internal-module "_current_to_path")
                       (mem/->offset-32))
            heap   (mem/get-heap-u32)
            length (aget heap offset)
            data   (mem/slice heap
                              (+ offset 1)
                              (* length path.impl/SEGMENT-U32-SIZE))
            content (path/from-bytes data)]
        (mem/free)
        content)
      (catch :default cause
        (mem/free)
        (throw cause)))))

(defn stroke-to-path
  "Converts a shape's stroke at the given index into a filled path.
   Returns a map {:content <PathData> :even-odd? <boolean>}, or nil when the
   stroke produces no geometry. The buffer carries two header words ahead of
   the segments: [even-odd flag][length] (the flat segment list can't encode
   the fill rule itself)."
  [id stroke-index]
  (when (initialized?)
    (wselect/use-shape id)
    (try
      (let [offset    (-> (h/call wasm/internal-module "_convert_stroke_to_path" stroke-index)
                          (mem/->offset-32))
            heap      (mem/get-heap-u32)
            even-odd? (not (zero? (aget heap offset)))
            length    (aget heap (inc offset))]
        (if (pos? length)
          (let [data    (mem/slice heap
                                   (+ offset 2)
                                   (* length path.impl/SEGMENT-U32-SIZE))
                content (path/from-bytes data)]
            (mem/free)
            {:content content :even-odd? even-odd?})
          (do (mem/free)
              nil)))
      (catch :default cause
        (mem/free)
        (throw cause)))))

(defn calculate-bool*
  [bool-type ids]
  (let [size   (mem/get-alloc-size ids UUID-U8-SIZE)
        offset (mem/alloc->offset-32 size)
        heap   (mem/get-heap-u32)]

    (reduce (fn [offset id]
              (mem.h32/write-uuid offset heap id))
            offset
            (rseq ids))

    (try
      (let [offset
            (-> (h/call wasm/internal-module "_calculate_bool" (sr/translate-bool-type bool-type))
                (mem/->offset-32))

            ;; The call above may have grown the memory: take a fresh view.
            heap    (mem/get-heap-u32)
            length  (aget heap offset)
            data    (mem/slice heap
                               (+ offset 1)
                               (* length path.impl/SEGMENT-U32-SIZE))
            content (path/from-bytes data)]
        (mem/free)
        content)
      (catch :default cause
        (mem/free)
        (throw cause)))))

(defn calculate-bool
  "WASM implementation of `path/calc-bool-content`.

  It must always return content: the result is stored as the bool shape's `:content`
  and persisted as a file change, so returning `nil` would destroy the path.
  When the render context is unusable, we fall back to the pure CLJS calculation,
  which needs no render context."
  [shape objects]

  ;; We need to be able to calculate the boolean data but we cannot
  ;; depend on the serialization flow.
  ;; start_temp_object / end_temp_object create a new shapes_pool
  ;; temporary and then we serialize the objects needed to calculate the
  ;; boolean object.
  ;; After the content is returned we discard that temporary context
  (if-not (initialized?)
    (path/calc-bool-content shape objects)
    (do
      (h/call wasm/internal-module "_start_temp_objects")

      (try
        (let [bool-type (get shape :bool-type)
              ids (get shape :shapes)
              all-children
              (->> ids
                   (mapcat #(cfh/get-children-with-self objects %)))]

          (h/call wasm/internal-module "_init_shapes_pool" (count all-children))
          (run! set-object all-children)

          (-> (calculate-bool* bool-type ids)
              (path.impl/path-data)))
        (finally
          ;; Always restore the main shapes pool: leaving the temp pool
          ;; active would make the next `_start_temp_objects` panic.
          (h/call wasm/internal-module "_end_temp_objects"))))))

(def POSITION-DATA-U8-SIZE 36)
(def POSITION-DATA-U32-SIZE (/ POSITION-DATA-U8-SIZE 4))

(defn calculate-position-data
  [shape]
  (when (initialized?)
    (wselect/use-shape (:id shape))
    (let [offset (-> (h/call wasm/internal-module "_calculate_position_data")
                     (mem/->offset-32))
          ;; Take the views after the call: it may have grown the memory.
          heapf32 (mem/get-heap-f32)
          heapu32 (mem/get-heap-u32)
          length (aget heapu32 offset)

          max-offset (+ offset 1 (* length POSITION-DATA-U32-SIZE))

          result
          (loop [result (transient [])
                 offset (inc offset)]
            (if (< offset max-offset)
              (let [entry (dr/read-position-data-entry heapu32 heapf32 offset)]
                (recur (conj! result entry)
                       (+ offset POSITION-DATA-U32-SIZE)))
              (persistent! result)))

          content (:content shape)]

      (mem/free)

      (into []
            (keep
             (fn [{:keys [paragraph span start-pos end-pos direction x y width height]}]
               (let [element (-> content :children
                                 (get 0) :children ;; paragraph-set
                                 (get paragraph) :children ;; paragraph
                                 (get span))
                     element-text (:text element)]

                 ;; Add comprehensive nil-safety checks
                 ;; Be aware that for RTL texts `start-pos` can be greatert han `end-pos`
                 (when (and element element-text)
                   (let [text (subs element-text start-pos end-pos)]
                     (d/patch-object
                      (txt/get-default-text-attrs)
                      (d/without-nils
                       {:x x
                        :y (+ y height)
                        :width width
                        :height height
                        :direction       (dr/translate-direction direction)
                        :font-id         (get element :font-id)
                        :font-family     (get element :font-family)
                        :font-size       (dm/str (get element :font-size) "px")
                        :font-weight     (get element :font-weight)
                        :text-transform  (get element :text-transform)
                        :text-decoration (get element :text-decoration)
                        :letter-spacing  (dm/str (get element :letter-spacing) "px")
                        :font-style      (get element :font-style)
                        :fills           (get element :fills)
                        :text            text})))))))
            result))))

(defn apply-canvas-blur
  []
  (reset! transition-reveal-rulers? false) ; snapshot has rulers baked in
  (let [already? @page-transition?]
    (begin-page-transition!)
    ;; The tiles-complete → end handler is armed later, once the target page's
    ;; shapes are loaded (see `arm-page-transition-end!`), so a frame rendered
    ;; before the new page is drawn can't dismiss the blur prematurely.
    ;;
    ;; Lock the snapshot for the whole transition: if the user clicks to another page
    ;; while the transition is active, keep showing the original page snapshot until
    ;; the final target page finishes rendering. The caller (sitemap on-click) is
    ;; responsible for ensuring `wasm/canvas-snapshot` was freshly captured
    ;; before invoking us.
    (when-not already?
      (when-let [snapshot wasm/canvas-snapshot]
        (reset! transition-image* snapshot)))))

(defn- read-raster-result
  "Decode `[len][width][height][bytes]` from a `_render_shape_*` raster call."
  [offset]
  (let [heap (mem/get-heap-u8)
        heapu32 (mem/get-heap-u32)
        length (aget heapu32 (mem/->offset-32 offset))
        result (dr/read-image-bytes heap (+ offset 12) length)]
    (mem/free)
    result))

(defn render-shape-pixels
  "Renders a shape subtree to encoded image bytes on the GPU export surface.
  `format` is :png, :jpeg or :webp; jpeg is flattened onto white on the Rust
  side, since it has no alpha channel."
  [shape-id scale format]
  (when (initialized?)
    (let [buffer (uuid/get-u32 shape-id)
          offset (h/call wasm/internal-module "_render_shape_pixels"
                         (aget buffer 0)
                         (aget buffer 1)
                         (aget buffer 2)
                         (aget buffer 3)
                         scale
                         (sr/translate-raster-format format))]
      (read-raster-result offset))))

(defn render-shape-raster
  "Same output as `render-shape-pixels`, but on a CPU Skia surface (no
  GPU/WebGL). Used when the export exceeds the GPU max texture size — the
  same path the headless exporter uses for wasm rasters."
  [shape-id scale format]
  (when (initialized?)
    (let [buffer (uuid/get-u32 shape-id)
          offset (h/call wasm/internal-module "_render_shape_raster"
                         (aget buffer 0)
                         (aget buffer 1)
                         (aget buffer 2)
                         (aget buffer 3)
                         scale
                         (sr/translate-raster-format format))]
      (read-raster-result offset))))

(defn get-shape-extrect
  [shape-id]
  (when (initialized?)
    (let [buffer (uuid/get-u32 shape-id)
          offset (h/call wasm/internal-module "_get_shape_extrect"
                         (aget buffer 0)
                         (aget buffer 1)
                         (aget buffer 2)
                         (aget buffer 3))]
      (when (and (number? offset) (pos? offset))
        (let [heapf32 (mem/get-heap-f32)
              base    (mem/->offset-32 offset)
              x       (aget heapf32 base)
              y       (aget heapf32 (+ base 1))
              w       (aget heapf32 (+ base 2))
              h       (aget heapf32 (+ base 3))]
          (mem/free)
          {:x x :y y :width w :height h})))))

(defn export-target
  [shape-id scale format]
  (when (initialized?)
    (let [buffer (uuid/get-u32 shape-id)]
      (case (h/call wasm/internal-module "_export_target"
                    (aget buffer 0)
                    (aget buffer 1)
                    (aget buffer 2)
                    (aget buffer 3)
                    scale
                    (sr/translate-raster-format format))
        0 :client
        2 :too-large
        :exporter))))

(defn render-shape-pdf
  [shape-id]
  (when (initialized?)
    (let [buffer (uuid/get-u32 shape-id)

          offset
          (h/call wasm/internal-module "_render_shape_pdf"
                  (aget buffer 0)
                  (aget buffer 1)
                  (aget buffer 2)
                  (aget buffer 3))

          heap (mem/get-heap-u8)
          heapu32 (mem/get-heap-u32)
          length (aget heapu32 (mem/->offset-32 offset))
          result (dr/read-image-bytes heap (+ offset 4) length)]
      (mem/free)
      result)))

(defn render-shapes-pdf
  "Renders each shape id as a page of one PDF. IDs are written to the
  transfer buffer (same layout as `set-focus-mode`) before the call."
  [shape-ids]
  (when (and (initialized?) (seq shape-ids))
    (let [ids    (vec shape-ids)
          size   (mem/get-alloc-size ids UUID-U8-SIZE)
          offset (mem/alloc->offset-32 size)
          heap   (mem/get-heap-u32)

          _ (reduce (fn [offset id]
                      (mem.h32/write-uuid offset heap id))
                    offset
                    ids)

          result-offset
          (h/call wasm/internal-module "_render_shapes_pdf")

          heapu8  (mem/get-heap-u8)
          heapu32 (mem/get-heap-u32)
          length  (aget heapu32 (mem/->offset-32 result-offset))
          result  (dr/read-image-bytes heapu8 (+ result-offset 4) length)]
      (mem/free)
      result)))

(defn pdf-export-begin!
  "Opens a progressive multi-page PDF session."
  []
  (when (initialized?)
    (h/call wasm/internal-module "_pdf_export_begin")))

(defn pdf-export-add-page!
  "Appends `shape-id` as the next page of the current PDF session."
  [shape-id]
  (when (initialized?)
    (let [buffer (uuid/get-u32 shape-id)]
      (h/call wasm/internal-module "_pdf_export_add_page"
              (aget buffer 0)
              (aget buffer 1)
              (aget buffer 2)
              (aget buffer 3)))))

(defn pdf-export-finish
  "Closes the PDF session and returns the encoded PDF bytes."
  []
  (when (initialized?)
    (let [offset  (h/call wasm/internal-module "_pdf_export_finish")
          heapu8  (mem/get-heap-u8)
          heapu32 (mem/get-heap-u32)
          length  (aget heapu32 (mem/->offset-32 offset))
          result  (dr/read-image-bytes heapu8 (+ offset 4) length)]
      (mem/free)
      result)))

(defn pdf-export-abort!
  "Drops an in-flight PDF session without returning bytes."
  []
  (when (initialized?)
    (h/call wasm/internal-module "_pdf_export_abort")))

(defn render-shape-svg
  [shape-id scale]
  (when (initialized?)
    (let [buffer (uuid/get-u32 shape-id)
          offset
          (h/call wasm/internal-module "_render_shape_svg"
                  (aget buffer 0)
                  (aget buffer 1)
                  (aget buffer 2)
                  (aget buffer 3)
                  scale)

          heap (mem/get-heap-u8)
          heapu32 (mem/get-heap-u32)
          length (aget heapu32 (mem/->offset-32 offset))
          result (dr/read-image-bytes heap (+ offset 4) length)]
      (mem/free)
      result)))

(defn render-shapes-svg
  "Renders the given shape ids into one SVG document (joined viewBox).
  IDs are written to the transfer buffer (same layout as `render-shapes-pdf`)."
  [shape-ids scale]
  (when (and (initialized?) (seq shape-ids))
    (let [ids    (vec shape-ids)
          size   (mem/get-alloc-size ids UUID-U8-SIZE)
          offset (mem/alloc->offset-32 size)
          heap   (mem/get-heap-u32)

          _ (reduce (fn [offset id]
                      (mem.h32/write-uuid offset heap id))
                    offset
                    ids)

          result-offset
          (h/call wasm/internal-module "_render_shapes_svg" scale)

          heapu8  (mem/get-heap-u8)
          heapu32 (mem/get-heap-u32)
          length  (aget heapu32 (mem/->offset-32 result-offset))
          result  (dr/read-image-bytes heapu8 (+ result-offset 4) length)]
      (mem/free)
      result)))

(defn get-render-counters
  "Reads the per-render-cycle counters exported by `get_render_counters`.
  Returns nil when the renderer is not initialized."
  []
  (when (initialized?)
    (let [offset (h/call wasm/internal-module "_get_render_counters")
          dview  (mem/get-data-view)
          u32    (fn [index] (.getUint32 dview (+ offset (* 4 index)) true))
          result {:tiles-rendered          (u32 0)
                  :tiles-from-cache        (u32 1)
                  :node-visits             (u32 2)
                  :shapes-drawn            (u32 3)
                  :save-layers             (u32 4)
                  :partial-frames          (u32 5)
                  :full-frames             (u32 6)
                  :render-from-cache-calls (u32 7)
                  :walk-ms                 (.getFloat64 dview (+ offset 32) true)
                  :imposters-drawn         (u32 10)
                  :imposters-built         (u32 11)
                  :culled-leaves           (u32 12)
                  :partial-tiles           (u32 13)}]
      (mem/free)
      result)))

;; Benchmark hook: `window.penpotRenderCounters()` returns the counters as a
;; plain object. Only installed with the `render-wasm-counters` flag.
(when (and (exists? js/window)
           (contains? cf/flags :render-wasm-counters))
  (unchecked-set js/window "penpotRenderCounters"
                 (fn [] (clj->js (get-render-counters)))))

(defn init-wasm-module
  [module]
  (let [default-fn (unchecked-get module "default")
        href       (cf/resolve-href "js/render-wasm.wasm")]
    (default-fn #js {:locateFile (constantly href)})))

(defonce module
  (delay
    (if (exists? js/dynamicImport)
      (let [uri (cf/resolve-href "js/render-wasm.js")]
        (->> (mod/import uri)
             (p/mcat init-wasm-module)
             (p/fmap
              (fn [default]
                (set! wasm/internal-module default)
                (try
                  (page-cache/apply-device-limits!)
                  (catch :default cause
                    (log/error :hint "could not set the page cache limits"
                               :cause cause)))
                true))
             (p/merr
              (fn [cause]
                (js/console.error cause)
                (p/resolved false)))))
      (p/resolved false))))

(defn preload-module!
  "Starts downloading + compiling the WASM engine now instead of on first
   viewport mount. Idempotent: the `delay` caches its in-flight promise."
  []
  @module)


