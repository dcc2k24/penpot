;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.rpc.mcp-boards
  "Board selection of the backend-native MCP: which frames of a page the
  board tools treat as boards (the screens). Pure logic for
  `app.rpc.commands.mcp-lint` and for the connector search. It takes the
  `objects` of a page, never touches the database and must not require
  `app.rpc.commands.mcp`.

  There are two modes. Mode `:depth` takes the visible frames at most
  `depth` levels below the page root. Mode `:auto` finds the screens by
  size: frames of one size that occur at least three times, outside
  component instances, with guards against list rows, container layers and
  small frames. See `select-boards`."
  (:require
   [app.common.exceptions :as ex]
   [app.common.geom.rect :as grc]
   [app.common.types.component :as ctk]
   [app.common.uuid :as uuid]))

;; --- CONSTANTS

(def max-depth
  "Deepest level `:auto` looks at, and the largest `depth` a caller may ask
  for."
  12)

(def size-tolerance
  "Two frames have the same size when their widths and their heights differ
  by at most this many pixels."
  2)

(def min-class-size
  "Fewest frames of one size that make a size class qualify."
  3)

(def layer-ratio
  "A top class with fewer members than this share of the members of the
  classes directly inside it is a layer of containers, not the screens."
  0.1)

(def area-ratio
  "A frame is too small to be a board when its area is below this share of
  the area of the largest top class."
  0.1)

(def wrapper-height-ratio
  "A frame class that is a little taller than a standard screen class is a
  wrapper around its screens only when its height is at most this many times
  the height of the screen class. A caption under each screen fits (800 by
  660 over 800 by 600 is 1.1); a scrolling screen (390 by 2000 over 390 by
  844) does not."
  1.25)

(def max-wrapper-margin
  "A frame that holds exactly one screen is a wrapper by margin when the gap
  between its edge and the screen is at most this many px on every side."
  200)

(def margin-tolerance
  "The four gaps of a wrapper by margin differ by at most this many px."
  2)

(def max-centered-margin
  "A frame that holds exactly one screen centered in it (the gaps on opposite
  sides equal) takes the ends of connectors for that screen when the gaps
  are at most this many px."
  400)

(def overlay-min-share
  "A sibling frame is an overlay of a screen when at least this share of its
  own area lies over the screen."
  0.5)

(def far-larger-ratio
  "A loose board that is larger than the screens in both directions and has
  at least this many times the area of the largest screen class is a section
  or a wrapper, not a screen."
  4)

(def pair-area-ratio
  "A loose board of a non-standard size that holds a frame of its own size or
  sits in one (an annotation holding its widget) is not a screen when its
  area is under this share of the area of the smallest screen class, unless
  it is portrait (a phone is taller than wide by `portrait-ratio`)."
  0.5)

(def portrait-ratio
  "A frame at least this many times taller than wide is portrait."
  1.5)

(def wrapper-share
  "A class is a wrapper by margin only when at least this share of its frames
  hold exactly one screen with an even margin."
  0.9)

(def min-screen-side
  "A candidate board is at least this many px wide and this many px high.
  List rows, buttons, chips and small cards stay under it, so they never
  form a size class and are never loose boards."
  200)

(def ^:private standard-sizes
  "Standard screen sizes as `[width height]`, portrait orientation of a
  landscape entry counts too (see `standard-size?`). The list comes from
  common device and frame presets (desktop, kiosk and embedded, tablet and
  phone). It is meant to grow: add a preset here when a real page uses one
  that is missing."
  [;; desktop
   [1920 1080] [2560 1440] [1680 1050] [1600 900] [1536 864] [1440 1024]
   [1440 900] [1366 768] [1280 1024] [1280 800] [1280 720] [1024 768]
   ;; kiosk and embedded
   [1024 600] [800 600] [800 480] [640 480] [480 320] [480 272]
   ;; tablet
   [1024 1366] [834 1194] [834 1112] [820 1180] [810 1080] [800 1280]
   [768 1024] [744 1133]
   ;; phone
   [440 956] [430 932] [428 926] [414 896] [414 736] [412 915] [412 892]
   [402 874] [393 852] [390 844] [375 812] [375 667] [360 800] [360 780]
   [360 740] [360 640] [320 568]])

