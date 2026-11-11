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
  entries `{:id :level :index :comp? :name :w :h :anc}`. `:level` is 1 for a child
  of the page root, `:index` the position in this walk, `:comp?` whether the
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

(defn- wrapper-classes
  "The classes of `qualifying` that are wrappers around screens, as a set. A
  class `t` that is standard only by the taller rule is a wrapper class when
  an exact standard class `e` (`exact-standard-size?`) of the same width
  (within `size-tolerance`) exists such that:

  1. `t` is only a little taller than `e`: its height is above that of `e`
     and at most `wrapper-height-ratio` times it;
  2. more than half of the members of `t` hold exactly one member of `e`: a
     member of `e` that has that member of `t` among its ancestors. An
     ancestor counts at any depth, so a wrapper around a wrapper around a
     screen holds that screen too.

  A scrolling screen holds a dialog or panels, not one screen of its width
  in each frame, and is far taller than the screens in it, so it is not a
  wrapper."
  [classes qualifying]
  (let [dims  (fn [i] (let [c (nth classes i)] [(:w c) (:h c)]))
        exact (into [] (filter #(apply exact-standard-size? (dims %))) (sort qualifying))
        tall  (filterv #(and (not (apply exact-standard-size? (dims %)))
                             (apply standard-size? (dims %)))
                       (sort qualifying))]
    (into #{}
          (filter
           (fn [t]
             (let [[tw th] (dims t)
                   members (:members (nth classes t))]
               (some (fn [e]
                       (let [[ew eh] (dims e)]
                         (and (<= (Math/abs (double (- ew tw))) size-tolerance)
                              (> th eh)
                              (<= th (* wrapper-height-ratio eh))
                              (let [tids   (into #{} (map :id) members)
                                    counts (frequencies
                                            (mapcat (fn [m] (filter tids (:anc m)))
                                                    (:members (nth classes e))))
                                    single (count (filter #(= 1 (get counts (:id %) 0)) members))]
                                (> (* 2 single) (count members))))))
                     exact))))
          tall)))

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
     of at least `area-ratio` of the largest screen class.
  9. When nothing is selected, the boards are the frames at level 1,
     `:fallback?` is true and `:basis` is `\"depth-fallback\"`.

  Returns `{:entries [...] :fallback? bool :basis s :classes [...]
  :class-of {...} :other-sizes [...] :nested #{ids} :timed-out? bool}`. `:other-sizes`
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
           (let [max-area (reduce max 0 (map #(class-area (nth classes %)) kept))
                 members  (into [] (mapcat #(:members (nth classes %))) kept)
                 {inner :kept nested :nested} (drop-nested members class-of name-ok?)]
             (if (empty? inner)
               (fallback false)
               (let [ids       (into #{} (map :id) inner)
                     above     (into #{} (mapcat :anc) inner)
                     min-level (reduce min (map :level inner))
                     loose     (filterv (fn [c]
                                          (and (not (contains? ids (:id c)))
                                               (not (contains? above (:id c)))
                                               (not-any? ids (:anc c))
                                               (<= (:level c) min-level)
                                               (>= (* (:w c) (:h c)) (* area-ratio max-area))))
                                        candidates)
                     entries   (vec (sort-by :index (into inner loose)))]
                 {:entries     entries
                  :fallback?   false
                  :basis       basis
                  :classes     classes
                  :class-of    class-of
                  :other-sizes (get-other-sizes classes class-of all-qual wrappers entries)
                  :nested      nested
                  :timed-out?  false})))))))))

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

  Returns `{:ids [...] :timed-out? bool :deeper-boards n :selection {...}}`.
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
