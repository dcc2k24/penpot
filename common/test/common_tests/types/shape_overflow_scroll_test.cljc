;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns common-tests.types.shape-overflow-scroll-test
  (:require
   [app.common.files.changes-builder :as pcb]
   [app.common.logic.shapes :as cls]
   [app.common.schema :as sm]
   [app.common.test-helpers.compositions :as tho]
   [app.common.test-helpers.files :as thf]
   [app.common.test-helpers.ids-map :as thi]
   [app.common.test-helpers.shapes :as ths]
   [app.common.types.component :as ctk]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [clojure.test :as t]))

(t/use-fixtures :each thi/test-fixture)

(defn- frame-with
  "A minimal frame shape carrying the given `:overflow-scroll` value."
  [value]
  (cts/setup-shape {:id (uuid/next)
                    :type :frame
                    :x 0
                    :y 0
                    :width 100
                    :height 100
                    :overflow-scroll value}))

(t/deftest frame-overflow-scroll-accepts-the-four-values
  (t/is (sm/validate cts/schema:shape-attrs (frame-with :none)))
  (t/is (sm/validate cts/schema:shape-attrs (frame-with :horizontal)))
  (t/is (sm/validate cts/schema:shape-attrs (frame-with :vertical)))
  (t/is (sm/validate cts/schema:shape-attrs (frame-with :both))))

(t/deftest frame-overflow-scroll-refuses-other-values
  (t/is (not (sm/validate cts/schema:shape-attrs (frame-with :diagonal))))
  ;; A string is not decoded yet, so the enum check refuses it.
  (t/is (not (sm/validate cts/schema:shape-attrs (frame-with "vertical")))))

(t/deftest rect-with-overflow-scroll-is-accepted-by-the-open-schema
  ;; `schema:rect-attrs` is an open map and the frame attrs are merged only
  ;; into the `:frame` branch. An extra key on a rect is not refused, and the
  ;; value is not checked against the frame enum.
  (let [rect (cts/setup-shape {:id (uuid/next)
                               :type :rect
                               :x 0
                               :y 0
                               :width 10
                               :height 10
                               :overflow-scroll :vertical})]
    (t/is (sm/validate cts/schema:shape-attrs rect))))

(t/deftest frame-overflow-scroll-decodes-from-json
  (let [frame   (-> (frame-with :none)
                    (assoc :type "frame"
                           :overflow-scroll "vertical"))
        decoded (sm/decode cts/schema:shape-attrs frame (sm/json-transformer))]
    (t/is (= :vertical (:overflow-scroll decoded)))
    (t/is (= :frame (:type decoded)))))

(t/deftest frame-overflow-scroll-has-its-own-sync-group
  ;; The scroll attribute is independent of `:show-content`, so each one
  ;; has its own group and changing one does not touch the other.
  (t/is (= :overflow-scroll (ctk/resolve-sync-group :frame :overflow-scroll)))
  (t/is (= :show-content (ctk/resolve-sync-group :frame :show-content)))
  (t/is (not= (ctk/resolve-sync-group :frame :show-content)
              (ctk/resolve-sync-group :frame :overflow-scroll))))

(defn- touched-after-root-update
  "Updates `attr` to `value` on the copy root of a simple component copy
  and returns the `:touched` set of that root."
  [attr value]
  (let [file      (-> (thf/sample-file :file1)
                      (tho/add-simple-component-with-copy :component1
                                                          :main-root
                                                          :main-child
                                                          :copy-root))
        page      (thf/current-page file)
        copy-root (ths/get-shape file :copy-root)

        changes   (cls/generate-update-shapes (pcb/empty-changes nil (:id page))
                                              #{(:id copy-root)}
                                              (fn [shape]
                                                (assoc shape attr value))
                                              (:objects page)
                                              {})

        file'     (thf/apply-changes file changes)]
    (:touched (ths/get-shape file' :copy-root))))

(t/deftest copy-root-overflow-scroll-touches-only-its-own-group
  (let [touched-overflow (touched-after-root-update :overflow-scroll :vertical)
        touched-show     (touched-after-root-update :show-content true)]
    (t/is (contains? touched-overflow :overflow-scroll))
    (t/is (not (contains? touched-overflow :show-content)))
    (t/is (contains? touched-show :show-content))
    (t/is (not (contains? touched-show :overflow-scroll)))))
