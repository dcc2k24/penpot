;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.rpc.commands.files-update
  (:require
   [app.binfile.common :as bfc]
   [app.common.data :as d]
   [app.common.exceptions :as ex]
   [app.common.features :as cfeat]
   [app.common.files.changes :as cpc]
   [app.common.files.migrations :as fmg]
   [app.common.files.repair :as cfr]
   [app.common.files.validate :as val]
   [app.common.logging :as l]
   [app.common.schema :as sm]
   [app.common.time :as ct]
   [app.common.types.component :as ctk]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.features.fdata :as fdata]
   [app.features.file-snapshots :as fsnap]
   [app.features.logical-deletion :as ldel]
   [app.http.errors :as errors]
   [app.loggers.audit :as audit]
   [app.loggers.webhooks :as webhooks]
   [app.metrics :as mtx]
   [app.msgbus :as mbus]
   [app.redis :as rds]
   [app.rpc :as-alias rpc]
   [app.rpc.climit :as climit]
   [app.rpc.commands.files :as files]
   [app.rpc.commands.teams :as teams]
   [app.rpc.doc :as-alias doc]
   [app.rpc.helpers :as rph]
   [app.util.blob :as blob]
   [app.util.pointer-map :as pmap]
   [app.util.services :as sv]
   [clojure.set :as set]))

(declare ^:private get-lagged-changes)
(declare ^:private send-notifications!)
(declare ^:private send-repair-notifications)
(declare ^:private update-file*)
(declare ^:private process-changes-and-validate)
(declare ^:private update-decoded-file!)
(declare ^:private take-snapshot?)
(declare ^:private invalidate-caches!)
(declare change-shape-ids)

;; PUBLIC API; intended to be used outside of this module
(declare update-file!)
(declare persist-file!)
(declare get-file)

;; --- SCHEMA

(def ^:private
  schema:update-file
  [:map {:title "update-file"}
   [:id ::sm/uuid]
   [:session-id ::sm/uuid]
   [:revn {:min 0} ::sm/int]
   [:vern {:min 0} ::sm/int]
   [:features {:optional true} ::cfeat/features]
   [:changes {:optional true} [:vector cpc/schema:change]]
   [:changes-with-metadata {:optional true}
    [:vector [:map
              [:changes [:vector cpc/schema:change]]
              [:hint-origin {:optional true} :keyword]
              [:hint-events {:optional true} [:vector [:string {:max 250}]]]]]]
   [:skip-validate {:optional true} ::sm/boolean]])

(def ^:private
  schema:update-file-result
  [:vector {:title "update-file-result"}
   [:map
    [:changes [:vector cpc/schema:change]]
    [:file-id ::sm/uuid]
    [:id ::sm/uuid]
    [:revn {:min 0} ::sm/int]
    [:session-id ::sm/uuid]]])

;; --- HELPERS

;; File changes that affect to the library, and must be notified
;; to all clients using it.

(def ^:private library-change-types
  #{:add-color
    :mod-color
    :del-color
    :add-media
    :mod-media
    :del-media
    :add-component
    :mod-component
    :del-component
    :restore-component
    :add-typography
    :mod-typography
    :del-typography})

(def ^:private token-change-types
  #{:set-tokens-lib
    :set-token
    :set-token-set
    :set-token-theme
    :rename-token-set-group
    :move-token-set
    :move-token-set-group
    :set-base-font-size})

(def ^:private file-change-types
  #{:add-obj
    :mod-obj
    :del-obj
    :reg-objects
    :mov-objects})

(defn- library-change?
  [{:keys [type] :as change}]
  (or (contains? library-change-types type)
      (contains? token-change-types type)
      (contains? file-change-types type)))

