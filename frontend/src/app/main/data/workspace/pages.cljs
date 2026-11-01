;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.workspace.pages
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.helpers :as cfh]
   [app.common.geom.point :as gpt]
   [app.common.types.component :as ctc]
   [app.common.types.components-list :as ctkl]
   [app.common.types.container :as ctn]
   [app.common.types.objects-map :as omap]
   [app.common.types.page :as ctp]
   [app.common.types.shape-tree :as ctst]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.data.changes :as dch]
   [app.main.data.common :as dcm]
   [app.main.data.event :as ev]
   [app.main.data.helpers :as dsh]
   [app.main.data.persistence :as-alias dps]
   [app.main.data.workspace.drawing :as dwd]
   [app.main.data.workspace.fix-deleted-fonts :as fdf]
   [app.main.data.workspace.layout :as layout]
   [app.main.data.workspace.libraries :as dwl]
   [app.main.data.workspace.thumbnails :as dwth]
   [app.main.errors]
   [app.main.features :as features]
   [app.main.router :as rt]
   [app.main.store :as st]
   [app.main.worker :as mw]
   [app.render-wasm.api :as wasm.api]
   [app.render-wasm.shape :as wasm.shape]
   [app.util.http :as http]
   [app.util.i18n :as i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cljs.spec.alpha :as s]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(def default-workspace-local {:zoom 1})

(defn- select-frame-tool
  [file-id page-id]
  (ptk/reify ::select-frame-tool
    ptk/WatchEvent
    (watch [_ state _]
      (let [page (dsh/lookup-page state file-id page-id)]
        (when (ctp/is-empty? page)
          (rx/of (dwd/select-for-drawing :frame)))))))

(defn- shape-media-uri
  "Resolve the file media URI of a shape, if any"
  [{:keys [metadata fill-image]}]
  (cond
    (some? metadata)   (cf/resolve-file-media metadata)
    (some? fill-image) (cf/resolve-file-media fill-image)))

(def ^:private xf:collect-file-media
  "Resolve and collect all file media on page objects"
  (comp (map second)
        (keep shape-media-uri)))

(defn- get-page-cache
  [state file-id page-id]
  (dm/get-in state [:workspace-cache [file-id page-id]]))

;; --- Idle pre-decode of neighbour pages
;;
;; Page objects arrive as an `ObjectsMap`: each shape is decoded on first
;; lookup and cached on that map. The first visit to a page decodes every
;; shape in one synchronous task (~2 s on a 30-screen page). Looking up the
;; shapes of a neighbour page in idle time, once the current page is on
;; screen, moves that work off the page-switch path: `ctst/start-page-index`
;; carries the warmed cache over to the map it stores.
;;
;; The decoded cache lives on the map in state and is never evicted, so every
;; warmed page costs memory for as long as the file is open, whether the user
;; opens it or not. To bound that cost we warm only the next page (the most
;; likely switch), and only when it has fewer than `warmup-max-shapes` shapes.
;; The previous page is warmed as well only when it is small (fewer than
;; `warmup-prev-max-shapes`), where the memory is cheap. Larger pages keep the
;; slow first switch in exchange for the memory saved.

(def ^:private ^:const warmup-max-shapes 15000)
(def ^:private ^:const warmup-prev-max-shapes 5000)

;; Upper bound of work per idle callback, so input stays responsive.
(def ^:private ^:const warmup-slice-ms 8)

(defn- warmup-targets
  "Pages to warm next to `page-id`, as `[page-id max-shapes]` pairs: the next
  page in sitemap order, then the previous one under a lower cap."
  [pages page-id]
  (let [pages (vec pages)
        index (d/index-of pages page-id)]
    (if (some? index)
      (into []
            (keep (fn [[i max-shapes]]
                    (when-let [id (nth pages i nil)]
                      [id max-shapes])))
            [[(inc index) warmup-max-shapes]
             [(dec index) warmup-prev-max-shapes]])
      [])))

(defn- warmup-objects?
  "True when `objects` is a lazy objects map with fewer than `max-shapes`
  shapes."
  [objects max-shapes]
  (and (omap/objects-map? objects)
       (< (count objects) max-shapes)))

(defn- current-page?
  [page-id]
  (= page-id (:current-page-id @st/state)))

