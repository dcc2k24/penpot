;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-file-update-commit-test
  (:require
   [app.binfile.common :as bfc]
   [app.common.features :as cfeat]
   [app.common.time :as ct]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.db :as db]
   [app.features.file-snapshots :as fsnap]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.files-update :as files-update]
   [backend-tests.helpers :as th]
   [clojure.string :as str]
   [clojure.test :as t]))

(t/use-fixtures :once th/state-init)
(t/use-fixtures :each th/database-reset)

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; Helpers
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- add-rect
  [page-id shape-id]
  {:type :add-obj
   :page-id page-id
   :id shape-id
   :parent-id uuid/zero
   :frame-id uuid/zero
   :components-v2 true
   :obj (cts/setup-shape
         {:id shape-id
          :name "rect"
          :frame-id uuid/zero
          :parent-id uuid/zero
          :type :rect})})

(def ^:private profile-index
  "Every profile of a test needs its own index: the helpers derive the
  profile id and email from it."
  (atom 0))

(defn- setup-file
  []
  (let [n       (swap! profile-index inc)
        profile (th/create-profile* n {:is-active true})
        file    (th/create-file* n {:profile-id (:id profile)
                                    :project-id (:default-project-id profile)
                                    :is-shared false})]
    {:profile-id (:id profile)
     :file-id    (:id file)
     :page-id    (first (get-in file [:data :pages]))}))

