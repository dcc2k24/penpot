;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.render-wasm.page-cache-test
  (:require
   [app.common.render-wasm.wasm :as wasm]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.render-wasm.page-cache :as pc]
   [cljs.test :as t :include-macros true]))

;; ---------------------------------------------------------------------------
;; Helpers
;; ---------------------------------------------------------------------------

(def ^:private page-a (uuid/next))
(def ^:private page-b (uuid/next))
(def ^:private shape-id (uuid/next))
(def ^:private component-id (uuid/next))

(def ^:private epoch-a {:file-id 1 :file-version 1 :preview-id nil})
(def ^:private epoch-b {:file-id 1 :file-version 2 :preview-id nil})

(defn- mock-module
  "Returns [module calls]. `calls` is an atom holding [name & args] vectors
  for every WASM call. The stash and restore results come from `opts`.

  `cached-ids`, when given, makes a newer build: `_cached_page_ids` reports
  those pages in its memory, and `_stash_page_keeping` takes the place of
  `_stash_page`."
  [{:keys [stash-result restore-result cached-ids]
    :or   {stash-result 1
           restore-result 1}}]
  (let [calls  (atom [])
        record (fn [fname result]
                 (fn [& args]
                   (swap! calls conj (into [fname] args))
                   result))
        module #js {"_init"             (fn [] nil)
                    "_stash_page"       (record "_stash_page" stash-result)
                    "_restore_page"     (record "_restore_page" restore-result)
                    "_drop_cached_page" (record "_drop_cached_page" 1)
                    "_clear_page_cache" (record "_clear_page_cache" nil)}]
    (when (some? cached-ids)
      (let [buffer (js/ArrayBuffer. 64)
            dview  (js/DataView. buffer)]
        ;; The reply of `_cached_page_ids`: [u32 count][count x 16-byte uuid].
        (.setUint32 dview 0 (count cached-ids) true)
        (doseq [[i id] (map-indexed vector cached-ids)
                :let [parts (uuid/get-u32 id)]
                j (range 4)]
          (.setUint32 dview (+ 4 (* 16 i) (* 4 j)) (aget parts j) true))
        (unchecked-set module "HEAPU8" (js/Uint8Array. buffer))
        (unchecked-set module "_cached_page_ids" (fn [] 0))
        (unchecked-set module "_free_bytes" (record "_free_bytes" nil))
        (unchecked-set module "_stash_page_keeping"
                       (record "_stash_page_keeping" stash-result))))
    [module calls]))

