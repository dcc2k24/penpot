;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.common.mcp.operations
  "Compiles backend MCP operations into file change sets.

  Operations run in order against the real file data. Each operation
  builds its changes on a fresh changes builder, and the redo changes are
  applied to the file data before the next operation runs."
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.exceptions :as ex]
   [app.common.files.changes :as cfc]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.helpers :as cfh]
   [app.common.files.shapes-helpers :as cfsh]
   [app.common.files.tokens :as cfo]
   [app.common.fonts.builtin :as builtin]
   [app.common.geom.align :as gal]
   [app.common.geom.point :as gpt]
   [app.common.geom.rect :as grc]
   [app.common.geom.shapes :as gsh]
   [app.common.geom.shapes.tree-seq :as cgst]
   [app.common.json :as json]
   [app.common.logic.libraries :as cll]
   [app.common.logic.modifiers :as lm]
   [app.common.logic.shapes :as cls]
   [app.common.logic.token-application :as tapp]
   [app.common.logic.tokens :as clt]
   [app.common.math :as mth]
   [app.common.path-names :as cpn]
   [app.common.schema :as sm]
   [app.common.types.color :as ctc]
   [app.common.types.component :as ctk]
   [app.common.types.container :as ctn]
   [app.common.types.file :as ctf]
   [app.common.types.fills :as ctfl]
   [app.common.types.grid :as ctg]
   [app.common.types.modifiers :as ctm]
   [app.common.types.page :as ctp]
   [app.common.types.path :as path]
   [app.common.types.shape :as cts]
   [app.common.types.shape.interactions :as ctsi]
   [app.common.types.shape.layout :as ctl]
   [app.common.types.text :as txt]
   [app.common.types.token :as cto]
   [app.common.types.tokens-lib :as ctob]
   [app.common.types.tokens-status :as ctos]
   [app.common.types.typography :as cty]
   [app.common.uuid :as uuid]
   [clojure.string :as str]))

;; Schemas

(def schema:ref
  [:or ::sm/uuid [:string {:min 6}]])

(defn tmp-handle?
  "Returns true when `v` is a `$tmp:<name>` handle for an id created by
  an earlier operation."
  [v]
  (and (string? v)
       (str/starts-with? v "$tmp:")))

(defn- op-schema
  "Builds the map schema of one operation. `groups` are vectors of
  entries, so each group can be shared between operations."
  [op-name & groups]
  (into [:map {:title op-name} [:op [:= op-name]]] cat groups))

(def ^:private g-page
  [[:page-id schema:ref]])

(def ^:private g-id
  [[:id schema:ref]])

(def ^:private g-opt-id
  [[:id {:optional true} schema:ref]])

(def ^:private g-ids
  [[:ids [:vector {:min 1} schema:ref]]])

(def ^:private g-shape
  [[:id {:optional true} schema:ref]
   [:parent-id {:optional true} schema:ref]
   [:index {:optional true} [:int {:min 0}]]
   [:name {:optional true} :string]
   [:props {:optional true} [:map]]])

(def ^:private g-box
  [[:x ::sm/safe-number]
   [:y ::sm/safe-number]
   [:width ::sm/non-negative-safe-number]
   [:height ::sm/non-negative-safe-number]])

(def ^:private g-font
  [[:font-size {:optional true} [:or :string ::sm/safe-number]]
   [:font-family {:optional true} :string]
   [:font-id {:optional true} :string]
   [:font-variant-id {:optional true} :string]
   [:font-weight {:optional true} [:or :string ::sm/safe-number]]
   [:font-style {:optional true} :string]
   [:fills {:optional true} [:vector [:map]]]])

(def ^:private g-text-box
  [[:width {:optional true} ::sm/non-negative-safe-number]
   [:height {:optional true} ::sm/non-negative-safe-number]])

(def ^:private g-gap
  [:map
   [:row-gap {:optional true} ::sm/non-negative-safe-number]
   [:column-gap {:optional true} ::sm/non-negative-safe-number]])

(def ^:private g-padding
  [:map
   [:p1 ::sm/non-negative-safe-number]
   [:p2 ::sm/non-negative-safe-number]
   [:p3 ::sm/non-negative-safe-number]
   [:p4 ::sm/non-negative-safe-number]])

(defn- valid-grid-track?
  "A flex track takes a positive value or none, since the default value
  applies to it. A percent or fixed track needs a value."
  [{:keys [type value]}]
  (case type
    :flex (or (nil? value) (and (number? value) (pos? value)))
    (:percent :fixed) (some? value)
    true))

(def ^:private g-tracks
  [:vector [:and
            [:map
             [:type [::sm/one-of ctl/grid-track-types]]
             [:value {:optional true} [:maybe ::sm/non-negative-safe-number]]]
            [:fn {:error/message "a flex track value must be > 0, and a percent or fixed track needs a value"}
             valid-grid-track?]]])

(def ^:private g-flex
  [[:layout-flex-dir {:optional true} [::sm/one-of ctl/flex-direction-types]]
   [:layout-wrap-type {:optional true} [::sm/one-of ctl/wrap-types]]
   [:layout-gap {:optional true} g-gap]
   [:layout-gap-type {:optional true} [::sm/one-of ctl/gap-types]]
   [:layout-padding {:optional true} g-padding]
   [:layout-padding-type {:optional true} [::sm/one-of ctl/padding-type]]
   [:layout-justify-content {:optional true} [::sm/one-of ctl/justify-content-types]]
   [:layout-align-items {:optional true} [::sm/one-of ctl/align-items-types]]
   [:layout-align-content {:optional true} [::sm/one-of ctl/align-content-types]]
   [:layout-item-h-sizing {:optional true} [::sm/one-of ctl/item-h-sizing-types]]
   [:layout-item-v-sizing {:optional true} [::sm/one-of ctl/item-v-sizing-types]]])

(def ^:private g-grid
  [[:layout-grid-dir {:optional true} [::sm/one-of ctl/grid-direction-types]]
   [:layout-grid-rows {:optional true} g-tracks]
   [:layout-grid-columns {:optional true} g-tracks]
   [:layout-gap {:optional true} g-gap]
   [:layout-gap-type {:optional true} [::sm/one-of ctl/gap-types]]
   [:layout-padding {:optional true} g-padding]
   [:layout-padding-type {:optional true} [::sm/one-of ctl/padding-type]]
   [:layout-align-items {:optional true} [::sm/one-of ctl/align-items-types]]
   [:layout-justify-items {:optional true} [::sm/one-of ctl/justify-items-types]]
   [:layout-align-content {:optional true} [::sm/one-of ctl/align-content-types]]
   [:layout-justify-content {:optional true} [::sm/one-of ctl/justify-content-types]]])

(def ^:private g-child
  [[:layout-item-margin-type {:optional true} [::sm/one-of ctl/item-margin-types]]
   [:layout-item-margin {:optional true}
    [:map
     [:m1 {:optional true} ::sm/safe-number]
     [:m2 {:optional true} ::sm/safe-number]
     [:m3 {:optional true} ::sm/safe-number]
     [:m4 {:optional true} ::sm/safe-number]]]
   [:layout-item-max-h {:optional true} ::sm/non-negative-safe-number]
   [:layout-item-min-h {:optional true} ::sm/non-negative-safe-number]
   [:layout-item-max-w {:optional true} ::sm/non-negative-safe-number]
   [:layout-item-min-w {:optional true} ::sm/non-negative-safe-number]
   [:layout-item-h-sizing {:optional true} [::sm/one-of ctl/item-h-sizing-types]]
   [:layout-item-v-sizing {:optional true} [::sm/one-of ctl/item-v-sizing-types]]
   [:layout-item-align-self {:optional true} [::sm/one-of ctl/item-align-self-types]]
   [:layout-item-absolute {:optional true} :boolean]
   [:layout-item-z-index {:optional true} ::sm/safe-number]])

(def ^:private g-text-attrs
  [[:font-family {:optional true} :string]
   [:font-id {:optional true} :string]
   [:font-variant-id {:optional true} :string]
   [:font-size {:optional true} [:or :string ::sm/safe-number]]
   [:font-weight {:optional true} [:or :string ::sm/safe-number]]
   [:font-style {:optional true} :string]
   [:line-height {:optional true} [:or :string ::sm/safe-number]]
   [:letter-spacing {:optional true} [:or :string ::sm/safe-number]]
   [:text-transform {:optional true} :string]
   [:text-decoration {:optional true} :string]
   [:text-align {:optional true} :string]
   [:vertical-align {:optional true} :string]
   [:fills {:optional true} [:vector [:map]]]])

