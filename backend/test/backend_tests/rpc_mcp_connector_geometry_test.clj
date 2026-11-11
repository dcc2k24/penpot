;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-mcp-connector-geometry-test
  "Pure geometry of `find-mcp-connectors`: flattening, simplification, head
  tips and the direction of outlines and of arrows drawn as a group. No
  database."
  (:require
   [app.common.uuid :as uuid]
   [app.rpc.commands.mcp-prototype :as proto]
   [clojure.test :as t]))

;; --- HELPERS

(defn- pt
  [x y]
  {:x (double x) :y (double y)})

(defn- dist
  [p q]
  (Math/sqrt (+ (Math/pow (- (:x p) (:x q)) 2) (Math/pow (- (:y p) (:y q)) 2))))

(defn- move
  [x y]
  {:command :move-to :params {:x x :y y}})

(defn- line
  [x y]
  {:command :line-to :params {:x x :y y}})

(defn- curve
  [c1x c1y c2x c2y x y]
  {:command :curve-to :params {:c1x c1x :c1y c1y :c2x c2x :c2y c2y :x x :y y}})

(def ^:private close
  {:command :close-path :params {}})

(defn- polygon
  "Path content of the closed polygon through the points `ps` (pairs)."
  [ps]
  (concat [(move (ffirst ps) (second (first ps)))]
          (map (fn [[x y]] (line x y)) (rest ps))
          [close]))

(defn- circle-content
  "Path content of a circle of four curves, centre (`cx`, `cy`), radius `r`."
  [cx cy r]
  (let [k (* 0.5522847498 r)]
    [(move (+ cx r) cy)
     (curve (+ cx r) (+ cy k) (+ cx k) (+ cy r) cx (+ cy r))
     (curve (- cx k) (+ cy r) (- cx r) (+ cy k) (- cx r) cy)
     (curve (- cx r) (- cy k) (- cx k) (- cy r) cx (- cy r))
     (curve (+ cx k) (- cy r) (+ cx r) (- cy k) (+ cx r) cy)
     close]))

(defn map-content
  "The content with `f` applied to every x, y pair of every segment."
  [f content]
  (map (fn [{:keys [command params] :as segment}]
         (case command
           :close-path segment
           :curve-to   (let [[c1x c1y] (f (:c1x params) (:c1y params))
                             [c2x c2y] (f (:c2x params) (:c2y params))
                             [x y]     (f (:x params) (:y params))]
                         (assoc segment :params {:c1x c1x :c1y c1y :c2x c2x :c2y c2y :x x :y y}))
           (let [[x y] (f (:x params) (:y params))]
             (assoc segment :params {:x x :y y}))))
       content))

(defn- turner
  "A function of x, y that turns the point by `k` times 45 degrees about the
  origin and moves it to (400, 300)."
  [k]
  (let [a (Math/toRadians (* 45.0 k))
        c (Math/cos a)
        s (Math/sin a)]
    (fn [x y]
      [(+ 400.0 (- (* x c) (* y s)))
       (+ 300.0 (+ (* x s) (* y c)))])))

(def ^:private sizes
  "Three lengths of arrow in px."
  [60.0 200.0 600.0])

(defn arrow
  "A synthetic arrow of length `l` (tail near the origin, tip on the +x
  axis), as `{:content :tip :tail}` in local coordinates. The shaft is
  `0.04 l` wide, the head `0.15 l` long and `0.12 l` wide. `style` is
  :triangle, :barbs (swept-back barbs), :dot (a triangle head and a round dot
  at the tail), :curved (a quarter arc with a triangle head) or :chevron (a
  V of two strokes, apex angle 56 degrees, no shaft)."
  [style l]
  (let [wd (* 0.04 l)
        hl (* 0.15 l)
        hw (* 0.12 l)
        h  (/ wd 2)
        hh (/ hw 2)]
    (case style
      :triangle
      {:content (polygon [[0 (- h)] [(- l hl) (- h)] [(- l hl) (- hh)] [l 0]
                          [(- l hl) hh] [(- l hl) h] [0 h]])
       :tip     (pt l 0)
       :tail    (pt 0 0)}

      :barbs
      {:content (polygon [[0 (- h)] [(- l (* 0.8 hl)) (- h)] [(- l (* 1.4 hl)) (- hh)]
                          [l 0] [(- l (* 1.4 hl)) hh] [(- l (* 0.8 hl)) h] [0 h]])
       :tip     (pt l 0)
       :tail    (pt 0 0)}

      :dot
      {:content (concat (polygon [[0 (- h)] [(- l hl) (- h)] [(- l hl) (- hh)] [l 0]
                                  [(- l hl) hh] [(- l hl) h] [0 h]])
                        (circle-content 0 0 (* 0.035 l)))
       :tip     (pt l 0)
       :tail    (pt 0 0)}

      :curved
      (let [r  (/ (* 2.0 l) Math/PI)
            ro (+ r h)
            ri (- r h)
            k  0.5522847498]
        {:content [(move 0 (- r ro))
                   (curve (* k ro) (- r ro) ro (- r (* k ro)) ro r)
                   (line (+ r hh) r)
                   (line r (+ r hl))
                   (line (- r hh) r)
                   (line ri r)
                   (curve ri (- r (* k ri)) (* k ri) (- r ri) 0 (- r ri))
                   close]
         :tip     (pt r (+ r hl))
         :tail    (pt 0 0)})

      :chevron
      (let [a  (* 0.5 l)
            t  wd
            th (Math/toRadians 28.0)
            c  (Math/cos th)
            s  (Math/sin th)
            ex (- l (* a c))
            ey (* a s)]
        {:content (polygon [[l 0]
                            [ex (- ey)]
                            [(- ex (* t s)) (+ (- ey) (* t c))]
                            [(- l (/ t (Math/sin th))) 0]
                            [(- ex (* t s)) (- ey (* t c))]
                            [ex ey]])
         :tip     (pt l 0)
         :tail    (pt ex 0)}))))

