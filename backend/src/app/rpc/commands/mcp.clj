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
   [app.common.json :as json]
   [app.common.logging :as l]
   [app.common.mcp.operations :as operations]
   [app.common.schema :as sm]
   [app.common.time :as ct]
   [app.common.transit :as t]
   [app.common.types.components-list :as ctkl]
   [app.common.types.shape :as cts]
   [app.common.types.shape.layout :as ctl]
   [app.common.types.text :as txt]
   [app.common.types.tokens-lib :as ctob]
   [app.common.types.tokens-status :as ctos]
   [app.common.types.variant :as ctv]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.db.sql :as-alias sql]
   [app.features.fdata :as feat.fdata]
   [app.http.access-token :as-alias actoken]
   [app.http.session :as session]
   [app.loggers.audit :as-alias audit]
   [app.metrics :as mtx]
   [app.rpc :as-alias rpc]
   [app.rpc.climit :as-alias climit]
   [app.rpc.commands.files :as files]
   [app.rpc.commands.mcp-limits :as limits]
   [app.rpc.commands.profile :as profile]
   [app.rpc.doc :as-alias doc]
   [app.rpc.helpers :as rph]
   [app.rpc.mcp-fonts :as mcp-fonts]
   [app.rpc.mcp-scope :as mcp-scope]
   [app.tokens :as tokens]
   [app.util.cache :as cache]
   [app.util.pointer-map :as pmap]
   [app.util.services :as sv]
   [clojure.string :as str])
  (:import
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
        request-id (::rpc/request-id params)
        token-fp   (mcp-scope/token-fingerprint (get-token-id params))]
    (try
      (let [[result props] (f)
            duration       (elapsed-ms started)]
        ;; Inside a transaction the timing and the log line wait for the
        ;; commit: a call that rolls back must not count as ok.
        (db/after-commit
         (fn []
           (record-tool-timing cfg tool "ok" duration)
           (l/inf :hint "mcp-tool"
                  :tool tool
                  :request-id request-id
                  :profile-id profile-id
                  :file-id file-id
                  :token-fp token-fp
                  :duration-ms duration
                  :outcome "ok")))
        (rph/with-meta result
          {::audit/replace-props (audit-props tool
                                              (assoc props :request-id request-id)
                                              duration)}))
      (catch Throwable cause
        (let [code     (error-code cause)
              duration (elapsed-ms started)]
          (record-tool-timing cfg tool "error" duration)
          (record-error cfg tool code)
          (l/inf :hint "mcp-tool"
                 :tool tool
                 :request-id request-id
                 :profile-id profile-id
                 :file-id file-id
                 :token-fp token-fp
                 :duration-ms duration
                 :outcome "error"
                 :code code)
          (throw cause))))))

;; --- AUTH

(defn- request-profile
  "The profile state that the access-token lookup read for this request, or
  nil when the request carries none (unit tests)."
  [params]
  (let [request (-> params meta :app.http/request)]
    (when (map? request)
      (get request ::actoken/profile))))

(defn- check-profile-state!
  "The checks of `check-profile!` on a profile map. Returns it.
  The `:mcp-disabled` check runs here only when the request carries no
  profile (unit tests): `wrap-authentication` in `rpc.clj` refuses a
  disabled profile before the command runs."
  [profile]
  (when (:is-blocked profile)
    (ex/raise :type :authorization
              :code :profile-blocked
              :hint "profile is marked as blocked"))
  (when-not (:is-active profile)
    (ex/raise :type :authorization
              :code :profile-not-active
              :hint "profile is not active"))
  (when (false? (get-in profile [:props :mcp-enabled]))
    (ex/raise :type :restriction
              :code :mcp-disabled
              :hint "MCP is disabled for this profile"))
  profile)

(defn check-profile!
  "Rejects blocked and inactive profiles, as `send-mcp-feedback` does, and
  profiles that switched MCP off in settings. The switch is a profile
  prop; the tokens keep existing, so the check happens on every call.

  The profile comes from the request, where the token lookup read it with
  the token. The row is read only when the request carries none. Returns
  the profile."
  ([cfg profile-id]
   (check-profile! cfg profile-id nil))
  ([cfg profile-id params]
   (check-profile-state! (or (request-profile params)
                             (profile/get-profile cfg profile-id)))))

(defn check-access!
  [cfg params profile-id file-id]
  (check-profile! cfg profile-id params)
  (files/check-read-permissions! cfg profile-id file-id))

;; --- FILE DATA

(defonce ^:private root-cache
  (cache/create :expire "10m" :max-size 256))

(defn- pointer-root?
  "Whether every page of the decoded file `file` is a pointer map. Such a
  root stays small: the pages are read from the database when used."
  [file]
  (let [pages (vals (get-in file [:data :pages-index]))]
    (and (seq pages)
         (every? pmap/pointer-map? pages))))

(defn- get-file-root
  "The file `file-id` as `bfc/get-file` reads it. A pointer-map file is
  kept in `root-cache` under its revn and vern for ten minutes, so the
  next page read does not decode the root again. Call it only after the
  permission check."
  [cfg file-id]
  (let [mfile (db/get cfg :file {:id file-id}
                      {::sql/columns [:id :revn :vern :version]})
        hit   (when (some? mfile)
                (cache/get root-cache [file-id (:revn mfile) (:vern mfile)]))]
    (or hit
        ;; `bfc/get-file` migrates and persists the file when it is behind
        ;; the current version and also when a named migration is missing,
        ;; which keeps the version. Its writes must be atomic, so every miss
        ;; runs in one transaction: the version alone does not say whether
        ;; the read will write.
        (let [file (db/tx-run! cfg (fn [cfg] (bfc/get-file cfg file-id)))]
          (when (pointer-root? file)
            (cache/put root-cache [file-id (:revn file) (:vern file)] file))
          file))))

(defn- load-pointer-data
  "The data behind pointer map `ptr`, read from the database by its id.
  `ptr` itself is not derefed: a deref would keep the data inside the
  pointer, and a pointer of the cached root must stay unloaded. Other
  values come back as they are."
  [cfg file-id ptr]
  (if (pmap/pointer-map? ptr)
    (or (feat.fdata/load-pointer cfg file-id (pmap/get-id ptr)) {})
    ptr))

