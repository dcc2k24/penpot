;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.workspace.thumbnails-wasm
  "WASM-based component thumbnail rendering.
   Renders component previews using the existing workspace WASM context
   via render-shape-pixels (SurfaceId::Export), avoiding a separate
   WASM module in the worker.

   Two-phase design:
   - render-thumbnail: WASM render in browser idle time → UI update (no server)
   - persist-thumbnail: pushes current data-uri to the server (debounced)"
  (:require
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.logging :as l]
   [app.common.math :as mth]
   [app.common.thumbnails :as thc]
   [app.common.time :as ct]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.thumbnails :as dwt]
   [app.main.repo :as rp]
   [app.main.store :as st]
   [app.render-wasm.api :as wasm.api]
   [app.render-wasm.page-cache :as page-cache]
   [app.util.timers :as timers]
   [app.util.webapi :as wapi]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]
   [promesa.core :as p]))

(l/set-level! :warn)

(defn- png-bytes->data-uri
  "Converts a Uint8Array of PNG bytes to a data:image/png;base64 URI."
  [png-bytes]
  (let [blob (wapi/create-blob png-bytes "image/png")
        reader (js/FileReader.)]
    (js/Promise.
     (fn [resolve reject]
       (set! (.-onload reader)
             (fn [] (resolve (.-result reader))))
       (set! (.-onerror reader)
             (fn [e] (reject e)))
       (.readAsDataURL reader blob)))))

;; This constant stores the target thumbnail minimum max-size so
;; the images doesn't lose quality when rendered
(def ^:private ^:const target-size 200)

;; A thumbnail render takes the main thread (100+ ms for a large component)
;; and shares the WASM renderer with the canvas. Renders run in a browser idle
;; period with no canvas render pending, one per turn and in request order, so
;; a burst of component changes (a theme switch) updates the canvas first. A
;; turn waits at most `idle-turn-timeout-ms`, so constant interaction delays
;; thumbnails without stopping them. The image is the same: it is rendered from
;; the current shapes.

(defn- render-component-pixels
  "Renders a component frame using the workspace WASM context, as soon as
   it is subscribed to (in an idle turn, see `wait-idle-turn`). Returns an
   observable that emits a data-uri string."
  [file-id page-id frame-id]
  (rx/create
   (fn [subs]
     (try
       (let [objects (dsh/lookup-page-objects @st/state file-id page-id)]
         (if-let [frame (get objects frame-id)]
           (let [{ext-w :width ext-h :height} (wasm.api/get-shape-extrect frame-id)
                 {sel-w :width sel-h :height} (:selrect frame)
                 max-size (mth/max (or ext-w sel-w) (or ext-h sel-h))
                 scale (mth/max 1 (/ target-size max-size))
                 ;; Thumbnails are always PNG: they need the alpha
                 ;; channel and are consumed as a `image/png` data uri.
                 png-bytes (wasm.api/render-shape-pixels frame-id scale :png)]
             (if (or (nil? png-bytes) (zero? (.-length png-bytes)))
               (do
                 (l/error :hint "render-shape-pixels returned empty" :frame-id (str frame-id))
                 (rx/end! subs))
               (.then
                (png-bytes->data-uri png-bytes)
                (fn [data-uri]
                  (rx/push! subs data-uri)
                  (rx/end! subs))
                (fn [err]
                  (rx/error! subs err)))))

           ;; A missing frame. Nothing to render, so end quietly.
           (rx/end! subs)))
       (catch :default err
         (rx/error! subs err)))
     nil)))

(defonce ^:private idle-turn* (atom (p/resolved nil)))

(def ^:private idle-turn-timeout-ms
  "Longest wait for an idle period with no canvas render pending. The render
  then runs between frames: it saves and restores the canvas render state."
  3000)

(defn- wait-idle-turn
  "Returns an observable that emits once, after every turn requested before
  it, in a browser idle period with no canvas render pending, or when
  `idle-turn-timeout-ms` has passed since the turn started. Subscribers
  render synchronously on emission, inside the callback."
  []
  (rx/create
   (fn [subs]
     (let [done?    (volatile! false)
           idle     (volatile! nil)
           deadline (volatile! nil)
           turn     (p/deferred)
           previous @idle-turn*]
       (reset! idle-turn* turn)
       (letfn [(finish! []
                 (vreset! done? true)
                 (some-> @idle rx/dispose!)
                 (some-> @deadline rx/dispose!)
                 (p/resolve! turn nil))
               (grant! []
                 (when-not @done?
                   (finish!)
                   (rx/push! subs nil)
                   (rx/end! subs)))
               (attempt []
                 (vreset! idle
                          (timers/schedule-on-idle
                           (fn []
                             (when-not @done?
                               (if (wasm.api/render-pending?)
                                 (attempt)
                                 (grant!)))))))]
         (p/finally previous
                    (fn [_ _]
                      (when-not @done?
                        (vreset! deadline (timers/schedule idle-turn-timeout-ms grant!))
                        (attempt))))
         ;; A turn given up before its time still ends in order: the next turn
         ;; waits for the ones before this one.
         (fn []
           (when-not @done?
             (vreset! done? true)
             (some-> @idle rx/dispose!)
             (some-> @deadline rx/dispose!)
             (p/finally previous (fn [_ _] (p/resolve! turn nil))))))))))

