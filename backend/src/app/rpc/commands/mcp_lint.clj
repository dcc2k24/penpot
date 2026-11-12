;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.rpc.commands.mcp-lint
  "Read commands of the backend-native MCP that inspect the boards of a
  page: `get-mcp-page-lint` reports layout findings and
  `find-mcp-similar-boards` groups boards that look alike. See
  `mcp/docs/backend-mode-contract.md`."
  (:require
   [app.common.exceptions :as ex]
   [app.common.schema :as sm]
   [app.common.types.component :as ctk]
   [app.common.uuid :as uuid]
   [app.rpc :as-alias rpc]
   [app.rpc.climit :as-alias climit]
   [app.rpc.commands.mcp :as mcp]
   [app.rpc.doc :as-alias doc]
   [app.rpc.mcp-boards :as boards]
   [app.util.services :as sv]
   [clojure.string :as str]))

;; --- BUDGET AND LIMITS

(def ^:private budget-ns
  "Time a board scan may spend: five seconds."
  5000000000)

(def max-similar-boards
  "Most boards whose signatures are compared. More set `truncated`."
  1000)

(def ^:private pair-check-interval
  "The deadline of a similarity scan is checked after this many pairs."
  256)

(def ^:private clip-threshold
  "A control whose visible share of its box is below this is clipped."
  0.999)

(def max-skipped-ids
  "Most ids `find-mcp-similar-boards` lists in `skipped-small`."
  50)

(def ^:private default-min-overflow
  "The overflow in px at which `scroll-candidate` reports a frame."
  8)

