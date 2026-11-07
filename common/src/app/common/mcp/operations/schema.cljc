(ns ^{:no-doc true} app.common.mcp.operations.schema
  "This namespace is internal: `app.common.mcp.operations` is the
  only API.

  The schemas of the MCP operations: the groups of params that the op
  schemas share, the schema of `props`, and the decoding of the JSON-style
  values. The op schemas themselves are in the families."
  (:require
   [app.common.mcp.operations.state :refer [raise-invalid]]
   [app.common.schema :as sm]
   [app.common.types.color :as ctc]
   [app.common.types.fills :as ctfl]
   [app.common.types.grid :as ctg]
   [app.common.types.shape :as cts]
   [app.common.types.shape.interactions :as ctsi]
   [app.common.types.shape.layout :as ctl]
   [app.common.types.typography :as cty]
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

(defn op-schema
  "Builds the map schema of one operation. `groups` are vectors of
  entries, so each group can be shared between operations."
  [op-name & groups]
  (into [:map {:title op-name} [:op [:= op-name]]] cat groups))

(def g-page
  [[:page-id schema:ref]])

(def g-id
  [[:id schema:ref]])

(def g-opt-id
  [[:id {:optional true} schema:ref]])

(def g-ids
  [[:ids [:vector {:min 1} schema:ref]]])

(def g-shape
  [[:id {:optional true} schema:ref]
   [:parent-id {:optional true} schema:ref]
   [:index {:optional true} [:int {:min 0}]]
   [:name {:optional true} :string]
   [:props {:optional true} [:map]]])

(def g-box
  [[:x ::sm/safe-number]
   [:y ::sm/safe-number]
   [:width ::sm/non-negative-safe-number]
   [:height ::sm/non-negative-safe-number]])

(def g-font
  [[:font-size {:optional true} [:or :string ::sm/safe-number]]
   [:font-family {:optional true} :string]
   [:font-id {:optional true} :string]
   [:font-variant-id {:optional true} :string]
   [:font-weight {:optional true} [:or :string ::sm/safe-number]]
   [:font-style {:optional true} :string]
   [:fills {:optional true} [:vector [:map]]]])

(def g-text-box
  [[:width {:optional true} ::sm/non-negative-safe-number]
   [:height {:optional true} ::sm/non-negative-safe-number]])

(def ^:private g-gap
  [:map
   [:row-gap {:optional true} ::sm/non-negative-safe-number]
   [:column-gap {:optional true} ::sm/non-negative-safe-number]])

(def ^:private g-padding
  "The padding sides. A side that is not given keeps its current value."
  [:map
   [:p1 {:optional true} ::sm/non-negative-safe-number]
   [:p2 {:optional true} ::sm/non-negative-safe-number]
   [:p3 {:optional true} ::sm/non-negative-safe-number]
   [:p4 {:optional true} ::sm/non-negative-safe-number]])

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

(def g-flex
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

(def g-grid
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

(def g-child
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

(def g-text-attrs
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

(def g-bool-type
  [[:bool-type [::sm/one-of #{:union :difference :intersection :exclude}]]])

(def g-overrides
  [[:overrides {:optional true}
    [:vector {:max 500}
     [:map
      [:name {:optional true} :string]
      [:path {:optional true} :string]
      [:characters {:optional true} :string]
      [:props {:optional true} [:map]]]]]])

(def json-transformer
  (sm/json-transformer))

;; Map params: decoded and checked per op, so a failure names the op
(def ^:private structural-prop-hints
  "The keys of a shape that `props` cannot set, each with the op that sets it.
  The ids and links belong to their ops, the geometry to `update_shape`, and
  the layout, mask, text and component state to the ops named here."
  {:id "the op that creates the shape"
   :type "the op that creates the shape"
   :parent-id "move_shapes"
   :frame-id "move_shapes"
   :shapes "move_shapes or reorder"
   :component-id "instantiate_component or swap_component"
   :component-file "instantiate_component or swap_component"
   :component-root "create_component or detach"
   :main-instance "create_component"
   :shape-ref "instantiate_component or detach"
   :applied-tokens "apply_token or unapply_token"
   :position-data "set_text or set_text_style"
   :selrect "update_shape"
   :points "update_shape"
   :transform "update_shape"
   :transform-inverse "update_shape"
   :layout "set_flex_layout or set_grid_layout"
   :layout-gap "set_flex_layout"
   :layout-gap-type "set_flex_layout"
   :layout-gap-col "set_flex_layout"
   :layout-gap-row "set_flex_layout"
   :layout-padding "set_flex_layout or set_grid_layout"
   :layout-padding-type "set_flex_layout or set_grid_layout"
   :layout-item-absolute "set_layout_child"
   :layout-item-align-self "set_layout_child"
   :layout-item-data "set_layout_child"
   :layout-item-h-sizing "set_layout_child"
   :layout-item-v-sizing "set_layout_child"
   :layout-item-margin "set_layout_child"
   :layout-item-margin-type "set_layout_child"
   :layout-item-max-h "set_layout_child"
   :layout-item-max-w "set_layout_child"
   :layout-item-min-h "set_layout_child"
   :layout-item-min-w "set_layout_child"
   :layout-item-z-index "set_layout_child"
   :layout-grid-cells "set_grid_cell"
   :layout-grid-rows "set_grid_layout"
   :layout-grid-columns "set_grid_layout"
   :touched "reset_overrides or update_main"
   :remote-synced "sync_components"
   :masked-group "make_mask or remove_mask"
   :interactions "add_interaction or remove_interaction"
   :plugin-data "set_plugin_data"
   :content "set_text, set_text_style or create_svg_raw"
   :bool-type "create_boolean"
   :metadata "create_image"
   :variant-id "the component ops"
   :variant-name "the component ops"
   :variant-error "the component ops"
   :is-variant-container "the component ops"})

(def ^:private structural-prop-keys
  (set (keys structural-prop-hints)))

(defn- branch-entries
  "The map entries `[k props schema]` of one branch of `cts/schema:shape-attrs`,
  less the structural keys."
  [branch]
  (into []
        (comp (mapcat sm/children)
              (remove (fn [[k]] (contains? structural-prop-keys k))))
        (sm/children branch)))

(defn- entries->map-schema
  "A closed map schema of `entries`. An attr that several types declare accepts
  any of their schemas."
  [entries]
  (let [by-key (reduce (fn [acc [k _ schema]]
                         (update acc k (fnil conj []) schema))
                       {}
                       entries)]
    (into [:map {:closed true}]
          (map (fn [[k schemas]]
                 (let [schemas (vec (distinct schemas))]
                   [k {:optional true}
                    (if (= 1 (count schemas))
                      (first schemas)
                      (into [:or] schemas))])))
          by-key)))

(def ^:private shape-branches
  "The `[type props schema]` branches of `cts/schema:shape-attrs`, one per
  shape type."
  (sm/children (sm/schema cts/schema:shape-attrs)))

(def ^:private type-props-schemas
  "The closed schema of the attrs that `props` may set on a shape of each
  type. It is the schema of the shape's own branch, so an attr of one type
  is refused on another."
  (into {}
        (map (fn [[type _ branch]]
               [type (sm/schema (entries->map-schema (branch-entries branch)))]))
        shape-branches))

(def ^:private type-props-validators
  "The validator of `type-props-schemas`, built once, since every update
  checks its props."
  (into {}
        (map (fn [[type schema]] [type (sm/validator schema)]))
        type-props-schemas))

(def ^:private schema:props
  "The closed schema of the attrs that `props` may set on any shape. It
  decodes the values, and each type's schema then checks them."
  (sm/schema (entries->map-schema (mapcat (fn [[_ _ branch]]
                                            (branch-entries branch))
                                          shape-branches))))

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

(def schema:library-color
  (sm/schema ctc/schema:library-color))

(def schema:typography
  (sm/schema cty/schema:typography))

(defn decode-checked
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
  is refused first, and the hint names the op that sets it."
  [props]
  (when-let [k (some structural-prop-keys (keys props))]
    (raise-invalid (str "props cannot set the structural key " k
                        "; use " (get structural-prop-hints k) " instead")))
  (or (decode-known-props props)
      (decode-checked "props" schema:props props)))

(defn props-keys-of-type
  "The keys that `props` may set on a shape of `type`."
  [type]
  (set (map first (sm/children (get type-props-schemas type)))))

(defn check-props-for-type
  "Checks the decoded `props` against the schema of the shape type `type`, so
  an attr of one type is refused on another. The explanation goes in the hint."
  [type props]
  (let [schema   (get type-props-schemas type)
        validate (get type-props-validators type)]
    (when (and (some? props) (not (validate props)))
      (raise-invalid (str "props do not fit a " (name type) " shape: "
                          (pr-str (sm/simplify (sm/explain schema props))))))))

(defn decode-op-values
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
