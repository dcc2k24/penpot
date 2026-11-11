;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.rpc.commands.mcp-subtree
  "Read command of the backend-native MCP that returns every attribute of
  the shapes of a subtree, window by window: `get-mcp-subtree`. See
  `mcp/docs/backend-mode-contract.md`."
  (:require
   [app.common.exceptions :as ex]
   [app.common.geom.shapes :as gsh]
   [app.common.geom.shapes.transforms :as gtr]
   [app.common.json :as json]
   [app.common.schema :as sm]
   [app.common.uuid :as uuid]
   [app.rpc :as-alias rpc]
   [app.rpc.climit :as-alias climit]
   [app.rpc.commands.mcp :as mcp]
   [app.rpc.doc :as-alias doc]
   [app.util.cache :as cache]
   [app.util.services :as sv]))

(def ^:private walk-budget
  "Entries that all cached walks may hold together: about 400,000. The
  weight of a walk is its entry count."
  400000)

(defn- walk-weight
  "Weight of a cached walk: its entry count, and at least one."
  [walk]
  (max 1 (count walk)))

(defonce ^:private walk-cache
  (cache/create :keepalive "10m"
                :weigher walk-weight
                :max-weight walk-budget))

(def max-json-bytes
  "Hard maximum of `max-json-bytes`, the budget of one window in bytes of
  its JSON text: 4,000,000. A window that holds one shape alone can still
  exceed it, because a window always holds at least one shape."
  4000000)

(def ^:private schema:subtree
  [:map {:title "get-mcp-subtree" :closed true}
   [:file-id ::sm/uuid]
   [:page-id ::sm/uuid]
   [:root-id {:optional true} ::sm/uuid]
   [:cursor {:optional true} [:string {:max 4096}]]
   [:limit {:optional true} [::sm/int {:min 1 :max 5000}]]
   [:max-bytes {:optional true} [::sm/int {:min 1000 :max 1000000}]]
   [:max-json-bytes {:optional true} [::sm/int {:min 1000 :max max-json-bytes}]]
   [:compact {:optional true} ::sm/boolean]])

(def compact-defaults
  "The values that a consumer assumes for a key that a compact shape does
  not carry. They are the defaults that `mcp/with-defaults` adds to every
  shape (`hidden`, `blocked`, `opacity`) and to every stroke
  (`stroke-alignment`, under `strokes`). The sizing defaults of layout
  items depend on the parent, so a compact shape keeps those keys."
  {:hidden false
   :blocked false
   :opacity 1
   :strokes {:stroke-alignment :center}})

(defn- json-size
  "Bytes of the JSON text of `value`, written as the HTTP layer writes a
  reply: the same encoder and the camel-case key function. The text is
  ASCII, since the encoder escapes other characters, so its length in
  characters is its size in bytes."
  [value]
  (let [writer (java.io.StringWriter.)]
    (json/write writer value :key-fn json/write-camel-key)
    (.length (.getBuffer writer))))

(defn- json-shape-size
  "Bytes that a shape adds to a JSON array: its own text and one comma.
  The budget of a JSON window is `max-json-bytes` less one, so the array,
  with its two brackets and one comma less than shapes, stays within
  `max-json-bytes`."
  [value]
  (inc (json-size value)))

(defn- default-value?
  "Whether `value` of the shape key `k` is the default that a consumer
  assumes for a missing key (see `compact-defaults`). Numbers compare by
  value, so a stored `1.0` is the default opacity `1`."
  [k value]
  (let [default (get compact-defaults k ::none)]
    (and (not= ::none default)
         (not (map? default))
         (if (number? default)
           (and (number? value) (== default value))
           (= default value)))))

(defn- compact-strokes
  "`strokes` without the alignment that is the default."
  [strokes]
  (mapv (fn [stroke]
          (if (= :center (:stroke-alignment stroke))
            (dissoc stroke :stroke-alignment)
            stroke))
        strokes))

(defn compact-shape
  "`shape` without the keys whose value is nil, without the keys whose
  value is a default of `compact-defaults`, and with `strokes` free of the
  default alignment. Only the keys of the shape itself are looked at: a nil
  inside a fill or in a text's content stays."
  [shape]
  (let [out (persistent!
             (reduce-kv (fn [out k v]
                          (if (or (nil? v) (default-value? k v))
                            out
                            (assoc! out k v)))
                        (transient {})
                        shape))]
    (cond-> out
      (seq (:strokes out))
      (update :strokes compact-strokes))))

