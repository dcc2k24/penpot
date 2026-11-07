(ns ^{:no-doc true} app.common.mcp.operations.shapes
  "This namespace is internal: `app.common.mcp.operations` is the
  only API.

  The ops that create, update, move, group, mask, clone and delete shapes,
  and the pages."
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.helpers :as cfh]
   [app.common.geom.matrix :as gmt]
   [app.common.geom.point :as gpt]
   [app.common.geom.shapes :as gsh]
   [app.common.logic.libraries :as cll]
   [app.common.logic.modifiers :as lm]
   [app.common.logic.shapes :as cls]
   [app.common.mcp.operations.refs :refer [alloc-id check-parent-accepts-children check-structure-move frame-id-for record-handle resolve-page-id resolve-parent-id resolve-shape-id resolve-shape-ids]]
   [app.common.mcp.operations.schema :refer [check-props-for-type g-bool-type g-box g-font g-id g-ids g-opt-id g-page g-shape g-text-box op-schema schema:ref tmp-handle?]]
   [app.common.mcp.operations.state :refer [add-shape assign-grid-cells child-index commit-builder default-names geometry-attr-keys geometry-keys geometry-modifiers get-libraries get-page get-page-objects layout-parent? make-shape mark-reflow modifier-objects op-builder raise-invalid shape-name shape-types]]
   [app.common.mcp.operations.text :refer [text-spec]]
   [app.common.schema :as sm]
   [app.common.types.component :as ctk]
   [app.common.types.container :as ctn]
   [app.common.types.page :as ctp]
   [app.common.types.path :as path]
   [app.common.types.shape.layout :as ctl]))

