(ns ^{:no-doc true} app.common.mcp.operations.layout
  "This namespace is internal: `app.common.mcp.operations` is the
  only API.

  The flex and grid layout ops, and the layout attrs of the children."
  (:require
   [app.common.data :as d]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.helpers :as cfh]
   [app.common.logic.shapes :as cls]
   [app.common.mcp.operations.refs :refer [resolve-page-id resolve-shape-id]]
   [app.common.mcp.operations.schema :refer [g-child g-flex g-grid g-id g-page op-schema schema:ref]]
   [app.common.mcp.operations.state :refer [child-layout-keys child-sizing-keys commit-builder flex-attr-keys get-page-objects grid-attr-keys grid-only-keys mark-reflow op-builder raise-invalid]]
   [app.common.types.shape.layout :as ctl]
   [app.common.types.token :as cto]))

;; Layout
(defn resolve-board
  "Resolves a ref that must be a board of `objects`, the only container of a
  layout."
  [state objects ref]
  (let [id (resolve-shape-id state objects ref)]
    (when-not (cfh/frame-shape? (get objects id))
      (raise-invalid "the shape is not a board"))
    id))

(defn- drop-constraints
  "The children of a layout lose their constraints, since the layout places
  them."
  [shape]
  (dissoc shape :constraints-h :constraints-v))

(defn- reverse-children
  [shape]
  (update shape :shapes (comp vec reverse)))

(defn- sub-attrs
  "The keys of the map under `k` in `attrs`, as a set, or nil when there are
  none. A token on one side of a padding or margin is unapplied only when that
  side changes, so the keys go to the token step as the changed sub attrs."
  [attrs k]
  (let [ks (some-> (get attrs k) keys set)]
    (when (seq ks)
      ks)))

