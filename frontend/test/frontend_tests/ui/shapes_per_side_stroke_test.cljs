;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.shapes-per-side-stroke-test
  (:require
   ["react" :as react]
   ["react-dom/server" :as rds]
   [app.common.uuid :as uuid]
   [app.main.ui.shapes.custom-stroke :as custom-stroke]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(defn- rect-shape
  "A 100 by 50 rect or frame, square corners, carrying `strokes`."
  [type strokes]
  {:id (uuid/next)
   :type type
   :x 0 :y 0 :width 100 :height 50
   :r1 0 :r2 0 :r3 0 :r4 0
   :fills []
   :strokes strokes})

(defn- render-strokes
  "Static markup of the strokes of `shape`. The child is the element the
  uniform stroke path decorates; the band path ignores it."
  [shape]
  (let [child (react/createElement "rect" #js {:style #js {}})]
    (rds/renderToStaticMarkup
     (mf/element custom-stroke/shape-strokes
                 #js {:shape shape :style #js {} :children child}))))

(defn- tags
  "Opening tags named `tag` in `markup`."
  [markup tag]
  (re-seq (re-pattern (str "<" tag "(?:\\s[^>]*)?>")) markup))

(defn- attr
  "Value of attribute `name` in the tag string `tag`, or nil."
  [tag name]
  (second (re-find (re-pattern (str "\\s" name "=\"([^\"]*)\"")) tag)))

(defn- element-body
  "Inner markup of the element `tag` whose id is `id`."
  [markup tag id]
  (second (re-find (re-pattern (str "<" tag " id=\"" id "\"[^>]*>(.*?)</" tag ">")) markup)))

(defn- url-id
  "The id a `url(#id)` attribute named `attr-name` on `tag` points at."
  [tag attr-name]
  (second (re-find (re-pattern (str "\\s" attr-name "=\"url\\(#([^)]*)\\)\"")) tag)))

(def ^:private per-side-solid
  {:stroke-style :solid
   :stroke-alignment :center
   :stroke-color "#ff0000"
   :stroke-opacity 1
   :stroke-width 2
   :stroke-width-top 2
   :stroke-width-right 4
   :stroke-width-bottom 6
   :stroke-width-left 8})

(def ^:private uniform-solid
  (assoc per-side-solid
         :stroke-width-right 2
         :stroke-width-bottom 2
         :stroke-width-left 2))

(def ^:private gradient
  {:type :linear
   :start-x 0 :start-y 0 :end-x 100 :end-y 0 :width 1
   :stops [{:offset 0 :color "#000000" :opacity 1}
           {:offset 1 :color "#ffffff" :opacity 1}]})

(def ^:private band-d
  "M -4 -1 L 102 -1 L 102 53 L -4 53 Z M 4 1 L 98 1 L 98 47 L 4 47 Z")

(t/deftest per-side-solid-paints-one-rect-through-the-band-clip
  (let [markup   (render-strokes (rect-shape :rect [per-side-solid]))
        rects    (tags markup "rect")
        rect-tag (first rects)
        clip-id  (url-id rect-tag "clip-path")
        clip     (element-body markup "clipPath" clip-id)
        path-tag (first (tags clip "path"))]
    (t/testing "one painted rect over the shape's own box"
      (t/is (= 1 (count rects)))
      (t/is (= "0" (attr rect-tag "x")))
      (t/is (= "0" (attr rect-tag "y")))
      (t/is (= "100" (attr rect-tag "width")))
      (t/is (= "50" (attr rect-tag "height")))
      (t/is (= "none" (attr rect-tag "fill")))
      (t/is (= "#ff0000" (attr rect-tag "stroke"))))
    (t/testing "the clip is the even-odd band, and there is no mask"
      (t/is (some? clip-id))
      (t/is (= band-d (attr path-tag "d")))
      (t/is (= "evenodd" (attr path-tag "clip-rule")))
      (t/is (not (str/includes? markup "<mask"))))))

(t/deftest per-side-dashed-masks-one-line-per-side-clockwise
  (let [markup   (render-strokes (rect-shape :rect [(assoc per-side-solid :stroke-style :dashed)]))
        rect-tag (first (tags markup "rect"))
        mask-id  (url-id rect-tag "mask")
        clip-id  (url-id rect-tag "clip-path")
        mask-tag (first (tags markup "mask"))
        lines    (tags (element-body markup "mask" mask-id) "line")]
    (t/is (some? clip-id))
    (t/is (some? mask-id))
    (t/is (= "userSpaceOnUse" (attr mask-tag "maskUnits")))
    (t/is (= 4 (count lines)))
    (t/is (every? #(= "white" (attr % "stroke")) lines))
    (t/is (not-any? #(str/includes? % "stroke-opacity") lines))
    (t/testing "bottom runs right to left, left runs bottom to top"
      (let [bottom (nth lines 2)
            left   (nth lines 3)]
        (t/is (> (js/parseFloat (attr bottom "x1")) (js/parseFloat (attr bottom "x2"))))
        (t/is (> (js/parseFloat (attr left "y1")) (js/parseFloat (attr left "y2"))))))))

(t/deftest per-side-opacity-sits-on-the-painted-rect-once
  (let [markup (render-strokes (rect-shape :rect [(assoc per-side-solid
                                                         :stroke-style :dashed
                                                         :stroke-opacity 0.5)]))]
    (t/is (= 1 (count (re-seq #"stroke-opacity=\"0.5\"" markup))))
    (t/is (= "0.5" (attr (first (tags markup "rect")) "stroke-opacity")))))

(t/deftest per-side-dashed-gradient-paints-the-rect-not-the-lines
  (let [stroke   (-> per-side-solid
                     (assoc :stroke-style :dashed :stroke-color-gradient gradient)
                     (dissoc :stroke-color))
        markup   (render-strokes (rect-shape :rect [stroke]))
        rect-tag (first (tags markup "rect"))]
    (t/is (str/starts-with? (attr rect-tag "stroke") "url(#"))
    (t/is (not-any? #(str/includes? % "url(#") (tags markup "line")))
    (t/is (every? #(= "white" (attr % "stroke")) (tags markup "line")))))

(t/deftest per-side-zero-side-gets-no-mask-line
  (let [stroke  (assoc per-side-solid :stroke-style :dashed :stroke-width-top 0)
        markup  (render-strokes (rect-shape :rect [stroke]))
        mask-id (url-id (first (tags markup "rect")) "mask")
        lines   (tags (element-body markup "mask" mask-id) "line")]
    (t/is (= 3 (count lines)))
    (t/is (not-any? #(= "0" (attr % "stroke-width")) lines))))

(t/deftest per-side-dash-caps-follow-the-style
  (let [mask-lines (fn [style]
                     (let [markup (render-strokes
                                   (rect-shape :rect [(assoc per-side-solid :stroke-style style)]))]
                       (tags (element-body markup "mask" (url-id (first (tags markup "rect")) "mask"))
                             "line")))]
    (t/is (every? #(= "round" (attr % "stroke-linecap")) (mask-lines :dotted)))
    (t/is (every? #(= "butt" (attr % "stroke-linecap")) (mask-lines :dashed)))))

(t/deftest per-side-stroke-on-frame-paints-through-the-clip
  (let [markup (render-strokes (rect-shape :frame [per-side-solid]))]
    (t/is (= 1 (count (tags markup "rect"))))
    (t/is (str/includes? markup "clip-path"))
    (t/is (str/includes? markup "clip-rule=\"evenodd\""))))

(t/deftest equal-sided-stroke-keeps-the-uniform-element
  (let [markup (render-strokes (rect-shape :rect [uniform-solid]))]
    (t/is (not (str/includes? markup "fill-rule")))
    (t/is (str/includes? markup "stroke-width:2"))))

(t/deftest per-side-stroke-on-ellipse-stays-uniform
  (let [markup (render-strokes (rect-shape :circle [per-side-solid]))]
    (t/is (not (str/includes? markup "clip-path")))
    (t/is (str/includes? markup "stroke-width:2"))))
