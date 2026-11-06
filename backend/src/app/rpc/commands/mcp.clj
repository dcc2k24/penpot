;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.rpc.commands.mcp
  "Read commands of the backend-native MCP: identity, file outline,
  page trees, shape projections, search, library and tokens. See
  `mcp/docs/backend-mode-contract.md`."
  (:require
   [app.binfile.common :as bfc]
   [app.common.exceptions :as ex]
   [app.common.features :as cfeat]
   [app.common.files.helpers :as cfh]
   [app.common.files.tokens :as cfo]
   [app.common.geom.rect :as grc]
   [app.common.logging :as l]
   [app.common.schema :as sm]
   [app.common.time :as ct]
   [app.common.transit :as t]
   [app.common.types.components-list :as ctkl]
   [app.common.types.shape.layout :as ctl]
   [app.common.types.text :as txt]
   [app.common.types.tokens-lib :as ctob]
   [app.common.types.tokens-status :as ctos]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.features.fdata :as feat.fdata]
   [app.http.access-token :as-alias actoken]
   [app.http.session :as session]
   [app.loggers.audit :as-alias audit]
   [app.metrics :as mtx]
   [app.rpc :as-alias rpc]
   [app.rpc.climit :as-alias climit]
   [app.rpc.commands.files :as files]
   [app.rpc.commands.profile :as profile]
   [app.rpc.doc :as-alias doc]
   [app.rpc.helpers :as rph]
   [app.rpc.mcp-scope :as mcp-scope]
   [app.tokens :as tokens]
   [app.util.cache :as cache]
   [app.util.pointer-map :as pmap]
   [app.util.services :as sv]
   [clojure.string :as str])
  (:import
   java.security.MessageDigest
   java.util.Base64))

;; --- METRICS AND AUDIT