(defn- stored-revn
  [file-id]
  (:revn (bfc/get-file th/*system* file-id :realize? true)))

(defn- commit!
  "Commit `changes` through `files-update/update-file!` in its own
  transaction, the way the MCP write path calls it. Extra keyword
  arguments are merged into the params (MCP hooks)."
  [{:keys [profile-id file-id]} revn changes & {:as extra}]
  (db/tx-run! th/*system*
              (fn [cfg]
                (files-update/update-file!
                 cfg
                 (merge {::rpc/profile-id profile-id
                         :id file-id
                         :session-id (uuid/random)
                         :revn revn
                         :vern 0
                         :features cfeat/supported-features
                         :changes changes}
                        extra)))))

(defn- all-snapshot-rows
  "Every `file_change` row of the file that carries a label, deleted or
  not."
  [file-id]
  (->> (th/db-query :file-change {:file-id file-id} {::db/remove-deleted false})
       (filter :label)))

(defn- live-snapshot-rows
  "Snapshots not yet past their deletion date. System snapshots carry
  a future `deleted-at` from birth, so only a past one counts as gone."
  [file-id]
  (let [now (inst-ms (ct/now))]
    (->> (all-snapshot-rows file-id)
         (remove #(when-let [deleted-at (:deleted-at %)]
                    (<= (inst-ms deleted-at) now))))))

(defn- mcp-label?
  [label]
  (str/starts-with? label "mcp/"))

(defn- create-user-snapshot!
  [{:keys [profile-id file-id]} label]
  (db/tx-run! th/*system*
              (fn [cfg]
                (fsnap/create! cfg
                               (bfc/get-file cfg file-id :realize? true)
                               {:label label
                                :profile-id profile-id
                                :created-by "user"}))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; Tests
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(t/deftest update-file-commits-like-the-rpc
  (let [direct  (setup-file)
        rpc     (setup-file)
        out     (commit! direct 0 [(add-rect (:page-id direct) (uuid/next))])
        res     (th/update-file! :profile-id (:profile-id rpc)
                                 :file-id (:file-id rpc)
                                 :changes [(add-rect (:page-id rpc) (uuid/next))]
                                 :revn 0)
        changes (fn [file-id]
                  (->> (th/db-query :file-change {:file-id file-id})
                       (filter :changes)
                       (remove :label)
                       (sort-by :revn)
                       (mapv :revn)))]

    (t/is (= 0 (:revn out)))
    (t/is (= 0 (:revn res)))
    (t/is (= (set (keys res)) (set (keys out))))

    (t/is (= 1 (stored-revn (:file-id direct))))
    (t/is (= 1 (stored-revn (:file-id rpc))))

    (t/is (= [1] (changes (:file-id direct))))
    (t/is (= [1] (changes (:file-id rpc))))

    ;; Without the MCP hooks the result carries no MCP keys
    (t/is (not (contains? out :snapshot-id)))
    (t/is (not (contains? out :changed-shape-ids)))))

(t/deftest mcp-snapshot-creates-one-labelled-snapshot
  (let [ctx   (setup-file)
        label "mcp/apply-changes/2026-11-04T10:00:00Z/req-1"
        out   (commit! ctx 0
                       [(add-rect (:page-id ctx) (uuid/next))]
                       ::files-update/mcp-snapshot {:label label :keep 20})
        rows  (live-snapshot-rows (:file-id ctx))]

    (t/is (uuid? (:snapshot-id out)))

    (let [mcp-rows (filter (comp mcp-label? :label) rows)]
      (t/is (= 1 (count mcp-rows)))
      (t/is (= label (:label (first mcp-rows))))
      (t/is (= "system" (:created-by (first mcp-rows))))
      (t/is (= (:snapshot-id out) (:id (first mcp-rows))))
      ;; no automatic internal snapshot in the same call
      (t/is (empty? (filter #(str/starts-with? (:label %) "internal/snapshot/") rows))))

    ;; control: the same commit without the hook takes the automatic
    ;; internal snapshot (the fixture enables auto snapshots every revn)
    (let [plain (setup-file)]
      (commit! plain 0 [(add-rect (:page-id plain) (uuid/next))])
      (t/is (= 1 (count (filter #(str/starts-with? (:label %) "internal/snapshot/")
                                (live-snapshot-rows (:file-id plain)))))))))

(t/deftest mcp-snapshots-are-pruned-to-keep
  (let [ctx        (setup-file)
        file-id    (:file-id ctx)
        user-label "user-kept"]

    (doseq [i (range 22)]
      (commit! ctx (stored-revn file-id)
               [(add-rect (:page-id ctx) (uuid/next))]
               ::files-update/mcp-snapshot {:label (str "mcp/test/" i) :keep 20})
      (when (= i 10)
        (create-user-snapshot! ctx user-label)))

    (let [rows (live-snapshot-rows file-id)
          mcp  (filter (comp mcp-label? :label) rows)
          user (filter #(= user-label (:label %)) rows)]
      (t/is (= 20 (count mcp)))
      (t/is (= (set (map #(str "mcp/test/" %) (range 2 22)))
               (set (map :label mcp))))
      (t/is (every? #(= "system" (:created-by %)) mcp))
      (t/is (= 1 (count user)))
      (t/is (= "user" (:created-by (first user)))))))

(t/deftest mcp-snapshot-keep-zero-keeps-one
  (let [ctx     (setup-file)
        file-id (:file-id ctx)]

    (doseq [i (range 2)]
      (commit! ctx (stored-revn file-id)
               [(add-rect (:page-id ctx) (uuid/next))]
               ::files-update/mcp-snapshot {:label (str "mcp/test/keep0/" i) :keep 0}))

    (let [mcp (filter (comp mcp-label? :label) (live-snapshot-rows file-id))]
      (t/is (= 1 (count mcp)))
      (t/is (= "mcp/test/keep0/1" (:label (first mcp)))))))

(t/deftest mcp-snapshot-failure-aborts-the-write
  (let [ctx    (setup-file)
        file-id (:file-id ctx)
        before (stored-revn file-id)
        error  (try
                 (with-redefs [fsnap/create! (fn [& _] (throw (ex-info "boom" {})))]
                   (commit! ctx before
                            [(add-rect (:page-id ctx) (uuid/next))]
                            ::files-update/mcp-snapshot {:label "mcp/test/fail" :keep 20}))
                 nil
                 (catch Exception cause cause))]

    (t/is (some? error))
    (t/is (= :snapshot-failed (:code (ex-data error))))
    (t/is (= before (stored-revn file-id)))
    (t/is (empty? (filter (comp mcp-label? :label) (all-snapshot-rows file-id))))))

(t/deftest changed-shape-ids-since-a-revn
  (let [ctx     (setup-file)
        shape-a (uuid/next)
        shape-b (uuid/next)
        before  (stored-revn (:file-id ctx))]

    ;; an earlier commit, with a revn before it
    (commit! ctx before [(add-rect (:page-id ctx) shape-a)])

    (let [out (commit! ctx (stored-revn (:file-id ctx))
                       [(add-rect (:page-id ctx) shape-b)]
                       ::files-update/changed-shape-ids-since before)
          ids (:changed-shape-ids out)]
      ;; the earlier commit's shape is in the result
      (t/is (contains? ids shape-a))
      ;; the shape added by this call's own commit is not
      (t/is (not (contains? ids shape-b)))
      (t/is (= #{shape-a} ids)))))
