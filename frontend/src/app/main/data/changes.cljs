;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.changes
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.changes :as cpc]
   [app.common.logging :as log]
   [app.common.schema :as sm]
   [app.common.time :as ct]
   [app.common.types.shape :as cts]
   [app.common.types.shape-tree :as ctst]
   [app.common.uuid :as uuid]
   [app.main.data.event :as ev]
   [app.main.data.helpers :as dsh]
   [app.main.features :as features]
   [app.main.worker :as mw]
   [app.render-wasm.api :as wasm.api]
   [app.render-wasm.page-cache :as page-cache]
   [app.render-wasm.shape :as wasm.shape]
   [app.util.timers :as tm]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

;; Change this to :info :debug or :trace to debug this module
(log/set-level! :warn)

(def page-change?
  #{:add-page :mod-page :del-page :mov-page})

(def update-layout-attr?
  #{:hidden})

(def commit?
  (ptk/type? ::commit))

(defn- fix-page-id
  "For events that modifies the page, page-id does not comes
  as a property so we assign it from the `id` property."
  [{:keys [id type page] :as change}]
  (cond-> change
    (and (page-change? type)
         (nil? (:page-id change)))
    (assoc :page-id (or id (:id page)))))

(defn- update-indexes
  "Given a vector of changes, send them to the worker for updating the
  indexes. Sends one request per page."
  [changes]
  (ptk/reify ::update-indexes
    ptk/WatchEvent
    (watch [_ _ _]
      (let [changes (->> changes
                         (map fix-page-id)
                         (filter :page-id)
                         (group-by :page-id))]

        (->> (rx/from changes)
             (rx/merge-map (fn [[page-id changes]]
                             (log/debug :hint "update-indexes" :page-id page-id :changes (count changes))
                             (mw/ask! {:cmd :index/update
                                       :page-id page-id
                                       :changes changes})))
             (rx/catch (fn [cause]
                         (log/warn :hint "unable to update index"
                                   :cause cause)
                         (rx/empty)))
             (rx/ignore))))))

(defn- get-pending-commits
  "Returns the local commits not yet saved, in commit order: the queued
  ones first, then the buffered ones still waiting for their flush. The
  rebase must see both, because a buffered commit is already applied to
  the file data."
  [{:keys [persistence]}]
  (->> (concat (map (d/getf (:index persistence)) (:queue persistence))
               (:buffer persistence))
       (not-empty)))

(defn- get-rebase-changes
  "Returns the changes the worker index must apply when `commit` is
  rebased over `pending`. The index must see the same sequence that the
  file data sees, so the result is: the undo changes of the pending
  commits, latest commit first; then the redo changes of `commit`; then
  the redo changes of the pending commits in commit order. With no
  pending commits it returns the redo changes of `commit`."
  [commit pending]
  (-> []
      (into (mapcat :undo-changes) (reverse pending))
      (into (:redo-changes commit))
      (into (mapcat :redo-changes) pending)))

(def ^:private xf:map-page-id
  ;; Component-only changes have no :page-id; keep drops those nils so
  ;; update-object-indices does not create a nil key in :pages-index.
  (keep :page-id))

(defn- wasm-structural-change?
  "True for a change that needs the WASM shape tree resynced. A
  `:mov-objects` without shapes changes nothing (`process-change` skips
  it), and moving a root board inside the root emits one."
  [{:keys [type shapes]}]
  (case type
    :add-obj     true
    :mov-objects (boolean (seq shapes))
    false))

(defn- redo-changes-need-wasm-object-sync?
  [redo-changes]
  (some wasm-structural-change? redo-changes))

(defn- sync-wasm-structural-changes
  [{:keys [redo-changes]}]
  (ptk/reify ::sync-wasm-structural-changes
    ptk/EffectEvent
    (effect [_ state _]
      (try
        (when (wasm.api/initialized?)
          (let [objects (dsh/lookup-page-objects state)
                shapes
                (into []
                      (keep (fn [{:keys [type id parent-id] :as change}]
                              (when (wasm-structural-change? change)
                                (get objects (case type
                                               :add-obj id
                                               :mov-objects parent-id)))))
                      redo-changes)]

            (wasm.api/process-objects shapes)
            (wasm.api/request-render "sync-wasm-structural-changes")))
        (finally
          ;; Counted by `page-cache/note-changes!` in `apply-changes-localy`.
          (page-cache/end-structural-sync!))))))

(defn- apply-changes-localy
  [{:keys [file-id redo-changes ignore-wasm?] :as commit} pending]
  (ptk/reify ::apply-changes-localy
    ptk/UpdateEvent
    (update [_ state]
      (let [undo-changes
            (if pending
              (->> pending
                   (map :undo-changes)
                   (reverse)
                   (mapcat identity)
                   (vec))
              nil)

            redo-changes
            (if pending
              (into redo-changes
                    (mapcat :redo-changes)
                    pending)
              redo-changes)

            apply-changes
            (fn [fdata]
              (let [fdata (cpc/process-changes fdata undo-changes false)
                    fdata (cpc/process-changes fdata redo-changes false)
                    pids (into #{} xf:map-page-id redo-changes)]
                (reduce #(ctst/update-object-indices %1 %2) fdata pids)))

            wasm-sync?
            (and (not ignore-wasm?) (features/active-feature? state "render-wasm/v1"))]

        ;; Every page these changes touch no longer matches a WASM copy
        ;; stashed before (see `app.render-wasm.page-cache`).
        (page-cache/note-changes!
         (concat undo-changes redo-changes)
         {:current-page-id  (:current-page-id state)
          :wasm-synced?     wasm-sync?
          ;; Same condition as the `sync-wasm-structural-changes` below.
          :structural-sync? (and wasm-sync?
                                 (redo-changes-need-wasm-object-sync? (:redo-changes commit)))})

        (if wasm-sync?
          ;; Update the wasm model
          (let [shape-changes (js/Map.)

                state
                (binding [cts/*shape-changes* shape-changes]
                  (update-in state [:files file-id :data] apply-changes))]

            (let [objects (dm/get-in state [:files file-id :data :pages-index (:current-page-id state) :objects])]
              (wasm.shape/process-shape-changes! objects (es6-iterator-seq (.entries shape-changes))))

            state)

          ;; wasm renderer deactivated
          (update-in state [:files file-id :data] apply-changes))))

    ptk/WatchEvent
    (watch [_ state _]
      ;; `:add-obj` / `:mov-objects` are not tracked via `*shape-changes*`.
      ;; Emit only for structural commits, after file data is in state.
      (when (and (not ignore-wasm?)
                 (features/active-feature? state "render-wasm/v1")
                 (redo-changes-need-wasm-object-sync? redo-changes))
        (rx/of (sync-wasm-structural-changes {:redo-changes redo-changes}))))))

(defn commit
  "Create a commit event instance"
  [{:keys [commit-id redo-changes undo-changes origin save-undo? features
           file-id file-revn file-vern undo-group tags stack-undo? source ignore-wasm?
           selected-before translation? skip-component-sync?]}]

  (assert (cpc/check-changes redo-changes)
          "expect valid vector of changes for redo-changes")

  (assert (cpc/check-changes undo-changes)
          "expect valid vector of changes for undo-changes")

  (let [commit-id (or commit-id (uuid/next))
        source    (d/nilv source :local)
        local?    (= source :local)
        commit    {:id commit-id
                   :created-at (ct/now)
                   :source source
                   :origin (ptk/type origin)
                   :features features
                   :file-id file-id
                   :file-revn file-revn
                   :file-vern file-vern
                   :changes redo-changes
                   :redo-changes redo-changes
                   :undo-changes undo-changes
                   :save-undo? save-undo?
                   :undo-group undo-group
                   :tags tags
                   :stack-undo? stack-undo?
                   :ignore-wasm? ignore-wasm?
                   :selected-before selected-before
                   :translation? translation?
                   :skip-component-sync? skip-component-sync?}]

    (ptk/reify ::commit
      cljs.core/IDeref
      (-deref [_] commit)

      ptk/WatchEvent
      (watch [_ state _]
        (let [pending (when-not local?
                        (get-pending-commits state))]
          (rx/concat
           (rx/of (apply-changes-localy commit pending))
           (rx/of (update-indexes (get-rebase-changes commit pending)))))))))

(defn- resolve-file-revn
  [state file-id]
  (:revn (dsh/lookup-file state file-id)))

(defn- resolve-file-vern
  [state file-id]
  (:vern (dsh/lookup-file state file-id)))

(defn commit-changes
  "Schedules a list of changes to execute now, and add the corresponding undo changes to
   the undo stack.

   Options:
   - save-undo?: if set to false, do not add undo changes.
   - undo-group: if some consecutive changes (or even transactions) share the same
                 undo-group, they will be undone or redone in a single step
   "
  [{:keys [redo-changes undo-changes save-undo? undo-group tags stack-undo? file-id
           translation? skip-component-sync?]
    :or {save-undo? true
         stack-undo? false
         undo-group (uuid/next)
         tags #{}}
    :as params}]
  (ptk/reify ::commit-changes
    ev/PerformanceEvent

    ptk/WatchEvent
    (watch [_ state _]
      (let [file-id     (or file-id (:current-file-id state))
            uchg        (vec undo-changes)
            rchg        (vec redo-changes)
            features    (get state :features)
            permissions (get state :permissions)]

        ;; Historical previews must not create edits to the live file. Check
        ;; this when creating commits so previously queued edits can still save.
        ;; Refusals answer with an empty stream (never nil) so callers can
        ;; uniformly subscribe and observe termination.
        (if (and (:can-edit permissions)
                 (not (dm/get-in state [:workspace-global :preview-id])))
          (do
            (log/trace :hint "commit-changes" :redo-changes redo-changes)
            (let [selected (dm/get-in state [:workspace-local :selected])]
              (rx/of (-> params
                         (assoc :undo-group undo-group)
                         (assoc :features features)
                         (assoc :tags tags)
                         (assoc :stack-undo? stack-undo?)
                         (assoc :save-undo? save-undo?)
                         (assoc :file-id file-id)
                         (assoc :file-revn (resolve-file-revn state file-id))
                         (assoc :file-vern (resolve-file-vern state file-id))
                         (assoc :undo-changes uchg)
                         (assoc :redo-changes rchg)
                         (assoc :selected-before selected)
                         (assoc :translation? translation?)
                         (assoc :skip-component-sync? skip-component-sync?)
                         (commit)))))
          (rx/empty))))))

;; --- Check functions warm-up
;;
;; `sm/check-fn` compiles its schema on the first check. The checks below run
;; on every edit (commit asserts, shape updates); a large one compiled on the
;; first edit stalls that interaction.

(def ^:private warm-up-check-fns
  [cpc/check-changes
   cts/check-shape-generic-attrs
   cts/check-shape-attrs
   cts/check-shape])

(defn warm-up-checks!
  "Compiles the validators of `warm-up-check-fns`, one step at a time.
  Each step is run through `schedule`, a fn of one step fn that returns
  a disposable (default: one step per browser idle period, see
  `sm/warm-check-fn!`). Returns a function that cancels the ones still
  pending."
  ([]
   (warm-up-checks! tm/schedule-on-idle))

  ([schedule]
   (let [pending (volatile! (seq warm-up-check-fns))
         task    (volatile! nil)]
     (letfn [(step []
               (vreset! task nil)
               (when-let [check-fn (first @pending)]
                 (vswap! pending next)
                 (try
                   (sm/warm-check-fn! check-fn)
                   (catch :default cause
                     (log/warn :hint "check function warm-up failed" :cause cause)))
                 (when (seq @pending)
                   (vreset! task (schedule step)))))]
       (vreset! task (schedule step))
       (fn []
         (vreset! pending nil)
         (some-> @task rx/dispose!))))))
