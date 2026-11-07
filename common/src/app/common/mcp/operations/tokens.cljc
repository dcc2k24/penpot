(ns ^{:no-doc true} app.common.mcp.operations.tokens
  "This namespace is internal: `app.common.mcp.operations` is the
  only API.

  The design token ops: sets, tokens, themes, the tokens source, the import,
  and applying tokens to shapes."
  (:require
   [app.common.data :as d]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.tokens :as cfo]
   [app.common.json :as json]
   [app.common.logic.modifiers :as lm]
   [app.common.logic.shapes :as cls]
   [app.common.logic.token-application :as tapp]
   [app.common.logic.tokens :as clt]
   [app.common.mcp.operations.refs :refer [alloc-id alloc-unchecked-id resolve-library-id resolve-page-id resolve-ref resolve-shape-ids]]
   [app.common.mcp.operations.schema :refer [g-id g-page op-schema schema:ref]]
   [app.common.mcp.operations.state :refer [commit-builder geometry-modifiers get-file-record get-page-objects mark-reflow modifier-objects-of op-builder parent-ids raise-invalid raise-unknown]]
   [app.common.schema :as sm]
   [app.common.types.token :as cto]
   [app.common.types.tokens-lib :as ctob]
   [app.common.types.tokens-status :as ctos]
   [clojure.string :as str]))

