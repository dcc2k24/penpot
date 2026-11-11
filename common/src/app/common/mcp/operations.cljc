(ns app.common.mcp.operations
  "Compiles backend MCP operations into file change sets.

  Operations run in order against the real file data. Each operation
  builds its changes on a fresh changes builder, and the redo changes are
  applied to the file data before the next operation runs. The ops are
  declared in the families (`operations.shapes` and the others): the op
  table merges them, and the schema and the dispatch come from it."
  (:require
   [app.common.exceptions :as ex]
   [app.common.mcp.operations.arrange :as f-arrange]
   [app.common.mcp.operations.components :as f-components]
   [app.common.mcp.operations.layout :as f-layout]
   [app.common.mcp.operations.library :as f-library]
   [app.common.mcp.operations.prototype :as f-prototype]
   [app.common.mcp.operations.replace-font :as f-replace-font]
   [app.common.mcp.operations.schema :as schema :refer [decode-op-values json-transformer]]
   [app.common.mcp.operations.shapes :as f-shapes]
   [app.common.mcp.operations.state :as state :refer [check-changed-shapes fatal? initial-state raise-compile-error reflow-pages]]
   [app.common.mcp.operations.text :as f-text]
   [app.common.mcp.operations.tokens :as f-tokens]
   [app.common.schema :as sm]))

(def op-table
  "The ops of the compiler, merged from the families. An op is declared once,
  in its family, with its schema and its compile function."
  (merge f-shapes/ops f-layout/ops f-text/ops f-components/ops f-library/ops f-tokens/ops f-prototype/ops f-arrange/ops f-replace-font/ops))

(def schema:operation
  "The schema of the ops: a `:multi` on the op name, built from the families."
  (into [:multi {:dispatch :op :title "Operation"}]
        (map (fn [[op-name entry]] [op-name (:schema entry)]))
        (sort-by key op-table)))

(def schema:operations
  [:vector {:max 2000} schema:operation])

(def schema-op-names
  "The op names of the operation schema, from the branches of its `:multi`."
  (set (map first (sm/children (sm/schema schema:operation)))))

;; The decoder and the validator are built once. Building them per call costs
;; as much as the check of a small write.
(def ^:private decode-operations-fn
  (sm/decoder schema:operations json-transformer))

(def ^:private validate-operations-fn
  (sm/validator schema:operations))

(def ^:private explain-operations-fn
  "Built on the first invalid vector, since only an error needs it."
  (delay (sm/explainer schema:operations)))

