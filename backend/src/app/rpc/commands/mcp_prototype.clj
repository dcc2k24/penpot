;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.rpc.commands.mcp-prototype
  "Read commands of the backend-native MCP for prototypes: the interactions
  and flows of a page, and the paths drawn between its boards. See
  `mcp/docs/backend-mode-contract.md`."
  (:require
   [app.common.exceptions :as ex]
   [app.common.geom.rect :as grc]
   [app.common.schema :as sm]
   [app.common.types.path :as path]
   [app.common.uuid :as uuid]
   [app.rpc :as-alias rpc]
   [app.rpc.climit :as-alias climit]
   [app.rpc.commands.mcp :as mcp]
   [app.rpc.doc :as-alias doc]
   [app.util.services :as sv]))

;; --- CONSTANTS

(def search-budget-ns
  "Time a connector scan may spend: five seconds, as `find-mcp-shapes`.
  Read at call time, so a test can redefine it. The boards and the
  candidates are built inside this budget too."
  5000000000)

(def ^:private arrow-caps
  "Stroke caps that draw an arrow head."
  #{:line-arrow :triangle-arrow})

(def ^:private max-sampled-points
  "Most content points a connector scan uses for its ends and outline. A
  guard: a path above it is thinned, so one outline costs little."
  400)

(def ^:private band-share
  "Share of the length from each end that the outline band of that end
  covers."
  0.2)

(def ^:private head-ratio
  "How many times wider than the other end the head of an outline is."
  1.5)

(def ^:private min-head-width
  "Width in px that an outline end must be wider than to be a head."
  2.0)

(def ^:private snap-tie
  "Distance in px within which two boards count as equally near an end."
  1.0)

(def ^:private default-max-distance
  "Default for `max-distance` of `find-mcp-connectors`, in px."
  64)

;; --- GEOMETRY

(defn rect-distance
  "Distance from the point (`px`, `py`) to the box spanned by (`x1`, `y1`)
  and (`x2`, `y2`): zero inside it, edges included."
  [x1 y1 x2 y2 px py]
  (let [dx (double (max 0.0 (- x1 px) (- px x2)))
        dy (double (max 0.0 (- y1 py) (- py y2)))]
    (Math/sqrt (+ (* dx dx) (* dy dy)))))

(defn- rect-dist2
  "The squared distance of `rect-distance`, without the root."
  [x1 y1 x2 y2 px py]
  (let [dx (double (max 0.0 (- x1 px) (- px x2)))
        dy (double (max 0.0 (- y1 py) (- py y2)))]
    (+ (* dx dx) (* dy dy))))

(defn- dist2
  "Squared distance between the points `p` and `q`."
  [p q]
  (let [dx (double (- (:x q) (:x p)))
        dy (double (- (:y q) (:y p)))]
    (+ (* dx dx) (* dy dy))))

(defn- farthest-from
  "The point of the vector `points` farthest from `p`, the first one on a tie."
  [points p]
  (let [n (count points)]
    (loop [i    0
           best 0
           best-d -1.0]
      (if (< i n)
        (let [d (dist2 p (nth points i))]
          (if (> d best-d)
            (recur (inc i) i d)
            (recur (inc i) best best-d)))
        (nth points best)))))

(defn farthest-pair
  "The two ends of the outline `points` (a vector), as `[p q]`, or nil for
  fewer than two points. Three passes: the point farthest from the centroid,
  then the point farthest from it, then the point farthest from that
  second one. The last two are the ends. O(n), and exact for the convex
  outlines of lines and arrows."
  [points]
  (let [n (count points)]
    (when (>= n 2)
      (let [cx (/ (double (reduce + 0.0 (map :x points))) n)
            cy (/ (double (reduce + 0.0 (map :y points))) n)
            p1 (farthest-from points {:x cx :y cy})
            p2 (farthest-from points p1)
            p3 (farthest-from points p2)]
        [p2 p3]))))

(defn sample-points
  "The vector `points` thinned to at most `max-sampled-points` entries: every
  k-th point, with k the smallest that makes the count fit. A vector of
  up to `max-sampled-points` points comes back as it is."
  [points]
  (let [n (count points)]
    (if (<= n max-sampled-points)
      points
      (let [k (quot (+ n max-sampled-points -1) max-sampled-points)]
        (into [] (take-nth k) points)))))

(defn- line-distance
  "Distance from the point `p` to the line through `a` and `b`, which must
  be two different points."
  [a b p]
  (let [dx    (double (- (:x b) (:x a)))
        dy    (double (- (:y b) (:y a)))
        len   (Math/sqrt (+ (* dx dx) (* dy dy)))
        cross (double (- (* dx (- (:y p) (:y a)))
                         (* dy (- (:x p) (:x a)))))]
    (/ (Math/abs cross) len)))

(defn band-width
  "Greatest distance from the line `a`-`b` of the points of `points` whose
  place along that line lies between `lo` and `hi`, given as shares of its
  length from `a` (0) to `b` (1). Zero when no point lies in the band. `a`
  and `b` must differ."
  [a b points lo hi]
  (let [dx   (double (- (:x b) (:x a)))
        dy   (double (- (:y b) (:y a)))
        len2 (+ (* dx dx) (* dy dy))]
    (reduce (fn [width p]
              (let [t (/ (+ (* (- (:x p) (:x a)) dx)
                            (* (- (:y p) (:y a)) dy))
                         len2)]
                (if (<= lo t hi)
                  (max width (line-distance a b p))
                  width)))
            0.0
            points)))

(defn outline-head
  "The end of an outline that is its head: `:a` or `:b`, or nil when no end
  is clearly wider. `a` and `b` are the ends and `points` the outline points.
  An end is the head when its band is wider than `min-head-width` and at
  least `head-ratio` times the band of the other end. The band of an end
  holds the points within `band-share` of the length from that end."
  [a b points]
  (let [wa (band-width a b points 0.0 band-share)
        wb (band-width a b points (- 1.0 band-share) 1.0)]
    (cond
      (and (> wa min-head-width) (>= wa (* head-ratio wb))) :a
      (and (> wb min-head-width) (>= wb (* head-ratio wa))) :b
      :else nil)))

(defn- leftmost-first?
  "Whether `a` is the end further left, or, on the same x, the one further up."
  [a b]
  (or (< (:x a) (:x b))
      (and (= (:x a) (:x b))
           (<= (:y a) (:y b)))))

;; --- BOARDS

(defrecord Board
           [id name x1 y1 x2 y2 area depth ancestors])

(defn- shape-rect
  "The bounding box of `shape` as `[x1 y1 x2 y2]`. A shape with points takes
  it from them: a rotated board has its stored box turned, not its real
  one. A shape without points takes its stored box."
  [shape]
  (if-let [r (grc/points->rect (:points shape))]
    [(:x r) (:y r) (+ (:x r) (:width r)) (+ (:y r) (:height r))]
    [(:x shape) (:y shape) (+ (:x shape) (:width shape)) (+ (:y shape) (:height shape))]))

(defn- board-dist2
  "Squared distance from the point `p` to the box of `board`."
  [^Board board p]
  (rect-dist2 (:x1 board) (:y1 board) (:x2 board) (:y2 board) (:x p) (:y p)))

(defn- usable?
  "Whether `board` may take an end `a`-`b` that is not its own: it is not
  in `excluded`, and it does not hold both ends."
  [board excluded a b]
  (and (not (contains? excluded (:id board)))
       (not (and (zero? (board-dist2 board a))
                 (zero? (board-dist2 board b))))))

(defn- outermost
  "The board of `tied` that is an ancestor of the others, when one is; else
  the board with the largest area. A tie keeps the first board of `tied`."
  [tied]
  (or (first (filter (fn [board]
                       (every? #(or (= (:id %) (:id board))
                                    (contains? (:ancestors %) (:id board)))
                               tied))
                     tied))
      (reduce (fn [best board]
                (if (> (:area board) (:area best))
                  board
                  best))
              tied)))

