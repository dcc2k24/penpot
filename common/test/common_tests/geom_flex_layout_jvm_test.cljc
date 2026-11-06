;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns common-tests.geom-flex-layout-jvm-test
  (:require
   ;; Requiring modifiers triggers the side-effect that wires
   ;; -child-min-width / -child-min-height into the layout code.
   [app.common.geom.modifiers :as gm]
   [app.common.geom.rect :as grc]
   [app.common.geom.shapes :as gsh]
   [app.common.geom.shapes.grid-layout.layout-data :as gld]
   [app.common.math :as mth]
   [app.common.types.modifiers :as ctm]
   [app.common.types.shape :as cts]
   [app.common.types.shape.layout :as ctl]
   [clojure.test :as t]))

;; These tests reflow flex and grid boards through the modifiers pipeline.
;; On the JVM, nil and division by zero throw where ClojureScript does not,
;; so each case must reflow without an exception and give finite geometry.

;; ---- helpers ----

(defn- finite-number?
  [x]
  (and (number? x)
       (= x x)
       (< (- ##Inf) x ##Inf)))

(defn- real-number?
  "True for a double, or for an integer where the code keeps integers.
  A clojure.lang.Ratio is neither, so it fails this check."
  [x]
  (or (double? x) (integer? x)))

(defn- assert-real-geometry
  "Checks x, y, width and height of a shape and of its :selrect."
  [shape]
  (let [selrect (:selrect shape)]
    (doseq [v [(:x shape) (:y shape) (:width shape) (:height shape)
               (:x selrect) (:y selrect) (:width selrect) (:height selrect)]]
      (t/is (real-number? v) (str "not a double or integer: " (pr-str v))))))

(defn- make-board
  [& {:as opts}]
  (cts/setup-shape (merge {:type :frame
                           :layout :flex
                           :layout-flex-dir :row
                           :x 0 :y 0 :width 200 :height 200}
                          opts)))

(defn- make-grid-board
  [& {:as opts}]
  (cts/setup-shape (merge {:type :frame
                           :layout :grid
                           :layout-grid-dir :row
                           :layout-grid-columns [{:type :flex :value 1}
                                                 {:type :fixed :value 50}]
                           :layout-grid-rows [{:type :flex :value 1}
                                              {:type :fixed :value 50}]
                           :layout-grid-cells {}
                           :layout-padding-type :multiple
                           :layout-padding {:p1 0 :p2 0 :p3 0 :p4 0}
                           :layout-gap {:column-gap 0 :row-gap 0}
                           :x 0 :y 0 :width 200 :height 200}
                          opts)))

(defn- make-child
  "Builds a rect inside the parent board. The caller must also list the
  child in the parent's :shapes (see with-children)."
  [parent w h & {:as opts}]
  (cts/setup-shape (merge {:type :rect
                           :x 0 :y 0
                           :width w :height h
                           :parent-id (:id parent)
                           :frame-id (:id parent)}
                          opts)))

(defn- with-children
  "Returns the board with its :shapes set to the ids of the children."
  [board children]
  (assoc board :shapes (mapv :id children)))

(defn- reflow
  "Reflows the board. The board must already list its children in :shapes,
  and descendants must contain every shape below the board. Returns a map
  from shape id to the shape with the reflow modifiers applied."
  [board descendants]
  (let [shapes  (cons board descendants)
        objects (into {} (map (juxt :id identity)) shapes)
        tree    (gm/set-objects-modifiers {(:id board) {:modifiers (ctm/reflow-modifiers)}}
                                          objects)]
    (into {}
          (map (fn [shape]
                 [(:id shape)
                  (gsh/transform-shape shape (get-in tree [(:id shape) :modifiers]))]))
          shapes)))

(defn- check-reflow
  "Reflows the board and checks that every child has finite geometry.
  Returns the reflowed shapes."
  [board children]
  (let [after (reflow board children)]
    (t/is (map? after))
    (doseq [child children]
      (let [{:keys [x y width height]} (:selrect (get after (:id child)))]
        (t/is (finite-number? x))
        (t/is (finite-number? y))
        (t/is (finite-number? width))
        (t/is (finite-number? height))))
    after))

;; ---- cases ----

(t/deftest flex-row-reflow-does-not-throw
  (let [board    (make-board :layout-flex-dir :row)
        children [(make-child board 50 50)
                  (make-child board 50 50)
                  (make-child board 50 50)]
        board    (with-children board children)]
    (check-reflow board children)))

(t/deftest flex-column-reflow-does-not-throw
  (let [board    (make-board :layout-flex-dir :column)
        children [(make-child board 50 50)
                  (make-child board 50 50)
                  (make-child board 50 50)]
        board    (with-children board children)]
    (check-reflow board children)))

(t/deftest flex-row-gap-places-second-child-after-first
  ;; The layout reads a parent's :shapes from the last entry to the first,
  ;; so the first child in the row is the last entry in :shapes.
  (let [board        (make-board :layout-flex-dir :row
                                 :layout-gap {:row-gap 10 :column-gap 10})
        first-child  (make-child board 50 50)
        second-child (make-child board 50 50)
        board        (with-children board [second-child first-child])
        after        (reflow board [first-child second-child])
        x1           (get-in after [(:id first-child) :selrect :x])
        w1           (get-in after [(:id first-child) :selrect :width])
        x2           (get-in after [(:id second-child) :selrect :x])]
    (t/is (mth/close? (+ x1 w1 10) x2 0.01))))

(t/deftest flex-wrap-five-children-in-200px-board
  (let [board    (make-board :layout-flex-dir :row
                             :layout-wrap-type :wrap)
        children (vec (repeatedly 5 #(make-child board 80 60)))
        board    (with-children board children)]
    (check-reflow board children)))

(t/deftest flex-non-zero-gaps-and-paddings
  (doseq [dir [:row :column]]
    (t/testing (str "direction " dir)
      (let [board    (make-board :layout-flex-dir dir
                                 :layout-wrap-type :wrap
                                 :layout-gap {:row-gap 8 :column-gap 10}
                                 :layout-padding-type :multiple
                                 :layout-padding {:p1 5 :p2 6 :p3 7 :p4 8})
            children (vec (repeatedly 4 #(make-child board 40 30)))
            board    (with-children board children)]
        (check-reflow board children)))))

(t/deftest flex-align-items-all-values
  (doseq [v   (sort ctl/align-items-types)
          dir [:row :column]]
    (t/testing (str "align-items " v " direction " dir)
      (let [board    (make-board :layout-flex-dir dir
                                 :layout-align-items v)
            children (vec (repeatedly 3 #(make-child board 40 30)))
            board    (with-children board children)]
        (check-reflow board children)))))

(t/deftest flex-justify-content-all-values
  (doseq [v   (sort ctl/justify-content-types)
          dir [:row :column]]
    (t/testing (str "justify-content " v " direction " dir)
      (let [board    (make-board :layout-flex-dir dir
                                 :layout-justify-content v)
            children (vec (repeatedly 3 #(make-child board 40 30)))
            board    (with-children board children)]
        (check-reflow board children)))))

(t/deftest flex-align-content-all-values-with-wrap
  (doseq [v   (sort ctl/align-content-types)
          dir [:row :column]]
    (t/testing (str "align-content " v " direction " dir)
      (let [board    (make-board :layout-flex-dir dir
                                 :layout-wrap-type :wrap
                                 :layout-align-content v)
            children (vec (repeatedly 5 #(make-child board 80 60)))
            board    (with-children board children)]
        (check-reflow board children)))))

(t/deftest flex-children-fill-and-auto-sizing
  (doseq [h   [:fill :auto]
          v   [:fill :auto]
          dir [:row :column]]
    (t/testing (str "h-sizing " h " v-sizing " v " direction " dir)
      (let [board    (make-board :layout-flex-dir dir)
            children (vec (repeatedly 3 #(make-child board 50 50
                                                     :layout-item-h-sizing h
                                                     :layout-item-v-sizing v)))
            board    (with-children board children)]
        (check-reflow board children)))))

(t/deftest flex-nested-flex-inside-flex
  (let [outer (make-board :layout-flex-dir :row)
        inner (make-board :layout-flex-dir :column
                          :width 100 :height 100
                          :parent-id (:id outer)
                          :frame-id (:id outer))
        c1    (make-child inner 30 30)
        c2    (make-child inner 30 30)
        inner (with-children inner [c1 c2])
        outer (with-children outer [inner])
        after (reflow outer [inner c1 c2])]
    (t/is (map? after))
    (doseq [id [(:id inner) (:id c1) (:id c2)]]
      (let [{:keys [x y width height]} (:selrect (get after id))]
        (t/is (finite-number? x))
        (t/is (finite-number? y))
        (t/is (finite-number? width))
        (t/is (finite-number? height))))))

(t/deftest flex-empty-board-all-align-content-values
  (doseq [v   (sort ctl/align-content-types)
          dir [:row :column]]
    (t/testing (str "align-content " v " direction " dir)
      (let [board (with-children (make-board :layout-flex-dir dir
                                             :layout-wrap-type :wrap
                                             :layout-align-content v)
                    [])]
        (check-reflow board [])))))

(t/deftest grid-2x2-with-children-reflow-does-not-throw
  (let [board    (make-grid-board)
        children (vec (repeatedly 4 #(make-child board 20 20)))
        board    (with-children board children)]
    (check-reflow board children)))

(t/deftest grid-2x2-with-assigned-cells-reflow-does-not-throw
  (let [board    (make-grid-board)
        children (vec (repeatedly 4 #(make-child board 20 20)))
        board    (with-children board children)
        objects  (into {(:id board) board} (map (juxt :id identity)) children)
        board    (ctl/assign-cells board objects)]
    (check-reflow board children)))

(t/deftest grid-empty-reflow-does-not-throw
  (let [board (with-children (make-grid-board) [])]
    (check-reflow board [])))

(t/deftest grid-zero-tracks-space-around-stays-finite
  ;; With no tracks, space-around must not divide by the track count.
  (let [board  (make-grid-board :layout-grid-columns []
                                :layout-grid-rows []
                                :layout-justify-content :space-around
                                :layout-align-content :space-around)
        bounds (grc/rect->points (grc/make-rect 0 0 200 200))
        result (gld/calc-layout-data board bounds [] {} {})]
    (doseq [k [:column-gap :row-gap
               :column-total-size :column-total-gap
               :row-total-size :row-total-gap]]
      (t/is (finite-number? (get result k)) (str k)))
    (t/is (finite-number? (get-in result [:origin :x])))
    (t/is (finite-number? (get-in result [:origin :y])))
    (check-reflow (with-children board []) [])))

(t/deftest flex-single-child-space-between-starts-at-origin
  ;; CSS flexbox: one item with space-between sits at the start.
  (doseq [dir [:row :column]]
    (t/testing (str "direction " dir)
      (let [board  (make-board :layout-flex-dir dir
                               :layout-justify-content :space-between)
            child  (make-child board 50 50)
            board  (with-children board [child])
            after  (reflow board [child])
            {:keys [x y width height]} (:selrect (get after (:id child)))]
        (t/is (finite-number? x))
        (t/is (mth/close? 0 x 0.01))
        (t/is (mth/close? 0 y 0.01))
        (t/is (mth/close? 50 width 0.01))
        (t/is (mth/close? 50 height 0.01))))))

(t/deftest flex-output-geometry-is-double-or-integer
  ;; space-around gives fractional margins (80 / 3 / 2), which must not
  ;; leak out as clojure.lang.Ratio.
  (let [board    (make-board :layout-flex-dir :row
                             :layout-justify-content :space-around)
        children (vec (repeatedly 3 #(make-child board 40 30)))
        board    (with-children board children)
        after    (reflow board children)]
    (t/is (= 4 (count after)))
    (doseq [shape (vals after)]
      (assert-real-geometry shape))))

(t/deftest grid-output-geometry-is-double-or-integer
  ;; space-around gives a fractional column gap (50 / 3), which must not
  ;; leak out as clojure.lang.Ratio.
  (let [board    (make-grid-board :layout-grid-columns [{:type :fixed :value 50}
                                                        {:type :fixed :value 50}
                                                        {:type :fixed :value 50}]
                                  :layout-grid-rows [{:type :fixed :value 50}]
                                  :layout-justify-content :space-around
                                  :layout-align-content :space-around)
        children (vec (repeatedly 3 #(make-child board 20 20)))
        board    (with-children board children)
        objects  (into {(:id board) board} (map (juxt :id identity)) children)
        board    (ctl/assign-cells board objects)
        after    (reflow board children)]
    (t/is (= 4 (count after)))
    (doseq [shape (vals after)]
      (assert-real-geometry shape))))
