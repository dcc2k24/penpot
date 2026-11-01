(ns app.main.data.render-wasm
  (:require
   [app.common.types.objects-hints :as ohints]
   [app.common.types.shape-tree :as ctst]
   [app.main.data.helpers :as dsh]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(defn set-page-objects-hints
  "Attaches the hints `hints` of the worker upload to the objects of the page
  `page-id` of the file `file-id`. Does nothing when the page is missing."
  [file-id page-id hints]
  (ptk/reify ::set-page-objects-hints
    ptk/UpdateEvent
    (update [_ state]
      (dsh/update-page state file-id page-id
                       (fn [page]
                         (update page :objects
                                 #(ctst/start-page-index
                                   (ohints/with-hints % hints))))))))

(defn context-lost
  []
  (ptk/reify ::context-lost
    ptk/UpdateEvent
    (update [_ state]
      (let [already-lost? (get-in state [:render-state :lost])
            prev-read-only? (get-in state [:workspace-global :read-only?])
            prev-options-mode (get-in state [:workspace-global :options-mode])]
        (-> state
            (update :render-state
                    (fn [render-state]
                      (cond-> (assoc render-state :lost true)
                        (not already-lost?)
                        (assoc :pre-context-lost-read-only? prev-read-only?
                               :pre-context-lost-options-mode prev-options-mode))))
            (assoc-in [:workspace-global :options-mode] :inspect)
            (assoc-in [:workspace-global :read-only?] true))))
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of :interrupt))))

(defn context-restored
  []
  (ptk/reify ::context-restored
    ptk/UpdateEvent
    (update [_ state]
      (let [restored-read-only? (get-in state [:render-state :pre-context-lost-read-only?]
                                        (get-in state [:workspace-global :read-only?]))
            restored-options-mode (get-in state [:render-state :pre-context-lost-options-mode]
                                          (get-in state [:workspace-global :options-mode]))]
        (-> state
            (update :render-state #(dissoc % :lost
                                           :pre-context-lost-read-only?
                                           :pre-context-lost-options-mode))
            (assoc-in [:workspace-global :options-mode] restored-options-mode)
            (assoc-in [:workspace-global :read-only?] restored-read-only?))))
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of :interrupt))))
