;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.rpc.commands.mcp-write
  "Write commands of the backend-native MCP: raw change batches, typed
  operation batches and SVG import, committed through the same path as
  `update-file`. See `mcp/docs/backend-mode-contract.md`."
  (:require
   [app.binfile.common :as bfc]
   [app.common.data :as d]
   [app.common.exceptions :as ex]
   [app.common.features :as cfeat]
   [app.common.files.changes :as cpc]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.shapes-builder :as sb]
   [app.common.files.validate :as val]
   [app.common.mcp.operations :as operations]
   [app.common.schema :as sm]
   [app.common.time :as ct]
   [app.common.transit :as t]
   [app.common.types.fills :as types.fills]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.features.fdata :as feat.fdata]
   [app.loggers.audit :as-alias audit]
   [app.loggers.webhooks :as webhooks]
   [app.media.svg :as svg]
   [app.rpc :as-alias rpc]
   [app.rpc.climit :as-alias climit]
   [app.rpc.commands.files :as files]
   [app.rpc.commands.files-update :as files-update]
   [app.rpc.commands.mcp :as mcp]
   [app.rpc.doc :as-alias doc]
   [app.util.pointer-map :as pmap]
   [app.util.services :as sv]
   [clojure.set :as set]
   [clojure.string :as str])
  (:import
   java.util.UUID))

;; --- LIMITS AND RULES

(def ^:private max-changes 2000)
(def ^:private max-operations 2000)
(def ^:private max-payload-bytes (* 8 1024 1024))
(def ^:private split-size 300)
(def ^:private snapshot-threshold 100)
(def ^:private snapshot-keep 20)

