(ns ^{:no-doc true} app.common.mcp.operations.components
  "This namespace is internal: `app.common.mcp.operations` is the
  only API.

  The component ops: create, instantiate, detach, swap, reset, update the
  main, rename, delete and sync."
  (:require
   [app.common.files.changes-builder :as pcb]
   [app.common.files.helpers :as cfh]
   [app.common.files.shapes-helpers :as cfsh]
   [app.common.geom.point :as gpt]
   [app.common.logic.libraries :as cll]
   [app.common.logic.shapes :as cls]
   [app.common.mcp.operations.refs :refer [alloc-id frame-id-for record-handle resolve-file-entry resolve-library-id resolve-page-id resolve-parent-id resolve-ref resolve-shape-id resolve-shape-ids]]
   [app.common.mcp.operations.schema :refer [decode-op-values g-id g-ids g-overrides g-page op-schema schema:ref tmp-handle?]]
   [app.common.mcp.operations.shapes :refer [compile-update-op]]
   [app.common.mcp.operations.state :refer [commit-builder geometry-attr-keys get-file-record get-libraries get-page get-page-objects mark-changes-reflow mark-reflow op-builder raise-invalid raise-unknown]]
   [app.common.mcp.operations.text :refer [compile-text-op]]
   [app.common.path-names :as cpn]
   [app.common.schema :as sm]
   [app.common.types.component :as ctk]
   [app.common.types.file :as ctf]
   [app.common.types.shape.layout :as ctl]
   [clojure.string :as str]))

;; Components
(defn- component-full-name
  "The name of a component after `op`: the path and the name joined with a
  slash. A missing part keeps the current value of the component."
  [component op]
  (let [path (if (contains? op :path) (:path op) (:path component))
        name (or (:name op) (:name component))]
    (if (str/blank? path)
      name
      (str path "/" name))))

(defn- rename-component-change
  "Renames a component and the name of its main shape, as the frontend does."
  [state component-id full-name]
  (let [state     (commit-builder state
                                  (cll/generate-rename-component (op-builder state nil)
                                                                 component-id
                                                                 full-name
                                                                 (:file-data state)))
        component (get-in (:file-data state) [:components component-id])
        page-id   (:main-instance-page component)
        shape-id  (:main-instance-id component)]
    (if (contains? (get-page-objects state page-id) shape-id)
      (commit-builder state
                      (pcb/update-shapes (op-builder state page-id)
                                         [shape-id]
                                         #(assoc % :name (cpn/merge-path-item (:path component)
                                                                              (:name component)))))
      state)))

(defn- require-copy
  [shape]
  (when-not (ctk/in-component-copy? shape)
    (raise-invalid "the shape is not a component copy")))

