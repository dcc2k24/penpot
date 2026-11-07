(ns ^{:no-doc true} app.common.mcp.operations.text
  "This namespace is internal: `app.common.mcp.operations` is the
  only API.

  The text ops, and the font variants of a text or a typography."
  (:require
   [app.common.data :as d]
   [app.common.fonts.builtin :as builtin]
   [app.common.logic.modifiers :as lm]
   [app.common.logic.shapes :as cls]
   [app.common.mcp.operations.refs :refer [resolve-page-id resolve-shape-id]]
   [app.common.mcp.operations.schema :refer [g-id g-page g-text-attrs op-schema]]
   [app.common.mcp.operations.state :refer [approximate-text-size auto-grow? commit-builder default-font-size default-text-fills geometry-modifiers get-page-objects mark-reflow modifier-objects numeric-text-attrs op-builder parse-font-size raise-invalid wrapped-height]]
   [app.common.types.shape :as cts]
   [app.common.types.text :as txt]
   [clojure.string :as str]))

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

(defn- number-str
  "The text of a number that a text attr stores. A whole number has no
  decimal point, so `16.0` gives \"16\" on the JVM as on ClojureScript."
  [value]
  (cond
    (nil? value)    nil
    (number? value) (if (== value (long value))
                      (str (long value))
                      (str value))
    :else           (str value)))

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

(defn font-variant-attrs
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
      (assoc :font-size (number-str (:font-size op)))

      (some? (:font-family op))
      (assoc :font-family (:font-family op))

      (some? (:font-id op))
      (assoc :font-id (:font-id op))

      (some? (:font-variant-id op))
      (assoc :font-variant-id (:font-variant-id op))

      (some? (:font-weight op))
      (assoc :font-weight (weight-str (:font-weight op)))

      (some? (:font-style op))
      (assoc :font-style (:font-style op)))))

(defn text-spec
  "Attrs and size of a text created by `op`. A missing size is approximated
  and reported when the grow type is automatic."
  [op]
  (let [characters (:characters op)
        font-size  (or (parse-font-size (:font-size op)) default-font-size)
        grow-type  (:grow-type op)
        approx     (approximate-text-size characters font-size)
        width      (or (:width op) (:width approx))
        content    (-> (cts/setup-shape {:type :text})
                       :content
                       (txt/change-text characters (text-create-styles op)))
        base-name  (let [s (txt/generate-shape-name characters)]
                     (if (str/blank? s) "Text" s))]
    {:type :text
     :attrs (cond-> {:content content}
              (some? grow-type)
              (assoc :grow-type grow-type))
     :width width
     :height (or (:height op)
                 (if (= :auto-height grow-type)
                   (wrapped-height characters font-size width nil)
                   (:height approx)))
     :base-name base-name
     :approximate (and (auto-grow? grow-type)
                       (or (nil? (:width op)) (nil? (:height op))))}))

;; Text
(defn- content-font-size
  [content]
  (or (some-> (txt/node-seq txt/is-text-node? content)
              first
              :font-size
              parse-font-size)
      default-font-size))

(defn- content-line-height
  "The line height of the first text node of `content`, as a factor of the
  font size, or nil when it has none."
  [content]
  (some-> (txt/node-seq txt/is-text-node? content)
          first
          :line-height
          parse-font-size))

(def text-content-attrs
  "The attrs that `set-text-content` changes. The change must name them, since
  an update with attrs emits only those."
  #{:content :position-data})

(defn set-text-content
  "Sets `content` on `shape` and drops its position data, which the new
  content makes stale."
  [shape content]
  (-> shape
      (assoc :content content)
      (dissoc :position-data)))

(defn refit-text
  "Resizes the text `id` of `page-id` to the approximate size of its content,
  for the automatic grow types. The size goes through the modifiers."
  [state page-id id]
  (let [objects    (get-page-objects state page-id)
        shape      (get objects id)
        content    (:content shape)
        characters (txt/content->text content)
        font-size  (content-font-size content)
        geometry   (case (:grow-type shape)
                     :auto-width (select-keys (approximate-text-size characters font-size)
                                              [:width :height])
                     :auto-height {:height (wrapped-height characters font-size
                                                           (:width shape)
                                                           (content-line-height content))}
                     {})
        modifiers  (geometry-modifiers shape geometry)]
    (if (some? modifiers)
      (commit-builder state
                      (lm/generate-apply-modifiers (op-builder state page-id)
                                                   (modifier-objects objects id)
                                                   {id {:modifiers modifiers}}
                                                   {:ignore-touched true}))
      state)))

(defn- normalize-text-attrs
  [attrs]
  (reduce-kv (fn [acc k v]
               (assoc acc k (if (and (number? v) (contains? numeric-text-attrs k))
                              (number-str v)
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

(defn apply-text-attrs
  "Puts each group of `groups`, as made by `split-text-attrs`, on the nodes
  that hold it."
  [content groups]
  (-> content
      (merge-text-nodes txt/is-root-node? (:root groups))
      (merge-text-nodes txt/is-paragraph-node? (:paragraph groups))
      (merge-text-nodes txt/is-text-node? (:leaf groups))))

(defn compile-text-op
  [state op]
  (let [page-id (resolve-page-id state (:page-id op))
        objects (get-page-objects state page-id)
        id      (resolve-shape-id state objects (:id op))
        shape   (get objects id)]
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
          builder (cls/generate-update-shapes (op-builder state page-id)
                                              [id]
                                              #(set-text-content % content)
                                              objects
                                              {:attrs text-content-attrs})]
      (-> state
          (commit-builder builder)
          (refit-text page-id id)
          (mark-reflow page-id [id (:parent-id shape)])
          (cond-> (auto-grow? (:grow-type shape))
            (update :warnings conj {:code :text-size-approximate :id id}))))))

(def ops
  "The ops of the text family. Each op name maps to its schema and its
  compile function."
  {"set_text" {:schema (op-schema "set_text" g-page g-id
                                  [[:characters :string]])
               :compile compile-text-op}
   "set_text_style" {:schema (op-schema "set_text_style" g-page g-id
                                        [[:attrs (into [:map] g-text-attrs)]])
                     :compile compile-text-op}})
