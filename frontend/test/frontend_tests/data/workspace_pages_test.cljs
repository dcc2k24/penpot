;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.workspace-pages-test
  (:require
   [app.common.data :as d]
   [app.common.files.changes-builder :as pcb]
   [app.common.test-helpers.files :as cthf]
   [app.common.test-helpers.ids-map :as cthi]
   [app.common.types.objects-map :as omap]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.main.data.workspace.pages :as dwpg]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [clojure.datafy :refer [datafy]]
   [frontend-tests.helpers.state :as ths]))

(t/use-fixtures :each
  {:before cthi/reset-idmap!})

(defn- pages
  [state]
  (let [file-id (:current-file-id state)]
    (get-in state [:files file-id :data :pages])))

(defn- make-five-pages
  []
  (-> (cthf/sample-file :file1 :page-label :page1)
      (cthf/add-sample-page :page2)
      (cthf/add-sample-page :page3)
      (cthf/add-sample-page :page4)
      (cthf/add-sample-page :page5)
      (cthf/switch-to-page :page1)))

;; ---------------------------------------------------------------------------
;; Verify the order of undo changes so that when pages are restored they
;; appear in the original page order (not reversed).
;; ---------------------------------------------------------------------------

(defn- add-page-ids-from-undo-changes
  "Extract the sequence of page ids from the `:add-page` undo changes list."
  [changes]
  (->> (:undo-changes changes)
       (keep (fn [change]
               (when (= :add-page (:type change))
                 (:id change))))))