(defn place
  "The arrow `a` turned by `k` times 45 degrees: its content and its tip and
  tail moved the same way."
  [a k]
  (let [f (turner k)
        p (fn [{:keys [x y]}] (let [[nx ny] (f x y)] (pt nx ny)))]
    (-> a
        (update :content #(vec (map-content f %)))
        (update :tip p)
        (update :tail p))))

(defn- rings-of
  "The simplified rings of the path content `content`."
  [content]
  (filterv seq (map #(proto/simplify-ring (:points %)) (proto/flatten-content content))))

(defn- direction-of
  "The result of `outline-direction` for the path content `content`."
  [content]
  (let [rings (rings-of content)]
    (proto/outline-direction rings (proto/shaft-width rings) #{})))

(defn- near-angle?
  [expected actual]
  (< (Math/abs (- expected actual)) 0.5))

(defn- close-to?
  [p q eps]
  (< (dist p q) eps))

(defn content->d
  "The SVG path data of the path content `content`."
  [content]
  (let [n (fn [x] (String/format java.util.Locale/ROOT "%.4f" (object-array [(double x)])))]
    (apply str
           (map (fn [{:keys [command params]}]
                  (case command
                    :move-to   (str "M " (n (:x params)) " " (n (:y params)) " ")
                    :line-to   (str "L " (n (:x params)) " " (n (:y params)) " ")
                    :curve-to  (str "C " (n (:c1x params)) " " (n (:c1y params)) " "
                                    (n (:c2x params)) " " (n (:c2y params)) " "
                                    (n (:x params)) " " (n (:y params)) " ")
                    :close-path "Z "))
                content))))

;; --- FLATTEN AND SIMPLIFY

(t/deftest flatten-a-square-keeps-its-corners
  (let [subpaths (proto/flatten-content (polygon [[0 0] [10 0] [10 10] [0 10]]))
        ring     (proto/simplify-ring (:points (first subpaths)))]
    (t/is (= 1 (count subpaths)))
    (t/is (true? (:closed? (first subpaths))))
    (t/is (= 4 (count ring)))
    (t/is (= [(pt 0 0) (pt 10 0) (pt 10 10) (pt 0 10)] ring))))

(t/deftest flatten-a-circle-of-four-curves-gives-many-points-on-the-circle
  (let [subpaths (proto/flatten-content (circle-content 50 50 20))
        points   (:points (first subpaths))
        ring     (proto/simplify-ring points)]
    (t/is (= (inc (* 4 proto/curve-samples)) (count points)) "the start and eight pieces per curve")
    (t/is (= (* 4 proto/curve-samples) (count ring)) "the closing point equals the start and is merged")
    (t/is (every? #(< (Math/abs (- (dist % (pt 50 50)) 20.0)) 0.2) ring) "every point is near the circle")))

(t/deftest flatten-a-rounded-bar-keeps-the-round-ends-as-many-points
  (let [r       10.0
        k       (* 0.5522847498 r)
        content [(move 10 0) (line 90 0)
                 (curve (+ 90 k) 0 100 (- 10 k) 100 10)
                 (curve 100 (+ 10 k) (+ 90 k) 20 90 20)
                 (line 10 20)
                 (curve (- 10 k) 20 0 (+ 10 k) 0 10)
                 (curve 0 (- 10 k) (- 10 k) 0 10 0)
                 close]
        ring    (proto/simplify-ring (:points (first (proto/flatten-content content))))]
    (t/is (<= 30 (count ring) 36) "four curves of eight pieces, two corners of lines")
    (t/is (= 4 (count (proto/simplify-ring [(pt 0 0) (pt 5 0) (pt 10 0) (pt 10 5) (pt 10 10) (pt 0 10)])))
          "points on a straight run go")
    (t/is (= [(pt 0 0) (pt 5 0)] (proto/simplify-ring [(pt 0 0) (pt 0.01 0) (pt 5 0)]))
          "close points merge")))

(t/deftest flatten-handles-several-subpaths
  (let [subpaths (proto/flatten-content (concat (polygon [[0 0] [10 0] [10 10]])
                                                (circle-content 50 50 5)
                                                [(move 80 0) (line 90 0)]))]
    (t/is (= [true true false] (map :closed? subpaths)))
    (t/is (= [3 33 2] (map (comp count :points) subpaths)))))

;; --- HEAD TIPS

(t/deftest every-arrow-style-gives-its-tip-at-the-head-end
  (doseq [style [:triangle :barbs :dot :curved :chevron]
          l     sizes
          k     (range 8)]
    (let [a      (place (arrow style l) k)
          result (direction-of (:content a))
          label  (str style " " l " " (* 45 k) " deg")]
      (t/is (= "shape" (:direction result)) label)
      (t/is (= :b (:head result)) label)
      (t/is (close-to? (:b result) (:tip a) (* 0.001 l)) (str label ": the tip"))
      (if (= :chevron style)
        (t/is (> (dist (:a result) (:b result)) (* 0.4 l)) label)
        (t/is (close-to? (:a result) (:tail a) (* 0.08 l)) (str label ": the tail")))
      (t/is (= "high" (:confidence result)) label))))

(t/deftest the-tip-of-a-triangle-arrow-has-the-expected-numbers
  (let [l       200.0
        a       (arrow :triangle l)
        rings   (rings-of (:content a))
        w       (proto/shaft-width rings)
        tips    (proto/find-head-tips rings w #{})]
    (t/is (= 1 (count tips)))
    (t/is (< 4.0 (:angle (first tips)) 80.0))
    (t/is (near-angle? 43.6 (:angle (first tips))))
    (t/is (< 6.0 w 10.0) "about 0.04 l")))

(t/deftest a-chevron-of-ninety-degrees-has-no-tip-on-the-axis
  ;; The apex of a V of 90 degrees is above `max-tip-angle`, so rule 1 sees no
  ;; tip. Rule 2 takes it as a wide tip, but the farthest point is the end of
  ;; an arm, 45 degrees off the bisector, above `tip-axis-angle` (20), so the
  ;; tip is lost. Any V lies this way. Documented, not tuned.
  (let [l 200.0
        t 8.0
        a (* 0.5 l)
        c (Math/cos (Math/toRadians 45.0))
        ex (- l (* a c))
        ey (* a c)
        content (polygon [[l 0] [ex (- ey)] [(- ex (* t c)) (+ (- ey) (* t c))]
                          [(- l (* t (Math/sqrt 2))) 0]
                          [(- ex (* t c)) (- ey (* t c))] [ex ey]])
        rings   (rings-of content)
        tips    (proto/find-head-tips rings (proto/shaft-width rings) #{})
        result  (direction-of content)]
    (t/is (empty? tips))
    (t/is (not= "high" (:confidence result)))
    (t/is (not= "both" (:direction result)))))

;; --- NOT ARROWS

(t/deftest bars-circles-and-dividers-have-no-direction
  (let [bar     (polygon [[0 0] [200 0] [200 8] [0 8]])
        divider (polygon [[0 0] [300 0] [300 1] [0 1]])
        r       4.0
        k       (* 0.5522847498 r)
        rounded [(move 4 0) (line 196 0)
                 (curve (+ 196 k) 0 200 (- 4 k) 200 4)
                 (curve 200 (+ 4 k) (+ 196 k) 8 196 8)
                 (line 4 8)
                 (curve (- 4 k) 8 0 (+ 4 k) 0 4)
                 (curve 0 (- 4 k) (- 4 k) 0 4 0)
                 close]]
    (doseq [[label content] {"plain bar" bar "thin divider" divider "rounded bar" rounded
                             "circle" (circle-content 100 100 30)}]
      (let [result (direction-of content)]
        (t/is (= "none" (:direction result)) label)
        (t/is (= "none" (:confidence result)) label)
        (t/is (nil? (:head result)) label)))))

(t/deftest a-bar-and-a-rounded-bar-turned-are-still-no-arrow
  (doseq [k (range 8)]
    (let [bar (vec (map-content (turner k) (polygon [[0 0] [200 0] [200 8] [0 8]])))]
      (t/is (= "none" (:direction (direction-of bar))) (str k)))))

;; --- TWO HEADS, DIAMONDS

(t/deftest two-heads-give-both
  (doseq [l sizes
          k [0 1 3]]
    (let [wd (* 0.04 l) hl (* 0.15 l) hw (* 0.12 l) h (/ wd 2) hh (/ hw 2)
          content (vec (map-content
                        (turner k)
                        (polygon [[0 0] [hl (- hh)] [hl (- h)] [(- l hl) (- h)] [(- l hl) (- hh)]
                                  [l 0] [(- l hl) hh] [(- l hl) h] [hl h] [hl hh]])))
          result  (direction-of content)
          f       (turner k)
          [x0 y0] (f 0 0)
          [x1 y1] (f l 0)]
      (t/is (= "both" (:direction result)) (str l " " k))
      (t/is (= "medium" (:confidence result)))
      (t/is (nil? (:head result)))
      (t/is (or (and (close-to? (:a result) (pt x0 y0) (* 0.001 l))
                     (close-to? (:b result) (pt x1 y1) (* 0.001 l)))
                (and (close-to? (:a result) (pt x1 y1) (* 0.001 l))
                     (close-to? (:b result) (pt x0 y0) (* 0.001 l))))))))

(t/deftest a-flat-diamond-reads-as-two-heads-and-a-decision-diamond-as-none
  ;; Documented behaviour: a rhombus 100 by 20 has two corners of 22.6
  ;; degrees, each an extremity, so the rule reads it as `both`. A square
  ;; turned 45 degrees has four corners of 90 degrees and no tip.
  (let [flat (direction-of (polygon [[0 10] [50 0] [100 10] [50 20]]))
        sq   (direction-of (polygon [[50 0] [100 50] [50 100] [0 50]]))]
    (t/is (= "both" (:direction flat)))
    (t/is (= "medium" (:confidence flat)))
    (t/is (= "none" (:direction sq)))))

;; --- SHORT ARROWS WITH WIDE HEADS, ICONS

(def ^:private short-arrow-points
  "An arrow of 30 px: shaft of 14 px and stroke 2, head of 16 by 16."
  [[0 -1] [14 -1] [14 -8] [30 0] [14 8] [14 1] [0 1]])

(t/deftest a-short-arrow-with-a-wide-head-has-one-head-at-the-tip
  ;; Before the fix both barbs passed the tip test, three tips were found and
  ;; the direction came out `both`, with a barb and the tip as the ends.
  (doseq [k (range 8)]
    (let [content (vec (map-content (turner k) (polygon short-arrow-points)))
          result  (direction-of content)
          [tx ty] ((turner k) 30 0)
          [ox oy] ((turner k) 0 0)]
      (t/is (= "shape" (:direction result)) (str k))
      (t/is (= :b (:head result)) (str k))
      (t/is (close-to? (:b result) (pt tx ty) 0.001) (str k ": the head is the tip"))
      (t/is (close-to? (:a result) (pt ox oy) 1.5) (str k ": the tail is the far end")))))

(t/deftest a-short-arrow-with-a-wide-head-has-three-tips-and-no-double-head
  (let [rings (rings-of (polygon short-arrow-points))
        tips  (proto/find-head-tips rings (proto/shaft-width rings) #{})]
    (t/is (= 3 (count tips)) "the tip and the two barbs")
    (t/is (= (pt 30 0) (:point (apply max-key :reach tips))) "the most extreme tip is the head")))

(t/deftest a-caret-and-a-play-triangle-are-not-double-headed
  ;; Icons, not arrows. The caret has two sharp tips at the ends of its strokes
  ;; (45 degrees each): one head, a tip at a stroke end. The play triangle has
  ;; three tips, and with `w` 3.7 px its length of 13.4 px is under
  ;; `wide-tip-elongation` times `w` (14.8 px), so it is not read as two heads:
  ;; one head, `shape`.
  (let [play  (direction-of (polygon [[0 0] [12 6] [0 12]]))
        caret (direction-of (polygon [[0 0] [2 0] [8 6] [2 12] [0 12] [6 6]]))]
    (t/is (= "shape" (:direction play)))
    (t/is (not= "both" (:direction caret)))))

;; --- DENSELY SAMPLED OUTLINES

(defn- densify
  "The points of the closed polygon `ps` (pairs) with a point every `step` px
  along its edges."
  [ps step]
  (let [closed (concat ps [(first ps)])]
    (vec (mapcat (fn [[x1 y1] [x2 y2]]
                   (let [len (Math/hypot (- x2 x1) (- y2 y1))
                         n   (max 1 (int (Math/ceil (/ len step))))]
                     (for [i (range n)]
                       [(+ x1 (* (/ i (double n)) (- x2 x1)))
                        (+ y1 (* (/ i (double n)) (- y2 y1)))])))
                 closed
                 (rest closed)))))

(t/deftest a-circle-of-six-thousand-points-keeps-its-shape
  ;; Before the fix each point was checked against its own neighbours only,
  ;; so the error added up and the circle came out as 6 points.
  (let [n       6000
        pts     (for [i (range n)]
                  (let [a (* 2 Math/PI (/ i (double n)))]
                    [(* 100 (Math/cos a)) (* 100 (Math/sin a))]))
        content (polygon pts)
        ring    (first (rings-of content))
        area    (#'proto/ring-area ring)
        circle  (* Math/PI 100.0 100.0)]
    (t/is (< 40 (count ring)) "a polygon that follows the circle")
    (t/is (< (/ (Math/abs (- area circle)) circle) 0.01) "within 1% of the area")
    (t/is (empty? (proto/find-head-tips [ring] (proto/shaft-width [ring]) #{})))
    (t/is (= "none" (:direction (direction-of content))))))

(t/deftest an-arrow-sampled-every-pixel-gives-the-tip-of-the-sparse-arrow
  (let [pts     [[0 -4] [170 -4] [170 -12] [200 0] [170 12] [170 4] [0 4]]
        sparse  (direction-of (polygon pts))
        dense   (direction-of (polygon (densify pts 1.0)))]
    (t/is (= "shape" (:direction sparse)))
    (t/is (= (:direction sparse) (:direction dense)))
    (t/is (= (:confidence sparse) (:confidence dense)))
    (t/is (close-to? (:b sparse) (:b dense) 0.001) "the same tip")
    (t/is (close-to? (:a sparse) (:a dense) 4.01) "the tail is one of the tail corners")
    (t/is (= 200.0 (:x (:b dense))))))

;; --- HOLES IN THE SHAFT WIDTH

(t/deftest the-shaft-width-of-a-ring-takes-the-hole-off
  ;; Outer radius 50, inner radius 40: a ring 10 px wide. Adding the hole
  ;; gave 45 px.
  (let [rings (rings-of (concat (circle-content 100 100 50) (circle-content 100 100 40)))
        solid (rings-of (circle-content 100 100 50))]
    (t/is (= 2 (count rings)))
    (t/is (< (Math/abs (- 10.0 (proto/shaft-width rings))) 0.3))
    (t/is (< (Math/abs (- 50.0 (proto/shaft-width solid))) 0.5) "a disc: its radius")))

(defn- poly-area
  [ps]
  (Math/abs (* 0.5 (reduce + (map (fn [[x1 y1] [x2 y2]] (- (* x1 y2) (* x2 y1)))
                                  ps (concat (rest ps) [(first ps)]))))))

(defn- poly-perimeter
  [ps]
  (reduce + (map (fn [[x1 y1] [x2 y2]] (Math/hypot (- x2 x1) (- y2 y1)))
                 ps (concat (rest ps) [(first ps)]))))

(t/deftest a-hollow-arrow-outline-has-its-width-and-its-tip
  (let [outer  [[0 -4] [170 -4] [170 -12] [200 0] [170 12] [170 4] [0 4]]
        ;; the same arrow 2 px smaller on each side, wholly inside the outer one
        inner  [[2 -2] [172 -2] [172 -8] [192 0] [172 8] [172 2] [2 2]]
        hollow (concat (polygon outer) (polygon inner))
        rings  (rings-of hollow)
        w      (proto/shaft-width rings)
        want   (/ (* 2.0 (- (poly-area outer) (poly-area inner)))
                  (+ (poly-perimeter outer) (poly-perimeter inner)))
        solid  (proto/shaft-width (rings-of (polygon outer)))
        result (direction-of hollow)]
    (t/is (= 2 (count rings)))
    (t/is (< (Math/abs (- want w)) 1.0E-6))
    (t/is (< w (* 0.5 solid)) "far below the width of the solid arrow")
    (t/is (= "shape" (:direction result)))
    (t/is (= :b (:head result)))
    (t/is (close-to? (:b result) (pt 200 0) 0.001))))

;; --- ROUNDED AND BLUNT TIPS, WIDE HEADS

(defn- tip-arrow
  "A synthetic arrow of length `l` along +x with the shaft `0.04 l` wide and
  a head `0.12 l` wide and `0.15 l` long (`0.06 l`, a 90 degree point, for
  `:wide`), as `{:content :tip :tail}`. `tip` is `{:kind ...}`:
  - `:sharp`: a point;
  - `:blunt` and `:b`: a flat end `b` px wide;
  - `:rounded` and `:r` (px, or `:half-shaft`): an arc of that radius, as
    `:segments` (a polyline of 12 pieces) or `:curve` (one cubic);
  - `:wide`: a point of 90 degrees.
  `:tip` is the point that the rule should find."
  [l {:keys [kind r b mode]}]
  (let [wd (* 0.04 l)
        hl (if (= kind :wide) (* 0.06 l) (* 0.15 l))
        hh (* 0.06 l)
        h  (/ wd 2)
        back  [(move 0 (- h)) (line (- l hl) (- h)) (line (- l hl) (- hh))]
        front [(line (- l hl) hh) (line (- l hl) h) (line 0 h) close]]
    (case kind
      (:sharp :wide)
      {:content (vec (concat back [(line l 0)] front)) :tip (pt l 0) :tail (pt 0 0)}

      :blunt
      (let [xb (- l (/ (* hl (/ b 2)) hh))]
        {:content (vec (concat back [(line xb (- (/ b 2))) (line xb (/ b 2))] front))
         :tip (pt xb 0) :tail (pt 0 0)})

      :rounded
      (let [r     (if (= :half-shaft r) h r)
            alpha (Math/atan2 hh hl)
            c     (/ r (Math/sin alpha))
            t     (/ r (Math/tan alpha))
            cx    (- l c)
            t1x   (- l (* t (Math/cos alpha)))
            t1y   (- (* t (Math/sin alpha)))
            phi1  (Math/atan2 t1y (- t1x cx))
            phi2  (- phi1)
            at    (fn [phi] [(+ cx (* r (Math/cos phi))) (* r (Math/sin phi))])
            arc   (if (= mode :curve)
                    (let [hk (* (/ 4.0 3.0) (Math/tan (/ (- phi2 phi1) 4.0)) r)
                          [p1x p1y] (at phi1)
                          [p2x p2y] (at phi2)]
                      [(line p1x p1y)
                       (curve (- p1x (* hk (Math/sin phi1))) (+ p1y (* hk (Math/cos phi1)))
                              (+ p2x (* hk (Math/sin phi2))) (- p2y (* hk (Math/cos phi2)))
                              p2x p2y)])
                    (mapv (fn [i] (let [[x y] (at (+ phi1 (* (/ i 12.0) (- phi2 phi1))))]
                                    (line x y)))
                          (range 13)))]
        {:content (vec (concat back arc front))
         :tip (pt (+ cx r) 0) :tail (pt 0 0)}))))

(def ^:private found-tip-cases
  "Arrows whose tip rule 2 finds at all three sizes, in 8 orientations."
  [["rounded r=1 as curve" {:kind :rounded :r 1.0 :mode :curve} [60.0 200.0 600.0]]
   ["rounded r=1 as segments" {:kind :rounded :r 1.0 :mode :segments} [200.0 600.0]]
   ["rounded r=2 as curve" {:kind :rounded :r 2.0 :mode :curve} [200.0 600.0]]
   ["rounded r=2 as segments" {:kind :rounded :r 2.0 :mode :segments} [200.0 600.0]]
   ["blunt 1 px" {:kind :blunt :b 1.0} [60.0 200.0 600.0]]
   ["blunt 2 px" {:kind :blunt :b 2.0} [200.0 600.0]]
   ["a 90 degree head" {:kind :wide} [60.0 200.0 600.0]]])

(t/deftest rounded-and-blunt-tips-and-wide-heads-are-read-as-medium-arrows
  (doseq [[label tip ls] found-tip-cases
          l              ls
          k              (range 8)]
    (let [a      (place (tip-arrow l tip) k)
          rings  (rings-of (:content a))
          w      (proto/shaft-width rings)
          tips   (proto/find-head-tips rings w #{})
          result (direction-of (:content a))
          what   (str label " " l " " (* 45 k) " deg")]
      (t/is (= 1 (count tips)) what)
      (t/is (= (if (= :wide (:kind tip)) :wide :capped) (:kind (first tips))) what)
      (t/is (= "shape" (:direction result)) what)
      (t/is (= "medium" (:confidence result)) what)
      (t/is (= :b (:head result)) what)
      (t/is (close-to? (:b result) (:tip a) (* 0.02 l)) (str what ": the tip"))
      (t/is (close-to? (:a result) (:tail a) (* 0.05 l)) (str what ": the tail")))))

(def ^:private missed-tip-cases
  "Arrows that rule 2 does not read at the sizes given, kept as they are: the
  cap of the tip (an arc of `0.75 w` or longer, see `cap-max-share`) is too
  long, or the cap is too wide for the shaft. The direction is `none`; the
  old width test, which used to read some of them, is gone."
  [["rounded r=1 as segments" {:kind :rounded :r 1.0 :mode :segments} [60.0]]
   ["rounded r=2 as curve" {:kind :rounded :r 2.0 :mode :curve} [60.0]]
   ["rounded r=2 as segments" {:kind :rounded :r 2.0 :mode :segments} [60.0]]
   ["rounded half the shaft width as curve" {:kind :rounded :r :half-shaft :mode :curve} [60.0 200.0 600.0]]
   ["rounded half the shaft width as segments" {:kind :rounded :r :half-shaft :mode :segments} [60.0 200.0 600.0]]
   ["blunt 2 px" {:kind :blunt :b 2.0} [60.0]]])

(t/deftest rounded-and-blunt-tips-that-the-cap-rule-does-not-read-have-direction-none
  (doseq [[label tip ls] missed-tip-cases
          l              ls
          k              (range 8)]
    (let [a      (place (tip-arrow l tip) k)
          rings  (rings-of (:content a))
          w      (proto/shaft-width rings)
          what   (str label " " l " " (* 45 k) " deg")]
      (t/is (empty? (proto/find-head-tips rings w #{})) what)
      (t/is (= "none" (:direction (direction-of (:content a)))) what)
      (t/is (= "none" (:confidence (direction-of (:content a)))) what))))

(defn- capsule
  "Path content of a capsule `l` long and `t` wide, drawn from curves."
  [l t]
  (let [r (/ t 2.0)
        k (* 0.5522847498 r)]
    [(move r 0) (line (- l r) 0)
     (curve (+ (- l r) k) 0 l (- r k) l r)
     (curve l (+ r k) (+ (- l r) k) t (- l r) t)
     (line r t)
     (curve (- r k) t 0 (+ r k) 0 r)
     (curve 0 (- r k) (- r k) 0 r 0)
     close]))

(t/deftest shapes-that-are-no-arrows-gain-no-tip-from-rule-2
  (doseq [l sizes
          k (range 8)]
    (let [r  (* 0.04 l)
          shapes {"plain bar"       (polygon [[0 0] [l 0] [l r] [0 r]])
                  "divider"         (polygon [[0 0] [l 0] [l 1] [0 1]])
                  "capsule"         (capsule l (* 0.1 l))
                  "thin capsule"    (capsule l r)
                  "circle"          (circle-content (* 0.5 l) (* 0.5 l) (* 0.25 l))
                  "square on corner" (polygon [[(* 0.5 l) 0] [l (* 0.5 l)] [(* 0.5 l) l] [0 (* 0.5 l)]])}]
      (doseq [[label content] shapes]
        (let [moved  (vec (map-content (turner k) content))
              rings  (rings-of moved)
              tips   (proto/find-head-tips rings (proto/shaft-width rings) #{})
              what   (str label " " l " " (* 45 k) " deg")]
          (t/is (empty? tips) what)
          (t/is (= "none" (:direction (direction-of moved))) what))))))

(t/deftest a-flat-rhombus-keeps-its-two-sharp-tips-and-gains-no-other
  (doseq [k (range 8)]
    (let [moved (vec (map-content (turner k) (polygon [[0 10] [50 0] [100 10] [50 20]])))
          rings (rings-of moved)
          tips  (proto/find-head-tips rings (proto/shaft-width rings) #{})]
      (t/is (= [:sharp :sharp] (map :kind tips)) (str k))
      (t/is (= "both" (:direction (direction-of moved))) (str k)))))

(t/deftest a-rounded-square-gets-no-capped-tip-as-it-is-not-elongated
  ;; Not an arrow. Each rounded corner is a cap between two long edges that
  ;; meet at 90 degrees, but the outline (diagonal 141 px, `w` 50 px) is not
  ;; `wide-tip-elongation` times `w` long, so rule 2 does not run.
  (let [r       10.0
        k       (* 0.5522847498 r)
        content [(move 10 0) (line 90 0) (curve (+ 90 k) 0 100 (- 10 k) 100 10)
                 (line 100 90) (curve 100 (+ 90 k) (+ 90 k) 100 90 100)
                 (line 10 100) (curve (- 10 k) 100 0 (+ 90 k) 0 90)
                 (line 0 10) (curve 0 (- 10 k) (- 10 k) 0 10 0)
                 close]
        rings   (rings-of content)
        tips    (proto/find-head-tips rings (proto/shaft-width rings) #{})]
    (t/is (empty? tips))
    (t/is (not= "both" (:direction (direction-of content))))))

;; --- RECTANGLES, TAGS AND TAPERED BARS (RULE 2 NEEDS THE AXIS)

(t/deftest a-plain-rectangle-has-no-tip-and-is-never-double-headed
  ;; Before the axis test the four 90 degree corners of a rectangle with an
  ;; aspect of 3:1 to 5:1 all passed the wide-tip test: `both`, medium.
  (doseq [[w h] [[100 30] [160 40] [200 40] [200 50] [200 66] [300 80] [400 100] [600 120] [800 200]]
          k     (range 8)]
    (let [content (vec (map-content (turner k) (polygon [[0 0] [w 0] [w h] [0 h]])))
          rings   (rings-of content)
          tips    (proto/find-head-tips rings (proto/shaft-width rings) #{})
          result  (direction-of content)
          what    (str w "x" h " " (* 45 k) " deg")]
      (t/is (empty? tips) what)
      (t/is (not= "both" (:direction result)) what)
      (t/is (= "none" (:direction result)) what))))

(t/deftest a-tag-has-direction-none
  ;; A rect of 200 by 50 with a pointed right side. The point (79.6 degrees)
  ;; has edges of 39 px, under 1.2 `w` (47), so it is no sharp tip; the square
  ;; back corners are wide tips but miss the axis by 38 degrees. No head is
  ;; read, and the old width test, which named the square back, is gone.
  (doseq [k (range 8)]
    (let [content (vec (map-content (turner k) (polygon [[0 0] [170 0] [200 25] [170 50] [0 50]])))
          rings   (rings-of content)
          tips    (proto/find-head-tips rings (proto/shaft-width rings) #{})
          result  (direction-of content)]
      (t/is (empty? tips) (str k))
      (t/is (not= "both" (:direction result)) (str k))
      (t/is (= "none" (:direction result)) (str k))
      (t/is (= "none" (:confidence result)) (str k))
      (t/is (nil? (:head result)) (str k)))))

(t/deftest a-bar-that-narrows-has-direction-none
  ;; 10 px wide at the back, 4 px at the front. Rule 2 gives no tip, and the
  ;; old width test, which named the wide end, is gone.
  (doseq [k (range 8)]
    (let [content (vec (map-content (turner k) (polygon [[0 -5] [200 -2] [200 2] [0 5]])))
          rings   (rings-of content)
          tips    (proto/find-head-tips rings (proto/shaft-width rings) #{})
          result  (direction-of content)]
      (t/is (empty? tips) (str k))
      (t/is (not= "both" (:direction result)) (str k))
      (t/is (= "none" (:direction result)) (str k))
      (t/is (= "none" (:confidence result)) (str k)))))

;; --- ARROWS DRAWN AS A GROUP

(defn- rect-shape
  "A rect child with the corner `points` of the box `x`, `y`, `w`, `h` turned
  by `k` times 45 degrees (the rect is turned about the origin, as the
  arrows are)."
  [id x y w h k]
  (let [f (turner k)]
    {:id id :type :rect :hidden false
     :points (mapv (fn [[px py]] (let [[nx ny] (f px py)] (pt nx ny)))
                   [[x y] [(+ x w) y] [(+ x w) (+ y h)] [x (+ y h)]])}))

(defn- path-shape
  [id content k]
  {:id id :type :path :hidden false :content (vec (map-content (turner k) content))})

(t/deftest an-arrow-drawn-as-a-rect-and-a-triangle-has-its-head-found
  (doseq [l sizes
          k [0 2 4 6 1 5]]
    (let [wd (* 0.04 l) hl (* 0.15 l) hw (* 0.12 l)
          parts (mapv #'proto/child-part
                      [(rect-shape (uuid/next) 0 (- (/ wd 2)) (- l hl) wd k)
                       (path-shape (uuid/next)
                                   (polygon [[(- l hl) (- (/ hw 2))] [l 0] [(- l hl) (/ hw 2)]])
                                   k)])
          result (proto/composed-direction parts)
          [tx ty] ((turner k) l 0)]
      (t/is (= "shape" (:direction result)) (str l " " k))
      (t/is (= :b (:head result)))
      (t/is (close-to? (:b result) (pt tx ty) (* 0.001 l)) (str l " " k))
      (t/is (= "high" (:confidence result)) (str l " " k)))))

(t/deftest a-line-path-shaft-with-a-triangle-head-is-found
  (let [l     200.0
        line  {:id (uuid/next) :type :path :hidden false
               :content (vec (map-content (turner 0) [(move 0 0) (line 170 0)]))
               :strokes [{:stroke-width 3.0}]}
        head  (path-shape (uuid/next) (polygon [[170 -12] [200 0] [170 12]]) 0)
        parts (mapv #'proto/child-part [line head])
        out   (proto/composed-direction parts)]
    (t/is (= "shape" (:direction out)))
    (t/is (close-to? (:b out) (pt 600 300) 0.001))
    (t/is (= 200.0 l))))

(defn- arrow-points
  "The closed outline of an arrow of length `l` along +x, from `x0`, with a
  shaft of width `sw` and a head `hl` long and `hw` wide."
  [x0 y0 l sw hl hw]
  (let [h (/ sw 2.0) hh (/ hw 2.0)]
    (mapv (fn [[x y]] [(+ x0 x) (+ y0 y)])
          [[0 (- h)] [(- l hl) (- h)] [(- l hl) (- hh)] [l 0]
           [(- l hl) hh] [(- l hl) h] [0 h]])))

(defn- flipped
  "The points `ps` mirrored left to right inside the arrow box of length `l`
  that starts at `x0`."
  [ps x0 l]
  (mapv (fn [[x y]] [(- (+ x0 l) (- x x0)) y]) ps))

(defn- group-fixture
  "Objects of a page with one group of the `children` (maps with :type, and
  a box) and the group box `x`, `y`, `w`, `h`. Returns `[objects entries
  gid]`."
  [children [x y w h]]
  (let [gid  (uuid/next)
        kids (mapv (fn [c] (assoc c :id (uuid/next) :parent-id gid :hidden false)) children)
        group {:id gid :type :group :parent-id uuid/zero :frame-id uuid/zero :hidden false
               :shapes (mapv :id kids)
               :x x :y y :width w :height h}
        objects (into {gid group uuid/zero {:id uuid/zero :type :frame :shapes [gid]}}
                      (map (juxt :id identity))
                      kids)]
    [objects (into [[1 group]] (map (fn [kid] [2 kid])) kids) gid]))

(defn- arrow-children
  "A shaft (a rect) and a triangle head (a path) of an arrow `l` long along
  +x: the shaft `0.04 l` wide, the head `0.15 l` long and `0.12 l` wide."
  [l]
  (let [wd (* 0.04 l) hl (* 0.15 l) hh (* 0.06 l)]
    [{:type :rect :x 0 :y (- (/ wd 2)) :width (- l hl) :height wd}
     {:type :path :content (polygon [[(- l hl) (- hh)] [l 0] [(- l hl) hh]])}]))

(defn- candidate-ids
  "The ids of the candidates that `get-candidates` finds in the group fixture."
  [objects entries]
  (mapv (comp :id first) (#'proto/get-candidates objects entries nil)))

(t/deftest a-group-is-a-candidate-only-with-the-anatomy-of-one-arrow
  (let [dot    {:type :rect :x 0 :y 0 :width 10 :height 4}
        arrow  (arrow-children 200)
        small  (arrow-children 20)
        wide   (arrow-children 300)
        cases  [["shaft and head" arrow [0 -12 200 24] true]
                ["six children" (into arrow (repeat 4 {:type :rect :x 175 :y -2 :width 10 :height 4}))
                 [0 -12 200 24] true]
                ["seven children" (into arrow (repeat 5 {:type :rect :x 175 :y -2 :width 10 :height 4}))
                 [0 -12 200 24] false]
                ["one child" (take 1 arrow) [0 -12 200 24] false]
                ["a text" [(first arrow) {:type :text}] [0 -12 200 24] false]
                ["a frame" [(first arrow) {:type :frame}] [0 -12 200 24] false]
                ["a group child" [(first arrow) {:type :group}] [0 -12 200 24] false]
                ["a square group" arrow [0 0 100 100] false]
                ["a small square group (thin by side)" small [0 0 20 20] true]
                ["elongated, not thin" wide [0 0 300 100] true]
                ["almost elongated" wide [0 0 299 100] false]
                ["a shaft that is too short for the group"
                 [(assoc (first arrow) :width 100) (second arrow)] [0 -12 200 24] false]
                ["a part far from both ends of the shaft"
                 (conj (vec arrow) (assoc dot :x 90 :y 40)) [0 -12 200 60] false]]]
    (doseq [[label children box expected] cases]
      (let [[objects entries gid] (group-fixture (vec children) box)
            found (candidate-ids objects entries)]
        (t/is (= expected (some? (some #{gid} found))) label)
        (when expected
          (t/is (= 1 (count found)) (str label ": the children are not candidates")))))))

(t/deftest the-children-of-a-group-that-is-no-candidate-stay-candidates
  (let [[objects entries _] (group-fixture [{:type :path} {:type :text}] [0 0 100 100])
        found (#'proto/get-candidates objects entries nil)]
    (t/is (= 1 (count found)) "the path child, not the group")
    (t/is (= :path (:type (ffirst found))))))

(t/deftest three-arrows-in-a-row-grouped-stay-three-connectors
  ;; Before the fix any group of 2 to 6 simple shapes with a long box was one
  ;; arrow: one connector over four screens, three real links lost.
  (let [arrows   (mapv (fn [x0] {:type :path
                                 :content (polygon (arrow-points x0 0 200 2 10 12))})
                       [0 800 1600])
        [objects entries gid] (group-fixture arrows [0 -6 1800 12])
        found    (#'proto/get-candidates objects entries nil)]
    (t/is (not (#'proto/composed-group? objects (get objects gid))))
    (t/is (= 3 (count found)) "the children, one each")
    (t/is (not-any? #(= gid (:id (first %))) found))
    (doseq [[shape _] found]
      (let [geometry (#'proto/path-geometry shape)]
        (t/is (= "shape" (:direction geometry)))
        (t/is (= :b (:head geometry)))
        (t/is (= 200.0 (- (:x (:b geometry)) (:x (:a geometry)))) "the tail is at the left, the tip at the right")))))

(t/deftest two-opposite-arrows-grouped-stay-two-connectors
  (let [right    (arrow-points 0 0 300 2 10 12)
        left     (mapv (fn [[x y]] [x (+ y 40)]) (flipped right 0 300))
        arrows   [{:type :path :content (polygon right)}
                  {:type :path :content (polygon left)}]
        [objects entries gid] (group-fixture arrows [0 -6 300 52])
        found    (#'proto/get-candidates objects entries nil)
        geometry (mapv (comp #'proto/path-geometry first) found)]
    (t/is (not (#'proto/composed-group? objects (get objects gid))))
    (t/is (= 2 (count found)))
    (t/is (= [:b :b] (mapv :head geometry)))
    (t/is (= [300.0 0.0] (mapv (comp :x :b) geometry)) "one head at the right, one at the left")))

(t/deftest a-shaft-with-a-head-at-each-end-is-one-composed-arrow-with-both-heads
  (let [kids   [{:type :rect :x 20 :y -4 :width 160 :height 8}
                {:type :path :content (polygon [[20 -12] [0 0] [20 12]])}
                {:type :path :content (polygon [[180 -12] [200 0] [180 12]])}]
        [objects entries gid] (group-fixture kids [0 -12 200 24])
        found  (candidate-ids objects entries)
        parts  (mapv (fn [kid] (#'proto/child-part (assoc kid :id (uuid/next)))) kids)
        result (proto/composed-direction parts)]
    (t/is (= [gid] found) "one candidate, the group")
    (t/is (= "both" (:direction result)))
    (t/is (= "medium" (:confidence result)))
    (t/is (= #{0.0 200.0} #{(:x (:a result)) (:x (:b result))}))))

(t/deftest a-divider-and-a-far-away-dot-are-not-one-arrow
  (let [kids [{:type :rect :x 0 :y 0 :width 300 :height 1}
              {:type :circle :x 897 :y -3 :width 6 :height 6}]
        [objects entries gid] (group-fixture kids [0 -3 906 6])
        found (candidate-ids objects entries)]
    (t/is (not (some #{gid} found)))
    (t/is (empty? found) "a rect and a circle are no candidates, and the group is no arrow")))