;; Not a real editor session: file-change messages with this id are
;; delivered to every connected session, including the saver.
(def repair-session-id
  #uuid "a11c0de5-0000-4000-8000-000000000001")

(defn- referential-integrity-error?
  [cause]
  (= :referential-integrity (:code (ex-data cause))))

(defn- record-repair-outcome
  [cfg outcome]
  (when-let [metrics (::mtx/metrics cfg)]
    (when (mtx/metrics? metrics)
      (mtx/run! metrics {:id :update-file-repair
                         :labels [(name outcome)]
                         :inc 1}))))

(defn- error-codes
  [errors]
  (into [] (keep :code) errors))

(defn- decode-file
  "The file with its main blob decoded. Its pointer maps stay unloaded."
  [{:keys [id] :as file}]
  (update file :data (fn [data]
                       (-> data
                           (blob/decode)
                           (assoc :id id)))))

;; If features are specified from params and the final feature
;; set is different than the persisted one, update it on the
;; database.

(defn- check-vern!
  "Raises `:vern-conflict` when the file was restored after `vern` was read."
  [file vern revn]
  (when (not= vern (:vern file))
    (ex/raise :type :validation
              :code :vern-conflict
              :hint "A different version has been restored for the file."
              :context {:incoming-revn revn
                        :stored-revn (:revn file)})))

(defn- check-revn!
  "Raises `:revn-conflict` when the client names a revn the file has not
  reached yet."
  [file revn]
  (when (> revn (:revn file))
    (ex/raise :type :validation
              :code :revn-conflict
              :hint "The incoming revision number is greater that stored version."
              :context {:incoming-revn revn
                        :stored-revn (:revn file)})))

(defn- commit-features
  "The features a commit of `file` gets on `team`, from the features the
  client names. Frontend-only features are still in the result."
  [team file client-features]
  (-> (cfeat/get-team-enabled-features cf/flags team)
      (cfeat/check-client-features! client-features)
      (cfeat/check-file-features! (:features file))))

(defn- store-team-features!
  "Stores on `team` the features `features` needs and the team lacks. The
  team row is written only when it changes."
  [conn team features]
  (when-let [features (-> features
                          (set/difference (:features team))
                          (set/difference cfeat/no-team-inheritable-features)
                          (not-empty))]
    (let [features (-> features
                       (set/union (:features team))
                       (set/difference cfeat/no-team-inheritable-features)
                       (into-array))]
      (db/update! conn :team
                  {:features features}
                  {:id (:id team)}
                  {::db/return-keys false}))))

(defn update-file!
  "Apply the changes of `params` to a file. This is the single commit
  path for human (RPC `update-file`) and MCP writes: both go through
  here, so the lock, the revn and vern checks, the features, the
  persistence and the notifications cannot drift apart.

  `cfg` must carry `::db/conn` (the caller owns the transaction) and
  `::mtx/metrics`. `params` carries `::rpc/profile-id`, `:id`, `:revn`,
  `:vern`, `:session-id`, `:features`, either `:changes` or
  `:changes-with-metadata`, and optionally `:skip-validate`.

  One optional MCP hook is read from `params`, `::mcp-snapshot`
  `{:label .. :keep ..}`: before the changes are applied, the pre-change
  file is saved as a snapshot with that label, and the snapshots of this
  file with an `mcp/` label are pruned to the `keep` newest (default 20).
  The automatic snapshot is not taken in the same call. The result
  carries `:snapshot-id`. `::mcp-write?` true makes the snapshots load
  only the pointer maps of the file (see `attach-snapshot`). An MCP write
  that takes several batches uses `begin-batches!`, `apply-batch!` and
  `finish-batches!` instead, which share this path.

  Returns `{:revn <revn before the update> :lagged [...]}` plus the
  `:snapshot-id` key when a snapshot was taken. Its metadata carries
  `::stored-revn`, the revn the call stored (two more than `:revn` when
  the file was repaired)."
  [{:keys [::mtx/metrics ::db/conn] :as cfg}
   {:keys [::rpc/profile-id id changes changes-with-metadata] :as params}]

  (files/check-edition-permissions! conn profile-id id)
  (db/xact-lock! conn id)

  (let [file     (get-file cfg id)
        team     (teams/get-team conn
                                 :profile-id profile-id
                                 :team-id (:team-id file))

        features (commit-features team file (:features params))

        changes  (if changes-with-metadata
                   (->> changes-with-metadata (mapcat :changes) vec)
                   (vec changes))

        params   (-> params
                     (assoc :profile-id profile-id)
                     (assoc :features (set/difference features cfeat/frontend-only-features))
                     (assoc :team team)
                     (assoc :file file)
                     (assoc :changes changes))

        cfg      (assoc cfg ::timestamp (ct/now)
                        ::validation-timings (atom {}))

        tpoint   (ct/tpoint)]

    (check-vern! file (:vern params) (:revn params))
    (check-revn! file (:revn params))

    ;; When newly computed features does not match exactly with the
    ;; features defined on team row, we update it
    (store-team-features! conn team features)


    (mtx/run! metrics {:id :update-file-changes :inc (count changes)})

    (binding [l/*context* (some-> (meta params)
                                  (get :app.http/request)
                                  (errors/request->context))]
      (try
        (-> (update-file* cfg params)
            (rph/with-defer #(let [elapsed (tpoint)
                                   timings @(::validation-timings cfg)]
                               (l/dbg :hint "update-file"
                                      :file-id (str (:id file))
                                      :project-id (str (:project-id file))
                                      :team-id (str (:team-id file))
                                      :status "success"
                                      :time (ct/format-duration elapsed)
                                      :resolve-libs-ms (get timings :resolve-libs-ms)
                                      :process-changes-ms (get timings :process-changes-ms)
                                      :soft-validate-affected-ms (get timings :soft-validate-affected-ms)
                                      :soft-validate-schema-ms (get timings :soft-validate-schema-ms)
                                      :validate-affected-ms (get timings :validate-affected-ms)
                                      :validate-schema-ms (get timings :validate-schema-ms)
                                      :repair-ms (get timings :repair-ms)
                                      :reprocess-changes-ms (get timings :reprocess-changes-ms)))))
        (catch Throwable cause
          ;; NOTE: `with-defer` hooks only run on the success path
          ;; (`handle-response`), so timings collected before a hard
          ;; validation failure would be lost without this inline log.
          (let [timings @(::validation-timings cfg)]
            (l/dbg :hint "update-file"
                   :file-id (str (:id file))
                   :project-id (str (:project-id file))
                   :team-id (str (:team-id file))
                   :status "error"
                   :resolve-libs-ms (get timings :resolve-libs-ms)
                   :process-changes-ms (get timings :process-changes-ms)
                   :soft-validate-affected-ms (get timings :soft-validate-affected-ms)
                   :soft-validate-schema-ms (get timings :soft-validate-schema-ms)
                   :validate-affected-ms (get timings :validate-affected-ms)
                   :validate-schema-ms (get timings :validate-schema-ms)
                   :repair-ms (get timings :repair-ms)
                   :reprocess-changes-ms (get timings :reprocess-changes-ms)))
          (throw cause))))))

(sv/defmethod ::update-file
  {::rpc/id-type :file
   ::climit/id [[:update-file/by-profile ::rpc/profile-id]
                [:update-file/global]]

   ::webhooks/event? true
   ::webhooks/batch-timeout (ct/duration "2m")
   ::webhooks/batch-key (webhooks/key-fn ::rpc/profile-id :id)

   ::sm/params schema:update-file
   ::sm/result schema:update-file-result
   ::doc/module :files
   ::doc/added "1.17"
   ::db/transaction true}
  [cfg params]
  (update-file! cfg params))

(defn- run-batch!
  "Applies `changes` to the decoded `file`, with `features` as the features
  of the commit. Returns `[file snapshot-id]`, see `update-decoded-file!`."
  [cfg file features {:keys [changes skip-validate mcp-snapshot mcp-write? skip-auto-snapshot]}]
  (let [file (assoc file :features
                    (-> features
                        (set/difference cfeat/frontend-only-features)
                        (set/union (:features file))))]
    (binding [cfeat/*current*  features
              cfeat/*previous* (:features file)]
      (update-decoded-file! cfg file
                            {:mcp-snapshot mcp-snapshot
                             :mcp-write? mcp-write?
                             :skip-auto-snapshot skip-auto-snapshot}
                            process-changes-and-validate
                            changes skip-validate))))

(defn- commit-batch!
  "Writes what one applied batch leaves behind, in the transaction of the
  call: the repair row when the batch repaired the file, the automatic
  snapshot the batch took, and the change row. Queues the notifications
  of the batch, which run when the transaction commits. `revn` is the
  revn before the batch."
  [{:keys [::db/conn ::timestamp] :as cfg} {:keys [profile-id session-id team]} file changes revn]
  (let [snapshot-deleted-at (ct/plus timestamp (ldel/get-deletion-delay team))
        deleted-at          (ct/plus timestamp (ct/duration {:hours 1}))
        repair              (::repair file)
        change-created-at   (cond-> timestamp
                              repair (ct/plus (ct/duration {:millis 1})))]

    (if repair
      (let [snapshot-file (or (::snapshot file)
                              (fdata/realize cfg (:original repair)))]
        (fsnap/create! cfg snapshot-file
                       {:label (str "internal/repair/" revn)
                        :created-by "system"
                        :deleted-at snapshot-deleted-at
                        :profile-id profile-id
                        :session-id repair-session-id}))
      (when-let [snapshot (::snapshot file)]
        (fsnap/create! cfg snapshot
                       {:label (str "internal/snapshot/" revn)
                        :created-by "system"
                        :deleted-at snapshot-deleted-at
                        :profile-id profile-id
                        :session-id session-id})))

    (when repair
      (db/insert! conn :file-change
                  {:id (uuid/next)
                   :session-id repair-session-id
                   :profile-id profile-id
                   :created-at timestamp
                   :updated-at timestamp
                   :deleted-at deleted-at
                   :file-id (:id file)
                   :revn (:revn repair)
                   :version (:version file)
                   :features (into-array (:features file))
                   :changes (blob/encode (:changes repair))}
                  {::db/return-keys false})
      (l/wrn :hint "file auto-repaired"
             :file-id (str (:id file))
             :error-codes (error-codes (:errors repair))
             :error-count (count (:errors repair))
             :change-count (count (:changes repair)))
      (record-repair-outcome cfg :repaired))

    ;; Insert change (xlog) with deleted_at in a future data for
    ;; make them automatically eleggible for GC once they expires
    (db/insert! conn :file-change
                {:id (uuid/next)
                 :session-id session-id
                 :profile-id profile-id
                 :created-at change-created-at
                 :updated-at change-created-at
                 :deleted-at deleted-at
                 :file-id (:id file)
                 :revn (:revn file)
                 :version (:version file)
                 :features (into-array (:features file))
                 :changes (blob/encode changes)}
                {::db/return-keys false})

    (when repair
      (send-repair-notifications cfg
                                 {:profile-id profile-id :session-id session-id :team team}
                                 file repair))

    (send-notifications! cfg
                         {:profile-id profile-id :session-id session-id :team team}
                         file changes)))

(defn- update-file*
  "Internal function, part of the update-file process, that encapsulates
  the changes application offload to a separated thread and emit all
  corresponding notifications.

  Follow the inner implementation to `update-decoded-file!` function.

  Only intended for internal use on this module."
  [{:keys [::db/conn ::timestamp] :as cfg}
   {:keys [profile-id file team features changes session-id skip-validate] :as params}]

  (binding [pmap/*tracked* (pmap/create-tracked)
            pmap/*load-fn* (bfc/pointer-loader cfg (:id file))]

    (let [;; We need to preserve the original revn for the response
          revn
          (get file :revn)

          mcp-snapshot
          (when-let [{:keys [label keep]} (::mcp-snapshot params)]
            {:label label
             :keep (max 1 (or keep 20))
             :profile-id profile-id
             :session-id session-id
             :deleted-at (ct/plus timestamp (ldel/get-deletion-delay team))})

          [file snapshot-id]
          (run-batch! cfg (decode-file file) features
                      {:changes changes
                       :skip-validate skip-validate
                       :mcp-snapshot mcp-snapshot
                       :mcp-write? (::mcp-write? params)})]

      (commit-batch! cfg
                     {:profile-id profile-id :session-id session-id :team team}
                     file changes revn)

      (persist-file! cfg (dissoc file ::repair))

      ;; Runs when the transaction commits, so a reader cannot refill the cache with the old summary before the new one is stored.
      (when (contains? cf/flags :redis-cache)
        (let [file-id (:id file)]
          (db/after-commit
           (fn []
             (invalidate-caches! cfg {:id file-id})))))

      (with-meta (cond-> {:revn revn :lagged (get-lagged-changes conn params)}
                   snapshot-id
                   (assoc :snapshot-id snapshot-id))
        {::stored-revn (:revn file)
         ::audit/replace-props
         {:id          (:id file)
          :name        (:name file)
          :features    (:features file)
          :project-id  (:project-id file)
          :team-id     (:team-id file)
          ;; NOTE: `file` carries the post-update revn here (`revn`
          ;; above is the pre-update one kept for the response), and
          ;; `modified-at` mirrors `persist-file!`: same `::timestamp`
          ;; fallback, so both agree to the millisecond when the
          ;; request timestamp exists.
          :revn        (:revn file)
          :modified-at (or timestamp (ct/now))}}))))

(defn get-file
  "Get not-decoded file, only decodes the features set."
  [cfg id]
  (bfc/get-file cfg id :decode? false :lock-for-share? true))

(defn persist-file!
  "Function responsible of persisting already encoded file. Should be
  used together with `get-file` and `update-file-data!`.

  It also updates the project modified-at attr."
  [{:keys [::db/conn ::timestamp] :as cfg} file]
  (let [;; The timestamp can be nil because this function is also
        ;; intended to be used outside of this module
        modified-at
        (or timestamp (ct/now))

        file
        (-> file
            (dissoc ::snapshot)
            (assoc :modified-at modified-at)
            (assoc :has-media-trimmed false))]

    (db/update! conn :project
                {:modified-at modified-at}
                {:id (:project-id file)}
                {::db/return-keys false})

    (bfc/update-file! cfg file)))

(defn- invalidate-caches!
  [cfg {:keys [id] :as file}]
  (rds/run! cfg (fn [{:keys [::rds/conn]}]
                  (let [key (files/file-summary-cache-key id)]
                    (rds/del conn key)))))

(defn- attach-snapshot
  "Attach snapshot data to the file. This should be called before the
  upcoming file operations are applied to the file.

  With `pointers-only?` only the pointer maps are loaded and the objects
  maps stay as they are: the snapshot holds the same data, but it is
  much cheaper to build and to encode on a large file. This path loads
  the pointer maps of a migrated file too, since `file_gc` drops the
  fragments the file no longer uses."
  [cfg migrated? pointers-only? file]
  (let [snapshot (cond
                   pointers-only? (fdata/realize-pointers cfg file)
                   migrated?      file
                   :else          (fdata/realize cfg file))]
    (assoc file ::snapshot snapshot)))

(def ^:private sql:mcp-snapshots
  "select c.id
     from file_change as c
    where c.file_id = ?
      and c.created_by = 'system'
      and c.label like 'mcp/%'
      and (c.deleted_at is null or c.deleted_at >= ?::timestamptz)
    order by c.created_at asc, c.id asc")

(defn- create-mcp-snapshot!
  "Snapshot the pre-change `file` (with `::snapshot` attached) for an
  MCP write. First marks the oldest `mcp/` snapshots of the file as
  deleted, so that `keep` snapshots remain counting the new one. Raises
  `:snapshot-failed`, an internal error, when the snapshot cannot be
  created, which aborts the transaction. Returns the new snapshot."
  [cfg file {:keys [label keep profile-id session-id deleted-at]}]
  (let [file-id  (:id file)
        now      (ct/now)
        existing (db/exec! cfg [sql:mcp-snapshots file-id now])
        excess   (- (count existing) (dec keep))]

    (doseq [{:keys [id]} (take (max 0 excess) existing)]
      (fsnap/delete! cfg :id id :file-id file-id :deleted-at now))

    (try
      (fsnap/create! cfg (::snapshot file)
                     {:label label
                      :created-by "system"
                      :deleted-at deleted-at
                      :profile-id profile-id
                      :session-id session-id})
      (catch Exception cause
        (ex/raise :type :internal
                  :code :snapshot-failed
                  :hint "unable to snapshot the file before the write; the write was aborted"
                  :file-id file-id
                  :cause cause)))))

(defn- update-decoded-file!
  "Runs the update of a decoded file: the snapshots the options ask for,
  the migration when the file needs one, then `update-fn` on the file.
  Returns a vector with the file and the id of the MCP snapshot taken
  before `update-fn` ran (nil when none was taken).

  `opts` are `:mcp-snapshot` (the MCP snapshot spec, or nil),
  `:mcp-write?` (true when an MCP call makes the write) and
  `:skip-auto-snapshot` (true to keep the automatic snapshot out of this
  update). An MCP snapshot replaces the automatic one. The snapshots of
  an MCP write load only the pointer maps (see `attach-snapshot`).

  This function does not save the file. The caller saves it, with the
  pointer maps the update changed."
  [cfg file {:keys [mcp-snapshot mcp-write? skip-auto-snapshot]} update-fn & args]
  (let [libs (delay (bfc/get-resolved-file-libraries cfg file))

        need-migration?
        (fmg/need-migration? file)

        take-snapshot?
        (and (nil? mcp-snapshot)
             (not skip-auto-snapshot)
             (take-snapshot? file))

        ;; For avoid unnecesary overhead of creating multiple
        ;; pointers and handly internally with objects map in their
        ;; worst case (when probably all shapes and all pointers
        ;; will be readed in any case), we just realize/resolve them
        ;; before applying the migration to the file
        file
        (cond-> file
          need-migration?
          (fmg/migrate-file libs)

          (or take-snapshot? (some? mcp-snapshot))
          (->> (attach-snapshot cfg need-migration?
                                (or (boolean mcp-write?) (some? mcp-snapshot)))))

        snapshot-id
        (when (some? mcp-snapshot)
          (:id (create-mcp-snapshot! cfg file mcp-snapshot)))

        file
        (cond-> file
          (some? mcp-snapshot)
          (dissoc ::snapshot))]

    [(apply update-fn cfg file args) snapshot-id]))

(defn- soft-validate-file-schema!
  [file]
  (try
    (val/validate-file-schema! file)
    (catch Throwable cause
      (l/error :hint "file schema validation error" :cause cause))))

(defn- record-validation-timing
  [cfg step-key step-label elapsed-ms]
  (when-let [metrics (::mtx/metrics cfg)]
    (when (mtx/metrics? metrics)
      (mtx/run! metrics {:id :update-file-validation-timing
                         :labels [step-label]
                         :val (double elapsed-ms)})))
  (when-let [timings (::validation-timings cfg)]
    (swap! timings assoc step-key elapsed-ms)))

(defn- soft-validate-file!
  [file libs changes]
  (try
    (val/validate-file-affected! file libs changes)
    (catch Throwable cause
      (l/error :hint "file validation error"
               :cause cause))))

(defn- apply-changes
  [cfg file changes]
  (let [state (atom {})
        file  (binding [cpc/*state* state]
                (-> file
                    (update :data cpc/process-changes changes)
                    (update :data d/without-nils)))]
    (if-let [media-refs (-> @state :media-refs not-empty)]
      (bfc/update-media-references! cfg file media-refs)
      file)))

(defn- fail-repair
  [cfg file errors cause]
  (l/wrn :hint "file auto-repair did not recover the file"
         :file-id (str (:id file))
         :error-codes (error-codes errors)
         :error-count (count errors))
  (record-repair-outcome cfg :unrepaired)
  (throw cause))

(defn- repair-preexisting-damage
  "Repair damage that was already in `original` on the pages/components
  the client's `changes` touch, then re-apply those changes. Throws
  `cause` when the client's changes are at fault or the repair cannot
  fix the file."
  [cfg mode original libs changes tracked tracked-0 cause]
  (let [libs (or libs {})]
    (try
      (let [pre-errors
            (binding [pmap/*tracked* nil]
              (val/validate-file-affected original libs changes))]

        (when (empty? pre-errors)
          (throw cause))

        (when tracked
          (reset! tracked tracked-0))

        (let [trepair (ct/tpoint)

              result
              (try
                (binding [pmap/*tracked* tracked]
                  (cfr/repair-file-until-valid
                   original libs
                   (fn [file applied]
                     (binding [pmap/*tracked* nil]
                       (val/validate-file-affected file libs (into applied changes))))
                   :initial-errors pre-errors))
                (finally
                  (record-validation-timing cfg :repair-ms "repair" (inst-ms (trepair)))))

              repair-changes (:changes result)]

          (when (seq (:errors result))
            (fail-repair cfg original (:errors result) cause))

          (let [treprocess (ct/tpoint)
                repaired   (try
                             (binding [pmap/*tracked* tracked]
                               (apply-changes cfg (:file result) changes))
                             (finally
                               (record-validation-timing cfg :reprocess-changes-ms "reprocess-changes"
                                                         (inst-ms (treprocess)))))
                scope      (into repair-changes changes)]

            (binding [pmap/*tracked* nil]
              (val/validate-file-affected! repaired libs scope)

              (when (:schema mode)
                (let [t (ct/tpoint)]
                  (try
                    (val/validate-file-schema! repaired)
                    (finally
                      (record-validation-timing cfg :validate-schema-ms "validate-schema" (inst-ms (t))))))))

            (-> repaired
                (assoc :revn (+ (:revn original) 2))
                (assoc ::repair {:changes repair-changes
                                 :errors  pre-errors
                                 :revn    (inc (:revn original))
                                 :original (dissoc original ::snapshot)})))))
      (catch Throwable inner
        (if (identical? inner cause)
          (throw cause)
          (do
            (l/wrn :hint "file auto-repair failed"
                   :file-id (str (:id original))
                   :cause inner)
            (record-repair-outcome cfg :unrepaired)
            (throw cause)))))))

(defn- view-of-page
  "The objects of a page that a check of the shapes `seeds` reads: each
  seed, its ancestors up to the root, and its subtree. The objects are not
  copied: the view holds the stored objects of those ids only, so the
  work of a check follows the touched shapes, not the page."
  [objects seeds]
  (letfn [;; Adds `id` and its ancestors. Stops at a shape already in the view.
          (climb [acc id]
            (loop [acc acc
                   id  id]
              (let [shape (get objects id)]
                (if (or (nil? shape) (contains? acc id))
                  acc
                  (recur (assoc acc id shape) (:parent-id shape))))))
          ;; Adds `id` and its subtree. `seen` holds the shapes already
          ;; expanded, so a seed that was added as an ancestor still has
          ;; its children added.
          (descend [[acc seen] id]
            (let [shape (get objects id)]
              (if (or (nil? shape) (contains? seen id))
                [acc seen]
                (reduce descend
                        [(assoc acc id shape) (conj seen id)]
                        (:shapes shape)))))]
    (first
     (reduce (fn [[acc seen] id]
               (descend [(climb acc id) seen] id))
             [{} #{}]
             seeds))))

(defn- check-changed-shapes!
  "The affected-shapes check of an MCP commit. It checks the shapes the
  changes touch, one check per touched shape, each over a view of its
  page (see `view-of-page`). The page-wide validation in `validate-file-affected!`
  walks every object of each touched page; this one does not. A change of
  a component, which the check does not cover, makes the caller run the
  page-wide check instead."
  [file libraries changes]
  (let [errors (volatile! [])]
    (doseq [[page-id page-changes] (group-by :page-id changes)
            :when (some? page-id)]
      (let [page (let [page (get-in file [:data :pages-index page-id])]
                   (if (pmap/pointer-map? page) (deref page) page))]
        (when (some? page)
          (let [seeds (into [] (comp (mapcat change-shape-ids)
                                     (filter some?)
                                     (distinct))
                            page-changes)
                view  (view-of-page (:objects page) seeds)
                page' (assoc page :objects view)]
            (push-thread-bindings
             {#'val/*errors*           errors
              #'val/*ref-shape-cache*  (volatile! {})
              #'val/*children-sets*    (#'val/build-children-sets view)})
            (try
              (doseq [id seeds :when (contains? view id)]
                (#'val/check-shape id file page' libraries))
              (finally
                (pop-thread-bindings)))))))
    (when-let [found (not-empty @errors)]
      (ex/raise :type :validation
                :code :referential-integrity
                :hint "error on validating file referential integrity"
                :file-id (:id file)
                :details found))))

(defn- component-part?
  "True for a shape the validator checks in a component context: a
  component root, a copy, a variant, or a shape inside a copy."
  [shape]
  (or (ctk/instance-head? shape)
      (ctk/instance-root? shape)
      (ctk/main-instance? shape)
      (ctk/in-component-copy? shape)
      (ctk/is-variant? shape)
      (ctk/is-variant-container? shape)))

(defn- inside-component?
  "True when `id` or one of its ancestors is a component part. The
  validator's context for such a shape depends on its ancestors, which
  the changed-shape check does not walk."
  [objects id]
  (loop [id id]
    (let [shape  (get objects id)
          parent (:parent-id shape)]
      (cond
        (nil? shape) false
        (component-part? shape) true
        (or (nil? parent) (= parent id)) false
        :else (recur parent)))))

(defn- page-of
  "The page `page-id` of `file`, derefed when it is a pointer map."
  [file page-id]
  (let [page (get-in file [:data :pages-index page-id])]
    (if (pmap/pointer-map? page) (deref page) page)))

(defn- scoped-to-components?
  "True when a changed shape is a component part or sits inside one."
  [file changes]
  (boolean
   (some (fn [[page-id page-changes]]
           (when-some [page (and (some? page-id) (page-of file page-id))]
             (let [objects (:objects page)]
               (some #(inside-component? objects %)
                     (into [] (comp (mapcat change-shape-ids) (filter some?))
                           page-changes)))))
         (group-by :page-id changes))))

(defn- affected-check!
  "Runs the affected-shapes check. An MCP commit (the `::force-validate`
  option is set) checks the touched shapes only. A change of a component,
  a shape inside one, or a file without the component feature takes the
  page-wide check the editor uses, which also carries the component
  context. The editor path is unchanged."
  [cfg file libraries changes]
  (cond
    (not (::force-validate cfg))
    (val/validate-file-affected! file libraries changes)

    (not (contains? (:features file) "components/v2"))
    nil

    (seq (:component-ids (#'val/extract-affected-ids changes)))
    (val/validate-file-affected! file libraries changes)

    (scoped-to-components? file changes)
    (val/validate-file-affected! file libraries changes)

    :else
    (check-changed-shapes! file libraries changes)))

(defn validation-mode
  "What the commit path validates. `:affected` runs the affected-shapes
  validation, `:schema` the schema validation. A true value in `force`
  (a map with the same two keys) turns that check on whatever the flags
  say. The MCP write path forces the affected-shapes check on every call,
  and the schema check on raw changes, since an agent builds those.
  Soft validation only logs, so it is not part of this. The MCP dry run
  calls this too, so a dry run decides as a commit does."
  ([]
   (validation-mode nil))
  ([force]
   {:affected (or (boolean (:affected force))
                  (contains? cf/flags :file-validation))
    :schema   (or (boolean (:schema force))
                  (contains? cf/flags :file-schema-validation))}))

(defn- process-changes-and-validate
  [cfg file changes skip-validate]
  (let [mode      (validation-mode (::force-validate cfg))
        original  file
        tracked   pmap/*tracked*
        tracked-0 (some-> tracked deref)

        should-resolve-libs?
        (and (or (:affected mode)
                 (contains? cf/flags :soft-file-validation))
             (not skip-validate))

        tlibs
        (ct/tpoint)

        libs
        (try
          (when should-resolve-libs?
            (if-let [libraries (::libraries cfg)] (assoc libraries (:id file) file) (bfc/get-resolved-file-libraries cfg file)))
          (finally
            (when should-resolve-libs?
              (record-validation-timing cfg :resolve-libs-ms "resolve-libs" (inst-ms (tlibs))))))

        tproc
        (ct/tpoint)

        file
        (try
          (apply-changes cfg
                         (-> (files/check-version! file)
                             (update :revn inc))
                         changes)
          (finally
            (record-validation-timing cfg :process-changes-ms "process-changes" (inst-ms (tproc)))))

        pending-repair
        (atom nil)]

    (binding [pmap/*tracked* nil]
      (when (contains? cf/flags :soft-file-validation)
        (let [t (ct/tpoint)]
          (try
            (soft-validate-file! file libs changes)
            (finally
              (record-validation-timing cfg :soft-validate-affected-ms "soft-validate-affected" (inst-ms (t)))))))

      (when (contains? cf/flags :soft-file-schema-validation)
        (let [t (ct/tpoint)]
          (try
            (soft-validate-file-schema! file)
            (finally
              (record-validation-timing cfg :soft-validate-schema-ms "soft-validate-schema" (inst-ms (t)))))))

      (when (and (:affected mode)
                 (not skip-validate))
        (let [t (ct/tpoint)]
          (try
            (affected-check! cfg file libs changes)
            (catch Throwable cause
              (reset! pending-repair cause)
              (when-not (referential-integrity-error? cause)
                (throw cause)))
            (finally
              (record-validation-timing cfg :validate-affected-ms "validate-affected" (inst-ms (t)))))))

      (when (and (:schema mode)
                 (not skip-validate)
                 (nil? @pending-repair))
        (let [t (ct/tpoint)]
          (try
            (val/validate-file-schema! file)
            (finally
              (record-validation-timing cfg :validate-schema-ms "validate-schema" (inst-ms (t))))))))

    (if-let [cause @pending-repair]
      (repair-preexisting-damage cfg mode original libs changes tracked tracked-0 cause)
      file)))

(defn- take-snapshot?
  "Defines the rule when file `data` snapshot should be saved."
  [{:keys [revn modified-at] :as file}]
  (when (contains? cf/flags :auto-file-snapshot)
    (let [freq    (or (cf/get :auto-file-snapshot-every) 20)
          timeout (or (cf/get :auto-file-snapshot-timeout)
                      (ct/duration {:hours 1}))]

      (or (= 1 freq)
          (zero? (mod revn freq))
          (> (inst-ms (ct/diff modified-at (ct/now)))
             (inst-ms timeout))))))

(def ^:private sql:lagged-changes
  "select s.id, s.revn, s.file_id,
          s.session_id, s.changes
     from file_change as s
    where s.file_id = ?
      and s.revn > ?
    order by s.revn asc, s.created_at asc")

(defn- get-lagged-changes
  [conn {:keys [id revn] :as params}]
  (->> (db/exec! conn [sql:lagged-changes id revn])
       (filter :changes)
       (mapv (fn [row]
               (update row :changes blob/decode)))))

;; --- BATCHED COMMITS

(defn library-files
  "The libraries of `file-id`, keyed by id. Each has its main blob decoded
  and its pointers unloaded: they load when read, through
  `fdata/load-pointer-of-files`."
  [cfg file-id]
  (into {}
        (map (fn [{lib-id :id}]
               [lib-id (bfc/get-file cfg lib-id :migrate? false)]))
        (bfc/get-file-libraries (::db/conn cfg) file-id)))

(defn begin-batches!
  "Starts a commit of several batches on `file`, the file loaded with its
  data and locked for share. The caller holds the file lock and the
  transaction. It then calls `apply-batch!` for each batch in order, and
  `finish-batches!` once at the end.

  The checks are the ones `update-file!` makes, minus those that cannot
  fail here: the revn was read under the lock, so only the vern can have
  moved. `params` holds `:profile-id`, `:session-id`, `:vern` (read under
  the lock), `:features` and `:force-validate` (see `validation-mode`).

  The caller passes the libraries of the file, resolved once for the call;
  they are used by the affected check, and their ids name the files the
  pointer loader may read. A forced
  schema check runs once, in `finish-batches!`, on the final file. The
  file is decoded once, by the caller's load, and then carried from batch
  to batch in memory. Returns the context of the commit."
  [cfg file {:keys [profile-id session-id vern features force-validate libraries]}]
  (let [conn (::db/conn cfg)
        team (teams/get-team conn
                             :profile-id profile-id
                             :team-id (:team-id file))

        features (commit-features team file features)]

    (check-vern! file vern (:revn file))
    (store-team-features! conn team features)

    {:cfg (assoc cfg
                 ::timestamp (ct/now)
                 ::validation-timings (atom {})
                 ;; The schema check moves to `finish-batches!`.
                 ::force-validate (dissoc force-validate :schema)
                 ::libraries libraries)
     :file (update file :data assoc :id (:id file))
     :file-ids (into [(:id file)] (keys libraries))
     :final-schema? (boolean (:schema force-validate))
     :profile-id profile-id
     :session-id session-id
     :team team
     :features (set/difference features cfeat/frontend-only-features)
     :tracked (pmap/create-tracked)
     :tpoint (ct/tpoint)
     :batches 0
     :snapshot-id nil}))

(defn apply-batch!
  "Applies one batch of `changes` to the context of `begin-batches!`, as
  `update-file!` applies a commit. The batch gets its own change row with
  its own revn, and its notifications are queued for the commit. The
  file is not written here: `finish-batches!` writes it once.

  `opts` holds `::mcp-snapshot`, the snapshot spec of a call that takes
  one (give it on the first batch only), and `::skip-auto-snapshot`.
  Give `::skip-auto-snapshot` true on every batch after the first, and
  on every batch of a call that takes its own snapshot. So the automatic
  snapshot is taken at most once per call, before the first batch, and
  never on a half-applied state. Returns the next context."
  [{:keys [cfg file profile-id session-id team features tracked] :as ctx}
   changes
   {::keys [mcp-snapshot skip-auto-snapshot]}]
  (let [revn         (:revn file)
        mcp-snapshot (when-let [{:keys [label keep]} mcp-snapshot]
                       {:label label
                        :keep (max 1 (or keep 20))
                        :profile-id profile-id
                        :session-id session-id
                        :deleted-at (ct/plus (::timestamp cfg)
                                             (ldel/get-deletion-delay team))})]

    (mtx/run! (::mtx/metrics cfg) {:id :update-file-changes :inc (count changes)})

    (binding [pmap/*tracked* tracked
              pmap/*load-fn* (partial fdata/load-pointer-of-files cfg (:file-ids ctx))]
      (let [[file' snapshot-id]
            (run-batch! cfg file features
                        {:changes changes
                         :mcp-snapshot mcp-snapshot
                         :mcp-write? true
                         :skip-auto-snapshot skip-auto-snapshot})]

        (commit-batch! cfg
                       {:profile-id profile-id :session-id session-id :team team}
                       file' changes revn)

        (-> ctx
            (assoc :file (dissoc file' ::snapshot ::repair))
            (update :batches inc)
            (update :snapshot-id #(or % snapshot-id)))))))

;; GREATEST keeps the stored stamp when a newer write touched the project
;; during this call: the request timestamp is taken at the call start, so a
;; long call must not move the stamp backwards.
(def ^:private sql:touch-project
  "UPDATE project SET modified_at = GREATEST(modified_at, ?)
    WHERE id = ? AND modified_at < now() - interval '5 seconds'")

(defn finish-batches!
  "Writes the file once, after the last batch: its data and the pointer
  maps the call changed, each once. Queues the project touch and the cache
  invalidation for the commit, so the project row is not locked by this
  transaction. Returns `{:revn <the stored revn> :snapshot-id <id or nil>}`."
  [{:keys [cfg file file-ids final-schema? tracked snapshot-id tpoint batches]}]
  (let [file-id     (:id file)
        modified-at (or (::timestamp cfg) (ct/now))
        file        (-> file
                        (dissoc ::snapshot ::repair)
                        (assoc :modified-at modified-at
                               :has-media-trimmed false))]

    (binding [pmap/*tracked* tracked
              pmap/*load-fn* (partial fdata/load-pointer-of-files cfg file-ids)]
      ;; The forced schema check runs once, on the final file, so a
      ;; raw call does not read every page on every batch.
      (when final-schema?
        (val/validate-file-schema! file))
      (bfc/update-file! cfg file ::bfc/skip-stored-migrations? true))

    ;; Runs after the commit, on its own pool connection, as one short
    ;; statement. It writes only when the stored project row is at least
    ;; 5 seconds old.
    (db/after-commit
     (fn []
       (db/exec-one! (::db/pool cfg)
                     [sql:touch-project modified-at (:project-id file)])))

    (when (contains? cf/flags :redis-cache)
      (db/after-commit
       (fn []
         (invalidate-caches! cfg {:id file-id}))))

    (let [elapsed (tpoint)
          file-id (str file-id)]
      (db/after-commit
       (fn []
         (l/dbg :hint "update-file"
                :file-id file-id
                :status "success"
                :batches batches
                :time (ct/format-duration elapsed)))))

    {:revn (:revn file)
     :snapshot-id snapshot-id}))

;; --- NOTIFICATIONS

(defn change-shape-ids
  "Ids of the shapes a change touches, for the changes that name them.
  A move or reorder touches its shapes and its parent. `:reg-objects`
  names no shape to conflict on, so it returns nil."
  [{:keys [type] :as change}]
  (case type
    (:add-obj :mod-obj :del-obj) [(:id change)]
    (:mov-objects :reorder-children)
    (into [] (remove nil?) (concat (:shapes change) (:ids change) [(:parent-id change)]))
    nil))

(def changed-rows-limit
  "The most `file_change` rows `read-changed-shapes` reads in one call."
  500)

(def changed-bytes-limit
  "The most bytes of change data `read-changed-shapes` reads in one call."
  (* 16 1024 1024))

(def ^:private sql:changed-shape-rows
  "select r.revn, r.changes
     from (select c.revn, c.changes,
                  sum(octet_length(c.changes)) over (order by c.revn asc) as running
             from file_change as c
            where c.file_id = ?
              and c.revn > ?
              and c.revn <= ?
              and c.changes is not null
              and c.session_id is distinct from ?) as r
    where r.running <= ?
    order by r.revn asc
    limit ?")

(defn read-changed-shapes
  "Ids of the shapes touched by the commits with a revn in (`since`,
  `stored-revn`], leaving out the rows of `session-id` (nil leaves out
  none). Reads at most `changed-rows-limit` rows and at most about
  `changed-bytes-limit` bytes of change data. Returns
  `{:shape-ids #{...} :truncated? bool}`.

  `:truncated?` is true when the read leaves some commits out: the row
  limit or the byte budget cut it short, a revn in the range has no row
  (the change row expired, for one), or a row does not decode. A row that
  does not decode is logged and skipped; this never raises for a bad row."
  [conn file-id since stored-revn session-id]
  (let [rows      (db/exec! conn [sql:changed-shape-rows
                                  file-id since stored-revn session-id
                                  changed-bytes-limit
                                  (inc changed-rows-limit)])
        overflow? (> (count rows) changed-rows-limit)
        rows      (take changed-rows-limit rows)
        lowest    (:revn (first rows))
        ;; Every revn of the range has a row, except when a row expired
        ;; or the budget cut the read. Rows left out by a session are
        ;; not missing, so the count check runs only without a session.
        gap?      (or (and (some? lowest) (> lowest (inc since)))
                      (and (nil? session-id)
                           (< (count rows) (- stored-revn since))))]
    (reduce (fn [acc {:keys [changes]}]
              (try
                (update acc :shape-ids into (mapcat change-shape-ids) (blob/decode changes))
                (catch Throwable cause
                  (l/wrn :hint "revn-lag: a file change does not decode; skipped"
                         :file-id (str file-id)
                         :cause cause)
                  (assoc acc :truncated? true))))
            {:shape-ids #{} :truncated? (or overflow? gap?)}
            rows)))

(defn- send-repair-notifications
  [cfg {:keys [profile-id session-id team]} file repair]
  (let [changes     (:changes repair)
        lchanges    (filterv library-change? changes)
        msgbus      (::mbus/msgbus cfg)
        file-id     (:id file)
        vern        (:vern file)
        is-shared   (:is-shared file)
        team-id     (:id team)
        repair-revn (:revn repair)]

    ;; Published when the transaction commits, never before, so a rolled back call reaches no open tab.
    (db/after-commit
     (fn []
       (mbus/pub! msgbus
                  :topic file-id
                  :message {:type :file-change
                            :profile-id profile-id
                            :file-id file-id
                            :session-id repair-session-id
                            :revn repair-revn
                            :vern vern
                            :changes changes
                            :repaired true})

       (when (and is-shared (seq lchanges))
         (mbus/pub! msgbus
                    :topic team-id
                    :message {:type :library-change
                              :profile-id profile-id
                              :file-id file-id
                              :session-id session-id
                              :revn repair-revn
                              :modified-at (ct/now)
                              :changes lchanges}))))))

(defn- send-notifications!
  "Queues the notifications of one commit. The callback closes over the
  values it needs, not over the decoded file or the params, so the file
  of a batch can be freed before the commit."
  [cfg {:keys [profile-id session-id team]} file changes]
  (let [lchanges  (filterv library-change? changes)
        msgbus    (::mbus/msgbus cfg)
        file-id   (:id file)
        revn      (:revn file)
        vern      (:vern file)
        is-shared (:is-shared file)
        team-id   (:id team)]

    ;; Published when the transaction commits, never before, so a rolled back call reaches no open tab.
    (db/after-commit
     (fn []
       (mbus/pub! msgbus
                  :topic file-id
                  :message {:type :file-change
                            :profile-id profile-id
                            :file-id file-id
                            :session-id session-id
                            :revn revn
                            :vern vern
                            :changes changes})

       (when (and is-shared (seq lchanges))
         (mbus/pub! msgbus
                    :topic team-id
                    :message {:type :library-change
                              :profile-id profile-id
                              :file-id file-id
                              :session-id session-id
                              :revn revn
                              :modified-at (ct/now)
                              :changes lchanges}))))))

