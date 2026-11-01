;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.common.types.objects-hints
  "Hints are small facts about the shapes of a page. They are computed
  ahead of time from the encoded shapes, for example by a web worker, and
  attached to the page objects in their metadata. Readers can then answer
  questions about frames and texts without decoding every shape.

  A hint set has this shape:

    {:raw    {id encoded-string}
     :frames {id {:bounds [x1 y1 x2 y2] or nil, :grid? boolean}}
     :texts  {id {:font-ids [...], :no-position-data? boolean}}}

  `:raw` is the raw data the hints were made from. A hint for an id is
  valid only while the objects map still holds that very same encoded
  string for the id (see `known?`). Once a shape is set to a new value,
  its hint is no longer used and the shape itself is read."
  (:require
   [app.common.data :as d]
   [app.common.files.helpers :as cfh]
   [app.common.math :as mth]
   [app.common.types.objects-map :as omap]
   [app.common.types.text :as txt]))

(def ^:private bounds-margin
  "Widens a frame box on every side, so that a point on its edge is never
  lost to rounding. The margin only adds candidates."
  0.01)

(defn hints
  "Returns the hint set attached to `objects`, or nil."
  [objects]
  (-> objects meta ::hints))

(defn with-hints
  "Returns `objects` with the hint set `hints` attached in its metadata."
  [objects hints]
  (vary-meta objects assoc ::hints hints))

(defn known?
  "True when `objects` still holds the encoded string that the hints were
  made from for `id`. Only then the hints can be trusted for that id."
  [hints objects id]
  (let [s (omap/raw-value objects id)]
    (and (some? s)
         (identical? s (get (:raw hints) id)))))

(defn has-displayed-grid?
  "True when the shape has at least one displayed grid."
  [shape]
  (and (some? (:grids shape))
       (d/not-empty? (filter :display (:grids shape)))))

(defn frame-bounds
  "Returns the box `[x1 y1 x2 y2]` around the frame and its points. Returns
  nil when the frame position, size or a point is not a finite number."
  [shape]
  (let [x      (:x shape)
        y      (:y shape)
        width  (:width shape)
        height (:height shape)
        points (:points shape)]
    (when (and (mth/finite? x)
               (mth/finite? y)
               (mth/finite? width)
               (mth/finite? height)
               (every? #(and (mth/finite? (:x %))
                             (mth/finite? (:y %)))
                       points))
      (let [xs (into [x (+ x width)] (map :x) points)
            ys (into [y (+ y height)] (map :y) points)]
        [(apply min xs) (apply min ys) (apply max xs) (apply max ys)]))))

(defn may-contain-point?
  "True when `point` may be inside `bounds`. A nil `bounds` always may."
  [bounds point]
  (or (nil? bounds)
      (let [[x1 y1 x2 y2] bounds
            px (:x point)
            py (:y point)]
        (and (>= px (- x1 bounds-margin))
             (<= px (+ x2 bounds-margin))
             (>= py (- y1 bounds-margin))
             (<= py (+ y2 bounds-margin))))))

(defn text-font-ids
  "Returns the font ids of the text nodes of a text shape that set a font
  family."
  [shape]
  (into []
        (comp (filter #(some? (:font-family %)))
              (map :font-id))
        (txt/node-seq txt/is-text-node? (:content shape))))

(defn shape-hint
  "Returns the hint of a frame or a text shape as `[kind data]`, or nil
  for any other shape."
  [shape]
  (cond
    (cfh/frame-shape? shape)
    [:frame {:bounds (frame-bounds shape)
             :grid?  (has-displayed-grid? shape)}]

    (cfh/text-shape? shape)
    [:text {:font-ids          (text-font-ids shape)
            :no-position-data? (nil? (:position-data shape))}]

    :else
    nil))

(defn select-ids
  "Returns the ids of `objects`, in map order, that pass the test. For an
  id known from `hints`, the test is `(hinted? id)`. For any other id, the
  shape is read and the test is `(pred shape)`. The root id is not removed,
  so callers drop it when they need to."
  [objects hints hinted? pred]
  (filter (fn [id]
            (if (known? hints objects id)
              (hinted? id)
              (pred (get objects id))))
          (keys objects)))
