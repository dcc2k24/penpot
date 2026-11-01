;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns common-tests.types.objects-hints-test
  (:require
   [app.common.files.helpers :as cfh]
   [app.common.geom.point :as gpt]
   [app.common.types.objects-hints :as ohints]
   [app.common.types.objects-map :as omap]
   [app.common.types.shape-tree :as ctst]
   [app.common.uuid :as uuid]
   [clojure.test :as t]))

(defn- make-frame
  [id parent-id shapes x y width height show-content]
  {:id id
   :type :frame
   :parent-id parent-id
   :frame-id parent-id
   :shapes (vec shapes)
   :x x
   :y y
   :width width
   :height height
   :rotation nil
   :hidden false
   :blocked false
   :show-content show-content})

(defn- make-group
  [id parent-id shapes]
  {:id id
   :type :group
   :parent-id parent-id
   :frame-id parent-id
   :shapes (vec shapes)
   :x 0
   :y 0
   :width 10
   :height 10
   :rotation nil
   :hidden false
   :blocked false})

(defn- make-rect
  [id parent-id x y width height]
  {:id id
   :type :rect
   :parent-id parent-id
   :frame-id parent-id
   :x x
   :y y
   :width width
   :height height
   :rotation nil})

(defn- make-text
  [id parent-id]
  {:id id
   :type :text
   :parent-id parent-id
   :frame-id parent-id
   :x 0
   :y 0
   :width 10
   :height 10
   :rotation nil
   :content {:type "root"
             :children [{:type "paragraph-set"
                         :children [{:type "paragraph"
                                     :children [{:text "a" :font-id "f1" :font-family "F1"}
                                                {:text "b" :font-id "f2" :font-family "F2"}
                                                {:text "c"}]}]}]}})

(defn- make-page
  "Returns the shapes of a page, and the ids of its named shapes.

  a (clips) > g (group) > a1 (nested frame, sticks out of a)
  b (shows content) > b1 (nested frame, sticks out of b)
  c (clips) > c1 (clips) > c2 (nested frame, sticks out of c1)
  r (rect) and tx (text), both at the root."
  []
  (let [ids (zipmap [:a :g :a1 :b :b1 :c :c1 :c2 :r :tx] (repeatedly uuid/next))
        {:keys [a g a1 b b1 c c1 c2 r tx]} ids
        shapes {uuid/zero (make-frame uuid/zero uuid/zero [a b c r tx] 0 0 0 0 false)
                a  (make-frame a uuid/zero [g] 0 0 100 100 false)
                g  (make-group g a [a1])
                a1 (make-frame a1 g [] 40 40 200 50 false)
                b  (make-frame b uuid/zero [b1] 300 0 100 100 true)
                b1 (make-frame b1 b [] 350 40 200 50 false)
                c  (make-frame c uuid/zero [c1] 600 0 100 100 false)
                c1 (make-frame c1 c [c2] 600 0 50 100 false)
                c2 (make-frame c2 c1 [] 620 40 180 50 false)
                r  (make-rect r uuid/zero 10 300 20 20)
                tx (make-text tx uuid/zero)}]
    [shapes ids]))