(t/deftest delete-pages-undo-changes-are-in-page-order
  (let [file      (make-five-pages)
        fdata     (:data file)
        pindex    (:pages-index fdata)
        pages     (:pages fdata)
        page2-id  (cthi/id :page2)
        page4-id  (cthi/id :page4)
        del-ids   (filter #{page2-id page4-id} pages)

        ;; Simulate the reduction from delete-pages but in REVERSE order
        ;; (the fix iterates (reverse del-ids) so undo changes are in correct order)
        changes   (reduce
                   (fn [changes id]
                     (let [page (-> (get pindex id)
                                    (assoc :index (d/index-of pages id)))]
                       (pcb/del-page changes page)))
                   (pcb/empty-changes)
                   del-ids)

        undo-before-fix (add-page-ids-from-undo-changes changes)

        changes-fixed   (reduce
                         (fn [changes id]
                           (let [page (-> (get pindex id)
                                          (assoc :index (d/index-of pages id)))]
                             (pcb/del-page changes page)))
                         (pcb/empty-changes)
                         (reverse del-ids))

        undo-after-fix (add-page-ids-from-undo-changes changes-fixed)]

    (t/is (= [page4-id page2-id] undo-before-fix)
          "before fix: undo changes are reversed (page order)")
    (t/is (= [page2-id page4-id] undo-after-fix)
          "after fix: undo changes are in correct page order")))

;; ---------------------------------------------------------------------------
;; delete-pages removes the correct pages and keeps remaining pages in order
;; ---------------------------------------------------------------------------

(t/deftest delete-pages-removes-pages-and-keeps-remaining-in-order
  (t/async
    done
    (let [file      (make-five-pages)
          page2-id  (cthi/id :page2)
          page4-id  (cthi/id :page4)
          store     (ths/setup-store file)
          events    [(dwpg/delete-pages [page2-id page4-id])]]

      (ths/run-store
       store done events
       (fn [state]
         (let [pgs (pages state)]
           (t/is (= 3 (count pgs))
                 "3 pages remain after deleting 2")
           (t/is (= [(cthi/id :page1) (cthi/id :page3) (cthi/id :page5)]
                    pgs)
                 "remaining pages stay in the original order")))))))

;; ---------------------------------------------------------------------------
;; delete-pages keeps at least one page in the file
;; ---------------------------------------------------------------------------

(t/deftest delete-pages-keeps-at-least-one-page
  (t/async
    done
    (let [file      (make-five-pages)
          page1-id  (cthi/id :page1)
          page2-id  (cthi/id :page2)
          page3-id  (cthi/id :page3)
          page4-id  (cthi/id :page4)
          page5-id  (cthi/id :page5)
          store     (ths/setup-store file)
          events    [(dwpg/delete-pages [page1-id page2-id page3-id page4-id page5-id])]]

      (ths/run-store
       store done events
       (fn [state]
         (let [pgs (pages state)]
           (t/is (= 1 (count pgs))
                 "at least one page remains")
           (t/is (= page1-id (first pgs))
                 "the first page (in page order) is kept")))))))

;; ---------------------------------------------------------------------------
;; The media prefetch reads only the shapes that may hold media, so it does
;; not decode (and keep decoded) every shape of a large page.
;; ---------------------------------------------------------------------------

(defn- media-fixture
  "A plain rect, an image shape and a rect with a legacy `:fill-image`, all
  in an objects map that holds only raw strings, as a loaded page does."
  []
  (let [rect-id   (uuid/next)
        image-id  (uuid/next)
        legacy-id (uuid/next)
        base      {:x 0 :y 0 :width 10 :height 10
                   :parent-id uuid/zero :frame-id uuid/zero}
        rect      (cts/setup-shape (assoc base :id rect-id :type :rect))
        image     (cts/setup-shape (assoc base :id image-id :type :image
                                          :metadata {:id (uuid/next) :width 10 :height 10
                                                     :mtype "image/png"}))
        legacy    (-> (cts/setup-shape (assoc base :id legacy-id :type :rect))
                      (assoc :fill-image {:id (uuid/next) :width 10 :height 10
                                          :mtype "image/png"}))
        objects   (omap/from-data
                   (omap/raw-data (omap/wrap {rect-id rect image-id image legacy-id legacy})))]
    {:objects objects :rect-id rect-id :image-id image-id :legacy-id legacy-id :rect rect}))

(t/deftest may-hold-media-reads-the-raw-strings
  (let [{:keys [objects rect-id image-id legacy-id rect]} (media-fixture)
        may-hold? #'dwpg/may-hold-media?]
    (t/is (true? (may-hold? objects image-id)) "an image shape names :metadata")
    (t/is (true? (may-hold? objects legacy-id)) "a legacy fill image names :fill-image")
    (t/is (false? (may-hold? objects rect-id)) "a plain rect has no media")
    (t/is (true? (may-hold? (assoc objects rect-id rect) rect-id))
          "an entry set after decoding has no raw string, so it is read")
    (t/is (empty? (:cache (datafy objects))) "no shape was decoded")))

(t/deftest shapes-in-idle-decodes-only-the-shapes-that-pass
  (t/async done
    (let [{:keys [objects image-id legacy-id]} (media-fixture)
          seen (volatile! [])]
      (rx/subscribe
       (#'dwpg/shapes-in-idle objects (partial #'dwpg/may-hold-media? objects))
       (fn [shape] (vswap! seen conj (:id shape)))
       (fn [cause]
         (t/is false (str cause))
         (done))
       (fn []
         (t/is (= #{image-id legacy-id} (set @seen)) "only the media shapes are emitted")
         (t/is (= #{image-id legacy-id} (set (keys (:cache (datafy objects)))))
               "only the media shapes are decoded")
         (done))))))

(t/deftest layer-tree-ids-names-two-levels-under-the-root
  (let [frame-id (uuid/next)
        child-id (uuid/next)
        deep-id  (uuid/next)
        base     {:x 0 :y 0 :width 10 :height 10}
        root     (cts/setup-shape (assoc base :id uuid/zero :type :frame
                                         :parent-id uuid/zero :frame-id uuid/zero
                                         :shapes [frame-id]))
        frame    (cts/setup-shape (assoc base :id frame-id :type :frame
                                         :parent-id uuid/zero :frame-id uuid/zero
                                         :shapes [child-id]))
        child    (cts/setup-shape (assoc base :id child-id :type :group
                                         :parent-id frame-id :frame-id frame-id
                                         :shapes [deep-id]))
        deep     (cts/setup-shape (assoc base :id deep-id :type :rect
                                         :parent-id child-id :frame-id frame-id))
        objects  (omap/from-data
                  (omap/raw-data (omap/wrap {uuid/zero root frame-id frame
                                             child-id child deep-id deep})))]
    (t/is (= [frame-id child-id] (vec (#'dwpg/layer-tree-ids objects))))
    (t/is (not (contains? (:cache (datafy objects)) deep-id))
          "the shapes below the second level are not decoded")))
