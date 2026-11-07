(ns ^{:no-doc true} app.common.mcp.operations.library
  "This namespace is internal: `app.common.mcp.operations` is the
  only API.

  The colour and typography ops of a file, and applying a typography."
  (:require
   [app.common.data.macros :as dm]
   [app.common.files.changes-builder :as pcb]
   [app.common.logic.shapes :as cls]
   [app.common.mcp.operations.refs :refer [alloc-unchecked-id resolve-file-entry resolve-library-id resolve-page-id resolve-ref resolve-shape-id]]
   [app.common.mcp.operations.schema :refer [decode-checked g-id g-page op-schema schema:library-color schema:ref schema:typography]]
   [app.common.mcp.operations.state :refer [auto-grow? commit-builder get-page-objects mark-reflow op-builder raise-invalid raise-unknown]]
   [app.common.mcp.operations.text :refer [apply-text-attrs font-variant-attrs refit-text set-text-content text-content-attrs]]
   [app.common.types.text :as txt]
   [app.common.types.typography :as cty]))

;; Colors and typographies
(defn- compile-color-op
  [state op]
  (case (:op op)
    "create_color"
    (let [color      (:color op)
          [id state] (alloc-unchecked-id state (:id color))]
      (when (contains? (:colors (:file-data state)) id)
        (raise-invalid (str "color already exists " id)))
      (let [color (decode-checked "color" schema:library-color (assoc color :id id))]
        (commit-builder state
                        (pcb/add-color (op-builder state nil) color))))

    "update_color"
    (let [color (:color op)
          id    (resolve-file-entry state :colors (:id color))
          prev  (dm/get-in (:file-data state) [:colors id])
          color (decode-checked "color" schema:library-color
                                (merge prev (assoc color :id id)))]
      (commit-builder state
                      (pcb/update-color (op-builder state nil) color)))

    "delete_color"
    (let [id (resolve-file-entry state :colors (:id op))]
      (commit-builder state (pcb/delete-color (op-builder state nil) id)))))

(defn- compile-typography-op
  [state op]
  (case (:op op)
    "create_typography"
    (let [typography (:typography op)
          [id state] (alloc-unchecked-id state (:id typography))]
      (when (contains? (:typographies (:file-data state)) id)
        (raise-invalid (str "typography already exists " id)))
      (let [font-id  (or (:font-id typography) (:font-id txt/default-text-attrs))
            typography (merge (cty/make-typography {:id id})
                              (font-variant-attrs font-id typography)
                              {:id id})
            typography (decode-checked "typography" schema:typography typography)]
        (commit-builder state
                        (pcb/add-typography (op-builder state nil) typography))))

    "update_typography"
    (let [typography (:typography op)
          id         (resolve-file-entry state :typographies (:id typography))
          prev       (dm/get-in (:file-data state) [:typographies id])
          font-id    (or (:font-id typography)
                         (:font-id prev)
                         (:font-id txt/default-text-attrs))
          typography (decode-checked "typography" schema:typography
                                     (merge prev
                                            (assoc (font-variant-attrs font-id typography)
                                                   :id id)))]
      (commit-builder state
                      (pcb/update-typography (op-builder state nil) typography)))

    "delete_typography"
    (let [id (resolve-file-entry state :typographies (:id op))]
      (commit-builder state (pcb/delete-typography (op-builder state nil) id)))))

;; Typography references
(def ^:private typography-leaf-keys
  "The typography attrs that the text nodes take. The paragraph attrs go on
  the paragraph nodes."
  [:font-id :font-family :font-variant-id :font-size :font-weight :font-style
   :line-height :letter-spacing :text-transform :text-decoration])

(defn- get-typography-source
  "The typography an `apply_typography` op refers to, with the id of the file
  that holds it: the library when `library-id` is given, else the file."
  [state op]
  (let [typography-id (resolve-ref state (:typography-id op))
        library-id    (some->> (:library-id op)
                               (resolve-library-id state (:libraries state)))
        typographies  (if (some? library-id)
                        (get-in (:libraries state) [library-id :data :typographies])
                        (:typographies (:file-data state)))
        typography    (get typographies typography-id)]
    (when-not (some? typography)
      (raise-unknown (str "unknown typography " typography-id)))
    [typography (or library-id (:id (:file-data state)))]))

(defn- apply-typography-change
  [state op]
  (let [page-id     (resolve-page-id state (:page-id op))
        objects     (get-page-objects state page-id)
        id          (resolve-shape-id state objects (:id op))
        shape       (get objects id)
        _           (when-not (= :text (:type shape))
                      (raise-invalid "the shape is not a text"))
        [typography file-id] (get-typography-source state op)
        leaf        (-> (select-keys typography typography-leaf-keys)
                        (assoc :typography-ref-id (:id typography)
                               :typography-ref-file file-id))
        content     (apply-text-attrs (:content shape)
                                      {:paragraph (select-keys typography txt/paragraph-attrs)
                                       :leaf leaf})
        builder     (cls/generate-update-shapes (op-builder state page-id)
                                                [id]
                                                #(set-text-content % content)
                                                objects
                                                {:attrs text-content-attrs})]
    (-> state
        (commit-builder builder)
        (refit-text page-id id)
        (mark-reflow page-id [id (:parent-id shape)])
        (cond-> (auto-grow? (:grow-type shape))
          (update :warnings conj {:code :text-size-approximate :id id})))))

(def ops
  "The ops of the library family. Each op name maps to its schema and its
  compile function."
  {"create_color" {:schema (op-schema "create_color"
                                      [[:color [:map]]])
                   :compile compile-color-op}
   "update_color" {:schema (op-schema "update_color"
                                      [[:color [:map [:id schema:ref]]]])
                   :compile compile-color-op}
   "delete_color" {:schema (op-schema "delete_color" g-id)
                   :compile compile-color-op}
   "create_typography" {:schema (op-schema "create_typography"
                                           [[:typography [:map]]])
                        :compile compile-typography-op}
   "update_typography" {:schema (op-schema "update_typography"
                                           [[:typography [:map [:id schema:ref]]]])
                        :compile compile-typography-op}
   "delete_typography" {:schema (op-schema "delete_typography" g-id)
                        :compile compile-typography-op}
   "apply_typography" {:schema (op-schema "apply_typography" g-page g-id
                                          [[:typography-id schema:ref]
                                           [:library-id {:optional true} schema:ref]])
                       :compile apply-typography-change}})
