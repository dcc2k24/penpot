;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-mcp-write-batch-test
  "Tests of the batched MCP commit: one decode and one file write per
  call, the rollback of a failed batch, the replay of a request, the lock
  wait and the time budget, the snapshot count, the forced validation,
  the raw change gate, the batch cuts and caps, the library pages, the
  deleted media and the notification buffer."
  (:require
   [app.binfile.common :as bfc]
   [app.common.exceptions :as ex]
   [app.common.features :as cfeat]
   [app.common.files.validate :as val]
   [app.common.time :as ct]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.features.fdata :as fdata]
   [app.msgbus :as mbus]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.files-update :as files-update]
   [app.rpc.commands.mcp :as mcp]
   [app.rpc.commands.mcp-write :as mcp-write]
   [app.storage :as sto]
   [app.util.blob :as blob]
   [backend-tests.helpers :as th]
   [backend-tests.storage-test :as stt]
   [clojure.set :as set]
   [clojure.string :as str]
   [clojure.test :as t]
   [promesa.protocols :as pt]))

(t/use-fixtures :once (t/compose-fixtures
                       (partial th/init-config [:enable-access-tokens
                                                :enable-client-header-check-middleware
                                                :enable-mcp-raw-changes])
                       th/init-system))
(t/use-fixtures :each
  th/database-reset
  ;; Small calls split into batches of 300 changes, so the split
  ;; tests need no 2000 operations. The 2000 bound is tested in
  ;; the unit tests that set it.
  (fn [f] (with-redefs-fn {#'mcp-write/notify-changes 300} f)))

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
  "The file change rows of `file-id`, change rows and snapshots alike."
  [file-id]
  (th/db-exec! ["SELECT id, label, session_id FROM file_change
                  WHERE file_id = ?" file-id]))

(defn- snapshot-rows
  "The snapshot rows of `file-id`, those with a label."
  [file-id]
  (filterv :label (file-changes file-id)))

(defn- internal-snapshot-count
  [file-id]
  (count (filter #(str/starts-with? (:label %) "internal/snapshot/")
                 (snapshot-rows file-id))))

(defn- fragment-count
  "The fragment rows of `file-id`. A pointer write adds one row."
  [file-id]
  (count (th/db-exec! ["SELECT id FROM file_data
                         WHERE file_id = ? AND type = 'fragment'" file-id])))

(defn- job-count
  []
  (count (th/db-exec! ["SELECT id FROM job"])))

(defn- object-count
  "The number of objects on the page `page-id` of the stored file."
  [file-id page-id]
  (let [file (bfc/get-file th/*system* file-id :realize? true)]
    (count (get-in file [:data :pages-index page-id :objects]))))

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
  [page-id id parent-id]
  {:type :add-obj
   :page-id page-id
   :id id
   :parent-id parent-id
   :frame-id parent-id
   :obj (cts/setup-shape {:id id
                          :type :rect
                          :name "Rect"
                          :parent-id parent-id
                          :frame-id parent-id
                          :x 10 :y 10 :width 20 :height 20})})

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
  [profile file-id page-id]
  (let [board (uuid/next)
        out   (call! profile :mcp-apply-changes
                     {:file-id file-id
                      :changes [(add-frame page-id board)]})]
    (t/is (nil? (:error out)))
    board))

(defn- create-paged-fixture
  "A profile that owns a pointer-map file with three pages, each with a
  board holding a rect. Returns the three page ids."
  []
  (let [{:keys [profile file-id page-id]} (create-fixture)
        page2  (uuid/next)
        page3  (uuid/next)
        pages  [page-id page2 page3]
        boards (repeatedly 3 uuid/next)
        rects  (repeatedly 3 uuid/next)
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
    {:profile profile :file-id file-id :pages pages}))

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

(defn- split-ops
  "One board and 301 rects on `page-id`: 302 object creations, so two
  batches."
  [page-id]
  (into [(op-board page-id)]
        (map #(op-rect page-id (str "$tmp:r" %) %))
        (range 301)))

(defn- create-media
  "A file media object backed by a stored object, as uploads create them."
  [file-id]
  (let [storage (-> (:app.storage/storage th/*system*)
                    (stt/configure-storage-backend))
        sobject (sto/put-object! storage
                                 {::sto/content (sto/content "<svg xmlns=\"http://www.w3.org/2000/svg\"/>")
                                  :content-type "image/svg+xml"
                                  :bucket "file-media-object"})]
    (th/create-file-media-object* {:file-id file-id
                                   :media-id (:id sobject)
                                   :name "media"
                                   :width 10 :height 10
                                   :mtype "image/svg+xml"})))

;; --- ONE FILE WRITE AND ONE FRAGMENT PER TOUCHED PAGE

(t/deftest split-commit-writes-one-fragment-per-touched-page
  (let [{:keys [profile file-id pages]} (create-paged-fixture)
        [page1] pages
        before (fragment-count file-id)
        out    (call! profile :mcp-apply-operations
                      {:file-id file-id
                       :allow-split true
                       :operations (split-ops page1)})]
    (t/is (nil? (:error out)))
    ;; Two batches, one touched page: one new fragment, not one per batch.
    (t/is (= 2 (:commits (:result out))))
    (t/is (= (inc before) (fragment-count file-id)))))

(t/deftest failed-batch-leaves-no-fragment-snapshot-or-job-rows
  (let [{:keys [profile file-id page-id]} (create-fixture)
        ;; Twenty `mcp/` snapshots, so the next snapshot prunes the oldest
        ;; one, which submits a job in the same transaction.
        _      (doseq [_ (range 20)]
                 (call! profile :mcp-apply-changes
                        {:file-id file-id
                         :snapshot true
                         :changes [(add-frame page-id (uuid/next))]}))
        rev0   (revn file-id)
        frags0 (fragment-count file-id)
        snaps0 (count (snapshot-rows file-id))
        jobs0  (job-count)
        calls  (atom 0)
        metric (atom 0)
        orig   files-update/apply-batch!
        out    (with-redefs [files-update/apply-batch!
                             (fn [ctx changes opts]
                               ;; The first batch runs for real, the second fails.
                               (if (= 1 (swap! calls inc))
                                 (orig ctx changes opts)
                                 (ex/raise :type :validation
                                           :code :boom-second-batch
                                           :hint "boom")))
                             mcp/record-change
                             (fn [& _] (swap! metric inc))]
                 (call! profile :mcp-apply-operations
                        {:file-id file-id
                         :allow-split true
                         :snapshot true
                         :operations (split-ops page-id)}))]
    (t/is (= :boom-second-batch (error-code out)))
    (t/is (= rev0 (revn file-id)))
    (t/is (= frags0 (fragment-count file-id)))
    (t/is (= snaps0 (count (snapshot-rows file-id))))
    (t/is (= jobs0 (job-count)))
    ;; A rolled back call records no change metric.
    (t/is (zero? @metric))))

;; --- REPLAY OF A REQUEST

(t/deftest replayed-request-applies-once
  (let [{:keys [profile file-id page-id]} (create-fixture)
        request (uuid/next)
        board   (uuid/next)
        args    {:file-id file-id
                 :request-id request
                 :changes [(add-frame page-id board)]}
        first   (call! profile :mcp-apply-changes args)
        rev1    (revn file-id)
        rows1   (count (file-changes file-id))
        objs1   (object-count file-id page-id)
        second  (call! profile :mcp-apply-changes args)]
    (t/is (nil? (:error first)))
    (t/is (nil? (:error second)))
    (t/is (true? (:already-applied (:result second))))
    (t/is (= 0 (:commits (:result second))))
    (t/is (= rev1 (:revn (:result second))))
    (t/is (= rev1 (revn file-id)))
    (t/is (= rows1 (count (file-changes file-id))))
    (t/is (= objs1 (object-count file-id page-id)))))

;; --- LOCK WAIT AND TIME BUDGET

(t/deftest busy-file-fails-fast-with-a-conflict
  (let [{:keys [profile file-id page-id]} (create-fixture)
        held    (promise)
        release (promise)
        hold    (bound-fn []
                  (db/tx-run! th/*system*
                              (fn [cfg]
                                (db/xact-lock! (::db/conn cfg) file-id)
                                (deliver held true)
                                @release)))
        holder  (future (hold))]
    @held
    (try
      (let [out (with-redefs-fn {#'mcp-write/lock-timeout "100ms"}
                  (fn []
                    (call! profile :mcp-apply-changes
                           {:file-id file-id
                            :changes [(add-frame page-id (uuid/next))]})))]
        (t/is (= :mcp-file-busy (error-code out)))
        (t/is (= :conflict (:type (ex-data (:error out))))))
      (finally
        (deliver release true)
        @holder))))

(t/deftest time-budget-refuses-a-later-batch
  (let [{:keys [profile file-id pages]} (create-paged-fixture)
        [page1] pages
        rev0   (revn file-id)
        frags0 (fragment-count file-id)
        out    (with-redefs-fn {#'mcp-write/batch-time-budget-ms 0}
                 (fn []
                   (call! profile :mcp-apply-operations
                          {:file-id file-id
                           :allow-split true
                           :operations (split-ops page1)})))]
    (t/is (= :mcp-time-budget-exceeded (error-code out)))
    (t/is (= rev0 (revn file-id)))
    (t/is (= frags0 (fragment-count file-id)))))

;; --- SNAPSHOTS IN A SPLIT CALL

(t/deftest automatic-snapshot-is-taken-once-per-split-call
  (let [{:keys [profile file-id pages]} (create-paged-fixture)
        [page1] pages
        ;; The test config takes an automatic snapshot on every revn.
        auto0 (internal-snapshot-count file-id)
        ;; No MCP snapshot: the call would take 302 operations as a reason.
        out   (call! profile :mcp-apply-operations
                     {:file-id file-id
                      :allow-split true
                      :snapshot false
                      :operations (split-ops page1)})]
    (t/is (nil? (:error out)))
    (t/is (= 2 (:commits (:result out))))
    (t/is (= 1 (- (internal-snapshot-count file-id) auto0)))))

(t/deftest mcp-snapshot-replaces-the-automatic-one-in-a-split-call
  (let [{:keys [profile file-id pages]} (create-paged-fixture)
        [page1] pages
        auto0 (internal-snapshot-count file-id)
        mcp0  (count (filter #(str/starts-with? (:label %) "mcp/")
                             (snapshot-rows file-id)))
        out   (call! profile :mcp-apply-operations
                     {:file-id file-id
                      :allow-split true
                      :snapshot true
                      :operations (split-ops page1)})
        mcp1  (count (filter #(str/starts-with? (:label %) "mcp/")
                             (snapshot-rows file-id)))]
    (t/is (nil? (:error out)))
    (t/is (= 1 (- mcp1 mcp0)))
    (t/is (= auto0 (internal-snapshot-count file-id)))))

;; --- VALIDATION AND GATES

(t/deftest forced-validation-refuses-a-dangling-parent
  ;; The flags are off, so only the forced check can see the mismatch: the
  ;; rect is moved to another parent without the parent lists changing.
  (let [{:keys [profile file-id page-id]} (create-fixture)
        board  (create-board! profile file-id page-id)
        other  (create-board! profile file-id page-id)
        rect   (uuid/next)
        setup  (call! profile :mcp-apply-changes
                      {:file-id file-id
                       :changes [(add-rect page-id rect board)]})
        rev0   (revn file-id)
        out    (call! profile :mcp-apply-changes
                      {:file-id file-id
                       :changes [{:type :mod-obj
                                  :page-id page-id
                                  :id rect
                                  :operations [{:type :set :attr :parent-id :val other}]}]})]
    (t/is (nil? (:error setup)))
    (t/is (= :referential-integrity (error-code out)))
    (t/is (= rev0 (revn file-id)))))

(t/deftest raw-changes-are-refused-unless-the-flag-is-on
  (let [{:keys [profile file-id page-id]} (create-fixture)
        change (add-frame page-id (uuid/next))
        off    (with-redefs [cf/flags (disj cf/flags :mcp-raw-changes)]
                 (call! profile :mcp-apply-changes
                        {:file-id file-id :changes [change]}))
        on     (call! profile :mcp-apply-changes
                      {:file-id file-id :changes [(add-frame page-id (uuid/next))]})]
    (t/is (= :mcp-raw-changes-disabled (error-code off)))
    (t/is (nil? (:error on)))))

(t/deftest oversized-operations-are-refused-before-the-lock
  (let [{:keys [profile file-id page-id]} (create-fixture)
        ops (mapv #(op-rect page-id (str "$tmp:x" %) %) (range 2001))
        out (with-redefs [bfc/get-file (fn [& _] (throw (ex-info "loaded" {})))]
              (call! profile :mcp-apply-operations
                     {:file-id file-id :operations ops}))]
    (t/is (= :mcp-batch-too-large (error-code out)))))

(t/deftest dry-run-loads-the-file-read-only
  (let [{:keys [profile file-id page-id]} (create-fixture)
        seen (atom [])
        orig bfc/get-file
        out  (with-redefs [bfc/get-file
                           (fn [cfg id & opts]
                             (swap! seen conj (apply hash-map opts))
                             (apply orig cfg id opts))]
               (call! profile :mcp-apply-operations
                      {:file-id file-id
                       :dry-run true
                       :operations [(op-board page-id)]}))]
    (t/is (nil? (:error out)))
    (t/is (some #(true? (:read-only? %)) @seen))))

;; --- CUTS AND CAPS

(defn- sized-ops
  "Ranges for operations of `counts` changes each, with the changes."
  [counts]
  (reduce (fn [{:keys [changes ranges]} n]
            (let [start (count changes)]
              {:changes (into changes (repeat n {:type :add-obj}))
               :ranges  (conj ranges [start (+ start n)])}))
          {:changes [] :ranges []}
          counts))

(t/deftest large-call-is-cut-into-batches-without-allow-split
  ;; The real bound: 3000 changes cannot share a batch of at most 2000.
  (with-redefs-fn {#'mcp-write/notify-changes 2000}
    (fn []
      (let [{:keys [changes ranges]} (sized-ops [1500 1500])
            batches (#'mcp-write/batches-of changes ranges false)]
        (t/is (= 2 (count batches)))
        (t/is (= [1500 1500] (mapv (comp count :changes) batches)))
        (t/is (= 3000 (reduce + (map (comp count :changes) batches))))))))

(t/deftest small-call-without-allow-split-stays-in-one-batch
  (let [{:keys [changes ranges]} (sized-ops [10 10])]
    (t/is (= 1 (count (#'mcp-write/batches-of changes ranges false))))))

(t/deftest call-takes-at-most-fifty-batches
  (t/is (nil? (#'mcp-write/check-batch-count! (repeat 50 {}))))
  (let [error (try
                (#'mcp-write/check-batch-count! (repeat 51 {}))
                nil
                (catch Exception cause cause))]
    (t/is (= :mcp-too-many-batches (:code (ex-data error))))))

(t/deftest token-deletes-take-a-snapshot-even-without-attrs
  (let [wanted? #'mcp-write/snapshot-wanted?]
    (t/is (true? (wanted? false [{:type :set-token-set :id (uuid/next)}] 1)))
    (t/is (true? (wanted? false [{:type :set-token :name "t"}] 1)))
    (t/is (false? (wanted? false [{:type :set-token :name "t" :attrs {:value "1"}}] 1)))))

;; --- MIGRATION GUARD AND LIBRARY PAGES

(t/deftest migrate-on-read-writes-only-the-revn-it-read
  (let [{:keys [file-id]} (create-fixture)
        stored (revn file-id)
        file   (db/tx-run! th/*system* (fn [cfg] (bfc/get-file cfg file-id)))
        stale  (db/tx-run! th/*system*
                           (fn [cfg] (#'bfc/update-migrated-file! cfg file (dec stored))))
        fresh  (db/tx-run! th/*system*
                           (fn [cfg] (#'bfc/update-migrated-file! cfg file stored)))]
    (t/is (false? stale))
    (t/is (true? fresh))
    (t/is (= stored (revn file-id)))))

(t/deftest unused-library-pages-stay-unloaded
  (let [{:keys [profile file-id page-id]} (create-fixture)
        lib-id (:id (th/create-file* 2 {:profile-id (:id profile)
                                        :project-id (:default-project-id profile)
                                        :is-shared true}))
        _      (th/link-file-to-library* {:file-id file-id :library-id lib-id})
        board  (create-board! profile file-id page-id)
        lib-ptrs (set (fdata/get-used-pointer-ids
                       (:data (bfc/get-file th/*system* lib-id))))
        loads  (atom #{})
        orig   fdata/load-pointer-of-files
        out    (with-redefs [fdata/load-pointer-of-files
                             (fn [cfg file-ids id]
                               (swap! loads conj id)
                               (orig cfg file-ids id))]
                 (call! profile :mcp-apply-changes
                        {:file-id file-id
                         :changes [(rename-shape page-id board "Renamed")]}))]
    (t/is (seq lib-ptrs))
    (t/is (nil? (:error out)))
    (t/is (empty? (set/intersection @loads lib-ptrs)))))

;; --- DELETED MEDIA

(t/deftest deleted-media-is-refused-like-a-foreign-one
  (let [{:keys [profile file-id page-id]} (create-fixture)
        old    (:id (create-media file-id))
        new    (:id (create-media file-id))
        _      (th/db-update! :file-media-object {:deleted-at (ct/now)} {:id old})
        board  (create-board! profile file-id page-id)
        image-fill (fn [media]
                     [{:fill-opacity 1
                       :fill-image {:id media :width 10 :height 10
                                    :mtype "image/png" :name "img"}}])
        bad    (call! profile :mcp-apply-changes
                      {:file-id file-id
                       :changes [(assoc (add-rect page-id (uuid/next) board)
                                        :obj (cts/setup-shape {:id (uuid/next) :type :rect
                                                               :name "R" :parent-id board
                                                               :frame-id board
                                                               :fills (image-fill old)}))]})]
    (t/is (= :mcp-foreign-media (error-code bad)))
    (t/is (not= new old))))

;; --- NOTIFICATION BUFFER

(t/deftest publish-buffer-keeps-its-size-when-full
  (let [buf (#'mbus/logging-dropping-buffer 2)]
    (t/is (true? (pt/-offer buf 1)))
    (t/is (true? (pt/-offer buf 2)))
    ;; A third message is dropped: the offer still succeeds, the size holds.
    (t/is (true? (pt/-offer buf 3)))
    (t/is (= 2 (pt/-size buf)))))

;; --- LIBRARIES AND POINTER LOADERS

(defn- pointer-loads-of
  "Calls `f` with `fdata/load-pointer-of-files` counted. Returns an atom
  with the file id sets each call named."
  [f]
  (let [seen (atom [])
        orig fdata/load-pointer-of-files]
    (with-redefs [fdata/load-pointer-of-files
                  (fn [cfg file-ids id]
                    (swap! seen conj (set file-ids))
                    (orig cfg file-ids id))]
      (f))
    seen))

(t/deftest instantiate-library-component
  (let [profile (th/create-profile* 6 {:is-active true})
        lib     (th/create-file* 6 {:profile-id (:id profile)
                                    :project-id (:default-project-id profile)
                                    :is-shared true})
        lib-pid (get-in lib [:data :pages 0])
        file    (th/create-file* 7 {:profile-id (:id profile)
                                    :project-id (:default-project-id profile)})
        pid     (get-in file [:data :pages 0])
        out1    (call! profile :mcp-apply-operations
                       {:file-id (:id lib)
                        :operations [(op-board lib-pid)
                                     (op-rect lib-pid "$tmp:r" 1)
                                     {:op "create_component" :page-id lib-pid
                                      :shape-ids ["$tmp:board"] :name "C" :id "$tmp:c"}]})
        comp-id (get-in out1 [:result :created-ids "$tmp:c"])
        _       (th/link-file-to-library* {:file-id (:id file) :library-id (:id lib)})
        copy    (atom nil)
        loads   (pointer-loads-of
                 (fn []
                   (let [out2 (call! profile :mcp-apply-operations
                                     {:file-id (:id file)
                                      :operations [{:op "instantiate_component" :page-id pid
                                                    :component-id (str comp-id)
                                                    :library-id (str (:id lib))
                                                    :x 300 :y 0 :id "$tmp:copy"}]})]
                     (t/is (nil? (:error out2)))
                     (reset! copy (get-in out2 [:result :created-ids "$tmp:copy"])))))
        copy-id @copy
        stored  (bfc/get-file th/*system* (:id file) :realize? true)
        objects (get-in stored [:data :pages-index pid :objects])]
    (t/is (nil? (:error out1)))
    (t/is (some? comp-id))
    (t/is (= (:id lib) (:component-file (get objects copy-id))))
    ;; The copy has its one child, the rect of the component.
    (t/is (= 1 (count (filter #(= copy-id (:parent-id %)) (vals objects)))))
    ;; The lookup names the library's file id, so its pages load.
    (t/is (some #(contains? % (:id lib)) @loads))))

(t/deftest pointer-loader-is-strict-about-the-file
  (let [profile (th/create-profile* 8 {:is-active true})
        file    (th/create-file* 8 {:profile-id (:id profile)
                                    :project-id (:default-project-id profile)})
        other   (th/create-file* 9 {:profile-id (:id profile)
                                    :project-id (:default-project-id profile)})
        ptr     (first (fdata/get-used-pointer-ids
                        (:data (bfc/get-file th/*system* (:id other)))))
        error   (try
                  (fdata/load-pointer th/*system* (:id file) ptr)
                  nil
                  (catch Exception cause cause))]
    (t/is (some? ptr))
    (t/is (= :fragment-not-found (:code (ex-data error))))))

(t/deftest libraries-are-resolved-once-per-call
  (let [{:keys [profile file-id pages]} (create-paged-fixture)
        [page1] pages
        n    (atom 0)
        orig files-update/library-files
        out  (with-redefs [files-update/library-files
                           (fn [cfg id] (swap! n inc) (orig cfg id))]
               (call! profile :mcp-apply-operations
                      {:file-id file-id
                       :allow-split true
                       :snapshot false
                       :operations (split-ops page1)}))]
    (t/is (nil? (:error out)))
    (t/is (= 2 (:commits (:result out))))
    ;; One resolve for the whole call: the compile, the validation and the
    ;; batches all use it.
    (t/is (= 1 @n))))

;; --- CHECKS AND REPLAY

(t/deftest forced-schema-check-runs-once-per-call
  (let [{:keys [profile file-id page-id]} (create-fixture)
        n    (atom 0)
        orig val/validate-file-schema!
        out  (with-redefs [val/validate-file-schema!
                           (fn [file] (swap! n inc) (orig file))]
               (call! profile :mcp-apply-changes
                      {:file-id file-id
                       :changes [(add-frame page-id (uuid/next))]}))]
    (t/is (nil? (:error out)))
    (t/is (= 1 @n))))

(t/deftest reused-request-id-with-another-payload-is-a-new-write
  (let [{:keys [profile file-id page-id]} (create-fixture)
        request (uuid/next)
        _       (call! profile :mcp-apply-changes
                       {:file-id file-id :request-id request
                        :changes [(add-frame page-id (uuid/next))]})
        rev1    (revn file-id)
        out     (call! profile :mcp-apply-changes
                       {:file-id file-id :request-id request
                        :changes [(add-frame page-id (uuid/next))]})]
    (t/is (nil? (:error out)))
    (t/is (not (:already-applied (:result out))))
    (t/is (= (inc rev1) (revn file-id)))))

(t/deftest lagged-rows-come-back-in-revn-order
  (let [{:keys [profile file-id page-id]} (create-fixture)
        now (ct/now)
        ;; Rows of one instant, inserted out of revn order.
        _   (doseq [r [3 1 2]]
              (th/db-insert! :file-change
                             {:id (uuid/next)
                              :session-id (uuid/next)
                              :profile-id (:id profile)
                              :created-at now
                              :updated-at now
                              :file-id file-id
                              :revn r
                              :version 0
                              :changes (blob/encode [])}
                             {::db/return-keys false}))
        out (db/tx-run! th/*system*
                        (fn [cfg]
                          (files-update/update-file!
                           cfg {::rpc/profile-id (:id profile)
                                :id file-id
                                :session-id (uuid/random)
                                :revn 0
                                :vern 0
                                :features cfeat/supported-features
                                :changes [(add-frame page-id (uuid/next))]})))
        revns (mapv :revn (:lagged out))]
    ;; The three rows, and the call's own row of revn 1.
    (t/is (= 4 (count revns)))
    (t/is (= (sort revns) revns))))

;; --- WHAT A SPLIT WRITE STORES

(t/deftest split-write-stores-every-object
  (let [{:keys [profile file-id pages]} (create-paged-fixture)
        [page1] pages
        before (object-count file-id page1)
        out    (call! profile :mcp-apply-operations
                      {:file-id file-id
                       :allow-split true
                       :snapshot false
                       :operations (split-ops page1)})]
    (t/is (nil? (:error out)))
    (t/is (= 302 (- (object-count file-id page1) before)))))

(t/deftest split-write-keeps-one-change-row-per-batch
  (let [{:keys [profile file-id pages]} (create-paged-fixture)
        [page1] pages
        rev0  (revn file-id)
        rows0 (count (filter (comp nil? :label) (file-changes file-id)))
        out   (call! profile :mcp-apply-operations
                     {:file-id file-id
                      :allow-split true
                      :snapshot false
                      :operations (split-ops page1)})
        rows  (th/db-exec! ["SELECT revn FROM file_change
                              WHERE file_id = ? AND label IS NULL AND revn > ?
                              ORDER BY revn ASC" file-id rev0])]
    (t/is (nil? (:error out)))
    (t/is (= (+ rev0 2) (revn file-id)))
    (t/is (= (+ rows0 2) (count (filter (comp nil? :label) (file-changes file-id)))))
    (t/is (= [(+ rev0 1) (+ rev0 2)] (mapv :revn rows)))))

(t/deftest split-write-notifies-each-batch-with-its-revn
  (let [{:keys [profile file-id pages]} (create-paged-fixture)
        [page1] pages
        rev0  (revn file-id)
        pubs  (atom [])
        out   (with-redefs [mbus/pub! (fn [& args]
                                        (swap! pubs conj (apply hash-map (rest args))))]
                (call! profile :mcp-apply-operations
                       {:file-id file-id
                        :allow-split true
                        :snapshot false
                        :operations (split-ops page1)}))
        revns (->> @pubs
                   (map :message)
                   (filter #(= :file-change (:type %)))
                   (mapv :revn))]
    (t/is (nil? (:error out)))
    (t/is (= [(+ rev0 1) (+ rev0 2)] revns))))

(t/deftest repairing-batch-keeps-its-revn-row
  (let [{:keys [profile file-id page-id]} (create-fixture)
        board (create-board! profile file-id page-id)
        other (create-board! profile file-id page-id)
        rect  (uuid/next)
        _     (call! profile :mcp-apply-changes
                     {:file-id file-id :changes [(add-rect page-id rect board)]})
        ;; The editor path does not check references: move the rect to
        ;; another parent without the parent lists changing. The file is
        ;; damaged before the MCP call.
        _     (th/update-file! :profile-id (:id profile)
                               :file-id file-id
                               :revn (revn file-id)
                               :changes [{:type :mod-obj
                                          :page-id page-id
                                          :id rect
                                          :operations [{:type :set :attr :parent-id :val other}]}])
        rev0  (revn file-id)
        out   (call! profile :mcp-apply-changes
                     {:file-id file-id
                      :changes [(rename-shape page-id rect "Renamed")]})
        repairs (th/db-exec! ["SELECT revn FROM file_change
                                WHERE file_id = ? AND session_id = ?"
                              file-id files-update/repair-session-id])]
    (t/is (nil? (:error out)))
    (t/is (pos? (count repairs)))
    ;; The repair takes one revn and the call's change takes the next.
    (t/is (= (+ rev0 2) (revn file-id)))))

(t/deftest live-media-passes-the-ownership-check
  (let [{:keys [profile file-id page-id]} (create-fixture)
        board (create-board! profile file-id page-id)
        media (:id (create-media file-id))
        out   (call! profile :mcp-apply-changes
                     {:file-id file-id
                      :changes [(assoc (add-rect page-id (uuid/next) board)
                                       :obj (cts/setup-shape
                                             {:id (uuid/next) :type :rect :name "R"
                                              :parent-id board :frame-id board
                                              :fills [{:fill-opacity 1
                                                       :fill-image {:id media :width 10 :height 10
                                                                    :mtype "image/svg+xml"
                                                                    :name "img"}}]}))]})]
    (t/is (nil? (:error out)))))

(t/deftest dry-run-instantiates-a-component-of-the-same-file
  (let [{:keys [profile file-id page-id]} (create-fixture)
        out1 (call! profile :mcp-apply-operations
                    {:file-id file-id
                     :operations [(op-board page-id)
                                  (op-rect page-id "$tmp:r" 1)
                                  {:op "create_component" :page-id page-id
                                   :shape-ids ["$tmp:board"] :name "C" :id "$tmp:c"}]})
        comp (get-in out1 [:result :created-ids "$tmp:c"])
        dry  (call! profile :mcp-apply-operations
                    {:file-id file-id
                     :dry-run true
                     :operations [{:op "instantiate_component" :page-id page-id
                                   :component-id (str comp) :x 300 :y 0 :id "$tmp:copy"}]})]
    (t/is (nil? (:error out1)))
    (t/is (nil? (:error dry)))
    (t/is (pos? (get-in dry [:result :change-count])))))

;; --- NOTIFICATION BUFFER RATE

(t/deftest drop-warning-is-due-once-a-second
  (t/is (false? (#'mbus/drop-log-due? 0 999)))
  (t/is (true? (#'mbus/drop-log-due? 0 1000))))

;; --- REFLOW AND THE BOUND

(t/deftest reflow-over-the-bound-gets-its-own-batch
  (with-redefs-fn {#'mcp-write/notify-changes 2000}
    (fn []
      (let [{:keys [changes ranges]} (sized-ops [1990])
            reflow  (repeat 50 {:type :mod-obj})
            batches (#'mcp-write/batches-of (into changes reflow) ranges true)]
        ;; 1990 + 50 would be 2040 changes in one notification.
        (t/is (= [1990 50] (mapv (comp count :changes) batches)))
        (t/is (= [0 0] [(:first-op (first batches)) (:last-op (first batches))]))
        (t/is (nil? (:first-op (second batches))))))))

(t/deftest reflow-within-the-bound-stays-in-the-last-batch
  (with-redefs-fn {#'mcp-write/notify-changes 2000}
    (fn []
      (let [{:keys [changes ranges]} (sized-ops [1500])
            batches (#'mcp-write/batches-of (into changes (repeat 400 {:type :mod-obj}))
                                            ranges true)]
        (t/is (= [1900] (mapv (comp count :changes) batches)))))))

(t/deftest oversize-reflow-is-cut-into-bounded-batches
  (with-redefs-fn {#'mcp-write/notify-changes 2000}
    (fn []
      (let [{:keys [changes ranges]} (sized-ops [100])
            batches (#'mcp-write/batches-of (into changes (repeat 4500 {:type :mod-obj}))
                                            ranges true)]
        (t/is (= [100 2000 2000 500] (mapv (comp count :changes) batches)))
        (t/is (every? #(<= (count (:changes %)) 2000) batches))))))

;; --- LIBRARY OF A LIBRARY

(t/deftest instantiate-a-component-of-a-library-of-a-library
  (let [profile (th/create-profile* 10 {:is-active true})
        mk      (fn [n shared?]
                  (th/create-file* n {:profile-id (:id profile)
                                      :project-id (:default-project-id profile)
                                      :is-shared shared?}))
        lib-b   (mk 10 true)
        lib-a   (mk 11 true)
        file    (mk 12 false)
        pid     (get-in file [:data :pages 0])
        bpid    (get-in lib-b [:data :pages 0])
        out1    (call! profile :mcp-apply-operations
                       {:file-id (:id lib-b)
                        :operations [(op-board bpid)
                                     (op-rect bpid "$tmp:r" 1)
                                     {:op "create_component" :page-id bpid
                                      :shape-ids ["$tmp:board"] :name "C" :id "$tmp:c"}]})
        comp-id (get-in out1 [:result :created-ids "$tmp:c"])
        _       (th/link-file-to-library* {:file-id (:id lib-a) :library-id (:id lib-b)})
        _       (th/link-file-to-library* {:file-id (:id file) :library-id (:id lib-a)})
        out2    (call! profile :mcp-apply-operations
                       {:file-id (:id file)
                        :operations [{:op "instantiate_component" :page-id pid
                                      :component-id (str comp-id)
                                      :library-id (str (:id lib-b))
                                      :x 300 :y 0 :id "$tmp:copy"}]})
        copy-id (get-in out2 [:result :created-ids "$tmp:copy"])
        stored  (bfc/get-file th/*system* (:id file) :realize? true)
        copy    (get-in stored [:data :pages-index pid :objects copy-id])]
    (t/is (nil? (:error out1)))
    (t/is (nil? (:error out2)))
    (t/is (= (:id lib-b) (:component-file copy)))))

;; --- EDITOR SAVES AND LIBRARY QUERIES

(t/deftest editor-save-runs-no-library-query
  (let [{:keys [profile file-id page-id]} (create-fixture)
        lib    (th/create-file* 13 {:profile-id (:id profile)
                                    :project-id (:default-project-id profile)
                                    :is-shared true})
        _      (th/link-file-to-library* {:file-id file-id :library-id (:id lib)})
        n      (atom 0)
        orig   bfc/get-file-libraries
        out    (with-redefs [bfc/get-file-libraries
                             (fn [conn id] (swap! n inc) (orig conn id))]
                 (th/update-file! :profile-id (:id profile)
                                  :file-id file-id
                                  :revn (revn file-id)
                                  :changes [(add-frame page-id (uuid/next))]))]
    (t/is (some? out))
    ;; The library rows are read only when a pointer misses the file.
    (t/is (zero? @n))))

;; --- REPLAY KEY

(t/deftest replay-digest-ignores-key-order-and-nil-values
  (let [text  #(#'mcp-write/canonical-text %)
        plain (text {:type :add-obj :id 1 :page-id 2})
        order (text (apply array-map (mapcat identity (reverse [[:type :add-obj] [:id 1] [:page-id 2]]))))
        nils  (text {:type :add-obj :id 1 :page-id 2 :extra nil})]
    (t/is (= plain order))
    (t/is (= plain nils))
    (t/is (not= plain (text {:type :add-obj :id 1 :page-id 3})))))

(t/deftest replay-with-reordered-keys-and-nil-values-is-a-replay
  (let [{:keys [profile file-id page-id]} (create-fixture)
        request (uuid/next)
        change  (add-frame page-id (uuid/next))
        _       (call! profile :mcp-apply-changes
                       {:file-id file-id :request-id request :changes [change]})
        rev1    (revn file-id)
        ;; The same change with its keys in another order, and a snapshot
        ;; option sent as nil, which is the same as no option.
        again   (apply array-map (mapcat identity (reverse (seq change))))
        out     (call! profile :mcp-apply-changes
                       {:file-id file-id :request-id request
                        :snapshot nil :changes [again]})]
    (t/is (nil? (:error out)))
    (t/is (true? (:already-applied (:result out))))
    (t/is (= rev1 (revn file-id)))))

;; --- LOCK WAITS

(t/deftest lock-waits-name-the-file-or-the-other-rows
  (let [wait (fn [file-lock?]
               (try
                 (#'mcp-write/lock-wait! file-lock? uuid/zero
                                         #(throw (java.sql.SQLException. "lock timeout" "55P03")))
                 nil
                 (catch Exception cause cause)))]
    (t/is (= :mcp-file-busy (:code (ex-data (wait true)))))
    (t/is (= :mcp-lock-timeout (:code (ex-data (wait false)))))
    (t/is (= :conflict (:type (ex-data (wait false)))))
    (t/is (str/includes? (:hint (ex-data (wait false))) "project or team row"))))

(t/deftest other-sql-errors-are-not-lock-waits
  (let [error (try
                (#'mcp-write/lock-wait! false uuid/zero
                                        #(throw (java.sql.SQLException. "other" "23505")))
                nil
                (catch java.sql.SQLException cause cause))]
    (t/is (= "23505" (.getSQLState error)))))

;; --- COST SHAPE OF THE AFFECTED CHECK

(t/deftest affected-check-visits-the-touched-shapes-only
  ;; A page with 200 shapes: a write that renames one of them must check
  ;; that shape, not every shape of the page.
  (let [{:keys [profile file-id page-id]} (create-fixture)
        board (create-board! profile file-id page-id)
        ids   (vec (repeatedly 200 uuid/next))
        setup (call! profile :mcp-apply-changes
                     {:file-id file-id
                      :changes (mapv #(add-rect page-id % board) ids)})
        visited (atom 0)
        orig    @#'val/check-shape
        out     (with-redefs-fn {#'val/check-shape
                                 (fn [& args]
                                   (swap! visited inc)
                                   (apply orig args))}
                  (fn []
                    (call! profile :mcp-apply-changes
                           {:file-id file-id
                            :changes [(rename-shape page-id (first ids) "Renamed")]})))]
    (t/is (nil? (:error setup)))
    (t/is (nil? (:error out)))
    (t/is (= 1 @visited))))

;; --- FILE_CHANGE INDEXES (migration 0159)

(defn- plan-of
  "The EXPLAIN text of `sql` with `params`, planned with sequential scans
  off, so a plan that names an index uses it when one exists."
  [sql params]
  (db/tx-run! th/*system*
              (fn [cfg]
                (let [conn (::db/conn cfg)]
                  (db/exec! conn ["SET LOCAL enable_seqscan = off"])
                  (->> (db/exec! conn (into [(str "EXPLAIN " sql)] params))
                       (map #(str (first (vals %))))
                       (str/join "\n"))))))

(t/deftest file-change-indexes-serve-the-replay-and-snapshot-queries
  (let [{:keys [profile file-id page-id]} (create-fixture)
        _     (create-board! profile file-id page-id)
        names (set (map :indexname
                        (th/db-exec! ["SELECT indexname FROM pg_indexes
                                        WHERE tablename = 'file_change'"])))
        replay-plan (plan-of @#'mcp-write/sql:session-exists
                             [file-id (uuid/next)])
        label-plan  (plan-of @#'files-update/sql:mcp-snapshots
                             [file-id (ct/now)])]
    (t/is (contains? names "file_change__file_id__session_id__idx"))
    (t/is (contains? names "file_change__file_id__created_at__labelled__idx"))
    (t/is (str/includes? replay-plan "file_change__file_id__session_id__idx"))
    (t/is (not (str/includes? replay-plan "Seq Scan on file_change")))
    (t/is (str/includes? label-plan "file_change__file_id__created_at__labelled__idx"))
    (t/is (not (str/includes? label-plan "Seq Scan on file_change")))))
