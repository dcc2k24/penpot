;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns common-tests.logic.modifiers-test
  "Unit tests of the modifier rules that `app.common.logic.modifiers` shares
  with the frontend and the MCP compiler."
  (:require
   [app.common.geom.rect :as grc]
   [app.common.logic.modifiers :as lm]
   [app.common.types.modifiers :as ctm]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [clojure.test :as t]))

(defn- rect-shape
  "A plain rect `id` at `x` and `y`, of the size `w` and `h`."
  [id x y w h]
  {:id id :type :rect :selrect (grc/make-rect x y w h)})

(t/deftest check-delta-accepts-an-unchanged-copy-shape
  (let [check-delta lm/check-delta
        root        (rect-shape (uuid/next) 0 0 100 100)
        shape       (rect-shape (uuid/next) 10 10 20 20)]
    (t/is (true? (check-delta shape root shape root)))))

(t/deftest check-delta-refuses-a-move-of-a-copy-shape
  (let [check-delta lm/check-delta
        root        (rect-shape (uuid/next) 0 0 100 100)
        shape       (rect-shape (uuid/next) 10 10 20 20)
        moved       (rect-shape (:id shape) 20 10 20 20)]
    (t/is (false? (check-delta shape root moved root)))))

(t/deftest check-delta-refuses-a-resize-of-a-copy-shape
  (let [check-delta lm/check-delta
        root        (rect-shape (uuid/next) 0 0 100 100)
        shape       (rect-shape (uuid/next) 10 10 20 20)
        resized     (rect-shape (:id shape) 10 10 30 20)]
    (t/is (false? (check-delta shape root resized root)))))

(t/deftest check-delta-ignores-a-move-under-one-pixel
  (let [check-delta lm/check-delta
        root        (rect-shape (uuid/next) 0 0 100 100)
        shape       (rect-shape (uuid/next) 10 10 20 20)
        nudged      (rect-shape (:id shape) 10.5 10 20 20)]
    (t/is (true? (check-delta shape root nudged root)))))

(t/deftest transform-attrs-cover-the-geometry-and-layout-attrs
  (let [attrs lm/transform-attrs]
    (t/is (contains? attrs :selrect))
    (t/is (contains? attrs :transform))
    (t/is (contains? attrs :layout-gap))
    (t/is (contains? attrs :fills))
    (t/is (not (contains? attrs :name)))
    (t/is (not (contains? attrs :touched)))))

(t/deftest calculate-ignore-tree-frees-a-moved-component-root
  (let [calculate-ignore-tree lm/calculate-ignore-tree
        root-id (uuid/next)
        root    (-> (cts/setup-shape {:type :rect :x 0 :y 0 :width 10 :height 10})
                    (assoc :id root-id
                           :component-root true
                           :shape-ref (uuid/next)))
        objects {root-id root}
        moved   {root-id {:modifiers (ctm/move-modifiers 10 0)}}]
    ;; A component root moved on its own is a free change, so its geometry
    ;; is ignored and the copy stays untouched
    (t/is (true? (get (calculate-ignore-tree moved objects) root-id)))))

(t/deftest calculate-ignore-tree-skips-shapes-outside-copies
  (let [calculate-ignore-tree lm/calculate-ignore-tree
        id      (uuid/next)
        shape   (-> (cts/setup-shape {:type :rect :x 0 :y 0 :width 10 :height 10})
                    (assoc :id id))
        moved   {id {:modifiers (ctm/move-modifiers 10 0)}}]
    (t/is (empty? (calculate-ignore-tree moved {id shape})))))

(t/deftest calculate-ignore-tree-marks-a-moved-copy-child
  (let [calculate-ignore-tree lm/calculate-ignore-tree
        root-id  (uuid/next)
        child-id (uuid/next)
        root     (-> (cts/setup-shape {:type :frame :x 0 :y 0 :width 100 :height 100})
                     (assoc :id root-id
                            :component-root true
                            :shape-ref (uuid/next)
                            :shapes [child-id]))
        child    (-> (cts/setup-shape {:type :rect :x 10 :y 10 :width 20 :height 20})
                     (assoc :id child-id
                            :parent-id root-id
                            :frame-id root-id
                            :shape-ref (uuid/next)))
        objects  {root-id root child-id child}
        moved    {child-id {:modifiers (ctm/move-modifiers 20 0)}}]
    ;; The copy child moves away from its root, so it is touched
    (t/is (false? (get (calculate-ignore-tree moved objects) child-id)))))