(defn- called?
  "True when WASM function `fname` was called at least once."
  [calls fname]
  (boolean (some #(= fname (first %)) @calls)))

(defn- call-args
  "The arguments of the first call of WASM function `fname`, or nil."
  [calls fname]
  (let [[_ & args] (first (filter #(= fname (first %)) @calls))]
    (vec args)))

;; ---------------------------------------------------------------------------
;; changes-scope
;; ---------------------------------------------------------------------------

(t/deftest changes-scope-page-ids
  (t/testing "a change with a page id names that page"
    (t/is (= {:page-ids #{page-a} :all? false}
             (pc/changes-scope [{:type :mod-obj :page-id page-a}]))))

  (t/testing "mod-page names its page in :id"
    (t/is (= {:page-ids #{page-a} :all? false}
             (pc/changes-scope [{:type :mod-page :id page-a}]))))

  (t/testing "add-page names its page in [:page :id]"
    (t/is (= {:page-ids #{page-a} :all? false}
             (pc/changes-scope [{:type :add-page :page {:id page-a}}]))))

  (t/testing "page-neutral change types touch no page"
    (t/is (= {:page-ids #{} :all? false}
             (pc/changes-scope [{:type :add-color}]))))

  (t/testing "a change with a component id and no page id is ignored"
    (t/is (= {:page-ids #{} :all? false}
             (pc/changes-scope [{:type :mod-obj :component-id component-id :id shape-id}]))))

  (t/testing "other changes with no page id set :all?"
    (t/is (= {:page-ids #{} :all? true}
             (pc/changes-scope [{:type :del-component :id component-id}]))))

  (t/testing "nil changes are accepted"
    (t/is (= {:page-ids #{} :all? false}
             (pc/changes-scope nil)))
    (t/is (= {:page-ids #{} :all? false}
             (pc/changes-scope [nil])))))

;; ---------------------------------------------------------------------------
;; versions
;; ---------------------------------------------------------------------------

(t/deftest note-changes-bumps-versions
  (pc/reset-state!)
  (pc/note-changes! [{:type :mod-obj :page-id page-a}]
                    {:current-page-id page-a :wasm-synced? true})
  (pc/note-changes! [{:type :mod-obj :page-id page-a}]
                    {:current-page-id page-a :wasm-synced? true})
  (t/is (= 2 (pc/version page-a)))
  (t/is (= 0 (pc/version page-b))))

;; ---------------------------------------------------------------------------
;; stash and restore
;; ---------------------------------------------------------------------------

(t/deftest stash-and-restore-round-trip
  (pc/reset-state!)
  (let [[module calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/set-summary! page-a :summary-a)
        (t/is (true? (pc/stash! epoch-a true)))
        (t/is (called? calls "_stash_page"))
        (let [entry (pc/restore! page-a epoch-a)]
          (t/is (some? entry))
          (t/is (= epoch-a (:epoch entry)))
          (t/is (called? calls "_restore_page"))
          (t/is (= :summary-a (pc/summary page-a))
                "a restore keeps the summary of the page"))))))

(t/deftest restore-after-version-change-drops-stash
  (pc/reset-state!)
  (let [[module calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (t/is (true? (pc/stash! epoch-a true)))
        (pc/note-changes! [{:type :mod-obj :page-id page-a}]
                          {:current-page-id page-a :wasm-synced? true})
        (t/is (nil? (pc/restore! page-a epoch-a)))
        (t/is (called? calls "_drop_cached_page"))
        (t/is (not (called? calls "_restore_page")))))))

(t/deftest restore-with-other-epoch-returns-nil
  (pc/reset-state!)
  (let [[module calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (t/is (true? (pc/stash! epoch-a true)))
        (t/is (nil? (pc/restore! page-a epoch-b)))
        (t/is (called? calls "_drop_cached_page"))))))

(t/deftest restore-when-wasm-returns-zero-returns-nil
  (pc/reset-state!)
  (let [[module calls] (mock-module {:restore-result 0})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (t/is (true? (pc/stash! epoch-a true)))
        (t/is (nil? (pc/restore! page-a epoch-a)))
        (t/is (called? calls "_restore_page"))
        (t/is (called? calls "_drop_cached_page"))))))

(t/deftest restore-miss-drops-the-summary
  (pc/reset-state!)
  (let [[module _calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/set-summary! page-a :summary-a)
        (t/is (true? (pc/stash! epoch-a true)))
        (t/is (nil? (pc/restore! page-a epoch-b)))
        (t/is (nil? (pc/summary page-a)))))))

(t/deftest stash-with-allowed-false-does-not-call-wasm
  (pc/reset-state!)
  (let [[module calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (t/is (false? (pc/stash! epoch-a false)))
        (t/is (not (called? calls "_stash_page")))))))

(t/deftest clear-drops-stashed-pages-and-summaries
  (pc/reset-state!)
  (let [[module calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/set-summary! page-a :summary-a)
        (t/is (true? (pc/stash! epoch-a true)))
        (pc/set-summary! page-b :summary-b)
        (pc/clear!)
        (t/is (called? calls "_clear_page_cache"))
        (t/is (nil? (pc/restore! page-a epoch-a)))
        (t/is (not (called? calls "_restore_page")))
        (t/is (nil? (pc/summary page-a)))
        (t/is (nil? (pc/summary page-b)))))))

;; ---------------------------------------------------------------------------
;; summaries
;; ---------------------------------------------------------------------------

(t/deftest set-summary-keeps-only-cached-pages-and-the-new-one
  (pc/reset-state!)
  (let [[module _calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/set-summary! page-a :summary-a)
        (t/is (true? (pc/stash! epoch-a true)))
        (t/is (= :summary-a (pc/summary page-a)) "a stashed page keeps its summary")
        ;; The restore takes the page out of the cache.
        (t/is (some? (pc/restore! page-a epoch-a)))
        (pc/set-summary! page-b :summary-b)
        (t/is (= :summary-b (pc/summary page-b)))
        (t/is (nil? (pc/summary page-a))
              "a page that is no longer cached loses its summary")))))

(t/deftest drop-summary-forgets-the-page
  (pc/reset-state!)
  (pc/set-summary! page-a :summary-a)
  (pc/drop-summary! page-a)
  (t/is (nil? (pc/summary page-a))))

;; ---------------------------------------------------------------------------
;; pruning with the pages WASM keeps
;; ---------------------------------------------------------------------------

(t/deftest stash-prunes-pages-wasm-no-longer-keeps
  (pc/reset-state!)
  (let [[module _calls] (mock-module {:cached-ids [page-b]})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/set-summary! page-a :summary-a)
        (t/is (true? (pc/stash! epoch-a true)))
        (t/is (not (pc/restorable? page-a epoch-a))
              "WASM reports only page b, so page a is not restorable")
        (t/is (nil? (pc/summary page-a)))
        (t/is (empty? (pc/stashed-page-ids)))))))

(t/deftest prune-keeps-the-summary-of-the-resident-page
  (pc/reset-state!)
  (let [[module _calls] (mock-module {:cached-ids [page-b]})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/set-summary! page-a :summary-a)
        (pc/sync-with-wasm!)
        (t/is (= :summary-a (pc/summary page-a)))))))

(t/deftest stash-passes-the-page-being-switched-to-to-wasm
  (pc/reset-state!)
  (let [[module calls] (mock-module {:cached-ids [page-a page-b]})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (t/is (true? (pc/stash! epoch-a true page-b)))
        (t/is (= (mapv #(aget (uuid/get-u32 page-b) %) (range 4))
                 (vec (take-last 4 (call-args calls "_stash_page_keeping"))))
              "the kept page is page b")
        (t/is (pc/restorable? page-a epoch-a)
              "both pages are kept, so page a is still restorable")))))

(t/deftest stash-without-another-page-keeps-the-nil-uuid
  (pc/reset-state!)
  (let [[module calls] (mock-module {:cached-ids [page-a]})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (t/is (true? (pc/stash! epoch-a true page-a)))
        (t/is (= (mapv #(aget (uuid/get-u32 uuid/zero) %) (range 4))
                 (vec (take-last 4 (call-args calls "_stash_page_keeping")))))))))

;; ---------------------------------------------------------------------------
;; taint
;; ---------------------------------------------------------------------------

(t/deftest change-on-other-current-page-taints-resident
  (pc/reset-state!)
  (let [[module calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/note-changes! [{:type :mod-obj :page-id page-a}]
                          {:current-page-id page-b :wasm-synced? true})
        (t/is (false? (pc/stash! epoch-a true)))
        (t/is (not (called? calls "_stash_page")))))))

(t/deftest unsynced-change-taints-resident-page
  (pc/reset-state!)
  (let [[module calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/note-changes! [{:type :mod-obj :page-id page-a}]
                          {:current-page-id page-a :wasm-synced? false})
        (t/is (false? (pc/stash! epoch-a true)))
        (t/is (not (called? calls "_stash_page")))))))

(t/deftest hold-blocks-stash
  (pc/reset-state!)
  (let [[module calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/hold-resident! token)
        (t/is (false? (pc/stash! epoch-a true)))
        (t/is (not (called? calls "_stash_page")))))))

(t/deftest release-allows-stash
  (pc/reset-state!)
  (let [[module calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/hold-resident! token)
        (pc/release-resident! token)
        (t/is (true? (pc/stash! epoch-a true)))
        (t/is (called? calls "_stash_page"))))))

(t/deftest hold-and-release-ignore-another-load
  (pc/reset-state!)
  (let [[module _calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [stale (pc/begin-load!)
            token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/hold-resident! stale)
        (t/is (true? (pc/stash! epoch-a true))
              "a hold of another load does not block the stash"))
      (let [stale (pc/begin-load!)
            token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/hold-resident! token)
        (pc/release-resident! stale)
        (t/is (false? (pc/stash! epoch-a true))
              "a release of another load does not lift the hold")))))

(t/deftest set-resident-clears-the-hold
  (pc/reset-state!)
  (let [[module calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/hold-resident! token))
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (t/is (true? (pc/stash! epoch-a true))
              "a new residency starts with no hold")
        (t/is (called? calls "_stash_page"))))))

