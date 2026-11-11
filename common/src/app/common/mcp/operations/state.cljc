(ns ^{:no-doc true} app.common.mcp.operations.state
  "This namespace is internal: `app.common.mcp.operations` is the
  only API.

  The state of an operation compile: the working file data, the changes
  builders, the errors, the geometry of the modifiers, and the layout reflow."
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.exceptions :as ex]
   [app.common.files.changes :as cfc]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.helpers :as cfh]
   [app.common.geom.rect :as grc]
   [app.common.geom.shapes :as gsh]
   [app.common.geom.shapes.tree-seq :as cgst]
   [app.common.logic.modifiers :as lm]
   [app.common.math :as mth]
   [app.common.schema :as sm]
   [app.common.types.modifiers :as ctm]
   [app.common.types.shape :as cts]
   [app.common.types.shape.layout :as ctl]
   [app.common.uuid :as uuid]
   [clojure.string :as str]))

;; Constants
(def geometry-keys
  #{:selrect :points :transform :transform-inverse})

(def geometry-attr-keys
  [:x :y :width :height :rotation])

(def default-names
  {:frame "Board"
   :rect "Rectangle"
   :circle "Ellipse"
   :path "Path"
   :image "Image"
   :svg-raw "SVG"
   :group "Group"
   :bool "Boolean"})

(def shape-types
  {"create_board" :frame
   "create_rect" :rect
   "create_ellipse" :circle
   "create_path" :path
   "create_image" :image
   "create_svg_raw" :svg-raw})

(def flex-attr-keys
  [:layout-flex-dir
   :layout-wrap-type
   :layout-gap
   :layout-gap-type
   :layout-padding
   :layout-padding-type
   :layout-justify-content
   :layout-align-items
   :layout-align-content])

(def grid-attr-keys
  [:layout-grid-dir
   :layout-grid-rows
   :layout-grid-columns
   :layout-gap
   :layout-gap-type
   :layout-padding
   :layout-padding-type
   :layout-align-items
   :layout-justify-items
   :layout-align-content
   :layout-justify-content])

(def child-sizing-keys
  [:layout-item-h-sizing
   :layout-item-v-sizing])

(def child-layout-keys
  [:layout-item-margin-type
   :layout-item-margin
   :layout-item-max-h
   :layout-item-min-h
   :layout-item-max-w
   :layout-item-min-w
   :layout-item-h-sizing
   :layout-item-v-sizing
   :layout-item-align-self
   :layout-item-absolute
   :layout-item-z-index])

(def grid-only-keys
  [:layout-grid-dir
   :layout-grid-rows
   :layout-grid-columns
   :layout-grid-cells
   :layout-justify-items])

(def default-font-size 14)

(def ^:private min-text-size 0.01)

(def ^:private auto-grow-types #{:auto-width :auto-height})

(def numeric-text-attrs #{:font-size :font-weight :line-height :letter-spacing})

(def default-text-fills
  [{:fill-color "#000000" :fill-opacity 1}])

;; Errors
(defn raise-invalid
  [hint]
  (ex/raise :type :validation
            :code :mcp-invalid-operation
            :hint hint))

(defn raise-unknown
  [hint]
  (ex/raise :type :validation
            :code :mcp-unknown-id
            :hint hint))

;; State and builders
(defn- library-records
  "The libraries as file records (`{:id :data}`), the shape the component
  builders read. A value without `:data` is taken as the file data itself."
  [libraries]
  (into {}
        (map (fn [[id library]]
               [id (if (contains? library :data)
                     library
                     {:id id :data library})]))
        libraries))

(defn initial-state
  [file-data opts]
  {:file-data file-data
   :changes []
   ;; One `[start end]` pair of change indexes per op, in op order.
   :op-ranges []
   :created-ids {}
   :warnings []
   :reflow {}
   ;; Ids of the components whose main instance holds a shape that an
   ;; earlier op added, modified or deleted in this compile.
   :touched-mains #{}
   :new-id-fn (or (:new-id-fn opts) uuid/next)
   :libraries (library-records (:libraries opts))
   ;; Font data for the ops that need it (`replace_font`): a function from a
   ;; font id to its family and variants. Nil when the call has no such op.
   :font-lookup (:font-lookup opts)
   ;; One result per op, in op order: a map for an op that reports one, else nil.
   :op-results []
   ;; Set by an op that wants the call to take a snapshot before it writes.
   :snapshot-hint false})

(defn get-file-record
  "The working file as a library record, the shape the sync builders read."
  [state]
  (let [file-data (:file-data state)]
    {:id (:id file-data) :data file-data}))

(defn get-libraries
  "The libraries the component builders read: the library records plus the
  working copy of the current file."
  [state]
  (assoc (:libraries state) (:id (:file-data state)) (get-file-record state)))

(defn op-builder
  "Returns a fresh changes builder over the working file data."
  [state page-id]
  (-> (pcb/empty-changes nil page-id)
      (pcb/with-file-data (:file-data state))
      (pcb/with-library-data (:file-data state))))

(defn main-component-ids
  "The ids of the components whose main instance is `shape-id` or one of its
  ancestors in `objects`."
  [objects shape-id]
  (into #{}
        (comp (map #(get objects %))
              (filter #(true? (:main-instance %)))
              (keep :component-id))
        (cons shape-id (cfh/get-parent-ids objects shape-id))))

(defn- touched-main-ids
  "The ids of the components whose main instance holds the shape that
  `change` adds, modifies or deletes, looked up in `before` and `after`, the
  file data around the change."
  [before after change]
  (when (contains? #{:add-obj :mod-obj :del-obj} (:type change))
    (let [page-id (:page-id change)
          id      (:id change)]
      (into (main-component-ids (dm/get-in before [:pages-index page-id :objects]) id)
            (main-component-ids (dm/get-in after [:pages-index page-id :objects]) id)))))

(defn commit-builder
  "Applies the redo changes of `builder` to the file data and appends them
  to the state changes. Records the components whose mains they touch. The
  builder has checked the changes already, and `check-changed-shapes` checks
  the final shapes, so the changes are not verified again here."
  [state builder]
  (let [changes (:redo-changes builder)
        before  (:file-data state)
        after   (cfc/process-changes before changes false)]
    (-> state
        (assoc :file-data after)
        (update :changes into changes)
        (update :touched-mains into (mapcat #(touched-main-ids before after %)) changes))))

(defn mark-reflow
  "Adds `ids` to the layout reflow of `page-id`. The root id is never added."
  [state page-id ids]
  (update-in state [:reflow page-id]
             (fnil into #{})
             (remove #(or (nil? %) (= uuid/zero %)))
             ids))

(defn assign-grid-cells
  "Gives the children of each grid among `parent-ids` a cell, and frees the
  cells of children that left it."
  [builder parent-ids]
  (reduce (fn [builder parent-id]
            (if (ctl/grid-layout? (pcb/get-objects builder) parent-id)
              (pcb/update-shapes builder
                                 [parent-id]
                                 (fn [shape objs] (ctl/assign-cells shape objs))
                                 {:with-objects? true})
              builder))
          builder
          (distinct (remove nil? parent-ids))))

(defn get-page
  [state page-id]
  (dm/get-in (:file-data state) [:pages-index page-id]))

(defn get-page-objects
  [state page-id]
  (dm/get-in (:file-data state) [:pages-index page-id :objects]))

;; Shape helpers
(defn make-shape
  "Builds a shape with `cts/setup-shape`. The fields win over `attrs`, and
  `attrs` win over `props`. Geometry in `props` is ignored."
  [props attrs fields]
  (cts/setup-shape (merge (apply dissoc (or props {}) geometry-keys) attrs fields)))

(defn shape-name
  "The name of a new shape: the op name, then the props name, then the plain
  `base` name. The default name has no suffix, since a scan of the page for
  the used names would cost a read of every shape per create."
  [op base]
  (or (:name op)
      (get (:props op) :name)
      base))

(defn layout-parent?
  "Whether `shape` is a flex or grid layout. Such a layout keeps its children
  in the reverse of their visual order: the front child is the first in
  `:shapes`."
  [shape]
  (or (ctl/flex-layout? shape)
      (ctl/grid-layout? shape)))

(defn child-index
  "The `:shapes` index of a child that goes to `index` in `parent`. In a
  layout the index is natural, so it counts from the visual start and becomes
  `count - index` in `:shapes`, where count is the number of children before
  the insert. Without an index a child of a layout goes to the front of
  `:shapes`, the last visual place, so creation order is visual order. Any
  other parent keeps the index as it is, and nil appends."
  [parent index]
  (cond
    (not (layout-parent? parent)) index
    (some? index)                 (max 0 (- (count (:shapes parent)) index))
    :else                         0))

(defn add-shape
  [builder shape index]
  (if (some? index)
    (pcb/add-object builder shape {:index index})
    (pcb/add-object builder shape)))

(defn parse-font-size
  [value]
  (cond
    (number? value) value
    (string? value) (d/parse-double value)
    :else nil))

(defn- text-stats
  [characters]
  (let [lines (str/split characters #"\n")]
    [(count lines) (reduce max 0 (map count lines))]))

(defn approximate-text-size
  "Width and height for text without a layout engine: a character is
  0.6 em wide and a line is 1.2 em high."
  [characters font-size]
  (let [[lines longest] (text-stats characters)]
    {:width (max min-text-size (* 0.6 font-size longest))
     :height (max min-text-size (* 1.2 font-size lines))}))

(defn wrapped-height
  "The height of `characters` wrapped at `width`, for a text that grows in
  height. Each paragraph takes as many lines as its characters need at that
  width, and a line is `line-height` em high."
  [characters font-size width line-height]
  (let [lines (reduce (fn [total paragraph]
                        (+ total (max 1 (mth/ceil (/ (* 0.6 font-size (count paragraph))
                                                     (max width min-text-size))))))
                      0
                      (str/split characters #"\n"))]
    (max min-text-size (* (or line-height 1.2) font-size lines))))

(defn auto-grow?
  [grow-type]
  (contains? auto-grow-types grow-type))

;; Geometry: every change goes through modifiers and `lm/generate-apply-modifiers`
(defn- size-step
  "The modifiers that set one dimension of `shape` to `value`, or nil. The
  current size is read from the selrect, which the transforms keep up to date.
  A path does not keep `:width`, so reading it would give a stale size."
  [shape attr value]
  (when (and (some? value)
             (not (mth/close? value (get (:selrect shape) attr))))
    (ctm/change-dimensions-modifiers shape attr value)))

(defn- current-rotation
  "The angle of `shape` in degrees, read from its transform matrix. The
  matrix is the value the transforms keep up to date, while `:rotation` may
  be stale. A flip in x mirrors the first axis, so the matrix has a negative
  determinant: its first column points the other way. The angle is read with
  that column mirrored back, so a flipped shape at rotation 0 reads 0."
  [shape]
  (let [{:keys [a b]} (:transform shape)]
    (if (some? a)
      (let [sign (if (:flip-x shape) -1 1)]
        (mth/degrees (mth/atan2 (* sign b) (* sign a))))
      0)))

(defn- rotation-step
  "The modifiers that turn `shape` about its center to `angle`, or nil. The
  turn takes the shorter way round."
  [shape angle]
  (when (some? angle)
    (let [delta (- angle (current-rotation shape))
          delta (- (mod (+ delta 180) 360) 180)]
      (when-not (mth/close? delta 0)
        (ctm/rotation-modifiers shape (gsh/shape->center shape) delta)))))

(defn- position-step
  "The modifiers that move `shape` so the top-left corner of its points
  rectangle is at `x` and `y`, as the workspace positions a shape. A nil
  coordinate keeps the current one."
  [shape x y]
  (let [bounds (grc/points->rect (:points shape))
        dx     (if (and (some? x) (not (mth/close? x (:x bounds))))
                 (- x (:x bounds))
                 0)
        dy     (if (and (some? y) (not (mth/close? y (:y bounds))))
                 (- y (:y bounds))
                 0)]
    (when-not (and (zero? dx) (zero? dy))
      (ctm/move-modifiers dx dy))))

(defn geometry-modifiers
  "The modifiers that take `shape` to the geometry of an update, or nil when
  nothing changes. The steps are size, rotation and position, as the
  workspace applies them. Each step is computed from the shape that the
  earlier steps give, so the shape after the last step is never built."
  [shape {:keys [x y width height rotation]}]
  (loop [steps     [#(size-step % :width width)
                    #(size-step % :height height)
                    #(rotation-step % rotation)
                    #(position-step % x y)]
         modifiers nil
         shape     shape]
    (if-let [step (first steps)]
      (let [more (next steps)]
        (if-let [step-modifiers (step shape)]
          (recur more
                 (ctm/add-modifiers modifiers step-modifiers)
                 (if more
                   (gsh/transform-shape shape step-modifiers)
                   shape))
          (recur more modifiers shape)))
      modifiers)))

;; Update
(defn- subtree-ids
  "The ids of `id` and of every shape under it in `objects`."
  [objects id]
  (set (tree-seq #(seq (:shapes (get objects %)))
                 #(:shapes (get objects %))
                 id)))

(defn- modifier-ids
  "The ids of the part of `objects` that the geometry of the shape `id` can
  read: the shape and its subtree from the reflow root (the shape itself,
  unless a layout holds it), its ancestors, the children of its group-like
  ancestors, whose bounds a group takes from them, and the whole subtree of
  each bool ancestor, whose bounds come from the paths of all its shapes."
  [objects id]
  (let [root-id   (cgst/get-reflow-root id objects)
        ancestors (cfh/get-parent-ids objects id)]
    (-> (subtree-ids objects root-id)
        (conj id)
        (into ancestors)
        (into (comp (filter #(cfh/group-like-shape? objects %))
                    (mapcat #(:shapes (get objects %))))
              ancestors)
        (into (comp (filter #(cfh/bool-shape? (get objects %)))
                    (mapcat #(subtree-ids objects %)))
              ancestors))))

(defn modifier-objects-of
  "The part of `objects` that the geometry of the shapes `ids` can read: the
  union of the parts of each id, as `modifier-objects` gives for one. Every
  other shape keeps its geometry, so the modifiers over this part equal the
  modifiers over all `objects`, and a family that moves many shapes does not
  give the whole page to the modifiers."
  [objects ids]
  (select-keys objects (into #{} (mapcat #(modifier-ids objects %)) ids)))

(defn modifier-objects
  "The part of `objects` that the geometry of the shape `id` can read. See
  `modifier-ids`."
  [objects id]
  (modifier-objects-of objects [id]))

(defn mark-changes-reflow
  "Adds the shapes that `changes` add or modify, and the parents of the added
  ones, to the reflow of the page each change belongs to."
  [state changes]
  (reduce (fn [state change]
            (if-let [page-id (:page-id change)]
              (mark-reflow state page-id
                           (case (:type change)
                             :add-obj [(:id change) (:parent-id change)]
                             :mod-obj [(:id change)]
                             nil))
              state))
          state
          changes))

(defn parent-ids
  [objects ids]
  (distinct (mapcat #(cfh/get-parent-ids objects %) ids)))

(defn- reflow-pending-ids
  "The ids of `ids` that the reflow can change. A shape can move only when it
  is a layout or has one among its ancestors, so a shape in no layout is left
  out, and the reflow does not run its modifiers over it. This keeps one
  builder from holding every reflowed shape, since each builder step checks
  all its changes. An id with no shape stays, and the reflow skips it."
  [objects ids]
  (filter (fn [id]
            (or (not (contains? objects id))
                (some #(ctl/any-layout? (get objects %))
                      (cons id (cfh/get-parent-ids objects id)))))
          ids))

(defn reflow-pages
  "Runs the layout reflow once for every page that has touched layout ids.
  The pages and the ids come in sorted order, so the changes come out in the
  same order for the same input."
  [state]
  (reduce (fn [state [page-id ids]]
            (let [objects (get-page-objects state page-id)
                  pending (when (some? objects)
                            (reflow-pending-ids objects (sort-by str ids)))]
              (if (seq pending)
                (let [builder (op-builder state page-id)
                      builder (lm/generate-reflow builder objects pending {})]
                  (commit-builder state builder))
                state)))
          state
          (sort-by (comp str key) (:reflow state))))

(def ^:private client-error-types
  "The error types that name a bad operation, which the agent can fix. Any
  other error is a fault in the compiler or in the data."
  #{:validation :assertion :not-found})

(defn- client-error?
  "Whether `cause` names a bad operation. Only an `ExceptionInfo` with one of
  `client-error-types` counts, so a null pointer is never sent to the agent
  as its own mistake."
  [cause]
  (and (ex/ex-info? cause)
       (contains? client-error-types (:type (ex-data cause)))))

(defn raise-compile-error
  "Raises `cause`, an error met while compiling the op at `index` (`nil` for
  the reflow after all ops). A client error becomes a validation error: an
  unknown id keeps its code, and any other becomes an invalid operation, with
  `:cause-code` holding the code of the original. Any other error is an
  internal fault. It keeps the index and the op, and the cause is attached."
  [index op-name cause]
  (if (client-error? cause)
    (let [cause-code (:code (ex-data cause))
          code       (if (= :mcp-unknown-id cause-code)
                       :mcp-unknown-id
                       :mcp-invalid-operation)]
      (ex/raise :type :validation
                :code code
                :cause-code cause-code
                :hint (or (:hint (ex-data cause)) (ex-message cause))
                :index index
                :op op-name
                :cause cause))
    (ex/raise :type :internal
              :code :mcp-compile-failed
              :hint (str "internal error compiling " op-name)
              :index index
              :op op-name
              :cause cause)))

(defn fatal?
  "Whether `cause` is a fault of the machine or a thread interrupt, which a
  compile must pass on. Any other throwable, an Error included, is reported
  as a failure of the op."
  [cause]
  #?(:clj (or (instance? InterruptedException cause)
              (instance? VirtualMachineError cause))
     :cljs (do cause false)))

(def ^:private xf:changed-shape-keys
  "The distinct `[page-id id]` pairs of the add-obj and mod-obj changes, in
  the order of their first change."
  (comp (filter #(contains? #{:add-obj :mod-obj} (:type %)))
        (map (juxt :page-id :id))
        (distinct)))

(defn check-changed-shapes
  "Checks the final state of each shape that `changes` add or modify, once
  per shape. Raises an invalid operation for the first shape that is not
  valid. Returns `state`."
  [state changes]
  (doseq [[page-id id] (sequence xf:changed-shape-keys changes)]
    (let [shape (dm/get-in (:file-data state) [:pages-index page-id :objects id])]
      (when (and (some? shape) (not (cts/valid-shape? shape)))
        (raise-invalid (str "invalid shape " id ": "
                            (pr-str (sm/simplify (cts/explain-shape shape))))))))
  state)
