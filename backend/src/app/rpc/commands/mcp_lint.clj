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
   [app.common.geom.rect :as grc]
   [app.common.schema :as sm]
   [app.common.types.component :as ctk]
   [app.common.uuid :as uuid]
   [app.rpc :as-alias rpc]
   [app.rpc.climit :as-alias climit]
   [app.rpc.commands.mcp :as mcp]
   [app.rpc.doc :as-alias doc]
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

(def ^:private lint-rules
  "The rules of `get-mcp-page-lint`, in the order of its counts."
  [:empty-board :instance-only-board :clipped-control :invisible-control
   :scroll-hidden-control :off-board-control])

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

(defn- visible-child-entries
  "Stack entries `[level id]` for the visible children of `parent-id`, the
  first child on top. Hidden children are left out."
  [objects parent-id level]
  (->> (:shapes (get objects parent-id))
       (remove #(:hidden (get objects %)))
       reverse
       (mapv #(vector level %))))

(defn get-visible-entries
  "Pre-order `[level id]` entries of the visible shapes below `start-id`,
  down to `max-level` levels: the children of `start-id` are level 1. A
  hidden shape takes its subtree out of the walk. Missing shapes are
  skipped."
  [objects start-id max-level]
  (loop [stack (visible-child-entries objects start-id 1)
         out   []]
    (if-let [[level id] (peek stack)]
      (let [stack (pop stack)]
        (if (some? (get objects id))
          (recur (cond-> stack
                   (< level max-level)
                   (into (visible-child-entries objects id (inc level))))
                 (conj out [level id]))
          (recur stack out)))
      out)))

(defn get-visible-descendant-ids
  "Ids of the visible descendants of `shape-id`, in walk order."
  [objects shape-id]
  (mapv second (get-visible-entries objects shape-id Long/MAX_VALUE)))

(defn get-visible-child-ids
  "Ids of the visible direct children of `shape-id`, in stored order."
  [objects shape-id]
  (mapv second (get-visible-entries objects shape-id 1)))

(defn find-boards
  "The boards of the page `objects`, in walk order: the visible frames at
  most `depth` levels below the page root whose name matches `regex` (nil
  matches all). The scan stops at `deadline` (nanoTime), and then
  `:timed-out?` is true. Returns `{:ids [...] :timed-out? bool}`."
  [objects depth regex deadline]
  (loop [entries (seq (get-visible-entries objects uuid/zero depth))
         ids     []]
    (cond
      (nil? entries)
      {:ids ids :timed-out? false}

      (>= (System/nanoTime) deadline)
      {:ids ids :timed-out? true}

      :else
      (let [id      (second (first entries))
            shape   (get objects id)
            matched (cond
                      (not= :frame (:type shape)) false
                      (nil? regex)                true
                      :else                       (board-name-match regex deadline shape))]
        (if (= :timeout matched)
          {:ids ids :timed-out? true}
          (recur (next entries)
                 (cond-> ids matched (conj id))))))))

;; --- BOXES

(defn get-box
  "The axis-aligned bounding box of the points of `shape`, in page space, as
  `{:x0 :y0 :x1 :y1}`. A rotated shape has its points turned, so the box
  follows them. A shape without points uses its stored `x`, `y`, `width`
  and `height`."
  [shape]
  (if-let [bounds (grc/points->rect (:points shape))]
    {:x0 (:x bounds)
     :y0 (:y bounds)
     :x1 (+ (:x bounds) (:width bounds))
     :y1 (+ (:y bounds) (:height bounds))}
    {:x0 (:x shape)
     :y0 (:y shape)
     :x1 (+ (:x shape) (:width shape))
     :y1 (+ (:y shape) (:height shape))}))

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

(defn get-visible-state
  "The visible share of the control `shape` at rest, after the clip
  `entries`: `:area` is its own area, `:visible` the area left, `:fraction`
  the share left (1 when the control has no area) and `:clipped-by` the id
  of the entry that keeps the least of it (nil without entries)."
  [shape entries]
  (let [box     (get-box shape)
        area    (box-area box)
        left    (reduce (fn [acc entry] (box-intersection acc (:full entry)))
                        box
                        entries)
        visible (box-area left)
        clipped (when (seq entries)
                  (:id (apply min-key
                              #(box-area (box-intersection box (:full %)))
                              entries)))]
    {:area       area
     :visible    visible
     :fraction   (if (pos? area) (double (/ visible area)) 1.0)
     :clipped-by clipped}))

(defn- reachable?
  "Whether the control `shape` can be scrolled into the view of the scroll
  frame `frame`. Its extent on each scrolled axis is replaced by the extent
  of `frame`; on the other axis it must fit inside `frame`. The result is
  clipped by `frame` on that axis and by the clipping frames of `above`
  (the frames above `frame`, nearest first). It is reachable when some area
  is left."
  [shape frame above]
  (let [cb       (get-box shape)
        fb       (get-box frame)
        sx       (scrolls-x? frame)
        sy       (scrolls-y? frame)
        fits-x   (or sx (and (>= (:x0 cb) (:x0 fb)) (<= (:x1 cb) (:x1 fb))))
        fits-y   (or sy (and (>= (:y0 cb) (:y0 fb)) (<= (:y1 cb) (:y1 fb))))
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
  bringing `shape` into view, or nil."
  [shape chain]
  (loop [frames chain]
    (when-let [frame (first frames)]
      (if (and (scrolling? frame)
               (reachable? shape frame (rest frames)))
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
  `off-board-control` applies when it sticks out of the board. A control
  inside a selected board below `board` is left to that board."
  [objects board selected asked shape]
  (when (and (control? objects shape)
             (not (inside-selected? objects selected (:id board) shape)))
    (let [chain           (get-ancestor-frames objects shape (:id board))
          at-rest         (get-visible-state shape (get-clip-entries chain))
          area            (:area at-rest)
          rest-invisible? (and (pos? area) (zero? (:visible at-rest)))
          rest-clipped?   (and (pos? area)
                               (pos? (:visible at-rest))
                               (< (:fraction at-rest) clip-threshold))
          scroll          (when (or rest-invisible? rest-clipped?)
                            (get-scroll-frame shape chain))
          overflow        (box-overflow (get-box board) (get-box shape))
          share           {:visible-fraction (round3 (:fraction at-rest))
                           :clipped-by       (:clipped-by at-rest)}
          applies         {:invisible-control    (and rest-invisible? (nil? scroll))
                           :clipped-control      (and rest-clipped? (nil? scroll))
                           :scroll-hidden-control (some? scroll)
                           :off-board-control    (some pos? (vals overflow))}
          rule            (first (filter #(and (contains? asked %) (applies %))
                                         control-rule-order))]
      (case rule
        (:invisible-control :clipped-control)
        (lint-finding objects board rule shape share)

        :scroll-hidden-control
        (lint-finding objects board rule shape
                      {:scrolled-by      (:id scroll)
                       :visible-fraction (round3 (:fraction at-rest))})

        :off-board-control
        (lint-finding objects board rule shape {:overflow overflow})

        nil))))

(defn- in-component?
  "Whether `shape` is, or lies inside, a component instance: it or one of its
  ancestors is a component head, a main instance or a component copy. The
  walk goes up through `:parent-id` in `objects` and stops at the page root,
  at a missing shape, at a shape that is its own parent, and after
  `mcp/max-ancestor-steps` steps."
  [objects shape]
  (loop [shape  shape
         steps  0]
    (let [parent-id (:parent-id shape)]
      (cond
        (nil? shape)
        false

        (or (ctk/instance-head? shape)
            (ctk/main-instance? shape)
            (ctk/in-component-copy? shape))
        true

        (or (> steps mcp/max-ancestor-steps)
            (= parent-id uuid/zero)
            (= parent-id (:id shape)))
        false

        :else
        (recur (get objects parent-id) (inc steps))))))

(defn get-board-findings
  "Every lint finding on `board` among the rules `asked`. `min-shapes` is
  the fewest visible descendants a board may have without an
  `empty-board` finding. `selected` holds the ids of all selected boards."
  [objects selected asked min-shapes board]
  (let [ids        (get-visible-descendant-ids objects (:id board))
        children   (get-visible-child-ids objects (:id board))
        only       (get objects (first children))
        component? (in-component? objects board)]
    (into (cond-> []
            (and (not component?)
                 (contains? asked :empty-board)
                 (< (count ids) min-shapes))
            (conj (lint-finding objects board :empty-board nil
                                {:shape-count (count ids)
                                 :min-shapes  min-shapes}))

            (and (not component?)
                 (contains? asked :instance-only-board)
                 (= 1 (count children))
                 (ctk/instance-head? only))
            (conj (lint-finding objects board :instance-only-board only
                                {:component-id (:component-id only)
                                 :shape-name   (:name only)})))
          (keep #(get-control-finding objects board selected asked (get objects %)))
          ids)))

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
  `:truncated` is true. Returns `{:findings [...] :boards n :truncated bool}`
  with every finding found, not cut to a limit; `n` is the number of boards
  checked. `selected` holds the ids of all selected boards."
  [objects ids {:keys [rules min-shapes deadline selected]}]
  (loop [ids      ids
         findings []
         checked  0]
    (cond
      (empty? ids)
      {:findings findings :boards checked :truncated false}

      (>= (System/nanoTime) deadline)
      {:findings findings :boards checked :truncated true}

      :else
      (let [board (get objects (first ids))]
        (recur (rest ids)
               (into findings
                     (get-board-findings objects selected rules min-shapes board))
               (inc checked))))))

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
  descendants, in walk order. The scan stops at `max-similar-boards`
  entries or at `deadline`, and then `:truncated` is true."
  [objects ids min-shapes deadline]
  (loop [ids ids
         out []]
    (cond
      (empty? ids)
      {:entries out :truncated false}

      (or (>= (count out) max-similar-boards)
          (>= (System/nanoTime) deadline))
      {:entries out :truncated true}

      :else
      (let [board (get objects (first ids))
            descs (get-visible-descendant-ids objects (:id board))]
        (recur (rest ids)
               (if (>= (count descs) min-shapes)
                 (conj out {:id          (:id board)
                            :name        (:name board)
                            :path        (mcp/shape-path objects board)
                            :shape-count (count descs)
                            :index       (count out)
                            :signature   (get-signature objects descs)})
                 out))))))

;; --- COMMANDS

(def ^:private schema:page-lint
  [:map {:title "get-mcp-page-lint" :closed true}
   [:file-id ::sm/uuid]
   [:page-id ::sm/uuid]
   [:depth {:optional true} [::sm/int {:min 1 :max 5}]]
   [:board-name-regex {:optional true} [:string {:max 200}]]
   [:min-shapes {:optional true} [::sm/int {:min 0 :max 1000}]]
   [:rules {:optional true} [:vector {:min 1 :max 8} [::sm/one-of lint-rules]]]
   [:limit {:optional true} [::sm/int {:min 1 :max 2000}]]])

(sv/defmethod ::get-mcp-page-lint
  "Lint findings on the boards of one page. Rules: `empty-board`,
  `instance-only-board`, `clipped-control`, `invisible-control`,
  `scroll-hidden-control` (a control that a scroll container brings into
  view, so it is reachable by scrolling), and `off-board-control`. A control
  is a component instance with a visible text, reported once under its
  innermost selected board. `empty-board` and `instance-only-board` skip a
  board that is, or lies inside, a component instance. Boards are the visible
  frames at most `depth` levels below the page root, optionally filtered by
  `board-name-regex`.
  `counts` totals every finding of the scan, also when `limit` cuts the
  list. Five seconds at most."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]
                [:mcp-find/by-file :file-id]]
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:page-lint}
  [cfg {:keys [::rpc/profile-id file-id page-id depth board-name-regex min-shapes limit] :as params}]
  (mcp/run-tool cfg "get-mcp-page-lint" params
                (fn []
                  (mcp/check-access! cfg params profile-id file-id)
                  (let [file     (mcp/load-file-for-page cfg file-id page-id [])
                        revn     (:revn file)
                        objects  (:objects (mcp/get-page-data cfg file-id revn (:data file) page-id))
                        regex    (compile-board-regex board-name-regex)
                        deadline (+ (System/nanoTime) budget-ns)
                        asked    (set (or (:rules params) lint-rules))
                        boards   (find-boards objects (or depth 1) regex deadline)
                        result   (get-lint-findings objects (:ids boards)
                                                    {:rules      asked
                                                     :min-shapes (or min-shapes 3)
                                                     :deadline   deadline
                                                     :selected   (set (:ids boards))})
                        all      (:findings result)
                        limit    (or limit 500)]
                    [{:revn      revn
                      :page-id   page-id
                      :boards    (:boards result)
                      :findings  (vec (take limit all))
                      :counts    (count-lint-findings asked all)
                      :truncated (boolean (or (:timed-out? boards)
                                              (:truncated result)
                                              (> (count all) limit)))}
                     {:file-id  file-id
                      :page-ids [page-id]
                      :revn     revn
                      :token-id (mcp/get-token-id params)}]))))

(def ^:private schema:similar-boards
  [:map {:title "find-mcp-similar-boards" :closed true}
   [:file-id ::sm/uuid]
   [:page-id ::sm/uuid]
   [:depth {:optional true} [::sm/int {:min 1 :max 5}]]
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
  boards come back, the largest first. Five seconds at most."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]
                [:mcp-find/by-file :file-id]]
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:similar-boards}
  [cfg {:keys [::rpc/profile-id file-id page-id depth board-name-regex threshold min-shapes limit] :as params}]
  (mcp/run-tool cfg "find-mcp-similar-boards" params
                (fn []
                  (mcp/check-access! cfg params profile-id file-id)
                  (let [file     (mcp/load-file-for-page cfg file-id page-id [])
                        revn     (:revn file)
                        objects  (:objects (mcp/get-page-data cfg file-id revn (:data file) page-id))
                        regex    (compile-board-regex board-name-regex)
                        deadline (+ (System/nanoTime) budget-ns)
                        boards   (find-boards objects (or depth 1) regex deadline)
                        entries  (get-board-entries objects (:ids boards)
                                                    (or min-shapes 3) deadline)
                        similar  (find-similar-groups (:entries entries)
                                                      (or threshold 0.9) deadline)
                        ranked   (sort-by (juxt #(- (count (:boards %))) #(- (:similarity %)))
                                          (:groups similar))
                        limit    (or limit 100)]
                    [{:revn      revn
                      :page-id   page-id
                      :boards    (count (:entries entries))
                      :compared  (:compared similar)
                      :groups    (mapv (fn [group]
                                         {:similarity (:similarity group)
                                          :exact      (:exact group)
                                          :boards     (mapv #(select-keys % [:id :name :path :shape-count])
                                                            (:boards group))})
                                       (take limit ranked))
                      :truncated (boolean (or (:timed-out? boards)
                                              (:truncated entries)
                                              (:timed-out? similar)
                                              (> (count ranked) limit)))}
                     {:file-id  file-id
                      :page-ids [page-id]
                      :revn     revn
                      :token-id (mcp/get-token-id params)}]))))
