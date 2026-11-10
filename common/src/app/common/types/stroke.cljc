;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.common.types.stroke
  (:require
   [app.common.data :as d]
   [app.common.types.color :as clr]
   [app.common.types.token :as ctt]
   [clojure.string]))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; SCHEMAS
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(def stroke-caps-line #{:round :square})
(def stroke-caps-marker #{:line-arrow :triangle-arrow :square-marker :circle-marker :diamond-marker})

(def default-stroke
  {:stroke-alignment :inner
   :stroke-style :solid
   :stroke-color clr/black
   :stroke-opacity 1
   :stroke-width 1})

(defn materialize-stroke-side-widths
  "Sets edited widths and fills missing sides from `:stroke-width` (default 0).
  Keeps `:stroke-width` equal to the top width."
  [stroke edited-keys value]
  (let [base-width (or (:stroke-width stroke) 0)
        current    (or stroke default-stroke)
        side-attrs (reduce
                    (fn [acc side-key]
                      (assoc acc side-key
                             (if (contains? edited-keys side-key)
                               value
                               (d/nilv (get current side-key) base-width))))
                    {}
                    ctt/per-side-stroke-width-keys)]
    (merge current side-attrs {:stroke-width (get side-attrs :stroke-width-top)})))

(defn set-width-to-all-sides
  "Sets every side and `:stroke-width` to `value`."
  [stroke value]
  (materialize-stroke-side-widths stroke ctt/per-side-stroke-width-keys value))

(defn set-width-to-single-side
  "Sets one side and preserves the other widths.
  Keeps `:stroke-width` equal to the top width."
  [stroke attr value]
  (materialize-stroke-side-widths (or stroke default-stroke) #{attr} value))

(defn side-width
  "Returns the side width, falling back to `:stroke-width` when unset."
  [stroke attr]
  (d/nilv (get stroke attr) (:stroke-width stroke)))

(defn width-type
  "Returns simple when all effective side widths match, multiple otherwise."
  [stroke]
  (if (= (side-width stroke :stroke-width-top)
         (side-width stroke :stroke-width-right)
         (side-width stroke :stroke-width-bottom)
         (side-width stroke :stroke-width-left))
    :simple
    :multiple))

(defn max-side-width
  "Largest effective side width of `stroke`, 0 when it has none."
  [stroke]
  (reduce d/max 0 (map #(d/nilv (side-width stroke %) 0)
                       [:stroke-width-top :stroke-width-right
                        :stroke-width-bottom :stroke-width-left])))

(defn per-side-stroke?
  "True when `stroke` on `shape` is a rect or frame stroke whose sides
  differ in width. Such a stroke is drawn as a band, not as one line."
  [shape stroke]
  (and (contains? #{:rect :frame} (:type shape))
       (= :multiple (width-type stroke))))

(defn- fmt-num
  "Prints a number the same way on the JVM and in the browser."
  [v]
  (let [r (/ (Math/round (* (double v) 10000.0)) 10000.0)]
    (if (== r (Math/floor r))
      (str (long r))
      (str r))))

(defn- fmt-pt
  [[x y]]
  (str (fmt-num x) " " (fmt-num y)))

(defn- alignment-fractions
  "How far each side width grows outward and inward for an alignment."
  [alignment]
  (case alignment
    :inner [0 1]
    :outer [1 0]
    [0.5 0.5]))

(defn- fit-radii
  "Scales all corner radii by one factor when two radii that share a side
  add up to more than that side, as SVG and Skia do for rounded rects."
  [width height radii]
  (let [[[tl-x tl-y] [tr-x tr-y] [br-x br-y] [bl-x bl-y]] radii
        factor-for (fn [total sum] (if (> sum total) (/ total sum) 1))
        factor     (reduce min 1 [(factor-for width (+ tl-x tr-x))
                                  (factor-for width (+ br-x bl-x))
                                  (factor-for height (+ tl-y bl-y))
                                  (factor-for height (+ tr-y br-y))])]
    (mapv (fn [[rx ry]] [(* rx factor) (* ry factor)]) radii)))

(defn per-side-band
  "Outer and inner rounded rects of a rect or frame stroke with one width
  per side. `rect` has :x :y :width :height; `radii` is four [rx ry] pairs
  (top-left, top-right, bottom-right, bottom-left) or nil for square
  corners; `widths` is [top right bottom left]; `alignment` is :inner,
  :center or :outer. The inner rect is nil when the sides leave no hole."
  [rect radii widths alignment]
  (let [{:keys [x y width height]} rect
        [top right bottom left]    widths
        [out-f in-f]               (alignment-fractions alignment)
        radii                      (or radii (vec (repeat 4 [0 0])))
        ;; The two side widths that meet at each corner, in radii order.
        corner-sides               [[left top] [right top] [right bottom] [left bottom]]
        grow                       (fn [r delta] (if (> r 0) (+ r delta) 0))
        shrink                     (fn [r delta] (max 0 (- r delta)))
        outer-radii                (mapv (fn [[rx ry] [dx dy]]
                                           [(grow rx (* dx out-f)) (grow ry (* dy out-f))])
                                         radii corner-sides)
        inner-radii                (mapv (fn [[rx ry] [dx dy]]
                                           [(shrink rx (* dx in-f)) (shrink ry (* dy in-f))])
                                         radii corner-sides)
        outer-w                    (+ width (* (+ left right) out-f))
        outer-h                    (+ height (* (+ top bottom) out-f))
        inner-w                    (- width (* (+ left right) in-f))
        inner-h                    (- height (* (+ top bottom) in-f))
        hole?                      (and (> inner-w 0) (> inner-h 0))]
    {:outer {:x (- x (* left out-f))
             :y (- y (* top out-f))
             :width outer-w
             :height outer-h
             :radii (fit-radii outer-w outer-h outer-radii)}
     :inner (when hole?
              {:x (+ x (* left in-f))
               :y (+ y (* top in-f))
               :width inner-w
               :height inner-h
               :radii (fit-radii inner-w inner-h inner-radii)})}))

(defn- rounded-rect-path
  "SVG path of one rounded rect, clockwise from the start of its top edge.
  A corner with no radius on one axis stays square."
  [{:keys [x y width height radii]}]
  (let [[[tl-rx tl-ry] [tr-rx tr-ry] [br-rx br-ry] [bl-rx bl-ry]] radii
        right     (+ x width)
        bottom    (+ y height)
        round?    (fn [rx ry] (and (> rx 0) (> ry 0)))
        arc       (fn [[rx ry] start end]
                    (str "L " (fmt-pt start) " A " (fmt-num rx) " " (fmt-num ry)
                         " 0 0 1 " (fmt-pt end)))
        sharp     (fn [corner] (str "L " (fmt-pt corner)))
        start     (if (round? tl-rx tl-ry) [(+ x tl-rx) y] [x y])
        top-right (if (round? tr-rx tr-ry)
                    (arc [tr-rx tr-ry] [(- right tr-rx) y] [right (+ y tr-ry)])
                    (sharp [right y]))
        bot-right (if (round? br-rx br-ry)
                    (arc [br-rx br-ry] [right (- bottom br-ry)] [(- right br-rx) bottom])
                    (sharp [right bottom]))
        bot-left  (if (round? bl-rx bl-ry)
                    (arc [bl-rx bl-ry] [(+ x bl-rx) bottom] [x (- bottom bl-ry)])
                    (sharp [x bottom]))
        top-left  (when (round? tl-rx tl-ry)
                    (arc [tl-rx tl-ry] [x (+ y tl-ry)] start))]
    (str "M " (fmt-pt start) " "
         (clojure.string/join " " (remove nil? [top-right bot-right bot-left top-left]))
         " Z")))

(defn per-side-band-path
  "SVG path of the band: the outer rounded rect, then the inner one when
  there is a hole. Fill it with fill-rule evenodd."
  [{:keys [outer inner]}]
  (cond-> (rounded-rect-path outer)
    (some? inner) (str " " (rounded-rect-path inner))))