(defn- dom?
  "True when there is a DOM `document` (false in the Node test runner and in
  workers)."
  []
  (exists? js/document))

(defn- document-events
  "Returns an observable of the `event-name` events of the document, or an
  empty one when there is no DOM."
  [event-name]
  (if (dom?)
    (rx/from-event js/document event-name)
    (rx/empty)))

(defn- page-stopper
  "Returns an observable that emits when the waits started on a page init
  must end: on `finalize-page`, or on the next `initialize-page` of any
  page, since the version flows initialize the page again without
  finalizing it first."
  [stream]
  (rx/filter (fn [event]
               (let [type (ptk/type event)]
                 (or (= type ::finalize-page)
                     (= type ::initialize-page))))
             stream))

(defn- after-page-upload
  "Returns an observable that emits once, when the latest load of `page-id`
  into WASM ends (a `penpot:wasm:set-objects` event that names the page and
  the latest load token, see `wasm.api/page-upload-event?`) and no other
  upload is running, while `page-id` is the current page. A late event of
  the page we left, of an older load or of a thumbnail render is ignored.
  Empty when there is no DOM."
  [page-id]
  (->> (document-events "penpot:wasm:set-objects")
       (rx/filter (fn [event]
                    (and (wasm.api/page-upload-event? event page-id)
                         (current-page? page-id)
                         (not @wasm.api/shapes-loading?))))
       (rx/take 1)))

(defn- decode-in-idle
  "Returns an observable that looks up every shape of the `targets` pages
  (from `warmup-targets`), decoding and caching it on the page's objects map,
  during browser idle periods. Each page is read from the current state when
  its turn comes, and read again at each idle callback. Stops when
  `page-id` is no longer the current page. Completes when done; disposing it
  cancels the pending idle callback."
  [file-id page-id targets]
  (rx/create
   (fn [subs]
     (let [targets (volatile! (seq targets))
           target  (volatile! nil)
           objects (volatile! nil)
           ids     (volatile! nil)
           done?   (volatile! false)
           handle  (volatile! nil)]
       (letfn [(next-page! []
                 ;; Moves to the next page worth warming; false when none left.
                 (loop []
                   (if-let [[target-id max-shapes :as item] (first @targets)]
                     (let [objs (dsh/lookup-page-objects @st/state file-id target-id)]
                       (vswap! targets next)
                       (if (warmup-objects? objs max-shapes)
                         (do
                           (vreset! target item)
                           (vreset! objects objs)
                           (vreset! ids (seq (keys objs)))
                           true)
                         (recur)))
                     false)))

               (refresh! []
                 ;; The page may change while we warm it (remote edit,
                 ;; component sync). Its new map carries the decodes done so
                 ;; far, so switch to it and go on with the remaining ids.
                 (when-let [[target-id max-shapes] @target]
                   (let [objs (dsh/lookup-page-objects @st/state file-id target-id)]
                     (when-not (identical? objs @objects)
                       (if (warmup-objects? objs max-shapes)
                         (vreset! objects objs)
                         (vreset! ids nil))))))

               (step [^js deadline]
                 (if (current-page? page-id)
                   (refresh!)
                   (vreset! done? true))
                 (let [start (js/performance.now)]
                   (loop []
                     (when (and (not @done?)
                                (> (.timeRemaining deadline) 1)
                                (< (- (js/performance.now) start) warmup-slice-ms))
                       (if-let [id (first @ids)]
                         (do
                           (get @objects id)
                           (vswap! ids next))
                         (when-not (next-page!)
                           (vreset! done? true)))
                       (recur))))
                 (if @done?
                   (rx/end! subs)
                   (vreset! handle (js/requestIdleCallback step))))]

         (vreset! handle (js/requestIdleCallback step))
         (fn []
           (vreset! done? true)
           (some-> @handle js/cancelIdleCallback)))))))

