;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.render-wasm.page-cache
  "Decides when the WASM renderer may reuse the shapes pool of a page.

  Switching pages rebuilds the renderer. The renderer can keep the shapes
  pool of the page on screen and give it back when the page is opened
  again. That skips the upload.

  A kept copy is only valid while the page data has not changed. Every
  applied commit bumps the version of each page it touches. A stash
  records the version, and a restore needs the same version. The copy
  also records a data epoch (file id, file version, preview id).

  A commit applied while the page is on screen, but not written to WASM,
  taints that page. A tainted page is not stashed. A page whose texts wait
  for a relayout (see `hold-resident!`) is not stashed either.

  The upload summary of a page (see `set-summary!`) is kept here too, so
  it is dropped together with the copy it describes.

  The `render-wasm-page-cache` flag turns the cache off."
  (:require
   [app.common.render-wasm.helpers :as h]
   [app.common.render-wasm.mem :as mem]
   [app.common.render-wasm.wasm :as wasm]
   [app.common.uuid :as uuid]
   [app.config :as cf]))

;; Page id -> number of commits that touched the page.
(defonce ^:private versions (atom {}))

;; Page id -> {:version int :epoch any}. Pages kept in WASM.
(defonce ^:private entries (atom {}))

;; Page id -> upload summary of the page (see `set-summary!`).
(defonce ^:private summaries (atom {}))

;; The page on screen, or nil.
;; {:page-id uuid :epoch any :token int :tainted? bool :layouts-pending? bool}
(defonce ^:private resident (atom nil))

;; Incremented by every begin-load!. Only the latest token may set the resident.
(defonce ^:private load-token (atom 0))

;; Number of structural syncs still running. Stash is blocked while above zero.
(defonce ^:private pending-syncs (atom 0))

(def ^:private page-change-types
  "Change types that name their page in :id or [:page :id] when :page-id is absent."
  #{:add-page :mod-page :del-page :mov-page})

(def ^:private page-neutral-change-types
  "Change types that never change page objects."
  #{:add-color :mod-color :del-color
    :add-media :mod-media :del-media
    :add-component :mod-component
    :add-typography :mod-typography :del-typography
    :set-tokens-lib :set-token :set-token-set :set-token-theme
    :set-tokens-status :set-own-tokens-status
    :rename-token-set-group :move-token-set :move-token-set-group
    :set-base-font-size :set-tokens-source
    :set-plugin-data})

(defn- change-page-id
  "Returns the page id a change names, or nil."
  [change]
  (or (:page-id change)
      (when (contains? page-change-types (:type change))
        (or (:id change)
            (get-in change [:page :id])))))

(defn- wasm-truthy?
  "True when a WASM bool result is true (it arrives as 1 or 0)."
  [result]
  (or (true? result)
      (= 1 result)))

(defn- wasm-stash-page
  "Calls `_stash_page` for a page id."
  [page-id]
  (let [buffer (uuid/get-u32 page-id)]
    (h/call wasm/internal-module "_stash_page"
            (aget buffer 0) (aget buffer 1) (aget buffer 2) (aget buffer 3))))

(defn- wasm-stash-page-keeping
  "Calls `_stash_page_keeping` for a page id. WASM never evicts the page
  `keep-page-id` to make room for it. The nil uuid keeps no page."
  [page-id keep-page-id]
  (let [buffer (uuid/get-u32 page-id)
        keep   (uuid/get-u32 keep-page-id)]
    (h/call wasm/internal-module "_stash_page_keeping"
            (aget buffer 0) (aget buffer 1) (aget buffer 2) (aget buffer 3)
            (aget keep 0) (aget keep 1) (aget keep 2) (aget keep 3))))

(defn- wasm-restore-page
  "Calls `_restore_page` for a page id."
  [page-id]
  (let [buffer (uuid/get-u32 page-id)]
    (h/call wasm/internal-module "_restore_page"
            (aget buffer 0) (aget buffer 1) (aget buffer 2) (aget buffer 3))))

(defn- wasm-drop-page
  "Calls `_drop_cached_page` for a page id."
  [page-id]
  (let [buffer (uuid/get-u32 page-id)]
    (h/call wasm/internal-module "_drop_cached_page"
            (aget buffer 0) (aget buffer 1) (aget buffer 2) (aget buffer 3))))

