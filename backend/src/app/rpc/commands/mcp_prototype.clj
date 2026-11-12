;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.rpc.commands.mcp-prototype
  "Read commands of the backend-native MCP for prototypes: the interactions
  and flows of a page, and the shapes drawn between its screens. See
  `mcp/docs/backend-mode-contract.md`."
  (:require
   [app.common.exceptions :as ex]
   [app.common.geom.rect :as grc]
   [app.common.schema :as sm]
   [app.common.types.path.helpers :as path.helpers]
   [app.common.uuid :as uuid]
   [app.rpc :as-alias rpc]
   [app.rpc.climit :as-alias climit]
   [app.rpc.commands.mcp :as mcp]
   [app.rpc.doc :as-alias doc]
   [app.rpc.mcp-boards :as boards]
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

(def ^:private snap-tie
  "Distance in px within which two boards count as equally near an end."
  1.0)

(def ^:private default-max-distance
  "Default for `max-distance` of `find-mcp-connectors`, in px."
  64)

(def curve-samples
  "Straight pieces that a curve is cut into when an outline is flattened."
  8)

(def ellipse-samples
  "Points of the flattened outline of a circle in an arrow drawn as a group."
  32)

(def max-flatten-segments
  "Most segments of a path whose curves are cut into `curve-samples` pieces.
  A longer path keeps one piece per curve, so one outline costs little."
  1500)

(def merge-epsilon
  "Distance in px under which two consecutive outline points are one point,
  and under which a point lies on the straight run of its neighbours."
  0.05)

(def min-shaft-width
  "Shaft width in px under which an outline has no head tip: a shape with no
  area has no shaft."
  1.0E-6)

(def max-tip-angle
  "Largest interior angle, in degrees, of a head tip."
  80.0)

(def high-tip-angle
  "Largest interior angle, in degrees, of a tip that can have `high`
  confidence."
  60.0)

(def min-edge-factor
  "Each of the two edges at a head tip is at least this many times the shaft
  width long."
  1.2)

(def extremity-slack
  "A head tip is an extremity: no outline point lies beyond it along its
  outward bisector by more than this share of the extent of the outline
  along that direction."
  0.1)

(def near-tip-depth
  "Depth behind a head tip, in shaft widths, within which the width of the
  outline is measured for the confidence of the tip."
  3.0)

(def high-width-factor
  "A head tip has `high` confidence when the outline is at least this many
  shaft widths wide within `near-tip-depth` of it."
  1.5)

(def composed-min-children
  "Fewest visible children of a group that is drawn as one arrow."
  2)

(def composed-max-children
  "Most visible children of a group that is drawn as one arrow."
  6)

(def composed-elongation
  "A group drawn as an arrow has a longer side at least this many times its
  shorter side, or a shorter side of at most `composed-thin-side`."
  3.0)

(def composed-thin-side
  "Shorter side in px up to which a group counts as thin."
  24.0)

(def composed-shaft-share
  "The shaft of an arrow drawn as a group spans at least this share of the
  longer side of the group."
  0.7)

(def composed-end-reach
  "Every other part of an arrow drawn as a group lies within this many shaft
  widths of one of the two ends of the shaft."
  2.0)

(def max-drop-run
  "Most consecutive outline points that `simplify-ring` drops in one run, so
  that a long straight run costs a bounded check per point."
  512)

(def both-bisector-dot
  "Two head tips make a double-headed arrow only when the dot product of
  their unit outward bisectors is below this: they point opposite ways."
  -0.5)

(def both-end-slack
  "Each tip of a double-headed arrow lies within this share of the extent of
  the outline, along the line through the two tips, of an end of it."
  0.1)

(def cap-max-share
  "The cap of a capped tip (the short run of hull edges between its two long
  edges) is shorter than this many times the shaft width."
  0.75)

(def cap-min-angle
  "Smallest angle, in degrees, at which the lines of the two long edges of a
  capped tip meet."
  20.0)

(def cap-max-angle
  "Largest angle, in degrees, at which the lines of the two long edges of a
  capped tip meet."
  100.0)

(def wide-tip-angle
  "Largest interior angle, in degrees, of a wide sharp tip. One above
  `max-tip-angle` counts only on an elongated outline."
  100.0)

(def tip-axis-angle
  "A capped or wide tip lies on the axis of the outline: the angle, in
  degrees, between its inward bisector and the line to the outline point
  farthest from it is at most this. The corner of a rectangle misses by
  30 degrees or more."
  20.0)

(def wide-tip-elongation
  "A wide sharp tip needs an outline at least this many shaft widths long."
  4.0)

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

(defn- leftmost-first?
  "Whether `a` is the end further left, or, on the same x, the one further up."
  [a b]
  (or (< (:x a) (:x b))
      (and (= (:x a) (:x b))
           (<= (:y a) (:y b)))))

;; --- OUTLINES: FLATTEN AND SIMPLIFY

(defn- pt
  "The plain point `{:x :y}` of two numbers, as doubles."
  [x y]
  {:x (double x) :y (double y)})

(defn flatten-content
  "The subpaths of the path `content` as `[{:points [...] :closed? bool}]`,
  with plain points `{:x :y}`. A curve is cut into `curve-samples` straight
  pieces (one piece when the content has more than `max-flatten-segments`
  segments), evaluated by `app.common.types.path.helpers/curve-values`.
  A `move-to` opens a subpath, a `close-path` closes it. A subpath that
  holds a single point is kept."
  [content]
  (let [steps (if (> (count content) max-flatten-segments) 1 curve-samples)]
    (loop [pending (seq content)
           done    []
           points  []
           start   nil
           prev    nil]
      (if-let [segment (first pending)]
        (let [params (:params segment)
              more   (next pending)]
          (case (:command segment)
            :move-to
            (let [p (pt (:x params) (:y params))]
              (recur more
                     (cond-> done (seq points) (conj {:points points :closed? false}))
                     [p] p p))

            :line-to
            (let [p (pt (:x params) (:y params))]
              (recur more done
                     (conj (if (empty? points) (if (some? prev) [prev] []) points) p)
                     start p))

            :curve-to
            (let [p    (pt (:x params) (:y params))
                  h1   (pt (:c1x params) (:c1y params))
                  h2   (pt (:c2x params) (:c2y params))
                  from (or prev p)
                  cut  (map (fn [i]
                              (if (= i steps)
                                p
                                (let [q (path.helpers/curve-values from p h1 h2 (/ i (double steps)))]
                                  (pt (:x q) (:y q)))))
                            (range 1 (inc steps)))]
              (recur more done
                     (into (if (empty? points) [from] points) cut)
                     start p))

            :close-path
            (recur more
                   (cond-> done (seq points) (conj {:points points :closed? true}))
                   [] start start)

            (recur more done points start prev)))
        (cond-> done (seq points) (conj {:points points :closed? false}))))))

(defn- merge-close
  "The vector `points` without a point within `merge-epsilon` of the one
  before it, nor of the first one at the end (the ring is closed)."
  [points]
  (let [eps2 (* merge-epsilon merge-epsilon)
        out  (reduce (fn [out p]
                       (if (and (seq out) (<= (dist2 (peek out) p) eps2))
                         out
                         (conj out p)))
                     []
                     points)]
    (if (and (> (count out) 1) (<= (dist2 (peek out) (first out)) eps2))
      (pop out)
      out)))