(defn- warm-neighbour-pages
  "Pre-decodes the neighbour pages of `page-id` in idle time, starting after
  the first full frame of this page. Stops when the page is finalized or a
  page is initialized again (see `page-stopper`)."
  [file-id page-id]
  (ptk/reify ::warm-neighbour-pages
    ptk/WatchEvent
    (watch [_ state stream]
      (let [pages   (:pages (dsh/lookup-file-data state file-id))
            targets (warmup-targets pages page-id)
            stopper (page-stopper stream)]
        (if (and (seq targets)
                 (dom?)
                 (exists? js/requestIdleCallback))
          ;; Wait for this page's shapes to be in WASM and its first full
          ;; frame, so the warm-up never competes with them.
          (->> (after-page-upload page-id)
               (rx/mapcat (fn [_]
                            (->> (document-events "penpot:wasm:tiles-complete")
                                 (rx/take 1))))
               (rx/mapcat (fn [_] (decode-in-idle file-id page-id targets)))
               (rx/take-until stopper)
               (rx/ignore))
          (rx/empty))))))

;; --- Page-init work kept off the WASM upload
;;
;; On page init the WASM renderer uploads the page in chunks, each one
;; decoding only its own shapes (see `wasm.api/set-objects`). Any walk over
;; every shape before that upload decodes the whole page in one task, so the
;; walks below wait for the upload instead.