(defn- pruning-supported?
  "True when the WASM build reports the pages it keeps (`_cached_page_ids`).
  An older build gets `_stash_page` and no pruning."
  []
  (fn? (unchecked-get wasm/internal-module "_cached_page_ids")))

(defn- wasm-stash
  "Stashes the pool of `page-id`, keeping `keep-page-id` when it is another
  page. Uses `_stash_page` on an older build."
  [page-id keep-page-id]
  (if (pruning-supported?)
    (wasm-stash-page-keeping page-id
                             (if (and (some? keep-page-id)
                                      (not= keep-page-id page-id))
                               keep-page-id
                               uuid/zero))
    (wasm-stash-page page-id)))

(defn- wasm-cached-page-ids
  "Reads the ids of the pages WASM keeps, as a set. `_cached_page_ids` returns
  a pointer to [u32 count][count x 16-byte uuid], each uuid as four
  little-endian u32 parts."
  []
  (let [ptr   (h/call wasm/internal-module "_cached_page_ids")
        dview (mem/get-data-view)
        n     (.getUint32 dview ptr true)
        ids   (into #{}
                    (map (fn [i]
                           (let [base (+ ptr 4 (* 16 i))
                                 part (fn [j]
                                        (.getUint32 dview (+ base (* 4 j)) true))]
                             (uuid/from-unsigned-parts (part 0) (part 1)
                                                       (part 2) (part 3)))))
                    (range n))]
    (mem/free)
    ids))

