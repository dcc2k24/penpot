;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.shapes.custom-stroke
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.geom.rect :as grc]
   [app.common.geom.shapes :as gsh]
   [app.common.geom.shapes.bounds :as gsb]
   [app.common.geom.shapes.text :as gst]
   [app.common.types.path :as path]
   [app.common.types.shape.radius :as ctsr]
   [app.common.types.stroke :as cts]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.ui.context :as muc]
   [app.main.ui.shapes.attrs :as attrs]
   [app.main.ui.shapes.embed :as embed]
   [app.main.ui.shapes.gradients :as grad]
   [app.util.object :as obj]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

;; FIXME: this clearly should be renamed to something different, this
;; namespace has also fill related code

(mf/defc inner-stroke-clip-path
  {::mf/wrap-props false}
  [{:keys [shape render-id index]}]
  (let [shape-id (dm/get-prop shape :id)
        suffix   (if (some? index) (dm/str "-" index) "")
        clip-id  (dm/str "inner-stroke-" render-id "-" shape-id suffix)
        href     (dm/str "#stroke-shape-" render-id "-" shape-id suffix)]
    [:> "clipPath" {:id clip-id}
     [:use {:href href}]]))

(mf/defc outer-stroke-mask
  {::mf/wrap-props false}
  [{:keys [shape stroke render-id index]}]
  (let [shape-id       (dm/get-prop shape :id)
        suffix         (if (some? index) (dm/str "-" index) "")
        mask-id        (dm/str "outer-stroke-" render-id "-" shape-id suffix)
        shape-id       (dm/str "stroke-shape-" render-id "-" shape-id suffix)
        href           (dm/str "#" shape-id)

        stroke-width   (case (:stroke-alignment stroke :center)
                         :center (/ (:stroke-width stroke 0) 2)
                         :outer (:stroke-width stroke 0)
                         0)
        stroke-margin  (gsb/shape-stroke-margin shape stroke-width)

        ;; NOTE: for performance reasons we may can delimit a bit the
        ;; dependencies to really useful shape attrs instead of using
        ;; the shepe as-is.
        selrect       (mf/with-memo [shape]
                        (if (cfh/text-shape? shape)
                          (gst/shape->rect shape)
                          (grc/points->rect (:points shape))))

        x             (- (dm/get-prop selrect :x) stroke-margin)
        y             (- (dm/get-prop selrect :y) stroke-margin)
        w             (+ (dm/get-prop selrect :width) (* 2 stroke-margin))
        h             (+ (dm/get-prop selrect :height) (* 2 stroke-margin))]

    [:mask {:id mask-id
            :x x
            :y y
            :width w
            :height h
            :maskUnits "userSpaceOnUse"}
     [:use
      {:href href
       :style {:fill "none"
               :stroke "white"
               :strokeWidth (* stroke-width 2)}}]

     [:use
      {:href href
       :style {:fill "black"
               :stroke "none"}}]]))

