;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns frontend-tests.data.fix-deleted-fonts-test
  (:require
   [app.common.test-helpers.files :as cthf]
   [app.common.test-helpers.ids-map :as cthi]
   [app.common.test-helpers.shapes :as cths]
   [app.common.types.shape :as cts]
   [app.common.types.text :as txt]
   [app.main.data.changes :as dwc]
   [app.main.data.workspace.fix-deleted-fonts :as fdf]
   [app.main.fonts :as fonts]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [frontend-tests.helpers.state :as ths]
   [potok.v2.core :as ptk]))

(t/use-fixtures :each
  {:before cthi/reset-idmap!})

(def ^:private missing-font-id
  "custom-missing-font-id")

(defn- text-content-with-font
  [text font-id font-family]
  (-> (cts/setup-shape {:type :text :x 0 :y 0 :grow-type :auto-width})
      :content
      (txt/change-text text :font-id font-id :font-family font-family)))

(defn- file-with-text-shape
  [font-id font-family]
  (-> (cthf/sample-file :file1 :page-label :page1)
      (cths/add-sample-shape :text
                             {:type :text
                              :content (text-content-with-font "TEST"
                                                               font-id
                                                               font-family)})))

(defn- watch-events
  [event state]
  (let [events (atom [])]
    (when-let [result (ptk/watch event state (rx/empty))]
      (->> result (rx/subs! #(swap! events conj %))))
    @events))

(defn- watch-fix-deleted-fonts-events
  ([file]
   (watch-fix-deleted-fonts-events file nil))
  ([file opts]
   (let [store (ths/setup-store file)]
     (watch-events (fdf/fix-deleted-fonts-for-page (:id file)
                                                   (cthf/current-page-id file)
                                                   opts)
                   @store))))

(defn- committed-ignore-wasm?
  "The `:ignore-wasm?` of the commit the fix emits."
  [file opts]
  (let [store  (ths/setup-store file)
        [cc]   (watch-fix-deleted-fonts-events file opts)
        [cmt]  (watch-events cc @store)]
    (:ignore-wasm? (deref cmt))))

(t/deftest fix-deleted-fonts-skips-unfixable-missing-font
  (let [file   (file-with-text-shape missing-font-id "Gibson")
        events (watch-fix-deleted-fonts-events file)]
    (t/is (empty? events)
          "missing custom fonts with no replacement must not commit changes")))

(t/deftest fix-deleted-fonts-remaps-when-replacement-exists
  (let [replacement-id "custom-gibson-replacement"
        cleanup        #(swap! fonts/fontsdb dissoc replacement-id)]
    (try
      (swap! fonts/fontsdb assoc replacement-id
             {:id replacement-id
              :family "Gibson"
              :name "Gibson"
              :variants []})
      (let [file   (file-with-text-shape missing-font-id "Gibson")
            events (watch-fix-deleted-fonts-events file)]
        (t/is (= 1 (count events)))
        (t/is (ptk/type? ::dwc/commit-changes (first events))))
      (finally
        (cleanup)))))

(t/deftest fix-deleted-fonts-writes-to-wasm-on-request
  (let [replacement-id "custom-gibson-replacement"
        cleanup        #(swap! fonts/fontsdb dissoc replacement-id)]
    (try
      (swap! fonts/fontsdb assoc replacement-id
             {:id replacement-id
              :family "Gibson"
              :name "Gibson"
              :variants []})
      (let [file (file-with-text-shape missing-font-id "Gibson")]
        (t/is (true? (committed-ignore-wasm? file nil))
              "by default the page is not uploaded yet: skip WASM")
        (t/is (false? (committed-ignore-wasm? file {:ignore-wasm? false}))
              "after the upload the fixed texts go to WASM too"))
      (finally
        (cleanup)))))

(t/deftest fix-deleted-fonts-skips-texts-under-edition
  (let [replacement-id "custom-gibson-replacement"
        cleanup        #(swap! fonts/fontsdb dissoc replacement-id)]
    (try
      (swap! fonts/fontsdb assoc replacement-id
             {:id replacement-id
              :family "Gibson"
              :name "Gibson"
              :variants []})
      (let [file    (file-with-text-shape missing-font-id "Gibson")
            text-id (cthi/id :text)
            state   @(ths/setup-store file)
            fix     #(fdf/fix-deleted-fonts-for-page (:id file)
                                                     (cthf/current-page-id file))
            editing #(assoc-in state [:workspace-local :edition] %)]
        (t/is (empty? (watch-events (fix) (editing text-id)))
              "the text open in the editor keeps its content")
        (t/is (empty? (watch-events (fix) (assoc-in state [:workspace-editor-state text-id] {})))
              "the text with an editor state keeps its content")
        (t/is (= 1 (count (watch-events (fix) (editing (cthi/new-id! :other)))))
              "editing another shape does not block the fix"))
      (finally
        (cleanup)))))