(defn changes-scope
  "Returns the pages that a list of changes touches.

  The result is {:page-ids set :all? bool}. A change with a page id adds
  that page. A change with no page id and a :component-id is ignored. A
  change with no page id is ignored when its type is page-neutral. Any
  other change with no page id sets :all? to true, because it may change
  page objects without naming the page. A nil change is ignored."
  [changes]
  (reduce
   (fn [scope change]
     (let [page-id (change-page-id change)]
       (cond
         (nil? change)
         scope

         (some? page-id)
         (update scope :page-ids conj page-id)

         (some? (:component-id change))
         scope

         (contains? page-neutral-change-types (:type change))
         scope

         :else
         (assoc scope :all? true))))
   {:page-ids #{} :all? false}
   changes))

(defn version
  "Returns the data version of a page. It is zero until a commit touches it."
  [page-id]
  (get @versions page-id 0))

(defn summary
  "Returns the upload summary of `page-id`, or nil. See `set-summary!`."
  [page-id]
  (get @summaries page-id))

(defn set-summary!
  "Stores `value`, the upload summary of `page-id`. Keeps the summaries of the
  pages still in the cache, and drops the others. Returns nil."
  [page-id value]
  (let [cached (set (keys @entries))]
    (swap! summaries (fn [m]
                       (assoc (select-keys m cached) page-id value))))
  nil)

(defn drop-summary!
  "Forgets the upload summary of `page-id`. Returns nil."
  [page-id]
  (swap! summaries dissoc page-id)
  nil)

(defn- drop-page!
  "Drops the stash entry, the summary and the WASM pool of `page-id`."
  [page-id]
  (swap! entries dissoc page-id)
  (swap! summaries dissoc page-id)
  (when (wasm/module-ready?)
    (wasm-drop-page page-id)))

(defn taint-resident!
  "Marks the resident page as tainted, so it is not stashed. Does nothing when no page is resident."
  []
  (when (some? @resident)
    (swap! resident assoc :tainted? true)))

(defn hold-resident!
  "Marks the resident page of load `token` as waiting for a text relayout: its
  texts were laid out with fallback faces, so it is not stashed. Does nothing
  for another load. Returns nil."
  [token]
  (when (and (some? token) (= token (:token @resident)))
    (swap! resident assoc :layouts-pending? true))
  nil)

(defn release-resident!
  "Ends `hold-resident!` for the resident page of load `token`, now that its
  texts are laid out again. Does nothing for another load. Returns nil."
  [token]
  (when (and (some? token) (= token (:token @resident)))
    (swap! resident assoc :layouts-pending? false))
  nil)

(defn clear!
  "Forgets every stashed page and summary, and taints the resident page.

  Calls `_clear_page_cache` when the WASM module is ready."
  []
  (reset! entries {})
  (reset! summaries {})
  (taint-resident!)
  (when (wasm/module-ready?)
    (h/call wasm/internal-module "_clear_page_cache")))

(defn note-changes!
  "Records the changes of one applied commit.

  `changes` is the concatenated undo and redo changes of the commit.
  `current-page-id` is the page on screen. `wasm-synced?` tells whether the
  commit was written to WASM. `structural-sync?` tells whether a structural
  sync is now running; stash stays blocked until end-structural-sync!.

  A deleted page (`:del-page`) loses its stash entry, its summary and its
  WASM pool.

  Returns nil."
  [changes {:keys [current-page-id wasm-synced? structural-sync?]}]
  (doseq [change changes
          :when (= :del-page (:type change))
          :let [page-id (change-page-id change)]
          :when (some? page-id)]
    (drop-page! page-id))

  (let [{:keys [page-ids all?]} (changes-scope changes)]
    (cond
      all?
      (clear!)

      (seq page-ids)
      (do
        (doseq [page-id page-ids]
          (swap! versions update page-id (fnil inc 0)))
        (let [res @resident]
          (when (and (some? res)
                     (or (not= current-page-id (:page-id res))
                         (and (not wasm-synced?)
                              (contains? page-ids (:page-id res)))))
            (taint-resident!)))))

    (when structural-sync?
      (swap! pending-syncs inc))

    nil))

(defn end-structural-sync!
  "Ends one structural sync. The count never goes below zero."
  []
  (swap! pending-syncs #(max 0 (dec %))))

(defn begin-load!
  "Starts loading a page into the renderer.

  Clears the resident page. Returns a token for this load. Pass the token to
  set-resident!. An older token is rejected."
  []
  (reset! resident nil)
  (swap! load-token inc))

(defn latest-load-token
  "Returns the token of the latest begin-load!, or 0 before the first one."
  []
  @load-token)

(defn invalidate-loads!
  "Makes every running load stale, so none of them sets the resident page or
  goes on to its next chunk. The resident page itself is not changed.
  Returns nil."
  []
  (swap! load-token inc)
  nil)

(defn set-resident!
  "Records the page the renderer now holds, if the token is the latest.

  Resets the structural sync count. Returns nil."
  [token page-id epoch]
  (when (= token @load-token)
    (reset! resident {:page-id          page-id
                      :epoch            epoch
                      :token            token
                      :tainted?         false
                      :layouts-pending? false})
    (reset! pending-syncs 0))
  nil)

(defn resident-page-id
  "Returns the id of the resident page, or nil."
  []
  (:page-id @resident))

(defn resident-token
  "Returns the load token of the resident page, or nil."
  []
  (:token @resident))

(defn enabled?
  "True unless the `render-wasm-page-cache` flag is disabled."
  []
  (contains? cf/flags :render-wasm-page-cache))

(defn sync-with-wasm!
  "Prunes the cache to the pages WASM still keeps, when this build reports
  them with `_cached_page_ids`. Entries of other pages are dropped, and so
  are summaries, except the one of the resident page. Does nothing for an
  older build or when the module is not ready. Returns nil."
  []
  (when (and (wasm/module-ready?)
             (pruning-supported?))
    (let [ids  (wasm-cached-page-ids)
          keep (cond-> ids
                 (some? (:page-id @resident)) (conj (:page-id @resident)))]
      (swap! entries select-keys ids)
      (swap! summaries select-keys keep)))
  nil)

(defn stash!
  "Ends the residency of the resident page and keeps its pool in WASM when allowed.

  Returns true when the pool was stashed. The pool is stashed only when
  `allowed?` is true, the page cache is enabled, the page is not tainted,
  the page has no pending text relayout, `epoch` equals the epoch of the
  resident, no structural sync runs, the WASM module is ready and WASM
  accepts the stash. In every other case the page is dropped from the cache,
  with its summary, and false is returned.

  `keep-page-id` is the page about to be restored, when it is another page.
  WASM does not evict it to make room. The cache is then pruned to the pages
  WASM keeps (see `sync-with-wasm!`)."
  ([epoch allowed?]
   (stash! epoch allowed? nil))
  ([epoch allowed? keep-page-id]
   (let [res      @resident
         page-id  (:page-id res)
         _        (reset! resident nil)
         stashed? (cond
                    (nil? page-id)
                    false

                    (and allowed?
                         (enabled?)
                         (not (:tainted? res))
                         (not (:layouts-pending? res))
                         (= epoch (:epoch res))
                         (zero? @pending-syncs)
                         (wasm/module-ready?)
                         (wasm-truthy? (wasm-stash page-id keep-page-id)))
                    (do
                      (swap! entries assoc page-id {:version (version page-id)
                                                    :epoch   epoch})
                      true)

                    :else
                    (do
                      (drop-page! page-id)
                      false))]
     (sync-with-wasm!)
     stashed?)))

(defn restore!
  "Restores the stashed pool of a page when it still matches the data.

  Returns the stash entry when WASM restored the pool. Returns nil otherwise,
  and also when the page cache is disabled. The entry is removed from the
  cache in both cases. A stale entry is dropped from WASM too, and a miss
  drops the summary of the page."
  [page-id epoch]
  (let [entry    (get @entries page-id)
        _        (swap! entries dissoc page-id)
        restored (when (wasm/module-ready?)
                   (if (and (enabled?)
                            (some? entry)
                            (= (:version entry) (version page-id))
                            (= (:epoch entry) epoch)
                            (wasm-truthy? (wasm-restore-page page-id)))
                     entry
                     (do
                       (wasm-drop-page page-id)
                       nil)))]
    (when (nil? restored)
      (drop-summary! page-id))
    restored))

(defn stashed-page-ids
  "Returns the ids of the pages kept in the cache, as a set."
  []
  (set (keys @entries)))

(defn restorable?
  "True when `restore!` would restore the stashed pool of `page-id` for
  `epoch`: the cache is enabled, WASM is ready and the entry matches the page
  version and the epoch. Makes no WASM call and changes no state."
  [page-id epoch]
  (let [entry (get @entries page-id)]
    (boolean
     (and (enabled?)
          (wasm/module-ready?)
          (some? entry)
          (= (:version entry) (version page-id))
          (= (:epoch entry) epoch)))))

(defn set-limits!
  "Sets how many pages the WASM page cache may keep, the largest weight one
  page may have and the total weight of all pages (see `pool_weight` in
  render-wasm). Calls `_set_page_cache_limits` when the WASM module is ready,
  then prunes the cache (see `sync-with-wasm!`). Returns nil."
  [max-pages max-page-weight max-weight]
  (when (wasm/module-ready?)
    (h/call wasm/internal-module "_set_page_cache_limits"
            max-pages max-page-weight max-weight)
    (sync-with-wasm!))
  nil)

;; The limits of a device with less than 8 GB of memory, or of unknown memory.
;; They match the DEFAULT_* constants in render-wasm/src/state/page_cache.rs.
(def ^:private default-limits
  [3 100000 200000])

;; The limits of a device that reports 8 GB or more of memory.
(def ^:private large-device-limits
  [3 400000 400000])

(defn device-limits
  "Returns the page cache limits `[max-pages max-page-weight max-weight]` for a
  device with `device-memory-gb` GB of memory, as `navigator.deviceMemory`
  reports it. Pass nil when the browser reports nothing.

  WASM memory does not shrink once it has grown, so every stashed page takes
  memory for good. The build lets the memory grow with no maximum, so the
  ceiling is the 2 GB of Emscripten's default, not 4 GB. Measured heap: 450 MB
  with the 73k-shape page, current or stashed, and about 835 MB in the worst
  case, after that page was evicted and uploaded again. Chrome reports 8 at
  most, so 8 means 8 GB or more. Other browsers report nothing, and they keep
  the small limits. A 73k-shape page with 28k texts weighs about 300k, so one
  page may weigh up to 400k. A total of 400k keeps at most one such page
  stashed."
  [device-memory-gb]
  (if (and (number? device-memory-gb)
           (>= device-memory-gb 8))
    large-device-limits
    default-limits))

(defn apply-device-limits!
  "Sets the page cache limits for this device, read from `navigator.deviceMemory`
  (see `device-limits`). Needs the WASM module ready, else `set-limits!` does
  nothing. Returns nil."
  []
  (let [memory (when (exists? js/navigator)
                 (some-> js/navigator .-deviceMemory))]
    (apply set-limits! (device-limits memory))
    nil))

(defn reset-state!
  "Resets all state to its start value. Does not call WASM. Meant for tests."
  []
  (reset! versions {})
  (reset! entries {})
  (reset! summaries {})
  (reset! resident nil)
  (reset! load-token 0)
  (reset! pending-syncs 0)
  nil)