(defn check-operations
  "Checks `operations` against `schema:operations` and returns them. An
  invalid vector raises an invalid operation with the `:index` of its first
  invalid op, which is nil when the error has no path, and the `:op` name of
  that op when it is a map. The hint and `:details` hold the humanized errors
  of that op, so the agent sees which field is wrong."
  [operations]
  (when-not (validate-operations-fn operations)
    (let [explanation (@explain-operations-fn operations)
          index       (some #(first (:in %)) (:errors explanation))
          op          (get operations index)
          errors      (filterv #(= index (first (:in %))) (:errors explanation))
          details     (sm/simplify (assoc explanation :errors errors))]
      (ex/raise :type :validation
                :code :mcp-invalid-operation
                :hint (str "invalid operations: " (pr-str details))
                :details details
                :index index
                :op (when (map? op) (:op op)))))
  operations)

(defn decode-operations
  "Decodes the JSON-style values of `operations`: keyword enums from
  strings. Decoding a decoded vector returns the same vector."
  [operations]
  (decode-operations-fn operations))

(def operation-names
  "The sorted vector of the operation names the compiler accepts. The
  backend reads it to list the ops it can run."
  (vec (sort (keys op-table))))

(defn- compile-op
  [state index op]
  (let [family (get-in op-table [(:op op) :compile])]
    (when-not family
      (ex/raise :type :validation
                :code :mcp-invalid-operation
                :hint (str "operation not implemented: " (:op op))
                :index index
                :op (:op op)))
    (try
      (let [changes-before (count (:changes state))
            state          (family state (decode-op-values op (:new-id-fn state)))
            state          (check-changed-shapes state (subvec (:changes state) changes-before))]
        (-> state
            (update :op-ranges conj [changes-before (count (:changes state))])
            ;; An op that reports a result leaves it in `:op-result`.
            (update :op-results conj (:op-result state))
            (dissoc :op-result)))
      (catch #?(:clj Throwable :cljs :default) cause
        (if (fatal? cause)
          (throw cause)
          (raise-compile-error index (:op op) cause))))))

(defn compile-operations
  "Compiles `operations` against `file-data` and returns the changes they
  emit.

  `file-data` is the `:data` map of a file. `operations` is a vector of op
  maps. JSON-style enum strings are decoded, and the vector is checked
  against the operation schema before any op runs. `opts` may hold
  `:new-id-fn` (default `uuid/next`), `:libraries`, a map from library
  id to library file data, and `:font-lookup`, a function from a font id to
  `{:family :variants}` (or `{:reason code}`, or nil), which `replace_font`
  needs.

  Returns a map with `:changes` (every emitted change in order, each with
  its page id), `:op-ranges` (one `[start end]` pair per op, in op order:
  the indexes in `:changes` of the first change the op emitted and one past
  its last, so `start` equals `end` for an op that emits nothing; the
  changes of the layout reflow come after the last range), `:op-results`
  (one entry per op, in op order: the result map of an op that reports one,
  else nil), `:snapshot-hint` (true when an op asks for a snapshot before the
  write), `:created-ids`
  (each `$tmp:` handle to its uuid), `:warnings` (maps with `:code` and
  `:id`), `:touched-page-ids` (the page ids of the changes) and `:summary`
  (`:op-count`, `:change-count` and `:change-types`, a map from change type
  to count). Invalid operations raise a validation error with the code
  `:mcp-invalid-operation` or `:mcp-unknown-id`, with the `:index` and `:op`
  of the failing operation. Any other failure raises an internal error with
  the code `:mcp-compile-failed`, with the same `:index` and `:op` and the
  cause attached.
  An error in the layout reflow after all ops has `:index` nil and `:op`
  \"reflow\".

  `:new-id-fn` makes the ids of the shapes that the create ops and the
  `$tmp` handles name, and the ids of token shadows. The ids of clones, copy
  children, new components and their copies, and flows come from
  `uuid/next` inside the editor generators, which take no id function. The
  token sets, themes and tokens take the current time. So a compile is not
  reproducible for the clone, instantiate, component, flow and token
  families, even with a fixed `:new-id-fn`."
  [file-data operations opts]
  (let [operations (check-operations (decode-operations operations))
        state (reduce-kv (fn [state index op]
                           (compile-op state index op))
                         (initial-state file-data opts)
                         operations)
        state (try
                (reflow-pages state)
                (catch #?(:clj Throwable :cljs :default) cause
                  (if (fatal? cause)
                    (throw cause)
                    (raise-compile-error nil "reflow" cause))))
        changes (:changes state)]
    {:changes changes
     :op-ranges (:op-ranges state)
     :op-results (:op-results state)
     :snapshot-hint (:snapshot-hint state)
     :created-ids (:created-ids state)
     :warnings (:warnings state)
     :touched-page-ids (into #{} (keep :page-id) changes)
     :summary {:op-count (count operations)
               :change-count (count changes)
               :change-types (frequencies (map :type changes))}}))

(def geometry-modifiers
  "The modifiers that take a shape to the geometry of an update. See
  `app.common.mcp.operations.state/geometry-modifiers`."
  state/geometry-modifiers)

(def props-keys-of-type
  "The keys that `props` may set on a shape of `type`."
  schema/props-keys-of-type)