(defn- get-walk-entries
  "The shapes of the walk from `root-id` as `[depth id]` entries, in
  pre-order and stored child order. The page root is not part of the walk:
  its children come at depth 0. A shape that is reached again, by a cycle
  in a corrupt `:shapes` or by a second parent, is listed once, at its
  first place. Missing shapes are skipped. Only ids are kept here: no shape
  map is built until a window needs one."
  [objects root-id]
  (let [page-root? (= root-id uuid/zero)
        starts     (if page-root?
                     (get-in objects [root-id :shapes] [])
                     [root-id])
        stack      (vec (map (fn [id] [0 id]) (reverse starts)))
        seen       (if page-root? #{uuid/zero} #{})]
    (loop [stack stack
           seen  seen
           out   (transient [])]
      (if-let [[depth id] (peek stack)]
        (let [stack (pop stack)
              shape (get objects id)]
          (if (or (nil? shape) (contains? seen id))
            (recur stack seen out)
            (recur (into stack
                         (map (fn [child] [(inc depth) child]))
                         (reverse (:shapes shape)))
                   (conj seen id)
                   (conj! out [depth id]))))
        (persistent! out)))))

(defn- get-cached-walk
  "The walk of `root-id` on the page `page-id` at `version`, from `walk-cache`
  when it is held. The version is part of the key, so a changed page walks
  again and no stale walk is served."
  [file-id page-id version objects root-id]
  (cache/get walk-cache
             [file-id page-id version root-id]
             (fn [_] (get-walk-entries objects root-id))))

(def ^:private min-matrix-determinant
  "A derived world matrix whose determinant is smaller than this in absolute
  value is singular: the points it came from are degenerate."
  1e-9)

(defn get-world-matrix
  "The affine matrix that maps the four corners of the selrect of `shape`
  (top-left, top-right, bottom-right, bottom-left) onto its four `points`
  (index 0 to 3), in page space. It is derived from the points, so it holds
  for a flipped group that kept an identity `:transform` with mirrored
  points (an import does this). When the shape has no selrect, no four
  points, a selrect of zero width or height, the derivation gives no
  matrix, or the derived matrix is singular (its determinant is 0 within
  `min-matrix-determinant`: two or more points coincide, or all lie on one
  line), it is the matrix of the stored `:transform` about the centre of the
  selrect. The two agree whenever the `:transform` agrees with the points."
  [shape]
  (let [selrect (:selrect shape)
        points  (:points shape)
        derived (when (and (some? selrect) (= 4 (count points)))
                  (gtr/transform-points-matrix selrect points))]
    (if (and (some? derived)
             (>= (Math/abs (double (- (* (:a derived) (:d derived))
                                      (* (:b derived) (:c derived)))))
                 min-matrix-determinant))
      derived
      (gsh/transform-matrix shape))))

(defn- get-walk-shape
  "The map that `get-mcp-subtree` returns for the walk entry `[depth id]`
  at `index`: every stored attribute but the thumbnail, the defaults, the
  box, the characters of a text, and the world matrix of a shape with a
  selrect (see `get-world-matrix`). Path content is untouched: it is the SVG path string in page
  space, and a text's content is its tree of paragraphs."
  [objects index [depth id]]
  (let [shape (get objects id)
        out   (mcp/with-defaults objects
                (mcp/shape-box (dissoc shape :thumbnail)))]
    (cond-> (assoc out :depth depth :index index)
      (= :text (:type out))
      (assoc :characters (mcp/shape-characters out))

      (some? (:selrect shape))
      (assoc :world-matrix (get-world-matrix shape)))))

(defn- get-walk-window
  "The shapes of `walk` from index `start`: at most `limit` of them, and
  stopping before the shape that would take the size past `budget`. The
  size of a shape is `(size-fn shape)`. A compact window holds
  `compact-shape` of each shape.
  The first shape is always kept, so a walk makes progress. Returns
  `[shapes end]`, where `end` is the index of the first shape that is not in
  the window."
  [objects walk start limit budget size-fn compact?]
  (let [stop (min (count walk) (+ start limit))]
    (loop [i    start
           size 0
           out  (transient [])]
      (if (>= i stop)
        [(persistent! out) i]
        (let [shape (get-walk-shape objects i (nth walk i))
              value (if compact? (compact-shape shape) shape)
              size' (+ size (size-fn value))]
          (if (and (pos? (count out)) (> size' budget))
            [(persistent! out) i]
            (recur (inc i) size' (conj! out value))))))))

(defn- get-start-index
  "The walk index that `cursor` names, or 0 without a cursor. `parse-cursor`
  refuses anything that is not a five-part cursor of the right types, so a
  malformed cursor is invalid, never a fault. A cursor of another page or
  root is refused as invalid. A cursor whose version is not the page's
  version is stale. An index past the end of the walk is invalid."
  [cursor page-id version root-id total]
  (if (nil? cursor)
    0
    (let [value (mcp/parse-cursor cursor)]
      (when (nil? value)
        (ex/raise :type :validation
                  :code :mcp-invalid-cursor
                  :hint "cursor is not valid"))
      (let [[cursor-page-id cursor-version index cursor-root-id cursor-zero] value]
        (when-not (and (= cursor-page-id page-id)
                       (= cursor-root-id root-id)
                       (zero? cursor-zero))
          (ex/raise :type :validation
                    :code :mcp-invalid-cursor
                    :hint "cursor belongs to another page or root"))
        (when-not (= cursor-version version)
          (ex/raise :type :validation
                    :code :mcp-stale-cursor
                    :hint "the page changed since the cursor was issued, start again without a cursor"))
        (when (>= index total)
          (ex/raise :type :validation
                    :code :mcp-invalid-cursor
                    :hint "cursor is past the end of the walk"))
        index))))

(sv/defmethod ::get-mcp-subtree
  "Every attribute of the shapes under `root-id` (the page root by
  default), in pre-order and stored child order. The root is the first
  shape, except the page root, which is skipped. Each shape carries its
  stored attributes without the thumbnail, the defaults, the box the plugin
  API reports, `characters` for a text, `depth`, `index` in the whole walk
  and `world-matrix` (the matrix that maps the corners of its selrect onto
  its points; for a flipped group it can differ from its stored
  `transform`). A
  path's or bool's `content` is its SVG path string in page space; a text's
  `content` is its tree of paragraphs. A reply holds at most `limit` shapes
  and always at least one shape. Its size is held by `max-json-bytes`, the
  bytes of the JSON text of the shapes as the HTTP layer writes them with
  camel-case keys (1,000 to 4,000,000; the commas that join the shapes
  count), or else by `max-bytes`, about 1 MB of transit text by default.
  The two are not given together. With `compact` each shape leaves out its
  nil keys and the keys whose value is in `compact-defaults`, and the reply
  carries `compact` true and `defaults` once. `truncated` is true and
  `nextCursor` continues the walk while shapes remain. The walk of a page
  version is cached, so the windows of one walk do not walk the page
  again."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:subtree}
  [cfg {:keys [::rpc/profile-id file-id page-id root-id cursor limit max-bytes max-json-bytes compact]
        :as params}]
  (mcp/run-tool cfg "get-mcp-subtree" params
                (fn []
                  (when (and (some? max-bytes) (some? max-json-bytes))
                    (ex/raise :type :validation
                              :code :mcp-invalid-window
                              :hint "give max-bytes or max-json-bytes, not both"))
                  (mcp/check-access! cfg params profile-id file-id)
                  (let [file    (mcp/load-file-for-page cfg file-id page-id [])
                        data    (:data file)
                        revn    (:revn file)
                        objects (:objects (mcp/get-page-data cfg file-id revn data page-id))
                        version (mcp/page-version data page-id revn)
                        root-id (or root-id uuid/zero)
                        limit   (or limit 500)
                        budget  (if (some? max-json-bytes)
                                  (dec max-json-bytes)
                                  (or max-bytes mcp/response-byte-budget))
                        size-fn (if (some? max-json-bytes) json-shape-size mcp/encoded-size)
                        compact? (true? compact)]
                    (when-not (contains? objects root-id)
                      (ex/raise :type :not-found
                                :code :shape-not-found
                                :hint "root shape not found in page"))
                    (let [walk       (get-cached-walk file-id page-id version objects root-id)
                          total      (count walk)
                          start      (get-start-index cursor page-id version root-id total)
                          [shapes end] (get-walk-window objects walk start limit budget size-fn compact?)
                          truncated? (< end total)]
                      [(cond-> {:revn revn
                                :page-id page-id
                                :root-id root-id
                                :total total
                                :shapes shapes
                                :truncated truncated?}
                         compact?
                         (assoc :compact true :defaults compact-defaults)

                         truncated?
                         (assoc :next-cursor (mcp/encode-cursor [page-id version end root-id 0])))
                       {:file-id file-id
                        :page-ids [page-id]
                        :revn revn
                        :token-id (mcp/get-token-id params)}])))))