(def ^:private g-bool-type
  [[:bool-type [::sm/one-of #{:union :difference :intersection :exclude}]]])

(def ^:private g-overrides
  [[:overrides {:optional true}
    [:vector {:max 500}
     [:map
      [:name {:optional true} :string]
      [:path {:optional true} :string]
      [:characters {:optional true} :string]
      [:props {:optional true} [:map]]]]]])

(def schema:operation
  [:multi {:dispatch :op :title "Operation"}
   ["create_page"
    (op-schema "create_page"
               [[:id {:optional true} schema:ref]
                [:name :string]
                [:index {:optional true} [:int {:min 0}]]])]

   ["update_page"
    (op-schema "update_page"
               g-id
               [[:name {:optional true} :string]
                [:background {:optional true} :string]
                [:background-token {:optional true} [:maybe :string]]])]

   ["delete_page"
    (op-schema "delete_page" g-id)]

   ["move_page"
    (op-schema "move_page"
               g-id
               [[:index [:int {:min 0}]]])]

   ["create_board"
    (op-schema "create_board" g-page g-shape g-box)]

   ["create_rect"
    (op-schema "create_rect" g-page g-shape g-box)]

   ["create_ellipse"
    (op-schema "create_ellipse" g-page g-shape g-box)]

   ["create_text"
    (op-schema "create_text" g-page g-shape
               [[:x ::sm/safe-number]
                [:y ::sm/safe-number]]
               g-text-box
               [[:characters :string]
                [:grow-type {:optional true} [::sm/one-of #{:auto-width :auto-height :fixed}]]]
               g-font)]

   ["create_path"
    (op-schema "create_path" g-page g-shape
               [[:x {:optional true} ::sm/safe-number]
                [:y {:optional true} ::sm/safe-number]]
               [[:content {:optional true} :any]
                [:d {:optional true} :string]])]

   ["create_image"
    (op-schema "create_image" g-page g-shape g-box
               [[:media-id ::sm/uuid]
                [:media-width ::sm/positive-safe-number]
                [:media-height ::sm/positive-safe-number]
                [:media-mtype {:optional true} :string]])]

   ["create_svg_raw"
    (op-schema "create_svg_raw" g-page g-shape g-box
               [[:content [:map]]])]

   ["create_group"
    (op-schema "create_group" g-page g-opt-id
               [[:name {:optional true} :string]
                [:child-ids [:vector {:min 1} schema:ref]]])]

   ["create_boolean"
    (op-schema "create_boolean" g-page g-opt-id
               [[:name {:optional true} :string]]
               g-bool-type
               [[:child-ids [:vector {:min 1} schema:ref]]])]

   ["update_shape"
    (op-schema "update_shape" g-page g-id
               [[:props [:map
                         [:x {:optional true} ::sm/safe-number]
                         [:y {:optional true} ::sm/safe-number]
                         [:width {:optional true} ::sm/non-negative-safe-number]
                         [:height {:optional true} ::sm/non-negative-safe-number]
                         [:rotation {:optional true} ::sm/safe-number]]]])]

   ["move_shapes"
    (op-schema "move_shapes" g-page g-ids
               [[:parent-id schema:ref]
                [:index {:optional true} [:int {:min 0}]]])]

   ["reorder"
    (op-schema "reorder" g-page
               [[:parent-id schema:ref]]
               g-ids)]

   ["delete_shapes"
    (op-schema "delete_shapes" g-page g-ids)]

   ["clone_shape"
    (op-schema "clone_shape" g-page g-id
               [[:parent-id {:optional true} schema:ref]
                [:new-id {:optional true} schema:ref]])]

   ["ungroup"
    (op-schema "ungroup" g-page g-id)]

   ["flatten"
    (op-schema "flatten" g-page g-ids)]

   ["make_mask"
    (op-schema "make_mask" g-page
               [[:group-id schema:ref]])]

   ["remove_mask"
    (op-schema "remove_mask" g-page
               [[:group-id schema:ref]])]

   ["set_flex_layout"
    (op-schema "set_flex_layout" g-page g-id g-flex)]

   ["set_grid_layout"
    (op-schema "set_grid_layout" g-page g-id g-grid)]

   ["remove_layout"
    (op-schema "remove_layout" g-page g-id)]

   ["set_layout_child"
    (op-schema "set_layout_child" g-page g-id g-child)]

   ["set_grid_cell"
    (op-schema "set_grid_cell" g-page
               [[:grid-id schema:ref]
                [:child-id schema:ref]
                [:row [:int {:min 1}]]
                [:column [:int {:min 1}]]
                [:row-span {:optional true} [:int {:min 1}]]
                [:column-span {:optional true} [:int {:min 1}]]])]

   ["set_text"
    (op-schema "set_text" g-page g-id
               [[:characters :string]])]

   ["set_text_style"
    (op-schema "set_text_style" g-page g-id
               [[:attrs (into [:map] g-text-attrs)]])]

   ["apply_typography"
    (op-schema "apply_typography" g-page g-id
               [[:typography-id schema:ref]
                [:library-id {:optional true} schema:ref]])]

   ["create_component"
    (op-schema "create_component" g-page
               [[:shape-ids [:vector {:min 1} schema:ref]]
                [:name {:optional true} :string]
                [:path {:optional true} :string]
                [:id {:optional true} schema:ref]])]

   ["instantiate_component"
    (op-schema "instantiate_component" g-page g-overrides
               [[:component-id schema:ref]
                [:library-id {:optional true} schema:ref]
                [:parent-id {:optional true} schema:ref]
                [:id {:optional true} schema:ref]
                [:x ::sm/safe-number]
                [:y ::sm/safe-number]])]

   ["detach"
    (op-schema "detach" g-page g-ids)]

   ["swap_component"
    (op-schema "swap_component" g-page g-id
               [[:component-id schema:ref]
                [:library-id {:optional true} schema:ref]])]

   ["reset_overrides"
    (op-schema "reset_overrides" g-page g-id)]

   ["update_main"
    (op-schema "update_main" g-page g-id)]

   ["rename_component"
    (op-schema "rename_component"
               [[:component-id schema:ref]
                [:name :string]
                [:path {:optional true} :string]])]

   ["delete_component"
    (op-schema "delete_component"
               [[:component-id schema:ref]])]

   ["restore_component"
    (op-schema "restore_component"
               [[:component-id schema:ref]
                [:page-id {:optional true} schema:ref]])]

   ["sync_components"
    (op-schema "sync_components"
               [[:component-ids {:optional true} [:vector schema:ref]]])]

   ["create_color"
    (op-schema "create_color"
               [[:color [:map]]])]

   ["update_color"
    (op-schema "update_color"
               [[:color [:map [:id schema:ref]]]])]

   ["delete_color"
    (op-schema "delete_color" g-id)]

   ["create_typography"
    (op-schema "create_typography"
               [[:typography [:map]]])]

   ["update_typography"
    (op-schema "update_typography"
               [[:typography [:map [:id schema:ref]]]])]

   ["delete_typography"
    (op-schema "delete_typography" g-id)]

   ["create_token_set"
    (op-schema "create_token_set"
               [[:id {:optional true} schema:ref]
                [:name :string]
                [:active {:optional true} :boolean]])]

   ["update_token_set"
    (op-schema "update_token_set" g-id
               [[:name {:optional true} :string]])]

   ["delete_token_set"
    (op-schema "delete_token_set" g-id)]

   ["move_token_set"
    (op-schema "move_token_set" g-id
               [[:before-id {:optional true} schema:ref]])]

   ["create_token"
    (op-schema "create_token"
               [[:set-id schema:ref]
                [:id {:optional true} schema:ref]
                [:type :string]
                [:name :string]
                [:value :any]
                [:description {:optional true} :string]])]

   ["update_token"
    (op-schema "update_token"
               [[:set-id schema:ref]
                [:id schema:ref]
                [:type {:optional true} :string]
                [:name {:optional true} :string]
                [:value {:optional true} :any]
                [:description {:optional true} :string]])]

   ["delete_token"
    (op-schema "delete_token"
               [[:set-id schema:ref]
                [:id schema:ref]])]

   ["create_theme"
    (op-schema "create_theme"
               [[:id {:optional true} schema:ref]
                [:group :string]
                [:name :string]
                [:sets [:vector :string]]])]

   ["update_theme"
    (op-schema "update_theme" g-id
               [[:group {:optional true} :string]
                [:name {:optional true} :string]
                [:sets {:optional true} [:vector :string]]])]

   ["delete_theme"
    (op-schema "delete_theme" g-id)]

   ["activate_theme"
    (op-schema "activate_theme" g-id)]

   ["deactivate_theme"
    (op-schema "deactivate_theme" g-id)]

   ["toggle_set"
    (op-schema "toggle_set"
               [[:set-id schema:ref]])]

   ["set_tokens_status"
    (op-schema "set_tokens_status"
               [[:theme-ids [:vector schema:ref]]
                [:set-ids [:vector schema:ref]]])]

   ["set_tokens_source"
    (op-schema "set_tokens_source"
               [[:library-id [:maybe schema:ref]]])]

   ["import_tokens_dtcg"
    (op-schema "import_tokens_dtcg"
               [[:json :string]
                [:mode [::sm/one-of #{:merge :replace}]]])]

   ["set_base_font_size"
    (op-schema "set_base_font_size"
               [[:value :string]])]

   ["apply_token"
    (op-schema "apply_token" g-page
               [[:shape-ids [:vector {:min 1} schema:ref]]
                [:token-name :string]
                [:attributes [:vector :string]]
                [:resolved-value :any]])]

   ["unapply_token"
    (op-schema "unapply_token" g-page
               [[:shape-ids [:vector {:min 1} schema:ref]]
                [:token-name :string]
                [:attributes [:vector :string]]])]

   ["add_interaction"
    (op-schema "add_interaction" g-page g-id
               [[:interaction [:map]]])]

   ["remove_interaction"
    (op-schema "remove_interaction" g-page g-id
               [[:index [:int {:min 0}]]])]

   ["create_flow"
    (op-schema "create_flow" g-page g-opt-id
               [[:name :string]
                [:starting-frame schema:ref]])]

   ["remove_flow"
    (op-schema "remove_flow" g-page g-id)]

   ["add_ruler_guide"
    (op-schema "add_ruler_guide" g-page g-opt-id
               [[:axis [::sm/one-of #{:horizontal :vertical}]]
                [:position ::sm/safe-number]
                [:frame-id {:optional true} schema:ref]])]

   ["remove_ruler_guide"
    (op-schema "remove_ruler_guide" g-page g-id)]

   ["set_board_grid_guides"
    (op-schema "set_board_grid_guides" g-page g-id
               [[:grids [:vector [:map]]]])]

   ["set_plugin_data"
    (op-schema "set_plugin_data"
               [[:target [::sm/one-of #{:file :page :shape :component :color :typography}]]
                [:id {:optional true} schema:ref]
                [:page-id {:optional true} schema:ref]
                [:namespace :string]
                [:key :string]
                [:value [:maybe :string]]])]

   ["align"
    (op-schema "align" g-page g-ids
               [[:axis [::sm/one-of #{:hleft :hcenter :hright :vtop :vcenter :vbottom}]]])]

   ["distribute"
    (op-schema "distribute" g-page g-ids
               [[:axis [::sm/one-of #{:horizontal :vertical}]]])]])

(def schema:operations
  [:vector {:max 2000} schema:operation])

(defn check-operations
  "Checks `operations` against `schema:operations` and returns them. An
  invalid vector raises an invalid operation with the `:index` of its first
  invalid op, which is nil when the error has no path, and the `:op` name of
  that op when it is a map."
  [operations]
  (when-not (sm/validate schema:operations operations)
    (let [errors (:errors (sm/explain schema:operations operations))
          index  (some #(first (:in %)) errors)
          op     (get operations index)]
      (ex/raise :type :validation
                :code :mcp-invalid-operation
                :hint "invalid operations"
                :index index
                :op (when (map? op) (:op op)))))
  operations)

(defn decode-operations
  "Decodes the JSON-style values of `operations`: keyword enums from
  strings. Decoding a decoded vector returns the same vector."
  [operations]
  (sm/decode schema:operations operations (sm/json-transformer)))

;; Constants

(def ^:private geometry-keys
  #{:selrect :points :transform :transform-inverse})

(def ^:private geometry-attr-keys
  [:x :y :width :height :rotation])

(def ^:private default-names
  {:frame "Board"
   :rect "Rectangle"
   :circle "Ellipse"
   :path "Path"
   :image "Image"
   :svg-raw "SVG"
   :group "Group"
   :bool "Boolean"})

(def ^:private shape-types
  {"create_board" :frame
   "create_rect" :rect
   "create_ellipse" :circle
   "create_path" :path
   "create_image" :image
   "create_svg_raw" :svg-raw})

(def ^:private flex-attr-keys
  [:layout-flex-dir
   :layout-wrap-type
   :layout-gap
   :layout-gap-type
   :layout-padding
   :layout-padding-type
   :layout-justify-content
   :layout-align-items
   :layout-align-content])

(def ^:private grid-attr-keys
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

(def ^:private child-sizing-keys
  [:layout-item-h-sizing
   :layout-item-v-sizing])

(def ^:private child-layout-keys
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

(def ^:private grid-only-keys
  [:layout-grid-dir
   :layout-grid-rows
   :layout-grid-columns
   :layout-grid-cells
   :layout-justify-items])

(def ^:private default-font-size 14)
(def ^:private min-text-size 0.01)
(def ^:private auto-grow-types #{:auto-width :auto-height})
(def ^:private numeric-text-attrs #{:font-size :font-weight :line-height :letter-spacing})

(def ^:private default-text-fills
  [{:fill-color "#000000" :fill-opacity 1}])

;; Errors

(defn- raise-invalid
  [hint]
  (ex/raise :type :validation
            :code :mcp-invalid-operation
            :hint hint))

(defn- raise-unknown
  [hint]
  (ex/raise :type :validation
            :code :mcp-unknown-id
            :hint hint))

;; Map params: decoded and checked per op, so a failure names the op

(def ^:private json-transformer
  (sm/json-transformer))

(def ^:private structural-prop-keys
  "The keys of a shape that `props` cannot set. The ids and links belong to
  the op, and the geometry belongs to the modifiers."
  #{:id :type :parent-id :frame-id :shapes :component-id :component-file
    :component-root :main-instance :shape-ref :applied-tokens :position-data
    :selrect :points :transform :transform-inverse})

(defn- props-schema
  "A closed map schema of the attrs that `props` may set: every attr of
  `cts/schema:shape-attrs` over all the shape types, less the structural
  keys. An attr that several types declare accepts any of their schemas."
  []
  (let [entries (into []
                      (comp (mapcat (fn [[_ _ branch]] (sm/children branch)))
                            (mapcat sm/children))
                      (sm/children (sm/schema cts/schema:shape-attrs)))
        by-key  (reduce (fn [acc [k _ schema]]
                          (update acc k (fnil conj []) schema))
                        {}
                        entries)]
    (into [:map {:closed true}]
          (comp (remove (fn [[k]] (contains? structural-prop-keys k)))
                (map (fn [[k schemas]]
                       (let [schemas (vec (distinct schemas))]
                         [k {:optional true}
                          (if (= 1 (count schemas))
                            (first schemas)
                            (into [:or] schemas))]))))
          by-key)))

(def ^:private schema:props
  (sm/schema (props-schema)))

(defn- coder
  "The JSON decoder and the validator of `schema`, built once."
  [schema]
  {:decode (sm/decoder schema json-transformer)
   :validate (sm/validator schema)})

(def ^:private prop-coders
  "The coder of each key that `props` may set, so an op decodes only the
  keys it gives, with no decoder built per op."
  (into {}
        (map (fn [[k _ schema]] [k (coder (sm/schema schema))]))
        (sm/children schema:props)))

(def ^:private schema-coder
  "The coder of a schema that `decode-checked` takes. The schemas are the
  defs of this namespace, so the cache stays small."
  (memoize coder))

(def ^:private schema:interaction
  (sm/schema ctsi/schema:interaction))

(def ^:private schema:grids
  (sm/schema [:vector ctg/schema:grid]))

(def ^:private schema:fills
  (sm/schema [:vector ctfl/schema:fill]))

(def ^:private schema:library-color
  (sm/schema ctc/schema:library-color))

(def ^:private schema:typography
  (sm/schema cty/schema:typography))

(defn- decode-checked
  "Decodes the JSON-style `value` with `schema` and checks the decoded value
  against it. A value that does not match raises an invalid operation whose
  hint is the explanation of the schema."
  [label schema value]
  (let [{:keys [decode validate]} (schema-coder schema)
        decoded                   (decode value)]
    (if (validate decoded)
      decoded
      (raise-invalid (str label " is invalid: "
                          (pr-str (sm/simplify (sm/explain schema decoded))))))))

(defn- decode-known-props
  "Decodes each value of `props` with the coder of its key, and checks it.
  Returns nil when a key is unknown or a value does not match, so the caller
  can name the failure with the closed schema of `props`."
  [props]
  (reduce-kv (fn [decoded k v]
               (if-let [{:keys [decode validate]} (get prop-coders k)]
                 (let [value (decode v)]
                   (if (validate value)
                     (assoc decoded k value)
                     (reduced nil)))
                 (reduced nil)))
             {}
             props))

(defn- decode-props
  "Decodes and checks the `props` of a create or update op. A structural key
  is refused first, and the hint names it."
  [props]
  (when-let [k (some structural-prop-keys (keys props))]
    (raise-invalid (str "props cannot set the structural key " k)))
  (or (decode-known-props props)
      (decode-checked "props" schema:props props)))

(defn- decode-op-values
  "Decodes the JSON-style map params of `op` and checks them against their
  schemas. Colors and typographies are checked by their ops, since an update
  merges them with the stored value first."
  [op]
  (cond-> op
    (some? (:props op))
    (update :props decode-props)

    (some? (:interaction op))
    (update :interaction #(decode-checked "interaction" schema:interaction %))

    (some? (:grids op))
    (update :grids #(decode-checked "grids" schema:grids %))

    (some? (:fills op))
    (update :fills #(decode-checked "fills" schema:fills %))

    (some? (get-in op [:attrs :fills]))
    (update-in [:attrs :fills] #(decode-checked "fills" schema:fills %))))

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

(defn- initial-state
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
   :libraries (library-records (:libraries opts))})

(defn- file-record
  "The working file as a library record, the shape the sync builders read."
  [state]
  (let [file-data (:file-data state)]
    {:id (:id file-data) :data file-data}))

(defn- libraries-of
  "The libraries the component builders read: the library records plus the
  working copy of the current file."
  [state]
  (assoc (:libraries state) (:id (:file-data state)) (file-record state)))

(defn- op-builder
  "Returns a fresh changes builder over the working file data."
  [state page-id]
  (-> (pcb/empty-changes nil page-id)
      (pcb/with-file-data (:file-data state))
      (pcb/with-library-data (:file-data state))))

(defn- main-component-ids
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

(defn- commit-builder
  "Applies the redo changes of `builder` to the file data and appends them
  to the state changes. Records the components whose mains they touch."
  [state builder]
  (let [changes (:redo-changes builder)
        before  (:file-data state)
        after   (cfc/process-changes before changes)]
    (-> state
        (assoc :file-data after)
        (update :changes into changes)
        (update :touched-mains into (mapcat #(touched-main-ids before after %)) changes))))

(defn- mark-reflow
  "Adds `ids` to the layout reflow of `page-id`. The root id is never added."
  [state page-id ids]
  (update-in state [:reflow page-id]
             (fnil into #{})
             (remove #(or (nil? %) (= uuid/zero %)))
             ids))

(defn- assign-grid-cells
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

(defn- page-of
  [state page-id]
  (dm/get-in (:file-data state) [:pages-index page-id]))

(defn- page-objects
  [state page-id]
  (dm/get-in (:file-data state) [:pages-index page-id :objects]))

;; References

(defn- resolve-ref
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

(defn- resolve-page-id
  [state ref]
  (let [id (resolve-ref state ref)]
    (if (some? (dm/get-in (:file-data state) [:pages-index id]))
      id
      (raise-unknown (str "unknown page " id)))))

(defn- resolve-shape-id
  "Resolves a ref that must be a shape of `objects`."
  [state objects ref]
  (let [id (resolve-ref state ref)]
    (if (and (contains? objects id) (not= id uuid/zero))
      id
      (raise-unknown (str "unknown shape " id)))))

(defn- resolve-shape-ids
  [state objects refs]
  (mapv #(resolve-shape-id state objects %) refs))

(defn- resolve-parent-id
  "Resolves a parent ref. The root id is always valid, and a missing ref
  means the root."
  [state objects ref]
  (if (nil? ref)
    uuid/zero
    (let [id (resolve-ref state ref)]
      (if (or (= id uuid/zero) (contains? objects id))
        id
        (raise-unknown (str "unknown parent " id))))))

(defn- record-handle
  [state ref id]
  (when (contains? (:created-ids state) ref)
    (raise-invalid (str "handle already used " ref)))
  (assoc-in state [:created-ids ref] id))

(defn- alloc-id
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

(defn- alloc-unchecked-id
  "Like `alloc-id` for collections that are not checked for literal ids."
  [state ref]
  (alloc-id state ref (constantly false)))

(defn- frame-id-for
  "The frame a child of `parent-id` belongs to."
  [objects parent-id]
  (let [parent (get objects parent-id)]
    (cond
      (cfh/frame-shape? parent) parent-id
      (some? parent) (or (:frame-id parent) uuid/zero)
      :else uuid/zero)))

;; Shape helpers

(defn- strip-geometry
  [props]
  (reduce dissoc (or props {}) geometry-keys))

(defn- without-keys
  [m ks]
  (reduce dissoc m ks))

(defn- make-shape
  "Builds a shape with `cts/setup-shape`. The fields win over `attrs`, and
  `attrs` win over `props`. Geometry in `props` is ignored."
  [props attrs fields]
  (cts/setup-shape (merge (strip-geometry props) attrs fields)))

(defn- shape-name
  "The name of a new shape: the op name, then the props name, then a unique
  name built from `base`."
  [op objects base]
  (or (:name op)
      (get (:props op) :name)
      (cfh/generate-unique-name base (cfh/get-used-names objects))))

(defn- layout-parent?
  "Whether `shape` is a flex or grid layout. Such a layout keeps its children
  in the reverse of their visual order: the front child is the first in
  `:shapes`."
  [shape]
  (or (ctl/flex-layout? shape)
      (ctl/grid-layout? shape)))

(defn- child-index
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

(defn- add-shape
  [builder shape index]
  (if (some? index)
    (pcb/add-object builder shape {:index index})
    (pcb/add-object builder shape)))

(defn- parse-font-size
  [value]
  (cond
    (number? value) value
    (string? value) (d/parse-double value)
    :else nil))

(defn- text-stats
  [characters]
  (let [lines (str/split characters #"\n")]
    [(count lines) (reduce max 0 (map count lines))]))

(defn- approximate-text-size
  "Width and height for text without a layout engine: a character is
  0.6 em wide and a line is 1.2 em high."
  [characters font-size]
  (let [[lines longest] (text-stats characters)]
    {:width (max min-text-size (* 0.6 font-size longest))
     :height (max min-text-size (* 1.2 font-size lines))}))

(defn- auto-grow?
  [grow-type]
  (contains? auto-grow-types grow-type))

;; Geometry: every change goes through modifiers and `lm/generate-apply-modifiers`

(defn- size-step
  "The modifiers that set one dimension of `shape` to `value`, or nil."
  [shape attr value]
  (when (and (some? value) (not (mth/close? value (get shape attr))))
    (ctm/change-dimensions-modifiers shape attr value)))

(defn- rotation-step
  "The modifiers that turn `shape` about its center to `angle`, or nil."
  [shape angle]
  (when (some? angle)
    (let [delta (- angle (or (:rotation shape) 0))]
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

(defn- geometry-modifiers
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
    (let [[id state] (alloc-id state (:id op) #(some? (page-of state %)))
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
          page    (assoc (page-of state page-id) :index (d/index-of pages page-id))
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

;; Font variants
;;
;; A text or typography names its face by `font-variant-id`, `font-weight` and
;; `font-style`. The three must agree. A bundled font has a table of variants
;; (see `app.common.fonts.builtin`), and any other font uses the numeric
;; convention: `regular` is 400 normal, `italic` is 400 italic, `W` is W
;; normal and `Witalic` is W italic.

(defn- weight-str
  [weight]
  (cond
    (nil? weight)    nil
    (number? weight) (str (long weight))
    :else            (str weight)))

(defn- style-str
  [style]
  (when (some? style)
    (if (contains? #{"normal" "italic"} style)
      style
      (raise-invalid (str "font-style " style " must be normal or italic")))))

(defn- variant-hint
  [font]
  (str "valid font-variant-id values: "
       (str/join ", " (map :id (:variants font)))))

(defn- builtin-variant-attrs
  "The variant attrs of a bundled `font`, read from its table."
  [font attrs variant weight style]
  (let [font-id  (:id font)
        variants (:variants font)]
    (if (some? variant)
      (let [entry (d/seek #(= variant (:id %)) variants)]
        (when-not entry
          (raise-invalid (str "font-variant-id " variant " is not a variant of "
                              font-id "; " (variant-hint font))))
        (when (or (and (some? weight) (not= weight (:weight entry)))
                  (and (some? style) (not= style (:style entry))))
          (raise-invalid (str "font-variant-id " variant " is font-weight "
                              (:weight entry) " and font-style " (:style entry)
                              ", but the op gives font-weight " (or weight "unset")
                              " and font-style " (or style "unset")
                              "; " (variant-hint font))))
        (assoc attrs
               :font-variant-id variant
               :font-weight (:weight entry)
               :font-style (:style entry)))
      (let [weight (or weight "400")
            style  (or style "normal")
            entry  (d/seek #(and (= weight (:weight %)) (= style (:style %)))
                           variants)]
        (when-not entry
          (raise-invalid (str "font " font-id " has no variant with font-weight "
                              weight " and font-style " style
                              "; " (variant-hint font))))
        (assoc attrs
               :font-variant-id (:id entry)
               :font-weight (:weight entry)
               :font-style (:style entry))))))

(defn- variant-weight-style
  "The weight and style that a variant id names by the numeric convention, or
  nil when the id does not name one."
  [variant]
  (cond
    (= "regular" variant) ["400" "normal"]
    (= "italic" variant)  ["400" "italic"]
    :else (when-let [[_ weight italic] (re-matches #"(\d+)(italic)?" variant)]
            [weight (if (some? italic) "italic" "normal")])))

(defn- numeric-variant-id
  [weight style]
  (cond
    (and (= "400" weight) (= "normal" style)) "regular"
    (and (= "400" weight) (= "italic" style)) "italic"
    (= "normal" style)                        weight
    :else                                     (str weight "italic")))

(defn- numeric-font-attrs
  "The variant attrs of a font that is not bundled, by the numeric convention."
  [attrs variant weight style]
  (if (some? variant)
    (if-let [[vweight vstyle] (variant-weight-style variant)]
      (do
        (when (or (and (some? weight) (not= weight vweight))
                  (and (some? style) (not= style vstyle)))
          (raise-invalid (str "font-variant-id " variant " is font-weight "
                              vweight " and font-style " vstyle
                              ", but the op gives font-weight " (or weight "unset")
                              " and font-style " (or style "unset"))))
        (assoc attrs
               :font-variant-id variant
               :font-weight vweight
               :font-style vstyle))
      (cond-> attrs
        (some? weight) (assoc :font-weight weight)
        (some? style)  (assoc :font-style style)))
    (let [weight (or weight "400")
          style  (or style "normal")]
      (assoc attrs
             :font-variant-id (numeric-variant-id weight style)
             :font-weight weight
             :font-style style))))

(defn- font-variant-attrs
  "Fills `font-variant-id`, `font-weight` and `font-style` of `attrs` from one
  another, for the font `font-id`. Refuses attrs that disagree. Returns `attrs`
  as it is when none of the three is given."
  [font-id attrs]
  (let [variant (:font-variant-id attrs)
        weight  (weight-str (:font-weight attrs))
        style   (style-str (:font-style attrs))
        font    (d/seek #(= font-id (:id %)) builtin/local-fonts)]
    (cond
      (and (nil? variant) (nil? weight) (nil? style)) attrs
      (some? font)  (builtin-variant-attrs font attrs variant weight style)
      :else         (numeric-font-attrs attrs variant weight style))))

(defn- text-create-styles
  [op]
  (let [op (font-variant-attrs (or (:font-id op) (:font-id txt/default-text-attrs)) op)]
    (cond-> {:fills (or (:fills op) default-text-fills)}
      (some? (:font-size op))
      (assoc :font-size (str (:font-size op)))

      (some? (:font-family op))
      (assoc :font-family (:font-family op))

      (some? (:font-id op))
      (assoc :font-id (:font-id op))

      (some? (:font-variant-id op))
      (assoc :font-variant-id (:font-variant-id op))

      (some? (:font-weight op))
      (assoc :font-weight (str (:font-weight op)))

      (some? (:font-style op))
      (assoc :font-style (:font-style op)))))

(defn- text-spec
  "Attrs and size of a text created by `op`. A missing size is approximated
  and reported when the grow type is automatic."
  [op]
  (let [characters (:characters op)
        font-size  (or (parse-font-size (:font-size op)) default-font-size)
        grow-type  (:grow-type op)
        approx     (approximate-text-size characters font-size)
        content    (-> (cts/setup-shape {:type :text})
                       :content
                       (txt/change-text characters (text-create-styles op)))
        base-name  (let [s (txt/generate-shape-name characters)]
                     (if (str/blank? s) "Text" s))]
    {:type :text
     :attrs (cond-> {:content content}
              (some? grow-type)
              (assoc :grow-type grow-type))
     :width (or (:width op) (:width approx))
     :height (or (:height op) (:height approx))
     :base-name base-name
     :approximate (and (auto-grow? grow-type)
                       (or (nil? (:width op)) (nil? (:height op))))}))

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
        content (path/move-content content move)
        bounds  (path/calc-selrect content)]
    {:attrs {:content content}
     :x (:x bounds)
     :y (:y bounds)
     :width (:width bounds)
     :height (:height bounds)}))

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
  (let [page-id (resolve-page-id state (:page-id op))
        objects (page-objects state page-id)
        [id state] (alloc-id state (:id op) #(contains? objects %))
        parent-id (resolve-parent-id state objects (:parent-id op))
        {:keys [type attrs x y width height base-name approximate]} (create-spec op)
        shape (make-shape (:props op)
                          attrs
                          {:type type
                           :id id
                           :parent-id parent-id
                           :frame-id (frame-id-for objects parent-id)
                           :name (shape-name op objects base-name)
                           :x x
                           :y y
                           :width width
                           :height height})
        builder (-> (op-builder state page-id)
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

(defn- check-children
  [objects child-ids]
  (when (some #(= uuid/zero %) child-ids)
    (raise-invalid "the root frame cannot be a child"))
  (when (some #(nil? (get objects %)) child-ids)
    (raise-unknown "unknown child")))

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
  "Creates a group or a boolean over the children. The group or boolean takes
  the parent of the first child, and goes at the first child's place. A group
  needs its children in one parent. A group resets their constraints to scale,
  and in a grid it takes the cell of the front child. A boolean takes its
  styles from its head child, and its children lose their layout item data."
  [state op]
  (let [group? (= "create_group" (:op op))
        page-id (resolve-page-id state (:page-id op))
        objects (page-objects state page-id)
        [id state] (alloc-id state (:id op) #(contains? objects %))
        child-ids (resolve-shape-ids state objects (:child-ids op))
        _ (check-children objects child-ids)
        ;; The front child comes first, as in the layers list
        ordered (vec (cfh/order-by-indexed-shapes objects child-ids))
        children (mapv #(get objects %) ordered)
        first-child (first children)
        parent-id (:parent-id first-child)
        _ (if group?
            (check-group-parent children)
            (check-bool-children children))
        ;; The frontend takes the cell of its last shape. Its shapes are in
        ;; the reverse of the layers order, so that is the front child.
        target-cell (when (and group? (ctl/grid-layout? objects parent-id))
                      (ctl/get-cell-by-shape-id (get objects parent-id) (:id first-child)))
        ;; The children in the order of their parent
        stacked (vec (reverse ordered))
        ;; A difference takes its styles from the bottom child, the base of
        ;; the others. The other types take them from the top child.
        head-id (when-not group?
                  (if (= :difference (:bool-type op))
                    (first stacked)
                    (last stacked)))
        selrect (gsh/shapes->rect children)
        index (if group?
                (cfh/get-position-on-parent objects (:id first-child))
                (inc (cfh/get-position-on-parent objects head-id)))
        fields {:id id
                :parent-id parent-id
                :frame-id (frame-id-for objects parent-id)
                :x (:x selrect)
                :y (:y selrect)
                :width (:width selrect)
                :height (:height selrect)}
        shape (if group?
                (make-shape nil {}
                            (assoc fields
                                   :type :group
                                   :name (shape-name op objects (get default-names :group))))
                (-> (make-shape nil
                                (merge {:bool-type (:bool-type op)}
                                       (bool-head-styles (get objects head-id)))
                                (assoc fields
                                       :type :bool
                                       :shapes stacked
                                       :name (shape-name op objects (get default-names :bool))))
                    (path/update-bool-shape objects)
                    (assoc :shapes [])))
        old-parents (map :parent-id children)
        builder (-> (op-builder state page-id)
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

;; Update

(defn- subtree-ids
  "The ids of `id` and of every shape under it in `objects`."
  [objects id]
  (set (tree-seq #(seq (:shapes (get objects %)))
                 #(:shapes (get objects %))
                 id)))

(defn- modifier-objects
  "The part of `objects` that the geometry of the shape `id` can read: the
  shape and its subtree from the reflow root (the shape itself, unless a
  layout holds it), its ancestors, the children of its group-like
  ancestors, whose bounds a group takes from them, and the whole subtree of
  each bool ancestor, whose bounds come from the paths of all its shapes.
  Every other shape keeps its geometry, so the modifiers over this part
  equal the modifiers over all `objects`."
  [objects id]
  (let [root-id   (cgst/get-reflow-root id objects)
        ancestors (cfh/get-parent-ids objects id)
        ids       (-> (subtree-ids objects root-id)
                      (conj id)
                      (into ancestors)
                      (into (comp (filter #(cfh/group-like-shape? objects %))
                                  (mapcat #(:shapes (get objects %))))
                            ancestors)
                      (into (comp (filter #(cfh/bool-shape? (get objects %)))
                                  (mapcat #(subtree-ids objects %)))
                            ancestors))]
    (select-keys objects ids)))

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

(defn- compile-update-op
  "Updates a shape. The geometry goes through modifiers, so the children of
  a board or group and the constraints follow it. The other props are then
  merged on the moved shape, unless the merge can emit nothing. The
  modifiers and the update take only the part of the page that
  `modifier-objects` gives."
  [state op]
  (let [page-id  (resolve-page-id state (:page-id op))
        objects  (page-objects state page-id)
        id       (resolve-shape-id state objects (:id op))
        shape    (get objects id)
        props    (:props op)
        geometry (select-keys props geometry-attr-keys)
        attrs    (without-keys (strip-geometry props) geometry-attr-keys)
        modifiers (geometry-modifiers shape geometry)
        state    (if (some? modifiers)
                   (commit-builder state
                                   (lm/generate-apply-modifiers (op-builder state page-id)
                                                                (modifier-objects objects id)
                                                                {id {:modifiers modifiers}}
                                                                {}))
                   state)
        objects  (page-objects state page-id)
        parents  (cfh/get-parent-ids objects id)
        state    (if (attrs-update-needed? objects id parents attrs)
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
  (let [ids (resolve-shape-ids state objects (:ids op))
        parent-id (resolve-parent-id state objects (:parent-id op))
        old-parents (into #{} (keep #(:parent-id (get objects %))) ids)
        index (child-index (get objects parent-id) (:index op))
        builder (-> (op-builder state page-id)
                    (cls/generate-relocate parent-id index ids)
                    (assign-grid-cells (cons parent-id old-parents)))]
    (-> state
        (commit-builder builder)
        (mark-reflow page-id (concat ids old-parents [parent-id])))))

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
                                                      (page-of state page-id)
                                                      objects
                                                      ids
                                                      nil)
        builder (assign-grid-cells builder parents)]
    (-> state
        (commit-builder builder)
        (mark-reflow page-id parents))))

(defn- clone-change
  [state page-id objects op]
  (let [id (resolve-shape-id state objects (:id op))
        file-data (:file-data state)
        page (dm/get-in file-data [:pages-index page-id])
        builder (cll/generate-duplicate-changes (op-builder state page-id)
                                                objects
                                                page
                                                [id]
                                                (gpt/point 0 0)
                                                (libraries-of state)
                                                file-data
                                                (:id file-data))
        root-id (some (fn [change]
                        (when (and (= :add-obj (:type change))
                                   (= id (:old-id change)))
                          (-> change :obj :id)))
                      (:redo-changes builder))
        _ (when (nil? root-id)
            (raise-invalid "clone produced no root shape"))
        state (if (some? (:new-id op))
                (if (tmp-handle? (:new-id op))
                  (record-handle state (:new-id op) root-id)
                  (raise-invalid "new-id must be a $tmp handle"))
                state)
        parent-id (when (some? (:parent-id op))
                    (resolve-parent-id state objects (:parent-id op)))
        builder (cond-> builder
                  (some? parent-id)
                  (cls/generate-relocate parent-id nil [root-id]))
        builder (assign-grid-cells builder
                                   [(:parent-id (get (pcb/get-objects builder) root-id))
                                    parent-id])]
    (-> state
        (commit-builder builder)
        (mark-reflow page-id [root-id parent-id]))))

(defn- ungroup-change
  [state page-id objects op]
  (let [id (resolve-shape-id state objects (:id op))
        group (get objects id)]
    (when-not (= :group (:type group))
      (raise-invalid "ungroup needs a group"))
    (let [parent-id (:parent-id group)
          children (vec (:shapes group))
          index (inc (cfh/get-position-on-parent objects id))
          builder (cls/generate-relocate (op-builder state page-id) parent-id index children)
          builder (if (contains? (pcb/get-objects builder) id)
                    (second (cls/generate-delete-shapes builder
                                                        (:file-data state)
                                                        (page-of state page-id)
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
  [state page-id objects op]
  (let [id (resolve-shape-id state objects (:group-id op))
        group (get objects id)
        masked? (= "make_mask" (:op op))]
    (when-not (= :group (:type group))
      (raise-invalid "masks need a group"))
    (let [builder (pcb/update-shapes (op-builder state page-id)
                                     [id]
                                     (if masked?
                                       #(assoc % :masked-group true)
                                       #(dissoc % :masked-group)))]
      (commit-builder state builder))))

(defn- compile-structure-op
  [state op]
  (let [page-id (resolve-page-id state (:page-id op))
        objects (page-objects state page-id)]
    (case (:op op)
      "move_shapes" (move-shapes-change state page-id objects op)
      "reorder" (reorder-change state page-id objects op)
      "delete_shapes" (delete-shapes-change state page-id objects op)
      "clone_shape" (clone-change state page-id objects op)
      "ungroup" (ungroup-change state page-id objects op)
      "flatten" (flatten-change state page-id objects op)
      ("make_mask" "remove_mask") (mask-change state page-id objects op))))

;; Layout

(defn- resolve-board-id
  "Resolves a ref that must be a board, the only container of a layout."
  [state objects ref]
  (let [id (resolve-shape-id state objects ref)]
    (when-not (cfh/frame-shape? (get objects id))
      (raise-invalid "layouts need a board"))
    id))

(defn- drop-constraints
  "The children of a layout lose their constraints, since the layout places
  them."
  [shape]
  (dissoc shape :constraints-h :constraints-v))

(defn- reverse-children
  [shape]
  (update shape :shapes (comp vec reverse)))

;; MCP rule: a flex layout shows its children in the reverse of `:shapes`.
;; A board that gets a flex layout while it has no layout yet has its
;; `:shapes` reversed once, so the children keep the order they were created
;; in as their visual order. A board that already has a layout is not
;; reversed again. remove_layout does not reverse back, so a board that gets
;; a layout again after remove_layout is reversed again.
(defn- set-flex-layout-change
  [state page-id objects op]
  (let [id (resolve-board-id state objects (:id op))
        children (cfh/get-immediate-children objects id)
        reverse? (and (seq children)
                      (not (ctl/any-layout? (get objects id))))
        ;; The params are not calculated from the children, as the plugin does
        attrs (merge ctl/initial-flex-layout (select-keys op flex-attr-keys))
        sizing (select-keys op child-sizing-keys)
        builder (-> (op-builder state page-id)
                    (pcb/update-shapes [id]
                                       #(merge (without-keys (cond-> % reverse? reverse-children)
                                                             grid-only-keys)
                                               attrs
                                               sizing))
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
  (let [id       (resolve-board-id state objects (:id op))
        attrs    (without-keys (select-keys op grid-attr-keys)
                               [:layout-grid-rows :layout-grid-columns])
        rows     (mapv default-track (:layout-grid-rows op))
        columns  (mapv default-track (:layout-grid-columns op))
        children (vec (:shapes (get objects id)))
        builder  (-> (op-builder state page-id)
                     (pcb/update-shapes [id]
                                        (fn [shape objs]
                                          (-> shape
                                              (merge ctl/initial-grid-layout attrs)
                                              (add-tracks ctl/add-grid-row rows)
                                              (add-tracks ctl/add-grid-column columns)
                                              (ctl/assign-cells objs)
                                              ctl/reorder-grid-children))
                                        {:with-objects? true})
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
  [state page-id objects op]
  (let [id (resolve-shape-id state objects (:id op))
        shape (get objects id)
        attrs (select-keys op child-layout-keys)
        builder (pcb/update-shapes (op-builder state page-id)
                                   [id]
                                   #(merge % attrs))]
    (-> state
        (commit-builder builder)
        (mark-reflow page-id [id (:parent-id shape)]))))

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
        objects (page-objects state page-id)]
    (case (:op op)
      "set_flex_layout" (set-flex-layout-change state page-id objects op)
      "set_grid_layout" (set-grid-layout-change state page-id objects op)
      "remove_layout" (remove-layout-change state page-id objects op)
      "set_layout_child" (set-layout-child-change state page-id objects op)
      "set_grid_cell" (set-grid-cell-change state page-id objects op))))

;; Text

(defn- content-font-size
  [content]
  (or (some-> (txt/node-seq txt/is-text-node? content)
              first
              :font-size
              parse-font-size)
      default-font-size))

(defn- set-text-content
  "Sets `content` on `shape` and drops its position data, which the new
  content makes stale."
  [shape content]
  (-> shape
      (assoc :content content)
      (dissoc :position-data)))

(defn- refit-text
  "Resizes the text `id` of `page-id` to the approximate size of its content,
  for the automatic grow types. The size goes through the modifiers."
  [state page-id id]
  (let [objects    (page-objects state page-id)
        shape      (get objects id)
        content    (:content shape)
        {:keys [width height]} (approximate-text-size (txt/content->text content)
                                                      (content-font-size content))
        geometry   (case (:grow-type shape)
                     :auto-width {:width width :height height}
                     :auto-height {:height height}
                     {})
        modifiers  (geometry-modifiers shape geometry)]
    (if (some? modifiers)
      (commit-builder state
                      (lm/generate-apply-modifiers (op-builder state page-id)
                                                   objects
                                                   {id {:modifiers modifiers}}
                                                   {:ignore-touched true}))
      state)))

(defn- normalize-text-attrs
  [attrs]
  (reduce-kv (fn [acc k v]
               (assoc acc k (if (and (number? v) (contains? numeric-text-attrs k))
                              (str v)
                              v)))
             {}
             attrs))

(def ^:private root-text-keys (set txt/root-attrs))
(def ^:private paragraph-text-keys (set txt/paragraph-attrs))
(def ^:private leaf-text-keys (set txt/text-node-attrs))

(defn- split-text-attrs
  "Groups `attrs` by the node that holds them: `:root` for the root attrs,
  `:paragraph` for the paragraph attrs and `:leaf` for the text node attrs."
  [attrs]
  (reduce-kv (fn [groups k v]
               (cond
                 (contains? root-text-keys k) (assoc-in groups [:root k] v)
                 (contains? paragraph-text-keys k) (assoc-in groups [:paragraph k] v)
                 (contains? leaf-text-keys k) (assoc-in groups [:leaf k] v)
                 :else groups))
             {}
             attrs))

(defn- merge-text-nodes
  "Merges `attrs` onto the nodes of `content` that match `pred`."
  [content pred attrs]
  (if (seq attrs)
    (txt/transform-nodes pred #(merge % attrs) content)
    content))

(defn- apply-text-attrs
  "Puts each group of `groups`, as made by `split-text-attrs`, on the nodes
  that hold it."
  [content groups]
  (-> content
      (merge-text-nodes txt/is-root-node? (:root groups))
      (merge-text-nodes txt/is-paragraph-node? (:paragraph groups))
      (merge-text-nodes txt/is-text-node? (:leaf groups))))

(defn- compile-text-op
  [state op]
  (let [page-id (resolve-page-id state (:page-id op))
        objects (page-objects state page-id)
        id (resolve-shape-id state objects (:id op))
        shape (get objects id)]
    (when-not (= :text (:type shape))
      (raise-invalid "the shape is not a text"))
    (let [content (case (:op op)
                    "set_text"
                    (txt/change-text (:content shape) (:characters op))

                    "set_text_style"
                    (let [attrs   (:attrs op)
                          font-id (or (:font-id attrs)
                                      (some-> (txt/node-seq txt/is-text-node? (:content shape))
                                              first
                                              :font-id)
                                      (:font-id txt/default-text-attrs))
                          attrs   (font-variant-attrs font-id attrs)]
                      (apply-text-attrs (:content shape)
                                        (split-text-attrs (normalize-text-attrs attrs)))))
          builder (pcb/update-shapes (op-builder state page-id)
                                     [id]
                                     #(set-text-content % content))]
      (-> state
          (commit-builder builder)
          (refit-text page-id id)
          (mark-reflow page-id [id (:parent-id shape)])
          (cond-> (auto-grow? (:grow-type shape))
            (update :warnings conj {:code :text-size-approximate :id id}))))))

;; Library and file entries

(defn- resolve-file-entry
  "Resolves a ref that must be an entry of the working file under `k`, such
  as `:colors` or `:components`."
  [state k ref]
  (let [id (resolve-ref state ref)]
    (when-not (contains? (get (:file-data state) k) id)
      (raise-unknown (str "unknown " (name k) " " id)))
    id))

(defn- resolve-library-id
  [state libraries ref]
  (let [id (resolve-ref state ref)]
    (when-not (contains? libraries id)
      (raise-unknown (str "unknown library " id)))
    id))

(defn- resolve-board
  "Resolves a ref that must be a board of `objects`."
  [state objects ref]
  (let [id (resolve-shape-id state objects ref)]
    (when-not (cfh/frame-shape? (get objects id))
      (raise-invalid "the shape is not a board"))
    id))

(defn- require-ref
  "Returns `ref`, or raises when it is missing."
  [ref hint]
  (if (nil? ref)
    (raise-invalid hint)
    ref))

(defn- mark-changes-reflow
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
    (if (contains? (page-objects state page-id) shape-id)
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
        id    (override-id (page-objects state page-id) root-id override)]
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
  (let [libraries    (libraries-of state)
        file-id      (if (some? (:library-id op))
                       (resolve-library-id state libraries (:library-id op))
                       (:id (:file-data state)))
        component-id (resolve-ref state (:component-id op))
        _            (when (nil? (ctf/get-component libraries file-id component-id))
                       (raise-unknown (str "unknown component " component-id)))
        [id state]   (alloc-id state (:id op) #(contains? objects %))
        parent-id    (resolve-parent-id state objects (:parent-id op))
        frame-id     (frame-id-for objects parent-id)
        ;; The ids map forces the id of the new root to `id`.
        [_ builder]  (cll/generate-instantiate-component (op-builder state page-id)
                                                         objects
                                                         file-id
                                                         component-id
                                                         (gpt/point (:x op) (:y op))
                                                         (page-of state page-id)
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
                                                             (libraries-of state))))
            state
            ids)))

(defn- swap-change
  [state page-id objects op]
  (let [libraries    (libraries-of state)
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
                                     (page-of state page-id)
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
        container (cfh/make-container (page-of state page-id) :page)
        builder   (cll/generate-reset-component (op-builder state page-id)
                                                (file-record state)
                                                (libraries-of state)
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
        container (cfh/make-container (page-of state page-id) :page)
        builder   (cll/generate-sync-shape-inverse (op-builder state page-id)
                                                   (file-record state)
                                                   (libraries-of state)
                                                   container
                                                   id)]
    (-> state
        (commit-builder builder)
        (mark-changes-reflow (:redo-changes builder)))))

(defn- compile-component-op
  [state op]
  (let [page-id (resolve-page-id state (:page-id op))
        objects (page-objects state page-id)]
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
          objects   (page-objects state page-id)]
      (when (:deleted component)
        (raise-invalid "the component is already deleted"))
      (if (contains? objects root-id)
        ;; As the workspace does: deleting the main root also deletes the
        ;; component, before the root is removed.
        (let [[all-parents builder]
              (cls/generate-delete-shapes (op-builder state page-id)
                                          (:file-data state)
                                          (page-of state page-id)
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
          _         (when (nil? (page-of state page-id))
                      (raise-invalid "restore_component needs an existing page"))
          builder   (cll/generate-restore-component (op-builder state page-id)
                                                    fdata
                                                    id
                                                    (:id fdata)
                                                    (page-of state page-id)
                                                    (page-objects state page-id))]
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
                                                      (libraries-of state)
                                                      file-id)]
                  (-> state
                      (commit-builder builder)
                      (mark-changes-reflow (:redo-changes builder)))))
              state
              ids))))

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
          objects (page-objects state page-id)]
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
        objects      (page-objects state page-id)
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
        page    (page-of state page-id)
        objects (page-objects state page-id)]
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
        page    (page-of state page-id)
        objects (page-objects state page-id)]
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

;; Typography references

(def ^:private typography-leaf-keys
  "The typography attrs that the text nodes take. The paragraph attrs go on
  the paragraph nodes."
  [:font-id :font-family :font-variant-id :font-size :font-weight :font-style
   :line-height :letter-spacing :text-transform :text-decoration])

(defn- typography-source
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
  (let [page-id (resolve-page-id state (:page-id op))
        objects (page-objects state page-id)
        id      (resolve-shape-id state objects (:id op))
        shape   (get objects id)
        _       (when-not (= :text (:type shape))
                  (raise-invalid "the shape is not a text"))
        [typography file-id] (typography-source state op)
        leaf    (-> (select-keys typography typography-leaf-keys)
                    (assoc :typography-ref-id (:id typography)
                           :typography-ref-file file-id))
        content (apply-text-attrs (:content shape)
                                  {:paragraph (select-keys typography txt/paragraph-attrs)
                                   :leaf leaf})
        builder (pcb/update-shapes (op-builder state page-id)
                                   [id]
                                   #(set-text-content % content))]
    (-> state
        (commit-builder builder)
        (refit-text page-id id)
        (mark-reflow page-id [id (:parent-id shape)])
        (cond-> (auto-grow? (:grow-type shape))
          (update :warnings conj {:code :text-size-approximate :id id})))))

;; Design tokens: sets, tokens, themes and status

(defn- state-token-lib
  [state]
  (cfo/get-tokens-lib (:file-data state)))

(defn- builder-token-lib
  [builder]
  (cfo/get-tokens-lib (pcb/get-library-data builder)))

(defn- builder-token-status
  "The tokens status of the builder, or an empty one when the file has none."
  [builder]
  (or (cfo/get-tokens-status (pcb/get-library-data builder))
      (ctos/make-tokens-status)))

(defn- resolve-token-set
  [state ref]
  (let [id (resolve-ref state ref)]
    (when-not (some-> (state-token-lib state) (ctob/get-set id))
      (raise-unknown (str "unknown token set " id)))
    id))

(defn- resolve-token-theme
  [state ref]
  (let [id (resolve-ref state ref)]
    (when-not (some-> (state-token-lib state) (ctob/get-theme id))
      (raise-unknown (str "unknown token theme " id)))
    id))

(defn- resolve-token
  [state set-id ref]
  (let [id (resolve-ref state ref)]
    (when-not (some-> (state-token-lib state) (ctob/get-token set-id id))
      (raise-unknown (str "unknown token " id)))
    id))

(defn- check-theme-sets
  "Raises when a theme names a set that the file does not have."
  [state set-names]
  (let [lib (state-token-lib state)]
    (run! (fn [set-name]
            (when-not (some-> lib (ctob/get-set-by-name set-name))
              (raise-unknown (str "unknown token set " set-name))))
          set-names)))

(defn- enable-token-set
  [builder set-id]
  (clt/generate-set-enabled-token-set builder
                                      (builder-token-status builder)
                                      (builder-token-lib builder)
                                      set-id
                                      true))

(defn- create-token-set-change
  "Creates the set, then enables it on a builder over the updated library, so
  that the activation sees the new set."
  [state op]
  (let [[id state] (alloc-unchecked-id state (:id op))]
    (when (some-> (state-token-lib state) (ctob/get-set id))
      (raise-invalid (str "token set already exists " id)))
    (let [state (commit-builder state
                                (pcb/set-token-set (op-builder state nil)
                                                   id
                                                   (ctob/make-token-set :id id :name (:name op))))]
      (if (:active op)
        (commit-builder state (enable-token-set (op-builder state nil) id))
        state))))

(defn- update-token-set-change
  [state op]
  (let [id      (resolve-token-set state (:id op))
        builder (cond-> (op-builder state nil)
                  (some? (:name op))
                  (pcb/rename-token-set id (:name op)))]
    (commit-builder state builder)))

(defn- delete-token-set-change
  [state op]
  (let [id (resolve-token-set state (:id op))]
    (commit-builder state (pcb/set-token-set (op-builder state nil) id nil))))

(defn- set-tree-index
  "The index of the set `set-id` in the flat sets tree."
  [tree set-id]
  (first (keep-indexed (fn [index item]
                         (when (and (not (:group? item))
                                    (= set-id (ctob/get-id (:set item))))
                           index))
                       tree)))

(defn- top-level-append-builder
  "The builder that moves the set at `from-index` of `tree` to the end of the
  top level. The set keeps its last name segment, so a set in a group leaves
  the group."
  [state lib tree from-index]
  (let [from      (nth tree from-index)
        from-path (:path from)
        to-path   [(peek from-path)]
        last-top  (last (keep-indexed (fn [index item]
                                        (when (zero? (:depth item)) index))
                                      tree))
        before    (first (drop (inc from-index) tree))
        builder   (op-builder state nil)]
    (cond
      (and (= from-path to-path) (= from-index last-top))
      builder

      (and (not= from-path to-path) (ctob/set-path-exists? lib to-path))
      (raise-invalid (str "token set already exists at the top level " (peek to-path)))

      :else
      (pcb/move-token-set builder
                          {:from-path from-path
                           :to-path to-path
                           :before-path nil
                           :before-group? nil
                           :prev-before-path (:path before)
                           :prev-before-group? (:group? before)}))))

(defn- move-token-set-change
  "Moves a set before `before-id`. Without `before-id` the set goes to the end
  of the top level."
  [state op]
  (let [id     (resolve-token-set state (:id op))
        lib    (state-token-lib state)
        tree   (vec (ctob/walk-sets-tree-seq (ctob/get-set-tree lib)))
        from-index (set-tree-index tree id)]
    (if (some? (:before-id op))
      (let [to-index (set-tree-index tree (resolve-token-set state (:before-id op)))
            params   {:from-index from-index
                      :to-index to-index
                      :position :top}]
        (commit-builder state (clt/generate-move-token-set (op-builder state nil) lib params)))
      (commit-builder state (top-level-append-builder state lib tree from-index)))))

(defn- compile-token-set-op
  [state op]
  (case (:op op)
    "create_token_set" (create-token-set-change state op)
    "update_token_set" (update-token-set-change state op)
    "delete_token_set" (delete-token-set-change state op)
    "move_token_set" (move-token-set-change state op)))

(defn- check-token-value
  "Raises an invalid operation when `value` is not valid for a token of
  `token-type`, by the schema of the workspace. A number is checked as its
  text, which is how the workspace writes values."
  [token-type value]
  (let [checked (if (number? value) (str value) value)]
    (when-not (sm/validate (cfo/make-token-value-schema token-type) checked)
      (raise-invalid (str "invalid value " (pr-str value)
                          " for a " (name token-type) " token")))))

(defn- check-token-name-free
  "Raises an invalid operation when another token of the set `set-id` already
  has `token-name`. `own-id` is the token that is written, which may keep its
  name."
  [lib set-id token-name own-id]
  (when-let [other (get (ctob/get-tokens lib set-id) token-name)]
    (when-not (= own-id (ctob/get-id other))
      (raise-invalid (str "token name already exists in the set " token-name)))))

(defn- op-token-type
  "The token type that the type string `type-name` of an op names. A DTCG or
  plugin name, such as `borderRadius`, maps to its token type. Any other
  string is keyworded as it is. Raises an invalid operation that lists the
  accepted names when the result is not a token type."
  [type-name]
  (let [token-type (get cto/dtcg-token-type->token-type type-name (keyword type-name))]
    (when-not (contains? cto/token-types token-type)
      (raise-invalid (str "unknown token type " type-name ", accepted values: "
                          (str/join ", " (sort (into (set (map name cto/token-types))
                                                     (keys cto/dtcg-token-type->token-type)))))))
    token-type))

(defn- create-token-change
  [state op]
  (let [set-id     (resolve-token-set state (:set-id op))
        [id state] (alloc-unchecked-id state (:id op))
        lib        (state-token-lib state)]
    (when (some-> lib (ctob/get-token set-id id))
      (raise-invalid (str "token already exists " id)))
    (check-token-name-free lib set-id (:name op) id)
    (let [token (ctob/make-token {:id id
                                  :name (:name op)
                                  :type (op-token-type (:type op))
                                  :value (:value op)
                                  :description (:description op)})]
      (check-token-value (:type token) (:value token))
      (commit-builder state (pcb/set-token (op-builder state nil) set-id id token)))))

(defn- update-token-change
  [state op]
  (let [set-id (resolve-token-set state (:set-id op))
        id     (resolve-token state set-id (:id op))
        prev   (ctob/get-token (state-token-lib state) set-id id)
        fields (cond-> {}
                 (some? (:type op))
                 (assoc :type (op-token-type (:type op)))

                 (some? (:name op))
                 (assoc :name (:name op))

                 (contains? op :value)
                 (assoc :value (:value op))

                 (contains? op :description)
                 (assoc :description (:description op)))
        token  (ctob/make-token (merge (into {} prev) fields))]
    (check-token-name-free (state-token-lib state) set-id (:name token) id)
    (check-token-value (:type token) (:value token))
    (commit-builder state (pcb/set-token (op-builder state nil) set-id id token))))

(defn- delete-token-change
  [state op]
  (let [set-id (resolve-token-set state (:set-id op))
        id     (resolve-token state set-id (:id op))]
    (commit-builder state (pcb/set-token (op-builder state nil) set-id id nil))))

(defn- compile-token-op
  [state op]
  (case (:op op)
    "create_token" (create-token-change state op)
    "update_token" (update-token-change state op)
    "delete_token" (delete-token-change state op)))

(defn- create-theme-change
  [state op]
  (let [[id state] (alloc-unchecked-id state (:id op))]
    (when (some-> (state-token-lib state) (ctob/get-theme id))
      (raise-invalid (str "token theme already exists " id)))
    (check-theme-sets state (:sets op))
    (let [theme (ctob/make-token-theme :id id
                                       :group (:group op)
                                       :name (:name op)
                                       :sets (:sets op))]
      (commit-builder state (pcb/set-token-theme (op-builder state nil) id theme)))))

(defn- update-theme-change
  [state op]
  (let [id     (resolve-token-theme state (:id op))
        prev   (ctob/get-theme (state-token-lib state) id)
        _      (check-theme-sets state (:sets op))
        fields (cond-> {}
                 (some? (:group op))
                 (assoc :group (:group op))

                 (some? (:name op))
                 (assoc :name (:name op))

                 (some? (:sets op))
                 (assoc :sets (:sets op)))
        theme  (ctob/make-token-theme (merge (into {} prev) fields))]
    (commit-builder state (pcb/set-token-theme (op-builder state nil) id theme))))

(defn- delete-theme-change
  [state op]
  (let [id (resolve-token-theme state (:id op))]
    (commit-builder state (pcb/set-token-theme (op-builder state nil) id nil))))

(defn- compile-theme-op
  [state op]
  (case (:op op)
    "create_theme" (create-theme-change state op)
    "update_theme" (update-theme-change state op)
    "delete_theme" (delete-theme-change state op)))

(defn- theme-activation-change
  [state op]
  (let [id      (resolve-token-theme state (:id op))
        builder (op-builder state nil)
        status  (builder-token-status builder)
        lib     (builder-token-lib builder)
        builder (if (= "activate_theme" (:op op))
                  (clt/generate-activate-theme builder status lib id)
                  (clt/generate-deactivate-theme builder status lib id))]
    (commit-builder state builder)))

(defn- toggle-set-change
  [state op]
  (let [id      (resolve-token-set state (:set-id op))
        builder (op-builder state nil)
        builder (clt/generate-toggle-token-set builder
                                               (builder-token-status builder)
                                               (builder-token-lib builder)
                                               id)]
    (commit-builder state builder)))

(defn- tokens-status-change
  [state op]
  (let [theme-ids (into #{} (map #(resolve-token-theme state %)) (:theme-ids op))
        set-ids   (into #{} (map #(resolve-token-set state %)) (:set-ids op))
        status    (ctos/make-tokens-status :active-theme-ids theme-ids
                                           :active-set-ids set-ids)]
    (commit-builder state (pcb/set-tokens-status (op-builder state nil) status))))

(defn- compile-token-status-op
  [state op]
  (case (:op op)
    ("activate_theme" "deactivate_theme") (theme-activation-change state op)
    "toggle_set" (toggle-set-change state op)
    "set_tokens_status" (tokens-status-change state op)))

;; Design tokens: file settings and import

(defn- set-tokens-source-change
  [state op]
  (let [library (when (some? (:library-id op))
                  (let [id (resolve-ref state (:library-id op))]
                    (if (= id (:id (:file-data state)))
                      (file-record state)
                      (get (:libraries state)
                           (resolve-library-id state (:libraries state) id)))))]
    (commit-builder state (clt/generate-set-tokens-source (op-builder state nil) library))))

(defn- base-font-size-change
  [state op]
  (commit-builder state (pcb/set-base-font-size (op-builder state nil) (:value op))))

(defn- parse-tokens-document
  "Parses a DTCG tokens document. The parser signals a malformed document
  with an assertion, which is not an `Exception` on the JVM."
  [json]
  (try
    (ctob/read-multi-set-dtcg json)
    (catch #?(:clj Throwable :cljs :default) cause
      (raise-invalid (str "invalid tokens document: " (ex-message cause))))))

(defn- import-token
  "Writes an imported token into the set. A token with the name of an
  existing token keeps that token's id."
  [builder state set-id existing-tokens token]
  (let [prev (get existing-tokens (ctob/get-name token))
        id   (if (some? prev)
               (ctob/get-id prev)
               ((:new-id-fn state)))]
    (pcb/set-token builder set-id id (ctob/make-token (assoc (into {} token) :id id)))))

(defn- drop-unimported-tokens
  [builder set-id existing-tokens imported-tokens]
  (reduce (fn [builder [token-name token]]
            (if (contains? imported-tokens token-name)
              builder
              (pcb/set-token builder set-id (ctob/get-id token) nil)))
          builder
          existing-tokens))

(defn- import-set
  "Brings an imported set into the file. A set that exists keeps its id and
  its tokens, and only the imported tokens are written."
  [builder state current replace? imported-set imported-tokens]
  (let [name            (ctob/get-name imported-set)
        existing        (some-> current (ctob/get-set-by-name name))
        set-id          (if (some? existing)
                          (ctob/get-id existing)
                          ((:new-id-fn state)))
        existing-tokens (if (some? existing)
                          (ctob/get-tokens current set-id)
                          {})
        builder         (if (some? existing)
                          builder
                          (pcb/set-token-set builder set-id
                                             (ctob/make-token-set
                                              :id set-id
                                              :name name
                                              :description (ctob/get-description imported-set))))
        builder         (reduce (fn [builder token]
                                  (import-token builder state set-id existing-tokens token))
                                builder
                                (vals imported-tokens))]
    (cond-> builder
      replace?
      (drop-unimported-tokens set-id existing-tokens imported-tokens))))

(defn- import-theme
  [builder state current theme]
  (let [group    (:group theme)
        name     (:name theme)
        existing (some-> current (ctob/get-theme-by-name group name))
        id       (if (some? existing)
                   (ctob/get-id existing)
                   ((:new-id-fn state)))
        attrs    (ctob/make-token-theme :id id
                                        :group group
                                        :name name
                                        :description (:description theme)
                                        :sets (:sets theme))]
    (pcb/set-token-theme builder id attrs)))

(defn- document-metadata?
  "True when the DTCG document `json` has a `$metadata` block."
  [json]
  (contains? (json/decode json :key-fn identity) "$metadata"))

(defn- document-active-names
  "The active themes and sets of the imported document `imported`, by name.
  Themes are keyed by group and name. The sets are the `$metadata` active sets
  and the sets of the active themes, as the workspace reads them."
  [imported]
  (let [themes (into []
                     (comp (map #(ctob/get-theme-by-path imported %))
                           (remove nil?)
                           (remove ctob/hidden-theme?))
                     (ctob/get-legacy-active-themes imported))
        hidden (ctob/get-theme imported ctob/hidden-theme-id)]
    {:theme-keys (into #{} (map (juxt :group :name)) themes)
     :set-names  (into (set (:sets hidden))
                       (mapcat :sets)
                       themes)}))

(defn- apply-document-status
  "Sets the active themes and sets of the file to the ones named by `active`,
  looked up by group and name in the file's current library."
  [state {:keys [theme-keys set-names]}]
  (let [lib        (state-token-lib state)
        theme-ids  (into #{}
                         (keep (fn [[group name]]
                                 (some-> (ctob/get-theme-by-name lib group name) ctob/get-id)))
                         theme-keys)
        set-ids    (into #{}
                         (keep #(some-> (ctob/get-set-by-name lib %) ctob/get-id))
                         set-names)
        status     (ctos/make-tokens-status :active-theme-ids theme-ids
                                            :active-set-ids set-ids)]
    (commit-builder state (pcb/set-tokens-status (op-builder state nil) status))))

(defn- move-set-before-change
  "Moves the set `from-name` before the set `to-name`, when both sit in the
  same group. Otherwise the move would rename the set, so nothing is done."
  [state from-name to-name]
  (let [lib        (state-token-lib state)
        tree       (vec (ctob/walk-sets-tree-seq (ctob/get-set-tree lib)))
        from-index (set-tree-index tree (ctob/get-id (ctob/get-set-by-name lib from-name)))
        to-index   (set-tree-index tree (ctob/get-id (ctob/get-set-by-name lib to-name)))]
    (if (= (butlast (:path (nth tree from-index)))
           (butlast (:path (nth tree to-index))))
      (commit-builder state
                      (clt/generate-move-token-set (op-builder state nil)
                                                   lib
                                                   {:from-index from-index
                                                    :to-index to-index
                                                    :position :top}))
      state)))

(defn- order-sets
  "Orders the sets of the file as `set-names` lists them. Working from the
  last pair back, each set moves before the one that follows it."
  [state set-names]
  (reduce (fn [state [from-name to-name]]
            (move-set-before-change state from-name to-name))
          state
          (reverse (partition 2 1 set-names))))

(defn- sync-tokens-status
  "Drops the active ids that the file no longer has, after a replace."
  [state]
  (let [builder (op-builder state nil)]
    (commit-builder state
                    (clt/generate-sync-tokens-status-with-lib builder
                                                              (builder-token-status builder)
                                                              (state-token-lib state)))))

(defn- import-tokens-change
  "Imports a DTCG document. In `:replace` mode the sets and themes missing
  from the document are deleted, and so are the tokens of kept sets that the
  document does not have.

  A document with `$metadata` also sets the active themes and sets, and the
  order of the sets, as the document gives them."
  [state op]
  (let [current    (state-token-lib state)
        imported   (parse-tokens-document (:json op))
        replace?   (= :replace (:mode op))
        set-names  (into #{} (map ctob/get-name) (ctob/get-sets imported))
        theme-keys (into #{} (map (juxt :group :name)) (ctob/get-themes-no-hidden imported))
        builder    (op-builder state nil)
        builder    (if replace?
                     (reduce (fn [builder set]
                               (if (contains? set-names (ctob/get-name set))
                                 builder
                                 (pcb/set-token-set builder (ctob/get-id set) nil)))
                             builder
                             (some-> current ctob/get-sets))
                     builder)
        builder    (reduce (fn [builder imported-set]
                             (import-set builder state current replace? imported-set
                                         (ctob/get-tokens imported (ctob/get-id imported-set))))
                           builder
                           (ctob/get-sets imported))
        builder    (reduce (fn [builder theme]
                             (import-theme builder state current theme))
                           builder
                           (ctob/get-themes-no-hidden imported))
        builder    (if replace?
                     (reduce (fn [builder theme]
                               (if (contains? theme-keys [(:group theme) (:name theme)])
                                 builder
                                 (pcb/set-token-theme builder (ctob/get-id theme) nil)))
                             builder
                             (some-> current ctob/get-themes-no-hidden))
                     builder)
        state      (commit-builder state builder)]
    (if (document-metadata? (:json op))
      (-> state
          (order-sets (map ctob/get-name (ctob/get-sets imported)))
          (apply-document-status (document-active-names imported)))
      (sync-tokens-status state))))

(defn- compile-token-file-op
  [state op]
  (case (:op op)
    "set_tokens_source" (set-tokens-source-change state op)
    "set_base_font_size" (base-font-size-change state op)
    "import_tokens_dtcg" (import-tokens-change state op)))

;; Design tokens: applying to shapes

(defn- state-token-status
  [state]
  (or (cfo/get-tokens-status (:file-data state))
      (ctos/make-tokens-status)))

(defn- token-type-of
  "The type of the token `token-name`. A token of an active set wins over a
  token of the same name in another set."
  [state token-name]
  (let [lib   (state-token-lib state)
        token (when (some? lib)
                (or (get (cfo/get-tokens-in-active-sets (state-token-status state) lib)
                         token-name)
                    (some #(get (ctob/get-tokens lib (ctob/get-id %)) token-name)
                          (ctob/get-sets lib))))]
    (or (:type token)
        (raise-unknown (str "unknown token " token-name)))))

(defn- resolved-number
  "A numeric string is read as a number, so that the number attributes take it."
  [value]
  (if (string? value)
    (or (d/parse-double value) value)
    value))

(defn- apply-token-geometry
  "Commits the size and rotation that the token implies for `ids`. The changes
  go through the modifiers, as `update_shape` does, and the touched state of
  the shapes is kept."
  [state page-id objects ids token-type value attributes]
  (let [modif-tree (into {}
                         (keep (fn [id]
                                 (let [shape    (get objects id)
                                       geometry (tapp/token-geometry-changes shape token-type value attributes)]
                                   (when-let [modifiers (geometry-modifiers shape geometry)]
                                     [id {:modifiers modifiers}]))))
                         ids)]
    (if (seq modif-tree)
      (commit-builder state
                      (lm/generate-apply-modifiers (op-builder state page-id)
                                                   objects
                                                   modif-tree
                                                   {:ignore-touched true}))
      state)))

(defn- parent-ids
  [objects ids]
  (distinct (mapcat #(cfh/get-parent-ids objects %) ids)))

(defn- compile-token-apply-op
  [state op]
  (let [page-id    (resolve-page-id state (:page-id op))
        objects    (page-objects state page-id)
        ids        (resolve-shape-ids state objects (:shape-ids op))
        attributes (mapv keyword (:attributes op))
        token-name (:token-name op)]
    (case (:op op)
      "apply_token"
      (let [token-type (token-type-of state token-name)
            value      (resolved-number (:resolved-value op))
            state      (apply-token-geometry state page-id objects ids token-type value attributes)
            objects    (page-objects state page-id)
            builder    (-> (op-builder state page-id)
                           (cls/generate-update-shapes ids
                                                       #(tapp/apply-token-to-shape %
                                                                                   token-name
                                                                                   token-type
                                                                                   value
                                                                                   attributes
                                                                                   objects)
                                                       objects
                                                       {:ignore-touched true})
                           (pcb/resize-parents (parent-ids objects ids)))]
        (-> state
            (commit-builder builder)
            (mark-reflow page-id (concat ids (map #(:parent-id (get objects %)) ids)))))

      "unapply_token"
      (commit-builder state
                      (pcb/update-shapes (op-builder state page-id)
                                         ids
                                         #(tapp/unapply-token-from-shape % token-name attributes))))))

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
                                                 objects
                                                 modif-tree
                                                 {})]
        (-> state
            (commit-builder builder)
            (mark-reflow page-id (concat ids (map #(:parent-id (get objects %)) ids))))))))

(defn- compile-align-op
  [state op]
  (let [page-id (resolve-page-id state (:page-id op))
        objects (page-objects state page-id)
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

;; Registry and reflow

(def ^:private op-registry
  {"create_page" compile-page-op
   "update_page" compile-page-op
   "delete_page" compile-page-op
   "move_page" compile-page-op
   "create_board" compile-create-op
   "create_rect" compile-create-op
   "create_ellipse" compile-create-op
   "create_text" compile-create-op
   "create_path" compile-create-op
   "create_image" compile-create-op
   "create_svg_raw" compile-create-op
   "create_group" compile-group-op
   "create_boolean" compile-group-op
   "update_shape" compile-update-op
   "move_shapes" compile-structure-op
   "reorder" compile-structure-op
   "delete_shapes" compile-structure-op
   "clone_shape" compile-structure-op
   "ungroup" compile-structure-op
   "flatten" compile-structure-op
   "make_mask" compile-structure-op
   "remove_mask" compile-structure-op
   "set_flex_layout" compile-layout-op
   "set_grid_layout" compile-layout-op
   "remove_layout" compile-layout-op
   "set_layout_child" compile-layout-op
   "set_grid_cell" compile-layout-op
   "set_text" compile-text-op
   "set_text_style" compile-text-op
   "create_component" compile-component-op
   "instantiate_component" compile-component-op
   "detach" compile-component-op
   "swap_component" compile-component-op
   "reset_overrides" compile-component-op
   "update_main" compile-component-op
   "rename_component" compile-component-library-op
   "delete_component" compile-component-library-op
   "restore_component" compile-component-library-op
   "sync_components" compile-component-library-op
   "create_color" compile-color-op
   "update_color" compile-color-op
   "delete_color" compile-color-op
   "create_typography" compile-typography-op
   "update_typography" compile-typography-op
   "delete_typography" compile-typography-op
   "set_plugin_data" compile-plugin-data-op
   "add_interaction" compile-interaction-op
   "remove_interaction" compile-interaction-op
   "create_flow" compile-flow-op
   "remove_flow" compile-flow-op
   "add_ruler_guide" compile-guide-op
   "remove_ruler_guide" compile-guide-op
   "set_board_grid_guides" compile-guide-op
   "apply_typography" apply-typography-change
   "create_token_set" compile-token-set-op
   "update_token_set" compile-token-set-op
   "delete_token_set" compile-token-set-op
   "move_token_set" compile-token-set-op
   "create_token" compile-token-op
   "update_token" compile-token-op
   "delete_token" compile-token-op
   "create_theme" compile-theme-op
   "update_theme" compile-theme-op
   "delete_theme" compile-theme-op
   "activate_theme" compile-token-status-op
   "deactivate_theme" compile-token-status-op
   "toggle_set" compile-token-status-op
   "set_tokens_status" compile-token-status-op
   "set_tokens_source" compile-token-file-op
   "set_base_font_size" compile-token-file-op
   "import_tokens_dtcg" compile-token-file-op
   "apply_token" compile-token-apply-op
   "unapply_token" compile-token-apply-op
   "align" compile-align-op
   "distribute" compile-align-op})

(defn- reflow-pending-ids
  "The ids of `ids` that the reflow can change. A rect or ellipse at the root
  with no children has no layout and no parent to reflow with, so the reflow
  leaves it as it is, and it is left out. This keeps one builder from holding
  every reflowed shape, since each builder step checks all its changes."
  [objects ids]
  (remove (fn [id]
            (let [shape (get objects id)]
              (and (some? shape)
                   (= uuid/zero (:parent-id shape))
                   (contains? #{:rect :circle} (:type shape))
                   (empty? (:shapes shape)))))
          ids))

(defn- reflow-pages
  "Runs the layout reflow once for every page that has touched layout ids."
  [state]
  (reduce (fn [state [page-id ids]]
            (let [objects (page-objects state page-id)
                  pending (when (some? objects)
                            (reflow-pending-ids objects ids))]
              (if (seq pending)
                (let [builder (op-builder state page-id)
                      builder (lm/generate-reflow builder objects pending {})]
                  (commit-builder state builder))
                state)))
          state
          (:reflow state)))

(defn- raise-compile-error
  "Raises `cause`, an error met while compiling the op at `index` (`nil` for
  the reflow after all ops), as a validation error. An unknown id keeps its
  code. Any other cause becomes an invalid operation, and `:cause-code` keeps
  the code of the original error when it has one."
  [index op-name cause]
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
              :cause cause)))

(def ^:private xf:changed-shape-keys
  "The distinct `[page-id id]` pairs of the add-obj and mod-obj changes, in
  the order of their first change."
  (comp (filter #(contains? #{:add-obj :mod-obj} (:type %)))
        (map (juxt :page-id :id))
        (distinct)))

(defn- check-changed-shapes
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

(defn- compile-op
  [state index op]
  (let [family (get op-registry (:op op))]
    (when-not family
      (ex/raise :type :validation
                :code :mcp-invalid-operation
                :hint (str "operation not implemented: " (:op op))
                :index index
                :op (:op op)))
    (try
      (let [changes-before (count (:changes state))
            state          (family state (decode-op-values op))
            state          (check-changed-shapes state (subvec (:changes state) changes-before))]
        (update state :op-ranges conj [changes-before (count (:changes state))]))
      (catch #?(:clj Throwable :cljs :default) cause
        (raise-compile-error index (:op op) cause)))))

(defn compile-operations
  "Compiles `operations` against `file-data` and returns the changes they
  emit.

  `file-data` is the `:data` map of a file. `operations` is a vector of op
  maps. JSON-style enum strings are decoded, and the vector is checked
  against the operation schema before any op runs. `opts` may hold
  `:new-id-fn` (default `uuid/next`) and `:libraries`, a map from library
  id to library file data.

  Returns a map with `:changes` (every emitted change in order, each with
  its page id), `:op-ranges` (one `[start end]` pair per op, in op order:
  the indexes in `:changes` of the first change the op emitted and one past
  its last, so `start` equals `end` for an op that emits nothing; the
  changes of the layout reflow come after the last range), `:created-ids`
  (each `$tmp:` handle to its uuid), `:warnings` (maps with `:code` and
  `:id`), `:touched-page-ids` (the page ids of the changes) and `:summary`
  (`:op-count`, `:change-count` and `:change-types`, a map from change type
  to count). Invalid operations raise a validation error with the code
  `:mcp-invalid-operation` or `:mcp-unknown-id`, with the `:index` and `:op`
  of the failing operation.
  An error in the layout reflow after all ops has `:index` nil and `:op`
  \"reflow\"."
  [file-data operations opts]
  (let [operations (check-operations (decode-operations operations))
        state (reduce-kv (fn [state index op]
                           (compile-op state index op))
                         (initial-state file-data opts)
                         operations)
        state (try
                (reflow-pages state)
                (catch #?(:clj Throwable :cljs :default) cause
                  (raise-compile-error nil "reflow" cause)))
        changes (:changes state)]
    {:changes changes
     :op-ranges (:op-ranges state)
     :created-ids (:created-ids state)
     :warnings (:warnings state)
     :touched-page-ids (into #{} (keep :page-id) changes)
     :summary {:op-count (count operations)
               :change-count (count changes)
               :change-types (frequencies (map :type changes))}}))
