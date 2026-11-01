;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.viewport.frame-grid
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.geom.grid :as gg]
   [app.common.geom.rect :as grc]
   [app.common.math :as mth]
   [app.common.types.objects-hints :as ohints]
   [app.common.types.objects-map :as omap]
   [app.common.types.shape-tree :as ctst]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.refs :as refs]
   [app.main.ui.workspace.viewport.rulers :as rulers]
   [app.render-wasm.api :as wasm.api]
   [rumext.v2 :as mf]))

(mf/defc square-grid* [{:keys [frame zoom grid]}]
  (let [grid-id (mf/use-memo #(uuid/next))
        {:keys [size] :as params} (-> grid :params)
        {color-value :color color-opacity :opacity} (-> grid :params :color)
        ;; Support for old color format
        color-value (or color-value (:value (get-in grid [:params :color :value])))]

    [:g.grid
     [:defs
      [:pattern {:id grid-id
                 :x (:x frame)
                 :y (:y frame)
                 :width size
                 :height size
                 :pattern-units "userSpaceOnUse"}
       [:path {:d (str "M " size " " 0 " "
                       "L " 0 " " 0 " " 0 " " size " ")
               :style {:fill "none"
                       :stroke color-value
                       :stroke-opacity color-opacity
                       :stroke-width (str (/ 1 zoom))}}]]]

     [:rect {:x (:x frame)
             :y (:y frame)
             :width (:width frame)
             :height (:height frame)
             :fill (str "url(#" grid-id ")")}]]))

(mf/defc layout-grid*
  [{:keys [key frame grid zoom]}]
  (let [{color-value :color color-opacity :opacity} (-> grid :params :color)
        ;; Support for old color format
        color-value (or color-value (:value (get-in grid [:params :color :value])))
        gutter (gg/grid-gutter frame grid)
        gutter? (and (not (nil? gutter)) (not (mth/almost-zero? gutter)))]

    [:g.grid
     (for [[idx {:keys [x y width height] :as area}] (d/enumerate (gg/grid-areas frame grid))]
       (cond
         gutter?
         [:rect {:key (str key "-" x "-" y)
                 :x x
                 :y y
                 :width (- (+ x width) x)
                 :height (- (+ y height) y)
                 :style {:fill color-value
                         :stroke-width 0
                         :opacity color-opacity}}]

         (and (not gutter?) (= :column (:type grid)))
         [:*
          (when (= idx 0)
            [:line {:key (str key "-" x "-" y "-start")
                    :x1 x
                    :y1 y
                    :x2 x
                    :y2 (+ y height)
                    :style {:stroke color-value
                            :stroke-width (/ 1 zoom)
                            :strokeOpacity color-opacity
                            :fill "none"}}])

          [:line {:key (str key "-" x "-" y "-end")
                  :x1 (+ x width)
                  :y1 y
                  :x2 (+ x width)
                  :y2 (+ y height)
                  :style {:stroke color-value
                          :stroke-width (/ 1 zoom)
                          :strokeOpacity color-opacity
                          :fill "none"}}]]

         (and (not gutter?) (= :row (:type grid)))
         [:*
          (when (= idx 0)
            [:line {:key (str key "-" x "-" y "-start")
                    :x1 x
                    :y1 y
                    :x2 (+ x width)
                    :y2 y
                    :style {:stroke color-value
                            :stroke-width (/ 1 zoom)
                            :strokeOpacity color-opacity
                            :fill "none"}}])

          [:line {:key (str key "-" x "-" y "-end")
                  :x1 x
                  :y1 (+ y height)
                  :x2 (+ x width)
                  :y2 (+ y height)
                  :style {:stroke color-value
                          :stroke-width (/ 1 zoom)
                          :strokeOpacity color-opacity
                          :fill "none"}}]]))]))

(defn frame-clip-area
  [{:keys [selrect]} parents]
  (reduce
   (fn [sr parent]
     (cond-> sr
       (and (not (cfh/root? parent))
            (cfh/frame-shape? parent)
            (not (:show-content parent)))
       (grc/clip-rect (:selrect parent))))
   selrect
   parents))

(mf/defc grid-display-frame*
  {::mf/wrap [mf/memo]}
  [{:keys [frame zoom transforming]}]
  (let [frame-id (:id frame)
        parents-ref (mf/with-memo [frame-id] (refs/shape-parents frame-id))
        parents     (mf/deref parents-ref)
        clip-area (frame-clip-area frame parents)
        clip-id (dm/str (:id frame) "-grid-clip")

        transform?
        (or (contains? transforming frame-id)
            (some #(contains? transforming %) (map :id parents)))]

    (when-not transform?
      [:g {:clip-path (dm/fmt "url(#%)" clip-id)}
       [:defs
        [:clipPath {:id clip-id}
         [:rect {:x (:x clip-area)
                 :y (:y clip-area)
                 :width (:width clip-area)
                 :height (:height clip-area)}]]]

       (for [[index grid] (->> (:grids frame)
                               (filter :display)
                               (map-indexed vector))]
         (let [props #js {:key (str (:id frame) "-grid-" index)
                          :frame frame
                          :zoom zoom
                          :grid grid}]
           (case (:type grid)
             :square [:> square-grid* props]
             :column [:> layout-grid* props]
             :row    [:> layout-grid* props])))])))

(defn has-grid?
  [shape]
  (ohints/has-displayed-grid? shape))

;; Pages with at least this many shapes and no hints yet find their grid
;; frames in idle time. A smaller page is filtered at once.
(def ^:private big-page-shape-count 3000)

;; The most time one idle callback spends on the grid scan, in milliseconds.
(def ^:private scan-slice-ms 8)

(defn- grid-frames
  "Returns the frames of `objects` with a displayed grid, in map order."
  [objects]
  (into [] (filter has-grid?) (ctst/get-frames objects)))

(defn- grid-frames-by-hints
  "Same result as `grid-frames`. Only the shapes without a valid hint are
  read."
  [objects hints]
  (into []
        (keep (d/getf objects))
        (remove #(= uuid/zero %)
                (ohints/select-ids objects hints
                                   #(get-in hints [:frames % :grid?])
                                   #(and (cfh/frame-shape? %)
                                         (ohints/has-displayed-grid? %))))))

(defn- schedule-idle
  "Calls `f` in idle time, with the idle deadline when the browser has idle
  callbacks. Returns a fn that cancels the call."
  [f]
  (if (fn? (unchecked-get js/globalThis "requestIdleCallback"))
    (let [id (js/requestIdleCallback f)]
      #(js/cancelIdleCallback id))
    (let [id (js/setTimeout #(f nil) 16)]
      #(js/clearTimeout id))))

(defn- scan-grid-frames
  "Finds the frames with a displayed grid in `objects`, in map order, in
  slices of at most `scan-slice-ms` in idle time. Calls `on-done` with the
  frames when the scan ends. Returns a fn that cancels the scan."
  [objects on-done]
  (let [ids     (into [] (remove #(= uuid/zero %)) (keys objects))
        total   (count ids)
        state   (volatile! {:index 0 :frames []})
        cancel  (volatile! nil)

        step
        (fn step [deadline]
          (let [start (.now js/performance)
                {:keys [index frames]} @state

                ;; A slice always reads its first shape, so the scan moves
                ;; on even when the browser gives it no time.
                time-left?
                (fn [i]
                  (or (= i index)
                      (and (< (- (.now js/performance) start) scan-slice-ms)
                           (or (nil? deadline)
                               (> (.timeRemaining deadline) 1)))))]

            ;; While the page uploads, wait: the upload workers attach hints
            ;; early in the upload, which replaces `objects` and ends this scan.
            (loop [i      index
                   frames frames]
              (if (and (< i total)
                       (not @wasm.api/shapes-loading?)
                       (time-left? i))
                (let [shape (get objects (nth ids i))]
                  (recur (inc i)
                         (if (and (cfh/frame-shape? shape) (has-grid? shape))
                           (conj frames shape)
                           frames)))
                (if (< i total)
                  (do (vreset! state {:index i :frames frames})
                      (vreset! cancel (schedule-idle step)))
                  (on-done frames))))))]

    (vreset! cancel (schedule-idle step))
    #(when-let [cancel-fn @cancel]
       (cancel-fn))))

(defn- use-grid-frames
  "Returns the frames of the page `objects` with a displayed grid, in map
  order. Uses the hints of the page when they are attached. With the upload
  workers, a big page without hints is scanned in idle time. Until a scan
  ends, the frames of the last scan that ended are kept, so the grids do not
  vanish on a change."
  [objects]
  (let [hints   (ohints/hints objects)
        page-id (mf/deref refs/current-page-id)
        scan?   (and (contains? cf/flags :render-wasm-worker-upload)
                     (nil? hints)
                     (omap/objects-map? objects)
                     (>= (count objects) big-page-shape-count))
        scanned (mf/use-state nil)

        _       (mf/with-effect [objects scan?]
                  (when scan?
                    (scan-grid-frames objects #(reset! scanned {:page-id page-id
                                                                :frames  %}))))

        ;; Memoized per page value, so the frames are found once per change.
        frames  (mf/with-memo [objects]
                  (cond
                    scan?         nil
                    (some? hints) (grid-frames-by-hints objects hints)
                    :else         (grid-frames objects)))]

    (if scan?
      ;; The frames found on another page are never shown.
      (when (= page-id (:page-id @scanned))
        (:frames @scanned))
      frames)))

(mf/defc frame-grid*
  {::mf/wrap [mf/memo]}
  [{:keys [zoom transform selected focus vbox clip-rulers] :or {clip-rulers false}}]
  (let [objects       (mf/deref refs/workspace-page-objects)
        ;; Re-renders on every vbox/zoom change while panning; the frames
        ;; only change with the page, so the grid frames are found once per
        ;; page value.
        frames        (use-grid-frames objects)
        transforming  (when (some? transform) selected)]

    [:g.grid-display {:style {:pointer-events "none"}
                      :clip-path (when clip-rulers "url(#clip-frame-grid)")}
     (when clip-rulers
       [:> rulers/rulers-clip-path* {:id "clip-frame-grid" :vbox vbox :zoom zoom}])
     (for [frame frames]
       (when (and #_(not (is-transform? frame))
              (not (ctst/rotated-frame? frame))
                  (or (empty? focus) (contains? focus (:id frame))))
         [:> grid-display-frame* {:key (str "grid-" (:id frame))
                                  :zoom zoom
                                  :frame frame
                                  :transforming transforming}]))]))