(defn- create-component-change
  [state page-id objects op]
  (let [shapes (mapv #(get objects %) (resolve-shape-ids state objects (:shape-ids op)))
        [_ component-id builder]
        (cll/generate-add-component (op-builder state page-id)
                                    shapes
                                    objects
                                    page-id
                                    (:id (:file-data state))
                                    cfsh/prepare-create-artboard-from-selection)
        state (-> state
                  (commit-builder builder)
                  (mark-changes-reflow (:redo-changes builder)))
        state (cond
                (tmp-handle? (:id op))
                (record-handle state (:id op) component-id)

                (some? (:id op))
                (raise-invalid "create_component id must be a $tmp handle")

                :else
                state)]
    (if (or (some? (:name op)) (some? (:path op)))
      (rename-component-change state
                               component-id
                               (component-full-name (get-in (:file-data state) [:components component-id])
                                                    op))
      state)))

(defn- copy-entries
  "The descendants of `parent-id` in `objects`, depth first. Each entry holds
  the `:id`, the `:name` and the `:path` of a descendant. The path joins the
  names from the child of `parent-id` down to the descendant with \" / \"."
  ([objects parent-id]
   (copy-entries objects parent-id nil))
  ([objects parent-id prefix]
   (mapcat (fn [child-id]
             (let [child-name (:name (get objects child-id))
                   path       (if (some? prefix)
                                (str prefix " / " child-name)
                                child-name)]
               (cons {:id child-id :name child-name :path path}
                     (copy-entries objects child-id path))))
           (:shapes (get objects parent-id)))))

(defn- override-id
  "The id of the one descendant of the copy `root-id` that `override` names,
  by its `:name` or by its `:path`. Raises an invalid operation when the
  override names neither or both, or when no descendant or several match."
  [objects root-id override]
  (when (= (some? (:name override)) (some? (:path override)))
    (raise-invalid "an override needs exactly one of name and path"))
  (let [field   (if (some? (:name override)) :name :path)
        value   (get override field)
        matches (filter #(= value (get % field))
                        (copy-entries objects root-id))]
    (case (count matches)
      0 (raise-invalid (str "no descendant of the copy matches " value))
      1 (:id (first matches))
      (raise-invalid (str "several descendants of the copy match " value)))))

(defn- apply-override
  "Applies one override to the copy `root-id` of `page-id`. The characters go
  through the `set_text` branch and the props through `update_shape`, so both
  are checked as those ops check them. Geometry is refused. Returns `state`."
  [state page-id root-id override]
  (let [props (:props override)
        id    (override-id (get-page-objects state page-id) root-id override)]
    (when-let [k (some #(when (contains? props %) %) geometry-attr-keys)]
      (raise-invalid (str "geometry overrides are not supported: " (name k))))
    (cond-> state
      (some? (:characters override))
      (compile-text-op {:op "set_text" :page-id page-id :id id
                        :characters (:characters override)})

      (some? props)
      (compile-update-op (decode-op-values {:op "update_shape" :page-id page-id
                                            :id id :props props})))))

(defn- instantiate-change
  [state page-id objects op]
  (let [libraries    (get-libraries state)
        file-id      (if (some? (:library-id op))
                       (resolve-library-id state libraries (:library-id op))
                       (:id (:file-data state)))
        component-id (resolve-ref state (:component-id op))
        _            (when (nil? (ctf/get-component libraries file-id component-id))
                       (raise-unknown (str "unknown component " component-id)))
        [id state]   (alloc-id state (:id op) #(contains? objects %))
        parent-id    (resolve-parent-id state objects (:parent-id op))
        ;; A copy of the component inside the component, or inside one of its
        ;; copies, would hold itself
        _            (when (some #(= component-id (:component-id %))
                                 (cfh/get-parents-with-self objects parent-id))
                       (raise-invalid "an instance cannot be placed inside its own component"))
        frame-id     (frame-id-for objects parent-id)
        ;; The ids map forces the id of the new root to `id`.
        [_ builder]  (cll/generate-instantiate-component (op-builder state page-id)
                                                         objects
                                                         file-id
                                                         component-id
                                                         (gpt/point (:x op) (:y op))
                                                         (get-page state page-id)
                                                         libraries
                                                         nil
                                                         parent-id
                                                         frame-id
                                                         {nil id}
                                                         {})]
    (reduce (fn [state override]
              (apply-override state page-id id override))
            (-> state
                (commit-builder builder)
                (mark-changes-reflow (:redo-changes builder)))
            (:overrides op))))

(defn- detach-change
  "Detaches each shape with its own builder, since the detach builder reads
  the file it is given and the earlier detaches change it."
  [state page-id objects op]
  (let [ids (resolve-shape-ids state objects (:ids op))]
    (reduce (fn [state id]
              (commit-builder state
                              (cll/generate-detach-component (op-builder state page-id)
                                                             id
                                                             (:file-data state)
                                                             page-id
                                                             (get-libraries state))))
            state
            ids)))

(defn- swap-change
  [state page-id objects op]
  (let [libraries    (get-libraries state)
        id           (resolve-shape-id state objects (:id op))
        shape        (get objects id)
        library-id   (when (some? (:library-id op))
                       (resolve-library-id state libraries (:library-id op)))
        file-id      (or library-id (:id (:file-data state)))
        component-id (resolve-ref state (:component-id op))
        _            (when (nil? (ctf/get-component libraries file-id component-id))
                       (raise-unknown (str "unknown component " component-id)))
        ;; The builder takes the file the new component lives in, as the
        ;; frontend does.
        file         (if (some? library-id)
                       (get-in libraries [library-id :data])
                       (:file-data state))
        parent       (get objects (:parent-id shape))
        target-cell  (when (ctl/grid-layout? parent)
                       (ctl/get-cell-by-shape-id parent id))
        index        (cfh/get-position-on-parent objects id)
        keep-values  (select-keys shape ctk/swap-keep-attrs)
        [new-shape parents builder]
        (cll/generate-component-swap (op-builder state page-id)
                                     objects
                                     shape
                                     file
                                     (get-page state page-id)
                                     libraries
                                     component-id
                                     index
                                     target-cell
                                     keep-values
                                     false)]
    (-> state
        (commit-builder builder)
        (mark-reflow page-id (concat [(:id new-shape) (:parent-id shape)] parents)))))

(defn- reset-change
  [state page-id objects op]
  (let [id        (resolve-shape-id state objects (:id op))
        shape     (get objects id)
        _         (require-copy shape)
        container (cfh/make-container (get-page state page-id) :page)
        builder   (cll/generate-reset-component (op-builder state page-id)
                                                (get-file-record state)
                                                (get-libraries state)
                                                container
                                                id)]
    (-> state
        (commit-builder builder)
        (mark-changes-reflow (:redo-changes builder)))))

(defn- update-main-change
  [state page-id objects op]
  (let [id        (resolve-shape-id state objects (:id op))
        shape     (get objects id)
        _         (require-copy shape)
        container (cfh/make-container (get-page state page-id) :page)
        builder   (cll/generate-sync-shape-inverse (op-builder state page-id)
                                                   (get-file-record state)
                                                   (get-libraries state)
                                                   container
                                                   id)]
    (-> state
        (commit-builder builder)
        (mark-changes-reflow (:redo-changes builder)))))

(defn- compile-component-op
  [state op]
  (let [page-id (resolve-page-id state (:page-id op))
        objects (get-page-objects state page-id)]
    (case (:op op)
      "create_component" (create-component-change state page-id objects op)
      "instantiate_component" (instantiate-change state page-id objects op)
      "detach" (detach-change state page-id objects op)
      "swap_component" (swap-change state page-id objects op)
      "reset_overrides" (reset-change state page-id objects op)
      "update_main" (update-main-change state page-id objects op))))

(defn- compile-component-library-op
  [state op]
  (case (:op op)
    "rename_component"
    (let [id        (resolve-file-entry state :components (:component-id op))
          component (get-in (:file-data state) [:components id])]
      (rename-component-change state id (component-full-name component op)))

    "delete_component"
    (let [id        (resolve-file-entry state :components (:component-id op))
          component (get-in (:file-data state) [:components id])
          page-id   (:main-instance-page component)
          root-id   (:main-instance-id component)
          objects   (get-page-objects state page-id)]
      (when (:deleted component)
        (raise-invalid "the component is already deleted"))
      (if (contains? objects root-id)
        ;; As the workspace does: deleting the main root also deletes the
        ;; component, before the root is removed.
        (let [[all-parents builder]
              (cls/generate-delete-shapes (op-builder state page-id)
                                          (:file-data state)
                                          (get-page state page-id)
                                          objects
                                          #{root-id}
                                          nil)]
          (-> state
              (commit-builder builder)
              (mark-reflow page-id all-parents)))
        (commit-builder state
                        (pcb/delete-component (op-builder state nil)
                                              id
                                              page-id))))

    "restore_component"
    (let [fdata     (:file-data state)
          id        (resolve-file-entry state :components (:component-id op))
          component (get-in fdata [:components id])
          _         (when-not (:deleted component)
                      (raise-invalid "the component is not deleted"))
          page-id   (if (some? (:page-id op))
                      (resolve-page-id state (:page-id op))
                      (:main-instance-page component))
          _         (when (nil? (get-page state page-id))
                      (raise-invalid "restore_component needs an existing page"))
          builder   (cll/generate-restore-component (op-builder state page-id)
                                                    fdata
                                                    id
                                                    (:id fdata)
                                                    (get-page state page-id)
                                                    (get-page-objects state page-id))]
      (-> state
          (commit-builder builder)
          (mark-changes-reflow (:redo-changes builder))))

    "sync_components"
    (let [fdata   (:file-data state)
          file-id (:id fdata)
          ;; Without ids, only the mains that earlier ops in this compile
          ;; touched are synced.
          ids     (if (some? (:component-ids op))
                    (mapv #(resolve-file-entry state :components %) (:component-ids op))
                    (into [] (keep (fn [id]
                                     (let [component (get-in fdata [:components id])]
                                       (when (and (some? component)
                                                  (not (:deleted component)))
                                         id))))
                          (:touched-mains state)))]
      (reduce (fn [state id]
                (let [builder (cll/generate-sync-file (op-builder state nil)
                                                      file-id
                                                      :components
                                                      id
                                                      file-id
                                                      (get-libraries state)
                                                      file-id)]
                  (-> state
                      (commit-builder builder)
                      (mark-changes-reflow (:redo-changes builder)))))
              state
              ids))))

(def ops
  "The ops of the components family. Each op name maps to its schema and its
  compile function."
  {"create_component" {:schema (op-schema "create_component" g-page
                                          [[:shape-ids [:vector {:min 1} schema:ref]]
                                           [:name {:optional true} :string]
                                           [:path {:optional true} :string]
                                           [:id {:optional true} schema:ref]])
                       :compile compile-component-op}
   "instantiate_component" {:schema (op-schema "instantiate_component" g-page g-overrides
                                               [[:component-id schema:ref]
                                                [:library-id {:optional true} schema:ref]
                                                [:parent-id {:optional true} schema:ref]
                                                [:id {:optional true} schema:ref]
                                                [:x ::sm/safe-number]
                                                [:y ::sm/safe-number]])
                            :compile compile-component-op}
   "detach" {:schema (op-schema "detach" g-page g-ids)
             :compile compile-component-op}
   "swap_component" {:schema (op-schema "swap_component" g-page g-id
                                        [[:component-id schema:ref]
                                         [:library-id {:optional true} schema:ref]])
                     :compile compile-component-op}
   "reset_overrides" {:schema (op-schema "reset_overrides" g-page g-id)
                      :compile compile-component-op}
   "update_main" {:schema (op-schema "update_main" g-page g-id)
                  :compile compile-component-op}
   "rename_component" {:schema (op-schema "rename_component"
                                          [[:component-id schema:ref]
                                           [:name :string]
                                           [:path {:optional true} :string]])
                       :compile compile-component-library-op}
   "delete_component" {:schema (op-schema "delete_component"
                                          [[:component-id schema:ref]])
                       :compile compile-component-library-op}
   "restore_component" {:schema (op-schema "restore_component"
                                           [[:component-id schema:ref]
                                            [:page-id {:optional true} schema:ref]])
                        :compile compile-component-library-op}
   "sync_components" {:schema (op-schema "sync_components"
                                         [[:component-ids {:optional true} [:vector schema:ref]]])
                      :compile compile-component-library-op}})