(mf/defc cap-markers
  {::mf/wrap-props false}
  [{:keys [stroke render-id index]}]
  (let [id-prefix (dm/str "marker-" render-id)

        gradient  (:stroke-color-gradient stroke)
        image     (:stroke-image stroke)
        cap-start (:stroke-cap-start stroke)
        cap-end   (:stroke-cap-end stroke)

        color     (cond
                    (some? gradient)
                    (str/ffmt "url(#stroke-color-gradient-%-%)" render-id index)

                    (some? image)
                    (str/ffmt "url(#stroke-fill-%-%)" render-id index)

                    :else
                    (:stroke-color stroke))

        opacity   (when-not (some? gradient)
                    (:stroke-opacity stroke))]

    [:*
     (when (or (= cap-start :line-arrow)
               (= cap-end :line-arrow))
       [:marker {:id (dm/str id-prefix "-line-arrow")
                 :viewBox "0 0 3 6"
                 :refX "2"
                 :refY "3"
                 :markerWidth "8.5"
                 :markerHeight "8.5"
                 :orient "auto-start-reverse"
                 :fill color
                 :fillOpacity opacity}
        [:path {:d "M 0.5 0.5 L 3 3 L 0.5 5.5 L 0 5 L 2 3 L 0 1 z"}]])

     (when (or (= cap-start :triangle-arrow)
               (= cap-end :triangle-arrow))
       [:marker {:id (dm/str id-prefix "-triangle-arrow")
                 :viewBox "0 0 3 6"
                 :refX "2"
                 :refY "3"
                 :markerWidth "8.5"
                 :markerHeight "8.5"
                 :orient "auto-start-reverse"
                 :fill color
                 :fillOpacity opacity}
        [:path {:d "M 0 0 L 3 3 L 0 6 z"}]])

     (when (or (= cap-start :square-marker)
               (= cap-end :square-marker))
       [:marker {:id (dm/str id-prefix "-square-marker")
                 :viewBox "0 0 6 6"
                 :refX "3"
                 :refY "3"
                 :markerWidth "4.2426" ;; diagonal length of a 3x3 square
                 :markerHeight "4.2426"
                 :orient "auto-start-reverse"
                 :fill color
                 :fillOpacity opacity}
        [:rect {:x 0 :y 0 :width 6 :height 6}]])

     (when (or (= cap-start :circle-marker)
               (= cap-end :circle-marker))
       [:marker {:id (dm/str id-prefix "-circle-marker")
                 :viewBox "0 0 6 6"
                 :refX "3"
                 :refY "3"
                 :markerWidth "4"
                 :markerHeight "4"
                 :orient "auto-start-reverse"
                 :fill color
                 :fillOpacity opacity}
        [:circle {:cx "3" :cy "3" :r "3"}]])

     (when (or (= cap-start :diamond-marker)
               (= cap-end :diamond-marker))
       [:marker {:id (dm/str id-prefix "-diamond-marker")
                 :viewBox "0 0 6 6"
                 :refX "3"
                 :refY "3"
                 :markerWidth "6"
                 :markerHeight "6"
                 :orient "auto-start-reverse"
                 :fill color
                 :fillOpacity opacity}
        [:path {:d "M 3 0 L 6 3 L 3 6 L 0 3 z"}]])

     ;; If the user wants line caps but different in each end,
     ;; simulate it with markers.
     (when (and (or (= cap-start :round)
                    (= cap-end :round))
                (not= cap-start cap-end))
       [:marker {:id (dm/str id-prefix "-round")
                 :viewBox "0 0 6 6"
                 :refX "3"
                 :refY "3"
                 :markerWidth "6"
                 :markerHeight "6"
                 :orient "auto-start-reverse"
                 :fill color
                 :fillOpacity opacity}
        [:path {:d "M 3 2.5 A 0.5 0.5 0 0 1 3 3.5 "}]])

     (when (and (or (= cap-start :square)
                    (= cap-end :square))
                (not= cap-start cap-end))
       [:marker {:id (dm/str id-prefix "-square")
                 :viewBox "0 0 6 6"
                 :refX "3"
                 :refY "3"
                 :markerWidth "6"
                 :markerHeight "6"
                 :orient "auto-start-reverse"
                 :fill color
                 :fillOpacity opacity}
        [:rect {:x 3 :y 2.5 :width 0.5 :height 1}]])]))