(defn- position-cases
  "The positions of the page of `make-page`, with the frames expected there."
  [{:keys [a a1 b b1 c c1 c2]}]
  [[[50 50] #{a a1}]
   [[150 50] #{}]
   [[380 50] #{b b1}]
   [[500 50] #{b1}]
   [[630 50] #{c c1 c2}]
   [[680 50] #{c}]
   [[750 50] #{}]])

(defn- ids-at
  "Returns the ids of the frames at the point x, y."
  [objects x y]
  (set (map :id (ctst/get-frames-by-position objects (gpt/point x y)))))

(defn- make-hints
  "Makes the hints of `objects` the way the workers do: one shape hint for
  every shape, made from its raw encoded string."
  [objects]
  (reduce (fn [hints id]
            (let [[kind data] (ohints/shape-hint (get objects id))]
              (case kind
                :frame (assoc-in hints [:frames id] data)
                :text  (assoc-in hints [:texts id] data)
                hints)))
          {:raw (omap/raw-data objects) :frames {} :texts {}}
          (keys (omap/raw-data objects))))

(t/deftest known-test
  (let [a       (uuid/next)
        b       (uuid/next)
        objects (omap/wrap {a (make-rect a uuid/zero 0 0 5 5)
                            b (make-rect b uuid/zero 0 0 5 5)})
        hints   {:raw (omap/raw-data objects)}]
    (t/testing "an untouched id is known"
      (t/is (ohints/known? hints objects a))
      (t/is (ohints/known? hints objects b)))

    (t/testing "an id that is set again is not known, the others are"
      (let [changed (assoc objects a (make-rect a uuid/zero 0 0 9 9))]
        (t/is (not (ohints/known? hints changed a)))
        (t/is (ohints/known? hints changed b))))

    (t/testing "a plain map and a missing id are never known"
      (t/is (not (ohints/known? hints {a (make-rect a uuid/zero 0 0 5 5)} a)))
      (t/is (not (ohints/known? hints objects (uuid/next)))))))

(t/deftest select-ids-test
  (let [f       (uuid/next)
        r       (uuid/next)
        c       (uuid/next)
        objects (omap/wrap {f (make-frame f uuid/zero [] 0 0 10 10 false)
                            r (make-rect r uuid/zero 0 0 5 5)
                            c (make-rect c uuid/zero 0 0 5 5)})
        hints   {:raw (omap/raw-data objects)}
        hinted? #{f r}
        changed (assoc objects c (make-frame c uuid/zero [] 0 0 5 5 false))]

    (t/testing "a known id takes the hinted test, not the shape test"
      ;; r is not a frame, but the hint says it is selected
      (t/is (= #{f r} (set (ohints/select-ids objects hints hinted? cfh/frame-shape?)))))

    (t/testing "a changed id takes the shape test"
      ;; c is a frame now, the hint for c is not used
      (t/is (= #{f r c} (set (ohints/select-ids changed hints hinted? cfh/frame-shape?)))))))

(t/deftest frame-bounds-test
  (let [frame (make-frame (uuid/next) uuid/zero [] 10 20 30 40 false)]
    (t/testing "an unrotated frame is its own box"
      (t/is (= [10 20 40 60] (ohints/frame-bounds frame))))

    (t/testing "the points of a rotated frame widen the box"
      (let [rotated (assoc frame
                           :rotation 45
                           :points [{:x 5 :y 25} {:x 50 :y 15}
                                    {:x 45 :y 70} {:x 0 :y 60}])]
        (t/is (= [0 15 50 70] (ohints/frame-bounds rotated)))))

    (t/testing "a missing or not finite number gives no box"
      (t/is (nil? (ohints/frame-bounds (dissoc frame :x))))
      (t/is (nil? (ohints/frame-bounds (assoc frame :width ##NaN))))
      (t/is (nil? (ohints/frame-bounds (assoc frame :height ##Inf))))
      (t/is (nil? (ohints/frame-bounds (assoc frame :points [{:x ##NaN :y 0}])))))))

(t/deftest may-contain-point-test
  (let [bounds [0 0 10 10]]
    (t/is (ohints/may-contain-point? bounds (gpt/point 5 5)))
    (t/is (ohints/may-contain-point? bounds (gpt/point 10 10)))
    (t/is (ohints/may-contain-point? bounds (gpt/point 10.005 -0.005)))
    (t/is (not (ohints/may-contain-point? bounds (gpt/point 10.02 5))))
    (t/is (not (ohints/may-contain-point? bounds (gpt/point 5 -0.02))))
    (t/is (ohints/may-contain-point? nil (gpt/point 1000 1000)))))

(t/deftest shape-hint-test
  (let [frame (make-frame (uuid/next) uuid/zero [] 10 20 30 40 false)
        text  (make-text (uuid/next) uuid/zero)]
    (t/is (= [:frame {:bounds [10 20 40 60] :grid? false}]
             (ohints/shape-hint frame)))

    (t/is (= [:frame {:bounds [10 20 40 60] :grid? true}]
             (ohints/shape-hint (assoc frame :grids [{:display true}]))))

    (t/is (= [:frame {:bounds [10 20 40 60] :grid? false}]
             (ohints/shape-hint (assoc frame :grids [{:display false}]))))

    (t/is (= [:text {:font-ids ["f1" "f2"] :no-position-data? true}]
             (ohints/shape-hint text)))

    (t/is (nil? (ohints/shape-hint (make-rect (uuid/next) uuid/zero 0 0 5 5))))))

(t/deftest frame-index-ids-test
  (let [[shapes ids] (make-page)
        frame-ids    (set (map ids [:a :a1 :b :b1 :c :c1 :c2]))
        page         (ctst/start-page-index shapes)]
    (t/testing "every frame is indexed, the root is not"
      (t/is (= frame-ids (set (ctst/get-frame-index-ids shapes))))
      (t/is (= frame-ids (set (ctst/get-frame-index-ids page))))
      (t/is (= frame-ids (set (ctst/get-frames-ids page))))
      (t/is (= frame-ids (set (ctst/get-frames-ids shapes {:ignore-index? true})))))))

(t/deftest frames-by-position-test
  (let [[shapes ids] (make-page)
        page         (ctst/start-page-index shapes)]
    (t/testing "frames at a position, nested and clipped ones included"
      (doseq [[[x y] expected] (position-cases ids)]
        (t/is (= expected (ids-at page x y)))))

    (t/testing "no position, no frames"
      (t/is (empty? (ctst/get-frames-by-position page nil))))))

#?(:cljs
   (t/deftest hinted-frames-test
     (let [[shapes ids] (make-page)
           page   (omap/wrap shapes)
           hints  (make-hints page)
           hinted (ctst/start-page-index (ohints/with-hints page hints))
           plain  (ctst/start-page-index (omap/wrap shapes))]

       (t/testing "the index keeps the hints"
         (t/is (= hints (ohints/hints hinted))))

       (t/testing "the same frames with and without hints"
         (t/is (= (set (ctst/get-frame-index-ids plain))
                  (set (ctst/get-frame-index-ids hinted))))
         (t/is (= (set (ctst/get-frames-ids plain))
                  (set (ctst/get-frames-ids hinted)))))

       (t/testing "the same frames at each position"
         (doseq [[[x y] expected] (position-cases ids)]
           (t/is (= expected (ids-at plain x y)))
           (t/is (= expected (ids-at hinted x y)))))

       (t/testing "no position, no frames"
         (t/is (empty? (ctst/get-frames-by-position hinted nil)))))))

#?(:cljs
   (t/deftest hinted-frames-after-change-test
     (let [[shapes ids] (make-page)
           {:keys [b b1]} ids
           page    (omap/wrap shapes)
           hints   (make-hints page)
           hinted  (ctst/start-page-index (ohints/with-hints page hints))
           ;; b1 moves to x 900, its hint still has the box at x 350
           moved   (make-frame b1 b [] 900 40 200 50 false)
           changed-hinted (assoc hinted b1 moved)
           changed-plain  (ctst/start-page-index (omap/wrap (assoc shapes b1 moved)))]

       (t/testing "the changed shape has no valid hint"
         (t/is (not (ohints/known? hints changed-hinted b1)))
         (t/is (ohints/known? hints changed-hinted b)))

       (t/testing "the original page uses the hint box of b1"
         (t/is (= #{} (ids-at hinted 950 50)))
         (t/is (= #{b b1} (ids-at hinted 380 50))))

       (t/testing "a stale hint is not used after a change"
         (t/is (= #{b1} (ids-at changed-plain 950 50)))
         (t/is (= #{b1} (ids-at changed-hinted 950 50)))
         (t/is (= #{b} (ids-at changed-plain 380 50)))
         (t/is (= #{b} (ids-at changed-hinted 380 50)))))))

#?(:cljs
   (t/deftest hints-survive-update-test
     (let [[shapes ids] (make-page)
           page    (omap/wrap shapes)
           hints   (make-hints page)
           updated (ctst/update-page-index (ohints/with-hints page hints))]
       (t/is (= hints (ohints/hints updated)))
       (t/is (ohints/known? hints updated (:a ids)))
       (t/is (= (set (ctst/get-frame-index-ids (ctst/start-page-index (omap/wrap shapes))))
                (set (ctst/get-frame-index-ids updated))))
       (t/is (= #{(:a ids) (:a1 ids)} (ids-at updated 50 50))))))
