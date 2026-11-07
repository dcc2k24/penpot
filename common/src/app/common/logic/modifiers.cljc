;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.common.logic.modifiers
  "Applies geometry modifiers and layout reflows to file changes."
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.changes-builder :as pcb]
   [app.common.geom.matrix :as gmt]
   [app.common.geom.modifiers :as gm]
   [app.common.geom.point :as gpt]
   [app.common.geom.rect :as grc]
   [app.common.geom.shapes :as gsh]
   [app.common.logic.shapes :as cls]
   [app.common.math :as mth]
   [app.common.types.component :as ctk]
   [app.common.types.container :as ctn]
   [app.common.types.modifiers :as ctm]
   [app.common.uuid :as uuid]))

(def ^:private xf:without-uuid-zero
  (remove #(= % uuid/zero)))

(def transform-attrs
  "The attributes that a transform changes. The frontend and the MCP compiler give them to the changes of the modifiers."
  #{:selrect
    :points
    :x
    :y
    :r1
    :r2
    :r3
    :r4
    :shadow
    :blur
    :background-blur
    :strokes
    :width
    :height
    :content
    :transform
    :transform-inverse
    :rotation
    :flip-x
    :flip-y
    :grow-type
    :position-data
    :layout-gap
    :layout-padding
    :layout-item-h-sizing
    :layout-item-max-h
    :layout-item-max-w
    :layout-item-min-h
    :layout-item-min-w
    :layout-item-v-sizing
    :layout-padding-type
    :layout-item-margin
    :layout-item-margin-type
    :layout-grid-cells
    :layout-grid-columns
    :layout-grid-rows
    :fills
    :fill-image})

(defn check-delta
  "Tells whether a transform of a component copy shape is a free change that must not mark it as touched."
  [shape root transformed-shape transformed-root]
  (let [is-root?     (and (some? root)
                          (= (dm/get-prop shape :id) (dm/get-prop root :id)))

        center       (fn [shape]
                       (grc/rect->center (:selrect shape)))

        rel-pos      (fn [shape root]
                       (when root
                         (-> (gpt/subtract (center shape) (center root))
                             (gpt/transform (:transform-inverse root (gmt/matrix))))))

        orientation  (fn [shape root]
                       ;; The transform matrix is read instead of the :rotation
                       ;; attribute, which the WASM transform path does not refresh.
                       (let [t (:transform shape (gmt/matrix))]
                         (if is-root?
                           t
                           (gmt/multiply (:transform-inverse root (gmt/matrix)) t))))

        pos-before   (rel-pos shape root)
        pos-after    (rel-pos transformed-shape transformed-root)

        distance
        (if (and pos-before pos-after)
          (gpt/distance-vector pos-before pos-after)
          (gpt/point 0 0))

        orientation-unchanged?
        (gmt/close? (orientation shape root)
                    (orientation transformed-shape transformed-root))

        selrect             (:selrect shape)
        transformed-selrect (:selrect transformed-shape)]

    ;; Movements below one pixel are ignored, because rounding and text
    ;; layout can shift coordinates slightly.
    (and (< (:x distance) 1)
         (< (:y distance) 1)
         (mth/close? (:width selrect) (:width transformed-selrect))
         (mth/close? (:height selrect) (:height transformed-selrect))
         orientation-unchanged?)))

(defn calculate-ignore-tree
  "Returns a map from shape id to the flag that ignores its geometry."
  [modif-tree objects]

  (letfn [(get-ignore-tree
            ([ignore-tree shape]
             (let [shape-id          (dm/get-prop shape :id)
                   transformed-shape (gsh/transform-shape shape (dm/get-in modif-tree [shape-id :modifiers]))

                   root
                   (if (:component-root shape)
                     shape
                     (ctn/get-component-shape objects shape {:allow-main? true}))

                   transformed-root
                   (if (:component-root shape)
                     transformed-shape
                     (gsh/transform-shape root (dm/get-in modif-tree [(:id root) :modifiers])))]

               (get-ignore-tree ignore-tree shape transformed-shape root transformed-root)))

            ([ignore-tree shape root transformed-root]
             (let [shape-id          (dm/get-prop shape :id)
                   transformed-shape (gsh/transform-shape shape (dm/get-in modif-tree [shape-id :modifiers]))]
               (get-ignore-tree ignore-tree shape transformed-shape root transformed-root)))

            ([ignore-tree shape transformed-shape root transformed-root]
             (let [shape-id (dm/get-prop shape :id)

                   ignore-tree
                   (cond-> ignore-tree
                     (and (some? root) (ctk/in-component-copy? shape))
                     (assoc shape-id
                            (check-delta shape root transformed-shape transformed-root)))

                   set-child
                   (fn [ignore-tree child]
                     (get-ignore-tree ignore-tree child root transformed-root))]

               (->> (:shapes shape)
                    (map (d/getf objects))
                    (reduce set-child ignore-tree)))))]

    (->> (keys modif-tree)
         (map #(get objects %))
         (reduce get-ignore-tree nil))))

(defn generate-apply-modifiers
  "Adds to `changes` the updates that apply the modifiers of `modif-tree` to `objects`.
  The updated shapes get their tokens unapplied and their grid cells assigned,
  unless `ignore-touched` or `skip-grid-reassignment?` is set."
  [changes objects modif-tree {:keys [ignore-touched ignore-constraints reg-objects?
                                      skip-grid-reassignment?]
                               :or {reg-objects? true
                                    ignore-constraints false}}]
  (let [object-modifiers (gm/set-objects-modifiers modif-tree objects
                                                   {:ignore-constraints ignore-constraints
                                                    :snap-pixel? false})

        ids         (into [] xf:without-uuid-zero (keys object-modifiers))
        ignore-tree (calculate-ignore-tree object-modifiers objects)

        update-shape
        (fn [shape]
          (let [modifiers (dm/get-in object-modifiers [(dm/get-prop shape :id) :modifiers])]
            (gsh/transform-shape shape modifiers)))]

    (cond-> (cls/generate-update-shapes changes ids update-shape objects
                                        {:attrs transform-attrs
                                         :ignore-tree ignore-tree
                                         :ignore-touched ignore-touched
                                         :skip-grid-reassignment? skip-grid-reassignment?})
      reg-objects?
      (pcb/resize-parents ids))))

(defn generate-reflow
  "Adds to `changes` the reflow of the layout containers related to `ids`.
  The reflow runs from every given shape, and the reflow of its layout
  container is found from there."
  [changes objects ids _opts]
  (let [ids (into [] (comp (remove #(= % uuid/zero))
                           (filter #(contains? objects %)))
                  ids)]
    (if (empty? ids)
      changes
      (let [modifiers  (ctm/reflow-modifiers)
            modif-tree (into {} (map #(vector % {:modifiers modifiers})) ids)]
        (generate-apply-modifiers changes objects modif-tree
                                  {:ignore-touched true
                                   :skip-grid-reassignment? true})))))
