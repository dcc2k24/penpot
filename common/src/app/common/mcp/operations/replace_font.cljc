(ns ^{:no-doc true} app.common.mcp.operations.replace-font
  "This namespace is internal: `app.common.mcp.operations` is the
  only API.

  The `replace_font` op: swaps one font for another on the texts of a page,
  in one pass. It writes the five font fields of the nodes that use the source
  font, with the variant ids that the workspace writes for the target font, and
  drops the layout data (`position-data`) of the texts it changes. It leaves
  alone, and reports, the texts of component copies, the texts linked to a
  typography and the texts with a font token applied.

  The face (weight and style) of a node follows the wasm renderer. A run's
  weight is its own `font-weight`, else the `font-weight` of its paragraph
  (`write-spans` in `render_wasm/text_content.cljs` reads
  `(get span :font-weight paragraph-font-weight)`, and `normalize-span-font`
  takes the paragraph only). A paragraph set or a root gives a run nothing. The
  style goes the same way. When neither names one, the face is what the run's
  own `font-variant-id` names, else 400 normal. A weight in a word
  (`font-weight \"bold\"`) is no number to the closest-variant rule of the
  renderer, so a `font-variant-id` that names a face wins over it; with none,
  the word counts as `serialize-font-weight` reads it, case-sensitively:
  `normal`, `regular` 400, `bold` 700, `thin` 100, `extralight` 200, `light`
  300, `medium` 500, `black` 900, and a case variant of one of them (`Bold`)
  400. `semibold`, `extrabold` and other spellings are left
  unmapped, and the op refuses them as a face the target lacks. The op does
  not resize auto-sized texts, the workspace does; the reply counts them
  (`auto-size-texts`).

  The op edits mains with shape changes and sets the `modified-at` of their
  components, as the workspace does, so other files see the library change.

  The target font comes from `:font-lookup` of the compile options: a function
  (or a map) from a font id to `{:family :variants [{:id :weight :style}]}`,
  or to `{:reason code}` for a font that does not resolve, or nil."
  (:require
   [app.common.data :as d]
   [app.common.files.changes-builder :as pcb]
   [app.common.fonts.builtin :as builtin]
   [app.common.fonts.variants :as variants]
   [app.common.mcp.operations.refs :refer [resolve-page-id resolve-shape-id]]
   [app.common.mcp.operations.schema :refer [g-page op-schema schema:ref]]
   [app.common.mcp.operations.state :refer [commit-builder get-page-objects main-component-ids op-builder raise-invalid]]
   [app.common.schema :as sm]
   [app.common.time :as ct]
   [app.common.types.component :as ctk]
   [app.common.types.container :as ctn]
   [app.common.types.text :as txt]
   [app.common.uuid :as uuid]
   [clojure.string :as str]))

(def default-max-texts
  "The most texts one `replace_font` changes when `maxTexts` is not given."
  1000)

(def max-texts-limit
  "The largest `maxTexts`. It is the size of a commit batch, so one op stays
  one batch."
  2000)

(def reply-cap
  "The most ids that a list of the reply holds. A count is always complete."
  100)

(def ^:private default-font-id
  "The font of a text leaf that names none."
  (:font-id txt/default-text-attrs))

(def ^:private builtin-variants-by-id
  "The variants of the bundled fonts, by variant id."
  (into {} (comp (mapcat :variants) (map (juxt :id identity))) builtin/local-fonts))

;; Faces: the weight and style a node shows

(def ^:private weight-words
  "The word weights that have one number in the renderer
  (`serialize-font-weight`), whichever way its substring tests run."
  {"normal" "400" "regular" "400" "bold" "700" "thin" "100" "extralight" "200"
   "light" "300" "medium" "500" "black" "900"})

(defn- raw-weight
  "The weight as the node holds it (a number, or trimmed text), or nil when it
  holds none."
  [weight]
  (cond
    (number? weight)                       weight
    (and (string? weight) (not (str/blank? weight))) (str/trim weight)
    :else                                  nil))

