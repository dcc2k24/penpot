(ns ^{:no-doc true} app.common.mcp.operations.arrange
  "This namespace is internal: `app.common.mcp.operations` is the
  only API.

  The align and distribute ops."
  (:require
   [app.common.geom.align :as gal]
   [app.common.geom.point :as gpt]
   [app.common.geom.shapes :as gsh]
   [app.common.logic.modifiers :as lm]
   [app.common.math :as mth]
   [app.common.mcp.operations.refs :refer [resolve-page-id resolve-shape-ids]]
   [app.common.mcp.operations.schema :refer [g-ids g-page op-schema]]
   [app.common.mcp.operations.state :refer [commit-builder get-page-objects mark-reflow modifier-objects-of op-builder]]
   [app.common.schema :as sm]
   [app.common.types.modifiers :as ctm]
   [app.common.uuid :as uuid]))

;; Align and distribute
(defn- point-delta
  "The move from the `before` shape to the `after` shape, on the first corner."
  [before after]
  (gpt/subtract (-> after :points first)
                (-> before :points first)))

(defn- align-moves
  "The shapes moved to the align axis, as the frontend does: one shape aligns
  to its parent, several shapes align to the bounds of the selection. A shape
  directly under the root is not moved, so the result is nil."
  [objects ids axis]
  (let [shapes (mapv #(get objects %) ids)]
    (if (= 1 (count shapes))
      (let [shape (first shapes)]
        (when-not (= uuid/zero (:parent-id shape))
          [(gal/align-to-parent shape (get objects (:parent-id shape)) axis)]))
      (let [rect (gsh/shapes->rect shapes)]
        (mapv #(gal/align-to-rect % rect axis) shapes)))))

(defn- move-to-changes
  "Moves each of the `moved` shapes by the difference with the shape of the
  page, through the modifiers of a move, so their children and constraints
  follow. Marks the moved shapes and their parents for reflow."
  [state page-id objects moved]
  (let [modif-tree (into {}
                         (keep (fn [shape]
                                 (let [delta (point-delta (get objects (:id shape)) shape)]
                                   (when-not (and (mth/close? (:x delta) 0)
                                                  (mth/close? (:y delta) 0))
                                     [(:id shape) {:modifiers (ctm/move-modifiers delta)}]))))
                         moved)
        ids      (vec (keys modif-tree))]
    (if (empty? ids)
      state
      (let [builder (lm/generate-apply-modifiers (op-builder state page-id)
                                                 (modifier-objects-of objects ids)
                                                 modif-tree
                                                 {})]
        (-> state
            (commit-builder builder)
            (mark-reflow page-id (concat ids (map #(:parent-id (get objects %)) ids))))))))

(defn- compile-align-op
  [state op]
  (let [page-id (resolve-page-id state (:page-id op))
        objects (get-page-objects state page-id)
        ids     (resolve-shape-ids state objects (:ids op))]
    (case (:op op)
      "align"
      (let [moved (align-moves objects ids (:axis op))]
        (if (seq moved)
          (move-to-changes state page-id objects moved)
          state))

      "distribute"
      (if (< (count ids) 3)
        state
        (move-to-changes state page-id objects
                         (gal/distribute-space (mapv #(get objects %) ids) (:axis op)))))))

(def ops
  "The ops of the arrange family. Each op name maps to its schema and its
  compile function."
  {"align" {:schema (op-schema "align" g-page g-ids
                               [[:axis [::sm/one-of #{:hleft :hcenter :hright :vtop :vcenter :vbottom}]]])
            :compile compile-align-op}
   "distribute" {:schema (op-schema "distribute" g-page g-ids
                                    [[:axis [::sm/one-of #{:horizontal :vertical}]]])
                 :compile compile-align-op}})
