;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.tokens.logic.token-propagation-test
  "Token propagation through `dwtp/propagate-workspace-tokens`. The pure-update
  path is checked against the legacy update-event path followed by component
  sync; the rest covers position data, undo, the component watcher and the
  tokenscript resolver."
  (:require
   [app.common.data :as d]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.helpers :as cfh]
   [app.common.files.tokens :as cfo]
   [app.common.test-helpers.components :as cthc]
   [app.common.test-helpers.compositions :as ctho]
   [app.common.test-helpers.files :as cthf]
   [app.common.test-helpers.ids-map :as cthi]
   [app.common.test-helpers.shapes :as cths]
   [app.common.test-helpers.tokens :as ctht]
   [app.common.types.fills :as types.fills]
   [app.common.types.pages-list :as ctpl]
   [app.common.types.text :as txt]
   [app.common.types.token :as ctt]
   [app.common.types.tokens-lib :as ctob]
   [app.common.types.tokens-status :as ctos]
   [app.config :as cf]
   [app.main.data.changes :as dch]
   [app.main.data.helpers :as dsh]
   [app.main.data.style-dictionary :as sd]
   [app.main.data.tokenscript :as ts]
   [app.main.data.workspace.colors :as wdc]
   [app.main.data.workspace.libraries :as dwl]
   [app.main.data.workspace.pages :as dwpg]
   [app.main.data.workspace.shapes :as dwsh]
   [app.main.data.workspace.thumbnails :as dwt]
   [app.main.data.workspace.thumbnails-wasm :as dwt.wasm]
   [app.main.data.workspace.tokens.application :as dwta]
   [app.main.data.workspace.tokens.library-edit :as dwtl]
   [app.main.data.workspace.tokens.propagation :as dwtp]
   [app.main.data.workspace.undo :as dwu]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [clojure.data :as data]
   [clojure.set :as set]
   [frontend-tests.helpers.async :as async]
   [frontend-tests.helpers.mock :as mock]
   [frontend-tests.helpers.pages :as thp]
   [frontend-tests.helpers.state :as ths]
   [frontend-tests.helpers.wasm :as thw]
   [frontend-tests.tokens.helpers.state :as tohs]
   [okulary.core :as l]
   [potok.v2.core :as ptk]))

(t/use-fixtures :each
  {:before (fn []
             (thp/reset-idmap!)
             (cthi/reset-idmap!)
             (thw/setup-wasm-mocks!))
   :after  thw/teardown-wasm-mocks!})

;; Legacy reference -----------------------------------------------------------
;; The propagation as it was before the pure-update path: one update event per
;; update, through the update buffer, and component sync after the commit.
;; Copied from the code it replaces; only the logging is left out.