;; Design tokens: sets, tokens, themes and status
(defn- get-state-token-lib
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

(defn- resolve-token-set-entity
  "The token set that `ref` names. Each token op resolves its set once, and
  passes the set down, since a lookup of a set scans the sets of the file."
  [state ref]
  (let [id (resolve-ref state ref)]
    (or (some-> (get-state-token-lib state) (ctob/get-set id))
        (raise-unknown (str "unknown token set " id)))))

(defn- resolve-token-set
  [state ref]
  (ctob/get-id (resolve-token-set-entity state ref)))

(defn- resolve-token-theme
  [state ref]
  (let [id (resolve-ref state ref)]
    (when-not (some-> (get-state-token-lib state) (ctob/get-theme id))
      (raise-unknown (str "unknown token theme " id)))
    id))

(defn- resolve-token-in-set
  "The id of the token that `ref` names in the set `set-id`."
  [state set-id ref]
  (let [id (resolve-ref state ref)]
    (when-not (some? (ctob/get-token (get-state-token-lib state) set-id id))
      (raise-unknown (str "unknown token " id)))
    id))

(defn- check-theme-sets
  "Raises when a theme names a set that the file does not have."
  [state set-names]
  (let [lib (get-state-token-lib state)]
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
    (when (some-> (get-state-token-lib state) (ctob/get-set id))
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
        lib    (get-state-token-lib state)
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

(def ^:private token-value-validator
  "The validator of the token values of a type, built once per type."
  (memoize (fn [token-type]
             (sm/validator (cfo/make-token-value-schema token-type)))))

(defn- check-token-value
  "Raises an invalid operation when `value` is not valid for a token of
  `token-type`, by the schema of the workspace. A number is checked as its
  text, which is how the workspace writes values."
  [token-type value]
  (let [checked (if (number? value) (str value) value)]
    (when-not ((token-value-validator token-type) checked)
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
  (let [set        (resolve-token-set-entity state (:set-id op))
        set-id     (ctob/get-id set)
        ;; A generated id is new, so only a literal id is looked up
        [id state] (alloc-id state (:id op)
                             #(some? (ctob/get-token (get-state-token-lib state) set-id %)))]
    (check-token-name-free (get-state-token-lib state) set-id (:name op) id)
    (let [token (ctob/make-token {:id id
                                  :name (:name op)
                                  :type (op-token-type (:type op))
                                  :value (:value op)
                                  :description (:description op)})]
      (check-token-value (:type token) (:value token))
      (commit-builder state (pcb/set-token (op-builder state nil) set-id id token)))))

(defn- update-token-change
  [state op]
  (let [set    (resolve-token-set-entity state (:set-id op))
        set-id (ctob/get-id set)
        id     (resolve-token-in-set state set-id (:id op))
        prev   (ctob/get-token (get-state-token-lib state) set-id id)
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
    (check-token-name-free (get-state-token-lib state) set-id (:name token) id)
    (check-token-value (:type token) (:value token))
    (commit-builder state (pcb/set-token (op-builder state nil) set-id id token))))

(defn- delete-token-change
  [state op]
  (let [set    (resolve-token-set-entity state (:set-id op))
        set-id (ctob/get-id set)
        id     (resolve-token-in-set state set-id (:id op))]
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
    (when (some-> (get-state-token-lib state) (ctob/get-theme id))
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
        prev   (ctob/get-theme (get-state-token-lib state) id)
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
                      (get-file-record state)
                      (get (:libraries state)
                           (resolve-library-id state (:libraries state) id)))))]
    (commit-builder state (clt/generate-set-tokens-source (op-builder state nil) library))))

(defn- base-font-size-change
  [state op]
  (commit-builder state (pcb/set-base-font-size (op-builder state nil) (:value op))))

(defn- decode-tokens-document
  "Decodes the JSON text of a DTCG tokens document, once. Text that is not
  JSON is an invalid operation."
  [json]
  (try
    (json/decode json :key-fn identity)
    (catch #?(:clj Exception :cljs :default) cause
      (raise-invalid (str "invalid tokens document: " (ex-message cause))))))

(defn- parse-tokens-document
  "Parses a decoded DTCG tokens document. The parser signals a malformed
  document with an assertion, which is not an `Exception` on the JVM."
  [document]
  (letfn [(invalid [cause]
            (raise-invalid (str "invalid tokens document: " (ex-message cause))))]
    (try
      (ctob/read-multi-set-dtcg document)
      (catch #?(:clj AssertionError :cljs :default) cause
        (invalid cause))
      #?(:clj (catch clojure.lang.ExceptionInfo cause
                (invalid cause))))))

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
  "True when the decoded DTCG `document` has a `$metadata` block."
  [document]
  (contains? document "$metadata"))

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
  (let [lib        (get-state-token-lib state)
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
  (let [lib        (get-state-token-lib state)
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
                                                              (get-state-token-lib state)))))

(defn- import-tokens-change
  "Imports a DTCG document. In `:replace` mode the sets and themes missing
  from the document are deleted, and so are the tokens of kept sets that the
  document does not have.

  A document with `$metadata` also sets the active themes and sets, and the
  order of the sets, as the document gives them."
  [state op]
  (let [current    (get-state-token-lib state)
        document   (decode-tokens-document (:json op))
        imported   (parse-tokens-document document)
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
    (if (document-metadata? document)
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

(defn- get-token-type
  "The type of the token `token-name`. A token of an active set wins over a
  token of the same name in another set, and the later set in the file wins
  over an earlier one. So the active sets are read last first, one set at a
  time, with no merge of their tokens. Only when no active set has the name,
  the first set that has it gives the type."
  [state token-name]
  (let [lib    (get-state-token-lib state)
        active (ctos/get-active-set-ids (state-token-status state))
        token  (when (some? lib)
                 (or (some (fn [set]
                             (when (contains? active (ctob/get-id set))
                               (get (ctob/get-tokens lib (ctob/get-id set)) token-name)))
                           (reverse (ctob/get-sets lib)))
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
                                                   (modifier-objects-of objects ids)
                                                   modif-tree
                                                   {:ignore-touched true}))
      state)))

(defn- apply-token-with-geometry
  "Returns `[shape written]` as `tapp/apply-token-to-shape` does, and records
  the geometry keys that the token sets (`:width`, `:height`, `:rotation`) in
  the `:applied-tokens` of the shape too. The geometry itself goes through
  the modifiers, so the update that records these runs after them."
  [shape token-name token-type value attributes objects new-id-fn]
  (let [[shape' written] (tapp/apply-token-to-shape shape token-name token-type
                                                    value attributes objects new-id-fn)
        geometry         (keys (tapp/token-geometry-changes shape token-type value attributes))]
    [(cond-> shape'
       (seq geometry)
       (update :applied-tokens merge (zipmap geometry (repeat token-name))))
     written]))

(defn- compile-token-apply-op
  [state op]
  (let [page-id    (resolve-page-id state (:page-id op))
        objects    (get-page-objects state page-id)
        ids        (resolve-shape-ids state objects (:shape-ids op))
        attributes (mapv keyword (:attributes op))
        token-name (:token-name op)]
    (case (:op op)
      "apply_token"
      (let [token-type (get-token-type state token-name)
            value      (resolved-number (:resolved-value op))
            state      (apply-token-geometry state page-id objects ids token-type value attributes)
            objects    (get-page-objects state page-id)
            ;; Each shape is applied once, so the update and the report agree
            applied    (into {}
                             (map (fn [id]
                                    [id (apply-token-with-geometry (get objects id)
                                                                   token-name
                                                                   token-type
                                                                   value
                                                                   attributes
                                                                   objects
                                                                   (:new-id-fn state))]))
                             ids)
            ;; The geometry a size or rotation token sets goes through the
            ;; modifiers above, so it counts as written here.
            written    (into #{}
                             (mapcat (fn [id]
                                       (concat (second (get applied id))
                                               (keys (tapp/token-geometry-changes
                                                      (get objects id) token-type value attributes)))))
                             ids)
            builder    (-> (op-builder state page-id)
                           (cls/generate-update-shapes ids
                                                       #(first (get applied (:id %)))
                                                       objects
                                                       {:ignore-touched true})
                           (pcb/resize-parents (parent-ids objects ids)))]
        (-> state
            (commit-builder builder)
            (cond-> (empty? written)
              (update :warnings conj {:code :token-not-applied
                                      :token token-name
                                      :attributes (mapv name attributes)}))
            (mark-reflow page-id (concat ids (map #(:parent-id (get objects %)) ids)))))

      "unapply_token"
      (commit-builder state
                      (pcb/update-shapes (op-builder state page-id)
                                         ids
                                         #(tapp/unapply-token-from-shape % token-name attributes))))))

(def ops
  "The ops of the tokens family. Each op name maps to its schema and its
  compile function."
  {"create_token_set" {:schema (op-schema "create_token_set"
                                          [[:id {:optional true} schema:ref]
                                           [:name :string]
                                           [:active {:optional true} :boolean]])
                       :compile compile-token-set-op}
   "update_token_set" {:schema (op-schema "update_token_set" g-id
                                          [[:name {:optional true} :string]])
                       :compile compile-token-set-op}
   "delete_token_set" {:schema (op-schema "delete_token_set" g-id)
                       :compile compile-token-set-op}
   "move_token_set" {:schema (op-schema "move_token_set" g-id
                                        [[:before-id {:optional true} schema:ref]])
                     :compile compile-token-set-op}
   "create_token" {:schema (op-schema "create_token"
                                      [[:set-id schema:ref]
                                       [:id {:optional true} schema:ref]
                                       [:type :string]
                                       [:name :string]
                                       [:value :any]
                                       [:description {:optional true} :string]])
                   :compile compile-token-op}
   "update_token" {:schema (op-schema "update_token"
                                      [[:set-id schema:ref]
                                       [:id schema:ref]
                                       [:type {:optional true} :string]
                                       [:name {:optional true} :string]
                                       [:value {:optional true} :any]
                                       [:description {:optional true} :string]])
                   :compile compile-token-op}
   "delete_token" {:schema (op-schema "delete_token"
                                      [[:set-id schema:ref]
                                       [:id schema:ref]])
                   :compile compile-token-op}
   "create_theme" {:schema (op-schema "create_theme"
                                      [[:id {:optional true} schema:ref]
                                       [:group :string]
                                       [:name :string]
                                       [:sets [:vector :string]]])
                   :compile compile-theme-op}
   "update_theme" {:schema (op-schema "update_theme" g-id
                                      [[:group {:optional true} :string]
                                       [:name {:optional true} :string]
                                       [:sets {:optional true} [:vector :string]]])
                   :compile compile-theme-op}
   "delete_theme" {:schema (op-schema "delete_theme" g-id)
                   :compile compile-theme-op}
   "activate_theme" {:schema (op-schema "activate_theme" g-id)
                     :compile compile-token-status-op}
   "deactivate_theme" {:schema (op-schema "deactivate_theme" g-id)
                       :compile compile-token-status-op}
   "toggle_set" {:schema (op-schema "toggle_set"
                                    [[:set-id schema:ref]])
                 :compile compile-token-status-op}
   "set_tokens_status" {:schema (op-schema "set_tokens_status"
                                           [[:theme-ids [:vector schema:ref]]
                                            [:set-ids [:vector schema:ref]]])
                        :compile compile-token-status-op}
   "set_tokens_source" {:schema (op-schema "set_tokens_source"
                                           [[:library-id [:maybe schema:ref]]])
                        :compile compile-token-file-op}
   "set_base_font_size" {:schema (op-schema "set_base_font_size"
                                            [[:value :string]])
                         :compile compile-token-file-op}
   "import_tokens_dtcg" {:schema (op-schema "import_tokens_dtcg"
                                            [[:json :string]
                                             [:mode [::sm/one-of #{:merge :replace}]]])
                         :compile compile-token-file-op}
   "apply_token" {:schema (op-schema "apply_token" g-page
                                     [[:shape-ids [:vector {:min 1} schema:ref]]
                                      [:token-name :string]
                                      [:attributes [:vector :string]]
                                      [:resolved-value :any]])
                  :compile compile-token-apply-op}
   "unapply_token" {:schema (op-schema "unapply_token" g-page
                                       [[:shape-ids [:vector {:min 1} schema:ref]]
                                        [:token-name :string]
                                        [:attributes [:vector :string]]])
                    :compile compile-token-apply-op}})
