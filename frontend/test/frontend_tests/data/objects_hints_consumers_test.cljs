;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.objects-hints-consumers-test
  (:require
   [app.common.test-helpers.files :as cthf]
   [app.common.test-helpers.ids-map :as cthi]
   [app.common.test-helpers.shapes :as cths]
   [app.common.types.objects-hints :as ohints]
   [app.common.types.objects-map :as omap]
   [app.common.types.shape :as cts]
   [app.common.types.text :as txt]
   [app.main.data.workspace :as dw]
   [app.main.data.workspace.fix-deleted-fonts :as fdf]
   [app.main.fonts :as fonts]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [frontend-tests.helpers.state :as ths]
   [frontend-tests.helpers.wasm :as wasm]
   [potok.v2.core :as ptk]))

(t/use-fixtures :each
  {:before (fn []
             (cthi/reset-idmap!)
             (wasm/setup-wasm-mocks!))
   :after wasm/teardown-wasm-mocks!})

(def ^:private missing-font-id
  "custom-missing-font-id")

(def ^:private replacement-font-id
  "custom-gibson-replacement")

(defn- text-content
  [font-id font-family]
  (-> (cts/setup-shape {:type :text :x 0 :y 0 :grow-type :auto-width})
      :content
      (txt/change-text "TEST" :font-id font-id :font-family font-family)))

(defn- sample-page-file
  "A page with a frame with a displayed grid, a plain frame and four
  texts: one with a missing font, one with no font family, one with a
  valid font, and one that is changed after the hints are made."
  []
  (-> (cthf/sample-file :file1 :page-label :page1)
      (cths/add-sample-shape :grid-frame
                             {:type :frame
                              :grids [{:type :square
                                       :display true
                                       :params {:size 10}}]})
      (cths/add-sample-shape :plain-frame
                             {:type :frame})
      (cths/add-sample-shape :text-missing
                             {:type :text
                              :position-data nil
                              :content (text-content missing-font-id "Gibson")})
      (cths/add-sample-shape :text-no-family
                             {:type :text
                              :position-data nil
                              :content (text-content missing-font-id nil)})
      (cths/add-sample-shape :text-ok
                             {:type :text
                              :position-data []
                              :content (text-content replacement-font-id "Gibson")})
      (cths/add-sample-shape :text-changed
                             {:type :text
                              :position-data []
                              :content (text-content replacement-font-id "Gibson")})))

(defn- page-objects
  [file]
  (:objects (cthf/current-page file)))

(defn- changed-text
  "The text after an edit: no position data and a missing font."
  [shape]
  (-> shape
      (assoc :position-data nil)
      (assoc :content (text-content missing-font-id "Gibson"))))

(defn- hinted-objects
  "Returns `objects` as an objects map with the hints of its frames and
  texts attached, made the way the workers make them."
  [objects]
  (let [objects-map (omap/wrap objects)
        hints       (reduce-kv (fn [hints id shape]
                                 (if-some [[kind data] (ohints/shape-hint shape)]
                                   (assoc-in hints
                                             [(if (= kind :frame) :frames :texts) id]
                                             data)
                                   hints))
                               {:raw (omap/raw-data objects-map) :frames {} :texts {}}
                               objects-map)]
    (ohints/with-hints objects-map hints)))

(defn- state-with-objects
  [file objects]
  (assoc-in @(ths/setup-store file)
            [:files (:id file) :data :pages-index (cthf/current-page-id file) :objects]
            objects))

(defn- watch-events
  [event state]
  (let [events (atom [])]
    (when-let [result (ptk/watch event state (rx/empty))]
      (->> result (rx/subs! #(swap! events conj %))))
    @events))

(defn- redo-changes-of
  "The `:redo-changes` of the commit that `event` emits, or nil when it
  emits no commit."
  [event state]
  (when-let [[commit-event] (seq (watch-events event state))]
    (when-let [[commit] (seq (watch-events commit-event state))]
      (:redo-changes (deref commit)))))

(defn- position-changes
  [file objects]
  (redo-changes-of (dw/update-page-position-data (:id file) (cthf/current-page-id file))
                   (state-with-objects file objects)))

(defn- font-changes
  [file objects]
  (redo-changes-of (fdf/fix-deleted-fonts-for-page (:id file) (cthf/current-page-id file))
                   (state-with-objects file objects)))

(defn- with-replacement-font
  "Calls `f` with a font in the fonts db that can replace the missing one."
  [f]
  (try
    (swap! fonts/fontsdb assoc replacement-font-id
           {:id replacement-font-id
            :family "Gibson"
            :name "Gibson"
            :variants []})
    (f)
    (finally
      (swap! fonts/fontsdb dissoc replacement-font-id))))

(t/deftest position-data-changes-same-with-hints
  (let [file    (sample-page-file)
        objects (page-objects file)
        changes (position-changes file (omap/wrap objects))]
    (t/is (= #{(cthi/id :text-missing) (cthi/id :text-no-family)}
             (set (map :id changes)))
          "only the texts without position data get a change")
    (t/is (= changes (position-changes file (hinted-objects objects)))
          "the hints give the same changes")))

(t/deftest position-data-changes-same-after-text-changed
  (let [file    (sample-page-file)
        objects (page-objects file)
        id      (cthi/id :text-changed)
        changed (changed-text (get objects id))
        changes (position-changes file (omap/wrap (assoc objects id changed)))]
    (t/is (contains? (set (map :id changes)) id)
          "the changed text has no position data and gets a change")
    (t/is (= changes
             (position-changes file
                               (-> (hinted-objects objects)
                                   (assoc id changed))))
          "a text changed after the hints are made is read, not hinted")))

(t/deftest font-fixes-same-with-hints
  (with-replacement-font
    (fn []
      (let [file    (sample-page-file)
            objects (page-objects file)
            changes (font-changes file (omap/wrap objects))]
        (t/is (= #{(cthi/id :text-missing)} (set (map :id changes)))
              "only the text with a missing font and a font family gets a fix")
        (t/is (= changes (font-changes file (hinted-objects objects)))
              "the hints give the same fixes")))))

(t/deftest font-fixes-same-after-text-changed
  (with-replacement-font
    (fn []
      (let [file    (sample-page-file)
            objects (page-objects file)
            id      (cthi/id :text-changed)
            changed (changed-text (get objects id))
            changes (font-changes file (omap/wrap (assoc objects id changed)))]
        (t/is (= #{(cthi/id :text-missing) id} (set (map :id changes)))
              "the changed text gets a fix")
        (t/is (= changes
                 (font-changes file
                               (-> (hinted-objects objects)
                                   (assoc id changed))))
              "a text changed after the hints are made is read, not hinted")))))