(def ^:private default-frame-name
  "The names the editor gives a new frame: `Board` or `Frame`, with a number
  after the first ones (`Board 2`, `Frame 12`). Many bare boards share such a
  name because nobody named them, so it says nothing about which frame of a
  chain is the screen: `drop-nested` does not count it."
  #"^(Board|Frame)( \d+)?$")

(def max-sizes
  "Most size entries a `selection` reply lists."
  20)

(def max-other-sizes
  "Most entries `other-sizes` of an automatic `selection` lists."
  5)

(def max-qualifying-classes
  "Most qualifying size classes `select-auto` weighs: the ones with the most
  members. A page with more sizes than this repeated three times drops the
  rarest, which bounds the work on the nesting of the classes."
  50)

(def ^:private check-every
  "Entries between two looks at the clock while a page is walked."
  256)

(def max-ancestor-steps
  "Most ancestors `in-component?` walks up."
  1000)

;; --- BOXES AND WALKS

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

(defn- visible-children
  "Ids of the visible children of `parent-id`, in reverse stored order, so
  that pushing them on a stack puts the first child on top."
  [objects parent-id]
  (->> (:shapes (get objects parent-id))
       (remove #(:hidden (get objects %)))
       reverse))

(defn get-visible-entries
  "Pre-order `[level id]` entries of the visible shapes below `start-id`,
  down to `max-level` levels: the children of `start-id` are level 1. A
  hidden shape takes its subtree out of the walk. Missing shapes are
  skipped."
  [objects start-id max-level]
  (loop [stack (into [] (map #(vector 1 %)) (visible-children objects start-id))
         out   []]
    (if-let [[level id] (peek stack)]
      (let [stack (pop stack)]
        (if (some? (get objects id))
          (recur (cond-> stack
                   (< level max-level)
                   (into (map #(vector (inc level) %)) (visible-children objects id)))
                 (conj out [level id]))
          (recur stack out)))
      out)))

(defn component-shape?
  "Whether `shape` is a component head, a main instance or a component copy
  shape."
  [shape]
  (boolean
   (or (ctk/instance-head? shape)
       (ctk/main-instance? shape)
       (ctk/in-component-copy? shape))))

(defn in-component?
  "Whether `shape` is, or lies inside, a component instance: it or one of its
  ancestors is a component head, a main instance or a component copy. The
  walk goes up through `:parent-id` in `objects` and stops at the page root,
  at a missing shape, at a shape that is its own parent, and after
  `max-ancestor-steps` steps."
  [objects shape]
  (loop [shape shape
         steps 0]
    (let [parent-id (:parent-id shape)]
      (cond
        (nil? shape)
        false

        (component-shape? shape)
        true

        (or (> steps max-ancestor-steps)
            (= parent-id uuid/zero)
            (= parent-id (:id shape)))
        false

        :else
        (recur (get objects parent-id) (inc steps))))))

(defn walk-frames
  "The visible frames of the page `objects` in pre-order, at any depth, as
  entries `{:id :level :index :comp? :name :w :h :x0 :y0 :parent :anc}`. `:level`
  is 1 for a child of the page root, `:x0` and `:y0` the corner of the box,
  `:parent` the id of the parent shape, `:index` the position in this walk, `:comp?` whether the
  frame is, or lies inside, a component instance, `:w` and `:h` the size of
  its box (see `get-box`) and `:anc` the set of the ids of its frame
  ancestors. A hidden shape takes its subtree out of the walk, a missing
  shape is skipped and a shape met twice is walked once. The walk stops at
  `deadline` (nanoTime). Returns `{:frames [...] :timed-out? bool}`."
  [objects deadline]
  (loop [stack  (into [] (map #(vector 1 % false #{})) (visible-children objects uuid/zero))
         frames []
         seen   #{}
         n      0]
    (if-let [[level id comp? anc] (peek stack)]
      (if (and (zero? (mod n check-every))
               (>= (System/nanoTime) deadline))
        {:frames frames :timed-out? true}
        (let [stack (pop stack)
              shape (get objects id)]
          (if (or (nil? shape) (contains? seen id))
            (recur stack frames seen n)
            (let [comp?  (or comp? (component-shape? shape))
                  frame? (= :frame (:type shape))
                  anc'   (cond-> anc frame? (conj id))
                  box    (when frame? (get-box shape))]
              (recur (into stack
                           (map #(vector (inc level) % comp? anc'))
                           (visible-children objects id))
                     (cond-> frames
                       frame?
                       (conj {:id    id
                              :level level
                              :index (count frames)
                              :comp? comp?
                              :name  (:name shape)
                              :w     (- (:x1 box) (:x0 box))
                              :h     (- (:y1 box) (:y0 box))
                              :x0    (:x0 box)
                              :y0    (:y0 box)
                              :parent (:parent-id shape)
                              :anc   anc}))
                     (conj seen id)
                     (inc n))))))
      {:frames frames :timed-out? false})))

;; --- SIZE CLASSES

(defn- round3
  "The number `x` rounded to three decimals; a whole number comes back as a
  long."
  [x]
  (let [r (/ (Math/round (* 1000.0 x)) 1000.0)]
    (if (== r (Math/rint r))
      (long r)
      r)))

(defn- cell-of
  "The grid cell of the size `w` by `h`. A cell is one more than the size
  tolerance wide, so frames of one size lie in neighbouring cells."
  [w h]
  (let [side (double (inc size-tolerance))]
    [(long (Math/floor (/ w side)))
     (long (Math/floor (/ h side)))]))

(defn- same-size?
  "Whether the sizes `aw` by `ah` and `bw` by `bh` differ by at most
  `size-tolerance` on each side."
  [aw ah bw bh]
  (and (<= (Math/abs (double (- aw bw))) size-tolerance)
       (<= (Math/abs (double (- ah bh))) size-tolerance)))

(defn group-size-classes
  "Groups the frame entries `entries` (see `walk-frames`) into size classes,
  greedily in the order given: a frame joins the first class whose first
  member has the same size (see `size-tolerance`), or opens a new class.
  Returns `{:classes [{:w :h :members [...]}] :class-of {id class-index}}`;
  `:w` and `:h` are those of the first member."
  [entries]
  (loop [entries (seq entries)
         classes []
         cells   {}]
    (if (nil? entries)
      {:classes  classes
       :class-of (into {}
                       (comp (map-indexed (fn [i c] (map #(vector (:id %) i) (:members c))))
                             cat)
                       classes)}
      (let [{:keys [w h] :as entry} (first entries)
            [cx cy] (cell-of w h)
            near    (for [dx [-1 0 1]
                          dy [-1 0 1]
                          idx (get cells [(+ cx dx) (+ cy dy)])
                          :let [c (nth classes idx)]
                          :when (same-size? w h (:w c) (:h c))]
                      idx)
            found   (when (seq near) (apply min near))]
        (if (some? found)
          (recur (next entries)
                 (update-in classes [found :members] conj entry)
                 cells)
          (recur (next entries)
                 (conj classes {:w w :h h :members [entry]})
                 (update cells [cx cy] (fnil conj []) (count classes))))))))

(defn- expired?
  "Whether `deadline` (nanoTime) has passed. A nil deadline never does."
  [deadline]
  (and (some? deadline) (>= (System/nanoTime) deadline)))

(defn- get-inside-map
  "For each class of `qualifying` (a set of class indexes), the set of the
  qualifying classes it lies inside: class A lies inside class B when more
  than half of the members of A have an ancestor that is a member of B."
  [classes class-of qualifying]
  (into {}
        (for [a qualifying]
          (let [members (:members (nth classes a))
                size    (count members)
                counts  (frequencies
                         (mapcat (fn [m]
                                   (->> (:anc m)
                                        (keep class-of)
                                        (filter qualifying)
                                        (remove #(= a %))
                                        distinct))
                                 members))]
            [a (into #{}
                     (comp (filter (fn [[_ n]] (> (* 2 n) size)))
                           (map key))
                     counts)]))))

(defn- top-classes
  "The classes of `qualifying` that lie inside no other class of it."
  [inside qualifying]
  (filterv (fn [t] (not-any? qualifying (get inside t))) (sort qualifying)))

(defn- direct-inside
  "The classes of `qualifying` that lie directly inside the class `top`:
  inside it, and inside no other class of `qualifying` that lies inside it."
  [inside qualifying top]
  (filterv (fn [a]
             (and (contains? (get inside a) top)
                  (not-any? (fn [c]
                              (and (contains? (get inside a) c)
                                   (contains? (get inside c) top)))
                            qualifying)))
           (sort qualifying)))

(defn- remove-container-layers
  "Takes the layers of containers out of the qualifying classes. A top class
  with fewer members than `layer-ratio` of the members of the classes
  directly inside it is a layer, for example sections of equal size around
  the screens. The layers go, the top classes are computed again and this
  repeats until nothing changes. Returns the top classes that are left, or
  nil when `deadline` (nanoTime) passed first."
  [classes inside qualifying deadline]
  (let [size (fn [i] (count (:members (nth classes i))))]
    (loop [q qualifying]
      (if (expired? deadline)
        nil
        (let [tops   (top-classes inside q)
              layers (reduce (fn [out t]
                               (if (expired? deadline)
                                 (reduced nil)
                                 (let [inner (reduce + (map size (direct-inside inside q t)))]
                                   (cond-> out
                                     (< (size t) (* layer-ratio inner)) (conj t)))))
                             []
                             tops)]
          (cond
            (nil? layers) nil
            (seq layers)  (recur (reduce disj q layers))
            :else         tops))))))

(defn- class-area
  "The area of the class `c`: the width times the height of its first
  member."
  [c]
  (* (:w c) (:h c)))

(defn exact-standard-size?
  "Whether the size `w` by `h` is a listed standard screen size: each side is
  within `size-tolerance` of an entry of `standard-sizes`, in either
  orientation."
  [w h]
  (boolean
   (some (fn [[ew eh]] (or (same-size? w h ew eh) (same-size? w h eh ew)))
         standard-sizes)))

(defn standard-size?
  "Whether the size `w` by `h` is a standard screen size: an exact size
  (`exact-standard-size?`), or the width is within `size-tolerance` of an
  entry's width and the height is above that entry's height (a screen made
  taller to hold scrolling content). The taller rule applies to an entry in
  its listed orientation only: the list gives each entry in its natural
  one."
  [w h]
  (boolean
   (or (exact-standard-size? w h)
       (some (fn [[ew eh]]
               (and (<= (Math/abs (double (- w ew))) size-tolerance)
                    (> h eh)))
             standard-sizes))))

(defn even-margin?
  "Whether the box `inner` lies inside the box `outer` with an even margin:
  the four gaps are not negative, at most `max-wrapper-margin` and within
  `margin-tolerance` of each other. Boxes are `{:x0 :y0 :x1 :y1}` (see
  `get-box`)."
  [outer inner]
  (let [gaps [(- (:x0 inner) (:x0 outer))
              (- (:y0 inner) (:y0 outer))
              (- (:x1 outer) (:x1 inner))
              (- (:y1 outer) (:y1 inner))]]
    (and (every? #(and (>= % (- margin-tolerance)) (<= % max-wrapper-margin)) gaps)
         (<= (- (reduce max gaps) (reduce min gaps)) margin-tolerance))))

(defn centered-margin?
  "Whether the box `inner` lies inside the box `outer` centered: the gaps on
  opposite sides are not negative, within `margin-tolerance` of each other,
  and at most `max-centered-margin`. A looser test than `even-margin?`: a
  wrapper of 1480 by 1000 around 800 by 600 (340 px left and right, 200 px
  above and below) passes."
  ([outer inner]
   (centered-margin? outer inner max-centered-margin))
  ([outer inner max-gap]
  (let [l (- (:x0 inner) (:x0 outer))
        t (- (:y0 inner) (:y0 outer))
        r (- (:x1 outer) (:x1 inner))
        b (- (:y1 outer) (:y1 inner))]
    (and (every? #(and (>= % (- margin-tolerance)) (<= % max-gap)) [l t r b])
         (<= (Math/abs (double (- l r))) margin-tolerance)
         (<= (Math/abs (double (- t b))) margin-tolerance)))))

(defn- entry-box
  "The box of a frame entry (see `walk-frames`) as `{:x0 :y0 :x1 :y1}`."
  [m]
  {:x0 (:x0 m) :y0 (:y0 m) :x1 (+ (:x0 m) (:w m)) :y1 (+ (:y0 m) (:h m))})

(defn- wrapper-margin?
  "Whether the entry `inner` lies in the entry `outer` with the margin of a
  wrapper: centered (`centered-margin?`) with gaps of at most
  `max-wrapper-margin`. A 1000 by 800 frame around a screen of 800 by 480 has
  100 px at the sides and 160 px above and below."
  [outer inner]
  (and (> (:w outer) (+ (:w inner) size-tolerance))
       (> (:h outer) (+ (:h inner) size-tolerance))
       (centered-margin? (entry-box outer) (entry-box inner) max-wrapper-margin)))

(defn- mostly-hold-one?
  "Whether enough of the frames `outer-members` hold exactly one of the frames
  `inner-members` (an ancestor counts at any depth) and that frame satisfies
  `ok?` (a function of the outer and the inner entry). `enough?` is a
  function of the number of such frames and of all the frames. With `direct?`
  only the children of a frame count as held."
  [outer-members inner-members ok? enough? direct?]
  (let [by-outer (reduce (fn [acc m]
                           (reduce (fn [acc id] (update acc id (fnil conj []) m))
                                   acc
                                   (if direct? [(:parent m)] (:anc m))))
                         {}
                         inner-members)
        single   (count (filter (fn [o]
                                  (let [held (get by-outer (:id o))]
                                    (and (= 1 (count held)) (ok? o (first held)))))
                                outer-members))]
    (enough? single (count outer-members))))

(defn- wrapper-classes
  "The classes of `qualifying` that are wrappers around screens, as a set. A
  class `t` is a wrapper class when an exact standard class `e`
  (`exact-standard-size?`) exists such that more than half of the members of
  `t` hold exactly one member of `e` (a member of `e` that has that member of
  `t` among its ancestors; an ancestor counts at any depth, so a wrapper
  around a wrapper around a screen holds that screen too), and one of:

  1. `t` is standard only by the taller rule, of the same width as `e`
     (within `size-tolerance`), only a little taller: its height is above
     that of `e` and at most `wrapper-height-ratio` times it;
  2. `t` is not a standard size and at least `wrapper-share` of its frames
     hold exactly one screen, of any exact standard size smaller than `t` in
     both directions (800 by 600 and 800 by 480 count together), with a centered
     margin (`wrapper-margin?`): centered, with gaps of at most
     `max-wrapper-margin` px. Rule 1 needs more than half.

  A scrolling screen holds a dialog or panels, not one screen of its width
  in each frame, and is far taller than the screens in it, so it is not a
  wrapper."
  [classes qualifying]
  (let [dims  (fn [i] (let [c (nth classes i)] [(:w c) (:h c)]))
        exact (into [] (filter #(apply exact-standard-size? (dims %))) (sort qualifying))
        other (filterv #(not (apply standard-size? (dims %))) (sort qualifying))
        tall  (filterv #(and (not (apply exact-standard-size? (dims %)))
                             (apply standard-size? (dims %)))
                       (sort qualifying))
        any   (constantly true)
        by-ratio  (fn [t]
                    (let [[tw th] (dims t)]
                      (some (fn [e]
                              (let [[ew eh] (dims e)]
                                (and (<= (Math/abs (double (- ew tw))) size-tolerance)
                                     (> th eh)
                                     (<= th (* wrapper-height-ratio eh))
                                     (mostly-hold-one? (:members (nth classes t))
                                                       (:members (nth classes e))
                                                       any
                                                       (fn [single n] (> (* 2 single) n))
                                                       false))))
                            exact)))
        ;; the screens held may be of several standard sizes: every class of
        ;; an exact standard size counts, of any number of members
        screens   (into [] (filter #(apply exact-standard-size? (dims %))) (range (count classes)))
        by-margin (fn [t]
                    (let [[tw th] (dims t)
                          held    (into []
                                        (comp (filter (fn [e]
                                                        (let [[ew eh] (dims e)]
                                                          (and (> tw (+ ew size-tolerance))
                                                               (> th (+ eh size-tolerance))))))
                                              (mapcat #(:members (nth classes %))))
                                        screens)]
                      (and (seq held)
                           (mostly-hold-one? (:members (nth classes t))
                                             held
                                             wrapper-margin?
                                             (fn [single n] (>= single (* wrapper-share n)))
                                             true))))]
    (into (into #{} (filter by-ratio) tall)
          (filter by-margin)
          other)))

(defn- standard-classes
  "The classes of `qualifying` chosen by their standard size, minus the
  classes that lie inside another class.

  A class is exact when its size is a listed one (`exact-standard-size?`) and
  taller-only when it is standard (`standard-size?`) through the taller rule
  alone. A taller-only class in `wrappers` (`wrapper-classes`: a little taller
  than an exact class of its width, at most `wrapper-height-ratio` times, and
  more than half of its frames hold exactly one frame of that class) is a
  wrapper, not a screen class. A wrapper is not chosen and hides no class
  inside it. A taller-only class that is not a wrapper is a scrolling screen
  and stays.

  Of the other standard classes, one goes when it lies inside another
  standard class (a panel the size of a screen inside a screen), or inside a
  class of any size that has more members (a dialog inside the screens). A
  class with as many members, such as a wrapper around each screen, does not
  hide them."
  [classes inside qualifying wrappers]
  (let [dims     (fn [i] (let [c (nth classes i)] [(:w c) (:h c)]))
        size     (fn [i] (count (:members (nth classes i))))
        standard (into #{}
                       (filter #(and (not (contains? wrappers %))
                                     (apply standard-size? (dims %))))
                       qualifying)]
    (filterv (fn [c]
               (not-any? (fn [o] (and (not (contains? wrappers o))
                                      (or (contains? standard o) (> (size o) (size c)))))
                         (get inside c)))
             (sort standard))))

(defn- structural-classes
  "The classes chosen by the structure of the page: top classes (not inside
  another qualifying class), minus the layers of containers, minus those
  under `area-ratio` of the largest area. Nil when `deadline` (nanoTime)
  passed."
  [classes inside qualifying deadline]
  (when-let [tops (remove-container-layers classes inside qualifying deadline)]
    (let [max-area (reduce max 0 (map #(class-area (nth classes %)) tops))]
      (filterv #(>= (class-area (nth classes %)) (* area-ratio max-area)) tops))))

(defn- candidate-frames
  "The frame entries of `frames` that can be boards: at level 1 to
  `max-depth`, outside component instances, at least `min-screen-side` px
  wide and high."
  [frames]
  (filterv #(and (not (:comp? %))
                 (<= (:level %) max-depth)
                 (>= (:w %) min-screen-side)
                 (>= (:h %) min-screen-side))
           frames))

(defn- drop-nested
  "The boards `members` (frame entries of the selected classes, with `:name`)
  without the nested ones. Of two boards in different classes where one holds
  the other, the inner goes. Boards of one size class that hold each other
  form a chain, and one board of the chain stays, the others go. The one that
  stays is, in this order:

  1. when `name-ok?` (a function of a board id that answers true, false or
     `:timeout`; nil for none) accepts some members, the outermost accepted
     one (a `:timeout` counts as no match);
  2. the member named like the bare boards of its class: a bare board is one
     in no chain, and the member whose exact name is borne by the most bare
     boards of its class wins, when at least one bare board bears it; of
     tied members, the outermost. A default frame name (`default-frame-name`)
     does not count;
  3. the outermost member (the top of the chain).

  When rule 1 or 2 leaves several outermost members (sibling frames), the top
  of the chain stays, so one board stays per chain. A regex cannot pick two
  frames of one chain: when it matches both, the top stays and the later name
  filter removes it if its own name does not match.

  The work is linear in the boards. Returns `{:kept [...] :nested #{ids}}`;
  `:nested` holds the ids of the kept boards of a chain that had other
  members, left out inside or around it."
  [members class-of name-ok?]
  (let [ids      (into #{} (map :id) members)
        same?    (fn [a b] (= (class-of a) (class-of b)))
        by-id    (into {} (map (juxt :id identity)) members)
        ;; the same-class selected ancestors of each board
        up       (into {}
                       (map (fn [m]
                              [(:id m) (filterv #(and (contains? ids %) (same? % (:id m)))
                                                (:anc m))]))
                       members)
        below    (into #{} (mapcat val) up)
        in-chain? (fn [id] (or (seq (get up id)) (contains? below id)))
        ;; the outermost board of the chain of a board
        top-of   (fn [id] (if (empty? (get up id))
                            id
                            (first (filter #(empty? (get up %)) (get up id)))))
        ;; bare boards, counted per class and exact name
        bare     (frequencies
                  (for [m members
                        :when (not (in-chain? (:id m)))]
                    [(class-of (:id m)) (:name m)]))
        ok?      (memoize #(and (some? name-ok?) (true? (name-ok? %))))
        chains   (group-by top-of (filter in-chain? (map :id members)))
        ;; of `candidates` (ids of one chain), those with no other candidate
        ;; above them
        outermost (fn [candidates]
                    (let [cs (set candidates)]
                      (filterv #(not-any? cs (get up %)) candidates)))
        keepers  (fn [top chain]
                   (let [matching (filterv ok? chain)
                         score    (fn [id]
                                    (let [n (:name (get by-id id))]
                                      (if (or (nil? n) (re-matches default-frame-name n))
                                        0
                                        (get bare [(class-of id) n] 0))))
                         best     (reduce max 0 (map score chain))
                         ;; one board stays: a choice of sibling frames
                         ;; falls back to the top of the chain
                         one      (fn [chosen] (if (= 1 (count chosen)) chosen [top]))]
                     (cond
                       (seq matching) (one (outermost matching))
                       (pos? best)    (one (outermost (filterv #(= best (score %)) chain)))
                       :else          [top])))
        kept-of  (into {} (map (fn [[top chain]] [top (keepers top chain)])) chains)
        same-kept (filterv (fn [m]
                             (let [id (:id m)]
                               (if (in-chain? id)
                                 (some #{id} (get kept-of (top-of id)))
                                 true)))
                           members)
        kept     (filterv (fn [m]
                            (not-any? #(and (contains? ids %) (not (same? % (:id m))))
                                      (:anc m)))
                          same-kept)]
    {:kept   kept
     :nested (into #{}
                   (comp (filter (fn [[top chain]] (> (count chain) (count (get kept-of top)))))
                         (mapcat (fn [[top _]] (get kept-of top))))
                   chains)}))

(defn- get-other-sizes
  "The qualifying classes (a set of class indexes) that have no member among
  the selected `entries`, as `{:width :height :boards :relation}`, the most
  boards first and then in walk order, at most `max-other-sizes`. `:relation`
  is \"wrapper\" for a class in `wrappers` (see `wrapper-classes`), else
  \"inside\" when more than half of the members lie inside the selected
  boards and \"outside\" otherwise."
  [classes class-of qualifying wrappers entries]
  (let [ids  (into #{} (map :id) entries)
        used (into #{} (keep #(get class-of (:id %))) entries)]
    (->> (remove used (sort qualifying))
         (map (fn [i]
                (let [c       (nth classes i)
                      members (:members c)
                      n       (count members)
                      inside  (count (filter #(some ids (:anc %)) members))]
                  {:index    i
                   :width    (round3 (:w c))
                   :height   (round3 (:h c))
                   :boards   n
                   :relation (cond (contains? wrappers i) "wrapper"
                                   (> (* 2 inside) n)     "inside"
                                   :else                  "outside")})))
         (sort-by (fn [{:keys [boards index]}] [(- boards) index]))
         (take max-other-sizes)
         (mapv #(dissoc % :index)))))

(defn overlap-share
  "The share of the area of the box `inner` (`{:x0 :y0 :x1 :y1}`) that lies
  inside the box `outer`; 0 for an empty `inner`. The lint rule
  `sibling-overlay` uses the same test (`overlay-min-share`)."
  [inner outer]
  (let [area (fn [{:keys [x0 y0 x1 y1]}] (* (max 0 (- x1 x0)) (max 0 (- y1 y0))))
        a    (area inner)]
    (if (pos? a)
      (/ (area {:x0 (max (:x0 inner) (:x0 outer)) :y0 (max (:y0 inner) (:y0 outer))
                :x1 (min (:x1 inner) (:x1 outer)) :y1 (min (:y1 inner) (:y1 outer))})
         a)
      0)))

(defn find-overlays
  "The overlay boards among the frame entries `frames` (see `walk-frames`), as
  a map `{overlay-id screen-id}`. An overlay is a frame outside component
  instances that is a sibling of a screen inside its wrapper: it has the same
  parent as the screen, that parent is in `wrapper-ids`, it is not a screen
  itself (`screen-ids`) and at least `overlay-min-share` of its own area lies
  over the screen. With several screens in the wrapper, the overlay belongs to
  the one it overlaps most. This is the hook for the lint rule that reports
  the overlays (a panel laid over a screen) and for the selection, which
  leaves them out of the boards."
  [frames screen-ids wrapper-ids]
  (let [screens (group-by :parent
                          (filter #(and (contains? screen-ids (:id %))
                                        (contains? wrapper-ids (:parent %)))
                                  frames))]
    (into {}
          (keep (fn [f]
                  (when (and (not (:comp? f))
                             (not (contains? screen-ids (:id f))))
                    (when-let [ss (seq (get screens (:parent f)))]
                      (let [box          (entry-box f)
                            [share best] (reduce (fn [[bs b] sc]
                                                   (let [sh (overlap-share box (entry-box sc))]
                                                     (if (> sh bs) [sh sc] [bs b])))
                                                 [0 nil]
                                                 ss)]
                        (when (and best (>= share overlay-min-share))
                          [(:id f) (:id best)]))))))
          frames)))

(defn- screen-refs
  "The sizes the loose boards are weighed against, from the screen classes
  `kept`: `{:max-w :max-h :max-a :min-a}`."
  [classes kept]
  (let [cs (map #(nth classes %) kept)
        as (map class-area cs)]
    {:max-w (reduce max (map :w cs))
     :max-h (reduce max (map :h cs))
     :max-a (reduce max as)
     :min-a (reduce min as)}))

(defn- not-a-screen?
  "Whether the loose board `c` (a frame entry in no screen class) is clearly
  not a screen. `refs` are from `screen-refs`, `held` maps the id of a loose
  board to the loose boards inside it, `children` the frame entries by parent
  id and `by-id` the entries by id. A standard size (`standard-size?`, the
  taller rule included) is always a screen size. Else it is not a screen
  when:

  - it is larger than the screen classes in both directions and has at
    least `far-larger-ratio` times the area of the largest (a section, a
    wrapper);
  - it holds a frame of its own size or sits in one (an annotation and its
    widget), is not portrait (`portrait-ratio`) and its area is under
    `pair-area-ratio` of the smallest screen class;
  - it holds exactly one other loose board with an even margin
    (`wrapper-margin?`): a wrapper.

  Every test is constant time per board and its children."
  [refs held children by-id c]
  (and (not (standard-size? (:w c) (:h c)))
       (let [area  (* (:w c) (:h c))
             same? (fn [d] (same-size? (:w c) (:h c) (:w d) (:h d)))
             pair? (and (not (>= (:h c) (* portrait-ratio (:w c))))
                        (or (some same? (get children (:id c)))
                            (some-> (get by-id (:parent c)) same?)))
             in    (get held (:id c))]
         (boolean
          (or (and (> (:w c) (+ (:max-w refs) size-tolerance))
                   (> (:h c) (+ (:max-h refs) size-tolerance))
                   (>= area (* far-larger-ratio (:max-a refs))))
              (and pair? (< area (* pair-area-ratio (:min-a refs))))
              (and (= 1 (count in))
                   (wrapper-margin? c (first in))))))))

(defn- filter-until
  "The items of `coll` that satisfy `pred`, as a vector, or nil when
  `deadline` (nanoTime) passes while it runs. The clock is read every
  `check-every` items."
  [pred coll deadline]
  (loop [items (seq coll)
         n     0
         out   []]
    (cond
      (nil? items) out
      (and (zero? (mod n check-every)) (expired? deadline)) nil
      :else (recur (next items) (inc n)
                   (cond-> out (pred (first items)) (conj (first items)))))))

(defn select-auto
  "The boards of the visible frame entries `frames` (see `walk-frames`) found
  by size, in walk order. `deadline` (nanoTime, nil for none) bounds the
  work; past it the result is the fallback with `:timed-out?` true.
  `name-ok?` is nil or a function of a frame id that answers true, false or
  `:timeout`, for the choice inside a chain of same-size boards (step 7).
  The steps:

  1. Candidates: frames at level 1 to `max-depth` outside component
     instances, at least `min-screen-side` px wide and high.
  2. Size classes (`group-size-classes`).
  3. A class qualifies with at least `min-class-size` members. Only the
     `max-qualifying-classes` with the most members are weighed.
  4a. Class A lies inside class B when more than half of the members of A
     have an ancestor in B. When a qualifying class has a standard screen
     size (`standard-size?` of its first member), the screen classes are
     the standard qualifying classes that lie inside no other standard
     class, and inside no class with more members (`standard-classes`);
     `:basis` is `\"standard-size\"`. A class that is standard only by the
     taller rule is a wrapper, and does not count, when it is at most
     `wrapper-height-ratio` times as tall as an exact standard class of its
     width and more than half of its frames hold exactly one frame of that
     class (`wrapper-classes`).
     When none is left, steps 4b to 6 choose them by structure and `:basis`
     is `\"structure\"`.
  4b. The top classes lie inside no other qualifying class.
  5. A top class that is a layer of containers goes, and the top classes are
     computed again (`remove-container-layers`).
  6. A top class whose area is under `area-ratio` of the largest one goes.
  7. The boards are the members of the screen classes. Of two boards where
     one holds the other, the inner goes when they are in different
     classes. Boards of one size class that hold each other form a chain
     and one stays (`drop-nested`): the outermost one that `name-ok?`
     accepts; else the one named like the bare boards of the class (boards
     in no chain; the most common exact name among them wins, the outermost
     on a tie); else the outermost. `:nested` holds the ids of the kept
     boards of a chain that had other members.
  8. Loose boards join: candidates that are neither above nor below a
     board, at a level not deeper than the shallowest board, with an area
     of at least `area-ratio` of the largest screen class, that are not
     clearly something else than a screen (`not-a-screen?`: a section or
     wrapper, an annotation) and are not overlays (`find-overlays`). The
     step checks the deadline; past it the result is the fallback.
  9. When nothing is selected, the boards are the frames at level 1,
     `:fallback?` is true and `:basis` is `\"depth-fallback\"`.

  Returns `{:entries [...] :fallback? bool :basis s :classes [...]
  :class-of {...} :other-sizes [...] :nested #{ids} :overlays {overlay-id
  screen-id} :timed-out? bool}`. `:other-sizes`
  lists the qualifying classes that have no selected board (see
  `get-other-sizes`)."
  ([frames]
   (select-auto frames nil nil))
  ([frames deadline]
   (select-auto frames deadline nil))
  ([frames deadline name-ok?]
   (let [candidates (candidate-frames frames)
         {:keys [classes class-of]} (group-size-classes candidates)
         all-qual   (into #{}
                          (comp (map-indexed vector)
                                (filter (fn [[_ c]] (>= (count (:members c)) min-class-size)))
                                (map first))
                          classes)
         qualifying (if (> (count all-qual) max-qualifying-classes)
                      (into #{}
                            (take max-qualifying-classes)
                            (sort-by (fn [i] [(- (count (:members (nth classes i)))) i]) all-qual))
                      all-qual)
         wrappers   (wrapper-classes classes qualifying)
         wrapper-ids (into #{}
                           (comp (mapcat #(:members (nth classes %))) (map :id))
                           wrappers)
         fallback   (fn [timed-out?]
                      (let [entries (filterv #(= 1 (:level %)) frames)]
                        {:entries     entries
                         :fallback?   true
                         :basis       "depth-fallback"
                         :classes     classes
                         :class-of    class-of
                         :other-sizes (get-other-sizes classes class-of all-qual wrappers entries)
                         :timed-out?  timed-out?}))]
     (if (expired? deadline)
       (fallback true)
       (let [inside   (get-inside-map classes class-of qualifying)
             standard (standard-classes classes inside qualifying wrappers)
             basis    (if (seq standard) "standard-size" "structure")
             kept     (if (seq standard)
                        standard
                        (structural-classes classes inside qualifying deadline))]
         (if (nil? kept)
           (fallback true)
           (let [all-members (into [] (mapcat #(:members (nth classes %))) kept)
                 ;; the overlays are known by the screens of exact size; a
                 ;; class that is standard by the taller rule only (480 by 460
                 ;; over 480 by 320) may hold nothing but overlays
                 anchors     (let [exact (filterv #(apply exact-standard-size?
                                                          ((juxt :w :h) (nth classes %)))
                                                  kept)]
                               (mapcat #(:members (nth classes %)) (if (seq exact) exact kept)))
                 anchor-ids  (into #{} (map :id) anchors)
                 ;; a frame that holds one screen with an even margin is a
                 ;; wrapper for the overlays, whatever the share of its class
                 held-count  (frequencies (mapcat :anc anchors))
                 by-id0      (into {} (map (juxt :id identity)) candidates)
                 own-wrapper-ids
                 (into wrapper-ids
                       (comp (keep (fn [a]
                                     (let [p (get by-id0 (:parent a))]
                                       (when (and (some? p)
                                                  (= 1 (get held-count (:id p)))
                                                  (wrapper-margin? p a))
                                         (:id p)))))
                             (distinct))
                       anchors)
                 overlays0   (find-overlays candidates anchor-ids own-wrapper-ids)
                 ;; a taller class (800 by 1600 over 800 by 600) whose frames
                 ;; mostly are no overlays holds screens
                 overlays    (let [not-overlays
                                   (into #{}
                                         (comp (remove #(apply exact-standard-size?
                                                               ((juxt :w :h) (nth classes %))))
                                               (map #(:members (nth classes %)))
                                               (filter (fn [ms]
                                                         (<= (* 2 (count (filter #(contains? overlays0 (:id %)) ms)))
                                                             (count ms))))
                                               cat
                                               (map :id))
                                         kept)]
                               (apply dissoc overlays0 not-overlays))
                 members     (filterv #(not (contains? overlays (:id %))) all-members)
                 kept        (filterv (fn [i] (some #(not (contains? overlays (:id %)))
                                                    (:members (nth classes i))))
                                      kept)
                 max-area    (reduce max 0 (map #(class-area (nth classes %)) kept))
                 {inner :kept nested :nested} (drop-nested members class-of name-ok?)]
             (if (empty? inner)
               (fallback false)
               (let [ids       (into #{} (map :id) inner)
                     above     (into #{} (mapcat :anc) inner)
                     min-level (reduce min (map :level inner))
                     children  (group-by :parent candidates)
                     pool      (filter-until (fn [c]
                                               (and (not (contains? ids (:id c)))
                                                    (not (contains? overlays (:id c)))
                                                    (not (contains? above (:id c)))
                                                    (not-any? ids (:anc c))
                                                    (<= (:level c) min-level)
                                                    (>= (* (:w c) (:h c)) (* area-ratio max-area))))
                                             candidates deadline)
                     pool-ids  (into #{} (map :id) pool)
                     ;; the loose boards inside each loose board, one pass
                     held      (reduce (fn [acc d]
                                         (reduce (fn [acc id]
                                                   (cond-> acc
                                                     (contains? pool-ids id)
                                                     (update id (fnil conj []) d)))
                                                 acc
                                                 (:anc d)))
                                       {}
                                       pool)
                     refs      (screen-refs classes kept)
                     loose     (when (some? pool)
                                 (filter-until #(not (not-a-screen? refs held children by-id0 %))
                                               pool deadline))
                     entries   (when (some? loose) (vec (sort-by :index (into inner loose))))]
                 (if (nil? entries)
                   (fallback true)
                 {:entries     entries
                  :fallback?   false
                  :basis       basis
                  :classes     classes
                  :class-of    class-of
                  :other-sizes (get-other-sizes classes class-of all-qual wrappers entries)
                  :nested      nested
                  :overlays    overlays
                  :wrapper-ids own-wrapper-ids
                  :timed-out?  false}))))))))))

;; --- SELECTION

(defn resolve-mode
  "The selection mode and the depth of a call. `mode` is `:depth` or `:auto`
  (a string is accepted), `depth` an int or nil and `regex?` whether the
  call has a board name regex. With neither `depth`, `regex?` nor `mode` the
  mode is `:auto`. With `depth` or `regex?` and no `mode` it is `:depth`.
  Mode `:auto` with `depth` is refused as a validation error. Returns
  `{:mode :depth :depth d}` or `{:mode :auto}`; the depth defaults to 1."
  [{:keys [depth mode regex?]}]
  (let [mode (some-> mode keyword)]
    (when (and (= :auto mode) (some? depth))
      (ex/raise :type :validation
                :code :mcp-invalid-board-selection
                :hint "depth cannot be combined with mode auto; leave depth out, or use mode depth"))
    (let [mode (or mode (if (or (some? depth) regex?) :depth :auto))]
      (if (= :depth mode)
        {:mode :depth :depth (or depth 1)}
        {:mode :auto}))))

(defn- filter-by-name
  "The entries of `entries` whose shape name `name-match` accepts. `name-match`
  takes a shape and answers true, false or `:timeout`; nil accepts all. The
  filter stops at `deadline` (nanoTime). Returns `{:entries [...]
  :timed-out? bool}`."
  [objects entries name-match deadline]
  (if (nil? name-match)
    {:entries entries :timed-out? false}
    (loop [entries (seq entries)
           out     []]
      (if (nil? entries)
        {:entries out :timed-out? false}
        (if (>= (System/nanoTime) deadline)
          {:entries out :timed-out? true}
          (let [matched (name-match (get objects (:id (first entries))))]
            (if (= :timeout matched)
              {:entries out :timed-out? true}
              (recur (next entries)
                     (cond-> out matched (conj (first entries)))))))))))

(defn- get-sizes
  "The sizes of the selected `entries` as `{:width :height :boards}`, one per
  size class, the most boards first and then in walk order, at most
  `max-sizes`. Also returns how many sizes were left out."
  [classes class-of entries]
  (let [groups (->> entries
                    (group-by #(get class-of (:id %)))
                    (keep (fn [[idx members]]
                            (when (some? idx)
                              [(:index (first members)) idx (count members)])))
                    (sort-by (fn [[first-index _ n]] [(- n) first-index])))]
    {:sizes   (mapv (fn [[_ idx n]]
                      {:width  (round3 (:w (nth classes idx)))
                       :height (round3 (:h (nth classes idx)))
                       :boards n})
                    (take max-sizes groups))
     :omitted (max 0 (- (count groups) max-sizes))}))

(defn- count-deeper
  "How many frames of `frames` are screen-sized candidates (see
  `candidate-frames`) in a size class of at least `min-class-size` members,
  not selected and below a selected board. Used in mode depth: when it is not
  0, screen-sized frames repeat deeper than the selected boards."
  [frames selected]
  (let [{:keys [classes]} (group-size-classes (candidate-frames frames))
        repeated (into #{}
                       (comp (filter #(>= (count (:members %)) min-class-size))
                             (mapcat :members)
                             (map :id))
                       classes)]
    (count (filter (fn [f]
                     (and (contains? repeated (:id f))
                          (not (contains? selected (:id f)))
                          (some selected (:anc f))))
                   frames))))

(defn select-boards
  "The boards of the page `objects`, in walk order, and what was selected.
  Options:
  - `:depth` int 1 to `max-depth`, `:mode` `:depth` or `:auto` (see
    `resolve-mode`).
  - `:name-match` a function of a shape that answers true, false or
    `:timeout`; the boards are kept when it answers true.
  - `:deadline` (nanoTime) where the walk and the name matching stop.

  Mode `:depth` takes the visible frames at most `depth` levels below the
  page root. Mode `:auto` takes the screens found by size (see
  `select-auto`), and then keeps those whose name matches.

  Returns `{:ids [...] :overlays {overlay-id screen-id} :wrapper-ids #{ids}
  (mode auto: the wrapper frames the overlays are looked for in) :timed-out? bool
  :deeper-boards n :selection {...}}`. `:overlays` (mode auto) maps the
  overlay boards left out of the selection to the screen they lie beside
  (see `find-overlays`).
  `:deeper-boards` (mode depth) counts the screen-sized frames (at least
  `min-screen-side` px on both sides, outside component instances) in a size
  class of at least `min-class-size` members that lie below the selected
  boards; it is nil in mode `:auto`. `:selection` has `:mode` (a string),
  `:depth` (mode depth, or a fallback), `:fallback` and `:basis` (mode auto:
  `standard-size`, `structure` or `depth-fallback`), `:sizes`,
  `:sizes-omitted` and `:other-sizes` (mode auto), `:nested-same-size`
  (mode auto, only above zero: the boards that sit in a chain of frames of
  their own size; one frame of each chain is the board: the one that matches
  the name regex, else the one named like the unwrapped boards of that size,
  else the outermost), `:boards`, `:min-depth` and `:max-depth`."
  [objects {:keys [depth mode name-match deadline]}]
  (let [resolved (resolve-mode {:depth depth :mode mode :regex? (some? name-match)})
        walked   (walk-frames objects deadline)
        frames   (:frames walked)
        auto     (when (= :auto (:mode resolved))
                   (select-auto frames deadline
                                (when (some? name-match)
                                  #(name-match (get objects %)))))
        picked   (if auto
                   (:entries auto)
                   (filterv #(<= (:level %) (:depth resolved)) frames))
        filtered (filter-by-name objects picked name-match deadline)
        entries  (:entries filtered)
        ids      (mapv :id entries)
        levels   (map :level entries)
        sizes    (when auto (get-sizes (:classes auto) (:class-of auto) entries))
        nested-same-size (if auto (count (filter (set ids) (:nested auto))) 0)]
    {:ids           ids
     :overlays      (or (:overlays auto) {})
     :wrapper-ids   (or (:wrapper-ids auto) #{})
     :timed-out?    (boolean (or (:timed-out? walked) (:timed-out? filtered) (:timed-out? auto)))
     :deeper-boards (when-not auto (count-deeper frames (set ids)))
     :selection     (cond-> {:mode      (name (:mode resolved))
                             :boards    (count ids)
                             :min-depth (when (seq levels) (reduce min levels))
                             :max-depth (when (seq levels) (reduce max levels))}
                      (not auto)
                      (assoc :depth (:depth resolved))

                      auto
                      (assoc :fallback      (:fallback? auto)
                             :basis         (:basis auto)
                             :sizes         (if (:fallback? auto) [] (:sizes sizes))
                             :sizes-omitted (if (:fallback? auto) 0 (:omitted sizes))
                             :other-sizes   (:other-sizes auto))

                      (and auto (pos? nested-same-size))
                      (assoc :nested-same-size nested-same-size)

                      (and auto (:fallback? auto))
                      (assoc :depth 1))}))