(defn load-file-data
  "The file read from the database. The pages stay pointer
  maps and `get-page-data` loads one at a time. The pointer maps of the
  file-level collections named in `ks` are loaded too. A file that needs
  migration is migrated and persisted here, once."
  [cfg file-id ks]
  (let [file (get-file-root cfg file-id)]
    (binding [pmap/*load-fn* (partial feat.fdata/load-pointer cfg file-id)]
      (update file :data
              (fn [data]
                (reduce (fn [data k]
                          (let [v (get data k)]
                            (cond-> data
                              (pmap/pointer-map? v) (assoc k (load-pointer-data cfg file-id v)))))
                        data
                        ks))))))

(defn load-file-for-page
  "`load-file-data` for a read of `page-id`. A cached root that lacks the
  page is stale: a root of another file or revision answered for this key.
  The entry is dropped and the file is read again, so the page is found
  whenever it is stored. A nil `page-id` skips the check."
  [cfg file-id page-id ks]
  (let [file (load-file-data cfg file-id ks)]
    (if (or (nil? page-id)
            (contains? (get-in file [:data :pages-index]) page-id))
      file
      (do
        (cache/invalidate root-cache [file-id (:revn file) (:vern file)])
        (load-file-data cfg file-id ks)))))

(def ^:private page-cache-shape-budget
  "Shapes that all cached pages may hold together: about 200,000. The
  weight of a page is its shape count, so the bound follows the memory a
  decoded page takes, not the number of pages."
  200000)

(defn- page-weight
  "Weight of a cached page: its shape count, and at least one."
  [page]
  (max 1 (count (:objects page))))

(defonce ^:private page-cache
  (cache/create :keepalive "10m"
                :weigher page-weight
                :max-weight page-cache-shape-budget))

(defn- load-page
  "The page `page-id` of a file `data`, with its pointer map loaded from
  the database. Decodes the page. Callers reach it through
  `get-page-data`, which keeps the result in `page-cache`."
  [cfg file-id data page-id]
  (let [page (get-in data [:pages-index page-id])]
    (binding [pmap/*load-fn* (partial feat.fdata/load-pointer cfg file-id)]
      (load-pointer-data cfg file-id page))))

(defn- page-cache-key
  "Key of a page in `page-cache`. A pointer map is keyed by its persisted
  pointer id, which names fixed content, so the entry survives writes to
  other pages of the file. A plain page has no such id and is keyed by
  its revision."
  [file-id page-id revn page]
  (if (pmap/pointer-map? page)
    [:pointer (pmap/get-id page)]
    [file-id page-id revn]))

(defn get-page-data
  "The page `page-id` of a file `data` at revision `revn`, from
  `page-cache` when its key is cached."
  [cfg file-id revn data page-id]
  (let [page (get-in data [:pages-index page-id])]
    (when (nil? page)
      (ex/raise :type :not-found
                :code :page-not-found
                :hint "page not found"))
    (cache/get page-cache (page-cache-key file-id page-id revn page)
               (fn [_] (load-page cfg file-id data page-id)))))

(defn page-version
  "The version a page-tree cursor binds to: the pointer id of a pointer
  map page, else the file revn. A write to another page leaves a pointer
  id alone."
  [data page-id revn]
  (let [page (get-in data [:pages-index page-id])]
    (if (pmap/pointer-map? page)
      (pmap/get-id page)
      revn)))

(defn- text-layout-state
  [shape]
  (if (some? (:position-data shape)) "exact" "approximate"))

(defn shape-characters
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

(defn shape-box
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

(defn with-defaults
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

(defn shape-children
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

(defn page-preorder
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

(def ^:private preorder-cache-budget
  "Entries that all cached page walks may hold together: 400,000."
  400000)

(defn- preorder-weight
  "Weight of a cached walk: its entry count, and at least one."
  [flat]
  (max 1 (count flat)))

(defonce ^:private preorder-cache
  (cache/create :keepalive "10m"
                :weigher preorder-weight
                :max-weight preorder-cache-budget))

(defn- get-cached-preorder
  "`page-preorder` in visual order of the subtree at `root-id` down to
  `depth` levels, from `preorder-cache` when it is held. `version` (see
  `page-version`) is part of the key, so a changed page walks again, and
  the windows of one tree read after the first cost no second walk."
  [file-id page-id version objects root-id depth]
  (cache/get preorder-cache
             [file-id page-id version root-id depth]
             (fn [_] (page-preorder objects root-id depth true))))

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

(def mcp-contract-version
  "Version of the contract between the MCP adapter and this backend. Bump
  it when a reply or a command changes shape in a way the adapter must
  notice. The adapter reads it from `mcp-whoami` before it serves tools."
  1)

(defn- token-expiry
  "When the token that made the call expires, from the request that the
  access-token middleware read. Nil when the token does not expire."
  [params]
  (let [request (-> params meta :app.http/request)]
    (when (map? request)
      (get request ::actoken/expires-at))))

(defn- mcp-write-limits
  "The write limits the write path enforces, read from `mcp-limits`."
  []
  {:max-operations       limits/max-operations
   :max-payload-bytes    limits/max-payload-bytes
   :max-compiled-changes (limits/max-compiled-changes)})

(def ^:private schema:mcp-whoami
  [:map {:title "mcp-whoami" :closed true}])

(sv/defmethod ::mcp-whoami
  "Describes the caller: profile, MCP scopes of the token, the backend
  version, the features it supports, the contract version, the operation
  names the compiler accepts and the write limits."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:mcp-whoami}
  [cfg {:keys [::rpc/profile-id ::rpc/token-perms] :as params}]
  (run-tool cfg "mcp-whoami" params
            (fn []
              (let [profile  (check-profile! cfg profile-id params)
                    token-id (get-token-id params)]
                [{:profile-id profile-id
                  :fullname (:fullname profile)
                  :email (:email profile)
                  :scopes (vec (sort (mcp-scope/effective-scopes token-perms)))
                  :token-id token-id
                  :expires-at (token-expiry params)
                  :version (select-keys cf/version [:full :base])
                  :features (vec (sort cfeat/supported-features))
                  :contract-version mcp-contract-version
                  :operations operations/operation-names
                  :limits (mcp-write-limits)}
                 {:token-id token-id}]))))

;; --- FILE OUTLINE

(defonce ^:private outline-cache
  (cache/create :expire "10m" :max-size 4096))

(def ^:private sql:count-media
  "SELECT count(*) AS total
     FROM file_media_object
    WHERE file_id = ?
      AND deleted_at IS NULL")

(defn- page-summary
  "Name and shape counts of the page `page-id`. Reads the page through
  `get-page-data`, so a page that `page-cache` holds is not decoded again."
  [cfg file-id revn data page-id]
  (let [page    (get-page-data cfg file-id revn data page-id)
        objects (:objects page)]
    {:name (:name page)
     :shape-count (max 0 (dec (count objects)))
     :root-child-count (count (get-in objects [uuid/zero :shapes]))}))

(defn- page-summaries
  "Summaries of the pages of `data`, in page order. A pointer-map page is
  cached under its pointer id, which names fixed content, so no other
  key is needed. A plain page is cached under its file, `vern` and
  revision."
  [cfg file-id vern revn data]
  (into []
        (map-indexed
         (fn [index page-id]
           (let [page      (get-in data [:pages-index page-id])
                 cache-key (if (pmap/pointer-map? page)
                             [:pointer (pmap/get-id page)]
                             [file-id vern page-id revn])]
             (-> (cache/get outline-cache cache-key
                            (fn [_] (page-summary cfg file-id revn data page-id)))
                 (assoc :id page-id
                        :index index)))))
        (:pages data)))

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
  summaries are cached until their page changes.

  `warnings` lists the fonts that do not resolve, per page (at most 50;
  `warnings-truncated` says when more exist). The warnings cover the pages
  that the call could read within one second, and a page above 5,000 shapes
  only when `get-mcp-fonts` has read it before. `warnings-complete` false means
  that some pages are not covered, so the warnings may be short.
  `warnings-pending-pages` names them (`page-id`, `shape-count` and `reason`,
  `page-too-large` or `time`; at most 50, with `warnings-pending-truncated`),
  and `warnings-complete-with` is then `list_fonts`, the adapter tool for
  `get-mcp-fonts`. A `get-mcp-fonts` reply that is not `truncated` is the
  complete font report of the file, so a client that needs the full picture
  reads it there. The outline warnings are a fast first look. Its reads fill a
  cache in one backend process, so the next outline reports `warnings-complete`
  true only when the same process serves it; with several backend processes it
  may stay false. A warning carries `suggested-font-id` and `suggested-family` when a font that resolves
  has the same family."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:file-outline}
  [cfg {:keys [::rpc/profile-id file-id] :as params}]
  (run-tool cfg "get-mcp-file-outline" params
            (fn []
              (check-access! cfg params profile-id file-id)
              (let [file   (load-file-data cfg file-id [:components :colors :typographies
                                                        :tokens-lib :tokens-status])
                    data   (:data file)
                    revn   (:revn file)
                    lib    (cfo/get-tokens-lib data)
                    status (or (cfo/get-tokens-status data)
                               (ctos/make-tokens-status))
                    pages  (page-summaries cfg file-id (:vern file) revn data)
                    ctx    (mcp-fonts/get-font-context cfg (:team-id file))
                    scan   (mcp-fonts/get-pages-usage
                            {:pages (mapv (fn [{page-id :id shape-count :shape-count}]
                                            {:id page-id
                                             :shape-count shape-count
                                             :key (mcp-fonts/get-page-key file-id (:vern file) revn data page-id)})
                                          pages)
                             :load-objects (fn [page-id]
                                             (:objects (get-page-data cfg file-id revn data page-id)))
                             :budget-ns mcp-fonts/outline-budget-ns
                             :max-shapes mcp-fonts/outline-max-shapes})
                    warnings (mcp-fonts/get-outline-warnings ctx (:page-usages scan))]
                [(cond-> {:id file-id
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
                          :warnings (vec (take 50 warnings))
                          :warnings-truncated (> (count warnings) 50)
                          :warnings-complete (empty? (:pending scan))
                          :warnings-pending-pages (vec (take 50 (:pending scan)))
                          :warnings-pending-truncated (> (count (:pending scan)) 50)
                          :libraries (mapv #(select-keys % [:id :name])
                                           (bfc/get-file-libraries cfg file-id))
                          :components (count (ctkl/components-seq data))
                          :deleted-components (count (ctkl/deleted-components-seq data))
                          :colors (count (:colors data))
                          :typographies (count (:typographies data))
                          :media (:total (db/exec-one! cfg [sql:count-media file-id]))
                          :tokens (tokens-summary lib status)
                          :pointer-map (contains? (:features file) "fdata/pointer-map")}
                   (seq (:pending scan)) (assoc :warnings-complete-with "list_fonts"))
                 {:file-id file-id
                  :page-ids (map :id pages)
                  :revn revn
                  :token-id (get-token-id params)}]))))

;; --- PAGE TREE

(def ^:private default-tree-fields
  [:id :name :type :x :y :width :height :parent-id :frame-id :hidden
   :blocked :component-id :main-instance :component-root :shape-ref])

(defn pick-named
  "The attributes `fields` of `shape`, each one present. An attribute the
  shape lacks comes back as nil, so a caller that names a field always
  gets a key for it. Defaults are filled before this runs."
  [shape fields]
  (into {} (map (fn [k] [k (get shape k)])) fields))

(defn- tree-node
  "One node of a page tree. `pick` turns the shape into the node's
  attributes; `children` are the nested nodes."
  [shape pick children]
  (cond-> (-> (pick shape)
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
  [entries pick]
  (letfn [(build [i]
            (let [[level shape] (nth entries i)]
              (loop [j        (inc i)
                     children []]
                (if (and (< j (count entries))
                         (> (first (nth entries j)) level))
                  (let [[child next-i] (build j)]
                    (recur next-i (conj children child)))
                  [(tree-node shape pick children) j]))))]
    (first (build 0))))

(defn encode-cursor
  [value]
  (let [^String text (t/encode-str value)]
    (.encodeToString (Base64/getEncoder) (.getBytes text "UTF-8"))))

(defn parse-cursor
  "The `[page-id version index root-id depth]` a cursor carries, or nil
  when it is not one. `version` is a pointer id (uuid) or a revn (int)."
  [^String cursor]
  (try
    (let [text  (String. (.decode (Base64/getDecoder) cursor) "UTF-8")
          value (t/decode-str text)]
      (when (and (vector? value)
                 (= 5 (count value))
                 (uuid? (nth value 0))
                 (or (uuid? (nth value 1))
                     (int? (nth value 1)))
                 (int? (nth value 2))
                 (not (neg? (nth value 2)))
                 (uuid? (nth value 3))
                 (int? (nth value 4)))
        value))
    (catch Exception _
      nil)))

(defn- cursor->index
  "The entry index a cursor points at; 0 without a cursor. A cursor of
  another page, root or depth is refused. A cursor whose `version` is not
  the page's current version (see `page-version`) is stale."
  [cursor page-id version root-id depth]
  (if (nil? cursor)
    0
    (let [value (parse-cursor cursor)]
      (when (nil? value)
        (ex/raise :type :validation
                  :code :mcp-invalid-cursor
                  :hint "cursor is not valid"))
      (let [[cursor-page-id cursor-version index cursor-root-id cursor-depth] value]
        (when-not (= cursor-page-id page-id)
          (ex/raise :type :validation
                    :code :mcp-invalid-cursor
                    :hint "cursor belongs to another page"))
        (when-not (and (= cursor-root-id root-id)
                       (= cursor-depth depth))
          (ex/raise :type :validation
                    :code :mcp-invalid-cursor
                    :hint "cursor belongs to another root or depth"))
        (when-not (= cursor-version version)
          (ex/raise :type :validation
                    :code :mcp-stale-cursor
                    :hint "the page changed since the cursor was issued, start again without a cursor"))
        index))))

(defn- schema-attr-keys
  "The attribute keys of a malli form, read from its map entries. `:map`
  lists its keys, `:merge` reads each part, `:multi` reads each branch.
  The nested value of an entry is not an attribute of the shape, so it
  is not read."
  [form]
  (when (vector? form)
    (let [[head & more] form
          args (remove map? more)]
      (case head
        :map   (filter keyword? (map first (filter vector? args)))
        :merge (mapcat schema-attr-keys args)
        :multi (mapcat (comp schema-attr-keys last) (filter vector? args))
        nil))))

(def ^:private shape-attr-names
  "Attributes a shape may be asked for by name, read from the shape
  schema, so a new attribute is listed without a second edit here.
  `:content` and `:position-data` are the heavy ones: a path, bool, svg
  or text body and the glyph positions of a text. They are added by hand
  in case a branch of the schema leaves them out."
  (into #{:content :position-data}
        (concat (schema-attr-keys cts/schema:shape-attrs)
                (schema-attr-keys ctv/schema:variant-shape)
                (schema-attr-keys ctv/schema:variant-component)
                (schema-attr-keys ctv/schema:variant-container))))

(def ^:private tree-attr-names
  "The attributes a tree node may carry. The heavy ones are left out, so
  a tree of many nodes stays small."
  (into #{} (remove #{:content :position-data}) shape-attr-names))

(defn- attr-enum
  "A malli enum over the keywords of `names`, sorted so the schema is
  stable."
  [names]
  (into [:enum] (sort names)))

(def ^:private schema:page-tree
  [:map {:title "get-mcp-page-tree" :closed true}
   [:file-id ::sm/uuid]
   [:page-id ::sm/uuid]
   [:root-id {:optional true} ::sm/uuid]
   [:depth {:optional true} [::sm/int {:min 1 :max 20}]]
   [:fields {:optional true} [:vector {:max 64} (attr-enum tree-attr-names)]]
   [:limit {:optional true} [::sm/int {:min 1 :max 5000}]]
   [:cursor {:optional true} [:string {:max 4096}]]
   [:estimate-size {:optional true} :boolean]])

(declare estimate-page-size)

(def response-byte-budget
  "Encoded bytes that the shapes or the tree nodes of one reply may take:
  about 1 MB. A reply above it is cut short and flagged `truncated`."
  1000000)

(defn encoded-size
  "Encoded size of `value` in characters of its transit text. It stands in
  for the bytes of the reply: transit text is ASCII for most shapes, and a
  rough count is enough for a budget. Costs one encode per value."
  [value]
  (count (t/encode-str value)))

(defn- tree-window-end
  "The end index (exclusive) of a page-tree window that starts at `start`.
  The window holds at most `limit` entries, and stops before the entry
  that would take the encoded size of the window past `budget`. The
  ancestors of `start` count against the budget too. The window always
  holds one entry, so a walk makes progress."
  [budget limit start total node-size ancestors]
  (let [limit-end (min total (+ start limit))]
    (loop [end  start
           size (reduce + (map node-size ancestors))]
      (if (>= end limit-end)
        end
        (let [size' (+ size (node-size end))]
          (if (and (> end start) (> size' budget))
            end
            (recur (inc end) size')))))))

(sv/defmethod ::get-mcp-page-tree
  "Nested tree of a page from `root-id` (the page root by default), down
  to `depth` levels (the root is level 1). Nodes below the last level
  carry only `childCount`. At most `limit` nodes are returned per call,
  and the reply stops early once its nodes reach about 1 MB of encoded
  size; `truncated` is then true and `nextCursor` continues the walk.
  Ancestors of the window are returned as well, so the window nests
  correctly. A cursor stays valid while its page is unchanged, so writes
  to other pages do not break a walk. The children of a flex or grid
  layout come in visual order, which is the reverse of their stored order;
  the children of other shapes keep their stored order. The box of a node
  is the one the plugin API reports. Heavy attributes are not allowed in
  `fields`. The walk of a page is cached per page version, so the windows
  of one read after the first cost no second walk. With `estimate-size`
  the reply adds `totalShapes` (the shapes of the whole walk) and
  `estimatedBytes`: the size of those shapes as `get-mcp-shapes` returns
  them in JSON (UTF-8 bytes, unescaped), scaled from a sample of about 400
  shapes, one per stratum of the walk, picked by a hash of the page
  version."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:page-tree}
  [cfg {:keys [::rpc/profile-id file-id page-id root-id depth fields limit cursor estimate-size] :as params}]
  (run-tool cfg "get-mcp-page-tree" params
            (fn []
              (check-access! cfg params profile-id file-id)
              (let [file    (load-file-for-page cfg file-id page-id [])
                    data    (:data file)
                    revn    (:revn file)
                    page    (get-page-data cfg file-id revn data page-id)
                    version (page-version data page-id revn)
                    objects (:objects page)
                    root-id (or root-id uuid/zero)
                    depth   (or depth 3)
                    named   (seq fields)
                    fields  (if named (vec fields) default-tree-fields)
                    pick    (if named
                              (fn [shape]
                                (pick-named (with-defaults objects (shape-box shape)) fields))
                              (fn [shape]
                                (select-keys (shape-box shape) fields)))
                    limit   (or limit 500)
                    start   (cursor->index cursor page-id version root-id depth)]
                (when-not (contains? objects root-id)
                  (ex/raise :type :not-found
                            :code :shape-not-found
                            :hint "root shape not found in page"))
                (let [flat       (get-cached-preorder file-id page-id version objects root-id depth)
                      total      (count flat)
                      node-size  (fn [i]
                                   (let [[_ id] (nth flat i)]
                                     (encoded-size (tree-node (get objects id) pick []))))]
                  (when (>= start total)
                    (ex/raise :type :validation
                              :code :mcp-invalid-cursor
                              :hint "cursor is past the end of the page"))
                  (let [ancestors  (ancestor-indexes flat start)
                        end        (tree-window-end response-byte-budget limit start total
                                                    node-size ancestors)
                        indexes    (concat ancestors (range start end))
                        entries    (mapv (fn [i]
                                           (let [[level id] (nth flat i)]
                                             [level (get objects id)]))
                                         indexes)
                        truncated? (< end total)]
                    [(cond-> {:revn revn
                              :page-id page-id
                              :root (nest-entries entries pick)
                              :truncated truncated?}
                       truncated?
                       (assoc :next-cursor (encode-cursor [page-id version end
                                                           root-id depth]))

                       estimate-size
                       (assoc :total-shapes total
                              :estimated-bytes (estimate-page-size objects flat version)))
                     {:file-id file-id
                      :page-ids [page-id]
                      :revn revn
                      :token-id (get-token-id params)}]))))))

;; --- SHAPES

(defn shape-out
  "The map of `shape` that `get-mcp-shapes` returns: the box the plugin
  API reports, the defaults Penpot assumes, no thumbnail. Without
  `fields` the heavy attributes are left out too; `fields` names the
  attributes to return, heavy ones included when asked by name."
  [objects shape fields]
  (let [base (as-> (dissoc shape :thumbnail) $
               (shape-box $)
               (with-defaults objects $))
        out  (if (seq fields)
               (pick-named base (into [:id :type] fields))
               (dissoc base :content :position-data))]
    (if (= :text (:type base))
      (cond-> (assoc out
                     :text-layout-state (text-layout-state base)
                     :characters (shape-characters base))
        (text-size-approximate? base)
        (assoc :text-size-approximate true))
      out)))

(def ^:private estimate-sample-size
  "Shapes that `estimate-page-size` encodes: about 400."
  400)

(def ^:private estimate-clamp-factor
  "A sampled shape above this many medians of the sample stands for itself
  only, not for the shapes of its stratum: one giant shape must not make a
  page that fits look too large."
  20)

(def ^:private estimate-clamp-rare-share
  "The clamp applies only when at most this share of the strata hold a
  sample above `estimate-clamp-factor` medians: 2 %. When more do, large
  shapes are a real part of the page, and each sample counts in full."
  0.02)

(defn- json-size
  "Size of `value` as the JSON reply carries it, in UTF-8 bytes. The reply
  is camel-cased, and the cap of the adapter counts the bytes of
  `JSON.stringify`, which escapes neither non-ASCII characters nor `/`."
  [value]
  (-> (json/encode value
                   :key-fn json/write-camel-key
                   :escape-unicode false
                   :escape-slash false)
      (.getBytes "UTF-8")
      (alength)))

(defn- stratum-pick
  "The index inside stratum `k` of `strata` over `total` entries
  (`[lo hi)` with `lo = k * total / strata`), chosen by a hash of `k` and
  `version`: the same page state always gives the same pick, and a page
  that repeats a pattern is not sampled in phase."
  [total strata version k]
  (let [lo (quot (* k total) strata)
        hi (quot (* (inc k) total) strata)]
    (+ lo (Math/floorMod (long (hash [version k])) (long (- hi lo))))))

(defn estimate-page-size
  "Estimate, in UTF-8 bytes, of the JSON of all the shapes of the pre-order
  `flat` (`[level id]` entries) as `get-mcp-shapes` returns them, comma
  between shapes included. It splits the walk into about
  `estimate-sample-size` strata of equal width and encodes one shape per
  stratum, picked by a hash of the stratum and `version` (see
  `stratum-pick`). A stratum counts its width times the size of its shape,
  except that, when at most `estimate-clamp-rare-share` of the strata are
  above `estimate-clamp-factor` medians of the sample, the part of such a
  size above that limit counts once. The result is deterministic for a
  page state."
  [objects flat version]
  (let [total (count flat)]
    (if (zero? total)
      0
      (let [strata  (min total estimate-sample-size)
            samples (mapv (fn [k]
                            (let [lo   (quot (* k total) strata)
                                  hi   (quot (* (inc k) total) strata)
                                  i    (stratum-pick total strata version k)
                                  [_ id] (nth flat i)]
                              [(- hi lo)
                               (inc (json-size (shape-out objects (get objects id) nil)))]))
                          (range strata))
            sorted  (vec (sort (map second samples)))
            median  (nth sorted (quot (count sorted) 2))
            limit   (* estimate-clamp-factor (max 1 median))
            over    (count (filter #(> (second %) limit) samples))
            clamp?  (<= over (* estimate-clamp-rare-share strata))]
        (reduce (fn [acc [width size]]
                  (let [kept (if clamp? (min size limit) size)]
                    (+ acc (* width kept) (- size kept))))
                0
                samples)))))

(defn within-budget
  "The shapes of `items`, mapped by `f`, in order, up to `budget` encoded
  bytes. The first one is always kept, so a call makes progress. Returns
  `[kept truncated?]`."
  [f items budget]
  (loop [items (seq items)
         size  0
         out   (transient [])]
    (if-let [item (first items)]
      (let [value (f item)
            size' (+ size (encoded-size value))]
        (if (and (pos? (count out)) (> size' budget))
          [(persistent! out) true]
          (recur (next items) size' (conj! out value))))
      [(persistent! out) false])))

(def ^:private derived-shape-attr-names
  "Attributes `shape-out` computes for a text shape and always returns, so
  they are not in the shape schema. A caller may name them in `fields`: a
  shape without them (not a text) answers nil for the name."
  #{:text-layout-state :characters})

(def ^:private schema:shapes
  [:map {:title "get-mcp-shapes" :closed true}
   [:file-id ::sm/uuid]
   [:page-id ::sm/uuid]
   [:ids [:vector {:min 1 :max 200} ::sm/uuid]]
   [:fields {:optional true}
    [:vector {:max 64} (attr-enum (into shape-attr-names derived-shape-attr-names))]]
   [:include-children {:optional true} :boolean]
   [:include-ancestors {:optional true} :boolean]])

(def ^:private max-ancestor-chain
  "Most ancestors `get-mcp-shapes` follows up from one shape."
  1000)

(defn- get-ancestor-ids
  "The ids of the ancestors of `ids` that `objects` holds, up to and
  including the page root, which are not in `exclude`. Each chain comes top
  down, and a shape shared by two chains is listed once, so a cycle in a
  corrupt `:parent-id` cannot loop. A chain ends at the page root, which is
  its own parent."
  [objects ids exclude]
  (loop [ids  (seq ids)
         seen (set exclude)
         out  []]
    (if-let [id (first ids)]
      (let [chain (loop [parent (:parent-id (get objects id))
                         chain  ()
                         steps  0]
                    (if (or (nil? parent)
                            (>= steps max-ancestor-chain)
                            (contains? seen parent)
                            (not (contains? objects parent))
                            (= parent (first chain)))
                      chain
                      (recur (:parent-id (get objects parent))
                             (conj chain parent)
                             (inc steps))))
            chain (distinct chain)]
        (recur (next ids) (into seen chain) (into out chain)))
      out)))

(def ^:private shapes-cap
  "Most shapes one call returns, descendants included."
  2000)

(sv/defmethod ::get-mcp-shapes
  "Shapes of a page by id. Shape maps are the full shapes, minus the
  thumbnail and the heavy attributes `content` and `position-data`, unless
  `fields` names them. The box is the one the plugin API reports, and
  absent `hidden`, `blocked`, `opacity`, stroke alignment and layout sizing
  carry Penpot's defaults. Text shapes carry `characters` and
  `textLayoutState`, and `textSizeApproximate` when their box is an
  estimate. `include-children` adds the descendants of the requested
  shapes, up to 2000 shapes in all; the page root cannot be requested with
  its children. A requested shape comes first, then all its children in
  stored order, then for each child in turn its own children and theirs by
  the same rule. That is not pre-order: the children of a shape come
  before the grandchildren of its first child. Each shape comes once.
  `include-ancestors` puts the ancestors of the requested shapes up to the
  page root before the requested shapes, top down, each once, when the
  requested shapes and their descendants do not hold them. The reply stops at about 1 MB of encoded shapes and sets
  `truncated`; ask again for the ids that are missing from the reply."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:shapes}
  [cfg {:keys [::rpc/profile-id file-id page-id ids fields include-children include-ancestors] :as params}]
  (run-tool cfg "get-mcp-shapes" params
            (fn []
              (check-access! cfg params profile-id file-id)
              (when (and include-children (contains? (set ids) uuid/zero))
                (ex/raise :type :validation
                          :code :mcp-root-children-not-allowed
                          :hint "the page root cannot be requested with its children"))
              (let [file    (load-file-for-page cfg file-id page-id [])
                    data    (:data file)
                    revn    (:revn file)
                    objects (:objects (get-page-data cfg file-id revn data page-id))
                    ids     (distinct ids)
                    found   (filterv #(contains? objects %) ids)
                    missing (filterv #(not (contains? objects %)) ids)
                    chosen  (if include-children
                              (into []
                                    (comp (distinct) (filter #(contains? objects %)))
                                    (mapcat #(cfh/get-children-ids-with-self objects %) found))
                              found)
                    chosen  (if include-ancestors
                              (into (get-ancestor-ids objects found (set chosen)) chosen)
                              chosen)
                    shown   (into [] (take (inc shapes-cap)) chosen)
                    [shapes budget-cut?]
                    (within-budget #(shape-out objects (get objects %) fields)
                                   (take shapes-cap shown)
                                   response-byte-budget)]
                [{:revn revn
                  :shapes shapes
                  :missing missing
                  :truncated (or budget-cut? (> (count shown) shapes-cap))}
                 {:file-id file-id
                  :page-ids [page-id]
                  :revn revn
                  :token-id (get-token-id params)}]))))

;; --- SEARCH

(def ^:private search-budget-ns
  "Time a search may spend across pages: five seconds."
  5000000000)

(defn compile-regex
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

(defn deadline-chars
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

(defn regex-timeout?
  [cause]
  (boolean (::deadline (ex-data cause))))

(defn- match-predicate
  "The predicate of the filters. `deadline` is a nanoTime, or a volatile that
  holds one, which the regex reads when it runs."
  [data deadline {:keys [type name-regex name component-id has-token text-contains colors]}]
  (let [regex  (compile-regex name-regex)
        wanted (when (seq colors)
                 (into #{} (map str/lower-case) colors))
        needle (some-> text-contains str/lower-case)]
    (fn [shape]
      (and (or (nil? type) (= type (:type shape)))
           (or (nil? name) (= name (:name shape)))
           (or (nil? regex)
               (re-find (re-matcher regex (deadline-chars (str (:name shape))
                                                          (if (volatile? deadline) @deadline deadline)))))
           (or (nil? component-id) (= component-id (:component-id shape)))
           (or (nil? has-token)
               (= has-token (boolean (seq (:applied-tokens shape)))))
           (or (nil? needle)
               (and (= :text (:type shape))
                    (str/includes? (str/lower-case (shape-characters shape))
                                   needle)))
           (or (nil? wanted)
               (boolean (some wanted (shape-colors data shape))))))))

(def max-ancestor-steps
  "Most ancestors `shape-path` walks up; a deeper path stops here."
  1000)

(defn shape-path
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
  ran past the search deadline. A regex that recurses too deep on a long
  name is refused as a bad pattern, not a server error."
  [pred? shape]
  (try
    (boolean (pred? shape))
    (catch clojure.lang.ExceptionInfo cause
      (if (regex-timeout? cause)
        :timeout
        (throw cause)))
    (catch StackOverflowError _
      (ex/raise :type :validation
                :code :mcp-invalid-pattern
                :hint "name-regex is too deep to match these names"))))

(defn- search-preorder
  "The pre-order `[level id]` entries of the subtree at `start-id`, in stored
  child order, from `preorder-cache` when it is held. A search that goes on
  with a cursor, or on the next call, reads the same walk."
  [file-id page-id version objects start-id]
  (cache/get preorder-cache
             [file-id page-id version start-id :search]
             (fn [_] (page-preorder objects start-id Long/MAX_VALUE false))))

(def ^:private find-envelope-bytes
  "Bytes of a find reply that `max-bytes` keeps for what is not a match: the
  flags, the counts, the reason and the cursor."
  512)

(defn- public-match
  "`match` as the reply carries it, without the keys of the cursor."
  [match]
  (dissoc match ::page-id ::index))

(defn- match-fit
  "How a match of `bytes` (its JSON bytes and the comma) goes into a reply
  budget of `budget` bytes that already holds `size` bytes: `:large` when it
  does not fit in an empty reply, `:over` when it does not fit next to what the
  reply holds, `:fit` otherwise. `fit-matches` and the search use this one
  measure."
  [size bytes budget]
  (cond
    (> (+ 2 bytes) budget)    :large
    (> (+ size bytes) budget) :over
    :else                     :fit))

(defn- search-objects
  "Matches of `pred?` in the tree of `start-id` on one page, in tree order,
  from entry `from` of the walk `entries`, up to `cap` of them and until
  `deadline` (nanoTime). The deadline is not read before the first entry of
  the call is examined, so a call always moves on. Each match carries its
  position, `::page-id` and `::index`, for the cursor. `size` is the bytes the
  reply holds so far and `budget` the bytes it may hold (see `match-fit`).
  The walk stops at the first match that fits alone but not next to the
  matches held: that match is the last of `:matches` and `fit-matches` cuts
  it. A match too large to fit alone is kept in `:matches`, not counted in the
  size, and the walk goes on. Returns `{:matches :scanned :stop :next-index
  :skipped :size}`. `:stop` is `:limit`, `:time` or `:size` when the walk ended
  before the last entry; for `:limit` and `:time` `:next-index` is the entry
  where it goes on. `:size` is the bytes held at the end. `:skipped` holds the
  id of the shape that the call left out because its name ran the regex past
  the deadline with nothing examined before it (absent otherwise). With
  `moved?` true the call examined entries before this page."
  [entries objects page-id start-id pred? cap deadline from moved? budget size]
  (let [total (count entries)]
    (loop [i       from
           scanned 0
           size    size
           out     []]
      (cond
        (>= i total)
        {:matches out :scanned scanned :stop nil :size size}

        (>= (count out) cap)
        {:matches out :scanned scanned :stop :limit :next-index i :size size}

        (and (or moved? (pos? scanned)) (> (System/nanoTime) deadline))
        {:matches out :scanned scanned :stop :time :next-index i :size size}

        :else
        (let [[_ id] (nth entries i)
              shape  (get objects id)
              hit    (if (= id start-id)
                       false
                       (hit? pred? shape))]
          (cond
            (= :timeout hit)
            ;; A name that ran past the deadline with nothing examined
            ;; before it is left out: tried again, it would stop every call.
            ;; The reply names it in `skipped`.
            (let [skip? (and (zero? scanned) (not moved?))]
              (cond-> {:matches out
                       :scanned scanned
                       :size size
                       :stop :time
                       :next-index (if skip? (inc i) i)}
                skip? (assoc :skipped [id])))

            (not hit)
            (recur (inc i) (inc scanned) size out)

            :else
            (let [match {:id id
                         :page-id page-id
                         :name (:name shape)
                         :type (:type shape)
                         :path (shape-path objects shape)
                         ::page-id page-id
                         ::index i}
                  bytes (inc (json-size (public-match match)))
                  out   (conj out match)]
              (case (match-fit size bytes budget)
                :large (recur (inc i) (inc scanned) size out)
                :fit   (recur (inc i) (inc scanned) (+ size bytes) out)
                :over  {:matches out :scanned (inc scanned) :stop :size
                        :size size}))))))))

(defn- search-pages
  "Matches in the pages `page-ids` of the file at `revn`, in page order, up
  to `cap` of them, from entry `from` of the first page. The time budget
  `budget-ns` counts from the moment the first page is loaded, since a cold
  load of a large page can take longer than the budget and would leave no
  time to read it. `deadline-v` is a volatile that holds the deadline, for
  the name regex too. `budget` is the bytes the matches may take in the reply
  (see `search-objects`); the search stops when the next match does not fit.
  `:scanned` counts the shapes the call examined. A call that stops on the
  size examined the match that did not fit, and the next call examines it
  again. Returns `{:matches :scanned :stop :resume :skipped}`; `:resume` is
  `[page-id index]` where the search goes on when `:stop` is `:limit` or
  `:time`, and `:skipped` the ids of the shapes left out (see
  `search-objects`)."
  [cfg file-id revn data page-ids start-id pred? cap budget-ns from deadline-v budget]
  (loop [page-ids page-ids
         from     from
         matches  []
         scanned  0
         size     2
         skipped  []]
    (cond
      (empty? page-ids)
      {:matches matches :scanned scanned :stop nil :skipped skipped}

      (>= (count matches) cap)
      {:matches matches :scanned scanned :stop :limit :skipped skipped
       :resume [(first page-ids) from]}

      (and (pos? scanned) (> (System/nanoTime) @deadline-v))
      {:matches matches :scanned scanned :stop :time :skipped skipped
       :resume [(first page-ids) from]}

      :else
      (let [page-id (first page-ids)
            objects (:objects (get-page-data cfg file-id revn data page-id))
            ;; The clock starts once the first page is in memory
            _       (when (= Long/MAX_VALUE @deadline-v)
                      (vreset! deadline-v (+ (System/nanoTime) budget-ns)))
            root    (or start-id uuid/zero)
            entries (search-preorder file-id page-id (page-version data page-id revn)
                                     objects root)
            result  (search-objects entries objects page-id root pred?
                                    (- cap (count matches)) @deadline-v from
                                    (pos? scanned) budget size)
            matches (into matches (:matches result))
            scanned (+ scanned (:scanned result))
            skipped (into skipped (:skipped result))]
        (if (:stop result)
          {:matches matches :scanned scanned :stop (:stop result)
           :skipped skipped
           :resume [page-id (:next-index result)]}
          (recur (rest page-ids) 0 matches scanned (:size result) skipped))))))

(def ^:private find-hash-bits
  "Bits of each of the two hashes that a find cursor carries."
  26)

(defn- find-hash
  "The low `find-hash-bits` bits of the hash of `value`. The hash of plain
  data is the same in every process, so another backend reads the cursor."
  [value]
  (bit-and (long (hash value)) (dec (bit-shift-left 1 find-hash-bits))))

(defn- find-signature
  "`[filters pages]`, two short hashes. `filters` covers every parameter that
  changes which shapes match (the page scope included; `within-id` is the
  root of the cursor) and `pages` the ordered page ids of the search. A
  cursor made with other values is refused (see `find-resume`)."
  [{:keys [colors] :as params} pages]
  [(find-hash (cond-> (select-keys params [:page-id :type :name :name-regex :component-id
                                           :has-token :text-contains])
                (seq colors) (assoc :colors (into #{} (map str/lower-case) colors))))
   (find-hash (vec pages))])

(defn- find-cursor
  "The cursor that goes on at entry `index` of the page `page-id`, for a
  search below `start-id`. The depth slot of a page-tree cursor holds the two
  hashes of `signature`, packed in one integer."
  [data page-id revn index start-id [filters pages]]
  (encode-cursor [page-id (page-version data page-id revn) index
                  (or start-id uuid/zero)
                  (bit-or (bit-shift-left filters find-hash-bits) pages)]))

(defn- find-resume
  "The `[page-ids from]` a find cursor goes on at: the pages of the search
  from the cursor's page on, and the entry to start at. Without a cursor,
  every page from entry 0. A cursor of another search (other filters, other
  root) is invalid. A cursor made when the file had other pages, or whose page
  changed, is stale."
  [cursor data revn pages start-id [filters-hash pages-hash]]
  (if (nil? cursor)
    [pages 0]
    (let [value (parse-cursor cursor)]
      (when (nil? value)
        (ex/raise :type :validation
                  :code :mcp-invalid-cursor
                  :hint "cursor is not valid"))
      (let [[page-id version index root-id packed] value
            mask       (dec (bit-shift-left 1 find-hash-bits))
            rest-pages (seq (drop-while #(not= % page-id) pages))]
        (when-not (and (= root-id (or start-id uuid/zero))
                       (= filters-hash (bit-and (bit-shift-right packed find-hash-bits) mask)))
          (ex/raise :type :validation
                    :code :mcp-invalid-cursor
                    :hint "cursor belongs to another search: the filters changed"))
        (when (or (nil? rest-pages)
                  (not= pages-hash (bit-and packed mask)))
          (ex/raise :type :validation
                    :code :mcp-stale-cursor
                    :hint "the pages of the file changed since the cursor was issued, start again without a cursor"))
        (when-not (= version (page-version data page-id revn))
          (ex/raise :type :validation
                    :code :mcp-stale-cursor
                    :hint "the page changed since the cursor was issued, start again without a cursor"))
        [rest-pages index]))))

(def ^:private schema:find-shapes
  [:map {:title "find-mcp-shapes" :closed true}
   [:file-id ::sm/uuid]
   [:page-id {:optional true} ::sm/uuid]
   [:type {:optional true} [::sm/one-of cts/shape-types]]
   [:name-regex {:optional true} [:string {:max 200}]]
   [:name {:optional true} [:string {:max 500}]]
   [:component-id {:optional true} ::sm/uuid]
   [:has-token {:optional true} :boolean]
   [:text-contains {:optional true} [:string {:max 500}]]
   [:within-id {:optional true} ::sm/uuid]
   [:colors {:optional true} [:vector {:max 50} [:string {:max 32}]]]
   [:limit {:optional true} [::sm/int {:min 1 :max 1000}]]
   [:max-bytes {:optional true} [::sm/int {:min 1000 :max 1000000}]]
   [:cursor {:optional true} [:string {:max 4096}]]])

(def ^:private find-skipped-ids-max
  "Most ids that a find reply lists in `skipped-ids`."
  20)

(defn- fit-matches
  "The matches of `matches`, in order, whose JSON as the client receives it
  (UTF-8 bytes, one comma per match, see `json-size`) stays within `budget`.
  A match that does not fit in the budget of an empty reply is left out, so a
  call always moves on. Returns `{:kept :large :last :cut?}`: the matches kept,
  the matches left out as too large, the last match the call went through (kept
  or left out; the cursor goes after it) and whether the budget cut the list."
  [matches budget]
  (loop [items (seq matches)
         size  2
         out   []
         large []
         lst   nil]
    (if-let [item (first items)]
      (let [bytes (inc (json-size (public-match item)))]
        (case (match-fit size bytes budget)
          :large (recur (next items) size out (conj large item) item)
          :over  {:kept out :large large :last lst :cut? true}
          :fit   (recur (next items) (+ size bytes) (conj out item) large item)))
      {:kept out :large large :last lst :cut? false})))

(defn- find-reply
  "The reply of a search. The matches keep whole: up to `limit` of them and
  up to `max-bytes` of JSON, in UTF-8 bytes less `find-envelope-bytes` for the
  rest of the reply. A match too large to fit alone is left out. `reason` says
  why the list ends before the last shape: `size` (the byte budget), `limit`
  (the match limit) or `time` (the search budget). `next-cursor` goes on after
  the last match the call went through, or where the search stopped on the
  clock. `scanned` counts the shapes the call examined. `skipped` counts the
  shapes the call left out because their name ran the regex out of time, and
  `skipped-ids` lists the first few. `skipped-large` counts the matches left
  out because one match alone does not fit in `max-bytes`, and
  `skipped-large-ids` lists the first few. Each pair is absent when none was
  left out. `signature` is the one of `find-signature`."
  [data revn start-id limit max-bytes signature {:keys [matches scanned stop resume skipped]}]
  (let [limited   (vec (take limit matches))
        {:keys [kept large cut?] last-seen :last}
        (fit-matches limited (- max-bytes find-envelope-bytes))
        reason    (cond cut?                     "size"
                        (> (count matches) limit) "limit"
                        (= :time stop)           "time")
        cursor    (case reason
                    ("size" "limit")
                    (find-cursor data (::page-id last-seen) revn
                                 (inc (::index last-seen)) start-id signature)
                    "time"
                    (let [[page-id index] resume]
                      (find-cursor data page-id revn index start-id signature))
                    nil)]
    (cond-> {:matches (mapv public-match kept)
             :truncated (some? reason)
             :scanned scanned}
      (some? reason) (assoc :reason reason
                            :next-cursor cursor)
      (seq skipped) (assoc :skipped (count skipped)
                           :skipped-ids (vec (take find-skipped-ids-max skipped)))
      (seq large) (assoc :skipped-large (count large)
                         :skipped-large-ids (into [] (comp (map :id) (take find-skipped-ids-max)) large)))))

(sv/defmethod ::find-mcp-shapes
  "Shapes matching every given filter, on one page or on all pages
  (five seconds at most). `name` is an exact, case-sensitive match on the
  shape name. `name-regex` is a Java regular expression searched in the
  shape name (`re-find`), so a partial pattern matches. `colors` matches
  fill and stroke colors and the colors of local library references.
  `text-contains` matches the characters of text shapes, ignoring case.
  `has-token` matches shapes with at least one applied token, or none
  when false. A search that ends early returns the matches it has, with
  `truncated`, the `reason` (`size`, `limit` or `time`), `scanned` (the
  shapes it examined) and `next-cursor`: send it back as `cursor` to go on.
  The five seconds start when the first page is loaded, and a call examines
  at least one shape, so every call moves on. A shape whose name runs the
  regex out of time as the first of a call is left out, and the reply counts
  it in `skipped`, with `skipped-ids`. A match that alone is larger than
  `max-bytes` is left out and counted in `skipped-large`, with
  `skipped-large-ids`. A cursor goes with the same filters
  only. `max-bytes` caps the size of the reply as UTF-8 bytes of JSON, about
  1 MB by default."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]
                [:mcp-find/by-file :file-id]]
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:find-shapes}
  [cfg {:keys [::rpc/profile-id file-id page-id within-id limit max-bytes cursor] :as params}]
  (run-tool cfg "find-mcp-shapes" params
            (fn []
              (check-access! cfg params profile-id file-id)
              (let [file       (load-file-for-page cfg file-id page-id [])
                    data       (:data file)
                    revn       (:revn file)
                    limit      (or limit 100)
                    max-bytes  (or max-bytes response-byte-budget)
                    pages      (if (some? page-id) [page-id] (:pages data))
                    signature  (find-signature params pages)
                    [pages from] (find-resume cursor data revn pages within-id signature)
                    deadline-v (volatile! Long/MAX_VALUE)
                    result     (search-pages cfg file-id revn data pages within-id
                                             (match-predicate data deadline-v params)
                                             (inc limit) search-budget-ns from deadline-v
                                             (- max-bytes find-envelope-bytes))
                    reply      (find-reply data revn within-id limit
                                           max-bytes signature result)]
                [reply
                 {:file-id file-id
                  :page-ids (distinct (map :page-id (:matches reply)))
                  :revn (:revn file)
                  :token-id (get-token-id params)}]))))

;; --- LIBRARY

(def ^:private library-kinds
  "The sections of a library, in the order the reply lists them."
  ["components" "colors" "typographies" "media"])

(def ^:private default-library-kinds
  "The sections returned when a call names none."
  (set library-kinds))

(def ^:private sql:library-media
  "SELECT id, name, width, height, mtype
     FROM file_media_object
    WHERE file_id = ?
      AND deleted_at IS NULL
    ORDER BY name, id
    LIMIT ?")

(def ^:private sql:library-media-count
  "SELECT count(*) AS total
     FROM file_media_object
    WHERE file_id = ?
      AND deleted_at IS NULL")

(defn- component-out
  [component]
  (-> (select-keys component [:id :name :path :main-instance-id
                              :main-instance-page :variant-id
                              :variant-properties])
      (assoc :deleted (boolean (:deleted component)))))

(defn- library-components
  [data include-deleted?]
  (let [live (map #(assoc % :deleted false) (ctkl/components-seq data))
        dead (when include-deleted?
               (map #(assoc % :deleted true) (ctkl/deleted-components-seq data)))]
    (->> (concat live dead)
         (sort-by (juxt :path :name))
         (mapv component-out))))

(def ^:private schema:library
  [:map {:title "get-mcp-library" :closed true}
   [:file-id ::sm/uuid]
   [:kinds {:optional true}
    [:vector {:max 4} (into [:enum] library-kinds)]]
   [:include-deleted {:optional true} :boolean]
   [:limit {:optional true} [::sm/int {:min 1 :max 5000}]]])

(sv/defmethod ::get-mcp-library
  "Library contents of a file: components (with `deleted` flag when
  `include-deleted` is set), colors, typographies and media objects.
  `kinds` picks the sections to return; the others come back empty.
  Each section holds at most `limit` items, and `totals` gives the full
  count per section. `truncated` is true when any section is cut short."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:library}
  [cfg {:keys [::rpc/profile-id file-id kinds include-deleted limit] :as params}]
  (run-tool cfg "get-mcp-library" params
            (fn []
              (check-access! cfg params profile-id file-id)
              (let [file   (load-file-data cfg file-id [:components :colors :typographies])
                    data   (:data file)
                    kinds  (if (seq kinds) (set kinds) default-library-kinds)
                    limit  (or limit 500)
                    wanted (fn [kind] (contains? kinds kind))
                    components   (if (wanted "components")
                                   (library-components data include-deleted)
                                   [])
                    colors       (if (wanted "colors")
                                   (vec (sort-by :name (vals (:colors data))))
                                   [])
                    typographies (if (wanted "typographies")
                                   (vec (sort-by :name (vals (:typographies data))))
                                   [])
                    media-total  (if (wanted "media")
                                   (:total (db/exec-one! cfg [sql:library-media-count file-id]))
                                   0)
                    media        (if (wanted "media")
                                   (mapv (fn [row]
                                           (select-keys row [:id :name :width :height :mtype]))
                                         (db/exec! cfg [sql:library-media file-id limit]))
                                   [])
                    totals       {"components"   (count components)
                                  "colors"       (count colors)
                                  "typographies" (count typographies)
                                  "media"        media-total}]
                [{:components (vec (take limit components))
                  :colors (vec (take limit colors))
                  :typographies (vec (take limit typographies))
                  :media media
                  :totals (into {} (map (fn [[k v]] [(keyword k) v])) totals)
                  :truncated (boolean (some #(> % limit) (vals totals)))}
                 {:file-id file-id
                  :page-ids []
                  :revn (:revn file)
                  :token-id (get-token-id params)}]))))

;; --- TOKENS

(def ^:private schema:tokens
  [:map {:title "get-mcp-tokens" :closed true}
   [:file-id ::sm/uuid]
   [:set-id {:optional true} ::sm/uuid]
   [:format {:optional true} [:enum "tokens" "dtcg"]]])

(defn- dtcg-of-set
  "The DTCG export `dtcg` cut down to the set named `set-name`, with the
  `$metadata` block that names the set order."
  [dtcg set-name]
  (select-keys dtcg [set-name "$metadata"]))

(sv/defmethod ::get-mcp-tokens
  "Token sets, themes and the active state of a file. `set-id` limits the
  sets and their tokens to one set; an unknown id is refused. `format`
  picks what the reply carries: `tokens` (the default) is the flat list
  of tokens; `dtcg` is the DTCG export, with the tokens in it and no flat
  list. The reply never carries both."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:tokens}
  [cfg {:keys [::rpc/profile-id file-id set-id] fmt :format :as params}]
  (run-tool cfg "get-mcp-tokens" params
            (fn []
              (check-access! cfg params profile-id file-id)
              (let [file     (load-file-data cfg file-id [:tokens-lib :tokens-status])
                    data     (:data file)
                    lib      (cfo/get-tokens-lib data)
                    status   (or (cfo/get-tokens-status data)
                                 (ctos/make-tokens-status))
                    all-sets (if (some? lib) (vec (ctob/get-sets lib)) [])
                    themes   (if (some? lib) (vec (ctob/get-themes-no-hidden lib)) [])
                    sets     (if (some? set-id)
                               (filterv #(= set-id (ctob/get-id %)) all-sets)
                               all-sets)
                    _        (when (and (some? set-id) (empty? sets))
                               (ex/raise :type :not-found
                                         :code :token-set-not-found
                                         :hint "token set not found"))
                    dtcg?    (= "dtcg" fmt)]
                [(cond-> {:sets (mapv (fn [token-set]
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
                          :active-themes (vec (sort (ctos/get-active-theme-ids status)))
                          :active-sets (vec (sort (ctos/get-active-set-ids status)))}
                   (not dtcg?)
                   (assoc :tokens (vec (for [token-set sets
                                             [_ token] (ctob/get-tokens lib (ctob/get-id token-set))]
                                         {:set-id (ctob/get-id token-set)
                                          :id (:id token)
                                          :name (:name token)
                                          :type (:type token)
                                          :value (:value token)
                                          :description (:description token)})))

                   dtcg?
                   (assoc :dtcg (when (some? lib)
                                  (let [dtcg (ctob/export-dtcg-json lib status)]
                                    (if (some? set-id)
                                      (dtcg-of-set dtcg (ctob/get-name (first sets)))
                                      dtcg)))))
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
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::db/transaction true
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:render-session}
  [cfg {:keys [::rpc/profile-id file-id] :as params}]
  (run-tool cfg "create-mcp-render-session" params
            (fn []
              (check-access! cfg params profile-id file-id)
              (let [file-ids   (into #{file-id}
                                     (map :id)
                                     (bfc/get-file-libraries cfg file-id))
                    token-id   (get-token-id params)
                    ;; The token id lets the session die with its token.
                    session    (session/create-session
                                (::session/manager cfg)
                                {:profile-id profile-id
                                 :user-agent "penpot-mcp-exporter"
                                 :props {:mcp-render {:file-ids file-ids}
                                         :token-id token-id}})
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