(defn find-snap-board
  "The board that the end `p` snaps to among the vector `boards`, with its
  `:distance`. Boards in `excluded` (ids) and boards that hold both ends `a`
  and `b` are left out. Of the boards within `max-distance`, the nearest is
  taken; among those within `snap-tie` of it, the outermost (see
  `outermost`). Nil when no board is that near. Plain loops over the
  vector, no seqs: one scan for the nearest, one for the ties."
  [boards excluded a b p max-distance]
  (let [n      (count boards)
        max2   (* (double max-distance) max-distance)
        nearest (loop [i 0
                       best Double/POSITIVE_INFINITY]
                  (if (< i n)
                    (let [board (nth boards i)
                          d     (board-dist2 board p)]
                      (recur (inc i)
                             (if (and (<= d max2)
                                      (< d best)
                                      (usable? board excluded a b))
                               d
                               best)))
                    best))]
    (when (< nearest Double/POSITIVE_INFINITY)
      (let [limit (+ (Math/sqrt nearest) snap-tie)
            lim2  (* limit limit)
            tied  (loop [i   0
                         out []]
                    (if (< i n)
                      (let [board (nth boards i)]
                        (recur (inc i)
                               (if (and (<= (board-dist2 board p) lim2)
                                        (usable? board excluded a b))
                                 (conj out board)
                                 out)))
                      out))
            best  (outermost tied)]
        (assoc best :distance (Math/sqrt (board-dist2 best p)))))))

