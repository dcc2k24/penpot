;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-mcp-write-path-test
  "Tests of the MCP write path: batching, failure handling, the revn lag
  read, conflicts, the compiled change cap, dry runs, publishing and the
  webhook metadata of a write."
  (:require
   [app.binfile.common :as bfc]
   [app.common.exceptions :as ex]
   [app.common.time :as ct]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.features.fdata :as fdata]
   [app.features.file-snapshots :as fsnap]
   [app.loggers.audit :as-alias audit]
   [app.loggers.webhooks :as-alias webhooks]
   [app.msgbus :as mbus]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.files-update :as files-update]
   [app.rpc.commands.mcp-write :as mcp-write]
   [app.util.pointer-map :as pmap]
   [backend-tests.helpers :as th]
   [clojure.test :as t]))

(t/use-fixtures :once (t/compose-fixtures
                       (partial th/init-config [:enable-access-tokens
                                                :enable-client-header-check-middleware])
                       th/init-system))
(t/use-fixtures :each th/database-reset)

;; --- HELPERS

(defn- call!
  "Runs an MCP command as `profile` with an MCP write token."
  [profile method params]
  (th/command!
   (merge {::th/type method
           ::rpc/profile-id (:id profile)
           ::rpc/auth-type :token
           ::rpc/token-type "mcp"
           ::rpc/token-perms #{"mcp:write"}}
          params)))

(defn- error-code
  [out]
  (:code (ex-data (:error out))))

(defn- revn
  [file-id]
  (:revn (th/db-get :file {:id file-id})))

(defn- file-changes
  "The file change rows of `file-id`, oldest first."
  [file-id]
  (th/db-exec! ["SELECT session_id, label, created_by
                   FROM file_change
                  WHERE file_id = ?
                  ORDER BY created_at ASC, id ASC" file-id]))

(defn- change-rows
  [file-id]
  (count (file-changes file-id)))

(defn- add-frame
  [page-id id]
  {:type :add-obj
   :page-id page-id
   :id id
   :parent-id uuid/zero
   :frame-id uuid/zero
   :obj (cts/setup-shape {:id id
                          :type :frame
                          :name "Board"
                          :parent-id uuid/zero
                          :frame-id uuid/zero
                          :x 0 :y 0 :width 500 :height 500})})

(defn- add-rect
  [page-id id parent-id & {:as attrs}]
  {:type :add-obj
   :page-id page-id
   :id id
   :parent-id parent-id
   :frame-id parent-id
   :obj (cts/setup-shape (merge {:id id
                                 :type :rect
                                 :name "Rect"
                                 :parent-id parent-id
                                 :frame-id parent-id
                                 :x 10 :y 10 :width 20 :height 20}
                                attrs))})

(defn- rename-shape
  [page-id id name]
  {:type :mod-obj
   :page-id page-id
   :id id
   :operations [{:type :set :attr :name :val name}]})

(defn- create-fixture
  "A profile that owns an empty file with one page."
  []
  (let [profile (th/create-profile* 1 {:is-active true})
        file    (th/create-file* 1 {:profile-id (:id profile)
                                    :project-id (:default-project-id profile)})]
    {:profile (th/db-get :profile {:id (:id profile)})
     :file-id (:id file)
     :page-id (get-in file [:data :pages 0])}))

(defn- create-board!
  "Commits a board through the MCP command and returns its id."
  [profile file-id page-id]
  (let [board (uuid/next)
        out   (call! profile :mcp-apply-changes
                     {:file-id file-id
                      :changes [(add-frame page-id board)]})]
    (t/is (nil? (:error out)))
    board))

(defn- op-board
  [page-id]
  {:op "create_board"
   :page-id page-id
   :id "$tmp:board"
   :name "Board"
   :x 0 :y 0 :width 2000 :height 2000})

(defn- op-rect
  [page-id handle i]
  {:op "create_rect"
   :page-id page-id
   :id handle
   :parent-id "$tmp:board"
   :name (str "Rect " i)
   :x (* 10 (mod i 100)) :y (* 10 (quot i 100))
   :width 5 :height 5})

(defn- pub-args
  "The keyword arguments of a captured `mbus/pub!` call, as a map. The
  first captured argument is the msgbus."
  [args]
  (apply hash-map (rest args)))

;; --- BATCHES AND FAILURES

(t/deftest split-write-failure-publishes-nothing
  (let [{:keys [profile file-id page-id]} (create-fixture)
        before (revn file-id)
        rows0  (change-rows file-id)
        pubs   (atom [])
        calls  (atom 0)
        orig   files-update/update-file!
        ;; One board and 301 rects: 302 object creations, so two batches.
        ops    (into [(op-board page-id)]
                     (map #(op-rect page-id (str "$tmp:r" %) %))
                     (range 301))
        out    (with-redefs [mbus/pub! (fn [& args] (swap! pubs conj args))
                             files-update/update-file!
                             (fn [cfg params]
                               ;; The first batch runs for real, the second fails.
                               (if (= 1 (swap! calls inc))
                                 (orig cfg params)
                                 (ex/raise :type :validation
                                           :code :boom-second-batch
                                           :hint "boom")))]
                 (call! profile :mcp-apply-operations
                        {:file-id file-id
                         :allow-split true
                         :operations ops}))]
    (t/is (= :boom-second-batch (error-code out)))
    (t/is (empty? @pubs))
    (t/is (= before (revn file-id)))
    (t/is (= rows0 (change-rows file-id)))))

(t/deftest error-path-keeps-the-original-error
  (let [{:keys [profile file-id page-id]} (create-fixture)
        ;; Aborts the PostgreSQL transaction, then raises a Penpot error.
        fake (fn [cfg _params]
               (try
                 (db/exec! (::db/conn cfg) ["select 1/0"])
                 (catch Throwable _ nil))
               (ex/raise :type :validation
                         :code :fake-batch-failure
                         :hint "fake"))
        out  (with-redefs [files-update/update-file! fake]
               (call! profile :mcp-apply-operations
                      {:file-id file-id
                       :operations [(op-board page-id)
                                    (op-rect page-id "$tmp:a" 1)]}))]
    (t/is (= :fake-batch-failure (error-code out)))))

(t/deftest write-publishes-after-commit
  (let [{:keys [profile file-id page-id]} (create-fixture)
        pubs (atom [])
        out  (with-redefs [mbus/pub! (fn [& args] (swap! pubs conj args))]
               (call! profile :mcp-apply-changes
                      {:file-id file-id
                       :changes [(add-frame page-id (uuid/next))]}))
        sent (map pub-args @pubs)]
    (t/is (nil? (:error out)))
    (t/is (= 1 (count sent)))
    (t/is (= file-id (:topic (first sent))))
    (t/is (= :file-change (:type (:message (first sent)))))))

(defn- ops-changes
  "The changes of operations that create `counts` objects each, with the
  change ranges `compile-operations` returns for them."
  [counts]
  (reduce (fn [{:keys [changes ranges]} n]
            (let [start (count changes)]
              {:changes (into changes (repeat n {:type :add-obj}))
               :ranges  (conj ranges [start (+ start n)])}))
          {:changes [] :ranges []}
          counts))

(t/deftest split-batches-keep-operations-whole
  (let [split (fn [counts reflow]
                (let [{:keys [changes ranges]} (ops-changes counts)]
                  (#'mcp-write/split-batches
                   (into changes (repeat reflow {:type :mod-obj}))
                   ranges)))
        spans (fn [batches] (mapv (juxt :first-op :last-op) batches))
        big   (split [150 200 350] 0)
        fits  (split [100 100 100] 0)
        exact (split [300 1] 0)
        tail  (split [150 200 350] 5)
        fits-tail (split [100 100 100] 5)]
    (t/is (= [[0 0] [1 1] [2 2]] (spans big)))
    (t/is (= [[0 2]] (spans fits)))
    (t/is (= [[0 0] [1 1]] (spans exact)))
    (t/is (= [[0 0] [1 1] [2 2]] (spans tail)))
    (t/is (= 355 (count (:changes (last tail)))))
    (t/is (= (repeat 5 :mod-obj) (map :type (take-last 5 (:changes (last tail))))))
    (t/is (= [[0 2]] (spans fits-tail)))
    (t/is (= 305 (count (:changes (first fits-tail)))))))

(t/deftest allow-split-commits-whole-operations
  (let [{:keys [profile file-id page-id]} (create-fixture)
        ;; One board and 319 rects, then 50 rects: 370 object creations,
        ;; so the split falls between operations: 300 and 70.
        ops    (-> [(op-board page-id)]
                   (into (map #(op-rect page-id (str "$tmp:a" %) %)) (range 319))
                   (into (map #(op-rect page-id (str "$tmp:b" %) %)) (range 50)))
        out    (call! profile :mcp-apply-operations
                      {:file-id file-id
                       :allow-split true
                       :operations ops})
        result (:result out)
        ids    (vec (vals (:created-ids result)))
        ;; get-mcp-shapes takes at most 200 ids per call.
        read   (mapv #(call! profile :get-mcp-shapes
                             {:file-id file-id
                              :page-id page-id
                              :ids (vec %)
                              ::rpc/token-perms #{"mcp:read"}})
                     (partition-all 200 ids))
        shapes (into {}
                     (comp (mapcat #(:shapes (:result %)))
                           (map (juxt :id identity)))
                     read)]
    (t/is (nil? (:error out)))
    (t/is (= 2 (:commits result)))
    ;; The second batch extends the revn the first one stored.
    (t/is (= (revn file-id) (:revn result)))
    (t/is (= 370 (count ids)))
    (t/is (every? #(nil? (:error %)) read))
    (t/is (= (count ids) (count shapes)))
    (t/is (every? #(or (= uuid/zero (:parent-id %))
                       (contains? shapes (:parent-id %)))
                  (vals shapes)))))

(t/deftest failed-batch-reports-its-operation-range
  (let [{:keys [profile file-id page-id]} (create-fixture)
        before (revn file-id)
        calls  (atom 0)
        orig   files-update/update-file!
        ;; Board is op 0, rect i is op i + 1. The first batch holds ops 0
        ;; to 299 (300 creations), the second ops 300 and 301.
        ops    (into [(op-board page-id)]
                     (map #(op-rect page-id (str "$tmp:r" %) %))
                     (range 301))
        out    (with-redefs [files-update/update-file!
                             (fn [cfg params]
                               (if (= 1 (swap! calls inc))
                                 (orig cfg params)
                                 (ex/raise :type :validation
                                           :code :boom-second-batch
                                           :hint "boom")))]
                 (call! profile :mcp-apply-operations
                        {:file-id file-id
                         :allow-split true
                         :operations ops}))
        data   (ex-data (:error out))]
    (t/is (= :boom-second-batch (:code data)))
    (t/is (= 300 (:failed-operation-index data)))
    (t/is (= 301 (:failed-operation-last-index data)))
    (t/is (= before (:last-committed-revn data)))
    (t/is (= before (revn file-id)))))

(t/deftest invalid-operation-fails-with-its-index
  (let [{:keys [profile file-id page-id]} (create-fixture)
        before (revn file-id)
        out    (call! profile :mcp-apply-operations
                      {:file-id file-id
                       :operations [(op-board page-id)
                                    {:op "create_rect" :page-id page-id}]})
        data   (ex-data (:error out))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (= 1 (:index data)))
    (t/is (= "create_rect" (:op data)))
    (t/is (= before (revn file-id)))))

;; --- REVN LAG READ

(t/deftest lag-read-truncates-at-the-limit
  (let [{:keys [profile file-id page-id]} (create-fixture)
        board  (create-board! profile file-id page-id)
        _      (doseq [_ (range 3)]
                 (call! profile :mcp-apply-changes
                        {:file-id file-id
                         :request-id (uuid/next)
                         :changes [(add-rect page-id (uuid/next) board)]}))
        stored (revn file-id)
        out    (with-redefs [files-update/changed-rows-limit 2]
                 (call! profile :mcp-apply-changes
                        {:file-id file-id
                         :base-revn 0
                         :changes [(add-rect page-id (uuid/next) board)]}))]
    (t/is (>= stored 4))
    (t/is (nil? (:error out)))
    (t/is (true? (:lagged-truncated (:result out))))))

(t/deftest lag-read-without-lag-has-no-flag
  (let [{:keys [profile file-id page-id]} (create-fixture)
        board (create-board! profile file-id page-id)
        out   (call! profile :mcp-apply-changes
                     {:file-id file-id
                      :base-revn (revn file-id)
                      :changes [(add-rect page-id (uuid/next) board)]})]
    (t/is (nil? (:error out)))
    (t/is (= 0 (:lagged-count (:result out))))
    (t/is (not (:lagged-truncated (:result out))))))

(t/deftest undecodable-lag-row-does-not-fail-the-write
  (let [{:keys [profile file-id page-id]} (create-fixture)
        board (create-board! profile file-id page-id)
        now   (ct/now)
        ;; A lag row at revn 1 whose changes are not transit.
        _     (th/db-insert! :file-change
                             {:id (uuid/next)
                              :session-id (uuid/next)
                              :profile-id (:id profile)
                              :created-at now
                              :updated-at now
                              :file-id file-id
                              :revn 1
                              :version 0
                              :changes (.getBytes "not transit" "UTF-8")}
                             {::db/return-keys false})
        ;; A limit of 1 makes the read truncate, so the flag is set.
        out   (with-redefs [files-update/changed-rows-limit 1]
                (call! profile :mcp-apply-changes
                       {:file-id file-id
                        :base-revn 0
                        :changes [(add-rect page-id (uuid/next) board)]}))]
    (t/is (nil? (:error out)))
    (t/is (true? (:lagged-truncated (:result out))))))

(t/deftest conflict-on-parent-of-a-reorder
  (let [{:keys [profile file-id page-id]} (create-fixture)
        frame (uuid/next)
        rect  (uuid/next)
        _     (call! profile :mcp-apply-changes
                     {:file-id file-id
                      :changes [(add-frame page-id frame)
                                (add-rect page-id rect frame)]})
        base  (revn file-id)
        ;; Commit 2 touches the frame only through its parent-id.
        setup (call! profile :mcp-apply-changes
                     {:file-id file-id
                      :request-id (uuid/next)
                      :changes [{:type :reorder-children
                                 :page-id page-id
                                 :parent-id frame
                                 :shapes [rect]}]})
        out   (call! profile :mcp-apply-changes
                     {:file-id file-id
                      :base-revn base
                      :fail-on-conflict true
                      :changes [(rename-shape page-id frame "Renamed")]})]
    (t/is (nil? (:error setup)))
    (t/is (= :mcp-revn-conflict (error-code out)))))

(t/deftest reg-objects-only-commit-does-not-conflict
  (let [{:keys [profile file-id page-id]} (create-fixture)
        frame (uuid/next)
        rect  (uuid/next)
        _     (call! profile :mcp-apply-changes
                     {:file-id file-id
                      :changes [(add-frame page-id frame)
                                (add-rect page-id rect frame)]})
        base  (revn file-id)
        setup (call! profile :mcp-apply-changes
                     {:file-id file-id
                      :request-id (uuid/next)
                      :changes [{:type :reg-objects
                                 :page-id page-id
                                 :shapes [rect]}]})
        out   (call! profile :mcp-apply-changes
                     {:file-id file-id
                      :base-revn base
                      :fail-on-conflict true
                      :changes [(rename-shape page-id rect "Renamed")]})
        warning (first (filter #(= "revn-lag" (:kind %))
                               (:warnings (:result out))))]
    (t/is (nil? (:error setup)))
    (t/is (nil? (:error out)))
    (t/is (some? warning))
    (t/is (not (contains? (set (:changed-shape-ids warning)) rect)))))

;; --- CAPS, VALIDATION AND DRY RUNS

(t/deftest compiled-change-cap-refuses-before-write
  (let [{:keys [profile file-id page-id]} (create-fixture)
        before (revn file-id)
        ops    [(op-board page-id)
                (op-rect page-id "$tmp:a" 1)
                (op-rect page-id "$tmp:b" 2)]
        out    (with-redefs-fn {#'mcp-write/max-compiled-changes (fn [] 3)}
                 (fn []
                   (call! profile :mcp-apply-operations
                          {:file-id file-id :operations ops})))
        dry    (with-redefs-fn {#'mcp-write/max-compiled-changes (fn [] 3)}
                 (fn []
                   (call! profile :mcp-apply-operations
                          {:file-id file-id :dry-run true :operations ops})))]
    (t/is (= :mcp-batch-too-large (error-code out)))
    (t/is (= before (revn file-id)))
    (t/is (= :mcp-batch-too-large (error-code dry)))))

(t/deftest dry-run-reports-the-commit-error-code
  ;; A fix change of an unknown kind fails while the changes are
  ;; processed, so the dry run and the commit report the same code. A
  ;; validator error is not used here: a commit turns those into
  ;; :referential-integrity, which is the auto-repair path.
  (with-redefs [cf/flags (conj cf/flags :file-validation)]
    (let [{:keys [profile file-id page-id]} (create-fixture)
          board (create-board! profile file-id page-id)
          before (revn file-id)
          bad   {:type :fix-obj
                 :page-id page-id
                 :id board
                 :fix :unknown-fix}
          dry   (call! profile :mcp-apply-changes
                       {:file-id file-id
                        :dry-run true
                        :changes [bad]})
          commit (call! profile :mcp-apply-changes
                        {:file-id file-id
                         :changes [bad]})
          codes (set (map :code (get-in dry [:result :validation :errors])))]
      (t/is (nil? (:error dry)))
      (t/is (false? (get-in dry [:result :validation :ok])))
      (t/is (contains? codes :fix-not-implemented))
      (t/is (= :fix-not-implemented (error-code commit)))
      (t/is (= before (revn file-id))))))

;; --- WEBHOOK AND AUDIT METADATA

(t/deftest write-emits-update-file-webhook-metadata
  (let [{:keys [profile file-id page-id]} (create-fixture)
        data {::th/type :mcp-apply-changes
              ::rpc/profile-id (:id profile)
              ::rpc/auth-type :token
              ::rpc/token-type "mcp"
              ::rpc/token-perms #{"mcp:write"}
              :file-id file-id
              :changes [(add-frame page-id (uuid/next))]}
        raw  (th/command-raw! data)
        m    (meta raw)
        props (::audit/replace-props m)]
    (t/is (true? (::webhooks/event? m)))
    (t/is (= "update-file" (::audit/name m)))
    (t/is (= (str (:id profile) ":" file-id)
             ((::webhooks/batch-key m) data)))
    (doseq [k [:id :name :revn :project-id :team-id :modified-at]]
      (t/is (contains? props k)))))

(t/deftest dry-run-emits-no-webhook-metadata
  (let [{:keys [profile file-id page-id]} (create-fixture)
        data {::th/type :mcp-apply-changes
              ::rpc/profile-id (:id profile)
              ::rpc/auth-type :token
              ::rpc/token-type "mcp"
              ::rpc/token-perms #{"mcp:write"}
              :file-id file-id
              :dry-run true
              :changes [(add-frame page-id (uuid/next))]}
        raw  (th/command-raw! data)
        m    (meta raw)]
    (t/is (not (true? (::webhooks/event? m))))
    (t/is (not= "update-file" (::audit/name m)))))

;; --- POINTER MAPS AND SNAPSHOTS

(defn- create-paged-fixture
  "A profile that owns a pointer-map file with three pages, each with a
  board holding a rect."
  []
  (let [{:keys [profile file-id page-id]} (create-fixture)
        page2  (uuid/next)
        page3  (uuid/next)
        boards (repeatedly 3 uuid/next)
        rects  (repeatedly 3 uuid/next)
        pages  [page-id page2 page3]
        out    (call! profile :mcp-apply-changes
                      {:file-id file-id
                       :snapshot false
                       :changes (into [{:type :add-page :id page2 :name "Two"}
                                       {:type :add-page :id page3 :name "Three"}]
                                      (mapcat (fn [page board rect]
                                                [(add-frame page board)
                                                 (add-rect page rect board)])
                                              pages boards rects))})]
    (t/is (nil? (:error out)))
    {:profile profile
     :file-id file-id
     :pages pages
     :rects (vec rects)}))

(defn- page-pointer-ids
  "The fragment id of each page of the stored file, keyed by fragment id."
  [file-id]
  (let [file (bfc/get-file th/*system* file-id)]
    (into {}
          (keep (fn [[page-id page]]
                  (when (pmap/pointer-map? page)
                    [(pmap/get-id page) page-id])))
          (get-in file [:data :pages-index]))))

(defn- realized-pages
  [file-id]
  (-> (bfc/get-file th/*system* file-id :realize? true)
      (get-in [:data :pages-index])))

(t/deftest write-on-one-page-loads-only-that-page
  (let [{:keys [profile file-id pages rects]} (create-paged-fixture)
        [page1 page2 page3] pages
        fragments (page-pointer-ids file-id)
        loads     (atom [])
        load-orig fdata/load-pointer
        ;; The test config snapshots every revn, and a snapshot loads
        ;; every page by design, so the automatic snapshot is off here.
        out       (with-redefs [cf/flags (disj cf/flags :auto-file-snapshot)
                                fdata/load-pointer
                                (fn [cfg file-id id]
                                  (swap! loads conj id)
                                  (load-orig cfg file-id id))]
                    (call! profile :mcp-apply-changes
                           {:file-id file-id
                            :snapshot false
                            :changes [(rename-shape page1 (first rects) "Renamed")]}))
        loaded    (into #{} (keep fragments) @loads)]
    (t/is (= 3 (count fragments)))
    (t/is (nil? (:error out)))
    ;; Only the touched page is loaded; the other two keep their
    ;; stored fragments.
    (t/is (= #{page1} loaded))
    (t/is (not (contains? loaded page2)))
    (t/is (not (contains? loaded page3)))))

(t/deftest save-keeps-unloaded-pages-as-they-are
  (let [{:keys [profile file-id pages rects]} (create-paged-fixture)
        [page1 page2 page3] pages
        before (realized-pages file-id)
        out    (call! profile :mcp-apply-changes
                      {:file-id file-id
                       :snapshot false
                       :changes [(rename-shape page1 (first rects) "Renamed")]})
        after  (realized-pages file-id)]
    (t/is (nil? (:error out)))
    (t/is (= (set pages) (set (keys after))))
    ;; Every page keeps all its shapes.
    (t/is (= (update-vals before #(count (:objects %)))
             (update-vals after #(count (:objects %)))))
    ;; The two untouched pages are the same as before the write.
    (t/is (= (:objects (get before page2)) (:objects (get after page2))))
    (t/is (= (:objects (get before page3)) (:objects (get after page3))))))

(t/deftest mcp-snapshot-restores-the-pre-call-state
  (let [{:keys [profile file-id pages rects]} (create-paged-fixture)
        [page1 page2] pages
        before   (realized-pages file-id)
        out      (call! profile :mcp-apply-changes
                        {:file-id file-id
                         :snapshot true
                         :changes [(rename-shape page1 (first rects) "Renamed")
                                   (add-rect page2 (uuid/next) uuid/zero)]})
        snap-id  (:snapshot-id (:result out))
        snapshot (fsnap/get-snapshot th/*system* file-id snap-id)
        data     (:data snapshot)]
    (t/is (nil? (:error out)))
    (t/is (some? snap-id))
    ;; The snapshot holds the data itself, never a reference to a
    ;; fragment that `file_gc` may drop.
    (t/is (not-any? pmap/pointer-map? (vals data)))
    (t/is (not-any? pmap/pointer-map? (vals (:pages-index data))))
    (t/is (not= before (realized-pages file-id)))
    (db/tx-run! th/*system* fsnap/restore! file-id snap-id)
    (t/is (= before (realized-pages file-id)))))

(t/deftest automatic-snapshot-of-an-mcp-write-holds-no-pointer
  ;; The test config takes the automatic snapshot on every revn.
  (let [{:keys [file-id]} (create-paged-fixture)
        row  (first (th/db-exec! ["SELECT id FROM file_change
                                    WHERE file_id = ?
                                      AND label LIKE 'internal/snapshot/%'
                                    ORDER BY created_at DESC
                                    LIMIT 1" file-id]))
        data (:data (fsnap/get-snapshot th/*system* file-id (:id row)))]
    (t/is (some? row))
    (t/is (map? (:pages-index data)))
    (t/is (not-any? pmap/pointer-map? (vals data)))
    (t/is (not-any? pmap/pointer-map? (vals (:pages-index data))))))