(defn- deep-merge
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

(def ^:private filter-existing-values? false)

(def ^:private attribute-actions-map
  (flatten-set-keyed-map dwta/attributes->shape-update {}))

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

(defn- collect-shapes-update-info [resolved-tokens objects]
  (loop [items (seq objects)
         frame-ids #{}
         text-ids []
         tokens {}]
    (if-let [[shape-id {:keys [applied-tokens] :as shape}] (first items)]
      (let [applied-tokens
            (-> (invert-collect-key-vals applied-tokens resolved-tokens shape)
                (shape-ids-by-values shape-id)
                (split-attribute-groups))

            parent-frame-id
            (cfh/get-shape-id-root-frame objects shape-id)]

        (recur (rest items)
               (if parent-frame-id
                 (conj frame-ids parent-frame-id)
                 frame-ids)
               (if (cfh/text-shape? shape)
                 (conj text-ids shape-id)
                 text-ids)
               (deep-merge tokens applied-tokens)))

      [tokens frame-ids text-ids])))

(defn- actionize-shapes-update-info [page-id shapes-update-info]
  (mapcat (fn [[attrs update-infos]]
            (let [action (some attribute-actions-map attrs)]
              (assert (fn? action) "missing action function on attributes->shape-update")
              (map
               (fn [[v shape-ids]]
                 (action v shape-ids attrs page-id))
               update-infos)))
          shapes-update-info))

(defn- update-canvas-background
  [page-id resolved-tokens]
  (ptk/reify ::update-canvas-background
    ptk/WatchEvent
    (watch [it state _]
      (let [page       (dsh/lookup-page state page-id)
            token-name (:background-token page)
            color      (some-> (get-in resolved-tokens [token-name :resolved-value])
                               (dwta/value->color)
                               (:color))]
        (when (and (some? color) (not= color (:background page)))
          (rx/of (dch/commit-changes
                  (-> (pcb/empty-changes it)
                      (pcb/with-page page)
                      (pcb/mod-page {:background color})))))))))

(defn- legacy-propagate-tokens
  "Propagates tokens values to all shapes and page backgrounds where they
  are applied."
  [state resolved-tokens]
  (let [file-id         (get state :current-file-id)
        current-page-id (get state :current-page-id)
        fdata           (dsh/lookup-file-data state file-id)]
    (->> (rx/concat
          (rx/of current-page-id)
          (->> (rx/from (:pages fdata))
               (rx/filter (fn [id] (not= id current-page-id)))))
         (rx/mapcat
          (fn [page-id]
            (let [page (dsh/get-page fdata page-id)

                  [attrs frame-ids text-ids]
                  (collect-shapes-update-info resolved-tokens (:objects page))

                  actions (actionize-shapes-update-info page-id attrs)

                  {:keys [observable normal]}
                  (group-by #(if (rx/observable? %) :observable :normal) actions)]

              (rx/merge
               (when (seq observable) (apply rx/merge observable))
               (when (seq normal) (rx/concat-all (rx/of normal)))

               (when (:background-token page)
                 (rx/of (update-canvas-background page-id resolved-tokens)))

               (->> (rx/from frame-ids)
                    (rx/mapcat (fn [frame-id]
                                 (rx/of (dwt/clear-thumbnail file-id page-id frame-id "frame")
                                        (dwt/clear-thumbnail file-id page-id frame-id "component")))))

               (when (not= page-id current-page-id)
                 (rx/of (dwsh/update-shapes text-ids
                                            (fn [shape]
                                              (dissoc shape :position-data))
                                            {:page-id page-id
                                             :ignore-touched true}))))))))))

(defn- legacy-propagate-workspace-tokens
  []
  (ptk/reify ::legacy-propagate-workspace-tokens
    ptk/WatchEvent
    (watch [_ state _]
      (let [tokens-lib    (dsh/lookup-tokens-lib state)
            tokens-status (dsh/lookup-tokens-status state)]
        (when (and tokens-lib tokens-status)
          (when-let [tokens-tree (cfo/get-tokens-in-active-sets tokens-status tokens-lib)]
            (->> (if (contains? cf/flags :tokenscript)
                   (rx/of (ts/resolve-tokens tokens-tree))
                   (sd/resolve-tokens tokens-tree))
                 (rx/mapcat
                  (fn [sd-tokens]
                    (let [undo-id (js/Symbol)]
                      (rx/concat
                       (rx/of (dwu/start-undo-transaction undo-id :timeout false))
                       (rx/of (dwsh/update-shapes-buffer-start))
                       (->> (legacy-propagate-tokens state sd-tokens)
                            (rx/catch #(rx/concat
                                        (rx/of (dwsh/update-shapes-buffer-stop))
                                        (rx/throw %))))
                       (rx/of (dwsh/update-shapes-buffer-stop))
                       (rx/of (dwu/commit-undo-transaction undo-id)))))))))))))

;; Fixture --------------------------------------------------------------------

(def ^:private light
  "The values the shapes hold before the theme switch."
  {:bg "#ffffff"
   :fg "#111111"
   :accent "#0055ff"
   :radius 4
   :opacity 0.8
   :stroke 1})

(def ^:private dark
  "The values the Dark theme gives the shapes."
  {:bg "#000000"
   :fg "#eeeeee"
   :accent "#3388ff"
   :radius 8
   :opacity 0.6
   :stroke 2})

(def ^:private shadow-light
  "The shadow token value of the light set."
  [{:offset-x 0 :offset-y 2 :blur 4 :spread 0 :color "#000000" :inset false}])

(def ^:private shadow-dark
  "The shadow token value of the dark set."
  [{:offset-x 0 :offset-y 4 :blur 8 :spread 0 :color "#000000" :inset false}])

(defn- fill-of
  "The fill that the colour `hex` gives, as the propagation makes it."
  [hex]
  (wdc/color->fill (dwta/value->color hex)))

(defn- add-token
  [lib set-label token-name token-type value]
  (ctob/add-token lib
                  (cthi/id set-label)
                  (ctob/make-token :id (cthi/new-id! [set-label token-name])
                                   :name token-name
                                   :type token-type
                                   :value value)))

(defn- add-token-pair
  "Adds `token-name` to the light set and to the dark set."
  [lib token-name token-type light-value dark-value]
  (-> lib
      (add-token :set-light token-name token-type light-value)
      (add-token :set-dark token-name token-type dark-value)))

(defn- token-lib
  "Two sets with the same token names, and one theme per set."
  [lib]
  (-> lib
      (ctob/add-set (ctob/make-token-set :id (cthi/new-id! :set-light)
                                         :name "light"))
      (ctob/add-set (ctob/make-token-set :id (cthi/new-id! :set-dark)
                                         :name "dark"))
      (ctob/add-theme (ctob/make-token-theme :id (cthi/new-id! :theme-light)
                                             :name "Light"
                                             :sets #{"light"}))
      (ctob/add-theme (ctob/make-token-theme :id (cthi/new-id! :theme-dark)
                                             :name "Dark"
                                             :sets #{"dark"}))
      (add-token-pair "color.bg" :color (:bg light) (:bg dark))
      (add-token-pair "color.fg" :color (:fg light) (:fg dark))
      (add-token-pair "color.accent" :color (:accent light) (:accent dark))
      (add-token-pair "radius.md" :border-radius (:radius light) (:radius dark))
      (add-token-pair "opacity.soft" :opacity (:opacity light) (:opacity dark))
      (add-token-pair "stroke.w" :stroke-width (:stroke light) (:stroke dark))
      (add-token-pair "shadow.card" :shadow shadow-light shadow-dark)))

(defn- base-file-on
  "A file with the tokens and the Dark theme active, page `page-label` current."
  [page-label]
  (ctht/sample-file-with-tokens
   :page-label page-label
   :lib-fn token-lib
   :status-fn #(ctos/set-tokens-status % #{(cthi/id :theme-dark)} #{(cthi/id :set-dark)})))

(defn- base-file
  "A file with the tokens and the Dark theme active, page `:page-ds` current."
  []
  (base-file-on :page-ds))

(defn- shape-of
  "The shape `label` on the page `page-label` of `file`."
  [file page-label label]
  (cths/get-shape file label :page-label page-label))

(defn- update-shape-raw
  "Applies `f` to the shape `label` of the current page. A fixture edit: it
  leaves the touched flags alone."
  [file label f]
  (let [page (cthf/current-page file)
        id   (cthi/id label)]
    (update file :data
            (fn [fdata]
              (ctpl/update-page fdata
                                (:id page)
                                #(update-in % [:objects id] f))))))

(defn- set-text-fills
  "Gives every text node of the shape `label` the fills `fills`."
  [file label fills]
  (update-shape-raw file label
                    #(txt/update-text-content % txt/is-text-node? d/txt-merge {:fills fills})))

(defn- text-fill
  "Applies the colour token `token-name` to the text `label`. The token goes on
  the shape, and the text nodes get the fill of the value `hex`."
  [file label token-name hex]
  (-> file
      (ctht/apply-token-to-shape label token-name [:fill] [] hex)
      (set-text-fills label [(fill-of hex)])))

(defn- position-data-of
  "Position data of a one-line text, with the node fills `fills`."
  [fills]
  [{:x 0
    :y 10
    :width 40
    :height 10
    :text "hello"
    :fills fills
    :font-size "14px"}])

(defn- set-position-data
  [file label position-data]
  (update-shape-raw file label #(assoc % :position-data position-data)))

(defn- label-copy!
  "Labels the shapes under the copy `copy-label` of the current page as
  `<copy>-rect`, `<copy>-text`, `<copy>-b` (the nested copy) and `<copy>-b-rect`.
  Each one is found by its `:shape-ref`, so the order of the children does not
  matter."
  [file copy-label]
  (let [objects (:objects (cthf/current-page file))
        shapes  (cfh/get-children-with-self objects (cthi/id copy-label))
        prefix  (name copy-label)]
    (doseq [[suffix main-label] [["rect" :a-rect]
                                 ["text" :a-text]
                                 ["b" :a-b-copy]
                                 ["b-rect" :a-b-rect]]]
      (let [main-id (cthi/id main-label)
            child   (some #(when (= main-id (:shape-ref %)) %) shapes)]
        (cthi/set-id! (keyword (str prefix "-" suffix)) (:id child))))
    file))

(defn- override-copy-rect
  "Gives the rect of the copy `copy-label` the accent token and its light
  accent fill, as a user override does."
  [file copy-label]
  (let [rect-label (keyword (str (name copy-label) "-rect"))
        rect       (cths/get-shape file rect-label)]
    (-> file
        (cths/update-shape rect-label :applied-tokens
                           (assoc (:applied-tokens rect) :fill "color.accent"))
        (cths/update-shape rect-label :fills [(fill-of (:accent light))]))))

(defn- edit-copy-text
  "Changes the text of the copy `copy-label`, as a user edit does."
  [file copy-label]
  (let [text-label (keyword (str (name copy-label) "-text"))
        text       (cths/get-shape file text-label)]
    (cths/update-shape file text-label :content
                      (txt/change-text (:content text) "Edited"))))

(defn- build-file
  "The fixture. Page `:page-ds` holds the components, `:page-screens` the
  copies and the loose shapes. The shapes hold the light values and the Dark
  theme is active. Page `:page-ds` is current at the end."
  []
  (-> (base-file)
      ;; Component B.
      (ctho/add-frame :b-main)
      (ctho/add-rect :b-rect :parent-label :b-main)
      (ctht/apply-token-to-shape :b-rect "color.accent" [:fill] [:fill] (:accent light))
      (cthc/make-component :comp-b :b-main)

      ;; Component A, with a nested copy of B.
      (ctho/add-frame :a-main)
      (ctho/add-rect :a-rect :parent-label :a-main)
      (ctht/apply-token-to-shape :a-rect "color.bg" [:fill] [:fill] (:bg light))
      (ctht/apply-token-to-shape :a-rect "color.fg" [:stroke-color] [:stroke-color] (:fg light))
      (ctht/apply-token-to-shape :a-rect "radius.md"
                                 [:r1 :r2 :r3 :r4] [:r1 :r2 :r3 :r4] (:radius light))
      (ctht/apply-token-to-shape :a-rect "stroke.w"
                                 [:stroke-width-top :stroke-width-right
                                  :stroke-width-bottom :stroke-width-left]
                                 [:stroke-width]
                                 (:stroke light))
      ;; The shadow comes from the propagation only: no shape attribute.
      (ctht/apply-token-to-shape :a-rect "shadow.card" [:shadow] [] shadow-light)
      (ctho/add-text :a-text "hello" :text-params {:parent-label :a-main})
      (text-fill :a-text "color.fg" (:fg light))
      (ctht/apply-token-to-shape :a-text "opacity.soft" [:opacity] [:opacity] (:opacity light))
      (set-position-data :a-text (position-data-of [(fill-of (:fg light))]))
      (cthc/instantiate-component :comp-b :a-b-copy
                                  :parent-label :a-main
                                  :children-labels [:a-b-rect])
      (cthc/make-component :comp-a :a-main)

      ;; Page 2: copies of A, and loose shapes.
      (cthf/add-sample-page :page-screens)
      (cthc/instantiate-component :comp-a :copy1)
      (label-copy! :copy1)
      (cthc/instantiate-component :comp-a :copy2)
      (label-copy! :copy2)
      (override-copy-rect :copy2)
      (cthc/instantiate-component :comp-a :copy3)
      (label-copy! :copy3)
      (edit-copy-text :copy3)

      (ctho/add-rect :loose-rect)
      (ctht/apply-token-to-shape :loose-rect "color.bg" [:fill] [:fill] (:bg light))

      (ctho/add-text :loose-text "hello")
      (text-fill :loose-text "color.fg" (:fg light))
      (set-position-data :loose-text (position-data-of [(fill-of (:fg light))]))

      ;; Position data that does not match the fills of the content.
      (ctho/add-text :stale-text "hello")
      (text-fill :stale-text "color.fg" (:fg light))
      (set-position-data :stale-text
                         (position-data-of [{:fill-color "#abcdef" :fill-opacity 1}]))

      (ctho/add-text :nopd-text "hello")
      (text-fill :nopd-text "color.fg" (:fg light))

      (cthf/switch-to-page :page-ds)))

(defn- rect-label
  [i]
  (keyword (str "rect-" i)))

(defn- build-rects-file
  "Page `:page-ds` with 300 rects, each with the fill `color.bg`."
  []
  (reduce (fn [file i]
            (let [label (rect-label i)]
              (-> file
                  (ctho/add-rect label)
                  (ctht/apply-token-to-shape label "color.bg" [:fill] [:fill] (:bg light)))))
          (base-file)
          (range 300)))

(defn- add-dark-rects
  "Adds to the current page the rects `<prefix><i>`, for i below `n`, each with
  the fill `color.bg`."
  [file prefix n]
  (reduce (fn [file i]
            (let [label (keyword (str prefix i))]
              (-> file
                  (ctho/add-rect label)
                  (ctht/apply-token-to-shape label "color.bg" [:fill] [:fill] (:bg light)))))
          file
          (range n)))

(defn- build-rects-pages
  "Page `:page-ds`, current at the end, with 120 rects `rect-<i>`, and page
  `:page-two` with 120 rects `rect2-<i>`. Every rect has the fill `color.bg`."
  []
  (-> (base-file)
      (add-dark-rects "rect-" 120)
      (cthf/add-sample-page :page-two)
      (add-dark-rects "rect2-" 120)
      (cthf/switch-to-page :page-ds)))

(defn- build-sync-file
  "Page `:page-copies`, current at the end, holds 60 rects with `color.bg` and
  the copy `:copy-x` of the component `:comp-x`. The main `:main-x`, a frame
  with the rect `:main-x-rect` (fill `color.bg`), lives on page `:page-mains`."
  []
  (-> (base-file-on :page-copies)
      (cthf/add-sample-page :page-mains)
      (ctho/add-frame :main-x)
      (ctho/add-rect :main-x-rect :parent-label :main-x)
      (ctht/apply-token-to-shape :main-x-rect "color.bg" [:fill] [:fill] (:bg light))
      (cthc/make-component :comp-x :main-x)
      (cthf/switch-to-page :page-copies)
      (add-dark-rects "fill-" 60)
      (cthc/instantiate-component :comp-x :copy-x :children-labels [:copy-x-rect])))

(defn- many-page-label
  [i]
  (keyword (str "many-" i)))

(defn- many-rect-label
  [i]
  (keyword (str "many-rect-" i)))

(defn- build-many-pages-file
  "300 pages, `many-0` first and current at the end. Pages 0, 7, 14, ... (40 of
  them) hold one rect with the fill `color.bg`."
  []
  (let [file (reduce (fn [file i]
                       (cthf/add-sample-page file (many-page-label i)))
                     (base-file-on (many-page-label 0))
                     (range 1 300))]
    (-> (reduce (fn [file i]
                  (-> file
                      (cthf/switch-to-page (many-page-label i))
                      (ctho/add-rect (many-rect-label i))
                      (ctht/apply-token-to-shape (many-rect-label i) "color.bg"
                                                 [:fill] [:fill] (:bg light))))
                file
                (range 0 280 7))
        (cthf/switch-to-page (many-page-label 0)))))

;; Helpers --------------------------------------------------------------------

(defn- state-file
  "The file of the store's state."
  [store]
  (ths/get-file-from-state @store))

(defn- pages-objects
  "The objects of every page of the file data `data`, by page id."
  [data]
  (into {}
        (map (fn [[page-id page]] [page-id (:objects page)]))
        (:pages-index data)))

(defn- comparable
  "The objects without their position data, and their shadows without ids.
  Shadow ids are random: a main and its copies share them, the legacy path
  makes new ones."
  [objects]
  (into {}
        (map (fn [[id shape]]
               [id (-> shape
                       (dissoc :position-data)
                       (d/update-when :shadow #(mapv (fn [shadow] (dissoc shadow :id)) %)))]))
        objects))

(defn- text-nodes
  [shape]
  (vec (txt/node-seq txt/is-text-node? (:content shape))))

(defn- touched-components
  "The ids of the components touched by the events `events`."
  [events]
  (into #{}
        (comp (filter #(ptk/type? ::dwl/touch-component %))
              (map (fn [event] (first @event))))
        events))

(defn- noop-render-thumbnail
  [& _]
  (ptk/reify ::noop-render-thumbnail
    ptk/WatchEvent
    (watch [_ _ _] (rx/empty))))

(defn- emit-until
  "Emits `events` on `store`. Returns a promise resolved once an event of
  type `done-type` has passed the store. The observation starts before the
  first event goes out."
  [store done-type events]
  (let [finished (async/observe (->> (ptk/input-stream store)
                                     (rx/filter (ptk/type? done-type))
                                     (rx/take 1))
                                :timeout-ms 5000)]
    (doseq [event events]
      (ptk/emit! store event))
    finished))

(defn- run-events
  "Emits `events` on `store` and returns a promise resolved once the store has
  processed them, through the end marker of `tohs/run-store-async`. For events
  with no done event of their own, such as `dwl/sync-file`."
  [store events]
  (js/Promise.
   (fn [resolve _reject]
     (tohs/run-store-async store #(resolve nil) events (fn [_] nil)))))

(defn- assert-dark-values
  "The values of the Dark theme on the shapes of `file`, the state after the
  propagation. `fixture` is the file the run started from."
  [file fixture]
  (let [rect        (shape-of file :page-ds :a-rect)
        text        (shape-of file :page-ds :a-text)
        copy1       (shape-of file :page-screens :copy1-rect)
        copy2       (shape-of file :page-screens :copy2-rect)
        copy2-fixed (shape-of fixture :page-screens :copy2-rect)
        copy3-nodes (text-nodes (shape-of file :page-screens :copy3-text))]
    (t/is (= "#000000" (-> rect :fills first :fill-color))
          "the rect takes the dark background")
    (t/is (= "#eeeeee" (-> rect :strokes first :stroke-color))
          "the rect takes the dark stroke colour")
    (t/is (= 2 (-> rect :strokes first :stroke-width))
          "the rect takes the dark stroke width")
    (t/is (= 8 (:r1 rect))
          "the rect takes the dark radius")
    (t/is (= 0.6 (:opacity text))
          "the text takes the dark opacity")
    (t/is (= "#000000" (-> copy1 :fills first :fill-color))
          "the plain copy takes the dark background")
    (t/is (= "#3388ff" (-> copy2 :fills first :fill-color))
          "the overriding copy takes the dark accent")
    (t/is (= "color.accent" (get-in copy2 [:applied-tokens :fill]))
          "the overriding copy keeps its accent token")
    (t/is (= (:touched copy2-fixed) (:touched copy2))
          "the overriding copy keeps its touched flags")
    (t/is (seq copy3-nodes)
          "the edited copy keeps its text nodes")
    (t/is (every? #(= "Edited" (:text %)) copy3-nodes)
          "the edited copy keeps its text")
    (t/is (every? #(= [(fill-of (:fg dark))] (:fills %)) copy3-nodes)
          "the edited copy takes the dark text colour")))

(defn- ^:async check-equivalence
  "Runs the legacy path with component sync, and the new propagation alone,
  from the same file. The shapes must match, bar their position data."
  [file]
  (let [store-legacy (ths/setup-store file)
        store-new    (ths/setup-store file)
        file-id      (:id file)]
    (await (emit-until store-legacy ::dwu/commit-undo-transaction
                       [(legacy-propagate-workspace-tokens)]))
    (await (run-events store-legacy
                       [(dwl/sync-file file-id file-id :components (cthi/id :comp-a))
                        (dwl/sync-file file-id file-id :components (cthi/id :comp-b))]))
    (await (emit-until store-new ::dwtp/propagation-done
                       [(dwtp/propagate-workspace-tokens)]))

    (let [legacy-objects (pages-objects (:data (state-file store-legacy)))
          new-objects    (pages-objects (:data (state-file store-new)))]
      (doseq [[page-id objects] legacy-objects]
        (let [expected  (comparable objects)
              actual    (comparable (get new-objects page-id))
              ids       (distinct (concat (keys expected) (keys actual)))
              differing (filter #(not= (get expected %) (get actual %)) ids)]
          (t/is (empty? differing)
                (str "page " page-id ", differing shapes: "
                     (pr-str (map cthi/label differing))))
          (when-let [id (first differing)]
            (t/is (= (get expected id) (get actual id))
                  (str "first difference, shape " (cthi/label id) ": "
                       (pr-str (data/diff (get expected id) (get actual id)))))))))

    (assert-dark-values (state-file store-new) file)))

(defn- dark?
  [color]
  (= "#000000" color))

(defn- fills-on
  "The first fill colour of the rects `<prefix><i>` of the page `page-label`,
  for i below `n`, the rect `skip-label` left out."
  ([store page-label prefix n]
   (fills-on store page-label prefix n nil))
  ([store page-label prefix n skip-label]
   (let [file (state-file store)]
     (->> (range n)
          (map #(keyword (str prefix %)))
          (remove #(= skip-label %))
          (mapv (fn [label]
                  (-> (shape-of file page-label label) :fills first :fill-color)))))))

(defn- all-rect-fills
  "The first fill colour of every rect of `build-rects-pages`."
  [store]
  (concat (fills-on store :page-ds "rect-" 120)
          (fills-on store :page-two "rect2-" 120)))

(defn- partly-dark?
  "True when some of the fills are dark, and not all of them."
  [fills]
  (and (some dark? fills)
       (not (every? dark? fills))))

(defn- touch-counts
  "How many times each component is touched by the events `events`."
  [events]
  (frequencies
   (into []
         (comp (filter #(ptk/type? ::dwl/touch-component %))
               (map (fn [event] (first @event))))
         events)))

;; Tests ----------------------------------------------------------------------

(t/deftest ^:async new-propagation-matches-legacy-and-sync
  (let [file (build-file)]
    (cthf/validate-file! file)
    (await (check-equivalence file))))

(t/deftest ^:async new-propagation-matches-legacy-and-sync-with-page-2-current
  (await (check-equivalence (cthf/switch-to-page (build-file) :page-screens))))

(t/deftest ^:async position-data-on-other-pages
  (let [file  (build-file)
        store (ths/setup-store file)]
    (await (emit-until store ::dwtp/propagation-done
                       [(dwtp/propagate-workspace-tokens)]))
    (let [file'    (state-file store)
          dark-fg  (fill-of (:fg dark))
          expected (fn [label]
                     (mapv #(update % :fills types.fills/assoc 0 dark-fg)
                           (:position-data (shape-of file :page-screens label))))]
      (t/is (= (expected :loose-text)
               (:position-data (shape-of file' :page-screens :loose-text)))
            "the loose text keeps its position data, with the dark fill")
      (t/is (nil? (:position-data (shape-of file' :page-screens :stale-text)))
            "the text whose position data does not match loses it")
      (t/is (nil? (:position-data (shape-of file' :page-screens :nopd-text)))
            "the text without position data gets none")
      (doseq [label [:copy1-text :copy2-text :copy3-text]]
        (t/is (= (expected label)
                 (:position-data (shape-of file' :page-screens label)))
              (str label " keeps its position data, with the dark fill"))))))

(t/deftest ^:async one-undo-step-and-redo
  (let [file   (build-file)
        store  (ths/setup-store file)
        before (pages-objects (:data file))]
    (ptk/emit! store (tohs/watch-undo-stack))
    (await (emit-until store ::dwtp/propagation-done
                       [(dwtp/propagate-workspace-tokens)]))
    (let [after (pages-objects (:data (state-file store)))]
      (t/is (= 1 (count (get-in @store [:workspace-undo :items])))
            "the whole run is one undo entry")

      (ptk/emit! store dwu/undo)
      (await (async/wait-for #(= before (pages-objects (:data (state-file store))))
                             "undo to restore the fixture"))
      (t/is (= before (pages-objects (:data (state-file store))))
            "undo restores every page, position data and touched flags included")

      (ptk/emit! store dwu/redo)
      (await (async/wait-for #(= after (pages-objects (:data (state-file store))))
                             "redo to apply the run again"))
      (t/is (= after (pages-objects (:data (state-file store))))
            "redo applies the run again"))))

(t/deftest ^:async tokenscript-resolver
  (let [file  (build-file)
        store (ths/setup-store file)]
    (await
     (mock/with-mocks*
       {cf/flags (conj cf/flags :tokenscript)}
       (await (emit-until store ::dwtp/propagation-done
                          [(dwtp/propagate-workspace-tokens)]))))
    (assert-dark-values (state-file store) file)))

(t/deftest ^:async watcher-does-not-resync-copies
  (let [file  (build-file)
        store (ths/setup-store file)
        seen  (atom [])]
    (await
     (mock/with-mocks*
       {;; The watcher reads the file data through this lens.
        refs/workspace-data       (l/derived dsh/lookup-file-data store)
        ;; Thumbnail renders read the global store.
        st/state                  store
        dwt.wasm/render-thumbnail noop-render-thumbnail}

       (ptk/emit! store (dwl/watch-component-changes))
       (->> (ptk/input-stream store)
            (rx/subs! (fn [event] (swap! seen conj event))
                      (fn [_] nil)))

       (await (emit-until store ::dwtp/propagation-done
                          [(dwtp/propagate-workspace-tokens)]))
       (await (async/wait-for
               #(let [touched (touched-components @seen)]
                  (and (contains? touched (cthi/id :comp-a))
                       (contains? touched (cthi/id :comp-b))))
               "the components to be touched"))
       (await (async/settle))

       (let [types (map ptk/type @seen)]
         (t/is (not-any? #{::dwl/sync-file} types)
               "the watcher does not sync the copies after the propagation"))

       (ptk/emit! store (dwpg/finalize-page (:id file) (cthf/current-page-id file)))
       (await (async/settle))))

    (assert-dark-values (state-file store) file)))

(defn- rect-fills
  "The first fill colour of every rect, in the store's state."
  [store]
  (let [file (state-file store)]
    (mapv (fn [i]
            (-> (shape-of file :page-ds (rect-label i))
                :fills first :fill-color))
          (range 300))))

(t/deftest ^:async many-shapes-one-undo-step
  (let [file  (build-rects-file)
        store (ths/setup-store file)]
    (ptk/emit! store (tohs/watch-undo-stack))
    (await (emit-until store ::dwtp/propagation-done
                       [(dwtp/propagate-workspace-tokens)]))
    (await (async/wait-for #(every? #{"#000000"} (rect-fills store))
                           "every rect to take the dark background"))
    (t/is (= 1 (count (get-in @store [:workspace-undo :items])))
          "the 300 rects are one undo entry")

    (ptk/emit! store dwu/undo)
    (await (async/wait-for #(every? #{"#ffffff"} (rect-fills store))
                           "undo to restore the light background of every rect"))
    (t/is (every? #{"#ffffff"} (rect-fills store))
          "undo restores the light background of every rect")))

(t/deftest ^:async shadow-ids-shared-by-main-and-copies
  (let [file  (build-file)
        store (ths/setup-store file)]
    (await (emit-until store ::dwtp/propagation-done
                       [(dwtp/propagate-workspace-tokens)]))
    (let [file'  (state-file store)
          main   (shape-of file' :page-ds :a-rect)
          copy1  (shape-of file' :page-screens :copy1-rect)]
      (t/is (seq (:shadow main))
            "the main gets its shadow from the propagation")
      (t/is (seq (:shadow copy1))
            "the copy gets its shadow from the propagation")
      (t/is (= (:shadow main) (:shadow copy1))
            "the copy and its main share the shadow, ids included"))))

(t/deftest ^:async sync-during-run-does-not-revert-copies
  (let [file  (build-sync-file)
        store (ths/setup-store file)]
    (await
     (mock/with-mocks*
       {;; The watcher reads the file data through this lens.
        refs/workspace-data       (l/derived dsh/lookup-file-data store)
        ;; Thumbnail renders read the global store.
        st/state                  store
        dwt.wasm/render-thumbnail noop-render-thumbnail
        cf/flags                  (conj cf/flags :tokenscript)
        dwtp/min-shapes           5
        dwtp/scan-budget-ms       0
        dwtp/build-budget-ms      0
        dwtp/budget-ms            0}

       (ptk/emit! store (dwl/watch-component-changes))
       (let [finished (async/observe (->> (ptk/input-stream store)
                                          (rx/filter (ptk/type? ::dwtp/propagation-done))
                                          (rx/take 1))
                                     :timeout-ms 5000)]
         ;; One batch: the change to the main and the start of the run.
         (ptk/emit! store
                    (dwsh/update-shapes [(cthi/id :main-x-rect)]
                                        #(assoc % :name "Renamed")
                                        {:page-id (cthi/id :page-mains)})
                    (dwtp/propagate-workspace-tokens))
         (await finished))

       (await (async/wait-for #(= "Renamed"
                                  (:name (shape-of (state-file store) :page-copies :copy-x-rect)))
                              "the held sync to rename the copy"
                              {:max-ticks 200}))
       (let [copy (shape-of (state-file store) :page-copies :copy-x-rect)]
         (t/is (= "#000000" (-> copy :fills first :fill-color))
               "the copy keeps the dark background after the sync")
         (t/is (= "Renamed" (:name copy))
               "the copy takes the new name of its main"))

       (ptk/emit! store (dwpg/finalize-page (:id file) (cthf/current-page-id file)))
       (await (async/settle))))))

(t/deftest ^:async undo-during-run-is-refused
  (let [file  (build-rects-pages)
        store (ths/setup-store file)]
    (ptk/emit! store (tohs/watch-undo-stack))
    (ptk/emit! store (dwsh/update-shapes [(cthi/id :rect2-0)]
                                         #(assoc % :name "Renamed")
                                         {:page-id (cthi/id :page-two)}))
    (await
     (mock/with-mocks*
       {dwtp/min-shapes      5
        dwtp/scan-budget-ms  0
        dwtp/build-budget-ms 0
        dwtp/budget-ms       0}

       (let [finished (emit-until store ::dwtp/propagation-done
                                  [(dwtp/propagate-workspace-tokens)])]
         (await (async/wait-for #(partly-dark? (all-rect-fills store))
                                "a pause part-way through the run"))
         (t/is (dwtp/running? @store)
               "the run is still active at the pause")

         (ptk/emit! store dwu/undo)
         (await finished)
         (t/is (every? dark? (all-rect-fills store))
               "the undo does nothing: every rect keeps the dark background")
         (t/is (= "Renamed" (:name (shape-of (state-file store) :page-two :rect2-0)))
               "the rename stays")
         (t/is (= 2 (count (get-in @store [:workspace-undo :items])))
               "the rename and the run are the two undo entries")

         (ptk/emit! store dwu/undo)
         (await (async/wait-for #(every? #{"#ffffff"} (all-rect-fills store))
                                "the second undo to restore the light background"))
         (t/is (= "Renamed" (:name (shape-of (state-file store) :page-two :rect2-0)))
               "the rename stays after the second undo"))))))

(t/deftest ^:async edit-during-run-is-kept
  (let [file  (build-rects-pages)
        store (ths/setup-store file)]
    (await
     (mock/with-mocks*
       {dwtp/min-shapes      5
        dwtp/scan-budget-ms  0
        dwtp/build-budget-ms 0
        dwtp/budget-ms       0}

       (let [finished (emit-until store ::dwtp/propagation-done
                                  [(dwtp/propagate-workspace-tokens)])]
         (await (async/wait-for #(partly-dark? (all-rect-fills store))
                                "a pause part-way through the run"))
         ;; A rect of page two the run has not reached yet.
         (let [index (last (keep-indexed (fn [i fill] (when (= "#ffffff" fill) i))
                                         (fills-on store :page-two "rect2-" 120)))
               label (keyword (str "rect2-" index))]
           (t/is (some? index)
                 "a rect of page two still has the light background")
           (ptk/emit! store (dwsh/update-shapes [(cthi/id label)]
                                                #(assoc % :fills [{:fill-color "#ff0000"
                                                                   :fill-opacity 1}])
                                                {:page-id (cthi/id :page-two)}))
           (await finished)

           (let [edited (shape-of (state-file store) :page-two label)]
             (t/is (= "#ff0000" (-> edited :fills first :fill-color))
                   "the user fill is kept")
             (t/is (not (contains? (:applied-tokens edited) :fill))
                   "the user fill removes the fill token"))

           (t/is (every? dark? (concat (fills-on store :page-ds "rect-" 120)
                                       (fills-on store :page-two "rect2-" 120 label)))
                 "every other rect takes the dark background")))))))

(t/deftest ^:async finish-before-close
  (let [file  (build-rects-pages)
        store (ths/setup-store file)]
    (ptk/emit! store (tohs/watch-undo-stack))
    (await
     (mock/with-mocks*
       {dwtp/min-shapes      5
        dwtp/scan-budget-ms  0
        dwtp/build-budget-ms 0
        dwtp/budget-ms       0}

       (let [finished (emit-until store ::dwtp/propagation-done
                                  [(dwtp/propagate-workspace-tokens)])]
         (await (async/wait-for #(partly-dark? (all-rect-fills store))
                                "a pause part-way through the run"))
         (t/is (contains? @st/ongoing-tasks :token-propagation)
               "the run is an ongoing task at the pause")

         (ptk/emit! store (dwtp/finish-propagation))
         (t/is (every? dark? (all-rect-fills store))
               "finishing the run propagates every rect at once")
         (t/is (not (dwtp/running? @store))
               "the run is no longer active")
         (t/is (not (contains? @st/ongoing-tasks :token-propagation))
               "the run is no longer an ongoing task")
         (t/is (= 1 (count (get-in @store [:workspace-undo :items])))
               "the finished run is one undo entry")
         (await finished))))))

(t/deftest ^:async page-switch-during-run
  (let [file   (build-rects-pages)
        store  (ths/setup-store file)
        switch (ptk/reify ::switch-to-page-two
                 ptk/UpdateEvent
                 (update [_ state]
                   (assoc state :current-page-id (cthi/id :page-two))))]
    (ptk/emit! store (tohs/watch-undo-stack))
    (await
     (mock/with-mocks*
       {dwtp/min-shapes      5
        dwtp/scan-budget-ms  0
        dwtp/build-budget-ms 0
        dwtp/budget-ms       0}

       (let [finished (emit-until store ::dwtp/propagation-done
                                  [(dwtp/propagate-workspace-tokens)])]
         (await (async/wait-for #(partly-dark? (all-rect-fills store))
                                "a pause part-way through the run"))
         (ptk/emit! store switch)
         (await finished)
         (t/is (every? dark? (all-rect-fills store))
               "every rect of both pages takes the dark background")
         (t/is (= 1 (count (get-in @store [:workspace-undo :items])))
               "the run is one undo entry"))))))

(t/deftest ^:async many-small-pages
  (let [file  (build-many-pages-file)
        store (ths/setup-store file)]
    (await (emit-until store ::dwtp/propagation-done
                       [(dwtp/propagate-workspace-tokens)]))
    (let [fills (mapv (fn [i]
                        (-> (shape-of (state-file store)
                                      (many-page-label i)
                                      (many-rect-label i))
                            :fills first :fill-color))
                      (range 0 280 7))]
      (t/is (every? dark? fills)
            "every rect of the 40 pages takes the dark background"))))

(t/deftest ^:async token-change-during-run-restarts
  (let [file  (build-rects-pages)
        store (ths/setup-store file)]
    (await
     (mock/with-mocks*
       {dwtp/min-shapes      5
        dwtp/scan-budget-ms  0
        dwtp/build-budget-ms 0
        dwtp/budget-ms       0}

       (let [finished (emit-until store ::dwtp/propagation-done
                                  [(dwtp/propagate-workspace-tokens)])]
         (await (async/wait-for #(partly-dark? (all-rect-fills store))
                                "a pause part-way through the run"))
         ;; A plain commit of the token: it does not propagate by itself.
         (ptk/emit! store (dwtl/update-token (cthi/id :set-dark)
                                             (cthi/id [:set-dark "color.bg"])
                                             {:value "#123456"}))
         ;; The first run ends when it notices the change, and a new one starts.
         (await finished)
         (await (async/wait-for #(and (not (dwtp/running? @store))
                                      (every? #{"#123456"} (all-rect-fills store)))
                                "the new run to give every rect the new value"
                                {:max-ticks 400}))
         (t/is (every? #{"#123456"} (all-rect-fills store))
               "every rect of both pages takes the new dark background"))))))

(t/deftest ^:async component-touched-once-per-run
  (let [file  (build-file)
        store (ths/setup-store file)
        seen  (atom [])]
    (await
     (mock/with-mocks*
       {;; The watcher reads the file data through this lens.
        refs/workspace-data       (l/derived dsh/lookup-file-data store)
        ;; Thumbnail renders read the global store.
        st/state                  store
        dwt.wasm/render-thumbnail noop-render-thumbnail
        dwtp/min-shapes           5
        dwtp/scan-budget-ms       0
        dwtp/build-budget-ms      0
        dwtp/budget-ms            0}

       (ptk/emit! store (dwl/watch-component-changes))
       (->> (ptk/input-stream store)
            (rx/subs! (fn [event] (swap! seen conj event))
                      (fn [_] nil)))

       (await (emit-until store ::dwtp/propagation-done
                          [(dwtp/propagate-workspace-tokens)]))
       (await (async/settle))

       (let [touches (touch-counts @seen)]
         (t/is (= 1 (get touches (cthi/id :comp-a)))
               "the run touches component A once")
         (t/is (= 1 (get touches (cthi/id :comp-b)))
               "the run touches component B once"))

       (ptk/emit! store (dwpg/finalize-page (:id file) (cthf/current-page-id file)))
       (await (async/settle))))))