(defn record-tool-timing
  "Records how long one call of the MCP `tool` took, with its `outcome`
  (\"ok\" or \"error\")."
  [cfg tool outcome duration-ms]
  (mtx/run! (mtx/instance cfg)
            :id :mcp-tool-timing
            :labels [tool outcome]
            :val (/ duration-ms 1000.0)))

(defn record-error
  "Counts one failed call of the MCP `tool`, by its error `code`."
  [cfg tool code]
  (mtx/run! (mtx/instance cfg)
            :id :mcp-errors-total
            :labels [tool code]
            :inc 1))

(defn record-change
  "Counts `n` changes of `change-type` applied by the MCP `tool`."
  [cfg tool change-type n]
  (mtx/run! (mtx/instance cfg)
            :id :mcp-changes-total
            :labels [tool change-type]
            :inc n))

(defn- elapsed-ms
  [started]
  (/ (- (System/nanoTime) started) 1000000.0))

(defn- error-code
  [cause]
  (if-let [code (:code (ex-data cause))]
    (name code)
    "internal"))

(defn- audit-props
  "The audit props of one call. The keys of `props` win over the
  defaults. Read calls name their revn with `:revn`, which is not an
  audit key, so it is dropped."
  [tool props duration-ms]
  (let [{:keys [file-id page-ids revn token-id]} props]
    (-> {:tool tool
         :file-id file-id
         :page-ids (vec page-ids)
         :change-count 0
         :change-types {}
         :revn-before revn
         :revn-after revn
         :duration-ms duration-ms
         :token-id token-id}
        (merge props)
        (dissoc :revn)
        (update :page-ids vec))))

(defn get-token-id
  "The id of the access token that authenticated the request, or nil
  when the request carries none (unit tests)."
  [params]
  (let [request (-> params meta :app.http/request)]
    (when (map? request)
      (get request ::actoken/id))))

(defn- token-fingerprint
  "The first eight hex chars of the SHA-256 of the token id, or nil when
  there is no token id. Logged in place of the token id."
  [token-id]
  (when (some? token-id)
    (let [digest (.digest (MessageDigest/getInstance "SHA-256")
                          (.getBytes (str token-id) "UTF-8"))]
      (apply str (map #(format "%02x" (bit-and % 0xff)) (take 4 digest))))))

(defn run-tool
  "Runs the body `f` of the MCP `tool` called with `params`. `f` returns
  `[result props]`, where `props` names the file, the pages and the revn
  the call touched. Records the timing and the outcome, logs one line
  and attaches the audit props to the result. A failing body records
  its error code and is rethrown."
  [cfg tool params f]
  (let [started    (System/nanoTime)
        profile-id (::rpc/profile-id params)
        file-id    (:file-id params)
        token-fp   (token-fingerprint (get-token-id params))]
    (try
      (let [[result props] (f)
            duration       (elapsed-ms started)]
        (record-tool-timing cfg tool "ok" duration)
        (l/inf :hint "mcp-tool"
               :tool tool
               :profile-id profile-id
               :file-id file-id
               :token-fp token-fp
               :duration-ms duration
               :outcome "ok")
        (rph/with-meta result
          {::audit/replace-props (audit-props tool props duration)}))
      (catch Throwable cause
        (let [code     (error-code cause)
              duration (elapsed-ms started)]
          (record-tool-timing cfg tool "error" duration)
          (record-error cfg tool code)
          (l/inf :hint "mcp-tool"
                 :tool tool
                 :profile-id profile-id
                 :file-id file-id
                 :token-fp token-fp
                 :duration-ms duration
                 :outcome "error"
                 :code code)
          (throw cause))))))

;; --- AUTH

(defn check-profile!
  "Rejects blocked and inactive profiles, as `send-mcp-feedback` does.
  Returns the profile."
  [cfg profile-id]
  (let [profile (profile/get-profile cfg profile-id)]
    (when (:is-blocked profile)
      (ex/raise :type :authorization
                :code :profile-blocked
                :hint "profile is marked as blocked"))
    (when-not (:is-active profile)
      (ex/raise :type :authorization
                :code :profile-not-active
                :hint "profile is not active"))
    profile))

(defn- check-access!
  [cfg profile-id file-id]
  (check-profile! cfg profile-id)
  (files/check-read-permissions! cfg profile-id file-id))

;; --- FILE DATA

(defn- load-file-data
  "The file read in the caller's transaction. The pages stay pointer
  maps and `get-page-data` loads one at a time. The pointer maps of the
  file-level collections named in `ks` are loaded too. A file that needs
  migration is migrated and persisted here, once."
  [cfg file-id ks]
  (let [file (bfc/get-file cfg file-id)]
    (binding [pmap/*load-fn* (partial feat.fdata/load-pointer cfg file-id)]
      (update file :data
              (fn [data]
                (reduce (fn [data k]
                          (let [v (get data k)]
                            (cond-> data
                              (pmap/pointer-map? v) (assoc k (deref v)))))
                        data
                        ks))))))

(def ^:private page-cache
  (cache/create :expire "10m" :max-size 256))

(defn- load-page
  "The page `page-id` of a file `data`, with its pointer map loaded from
  the database. Decodes the page on every call."
  [cfg file-id data page-id]
  (let [page (get-in data [:pages-index page-id])]
    (binding [pmap/*load-fn* (partial feat.fdata/load-pointer cfg file-id)]
      (if (pmap/pointer-map? page)
        (deref page)
        page))))

(defn- get-page-data
  "The page `page-id` of a file `data` at revision `revn`. The decoded
  page is kept in `page-cache` for the revision."
  [cfg file-id revn data page-id]
  (when (nil? (get-in data [:pages-index page-id]))
    (ex/raise :type :not-found
              :code :page-not-found
              :hint "page not found"))
  (cache/get page-cache [file-id page-id revn]
             (fn [_] (load-page cfg file-id data page-id))))

(defn- text-layout-state
  [shape]
  (if (some? (:position-data shape)) "exact" "approximate"))

(defn- shape-characters
  [shape]
  (if (some? (:content shape))
    (txt/content->text (:content shape))
    ""))

(defn- text-size-approximate?
  "Whether the box of the text `shape` is the backend's estimate: the
  text grows with its content and no browser has laid it out yet."
  [shape]
  (and (= :text (:type shape))
       (contains? #{:auto-width :auto-height} (:grow-type shape))
       (nil? (:position-data shape))))

(defn- shape-box
  "`shape` with the box the plugin API reports. `:x` and `:y` are the
  top-left corner of the rectangle around its points; `:width` and
  `:height` are the size of its selrect, before rotation. The stored
  attrs go stale on a bool or path whose content changed, and do not
  match the points of a rotated shape. A shape without points, as the
  page root, keeps its stored attrs."
  [shape]
  (if-let [bounds (grc/points->rect (:points shape))]
    (let [size (or (:selrect shape) bounds)]
      (assoc shape
             :x (:x bounds)
             :y (:y bounds)
             :width (:width size)
             :height (:height size)))
    shape))

(def ^:private shape-defaults
  "Values Penpot assumes for a shape that does not store these attrs."
  {:hidden false
   :blocked false
   :opacity 1})

(def ^:private default-stroke-alignment
  "The alignment the renderers assume for a stroke that stores none."
  :center)

(def ^:private default-layout-item-sizing
  "The sizing the plugin API reports for a layout board or child that
  stores none."
  :fix)

(defn- fill-missing
  [shape defaults]
  (reduce-kv (fn [shape k v]
               (if (nil? (get shape k))
                 (assoc shape k v)
                 shape))
             shape
             defaults))

(defn- with-defaults
  "`shape` with the defaults Penpot assumes for `hidden`, `blocked`,
  `opacity`, the alignment of its strokes and, on a layout board or
  child, its layout sizing."
  [objects shape]
  (cond-> (fill-missing shape shape-defaults)
    (seq (:strokes shape))
    (update :strokes (partial mapv #(fill-missing % {:stroke-alignment default-stroke-alignment})))

    (or (ctl/any-layout? shape)
        (ctl/any-layout-immediate-child? objects shape))
    (fill-missing {:layout-item-h-sizing default-layout-item-sizing
                   :layout-item-v-sizing default-layout-item-sizing})))

(defn- shape-children
  "The children of `shape` in the order the tree shows them. With `visual?`
  the children of a flex or grid layout come in visual order, the reverse of
  the stored `:shapes`, since a layout keeps its children reversed. Every
  other shape keeps its stored order."
  [shape visual?]
  (let [children (:shapes shape)]
    (if (and visual?
             (or (ctl/flex-layout? shape)
                 (ctl/grid-layout? shape)))
      (vec (reverse children))
      children)))

(defn- page-preorder
  "Pre-order `[level id]` entries of the subtree at `start-id`, down to
  `max-level` levels (the start shape is level 1). Missing shapes are
  skipped. With `visual?` the children of layouts come in visual order (see
  `shape-children`)."
  [objects start-id max-level visual?]
  (loop [stack [[1 start-id]]
         out   (transient [])]
    (if-let [[level id] (peek stack)]
      (let [stack (pop stack)]
        (if-let [shape (get objects id)]
          (let [children (when (< level max-level) (shape-children shape visual?))
                stack    (reduce (fn [stack child]
                                   (conj stack [(inc level) child]))
                                 stack
                                 (rseq (vec children)))]
            (recur stack (conj! out [level id])))
          (recur stack out)))
      (persistent! out))))

(defn- ancestor-indexes
  "Indexes, ascending, of the ancestors of entry `start` in the pre-order
  `entries` (each entry is `[level id]`)."
  [entries start]
  (if (zero? start)
    []
    (loop [i      (dec start)
           target (dec (first (nth entries start)))
           out    ()]
      (cond
        (< target 1)
        (vec out)

        (neg? i)
        (vec out)

        (= (first (nth entries i)) target)
        (recur (dec i) (dec target) (conj out i))

        :else
        (recur (dec i) target out)))))

;; --- COMMAND: mcp-whoami

(def ^:private sql:token-expiry
  "SELECT expires_at
     FROM access_token
    WHERE id = ?")

(defn- token-expiry
  [cfg token-id]
  (when (some? token-id)
    (:expires-at (db/exec-one! cfg [sql:token-expiry token-id]))))

(def ^:private schema:mcp-whoami
  [:map {:title "mcp-whoami" :closed true}])

(sv/defmethod ::mcp-whoami
  "Describes the caller: profile, MCP scopes of the token, the backend
  version and the features it supports."
  {::rpc/token-type "mcp"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::db/transaction true
   ::audit/skip false
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:mcp-whoami}
  [cfg {:keys [::rpc/profile-id ::rpc/token-perms] :as params}]
  (run-tool cfg "mcp-whoami" params
            (fn []
              (let [profile  (check-profile! cfg profile-id)
                    token-id (get-token-id params)]
                [{:profile-id profile-id
                  :fullname (:fullname profile)
                  :email (:email profile)
                  :scopes (vec (sort (mcp-scope/effective-scopes token-perms)))
                  :token-id token-id
                  :expires-at (token-expiry cfg token-id)
                  :version (select-keys cf/version [:full :base])
                  :features (vec (sort cfeat/supported-features))}
                 {:token-id token-id}]))))

;; --- FILE OUTLINE

(def ^:private outline-cache
  (cache/create :expire "10m" :max-size 4096))

(def ^:private sql:count-media
  "SELECT count(*) AS total
     FROM file_media_object
    WHERE file_id = ?
      AND deleted_at IS NULL")

(def ^:private sql:fragment-modified-at
  "SELECT id, modified_at
     FROM file_data
    WHERE file_id = ?
      AND type = 'fragment'")

(defn- fragment-modified-at
  "Map of the fragment ids of the file to their modification time."
  [cfg file-id]
  (into {}
        (map (juxt :id :modified-at))
        (db/exec! cfg [sql:fragment-modified-at file-id])))

(defn- page-summary
  "Name and shape counts of the page `page-id`. Decodes the page."
  [cfg file-id data page-id]
  (let [page    (load-page cfg file-id data page-id)
        objects (:objects page)]
    {:name (:name page)
     :shape-count (max 0 (dec (count objects)))
     :root-child-count (count (get-in objects [uuid/zero :shapes]))}))

(defn- page-summaries
  "Summaries of the pages of `data`, in page order. A page that is a
  pointer map is cached under its pointer id, its modification time and
  the file's `vern`; any other page under its revision."
  [cfg file-id vern revn data]
  (let [modified (fragment-modified-at cfg file-id)]
    (into []
          (map-indexed
           (fn [index page-id]
             (let [page       (get-in data [:pages-index page-id])
                   cache-key  (if (pmap/pointer-map? page)
                                (let [pointer-id (pmap/get-id page)]
                                  [file-id vern pointer-id (get modified pointer-id)])
                                [file-id vern page-id revn])]
               (-> (cache/get outline-cache cache-key
                              (fn [_] (page-summary cfg file-id data page-id)))
                   (assoc :id page-id
                          :index index)))))
          (:pages data))))

(defn- tokens-summary
  [lib status]
  (when (some? lib)
    {:sets (count (ctob/get-sets lib))
     :themes (count (ctob/get-themes-no-hidden lib))
     :tokens (count (ctob/get-all-tokens lib))
     :active-themes (vec (sort (ctos/get-active-theme-ids status)))
     :active-sets (vec (sort (ctos/get-active-set-ids status)))}))

(def ^:private schema:file-outline
  [:map {:title "get-mcp-file-outline" :closed true}
   [:file-id ::sm/uuid]])

(sv/defmethod ::get-mcp-file-outline
  "Summary of a file: pages with their shape counts, libraries, library
  contents counts, tokens summary and the pointer-map flag. Page
  summaries are cached until their page changes."
  {::rpc/token-type "mcp"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::db/transaction true
   ::audit/skip false
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:file-outline}
  [cfg {:keys [::rpc/profile-id file-id] :as params}]
  (run-tool cfg "get-mcp-file-outline" params
            (fn []
              (check-access! cfg profile-id file-id)
              (let [file   (load-file-data cfg file-id [:components :colors :typographies
                                                        :tokens-lib :tokens-status])
                    data   (:data file)
                    revn   (:revn file)
                    lib    (cfo/get-tokens-lib data)
                    status (or (cfo/get-tokens-status data)
                               (ctos/make-tokens-status))
                    pages  (page-summaries cfg file-id (:vern file) revn data)]
                [{:id file-id
                  :name (:name file)
                  :revn revn
                  :vern (:vern file)
                  :version (:version file)
                  :features (vec (sort (:features file)))
                  :project-id (:project-id file)
                  :team-id (:team-id file)
                  :is-shared (:is-shared file)
                  :modified-at (:modified-at file)
                  :pages pages
                  :libraries (mapv #(select-keys % [:id :name])
                                   (bfc/get-file-libraries cfg file-id))
                  :components (count (ctkl/components-seq data))
                  :deleted-components (count (ctkl/deleted-components-seq data))
                  :colors (count (:colors data))
                  :typographies (count (:typographies data))
                  :media (:total (db/exec-one! cfg [sql:count-media file-id]))
                  :tokens (tokens-summary lib status)
                  :pointer-map (contains? (:features file) "fdata/pointer-map")}
                 {:file-id file-id
                  :page-ids (map :id pages)
                  :revn revn
                  :token-id (get-token-id params)}]))))

;; --- PAGE TREE

(def ^:private default-tree-fields
  [:id :name :type :x :y :width :height :parent-id :frame-id :hidden
   :blocked :component-id :main-instance :component-root :shape-ref])

(defn- tree-node
  [shape fields children]
  (cond-> (-> (select-keys (shape-box shape) fields)
              (assoc :id (:id shape)
                     :type (:type shape)
                     :children children
                     :child-count (count (:shapes shape))))
    (= :text (:type shape))
    (assoc :text-layout-state (text-layout-state shape))))

(defn- nest-entries
  "Nests the pre-order `[level shape]` entries into a tree of nodes and
  returns its top node. Each entry after the first one is a descendant
  of the entry before it, so a deeper level belongs to the nearest
  shallower one above it."
  [entries fields]
  (letfn [(build [i]
            (let [[level shape] (nth entries i)]
              (loop [j        (inc i)
                     children []]
                (if (and (< j (count entries))
                         (> (first (nth entries j)) level))
                  (let [[child next-i] (build j)]
                    (recur next-i (conj children child)))
                  [(tree-node shape fields children) j]))))]
    (first (build 0))))

(defn- encode-cursor
  [value]
  (let [^String text (t/encode-str value)]
    (.encodeToString (Base64/getEncoder) (.getBytes text "UTF-8"))))

(defn- parse-cursor
  "The `[page-id revn index root-id depth]` a cursor carries, or nil when
  it is not one."
  [^String cursor]
  (try
    (let [text  (String. (.decode (Base64/getDecoder) cursor) "UTF-8")
          value (t/decode-str text)]
      (when (and (vector? value)
                 (= 5 (count value))
                 (uuid? (nth value 0))
                 (int? (nth value 1))
                 (int? (nth value 2))
                 (not (neg? (nth value 2)))
                 (uuid? (nth value 3))
                 (int? (nth value 4)))
        value))
    (catch Exception _
      nil)))

(defn- cursor->index
  "The entry index a cursor points at; 0 without a cursor. A cursor of
  another page, root or depth, or of another revision of the file is
  refused."
  [cursor page-id revn root-id depth]
  (if (nil? cursor)
    0
    (let [value (parse-cursor cursor)]
      (when (nil? value)
        (ex/raise :type :validation
                  :code :mcp-invalid-cursor
                  :hint "cursor is not valid"))
      (let [[cursor-page-id cursor-revn index cursor-root-id cursor-depth] value]
        (when-not (= cursor-page-id page-id)
          (ex/raise :type :validation
                    :code :mcp-invalid-cursor
                    :hint "cursor belongs to another page"))
        (when-not (and (= cursor-root-id root-id)
                       (= cursor-depth depth))
          (ex/raise :type :validation
                    :code :mcp-invalid-cursor
                    :hint "cursor belongs to another root or depth"))
        (when-not (= cursor-revn revn)
          (ex/raise :type :validation
                    :code :mcp-stale-cursor
                    :hint "the file changed since the cursor was issued, start again without a cursor"))
        index))))

(def ^:private schema:page-tree
  [:map {:title "get-mcp-page-tree" :closed true}
   [:file-id ::sm/uuid]
   [:page-id ::sm/uuid]
   [:root-id {:optional true} ::sm/uuid]
   [:depth {:optional true} [::sm/int {:min 1 :max 20}]]
   [:fields {:optional true} [:vector {:max 64} :keyword]]
   [:limit {:optional true} [::sm/int {:min 1 :max 5000}]]
   [:cursor {:optional true} [:string {:max 4096}]]])

(sv/defmethod ::get-mcp-page-tree
  "Nested tree of a page from `root-id` (the page root by default), down
  to `depth` levels (the root is level 1). Nodes below the last level
  carry only `childCount`. At most `limit` nodes are returned per call;
  `nextCursor` continues the walk. Ancestors of the window are returned
  as well, so the window nests correctly. The children of a flex or grid
  layout come in visual order, which is the reverse of their stored order;
  the children of other shapes keep their stored order. The box of a node
  is the one the plugin API reports."
  {::rpc/token-type "mcp"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::db/transaction true
   ::audit/skip false
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:page-tree}
  [cfg {:keys [::rpc/profile-id file-id page-id root-id depth fields limit cursor] :as params}]
  (run-tool cfg "get-mcp-page-tree" params
            (fn []
              (check-access! cfg profile-id file-id)
              (let [file    (load-file-data cfg file-id [])
                    data    (:data file)
                    revn    (:revn file)
                    objects (:objects (get-page-data cfg file-id revn data page-id))
                    root-id (or root-id uuid/zero)
                    depth   (or depth 3)
                    fields  (if (seq fields) (vec fields) default-tree-fields)
                    limit   (or limit 500)
                    start   (cursor->index cursor page-id revn root-id depth)]
                (when-not (contains? objects root-id)
                  (ex/raise :type :not-found
                            :code :shape-not-found
                            :hint "root shape not found in page"))
                (let [flat (page-preorder objects root-id depth true)
                      total (count flat)]
                  (when (>= start total)
                    (ex/raise :type :validation
                              :code :mcp-invalid-cursor
                              :hint "cursor is past the end of the page"))
                  (let [end        (min total (+ start limit))
                        indexes    (concat (ancestor-indexes flat start)
                                           (range start end))
                        entries    (mapv (fn [i]
                                           (let [[level id] (nth flat i)]
                                             [level (get objects id)]))
                                         indexes)
                        truncated? (< end total)]
                    [(cond-> {:revn revn
                              :page-id page-id
                              :root (nest-entries entries fields)
                              :truncated truncated?}
                       truncated?
                       (assoc :next-cursor (encode-cursor [page-id revn end
                                                           root-id depth])))
                     {:file-id file-id
                      :page-ids [page-id]
                      :revn revn
                      :token-id (get-token-id params)}]))))))

;; --- SHAPES

(defn- shape-out
  "The map of `shape` that `get-mcp-shapes` returns: the box the plugin
  API reports, the defaults Penpot assumes, no thumbnail, narrowed to
  `fields` when given."
  [objects shape fields]
  (let [base (as-> (dissoc shape :thumbnail) $
               (shape-box $)
               (with-defaults objects $))
        out  (if (seq fields)
               (select-keys base (into [:id :type] fields))
               base)]
    (if (= :text (:type base))
      (cond-> (assoc out
                     :text-layout-state (text-layout-state base)
                     :characters (shape-characters base))
        (text-size-approximate? base)
        (assoc :text-size-approximate true))
      out)))

(def ^:private schema:shapes
  [:map {:title "get-mcp-shapes" :closed true}
   [:file-id ::sm/uuid]
   [:page-id ::sm/uuid]
   [:ids [:vector {:min 1 :max 200} ::sm/uuid]]
   [:fields {:optional true} [:vector {:max 64} :keyword]]
   [:include-children {:optional true} :boolean]])

(def ^:private shapes-cap
  "Most shapes one call returns, descendants included."
  2000)

(sv/defmethod ::get-mcp-shapes
  "Shapes of a page by id. Shape maps are the full shapes, minus the
  thumbnail, unless `fields` narrows them. The box is the one the
  plugin API reports, and absent `hidden`, `blocked`, `opacity`, stroke
  alignment and layout sizing carry Penpot's defaults. Text shapes carry
  `characters` and `textLayoutState`, and `textSizeApproximate` when
  their box is an estimate. `include-children` adds the
  descendants of the requested shapes, up to 2000 shapes in all; the
  page root cannot be requested with its children."
  {::rpc/token-type "mcp"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::db/transaction true
   ::audit/skip false
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:shapes}
  [cfg {:keys [::rpc/profile-id file-id page-id ids fields include-children] :as params}]
  (run-tool cfg "get-mcp-shapes" params
            (fn []
              (check-access! cfg profile-id file-id)
              (when (and include-children (contains? (set ids) uuid/zero))
                (ex/raise :type :validation
                          :code :mcp-root-children-not-allowed
                          :hint "the page root cannot be requested with its children"))
              (let [file    (load-file-data cfg file-id [])
                    data    (:data file)
                    revn    (:revn file)
                    objects (:objects (get-page-data cfg file-id revn data page-id))
                    ids     (distinct ids)
                    found   (filterv #(contains? objects %) ids)
                    missing (filterv #(not (contains? objects %)) ids)
                    chosen  (if include-children
                              (distinct (mapcat #(cfh/get-children-ids-with-self objects %) found))
                              found)
                    shown   (into [] (take (inc shapes-cap)) chosen)]
                [{:revn revn
                  :shapes (mapv #(shape-out objects (get objects %) fields)
                                (take shapes-cap shown))
                  :missing missing
                  :truncated (> (count shown) shapes-cap)}
                 {:file-id file-id
                  :page-ids [page-id]
                  :revn revn
                  :token-id (get-token-id params)}]))))

;; --- SEARCH

(def ^:private search-budget-ns
  "Time a search may spend across pages: five seconds."
  5000000000)

(defn- compile-regex
  [pattern]
  (when (some? pattern)
    (try
      (re-pattern pattern)
      (catch java.util.regex.PatternSyntaxException _
        (ex/raise :type :validation
                  :code :mcp-invalid-regex
                  :hint "name-regex is not a valid regular expression")))))

(defn- paint-colors
  [data paints color-key ref-key]
  (keep (fn [paint]
          (some-> (or (get paint color-key)
                      (get-in data [:colors (get paint ref-key) :color]))
                  str/lower-case))
        paints))

(defn- shape-colors
  "Lowercased colors of the fills and strokes of `shape`, including the
  colors of its local library references."
  [data shape]
  (into #{}
        (concat (paint-colors data (:fills shape) :fill-color :fill-color-ref-id)
                (paint-colors data (:strokes shape) :stroke-color :stroke-color-ref-id))))

(defn- deadline-chars
  "A `CharSequence` over `text` whose `charAt` throws once `deadline`
  (nanoTime) has passed, so a regex run over it cannot outlive the
  search budget."
  [^String text deadline]
  (reify CharSequence
    (length [_]
      (.length text))
    (charAt [_ i]
      (when (> (System/nanoTime) deadline)
        (throw (ex-info "search deadline passed" {::deadline true})))
      (.charAt text i))
    (subSequence [_ start end]
      (deadline-chars (subs text start end) deadline))
    (toString [_]
      text)))

(defn- regex-timeout?
  [cause]
  (boolean (::deadline (ex-data cause))))

(defn- match-predicate
  [data deadline {:keys [type name-regex name component-id has-token text-contains colors]}]
  (let [regex  (compile-regex name-regex)
        wanted (when (seq colors)
                 (into #{} (map str/lower-case) colors))
        needle (some-> text-contains str/lower-case)]
    (fn [shape]
      (and (or (nil? type) (= type (:type shape)))
           (or (nil? name) (= name (:name shape)))
           (or (nil? regex)
               (re-find (re-matcher regex (deadline-chars (str (:name shape)) deadline))))
           (or (nil? component-id) (= component-id (:component-id shape)))
           (or (nil? has-token)
               (= has-token (boolean (seq (:applied-tokens shape)))))
           (or (nil? needle)
               (and (= :text (:type shape))
                    (str/includes? (str/lower-case (shape-characters shape))
                                   needle)))
           (or (nil? wanted)
               (boolean (some wanted (shape-colors data shape))))))))

(def ^:private max-ancestor-steps
  "Most ancestors `shape-path` walks up; a deeper path stops here."
  1000)

(defn- shape-path
  "Names of the shape's ancestors, top down, and its own name, joined
  with \" / \". The page root is not part of the path."
  [objects shape]
  (loop [parent-id (:parent-id shape)
         names     ()
         steps     0]
    (let [parent (when (and (not= parent-id uuid/zero)
                            (< steps max-ancestor-steps))
                   (get objects parent-id))]
      (if (nil? parent)
        (str/join " / " (concat names [(:name shape)]))
        (recur (:parent-id parent) (cons (:name parent) names) (inc steps))))))

(defn- hit?
  "Whether `pred?` holds for `shape`, or `:timeout` when the name regex
  ran past the search deadline."
  [pred? shape]
  (try
    (boolean (pred? shape))
    (catch clojure.lang.ExceptionInfo cause
      (if (regex-timeout? cause)
        :timeout
        (throw cause)))))

(defn- search-objects
  "Matches of `pred?` in the tree of `start-id` on one page, in tree
  order, up to `cap` of them and until `deadline` (nanoTime)."
  [objects page-id start-id pred? cap deadline]
  (let [entries (page-preorder objects start-id Long/MAX_VALUE false)]
    (loop [i   0
           out []]
      (cond
        (>= i (count entries))
        {:matches out :timed-out? false}

        (>= (count out) cap)
        {:matches out :timed-out? false}

        (> (System/nanoTime) deadline)
        {:matches out :timed-out? true}

        :else
        (let [[_ id] (nth entries i)
              shape  (get objects id)
              hit    (if (= id start-id)
                       false
                       (hit? pred? shape))]
          (if (= :timeout hit)
            {:matches out :timed-out? true}
            (recur (inc i)
                   (if hit
                     (conj out {:id id
                                :page-id page-id
                                :name (:name shape)
                                :type (:type shape)
                                :path (shape-path objects shape)})
                     out))))))))

(defn- search-pages
  "Matches in the pages `page-ids` of the file at `revn`, in page order,
  up to `cap` of them."
  [cfg file-id revn data page-ids start-id pred? cap deadline]
  (loop [page-ids page-ids
         matches  []]
    (cond
      (empty? page-ids)
      {:matches matches :timed-out? false}

      (>= (count matches) cap)
      {:matches matches :timed-out? false}

      (> (System/nanoTime) deadline)
      {:matches matches :timed-out? true}

      :else
      (let [page-id (first page-ids)
            objects (:objects (get-page-data cfg file-id revn data page-id))
            result  (search-objects objects page-id (or start-id uuid/zero)
                                    pred? (- cap (count matches)) deadline)
            matches (into matches (:matches result))]
        (if (:timed-out? result)
          {:matches matches :timed-out? true}
          (recur (rest page-ids) matches))))))

(def ^:private schema:find-shapes
  [:map {:title "find-mcp-shapes" :closed true}
   [:file-id ::sm/uuid]
   [:page-id {:optional true} ::sm/uuid]
   [:type {:optional true} :keyword]
   [:name-regex {:optional true} [:string {:max 200}]]
   [:name {:optional true} [:string {:max 500}]]
   [:component-id {:optional true} ::sm/uuid]
   [:has-token {:optional true} :boolean]
   [:text-contains {:optional true} [:string {:max 500}]]
   [:within-id {:optional true} ::sm/uuid]
   [:colors {:optional true} [:vector {:max 50} [:string {:max 32}]]]
   [:limit {:optional true} [::sm/int {:min 1 :max 1000}]]])

(sv/defmethod ::find-mcp-shapes
  "Shapes matching every given filter, on one page or on all pages
  (five seconds at most). `name` is an exact, case-sensitive match on the
  shape name. `name-regex` is a Java regular expression searched in the
  shape name (`re-find`), so a partial pattern matches. `colors` matches
  fill and stroke colors and the colors of local library references.
  `text-contains` matches the characters of text shapes, ignoring case.
  `has-token` matches shapes with at least one applied token, or none
  when false."
  {::rpc/token-type "mcp"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::db/transaction true
   ::audit/skip false
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:find-shapes}
  [cfg {:keys [::rpc/profile-id file-id page-id within-id limit] :as params}]
  (run-tool cfg "find-mcp-shapes" params
            (fn []
              (check-access! cfg profile-id file-id)
              (let [file     (load-file-data cfg file-id [])
                    data     (:data file)
                    revn     (:revn file)
                    limit    (or limit 100)
                    pages    (if (some? page-id) [page-id] (:pages data))
                    deadline (+ (System/nanoTime) search-budget-ns)
                    result   (search-pages cfg file-id revn data pages within-id
                                           (match-predicate data deadline params)
                                           (inc limit) deadline)
                    matches  (:matches result)]
                [{:matches (vec (take limit matches))
                  :truncated (or (:timed-out? result) (> (count matches) limit))}
                 {:file-id file-id
                  :page-ids (distinct (map :page-id matches))
                  :revn (:revn file)
                  :token-id (get-token-id params)}]))))

;; --- LIBRARY

(def ^:private default-library-kinds
  #{"components" "colors" "typographies" "media"})

(def ^:private sql:library-media
  "SELECT id, name, width, height, mtype
     FROM file_media_object
    WHERE file_id = ?
      AND deleted_at IS NULL
    ORDER BY name, id
    LIMIT ?")

(defn- component-out
  [component]
  (-> (select-keys component [:id :name :path :main-instance-id
                              :main-instance-page :variant-id
                              :variant-properties])
      (assoc :deleted (boolean (:deleted component)))))

(defn- library-components
  [data include-deleted? limit]
  (let [live (map #(assoc % :deleted false) (ctkl/components-seq data))
        dead (when include-deleted?
               (map #(assoc % :deleted true) (ctkl/deleted-components-seq data)))]
    (->> (concat live dead)
         (sort-by (juxt :path :name))
         (take limit)
         (mapv component-out))))

(def ^:private schema:library
  [:map {:title "get-mcp-library" :closed true}
   [:file-id ::sm/uuid]
   [:kinds {:optional true}
    [:vector {:max 4} [:enum "components" "colors" "typographies" "media"]]]
   [:include-deleted {:optional true} :boolean]
   [:limit {:optional true} [::sm/int {:min 1 :max 5000}]]])

(sv/defmethod ::get-mcp-library
  "Library contents of a file: components (with `deleted` flag when
  `include-deleted` is set), colors, typographies and media objects.
  `kinds` picks the sections to return; the others come back empty."
  {::rpc/token-type "mcp"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::db/transaction true
   ::audit/skip false
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:library}
  [cfg {:keys [::rpc/profile-id file-id kinds include-deleted limit] :as params}]
  (run-tool cfg "get-mcp-library" params
            (fn []
              (check-access! cfg profile-id file-id)
              (let [file  (load-file-data cfg file-id [:components :colors :typographies])
                    data  (:data file)
                    kinds (if (seq kinds) (set kinds) default-library-kinds)
                    limit (or limit 500)
                    take-kind (fn [kind f]
                                (if (contains? kinds kind) (f) []))]
                [{:components (take-kind "components"
                                         #(library-components data include-deleted limit))
                  :colors (take-kind "colors"
                                     #(->> (vals (:colors data))
                                           (sort-by :name)
                                           (take limit)
                                           (vec)))
                  :typographies (take-kind "typographies"
                                           #(->> (vals (:typographies data))
                                                 (sort-by :name)
                                                 (take limit)
                                                 (vec)))
                  :media (take-kind "media"
                                    #(mapv (fn [row]
                                             (select-keys row [:id :name :width :height :mtype]))
                                           (db/exec! cfg [sql:library-media file-id limit])))}
                 {:file-id file-id
                  :page-ids []
                  :revn (:revn file)
                  :token-id (get-token-id params)}]))))

;; --- TOKENS

(def ^:private schema:tokens
  [:map {:title "get-mcp-tokens" :closed true}
   [:file-id ::sm/uuid]
   [:resolve {:optional true} :boolean]])

(sv/defmethod ::get-mcp-tokens
  "Token sets, themes and tokens of a file, with their active state and
  the DTCG export. `resolve` is accepted and ignored: resolution is done
  by the adapter."
  {::rpc/token-type "mcp"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::db/transaction true
   ::audit/skip false
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:tokens}
  [cfg {:keys [::rpc/profile-id file-id] :as params}]
  (run-tool cfg "get-mcp-tokens" params
            (fn []
              (check-access! cfg profile-id file-id)
              (let [file   (load-file-data cfg file-id [:tokens-lib :tokens-status])
                    data   (:data file)
                    lib    (cfo/get-tokens-lib data)
                    status (or (cfo/get-tokens-status data)
                               (ctos/make-tokens-status))
                    sets   (if (some? lib) (vec (ctob/get-sets lib)) [])
                    themes (if (some? lib) (vec (ctob/get-themes-no-hidden lib)) [])]
                [{:sets (mapv (fn [token-set]
                                (let [set-id (ctob/get-id token-set)]
                                  {:id set-id
                                   :name (ctob/get-name token-set)
                                   :active (ctos/set-active? status set-id)
                                   :token-count (count (ctob/get-tokens lib set-id))}))
                              sets)
                  :themes (mapv (fn [theme]
                                  {:id (:id theme)
                                   :group (:group theme)
                                   :name (:name theme)
                                   :sets (vec (:sets theme))
                                   :active (ctos/theme-active? status (:id theme))})
                                themes)
                  :tokens (vec (for [token-set sets
                                     [_ token] (ctob/get-tokens lib (ctob/get-id token-set))]
                                 {:set-id (ctob/get-id token-set)
                                  :id (:id token)
                                  :name (:name token)
                                  :type (:type token)
                                  :value (:value token)
                                  :description (:description token)}))
                  :active-themes (vec (sort (ctos/get-active-theme-ids status)))
                  :active-sets (vec (sort (ctos/get-active-set-ids status)))
                  :dtcg (when (some? lib)
                          (ctob/export-dtcg-json lib status))}
                 {:file-id file-id
                  :page-ids []
                  :revn (:revn file)
                  :token-id (get-token-id params)}]))))

;; --- RENDER SESSION

(def ^:private schema:render-session
  [:map {:title "create-mcp-render-session" :closed true}
   [:file-id ::sm/uuid]])

(sv/defmethod ::create-mcp-render-session
  "Mints a session for the caller that the exporter accepts as the
  `auth-token` cookie. The session expires after ten minutes. The file
  must be readable by the caller."
  {::rpc/token-type "mcp"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::db/transaction true
   ::audit/skip false
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:render-session}
  [cfg {:keys [::rpc/profile-id file-id] :as params}]
  (run-tool cfg "create-mcp-render-session" params
            (fn []
              (check-access! cfg profile-id file-id)
              (let [file-ids   (into #{file-id}
                                     (map :id)
                                     (bfc/get-file-libraries cfg file-id))
                    session    (session/create-session
                                (::session/manager cfg)
                                {:profile-id profile-id
                                 :user-agent "penpot-mcp-exporter"
                                 :props {:mcp-render {:file-ids file-ids}}})
                    expires-at (ct/plus (ct/now) session/mcp-render-max-age)
                    claims     {:iss "authentication"
                                :aud "penpot"
                                :sid (:id session)
                                :iat (:modified-at session)
                                :uid profile-id
                                :exp expires-at
                                :mcp-render true}
                    token      (tokens/generate cfg claims {:kid 1 :ver 1})]
                [{:token token
                  :expires-at expires-at}
                 {:file-id file-id
                  :page-ids []
                  :token-id (get-token-id params)}]))))