(defn- drop-collinear
  "The ring `points` without the points that lie within `merge-epsilon` of the
  line through their neighbours, so a straight run keeps its two ends. The
  error does not add up: a point goes only when it and every point dropped
  since the last kept one lie within `merge-epsilon` of the chord from that
  kept point to the next point. A run is at most `max-drop-run` points."
  [points]
  (let [n (count points)]
    (if (< n 3)
      points
      (loop [i       0
             out     []
             pending []]
        (if (< i n)
          (let [p      (nth points i)
                before (if (seq out) (peek out) (peek points))
                after  (nth points (mod (inc i) n))
                chord? (pos? (dist2 before after))
                off    (fn [q]
                         (if chord?
                           (line-distance before after q)
                           (Math/sqrt (dist2 before q))))
                drop?  (and (< (count pending) max-drop-run)
                            (<= (off p) merge-epsilon)
                            (every? #(<= (off %) merge-epsilon) pending))]
            (if drop?
              (recur (inc i) out (conj pending p))
              (recur (inc i) (conj out p) [])))
          out)))))

(defn simplify-ring
  "The vector `points` of a ring with its near-equal consecutive points
  merged and the points on a straight run dropped, so that every point left
  is a real corner or a sample of a curve."
  [points]
  (drop-collinear (merge-close points)))

(defn- ring-area
  "Absolute area of the ring `points` (shoelace); 0 below three points."
  [ring]
  (let [n (count ring)]
    (if (< n 3)
      0.0
      (Math/abs
       (* 0.5 (double
               (reduce + 0.0
                       (map (fn [i]
                              (let [p (nth ring i)
                                    q (nth ring (mod (inc i) n))]
                                (- (* (:x p) (:y q)) (* (:x q) (:y p)))))
                            (range n)))))))))

(defn- ring-perimeter
  "Length of the closed ring `points`; 0 below two points."
  [ring]
  (let [n (count ring)]
    (if (< n 2)
      0.0
      (reduce + 0.0
              (map (fn [i]
                     (Math/sqrt (dist2 (nth ring i) (nth ring (mod (inc i) n)))))
                   (range n))))))

(defn- ring-box
  "The box of the ring `ring` as `[x1 y1 x2 y2]`."
  [ring]
  [(double (reduce min (map :x ring))) (double (reduce min (map :y ring)))
   (double (reduce max (map :x ring))) (double (reduce max (map :y ring)))])

(defn- point-in-ring?
  "Whether the point `p` lies inside the ring `ring` (at least three
  points), by the even-odd rule."
  [ring p]
  (let [n  (count ring)
        px (double (:x p))
        py (double (:y p))]
    (loop [i      0
           j      (dec n)
           inside false]
      (if (< i n)
        (let [a   (nth ring i)
              b   (nth ring j)
              ay  (double (:y a))
              by  (double (:y b))
              hit (and (not= (> ay py) (> by py))
                       (< px (+ (double (:x a))
                                (/ (* (- (double (:x b)) (double (:x a))) (- py ay))
                                   (- by ay)))))]
          (recur (inc i) i (if hit (not inside) inside)))
        inside))))

(defn- inside-ring?
  "Whether the ring `ring` (with the box `box`) lies wholly inside `other`
  (with the box `other-box`): its box lies in the box of `other`, and every
  one of its points lies inside the polygon of `other` (at least three
  points)."
  [ring [x1 y1 x2 y2] other [ox1 oy1 ox2 oy2]]
  (and (>= (count other) 3)
       (<= ox1 x1) (<= oy1 y1) (<= x2 ox2) (<= y2 oy2)
       (every? #(point-in-ring? other %) ring)))

(defn- net-area
  "The area of the shape drawn by the `rings`: the sum of the ring areas,
  each added when an even number of the other rings hold it wholly and taken
  off when an odd number do (a hole, or an island in a hole). A ring that
  only overlaps another, such as a dot at the end of a shaft, is added.
  Never below zero."
  [rings]
  (let [rings (filterv seq rings)
        boxes (mapv ring-box rings)
        n     (count rings)]
    (max 0.0
         (double
          (reduce
           + 0.0
           (map (fn [i]
                  (let [ring  (nth rings i)
                        depth (count (filter #(and (not= i %)
                                                   (inside-ring? ring (nth boxes i)
                                                                 (nth rings %) (nth boxes %)))
                                             (range n)))]
                    (if (even? depth)
                      (ring-area ring)
                      (- (ring-area ring)))))
                (range n)))))))

(defn shaft-width
  "The width of the shaft of an outline made of the `rings` (vectors of
  points): twice its area over its perimeter. For a long thin shape the area
  is about length times width and the perimeter about twice the length. A
  ring wholly inside another is a hole: its area is taken off (see
  `net-area`) and its edge is added to the perimeter. Zero when the perimeter is zero."
  [rings]
  (let [area      (net-area rings)
        perimeter (reduce + 0.0 (map ring-perimeter rings))]
    (if (pos? perimeter)
      (/ (* 2.0 area) perimeter)
      0.0)))

;; --- OUTLINES: HEAD TIPS

(defn- cross
  "The z part of the cross product of `oa` and `ob`."
  [o a b]
  (- (* (- (:x a) (:x o)) (- (:y b) (:y o)))
     (* (- (:y a) (:y o)) (- (:x b) (:x o)))))

(defn- hull-half
  "One chain of the monotone-chain convex hull of the sorted `points`."
  [points]
  (reduce (fn [hull p]
            (loop [hull hull]
              (let [n (count hull)]
                (if (and (>= n 2) (<= (cross (nth hull (- n 2)) (peek hull) p) 0.0))
                  (recur (pop hull))
                  (conj hull p)))))
          []
          points))

(defn convex-hull
  "The convex hull of `points` as a vector of the points that are its
  corners (points on an edge are left out), or the distinct points when
  there are fewer than three."
  [points]
  (let [pts (vec (sort-by (juxt :x :y) (distinct points)))]
    (if (< (count pts) 3)
      pts
      (into (pop (hull-half pts)) (pop (hull-half (rseq pts)))))))

(defn- elongated?
  "Whether the outline points `all` are at least `wide-tip-elongation` times
  `w` long: the distance between its two farthest points."
  [all w]
  (let [[a b] (farthest-pair (sample-points all))]
    (and (some? a)
         (>= (Math/sqrt (dist2 a b)) (* wide-tip-elongation w)))))

(defn- on-axis?
  "Whether the tip `tip` of the outline points `all` has its inward bisector
  within `tip-axis-angle` of the line to the outline point farthest from it."
  [all tip]
  (let [p        (:point tip)
        far      (farthest-from all p)
        dx       (- (:x far) (:x p))
        dy       (- (:y far) (:y p))
        len      (Math/sqrt (+ (* dx dx) (* dy dy)))
        [ax ay]  (:axis tip)]
    (and (pos? len)
         (>= (/ (+ (* dx ax) (* dy ay)) len)
             (Math/cos (Math/toRadians tip-axis-angle))))))

(defn- extreme-tip
  "The tip at the point `p` of the outline points `all`, whose two edges
  leave `p` along the vectors (`ux`, `uy`) and (`vx`, `vy`), as `{:point
  :angle :axis :reach}`, or nil. `:angle` is the angle between the two
  edges, in degrees, and must lie from `min-angle` to `max-angle`. `:axis`
  is the unit bisector that points into the outline. The tip must be an
  extremity: no point of the outline lies beyond it along the outward
  bisector by more than `extremity-slack` of the extent of the outline along
  that direction. `:reach` is how far the outline extends behind the tip
  along the bisector."
  [all p ux uy vx vy min-angle max-angle]
  (let [lu (Math/sqrt (+ (* ux ux) (* uy uy)))
        lv (Math/sqrt (+ (* vx vx) (* vy vy)))]
    (when (and (pos? lu) (pos? lv))
      (let [angle (Math/toDegrees
                   (Math/atan2 (Math/abs (- (* ux vy) (* uy vx)))
                               (+ (* ux vx) (* uy vy))))]
        (when (<= min-angle angle max-angle)
          (let [sx (+ (/ ux lu) (/ vx lv))
                sy (+ (/ uy lu) (/ vy lv))
                sl (Math/sqrt (+ (* sx sx) (* sy sy)))]
            (when (pos? sl)
              (let [ax    (/ sx sl)
                    ay    (/ sy sl)
                    ;; position of a point along the outward bisector
                    out   (fn [q] (- (+ (* (- (:x q) (:x p)) ax)
                                        (* (- (:y q) (:y p)) ay))))
                    [hi lo] (reduce (fn [[hi lo] q]
                                      (let [d (double (out q))]
                                        [(max hi d) (min lo d)]))
                                    [0.0 0.0]
                                    all)]
                (when (<= hi (* extremity-slack (- hi lo)))
                  {:point p
                   :angle angle
                   :axis  [ax ay]
                   :reach (- lo)})))))))))

(defn- tip-at
  "The head tip at the vertex `j` of the ring `ring` (the ring number `i`) of
  an outline with all points `all`, convex hull `hull` (a set) and shaft
  width `w`, or nil. The vertex is a tip when it lies on the hull, both
  edges are at least `min-edge-factor` times `w` long, its interior angle
  lies from `min-angle` to `max-angle`, and it is an extremity (see
  `extreme-tip`). The tip has the given `kind`."
  [all hull ring j w i min-angle max-angle kind]
  (let [n (count ring)
        p (nth ring j)]
    (when (contains? hull p)
      (let [prev (nth ring (mod (dec j) n))
            nxt  (nth ring (mod (inc j) n))
            ux   (- (:x prev) (:x p))
            uy   (- (:y prev) (:y p))
            vx   (- (:x nxt) (:x p))
            vy   (- (:y nxt) (:y p))
            lu   (Math/sqrt (+ (* ux ux) (* uy uy)))
            lv   (Math/sqrt (+ (* vx vx) (* vy vy)))]
        (when (and (>= lu (* min-edge-factor w))
                   (>= lv (* min-edge-factor w)))
          (some-> (extreme-tip all p ux uy vx vy min-angle max-angle)
                  (assoc :ring i :kind kind)))))))

(defn- cap-middle
  "The point halfway along the path through the vector `vertices`."
  [vertices]
  (let [len   (fn [k] (Math/sqrt (dist2 (nth vertices k) (nth vertices (inc k)))))
        total (reduce + 0.0 (map len (range (dec (count vertices)))))]
    (loop [k    0
           left (/ total 2.0)]
      (let [a (nth vertices k)
            b (nth vertices (inc k))
            l (len k)]
        (if (or (<= left l) (>= (+ k 2) (count vertices)))
          (let [t (if (pos? l) (min 1.0 (/ left l)) 0.0)]
            (pt (+ (:x a) (* t (- (:x b) (:x a))))
                (+ (:y a) (* t (- (:y b) (:y a))))))
          (recur (inc k) (- left l)))))))

(defn- capped-tip-at
  "The capped tip whose first long edge is the edge `i` of the hull vector
  `hull`, or nil. Long edges are at least `min-edge-factor` times `w`. After
  edge `i` come one or more edges that are not long, together shorter than
  `cap-max-share` times `w`: the cap. Then comes a second long edge. The
  lines of the two long edges must meet beyond the cap, at an angle from
  `cap-min-angle` to `cap-max-angle`. The tip is the middle of the cap,
  measured along its length: a point of the outline, not the point where the
  lines meet. It must be an extremity (see `extreme-tip`), and the cap must
  not lie wholly on a skipped ring (`skipped` is the set of their points)."
  [all hull w skipped i]
  (let [n     (count hull)
        long? (* min-edge-factor w)
        cap?  (* cap-max-share w)
        edge  (fn [k] (let [a (nth hull (mod k n))
                            b (nth hull (mod (inc k) n))]
                        [a b (Math/sqrt (dist2 a b))]))
        [a1 b1 len1] (edge i)]
    (when (>= len1 long?)
      (loop [k   (inc i)
             cap 0.0]
        (let [[a2 b2 len2] (edge k)]
          (cond
            (>= (- k i) n)
            nil

            (>= len2 long?)
            (when (> k (inc i))
              (let [d1x   (- (:x b1) (:x a1))
                    d1y   (- (:y b1) (:y a1))
                    d2x   (- (:x b2) (:x a2))
                    d2y   (- (:y b2) (:y a2))
                    denom (- (* d1x d2y) (* d1y d2x))
                    rx    (- (:x a2) (:x a1))
                    ry    (- (:y a2) (:y a1))]
                (when (> (Math/abs denom) 1.0E-12)
                  (let [t (/ (- (* rx d2y) (* ry d2x)) denom)
                        s (/ (- (* rx d1y) (* ry d1x)) denom)]
                    ;; the lines meet past the end of the first edge and
                    ;; before the start of the second one
                    (when (and (>= t 1.0) (<= s 0.0))
                      (let [cap-vs (mapv #(nth hull (mod % n)) (range (inc i) (inc k)))]
                        (when-not (every? #(contains? skipped %) cap-vs)
                          (extreme-tip all (cap-middle cap-vs)
                                       (- d1x) (- d1y) d2x d2y
                                       cap-min-angle cap-max-angle))))))))

            (< (+ cap len2) cap?)
            (recur (inc k) (+ cap len2))

            :else nil))))))

(defn find-head-tips
  "The head tips of an outline made of the `rings` (vectors of simplified
  points, all drawn as one shape) for the shaft width `w`, as `[{:point :angle
  :axis :reach :ring :kind}]`. The rings whose number is in the set `skip`
  give no tip (the shaft of an arrow drawn as a group). Empty when `w` is not
  above `min-shaft-width`.
  - Rule 1, `:kind :sharp`: a vertex on the convex hull with an interior
    angle of at most `max-tip-angle`, two edges of at least `min-edge-factor`
    times `w`, and an extremity (see `tip-at`).
  - Rule 2, only when rule 1 finds no tip and the outline is at least
    `wide-tip-elongation` times `w` long (see `elongated?`): `:kind :capped`
    or `:wide`. A capped tip is a rounded or blunt end (see
    `capped-tip-at`). A wide tip is a rule 1 vertex whose angle is above
    `max-tip-angle` and up to `wide-tip-angle`. A capped or wide tip must
    also lie on the axis of the outline (see `on-axis?`)."
  [rings w skip]
  (if (> w min-shaft-width)
    (let [all      (into [] cat rings)
          hull-pts (convex-hull all)
          hull     (set hull-pts)
          each     (fn [f]
                     (into []
                           (comp (map-indexed vector)
                                 (remove (fn [[i _]] (contains? skip i)))
                                 (filter (fn [[_ ring]] (>= (count ring) 3)))
                                 (mapcat (fn [[i ring]]
                                           (keep #(f ring % i) (range (count ring))))))
                           rings))
          sharp    (each #(tip-at all hull %1 %2 w %3 0.0 max-tip-angle :sharp))]
      (if (seq sharp)
        sharp
        (let [skipped (into #{} (mapcat #(nth rings % [])) skip)
              long?   (elongated? all w)
              capped  (if long?
                        (into []
                              (comp (keep #(capped-tip-at all hull-pts w skipped %))
                                    (map #(assoc % :ring nil :kind :capped)))
                              (range (count hull-pts)))
                        [])
              wide    (if long?
                        (each #(tip-at all hull %1 %2 w %3 max-tip-angle wide-tip-angle :wide))
                        [])]
          (filterv #(on-axis? all %) (into capped wide)))))
    []))

(defn- near-tip-width
  "The width of the outline `rings` across the bisector of `tip`, within
  `near-tip-depth` times `w` behind the tip: the spread, perpendicular to the
  bisector, of the parts of the edges in that strip."
  [rings tip w]
  (let [{:keys [point axis]} tip
        [ax ay] axis
        depth (* near-tip-depth w)
        along (fn [q] (+ (* (- (:x q) (:x point)) ax) (* (- (:y q) (:y point)) ay)))
        across (fn [q] (- (* (- (:y q) (:y point)) ax) (* (- (:x q) (:x point)) ay)))
        spread (reduce
                (fn [acc ring]
                  (let [n (count ring)]
                    (reduce
                     (fn [acc k]
                       (let [q0 (nth ring k)
                             q1 (nth ring (mod (inc k) n))
                             s0 (along q0)
                             s1 (along q1)
                             c0 (across q0)
                             c1 (across q1)
                             at (fn [t] (+ c0 (* t (- c1 c0))))]
                         (if (== s0 s1)
                           (if (<= 0.0 s0 depth)
                             (into acc [c0 c1])
                             acc)
                           (let [ta (/ (- 0.0 s0) (- s1 s0))
                                 tb (/ (- depth s0) (- s1 s0))
                                 lo (max 0.0 (min ta tb))
                                 hi (min 1.0 (max ta tb))]
                             (if (<= lo hi)
                               (conj acc (at lo) (at hi))
                               acc)))))
                     acc
                     (if (> n 1) (range n) []))))
                []
                rings)]
    (if (seq spread)
      (- (double (reduce max spread)) (double (reduce min spread)))
      0.0)))

(defn- tip-confidence
  "`high` when `tip` is a sharp tip, its angle is at most `high-tip-angle`
  and the outline is at least `high-width-factor` times `w` wide near it,
  else `medium`. A capped or wide tip is always `medium`."
  [rings tip w]
  (if (and (= :sharp (:kind tip))
           (<= (:angle tip) high-tip-angle)
           (>= (near-tip-width rings tip w) (* high-width-factor w)))
    "high"
    "medium"))

(defn- farthest-tip-pair
  "The two tips of `tips` that are farthest apart, as `[tip tip]`."
  [tips]
  (let [n (count tips)]
    (loop [i 0
           j 1
           best nil
           best-d -1.0]
      (cond
        (>= i (dec n)) best
        (>= j n)       (recur (inc i) (+ i 2) best best-d)
        :else
        (let [d (dist2 (:point (nth tips i)) (:point (nth tips j)))]
          (if (> d best-d)
            (recur i (inc j) [(nth tips i) (nth tips j)] d)
            (recur i (inc j) best best-d)))))))

(defn- double-headed?
  "Whether the tips `t1` and `t2` of the outline points `all` (shaft width
  `w`) are the two heads of one arrow: the outline is elongated (see
  `elongated?`), their outward bisectors point opposite ways (the dot
  product of the unit bisectors is below `both-bisector-dot`), and each lies
  within `both-end-slack` of the extent of the outline, along the line
  through the two tips, of an end of it."
  [all w t1 t2]
  (let [p  (:point t1)
        q  (:point t2)
        dx (- (:x q) (:x p))
        dy (- (:y q) (:y p))
        d  (Math/sqrt (+ (* dx dx) (* dy dy)))]
    (and (pos? d)
         (elongated? all w)
         (< (+ (* (first (:axis t1)) (first (:axis t2)))
               (* (second (:axis t1)) (second (:axis t2))))
            both-bisector-dot)
         (let [ux      (/ dx d)
               uy      (/ dy d)
               along   (fn [r] (+ (* (- (:x r) (:x p)) ux) (* (- (:y r) (:y p)) uy)))
               [lo hi] (reduce (fn [[lo hi] r]
                                 (let [t (double (along r))]
                                   [(min lo t) (max hi t)]))
                               [0.0 d]
                               all)
               slack   (* both-end-slack (- hi lo))]
           (and (<= (- lo) slack)
                (<= (- hi d) slack))))))

(defn outline-direction
  "The direction of an outline made of the `rings` (vectors of simplified
  points) with shaft width `w`, as `{:direction :confidence :a :b :head}`, or
  nil for fewer than two points. `:head` is `:a`, `:b` or nil.
  - One head tip (see `find-head-tips`): direction `shape`; `:b` is the tip
    and `:a` the outline point farthest from it; confidence `high` or
    `medium` (see `tip-confidence`).
  - Two or more tips, the two farthest apart being the heads of one arrow
    (see `double-headed?`; the outline must be elongated): direction `both`, the ends are those two tips,
    confidence `medium`.
  - Two or more tips that are not two heads (a short arrow with wide barbs,
    a triangle icon): one head, the tip with the greatest `:reach`, as for
    one tip.
  - No tip: the ends are the two farthest points, direction `none` and
    confidence `none`. No other rule gives a direction.
  The rings numbered in `skip` give no tips."
  [rings w skip]
  (let [all (into [] cat rings)]
    (when (>= (count all) 2)
      (let [tips   (find-head-tips rings w skip)
            n      (count tips)
            single (fn [tip]
                     {:direction  "shape"
                      :confidence (tip-confidence rings tip w)
                      :a          (farthest-from all (:point tip))
                      :b          (:point tip)
                      :head       :b})]
        (cond
          (= 1 n)
          (single (first tips))

          (>= n 2)
          (let [[t1 t2] (farthest-tip-pair tips)]
            (if (double-headed? all w t1 t2)
              {:direction "both" :confidence "medium"
               :a (:point t1) :b (:point t2) :head nil}
              (single (reduce (fn [best tip]
                                (if (> (:reach tip) (:reach best)) tip best))
                              tips))))

          :else
          (let [[a b] (farthest-pair (sample-points all))]
            {:direction "none" :confidence "none" :a a :b b :head nil}))))))

;; --- OUTLINES: ARROWS DRAWN AS A GROUP

(defn- part-stats
  "`{:length :width :ratio}` of a part of a composed arrow, a map `{:rings
  [...] :min-width m}`: the distance between its two farthest points, its
  width (twice its area over its perimeter, but at least `:min-width`, the
  stroke width of a line) and their ratio."
  [part]
  (let [all    (into [] cat (:rings part))
        [a b]  (farthest-pair (sample-points all))
        length (if (some? a) (Math/sqrt (dist2 a b)) 0.0)
        width  (max (double (:min-width part)) (shaft-width (:rings part)))]
    {:length length
     :width  width
     :ratio  (if (pos? width) (/ length width) 0.0)}))

;; Part boxes and the shaft pick are shared by `composed-direction` and
;; `composed-anatomy?`.

(defn- shaft-index
  "The index of the shaft among `stats` (see `part-stats`): the part with the
  largest ratio of length to width, the first on a tie."
  [stats]
  (reduce (fn [best i]
            (if (> (:ratio (nth stats i)) (:ratio (nth stats best))) i best))
          0
          (range (count stats))))

(defn- part-box
  "The box of the part `part` as `[x1 y1 x2 y2]`, or nil when it has no point."
  [part]
  (let [all (into [] cat (:rings part))]
    (when (seq all)
      [(double (reduce min (map :x all))) (double (reduce min (map :y all)))
       (double (reduce max (map :x all))) (double (reduce max (map :y all)))])))

(defn composed-anatomy?
  "Whether the `parts` (see `composed-direction`) have the anatomy of one
  arrow, in a group whose longer side is `long-side`: one shaft (see
  `shaft-index`) that spans at least `composed-shaft-share` of `long-side`,
  and every other part within `composed-end-reach` times the shaft width of
  one of the two ends of the shaft, measured from the box of the part."
  [parts long-side]
  (let [stats  (mapv part-stats parts)
        shaft  (shaft-index stats)
        {:keys [length width]} (nth stats shaft)
        [a b]  (farthest-pair (sample-points (into [] cat (:rings (nth parts shaft)))))
        reach  (* composed-end-reach width)]
    (and (some? a)
         (>= length (* composed-shaft-share long-side))
         (every? (fn [i]
                   (let [[x1 y1 x2 y2 :as box] (part-box (nth parts i))]
                     (and (some? box)
                          (or (<= (rect-distance x1 y1 x2 y2 (:x a) (:y a)) reach)
                              (<= (rect-distance x1 y1 x2 y2 (:x b) (:y b)) reach)))))
                 (remove #{shaft} (range (count parts)))))))

(defn composed-direction
  "The direction of an arrow drawn as a group, from its `parts`: maps
  `{:rings [...] :min-width m}`, one per child, each ring a vector of
  simplified points. The shaft is the part with the largest ratio of length
  to width, and its width is `w`. The parts are one outline for the hull and
  the extremity test, and a tip on the shaft does not count. Result as
  `outline-direction`."
  [parts]
  (let [stats  (mapv part-stats parts)
        shaft  (shaft-index stats)
        sizes  (mapv #(count (:rings %)) parts)
        offset (reduce + 0 (take shaft sizes))
        skip   (into #{} (range offset (+ offset (nth sizes shaft))))
        rings  (into [] (mapcat :rings) parts)]
    (outline-direction rings (:width (nth stats shaft)) skip)))

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

(def ^:private composed-types
  "Shape types a group may hold to count as one arrow drawn in parts."
  #{:rect :circle :path :bool})

(declare child-part)

(defn- composed-group?
  "Whether the `group` is an arrow drawn as a group: `composed-min-children` to
  `composed-max-children` visible children, all of a type in `composed-types`
  (so no text and no frame), a box that is elongated (see
  `composed-elongation`) or thin (see `composed-thin-side`), and the anatomy
  of one arrow (see `composed-anatomy?`). Other groups of such shapes, such
  as a row of arrows, are no arrow: their children are candidates."
  [objects group]
  (let [children (into [] (comp (keep #(get objects %))
                                (remove #(true? (:hidden %))))
                       (:shapes group))]
    (and (<= composed-min-children (count children) composed-max-children)
         (every? #(contains? composed-types (:type %)) children)
         (let [[x1 y1 x2 y2] (shape-rect group)
               w             (- x2 x1)
               h             (- y2 y1)
               longer        (max w h)
               shorter       (min w h)]
           (and (or (>= longer (* composed-elongation shorter))
                    (<= shorter composed-thin-side))
                (composed-anatomy? (mapv child-part children) longer))))))

(defn- get-candidates
  "The candidates of `entries` as `[shape chain]`, `chain` being the
  ancestors of the shape, shallowest first and in walk order. A candidate is
  a visible path or boolean, or a visible group drawn as an arrow (see
  `composed-group?`), with no boolean ancestor (a boolean draws its children
  as one shape) and no such group as ancestor (the group is the candidate,
  not its children). With `within-id`, it lies under that shape."
  [objects entries within-id]
  (let [composed (into #{}
                       (comp (map second)
                             (filter #(and (= :group (:type %))
                                           (visible? objects %)
                                           (composed-group? objects %)))
                             (map :id))
                       entries)
        found    (into []
                       (comp (filter (fn [[_ shape]]
                                       (and (or (contains? #{:path :bool} (:type shape))
                                                (contains? composed (:id shape)))
                                            (visible? objects shape))))
                             (map (fn [[level shape]]
                                    [level shape (get-ancestors objects shape)]))
                             (filter (fn [[_ _ chain]]
                                       (and (not-any? #(or (= :bool (:type %))
                                                           (contains? composed (:id %)))
                                                      chain)
                                            (or (nil? within-id)
                                                (some #(= within-id (:id %)) chain))))))
                       entries)]
    (mapv (fn [[_ shape chain]] [shape chain])
          (sort-by first found))))

;; --- SCREENS OF THE ENDS

(def ^:private grid-cell
  "Side in px of a cell of the grid that indexes the targets of the ends."
  512.0)

(def ^:private max-grid-cells
  "Most cells one target is entered in. A target that covers more is kept in
  a list that every look-up reads."
  1024)

(defn- get-targets
  "The targets that an end may belong to, as `[{:board :screen? :order}]` in
  walk order: the selected boards (the screens), and the loose frames, which
  are visible frames that are neither selected nor inside a selected board.
  A frame that holds a selected board (a section, a journey group, a
  wrapper) is no target. `frames` are the Board records of the visible
  frames in walk order and `selected` the set of the ids of the screens.
  A screen has `:reach`, the boards that also make an end its own: its
  wrapper by margin (`wrappers`, see `get-wrappers`) and its overlays
  (`overlays`, `{overlay-id screen-id}` of the selection). The overlays and
  the frames inside them are no targets: they belong to their screen."
  ([frames selected]
   (get-targets frames selected {} {}))
  ([frames selected wrappers overlays]
   (let [above   (into #{} (comp (filter #(contains? selected (:id %)))
                                 (mapcat :ancestors))
                       frames)
         by-id   (into {} (map (juxt :id identity)) frames)
         reaches (reduce-kv (fn [acc overlay-id screen-id]
                              (cond-> acc
                                (contains? by-id overlay-id)
                                (update screen-id (fnil conj []) (get by-id overlay-id))))
                            (into {} (map (fn [[k v]] [k [v]])) wrappers)
                            overlays)]
     (into []
           (comp (map-indexed
                  (fn [i board]
                    (let [screen? (contains? selected (:id board))]
                      (when (and (not (contains? above (:id board)))
                                 (not (contains? overlays (:id board)))
                                 (not-any? #(contains? overlays %) (:ancestors board))
                                 (or screen? (not-any? selected (:ancestors board))))
                        (cond-> {:board board :screen? screen? :order i}
                          (and screen? (contains? reaches (:id board)))
                          (assoc :reach (get reaches (:id board))
                                 :wrapper-id (:id (get wrappers (:id board)))))))))
                 (remove nil?))
           frames))))

(defn- board-box
  "The box of the Board record `board` as `{:x0 :y0 :x1 :y1}`."
  [^Board board]
  {:x0 (:x1 board) :y0 (:y1 board) :x1 (:x2 board) :y1 (:y2 board)})

(defn- get-wrappers
  "The wrappers of the screens, as `{screen-id wrapper-board}`. The wrapper of
  a selected screen is its parent frame when that frame holds no other
  selected board and the screen lies in it centered (`boards/centered-margin?`:
  the gaps on opposite sides within `boards/margin-tolerance` of each other,
  at most `boards/max-centered-margin` px). `objects` are the
  page objects, `frames` the Board records of the visible frames and
  `selected` the set of the ids of the screens."
  [objects frames selected]
  (let [by-id (into {} (map (juxt :id identity)) frames)
        held  (frequencies (mapcat :ancestors (filter #(contains? selected (:id %)) frames)))]
    (into {}
          (keep (fn [board]
                  (when (contains? selected (:id board))
                    (let [parent (get by-id (:parent-id (get objects (:id board))))]
                      (when (and (some? parent)
                                 (= 1 (get held (:id parent)))
                                 (boards/centered-margin? (board-box parent) (board-box board)))
                        [(:id board) parent])))))
          frames)))

(defn- cell-index
  "The grid cell, on one axis, of the coordinate `v`."
  [v]
  (long (Math/floor (/ (double v) grid-cell))))

(defn- build-target-index
  "The grid over `targets` (see `get-targets`): `{:cells {[cx cy] [target]}
  :big [target]}`. A target is entered in every cell that its box, grown by
  `max-distance`, touches, so a look-up reads one cell and the `:big`
  targets only."
  [targets max-distance]
  (let [md (double max-distance)]
    (reduce
     (fn [index {:keys [board reach] :as target}]
       (let [boxes (cons board reach)
             board {:x1 (reduce min (map :x1 boxes)) :y1 (reduce min (map :y1 boxes))
                    :x2 (reduce max (map :x2 boxes)) :y2 (reduce max (map :y2 boxes))}
             cx1 (cell-index (- (:x1 board) md))
             cx2 (cell-index (+ (:x2 board) md))
             cy1 (cell-index (- (:y1 board) md))
             cy2 (cell-index (+ (:y2 board) md))]
         (if (> (* (inc (- cx2 cx1)) (inc (- cy2 cy1))) max-grid-cells)
           (update index :big conj target)
           (reduce (fn [index cell]
                     (update-in index [:cells cell] (fnil conj []) target))
                   index
                   (for [cx (range cx1 (inc cx2))
                         cy (range cy1 (inc cy2))]
                     [cx cy])))))
     {:cells {} :big []}
     targets)))

(defn- nearer?
  "Whether the target `target` at squared distance `d2` beats `best`, a
  `[d2 target]` pair or nil: nearer, and on a tie a screen over a loose
  frame, then the smaller area, then the earlier in walk order."
  [d2 target best]
  (if (nil? best)
    true
    (let [[best-d2 other] best]
      (cond
        (< d2 (- best-d2 1.0E-9)) true
        (> d2 (+ best-d2 1.0E-9)) false
        (not= (:screen? target) (:screen? other)) (:screen? target)
        (not= (:area (:board target)) (:area (:board other)))
        (< (:area (:board target)) (:area (:board other)))
        :else (< (:order target) (:order other))))))

(defn- in-reach?
  "Whether the point `p` is within `max2` (squared distance) of a board of
  the `:reach` of `target`: its wrapper and its overlays."
  [target p max2]
  (some #(<= (board-dist2 % p) max2) (:reach target)))

(defn- resolve-target
  "The target (see `get-targets`) of the end `p`: the nearest within
  `max-distance` by the distance of the snap (0 inside), as `{:id :name
  :screen? :distance}`, or nil when there is none. A screen whose wrapper or
  overlay is within `max-distance` of `p` is a candidate too, but candidates
  are ranked by their true distance to the screen, so a screen near the end
  beats the screen inside a large wrapper that the end lies in. `:distance` is
  that true distance and may exceed `max-distance` (the end lies in the
  margin of a wrapper). `:wrapper-id` is set when the wrapper is nearer to `p`
  than the screen is. `index` is from `build-target-index`."
  [index max-distance p]
  (let [max2 (* (double max-distance) max-distance)
        cell [(cell-index (:x p)) (cell-index (:y p))]
        best (reduce (fn [best target]
                       (let [d2 (board-dist2 (:board target) p)]
                         (if (and (or (<= d2 max2) (in-reach? target p max2))
                                  (nearer? d2 target best))
                           [d2 target]
                           best)))
                     nil
                     (concat (get-in index [:cells cell]) (:big index)))]
    (when-let [[d2 {:keys [board screen? reach wrapper-id]}] best]
      (cond-> {:id (:id board) :name (:name board) :screen? screen?
               :distance (Math/sqrt d2)}
        (and (some? reach) (some #(< (board-dist2 % p) d2) reach))
        (assoc :reach-ids (into #{} (map :id) reach))
        (and (some? wrapper-id) (some #(< (board-dist2 % p) d2) reach))
        (assoc :wrapper-id wrapper-id)))))

;; --- FRAMES OF THE ENDS

(defn- snap-among
  "The board that the end `p` snaps to among the vector `boards`, with its
  `:distance`. Boards in `excluded` (ids) and boards that hold both ends `a`
  and `b` are left out. Of the boards within `max-distance`, the nearest is
  taken; among those within `snap-tie` of it, the outermost (see
  `outermost`). Nil when no board is that near. Plain loops over the
  vector, no seqs: one scan for the nearest, one for the ties. Reads every
  board of the vector; `find-snap-board` hands it the boards near `p` only,
  and the tests compare the two."
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

(defn build-board-index
  "The grid over the vector `boards` for `find-snap-board`: the grid of
  `build-target-index`, with an entry `{:board :order}` per board, `order`
  being its place in `boards`. A board is entered in every cell that its box,
  grown by `max-distance`, touches."
  [boards max-distance]
  (build-target-index (into [] (map-indexed (fn [i board] {:board board :order i})) boards)
                      max-distance))

(defn find-snap-board
  "The board that the end `p` snaps to, as `snap-among` chooses it, among the
  boards of `index` (see `build-board-index`, built for the same
  `max-distance` or a larger one). Only the boards of the cell of `p` and the
  oversized boards are read, in the order of the vector, so the choice is
  the one `snap-among` makes over all boards."
  [index excluded a b p max-distance]
  (let [cell  [(cell-index (:x p)) (cell-index (:y p))]
        near  (->> (concat (get-in index [:cells cell]) (:big index))
                   (sort-by :order)
                   (mapv :board))]
    (snap-among near excluded a b p max-distance)))

;; --- CONNECTORS

(defn- arrow-cap?
  "Whether a stroke of `shape` has an arrow cap at `k`, `:stroke-cap-start`
  or `:stroke-cap-end`."
  [shape k]
  (boolean (some #(contains? arrow-caps (get % k)) (:strokes shape))))

(defn- path-geometry
  "The ends and direction of the path or boolean `shape`, as
  `outline-direction` answers, or nil for fewer than two points. An open
  path with a stroke ends at its first and last points; an arrow cap on
  exactly one end makes it the head (`cap`, `high`); else the direction is
  `none`. Any other shape is an outline (`outline-direction`)."
  [shape]
  (let [content  (:content shape)
        subpaths (flatten-content content)
        open?    (not-any? #(= :close-path (:command %)) content)
        points   (into [] (mapcat :points) subpaths)]
    (when (>= (count points) 2)
      (if (and open? (seq (:strokes shape)))
        (let [a           (first points)
              b           (peek points)
              start-arrow (arrow-cap? shape :stroke-cap-start)
              end-arrow   (arrow-cap? shape :stroke-cap-end)]
          (cond
            (and start-arrow (not end-arrow))
            {:direction "cap" :confidence "high" :a a :b b :head :a}

            (and end-arrow (not start-arrow))
            {:direction "cap" :confidence "high" :a a :b b :head :b}

            :else
            {:direction "none" :confidence "none" :a a :b b :head nil}))
        (let [rings (filterv seq (map #(simplify-ring (:points %)) subpaths))]
          (outline-direction rings (shaft-width rings) #{}))))))

(defn- rect-ring
  "The four corners of the rect `shape` in page space, as plain points: its
  `points` (which carry its transform), else its stored box."
  [shape]
  (let [ps (:points shape)]
    (if (= 4 (count ps))
      (mapv #(pt (:x %) (:y %)) ps)
      (let [x1 (:x shape)
            y1 (:y shape)
            x2 (+ x1 (:width shape))
            y2 (+ y1 (:height shape))]
        [(pt x1 y1) (pt x2 y1) (pt x2 y2) (pt x1 y2)]))))

(defn- ellipse-ring
  "The circle or ellipse `shape` as `ellipse-samples` points. Its box
  corners (with its transform applied) give the centre and the two half
  axes, so a turned or skewed ellipse is right too."
  [shape]
  (let [[p0 p1 _ p3] (rect-ring shape)
        ux (/ (- (:x p1) (:x p0)) 2.0)
        uy (/ (- (:y p1) (:y p0)) 2.0)
        vx (/ (- (:x p3) (:x p0)) 2.0)
        vy (/ (- (:y p3) (:y p0)) 2.0)
        cx (+ (:x p0) ux vx)
        cy (+ (:y p0) uy vy)]
    (mapv (fn [k]
            (let [t (/ (* 2.0 Math/PI k) ellipse-samples)
                  c (Math/cos t)
                  s (Math/sin t)]
              (pt (+ cx (* ux c) (* vx s)) (+ cy (* uy c) (* vy s)))))
          (range ellipse-samples))))

(defn- child-part
  "The part `{:rings :min-width}` of a child of an arrow drawn as a group.
  A rect is its four corners, a circle a flattened ellipse, a path or boolean
  its flattened subpaths. `min-width` is the stroke width of an open stroked
  path, which has no area of its own."
  [child]
  (case (:type child)
    :rect   {:rings [(simplify-ring (rect-ring child))] :min-width 0.0}
    :circle {:rings [(simplify-ring (ellipse-ring child))] :min-width 0.0}
    (let [content (:content child)
          open?   (not-any? #(= :close-path (:command %)) content)]
      {:rings     (filterv seq (map #(simplify-ring (:points %)) (flatten-content content)))
       :min-width (if (and open? (seq (:strokes child)))
                    (double (reduce max 0.0 (keep :stroke-width (:strokes child))))
                    0.0)})))

(defn- get-geometry
  "The ends and direction of the candidate `shape` (see `path-geometry`; a
  group is looked at as `composed-direction` does, and answers `:composed?
  true`), or nil."
  [objects shape]
  (if (= :group (:type shape))
    (let [parts (into [] (comp (keep #(get objects %))
                               (remove #(true? (:hidden %)))
                               (map child-part))
                      (:shapes shape))]
      (some-> (composed-direction parts)
              (assoc :composed? true)))
    (path-geometry shape)))

(defn- connector-end
  "The end map of the point `p` snapped to `board`, with its `target` (see
  `resolve-target`): `screen-id` and `screen-name` when the target is a
  screen, else `non-screen true` (a loose frame, or no target in reach).
  Without a `board` (no frame to snap to) the target stands in for it. An
  end that reached its screen through a wrapper by margin reports the
  distance to the screen, and the screen in place of the wrapper."
  [p board target]
  (let [wrapped? (some? (:reach-ids target))
        board    (if (and wrapped? (contains? (:reach-ids target) (:id board))) nil board)]
    (cond-> {:board-id   (or (:id board) (:id target))
             :board-name (or (:name board) (:name target))
             :distance   (if (and (some? board) (not wrapped?)) (:distance board) (:distance target))
             :x          (:x p)
             :y          (:y p)}
      (:screen? target)
      (assoc :screen-id   (:id target)
             :screen-name (:name target))

      (not (:screen? target))
      (assoc :non-screen true))))

(defn- inside-own-frame?
  "Whether both ends `a` and `b` lie inside `frame`, the nearest ancestor
  frame of a candidate, and no frame sits inside that frame. A shape in a
  frame like that cannot join two screens; it is left out without being
  counted as same-screen."
  [frame frame-parents a b]
  (and (some? frame)
       (not (contains? frame-parents (:id frame)))
       (let [[x1 y1 x2 y2] (shape-rect frame)]
         (and (zero? (rect-dist2 x1 y1 x2 y2 (:x a) (:y a)))
              (zero? (rect-dist2 x1 y1 x2 y2 (:x b) (:y b)))))))

(defn- find-connector
  "The connector that the candidate `shape` makes between the frames of
  `ctx` (`:objects :board-index :frame-parents :resolve :max-distance
  :include-same-screen?`), nil when it makes none, or `:same-screen` when it
  joins two frames of one screen and `include-same-screen?` is false.
  Frames that are ancestors of `shape` are left out, and so are frames that
  hold both ends. A candidate whose both ends lie inside its nearest ancestor
  frame, when that frame holds no frame, is skipped. The screen of an end is
  its target (`resolve-target`), not its frame.
  - Both ends snap to a frame: the ends make a connector when their targets
    differ; when both targets are one screen, when the frames differ (it is
    then a same-screen connector); when a target is missing, when the frames
    differ.
  - An end snaps to no frame (an arrow drawn inside a screen, whose own
    screen is an ancestor, and a button with no frame near it): when both
    ends have a target the connector is kept if the targets differ, the
    target standing in for the frame of that end; one screen is a
    same-screen connector. Otherwise it is none."
  [ctx shape chain]
  (when-let [{:keys [a b direction confidence head composed?]} (get-geometry (:objects ctx) shape)]
    (let [{:keys [board-index frame-parents max-distance]} ctx
          excluded (into #{} (map :id) chain)
          frame    (some #(when (= :frame (:type %)) %) chain)]
      (when-not (inside-own-frame? frame frame-parents a b)
        (let [board-a   (find-snap-board board-index excluded a b a max-distance)
              board-b   (find-snap-board board-index excluded a b b max-distance)
              target-a  ((:resolve ctx) a)
              target-b  ((:resolve ctx) b)
              boards?   (and (some? board-a) (some? board-b))
              targets?  (and (some? target-a) (some? target-b))
              differ?   (and targets? (not= (:id target-a) (:id target-b)))
              same-frame (and boards? (= (:id board-a) (:id board-b)))
              joined    (cond
                          boards?  (if targets?
                                     (or differ?
                                         (and (:screen? target-a) (not same-frame)))
                                     (not same-frame))
                          targets? (or differ? (boolean (:screen? target-a)))
                          :else    false)]
          (when joined
            (let [[from-key to-key] (cond
                                      (= head :a) [:b :a]
                                      (= head :b) [:a :b]
                                      (leftmost-first? a b) [:a :b]
                                      :else [:b :a])
                  ends     {:a [a board-a target-a] :b [b board-b target-b]}
                  [from-p from-board from-target] (get ends from-key)
                  [to-p to-board to-target]       (get ends to-key)
                  from-end (connector-end from-p from-board from-target)
                  to-end   (connector-end to-p to-board to-target)
                  same?    (and (some? (:screen-id from-end))
                                (= (:screen-id from-end) (:screen-id to-end)))]
              (if (and same? (not (:include-same-screen? ctx)))
                :same-screen
                (cond-> {:id         (:id shape)
                         :name       (:name shape)
                         :type       (:type shape)
                         :direction  direction
                         :confidence confidence
                         :length     (Math/sqrt (dist2 a b))
                         :from       from-end
                         :to         to-end}
                  same?     (assoc :same-screen true)
                  composed? (assoc :composed true))))))))))

(defn- scan-connectors
  "The connectors among `candidates` (`[shape chain]` pairs, in order), all
  of them, until `deadline` (nanoTime). Returns `{:scanned n :connectors
  [...] :same-screen-skipped n :timed-out? bool}`. `:timed-out?` is true when
  the deadline passes before the candidates end."
  [ctx candidates deadline]
  (loop [todo    (seq candidates)
         scanned 0
         found   []
         skipped 0]
    (cond
      (nil? todo)
      {:scanned scanned :connectors found
       :same-screen-skipped skipped :timed-out? false}

      (>= (System/nanoTime) deadline)
      {:scanned scanned :connectors found
       :same-screen-skipped skipped :timed-out? true}

      :else
      (let [[shape chain] (first todo)
            connector     (find-connector ctx shape chain)]
        (recur (next todo)
               (inc scanned)
               (cond-> found
                 (map? connector) (conj connector))
               (if (= :same-screen connector) (inc skipped) skipped))))))

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
   [:offset {:optional true} [::sm/int {:min 0}]]
   [:within-id {:optional true} ::sm/uuid]
   [:depth {:optional true} [::sm/int {:min 1 :max boards/max-depth}]]
   [:mode {:optional true} [::sm/one-of #{:depth :auto}]]
   [:board-name-regex {:optional true} [:string {:max 200}]]
   [:include-same-screen {:optional true} :boolean]])

;; --- BOARD SELECTION

(defn- name-re-find
  "Whether `regex` finds a match in `chars`."
  [regex chars]
  (boolean (re-find (re-matcher regex chars))))

(defn- board-name-match
  "Whether the name of the board `shape` matches `regex`: true or false, or
  `:timeout` when the regex ran past `deadline`. A regex too deep for a name
  is refused as an invalid pattern."
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
  "Shapes drawn as connectors between two screens of a page: both ends snap
  to two different frames within `max-distance`. Candidates are the visible
  paths and booleans, and the groups drawn as an arrow (2 to 6 drawing
  children, elongated or thin, with a shaft and parts at its ends; `composed
  true`). Shallowest first. An arrow drawn inside a screen is found: an end
  that snaps to no frame takes its screen in place of the frame.
  The screens are the boards of the board selection (`depth`, `mode`,
  `board-name-regex`, as in `get-mcp-page-lint`; `selection` and
  `deeper-boards` in the reply). Each end reports its frame (`board-id`)
  and its screen: the nearest of the screens and the loose frames (visible
  frames outside every screen, such as a decision frame; a frame that holds a
  screen is neither) within `max-distance`. A screen in a wrapper (a frame
  that holds that one screen centered, with gaps of at most 400 px) is as
  near as its wrapper is: an end that lands on the wrapper belongs to the
  screen, and its `distance` is measured to the screen. A screen gives `screen-id` and
  `screen-name`; a loose frame, or nothing in reach, gives `non-screen true`.
  A connector whose ends lie in one screen is dropped and counted in
  `same-screen-skipped`; `include-same-screen` returns it with `same-screen
  true`. `non-screen-ends` counts the ends of the connectors that lie in no
  screen. The direction is `cap` (an arrow cap on one end of an open path),
  `shape` (a head found in the outline, rounded and blunt heads included, with
  `medium` confidence), `both` (two heads at the two ends) or `none`, with a
  `confidence`. `within-id` limits the candidates to the shapes under one
  shape. The order is the walk order, shallowest first, and depends only on
  the file at one `revn` and the params. `total` counts all connectors found
  (the counts `same-screen-skipped` and `non-screen-ends` cover all of them
  too). `offset` skips that many, then `limit` applies; `next-offset` is
  there when more remain and the scan did not time out. An `offset` past the
  end gives an empty list. The scan stops at five seconds: `timed-out true`,
  no `next-offset` (a later call could scan another list), and `total` is
  then what the scan found. `truncated` is true when connectors remain after the ones
  returned or the time limit cut the work."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]
                [:mcp-find/by-file :file-id]]
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:connectors}
  [cfg {:keys [::rpc/profile-id file-id page-id max-distance limit offset
               within-id depth mode board-name-regex include-same-screen]
        :as params}]
  (mcp/run-tool cfg "find-mcp-connectors" params
                (fn []
                  (mcp/check-access! cfg params profile-id file-id)
                  (let [file          (mcp/load-file-for-page cfg file-id page-id [])
                        data          (:data file)
                        revn          (:revn file)
                        objects       (:objects (mcp/get-page-data cfg file-id revn data page-id))
                        regex         (compile-board-regex board-name-regex)
                        deadline      (+ (System/nanoTime) search-budget-ns)
                        _             (when (and (some? within-id)
                                                 (not (contains? objects within-id)))
                                        (ex/raise :type :not-found
                                                  :code :shape-not-found
                                                  :hint "within-id shape not found in page"))
                        selected      (boards/select-boards
                                       objects
                                       {:depth      depth
                                        :mode       mode
                                        :deadline   deadline
                                        :name-match (when (some? regex)
                                                      (partial board-name-match regex deadline))})
                        entries       (get-walk-entries objects)
                        frames        (get-boards objects entries)
                        frame-parents (reduce (fn [acc board] (into acc (:ancestors board)))
                                              #{}
                                              frames)
                        candidates    (get-candidates objects entries within-id)
                        reach         (or max-distance default-max-distance)
                        screens       (set (:ids selected))
                        targets       (get-targets frames screens
                                                   (get-wrappers objects frames screens)
                                                   (:overlays selected))
                        ctx           {:objects              objects
                                       :board-index          (build-board-index frames reach)
                                       :frame-parents        frame-parents
                                       :resolve              (partial resolve-target
                                                                      (build-target-index targets reach)
                                                                      reach)
                                       :max-distance         reach
                                       :include-same-screen? (true? include-same-screen)}
                        result        (scan-connectors ctx candidates deadline)
                        all           (:connectors result)
                        total         (count all)
                        start         (min total (or offset 0))
                        end           (min total (+ start (or limit 500)))
                        connectors    (subvec all start end)
                        timed-out?    (boolean (or (:timed-out? result)
                                                   (:timed-out? selected)))]
                    [(cond-> {:revn                revn
                              :page-id             page-id
                              :scanned             (:scanned result)
                              :connectors          connectors
                              :total               total
                              :selection           (:selection selected)
                              :same-screen-skipped (:same-screen-skipped result)
                              :non-screen-ends     (count (filter :non-screen
                                                                  (mapcat (juxt :from :to) all)))
                              :truncated           (boolean (or timed-out? (< end total)))}
                       (and (< end total) (not timed-out?))
                       (assoc :next-offset end)
                       timed-out?
                       (assoc :timed-out true)
                       (some? (:deeper-boards selected))
                       (assoc :deeper-boards (:deeper-boards selected)))
                     {:file-id file-id
                      :page-ids [page-id]
                      :revn revn
                      :token-id (mcp/get-token-id params)}]))))