(mf/defc stroke-defs
  {::mf/wrap-props false}
  [{:keys [shape stroke render-id index]}]
  (let [open-path?    (and ^boolean (cfh/path-shape? shape)
                           ^boolean (path/shape-with-open-path? shape))
        gradient      (:stroke-color-gradient stroke)
        alignment     (:stroke-alignment stroke :center)
        width         (:stroke-width stroke 0)

        props         #js {:id (dm/str "stroke-color-gradient-" render-id "-" index)
                           :gradient gradient
                           :shape shape
                           :force-transform (cfh/path-shape? shape)}
        stroke-image  (:stroke-image stroke)
        uri           (when stroke-image (cf/resolve-file-media stroke-image))
        embed         (embed/use-data-uris [uri])

        stroke-width  (case (:stroke-alignment stroke :center)
                        :center (/ (:stroke-width stroke 0) 2)
                        :outer (:stroke-width stroke 0)
                        0)
        margin        (gsb/shape-stroke-margin stroke stroke-width)

        selrect       (mf/with-memo [shape]
                        (if (cfh/text-shape? shape)
                          (gst/shape->rect shape)
                          (grc/points->rect (:points shape))))

        stroke-margin (+ stroke-width margin)

        w             (+ (dm/get-prop selrect :width) (* 2 stroke-margin))
        h             (+ (dm/get-prop selrect :height) (* 2 stroke-margin))
        image-props   #js {:href (get embed uri uri)
                           :preserveAspectRatio "xMidYMid slice"
                           :width 1
                           :height 1
                           :id (dm/str "stroke-image-" render-id "-" index)}]
    [:*
     (when (some? gradient)
       (case (:type gradient)
         :linear [:> grad/linear-gradient props]
         :radial [:> grad/radial-gradient props]))

     (when (:stroke-image stroke)
       ;; We need to make the pattern size and the image fit so it's not repeated
       [:pattern {:id (dm/str "stroke-fill-" render-id "-" index)
                  :patternContentUnits "objectBoundingBox"
                  :x (- (/ stroke-margin (dm/get-prop selrect :width)))
                  :y (- (/ stroke-margin (dm/get-prop selrect :height)))
                  :width (/ w (dm/get-prop selrect :width))
                  :height (/ h (dm/get-prop selrect :height))
                  :viewBox "0 0 1 1"
                  :preserveAspectRatio "xMidYMid slice"
                  :patternTransform (when (cfh/path-shape? shape) (gsh/transform-str shape))}
        [:> :image image-props]])

     (cond
       (and (not open-path?)
            (= :inner alignment)
            (> width 0))
       [:& inner-stroke-clip-path {:shape shape
                                   :render-id render-id
                                   :index index}]

       (and (not open-path?)
            (= :outer alignment)
            (> width 0))
       [:& outer-stroke-mask {:shape shape
                              :stroke stroke
                              :render-id render-id
                              :index index}]

       (or (some? (:stroke-cap-start stroke))
           (some? (:stroke-cap-end stroke)))
       [:& cap-markers {:stroke stroke
                        :render-id render-id
                        :index index}])]))

;; Outer alignment: display the shape in two layers. One without
;; stroke (only fill), and another one only with stroke at double
;; width (transparent fill) and passed through a mask that shows the
;; whole shape, but hides the original shape without stroke

(mf/defc outer-stroke
  {::mf/wrap-props false}
  [{:keys [children shape stroke index]}]
  (let [shape-id     (dm/get-prop shape :id)
        render-id    (mf/use-ctx muc/render-id)

        props        (obj/get children "props")
        style        (obj/get props "style")

        stroke-width (:stroke-width stroke 0)

        suffix       (if (some? index) (dm/str "-" index) "")
        mask-id      (dm/str "outer-stroke-" render-id "-" shape-id suffix)
        shape-id     (dm/str "stroke-shape-" render-id "-" shape-id suffix)
        href         (dm/str "#" shape-id)]

    [:g.outer-stroke-shape
     [:defs
      [:& stroke-defs {:shape shape :stroke stroke :render-id render-id :index index}]
      (let [type  (obj/get children "type")
            style (-> (obj/clone style)
                      (obj/unset! "fill")
                      (obj/unset! "fillOpacity")
                      (obj/unset! "stroke")
                      (obj/unset! "strokeWidth")
                      (obj/unset! "strokeOpacity")
                      (obj/unset! "strokeStyle")
                      (obj/unset! "strokeDasharray"))
            props (-> (obj/clone props)
                      (obj/set! "id" shape-id)
                      (obj/set! "style" style))]

        [:> type props])]

     [:use {:href href
            :mask (dm/str "url(#" mask-id ")")
            :style (-> (obj/clone style)
                       (obj/set! "strokeWidth" (* stroke-width 2))
                       (obj/set! "fill" "none")
                       (obj/unset! "fillOpacity"))}]

     [:use {:href href
            :style (-> (obj/clone style)
                       (obj/set! "stroke" "none"))}]]))


;; Inner alignment: display the shape with double width stroke, and
;; clip the result with the original shape without stroke.