(defn render-thumbnail
  "Renders a component thumbnail via WASM in the next idle turn (see
   `wait-idle-turn`) and updates the UI.
   When `persist?` is true, also persists the rendered thumbnail to the
   server in the same observable chain (guaranteeing correct ordering)."
  [file-id page-id frame-id & {:keys [persist?] :or {persist? false}}]

  (let [object-id (thc/fmt-object-id file-id page-id frame-id "component")]
    (ptk/reify ::render-thumbnail
      cljs.core/IDeref
      (-deref [_] object-id)

      ptk/WatchEvent
      (watch [_ _ stream]
        ;; When the component is removed it can arrived a render
        ;; request with frame-id=null
        (when (some? frame-id)
          (letfn [(load-objects-stream
                    [subtree]
                    (rx/create
                     (fn [subs]
                       ;; The shapes join the pool of the page on screen: that
                       ;; pool no longer matches its page, so it is not cached.
                       (page-cache/taint-resident!)
                       (try
                         (wasm.api/set-objects subtree
                                               (fn [& _]
                                                 (rx/push! subs nil)
                                                 (rx/end! subs)))
                         (catch :default err
                           (rx/error! subs err)))
                       nil)))

                  (render-off-page
                    [state]
                    (let [objects (dsh/lookup-page-objects state file-id page-id)
                          ;; retrieves a subtree with only the id and its children
                          ;; to be loaded before rendering the thumbnail
                          subtree (into {}
                                        (map #(vector (:id %) %))
                                        (cfh/get-children-with-self objects frame-id))]
                      ;; Nothing to render when the component or its page is
                      ;; gone, or the renderer is not running (left workspace).
                      (if (and (seq subtree) (wasm.api/initialized?))
                        (->> (load-objects-stream subtree)
                             (rx/mapcat do-render-thumbnail))
                        (rx/empty))))

                  (persist-to-server
                    [data-uri]
                    (let [blob (wapi/data-uri->blob data-uri)]
                      (->> (rp/cmd! :create-file-object-thumbnail
                                    {:file-id file-id
                                     :object-id object-id
                                     :media blob
                                     :tag "component"})
                           (rx/catch rx/empty)
                           (rx/ignore))))

                  (do-render-thumbnail
                    []
                    (let [tp (ct/tpoint-ms)]
                      (->> (render-component-pixels file-id page-id frame-id)
                           (rx/mapcat
                            (fn [data-uri]
                              (l/dbg :hint "component thumbnail rendered (wasm)"
                                     :elapsed (dm/str (tp) "ms"))
                              (if persist?
                                (rx/merge
                                 (rx/of (dwt/assoc-thumbnail object-id data-uri))
                                 (persist-to-server data-uri))
                                (rx/of (dwt/assoc-thumbnail object-id data-uri)))))

                           (rx/catch (fn [err]
                                       (js/console.error err)
                                       (l/error :hint "error rendering component thumbnail" :frame-id (str frame-id))
                                       (rx/empty)))

                           (rx/take-until
                            (->> stream
                                 (rx/filter (ptk/type? ::dwt/clear-thumbnail))
                                 (rx/filter #(= (deref %) object-id)))))))]

            ;; A persisting render does not queue: it comes after edits stopped,
            ;; and waiting behind the queue could lose it on a file close. It
            ;; still runs in a task of its own, not in the one that asked for it.
            ;; Read the state when the turn comes: the page may have changed.
            (->> (if persist? (rx/timer 0) (wait-idle-turn))
                 (rx/mapcat
                  (fn [_]
                    (let [state @st/state]
                      (if (not= page-id (:current-page-id state))
                        (render-off-page state)
                        (do-render-thumbnail)))))
                 (rx/catch (fn [err]
                             (l/error :hint "error loading component thumbnail" :frame-id (str frame-id) :cause err)
                             (rx/empty)))
                 (rx/take-until
                  (->> stream
                       (rx/filter (ptk/type? ::dwt/clear-thumbnail))
                       (rx/filter #(= (deref %) object-id)))))))))))

(defn persist-thumbnail
  "Persists the current component thumbnail data-uri to the server.
   Expects that `render-thumbnail` has already been called so the
   data-uri is present in app state. If not, this is a no-op."
  [file-id page-id frame-id]
  (let [object-id (thc/fmt-object-id file-id page-id frame-id "component")]
    (ptk/reify ::persist-thumbnail
      ptk/WatchEvent
      (watch [_ state _]
        (let [data-uri (dm/get-in state [:thumbnails object-id :uri])]
          (if (and (some? data-uri)
                   (str/starts-with? data-uri "data:"))
            (let [blob (wapi/data-uri->blob data-uri)]
              (->> (rp/cmd! :create-file-object-thumbnail
                            {:file-id file-id
                             :object-id object-id
                             :media blob
                             :tag "component"})
                   (rx/catch rx/empty)
                   (rx/ignore)))
            (rx/empty)))))))
