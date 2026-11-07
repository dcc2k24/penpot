(ns ^{:no-doc true} app.common.mcp.operations.prototype
  "This namespace is internal: `app.common.mcp.operations` is the
  only API.

  The interaction, flow, guide and plugin data ops."
  (:require
   [app.common.data.macros :as dm]
   [app.common.files.changes-builder :as pcb]
   [app.common.logic.shapes :as cls]
   [app.common.mcp.operations.layout :refer [resolve-board]]
   [app.common.mcp.operations.refs :refer [alloc-id require-ref resolve-file-entry resolve-page-id resolve-ref resolve-shape-id]]
   [app.common.mcp.operations.schema :refer [g-id g-opt-id g-page op-schema schema:ref]]
   [app.common.mcp.operations.state :refer [commit-builder get-page get-page-objects op-builder raise-invalid raise-unknown]]
   [app.common.schema :as sm]))

;; Plugin data
(defn- plugin-data-target
  "The object type, object id and page id that a set_plugin_data op writes to."
  [state op]
  (case (:target op)
    :file
    [:file nil nil]

    :page
    [:page (resolve-page-id state (require-ref (:id op) "set_plugin_data needs a page id")) nil]

    :shape
    (let [page-id (resolve-page-id state (require-ref (:page-id op) "set_plugin_data needs a page-id for a shape"))
          objects (get-page-objects state page-id)]
      [:shape
       (resolve-shape-id state objects (require-ref (:id op) "set_plugin_data needs a shape id"))
       page-id])

    :component
    [:component
     (resolve-file-entry state :components (require-ref (:id op) "set_plugin_data needs a component id"))
     nil]

    :color
    [:color
     (resolve-file-entry state :colors (require-ref (:id op) "set_plugin_data needs a color id"))
     nil]

    :typography
    [:typography
     (resolve-file-entry state :typographies (require-ref (:id op) "set_plugin_data needs a typography id"))
     nil]))

(defn- compile-plugin-data-op
  [state op]
  (let [[object-type id page-id] (plugin-data-target state op)
        builder (pcb/set-plugin-data (op-builder state page-id)
                                     object-type
                                     id
                                     page-id
                                     (keyword (:namespace op))
                                     (:key op)
                                     (:value op))]
    (commit-builder state builder)))

;; Interactions and flows
(defn- compile-interaction-op
  [state op]
  (let [page-id      (resolve-page-id state (:page-id op))
        objects      (get-page-objects state page-id)
        id           (resolve-shape-id state objects (:id op))
        builder      (op-builder state page-id)]
    (case (:op op)
      "add_interaction"
      (commit-builder state
                      (pcb/update-shapes builder
                                         [id]
                                         #(cls/add-new-interaction % (:interaction op))))

      "remove_interaction"
      (let [index        (:index op)
            interactions (vec (:interactions (get objects id)))]
        (when-not (< index (count interactions))
          (raise-invalid "interaction index out of range"))
        (commit-builder state
                        (pcb/update-shapes builder
                                           [id]
                                           (fn [shape]
                                             (assoc shape :interactions
                                                    (into (subvec interactions 0 index)
                                                          (subvec interactions (inc index)))))))))))

(defn- compile-flow-op
  [state op]
  (let [page-id (resolve-page-id state (:page-id op))
        page    (get-page state page-id)
        objects (get-page-objects state page-id)]
    (case (:op op)
      "create_flow"
      (let [[id state] (alloc-id state (:id op) #(some? (dm/get-in page [:flows %])))
            flow       {:id id
                        :name (:name op)
                        :starting-frame (resolve-board state objects (:starting-frame op))}
            builder    (-> (op-builder state page-id)
                           (pcb/with-page page)
                           (pcb/set-flow id flow))]
        (commit-builder state builder))

      "remove_flow"
      (let [id (resolve-ref state (:id op))]
        (when-not (dm/get-in page [:flows id])
          (raise-unknown (str "unknown flow " id)))
        (commit-builder state
                        (-> (op-builder state page-id)
                            (pcb/with-page page)
                            (pcb/set-flow id nil)))))))

;; Guides
(defn- compile-guide-op
  [state op]
  (let [page-id (resolve-page-id state (:page-id op))
        page    (get-page state page-id)
        objects (get-page-objects state page-id)]
    (case (:op op)
      "add_ruler_guide"
      (let [[id state] (alloc-id state (:id op) #(some? (dm/get-in page [:guides %])))
            guide      (cond-> {:id id
                                :axis (if (= :vertical (:axis op)) :x :y)
                                :position (:position op)}
                         (some? (:frame-id op))
                         (assoc :frame-id (resolve-board state objects (:frame-id op))))
            builder    (-> (op-builder state page-id)
                           (pcb/with-page page)
                           (pcb/set-guide id guide))]
        (commit-builder state builder))

      "remove_ruler_guide"
      (let [id (resolve-ref state (:id op))]
        (when-not (dm/get-in page [:guides id])
          (raise-unknown (str "unknown guide " id)))
        (commit-builder state
                        (-> (op-builder state page-id)
                            (pcb/with-page page)
                            (pcb/set-guide id nil))))

      "set_board_grid_guides"
      (let [id      (resolve-board state objects (:id op))
            builder (pcb/update-shapes (op-builder state page-id)
                                       [id]
                                       #(assoc % :grids (:grids op)))]
        (commit-builder state builder)))))

(def ops
  "The ops of the prototype family. Each op name maps to its schema and its
  compile function."
  {"set_plugin_data" {:schema (op-schema "set_plugin_data"
                                         [[:target [::sm/one-of #{:file :page :shape :component :color :typography}]]
                                          [:id {:optional true} schema:ref]
                                          [:page-id {:optional true} schema:ref]
                                          [:namespace :string]
                                          [:key :string]
                                          [:value [:maybe :string]]])
                      :compile compile-plugin-data-op}
   "add_interaction" {:schema (op-schema "add_interaction" g-page g-id
                                         [[:interaction [:map]]])
                      :compile compile-interaction-op}
   "remove_interaction" {:schema (op-schema "remove_interaction" g-page g-id
                                            [[:index [:int {:min 0}]]])
                         :compile compile-interaction-op}
   "create_flow" {:schema (op-schema "create_flow" g-page g-opt-id
                                     [[:name :string]
                                      [:starting-frame schema:ref]])
                  :compile compile-flow-op}
   "remove_flow" {:schema (op-schema "remove_flow" g-page g-id)
                  :compile compile-flow-op}
   "add_ruler_guide" {:schema (op-schema "add_ruler_guide" g-page g-opt-id
                                         [[:axis [::sm/one-of #{:horizontal :vertical}]]
                                          [:position ::sm/safe-number]
                                          [:frame-id {:optional true} schema:ref]])
                      :compile compile-guide-op}
   "remove_ruler_guide" {:schema (op-schema "remove_ruler_guide" g-page g-id)
                         :compile compile-guide-op}
   "set_board_grid_guides" {:schema (op-schema "set_board_grid_guides" g-page g-id
                                               [[:grids [:vector [:map]]]])
                            :compile compile-guide-op}})