(mf/defc inner-stroke
  {::mf/wrap-props false}
  [props]
  (let [child        (unchecked-get props "children")
        shape        (unchecked-get props "shape")
        stroke       (unchecked-get props "stroke")
        index        (unchecked-get props "index")

        shape-id     (dm/get-prop shape :id)
        render-id    (mf/use-ctx muc/render-id)

        type         (obj/get child "type")

        props        (-> (obj/get child "props") obj/clone)
        ;; FIXME: check if style need to be cloned
        style        (-> (obj/get props "style") obj/clone)
        transform    (obj/get props "transform")

        stroke-width (:stroke-width stroke 0)

        suffix       (if (some? index) (dm/str "-" index) "")
        clip-id      (dm/str "inner-stroke-" render-id "-" shape-id suffix)
        shape-id     (dm/str "stroke-shape-" render-id "-" shape-id suffix)
        clip-path    (dm/str "url('#" clip-id "')")

        style        (obj/set! style "strokeWidth" (* stroke-width 2))

        props        (-> props
                         (obj/set! "id" (dm/str shape-id))
                         (obj/set! "style" style)
                         (obj/unset! "transform"))]

    [:g.inner-stroke-shape
     {:transform transform}
     [:defs
      [:& stroke-defs {:shape shape :stroke stroke :render-id render-id :index index}]
      [:> type props]]

     [:use {:href (dm/str "#" shape-id)
            :clipPath clip-path}]]))

;; The SVG standard does not implement yet the 'stroke-alignment'
;; attribute, to define the position of the stroke relative to the
;; stroke axis (inner, center, outer). Here we implement a patch to be
;; able to draw the stroke in the three cases. See discussion at:
;; https://stackoverflow.com/questions/7241393/can-you-control-how-an-svgs-stroke-width-is-drawn

(mf/defc shape-custom-stroke
  {::mf/wrap-props false}
  [props]
  (let [child           (unchecked-get props "children")
        shape           (unchecked-get props "shape")
        stroke          (unchecked-get props "stroke")
        index           (unchecked-get props "index")

        render-id       (mf/use-ctx muc/render-id)
        render-id       (d/nilv (unchecked-get props "render-id") render-id)

        stroke-width    (:stroke-width stroke 0)
        stroke-style    (:stroke-style stroke :none)
        stroke-position (:stroke-alignment stroke :center)

        has-stroke?     (and (> stroke-width 0)
                             (not= stroke-style :none))
        closed?         (or (not ^boolean (cfh/path-shape? shape))
                            (not ^boolean (path/shape-with-open-path? shape)))
        inner?          (= :inner stroke-position)
        outer?          (= :outer stroke-position)]

    (cond
      (and has-stroke? inner? closed?)
      [:& inner-stroke {:shape shape :stroke stroke :index index} child]

      (and has-stroke? outer? closed?)
      [:& outer-stroke {:shape shape :stroke stroke :index index} child]

      :else
      [:g.stroke-shape
       [:defs
        [:& stroke-defs {:shape shape :stroke stroke :render-id render-id :index index}]]
       child])))

(defn- build-fill-element
  [shape child position render-id]
  (let [type         (obj/get child "type")
        props        (-> (obj/get child "props")
                         (obj/clone))
        props        (attrs/add-fill-props! props shape position render-id)]
    (mf/html [:> type props])))

(defn- build-stroke-element
  [child value position render-id open-path?]
  (let [props (obj/get child "props")
        type  (obj/get child "type")

        style (-> (obj/get props "style")
                  (obj/clone)
                  (obj/set! "fill" "none")
                  (obj/set! "fillOpacity" "none")
                  (attrs/add-stroke! value render-id position open-path?))

        style (if (:stroke-image value)
                (obj/set! style "stroke" (dm/fmt "url(#stroke-fill-%-%)" render-id position))
                style)

        props (-> (obj/clone props)
                  (obj/unset! "fill")
                  (obj/unset! "fillOpacity")
                  (obj/set! "style" style))]

    (mf/html [:> type props])))

(mf/defc shape-fills
  {::mf/wrap-props false}
  [props]
  (let [child      (unchecked-get props "children")
        shape      (unchecked-get props "shape")

        shape-id   (dm/get-prop shape :id)

        position   (d/nilv (unchecked-get props "position") 0)

        render-id  (mf/use-ctx muc/render-id)
        render-id  (d/nilv (unchecked-get props "render-id") render-id)]

    [:g.fills {:id (dm/fmt "fills-%" shape-id)}
     (build-fill-element shape child position render-id)]))