;; Pages
(defn- page-component-ids
  "The ids of the components that are live in the file and whose main
  instance is on `page`."
  [file-data page]
  (->> (vals (:objects page))
       (filter #(true? (:main-instance %)))
       (keep :component-id)
       (distinct)
       (filter (fn [id]
                 (let [component (get-in file-data [:components id])]
                   (and (some? component) (not (:deleted component))))))))

(defn- delete-page-components
  "Adds to `builder` the deletion of the components whose main instance is
  on `page`, as the workspace does. Copies of them on other pages keep their
  component reference."
  [builder file-data page]
  (reduce #(pcb/delete-component %1 %2 (:id page))
          builder
          (page-component-ids file-data page)))

(defn- compile-page-op
  [state op]
  (case (:op op)
    "create_page"
    (let [[id state] (alloc-id state (:id op) #(some? (get-page state %)))
          page (cond-> (ctp/make-empty-page {:id id :name (:name op)})
                 (some? (:index op))
                 (assoc :index (:index op)))
          builder (pcb/add-page (op-builder state nil) id page)]
      (commit-builder state builder))

    "update_page"
    (let [page-id (resolve-page-id state (:id op))
          page (dm/get-in (:file-data state) [:pages-index page-id])
          options (cond-> {}
                    (some? (:name op))
                    (assoc :name (:name op))

                    (contains? op :background)
                    (assoc :background (:background op))

                    (contains? op :background-token)
                    (assoc :background-token (:background-token op)))
          builder (pcb/mod-page (op-builder state nil) page options)]
      (commit-builder state builder))

    "delete_page"
    (let [pages   (:pages (:file-data state))
          page-id (resolve-page-id state (:id op))
          _       (when (= 1 (count pages))
                    (raise-invalid "cannot delete the last page"))
          ;; The index lets an undo put the page back in its place
          page    (assoc (get-page state page-id) :index (d/index-of pages page-id))
          builder (-> (op-builder state nil)
                      (delete-page-components (:file-data state) page)
                      (pcb/del-page page))]
      (commit-builder state builder))

    "move_page"
    (let [page-id    (resolve-page-id state (:id op))
          prev-index (d/index-of (get-in state [:file-data :pages]) page-id)
          ;; The :mov-page change inserts before the page at its index, in the
          ;; list that still holds the page. A move to a higher index needs
          ;; one place more, so the change gets the index plus one. The undo
          ;; move is the reverse, with the same rule.
          index      (cond-> (:index op) (> (:index op) prev-index) inc)
          undo-index (cond-> prev-index (> prev-index (:index op)) inc)
          builder    (pcb/move-page (op-builder state nil) page-id index undo-index)]
      (commit-builder state builder))))

;; Create shapes
(defn- path-content
  [op]
  (cond
    (some? (:content op)) (path/content (:content op))
    (some? (:d op)) (path/from-string (:d op))
    :else (raise-invalid "create_path needs content or d")))

(defn- image-attrs
  [op]
  (let [media {:id (:media-id op)
               :width (:media-width op)
               :height (:media-height op)
               :mtype (or (:media-mtype op) "image/png")}]
    {:metadata media
     :fills [{:fill-opacity 1
              :fill-image (assoc media :keep-aspect-ratio true)}]}))

(defn- path-spec
  "The attrs, position and size of a path op. The size is the bounds of the
  content. The content moves so that its bounds start at the requested `x`
  and `y`, when they are given."
  [op]
  (let [content (path-content op)
        bounds  (or (path/calc-selrect content)
                    (raise-invalid "create_path needs a content with bounds"))
        move    (gpt/point (if (some? (:x op)) (- (:x op) (:x bounds)) 0)
                           (if (some? (:y op)) (- (:y op) (:y bounds)) 0))
        content (path/move-content content move)]
    ;; A path has no position or size of its own: its selrect comes from the content
    {:attrs {:content content}}))

(defn- create-spec
  "The type, attrs, position, size and default name of a create op."
  [op]
  (case (:op op)
    "create_text"
    (assoc (text-spec op) :x (:x op) :y (:y op))

    "create_path"
    (assoc (path-spec op)
           :type :path
           :base-name (get default-names :path))

    (let [type (get shape-types (:op op))
          attrs (case type
                  :image (image-attrs op)
                  :svg-raw {:content (:content op)}
                  {})]
      {:type type
       :attrs attrs
       :x (:x op)
       :y (:y op)
       :width (:width op)
       :height (:height op)
       :base-name (get default-names type)})))

(defn- compile-create-op
  [state op]
  (let [page-id    (resolve-page-id state (:page-id op))
        objects    (get-page-objects state page-id)
        [id state] (alloc-id state (:id op) #(contains? objects %))
        parent-id  (resolve-parent-id state objects (:parent-id op))
        {:keys [type attrs x y width height base-name approximate]} (create-spec op)
        _          (check-props-for-type type (:props op))
        ;; A path takes its box from its content, so no position or size is given
        geometry   (when-not (= :path type)
                     {:x x :y y :width width :height height})
        shape      (make-shape (:props op)
                               attrs
                               (merge {:type type
                                       :id id
                                       :parent-id parent-id
                                       :frame-id (frame-id-for objects parent-id)
                                       :name (shape-name op base-name)}
                                      geometry))
        builder    (-> (op-builder state page-id)
                       (add-shape shape (child-index (get objects parent-id) (:index op)))
                       (assign-grid-cells [parent-id])
                       (cond-> (contains? #{:group :bool} (:type (get objects parent-id)))
                         (pcb/resize-parents [parent-id])))]
    (-> state
        (commit-builder builder)
        (mark-reflow page-id [id parent-id])
        (cond-> approximate
          (update :warnings conj {:code :text-size-approximate :id id})))))

;; Groups and booleans
(defn- check-group-parent
  [children]
  (when-not (apply = (map :parent-id children))
    (raise-invalid "children must share a parent")))

(defn- check-bool-children
  "Refuses a board as a child of a boolean."
  [children]
  (when-let [board (first (filter cfh/frame-shape? children))]
    (raise-invalid (str "a board cannot be a child of a boolean: "
                        (:name board) " (" (:id board) ")"))))

(defn- bool-head-styles
  "The styles that a boolean takes from its head child. An svg child without
  fills gives the boolean the default fills."
  [head]
  (let [head (cond-> head
               (and (contains? head :svg-attrs) (empty? (:fills head)))
               (assoc :fills (path/get-default-bool-fills)))]
    (select-keys head path/bool-style-properties)))

(defn- scale-constraints
  "A group sets the constraints of its children to scale, as the frontend
  does. `assoc-when` sets only the constraints that the child has."
  [shape]
  (-> shape
      (d/assoc-when :constraints-h :scale)
      (d/assoc-when :constraints-v :scale)))

(defn- compile-group-op
  "Creates a group or a boolean over the children. A group takes the parent
  of its first child, and goes at that child's place. A boolean takes the
  parent and the place of its head child, as the editor does. A group needs
  its children in one parent. A group resets their constraints to scale,
  and in a grid it takes the cell of the front child. A boolean takes its
  styles from its head child, and its children lose their layout item data."
  [state op]
  (let [group?      (= "create_group" (:op op))
        page-id     (resolve-page-id state (:page-id op))
        objects     (get-page-objects state page-id)
        [id state]  (alloc-id state (:id op) #(contains? objects %))
        child-ids   (resolve-shape-ids state objects (:child-ids op))
        ;; The front child comes first, as in the layers list
        ordered     (vec (cfh/order-by-indexed-shapes objects child-ids))
        _           (when-not (= (count ordered) (count (cfh/clean-loops objects ordered)))
                      (raise-invalid "a shape cannot be grouped with its own child"))
        _           (check-structure-move objects ordered nil)
        children    (mapv #(get objects %) ordered)
        first-child (first children)
        _           (if group?
                      (check-group-parent children)
                      (check-bool-children children))
        ;; The children in the order of their parent
        stacked     (vec (reverse ordered))
        ;; A difference takes its styles from the bottom child, the base of
        ;; the others. The other types take them from the top child.
        head-id     (when-not group?
                      (if (= :difference (:bool-type op))
                        (first stacked)
                        (last stacked)))
        ;; As the editor does, a boolean takes its parent, frame and place
        ;; from its head. A group takes them from its first child.
        parent-id   (:parent-id (get objects (if group? (:id first-child) head-id)))
        ;; The frontend takes the cell of its last shape. Its shapes are in
        ;; the reverse of the layers order, so that is the front child.
        target-cell (when (and group? (ctl/grid-layout? objects parent-id))
                      (ctl/get-cell-by-shape-id (get objects parent-id) (:id first-child)))
        selrect     (gsh/shapes->rect children)
        index       (if group?
                      (cfh/get-position-on-parent objects (:id first-child))
                      (inc (cfh/get-position-on-parent objects head-id)))
        fields      {:id id
                     :parent-id parent-id
                     :frame-id (frame-id-for objects parent-id)
                     :x (:x selrect)
                     :y (:y selrect)
                     :width (:width selrect)
                     :height (:height selrect)}
        shape       (if group?
                      (make-shape nil {}
                                  (assoc fields
                                         :type :group
                                         :name (shape-name op (get default-names :group))))
                      (-> (make-shape nil
                                      (merge {:bool-type (:bool-type op)}
                                             (bool-head-styles (get objects head-id)))
                                      (assoc fields
                                             :type :bool
                                             :shapes stacked
                                             :name (shape-name op (get default-names :bool))))
                          (path/update-bool-shape objects)
                          (assoc :shapes [])))
        old-parents (map :parent-id children)
        builder     (-> (op-builder state page-id)
                        (add-shape shape index)
                        (cond-> group?
                          (pcb/update-shapes ordered scale-constraints))
                        (cond-> (not group?)
                          (pcb/update-shapes ordered ctl/remove-layout-item-data))
                        (cond-> target-cell
                          (pcb/update-shapes
                           [parent-id]
                           (fn [parent]
                             (assoc-in parent [:layout-grid-cells (:id target-cell) :shapes] [id]))))
                        (cls/generate-relocate id nil ordered)
                        (assign-grid-cells (cons parent-id old-parents)))]
    (-> state
        (commit-builder builder)
        (mark-reflow page-id (concat [id parent-id] ordered old-parents)))))

(defn- attrs-update-needed?
  "Whether merging `attrs` on the shape `id` can emit a change. With no
  attrs, when the shape is not a grid layout and no group or bool is among
  `parents`, it emits none: the merge changes nothing, no grid cell moves
  and no parent resizes."
  [objects id parents attrs]
  (boolean
   (or (seq attrs)
       (ctl/grid-layout? objects id)
       (some #(contains? #{:group :bool} (:type (get objects %))) parents))))

(defn compile-update-op
  "Updates a shape. The geometry goes through modifiers, so the children of
  a board or group and the constraints follow it. The other props are then
  merged on the moved shape, unless the merge can emit nothing. The
  modifiers and the update take only the part of the page that
  `modifier-objects` gives."
  [state op]
  (let [page-id   (resolve-page-id state (:page-id op))
        objects   (get-page-objects state page-id)
        id        (resolve-shape-id state objects (:id op))
        shape     (get objects id)
        props     (:props op)
        _         (check-props-for-type (:type shape) props)
        geometry  (select-keys props geometry-attr-keys)
        attrs     (apply dissoc (or props {}) (concat geometry-keys geometry-attr-keys))
        modifiers (geometry-modifiers shape geometry)
        state     (if (some? modifiers)
                    (commit-builder state
                                    (lm/generate-apply-modifiers (op-builder state page-id)
                                                                 (modifier-objects objects id)
                                                                 {id {:modifiers modifiers}}
                                                                 {}))
                    state)
        objects   (get-page-objects state page-id)
        parents   (cfh/get-parent-ids objects id)
        state     (if (attrs-update-needed? objects id parents attrs)
                    (let [builder (-> (op-builder state page-id)
                                      (cls/generate-update-shapes [id]
                                                                  #(merge % attrs)
                                                                  (modifier-objects objects id)
                                                                  {})
                                      (pcb/resize-parents parents))]
                      (commit-builder state builder))
                    state)]
    (mark-reflow state page-id [id (:parent-id shape)])))

;; Structure: move, reorder, delete, clone, ungroup, flatten and masks
(defn- move-shapes-change
  [state page-id objects op]
  (let [parent-id (resolve-parent-id state objects (:parent-id op))
        ids       (check-structure-move objects
                                        (resolve-shape-ids state objects (:ids op))
                                        parent-id)]
    (if (empty? ids)
      state
      (let [old-parents (into #{} (keep #(:parent-id (get objects %))) ids)
            index (child-index (get objects parent-id) (:index op))
            builder (-> (op-builder state page-id)
                        (cls/generate-relocate parent-id index ids)
                        (assign-grid-cells (cons parent-id old-parents)))]
        (-> state
            (commit-builder builder)
            (mark-reflow page-id (concat ids old-parents [parent-id])))))))

(defn- reorder-change
  [state page-id objects op]
  (let [parent-id (resolve-parent-id state objects (:parent-id op))
        parent (get objects parent-id)
        ids (resolve-shape-ids state objects (:ids op))]
    (when-not (and (some? parent)
                   (= (count ids) (count (:shapes parent)))
                   (= (set ids) (set (:shapes parent))))
      (raise-invalid "reorder needs every child of the parent exactly once"))
    (let [;; The ids come in visual order, and a layout keeps its children
          ;; in the reverse of that order
          shapes  (cond-> (vec ids) (layout-parent? parent) (->> reverse vec))
          builder (pcb/reorder-children (op-builder state page-id) parent-id shapes)]
      (-> state
          (commit-builder builder)
          (mark-reflow page-id [parent-id])))))

(defn- delete-shapes-change
  [state page-id objects op]
  (let [ids (resolve-shape-ids state objects (:ids op))
        [parents builder] (cls/generate-delete-shapes (op-builder state page-id)
                                                      (:file-data state)
                                                      (get-page state page-id)
                                                      objects
                                                      ids
                                                      nil)
        builder (assign-grid-cells builder parents)]
    (-> state
        (commit-builder builder)
        (mark-reflow page-id parents))))

(defn- clone-change
  [state page-id objects op]
  (let [id        (resolve-shape-id state objects (:id op))
        ;; Without a parent, the clone goes where the source is. With one, the
        ;; parent is checked when it is resolved below.
        _         (when (nil? (:parent-id op))
                    (check-parent-accepts-children objects (:parent-id (get objects id))))
        file-data (:file-data state)
        page      (dm/get-in file-data [:pages-index page-id])
        builder   (cll/generate-duplicate-changes (op-builder state page-id)
                                                  objects
                                                  page
                                                  [id]
                                                  (gpt/point 0 0)
                                                  (get-libraries state)
                                                  file-data
                                                  (:id file-data))
        root-id   (some (fn [change]
                          (when (and (= :add-obj (:type change))
                                     (= id (:old-id change)))
                            (-> change :obj :id)))
                        (:redo-changes builder))
        _         (when (nil? root-id)
                    (raise-invalid "clone produced no root shape"))
        state     (if (some? (:new-id op))
                    (if (tmp-handle? (:new-id op))
                      (record-handle state (:new-id op) root-id)
                      (raise-invalid "new-id must be a $tmp handle"))
                    state)
        parent-id (when (some? (:parent-id op))
                    (resolve-parent-id state objects (:parent-id op)))
        ;; A clone of a copy shape that goes out of the copy is detached from
        ;; its component, as the editor does when a copy shape leaves it
        leaves-copy? (and (some? parent-id)
                          (ctk/in-component-copy? (get objects (:parent-id (get objects id)))))
        builder   (cond-> builder
                    leaves-copy?
                    (pcb/update-shapes [root-id] ctk/detach-shape))
        ;; A move out of a copy is refused unless the change allows it: the
        ;; clone is new, so the move is its placement, not a change of the copy
        builder   (cond-> builder
                    (and (some? parent-id) leaves-copy?)
                    (pcb/change-parent parent-id [{:id root-id}] nil
                                       {:allow-altering-copies true}))
        builder   (cond-> builder
                    (and (some? parent-id) (not leaves-copy?))
                    (cls/generate-relocate parent-id nil [root-id]))
        ;; The target is checked by `resolve-parent-id`. The clone is new, so
        ;; only its nesting of components is checked: the copy it came from is
        ;; not its parent any more
        _         (when (some? parent-id)
                    (check-structure-move (pcb/get-objects builder) [] parent-id)
                    (when (cfh/components-nesting-loop? (pcb/get-objects builder) root-id parent-id)
                      (raise-invalid "a clone would nest a component inside its own main")))
        builder   (assign-grid-cells builder
                                     [(:parent-id (get (pcb/get-objects builder) root-id))
                                      parent-id])]
    (-> state
        (commit-builder builder)
        (mark-reflow page-id [root-id parent-id]))))

(defn- ungroup-change
  [state page-id objects op]
  (let [id    (resolve-shape-id state objects (:id op))
        group (get objects id)]
    (when-not (= :group (:type group))
      (raise-invalid "ungroup needs a group"))
    (let [parent-id (:parent-id group)
          children (check-structure-move objects (:shapes group) parent-id)
          index (inc (cfh/get-position-on-parent objects id))
          builder (cls/generate-relocate (op-builder state page-id) parent-id index children)
          builder (if (contains? (pcb/get-objects builder) id)
                    (second (cls/generate-delete-shapes builder
                                                        (:file-data state)
                                                        (get-page state page-id)
                                                        (pcb/get-objects builder)
                                                        [id]
                                                        nil))
                    builder)
          builder (assign-grid-cells builder [parent-id])]
      (-> state
          (commit-builder builder)
          (mark-reflow page-id (concat [parent-id id] children))))))

(defn- flatten-change
  "Converts the shapes to paths and removes their descendants. Shapes inside
  a component copy are skipped, as the workspace does."
  [state page-id objects op]
  (let [ids          (->> (resolve-shape-ids state objects (:ids op))
                          (remove #(ctn/has-any-copy-parent? objects (get objects %))))
        children-ids (into #{} (mapcat #(cfh/get-children-ids objects %)) ids)
        builder      (-> (op-builder state page-id)
                         (pcb/update-shapes ids
                                            (fn [shape objs] (path/convert-to-path shape objs))
                                            {:with-objects? true})
                         (pcb/remove-objects children-ids))]
    (-> state
        (commit-builder builder)
        (mark-reflow page-id (concat ids (map #(:parent-id (get objects %)) ids))))))

(defn- mask-change
  "Makes the group a mask group, or removes its mask. The mask is the first
  child in `:shapes`, the bottom-most child, which is the shape the editor's
  `mask-group` takes too: its shapes come back to front, and the first of them
  gives the geometry of the mask group. The parents resize to it. Removing the
  mask resizes the parents again."
  [state page-id objects op]
  (let [id         (resolve-shape-id state objects (:group-id op))
        group      (get objects id)
        masked?    (= "make_mask" (:op op))
        mask-shape (get objects (first (:shapes group)))]
    (when-not (= :group (:type group))
      (raise-invalid "masks need a group"))
    (when (and masked? (nil? mask-shape))
      (raise-invalid "a mask group needs a child to be the mask"))
    (let [builder (-> (op-builder state page-id)
                      (pcb/update-shapes [id]
                                         (if masked?
                                           #(assoc %
                                                   :masked-group true
                                                   :selrect (:selrect mask-shape)
                                                   :points (:points mask-shape)
                                                   :transform (:transform mask-shape)
                                                   :transform-inverse (:transform-inverse mask-shape))
                                           #(dissoc % :masked-group)))
                      (pcb/resize-parents [id]))]
      (-> state
          (commit-builder builder)
          (mark-reflow page-id [id (:parent-id group)])))))

(defn- compile-structure-op
  [state op]
  (let [page-id (resolve-page-id state (:page-id op))
        objects (get-page-objects state page-id)]
    (case (:op op)
      "move_shapes" (move-shapes-change state page-id objects op)
      "reorder" (reorder-change state page-id objects op)
      "delete_shapes" (delete-shapes-change state page-id objects op)
      "clone_shape" (clone-change state page-id objects op)
      "ungroup" (ungroup-change state page-id objects op)
      "flatten" (flatten-change state page-id objects op)
      ("make_mask" "remove_mask") (mask-change state page-id objects op))))

;; Path content
(defn- compile-path-content-op
  "Sets the content of the path `id`. The content must be a valid path. Its
  bounds start at the origin of the selrect the path has, so a moved path
  stays where it is. The selrect and the points come from the content and the
  transform of the path, as the editor computes them, so a rotated or flipped
  path keeps its transform. A path has no `:x`, `:y`, `:width` or `:height`:
  these are not read or written, since the editor does not keep them."
  [state op]
  (let [page-id  (resolve-page-id state (:page-id op))
        objects  (get-page-objects state page-id)
        id       (resolve-shape-id state objects (:id op))
        shape    (get objects id)
        _        (when-not (= :path (:type shape))
                   (raise-invalid "set_path_content needs a path shape"))
        content  (path/content (:content op))
        _        (when-not (sm/validate path/schema:content content)
                   (raise-invalid "content is not a valid path"))
        bounds   (or (path/calc-selrect content)
                     (raise-invalid "set_path_content needs a content with bounds"))
        origin   (let [selrect (or (:selrect shape) (path/calc-selrect (:content shape)))]
                   (gpt/point (:x selrect) (:y selrect)))
        move     (gpt/point (- (:x origin) (:x bounds)) (- (:y origin) (:y bounds)))
        content  (path/move-content content move)
        ;; The geometry comes from the content and the transform, as in the editor
        updated  (path/update-geometry
                  (-> shape
                      (assoc :content content)
                      (update :transform #(or % (gmt/matrix)))
                      (update :transform-inverse #(or % (gmt/matrix)))))
        builder  (-> (op-builder state page-id)
                     (pcb/update-shapes [id]
                                        (fn [s]
                                          (-> s
                                              (merge (select-keys updated [:content :selrect :points]))
                                              (dissoc :x :y :width :height))))
                     (pcb/resize-parents (cfh/get-parent-ids objects id)))]
    (-> state
        (commit-builder builder)
        (mark-reflow page-id [id (:parent-id shape)]))))

(def ops
  "The ops of the shapes family. Each op name maps to its schema and its
  compile function."
  {"create_page" {:schema (op-schema "create_page"
                                     [[:id {:optional true} schema:ref]
                                      [:name :string]
                                      [:index {:optional true} [:int {:min 0}]]])
                  :compile compile-page-op}
   "update_page" {:schema (op-schema "update_page"
                                     g-id
                                     [[:name {:optional true} :string]
                                      [:background {:optional true} :string]
                                      [:background-token {:optional true} [:maybe :string]]])
                  :compile compile-page-op}
   "delete_page" {:schema (op-schema "delete_page" g-id)
                  :compile compile-page-op}
   "move_page" {:schema (op-schema "move_page"
                                   g-id
                                   [[:index [:int {:min 0}]]])
                :compile compile-page-op}
   "create_board" {:schema (op-schema "create_board" g-page g-shape g-box)
                   :compile compile-create-op}
   "create_rect" {:schema (op-schema "create_rect" g-page g-shape g-box)
                  :compile compile-create-op}
   "create_ellipse" {:schema (op-schema "create_ellipse" g-page g-shape g-box)
                     :compile compile-create-op}
   "create_text" {:schema (op-schema "create_text" g-page g-shape
                                     [[:x ::sm/safe-number]
                                      [:y ::sm/safe-number]]
                                     g-text-box
                                     [[:characters :string]
                                      [:grow-type {:optional true} [::sm/one-of #{:auto-width :auto-height :fixed}]]]
                                     g-font)
                  :compile compile-create-op}
   "create_path" {:schema (op-schema "create_path" g-page g-shape
                                     [[:x {:optional true} ::sm/safe-number]
                                      [:y {:optional true} ::sm/safe-number]]
                                     [[:content {:optional true} :any]
                                      [:d {:optional true} :string]])
                  :compile compile-create-op}
   "create_image" {:schema (op-schema "create_image" g-page g-shape g-box
                                      [[:media-id ::sm/uuid]
                                       [:media-width ::sm/positive-safe-number]
                                       [:media-height ::sm/positive-safe-number]
                                       [:media-mtype {:optional true} :string]])
                   :compile compile-create-op}
   "create_svg_raw" {:schema (op-schema "create_svg_raw" g-page g-shape g-box
                                        [[:content [:map]]])
                     :compile compile-create-op}
   "create_group" {:schema (op-schema "create_group" g-page g-opt-id
                                      [[:name {:optional true} :string]
                                       [:child-ids [:vector {:min 1} schema:ref]]])
                   :compile compile-group-op}
   "create_boolean" {:schema (op-schema "create_boolean" g-page g-opt-id
                                        [[:name {:optional true} :string]]
                                        g-bool-type
                                        [[:child-ids [:vector {:min 1} schema:ref]]])
                     :compile compile-group-op}
   "update_shape" {:schema (op-schema "update_shape" g-page g-id
                                      [[:props [:map
                                                [:x {:optional true} ::sm/safe-number]
                                                [:y {:optional true} ::sm/safe-number]
                                                [:width {:optional true} ::sm/non-negative-safe-number]
                                                [:height {:optional true} ::sm/non-negative-safe-number]
                                                [:rotation {:optional true} ::sm/safe-number]]]])
                   :compile compile-update-op}
   "move_shapes" {:schema (op-schema "move_shapes" g-page g-ids
                                     [[:parent-id schema:ref]
                                      [:index {:optional true} [:int {:min 0}]]])
                  :compile compile-structure-op}
   "reorder" {:schema (op-schema "reorder" g-page
                                 [[:parent-id schema:ref]]
                                 g-ids)
              :compile compile-structure-op}
   "delete_shapes" {:schema (op-schema "delete_shapes" g-page g-ids)
                    :compile compile-structure-op}
   "clone_shape" {:schema (op-schema "clone_shape" g-page g-id
                                     [[:parent-id {:optional true} schema:ref]
                                      [:new-id {:optional true} schema:ref]])
                  :compile compile-structure-op}
   "ungroup" {:schema (op-schema "ungroup" g-page g-id)
              :compile compile-structure-op}
   "flatten" {:schema (op-schema "flatten" g-page g-ids)
              :compile compile-structure-op}
   "make_mask" {:schema (op-schema "make_mask" g-page
                                   [[:group-id schema:ref]])
                :compile compile-structure-op}
   "remove_mask" {:schema (op-schema "remove_mask" g-page
                                     [[:group-id schema:ref]])
                  :compile compile-structure-op}
   "set_path_content" {:schema (op-schema "set_path_content" g-page g-id
                                          [[:content :any]])
                       :compile compile-path-content-op}})