(t/deftest synced-change-on-other-page-does-not-taint
  (pc/reset-state!)
  (let [[module calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/note-changes! [{:type :mod-obj :page-id page-b}]
                          {:current-page-id page-a :wasm-synced? true})
        (t/is (true? (pc/stash! epoch-a true)))
        (t/is (called? calls "_stash_page"))))))

;; ---------------------------------------------------------------------------
;; deleted pages
;; ---------------------------------------------------------------------------

(t/deftest deleted-page-loses-its-stash-summary-and-pool
  (pc/reset-state!)
  (let [[module calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/set-summary! page-a :summary-a)
        (t/is (true? (pc/stash! epoch-a true)))
        (pc/note-changes! [{:type :del-page :id page-a}]
                          {:current-page-id page-b :wasm-synced? true})
        (t/is (not (pc/restorable? page-a epoch-a)))
        (t/is (nil? (pc/summary page-a)))
        (t/is (empty? (pc/stashed-page-ids)))
        (t/is (called? calls "_drop_cached_page"))))))

;; ---------------------------------------------------------------------------
;; structural sync
;; ---------------------------------------------------------------------------

(t/deftest structural-sync-blocks-stash
  (pc/reset-state!)
  (let [[module calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/note-changes! [{:type :mod-obj :page-id page-a}]
                          {:current-page-id  page-a
                           :wasm-synced?     true
                           :structural-sync? true})
        (t/is (false? (pc/stash! epoch-a true)))
        (t/is (not (called? calls "_stash_page")))))))

