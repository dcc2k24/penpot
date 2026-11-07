(ns ^{:no-doc true} app.common.mcp.operations.refs
  "This namespace is internal: `app.common.mcp.operations` is the
  only API.

  Resolves the refs of the ops: ids and handles, pages, shapes, parents,
  and the entries of the file and its libraries."
  (:require
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.logic.shapes :as cls]
   [app.common.mcp.operations.schema :refer [tmp-handle?]]
   [app.common.mcp.operations.state :refer [raise-invalid raise-unknown]]
   [app.common.types.component :as ctk]
   [app.common.uuid :as uuid]))

;; References
(defn resolve-ref
  "Returns the uuid of a ref. Handles must already be created by an earlier
  operation. Literal uuids are not checked against the file."
  [state ref]
  (cond
    (tmp-handle? ref)
    (or (get (:created-ids state) ref)
        (raise-unknown (str "unknown handle " ref)))

    (uuid? ref)
    ref

    :else
    (or (uuid/parse* ref)
        (raise-invalid (str "invalid id " ref)))))

(defn resolve-page-id
  [state ref]
  (let [id (resolve-ref state ref)]
    (if (some? (dm/get-in (:file-data state) [:pages-index id]))
      id
      (raise-unknown (str "unknown page " id)))))

(defn resolve-shape-id
  "Resolves a ref that must be a shape of `objects`."
  [state objects ref]
  (let [id (resolve-ref state ref)]
    (if (and (contains? objects id) (not= id uuid/zero))
      id
      (raise-unknown (str "unknown shape " id)))))

(defn resolve-shape-ids
  "Resolves refs that must be shapes of `objects`. A shape may be named only
  once, since a repeat would move or group it twice."
  [state objects refs]
  (let [ids (mapv #(resolve-shape-id state objects %) refs)]
    (when-not (= (count ids) (count (set ids)))
      (raise-invalid "a shape is named more than once"))
    ids))

(defn- container-shape?
  "Whether `shape` can hold children: a board, a group or a boolean."
  [shape]
  (contains? #{:frame :group :bool} (:type shape)))

(defn check-parent-accepts-children
  "Raises an invalid operation when `parent-id` cannot take a new child. Inside
  a component copy, a shape cannot be added: `detach` the copy first if the
  shape must go there. A variant container holds only its variants."
  [objects parent-id]
  (let [parent (get objects parent-id)]
    (when (ctk/in-component-copy? parent)
      (raise-invalid (str "parent " parent-id " is inside a component copy; a shape cannot be added to it")))
    (when (ctk/is-variant-container? parent)
      (raise-invalid (str "parent " parent-id " is a variant container; it holds only variants")))))

(defn resolve-parent-id
  "Resolves a parent ref. The root id is always valid, and a missing ref
  means the root. Any other parent must be a board, a group or a boolean, as
  the editor only nests shapes in those."
  [state objects ref]
  (if (nil? ref)
    uuid/zero
    (let [id (resolve-ref state ref)]
      (cond
        (= id uuid/zero)
        id

        (not (contains? objects id))
        (raise-unknown (str "unknown parent " id))

        (not (container-shape? (get objects id)))
        (raise-invalid (str "parent " id " is a " (name (:type (get objects id)))
                            " and cannot hold children; use a board, a group or a boolean"))

        :else
        (do (check-parent-accepts-children objects id)
            id)))))

(defn check-structure-move
  "Checks the move of the shapes `ids` into `parent-id` of `objects`, and
  returns the ids to move. Raises an invalid operation for a move that the
  editor refuses. See `cls/check-structure-move`."
  [objects ids parent-id]
  (let [{:keys [ids problem]} (cls/check-structure-move objects ids parent-id)]
    (when (some? problem)
      (raise-invalid problem))
    ids))

(defn record-handle
  [state ref id]
  (when (contains? (:created-ids state) ref)
    (raise-invalid (str "handle already used " ref)))
  (assoc-in state [:created-ids ref] id))

(defn alloc-id
  "Returns the id for a create op and the state with its handle recorded.
  A missing id gets a new uuid that no handle refers to. A literal id must
  not be taken already: `taken?` tells whether an id is in the collection
  that the op creates into."
  [state ref taken?]
  (cond
    (nil? ref)
    [((:new-id-fn state)) state]

    (tmp-handle? ref)
    (let [id ((:new-id-fn state))]
      [id (record-handle state ref id)])

    :else
    (let [id (resolve-ref state ref)]
      (when (taken? id)
        (raise-invalid "id already exists"))
      [id state])))

(defn alloc-unchecked-id
  "Like `alloc-id` for collections that are not checked for literal ids."
  [state ref]
  (alloc-id state ref (constantly false)))

(defn frame-id-for
  "The frame a child of `parent-id` belongs to."
  [objects parent-id]
  (let [parent (get objects parent-id)]
    (cond
      (cfh/frame-shape? parent) parent-id
      (some? parent) (or (:frame-id parent) uuid/zero)
      :else uuid/zero)))

;; Library and file entries
(defn resolve-file-entry
  "Resolves a ref that must be an entry of the working file under `k`, such
  as `:colors` or `:components`."
  [state k ref]
  (let [id (resolve-ref state ref)]
    (when-not (contains? (get (:file-data state) k) id)
      (raise-unknown (str "unknown " (name k) " " id)))
    id))

(defn resolve-library-id
  [state libraries ref]
  (let [id (resolve-ref state ref)]
    (when-not (contains? libraries id)
      (raise-unknown (str "unknown library " id)))
    id))

(defn require-ref
  "Returns `ref`, or raises when it is missing."
  [ref hint]
  (if (nil? ref)
    (raise-invalid hint)
    ref))
