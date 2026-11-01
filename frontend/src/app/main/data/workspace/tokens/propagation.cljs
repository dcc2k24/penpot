;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.workspace.tokens.propagation
  (:require
   [app.common.data :as d]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.helpers :as cfh]
   [app.common.files.tokens :as cfo]
   [app.common.logging :as l]
   [app.common.logic.shapes :as cls]
   [app.common.time :as ct]
   [app.common.types.fills :as types.fills]
   [app.common.types.shape.radius :as ctsr]
   [app.common.types.text :as txt]
   [app.common.types.token :as ctt]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.data.changes :as dch]
   [app.main.data.helpers :as dsh]
   [app.main.data.persistence :as-alias dps]
   [app.main.data.style-dictionary :as sd]
   [app.main.data.tokenscript :as ts]
   [app.main.data.workspace.colors :as wdc]
   [app.main.data.workspace.reflow.signals :as wrfs]
   [app.main.data.workspace.shapes :as dwsh]
   [app.main.data.workspace.texts :as dwtx]
   [app.main.data.workspace.thumbnails :as dwt]
   [app.main.data.workspace.tokens.application :as dwta]
   [app.main.data.workspace.undo :as dwu]
   [app.main.store :as st]
   [beicon.v2.core :as rx]
   [clojure.data :as data]
   [clojure.set :as set]
   [potok.v2.core :as ptk]))

;; Change this to :info :debug or :trace to debug this module, or :warn to reset to default
(l/set-level! :warn)

;; Helpers ---------------------------------------------------------------------

;; TODO: see if this can be replaced by more standard functions
(defn deep-merge
  "Like d/deep-merge but unions set values."
  ([a b]
   (cond
     (map? a) (merge-with deep-merge a b)
     (set? a) (set/union a b)
     :else b))
  ([a b & rest]
   (reduce deep-merge a (cons b rest))))

(defn- flatten-set-keyed-map
  "Flattens a map where the keys are sets of keywords."
  [m into-m]
  (reduce
   (fn [acc [ks action]]
     (into acc (map (fn [k] [k action]) ks)))
   into-m m))

;; Constants -------------------------------------------------------------------

(def commit-tag
  "Tag of the commits that apply token values with a pure update (see
  `fast-actions`). The component watcher does not sync the copies of the
  components these commits change: the same commits already gave every
  copy its value (see `app.main.data.workspace.libraries/watch-component-changes`)."
  :token-propagation)

(def budget-ms
  "Work done before the propagation lets the browser run (render, input)."
  80)

(def min-shapes
  "Shapes visited before the propagation may yield. Small files never yield,
  so they update in one go as before."
  50)

(def scan-budget-ms
  "Part of a step spent reading shapes before building their changes."
  20)

(def build-budget-ms
  "Part of a step spent building changes; shapes read but not built yet wait
  for the next step."
  60)

(def ^:private max-pending
  "Shapes read and waiting to be built above which a step reads no more."
  200)

(def ^:private persist-interval-ms
  "How often a long run asks persistence to send what it has, so the saves
  are spread over the run instead of one large save at the end."
  2000)

(def ^:private filter-existing-values? false)

(def ^:private attributes->shape-update dwta/attributes->shape-update)

(def ^:private attribute-actions-map
  (flatten-set-keyed-map attributes->shape-update {}))

;; Data flows ------------------------------------------------------------------

