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
   [app.rpc.climit :as climit]
   [app.rpc.commands.files :as files]
   [app.rpc.commands.files-update :as files-update]
   [app.rpc.commands.mcp :as mcp]
   [app.rpc.commands.mcp-limits :as limits]
   [app.rpc.doc :as-alias doc]
   [app.rpc.mcp-font-lookup :as font-lookup]
   [app.util.blob :as blob]
   [app.util.pointer-map :as pmap]
   [app.util.services :as sv]
   [clojure.set :as set]
   [clojure.string :as str])
  (:import
   java.security.MessageDigest
   java.util.UUID))

;; --- LIMITS AND RULES

(def ^:private max-changes limits/max-changes)
(def ^:private max-operations limits/max-operations)
(def ^:private max-payload-bytes limits/max-payload-bytes)
(def ^:private replay-max-entries
  "The most entries of one list (`created-ids`, `shape-ids`) that the record of
  a request keeps for a replay."
  10000)

(def ^:private replay-max-bytes
  "The most bytes the encoded reply of a request may take in its record: 1 MiB.
  The record is the `mcp_reply` column of the first change row of the call, which the
  database drops with the other change rows after about an hour. One row of a
  call holds its compiled changes, which are far larger, so the reply adds a
  small share to what the call already stores."
  (* 1024 1024))

(def ^:private snapshot-threshold 100)
(def ^:private snapshot-keep 20)

(def ^:private notify-changes
  "The most compiled changes one commit batch holds, of any kind. A batch is
  one notification to every open tab, so a larger batch makes a larger
  message. A call above this limit is cut into batches even without
  `allow-split`; the batches still commit in one transaction. A single
  operation above the limit gets a batch of its own, and so does a reflow
  that would cross the limit."
  2000)

(def ^:private max-batches
  "The most commit batches one call may take. At `notify-changes` changes
  a batch, 50 batches hold the 100000 compiled changes of a call."
  50)

(def ^:private batch-time-budget-ms
  "How long one call may run, from the moment it holds the file lock,
  before the next batch is refused. A call past this limit fails and rolls
  back, so the file is free for the people who wait on it. The budget does
  not bound the compile (it runs before the first batch), a call with one
  batch (the first batch is never refused), or `finish-batches!`."
  60000)

(def ^:private lock-timeout
  "How long an MCP write waits for a lock before it fails with a conflict.
  A short wait keeps the connection free for other work."
  "15s")