(def ^:private refused-types
  "Change types no MCP call may apply."
  #{:set-tokens-lib :purge-component :purge-typography :purge-color})

(def ^:private delete-types
  "Change types that always take a snapshot before they are applied."
  #{:del-obj :del-page :del-component :del-color :del-typography :del-media})

(def ^:private commit-features
  (set/difference cfeat/supported-features cfeat/frontend-only-features))

(defn- write-scope
  "The MCP scope a write needs. A dry run only reads the file."
  [params]
  (if (:dry-run params) "mcp:read" "mcp:write"))

;; --- SCHEMAS

(def ^:private schema:mcp-apply-changes
  [:map {:title "mcp-apply-changes"}
   [:file-id ::sm/uuid]
   [:base-revn {:optional true} [:maybe ::sm/int]]
   [:changes [:vector cpc/schema:change]]
   [:dry-run {:optional true} ::sm/boolean]
   [:snapshot {:optional true} [:maybe ::sm/boolean]]
   [:fail-on-conflict {:optional true} ::sm/boolean]
   [:request-id {:optional true} ::sm/uuid]])

(def ^:private schema:mcp-apply-operations
  [:map {:title "mcp-apply-operations"}
   [:file-id ::sm/uuid]
   [:base-revn {:optional true} [:maybe ::sm/int]]
   [:operations [:vector :map]]
   [:dry-run {:optional true} ::sm/boolean]
   [:snapshot {:optional true} [:maybe ::sm/boolean]]
   [:allow-split {:optional true} ::sm/boolean]
   [:fail-on-conflict {:optional true} ::sm/boolean]
   [:request-id {:optional true} ::sm/uuid]])

(def ^:private schema:mcp-import-svg
  [:map {:title "mcp-import-svg"}
   [:file-id ::sm/uuid]
   [:page-id ::sm/uuid]
   [:parent-id {:optional true} [:maybe ::sm/uuid]]
   [:svg :string]
   [:x {:optional true} ::sm/number]
   [:y {:optional true} ::sm/number]
   [:name {:optional true} :string]
   [:dry-run {:optional true} ::sm/boolean]
   [:request-id {:optional true} ::sm/uuid]])

;; --- HELPERS

(defn- payload-bytes
  "The size in bytes of the transit encoding of `value`."
  [value]
  (let [^String text (t/encode-str value)]
    (alength (.getBytes text "UTF-8"))))

(defn- check-size!
  "Raises `:mcp-batch-too-large` when `items` has more than `max-count`
  entries or `payload` encodes to more than 8 MB."
  [items max-count payload]
  (when (> (count items) max-count)
    (ex/raise :type :validation
              :code :mcp-batch-too-large
              :hint (str "a call takes at most " max-count " items")
              :max-count max-count))
  (when (> (payload-bytes payload) max-payload-bytes)
    (ex/raise :type :validation
              :code :mcp-batch-too-large
              :hint "the payload is larger than 8 MB"
              :max-bytes max-payload-bytes)))

(defn- check-change-types!
  "Raises `:mcp-change-type-refused` when a change is of a refused type."
  [changes]
  (let [refused (into (sorted-set)
                      (comp (map :type)
                            (filter refused-types)
                            (map name))
                      changes)]
    (when (seq refused)
      (ex/raise :type :validation
                :code :mcp-change-type-refused
                :hint (str "change types refused over MCP: " (str/join ", " refused))
                :change-types (vec refused)))))

(defn- max-compiled-changes
  "The most changes one call may compile to. Read from the config key
  `:mcp-max-compiled-changes`; 100000 when the key is not set."
  []
  (cf/get :mcp-max-compiled-changes 100000))

(defn- check-compiled-count!
  "Raises `:mcp-batch-too-large` when `changes` has more entries than the cap. Runs before any write, dry runs included."
  [changes]
  (let [limit (max-compiled-changes)]
    (when (> (count changes) limit)
      (ex/raise :type :validation
                :code :mcp-batch-too-large
                :hint (str "the call compiles to more than " limit " changes")
                :max-count limit))))

(defn- change-types
  "The histogram of the change types of `changes`, keyed by name."
  [changes]
  (into {}
        (map (fn [[type n]] [(name type) n]))
        (frequencies (map :type changes))))

(defn- touched-ids
  [changes]
  (into #{} (mapcat files-update/change-shape-ids) changes))

(defn- media-id
  "The media id a node of a change refers to, if the node refers to one:
  fill and stroke images, image shape metadata, metadata set operations
  and media records."
  [node]
  (when (map? node)
    (or (-> node :fill-image :id)
        (-> node :stroke-image :id)
        (when (= :image (:type node))
          (-> node :metadata :id))
        (when (= :metadata (:attr node))
          (-> node :val :id))
        (when (contains? #{:add-media :mod-media} (:type node))
          (-> node :object :id)))))

(defn- media-ids
  "The media ids of every node of `changes`, at any depth. The walk
  visits map values and collection items; map keys never hold media."
  [changes]
  (let [ids  (volatile! (transient #{}))
        walk (fn walk [node]
               (cond
                 (map? node)
                 (let [id (media-id node)]
                   (when (uuid? id)
                     (vswap! ids conj! id))
                   (run! walk (vals node)))

                 (coll? node)
                 (run! walk node)))]
    (walk changes)
    (persistent! @ids)))

(def ^:private sql:media-owners
  "SELECT id, file_id
     FROM file_media_object
    WHERE id = ANY(?)")

(defn- check-media!
  "Raises `:mcp-foreign-media` unless every media the changes refer to
  belongs to this file or to a library of it that the profile can read."
  [cfg profile-id file-id changes]
  (let [ids (media-ids changes)]
    (when (seq ids)
      (let [conn     (::db/conn cfg)
            readable (into #{file-id}
                           (comp (map :id)
                                 (filter #(files/has-read-permissions? cfg profile-id %)))
                           (bfc/get-file-libraries conn file-id))
            owners   (into {}
                           (map (juxt :id :file-id))
                           (db/exec! conn [sql:media-owners (db/create-array conn "uuid" (vec ids))]))]
        (doseq [id ids]
          (when-not (contains? readable (get owners id))
            (ex/raise :type :validation
                      :code :mcp-foreign-media
                      :hint "the media is not in this file nor in a readable library of it"
                      :media-id id)))))))

(defn- revn-lag
  "When `base-revn` is older than the stored revn: the warning that names
  the shapes later commits touched, the overlap of those shapes with the
  shapes of `changes`, and whether the read was cut short. Nil otherwise.
  The read is capped and an undecodable row does not fail the write (see
  `files-update/read-changed-shapes`)."
  [cfg file-id base-revn stored-revn changes]
  (when (and (some? base-revn) (< base-revn stored-revn))
    (let [{:keys [shape-ids truncated?]}
          (files-update/read-changed-shapes (::db/conn cfg) file-id base-revn stored-revn nil)]
      {:warning    (cond-> {:kind "revn-lag"
                            :base-revn base-revn
                            :stored-revn stored-revn
                            :changed-shape-ids (vec shape-ids)}
                     truncated? (assoc :truncated true))
       :truncated? truncated?
       :overlap    (set/intersection (touched-ids changes) shape-ids)})))

(defn- session-id
  "The session id of the commits of one request. Open tabs apply the
  change live because the id is not theirs."
  [token-id request-id]
  (UUID/nameUUIDFromBytes
   (.getBytes ^String (str "penpot-mcp:" token-id ":" request-id) "UTF-8")))

(defn- snapshot-label
  [tool request-id]
  (str "mcp/" tool "/" (ct/format-inst (ct/now)) "/" request-id))

(defn- snapshot-wanted?
  "The snapshot rule: a delete always takes one, more than 100 operations
  or changes take one unless `snapshot` is false, and `snapshot` true
  forces one."
  [snapshot? changes size]
  (boolean
   (or (true? snapshot?)
       (some #(contains? delete-types (:type %)) changes)
       (and (not (false? snapshot?))
            (> size snapshot-threshold)))))

(defn- add-object?
  [change]
  (= :add-obj (:type change)))

(defn- split-batches
  "Cuts `changes` into batches of whole operations. `op-ranges` holds one
  `[start end]` pair per operation, the indexes in `changes` of the changes
  that operation emitted (see `compile-operations`). A batch takes the next
  operation unless that would push its object creations (`:add-obj`
  changes) past `split-size`. A batch that holds no operation yet always
  takes it, so an operation with more creations than `split-size` gets a
  batch of its own. The changes after the last range, the layout reflow,
  go into the last batch. Returns the batches as maps with `:changes`,
  `:first-op` and `:last-op`, the first and last operation index of the
  batch."
  [changes op-ranges]
  (let [empty-batch {:changes [] :adds 0 :first-op nil :last-op nil}
        [closed open]
        (reduce (fn [[closed batch] [index [start end]]]
                  (let [op-changes (subvec changes start end)
                        op-adds    (count (filter add-object? op-changes))
                        full?      (and (some? (:first-op batch))
                                        (> (+ (:adds batch) op-adds) split-size))
                        [closed batch] (if full?
                                         [(conj closed batch) empty-batch]
                                         [closed batch])]
                    [closed (-> batch
                                (update :changes into op-changes)
                                (update :adds + op-adds)
                                (update :first-op #(or % index))
                                (assoc :last-op index))]))
                [[] empty-batch]
                (map-indexed vector op-ranges))
        reflow     (subvec changes (if (seq op-ranges)
                                     (second (peek op-ranges))
                                     0))
        last-batch (update open :changes into reflow)]
    (mapv #(dissoc % :adds) (conj closed last-batch))))

(defn- batches-of
  "The batches `changes` commit in, as maps with `:changes` and the
  operation indexes they hold (`:first-op` and `:last-op`, nil when the
  batch holds no operation). With `split?` the batches cut at operation
  boundaries; without it the whole call is one batch."
  [changes op-ranges split?]
  (cond
    (empty? changes) []
    split?           (split-batches changes op-ranges)
    :else            [{:changes    changes
                       :first-op   (when (seq op-ranges) 0)
                       :last-op    (when (seq op-ranges) (dec (count op-ranges)))}]))

(defn- batch-failure
  "The error of a failed batch, with the context of the call. Returns `cause` unchanged when it is not a Penpot error. The operations of the batch come from the batch itself, so no database access is needed. `:failed-operation-index` and `:failed-operation-last-index` are left out when the batch holds no operation."
  [cause last-revn change-offset {:keys [first-op last-op]}]
  (if (ex/ex-info? cause)
    (ex-info (.getMessage ^Throwable cause)
             (cond-> (assoc (ex-data cause)
                            :last-committed-revn last-revn
                            :failed-change-index change-offset)
               (some? first-op) (assoc :failed-operation-index first-op
                                       :failed-operation-last-index last-op))
             cause)
    cause))

(defn- commit-batches!
  "Commits `batches` in order, one `update-file!` call each, in the
  transaction of the call. The snapshot is taken with the first batch
  only. The revn of the next batch is the one `update-file!` stored, so
  no read of the file is needed between batches. Returns the stored
  revn, the count of changes of other sessions
  that lagged behind the call (the largest count any batch saw) and the
  snapshot id."
  [cfg file batches {:keys [profile-id session-id snapshot? label]}]
  (let [file-id (:id file)]
    (loop [index        0
           revn         (:revn file)
           offset       0
           lagged-count 0
           snapshot-id  nil]
      (if (< index (count batches))
        (let [batch   (nth batches index)
              changes (:changes batch)
              params  (cond-> {::rpc/profile-id profile-id
                               ::files-update/mcp-write? true
                               :id file-id
                               :revn revn
                               :vern (:vern file)
                               :session-id session-id
                               :features commit-features
                               :changes changes}
                        (and snapshot? (zero? index))
                        (assoc ::files-update/mcp-snapshot {:label label
                                                            :keep snapshot-keep}))
              result  (try
                        (files-update/update-file! cfg params)
                        (catch Throwable cause
                          (throw (batch-failure cause (:revn file) offset batch))))]
          (recur (inc index)
                 (::files-update/stored-revn (meta result))
                 (+ offset (count changes))
                 (max lagged-count
                      (count (remove #(= session-id (:session-id %))
                                     (:lagged result))))
                 (or snapshot-id (:snapshot-id result))))
        {:revn revn
         :lagged-count lagged-count
         :snapshot-id snapshot-id
         :commits (count batches)}))))

(declare ^:private realize-pointers)

(defn- library-map
  "The linked libraries of the file, keyed by id. Their pointer maps are
  loaded here, because they belong to the library file."
  [cfg file-id]
  (into {}
        (map (fn [{lib-id :id}]
               (let [lib (bfc/get-file cfg lib-id :migrate? false)]
                 [lib-id (update lib :data #(realize-pointers cfg lib-id %))])))
        (bfc/get-file-libraries (::db/conn cfg) file-id)))

(defn- realize-pointers
  "The data of a file with its file-level pointer maps and page pointer
  maps derefed, loaded for the file `file-id`."
  [cfg file-id data]
  (binding [pmap/*load-fn* (partial feat.fdata/load-pointer cfg file-id)]
    (reduce-kv (fn [data k v]
                 (cond
                   (pmap/pointer-map? v)
                   (assoc data k (deref v))

                   (= k :pages-index)
                   (assoc data k (into {}
                                       (map (fn [[page-id page]]
                                              [page-id (if (pmap/pointer-map? page)
                                                         (deref page)
                                                         page)]))
                                       v))

                   :else
                   data))
               data
               data)))

(defn- schema-errors
  "The schema errors of `file`, as error summaries. Empty when the schema is valid."
  [file]
  (try
    (val/validate-file-schema! file)
    []
    (catch clojure.lang.ExceptionInfo cause
      [{:code (get (ex-data cause) :code :schema-failed)
        :hint (.getMessage cause)}])))

(defn- affected-errors
  "The errors of the affected-shape check, as the commit raises them: one
  `:referential-integrity` error per validator error. The validator's own
  code and hint are kept as `:detail-code` and `:detail-hint`."
  [file errors]
  (mapv (fn [e]
          (d/without-nils
           {:code :referential-integrity
            :hint "error on validating file referential integrity"
            :file-id (:id file)
            :page-id (:page-id e)
            :shape-id (:shape-id e)
            :detail-code (:code e)
            :detail-hint (:hint e)}))
        errors))

(defn- validation-of
  "The validation outcome of `changes` applied in memory to `file`. The checks are the ones the commit runs (`files-update/validation-mode`), and the errors carry the codes the commit would raise."
  [cfg file libs changes]
  (let [{:keys [affected schema]} (files-update/validation-mode)
        errors
        (binding [pmap/*load-fn* (partial feat.fdata/load-pointer cfg (:id file))]
          (try
            (let [file' (assoc file :data (cpc/process-changes (:data file) changes))]
              (cond-> []
                affected (into (affected-errors file (val/validate-file-affected file' libs changes)))
                schema   (into (schema-errors file'))))
            (catch clojure.lang.ExceptionInfo cause
              [{:code (get (ex-data cause) :code :processing-failed)
                :hint (.getMessage cause)}])))]
    (if (empty? errors)
      {:ok true}
      {:ok false :errors errors})))

(defn- load-write-file
  "Checks the caller against the file and loads it. A dry run needs read
  permission and takes no lock. A write needs edit permission and takes
  the file lock before it reads the revn, so the commit extends that revn."
  [cfg profile-id file-id dry-run? with-data?]
  (mcp/check-profile! cfg profile-id)
  (if dry-run?
    (files/check-read-permissions! cfg profile-id file-id)
    (do
      (files/check-edition-permissions! (::db/conn cfg) profile-id file-id)
      (db/xact-lock! (::db/conn cfg) file-id)))
  (if (or dry-run? with-data?)
    (update (bfc/get-file cfg file-id) :data assoc :id file-id)
    (bfc/get-file cfg file-id :load-data? false)))

(defn- compile-ops!
  "Compiles `operations` against the data of `file`, its libraries
  included."
  [cfg file operations]
  (binding [pmap/*load-fn* (partial feat.fdata/load-pointer cfg (:id file))]
    (operations/compile-operations (:data file)
                                   operations
                                   {:new-id-fn uuid/next
                                    :libraries (library-map cfg (:id file))})))

(defn- page-objects
  [cfg file-id data page-id]
  (let [page (get-in data [:pages-index page-id])]
    (when (nil? page)
      (ex/raise :type :not-found
                :code :page-not-found
                :hint "page not found"))
    (binding [pmap/*load-fn* (partial feat.fdata/load-pointer cfg file-id)]
      (:objects (if (pmap/pointer-map? page) (deref page) page)))))

(defn- parse-svg-data
  "The parsed SVG of `text`, sanitized first. Raises `:mcp-invalid-svg`
  when the text is not an SVG document."
  [text name]
  (let [parsed (try
                 (svg/parse-svg (svg/sanitize-svg text))
                 (catch Exception cause
                   (ex/raise :type :validation
                             :code :mcp-invalid-svg
                             :hint "the SVG text cannot be parsed"
                             :cause cause)))]
    (when-not (= :svg (:tag parsed))
      (ex/raise :type :validation
                :code :mcp-invalid-svg
                :hint "the root element is not an svg element"))
    (assoc parsed :name (or name "svg"))))

(defn- svg-import
  "The changes that place the SVG under a wrapper frame, as the frontend
  does: the frame holds the svg root and its children."
  [cfg file {:keys [page-id parent-id svg x y name]}]
  (let [svg-data  (parse-svg-data svg name)
        objects   (page-objects cfg (:id file) (:data file) page-id)
        parent-id (or parent-id uuid/zero)
        parent    (when-not (= parent-id uuid/zero)
                    (or (get objects parent-id)
                        (ex/raise :type :not-found
                                  :code :shape-not-found
                                  :hint "parent shape not found")))
        outer     (cond
                    (= parent-id uuid/zero) uuid/zero
                    (= :frame (:type parent)) parent-id
                    :else (:frame-id parent))
        pos       {:x (or x 0) :y (or y 0)}

        [root children]
        (sb/create-svg-shapes svg-data pos objects uuid/zero nil #{} false)

        root-id   (:id root)
        selrect   (:selrect root)

        frame     (cts/setup-shape
                   {:type :frame
                    :x (:x pos)
                    :y (:y pos)
                    :width (:width selrect)
                    :height (:height selrect)
                    :name (:name root)
                    :frame-id outer
                    :parent-id parent-id
                    :fills (types.fills/create)})

        frame-id  (:id frame)

        direct    (into [] (comp (filter #(= root-id (:parent-id %)))
                                 (map :id))
                        children)

        root      (assoc root
                         :frame-id frame-id
                         :parent-id frame-id
                         :shapes direct)

        children  (mapv #(assoc % :frame-id frame-id) children)
        shapes    (d/concat-vec [frame root] children)

        changes   (-> (pcb/empty-changes nil page-id)
                      (pcb/with-objects objects)
                      (pcb/add-objects shapes)
                      :redo-changes)]

    {:changes changes
     :extra {:root-id frame-id
             :shape-ids (mapv :id shapes)}}))

(defn- run-write
  "The write path the three commands share. `derive` takes the loaded
  file and returns a map with `:changes`, and optionally `:warnings`,
  `:op-count` (the operations or changes the call names, for the snapshot
  rule), `:op-ranges` (the change range of each operation, see
  `split-batches`), `:split?` and `:extra` (merged into the result).
  Returns the result and the audit props."
  [cfg tool {:keys [::rpc/profile-id file-id dry-run request-id
                    base-revn fail-on-conflict snapshot]
             :as params}
   {:keys [with-data? derive]}]
  (let [dry-run?   (boolean dry-run)
        request-id (or request-id (uuid/next))
        token-id   (mcp/get-token-id params)
        file       (load-write-file cfg profile-id file-id dry-run? with-data?)
        derived    (derive file)
        changes    (vec (:changes derived))
        _          (check-change-types! changes)
        _          (check-compiled-count! changes)
        _          (check-media! cfg profile-id file-id changes)
        lag        (revn-lag cfg file-id base-revn (:revn file) changes)
        _          (when (and fail-on-conflict (seq (:overlap lag)))
                     (ex/raise :type :conflict
                               :code :mcp-revn-conflict
                               :hint "commits made since the base revision touch the same shapes"
                               :changed-shape-ids (vec (:overlap lag))))

        warnings   (cond-> (vec (:warnings derived))
                     (some? (:warning lag)) (conj (:warning lag)))

        base       {:change-count (count changes)
                    :change-types (change-types changes)
                    :warnings warnings
                    :dry-run dry-run?}

        audit      {:tool tool
                    :file-id file-id
                    :id file-id
                    :name (:name file)
                    :features (:features file)
                    :project-id (:project-id file)
                    :team-id (:team-id file)
                    :page-ids (vec (into #{} (keep :page-id) changes))
                    :change-count (count changes)
                    :change-types (change-types changes)
                    :revn-before (:revn file)
                    :token-id token-id}]

    (if dry-run?
      (let [validation (validation-of cfg file (library-map cfg (:id file)) changes)]
        [(merge (:extra derived)
                base
                {:revn (:revn file)
                 :lagged-count 0
                 :validation validation})
         (assoc audit :revn-after (:revn file))])

      (let [label     (snapshot-label tool request-id)
            snapshot? (snapshot-wanted? snapshot
                                        changes
                                        (or (:op-count derived) (count changes)))
            batches   (batches-of changes (:op-ranges derived) (:split? derived))
            outcome   (commit-batches! cfg file batches
                                       {:profile-id profile-id
                                        :session-id (session-id token-id request-id)
                                        :snapshot? snapshot?
                                        :label label})]

        (doseq [[type-name n] (change-types changes)]
          (mcp/record-change cfg tool type-name n))

        [(cond-> (merge (:extra derived)
                        base
                        {:revn (:revn outcome)
                         :lagged-count (:lagged-count outcome)
                         :commits (:commits outcome)
                         :validation {:ok true}})
           (some? (:snapshot-id outcome))
           (assoc :snapshot-id (:snapshot-id outcome))

           (:truncated? lag)
           (assoc :lagged-truncated true))
         (cond-> (assoc audit
                        :revn-after (:revn outcome)
                        :revn (:revn outcome)
                        :modified-at (ct/now))
           (some? (:snapshot-id outcome))
           (assoc :snapshot-id (:snapshot-id outcome)))]))))

(defn- write-command
  "Runs a write command through `mcp/run-tool` and attaches the write audit props: the change count and the histogram of the call. A write (not a dry run) also names its event `update-file`, marks it as a webhook event and batches it per file, as the `update-file` RPC does, so MCP writes reach webhook consumers with the same event and payload shape."
  [cfg tool params opts]
  (let [started (System/nanoTime)
        audit   (volatile! nil)
        result  (mcp/run-tool cfg tool params
                              (fn []
                                (let [[result props] (run-write cfg tool params opts)]
                                  (vreset! audit props)
                                  [result props])))
        props   (assoc @audit
                       :duration-ms (/ (- (System/nanoTime) started) 1000000.0))]
    (cond-> (vary-meta result assoc ::audit/replace-props props)
      (not (:dry-run params))
      (vary-meta assoc
                 ::audit/name "update-file"
                 ::webhooks/event? true
                 ::webhooks/batch-key (webhooks/key-fn ::rpc/profile-id :file-id)
                 ::webhooks/batch-timeout (ct/duration "2m")))))

;; --- COMMAND: mcp-apply-changes

(sv/defmethod ::mcp-apply-changes
  "Applies raw change records to a file in one commit. With `dry-run`
  the changes are applied in memory and validated only."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope write-scope
   ::climit/id [[:mcp-apply/by-profile ::rpc/profile-id]
                [:mcp-apply/global]
                [:update-file/by-profile ::rpc/profile-id]]
   ::db/transaction true
   ::audit/skip false
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:mcp-apply-changes}
  [cfg params]
  (write-command cfg "mcp-apply-changes" params
                 {:with-data? false
                  :derive (fn [_file]
                            (let [changes (:changes params)]
                              (check-size! changes max-changes changes)
                              {:changes changes}))}))

;; --- COMMAND: mcp-apply-operations

(sv/defmethod ::mcp-apply-operations
  "Compiles typed operations against the latest file data and commits
  them. With `allow-split` the changes are committed in batches of whole
  operations, each with at most 300 object creations unless one operation
  alone has more, in one transaction."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope write-scope
   ::climit/id [[:mcp-apply/by-profile ::rpc/profile-id]
                [:mcp-apply/global]
                [:update-file/by-profile ::rpc/profile-id]]
   ::db/transaction true
   ::audit/skip false
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:mcp-apply-operations}
  [cfg params]
  (write-command cfg "mcp-apply-operations" params
                 {:with-data? true
                  :derive (fn [file]
                            (let [operations (vec (:operations params))]
                              (check-size! operations max-operations operations)
                              (let [compiled (compile-ops! cfg file operations)]
                                {:changes (:changes compiled)
                                 :warnings (:warnings compiled)
                                 :op-count (count operations)
                                 :op-ranges (:op-ranges compiled)
                                 :split? (boolean (:allow-split params))
                                 :extra {:created-ids (:created-ids compiled)}})))}))

;; --- COMMAND: mcp-import-svg

(sv/defmethod ::mcp-import-svg
  "Imports an SVG document as a wrapper frame holding its shapes. Embedded
  raster images are not uploaded."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope write-scope
   ::climit/id [[:mcp-apply/by-profile ::rpc/profile-id]
                [:mcp-apply/global]
                [:update-file/by-profile ::rpc/profile-id]]
   ::db/transaction true
   ::audit/skip false
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:mcp-import-svg}
  [cfg params]
  (write-command cfg "mcp-import-svg" params
                 {:with-data? true
                  :derive (fn [file]
                            (let [result (svg-import cfg file params)]
                              (check-size! (:changes result) max-changes (:changes result))
                              result))}))