(defn- invert-collect-key-vals
  [xs resolved-tokens shape]
  (-> (reduce
       (fn [acc [k v]]
         (let [resolved-token (get resolved-tokens v)
               resolved-value (get resolved-token :resolved-value)
               skip? (or
                      (not (get resolved-tokens v))
                      (and filter-existing-values? (= (get shape k) resolved-value)))]
           (if skip?
             acc
             (update acc resolved-value (fnil conj #{}) k))))
       {} xs)))

(defn- split-attribute-groups [attrs-values-map]
  (reduce
   (fn [acc [attrs v]]
     (cond
       (some attrs #{:width :height}) (let [[_ a b] (data/diff #{:width :height} attrs)]
                                        (cond-> (assoc acc b v)
                                          ;; Exact match in attrs
                                          a (assoc a v)))
       (some attrs ctt/spacing-keys) (let [[_ rst gap] (data/diff #{:row-gap :column-gap} attrs)
                                           [_ position padding] (data/diff #{:p1 :p2 :p3 :p4} rst)]
                                       (cond-> acc
                                         (seq gap) (assoc gap v)
                                         (seq position) (assoc position v)
                                         (seq padding) (assoc padding v)))
       attrs (assoc acc attrs v)))
   {} attrs-values-map))

(defn- shape-ids-by-values
  [attrs-values-map object-id]
  (->> (map (fn [[value attrs]] [attrs {value #{object-id}}]) attrs-values-map)
       (into {})))

(defn- actionize-shapes-update-info [page-id shapes-update-info]
  (mapcat (fn [[attrs update-infos]]
            (let [action (some attribute-actions-map attrs)]
              (assert (fn? action) "missing action function on attributes->shape-update")
              (map
               (fn [[v shape-ids]]
                 (action v shape-ids attrs page-id))
               update-infos)))
          shapes-update-info))

;; Shape updates without events ------------------------------------------------
;;
;; While the update buffer is on, `dwsh/update-shapes` only appends
;; `cls/generate-update-shapes` (objects nil, so no grid reassignment) and,
;; with `:reg-objects?`, `pcb/resize-parents`. These functions append the
;; same changes for the token kinds below, without one event per update.

(defn- update-shapes*
  [changes ids update-fn {:keys [reg-objects? attrs ignore-touched changed-sub-attr]}]
  (cond-> (cls/generate-update-shapes changes ids update-fn nil
                                      {:attrs attrs
                                       :changed-sub-attr changed-sub-attr
                                       :ignore-touched ignore-touched})
    reg-objects?
    (pcb/resize-parents ids)))

(defn- position-data-follows-fills?
  "True when a fill update of the text `shape` can be applied to its
  position data in place: every text node has its own fills and no legacy
  colour keys (so `dwtx/migrate-node` leaves it alone), and every position
  data entry carries the fills of some text node. The layout does not
  depend on colours, so the regenerated position data would be this one
  with the new fills."
  [shape]
  (let [position-data (get shape :position-data)]
    (boolean
     (and (seq position-data)
          (let [nodes (txt/node-seq txt/is-text-node? (get shape :content))
                fills (mapv :fills nodes)]
            (and (seq nodes)
                 (every? (fn [node]
                           (and (some? (:fills node))
                                (empty? (select-keys node types.fills/fill-attrs))))
                         nodes)
                 (every? (fn [entry]
                           (some #(= (:fills entry) %) fills))
                         position-data)))))))

(defn- content-migrated?
  "True when `dwtx/migrate-content` would leave every node of `content` as it
  is: every text and paragraph node has its own fills and no legacy colour
  keys. Skipping it then gives the same content, with one walk less."
  [content]
  (every? (fn [node]
            (and (some? (:fills node))
                 (empty? (select-keys node types.fills/fill-attrs))))
          (txt/node-seq (some-fn txt/is-text-node? txt/is-paragraph-node?) content)))

(defn- update-text-fill
  "What `dwtx/update-text-with-function` does to a text when no editor is
  open, with `#(wdc/assoc-shape-fill % 0 fill)` as node function. With
  `position-data?`, the position data gets the same fill change."
  [shape fill position-data?]
  (let [update-node? (some-fn txt/is-text-node? txt/is-paragraph-node?)
        update-node  #(wdc/assoc-shape-fill % 0 fill)
        shape'       (-> shape
                         (dissoc :fills)
                         (d/update-when :content
                                        (fn [content]
                                          (->> (cond-> content
                                                 (not (content-migrated? content))
                                                 (dwtx/migrate-content))
                                               (txt/transform-nodes update-node? update-node)))))]
    (if (and position-data? (seq (:position-data shape)))
      (assoc shape' :position-data
             (mapv #(update % :fills types.fills/assoc 0 fill)
                   (:position-data shape)))
      shape')))

(defn- fill-changes
  "Same as `dwta/update-fill`."
  [changes value ids {:keys [position-data?]}]
  (if-let [color (dwta/value->color value)]
    (let [fill    (wdc/color->fill color)
          objects (pcb/lookup-objects changes)
          [text-ids shape-ids] (dsh/split-text-shapes objects ids)
          changes (reduce (fn [changes id]
                            (update-shapes* changes [id]
                                            #(update-text-fill % fill position-data?)
                                            {:ignore-touched true}))
                          changes
                          text-ids)]
      (update-shapes* changes shape-ids #(wdc/assoc-shape-fill % 0 fill)
                      {:ignore-touched true}))
    changes))

(defn- stroke-color-changes
  "Same as `dwta/update-stroke-color`."
  [changes value ids]
  (if-let [color (dwta/value->color value)]
    (update-shapes* changes ids #(wdc/update-shape-stroke-color % 0 color)
                    {:ignore-touched true
                     :changed-sub-attr [:stroke-color]})
    changes))

(defn- fill-stroke-changes
  "Same as `dwta/update-fill-stroke`."
  [changes value ids attributes ctx]
  (cond-> changes
    (:fill attributes)
    (fill-changes value ids ctx)

    (:stroke-color attributes)
    (stroke-color-changes value ids)))

(defn- radius-changes
  "Same as `dwta/update-shape-radius-for-corners`."
  [changes value ids attributes _ctx]
  (if (number? value)
    (let [value (max 0 value)]
      (update-shapes* changes ids #(ctsr/set-radius-for-corners % attributes value)
                      {:reg-objects? true
                       :ignore-touched true
                       :attrs ctt/border-radius-keys}))
    changes))

(defn- opacity-changes
  "Same as `dwta/update-opacity`."
  [changes value ids _attributes _ctx]
  (if (<= 0 value 1)
    (update-shapes* changes ids #(assoc % :opacity value)
                    {:ignore-touched true})
    changes))

(defn- stroke-width-changes
  "Same as `dwta/update-stroke-width-side`."
  [changes value ids attributes _ctx]
  (if (number? value)
    (update-shapes* changes ids #(dwta/set-stroke-width-side % attributes value)
                    {:reg-objects? true
                     :ignore-touched true
                     :attrs [:strokes]})
    changes))

(defn- shadow-changes
  "Same as `dwta/update-shadow`. `dwta/value->shadow` makes new shadow ids
  on each call; `shadows` calls it once per value for the whole run, so a
  main and its copies share the ids."
  [changes value ids _attributes {:keys [shadows]}]
  (if (sequential? value)
    (let [shadow (shadows value)]
      (update-shapes* changes ids #(assoc % :shadow shadow)
                      {:reg-objects? true
                       :ignore-touched true
                       :attrs [:shadow]}))
    changes))

(def ^:private fast-actions
  "Update functions with a pure counterpart above. They change no geometry,
  layout or text layout, and each one gives a shape a value that depends
  only on that shape and the token value."
  {dwta/update-fill-stroke              fill-stroke-changes
   dwta/update-shape-radius-for-corners radius-changes
   dwta/update-opacity                  opacity-changes
   dwta/update-stroke-width-side        stroke-width-changes
   dwta/update-shadow                   shadow-changes})

;; Run -------------------------------------------------------------------------
;;
;; A run is a chain of `propagation-step` events, a pause (0 ms timer) between
;; them, so other events can come in between. To keep that safe:
;; - the run commits with `:save-undo? false` and adds one undo entry at the
;;   end (`finish-run`), so edits made during the run keep their own entries;
;;   undo and redo are locked while it runs (`dwu/lock-undo`);
;; - every shape is read again when its changes are built, and the event-path
;;   updates keep only ids, so edits made during the run are not overwritten;
;; - the component watcher holds back component changes while a run is active
;;   and replays them after `propagation-done` (see `running?`);
;; - a newer run, or a change of the tokens, closes the current run and the
;;   newer one propagates every page again;
;; - `finish-propagation` completes the run at once, before the file closes
;;   or a version is saved.

(defn- now [] (js/performance.now))

(defn- yield?
  [{:keys [since-yield yield-start unbounded?]}]
  (and (not unbounded?)
       (>= since-yield min-shapes)
       (> (- (now) yield-start) budget-ms)))

(defn running?
  "True while a propagation run is active."
  [state]
  (some? (get state ::active-run)))

(defn done-event?
  "True for the event that ends a propagation run."
  [event]
  (= ::propagation-done (ptk/type event)))

(defn- text-editor-open?
  "While a text editor is open, a text update also goes to the editor, so
  everything takes the event path."
  [state]
  (or (some? (get-in state [:workspace-local :edition]))
      (some? (get state :workspace-editor))
      (d/not-empty? (get state :workspace-editor-state))))

(defn- shape-update-groups
  "The update groups of one shape, `{attrs {value #{id}}}`, as the old
  page-wide collection merged them: one group per set of attributes that
  share a resolved value."
  [resolved-tokens shape]
  (when (d/not-empty? (:applied-tokens shape))
    (not-empty
     (-> (invert-collect-key-vals (:applied-tokens shape) resolved-tokens shape)
         (shape-ids-by-values (:id shape))
         (split-attribute-groups)))))

(defn- fast-action
  "The pure update for the group `attrs`, or nil when it takes the event path."
  [attrs]
  (get fast-actions (some attribute-actions-map attrs)))

(defn- root-frame-fn
  "Memoized `cfh/get-shape-id-root-frame` for `objects`."
  [objects]
  (let [cache (volatile! {})]
    (fn root-frame [id]
      (if (contains? @cache id)
        (get @cache id)
        (let [shape     (get objects id)
              parent-id (:parent-id shape)
              result    (cond
                          (nil? shape)                 nil
                          (cfh/root-frame? shape)      id
                          (or (nil? parent-id)
                              (= parent-id id)
                              (= id uuid/zero))        nil
                          :else                        (root-frame parent-id))]
          (vswap! cache assoc id result)
          result)))))

(defn- shadows-fn
  "`dwta/value->shadow` once per value for the whole run, kept in `cache`
  (a volatile), so a main and its copies get the same shadow ids."
  [cache]
  (fn [value]
    (or (get @cache value)
        (let [shadow (dwta/value->shadow value)]
          (vswap! cache assoc value shadow)
          shadow))))

(defn- in-rect?
  "True when the shape selrect overlaps `rect` (`:x :y :width :height`)."
  [rect shape]
  (let [sr (:selrect shape)]
    (and (some? sr)
         (< (:x sr) (+ (:x rect) (:width rect)))
         (< (:x rect) (+ (:x sr) (:width sr)))
         (< (:y sr) (+ (:y rect) (:height rect)))
         (< (:y rect) (+ (:y sr) (:height sr))))))

(defn- page-roots
  "The children of the page root, those in `vbox` first when given."
  [objects vbox]
  (let [roots (vec (:shapes (get objects uuid/zero)))]
    (if (some? vbox)
      (let [visible? #(in-rect? vbox (get objects %))]
        (into (filterv visible? roots) (remove visible?) roots))
      roots)))

(defn- next-shape
  "Takes the next shape to visit from the job stack and pushes its children.
  Returns `[shape job]`, or nil when the page has no shape left. When the
  tree is done, the ids it did not reach are queued once."
  [{:keys [stack visited rest-queued?] :as job} objects]
  (cond
    (seq stack)
    (let [id  (peek stack)
          job (assoc job :stack (pop stack))]
      (if (contains? visited id)
        (recur job objects)
        (let [shape    (get objects id)
              children (:shapes shape)]
          [shape (cond-> (update job :visited conj id)
                   (seq children)
                   (update :stack into (rseq (vec children))))])))

    (not rest-queued?)
    (recur (assoc job
                  :stack (into [] (remove visited) (keys objects))
                  :rest-queued? true)
           objects)

    :else
    nil))

(defn- scan-chunk
  "Reads shapes of the job page until the scan budget runs out. Returns
  `[job ids done?]`, `ids` being the shapes that have token updates now."
  [{:keys [resolved-tokens unbounded?] :as job} objects]
  (let [start (now)]
    (loop [job job
           ids []]
      (if (and (not unbounded?)
               (>= (:since-yield job) min-shapes)
               (> (- (now) start) scan-budget-ms))
        [job ids false]
        (if-let [[shape job] (next-shape job objects)]
          (recur (update job :since-yield inc)
                 (cond-> ids
                   (some? (shape-update-groups resolved-tokens shape))
                   (conj (:id shape))))
          [job ids true])))))

(defn- next-page
  "The job with a page to work on, or nil when no page is left."
  [{:keys [file-id page-id pages] :as job} state]
  (if (some? page-id)
    job
    (loop [pages pages]
      (when-let [page-id (first pages)]
        (if-let [objects (dsh/lookup-page-objects state file-id page-id)]
          (let [vbox (when (= page-id (:current-page-id state))
                       (get-in state [:workspace-local :vbox]))]
            (assoc job
                   :pages (rest pages)
                   :page-id page-id
                   ;; Ids still to visit; the top of the stack is the end.
                   :stack (vec (rseq (page-roots objects vbox)))
                   :visited #{uuid/zero}
                   :rest-queued? false
                   :pending []
                   ;; Root frames whose thumbnails were already cleared.
                   :frame-ids #{}))
          (recur (rest pages)))))))

(defn- split-changes
  "The changes of `changes` on shapes that pass `pred`."
  [changes pred]
  (-> changes
      (update :redo-changes #(filterv (comp pred :id) %))
      (update :undo-changes #(filter (comp pred :id) %))))

(defn- background-changes
  "The changes that give `page` the colour of its background token, or nil
  when it has none or already has that colour."
  [it page resolved-tokens]
  (let [token-name (:background-token page)
        color      (some-> (get-in resolved-tokens [token-name :resolved-value])
                           (dwta/value->color)
                           (:color))]
    (when (and (some? token-name) (some? color) (not= color (:background page)))
      (-> (pcb/empty-changes it)
          (pcb/with-page page)
          (pcb/mod-page {:background color})))))

(defn- commit
  "A commit of the run: no undo entry of its own (see `finish-run`)."
  [changes tags]
  (dch/commit-changes (assoc changes :tags tags :save-undo? false)))

(defn- record-undo
  "Keeps the undo and redo changes of `changes` for the run undo entry."
  [job changes]
  (if (seq (:redo-changes changes))
    (-> job
        (update :redo-chunks conj (:redo-changes changes))
        (update :undo-chunks conj (vec (:undo-changes changes))))
    job))

(defn- process-chunk
  "Builds the updates of the next shapes of the job page. Returns the job to
  continue with and the events to emit."
  [it state {:keys [file-id page-id resolved-tokens shadow-cache unbounded?] :as job}]
  (let [objects       (dsh/lookup-page-objects state file-id page-id)
        current-page? (= page-id (:current-page-id state))
        event-path?   (text-editor-open? state)
        root-frame    (root-frame-fn objects)
        shadows       (shadows-fn shadow-cache)

        ;; Read more shapes only while few wait to be built: reading cached
        ;; shapes is much faster than building them.
        [job scanned scan-done?]
        (if (< (count (:pending job)) max-pending)
          (scan-chunk job objects)
          [job [] false])

        entries       (into (:pending job) scanned)
        build-start   (now)

        ;; The groups are computed from the shape as it is now, so an edit
        ;; made since the scan (a new fill, a removed token) is respected.
        build-entry
        (fn [[changes recompute text-ids frame-ids legacy :as acc] id]
          (let [shape  (get objects id)
                groups (shape-update-groups resolved-tokens shape)]
            (if (nil? groups)
              acc
              (let [text?          (cfh/text-shape? shape)
                    position-data? (and text? (position-data-follows-fills? shape))
                    ctx            {:position-data? position-data?
                                    :shadows shadows}

                    changes
                    (if event-path?
                      changes
                      (reduce-kv
                       (fn [changes attrs values]
                         (if-let [fast (fast-action attrs)]
                           (reduce-kv (fn [changes value shape-ids]
                                        (fast changes value shape-ids attrs ctx))
                                      changes
                                      values)
                           changes))
                       changes
                       groups))

                    ;; Only ids are kept: the event path reads the shape again.
                    legacy
                    (cond
                      event-path?
                      (update legacy :all (fnil conj #{}) id)

                      (some (comp nil? fast-action) (keys groups))
                      (update legacy :some (fnil conj #{}) id)

                      :else
                      legacy)

                    ;; Position data that does not follow the fills is dropped
                    ;; and made again: on the current page by the position data
                    ;; watcher after the commit (see `recompute`), on other
                    ;; pages on the next visit, as before.
                    changes
                    (if (and text? (not position-data?) (not event-path?))
                      (update-shapes* changes [id] #(dissoc % :position-data)
                                      {:ignore-touched true})
                      changes)]

                [changes
                 (if (and text? (not position-data?) current-page?)
                   (conj recompute id)
                   recompute)
                 (if text? (conj text-ids id) text-ids)
                 (if-let [frame-id (root-frame id)]
                   (conj frame-ids frame-id)
                   frame-ids)
                 legacy]))))

        [acc pending]
        (loop [acc     [(-> (pcb/empty-changes it page-id)
                            (pcb/with-objects objects))
                        #{}
                        []
                        #{}
                        (get-in job [:legacy page-id])]
               entries (seq entries)
               built   0]
          (if (and entries
                   (or (zero? built)
                       unbounded?
                       (< (:since-yield job) min-shapes)
                       (<= (- (now) build-start) build-budget-ms)))
            (recur (build-entry acc (first entries)) (next entries) (inc built))
            [acc (vec entries)]))

        [changes recompute text-ids touched-frames legacy] acc

        done?      (and scan-done? (empty? pending))
        persist?   (> (- (now) (:persist-at job)) persist-interval-ms)
        new-frames (remove (:frame-ids job) touched-frames)

        main       (split-changes changes (complement recompute))
        ;; Texts on the current page whose position data was dropped: the
        ;; position data watcher makes it again.
        recompute  (split-changes changes recompute)

        background (when done?
                     (when-let [page (dsh/lookup-page state file-id page-id)]
                       (background-changes it page resolved-tokens)))

        reflow-ids
        (when (and current-page? (seq text-ids))
          (:text-ids (wrfs/reflow-ids state page-id objects
                                      (pcb/lookup-objects changes)
                                      text-ids nil)))

        events
        (cond-> []
          (some? reflow-ids)
          (conj (ptk/data-event :text/reflow {:ids reflow-ids :page-id page-id}))

          ;; Cleared once per board, before the commits: component thumbnails
          ;; are rendered after the run (the watcher holds the component
          ;; changes until then), so no newer render is cancelled.
          :always
          (into (mapcat (fn [frame-id]
                          [(dwt/clear-thumbnail file-id page-id frame-id "frame")
                           (dwt/clear-thumbnail file-id page-id frame-id "component")]))
                new-frames)

          ;; `:position-data`: the position data of these texts is already
          ;; up to date, the watcher does not make it again.
          (seq (:redo-changes main))
          (conj (commit main #{commit-tag :position-data}))

          (seq (:redo-changes recompute))
          (conj (commit recompute #{commit-tag}))

          (some? background)
          (conj (commit background #{commit-tag}))

          persist?
          (conj ::dps/force-persist))

        job
        (cond-> (-> job
                    (assoc :pending pending
                           ;; A step that read nothing only builds: count what
                           ;; it built, so it still yields.
                           :since-yield (cond-> (:since-yield job)
                                          (empty? scanned)
                                          (+ (- (count entries) (count pending)))))
                    (update :frame-ids into new-frames)
                    (record-undo changes)
                    (cond-> (some? background) (record-undo background)))
          (some? legacy)
          (assoc-in [:legacy page-id] legacy)

          persist?
          (assoc :persist-at (now))

          done?
          (assoc :page-id nil :stack nil :visited nil :pending nil))]

    (l/inf :status "PROGRESS"
           :hint "propagate-tokens"
           :page-id (str page-id)
           :built (- (count entries) (count pending))
           :pending (count pending)
           :done done?
           ::l/sync? true)

    {:job job :events events}))

(defn- run-pages
  "Processes chunks of the job pages until the budget is spent or no page is
  left. Pages are independent, so several of them can be built from the same
  state. Returns `[job events done?]`."
  [it state job]
  (loop [job    job
         events []]
    (if-let [job (next-page job state)]
      (let [{job :job chunk-events :events} (process-chunk it state job)
            events (into events chunk-events)]
        (if (or (some? (:page-id job)) (yield? job))
          [job events false]
          (recur job events)))
      [job events true])))

(defn- propagation-done
  [run-id]
  (ptk/reify ::propagation-done
    cljs.core/IDeref
    (-deref [_] run-id)

    ptk/UpdateEvent
    (update [_ state]
      (cond-> state
        (= run-id (get state ::active-run))
        (dissoc ::active-run ::active-job)))

    ptk/EffectEvent
    (effect [_ state _]
      (when-not (running? state)
        (swap! st/ongoing-tasks disj :token-propagation)))))

(defn- propagation-done?
  [event run-id]
  (and (done-event? event)
       (= run-id (deref event))))

(defn- event-path-groups
  "The groups of `groups` without a pure update."
  [groups]
  (into {} (remove (comp some? fast-action key)) groups))

(defn- propagate-legacy
  "Runs, through the update events and the update buffer as before, the
  updates without a pure counterpart (sizes, positions, rotation, layout,
  typography, and everything built while a text editor was open). The
  shapes are read again here, so edits made during the run are respected.
  Their commits are not tagged, so component sync follows them as before.
  Pages with such updates also drop the position data of every text, except
  the current page, whose position data watcher makes it again."
  [{:keys [file-id legacy pages-order resolved-tokens]}]
  (ptk/reify ::propagate-legacy
    ptk/WatchEvent
    (watch [_ state _]
      (let [current-page-id (:current-page-id state)

            infos
            (into []
                  (keep
                   (fn [page-id]
                     (let [{:keys [all some]} (get legacy page-id)
                           objects (dsh/lookup-page-objects state file-id page-id)
                           info    (reduce
                                    (fn [info id]
                                      (let [groups (shape-update-groups resolved-tokens (get objects id))
                                            groups (if (contains? all id)
                                                     groups
                                                     (event-path-groups groups))]
                                        (deep-merge info groups)))
                                    {}
                                    (set/union all some))]
                       (when (d/not-empty? info)
                         [page-id info objects]))))
                  pages-order)]
        (if (empty? infos)
          (rx/empty)
          (rx/concat
           (rx/of (dwsh/update-shapes-buffer-start))
           (->> (rx/from infos)
                (rx/mapcat
                 (fn [[page-id info objects]]
                   (let [actions
                         (actionize-shapes-update-info page-id info)

                         ;; Composed updates return observables and need to be executed differently
                         {:keys [observable normal]}
                         (group-by #(if (rx/observable? %) :observable :normal) actions)]
                     (rx/merge
                      (when (seq observable) (apply rx/merge observable))
                      (when (seq normal) (rx/concat-all (rx/of normal)))
                      (when (not= page-id current-page-id)
                        (let [text-ids (into []
                                             (comp (filter cfh/text-shape?)
                                                   (map :id))
                                             (vals objects))]
                          (rx/of (dwsh/update-shapes text-ids
                                                     (fn [shape]
                                                       (dissoc shape :position-data))
                                                     {:page-id page-id
                                                      :ignore-touched true}))))))))
                (rx/catch #(rx/concat
                            (rx/of (dwsh/update-shapes-buffer-stop))
                            (rx/throw %))))
           (rx/of (dwsh/update-shapes-buffer-stop))))))))

(defn- undo-entry
  "One undo entry for everything the run committed, or nil."
  [{:keys [redo-chunks undo-chunks undo-group selected-before]}]
  (let [redo (into [] cat redo-chunks)]
    (when (seq redo)
      {:undo-changes    (into [] cat (rseq undo-chunks))
       :redo-changes    redo
       :undo-group      undo-group
       :tags            #{}
       :selected-before selected-before})))

(defn- finish-run
  "Ends a run: its undo entry, then (with `legacy?`) the event-path updates,
  which join the same undo entry, then `propagation-done`. A run closed
  because a newer one started skips the event path: the newer run does it."
  [{:keys [run-id legacy] :as job} legacy?]
  (ptk/reify ::finish-run
    ptk/WatchEvent
    (watch [_ _ _]
      (let [entry   (undo-entry job)
            legacy? (and legacy?
                         (some (fn [[_ {:keys [all some]}]]
                                 (or (seq all) (seq some)))
                               legacy))
            tx-id   (js/Symbol)]
        (rx/concat
         (if (or (some? entry) legacy?)
           (rx/concat
            (rx/of (dwu/start-undo-transaction tx-id :timeout false))
            (if (some? entry) (rx/of (dwu/append-undo entry false)) (rx/empty))
            (if legacy? (rx/of (propagate-legacy job)) (rx/empty))
            (rx/of (dwu/commit-undo-transaction tx-id)))
           (rx/empty))
         (rx/of (propagation-done run-id)))))))

(defn- store-job
  "Keeps the job the run continues with, for `finish-propagation`."
  [job]
  (ptk/reify ::store-job
    ptk/UpdateEvent
    (update [_ state]
      (cond-> state
        (= (:run-id job) (get state ::active-run))
        (assoc ::active-job job)))))

(defn- tokens-changed?
  "True when the tokens the run started with are no longer the file's."
  [job state]
  (not (and (identical? (:tokens-lib job) (dsh/lookup-tokens-lib state))
            (identical? (:tokens-status job) (dsh/lookup-tokens-status state)))))

(declare propagate-workspace-tokens)

(defn- propagation-step
  [{:keys [run-id] :as job}]
  (ptk/reify ::propagation-step
    ptk/WatchEvent
    (watch [it state _]
      (try
        (cond
          ;; Closed already: a newer run, `finish-propagation` or a change of
          ;; the tokens ended it.
          (not= run-id (get state ::active-run))
          (rx/empty)

          ;; The tokens changed (a remote change, an edit): close this run and
          ;; propagate again with the current tokens.
          (tokens-changed? job state)
          (rx/of (finish-run job false)
                 (propagate-workspace-tokens))

          :else
          (let [[job events done?] (run-pages it state job)]
            (rx/concat
             (rx/from events)
             (if done?
               (rx/of (finish-run job true))
               (rx/concat
                (rx/of (store-job job))
                (->> (rx/timer 0)
                     (rx/map (fn [_]
                               (propagation-step (assoc job
                                                        :since-yield 0
                                                        :yield-start (now)))))))))))
        (catch :default cause
          (rx/concat
           (rx/of (propagation-done run-id))
           (rx/throw cause)))))))

(defn- supersede-run
  "Closes the active run, if any, before a new one starts."
  []
  (ptk/reify ::supersede-run
    ptk/WatchEvent
    (watch [_ state _]
      (if-let [job (get state ::active-job)]
        (rx/of (finish-run job false))
        (rx/empty)))))

(defn- start-propagation
  [{:keys [run-id] :as job}]
  (ptk/reify ::start-propagation
    ptk/UpdateEvent
    (update [_ state]
      (assoc state
             ::active-run run-id
             ::active-job job))

    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (propagation-step job)))

    ptk/EffectEvent
    (effect [_ _ _]
      ;; Closing the tab now would leave pages without the new values.
      (swap! st/ongoing-tasks conj :token-propagation))))

(defn finish-propagation
  "Completes the active propagation run at once, if there is one. Emitted
  before the workspace closes and before a version is saved, so neither
  sees a file with only some pages propagated."
  []
  (ptk/reify ::finish-propagation
    ptk/WatchEvent
    (watch [it state _]
      (let [job (get state ::active-job)]
        (if (and (some? job) (= (:run-id job) (get state ::active-run)))
          (let [[job events _] (run-pages it state (assoc job :unbounded? true))]
            (rx/concat
             (rx/from events)
             (rx/of (finish-run job true))))
          (rx/empty))))))

(defn- make-job
  "The job of a new run. `tokens-lib` and `tokens-status` are those the
  tokens were resolved from."
  [state run-id resolved-tokens tokens-lib tokens-status]
  (let [file-id         (get state :current-file-id)
        current-page-id (get state :current-page-id)
        fdata           (dsh/lookup-file-data state file-id)
        pages           (into [current-page-id]
                              (remove #(= % current-page-id))
                              (:pages fdata))]
    {:run-id          run-id
     :file-id         file-id
     :pages           pages
     :pages-order     pages
     :page-id         nil
     :resolved-tokens resolved-tokens
     :tokens-lib      tokens-lib
     :tokens-status   tokens-status
     :shadow-cache    (volatile! {})
     :legacy          {}
     :redo-chunks     []
     :undo-chunks     []
     :undo-group      (uuid/next)
     :selected-before (get-in state [:workspace-local :selected])
     :since-yield     0
     :yield-start     (now)
     :persist-at      (now)
     :tpoint          (ct/tpoint-ms)}))

(defn propagate-workspace-tokens
  "Gives every shape of every page the values of its applied tokens, and
  pages the colour of their background token, in one undo step.

  The current page goes first. Fills, strokes, radius, opacity, stroke
  widths and shadows are applied with pure updates, committed a few at a
  time so the browser keeps rendering between commits (see `fast-actions`
  and `commit-tag`). Every other kind goes through the update events at the
  end, as before (see `propagate-legacy`).

  Each page is visited in tree order, the boards in the viewport first on
  the current page, so a commit changes few boards and the visible ones
  change first. See the Run section above for how edits, undo, other runs
  and closing the file are handled while a run is active."
  []
  (ptk/reify ::propagate-workspace-tokens
    ptk/WatchEvent
    (watch [_ state stream]
      (let [tokens-lib    (dsh/lookup-tokens-lib state)
            tokens-status (dsh/lookup-tokens-status state)]
        (when (and tokens-lib tokens-status)
          (when-let [tokens-tree (cfo/get-tokens-in-active-sets tokens-status tokens-lib)]
            (->> (if (contains? cf/flags :tokenscript)
                   (rx/of (ts/resolve-tokens tokens-tree))
                   (sd/resolve-tokens tokens-tree))
                 (rx/mapcat
                  (fn [resolved-tokens]
                    (let [run-id (uuid/next)]
                      (l/inf :status "START" :hint "propagate-tokens")
                      (rx/concat
                       (rx/of (dwu/lock-undo run-id))
                       ;; The listener goes first: a small file finishes before
                       ;; `start-propagation` returns.
                       (rx/merge
                        (->> stream
                             (rx/filter #(propagation-done? % run-id))
                             (rx/take 1)
                             (rx/ignore))
                        (rx/of (supersede-run)
                               (ptk/reify ::make-and-start
                                 ptk/WatchEvent
                                 (watch [_ state _]
                                   ;; The job reads the state after the older
                                   ;; run is closed.
                                   (rx/of (start-propagation
                                           (make-job state run-id resolved-tokens
                                                     tokens-lib tokens-status)))))))
                       (rx/of (dwu/unlock-undo run-id)))))))))))))