(defn- changed-padding
  "The padding sides whose value changes from `old-pad` to `new-pad`. The
  token of a side that stays keeps its value, so only these sides go to the
  token step. The result is empty when no side changes."
  [old-pad new-pad]
  (into #{}
        (filter #(not= (get old-pad %) (get new-pad %)))
        [:p1 :p2 :p3 :p4]))

(defn- unapply-gap-tokens
  "Unapplies the gap tokens of the shape `id` whose gap value changes from
  `old-gap` to `new-gap`. The token rules map no attr to `:layout-gap`, so the
  update leaves the gap tokens in place, and a stale token would write its
  value back. A gap that stays the same keeps its token."
  [builder id old-gap new-gap]
  (let [changed (into #{}
                      (filter #(not= (get old-gap %) (get new-gap %)))
                      cto/spacing-gap-keys)]
    (cond-> builder
      (seq changed)
      (pcb/update-shapes [id] #(cto/unapply-tokens-from-shape % changed)))))

;; MCP rule: a flex layout shows its children in the reverse of `:shapes`.
;; A board that gets a flex layout while it has no layout yet has its
;; `:shapes` reversed once, so the children keep the order they were created
;; in as their visual order. A board that already has a layout is not
;; reversed again. remove_layout does not reverse back, so a board that gets
;; a layout again after remove_layout is reversed again.
;;
;; The gap and the padding of an absent op keep their current values, and a
;; side that the op names merges into them. Other absent flex attrs reset to
;; their initial values, as the op sets the whole layout.
(defn- set-flex-layout-change
  [state page-id objects op]
  (let [id       (resolve-board state objects (:id op))
        shape    (get objects id)
        children (cfh/get-immediate-children objects id)
        reverse? (and (seq children)
                      (not (ctl/any-layout? shape)))
        ;; The gap of the op is merged with the current one, so a side that the
        ;; op does not name keeps its value. The params are not calculated from
        ;; the children, as the plugin does
        gap-now  (or (:layout-gap shape) (:layout-gap ctl/initial-flex-layout))
        gap      (if (some? (:layout-gap op)) (merge gap-now (:layout-gap op)) gap-now)
        pad-now  (or (:layout-padding shape) (:layout-padding ctl/initial-flex-layout))
        pad      (if (some? (:layout-padding op)) (merge pad-now (:layout-padding op)) pad-now)
        attrs    (assoc (merge ctl/initial-flex-layout (select-keys op flex-attr-keys))
                        :layout-gap gap
                        :layout-padding pad)
        sizing   (select-keys op child-sizing-keys)
        builder  (-> (op-builder state page-id)
                     (cls/generate-update-shapes [id]
                                                 #(merge (apply dissoc (cond-> % reverse? reverse-children)
                                                                grid-only-keys)
                                                         attrs
                                                         sizing)
                                                 objects
                                                 {:changed-sub-attr (changed-padding pad-now pad)
                                                  :skip-grid-reassignment? true})
                     (unapply-gap-tokens id (:layout-gap shape) gap)
                     (cond-> (seq children)
                       (pcb/update-shapes (mapv :id children) drop-constraints)))]
    (-> state
        (commit-builder builder)
        (cond-> (seq children)
          (mark-reflow page-id [id])))))

(defn- default-track
  "A flex track without a value gets the default value, since the grid
  layout cannot size it otherwise."
  [track]
  (cond-> track
    (and (= :flex (:type track)) (nil? (:value track)))
    (assoc :value (:value ctl/default-track-value))))

(defn- add-tracks
  "Adds the tracks one by one. Each track creates the cells that cross it,
  so the grid has a cell for every row and column pair."
  [grid add-track tracks]
  (reduce add-track grid tracks))

;; A grid is not reversed, unlike a flex layout. Its cells come from the
;; order of `:shapes` (the first pending child takes the first free cell), and
;; `reorder-grid-children` then rewrites `:shapes` as the reverse of the cell
;; order. So the children keep the order they were created in as their cell
;; order without a reversal.
(defn- set-grid-layout-change
  [state page-id objects op]
  (let [id       (resolve-board state objects (:id op))
        shape    (get objects id)
        ;; As the flex layout, an absent gap keeps the current gap
        gap-now  (or (:layout-gap shape) (:layout-gap ctl/initial-grid-layout))
        gap      (if (some? (:layout-gap op)) (merge gap-now (:layout-gap op)) gap-now)
        pad-now  (or (:layout-padding shape) (:layout-padding ctl/initial-grid-layout))
        pad      (if (some? (:layout-padding op)) (merge pad-now (:layout-padding op)) pad-now)
        attrs    (assoc (apply dissoc (select-keys op grid-attr-keys)
                               [:layout-grid-rows :layout-grid-columns])
                        :layout-gap gap
                        :layout-padding pad)
        rows     (mapv default-track (:layout-grid-rows op))
        columns  (mapv default-track (:layout-grid-columns op))
        children (vec (:shapes (get objects id)))
        builder  (-> (op-builder state page-id)
                     (cls/generate-update-shapes [id]
                                                 (fn [shape objs]
                                                   (-> shape
                                                       (merge ctl/initial-grid-layout attrs)
                                                       (add-tracks ctl/add-grid-row rows)
                                                       (add-tracks ctl/add-grid-column columns)
                                                       (ctl/assign-cells objs)
                                                       ctl/reorder-grid-children))
                                                 objects
                                                 {:with-objects? true
                                                  :changed-sub-attr (changed-padding pad-now pad)
                                                  :skip-grid-reassignment? true})
                     (unapply-gap-tokens id (:layout-gap shape) gap)
                     (cond-> (seq children)
                       (pcb/update-shapes children drop-constraints)))]
    (-> state
        (commit-builder builder)
        (mark-reflow page-id [id]))))

(defn- remove-layout-change
  [state page-id objects op]
  (let [id (resolve-shape-id state objects (:id op))
        shape (get objects id)]
    (when-not (ctl/any-layout? shape)
      (raise-invalid "the shape has no layout"))
    (let [child-ids (vec (:shapes shape))
          builder (-> (op-builder state page-id)
                      (pcb/update-shapes [id] ctl/remove-layout-container-data)
                      (pcb/update-shapes child-ids ctl/remove-layout-item-data))]
      (-> state
          (commit-builder builder)
          (mark-reflow page-id (into [id] child-ids))))))

(defn- set-layout-child-change
  "Sets the layout item attrs of a child, as the editor does: the tokens on the
  changed attrs are unapplied, the descendants and the parent take the sizing
  fix-ups, and a grid parent reassigns its cells."
  [state page-id objects op]
  (let [id           (resolve-shape-id state objects (:id op))
        shape        (get objects id)
        parent-id    (:parent-id shape)
        attrs        (select-keys op child-layout-keys)
        children-ids (cfh/get-children-ids objects id)
        builder      (-> (op-builder state page-id)
                         (cls/generate-update-shapes [id]
                                                     (d/patch-object attrs)
                                                     objects
                                                     {:attrs (set (keys attrs))
                                                      :changed-sub-attr (sub-attrs attrs :layout-item-margin)})
                         (cond-> (seq children-ids)
                           (pcb/update-shapes children-ids
                                              (partial ctl/fix-child-sizing objects attrs)))
                         (cond-> (contains? objects parent-id)
                           (pcb/update-shapes [parent-id]
                                              (fn [parent objs]
                                                (-> parent
                                                    (ctl/fix-parent-sizing objs #{id} attrs)
                                                    (cond-> (ctl/grid-layout? parent)
                                                      (ctl/assign-cells objs))))
                                              {:with-objects? true})))]
    (-> state
        (commit-builder builder)
        (mark-reflow page-id [id parent-id]))))

(defn- ensure-tracks
  "Adds default rows and columns until the grid has `last-row` rows and
  `last-column` columns."
  [grid last-row last-column]
  (let [grid (reduce (fn [grid _] (ctl/add-grid-row grid ctl/default-track-value))
                     grid
                     (range (- last-row (count (:layout-grid-rows grid)))))]
    (reduce (fn [grid _] (ctl/add-grid-column grid ctl/default-track-value))
            grid
            (range (- last-column (count (:layout-grid-columns grid)))))))

(defn- place-grid-child
  "Puts `child-id` in the cell at `row` and `column` spanning the given
  number of tracks."
  [grid objects child-id row column row-span column-span]
  (let [grid (ensure-tracks grid (+ row row-span -1) (+ column column-span -1))
        grid (if (some? (ctl/get-cell-by-position grid row column))
               grid
               (ctl/create-cells grid [column row 1 1]))
        grid (ctl/resize-cell-area grid row column row column row-span column-span)
        grid (ctl/add-children-to-cell grid (into (d/ordered-set) [child-id]) objects [row column])]
    (ctl/reorder-grid-children grid)))

(defn- set-grid-cell-change
  [state page-id objects op]
  (let [grid-id (resolve-shape-id state objects (:grid-id op))
        grid (get objects grid-id)
        child-id (resolve-shape-id state objects (:child-id op))
        row (:row op)
        column (:column op)
        row-span (or (:row-span op) 1)
        column-span (or (:column-span op) 1)]
    (when-not (ctl/grid-layout? grid)
      (raise-invalid "set_grid_cell needs a grid layout"))
    (when-not (some #{child-id} (:shapes grid))
      (raise-invalid "the child is not a child of the grid"))
    (let [builder (pcb/update-shapes (op-builder state page-id)
                                     [grid-id]
                                     (fn [shape objs]
                                       (place-grid-child shape objs child-id
                                                         row column row-span column-span))
                                     {:with-objects? true})]
      (-> state
          (commit-builder builder)
          (mark-reflow page-id [grid-id child-id])))))

(defn- compile-layout-op
  [state op]
  (let [page-id (resolve-page-id state (:page-id op))
        objects (get-page-objects state page-id)]
    (case (:op op)
      "set_flex_layout" (set-flex-layout-change state page-id objects op)
      "set_grid_layout" (set-grid-layout-change state page-id objects op)
      "remove_layout" (remove-layout-change state page-id objects op)
      "set_layout_child" (set-layout-child-change state page-id objects op)
      "set_grid_cell" (set-grid-cell-change state page-id objects op))))

(def ops
  "The ops of the layout family. Each op name maps to its schema and its
  compile function."
  {"set_flex_layout" {:schema (op-schema "set_flex_layout" g-page g-id g-flex)
                      :compile compile-layout-op}
   "set_grid_layout" {:schema (op-schema "set_grid_layout" g-page g-id g-grid)
                      :compile compile-layout-op}
   "remove_layout" {:schema (op-schema "remove_layout" g-page g-id)
                    :compile compile-layout-op}
   "set_layout_child" {:schema (op-schema "set_layout_child" g-page g-id g-child)
                       :compile compile-layout-op}
   "set_grid_cell" {:schema (op-schema "set_grid_cell" g-page
                                       [[:grid-id schema:ref]
                                        [:child-id schema:ref]
                                        [:row [:int {:min 1}]]
                                        [:column [:int {:min 1}]]
                                        [:row-span {:optional true} [:int {:min 1}]]
                                        [:column-span {:optional true} [:int {:min 1}]]])
                    :compile compile-layout-op}})