(defn- word->weight
  "The number as text that the renderer reads from the word `text`. The tests
  of the renderer are case-sensitive: the words of `weight-words` give their
  number, and a text with none of those words in it gives 400. Other text (such
  as `semibold`, which holds `bold`) is not mapped and stays as it is."
  [text]
  (cond
    (contains? weight-words text)
    (get weight-words text)

    (some #(str/includes? text %) (keys (dissoc weight-words "normal" "regular")))
    text

    (contains? weight-words (str/lower-case text))
    "400"

    :else
    text))

(defn- weight-str
  "The weight as text of digits for `weight`, a number or a numeric text, else
  nil: a word is no number (see `word->weight`)."
  [weight]
  (let [weight (raw-weight weight)]
    (cond
      (number? weight)                    (str (long weight))
      (some? (re-matches #"\d+" (str weight))) weight
      :else                               nil)))

(defn variant-id->face
  "The `[weight style]` that the variant id `variant-id` names, or nil when it
  names none. Reads the numeric convention (`regular`, `italic`, `700`,
  `700italic`), the team font form (`normal-700`) and the bundled table
  (`bold`)."
  [variant-id]
  (when (string? variant-id)
    (or (when-let [entry (get builtin-variants-by-id variant-id)]
          [(:weight entry) (:style entry)])
        (cond
          (= "regular" variant-id) ["400" "normal"]
          (= "italic" variant-id)  ["400" "italic"]
          :else
          (if-let [[_ weight italic] (re-matches #"(\d+)(italic)?" variant-id)]
            [weight (if (some? italic) "italic" "normal")]
            (when-let [[_ style weight] (re-matches #"(normal|italic)-(\d+)" variant-id)]
              [weight style]))))))

(defn node-face
  "The `[weight style]` of a content node. `inherited` is a map with `:weight`
  and `:style` of the paragraph above it, as `inherit` gives; only a paragraph
  gives a run its face, a paragraph set or a root gives nothing.

  The weight is the node's own `font-weight`, else the paragraph's. A number
  stands. A word gives way to the face that the node's `font-variant-id` names,
  and counts as its number (`word->weight`) only when the id names none. With
  no weight at all, the weight comes from the variant id, else 400. The style
  is the node's own, else the paragraph's, else the variant id's, else normal."
  ([node]
   (node-face node nil))
  ([node inherited]
   (let [[vweight vstyle] (variant-id->face (:font-variant-id node))
         raw              (or (raw-weight (:font-weight node)) (:weight inherited))
         style            (:font-style node)]
     [(cond
        (nil? raw)             (or vweight "400")
        (some? (weight-str raw)) (weight-str raw)
        :else                  (or vweight (word->weight raw)))
      (if (str/blank? style)
        (or (:style inherited) vstyle "normal")
        style)])))

(defn- inherit
  "What the children of `node` take from it: the weight and style of a
  paragraph, as `{:weight :style}`. Any other node passes `inherited` on
  unchanged, which is nil above a paragraph."
  [inherited node]
  (if (txt/is-paragraph-node? node)
    (let [weight (raw-weight (:font-weight node))
          style  (:font-style node)]
      (cond-> inherited
        (some? weight)           (assoc :weight weight)
        (not (str/blank? style)) (assoc :style style)))
    inherited))

(defn- node-entries
  "Every node of `node` and below, in order, as `[node inherited]`."
  ([node]
   (node-entries node nil))
  ([node inherited]
   (let [below (inherit inherited node)]
     (cons [node inherited]
           (mapcat #(node-entries % below) (:children node))))))

(defn- has-face-attrs?
  "Whether `node` holds any attr that names a face."
  [node]
  (or (some? (:font-variant-id node))
      (some? (:font-weight node))
      (some? (:font-style node))))

;; Which nodes use the source font

(defn uses-font?
  "Whether the content node `node` uses the font `font-id`. A leaf with no
  `font-id` uses the default font, since nothing inherits for rendering. Any
  other node counts only when its own `font-id` is the font."
  [font-id node]
  (if (txt/is-text-node? node)
    (= font-id (or (:font-id node) default-font-id))
    (and (or (txt/is-root-node? node)
             (txt/is-paragraph-node? node)
             (txt/is-paragraph-set-node? node))
         (= font-id (:font-id node)))))

(defn- face-needed?
  "Whether the swap of `node` needs a variant: a leaf always does, and any
  other node only when it names a face already."
  [node]
  (or (txt/is-text-node? node)
      (has-face-attrs? node)))

(defn scan-content
  "What the swap of `font-id` finds in `content`: nil when no node uses the
  font, else a map with `:faces` (the set of `[weight style]` of the nodes that
  need a variant) and `:runs` (the leaves that use it and hold text)."
  [font-id content]
  (when-let [entries (seq (filter (fn [[node _]] (uses-font? font-id node))
                                  (node-entries content)))]
    {:faces (into #{}
                  (comp (filter (fn [[node _]] (face-needed? node)))
                        (map (fn [[node inherited]] (node-face node inherited))))
                  entries)
     :runs  (count (filter (fn [[node _]] (and (txt/is-text-node? node) (seq (:text node))))
                           entries))}))

;; Skips

(def skip-reasons
  "The reason codes of a skipped text."
  ["component-copy" "typography-ref" "font-token"])

(defn- token-names
  "The names of the font tokens that `shape` has applied."
  [shape]
  (let [applied (:applied-tokens shape)]
    (into []
          (comp (filter #(contains? applied %))
                (map name))
          [:font-family :typography :font-weight])))

(defn- linked-typography
  "The `{:typography-id :typography-file}` of the first node of `content` that
  links a typography, or nil."
  [content]
  (some (fn [node]
          (when (some? (:typography-ref-id node))
            {:typography-id (:typography-ref-id node)
             :typography-file (:typography-ref-file node)}))
        (txt/node-seq content)))

(defn skip-of
  "Why the text `shape` must not be written, as `{:reason :detail}`, or nil.
  `objects` are the objects of its page and `file-id` is the working file.
  Checked in this order: a copy, a linked typography, a font token."
  [file-id objects shape]
  (if (ctk/in-component-copy? shape)
    (let [head (ctn/get-component-shape objects shape)]
      {:reason "component-copy"
       :detail (d/without-nils
                {:component-id (:component-id head)
                 :component-file (:component-file head)
                 :main-in-this-file (some-> (:component-file head) (= file-id))})})
    (if-let [typography (linked-typography (:content shape))]
      {:reason "typography-ref" :detail typography}
      (when-let [names (seq (token-names shape))]
        {:reason "font-token" :detail {:tokens (vec names)}}))))

;; Variants

(defn- normalize-variants
  "The variants of a looked up font with their weights as text."
  [variants]
  (mapv (fn [{:keys [id weight style]}]
          {:id id :weight (weight-str weight) :style style})
        variants))

(defn resolve-target
  "The target font `font-id` from the lookup of `state`: `{:family :variants}`.
  Raises an invalid operation when the compile has no lookup, or the font does
  not resolve, or it has no variants."
  [state font-id]
  (let [lookup (:font-lookup state)]
    (when-not (ifn? lookup)
      (raise-invalid "replace_font needs font data, which this compile has none of"))
    (let [font (lookup font-id)]
      (cond
        (nil? font)
        (raise-invalid (str "toFontId " font-id " does not resolve to a font this team can use"))

        (some? (:reason font))
        (raise-invalid (str "toFontId " font-id " does not resolve: " (:reason font)))

        (or (str/blank? (:family font)) (empty? (:variants font)))
        (raise-invalid (str "toFontId " font-id " has no family or no variants"))

        :else
        {:family   (:family font)
         :variants (normalize-variants (:variants font))}))))

(defn pick-variant
  "The variant of `variants` for `face`, a `[weight style]`, as `{:variant :exact}`,
  or nil when there is none. `exact` takes the variant with that weight and
  style only. `nearest` takes the closest one, by the rule of the workspace
  (`app.common.fonts.variants/closest-variant`)."
  [mode variants [weight style]]
  (if-let [exact (d/seek #(and (= weight (:weight %)) (= style (:style %))) variants)]
    {:variant exact :exact true}
    (when (= :nearest mode)
      (when-let [near (variants/closest-variant variants weight style)]
        {:variant near :exact false}))))

(defn- face-text
  [[weight style]]
  (str weight " " style))

(defn choose-variants
  "Maps each face of `faces` to its pick (see `pick-variant`). Raises an
  invalid operation, naming the faces, when `mode` is `:exact` and a face has
  no variant, or when `:nearest` finds none."
  [mode font-id variants faces]
  (let [picks   (into {} (map (fn [face] [face (pick-variant mode variants face)])) faces)
        missing (sort-by face-text (keep (fn [[face pick]] (when (nil? pick) face)) picks))]
    (when (seq missing)
      (raise-invalid
       (str "the font " font-id " has no variant for "
            (str/join ", " (map face-text missing))
            " (weight style); its variants are "
            (str/join ", " (map #(str (:id %) " (" (face-text [(:weight %) (:style %)]) ")") variants))
            (if (= :exact mode)
              ". Use variantMatch \"nearest\" to take the closest variant."
              "."))))
    picks))

;; Writing

(defn- rewrite-node
  [node inherited from-id to-id family picks]
  (let [below    (inherit inherited node)
        children (:children node)
        node     (if (seq children)
                   (assoc node :children
                          (mapv #(rewrite-node % below from-id to-id family picks) children))
                   node)]
    (if (and (txt/is-node? node) (uses-font? from-id node))
      (let [face (when (face-needed? node) (node-face node inherited))
            leaf? (txt/is-text-node? node)
            node (assoc node :font-id to-id :font-family family)]
        (if face
          (let [{:keys [id weight style]} (:variant (get picks face))]
            ;; A run gets the whole face. A paragraph, a paragraph set or a
            ;; root gets the variant id only: the weight and style it names
            ;; stay, or a run of another font that inherits them would change.
            (if leaf?
              (assoc node
                     :font-variant-id id
                     :font-weight weight
                     :font-style style)
              (assoc node :font-variant-id id)))
          node))
      node)))

(defn rewrite-content
  "`content` with each node that uses `from-id` moved to the font `to-id` of
  `family`. A run gets the id, weight and style that `picks` hold for its face,
  which `node-face` finds from the run and its paragraph as they were. A
  paragraph, paragraph set or root that names a face gets the variant id only.
  Other nodes are not touched."
  [content from-id to-id family picks]
  (rewrite-node content nil from-id to-id family picks))

;; The scan

(defn- walk-texts
  "The text shapes of `objects` under `root-ids`, roots included, in tree
  order. A shape reached twice, or a cycle in `:shapes`, is visited once."
  [objects root-ids]
  (loop [stack (vec (reverse root-ids))
         seen  #{}
         out   []]
    (if (empty? stack)
      out
      (let [id    (peek stack)
            stack (pop stack)]
        (if (contains? seen id)
          (recur stack seen out)
          (let [shape (get objects id)]
            (recur (into stack (reverse (:shapes shape)))
                   (conj seen id)
                   (cond-> out
                     (= :text (:type shape)) (conj shape)))))))))

(defn- classify
  "Walks `texts` and sorts them: the ones to write (`:candidates`, each with
  its `:shape`, `:faces` and `:runs`), the skipped ones (`:skipped`, maps with
  `:id`, `:reason` and `:detail`), and the counts."
  [file-id objects from-id texts]
  (reduce (fn [acc shape]
            (if-let [found (scan-content from-id (:content shape))]
              (let [acc (update acc :matched inc)]
                (if-let [skip (skip-of file-id objects shape)]
                  (update acc :skipped conj (assoc skip :id (:id shape)))
                  (update acc :candidates conj (assoc found :shape shape))))
              acc))
          {:matched 0 :candidates [] :skipped []}
          texts))

(defn- capped
  "`items` cut to `reply-cap`, as `[items truncated?]`."
  [items]
  [(vec (take reply-cap items)) (> (count items) reply-cap)])

(defn- picks->used
  "The `variants-used` entries of the reply: one per face, sorted."
  [picks]
  (->> picks
       (map (fn [[[weight style] {:keys [variant exact]}]]
              {:from {:weight weight :style style}
               :to {:variant-id (:id variant)
                    :weight (:weight variant)
                    :style (:style variant)}
               :exact exact}))
       (sort-by (juxt #(d/parse-integer (get-in % [:from :weight]) 0)
                      #(get-in % [:from :weight])
                      #(get-in % [:from :style])))
       (vec)))

(defn- skipped-report
  "The `skipped` part of the reply."
  [skipped]
  (let [[items truncated] (capped (map #(select-keys % [:id :reason :detail]) skipped))
        by-reason         (frequencies (map :reason skipped))]
    {:total (count skipped)
     :by-reason (vec (keep (fn [reason]
                             (when-let [n (get by-reason reason)]
                               {:reason reason :count n}))
                           skip-reasons))
     :items items
     :items-truncated truncated}))

(defn- result-of
  "The op result of the reply."
  [op page-id target scanned classified picks changed]
  (let [ids                 (mapv (comp :id :shape) changed)
        dropped             (into [] (comp (filter #(seq (:position-data (:shape %))))
                                           (map (comp :id :shape)))
                                  changed)
        [changed-ids ctrunc] (capped ids)
        [dropped-ids dtrunc] (capped dropped)
        auto                (into [] (comp (filter #(contains? #{:auto-width :auto-height}
                                                               (:grow-type (:shape %))))
                                           (map (comp :id :shape)))
                                  changed)
        [auto-ids atrunc]   (capped auto)]
    {:op "replace_font"
     :page-id page-id
     :from-font-id (:from-font-id op)
     :to-font-id (:to-font-id op)
     :to-family (:family target)
     :texts-scanned scanned
     :texts-matched (:matched classified)
     :texts-changed (count changed)
     :runs-changed (transduce (map :runs) + 0 changed)
     :variants-used (picks->used picks)
     :changed-ids changed-ids
     :changed-ids-truncated ctrunc
     :layout-dropped (count dropped)
     :layout-dropped-ids dropped-ids
     :layout-dropped-ids-truncated dtrunc
     :auto-size-texts (count auto)
     :auto-size-ids auto-ids
     :auto-size-ids-truncated atrunc
     :skipped (skipped-report (:skipped classified))}))

(defn- scope-roots
  "The ids the walk starts from: the page root, or the resolved `root-ids`."
  [state objects root-ids]
  (if (seq root-ids)
    (mapv #(resolve-shape-id state objects %) root-ids)
    [uuid/zero]))

(defn compile-replace-font
  "Compiles one `replace_font` op. Refuses the whole op, writing nothing, when
  the fonts are the same, the target does not resolve, a root is not on the
  page, more texts than `max-texts` would change, or, in `exact` mode, a face
  in use has no variant in the target."
  [state op]
  (let [page-id   (resolve-page-id state (:page-id op))
        objects   (get-page-objects state page-id)
        from-id   (:from-font-id op)
        to-id     (:to-font-id op)
        mode      (or (:variant-match op) :exact)
        max-texts (or (:max-texts op) default-max-texts)
        file-id   (:id (:file-data state))]
    (when (= from-id to-id)
      (raise-invalid "fromFontId and toFontId are the same font"))
    (let [target     (resolve-target state to-id)
          texts      (walk-texts objects (scope-roots state objects (:root-ids op)))
          classified (classify file-id objects from-id texts)
          changed    (:candidates classified)]
      (when (> (count changed) max-texts)
        (raise-invalid (str "replace_font would change " (count changed) " texts, more than maxTexts "
                            max-texts "; " (count (:skipped classified)) " more are skipped. "
                            "Narrow it with rootIds, or raise maxTexts (at most " max-texts-limit ")")))
      (let [picks   (choose-variants mode to-id (:variants target)
                                     (into #{} (mapcat :faces) changed))
            ;; The new content of each text, found before the write.
            content (into {}
                          (map (fn [{:keys [shape]}]
                                 [(:id shape)
                                  (rewrite-content (:content shape) from-id to-id (:family target) picks)]))
                          changed)
            ids     (mapv (comp :id :shape) changed)
            result  (result-of op page-id target (count texts) classified picks changed)
            mains   (into (sorted-set-by #(compare (str %1) (str %2)))
                          (mapcat #(main-component-ids objects %))
                          ids)
            [main-ids mtrunc] (capped mains)
            result  (assoc result
                           :mains-changed main-ids
                           :mains-changed-truncated mtrunc)
            state   (assoc state :op-result result)]
        (if (empty? ids)
          state
          (let [now     (ct/now)
                builder (pcb/update-shapes (op-builder state page-id)
                                           ids
                                           (fn [shape]
                                             (-> shape
                                                 (assoc :content (get content (:id shape)))
                                                 (dissoc :position-data)))
                                           {:attrs #{:content :position-data}})
                ;; The workspace stamps a component when its main changes.
                ;; Other files learn of a library change from this stamp.
                builder (reduce (fn [builder component-id]
                                  (pcb/update-component builder component-id #(assoc % :modified-at now)))
                                builder
                                mains)]
            (-> state
                (commit-builder builder)
                (assoc :snapshot-hint true))))))))

(def ops
  "The ops of the replace-font family. Each op name maps to its schema and
  its compile function."
  {"replace_font" {:schema (op-schema "replace_font" g-page
                                      [[:from-font-id [:string {:min 1}]]
                                       [:to-font-id [:string {:min 1}]]
                                       [:root-ids {:optional true} [:vector {:min 1 :max 500} schema:ref]]
                                       [:variant-match {:optional true} [::sm/one-of #{:exact :nearest}]]
                                       [:max-texts {:optional true} [:int {:min 1 :max max-texts-limit}]]])
                   :compile compile-replace-font}})