(def ^:private content-types
  "The shape types that count as content of a board for the chrome rule."
  #{:rect :circle :path :bool :text :image :svg-raw})

(def ^:private backdrop-share
  "A shape of a drawing type whose box covers at least this share of its
  board is a backdrop, not content."
  0.9)

(def ^:private block-share
  "A frame or group with a fill or stroke of its own, and nothing inside it,
  counts as content only when its box is under this share of its board; a
  larger one is an empty panel."
  0.5)

(def ^:private min-chrome-boards
  "Fewest boards a chrome component occurs in."
  3)

(def ^:private min-chrome-share
  "Smallest share of the boards a chrome component occurs in."
  0.3)

(def ^:private max-chrome-area-share
  "A chrome component has instances of a mean area under this share of the
  mean area of the boards: a full-screen template is not chrome."
  0.5)

(def ^:private chrome-once-share
  "Smallest share of the boards holding a chrome component in which it
  occurs exactly once."
  0.9)

(def ^:private chrome-offset-share
  "Smallest share of the boards holding a chrome component in which it sits
  at the same offset from the top-left corner of the board."
  0.8)

(def ^:private chrome-offset-tolerance
  "Two offsets from the corner of the board are the same place when both
  their x and their y differ by at most this many px."
  2)

(def ^:private chrome-edge-distance
  "A chrome component touches an edge of its board when its box lies within
  this many px of the top or bottom edge, or of the left or right edge (see
  `chrome-rail-height-share`)."
  4)

(def ^:private chrome-rail-height-share
  "A chrome component touches the left or right edge of its board only when
  its box is at least this share of the board's height: a side rail, not a
  full-width banner."
  0.5)

(def ^:private chrome-everywhere-share
  "A chrome component that touches no edge of its board occurs in at least
  this share of the selected boards."
  0.7)

(def max-chrome-components
  "Most entries `chrome-components` of a lint reply lists."
  10)

(def ^:private lint-rules
  "The rules of `get-mcp-page-lint`, in the order of its counts."
  [:empty-board :instance-only-board :clipped-control :invisible-control
   :scroll-hidden-control :off-board-control :scroll-candidate :sibling-overlay])

(def ^:private control-rule-order
  "The rules a control can break, in the order they are reported: the
  first asked rule that applies wins."
  [:invisible-control :clipped-control :scroll-hidden-control :off-board-control])

;; --- REGEX

(defn- name-re-find
  "Whether `regex` finds a match in `chars`."
  [regex chars]
  (boolean (re-find (re-matcher regex chars))))

(defn- board-name-match
  "Whether the name of the board `shape` matches `regex`: true or false, or
  `:timeout` when the regex ran past `deadline`. A regex too deep for a name
  is refused as an invalid pattern. The name is read through the guarded
  `CharSequence` of `mcp.clj`."
  [regex deadline shape]
  (try
    (name-re-find regex (mcp/deadline-chars (str (:name shape)) deadline))
    (catch clojure.lang.ExceptionInfo cause
      (if (mcp/regex-timeout? cause)
        :timeout
        (throw cause)))
    (catch StackOverflowError _
      (ex/raise :type :validation
                :code :mcp-invalid-pattern
                :hint "board-name-regex is too deep to match these names"))))

(defn- compile-board-regex
  "`pattern` compiled, nil when there is none. An invalid regex is refused
  with a hint that names `board-name-regex`."
  [pattern]
  (try
    (mcp/compile-regex pattern)
    (catch clojure.lang.ExceptionInfo cause
      (if (= :mcp-invalid-regex (:code (ex-data cause)))
        (ex/raise :type :validation
                  :code :mcp-invalid-regex
                  :hint "board-name-regex is not a valid regular expression")
        (throw cause)))))

;; --- WALKS

(defn get-visible-entries
  "Pre-order `[level id]` entries of the visible shapes below `start-id`,
  down to `max-level` levels: the children of `start-id` are level 1. A
  hidden shape takes its subtree out of the walk. Missing shapes are
  skipped. See `app.rpc.mcp-boards`."
  [objects start-id max-level]
  (boards/get-visible-entries objects start-id max-level))

(defn get-visible-descendant-ids
  "Ids of the visible descendants of `shape-id`, in walk order."
  [objects shape-id]
  (mapv second (get-visible-entries objects shape-id Long/MAX_VALUE)))

(defn get-visible-child-ids
  "Ids of the visible direct children of `shape-id`, in stored order."
  [objects shape-id]
  (mapv second (get-visible-entries objects shape-id 1)))

;; --- BOXES

(defn get-box
  "The axis-aligned bounding box of the points of `shape`, in page space, as
  `{:x0 :y0 :x1 :y1}`. A rotated shape has its points turned, so the box
  follows them. A shape without points uses its stored `x`, `y`, `width`
  and `height`."
  [shape]
  (boards/get-box shape))

(defn box-area
  "The area of the box `b`, 0 when it is empty."
  [{:keys [x0 y0 x1 y1]}]
  (* (max 0 (- x1 x0))
     (max 0 (- y1 y0))))

(defn box-intersection
  "The box where the boxes `a` and `b` overlap. Its area is 0 when they do
  not overlap."
  [a b]
  {:x0 (max (:x0 a) (:x0 b))
   :y0 (max (:y0 a) (:y0 b))
   :x1 (min (:x1 a) (:x1 b))
   :y1 (min (:y1 a) (:y1 b))})

(defn box-overflow
  "How far the box `inner` sticks out of `outer`, per side, in px. A side
  inside `outer` is 0."
  [outer inner]
  {:left   (max 0 (- (:x0 outer) (:x0 inner)))
   :top    (max 0 (- (:y0 outer) (:y0 inner)))
   :right  (max 0 (- (:x1 inner) (:x1 outer)))
   :bottom (max 0 (- (:y1 inner) (:y1 outer)))})

(defn- round3
  "The number `x` rounded to three decimals."
  [x]
  (/ (Math/round (* 1000.0 x)) 1000.0))

;; --- CLIPPING AND SCROLLING

(defn- clips?
  "Whether the shape `shape` cuts its content: a frame clips unless its
  `:show-content` is true."
  [shape]
  (and (= :frame (:type shape))
       (not (true? (:show-content shape)))))

(defn- scrolling?
  "Whether the frame `shape` is a scroll container: its `:overflow-scroll`
  names an axis."
  [shape]
  (contains? #{:vertical :horizontal :both} (:overflow-scroll shape)))

(defn- scrolls-x?
  "Whether the frame `shape` scrolls horizontally."
  [shape]
  (contains? #{:horizontal :both} (:overflow-scroll shape)))

(defn- scrolls-y?
  "Whether the frame `shape` scrolls vertically."
  [shape]
  (contains? #{:vertical :both} (:overflow-scroll shape)))

(defn get-ancestor-frames
  "The frames above `control` up to and including the board `board-id`,
  nearest first."
  [objects control board-id]
  (loop [id    (:parent-id control)
         out   []
         steps 0]
    (let [shape (when (and (not= id uuid/zero)
                           (< steps mcp/max-ancestor-steps))
                  (get objects id))
          out   (cond-> out
                  (and (some? shape) (= :frame (:type shape))) (conj shape))]
      (if (or (nil? shape) (= id board-id))
        out
        (recur (:parent-id shape) out (inc steps))))))

(defn get-clipping-frames
  "The frames above `control` that cut it at rest, nearest first, up to and
  including the board `board-id`."
  [objects control board-id]
  (filterv clips? (get-ancestor-frames objects control board-id)))

(defn- get-clip-entries
  "The clip entries `{:id :full}` of the clipping frames among `frames`."
  [frames]
  (into []
        (comp (filter clips?)
              (map (fn [frame]
                     {:id   (:id frame)
                      :full (get-box frame)})))
        frames))

(defn shrink-box
  "The box `box` with `tolerance` px taken off each side. A box whose width
  or height is not above twice `tolerance` is returned as it is."
  [{:keys [x0 y0 x1 y1] :as box} tolerance]
  (if (and (pos? tolerance)
           (> (- x1 x0) (* 2 tolerance))
           (> (- y1 y0) (* 2 tolerance)))
    {:x0 (+ x0 tolerance)
     :y0 (+ y0 tolerance)
     :x1 (- x1 tolerance)
     :y1 (- y1 tolerance)}
    box))

(defn- get-box-share
  "The visible share of the box `box` after the clip `entries`: `:area` is its
  area, `:visible` the area left and `:fraction` the share left (1 when the
  box has no area)."
  [box entries]
  (let [area    (box-area box)
        left    (reduce (fn [acc entry] (box-intersection acc (:full entry)))
                        box
                        entries)
        visible (box-area left)]
    {:area     area
     :visible  visible
     :fraction (if (pos? area) (double (/ visible area)) 1.0)}))

(defn get-visible-state
  "The visible share of the control `shape` at rest, after the clip
  `entries`: `:area` is its own area, `:visible` the area left, `:fraction`
  the share left (1 when the control has no area) and `:clipped-by` the id
  of the entry that keeps the least of it (nil without entries). `:area`,
  `:visible` and `:fraction` are taken on the box of the control shrunk by
  `tolerance` px on each side (see `shrink-box`), so a cut thinner than
  `tolerance` does not count; 0 keeps the whole box. `:raw-fraction` is the
  share of the whole box, which the findings report."
  [shape entries tolerance]
  (let [box     (get-box shape)
        raw     (get-box-share box entries)
        judged  (if (pos? tolerance)
                  (get-box-share (shrink-box box tolerance) entries)
                  raw)
        clipped (when (seq entries)
                  (:id (apply min-key
                              #(box-area (box-intersection box (:full %)))
                              entries)))]
    (assoc judged
           :raw-fraction (:fraction raw)
           :clipped-by   clipped)))

(defn- reachable?
  "Whether the control `shape` can be scrolled into the view of the scroll
  frame `frame`. Its extent on each scrolled axis is replaced by the extent
  of `frame`; on the other axis it must fit inside `frame`, within
  `tolerance` px. The result is clipped by `frame` on that axis and by the
  clipping frames of `above` (the frames above `frame`, nearest first). It is
  reachable when some area is left."
  [shape frame above tolerance]
  (let [cb       (get-box shape)
        fb       (get-box frame)
        sx       (scrolls-x? frame)
        sy       (scrolls-y? frame)
        fits-x   (or sx (and (>= (:x0 cb) (- (:x0 fb) tolerance)) (<= (:x1 cb) (+ (:x1 fb) tolerance))))
        fits-y   (or sy (and (>= (:y0 cb) (- (:y0 fb) tolerance)) (<= (:y1 cb) (+ (:y1 fb) tolerance))))
        reach    {:x0 (if sx (:x0 fb) (:x0 cb))
                  :x1 (if sx (:x1 fb) (:x1 cb))
                  :y0 (if sy (:y0 fb) (:y0 cb))
                  :y1 (if sy (:y1 fb) (:y1 cb))}
        clipped  (reduce box-intersection
                         reach
                         (cons fb (map :full (get-clip-entries above))))]
    (and fits-x fits-y (pos? (box-area clipped)))))

(defn- get-scroll-frame
  "The nearest frame of `chain` (nearest first) that is a scroll container
  bringing `shape` into view, within `tolerance` px on the axis that does not
  scroll, or nil."
  [shape chain tolerance]
  (loop [frames chain]
    (when-let [frame (first frames)]
      (if (and (scrolling? frame)
               (reachable? shape frame (rest frames) tolerance))
        frame
        (recur (rest frames))))))

(defn control?
  "Whether `shape` is a control: a component instance head with a visible
  text descendant."
  [objects shape]
  (boolean
   (and (ctk/instance-head? shape)
        (some #(= :text (:type (get objects %)))
              (get-visible-descendant-ids objects (:id shape))))))

(defn- inside-selected?
  "Whether a selected board lies between `shape` and the board `board-id`.
  That board reports the shape, so the outer one does not."
  [objects selected board-id shape]
  (loop [id    (:parent-id shape)
         steps 0]
    (cond
      (or (nil? id) (= id board-id) (= id uuid/zero)
          (> steps mcp/max-ancestor-steps))
      false

      (contains? selected id)
      true

      :else
      (recur (:parent-id (get objects id)) (inc steps)))))

;; --- LINT FINDINGS

(defn- lint-finding
  "A finding of `rule` on `board`. `shape`, when given, is the shape the
  finding is about."
  [objects board rule shape detail]
  (cond-> {:rule       rule
           :board-id   (:id board)
           :board-name (:name board)
           :detail     detail}
    (some? shape)
    (assoc :shape-id (:id shape)
           :shape-name (:name shape)
           :path (mcp/shape-path objects shape))))

(defn- get-control-finding
  "The finding of `shape` as a control on `board`, or nil. Only the rules
  in `asked` count. Each control gets at most one finding, the first asked
  rule of `control-rule-order` that applies:
  `invisible-control` when nothing of it shows at rest, `clipped-control`
  when a clipping frame cuts it below the threshold at rest, and
  `scroll-hidden-control` when a scroll container brings it into view.
  `off-board-control` applies when it sticks out of the board by more than
  `tolerance` px on some side. A control inside a selected board below
  `board` is left to that board. The `visible-fraction` of an
  `invisible-control` is 0, as the rule judged the box shrunk by
  `tolerance`; when the share of the whole box is above 0, it is given as
  `raw-visible-fraction`."
  [objects board selected asked tolerance shape]
  (when (and (control? objects shape)
             (not (inside-selected? objects selected (:id board) shape)))
    (let [chain           (get-ancestor-frames objects shape (:id board))
          at-rest         (get-visible-state shape (get-clip-entries chain) tolerance)
          area            (:area at-rest)
          rest-invisible? (and (pos? area) (zero? (:visible at-rest)))
          rest-clipped?   (and (pos? area)
                               (pos? (:visible at-rest))
                               (< (:fraction at-rest) clip-threshold))
          scroll          (when (or rest-invisible? rest-clipped?)
                            (get-scroll-frame shape chain tolerance))
          overflow        (box-overflow (get-box board) (get-box shape))
          raw-fraction    (:raw-fraction at-rest)
          share           {:visible-fraction (round3 raw-fraction)
                           :clipped-by       (:clipped-by at-rest)}
          applies         {:invisible-control    (and rest-invisible? (nil? scroll))
                           :clipped-control      (and rest-clipped? (nil? scroll))
                           :scroll-hidden-control (some? scroll)
                           :off-board-control    (some #(> % tolerance) (vals overflow))}
          rule            (first (filter #(and (contains? asked %) (applies %))
                                         control-rule-order))]
      (case rule
        :invisible-control
        (lint-finding objects board rule shape
                      (cond-> (assoc share :visible-fraction 0)
                        (pos? raw-fraction)
                        (assoc :raw-visible-fraction (round3 raw-fraction))))

        :clipped-control
        (lint-finding objects board rule shape share)

        :scroll-hidden-control
        (lint-finding objects board rule shape
                      {:scrolled-by      (:id scroll)
                       :visible-fraction (round3 (:raw-fraction at-rest))})

        :off-board-control
        (lint-finding objects board rule shape {:overflow overflow})

        nil))))

(defn- in-copy?
  "Whether `shape` or one of its ancestors is a component copy shape (it has
  a `:shape-ref`). The walk goes up through `:parent-id` in `objects`, stops
  at the page root and at a missing shape, and goes at most
  `mcp/max-ancestor-steps` steps."
  [objects shape]
  (loop [shape shape
         steps 0]
    (cond
      (nil? shape)
      false

      (ctk/in-component-copy? shape)
      true

      (or (> steps mcp/max-ancestor-steps)
          (= (:parent-id shape) uuid/zero)
          (= (:parent-id shape) (:id shape)))
      false

      :else
      (recur (get objects (:parent-id shape)) (inc steps)))))

;; --- CHROME COMPONENTS

(defn- touches-edge?
  "Whether the head box `hb` touches an edge of the board box `bb`: it lies
  within `chrome-edge-distance` px of the top or the bottom edge, or within
  that distance of the left or the right edge and is at least
  `chrome-rail-height-share` of the board high (a side rail; a full-width
  banner in the middle of the board touches no edge)."
  [bb hb]
  (let [near (fn [d] (<= d chrome-edge-distance))
        tall (>= (* 2 (- (:y1 hb) (:y0 hb)))
                 (* 2 chrome-rail-height-share (- (:y1 bb) (:y0 bb))))]
    (boolean
     (or (near (- (:y0 hb) (:y0 bb)))
         (near (- (:y1 bb) (:y1 hb)))
         (and tall
              (or (near (- (:x0 hb) (:x0 bb)))
                  (near (- (:x1 bb) (:x1 hb)))))))))

(defn- get-chrome-stats
  "How the chrome of a page is found: for each group that has instance heads
  inside the boards `ids`, `{:boards n :count n :area a :once n :placements
  [[board dx dy edge?]] :cids #{id} :first-cid id :name s}`. A group is the
  set of the variants of a component when `component-variant` (a function of
  a component id that answers the id of its variant container, or nil) gives
  one, else the component id; the key of the map is that id. `:boards` is the
  number of boards holding at least one head, `:count` the number of heads,
  `:area` their summed box area, `:once` the number of boards that hold
  exactly one head, `:placements` the offset of each head from the top-left
  corner of its board with the number of the board and whether the head
  touches an edge of the board (see `touches-edge?`), `:cids` the component
  ids in the group, `:first-cid` the first of them and `:name` the name of the
  first head. Heads are visible shapes with a component id, at any depth
  inside a board, sub-instances included. Stops at `deadline` (nanoTime).
  Returns `{:stats {...} :mean-area a :timed-out? bool}`; `:mean-area` is the
  mean box area of the boards."
  [objects ids deadline component-variant]
  (loop [todo  ids
         stats {}
         total 0.0
         n     0]
    (cond
      (empty? todo)
      {:stats      stats
       :mean-area  (if (seq ids) (/ total (count ids)) 0.0)
       :timed-out? false}

      (>= (System/nanoTime) deadline)
      {:stats stats :mean-area 0.0 :timed-out? true}

      :else
      (let [board  (get objects (first todo))
            bb     (get-box board)
            heads  (->> (get-visible-descendant-ids objects (:id board))
                        (map #(get objects %))
                        (filter ctk/instance-head?))
            key-of (fn [head]
                     (let [cid (:component-id head)]
                       (or (when (some? component-variant) (component-variant cid))
                           cid)))
            place  (fn [head]
                     (let [hb (get-box head)]
                       [n
                        (- (:x0 hb) (:x0 bb))
                        (- (:y0 hb) (:y0 bb))
                        (touches-edge? bb hb)]))]
        (recur (rest todo)
               (reduce-kv (fn [stats k group]
                            (as-> stats $
                              (update-in $ [k :boards] (fnil inc 0))
                              (update-in $ [k :count] (fnil + 0) (count group))
                              (update-in $ [k :area] (fnil + 0)
                                         (reduce + (map #(box-area (get-box %)) group)))
                              (update-in $ [k :once] (fnil + 0) (if (= 1 (count group)) 1 0))
                              (update-in $ [k :name] #(or % (:name (first group))))
                              (update-in $ [k :first-cid] #(or % (:component-id (first group))))
                              (update-in $ [k :cids] (fnil into #{}) (map :component-id group))
                              (update-in $ [k :placements] (fnil into []) (map place group))))
                          stats
                          (group-by key-of heads))
               (+ total (box-area bb))
               (inc n))))))

(defn- at-least-share?
  "Whether `n` is at least `share` of `total`. The product is compared with a
  margin for rounding."
  [n total share]
  (>= n (- (* share total) 1e-9)))

(defn- near-offset?
  "Whether the placements `a` and `b` (`[board dx dy edge?]`) are within
  `chrome-offset-tolerance` px of each other on both axes."
  [a b]
  (and (<= (Math/abs (double (- (nth a 1) (nth b 1)))) chrome-offset-tolerance)
       (<= (Math/abs (double (- (nth a 2) (nth b 2)))) chrome-offset-tolerance)))

(defn- largest-cluster
  "The largest cluster of the `placements` (`[board dx dy edge?]`), as
  `{:boards n :edge? bool}`: `:boards` is the number of boards with a head in
  the cluster and `:edge?` whether most of its heads touch an edge. The
  clusters are made greedily in the order given: a placement joins the first
  cluster whose first member is within `chrome-offset-tolerance` px of it on
  both axes, else it opens one. The first of equal clusters wins."
  [placements]
  (let [clusters (reduce (fn [clusters p]
                           (let [i (first (keep-indexed (fn [i c] (when (near-offset? (first c) p) i))
                                                        clusters))]
                             (if (some? i)
                               (update clusters i conj p)
                               (conj clusters [p]))))
                         []
                         placements)]
    (reduce (fn [best members]
              (let [boards (count (into #{} (map first) members))]
                (if (or (nil? best) (> boards (:boards best)))
                  {:boards boards
                   :edge?  (> (* 2 (count (filter #(nth % 3) members))) (count members))}
                  best)))
            nil
            clusters)))

(defn- chrome-stats?
  "Whether the component stats `s` (see `get-chrome-stats`) make a chrome
  component of a scan of `total` boards with the mean box area `mean-area`:
  its heads occur in at least `min-chrome-boards` boards and `min-chrome-share`
  of them, their mean area is under `max-chrome-area-share` of `mean-area`,
  it occurs exactly once in at least `chrome-once-share` of the boards that
  hold it, and at the same offset (within `chrome-offset-tolerance` px, see
  `largest-cluster`) in at least `chrome-offset-share` of them. In addition
  the head at that offset touches an edge of its board (see
  `touches-edge?`), or it occurs in at least `chrome-everywhere-share` of the
  `total` boards."
  [s total mean-area]
  (let [boards (:boards s)]
    (and (>= boards min-chrome-boards)
         (at-least-share? boards total min-chrome-share)
         (< (/ (:area s) (max 1 (:count s))) (* max-chrome-area-share mean-area))
         (at-least-share? (:once s) boards chrome-once-share)
         (let [cluster (largest-cluster (:placements s))]
           (and (at-least-share? (:boards cluster) boards chrome-offset-share)
                (or (:edge? cluster)
                    (at-least-share? boards total chrome-everywhere-share)))))))

(defn get-chrome-components
  "The chrome components of the boards `ids`: the components that repeat in
  the same place across the screens and touch a screen edge or sit on most
  screens, such as a header, a footer or a side rail. A component is chrome
  when `chrome-stats?` holds for it. The variants of a component are one
  component (see `get-chrome-stats`). They come most boards first, then the
  smaller mean area, then the smaller id. Returns `{:chrome [{:id :name
  :boards :component-ids :variants?}] :timed-out? bool}`, all of them, none
  for a page without chrome. `:id` is the id of the variant container or of
  the component, `:component-ids` the set of the component ids in the group
  and `:variants` their number, present only when above 1. `component-name`
  is a function of a component id that answers its name, or nil to use the
  name of its first instance head. `component-variant` is a function of a
  component id that answers the id of its variant container, or nil to group
  by component id."
  ([objects ids deadline component-name]
   (get-chrome-components objects ids deadline component-name nil))
  ([objects ids deadline component-name component-variant]
   (let [{:keys [stats mean-area timed-out?]} (get-chrome-stats objects ids deadline component-variant)
         total (count ids)]
     {:chrome     (->> stats
                       (filter (fn [[_ s]] (chrome-stats? s total mean-area)))
                       (sort-by (fn [[k s]]
                                  [(- (:boards s))
                                   (/ (:area s) (max 1 (:count s)))
                                   (str k)]))
                       (mapv (fn [[k s]]
                               (cond-> {:id            k
                                        :name          (or (when component-name
                                                             (component-name (:first-cid s)))
                                                           (:name s))
                                        :boards        (:boards s)
                                        :component-ids (:cids s)}
                                 (> (count (:cids s)) 1)
                                 (assoc :variants (count (:cids s)))))))
      :timed-out? timed-out?})))

(defn- visible-paint?
  "Whether the frame or group `shape` has a visible fill, stroke or image fill
  of its own: a fill with a colour, a gradient or an image and an opacity
  above 0, or a stroke of a width and an opacity above 0."
  [shape]
  (boolean
   (or (some (fn [fill]
               (and (pos? (or (:fill-opacity fill) 1))
                    (or (some? (:fill-color fill))
                        (some? (:fill-color-gradient fill))
                        (some? (:fill-image fill)))))
             (:fills shape))
       (some (fn [stroke]
               (and (pos? (or (:stroke-opacity stroke) 1))
                    (pos? (or (:stroke-width stroke) 1))))
             (:strokes shape)))))

(defn- image-shape?
  "Whether `shape` is an image: its type is `:image`, or one of its fills
  holds an image and has an opacity above 0."
  [shape]
  (boolean
   (or (= :image (:type shape))
       (some (fn [fill]
               (and (some? (:fill-image fill))
                    (pos? (or (:fill-opacity fill) 1))))
             (:fills shape)))))

(defn get-board-content
  "What the board `board` holds, for the chrome rule: `{:chrome-ids [...]
  :content n}` over its visible descendants. `:chrome-ids` lists the
  components of `chrome-ids` that have an instance head in the board, in
  walk order, nested heads included. `:content` counts the content outside
  chrome instances (a chrome instance and what lies inside it do not count):
  a visible image (`image-shape?`: a shape of type `:image`, or any shape
  with an image fill), whatever its size; a visible shape of another drawing
  type (`content-types`) unless it is a backdrop, its box covering
  `backdrop-share` of the board or more (a background split into several
  shapes counts as content); and a
  visible frame or group with a visible fill, stroke or image fill of its
  own (`visible-paint?`) that holds no content and no chrome instance and has
  a box under `block-share` of the board."
  [objects board chrome-ids]
  (let [bb    (get-box board)
        barea (box-area bb)
        chrome-head? (fn [shape]
                       (and (ctk/instance-head? shape)
                            (contains? chrome-ids (:component-id shape))))
        order (loop [stack (into [] (map #(vector % (:id board) false))
                                 (reverse (get-visible-child-ids objects (:id board))))
                     out   []]
                (if-let [[id parent inside?] (peek stack)]
                  (let [shape (get objects id)
                        head? (chrome-head? shape)
                        skip? (or inside? head?)]
                    (recur (into (pop stack)
                                 (map #(vector % id skip?))
                                 (reverse (get-visible-child-ids objects id)))
                           (conj out {:id id :shape shape :parent parent
                                      :head? head? :skip? skip? :top-head? (and head? (not inside?))})))
                  out))]
    (loop [entries (rseq order)
           below   {}
           chrome  {}
           content 0]
      (if-let [{:keys [id shape parent skip? top-head?]} (first entries)]
        (if skip?
          (recur (next entries)
                 below
                 (cond-> chrome top-head? (update parent (fnil inc 0)))
                 content)
          (let [type    (:type shape)
                sub     (get below id 0)
                area    (box-area (box-intersection (get-box shape) bb))
                self?   (cond
                          (image-shape? shape)
                          true

                          (contains? content-types type)
                          (< area (* backdrop-share barea))

                          (contains? #{:frame :group} type)
                          (and (visible-paint? shape)
                               (zero? sub)
                               (zero? (get chrome id 0))
                               (< area (* block-share barea)))

                          :else
                          false)
                own     (if self? 1 0)]
            (recur (next entries)
                   (update below parent (fnil + 0) (+ own sub))
                   (update chrome parent (fnil + 0) (get chrome id 0))
                   (+ content own))))
        {:chrome-ids (into [] (comp (filter :head?) (map #(:component-id (:shape %))) (distinct))
                           order)
         :content    content}))))

;; --- SCROLL CANDIDATES

(defn get-scroll-overflow
  "How far the visible direct children of the frame `frame` reach past its
  right and bottom edges, in px, as `{:right :bottom}`. A child that covers
  the frame on both axes is left out: it starts left of the left edge and
  above the top edge and ends right of the right edge and below the bottom
  edge, each beyond `tolerance` px. Such a background bleeds past the frame on
  every side and does not make it scroll; a track that overflows on one axis,
  for example a carousel scrolled to the middle, still counts. A side with no
  child past the edge is 0. `tolerance` is 0 when absent."
  ([objects frame]
   (get-scroll-overflow objects frame 0))
  ([objects frame tolerance]
   (let [fb    (get-box frame)
         boxes (->> (get-visible-child-ids objects (:id frame))
                    (map #(get-box (get objects %)))
                    (remove #(and (< (:x0 %) (- (:x0 fb) tolerance))
                                  (< (:y0 %) (- (:y0 fb) tolerance))
                                  (> (:x1 %) (+ (:x1 fb) tolerance))
                                  (> (:y1 %) (+ (:y1 fb) tolerance)))))]
     {:right  (reduce max 0 (map #(- (:x1 %) (:x1 fb)) boxes))
      :bottom (reduce max 0 (map #(- (:y1 %) (:y1 fb)) boxes))})))

(defn get-scroll-suggestion
  "The `overflow-scroll` value that a frame with this `overflow` needs:
  `\"horizontal\"` when only the right side is over, `\"vertical\"` when only
  the bottom is, `\"both\"` when both are, and nil when neither is. A side is
  over when its overflow reaches `min-overflow` px and exceeds `tolerance`
  px, 0 when absent: an overflow of 0, or of float noise, never counts."
  ([overflow min-overflow]
   (get-scroll-suggestion overflow min-overflow 0))
  ([overflow min-overflow tolerance]
   (let [over? (fn [v] (and (pos? v) (>= v min-overflow) (> v tolerance)))
         right (over? (:right overflow))
         down  (over? (:bottom overflow))]
     (cond
       (and right down) "both"
       right            "horizontal"
       down             "vertical"))))

(defn- get-scroll-findings
  "The `scroll-candidate` findings of `board`: the frames inside it, the
  board included, that clip their content, have no `overflow-scroll` and
  have visible children that reach past their right or bottom edge (and do
  not cover the frame on both axes) by at least `min-overflow` px and more than `tolerance` px
  (see `get-scroll-overflow`). A selected board below `board` is left to
  itself, so a frame is reported once, under its innermost selected board."
  [objects selected board min-overflow tolerance]
  (loop [stack [[(:id board) (in-copy? objects (get objects (:parent-id board)))]]
         out   []]
    (if-let [[id copy?] (peek stack)]
      (let [shape     (get objects id)
            copy?     (boolean (or copy? (ctk/in-component-copy? shape)))
            overflow  (when (and (= :frame (:type shape))
                                 (clips? shape)
                                 (contains? #{nil :none} (:overflow-scroll shape)))
                        (get-scroll-overflow objects shape tolerance))
            suggested (when overflow (get-scroll-suggestion overflow min-overflow tolerance))
            children  (remove #(contains? selected %) (get-visible-child-ids objects id))]
        (recur (into (pop stack) (map #(vector % copy?)) (reverse children))
               (cond-> out
                 (some? suggested)
                 (conj (lint-finding objects board :scroll-candidate shape
                                     {:overflow          overflow
                                      :suggested         suggested
                                      :in-component-copy copy?})))))
      out)))

;; --- SIBLING OVERLAYS

(def ^:private overlay-cell
  "Side in px of the cells of the grid that `find-sibling-overlays` indexes the
  screens of a wrapper with."
  512)

(def ^:private overlay-max-cells
  "A shape that spans more grid cells than this is tested against every
  screen of its wrapper instead."
  1024)

(defn- grid-cells
  "The grid cells `[cx cy]` that the box `b` touches, or nil when there are
  more than `overlay-max-cells`."
  [b]
  (let [cx0 (long (Math/floor (/ (double (:x0 b)) overlay-cell)))
        cx1 (long (Math/floor (/ (double (:x1 b)) overlay-cell)))
        cy0 (long (Math/floor (/ (double (:y0 b)) overlay-cell)))
        cy1 (long (Math/floor (/ (double (:y1 b)) overlay-cell)))]
    (when (<= (* (inc (- cx1 cx0)) (inc (- cy1 cy0))) overlay-max-cells)
      (for [cx (range cx0 (inc cx1))
            cy (range cy0 (inc cy1))]
        [cx cy]))))

(defn find-sibling-overlays
  "The overlays of the selected screens `screen-ids` as `{:overlays
  {overlay-id screen-id} :timed-out? bool}`: the visible frames and groups,
  of any size, that are children of the same parent as a screen, when that
  parent is a wrapper (`wrapper-ids`: the wrapper frames the board selection
  found, see `app.rpc.mcp-boards/select-boards`), are not selected, are not
  and do not lie inside a component instance, and have at least
  `boards/overlay-min-share` of their own area over a screen of that parent
  (the one they overlap most). The screens of a wrapper are indexed in a grid,
  so each child is tested against the screens near it only. A shape that is
  not a sibling of a screen (a section child laid over a screen) is not
  found. The scan stops at `deadline` (nanoTime), and then `:timed-out?` is
  true. With no `wrapper-ids` (mode `depth`) the result is empty."
  [objects screen-ids wrapper-ids deadline]
  (let [selected (set screen-ids)
        parents  (into []
                       (comp (map #(get-in objects [% :parent-id]))
                             (filter #(contains? wrapper-ids %))
                             (distinct))
                       screen-ids)]
    (loop [parents parents
           out     {}
           n       0]
      (if-let [parent-id (first parents)]
        (let [children (get-visible-child-ids objects parent-id)
              screens  (filterv #(and (contains? selected %)
                                      (not (boards/in-component? objects (get objects %))))
                                children)
              boxes    (into {} (map (juxt identity #(get-box (get objects %)))) screens)
              grid     (reduce (fn [g sid]
                                 (reduce #(update %1 %2 (fnil conj []) sid) g (grid-cells (get boxes sid))))
                               {}
                               screens)
              result
              (loop [ids children
                     out out
                     n   n]
                (cond
                  (empty? ids)
                  {:out out :n n}

                  (and (zero? (mod n 256)) (>= (System/nanoTime) deadline))
                  {:out out :n n :timed-out? true}

                  :else
                  (let [id    (first ids)
                        shape (get objects id)
                        out'  (if (and (seq screens)
                                       (not (contains? selected id))
                                       (contains? #{:frame :group} (:type shape))
                                       (not (boards/in-component? objects shape)))
                                (let [box   (get-box shape)
                                      cells (grid-cells box)
                                      near  (if cells
                                              (distinct (mapcat #(get grid %) cells))
                                              screens)
                                      [share best] (reduce (fn [[bs b] sid]
                                                             (let [sh (boards/overlap-share box (get boxes sid))]
                                                               (if (> sh bs) [sh sid] [bs b])))
                                                           [0 nil]
                                                           near)]
                                  (cond-> out
                                    (and best (>= share boards/overlay-min-share))
                                    (assoc id best)))
                                out)]
                    (recur (rest ids) out' (inc n)))))]
          (if (:timed-out? result)
            {:overlays (:out result) :timed-out? true}
            (recur (rest parents) (:out result) (:n result))))
        {:overlays out :timed-out? false}))))

(defn get-covering-overlays
  "The overlays of `overlays` (`{overlay-id screen-id}`, see
  `find-sibling-overlays`) with their coverage, as `[{:overlay-id :screen-id
  :fraction :box}]` ordered by position (top, left) and then by id.
  `:fraction` is the share of the overlay box inside the screen box (see
  `boards/overlap-share`), `:box` the overlay box (see `get-box`). Only
  overlays at or over `boards/overlay-min-share` are kept. An overlay or
  screen missing from `objects` is skipped."
  [objects overlays]
  (->> overlays
       (keep (fn [[overlay-id screen-id]]
               (let [overlay (get objects overlay-id)
                     screen  (get objects screen-id)]
                 (when (and overlay screen)
                   (let [ob   (get-box overlay)
                         frac (boards/overlap-share ob (get-box screen))]
                     (when (>= frac boards/overlay-min-share)
                       {:overlay-id overlay-id
                        :screen-id  screen-id
                        :fraction   frac
                        :box        ob}))))))
       (sort-by (fn [{:keys [box overlay-id]}] [(:y0 box) (:x0 box) (str overlay-id)]))
       vec))

(defn- get-overlay-findings
  "The `sibling-overlay` findings of `board`: one for each entry of
  `covering` (see `get-covering-overlays`) whose screen is `board`."
  [objects board covering]
  (into []
        (comp (filter #(= (:id board) (:screen-id %)))
              (map (fn [{:keys [overlay-id fraction box]}]
                     (lint-finding objects board :sibling-overlay (get objects overlay-id)
                                   {:covered-fraction (round3 fraction)
                                    :overlay-box      {:x      (round3 (:x0 box))
                                                       :y      (round3 (:y0 box))
                                                       :width  (round3 (- (:x1 box) (:x0 box)))
                                                       :height (round3 (- (:y1 box) (:y0 box)))}}))))
        covering))

;; --- BOARD FINDINGS

(defn get-board-findings
  "Every lint finding on `board` among the rules `asked`. Options:
  `:min-shapes` is the fewest visible descendants a board may have without
  an `empty-board` finding; `:tolerance` the edge tolerance in px of the
  control and scroll rules; `:min-overflow` the overflow in px of
  `scroll-candidate`; `:selected` the ids of all selected boards; `:covering` the covering
  overlays of the scan (see `get-covering-overlays`); `:chrome`
  the chrome components `[{:id :component-ids}]` of the scan (see
  `get-chrome-components`), empty when there are none.
  A board that holds at least one chrome instance and no content outside
  chrome instances (see `get-board-content`) has an `instance-only-board`
  finding."
  [objects board {:keys [asked min-shapes tolerance min-overflow selected chrome covering]}]
  (let [ids        (get-visible-descendant-ids objects (:id board))
        component? (boards/in-component? objects board)
        chrome-ids (into #{} (mapcat #(or (:component-ids %) [(:id %)])) chrome)
        content    (when (and (not component?)
                              (seq chrome-ids)
                              (contains? asked :instance-only-board))
                     (get-board-content objects board chrome-ids))]
    (-> []
        (cond->
         (and (not component?)
              (contains? asked :empty-board)
              (< (count ids) min-shapes))
          (conj (lint-finding objects board :empty-board nil
                              {:shape-count (count ids)
                               :min-shapes  min-shapes}))

          (and (some? content)
               (seq (:chrome-ids content))
               (zero? (:content content)))
          (conj (lint-finding objects board :instance-only-board nil
                              {:chrome-component-ids (:chrome-ids content)
                               :content-shapes       0})))
        (into (when (contains? asked :scroll-candidate)
                (get-scroll-findings objects selected board
                                     (or min-overflow default-min-overflow)
                                     (or tolerance 0))))
        (into (keep #(get-control-finding objects board selected asked tolerance (get objects %)))
              ids)
        (into (when (contains? asked :sibling-overlay)
                (get-overlay-findings objects board covering))))))

(defn- count-lint-findings
  "How many findings each asked rule of `rules` has, keyed by rule name."
  [rules findings]
  (into {}
        (for [rule lint-rules
              :when (contains? rules rule)]
          [(name rule) (count (filter #(= rule (:rule %)) findings))])))

(defn get-lint-findings
  "The findings of the boards `ids`, in board order, among the `rules`
  asked. The scan stops when `deadline` (nanoTime) has passed, and then
  `:truncated` is true. Returns `{:findings [...] :boards n :truncated bool
  :chrome-components [...]}` with every finding found, not cut to a limit;
  `n` is the number of boards checked. `:chrome-components` lists the chrome
  components `{:id :name :boards :variants?}` of `get-chrome-components`, at most
  `max-chrome-components`, looked for only when `instance-only-board` is
  asked, else empty. Options: `selected` holds the ids of all selected
  boards, `tolerance` is the edge tolerance in px of the control and scroll
  rules (0 when absent), `min-overflow` the overflow in px of
  `scroll-candidate`, `component-name` a function of a component id that
  answers its name, or nil, and `component-variant` a function of a component
  id that answers the id of its variant container, or nil. `overlays` is the
  map `{overlay-id screen-id}` of `find-sibling-overlays`, for
  `sibling-overlay`; nil or empty for none."
  [objects ids {:keys [rules min-shapes deadline selected tolerance min-overflow component-name component-variant overlays]}]
  (let [found  (when (contains? rules :instance-only-board)
                 (get-chrome-components objects ids deadline component-name component-variant))
        chrome (or (:chrome found) [])
        opts   {:asked        rules
                :min-shapes   min-shapes
                :tolerance    (or tolerance 0)
                :min-overflow min-overflow
                :selected     selected
                :chrome       chrome
                :covering     (when (contains? rules :sibling-overlay)
                                (get-covering-overlays objects overlays))}
        listed (into [] (comp (take max-chrome-components) (map #(dissoc % :component-ids))) chrome)]
    (loop [ids      ids
           findings []
           checked  0]
      (cond
        (empty? ids)
        {:findings          findings
         :boards            checked
         :truncated         (boolean (:timed-out? found))
         :chrome-components listed}

        (>= (System/nanoTime) deadline)
        {:findings          findings
         :boards            checked
         :truncated         true
         :chrome-components listed}

        :else
        (let [board (get objects (first ids))]
          (recur (rest ids)
                 (into findings (get-board-findings objects board opts))
                 (inc checked)))))))

;; --- SIMILAR BOARDS

(defn get-shape-token
  "The token of a visible descendant: its type, its component id (nil for
  none) and, for a text shape, its characters with whitespace runs
  collapsed and trimmed."
  [shape]
  [(:type shape)
   (:component-id shape)
   (when (= :text (:type shape))
     (str/trim (str/replace (mcp/shape-characters shape) #"\s+" " ")))])

(defn get-signature
  "The multiset of the tokens of the shapes `ids`, as a map from token to
  count. Positions and names are not part of it."
  [objects ids]
  (frequencies (map #(get-shape-token (get objects %)) ids)))

(defn jaccard-index
  "The Jaccard index of the token multisets `a` and `b` (maps from token to
  count): the sum of the smaller counts over the sum of the larger ones."
  [a b]
  (let [tokens (into (set (keys a)) (keys b))
        mins   (reduce + (map #(min (get a % 0) (get b % 0)) tokens))
        maxs   (reduce + (map #(max (get a % 0) (get b % 0)) tokens))]
    (if (zero? maxs)
      1.0
      (double (/ mins maxs)))))

(defn- index-at-least
  "The Jaccard index of the interned multisets `a` and `b`, with `a` the
  smaller, or nil when it is below `threshold`. Only the tokens of `a` are
  walked, and the walk stops once the tokens left in `a` cannot reach the
  overlap the threshold needs."
  [a b threshold]
  (let [total (+ (:size a) (:size b))
        need  (/ (* threshold total) (+ 1 threshold))]
    (loop [entries (seq (:counts a))
           overlap 0
           seen    0]
      (cond
        (< (+ overlap (- (:size a) seen)) (- need 1e-9))
        nil

        (nil? entries)
        (let [index (double (/ overlap (- total overlap)))]
          (when (>= index threshold)
            index))

        :else
        (let [[token c] (first entries)]
          (recur (next entries)
                 (+ overlap (min c (get (:counts b) token 0)))
                 (+ seen c)))))))

(defn find-similar-pairs
  "The pairs `[i j index]` of the representatives `reps`, sorted by size
  ascending, whose Jaccard index is at least `threshold`. A pair is skipped
  without comparing when the smaller size over the larger one is already
  below the threshold; the sizes only grow with `j`, so the inner loop stops
  there. The deadline (nanoTime) is checked every `pair-check-interval`
  comparisons. Returns `{:edges [...] :compared n :timed-out? bool}`."
  [reps threshold deadline]
  (let [n (count reps)]
    (loop [i        0
           j        1
           compared 0
           edges    []]
      (cond
        (>= i n)
        {:edges edges :compared compared :timed-out? false}

        (>= j n)
        (recur (inc i) (+ i 2) compared edges)

        (< (:size (nth reps i)) (* threshold (:size (nth reps j))))
        (recur (inc i) (+ i 2) compared edges)

        (and (zero? (mod compared pair-check-interval))
             (>= (System/nanoTime) deadline))
        {:edges edges :compared compared :timed-out? true}

        :else
        (let [index (index-at-least (nth reps i) (nth reps j) threshold)]
          (recur i
                 (inc j)
                 (inc compared)
                 (cond-> edges
                   (some? index) (conj [i j index]))))))))

(defn link-components
  "The connected components of the `n` nodes joined by `edges`, a sequence
  of `[a b index]` node pairs. Each component is a vector of its node
  indexes, ascending. The components come in order of their first node."
  [n edges]
  (let [root   (fn [parent i]
                 (loop [i i]
                   (let [p (nth parent i)]
                     (if (= p i) i (recur p)))))
        parent (reduce (fn [parent [a b _]]
                         (let [ra (root parent a)
                               rb (root parent b)]
                           (if (= ra rb) parent (assoc parent rb ra))))
                       (vec (range n))
                       edges)]
    (vec (sort-by first (vals (group-by #(root parent %) (range n)))))))

(defn- intern-tokens
  "A map from each distinct token of the signatures `sigs` to a small int."
  [sigs]
  (reduce (fn [ids token]
            (if (contains? ids token)
              ids
              (assoc ids token (count ids))))
          {}
          (mapcat keys sigs)))

(defn find-similar-groups
  "The groups of two or more boards among `entries`, each with `:id`,
  `:index` (walk order) and `:signature`. Boards with equal signatures form
  an exact group with similarity 1. Distinct signatures whose Jaccard index
  is at least `threshold` are linked, and the merged group is not exact,
  with the lowest index of its linked pairs as similarity. Returns
  `{:groups [{:similarity :exact :boards}] :compared n :timed-out? bool}`,
  the groups unsorted. `compared` counts the pairs whose index was computed."
  [entries threshold deadline]
  (let [exact                      (group-by :signature entries)
        sigs                       (vec (distinct (map :signature entries)))
        ids                        (intern-tokens sigs)
        reps                       (->> sigs
                                        (map (fn [sig]
                                               {:boards (get exact sig)
                                                :counts (into {} (map (fn [[token c]]
                                                                        [(ids token) c]))
                                                              sig)
                                                :size   (reduce + (vals sig))}))
                                        (sort-by :size)
                                        vec)
        {:keys [edges compared timed-out?]} (find-similar-pairs reps threshold deadline)
        comps                      (link-components (count reps) edges)
        comp-of                    (into {} (for [[ci comp] (map-indexed vector comps)
                                                  i        comp]
                                              [i ci]))
        sims-of                    (group-by #(comp-of (first %)) edges)
        groups                     (keep-indexed
                                    (fn [ci comp]
                                      (let [boards (->> comp
                                                        (mapcat #(:boards (nth reps %)))
                                                        (sort-by :index))]
                                        (when (>= (count boards) 2)
                                          (if (= 1 (count comp))
                                            {:similarity 1.0 :exact true :boards boards}
                                            {:similarity (reduce min (map last (get sims-of ci)))
                                             :exact      false
                                             :boards     boards}))))
                                    comps)]
    {:groups     (vec groups)
     :compared   compared
     :timed-out? timed-out?}))

(defn- get-board-entries
  "Entries of the boards `ids` that have at least `min-shapes` visible
  descendants, in walk order, and the ids of the boards left out for having
  fewer (`:skipped`, in walk order). The scan stops at `max-similar-boards`
  entries or at `deadline`, and then `:truncated` is true."
  [objects ids min-shapes deadline]
  (loop [ids     ids
         out     []
         skipped []]
    (cond
      (empty? ids)
      {:entries out :skipped skipped :truncated false}

      (or (>= (count out) max-similar-boards)
          (>= (System/nanoTime) deadline))
      {:entries out :skipped skipped :truncated true}

      :else
      (let [board (get objects (first ids))
            descs (get-visible-descendant-ids objects (:id board))
            keep? (>= (count descs) min-shapes)]
        (recur (rest ids)
               (if keep?
                 (conj out {:id          (:id board)
                            :name        (:name board)
                            :path        (mcp/shape-path objects board)
                            :shape-count (count descs)
                            :index       (count out)
                            :signature   (get-signature objects descs)})
                 out)
               (cond-> skipped
                 (not keep?) (conj (:id board))))))))

;; --- COMMANDS

(defn- select-page-boards
  "The board selection of a command (see `app.rpc.mcp-boards`) for the page
  `objects`, with the board name `regex` (nil for none) matched under
  `deadline`. `depth` and `mode` are the parameters of the call."
  [objects regex depth mode deadline]
  (boards/select-boards objects
                        {:depth      depth
                         :mode       mode
                         :deadline   deadline
                         :name-match (when (some? regex)
                                       (partial board-name-match regex deadline))}))

(def ^:private schema:page-lint
  [:map {:title "get-mcp-page-lint" :closed true}
   [:file-id ::sm/uuid]
   [:page-id ::sm/uuid]
   [:depth {:optional true} [::sm/int {:min 1 :max boards/max-depth}]]
   [:mode {:optional true} [::sm/one-of #{:depth :auto}]]
   [:board-name-regex {:optional true} [:string {:max 200}]]
   [:min-shapes {:optional true} [::sm/int {:min 0 :max 1000}]]
   [:rules {:optional true} [:vector {:min 1 :max 9} [::sm/one-of lint-rules]]]
   [:tolerance {:optional true} [::sm/number {:min 0 :max 100}]]
   [:min-overflow {:optional true} [::sm/number {:min 0 :max 1000}]]
   [:limit {:optional true} [::sm/int {:min 1 :max 2000}]]
   [:offset {:optional true} [::sm/int {:min 0}]]])

(sv/defmethod ::get-mcp-page-lint
  "Lint findings on the boards of one page. Rules: `empty-board`,
  `instance-only-board` (the board holds an instance of a chrome component
  and nothing else: chrome components are the components that repeat in the
  same place across the screens and touch a screen edge or sit on most
  screens, such as a header, a footer or a side rail; a component is chrome
  when it occurs in at least 3 selected boards and 30 % of them, is on
  average under half the size of a board, occurs once in at least 90 % of
  the boards that hold it, sits at the same offset (within 2 px) in at least
  80 % of them, and either lies within 4 px of a board edge there or occurs
  in at least 70 % of the selected boards; the variants of a component count
  as one; `chrome-components` in the reply lists up to 10 as `{id, name,
  boards, variants?}`, empty for none; content is an image (a shape of type
  `image` or with an image fill) of any size, a visible shape of another
  drawing type that is not a backdrop (its box covers under 90 % of the
  board), or a frame or group with a fill or stroke of its own and nothing
  inside it that covers under 50 % of the board),
  `clipped-control`, `invisible-control`, `scroll-hidden-control` (a control
  that a scroll container brings into view, so it is reachable by
  scrolling), `off-board-control`, and `scroll-candidate` (a frame that clips
  its content, has no `overflow-scroll`, and has visible children (not a
  background that covers it on both axes) that reach past its right or bottom
  edge by at least
  `min-overflow` px and more than `tolerance` px; the detail suggests the
  value to set), and `sibling-overlay` (mode `auto` only: a visible board or group, of any size,
  that is not a screen, is a child of the same parent as a screen (its wrapper) and covers
  at least 50 % of its own area over that screen, such as a panel drawn over
  a screen; `board-id` is the covered screen, `shape-id` the overlay, the
  detail has `covered-fraction` and `overlay-box`; the overlay is not a
  board of the selection; mode `depth` reports none). A control is a component instance with a
  visible text, reported once under its innermost selected board. A
  `scroll-candidate` frame is reported once too. `empty-board` and
  `instance-only-board` skip a board that is, or lies inside, a component
  instance.
  Boards: with no `depth`, `board-name-regex` or `mode`, the screens are found
  by size (mode `auto`); with `depth` or `board-name-regex`, they are the
  visible frames at most `depth` levels below the page root (mode `depth`,
  default 1), filtered by `board-name-regex`. `mode` auto with
  `board-name-regex` keeps the boards of the automatic selection whose name
  matches; `mode` auto with `depth` is refused. `selection` in the reply
  says what was selected; in mode `auto` it lists `other-sizes`, the size
  classes of three frames or more that were not selected. In mode `depth`,
  `deeper-boards` counts the screen-sized frames (200 px or more on both
  sides) of repeated sizes below the selected boards; when it is not 0, call
  again without `depth`, or with a larger one. Mode `auto` has no
  `deeper-boards`.
  `tolerance` (px, 0 to 100, default 0.5) keeps rounding noise out of the
  edge tests: `off-board-control` needs an overflow above it on some side
  (the finding keeps the raw overflow), `clipped-control` and
  `invisible-control` take the visible share of the control box shrunk by it
  on each side, unless that would collapse the box, and a control within it
  of a scroll frame on the axis that does not scroll still counts as
  reachable. `visibleFraction` in a finding stays the share of the whole box,
  except for `invisible-control`: it is 0 there, and `raw-visible-fraction`
  gives the share of the whole box when that is above 0. 0 gives the strict
  tests.
  The findings come in board order, then rule order within a board, which
  depends only on the file at one `revn` and the params. `counts` totals
  every finding of the scan, and `total` is their sum, whatever `limit` and
  `offset` are. `offset` skips that many findings, then `limit` applies;
  `next-offset` is there when more remain after the ones returned, and the
  scan did not time out. An `offset` past the end gives an empty list.
  `truncated` is true when findings remain or the time limit cut the scan; a
  time cut also sets `timed-out true` and gives no `next-offset`: each call
  selects its boards under its own clock, so a later page could come from
  another list. `counts` and `total` then cover only what the scan reached.
  Five seconds at most."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]
                [:mcp-find/by-file :file-id]]
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:page-lint}
  [cfg {:keys [::rpc/profile-id file-id page-id depth mode board-name-regex min-shapes tolerance min-overflow limit offset] :as params}]
  (mcp/run-tool cfg "get-mcp-page-lint" params
                (fn []
                  (mcp/check-access! cfg params profile-id file-id)
                  (let [file     (mcp/load-file-for-page cfg file-id page-id [:components])
                        revn     (:revn file)
                        objects  (:objects (mcp/get-page-data cfg file-id revn (:data file) page-id))
                        regex    (compile-board-regex board-name-regex)
                        deadline (+ (System/nanoTime) budget-ns)
                        asked    (set (or (:rules params) lint-rules))
                        selected (select-page-boards objects regex depth mode deadline)
                        overlay-scan (when (contains? asked :sibling-overlay)
                                       (find-sibling-overlays objects (:ids selected)
                                                              (:wrapper-ids selected) deadline))
                        result   (get-lint-findings objects (:ids selected)
                                                    {:rules          asked
                                                     :min-shapes     (or min-shapes 3)
                                                     :tolerance      (or tolerance 0.5)
                                                     :min-overflow   (or min-overflow default-min-overflow)
                                                     :deadline       deadline
                                                     :selected       (set (:ids selected))
                                                     :overlays       (:overlays overlay-scan)
                                                     :component-name #(get-in file [:data :components % :name])
                                                     :component-variant #(get-in file [:data :components % :variant-id])})
                        all      (:findings result)
                        counts   (count-lint-findings asked all)
                        total    (count all)
                        start    (min total (or offset 0))
                        end      (min total (+ start (or limit 500)))
                        timed-out? (boolean (or (:timed-out? selected)
                                                (:timed-out? overlay-scan)
                                                (:truncated result)))]
                    [(cond-> {:revn              revn
                              :page-id           page-id
                              :boards            (:boards result)
                              :selection         (:selection selected)
                              :chrome-components (:chrome-components result)
                              :findings          (subvec all start end)
                              :counts            counts
                              :total             (reduce + 0 (vals counts))
                              :truncated         (boolean (or timed-out? (< end total)))}
                       (and (< end total) (not timed-out?))
                       (assoc :next-offset end)
                       timed-out?
                       (assoc :timed-out true)
                       (some? (:deeper-boards selected))
                       (assoc :deeper-boards (:deeper-boards selected)))
                     {:file-id  file-id
                      :page-ids [page-id]
                      :revn     revn
                      :token-id (mcp/get-token-id params)}]))))

(def ^:private schema:similar-boards
  [:map {:title "find-mcp-similar-boards" :closed true}
   [:file-id ::sm/uuid]
   [:page-id ::sm/uuid]
   [:depth {:optional true} [::sm/int {:min 1 :max boards/max-depth}]]
   [:mode {:optional true} [::sm/one-of #{:depth :auto}]]
   [:board-name-regex {:optional true} [:string {:max 200}]]
   [:threshold {:optional true} [::sm/number {:min 0.5 :max 1}]]
   [:min-shapes {:optional true} [::sm/int {:min 1 :max 1000}]]
   [:limit {:optional true} [::sm/int {:min 1 :max 500}]]])

(sv/defmethod ::find-mcp-similar-boards
  "Groups of boards that look alike on one page. A board's signature is the
  multiset of the types, component ids and text characters of its visible
  descendants, so positions and names do not count. Boards with equal
  signatures are exact copies; distinct signatures whose Jaccard index is at
  least `threshold` are near copies, merged by single link. `compared`
  counts the pairs whose index was computed. Only groups of two or more
  boards come back, the largest first. Boards with fewer visible
  descendants than `min-shapes` are left out of the comparison;
  `skipped-small` gives their count and their first 50 ids. The boards are
  selected as in `get-mcp-page-lint` (`depth`, `mode`, `board-name-regex`;
  `selection` in the reply, with `other-sizes` in mode `auto`, and
  `deeper-boards` in mode `depth`). A group whose boards have overlays (see
  `sibling-overlay` of `get-mcp-page-lint`, mode `auto`) lists them as
  `overlays: [{board-id, shape-id}]`, so copies that differ only by a panel
  laid over them can be told apart. Five seconds at most."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]
                [:mcp-find/by-file :file-id]]
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:similar-boards}
  [cfg {:keys [::rpc/profile-id file-id page-id depth mode board-name-regex threshold min-shapes limit] :as params}]
  (mcp/run-tool cfg "find-mcp-similar-boards" params
                (fn []
                  (mcp/check-access! cfg params profile-id file-id)
                  (let [file     (mcp/load-file-for-page cfg file-id page-id [])
                        revn     (:revn file)
                        objects  (:objects (mcp/get-page-data cfg file-id revn (:data file) page-id))
                        regex    (compile-board-regex board-name-regex)
                        deadline (+ (System/nanoTime) budget-ns)
                        selected (select-page-boards objects regex depth mode deadline)
                        overlay-scan (find-sibling-overlays objects (:ids selected)
                                                            (:wrapper-ids selected) deadline)
                        entries  (get-board-entries objects (:ids selected)
                                                    (or min-shapes 3) deadline)
                        similar  (find-similar-groups (:entries entries)
                                                      (or threshold 0.9) deadline)
                        ranked   (sort-by (juxt #(- (count (:boards %))) #(- (:similarity %)))
                                          (:groups similar))
                        covering (group-by :screen-id
                                           (get-covering-overlays objects (:overlays overlay-scan)))
                        limit    (or limit 100)]
                    [(cond-> {:revn          revn
                              :page-id       page-id
                              :boards        (count (:entries entries))
                              :selection     (:selection selected)
                              :skipped-small {:count (count (:skipped entries))
                                              :ids   (vec (take max-skipped-ids (:skipped entries)))}
                              :compared      (:compared similar)
                              :groups        (mapv (fn [group]
                                                     (let [overlays (into []
                                                                          (mapcat (fn [b]
                                                                                    (map (fn [o] {:board-id (:id b) :shape-id (:overlay-id o)})
                                                                                         (get covering (:id b)))))
                                                                          (:boards group))]
                                                       (cond-> {:similarity (:similarity group)
                                                                :exact      (:exact group)
                                                                :boards     (mapv #(select-keys % [:id :name :path :shape-count])
                                                                                  (:boards group))}
                                                         (seq overlays) (assoc :overlays overlays))))
                                                   (take limit ranked))
                              :truncated     (boolean (or (:timed-out? selected)
                                                          (:timed-out? overlay-scan)
                                                          (:truncated entries)
                                                          (:timed-out? similar)
                                                          (> (count ranked) limit)))}
                       (some? (:deeper-boards selected))
                       (assoc :deeper-boards (:deeper-boards selected)))
                     {:file-id  file-id
                      :page-ids [page-id]
                      :revn     revn
                      :token-id (mcp/get-token-id params)}]))))
