;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.render-wasm.tree-order-test
  "The chunked upload order of `wasm.api/set-objects` must match
  `shapes-in-tree-order`, and must look up each shape only when its chunk
  is taken."
  (:require
   [app.common.types.objects-map :as omap]
   [app.common.types.shape-tree :as ctt]
   [app.common.uuid :as uuid]
   [app.render-wasm.api :as wasm.api]
   [cljs.test :as t :include-macros true]
   [clojure.core.protocols :as cp]))

(defn- shape
  [id type parent-id children]
  {:id id :type type :parent-id parent-id :frame-id uuid/zero :shapes (vec children)})

(defn- sample-objects
  "A page with nested boards, a group, a shape referenced twice, a cycle and
  a dangling child id."
  []
  (let [b1      (uuid/next)
        b2      (uuid/next)
        g1      (uuid/next)
        r1      (uuid/next)
        r2      (uuid/next)
        r3      (uuid/next)
        c1      (uuid/next)
        c2      (uuid/next)
        missing (uuid/next)]
    {uuid/zero (shape uuid/zero :frame uuid/zero [b1 b2 c1])
     b1        (shape b1 :frame uuid/zero [g1 r1])
     g1        (shape g1 :group b1 [r2 r3 missing])
     r1        (shape r1 :rect b1 [])
     r2        (shape r2 :rect g1 [])
     r3        (shape r3 :rect g1 [])
     ;; r1 is also listed under b2
     b2        (shape b2 :frame uuid/zero [r1])
     ;; c1 -> c2 -> c1
     c1        (shape c1 :group uuid/zero [c2])
     c2        (shape c2 :group c1 [c1])}))

(defn- take-all
  "Takes every shape from `next-shapes!` in chunks of `n`."
  [next-shapes! n]
  (loop [shapes []]
    (let [chunk (next-shapes! n)]
      (t/is (<= (count chunk) n))
      (if (seq chunk)
        (recur (into shapes chunk))
        shapes))))

(defn- cached-count
  [objects]
  (count (:cache (cp/datafy objects))))

(t/deftest tree-order-source-matches-shapes-in-tree-order
  (let [objects  (sample-objects)
        expected (#'wasm.api/shapes-in-tree-order objects)]
    (t/is (= 11 (count expected))
          "root, every child once per parent, the cycle cut on its path, the dangling id dropped")
    (doseq [n [1 2 3 5 100 512]]
      (t/is (= (mapv :id expected)
               (mapv :id (take-all (#'wasm.api/tree-order-source objects) n)))
            (str "same order in chunks of " n)))
    (t/is (= expected
             (#'wasm.api/drain-source (#'wasm.api/tree-order-source objects))))))

(t/deftest tree-order-source-on-root-only
  (let [objects {uuid/zero (shape uuid/zero :frame uuid/zero [])}]
    (t/is (= [uuid/zero]
             (mapv :id (take-all (#'wasm.api/tree-order-source objects) 512))))))

(t/deftest prepend-source-keeps-chunk-sizes
  (let [objects  (sample-objects)
        expected (#'wasm.api/shapes-in-tree-order objects)
        source   (#'wasm.api/tree-order-source objects)
        head     (source 3)
        source   (#'wasm.api/prepend-source head source)
        chunk1   (source 5)]
    (t/is (= 5 (count chunk1)))
    (t/is (= (mapv :id expected)
             (mapv :id (into chunk1 (take-all source 5)))))))

(t/deftest vector-source-yields-the-vector
  (let [shapes (#'wasm.api/shapes-in-tree-order (sample-objects))]
    (t/is (= shapes (take-all (#'wasm.api/vector-source shapes) 4)))))

(t/deftest tree-order-source-decodes-chunk-by-chunk
  (let [objects (omap/create (omap/wrap (sample-objects)))
        source  (#'wasm.api/tree-order-source objects)]
    (t/is (zero? (cached-count objects)))
    (t/is (= [uuid/zero] (mapv :id (source 1))))
    (t/is (= 1 (cached-count objects))
          "the first chunk decodes the root only")
    (source 2)
    ;; The next chunk decodes only the two shapes it yields.
    (t/is (= 3 (cached-count objects)))
    (t/is (< (cached-count objects) (count objects)))))

(t/deftest top-level-frames-decode-root-children-only
  (let [plain   (sample-objects)
        objects (omap/create (omap/wrap plain))
        ids     (ctt/get-top-level-frames-ids objects {:skip-copies? true})]
    (t/is (= (set ids)
             (into #{}
                   (filter #(= :frame (:type (get plain %))))
                   (:shapes (get plain uuid/zero)))))
    ;; The root and its three children.
    (t/is (= 4 (cached-count objects)))))
