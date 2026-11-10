;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns common-tests.types.stroke-test
  (:require
   [app.common.geom.shapes.bounds :as gsb]
   [app.common.types.stroke :as cts]
   [clojure.test :as t]
   [clojure.walk :as walk]))

;; --- materialize-stroke-side-widths

(t/deftest materialize-with-nil-stroke
  (t/testing "a shape without stroke gets the default stroke with every side concretized"
    (let [stroke (cts/materialize-stroke-side-widths nil #{:stroke-width-top} 10)]
      (t/is (= (:stroke-width-top stroke) 10))
      (t/is (= (:stroke-width-right stroke) 0))
      (t/is (= (:stroke-width-bottom stroke) 0))
      (t/is (= (:stroke-width-left stroke) 0))
      (t/is (= (:stroke-width stroke) 10))
      (t/is (= (:stroke-style stroke) :solid))
      (t/is (= (:stroke-alignment stroke) :inner)))))

(t/deftest materialize-with-global-only-stroke
  (t/testing "editing the top side keeps the other sides on the global width"
    (let [stroke (cts/materialize-stroke-side-widths
                  {:stroke-width 5 :stroke-color "#000000"}
                  #{:stroke-width-top}
                  10)]
      (t/is (= (:stroke-width-top stroke) 10))
      (t/is (= (:stroke-width-right stroke) 5))
      (t/is (= (:stroke-width-bottom stroke) 5))
      (t/is (= (:stroke-width-left stroke) 5))
      (t/is (= (:stroke-width stroke) 10))
      (t/is (= (:stroke-color stroke) "#000000"))))

  (t/testing "editing a non-top side keeps the global width mirroring the top side"
    (let [stroke (cts/materialize-stroke-side-widths
                  {:stroke-width 5}
                  #{:stroke-width-right}
                  10)]
      (t/is (= (:stroke-width-top stroke) 5))
      (t/is (= (:stroke-width-right stroke) 10))
      (t/is (= (:stroke-width-bottom stroke) 5))
      (t/is (= (:stroke-width-left stroke) 5))
      (t/is (= (:stroke-width stroke) 5)))))

(t/deftest materialize-keeps-explicit-sides
  (t/testing "sides with their own value keep it even when it differs from the global width"
    (let [stroke (cts/materialize-stroke-side-widths
                  {:stroke-width 4
                   :stroke-width-top 2
                   :stroke-width-right 3
                   :stroke-width-bottom 6}
                  #{:stroke-width-left}
                  7)]
      (t/is (= (:stroke-width-top stroke) 2))
      (t/is (= (:stroke-width-right stroke) 3))
      (t/is (= (:stroke-width-bottom stroke) 6))
      (t/is (= (:stroke-width-left stroke) 7))
      (t/is (= (:stroke-width stroke) 2)))))

(t/deftest materialize-multiple-sides
  (t/testing "several sides can be edited at once"
    (let [stroke (cts/materialize-stroke-side-widths
                  {:stroke-width 5}
                  #{:stroke-width-top :stroke-width-right}
                  10)]
      (t/is (= (:stroke-width-top stroke) 10))
      (t/is (= (:stroke-width-right stroke) 10))
      (t/is (= (:stroke-width-bottom stroke) 5))
      (t/is (= (:stroke-width-left stroke) 5))
      (t/is (= (:stroke-width stroke) 10)))))

;; --- set-width-to-all-sides

(t/deftest set-width-to-all-sides-uniform
  (t/testing "all four sides take the value and the alias mirrors the top"
    (let [stroke (cts/set-width-to-all-sides {:stroke-width 5 :stroke-color "#000000"} 8)]
      (t/is (= 8 (:stroke-width-top stroke)))
      (t/is (= 8 (:stroke-width-right stroke)))
      (t/is (= 8 (:stroke-width-bottom stroke)))
      (t/is (= 8 (:stroke-width-left stroke)))
      (t/is (= 8 (:stroke-width stroke)))
      (t/is (= "#000000" (:stroke-color stroke)))))

  (t/testing "a nil stroke is materialized from the default stroke"
    (let [stroke (cts/set-width-to-all-sides nil 3)]
      (t/is (= 3 (:stroke-width stroke)))
      (t/is (= 3 (:stroke-width-top stroke)))
      (t/is (= 3 (:stroke-width-right stroke)))
      (t/is (= :solid (:stroke-style stroke))))))

;; --- set-width-to-single-side

(t/deftest set-width-to-single-side-non-top
  (t/testing "a non-top side only changes that side, keeping the alias on top"
    (let [stroke (cts/set-width-to-single-side
                  {:stroke-width 5
                   :stroke-width-top 5
                   :stroke-width-right 5
                   :stroke-width-bottom 6
                   :stroke-width-left 7}
                  :stroke-width-right
                  9)]
      (t/is (= 5 (:stroke-width-top stroke)))
      (t/is (= 9 (:stroke-width-right stroke)))
      (t/is (= 6 (:stroke-width-bottom stroke)))
      (t/is (= 7 (:stroke-width-left stroke)))
      (t/is (= 5 (:stroke-width stroke))))))

(t/deftest set-width-to-single-side-top
  (t/testing "the top side also updates the :stroke-width alias"
    (let [stroke (cts/set-width-to-single-side {:stroke-width 5} :stroke-width-top 9)]
      (t/is (= 9 (:stroke-width-top stroke)))
      (t/is (= 9 (:stroke-width stroke)))))

  (t/testing "a nil stroke is materialized from the default stroke"
    (let [stroke (cts/set-width-to-single-side nil :stroke-width-bottom 4)]
      (t/is (= 4 (:stroke-width-bottom stroke)))
      (t/is (= 1 (:stroke-width stroke)))
      (t/is (= :solid (:stroke-style stroke))))))

;; --- side-width

(t/deftest side-width-falls-back-to-global
  (t/testing "a side without its own value reads the uniform width"
    (t/is (= 5 (cts/side-width {:stroke-width 5} :stroke-width-right)))
    (t/is (= 5 (cts/side-width {:stroke-width 5 :stroke-width-left 4} :stroke-width-right))))

  (t/testing "a side with its own value wins over the global width"
    (t/is (= 9 (cts/side-width {:stroke-width 5 :stroke-width-right 9} :stroke-width-right))))

  (t/testing "a nil stroke reads nil"
    (t/is (nil? (cts/side-width nil :stroke-width-top)))))

(t/deftest width-setters-select-mode
  (let [uniform (cts/set-width-to-all-sides {:stroke-color "#000000"} 1)
        top     (cts/set-width-to-single-side uniform :stroke-width-top 8)
        equal   (-> top
                    (cts/set-width-to-single-side :stroke-width-right 8)
                    (cts/set-width-to-single-side :stroke-width-bottom 8)
                    (cts/set-width-to-single-side :stroke-width-left 8))]
    (t/is (= :simple (cts/width-type uniform)))
    (t/is (= :multiple (cts/width-type top)))
    (t/is (= [8 1 1 1]
             (mapv #(cts/side-width top %)
                   [:stroke-width-top :stroke-width-right :stroke-width-bottom :stroke-width-left])))
    (t/is (= :simple (cts/width-type equal)))
    (t/is (= 8 (:stroke-width equal)))
    (t/is (not (contains? equal :stroke-width-type)))
    (t/is (= :simple (cts/width-type (cts/set-width-to-all-sides equal 3))))))

(t/deftest top-width-preserves-unset-sides
  (let [stroke (cts/set-width-to-single-side {:stroke-width 5} :stroke-width-top 9)]
    (t/is (= [9 5 5 5]
             (mapv #(cts/side-width stroke %)
                   [:stroke-width-top :stroke-width-right :stroke-width-bottom :stroke-width-left])))))

(t/deftest width-type-follows-effective-side-widths
  (let [stroke {:stroke-width 2 :stroke-width-top 2 :stroke-width-right 4
                :stroke-width-bottom 6 :stroke-width-left 8}
        simple (cts/set-width-to-all-sides stroke 2)]
    (t/is (= :multiple (cts/width-type stroke)))
    (t/is (= :simple (cts/width-type {:stroke-width 2})))
    (t/is (= :simple (cts/width-type {:stroke-width 2 :stroke-width-top 2})))
    (t/is (= :multiple (cts/width-type {:stroke-width 2 :stroke-width-right 4})))
    (t/is (= [2 2 2 2]
             (mapv simple [:stroke-width-top :stroke-width-right :stroke-width-bottom :stroke-width-left])))
    (t/is (= :simple (cts/width-type simple)))
    (t/is (not (contains? simple :stroke-width-type)))))

;; --- per-side bands and the rect/frame margin

(defn- as-doubles
  "Every number in `value` as a double, so JVM and JS compare alike."
  [value]
  (walk/postwalk #(if (number? %) (double %) %) value))

(def ^:private band-rect {:x 0 :y 0 :width 100 :height 50})
(def ^:private band-widths [2 4 6 8])

(t/deftest per-side-band-inner-alignment
  (let [band (cts/per-side-band band-rect nil band-widths :inner)]
    (t/is (= (as-doubles {:x 0 :y 0 :width 100 :height 50
                          :radii [[0 0] [0 0] [0 0] [0 0]]})
             (as-doubles (:outer band))))
    (t/is (= (as-doubles {:x 8 :y 2 :width 88 :height 42
                          :radii [[0 0] [0 0] [0 0] [0 0]]})
             (as-doubles (:inner band))))))

(t/deftest per-side-band-center-alignment
  (let [band (cts/per-side-band band-rect nil band-widths :center)]
    (t/is (= (as-doubles {:x -4 :y -1 :width 106 :height 54
                          :radii [[0 0] [0 0] [0 0] [0 0]]})
             (as-doubles (:outer band))))
    (t/is (= (as-doubles {:x 4 :y 1 :width 94 :height 46
                          :radii [[0 0] [0 0] [0 0] [0 0]]})
             (as-doubles (:inner band))))))

(t/deftest per-side-band-outer-alignment
  (let [band (cts/per-side-band band-rect nil band-widths :outer)]
    (t/is (= (as-doubles {:x -8 :y -2 :width 112 :height 58
                          :radii [[0 0] [0 0] [0 0] [0 0]]})
             (as-doubles (:outer band))))
    (t/is (= (as-doubles {:x 0 :y 0 :width 100 :height 50
                          :radii [[0 0] [0 0] [0 0] [0 0]]})
             (as-doubles (:inner band))))))

(t/deftest per-side-band-square-corners-stay-square
  (let [band (cts/per-side-band band-rect nil band-widths :outer)]
    (t/is (every? (fn [[rx ry]] (and (zero? rx) (zero? ry))) (get-in band [:outer :radii])))))

(t/deftest per-side-band-radius-grows-outside-and-shrinks-inside
  (let [radii  (vec (repeat 4 [10 10]))
        outer  (:outer (cts/per-side-band band-rect radii band-widths :inner))
        inner  (:inner (cts/per-side-band band-rect radii band-widths :inner))]
    (t/testing "outer alignment grows the outer radii by the adjacent sides"
      (t/is (= (as-doubles [[18 12] [14 12] [14 16] [18 16]])
               (as-doubles (get-in (cts/per-side-band band-rect radii band-widths :outer)
                                   [:outer :radii])))))
    (t/testing "inner alignment shrinks the inner radii, never below zero"
      (t/is (= (as-doubles [[2 8] [6 8] [6 4] [2 4]])
               (as-doubles (:radii inner)))))
    (t/is (= (as-doubles [[10 10] [10 10] [10 10] [10 10]])
             (as-doubles (:radii outer))))))

(t/deftest per-side-band-scales-radii-that-do-not-fit
  (let [band (cts/per-side-band {:x 0 :y 0 :width 20 :height 20}
                                (vec (repeat 4 [15 15])) [1 1 1 1] :center)]
    (t/testing "two radii on one side never exceed that side, all radii scale together"
      (let [[[tl-x _] [tr-x _] _ _] (get-in band [:outer :radii])]
        (t/is (<= (+ tl-x tr-x) 21.000001))
        (t/is (apply = (map first (get-in band [:outer :radii]))))))))

(t/deftest per-side-band-wide-side-leaves-no-hole
  (t/testing "a side wider than the shape gives no inner rect and a full outer rect"
    (let [band (cts/per-side-band band-rect nil [2 60 2 60] :inner)]
      (t/is (nil? (:inner band)))
      (t/is (= 1 (count (re-seq #"M" (cts/per-side-band-path band))))))))

(t/deftest per-side-band-zero-side-draws-no-thickness-there
  (let [band  (cts/per-side-band band-rect nil [0 4 6 8] :inner)]
    (t/is (== 0 (get-in band [:inner :y])))
    (t/is (== 0 (get-in band [:outer :y])))))

(t/deftest per-side-band-path-square-case
  (let [band (cts/per-side-band band-rect nil band-widths :inner)]
    (t/is (= "M 0 0 L 100 0 L 100 50 L 0 50 Z M 8 2 L 96 2 L 96 44 L 8 44 Z"
             (cts/per-side-band-path band)))))

(t/deftest per-side-band-path-has-two-subpaths-only-with-a-hole
  (let [with-hole    (cts/per-side-band band-rect nil band-widths :inner)
        without-hole (cts/per-side-band band-rect nil [2 60 2 60] :inner)]
    (t/is (= 2 (count (re-seq #"M" (cts/per-side-band-path with-hole)))))
    (t/is (= 1 (count (re-seq #"M" (cts/per-side-band-path without-hole)))))))

(t/deftest per-side-band-path-rounded-uses-arcs
  (let [band (cts/per-side-band band-rect (vec (repeat 4 [10 10])) band-widths :outer)]
    (t/is (= 8 (count (re-seq #" A " (cts/per-side-band-path band)))))))

(t/deftest per-side-stroke-predicate
  (let [different {:stroke-width 2 :stroke-width-top 2 :stroke-width-right 4
                   :stroke-width-bottom 2 :stroke-width-left 2}
        equal     {:stroke-width 2 :stroke-width-top 2 :stroke-width-right 2
                   :stroke-width-bottom 2 :stroke-width-left 2}]
    (t/is (true? (cts/per-side-stroke? {:type :rect} different)))
    (t/is (true? (cts/per-side-stroke? {:type :frame} different)))
    (t/is (false? (cts/per-side-stroke? {:type :rect} equal)))
    (t/is (false? (cts/per-side-stroke? {:type :circle} different)))
    (t/is (false? (cts/per-side-stroke? {:type :path} different)))))

(t/deftest max-side-width-takes-the-widest-side
  (t/is (== 8 (cts/max-side-width {:stroke-width 2 :stroke-width-top 2 :stroke-width-right 4
                                   :stroke-width-bottom 6 :stroke-width-left 8})))
  (t/is (== 2 (cts/max-side-width {:stroke-width 2}))))

(t/deftest padding-of-outer-stroke-uses-widest-side
  (let [uniform {:strokes [{:stroke-alignment :outer :stroke-style :solid :stroke-width 2}]
                 :type :rect}
        per-side {:strokes [{:stroke-alignment :outer :stroke-style :solid :stroke-width 2
                             :stroke-width-top 2 :stroke-width-right 10
                             :stroke-width-bottom 2 :stroke-width-left 2}]
                  :type :rect}]
    (t/testing "a uniform outer stroke keeps its margin"
      (t/is (== 3 (:horizontal (gsb/calculate-padding uniform)))))
    (t/testing "a wide outer side sets the margin"
      (t/is (== 15 (:horizontal (gsb/calculate-padding per-side)))))))