(defn- request-idle!
  "Calls `f` with the deadline of the next browser idle period, or with nil
  after a short timeout where idle callbacks are not supported. Returns a
  function that cancels the call."
  [f]
  (if (exists? js/requestIdleCallback)
    (let [id (js/requestIdleCallback f)]
      #(js/cancelIdleCallback id))
    (let [id (js/setTimeout #(f nil) 50)]
      #(js/clearTimeout id))))

(defn- shapes-in-idle
  "Returns an observable that emits every shape of `objects`, looking them
  up during browser idle periods, at most `warmup-slice-ms` per period, and
  then completes. Disposing it cancels the pending idle callback."
  [objects]
  (rx/create
   (fn [subs]
     (let [ids    (volatile! (seq (keys objects)))
           cancel (volatile! nil)]
       (letfn [(step [^js deadline]
                 (let [start (js/performance.now)]
                   (loop []
                     (when (and (seq @ids)
                                (or (nil? deadline)
                                    (> (.timeRemaining deadline) 1))
                                (< (- (js/performance.now) start) warmup-slice-ms))
                       (let [id (first @ids)]
                         (vswap! ids next)
                         (when-let [shape (get objects id)]
                           (rx/push! subs shape)))
                       (recur))))
                 (if (seq @ids)
                   (vreset! cancel (request-idle! step))
                   (rx/end! subs)))]

         (vreset! cancel (request-idle! step))
         (fn []
           (vreset! ids nil)
           (when-let [cancel-fn @cancel]
             (cancel-fn))))))))

(defn- prefetch-page-media
  "Fetches the media of the page shapes as data URIs, which fills the cache
  of `http/fetch-data-uri` (used by SVG rendering, exports and the code
  view). The WASM renderer loads its own images, so this waits for the
  first full frame of the page and reads the shapes in idle time instead of
  decoding the whole page before its upload. Stops when the page is
  finalized or a page is initialized again (see `page-stopper`). Does
  nothing when there is no DOM."
  [file-id page-id]
  (ptk/reify ::prefetch-page-media
    ptk/WatchEvent
    (watch [_ _ stream]
      (let [stopper (page-stopper stream)]
        (->> (after-page-upload page-id)
             (rx/mapcat (fn [_]
                          (->> (document-events "penpot:wasm:tiles-complete")
                               (rx/take 1))))
             (rx/mapcat
              (fn [_]
                (let [seen (volatile! #{})]
                  (->> (shapes-in-idle (dsh/lookup-page-objects @st/state file-id page-id))
                       (rx/map shape-media-uri)
                       (rx/filter (fn [uri]
                                    (when (and (some? uri) (not (contains? @seen uri)))
                                      (vswap! seen conj uri)
                                      true)))
                       (rx/map #(http/fetch-data-uri % false))))))
             (rx/take-until stopper)
             (rx/ignore))))))

;; Below this many shapes the deleted-fonts fix runs on page init, before
;; the upload, as in the SVG renderer: decoding such a page is cheap.
(def ^:private ^:const defer-fonts-fix-min-shapes 1000)

(defn- fix-deleted-fonts-on-load
  "Runs `fdf/fix-deleted-fonts-for-page` for the WASM renderer. On a large
  page it waits until the page is uploaded, when its shapes are already
  decoded, and writes the fixed texts to WASM as well, in one commit. A text
  under edition by then is left as it is (see `fdf/fix-deleted-fonts-for-page`).
  Stops when the page is finalized or a page is initialized again (see
  `page-stopper`). Without a DOM (tests) there is no upload to wait for, so
  it runs at once."
  [file-id page-id]
  (ptk/reify ::fix-deleted-fonts-on-load
    ptk/WatchEvent
    (watch [_ state stream]
      (if (or (not (dom?))
              (< (count (dsh/lookup-page-objects state file-id page-id))
                 defer-fonts-fix-min-shapes))
        (rx/of (fdf/fix-deleted-fonts-for-page file-id page-id))
        (let [stopper (page-stopper stream)]
          (->> (after-page-upload page-id)
               (rx/map (fn [_]
                         (fdf/fix-deleted-fonts-for-page file-id page-id
                                                         {:ignore-wasm? false})))
               (rx/take-until stopper)))))))

(defn- initialize-page*
  "Second phase of page initialization, once we know the page is
  available in the state"
  [file-id page-id]
  (ptk/reify ::initialize-page*
    ptk/UpdateEvent
    (update [_ state]
      (let [state (dsh/update-page state file-id page-id #(update % :objects ctst/start-page-index))
            page  (dsh/lookup-page state file-id page-id)
            local (or (get-page-cache state file-id page-id) default-workspace-local)]

        (-> state
            (assoc :current-page-id page-id)
            (assoc :workspace-local (assoc local :selected (d/ordered-set)))
            (assoc :workspace-trimmed-page (dm/select-keys page [:id :name]))

            ;; FIXME: this should be done on `initialize-layout` (?)
            (update :workspace-layout layout/load-layout-flags)
            (update :workspace-global layout/load-layout-state))))

    ptk/WatchEvent
    (watch [_ state _]
      (let [page (dsh/lookup-page state file-id page-id)]
        (when (features/active-feature? state "render-wasm/v1")
          (wasm.api/prewarm-upload-workers! (:objects page) page-id))
        (rx/merge
         (rx/of (ptk/data-event ::initialized page-id))
         ;; With the WASM renderer `prefetch-page-media` does this after
         ;; the first frame, without decoding the page up front.
         (if (features/active-feature? state "render-wasm/v1")
           (rx/empty)
           (->> (rx/from (into #{} xf:collect-file-media (:objects page)))
                (rx/map #(http/fetch-data-uri % false))
                (rx/ignore)))
         (->> (mw/ask! (if (omap/objects-map? (:objects page))
                         ;; Send the raw shape strings beside the message:
                         ;; transit would escape each one a second time.
                         {:cmd :index/initialize
                          :page (dissoc page :objects)
                          :raw (omap/raw-entries (:objects page))}
                         {:cmd :index/initialize :page page}))
              (rx/ignore)))))))

(defn initialize-page
  [file-id page-id]
  (assert (uuid? file-id) "expected valid uuid for `file-id`")
  (assert (uuid? page-id) "expected valid uuid for `page-id`")

  (ptk/reify ::initialize-page
    ptk/WatchEvent
    (watch [_ state _]
      (if (dsh/lookup-page state file-id page-id)
        (rx/concat
         (rx/of (initialize-page* file-id page-id))

         ;; Disable thumbnail generation in wasm renderer; warm the
         ;; neighbour pages instead (see `warm-neighbour-pages`). Keep the
         ;; walks over every shape off the upload (see
         ;; `prefetch-page-media` and `fix-deleted-fonts-on-load`).
         (if (features/active-feature? state "render-wasm/v1")
           (rx/of (fix-deleted-fonts-on-load file-id page-id)
                  (warm-neighbour-pages file-id page-id)
                  (prefetch-page-media file-id page-id))
           (rx/of (fdf/fix-deleted-fonts-for-page file-id page-id)
                  (dwth/watch-state-changes file-id page-id)))

         (rx/of (dwl/watch-component-changes))
         (rx/of (dwl/watch-token-changes))

         (let [profile (:profile state)
               props   (get profile :props)]
           (when (not (:workspace-visited props))
             (rx/of (select-frame-tool file-id page-id)))))

        ;; NOTE: this redirect is necessary for cases where user
        ;; explicitly passes an non-existing page-id on the url
        ;; params, so on check it we can detect that there are no data
        ;; for the page and redirect user to an existing page
        (rx/of (dcm/go-to-workspace :file-id file-id ::rt/replace true))))))

(defn finalize-page
  [file-id page-id]
  (assert (uuid? file-id) "expected valid uuid for `file-id`")
  (assert (uuid? page-id) "expected valid uuid for `page-id`")

  (ptk/reify ::finalize-page
    ptk/UpdateEvent
    (update [_ state]
      (let [local (-> (:workspace-local state)
                      (dissoc :edition :edit-path :selected
                              :selected-pages :selected-pages-anchor))
            exit? (not= :workspace (rt/lookup-name state))
            state (-> state
                      (update :workspace-cache assoc [file-id page-id] local)
                      (dissoc :current-page-id
                              :workspace-local
                              :workspace-trimmed-page
                              :workspace-focus-selected))]

        (cond-> state
          exit? (dissoc :workspace-drawing))))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; Workspace Page CRUD
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn update-page-root
  [file-id page-id]
  (ptk/reify ::update-page-root
    ptk/UpdateEvent
    (update [_ state]
      (-> state
          (update-in [:files file-id :data :pages-index page-id :objects uuid/zero] wasm.shape/create-shape)))))

(defn create-page
  [{:keys [page-id file-id]}]
  (let [id (or page-id (uuid/next))]
    (ptk/reify ::create-page
      ev/Event
      (-data [_]
        {:id id
         :file-id file-id})

      ptk/WatchEvent
      (watch [it state _]
        (let [pages   (-> (dsh/lookup-file-data state)
                          (get :pages-index))
              unames  (cfh/get-used-names pages)
              name    (cfh/generate-unique-name "Page" unames :immediate-suffix? true)
              changes (-> (pcb/empty-changes it)
                          (pcb/add-empty-page id name))]

          (rx/concat
           (rx/of (dch/commit-changes changes))
           (if (features/active-feature? state "render-wasm/v1")
             (rx/of (update-page-root file-id id))
             (rx/empty))))))))

(defn duplicate-page
  [page-id]
  (ptk/reify ::duplicate-page
    ptk/WatchEvent
    (watch [it state _]
      (let [new-page-id        (uuid/next)
            fdata              (dsh/lookup-file-data state)
            pages              (get fdata :pages-index)
            page               (get pages page-id)

            unames             (cfh/get-used-names pages)
            suffix-fn          (fn [copy-count]
                                 (str/concat " "
                                             (tr "dashboard.copy-suffix")
                                             (when (> copy-count 1)
                                               (str " " copy-count))))
            base-name          (:name page)
            name               (cfh/generate-unique-name base-name unames :suffix-fn suffix-fn)
            objects            (update-vals (:objects page) #(dissoc % :use-for-thumbnail))

            main-not-variant-ids (set (keep #(when (and (ctc/main-instance? (val %)) (not (ctc/is-variant? (val %))))
                                               (key %)) objects))
            ids-to-remove      (set (apply concat (map #(cfh/get-children-ids objects %) main-not-variant-ids)))

            add-component-copy
            (fn [objs id shape]
              (let [component (ctkl/get-component fdata (:component-id shape))
                    parent-id (when (not= (:parent-id shape) uuid/zero) (:parent-id shape))
                    [new-shape new-shapes]
                    (ctn/make-component-instance page
                                                 component
                                                 fdata
                                                 (gpt/point (:x shape) (:y shape))
                                                 {:keep-ids? true
                                                  :force-frame-id (:frame-id shape)
                                                  :force-parent-id parent-id})
                    children (into {} (map (fn [shape] [(:id shape) shape]) new-shapes))
                    objs (assoc objs id new-shape)]
                (merge objs children)))

            ;; List of the shapes that are a variant component main
            variant-mains    (->> objects
                                  vals
                                  (filter ctc/is-variant?))

            ;; Map ids of several variants related old ids to new
            variants-ids-map (->> variant-mains
                                  (reduce (fn [ids-map shape]
                                            (assoc ids-map
                                                   (:id shape) (uuid/next)
                                                   (:component-id shape) (uuid/next)
                                                   (:variant-id shape) (uuid/next)))
                                          {}))

            update-variant-values
            (fn [shape]
              (let [new-shape (cond-> shape
                                (contains? shape :component-id)
                                (assoc :component-id (get variants-ids-map (:component-id shape)))
                                (contains? shape :variant-id)
                                (assoc :variant-id (get variants-ids-map (:variant-id shape))))]
                new-shape))

            add-comp
            (fn [changes main]
              (let [new-component-id (get variants-ids-map (:component-id main))
                    new-variant-id   (get variants-ids-map (:variant-id main))
                    main-instance-id (get variants-ids-map (:id main))
                    component        (ctkl/get-component fdata (:component-id main))]
                (pcb/add-component changes
                                   new-component-id
                                   (:path component)
                                   (:name component)
                                   []
                                   main-instance-id
                                   new-page-id
                                   (:annotation component)
                                   new-variant-id
                                   (:variant-properties component))))

            ;; Generate the new page objects from the old page objects
            objects
            (reduce
             (fn [objs [id shape]]
               (cond
                 ;; If it is a component main (and not a variant) we don't want to
                 ;; copy it. We want to instanciate (copy) it
                 (contains? main-not-variant-ids id)
                 (add-component-copy objs id shape)

                 ;; If it is in the remove list, ignore it
                 (contains? ids-to-remove id)
                 objs

                 ;; If it is a variant-container or a variant component,
                 ;; update its values to new ids
                 (contains? variants-ids-map id)
                 (assoc objs id (update-variant-values shape))

                 ;; In other case, simply copy it
                 :else
                 (assoc objs id shape)))
             {}
             objects)

            ;; Remap parents and childs with the new ids generated for variants
            objects
            (reduce-kv
             (fn [objs _ {:keys [id parent-id frame-id] :as shape}]
               (assoc objs
                      (get variants-ids-map id id)
                      (-> shape
                          (assoc :id (get variants-ids-map id id))
                          (assoc :parent-id (get variants-ids-map parent-id parent-id))
                          (assoc :frame-id (get variants-ids-map frame-id frame-id))
                          (cond->
                           (contains? shape :shapes)
                            (assoc :shapes (mapv #(get variants-ids-map % %) (:shapes shape)))))))
             {}
             objects)

            page    (-> page
                        (assoc :name name)
                        (assoc :id new-page-id)
                        (assoc :objects
                               objects))

            changes (-> (pcb/empty-changes it)
                        (pcb/add-page new-page-id page)
                        (pcb/with-page page)
                        (pcb/with-objects objects)
                        ;; Create new components for each duplicated variant main
                        (as-> changes
                              (reduce add-comp changes variant-mains)))]
        (rx/of (dch/commit-changes changes))))))

(s/def ::rename-page
  (s/keys :req-un [::id ::name]))

(defn rename-page
  [id name]
  (dm/assert! (uuid? id))
  (dm/assert! (string? name))
  (ptk/reify ::rename-page
    ptk/WatchEvent
    (watch [it state _]
      (let [page             (dsh/lookup-page state id)
            objects          (:objects page)
            empty-page?       (and (= 1 (count objects))
                                   (= uuid/zero (first (keys objects))))
            changes          (-> (pcb/empty-changes it)
                                 (pcb/with-page page)
                                 (pcb/mod-page page {:name name}))
            pages            (-> (dsh/lookup-file-data state) :pages)
            index            (d/index-of pages id)
            prev-id          (when (and (some? index) (pos? index))
                               (nth pages (dec index) nil))
            next-id          (when (some? index)
                               (nth pages (inc index) nil))
            fallback-page-id (or prev-id next-id)
            separator?       (= "---" (str/trim name))]
        (rx/concat
         (rx/of (dch/commit-changes changes))
         ;; Go to other page only if page is empty (only has the root shape)
         ;; and the separator page is being renamed, otherwise user can rename
         ;; any page to separator and be forced to go to another page
         (when (and separator?
                    empty-page?
                    (= id (:current-page-id state))
                    (some? fallback-page-id))
           (rx/of (dcm/go-to-workspace :page-id fallback-page-id))))))))

(defn- delete-page-components
  [changes page]
  (let [components-to-delete (->> page
                                  :objects
                                  vals
                                  (filter #(true? (:main-instance %)))
                                  (map :component-id))

        changes (reduce (fn [changes component-id]
                          (pcb/delete-component changes component-id (:id page)))
                        changes
                        components-to-delete)]
    changes))

(defn delete-page
  [id]
  (ptk/reify ::delete-page
    ptk/WatchEvent
    (watch [it state _]
      (let [file-id (:current-file-id state)
            fdata   (dsh/lookup-file-data state file-id)
            pindex  (:pages-index fdata)
            pages   (:pages fdata)

            index   (d/index-of pages id)
            page    (get pindex id)]

        (if (nil? page)
          (rx/empty)
          (let [page    (assoc page :index index)
                pages   (filter #(not= % id) pages)

                changes (-> (pcb/empty-changes it)
                            (pcb/with-library-data fdata)
                            (delete-page-components page)
                            (pcb/del-page page))]

            (rx/of (dch/commit-changes changes)
                   (when (= id (:current-page-id state))
                     (dcm/go-to-workspace {:page-id (first pages)})))))))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; Page selection (sitemap multi-selection)
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn clear-page-selection
  "Clear the sitemap multi-selection state."
  []
  (ptk/reify ::clear-page-selection
    ptk/UpdateEvent
    (update [_ state]
      (update state :workspace-local dissoc :selected-pages :selected-pages-anchor))))

(defn select-page
  "Set the sitemap selection to a single page (plain click). It also
  sets the anchor used by range (shift+click) selection."
  [id]
  (ptk/reify ::select-page
    ptk/UpdateEvent
    (update [_ state]
      (update state :workspace-local assoc
              :selected-pages (d/ordered-set id)
              :selected-pages-anchor id))))

(defn toggle-page-selection
  "Add or remove a page from the sitemap multi-selection (ctrl/cmd + click)."
  [id]
  (ptk/reify ::toggle-page-selection
    ptk/UpdateEvent
    (update [_ state]
      (let [current-id (:current-page-id state)
            selected   (or (not-empty (dm/get-in state [:workspace-local :selected-pages]))
                           (d/ordered-set current-id))
            selected   (if (contains? selected id)
                         (disj selected id)
                         (conj selected id))]
        (update state :workspace-local assoc
                :selected-pages selected
                :selected-pages-anchor id)))))

(defn select-pages-range
  "Select every page between the current anchor and `id`, both included
  (shift + click). The anchor is kept unchanged."
  [id]
  (ptk/reify ::select-pages-range
    ptk/UpdateEvent
    (update [_ state]
      (let [current-id (:current-page-id state)
            pages      (-> (dsh/lookup-file-data state) :pages vec)
            anchor     (or (dm/get-in state [:workspace-local :selected-pages-anchor])
                           current-id)
            a-idx      (d/index-of pages anchor)
            b-idx      (d/index-of pages id)]
        (if (and (some? a-idx) (some? b-idx))
          (let [start (min a-idx b-idx)
                end   (inc (max a-idx b-idx))
                range (subvec pages start end)]
            (update state :workspace-local assoc
                    :selected-pages (into (d/ordered-set) range)))
          state)))))

(defn delete-pages
  "Delete a collection of pages in a single change (single undo entry),
  always keeping at least one page in the file."
  [ids]
  (ptk/reify ::delete-pages
    ptk/WatchEvent
    (watch [it state _]
      (let [file-id (:current-file-id state)
            fdata   (dsh/lookup-file-data state file-id)
            pindex  (:pages-index fdata)
            pages   (:pages fdata)

            ids     (set ids)
            ;; A file must keep at least one page: if every page is
            ;; selected, keep the first one in page order.
            ids     (if (>= (count ids) (count pages))
                      (set (rest (filter ids pages)))
                      ids)

            ;; Pages to delete, in page order.
            del-ids   (filter ids pages)
            remaining (remove ids pages)

            changes (reduce
                     (fn [changes id]
                       (let [page (-> (get pindex id)
                                      (assoc :index (d/index-of pages id)))]
                         (-> changes
                             (delete-page-components page)
                             (pcb/del-page page))))
                     (-> (pcb/empty-changes it)
                         (pcb/with-library-data fdata))
                     (reverse del-ids))]

        (if (empty? del-ids)
          (rx/empty)
          (rx/of (dch/commit-changes changes)
                 (clear-page-selection)
                 (when (contains? ids (:current-page-id state))
                   (dcm/go-to-workspace {:page-id (first remaining)}))))))))
