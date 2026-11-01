;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns common-tests.types-shape-tree-test
  (:require
   [app.common.geom.point :as gpt]
   [app.common.types.shape-tree :as ctt]
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

(t/deftest top-nested-frame-clip-content-test
  (t/testing "board A (clip) contains a wider board B; point inside both resolves to B"
    (let [a-id     (uuid/next)
          b-id     (uuid/next)
          objects  {a-id (make-frame a-id uuid/zero [b-id] 0 0 200 200 false)
                    b-id (make-frame b-id a-id [] 50 50 300 300 false)}
          position (gpt/point 150 150)
          result   (ctt/top-nested-frame objects position)]
      (t/is (= b-id result))))

  (t/testing "point inside B but outside A's clipped bounds is not reachable at all"
    (let [a-id     (uuid/next)
          b-id     (uuid/next)
          objects  {a-id (make-frame a-id uuid/zero [b-id] 0 0 200 200 false)
                    b-id (make-frame b-id a-id [] 50 50 300 300 false)}
          position (gpt/point 300 300)
          result   (ctt/top-nested-frame objects position)]
      ;; Outside A (the clip ancestor) and B's visible/clipped region there is
      ;; not visible either, so no frame should be resolved at that point.
      (t/is (= uuid/zero result))))

  (t/testing "with show-content true on A, the same point can resolve into B"
    (let [a-id     (uuid/next)
          b-id     (uuid/next)
          objects  {a-id (make-frame a-id uuid/zero [b-id] 0 0 200 200 true)
                    b-id (make-frame b-id a-id [] 50 50 300 300 false)}
          position (gpt/point 300 300)
          result   (ctt/top-nested-frame objects position)]
      (t/is (= b-id result)))))

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

(t/deftest get-frames-by-position-clipping-test
  ;; a (clips, 0..100) > g (group) > a1 (40..240, sticks out of a)
  ;; b (shows content, 300..400) > b1 (350..550, sticks out of b)
  ;; c (clips, 600..700) > c1 (clips, 600..650) > c2 (620..800)
  (let [a  (uuid/next) g  (uuid/next) a1 (uuid/next)
        b  (uuid/next) b1 (uuid/next)
        c  (uuid/next) c1 (uuid/next) c2 (uuid/next)
        objects {uuid/zero {:id uuid/zero :type :frame :parent-id uuid/zero
                            :frame-id uuid/zero :shapes [a b c]
                            :x 0 :y 0 :width 0 :height 0}
                 a  (make-frame a uuid/zero [g] 0 0 100 100 false)
                 g  (make-group g a [a1])
                 a1 (make-frame a1 g [] 40 40 200 50 false)
                 b  (make-frame b uuid/zero [b1] 300 0 100 100 true)
                 b1 (make-frame b1 b [] 350 40 200 50 false)
                 c  (make-frame c uuid/zero [c1] 600 0 100 100 false)
                 c1 (make-frame c1 c [c2] 600 0 50 100 false)
                 c2 (make-frame c2 c1 [] 620 40 180 50 false)}
        ids-at  (fn [x y]
                  (set (map :id (ctt/get-frames-by-position objects (gpt/point x y)))))]
    (t/testing "a frame inside a clipping board counts only within the board"
      (t/is (= #{a a1} (ids-at 50 50)))
      (t/is (= #{} (ids-at 150 50))))

    (t/testing "a board that shows its content does not hide its children"
      (t/is (= #{b b1} (ids-at 380 50)))
      (t/is (= #{b1} (ids-at 500 50))))

    (t/testing "any clipping ancestor hides the frame"
      (t/is (= #{c c1 c2} (ids-at 630 50)))
      (t/is (= #{c} (ids-at 680 50)))
      (t/is (= #{} (ids-at 750 50))))

    (t/testing "no position, no frames"
      (t/is (empty? (ctt/get-frames-by-position objects nil))))))

(defn- root-frame-ids-by-filter
  "The board-title selection before `get-top-level-frames-ids`: every frame,
  then those whose parent is the root."
  [objects options]
  (into []
        (comp (map #(get objects %))
              (filter #(= uuid/zero (:parent-id %)))
              (map :id))
        (ctt/get-frames-ids objects (assoc options :ignore-index? true))))

(t/deftest get-top-level-frames-ids-test
  (let [f1-id   (uuid/next)
        f2-id   (uuid/next)
        f3-id   (uuid/next)
        r1-id   (uuid/next)
        copy-id (uuid/next)
        main-id (uuid/next)
        objects {uuid/zero {:id uuid/zero
                            :type :frame
                            :parent-id uuid/zero
                            :frame-id uuid/zero
                            :shapes [f1-id r1-id f2-id copy-id main-id]}
                 f1-id     (make-frame f1-id uuid/zero [] 0 0 10 10 false)
                 f2-id     (make-frame f2-id uuid/zero [f3-id] 20 0 10 10 false)
                 f3-id     (make-frame f3-id f2-id [] 20 0 5 5 false)
                 r1-id     {:id r1-id :type :rect :parent-id uuid/zero :frame-id uuid/zero}
                 copy-id   (assoc (make-frame copy-id uuid/zero [] 40 0 10 10 false)
                                  :component-id (uuid/next))
                 main-id   (assoc (make-frame main-id uuid/zero [] 60 0 10 10 false)
                                  :component-id (uuid/next)
                                  :main-instance true)}]

    (t/testing "same frames as filtering every frame by parent"
      (doseq [options [nil {:skip-copies? true} {:skip-components? true}]]
        (t/is (= (set (root-frame-ids-by-filter objects options))
                 (set (ctt/get-top-level-frames-ids objects options))))))

    (t/testing "in the order of the root shapes, missing ids skipped"
      (let [missing-id (uuid/next)
            objects    (assoc-in objects [uuid/zero :shapes]
                                 [main-id missing-id copy-id f2-id r1-id f1-id])]
        (t/is (= [main-id copy-id f2-id f1-id]
                 (ctt/get-top-level-frames-ids objects)))))

    (t/testing "only root boards, copies skipped on request"
      (t/is (= #{f1-id f2-id main-id}
               (set (ctt/get-top-level-frames-ids objects {:skip-copies? true}))))
      (t/is (= #{f1-id f2-id}
               (set (ctt/get-top-level-frames-ids objects {:skip-components? true})))))

    (t/testing "a page without root children has no top-level frames"
      (t/is (= [] (ctt/get-top-level-frames-ids {})))
      (t/is (= [] (ctt/get-top-level-frames-ids
                   {uuid/zero {:id uuid/zero :type :frame :shapes []}}))))))