;; --- PAGE READS

(defn- visible?
  "Whether `shape` and each of its ancestors on the page is not hidden."
  [objects shape]
  (loop [current shape
         steps   0]
    (cond
      (nil? current)            true
      (true? (:hidden current)) false
      (or (= uuid/zero (:parent-id current))
          (>= steps mcp/max-ancestor-steps)) true
      :else (recur (get objects (:parent-id current)) (inc steps)))))

(defn- get-ancestors
  "The ancestors of `shape` on the page, nearest first, the page root left out."
  [objects shape]
  (loop [parent-id (:parent-id shape)
         out       []
         steps     0]
    (let [parent (when (and (some? parent-id)
                            (not= uuid/zero parent-id)
                            (< steps mcp/max-ancestor-steps))
                   (get objects parent-id))]
      (if (nil? parent)
        out
        (recur (:parent-id parent) (conj out parent) (inc steps))))))

(defn- get-walk-entries
  "The shapes of the page in walk order (stored order, pre-order) as
  `[level shape]`, the level being the depth in the tree (page root children
  are 2). The page root is left out."
  [objects]
  (into []
        (comp (remove #(= uuid/zero (second %)))
              (keep (fn [[level id]]
                      (when-let [shape (get objects id)]
                        [level shape]))))
        (mcp/page-preorder objects uuid/zero Long/MAX_VALUE false)))

(defn- get-boards
  "The visible frames of `entries` as Board records, in walk order."
  [objects entries]
  (into []
        (comp (filter (fn [[_ shape]]
                        (and (= :frame (:type shape))
                             (visible? objects shape))))
              (map (fn [[level shape]]
                     (let [[x1 y1 x2 y2] (shape-rect shape)]
                       (->Board (:id shape) (:name shape)
                                x1 y1 x2 y2
                                (* (- x2 x1) (- y2 y1))
                                level
                                (into #{} (map :id) (get-ancestors objects shape)))))))
        entries))

(defn- get-candidates
  "The candidate paths of `entries` as `[shape chain]`, `chain` being the
  ancestors of the shape, shallowest first and in walk order. A candidate
  is visible, and has no boolean ancestor (a boolean draws its children
  as one shape). With `within-id`, it lies under that shape."
  [objects entries within-id]
  (let [found (into []
                    (comp (filter (fn [[_ shape]]
                                    (and (contains? #{:path :bool} (:type shape))
                                         (visible? objects shape))))
                          (map (fn [[level shape]]
                                 [level shape (get-ancestors objects shape)]))
                          (filter (fn [[_ _ chain]]
                                    (and (not-any? #(= :bool (:type %)) chain)
                                         (or (nil? within-id)
                                             (some #(= within-id (:id %)) chain))))))
                    entries)]
    (mapv (fn [[_ shape chain]] [shape chain])
          (sort-by first found))))

;; --- CONNECTORS

(defn- get-ends
  "The ends of the path `shape` as `{:a p :b q :points ps :open? bool}`,
  where `ps` are the (sampled) content points. An open path with a stroke
  ends at its first and last points; any other shape ends at the two ends
  of `farthest-pair`. Nil for fewer than two points."
  [shape]
  (let [content (:content shape)
        points  (vec (path/get-points content))
        open?   (not-any? #(= :close-path (:command %)) content)]
    (when (>= (count points) 2)
      (let [sampled (sample-points points)]
        (if (and open? (seq (:strokes shape)))
          {:a (first points) :b (peek points) :points sampled :open? true}
          (let [[p q] (farthest-pair sampled)]
            {:a p :b q :points sampled :open? open?}))))))

(defn- arrow-cap?
  "Whether a stroke of `shape` has an arrow cap at `k`, `:stroke-cap-start`
  or `:stroke-cap-end`."
  [shape k]
  (boolean (some #(contains? arrow-caps (get % k)) (:strokes shape))))

(defn- get-direction
  "The direction of a connector `shape` with ends `a` and `b`, and the key of
  its head end (`:a`, `:b`, or nil). Only an open path has caps: an arrow
  cap on exactly one end makes that end the head (\"cap\"). Else the outline
  decides (\"shape\"). Else there is no head (\"none\")."
  [shape a b points open?]
  (let [start-arrow (and open? (arrow-cap? shape :stroke-cap-start))
        end-arrow   (and open? (arrow-cap? shape :stroke-cap-end))]
    (cond
      (and start-arrow (not end-arrow)) ["cap" :a]
      (and end-arrow (not start-arrow)) ["cap" :b]
      :else (if-let [head (and (pos? (dist2 a b))
                               (outline-head a b points))]
              ["shape" head]
              ["none" nil]))))

(defn- connector-end
  "The end map of the point `p` snapped to `board`."
  [p board]
  {:board-id   (:id board)
   :board-name (:name board)
   :distance   (:distance board)
   :x          (:x p)
   :y          (:y p)})

(defn- inside-own-frame?
  "Whether both ends `a` and `b` lie inside `frame`, the nearest ancestor
  frame of a candidate, and no board sits inside that frame."
  [frame frame-parents a b]
  (and (some? frame)
       (not (contains? frame-parents (:id frame)))
       (let [[x1 y1 x2 y2] (shape-rect frame)]
         (and (zero? (rect-dist2 x1 y1 x2 y2 (:x a) (:y a)))
              (zero? (rect-dist2 x1 y1 x2 y2 (:x b) (:y b)))))))

(defn- find-connector
  "The connector that the candidate `shape` makes between `boards`, or nil.
  Boards that are ancestors of `shape` are left out, and so are boards that
  hold both ends. A candidate whose both ends lie inside its nearest
  ancestor frame, when that frame holds no board, is skipped. Both ends must
  snap to two different boards."
  [boards frame-parents shape chain max-distance]
  (when-let [{:keys [a b points open?]} (get-ends shape)]
    (let [excluded (into #{} (map :id) chain)
          frame    (some #(when (= :frame (:type %)) %) chain)]
      (when-not (inside-own-frame? frame frame-parents a b)
        (let [board-a (find-snap-board boards excluded a b a max-distance)
              board-b (find-snap-board boards excluded a b b max-distance)]
          (when (and (some? board-a)
                     (some? board-b)
                     (not= (:id board-a) (:id board-b)))
            (let [[direction head] (get-direction shape a b points open?)
                  [from-key to-key] (cond
                                      (= head :a) [:b :a]
                                      (= head :b) [:a :b]
                                      (leftmost-first? a b) [:a :b]
                                      :else [:b :a])
                  ends {:a [a board-a] :b [b board-b]}
                  [from-p from-board] (get ends from-key)
                  [to-p to-board]     (get ends to-key)]
              {:id        (:id shape)
               :name      (:name shape)
               :type      (:type shape)
               :direction direction
               :length    (Math/sqrt (dist2 a b))
               :from      (connector-end from-p from-board)
               :to        (connector-end to-p to-board)})))))))

(defn- scan-connectors
  "The connectors among `candidates` (`[shape chain]` pairs, in order), up
  to `limit` of them, and until `deadline` (nanoTime). Returns `{:scanned n
  :connectors [...] :truncated bool}`. Truncated when a connector past
  `limit` exists or the deadline passes before the candidates end."
  [boards frame-parents candidates max-distance limit deadline]
  (loop [todo    (seq candidates)
         scanned 0
         found   []]
    (cond
      (> (count found) limit)
      {:scanned scanned :connectors (vec (take limit found)) :truncated true}

      (nil? todo)
      {:scanned scanned :connectors found :truncated false}

      (>= (System/nanoTime) deadline)
      {:scanned scanned :connectors (vec (take limit found)) :truncated true}

      :else
      (let [[shape chain] (first todo)
            connector     (find-connector boards frame-parents shape chain max-distance)]
        (recur (next todo)
               (inc scanned)
               (cond-> found
                 (some? connector) (conj connector)))))))

;; --- INTERACTIONS

(defn- interaction-out
  "The stored `interaction`, with `:destination-name` when its destination is
  a shape of the page."
  [objects interaction]
  (let [dest (get objects (:destination interaction))]
    (cond-> interaction
      (some? dest) (assoc :destination-name (:name dest)))))

(defn- interaction-shape-out
  "The entry of `get-mcp-interactions` for `shape`."
  [objects shape]
  {:id           (:id shape)
   :name         (:name shape)
   :type         (:type shape)
   :frame-id     (:frame-id shape)
   :path         (mcp/shape-path objects shape)
   :interactions (mapv #(interaction-out objects %) (:interactions shape))})

;; --- SCHEMAS

(def ^:private schema:interactions
  [:map {:title "get-mcp-interactions" :closed true}
   [:file-id ::sm/uuid]
   [:page-id ::sm/uuid]
   [:limit {:optional true} [::sm/int {:min 1 :max 5000}]]])

(def ^:private schema:connectors
  [:map {:title "find-mcp-connectors" :closed true}
   [:file-id ::sm/uuid]
   [:page-id ::sm/uuid]
   [:max-distance {:optional true} [::sm/number {:min 0 :max 2000}]]
   [:limit {:optional true} [::sm/int {:min 1 :max 2000}]]
   [:within-id {:optional true} ::sm/uuid]])

;; --- COMMAND: get-mcp-interactions

(sv/defmethod ::get-mcp-interactions
  "Every shape of a page with at least one interaction, in walk order, and
  the flows of the page. Each interaction is the stored map, plus
  `destination-name` when its destination is a shape of the page. At most
  `limit` shapes, and at most the response byte budget; `truncated` says
  when a cut was made. The totals count the whole page."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]]
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:interactions}
  [cfg {:keys [::rpc/profile-id file-id page-id limit] :as params}]
  (mcp/run-tool cfg "get-mcp-interactions" params
                (fn []
                  (mcp/check-access! cfg params profile-id file-id)
                  (let [file     (mcp/load-file-for-page cfg file-id page-id [])
                        data     (:data file)
                        revn     (:revn file)
                        page     (mcp/get-page-data cfg file-id revn data page-id)
                        objects  (:objects page)
                        limit    (or limit 1000)
                        marked   (into [] (comp (map second)
                                                (filter #(seq (:interactions %))))
                                       (get-walk-entries objects))
                        [shapes cut?]
                        (mcp/within-budget #(interaction-shape-out objects %)
                                           (take limit marked)
                                           mcp/response-byte-budget)
                        flows    (into []
                                       (map (fn [flow]
                                              {:id              (:id flow)
                                               :name            (:name flow)
                                               :starting-frame  (:starting-frame flow)
                                               :starting-frame-name
                                               (:name (get objects (:starting-frame flow)))}))
                                       (sort-by (juxt :name :id) (vals (:flows page))))]
                    [{:revn revn
                      :page-id page-id
                      :flows flows
                      :shapes shapes
                      :total-interactions (reduce + (map #(count (:interactions %)) marked))
                      :total-shapes (count marked)
                      :truncated (or cut? (> (count marked) limit))}
                     {:file-id file-id
                      :page-ids [page-id]
                      :revn revn
                      :token-id (mcp/get-token-id params)}]))))

;; --- COMMAND: find-mcp-connectors

(sv/defmethod ::find-mcp-connectors
  "Paths drawn as connectors between two boards of a page: both ends snap
  to two different boards within `max-distance`. The direction is `cap`
  when one end of an open path has an arrow cap, `shape` when the outline
  is clearly wider at one end, else `none`. Candidates are looked at
  shallowest first. `within-id` limits them to the shapes under one shape.
  The scan stops at five seconds or at `limit` connectors, and says so with
  `truncated`."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]
                [:mcp-find/by-file :file-id]]
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:connectors}
  [cfg {:keys [::rpc/profile-id file-id page-id max-distance limit within-id] :as params}]
  (mcp/run-tool cfg "find-mcp-connectors" params
                (fn []
                  (mcp/check-access! cfg params profile-id file-id)
                  (let [file         (mcp/load-file-for-page cfg file-id page-id [])
                        data         (:data file)
                        revn         (:revn file)
                        objects      (:objects (mcp/get-page-data cfg file-id revn data page-id))
                        deadline     (+ (System/nanoTime) search-budget-ns)
                        _            (when (and (some? within-id)
                                                (not (contains? objects within-id)))
                                       (ex/raise :type :not-found
                                                 :code :shape-not-found
                                                 :hint "within-id shape not found in page"))
                        entries      (get-walk-entries objects)
                        boards       (get-boards objects entries)
                        frame-parents (reduce (fn [acc board] (into acc (:ancestors board)))
                                              #{}
                                              boards)
                        candidates   (get-candidates objects entries within-id)
                        result       (scan-connectors boards frame-parents candidates
                                                      (or max-distance default-max-distance)
                                                      (or limit 500)
                                                      deadline)]
                    [{:revn revn
                      :page-id page-id
                      :scanned (:scanned result)
                      :connectors (:connectors result)
                      :truncated (:truncated result)}
                     {:file-id file-id
                      :page-ids [page-id]
                      :revn revn
                      :token-id (mcp/get-token-id params)}]))))