(def ^:private refused-types
  "Change types no MCP call may apply."
  #{:set-tokens-lib :purge-component :purge-typography :purge-color})

(def ^:private delete-types
  "Change types that always take a snapshot before they are applied."
  #{:del-obj :del-page :del-component :del-color :del-typography :del-media})

(def ^:private token-delete-types
  "Token change types that delete when they carry no `:attrs`."
  #{:set-token :set-token-set :set-token-theme})

(def ^:private commit-features
  (set/difference cfeat/supported-features cfeat/frontend-only-features))

(defn- write-scope
  "The MCP scope a write needs. A dry run only reads the file."
  [params]
  (if (:dry-run params) "mcp:read" "mcp:write"))

(defn- force-for
  "The validation this tool forces on a call, whatever the flags say.
  Every call gets the affected-shapes check. A raw change batch also gets
  the schema check, since the agent builds those changes itself."
  [tool]
  {:affected true
   :schema   (= tool "mcp-apply-changes")})

(defn- validation-checks
  "The names of the checks that run for `tool`, in a fixed order."
  [tool]
  (let [mode (files-update/validation-mode (force-for tool))]
    (cond-> []
      (:affected mode) (conj "affected")
      (:schema mode)   (conj "schema"))))

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
   [:svg [:string {:max (* 8 1024 1024)}]]
   [:x {:optional true} ::sm/number]
   [:y {:optional true} ::sm/number]
   [:name {:optional true} :string]
   [:dry-run {:optional true} ::sm/boolean]
   [:request-id {:optional true} ::sm/uuid]])

;; --- HELPERS

(defn- canonical-text
  "A text of `value` that does not depend on how the value was built: map
  keys are sorted, map entries with a nil value are left out, sets are
  sorted and vectors keep their order. The same content gives the same
  text whatever the key order or the nil values, so a retry with reordered
  keys is the same request."
  [value]
  (cond
    (map? value)
    (str "{"
         (str/join ","
                   (for [[k v] (sort-by (comp pr-str key) value)
                         :when (some? v)]
                     (str (pr-str k) ":" (canonical-text v))))
         "}")

    (set? value)
    (str "#{" (str/join "," (sort (map canonical-text value))) "}")

    (sequential? value)
    (str "[" (str/join "," (map canonical-text value)) "]")

    :else
    (pr-str value)))

(defn- text-bytes
  "The size in bytes of `text`, in UTF-8."
  [^String text]
  (alength (.getBytes text "UTF-8")))

(defn- check-count!
  "Raises `:mcp-batch-too-large` when `items` has more than `max-count`
  entries. Runs before the file is locked."
  [items max-count]
  (when (> (count items) max-count)
    (ex/raise :type :validation
              :code :mcp-batch-too-large
              :hint (str "a call takes at most " max-count " items")
              :max-count max-count)))

(defn- check-payload-size!
  "Raises `:mcp-batch-too-large` when the canonical `text` of a call is
  larger than 8 MB. Runs before the file is locked, so an oversized call
  costs nothing on the file."
  [text]
  (when (> (text-bytes text) max-payload-bytes)
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

(defn- check-compiled-count!
  "Raises `:mcp-batch-too-large` when `changes` has more entries than the cap. Runs before any write, dry runs included."
  [changes]
  (let [limit (limits/max-compiled-changes)]
    (when (> (count changes) limit)
      (ex/raise :type :validation
                :code :mcp-batch-too-large
                :hint (str "the call compiles to more than " limit " changes")
                :max-count limit))))

(defn- check-batch-count!
  "Raises `:mcp-too-many-batches` when the call would take more commits than
  `max-batches`. Runs before the first write."
  [batches]
  (when (> (count batches) max-batches)
    (ex/raise :type :validation
              :code :mcp-too-many-batches
              :hint (str "a call takes at most " max-batches
                         " commits; send the work in smaller calls")
              :max-batches max-batches)))

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
    WHERE id = ANY(?)
      AND deleted_at IS NULL")

(defn- check-media!
  "Raises `:mcp-foreign-media` unless every media the changes refer to
  belongs to this file or to a library of it that the profile can read.
  A deleted media row counts as missing: the object GC removes it."
  [cfg profile-id file-id libraries changes]
  (let [ids (media-ids changes)]
    (when (seq ids)
      (let [conn     (::db/conn cfg)
            readable (into #{file-id}
                           (comp (map :id)
                                 (filter #(files/has-read-permissions? cfg profile-id %)))
                           (vals libraries))
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

(defn- payload-digest
  "The SHA-256 of the canonical `text` of a call, as hex."
  [^String text]
  (let [digest (.digest (MessageDigest/getInstance "SHA-256")
                        (.getBytes text "UTF-8"))]
    (str/join (map #(format "%02x" (bit-and % 0xff)) digest))))

(defn- payload-of
  "The part of a write call that defines its changes. A replayed request
  with another payload is a new write, so the digest covers this part."
  [params]
  (select-keys params [:changes :operations :page-id :parent-id :svg
                       :x :y :name :allow-split :snapshot]))

(defn- session-id
  "The session id of the commits of one request. Open tabs apply the
  change live because the id is not theirs. The id is a pure function of
  the token, the request id and the payload digest, so a retry of the
  same request and payload finds its own change rows (see
  `applied-before?`). A reused request id with another payload is a new
  write."
  [token-id request-id digest]
  (UUID/nameUUIDFromBytes
   (.getBytes ^String (str "penpot-mcp:" token-id ":" request-id ":" digest)
              "UTF-8")))

(def ^:private sql:session-changes
  "select c.changes
     from file_change as c
    where c.file_id = ?
      and c.session_id = ?
      and c.changes is not null
    order by c.revn asc")

(defn- session-changes
  "The changes of the commits of `session`, in commit order, read from the
  change rows of `file-id` that still exist. Empty when none."
  [cfg file-id session]
  (into []
        (mapcat #(blob/decode (:changes %)))
        (db/exec! (::db/conn cfg) [sql:session-changes file-id session])))

(def ^:private sql:session-exists
  "select 1
     from file_change as c
    where c.file_id = ?
      and c.session_id = ?
    limit 1")

(defn- applied-before?
  "True when an earlier call with the same request and payload already
  committed to the file. Runs under the file lock, before the changes are
  compiled. The change rows expire after about an hour and the objects GC
  removes them, so a retry after that window applies the changes again."
  [cfg file-id session]
  (boolean (db/exec-one! (::db/conn cfg) [sql:session-exists file-id session])))

(def ^:private replay-keys
  "The keys of the reply of a write that a replay returns again: the handle
  to id map and the per-operation results of `apply_operations`, and the ids
  of `import_svg`."
  [:created-ids :op-results :root-id :shape-ids])

(defn- encode-reply
  "The bytes of `reply` for the change row, and whether the reply was cut."
  [reply truncated?]
  (blob/encode (cond-> reply truncated? (assoc :replay-truncated true))))

(defn- cap-list
  "The first `n` entries of the list or map `value`. A map is cut in the order
  of its sorted keys, so the same map gives the same part."
  [value n]
  (if (map? value)
    (into {} (take n) (sort-by (comp str key) value))
    (vec (take n value))))

(defn- replay-reply
  "The bytes to store for a replay of the call that `extra` answers, or nil
  when the call has no reply data. At most `replay-max-entries` entries of
  each list are kept; a reply larger than `replay-max-bytes` loses its
  `op-results` first, then half of its entries at a time until it fits. A cut
  reply is flagged `:replay-truncated` when it is read back."
  [extra]
  (let [reply (select-keys extra replay-keys)]
    (when (seq reply)
      (let [capped (reduce-kv (fn [m k v]
                                (if (and (contains? #{:created-ids :shape-ids :op-results} k)
                                         (coll? v)
                                         (> (count v) replay-max-entries))
                                  (-> m (assoc k (cap-list v replay-max-entries)) (assoc ::cut true))
                                  m))
                              reply
                              reply)]
        (loop [reply     (dissoc capped ::cut)
               truncated? (some? (::cut capped))
               dropped?  false]
          (let [bytes (encode-reply reply truncated?)]
            (cond
              (<= (alength ^bytes bytes) replay-max-bytes)
              bytes

              (and (not dropped?) (contains? reply :op-results))
              (recur (dissoc reply :op-results) true true)

              :else
              (recur (reduce (fn [m k]
                               (cond-> m
                                 (coll? (get m k))
                                 (update k cap-list (quot (count (get m k)) 2))))
                             reply
                             [:created-ids :shape-ids])
                     true
                     dropped?))))))))

(def ^:private sql:session-reply
  "select c.mcp_reply
     from file_change as c
    where c.file_id = ?
      and c.session_id = ?
      and c.changes is not null
      and c.mcp_reply is not null
    order by c.revn asc
    limit 1")

(defn- stored-reply
  "The reply data a call kept in its first change row, decoded, or nil when
  the row holds none (a call made before the reply was kept)."
  [cfg file-id session]
  (some-> (db/exec-one! (::db/conn cfg) [sql:session-reply file-id session])
          :mcp-reply
          blob/decode))

(defn- snapshot-label
  [tool request-id]
  (str "mcp/" tool "/" (ct/format-inst (ct/now)) "/" request-id))

(defn- delete-change?
  "True for a change that deletes: a delete type, or a token change that
  carries no attributes, which removes the token, the set or the theme."
  [change]
  (or (contains? delete-types (:type change))
      (and (contains? token-delete-types (:type change))
           (nil? (:attrs change)))))

(defn- snapshot-wanted?
  "The snapshot rule: a delete always takes one, more than 100 operations
  or changes take one unless `snapshot` is false, and `snapshot` true
  forces one. With `hint?` (an operation asked for a snapshot, as
  `replace_font` does when it changes a text) a snapshot is taken unless
  `snapshot` is false."
  ([snapshot? changes size]
   (snapshot-wanted? snapshot? changes size false))
  ([snapshot? changes size hint?]
   (boolean
    (or (true? snapshot?)
        (some delete-change? changes)
        (and (not (false? snapshot?))
             (or (true? hint?)
                 (> size snapshot-threshold)))))))

(defn- split-batches
  "Cuts `changes` into batches of whole operations. `op-ranges` holds one
  `[start end]` pair per operation, the indexes in `changes` of the changes
  that operation emitted (see `compile-operations`). A batch takes the next
  operation unless that would push its changes past `notify-changes`. A
  batch that holds no operation yet always takes it, so an operation larger
  than the bound gets a batch of its own.

  The changes after the last range, the layout reflow, go into the last
  batch. A reflow that would cross the bound gets batches of its own: the
  last operation batch is closed first, and the reflow is cut into pieces
  of at most `notify-changes`. Returns the batches as maps with `:changes`,
  `:first-op` and `:last-op`, the first and last operation index of the
  batch (nil for a reflow batch). Raises `:mcp-batch-split-mismatch` if the
  batches do not hold every change."
  [changes op-ranges]
  (let [empty-batch {:changes [] :size 0 :first-op nil :last-op nil}
        [closed open]
        (reduce (fn [[closed batch] [index [start end]]]
                  (let [op-size (- end start)
                        full?   (and (some? (:first-op batch))
                                     (> (+ (:size batch) op-size) notify-changes))
                        [closed batch] (if full?
                                         [(conj closed batch) empty-batch]
                                         [closed batch])]
                    [closed (-> batch
                                (update :changes into (subvec changes start end))
                                (update :size + op-size)
                                (update :first-op #(or % index))
                                (assoc :last-op index))]))
                [[] empty-batch]
                (map-indexed vector op-ranges))
        reflow     (subvec changes (if (seq op-ranges)
                                     (second (peek op-ranges))
                                     0))
        cross?     (> (+ (:size open) (count reflow)) notify-changes)
        closed     (cond-> closed
                     (and cross? (seq (:changes open))) (conj open))
        tail       (if cross?
                     (map (fn [piece]
                            {:changes (vec piece)
                             :size (count piece)
                             :first-op nil
                             :last-op nil})
                          (partition-all notify-changes reflow))
                     [(update open :changes into reflow)])
        batches    (mapv #(dissoc % :size) (concat closed tail))]
    (when (not= (count changes)
                (reduce + 0 (map (comp count :changes) batches)))
      (ex/raise :type :internal
                :code :mcp-batch-split-mismatch
                :hint "the batches do not hold every change of the call"))
    batches))

(defn- batches-of
  "The batches `changes` commit in, as maps with `:changes` and the
  operation indexes they hold (`:first-op` and `:last-op`, nil when the
  batch holds no operation). With `split?`, or when the call has more
  changes than `notify-changes`, the batches cut at operation boundaries;
  otherwise the whole call is one batch."
  [changes op-ranges split?]
  (cond
    (empty? changes) []
    (or split? (> (count changes) notify-changes))
    (split-batches changes op-ranges)

    :else
    [{:changes    changes
      :first-op   (when (seq op-ranges) 0)
      :last-op    (when (seq op-ranges) (dec (count op-ranges)))}]))

(defn- batch-failure
  "The error of a failed batch, with the context of the call. Returns `cause` unchanged when it is not a Penpot error. The operations of the batch come from the batch itself, so no database access is needed. `:failed-operation-index` and `:failed-operation-last-index` are left out when the batch holds no operation."
  [cause last-revn change-offset {:keys [first-op last-op]}]
  (if (ex/ex-info? cause)
    (ex-info (.getMessage ^Throwable cause)
             (cond-> (assoc (ex-data cause)
                            :revn-before-call last-revn
                            :failed-change-index change-offset)
               (some? first-op) (assoc :failed-operation-index first-op
                                       :failed-operation-last-index last-op))
             cause)
    cause))

(declare ^:private file-ids-of)

(defn- invalid-change-of
  "The first change of `changes` that the processor rejects with an
  assertion, as `{:index i :cause e}`, or nil. The changes are applied one at
  a time to `data`, so the index is exact. Runs on the failure path only."
  [cfg file-ids data changes]
  (binding [pmap/*load-fn* (partial feat.fdata/load-pointer-of-files cfg file-ids)]
    (loop [data    data
           index   0
           changes (seq changes)]
      (when-let [change (first changes)]
        (let [outcome (try
                        (cpc/process-changes data [change])
                        (catch clojure.lang.ExceptionInfo cause
                          cause))]
          (if (instance? clojure.lang.ExceptionInfo outcome)
            (when (= :assertion (:type (ex-data outcome)))
              {:index index :cause outcome})
            (recur outcome (inc index) (next changes))))))))

(defn- explain-path
  "The first failing path of a rejected shape, as a dotted text, or nil."
  [cause]
  (some->> (get-in (ex-data cause) [::sm/explain :errors])
           first
           :in
           seq
           (map #(if (keyword? %) (name %) (str %)))
           (str/join ".")))

(defn- raw-change-failure
  "The error of a change the processor rejects. For `mcp-apply-changes` the
  changes are the agent's, so an internal assertion is reported as
  `:mcp-invalid-change`, with the index of the change in the call and the
  first failing path. It carries no explain and no shape record. The
  operation tools compile their changes, so the same assertion is a fault
  of the compiler: it is `:mcp-compile-failed`, with no change index the
  agent could map. Any other cause is returned unchanged."
  [tool cfg libraries file offset changes cause]
  (cond
    (not= :assertion (:type (ex-data cause)))
    cause

    (not= "mcp-apply-changes" tool)
    (ex/raise :type :internal
              :code :mcp-compile-failed
              :hint (str "the compiler of " tool " produced a change the processor rejects")
              :cause cause)

    :else
    (let [found (invalid-change-of cfg (file-ids-of file libraries) (:data file) changes)
          index (some-> found :index (+ offset))
          path  (some-> found :cause explain-path)]
      (ex/raise :type :validation
                :code :mcp-invalid-change
                :hint (str "a change is invalid"
                           (when index (str ": change " index))
                           (when path (str ", at " path)))
                :change-index index
                :field path))))

(defn- unknown-shape-warnings
  "A warning for each `:mod-obj` or `:del-obj` change whose shape is not on
  its page: such a change changes nothing. Read from the loaded file.
  A shape that an earlier `:add-obj` of the same call creates is not
  unknown: a later operation may name it, as the reflow of a new layout
  does. The changes are walked in order, keeping the ids added so far."
  [cfg libraries file changes]
  (let [objects (memoize
                 (fn [page-id]
                   (binding [pmap/*load-fn* (partial feat.fdata/load-pointer-of-files cfg
                                                     (file-ids-of file libraries))]
                     (some-> (get-in file [:data :pages-index page-id])
                             (as-> page (if (pmap/pointer-map? page) (deref page) page))
                             :objects))))]
    (first
     (reduce
      (fn [[warnings added] [index change]]
        (let [page-id   (:page-id change)
              id        (:id change)
              shape-key [page-id id]]
          (cond
            (= :add-obj (:type change))
            [warnings (conj added shape-key)]

            (and (contains? #{:mod-obj :del-obj} (:type change))
                 (some? page-id)
                 (some? (objects page-id))
                 (not (contains? (objects page-id) id))
                 (not (contains? added shape-key)))
            [(conj warnings {:kind "unknown-shape"
                             :change-index index
                             :shape-id id
                             :page-id page-id})
             added]

            :else
            [warnings added])))
      [[] #{}]
      (map-indexed vector changes)))))

(defn- over-budget?
  [started-ns]
  (> (/ (- (System/nanoTime) started-ns) 1e6)
     batch-time-budget-ms))

(defn- commit-batches!
  "Commits `batches` in order, in the transaction of the call. The file is
  decoded and written once, by `files-update/begin-batches!` and
  `finish-batches!`. The snapshot is taken with the first batch only, and
  the automatic snapshot is kept out of every batch, so it is taken at
  most once and never on a half-applied state.

  Before a batch after the first, the call checks its time budget
  (`:mcp-time-budget-exceeded`). A failed batch raises with the context
  of the call. The `reply` bytes (see `replay-reply`) go with the change row
  of the first batch. Returns the stored revn and the snapshot id."
  [cfg file libraries batches {:keys [profile-id session-id reply snapshot? label tool started-ns]}]
  (let [ctx (files-update/begin-batches!
             cfg file
             {:profile-id profile-id
              :session-id session-id
              :vern (:vern file)
              :features commit-features
              :libraries libraries
              :force-validate (force-for tool)})]
    (loop [index  0
           ctx    ctx
           offset 0]
      (if (< index (count batches))
        (let [batch (nth batches index)]
          (when (and (pos? index) (over-budget? started-ns))
            (ex/raise :type :validation
                      :code :mcp-time-budget-exceeded
                      :hint "the call ran longer than its time budget; send the work in smaller calls"
                      :budget-ms batch-time-budget-ms
                      :revn-before-call (:revn file)))
          (let [opts (cond-> {::files-update/skip-auto-snapshot (or snapshot? (pos? index))}
                       ;; The reply of the call goes with the first change row
                       (and (zero? index) (some? reply))
                       (assoc ::files-update/reply reply)
                       (and snapshot? (zero? index))
                       (assoc ::files-update/mcp-snapshot {:label label
                                                           :keep snapshot-keep}))
                ctx' (try
                       (files-update/apply-batch! ctx (:changes batch) opts)
                       (catch Throwable cause
                         (throw (batch-failure (raw-change-failure tool cfg libraries (:file ctx) offset (:changes batch) cause)
                                               (:revn file) offset batch))))]
            (recur (inc index)
                   ctx'
                   (+ offset (count (:changes batch))))))
        (files-update/finish-batches! ctx)))))

(defn- sql-lock-timeout
  []
  (str "SET LOCAL lock_timeout = '" lock-timeout "'"))

(defn- lock-wait!
  "Runs `f`, which takes a lock. A lock wait that the lock timeout ends
  raises a conflict the agent can retry. For the file lock (`file-lock?`,
  the advisory lock and the share lock of the file row) it is
  `:mcp-file-busy`, naming the file. Any other wait is
  `:mcp-lock-timeout`: the project or team row another write holds."
  [file-lock? file-id f]
  (try
    (f)
    (catch java.sql.SQLException cause
      (if (= "55P03" (.getSQLState cause))
        (if file-lock?
          (ex/raise :type :conflict
                    :code :mcp-file-busy
                    :hint "another write holds the file; retry later"
                    :file-id file-id
                    :cause cause)
          (ex/raise :type :conflict
                    :code :mcp-lock-timeout
                    :hint "a project or team row could not be locked; another write holds it, retry later"
                    :file-id file-id
                    :cause cause))
        (throw cause)))))

(defn- load-write-file
  "Checks the caller against the file and loads it with its data, decoded.
  A dry run needs read permission and takes no lock; it loads the file
  with `:read-only?`, so a migration on read is not saved. A write needs
  edit permission, sets the lock timeout, and takes the file lock and
  the share lock of the file row before it reads the file, so the commit
  extends the revn it reads. A lock wait that runs out raises a conflict
  (see `lock-wait!`)."
  [cfg params profile-id file-id dry-run?]
  (mcp/check-profile! cfg profile-id params)
  (let [conn (::db/conn cfg)
        file (if dry-run?
               (do
                 (files/check-read-permissions! cfg profile-id file-id)
                 (bfc/get-file cfg file-id :read-only? true))
               (do
                 (files/check-edition-permissions! conn profile-id file-id)
                 (db/exec! conn [(sql-lock-timeout)])
                 (lock-wait! true file-id
                             #(do
                                (db/xact-lock! conn file-id)
                                (bfc/get-file cfg file-id :lock-for-share? true)))))]
    ;; The compile and the batches read the data by its file id.
    (update file :data assoc :id file-id)))

(defn- file-ids-of
  "The ids of `file` and of its libraries: every file a pointer of the
  call may belong to. The pointer loader names them, so the lookup reads
  only their partitions."
  [file libraries]
  (into [(:id file)] (keys libraries)))

(defn- font-lookup-for
  "The font lookup that `replace_font` reads, or nil when no operation of the
  call is one: a call without it builds no lookup and reads no font data."
  [cfg file operations]
  (when (some #(= "replace_font" (:op %)) operations)
    (font-lookup/make-font-lookup cfg (:team-id file))))

(defn- compile-ops!
  "Compiles `operations` against the data of `file`, with the resolved
  `libraries`. A library's pages load when an operation reads them, through
  the loader that names the library's file id. The font lookup is built only
  for a call that holds a `replace_font` operation (see `font-lookup-for`)."
  [file libraries cfg operations]
  (binding [pmap/*load-fn* (partial feat.fdata/load-pointer-of-files cfg
                                    (file-ids-of file libraries))]
    (operations/compile-operations (:data file)
                                   operations
                                   {:new-id-fn uuid/next
                                    :libraries libraries
                                    :font-lookup (font-lookup-for cfg file operations)})))

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
  "The validation outcome of `changes` applied in memory to `file`, with the
  resolved `libraries`. The checks are the ones the commit runs
  (`files-update/validation-mode` with the force of `tool`), and the errors
  carry the codes the commit would raise. Reports the checks that ran."
  [cfg tool file libraries changes]
  (let [{:keys [affected schema]} (files-update/validation-mode (force-for tool))
        checks (validation-checks tool)
        errors
        (binding [pmap/*load-fn* (partial feat.fdata/load-pointer-of-files cfg
                                          (file-ids-of file libraries))]
          (try
            (let [file' (assoc file :data (cpc/process-changes (:data file) changes))]
              (cond-> []
                affected (into (affected-errors file (val/validate-file-affected file' libraries changes)))
                schema   (into (schema-errors file'))))
            (catch clojure.lang.ExceptionInfo cause
              [{:code (get (ex-data cause) :code :processing-failed)
                :hint (.getMessage cause)}])))]
    (if (empty? errors)
      {:ok true :checks checks}
      {:ok false :checks checks :errors errors})))

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

(defn- applied-result
  "The result of a call whose request an earlier call already applied.
  Nothing is written: the counts come from the change rows of that call,
  and no change is recorded or notified again. The reply data of the first
  answer (the `created-ids` handle map, the `op-results`, the ids of an SVG
  import) comes from the first change row of the call, as it was kept,
  flagged `replay-truncated` when it was cut. An `apply_operations` replay
  with no kept reply has none of them."
  [cfg tool file session]
  (let [changes (session-changes cfg (:id file) session)
        result  (merge {:revn (:revn file)
                        :already-applied true
                        :commits 0
                        :change-count (count changes)
                        :change-types (change-types changes)
                        :warnings []
                        :dry-run false
                        :validation {:ok true :checks []}}
                       (stored-reply cfg (:id file) session))]
    [result {:tool tool
             :file-id (:id file)
             :id (:id file)
             :name (:name file)
             :project-id (:project-id file)
             :team-id (:team-id file)
             :revn-before (:revn file)
             :revn-after (:revn file)
             :revn (:revn file)
             :already-applied true}]))

(defn- run-write
  "The write path the three commands share. `derive` takes the loaded
  file and the resolved libraries, and returns a map with `:changes`, and
  optionally `:warnings`, `:op-count` (the operations or changes the call
  names, for the snapshot rule), `:op-ranges` (the change range of each
  operation, see `split-batches`), `:split?`, `:snapshot-hint` (true when an
  operation wants a snapshot, see `snapshot-wanted?`) and `:extra` (merged into
  the result). `text` is the canonical text of the call, see `canonical-text`.
  Returns the result and the audit props.

  A write takes the file lock before it loads the file. Under the lock,
  a request that already committed is answered from its change rows,
  without compiling anything. The libraries are resolved once, here, and
  passed to the compile, the validation and the batches."
  [cfg tool {:keys [::rpc/profile-id file-id dry-run request-id
                    base-revn fail-on-conflict snapshot]
             :as params}
   {:keys [derive text]}]
  (let [dry-run?   (boolean dry-run)
        request-id (or request-id (uuid/next))
        token-id   (mcp/get-token-id params)
        file       (load-write-file cfg params profile-id file-id dry-run?)
        ;; The time budget counts from the lock, which the load takes.
        started-ns (System/nanoTime)
        ;; A dry run writes nothing, so it has no session to replay.
        session    (when-not dry-run?
                     (session-id token-id request-id (payload-digest text)))]

    (if (and session (applied-before? cfg file-id session))
      (applied-result cfg tool file session)

      (let [libraries  (files-update/library-files cfg file-id)
            derived    (derive file libraries)
            changes    (vec (:changes derived))
            _          (check-change-types! changes)
            _          (check-compiled-count! changes)
            _          (check-media! cfg profile-id file-id libraries changes)
            lag        (revn-lag cfg file-id base-revn (:revn file) changes)
            _          (when (and fail-on-conflict
                                  (or (seq (:overlap lag))
                                      (:truncated? lag)))
                         (ex/raise :type :conflict
                                   :code :mcp-revn-conflict
                                   :hint "commits made since the base revision touch the same shapes, or the read could not see every commit since then"
                                   :changed-shape-ids (vec (:overlap lag))
                                   :truncated (boolean (:truncated? lag))))

            warnings   (cond-> (into (vec (:warnings derived))
                                     (unknown-shape-warnings cfg libraries file changes))
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
          [(merge (:extra derived)
                  base
                  {:revn (:revn file)
                   :validation (validation-of cfg tool file libraries changes)})
           (assoc audit :revn-after (:revn file))]

          (let [label     (snapshot-label tool request-id)
                snapshot? (snapshot-wanted? snapshot
                                            changes
                                            (or (:op-count derived) (count changes))
                                            (:snapshot-hint derived))
                batches   (batches-of changes (:op-ranges derived) (:split? derived))
                _         (check-batch-count! batches)
                outcome   (if (seq batches)
                            (commit-batches! cfg file libraries batches
                                             {:profile-id profile-id
                                              :session-id session
                                              :reply (replay-reply (:extra derived))
                                              :snapshot? snapshot?
                                              :label label
                                              :tool tool
                                              :started-ns started-ns})
                            {:revn (:revn file)})]

            ;; The metrics and the log line come after the commit, so a
            ;; rolled back call records nothing.
            (when (seq batches)
              (db/after-commit
               (fn []
                 (doseq [[type-name n] (change-types changes)]
                   (mcp/record-change cfg tool type-name n)))))

            [(cond-> (merge (:extra derived)
                            base
                            {:revn (:revn outcome)
                             :commits (count batches)
                             :validation {:ok true
                                          :checks (validation-checks tool)}})
               (some? (:snapshot-id outcome))
               (assoc :snapshot-id (:snapshot-id outcome))

               (:truncated? lag)
               (assoc :lagged-truncated true))
             (cond-> (assoc audit
                            :revn-after (:revn outcome)
                            :revn (:revn outcome)
                            :modified-at (ct/now))
               (some? (:snapshot-id outcome))
               (assoc :snapshot-id (:snapshot-id outcome)))]))))))

(defn- write-command
  "Runs a write command through `mcp/run-tool` and attaches the write audit props: the change count and the histogram of the call. A write (not a dry run) also names its event `update-file`, marks it as a webhook event and batches it per file, as the `update-file` RPC does, so MCP writes reach webhook consumers with the same event and payload shape. A replayed request names no event: it wrote nothing.

  The canonical text of the call is built once here: it is checked for size before the file is locked, and it is the digest input of a write."
  [cfg tool params opts]
  (let [;; The log line and the audit props name the request as the reads
        ;; do, by the RPC request id. A call that came with only its body
        ;; `request-id` (or with none, in tests) takes that id.
        params  (cond-> params
                  (nil? (::rpc/request-id params))
                  (assoc ::rpc/request-id (or (:request-id params) (uuid/next))))
        started (System/nanoTime)
        audit   (volatile! nil)
        text    (canonical-text (payload-of params))
        _       (check-payload-size! text)
        result  (mcp/run-tool cfg tool params
                              (fn []
                                (let [[result props]
                                      (lock-wait! false (:file-id params)
                                                  #(run-write cfg tool params
                                                              (assoc opts :text text)))]
                                  (vreset! audit props)
                                  [result props])))
        ;; These props replace the ones `run-tool` attaches, so they carry
        ;; the request id too.
        props   (assoc @audit
                       :request-id (::rpc/request-id params)
                       :duration-ms (/ (- (System/nanoTime) started) 1000000.0))
        write?  (and (not (:dry-run params))
                     (not (:already-applied result)))]
    (cond-> (vary-meta result assoc ::audit/replace-props props)
      write?
      (vary-meta assoc
                 ::audit/name "update-file"
                 ::webhooks/event? true
                 ::webhooks/batch-key (webhooks/key-fn ::rpc/profile-id :file-id)
                 ::webhooks/batch-timeout (ct/duration "2m")))))

;; --- TEAM LIMIT

(def ^:private sql:team-of-file
  "select p.team_id
     from file as f
     join project as p on p.id = f.project_id
    where f.id = ?")

(defn- team-of-file
  "The team of the file `file-id`, or nil when the file does not exist.
  One indexed lookup on the pool: the limiter runs before the transaction."
  [cfg file-id]
  (:team-id (db/exec-one! cfg [sql:team-of-file file-id])))

(def ^:private team-key
  "The key of the `:mcp-apply/by-team` limiter: the team of the write's file.
  The writes of one team share its permits, so the agents of a team of many
  profiles cannot saturate the backend. A file that does not exist has no
  team and takes the unkeyed limiter; the command fails on the file itself.
  The write commands declare this limit last: `climit/wrap` takes the first
  declared limit innermost, so the lookup runs before any permit is held."
  (climit/with-cfg
    (fn [cfg params]
      (some->> (:file-id params) (team-of-file cfg)))))

;; --- COMMAND: mcp-apply-changes

(sv/defmethod ::mcp-apply-changes
  "Applies raw change records to a file in one commit. With `dry-run`
  the changes are applied in memory and validated only. Raw changes are
  off unless the deployment turns `enable-mcp-raw-changes` on."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope write-scope
   ::climit/id [[:mcp-apply/by-profile ::rpc/profile-id]
                [:mcp-apply/global]
                [:mcp-update-file/by-profile ::rpc/profile-id]
                [:mcp-apply/by-team team-key]]
   ::db/transaction true
   ::audit/skip false
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:mcp-apply-changes}
  [cfg params]
  (when-not (contains? cf/flags :mcp-raw-changes)
    (ex/raise :type :restriction
              :code :mcp-raw-changes-disabled
              :hint "raw change batches are off on this deployment; send typed operations instead"))
  (check-count! (:changes params) max-changes)
  (write-command cfg "mcp-apply-changes" params
                 {:derive (fn [_file _libraries]
                            {:changes (:changes params)})}))

;; --- COMMAND: mcp-apply-operations

(sv/defmethod ::mcp-apply-operations
  "Compiles typed operations against the latest file data and commits
  them. With `allow-split` the changes are committed in batches of whole
  operations, each with at most 2000 changes unless one operation alone
  has more. Every batch of one call commits in one transaction."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope write-scope
   ::climit/id [[:mcp-apply/by-profile ::rpc/profile-id]
                [:mcp-apply/global]
                [:mcp-update-file/by-profile ::rpc/profile-id]
                [:mcp-apply/by-team team-key]]
   ::db/transaction true
   ::audit/skip false
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:mcp-apply-operations}
  [cfg params]
  (check-count! (:operations params) max-operations)
  (write-command cfg "mcp-apply-operations" params
                 {:derive (fn [file libraries]
                            (let [operations (vec (:operations params))
                                  compiled   (compile-ops! file libraries cfg operations)]
                              {:changes (:changes compiled)
                               :warnings (:warnings compiled)
                               :op-count (count operations)
                               :op-ranges (:op-ranges compiled)
                               :split? (boolean (:allow-split params))
                               :snapshot-hint (:snapshot-hint compiled)
                               ;; The per-operation results, only when an
                               ;; operation reports one.
                               :extra (cond-> {:created-ids (:created-ids compiled)}
                                        (some some? (:op-results compiled))
                                        (assoc :op-results (:op-results compiled)))}))}))

;; --- COMMAND: mcp-import-svg

(sv/defmethod ::mcp-import-svg
  "Imports an SVG document as a wrapper frame holding its shapes. Embedded
  raster images are not uploaded."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope write-scope
   ::climit/id [[:mcp-apply/by-profile ::rpc/profile-id]
                [:mcp-apply/global]
                [:mcp-update-file/by-profile ::rpc/profile-id]
                [:mcp-apply/by-team team-key]]
   ::db/transaction true
   ::audit/skip false
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:mcp-import-svg}
  [cfg params]
  (write-command cfg "mcp-import-svg" params
                 {:derive (fn [file _libraries]
                            (let [result (svg-import cfg file params)]
                              (check-count! (:changes result) max-changes)
                              result))}))
