;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.logic.translate-commit-test
  "Covers the commit of a pure translation. Moving a board moves every
   shape inside it, moving a shape inside a group or a boolean still
   resizes that parent, and undo restores the previous geometry."
  (:require
   [app.common.geom.point :as gpt]
   [app.common.math :as mth]
   [app.common.test-helpers.compositions :as ctho]
   [app.common.test-helpers.files :as cthf]
   [app.common.test-helpers.ids-map :as cthi]
   [app.common.test-helpers.shapes :as cths]
   [app.common.types.modifiers :as ctm]
   [app.common.types.pages-list :as ctpl]
   [app.common.types.path :as path]
   [app.common.types.shape-tree :as ctst]
   [app.main.data.changes :as dch]
   [app.main.data.workspace.modifiers :as dwm]
   [app.main.data.workspace.undo :as dwu]
   [app.render-wasm.api :as wasm.api]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [frontend-tests.helpers.state :as ths]
   [frontend-tests.helpers.wasm :as thw]
   [potok.v2.core :as ptk]))

(def ^:private original-calculate-bool wasm.api/calculate-bool)

;; Boolean content is computed by the renderer; use the CLJS version.
(t/use-fixtures :each
  {:before (fn []
             (cthi/reset-idmap!)
             (thw/setup-wasm-mocks!)
             (set! wasm.api/calculate-bool path/calc-bool-content)
             (set! path/wasm:calc-bool-content path/calc-bool-content))
   :after  (fn []
             (set! wasm.api/calculate-bool original-calculate-bool)
             (set! path/wasm:calc-bool-content nil)
             (thw/teardown-wasm-mocks!))})

(defn- board-with-group
  "Board > group > rect, with the group bounds matching the rect."
  []
  (-> (cthf/sample-file :file1)
      (ctho/add-frame :board :x 0 :y 0 :width 400 :height 400)
      (ctho/add-group :group :parent-label :board :x 10 :y 10 :width 100 :height 100)
      (ctho/add-rect :rect :parent-label :group :x 10 :y 10 :width 100 :height 100)))

(defn- board-with-bool
  "Board > union bool > two rects, with the bool geometry computed from
   the rects: (10, 10) to (160, 160)."
  []
  (let [file (-> (cthf/sample-file :file1)
                 (ctho/add-frame :board :x 0 :y 0 :width 400 :height 400)
                 (cths/add-sample-shape :bool {:type :bool
                                               :bool-type :union
                                               :parent-label :board})
                 (ctho/add-rect :rect1 :x 10 :y 10 :width 100 :height 100 :parent-label :bool)
                 (ctho/add-rect :rect2 :x 60 :y 60 :width 100 :height 100 :parent-label :bool))
        page (cthf/current-page file)
        bool (path/update-bool-shape (cths/get-shape file :bool) (:objects page))]
    (update file :data ctpl/update-page (:id page) #(ctst/set-shape % bool))))

(defn- position
  [file label]
  (let [{:keys [x y]} (:selrect (cths/get-shape file label))]
    [x y]))

(defn- close-position?
  [[x1 y1] [x2 y2]]
  (and (mth/close? x1 x2) (mth/close? y1 y2)))

(defn- move
  [file label dx dy]
  (let [shape (cths/get-shape file label)]
    (dwm/apply-wasm-modifiers
     (dwm/create-modif-tree [(:id shape)] (ctm/move-modifiers (gpt/point dx dy)))
     :ignore-snap-pixel true)))

(defn- watch-undo-stack
  "Feeds local commits to the undo stack, as `initialize-workspace` does
  in the app."
  []
  (ptk/reify ::watch-undo-stack
    ptk/WatchEvent
    (watch [_ _ stream]
      (->> stream
           (rx/filter dch/commit?)
           (rx/map deref)
           (rx/filter #(= :local (:source %)))
           (rx/mapcat
            (fn [{:keys [save-undo? undo-changes redo-changes undo-group tags stack-undo? selected-before]}]
              (if (and save-undo? (seq undo-changes))
                (rx/of (dwu/append-undo
                        {:undo-changes undo-changes
                         :redo-changes redo-changes
                         :undo-group undo-group
                         :tags tags
                         :selected-before selected-before}
                        stack-undo?))
                (rx/empty))))
           (rx/take-until (rx/filter #(= :the/end %) stream))))))

(t/deftest board-drag-moves-every-descendant
  (t/async
    done
    (let [file   (board-with-group)
          store  (ths/setup-store file)
          events [(move file :board 50 30)]]
      (ths/run-store
       store done events
       (fn [new-state]
         (let [file' (ths/get-file-from-state new-state)]
           (t/is (close-position? [50 30] (position file' :board)))
           (t/is (close-position? [60 40] (position file' :group)))
           (t/is (close-position? [60 40] (position file' :rect)))))))))

(t/deftest moving-a-child-still-resizes-its-group
  (t/async
    done
    (let [file   (board-with-group)
          store  (ths/setup-store file)
          events [(move file :rect 50 30)]]
      (ths/run-store
       store done events
       (fn [new-state]
         (let [file' (ths/get-file-from-state new-state)]
           (t/is (close-position? [0 0] (position file' :board)))
           (t/is (close-position? [60 40] (position file' :rect)))
           (t/is (close-position? [60 40] (position file' :group)))))))))

(t/deftest moving-a-child-still-rebuilds-its-bool
  (t/async
    done
    (let [file   (board-with-bool)
          store  (ths/setup-store file)
          events [(move file :rect1 50 30)]]
      (ths/run-store
       store done events
       (fn [new-state]
         (let [file'    (ths/get-file-from-state new-state)
               selrect' (:selrect (cths/get-shape file' :bool))]
           (t/is (close-position? [0 0] (position file' :board)))
           (t/is (close-position? [60 40] (position file' :rect1)))
           ;; Union of (60, 40)-(160, 140) and (60, 60)-(160, 160)
           (t/is (close-position? [60 40] (position file' :bool)))
           (t/is (mth/close? 100 (:width selrect')))
           (t/is (mth/close? 120 (:height selrect')))))))))

(t/deftest undoing-a-board-drag-restores-every-descendant
  (t/async
    done
    (let [file   (board-with-group)
          store  (ths/setup-store file)
          events [(watch-undo-stack)
                  (move file :board 50 30)
                  dwu/undo]]
      (ths/run-store
       store done events
       (fn [new-state]
         (let [file' (ths/get-file-from-state new-state)]
           (t/is (close-position? [0 0] (position file' :board)))
           (t/is (close-position? [10 10] (position file' :group)))
           (t/is (close-position? [10 10] (position file' :rect)))))))))