(defn- per-side-corners
  "Corner radii of a rect or frame as four [r r] pairs, top-left first."
  [shape]
  (let [radii (case (ctsr/radius-mode shape)
                :radius-1 (let [r (gsh/shape-corners-1 shape)] [r r r r])
                (gsh/shape-corners-4 shape))]
    (mapv (fn [r] (let [r (d/nilv r 0)] [r r])) radii)))

(defn- per-side-widths
  "Effective widths of a stroke as [top right bottom left]."
  [stroke]
  [(d/nilv (cts/side-width stroke :stroke-width-top) 0)
   (d/nilv (cts/side-width stroke :stroke-width-right) 0)
   (d/nilv (cts/side-width stroke :stroke-width-bottom) 0)
   (d/nilv (cts/side-width stroke :stroke-width-left) 0)])

(defn- mask-lines
  "The middle line of each side strip of a band, clockwise from the top:
  top left to right, right top to bottom, bottom right to left, left
  bottom to top. Each map carries its :side and end points."
  [outer inner]
  (let [outer-right  (+ (:x outer) (:width outer))
        outer-bottom (+ (:y outer) (:height outer))
        inner-right  (+ (:x inner) (:width inner))
        inner-bottom (+ (:y inner) (:height inner))
        mid-top      (/ (+ (:y outer) (:y inner)) 2.0)
        mid-right    (/ (+ outer-right inner-right) 2.0)
        mid-bottom   (/ (+ outer-bottom inner-bottom) 2.0)
        mid-left     (/ (+ (:x outer) (:x inner)) 2.0)]
    [{:side :top    :x1 (:x outer) :y1 mid-top    :x2 outer-right :y2 mid-top}
     {:side :right  :x1 mid-right  :y1 (:y outer) :x2 mid-right   :y2 outer-bottom}
     {:side :bottom :x1 outer-right :y1 mid-bottom :x2 (:x outer) :y2 mid-bottom}
     {:side :left   :x1 mid-left   :y1 outer-bottom :x2 mid-left :y2 (:y outer)}]))

