;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.common.logic.token-application
  "Mapping from resolved design token values to shape data.

  Ports the token-to-shape mapping of the frontend
  (`app.main.data.workspace.tokens.application`), so that backend
  operations can apply tokens. Shape functions take a shape and return
  a shape. The namespace keeps no state of its own: the ids of new
  shadows come from the id function the caller passes. Geometry (size
  and rotation) is returned as a change map for the caller to apply
  through the geometry modifiers."
  (:require
   [app.common.colors :as clr]
   [app.common.data :as d]
   [app.common.types.fills :as ctf]
   [app.common.types.shape.layout :as ctsl]
   [app.common.types.shape.radius :as ctsr]
   [app.common.types.stroke :as cts]
   [app.common.types.text :as txt]
   [app.common.types.token :as ctt]
   [app.common.types.typography :as cty]
   [clojure.set :as set]
   [clojure.string :as str]))

;; Constants --------------------------------------------------------------------

(def ^:private hex-digits "0123456789abcdef")

(def ^:private hex-re
  #"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")

(def ^:private rgb-re
  #"[rR][gG][bB][aA]?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)")

(def ^:private padding-keys #{:p1 :p2 :p3 :p4})

(def ^:private text-attr-keys
  "Token attributes that are written to text leaf and paragraph nodes."
  #{:font-size :letter-spacing :line-height :text-case :text-decoration})

(def ^:private typography-text-keys
  "Typography token value keys that map to text node attributes.
  Font family and font weight are left out: they need the font catalog,
  which only the frontend has."
  [:font-size :letter-spacing :line-height :text-case :text-decoration])

(def ^:private token-type->attributes
  "Token attributes each token type may apply to. Mirrors the frontend
  token properties (`all-attributes` when present, else `attributes`)."
  {:border-radius   ctt/border-radius-keys
   :shadow          ctt/shadow-keys
   :color           ctt/color-keys
   :font-size       ctt/font-size-keys
   :letter-spacing  ctt/letter-spacing-keys
   :text-case       ctt/text-case-keys
   :text-decoration ctt/text-decoration-keys
   :typography      ctt/typography-token-keys
   :stroke-width    ctt/stroke-width-keys
   :sizing          ctt/sizing-keys
   :dimensions      (set/union ctt/spacing-keys
                               ctt/sizing-keys
                               ctt/border-radius-keys
                               ctt/axis-keys
                               ctt/stroke-width-keys)
   :opacity         ctt/opacity-keys
   :number          ctt/number-keys
   :rotation        ctt/rotation-keys
   :spacing         ctt/spacing-keys})

;; Numbers and colours ----------------------------------------------------------

(defn- ->number
  "Returns `n` as a long or a double, so that ratios never reach the data."
  [n]
  (if (integer? n) n (double n)))

(defn- byte->hex
  "Two lowercase hex digits for an integer in 0..255."
  [n]
  (str (nth hex-digits (quot n 16)) (nth hex-digits (rem n 16))))

(defn- hex-digit-value
  "Numeric value of one hex digit character."
  [ch]
  (str/index-of hex-digits (str/lower-case (str ch))))

(defn- hex-pair->int
  "Integer value of a two-digit hex string."
  [pair]
  (+ (* 16 (hex-digit-value (nth pair 0)))
     (hex-digit-value (nth pair 1))))

(defn- expand-short-hex
  "Doubles each digit of a 3 or 4 digit hex string, e.g. \"abc\" -> \"aabbcc\"."
  [digits]
  (if (<= (count digits) 4)
    (apply str (mapcat (fn [ch] [ch ch]) digits))
    digits))

(defn- hex->color
  "Converts the digits of a `#` colour (3, 4, 6 or 8 digits) to a colour map."
  [digits]
  (let [full  (expand-short-hex digits)
        rgb   (map #(hex-pair->int (subs full % (+ % 2))) [0 2 4])
        alpha (if (= 8 (count full))
                (/ (hex-pair->int (subs full 6 8)) 255.0)
                1)]
    {:color (str "#" (apply str (map byte->hex rgb)))
     :opacity (->number alpha)}))

(defn- parse-alpha
  "Parses the alpha component of an rgba() colour."
  [s]
  #?(:clj (Double/parseDouble s)
     :cljs (js/parseFloat s)))

(defn- rgb->color
  "Converts the match of `rgb-re` to a colour map, or nil when a channel is out of range."
  [[_ r g b a]]
  (let [channels [(parse-long r) (parse-long g) (parse-long b)]]
    (when (every? #(<= 0 % 255) channels)
      {:color (str "#" (apply str (map byte->hex channels)))
       :opacity (if a
                  (->number (-> (parse-alpha a) (min 1.0) (max 0.0)))
                  1)})))

(defn parse-color
  "Parses a CSS colour string into `{:color \"#rrggbb\" :opacity n}`: a hex
  colour, an rgb() or rgba() colour, or a colour name that `app.common.colors`
  knows. Returns nil for any other value, such as hsl(), so the caller can
  report that the token did not apply."
  [value]
  (when (string? value)
    (let [s (str/trim value)]
      (if-let [[_ digits] (re-matches hex-re s)]
        (hex->color digits)
        (or (some-> (re-matches rgb-re s) rgb->color)
            (when-let [hex (clr/parse s)]
              {:color hex :opacity 1}))))))

(defn- color->fill
  "Fill map for a colour map, as the frontend builds it."
  [{:keys [color opacity]}]
  {:fill-color color
   :fill-opacity opacity})

;; Text nodes -------------------------------------------------------------------

(defn- map-text-nodes
  "Returns `shape` with `f` applied to each text leaf and paragraph node."
  [shape f]
  (if (some? (:content shape))
    (txt/update-text-content shape
                             (some-fn txt/is-text-node? txt/is-paragraph-node?)
                             (fn [node _] (f node))
                             nil)
    shape))

(defn- text-node-attr
  "Returns the text node entry `[key value]` for token attribute `attr`
  with `value`, or nil when the value does not fit the attribute."
  [attr value]
  (case attr
    :font-size       (when (number? value) [:font-size (str value)])
    :letter-spacing  (when (number? value) [:letter-spacing (str value)])
    :line-height     (when (number? value) [:line-height (->number value)])
    :text-case       (when (string? value) [:text-transform value])
    :text-decoration (when-let [css (and (string? value)
                                         (ctt/valid-text-decoration value))]
                       [:text-decoration (if (= css "strike-through")
                                           "line-through"
                                           css)])
    nil))

(defn- typography->text-attrs
  "Text node attributes for the parts of a typography token value."
  [value]
  (into {}
        (keep (fn [attr] (text-node-attr attr (get value attr))))
        typography-text-keys))

(defn- apply-text-attrs
  "Merges `node-attrs` into the text nodes of `shape` and drops typography refs."
  [shape node-attrs]
  (if (seq node-attrs)
    (map-text-nodes shape #(-> % (d/txt-merge node-attrs) cty/remove-typography-from-node))
    shape))

;; Attribute appliers -----------------------------------------------------------

(defn- text-shape?
  [shape]
  (= :text (:type shape)))

(defn- applicable-attrs
  "Returns the subset of `attributes` that `shape` can take. Margins also
  count for a shape that is an immediate child of a layout."
  [shape attributes objects]
  (let [attrs   (set attributes)
        shape-type (:type shape)
        layout? (ctsl/any-layout? shape)
        margins (if (ctsl/any-layout-immediate-child? objects shape)
                  (set/intersection attrs ctt/spacing-margin-keys)
                  #{})]
    (if (ctt/any-appliable-attr-for-shape? attrs shape-type layout?)
      (set/union (ctt/appliable-attrs-for-shape attrs shape-type layout?) margins)
      margins)))

(defn- token-type-appliable?
  "True when every attribute in `attributes` may be set by `token-type`."
  [token-type attributes]
  (set/subset? (set attributes) (get token-type->attributes token-type #{})))

(defn- apply-radius
  "Sets the corner radii in `attrs` to `value`, clamped at zero."
  [shape attrs value]
  (ctsr/set-radius-for-corners shape attrs (->number (max 0 value))))

(defn- apply-fill
  "Sets the first fill to `color`. On a text shape the fill goes to the text nodes."
  [shape color]
  (let [fill (color->fill color)]
    (if (text-shape? shape)
      (map-text-nodes shape #(update % :fills ctf/assoc 0 fill))
      (update shape :fills ctf/assoc 0 fill))))

(defn- apply-stroke-color
  "Sets the colour of the first stroke, creating a default stroke if needed."
  [shape {:keys [color opacity]}]
  (let [strokes (:strokes shape)
        stroke  (-> (or (first strokes) cts/default-stroke)
                    (assoc :stroke-color color
                           :stroke-opacity opacity))]
    (assoc shape :strokes (into [stroke] (rest strokes)))))

(defn- apply-stroke-width
  "Sets the widths of the sides in `side-keys` on the first stroke.
  Sides not in `side-keys` keep their width. `:stroke-width` follows the top side."
  [shape side-keys value]
  (let [strokes (:strokes shape)
        stroke  (cts/materialize-stroke-side-widths (first strokes) side-keys value)]
    (assoc shape :strokes (into [stroke] (rest strokes)))))

(defn- value->shadow
  "Converts a shadow token value (a sequence of shadow maps) to shape shadows.
  `new-id-fn` makes the id of each shadow."
  [new-id-fn shadows]
  (mapv (fn [{:keys [offset-x offset-y blur spread color inset]}]
          {:id (new-id-fn)
           :hidden false
           :offset-x offset-x
           :offset-y offset-y
           :blur (cond-> blur (number? blur) (max 0))
           :color (parse-color color)
           :spread spread
           :style (if (true? inset) :inner-shadow :drop-shadow)})
        shadows))

(defn- apply-limits
  "Sets every layout item size limit in `limits` to `value`, clamped at zero."
  [shape limits value]
  (reduce (fn [s k] (assoc s k (->number (max 0 value))))
          shape
          limits))

(defn- text-step
  "Applies a text token value to `shape`, where `written` holds the attrs
  written so far. Returns `[shape written]`. A typography value writes the
  text attrs of its parts, and then all its token attrs count as written. A
  single attr counts only when its value fits it."
  [[shape written] attrs value]
  (if (and (contains? attrs :typography) (map? value))
    (let [node-attrs (typography->text-attrs value)]
      (if (seq node-attrs)
        [(apply-text-attrs shape node-attrs) (into written attrs)]
        [shape written]))
    (let [single (set/intersection attrs text-attr-keys)
          fits   (filterv #(some? (text-node-attr % value)) single)]
      (if (seq fits)
        [(apply-text-attrs shape (into {} (keep #(text-node-attr % value)) fits))
         (into written fits)]
        [shape written]))))

(defn- write-step
  "Runs `f` on the shape of `[shape written]` when `ok?` holds, and adds
  `attr-set` to `written`. Returns the pair."
  [[shape written] ok? attr-set f]
  (if ok?
    [(f shape) (into written attr-set)]
    [shape written]))

(defn- apply-values
  "Writes `value` into the shape attributes in `attrs`, one group at a time.
  Returns `[shape written]`, where `written` is the set of the attrs that were
  written. An attr whose value does not fit it is not written. Geometry (size
  and rotation) is not written here; see `token-geometry-changes`."
  [shape value attrs objects new-id-fn]
  (let [layout?       (ctsl/any-layout? shape)
        layout-child? (ctsl/any-layout-immediate-child? objects shape)
        radius        (set/intersection attrs ctt/border-radius-keys)
        padding       (set/intersection attrs padding-keys)
        gaps          (set/intersection attrs ctt/spacing-gap-keys)
        margins       (set/intersection attrs ctt/spacing-margin-keys)
        limits        (set/intersection attrs ctt/sizing-layout-item-keys)
        strokes       (set/intersection attrs ctt/stroke-width-keys)
        color         (parse-color value)]
    (-> [shape #{}]
        (write-step (and (seq radius) (number? value))
                    radius
                    #(apply-radius % radius value))

        (write-step (and (contains? attrs :fill) color)
                    #{:fill}
                    #(apply-fill % color))

        (write-step (and (contains? attrs :stroke-color) color)
                    #{:stroke-color}
                    #(apply-stroke-color % color))

        (write-step (and (seq strokes) (number? value))
                    strokes
                    #(apply-stroke-width % strokes (->number (max 0 value))))

        (write-step (and (contains? attrs :shadow) (sequential? value))
                    #{:shadow}
                    #(assoc % :shadow (value->shadow new-id-fn value)))

        (write-step (and (contains? attrs :opacity) (number? value) (<= 0 value 1))
                    #{:opacity}
                    #(assoc % :opacity (->number value)))

        (write-step (and (seq padding) (number? value) layout?)
                    padding
                    #(update % :layout-padding merge (zipmap padding (repeat (->number (max 0 value))))))

        (write-step (and (seq gaps) (number? value) layout?)
                    gaps
                    #(update % :layout-gap merge (zipmap gaps (repeat (->number (max 0 value))))))

        (write-step (and (seq margins) (number? value) layout-child?)
                    margins
                    #(update % :layout-item-margin merge (zipmap margins (repeat (->number value)))))

        (write-step (and (seq limits) (number? value))
                    limits
                    #(apply-limits % limits value))

        (text-step attrs value))))

;; Public API -------------------------------------------------------------------

(defn apply-token-to-shape
  "Returns `[shape written]`: `shape` with the token `token-name` applied, and
  the set of the attributes that were written.

  `token-type` is the frontend token type keyword (e.g. `:spacing`,
  `:sizing`, `:border-radius`, `:color`, `:typography`). `resolved-value`
  is the resolved token value. `attributes` is the token attribute set
  (e.g. `#{:p1 :p2}`). `objects` is the page object map, used to check
  layout parents and children. `new-id-fn` makes the ids of new shadows.

  Only the attributes that the shape can take and whose value fits are
  written. Each written one is recorded in `:applied-tokens` as
  `attribute -> token-name`; an attribute that was not written is not
  recorded. Geometry is not changed here. When nothing is written, the
  shape comes back as it was and `written` is empty, so the caller can
  report that the token did not apply.

  Does not set `:ignore-touched`: the frontend passes that as an option
  to the update, so the caller must do it."
  [shape token-name token-type resolved-value attributes objects new-id-fn]
  (let [attrs (applicable-attrs shape attributes objects)]
    (if (and (seq attrs) (token-type-appliable? token-type attributes))
      (let [[shape written] (apply-values shape resolved-value attrs objects new-id-fn)]
        (if (seq written)
          [(update shape :applied-tokens merge (zipmap written (repeat token-name)))
           written]
          [shape #{}]))
      [shape #{}])))

(defn token-geometry-changes
  "Returns a map with any of `:width`, `:height`, `:rotation` that a
  sizing, dimensions or rotation token implies for `shape`. Returns `{}`
  when there is nothing to change. The caller applies the result through
  the geometry modifiers. Nothing is applied here."
  [shape token-type resolved-value attributes]
  (let [attrs (applicable-attrs shape attributes nil)]
    (if (and (number? resolved-value)
             (token-type-appliable? token-type attributes))
      (let [value (->number resolved-value)]
        (cond-> {}
          (contains? attrs :width)    (assoc :width value)
          (contains? attrs :height)   (assoc :height value)
          (contains? attrs :rotation) (assoc :rotation value)))
      {})))

(defn unapply-token-from-shape
  "Returns `shape` without the `:applied-tokens` entries that point to
  `token-name` for the given `attributes`. Other entries and the
  attribute values themselves are left as they are."
  [shape token-name attributes]
  (let [attr? (set attributes)]
    (cond-> shape
      (:applied-tokens shape)
      (update :applied-tokens
              (fn [applied]
                (into {}
                      (remove (fn [[k v]] (and (attr? k) (= v token-name))))
                      applied))))))