(t/deftest end-structural-sync-unblocks-stash
  (pc/reset-state!)
  (let [[module calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (pc/note-changes! [{:type :mod-obj :page-id page-a}]
                          {:current-page-id  page-a
                           :wasm-synced?     true
                           :structural-sync? true})
        (pc/end-structural-sync!)
        (t/is (true? (pc/stash! epoch-a true)))
        (t/is (called? calls "_stash_page"))))))

;; ---------------------------------------------------------------------------
;; load tokens
;; ---------------------------------------------------------------------------

(t/deftest stale-token-does-not-set-resident
  (pc/reset-state!)
  (let [stale (pc/begin-load!)]
    (pc/begin-load!)
    (pc/set-resident! stale page-a epoch-a)
    (t/is (nil? (pc/resident-page-id)))))

(t/deftest invalidate-loads-makes-the-running-load-stale
  (pc/reset-state!)
  (let [token (pc/begin-load!)]
    (pc/invalidate-loads!)
    (t/is (not= token (pc/latest-load-token)))
    (pc/set-resident! token page-a epoch-a)
    (t/is (nil? (pc/resident-page-id)))))

(t/deftest stash-with-no-resident-returns-false
  (pc/reset-state!)
  (t/is (false? (pc/stash! epoch-a true))))

(t/deftest resident-token-follows-the-latest-load
  (pc/reset-state!)
  (let [t1 (pc/begin-load!)]
    (pc/set-resident! t1 page-a epoch-a)
    (t/is (= t1 (pc/resident-token)))
    (let [t2 (pc/begin-load!)]
      (t/is (nil? (pc/resident-token)))
      ;; Same page as before, so only the token tells the loads apart.
      (pc/set-resident! t2 page-a epoch-a)
      (t/is (= t2 (pc/resident-token)))
      (t/is (not= t1 (pc/resident-token))))))

(t/deftest latest-load-token-follows-every-load
  (pc/reset-state!)
  (t/is (= 0 (pc/latest-load-token)))
  (let [t1 (pc/begin-load!)]
    (t/is (= t1 (pc/latest-load-token)))
    ;; Set even when the load never becomes resident (no page id).
    (let [t2 (pc/begin-load!)]
      (t/is (= t2 (pc/latest-load-token)))
      (t/is (not= t1 (pc/latest-load-token))))))

;; ---------------------------------------------------------------------------
;; enable flag
;; ---------------------------------------------------------------------------

(t/deftest enabled-by-default
  (t/is (true? (pc/enabled?))))

(t/deftest disabled-flag-blocks-stash-and-restore
  (pc/reset-state!)
  (let [[module calls] (mock-module {})]
    (with-redefs [wasm/internal-module module]
      (let [token (pc/begin-load!)]
        (pc/set-resident! token page-a epoch-a)
        (t/is (true? (pc/stash! epoch-a true)))
        (with-redefs [cf/flags #{}]
          (t/is (false? (pc/enabled?)))
          (t/is (nil? (pc/restore! page-a epoch-a)))
          (t/is (not (called? calls "_restore_page")))
          (let [token (pc/begin-load!)]
            (pc/set-resident! token page-b epoch-a)
            (t/is (false? (pc/stash! epoch-a true)))
            (t/is (= 1 (count (filter #(= "_stash_page" (first %)) @calls))))))))))

;; ---------------------------------------------------------------------------
;; device limits
;; ---------------------------------------------------------------------------

(t/deftest device-limits-of-an-unknown-device-are-the-defaults
  (t/is (= [3 100000 200000] (pc/device-limits nil))))

(t/deftest device-limits-below-8-gb-are-the-defaults
  (t/is (= [3 100000 200000] (pc/device-limits 4)))
  (t/is (= [3 100000 200000] (pc/device-limits 7.9))))

(t/deftest device-limits-of-8-gb-or-more-are-the-large-limits
  (t/is (= [3 400000 400000] (pc/device-limits 8)))
  (t/is (= [3 400000 400000] (pc/device-limits 16))))