;; A rect or frame stroke whose sides differ in width is drawn as the band
;; between an outer and an inner rounded rect. One rect is painted, clipped
;; to the band, so a gradient or image paint maps to the shape's own box as a
;; uniform stroke does. Dashed styles also mask that rect with one line per
;; side. Known gaps against the workspace renderer: strokes that share a box
;; are not mitred against each other; dashes are not fitted to a whole number
;; per side; rounded corners do not get the solid corner patches the workspace
;; renderer adds for dashed styles.
(mf/defc per-side-stroke
  {::mf/wrap-props false}
  [{:keys [shape stroke index render-id]}]
  (let [style        (:stroke-style stroke :solid)
        shape-id     (dm/get-prop shape :id)
        alignment    (:stroke-alignment stroke :center)
        dash         (:stroke-dash stroke)
        gap          (:stroke-gap stroke)
        widths       (per-side-widths stroke)
        [top right bottom left] widths
        side-widths  {:top top :right right :bottom bottom :left left}
        max-width    (reduce d/max 0 widths)
        rect         (select-keys shape [:x :y :width :height])
        band         (cts/per-side-band rect (per-side-corners shape) widths alignment)
        outer        (:outer band)
        inner        (:inner band)
        band-d       (cts/per-side-band-path band)
        transform    (gsh/transform-str shape)
        dashed?      (and (some? inner) (contains? #{:dashed :dotted :mixed} style))

        ;; Paint and opacity come from the same rules a uniform stroke uses.
        paint-attrs  (attrs/add-stroke! #js {} stroke render-id index false)
        paint        (if (some? (:stroke-image stroke))
                       (dm/fmt "url(#stroke-fill-%-%)" render-id index)
                       (obj/get paint-attrs "stroke"))
        opacity      (obj/get paint-attrs "strokeOpacity")

        ;; The gradient and image paints need the stroke defs. They are
        ;; sized for the widest side, so the paint covers the whole band.
        defs-el      (mf/html [:& stroke-defs {:shape shape
                                               :stroke (assoc stroke :stroke-width max-width)
                                               :render-id render-id
                                               :index index}])

        ;; The painted rect's stroke is wider than the shape, so it covers
        ;; the whole band even around inner rounded corners. The clip cuts
        ;; it to the band, so the extra width is never visible.
        cover-width  (+ (max (:width shape) (:height shape)) (* 2 max-width))
        clip-id      (dm/str "per-side-clip-" render-id "-" shape-id "-" index)
        mask-id      (dm/str "per-side-mask-" render-id "-" shape-id "-" index)]

    (when-not (= style :none)
      [:g {:transform transform}
       [:defs
        defs-el
        [:> "clipPath" {:id clip-id}
         [:path {:d band-d :clipRule "evenodd"}]]
        (when dashed?
          [:mask {:id mask-id
                  :maskUnits "userSpaceOnUse"
                  :x (- (:x outer) max-width)
                  :y (- (:y outer) max-width)
                  :width (+ (:width outer) (* 2 max-width))
                  :height (+ (:height outer) (* 2 max-width))}
           (for [{:keys [side x1 y1 x2 y2]} (mask-lines outer inner)
                 :let [width (get side-widths side)]
                 :when (pos? width)]
             ;; No strokeOpacity here: opacity sits on the painted rect only.
             [:line {:key (name side)
                     :x1 x1 :y1 y1 :x2 x2 :y2 y2
                     :stroke "white"
                     :strokeWidth width
                     :strokeDasharray (attrs/calculate-dasharray style width dash gap)
                     :strokeLinecap (if (= style :dotted) "round" "butt")
                     :fill "none"}])])]
       [:rect {:x (:x shape)
               :y (:y shape)
               :width (:width shape)
               :height (:height shape)
               :fill "none"
               :stroke paint
               :strokeOpacity opacity
               :strokeWidth cover-width
               :clipPath (dm/str "url(#" clip-id ")")
               :mask (when dashed? (dm/str "url(#" mask-id ")"))}]])))

(mf/defc shape-strokes
  {::mf/wrap-props false}
  [props]
  (let [child         (unchecked-get props "children")
        shape         (unchecked-get props "shape")

        shape-id      (dm/get-prop shape :id)

        render-id     (mf/use-ctx muc/render-id)
        render-id     (d/nilv (unchecked-get props "render-id") render-id)

        strokes       (get shape :strokes)

        ;; Generate a unique id when the strokes change. This way we can solve some
        ;; render issues in Safari https://tree.taiga.io/project/penpot/issue/9040
        prefix        (mf/use-memo (mf/deps strokes) #(dm/str (uuid/next)))

        stroke-id     (dm/str (dm/fmt "strokes-%-%" prefix shape-id))

        shape-blur   (get shape :blur)

        shape-fills   (get shape :fills)
        shape-shadow  (get shape :shadow)
        shape-strokes (not-empty strokes)

        svg-attrs     (attrs/get-svg-props shape render-id)

        style         (-> (obj/get props "style")
                          (obj/clone)
                          (obj/merge! (obj/get svg-attrs "style")))

        props        (mf/spread-props svg-attrs
                                      {:id stroke-id
                                       :className "strokes"
                                       :style style})

        open-path?    (and ^boolean (cfh/path-shape? shape)
                           ^boolean (path/shape-with-open-path? shape))]

    (when-not ^boolean (cfh/frame-shape? shape)
      (when (and (some? shape-blur)
                 (not ^boolean (:hidden shape-blur)))
        (obj/set! props "filter" (dm/fmt "url(#filter-blur-%)" render-id)))

      (when (and (empty? shape-fills)
                 (some? (->> shape-shadow (remove :hidden) not-empty)))
        (obj/set! props "filter" (dm/fmt "url(#filter-%)" render-id))))

    (when (some? shape-strokes)
      [:> :g props
       (for [[index value] (reverse (d/enumerate shape-strokes))
             :when (not (:hidden value))]
         (if (cts/per-side-stroke? shape value)
           [:& per-side-stroke {:shape shape
                                :stroke value
                                :index index
                                :render-id render-id
                                :key (dm/str index "-" stroke-id)}]
           [:& shape-custom-stroke {:shape shape
                                    :stroke value
                                    :index index
                                    :key (dm/str index "-" stroke-id)}
            (build-stroke-element child value index render-id open-path?)]))])))

(mf/defc shape-custom-strokes
  {::mf/wrap-props false}
  [props]
  [:*
   [:> shape-fills props]
   [:> shape-strokes props]])
