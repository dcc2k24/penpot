;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-mcp-boards-test
  "Pure tests of the board selection of `app.rpc.mcp-boards`, on plain maps
  of shapes."
  (:require
   [app.common.uuid :as uuid]
   [app.rpc.mcp-boards :as boards]
   [clojure.string :as str]
   [clojure.test :as t]))

;; --- HELPERS

(defn- fr
  "A frame spec named `name` of the size `w` by `h` with the child specs
  `kids`."
  [name w h & kids]
  {:t :frame :name name :w w :h h :kids (vec kids)})

(defn- fr+
  "Like `fr`, with the extra shape attributes `attrs` as the first child
  argument."
  [name w h attrs & kids]
  (assoc (apply fr name w h kids) :attrs attrs))

(defn- rect
  "A rect spec named `name`."
  [name]
  {:t :rect :name name :w 10 :h 10 :kids []})

(defn- build
  "Page objects from the top-level specs `tops`. Returns `{:objects m :order
  [ids in walk order]}`. Ids are keywords numbered in walk order."
  [& tops]
  (let [counter (atom 0)
        objects (atom {})
        order   (atom [])
        add     (fn add [spec parent]
                  (let [id   (keyword (str "s" (swap! counter inc)))
                        _    (swap! order conj id)
                        kids (mapv #(add % id) (:kids spec))]
                    (swap! objects assoc id
                           (merge {:id        id
                                   :parent-id parent
                                   :type      (:t spec)
                                   :name      (:name spec)
                                   :x         0
                                   :y         0
                                   :width     (:w spec)
                                   :height    (:h spec)
                                   :shapes    kids}
                                  (:attrs spec)))
                    id))
        roots   (mapv #(add % uuid/zero) tops)]
    {:objects (assoc @objects uuid/zero {:id uuid/zero :type :frame :shapes roots})
     :order   @order}))

(defn- named
  "The ids of the shapes named `name` in `page`, in walk order."
  [page name]
  (filterv #(= name (:name (get (:objects page) %))) (:order page)))

(defn- named-many
  "The ids of the shapes whose name is one of `names`, in walk order."
  [page & names]
  (filterv #(contains? (set names) (:name (get (:objects page) %))) (:order page)))

(defn- named-like
  "The ids of the shapes whose name starts with `prefix` in `page`, in walk
  order."
  [page prefix]
  (filterv #(str/starts-with? (:name (get (:objects page) %)) prefix) (:order page)))

(defn- in-seconds
  "A deadline `n` seconds from now."
  [n]
  (+ (System/nanoTime) (* n 1000000000)))

(defn- select
  "`select-boards` on `page` with `opts` merged over a 5 second deadline."
  [page opts]
  (boards/select-boards (:objects page) (merge {:deadline (in-seconds 5)} opts)))

(defn- level-1
  "The ids of the frames at the page root of `page`."
  [page]
  (:shapes (get (:objects page) uuid/zero)))

(defn- sizes-of
  "The `sizes` of a selection reply as `[width height boards]` triples."
  [out]
  (mapv (juxt :width :height :boards) (get-in out [:selection :sizes])))

;; --- MODE

(t/deftest resolve-mode-follows-the-given-parameters
  (t/is (= {:mode :auto} (boards/resolve-mode {})))
  (t/is (= {:mode :depth :depth 1} (boards/resolve-mode {:regex? true})))
  (t/is (= {:mode :depth :depth 3} (boards/resolve-mode {:depth 3})))
  (t/is (= {:mode :depth :depth 1} (boards/resolve-mode {:mode :depth})))
  (t/is (= {:mode :depth :depth 1} (boards/resolve-mode {:mode "depth"})))
  (t/is (= {:mode :auto} (boards/resolve-mode {:mode :auto :regex? true})))
  (t/is (= {:mode :auto} (boards/resolve-mode {:mode "auto"}))))

(t/deftest mode-auto-with-depth-is-refused
  (let [data (try
               (boards/resolve-mode {:mode :auto :depth 2})
               nil
               (catch clojure.lang.ExceptionInfo cause
                 (ex-data cause)))]
    (t/is (= :validation (:type data)))
    (t/is (= :mcp-invalid-board-selection (:code data)))
    (t/is (re-find #"depth" (:hint data))))
  (let [page (build (fr "A" 100 100))]
    (t/is (thrown? clojure.lang.ExceptionInfo (select page {:mode :auto :depth 2})))))

;; --- SIZE CLASSES

(t/deftest size-classes-join-the-first-class-within-two-pixels
  (let [page    (build (fr "a" 800 600) (fr "b" 801 602) (fr "c" 798 599)
                       (fr "d" 803 600) (fr "e" 100 100))
        frames  (:frames (boards/walk-frames (:objects page) (in-seconds 5)))
        classes (:classes (boards/group-size-classes frames))]
    (t/is (= [3 1 1] (mapv (comp count :members) classes)))
    (t/is (= [800 803 100] (mapv :w classes)) "a size is the size of the first member")))

(t/deftest size-classes-compare-with-the-first-member-only
  (let [page    (build (fr "a" 800 600) (fr "b" 802 600) (fr "c" 804 600))
        frames  (:frames (boards/walk-frames (:objects page) (in-seconds 5)))
        classes (:classes (boards/group-size-classes frames))]
    (t/is (= [2 1] (mapv (comp count :members) classes))
          "c is within 2 px of b but 4 px from the first member a")))

;; --- AUTO SELECTION

(t/deftest flat-page-of-equal-boards-selects-all-like-depth-1
  (let [page  (build (fr "A" 400 300 (rect "R")) (fr "B" 400 300) (fr "C" 400 300)
                     (fr "D" 400 300) (fr "E" 400 300))
        auto  (select page {})
        depth (select page {:depth 1})]
    (t/is (= (level-1 page) (:ids auto)))
    (t/is (= (:ids depth) (:ids auto)))
    (t/is (= {:mode "auto" :fallback false :basis "structure" :boards 5 :min-depth 1 :max-depth 1
              :sizes [{:width 400 :height 300 :boards 5}] :sizes-omitted 0 :other-sizes []}
             (:selection auto)))
    (t/is (nil? (:deeper-boards auto)) "mode auto has no deeper-boards")
    (t/is (false? (:timed-out? auto)))))

(t/deftest flat-boards-of-mixed-sizes-select-the-same-boards-as-depth-1
  (let [page (build (fr "A" 400 300) (fr "B" 400 300) (fr "C" 400 300)
                    (fr "wide" 600 500) (fr "small" 350 250) (fr "mid" 500 400))
        auto (select page {})]
    (t/is (= (level-1 page) (:ids auto)) "boards of other sizes join as loose boards")
    (t/is (= (:ids (select page {:depth 1})) (:ids auto)))
    (t/is (= [[400 300 3] [350 250 1] [500 400 1] [600 500 1]] (sort-by (juxt (comp - last) first) (sizes-of auto)))
          "one size entry per size")
    (t/is (= {:mode "auto" :fallback false} (select-keys (:selection auto) [:mode :fallback])))))

(t/deftest a-small-loose-frame-stays-out-of-the-auto-selection
  (let [page (build (fr "A" 400 300) (fr "B" 400 300) (fr "C" 400 300) (fr "tiny" 100 50))
        auto (select page {})]
    (t/is (= (named-many page "A" "B" "C") (:ids auto))
          "its area is under 10 % of the area of a board, so it is not a board")
    (t/is (= 4 (count (:ids (select page {:depth 1})))))))

(defn- journeys
  "A journeys page: `n-sections` section frames of the sizes `section-size`
  (a function of the section index, giving `[w h]`), each with a chain of
  three wrapper frames of sizes of their own and then `per-section` screens
  named \"Parent\", every screen with one \"Button\" frame. The first `singles`
  screens sit in a \"Single\" frame of the screen size. Section 0 also holds
  `decisions` frames of 200 by 100 beside its screens."
  [n-sections section-size per-section singles decisions]
  (apply build
         (for [i (range n-sections)]
           (let [[sw sh] (section-size i)
                 wrap-w  (+ 1000 (* 10 i))
                 shapes  (concat
                          (for [j (range per-section)]
                            (let [parent (fr "Parent" 800 600 (fr "Button" 120 40) (rect "R"))]
                              (if (< (+ (* i per-section) j) singles)
                                (fr "Single" 800 600 parent)
                                parent)))
                          (when (zero? i)
                            (repeat decisions (fr "Decision" 200 100))))]
             (fr (str "Section " i) sw sh
                 (fr (str "Wrap a" i) wrap-w 900
                     (fr (str "Wrap b" i) wrap-w 800
                         (apply fr (str "Wrap c" i) wrap-w 700 shapes))))))))

(t/deftest journeys-page-selects-the-screens-at-depth-5
  (let [page (journeys 12 (fn [i] [3000 (+ 2000 (* 20 i))]) 3 0 3)
        auto (select page {})]
    (t/is (= (named page "Parent") (:ids auto)) "the 36 screens, not the sections")
    (t/is (= 36 (count (:ids auto))))
    (t/is (= [[800 600 36]] (sizes-of auto)))
    (t/is (= {:min-depth 5 :max-depth 5 :mode "auto" :fallback false :boards 36}
             (select-keys (:selection auto) [:min-depth :max-depth :mode :fallback :boards])))
    (t/is (nil? (:deeper-boards auto)))
    (t/is (= (:ids auto) (:ids (select page {:mode :auto}))))
    (t/is (= 12 (count (:ids (select page {:depth 1})))) "depth 1 sees only the sections")
    (t/is (= 87 (count (:ids (select page {:depth 5}))))
          "depth 5 sees 12 sections, 36 wrappers, 36 screens and 3 decision frames")))

(t/deftest journeys-page-with-wrappers-of-the-screen-size-and-decision-frames
  (let [page (journeys 2 (fn [_] [3000 2000]) 4 3 2)
        auto (select page {})]
    (t/is (= (named page "Parent") (:ids auto)) "rule 2: the bare screens are named Parent")
    (t/is (= 8 (count (:ids auto))))
    (t/is (empty? (filter (set (named page "Single")) (:ids auto))) "the wrapper is dropped, the inner screen kept")
    (t/is (empty? (filter (set (named page "Decision")) (:ids auto))))
    (t/is (= 3 (get-in auto [:selection :nested-same-size])))
    (t/is (= 5 (get-in auto [:selection :min-depth])))
    (t/is (= 6 (get-in auto [:selection :max-depth])))))

(t/deftest equal-sized-sections-are-a-layer-of-containers
  (let [page (apply build
                    (for [i (range 12)]
                      (apply fr (str "Section " i) 3000 2000
                             (for [_ (range 18)]
                               (fr "Parent" 800 600 (rect "R"))))))
        auto (select page {})]
    (t/is (= 216 (count (named page "Parent"))))
    (t/is (= (named page "Parent") (:ids auto))
          "12 sections are under 10 % of the 216 screens, so they are a layer and go")
    (t/is (= [[800 600 216]] (sizes-of auto)))))

(t/deftest equal-sized-sections-with-few-screens-select-the-standard-size-screens
  ;; Before the standard-size step this selected the 12 sections.
  (let [page (apply build
                    (for [i (range 12)]
                      (apply fr (str "Section " i) 3000 2000
                             (for [_ (range (if (< i 6) 3 2))]
                               (fr "Parent" 800 600 (rect "R"))))))
        auto (select page {})]
    (t/is (= 30 (count (named page "Parent"))))
    (t/is (= (named page "Parent") (:ids auto)))
    (t/is (= "standard-size" (get-in auto [:selection :basis])))
    (t/is (nil? (:deeper-boards auto)))))

(t/deftest equal-sized-sections-with-an-equal-sized-wrapper-each-select-the-screens
  ;; Before the standard-size step this selected the 12 sections.
  (let [page (apply build
                    (for [i (range 12)]
                      (fr (str "Section " i) 3000 2000
                          (apply fr "Wrap" 2800 1800
                                 (for [_ (range 18)]
                                   (fr "Parent" 800 600 (rect "R")))))))
        auto (select page {})]
    (t/is (= 216 (count (named page "Parent"))))
    (t/is (= (named page "Parent") (:ids auto)))
    (t/is (= "standard-size" (get-in auto [:selection :basis])))))

(t/deftest two-layers-of-containers-are-removed-one-after-the-other
  (let [page (apply build
                    (for [r (range 3)]
                      (apply fr (str "Region " r) 9000 6000
                             (for [s (range 20)]
                               (apply fr (str "Section " r "-" s) 2000 1500
                                      (for [_ (range 20)]
                                        (fr "Parent" 800 600 (rect "R"))))))))
        auto (select page {})]
    (t/is (= 1200 (count (named page "Parent"))))
    (t/is (= (named page "Parent") (:ids auto))
          "3 regions are under 10 % of 60 sections, then 60 sections under 10 % of 1200 screens")))

(t/deftest screens-wrapped-in-same-size-frames-keep-the-frame-named-like-the-bare-screens
  (let [page (build (fr "Section" 3000 2000
                        (fr "Single" 800 600 (fr "Parent" 800 600 (rect "R")))
                        (fr "Single" 800 600 (fr "Parent" 800 600 (rect "R")))
                        (fr "Single" 801 601 (fr "Parent" 800 600 (rect "R")))
                        (fr "Parent" 800 600 (rect "R"))
                        (fr "Parent" 800 600 (rect "R"))
                        (fr "Parent" 800 600 (rect "R"))))
        auto (select page {})]
    (t/is (= (named page "Parent") (:ids auto)))
    (t/is (= 6 (count (:ids auto))))
    (t/is (= 3 (get-in auto [:selection :nested-same-size])))
    (t/is (= {:min-depth 2 :max-depth 3} (select-keys (:selection auto) [:min-depth :max-depth])))
    (t/is (= [] (get-in auto [:selection :other-sizes])))))

(t/deftest list-rows-do-not-outnumber-the-screens-enough-to-replace-them
  (let [page (apply build
                    (for [_ (range 6)]
                      (apply fr "Screen" 390 844
                             (for [_ (range 8)] (fr "Row" 300 40 (rect "R"))))))
        auto (select page {})]
    (t/is (= 48 (count (named page "Row"))))
    (t/is (= (named page "Screen") (:ids auto))
          "6 screens are 12.5 % of the 48 rows, so they are not a layer")
    (t/is (= [[390 844 6]] (sizes-of auto)))))

(t/deftest many-list-rows-do-not-replace-the-screens
  ;; Before the 200 px bound this selected the 120 rows. Rows are under 200 px
  ;; high, so they are no candidates, and 390 by 844 is a standard size.
  (let [page (apply build
                    (for [_ (range 6)]
                      (apply fr "Screen" 390 844
                             (for [_ (range 20)] (fr "Row" 300 40 (rect "R"))))))
        auto (select page {})]
    (t/is (= (named page "Screen") (:ids auto)))
    (t/is (= [] (get-in auto [:selection :other-sizes])) "the rows form no class")))

(t/deftest mobile-and-desktop-screens-are-all-selected
  (let [page (build (fr "Desktop" 1440 900) (fr "Mobile" 390 844) (fr "Desktop" 1440 900)
                    (fr "Mobile" 390 844) (fr "Mobile" 390 844) (fr "Desktop" 1440 900)
                    (fr "Mobile" 390 844) (fr "Desktop" 1440 900) (fr "Mobile" 390 844)
                    (fr "Desktop" 1440 900) (fr "Mobile" 390 844))
        auto (select page {})]
    (t/is (= (level-1 page) (:ids auto)))
    (t/is (= [[390 844 6] [1440 900 5]] (sizes-of auto)) "the size with more boards first")))

(t/deftest decision-frames-beside-the-screens-are-not-boards
  (let [page (build (fr "Screen" 800 600) (fr "Decision" 200 100) (fr "Screen" 800 600)
                    (fr "Decision" 200 100) (fr "Screen" 800 600) (fr "Decision" 200 100)
                    (fr "Screen" 800 600) (fr "Decision" 200 100) (fr "Odd" 700 500))
        auto (select page {})]
    (t/is (= (named-many page "Screen" "Odd") (:ids auto))
          "4 decision frames are a size class but under 10 % of the area of a screen")))

(t/deftest frames-inside-component-instances-are-not-candidates
  (let [copy (fn [name & kids] (apply fr+ name 900 700 {:component-id (uuid/next) :shape-ref (uuid/next)} kids))
        page (build (copy "Copy 1" (fr "Inner" 800 600))
                    (copy "Copy 2" (fr "Inner" 800 600))
                    (copy "Copy 3" (fr "Inner" 800 600))
                    (copy "Copy 4" (fr "Inner" 800 600)))
        auto (select page {})]
    (t/is (= (level-1 page) (:ids auto)) "no candidate is left, so the selection falls back to depth 1")
    (t/is (true? (get-in auto [:selection :fallback])))
    (t/is (= 1 (get-in auto [:selection :depth])))
    (t/is (= [] (get-in auto [:selection :sizes])))
    (t/is (= [] (get-in auto [:selection :other-sizes])) "frames inside component instances form no class"))
  (t/testing "plain screens beside component copies"
    (let [copy (fn [name & kids] (apply fr+ name 800 600 {:component-id (uuid/next) :shape-ref (uuid/next)} kids))
          page (build (fr "Screen" 800 600) (fr "Screen" 800 600) (fr "Screen" 800 600)
                      (copy "Copy 1" (fr "Inner" 800 600)) (copy "Copy 2"))
          auto (select page {})]
      (t/is (= (named page "Screen") (:ids auto))))))

(t/deftest no-size-repeated-three-times-falls-back-to-depth-1
  (let [page (build (fr "Section 1" 3000 2000 (fr "Inner" 800 600))
                    (fr "Section 2" 3000 2000 (fr "Inner" 800 600))
                    (fr "Section 3" 2500 1500))
        auto (select page {})]
    (t/is (= (level-1 page) (:ids auto)))
    (t/is (= {:mode "auto" :fallback true :basis "depth-fallback" :depth 1 :sizes [] :sizes-omitted 0
              :other-sizes [] :boards 3 :min-depth 1 :max-depth 1}
             (:selection auto)))
    (t/is (nil? (:deeper-boards auto)))))

(t/deftest hidden-frames-and-their-subtrees-are-left-out
  (let [page (build (fr "A" 400 300) (fr "B" 400 300) (fr "C" 400 300)
                    (fr+ "Hidden" 400 300 {:hidden true} (fr "Under hidden" 400 300))
                    (fr "D" 400 300 (fr+ "Hidden inner" 100 100 {:hidden true})))
        auto (select page {})]
    (t/is (= (named-many page "A" "B" "C" "D") (:ids auto)))
    (t/is (= [] (get-in auto [:selection :other-sizes])) "the hidden frames form no class")))

;; --- STANDARD SIZES AND THE SCREEN-SIZE BOUND

(defn- basis-of
  "The `basis` of a selection reply."
  [out]
  (get-in out [:selection :basis]))

(t/deftest six-800-by-600-screens-with-list-rows-select-the-screens
  (let [page (apply build
                    (for [_ (range 6)]
                      (apply fr "Screen" 800 600
                             (for [_ (range 20)] (fr "Row" 760 48 (rect "R"))))))
        auto (select page {})]
    (t/is (= (named page "Screen") (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))))

(t/deftest twelve-equal-sections-with-thirty-800-by-600-screens-select-the-screens
  (let [page (apply build
                    (for [i (range 12)]
                      (apply fr (str "Section " i) 3000 2000
                             (for [_ (range (if (< i 6) 3 2))]
                               (fr "Parent" 800 600 (rect "R"))))))
        auto (select page {})]
    (t/is (= 30 (count (:ids auto))))
    (t/is (= (named page "Parent") (:ids auto)))))

(t/deftest sections-with-an-equal-wrapper-each-and-800-by-600-screens-select-the-screens
  (let [page (apply build
                    (for [i (range 12)]
                      (fr (str "Section " i) 3000 2000
                          (apply fr "Wrap" 2800 1800
                                 (for [_ (range 3)] (fr "Parent" 800 600 (rect "R")))))))
        auto (select page {})]
    (t/is (= (named page "Parent") (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))))

(t/deftest non-standard-screens-with-list-rows-are-still-the-screens
  ;; 900 by 700 is not a standard size, so the structure decides. The rows
  ;; (760 by 48) are under 200 px high and never form a class.
  (let [page (apply build
                    (for [_ (range 6)]
                      (apply fr "Screen" 900 700
                             (for [_ (range 20)] (fr "Row" 760 48 (rect "R"))))))
        auto (select page {})]
    (t/is (= (named page "Screen") (:ids auto)))
    (t/is (= "structure" (basis-of auto)))))

(t/deftest non-standard-screens-under-equal-sections-select-the-sections
  ;; Documents the structural rules: 12 equal sections hold 30 screens of
  ;; 900 by 700 (not a standard size). The sections are the top class and 12
  ;; is not under 10 % of 30, so the sections are selected, which a designer
  ;; would not call the screens.
  (let [page (apply build
                    (for [i (range 12)]
                      (apply fr (str "Section " i) 3000 2000
                             (for [_ (range (if (< i 6) 3 2))]
                               (fr "Parent" 900 700 (rect "R"))))))
        auto (select page {})]
    (t/is (= (named-like page "Section") (:ids auto)))
    (t/is (= "structure" (basis-of auto)))))

(t/deftest non-standard-screens-under-sections-with-wrappers-select-the-sections
  ;; Documents the structural rules: every section holds one equal wrapper,
  ;; then 18 screens of 900 by 700. The wrapper class is as large as the
  ;; section class, so the sections are not a layer and are selected.
  (let [page (apply build
                    (for [i (range 12)]
                      (fr (str "Section " i) 3000 2000
                          (apply fr "Wrap" 2800 1800
                                 (for [_ (range 18)] (fr "Parent" 900 700 (rect "R")))))))
        auto (select page {})]
    (t/is (= (named-like page "Section") (:ids auto)))
    (t/is (= "structure" (basis-of auto)))))

(t/deftest mobile-and-desktop-screens-at-different-depths-are-both-selected
  (let [page (build (fr "Mobile" 375 812) (fr "Mobile" 375 812)
                    (fr "Section" 5000 3000
                        (fr "Wrap" 4000 2000
                            (fr "Desktop" 1440 900) (fr "Desktop" 1440 900) (fr "Desktop" 1440 900)))
                    (fr "Mobile" 375 812))
        auto (select page {})]
    (t/is (= (named-many page "Mobile" "Desktop") (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))
    (t/is (= {:min-depth 1 :max-depth 3} (select-keys (:selection auto) [:min-depth :max-depth])))))

(t/deftest tall-screens-form-a-standard-class-when-there-are-three-of-a-size
  (let [page (apply build
                    (concat (for [_ (range 6)] (fr "Screen" 800 600))
                            (for [_ (range 4)] (fr "Tall" 800 1400))))
        auto (select page {})]
    (t/is (= (level-1 page) (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))
    (t/is (= [[800 600 6] [800 1400 4]] (sizes-of auto)))))

(t/deftest fewer-than-three-tall-screens-come-in-as-loose-boards-at-the-same-level
  ;; Two tall screens do not form a class. At the level of the screens they
  ;; are loose boards. Inside a section they are not: the section, at the
  ;; level of the screens, is the loose board instead.
  (let [flat   (build (fr "Screen" 800 600) (fr "Screen" 800 600) (fr "Screen" 800 600)
                      (fr "Tall" 800 1400) (fr "Tall" 800 1400))
        nested (build (fr "Screen" 800 600) (fr "Screen" 800 600) (fr "Screen" 800 600)
                      (fr "Section" 3000 2000 (fr "Tall" 800 1400) (fr "Tall" 800 1400)))
        a      (select flat {})
        b      (select nested {})]
    (t/is (= (level-1 flat) (:ids a)) "both tall screens are admitted as loose boards")
    (t/is (= (named-many nested "Screen" "Section") (:ids b)))
    (t/is (empty? (filter (set (named nested "Tall")) (:ids b))) "the nested tall screens are not boards")))

(t/deftest large-equal-panels-inside-screens-are-not-the-screens
  (let [page (apply build
                    (for [_ (range 6)]
                      (fr "Screen" 800 600 (fr "Panel" 380 400) (fr "Panel" 380 400))))
        auto (select page {})]
    (t/is (= (named page "Screen") (:ids auto)))
    (t/is (= [[800 600 6]] (sizes-of auto)))
    (t/is (= [{:width 380 :height 400 :boards 12 :relation "inside"}]
             (get-in auto [:selection :other-sizes]))
          "the panels repeat inside the screens and are reported, not selected")))

(t/deftest portrait-and-landscape-table-entries-both-count
  (let [page (build (fr "Portrait" 600 800) (fr "Portrait" 600 800) (fr "Portrait" 600 800))
        auto (select page {})]
    (t/is (= (level-1 page) (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))
    (t/is (true? (boards/standard-size? 800 600)))
    (t/is (true? (boards/standard-size? 600 800)))))

(t/deftest a-size-two-pixels-off-is-standard-and-three-is-not
  (t/is (true? (boards/standard-size? 802 598)))
  (t/is (true? (boards/standard-size? 798 602)))
  (t/is (false? (boards/standard-size? 803 600)))
  (t/is (false? (boards/standard-size? 797 600)))
  (t/is (true? (boards/standard-size? 802 1400)) "the taller rule: width within 2 px, height above the entry")
  (t/is (true? (boards/standard-size? 800 520)) "800 wide and over the listed 800 by 480")
  (t/is (false? (boards/standard-size? 800 350))
        "the taller rule uses the listed orientation: 800 by 360 would come from 360 by 800 turned")
  (t/is (false? (boards/standard-size? 320 500)) "320 by 480 is listed turned, so the taller rule does not apply")
  (t/is (true? (boards/standard-size? 568 320)) "the exact match keeps both orientations")
  (t/is (false? (boards/standard-size? 803 1400)))
  (t/is (false? (boards/standard-size? 800 300)) "shorter than every entry of that width")
  (t/is (false? (boards/standard-size? 900 700)))
  (let [near (build (fr "A" 802 598) (fr "B" 802 598) (fr "C" 802 598))
        off  (build (fr "A" 803 600) (fr "B" 803 600) (fr "C" 803 600))]
    (t/is (= "standard-size" (basis-of (select near {}))))
    (t/is (= "structure" (basis-of (select off {}))))))

(t/deftest the-basis-names-how-the-boards-were-found
  (let [standard (select (build (fr "A" 800 600) (fr "B" 800 600) (fr "C" 800 600)) {})
        struct   (select (build (fr "A" 900 700) (fr "B" 900 700) (fr "C" 900 700)) {})
        fallback (select (build (fr "A" 900 700) (fr "B" 500 500)) {})
        depth    (select (build (fr "A" 900 700)) {:depth 1})]
    (t/is (= "standard-size" (basis-of standard)))
    (t/is (= "structure" (basis-of struct)))
    (t/is (= "depth-fallback" (basis-of fallback)))
    (t/is (true? (get-in fallback [:selection :fallback])))
    (t/is (false? (get-in standard [:selection :fallback])))
    (t/is (not (contains? (:selection depth) :basis)) "depth mode has no basis")))

(t/deftest frames-under-200-px-on-a-side-are-no-candidates
  (t/is (= 200 boards/min-screen-side))
  (let [page (build (fr "Screen" 900 700 (fr "Banner" 1440 180))
                    (fr "Screen" 900 700 (fr "Banner" 1440 180))
                    (fr "Screen" 900 700 (fr "Banner" 1440 180)))
        auto (select page {})]
    (t/is (= (named page "Screen") (:ids auto)))
    (t/is (= [[900 700 3]] (sizes-of auto)) "the banners form no class")
    (t/is (= [] (get-in auto [:selection :other-sizes]))))
  (t/testing "200 by 200 is a candidate, 199 by 600 is not"
    (let [page (build (fr "A" 200 200) (fr "B" 200 200) (fr "C" 200 200)
                      (fr "N1" 199 600) (fr "N2" 199 600) (fr "N3" 199 600))
          auto (select page {})]
      (t/is (= (named-many page "A" "B" "C") (:ids auto))))))

;; --- SCREENS THAT HOLD FRAMES OF A STANDARD SIZE

(t/deftest kiosk-screens-with-a-content-frame-select-the-screens
  ;; Before: the 204 Content frames (800 by 520 is over the listed 800 by 480)
  ;; were selected and the screens were not.
  (let [page (apply build
                    (for [s (range 12)]
                      (apply fr (str "Section" s) 3000 2000
                             (for [_ (range 17)]
                               (fr "Parent" 800 600
                                   (fr "Header" 800 80 (rect "h"))
                                   (fr "Content" 800 520 (rect "c")))))))
        auto (select page {})]
    (t/is (= 204 (count (named page "Content"))))
    (t/is (= (named page "Parent") (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))
    (t/is (= [[800 600 204]] (sizes-of auto)))
    (t/is (= [{:width 800 :height 520 :boards 204 :relation "inside"}
              {:width 3000 :height 2000 :boards 12 :relation "outside"}]
             (get-in auto [:selection :other-sizes])))))

(t/deftest phone-screens-with-a-body-frame-select-the-phones
  ;; Before: the 375 by 700 bodies replaced the phones.
  (let [page (apply build
                    (for [_ (range 10)]
                      (fr "Phone" 375 812 (fr "Status" 375 44) (fr "Body" 375 700 (rect "b")))))
        auto (select page {})]
    (t/is (= (named page "Phone") (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))))

(t/deftest long-desktop-pages-with-equal-sections-select-the-pages
  (let [page (apply build
                    (for [_ (range 5)]
                      (fr "Page" 1440 4000
                          (fr "Hero" 1440 1000 (rect "a"))
                          (fr "Feat" 1440 1000 (rect "b"))
                          (fr "Foot" 1440 1000 (rect "c")))))
        auto (select page {})]
    (t/is (= (named page "Page") (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))))

(t/deftest cards-inside-a-few-large-boards-do-not-replace-the-boards
  ;; Before: 320 by 500 counted as standard (480 by 320 turned, taller rule),
  ;; so the 12 cards replaced the 4 boards.
  (let [page (apply build
                    (for [_ (range 4)]
                      (fr "Board" 1200 900
                          (fr "Card" 320 500) (fr "Card" 320 500) (fr "Card" 320 500))))
        auto (select page {})]
    (t/is (= (named page "Board") (:ids auto)))
    (t/is (= "structure" (basis-of auto)))
    (t/is (= [{:width 320 :height 500 :boards 12 :relation "inside"}]
             (get-in auto [:selection :other-sizes])))))

(t/deftest a-dialog-in-three-of-a-hundred-screens-does-not-replace-them
  ;; Before: the 3 dialogs were selected, and the 3 screens that hold them left out.
  (let [page (apply build
                    (for [i (range 100)]
                      (if (< i 3)
                        (fr "Screen" 1200 800 (rect "x") (fr "Dialog" 480 300 (rect "d")))
                        (fr "Screen" 1200 800 (rect "x")))))
        auto (select page {})]
    (t/is (= 100 (count (:ids auto))))
    (t/is (= (named page "Screen") (:ids auto)))
    (t/is (= "structure" (basis-of auto)))
    (t/is (= [{:width 480 :height 300 :boards 3 :relation "inside"}]
             (get-in auto [:selection :other-sizes])))))

(t/deftest standard-size-phone-mockups-in-non-standard-screens-win-a-known-limit
  ;; A known limit: a standard class beats a non-standard parent that has
  ;; fewer members, so the 12 mockups are the boards, not the 4 screens.
  (let [page (apply build
                    (for [_ (range 4)]
                      (fr "Screen" 1200 900
                          (fr "Mockup" 375 812 (rect "a"))
                          (fr "Mockup" 375 812 (rect "b"))
                          (fr "Mockup" 375 812 (rect "c")))))
        auto (select page {})]
    (t/is (= (named page "Mockup") (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))
    (t/is (= [{:width 1200 :height 900 :boards 4 :relation "outside"}]
             (get-in auto [:selection :other-sizes]))
          "the screens are reported as another size that repeats")))

(t/deftest screens-in-one-to-one-annotation-wrappers-are-still-the-screens
  ;; Before: each 820 by 640 wrapper class had as many members as the screens
  ;; (30), so the screens went and the 3 sections were selected.
  (let [page (apply build
                    (for [s (range 3)]
                      (apply fr (str "Section " s) 3000 2000
                             (for [_ (range 10)]
                               (fr "Note" 820 640 (fr "Parent" 800 600 (rect "x")))))))
        auto (select page {})]
    (t/is (= (named page "Parent") (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))))

(t/deftest phones-in-one-to-one-device-frames-are-still-the-phones
  ;; Before: the ten 420 by 900 device frames had as many members as the
  ;; phones, so the phones went and the device frames were selected.
  (let [page (apply build
                    (for [_ (range 10)]
                      (fr "Device" 420 900 (fr "Phone" 375 812 (rect "x")))))
        auto (select page {})]
    (t/is (= (named page "Phone") (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))))

(t/deftest three-standard-dialogs-in-exactly-three-other-screens-are-selected-a-known-result
  ;; A known result: a standard class goes only when a class with more members
  ;; holds it. Three 800 by 600 dialogs in three 900 by 700 screens tie, so the
  ;; dialogs are the boards. With a fourth screen the screens would win.
  (let [page (apply build
                    (for [_ (range 3)]
                      (fr "Screen" 900 700 (fr "Dialog" 800 600 (rect "d")))))
        auto (select page {})]
    (t/is (= (named page "Dialog") (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))))

(t/deftest of-two-boards-in-different-classes-the-outer-one-stays
  ;; One of the four boards of the kiosk size sits in a desktop screen. That is
  ;; not more than half of its class, so neither class lies inside the other.
  ;; The inner board goes, and the outer one stays.
  (let [page (apply build
                    (concat
                     [(fr "Desktop" 1440 900 (fr "Inside" 800 600 (rect "r")))]
                     (for [_ (range 5)] (fr "Desktop" 1440 900 (rect "r")))
                     (for [_ (range 3)] (fr "Kiosk" 800 600 (rect "r")))))
        auto (select page {})]
    (t/is (= (named-many page "Desktop" "Kiosk") (:ids auto)) "6 desktop and 3 loose kiosk boards")
    (t/is (empty? (filter (set (named page "Inside")) (:ids auto))) "the inner board of the other class goes")
    (t/is (= [[1440 900 6] [800 600 3]] (sizes-of auto)))))

(t/deftest two-hundred-size-classes-are-weighed-in-part-and-finish
  (let [page (apply build
                    (for [i (range 200)
                          _ (range 3)]
                      (fr (str "S" i) (+ 300 (* 5 i)) 250 (rect "r"))))
        seen (atom nil)
        orig @#'boards/get-inside-map
        auto (with-redefs-fn {#'boards/get-inside-map
                              (fn [classes class-of qualifying]
                                (reset! seen (count qualifying))
                                (orig classes class-of qualifying))}
               #(select page {}))]
    (t/is (= 50 @seen) "only the 50 classes with the most members are weighed")
    (t/is (false? (:timed-out? auto)))
    (t/is (= 600 (count (:ids auto))) "the other classes join as loose boards")
    (t/is (<= (count (get-in auto [:selection :other-sizes])) boards/max-other-sizes))))

(t/deftest select-auto-stops-at-an-expired-deadline
  (let [page   (build (fr "A" 400 300) (fr "B" 400 300) (fr "C" 400 300))
        frames (:frames (boards/walk-frames (:objects page) (in-seconds 5)))
        out    (boards/select-auto frames (- (System/nanoTime) 1))]
    (t/is (true? (:timed-out? out)))
    (t/is (true? (:fallback? out)))
    (t/is (false? (:timed-out? (boards/select-auto frames))) "no deadline never expires")))

;; --- DEPTH MODE

(defn- chain
  "A chain of `n` nested frames, each of its own size."
  [n]
  (letfn [(link [i]
            (apply fr (str "L" i) (+ 100 (* 10 i)) 100
                   (when (< i n) [(link (inc i))])))]
    (build (link 1))))

(t/deftest depth-mode-takes-the-frames-down-to-the-depth
  (let [page (chain 14)
        six  (select page {:depth 6})
        twel (select page {:depth 12})]
    (t/is (= (take 6 (:order page)) (:ids six)))
    (t/is (= {:mode "depth" :depth 6 :boards 6 :min-depth 1 :max-depth 6} (:selection six)))
    (t/is (= 0 (:deeper-boards six)) "the chain frames are 100 px high: no screen-sized frame is deeper")
    (t/is (= (take 12 (:order page)) (:ids twel)))
    (t/is (= {:mode "depth" :depth 12 :boards 12 :min-depth 1 :max-depth 12} (:selection twel)))
    (t/is (= 0 (:deeper-boards twel)))
    (t/is (= [(first (:order page))] (:ids (select page {:mode :depth}))) "depth 1 is the default"))
  (t/testing "depth mode keeps component frames, as it always did"
    (let [page (build (fr+ "Head" 100 100 {:component-id (uuid/next)} (fr "In" 50 50)))]
      (t/is (= 1 (count (:ids (select page {:depth 1})))))
      (t/is (= 2 (count (:ids (select page {:depth 2})))))
      (t/is (= 0 (:deeper-boards (select page {:depth 2})))))))

(t/deftest depth-mode-counts-the-repeated-screen-sized-frames-below-the-selection
  ;; Before: it counted every frame below the selection, buttons included, so
  ;; it was almost never 0.
  (let [page (journeys 12 (fn [i] [3000 (+ 2000 (* 20 i))]) 3 0 3)]
    (t/is (= 36 (:deeper-boards (select page {:depth 1})))
          "the 36 screens repeat below the 12 sections; wrappers, buttons and decisions do not count")
    (t/is (= 0 (:deeper-boards (select page {:depth 5}))) "the screens are selected, the buttons are small")
    (t/is (nil? (:deeper-boards (select page {:mode :auto}))) "mode auto has none"))
  (t/testing "a screen-sized frame that does not repeat is not counted"
    (let [page (build (fr "Section" 3000 2000 (fr "Screen" 800 600) (fr "Screen" 800 600)))]
      (t/is (= 0 (:deeper-boards (select page {:depth 1})))))))

;; --- NAME FILTER

(t/deftest the-name-filter-runs-after-the-automatic-selection
  (let [page   (build (fr "Login" 800 600) (fr "Login" 800 600) (fr "Settings" 800 600)
                      (fr "Settings" 800 600) (fr "Login" 800 600))
        login? (fn [shape] (str/starts-with? (:name shape) "Login"))
        auto   (select page {:mode :auto :name-match login?})
        none   (select page {:name-match login?})]
    (t/is (= (named page "Login") (:ids auto)))
    (t/is (= "auto" (get-in auto [:selection :mode])))
    (t/is (= [[800 600 3]] (sizes-of auto)))
    (t/is (= "depth" (get-in none [:selection :mode])) "a name filter alone means depth mode")
    (t/is (= (named page "Login") (:ids none)))
    (t/is (= 3 (get-in auto [:selection :boards])))))

(t/deftest the-name-filter-applies-to-the-fallback-too
  (let [page (build (fr "A" 100 100) (fr "B" 200 200))
        out  (select page {:mode :auto :name-match #(= "B" (:name %))})]
    (t/is (= (named page "B") (:ids out)))
    (t/is (true? (get-in out [:selection :fallback])))))

;; --- DEADLINE

(t/deftest an-expired-deadline-cuts-the-walk
  (let [page (build (fr "A" 400 300) (fr "B" 400 300) (fr "C" 400 300))
        past (- (System/nanoTime) 1)]
    (doseq [opts [{} {:depth 2} {:mode :auto}]]
      (let [out (boards/select-boards (:objects page) (assoc opts :deadline past))]
        (t/is (true? (:timed-out? out)))
        (t/is (= [] (:ids out)))
        (t/is (= 0 (get-in out [:selection :boards])))))))

(t/deftest a-short-deadline-cuts-a-large-walk
  (let [page (apply build (for [i (range 60000)] (fr (str "F" i) (+ 100 (mod i 50)) 100)))
        out  (boards/select-boards (:objects page) {:deadline (+ (System/nanoTime) 1000000)})]
    (t/is (true? (:timed-out? out)))))

(t/deftest the-name-filter-stops-at-the-deadline-and-on-a-timeout
  (let [page (build (fr "A" 400 300) (fr "B" 400 300) (fr "C" 400 300))
        out  (select page {:depth 1 :name-match (fn [_] :timeout)})]
    (t/is (true? (:timed-out? out)))
    (t/is (= [] (:ids out)))))

;; --- ROBUSTNESS

(t/deftest missing-and-repeated-ids-do-not-break-the-walk
  (let [objects {uuid/zero {:id uuid/zero :type :frame :shapes [:a :missing :a :b]}
                 :a        {:id :a :type :frame :name "A" :x 0 :y 0 :width 10 :height 10
                            :parent-id uuid/zero :shapes [:b]}
                 :b        {:id :b :type :frame :name "B" :x 0 :y 0 :width 20 :height 20
                            :parent-id :a :shapes []}}
        out     (boards/select-boards objects {:depth 2 :deadline (in-seconds 5)})]
    (t/is (= [:a :b] (:ids out)) "each shape is walked once")))

;; --- WRAPPERS OF TALLER SIZE

(defn- caption
  "A text spec named `name`."
  [name]
  {:t :text :name name :w 100 :h 20 :kids []})

(defn- wrapped
  "A wrapper frame of 800 by 660 that holds one screen of 800 by 600 and a
  caption."
  []
  (fr "State" 800 660 (fr "Parent" 800 600) (caption "Caption")))

(t/deftest screens-inside-taller-wrappers-are-selected-not-the-wrappers
  (let [page (apply build (for [_ (range 7)] (wrapped)))
        auto (select page {})]
    (t/is (= (named page "Parent") (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))
    (t/is (= [[800 600 7]] (sizes-of auto)))
    (t/is (= [{:width 800 :height 660 :boards 7 :relation "wrapper"}]
             (get-in auto [:selection :other-sizes])))))

(t/deftest screens-outside-wrappers-join-the-screens-inside-them
  (let [page (apply build (concat (for [_ (range 7)] (wrapped))
                                  (for [_ (range 3)] (fr "Parent" 800 600))))
        auto (select page {})]
    (t/is (= (named page "Parent") (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))
    (t/is (= [[800 600 10]] (sizes-of auto)))))

(t/deftest tall-scrolling-screens-with-no-exact-screen-inside-stay-selected
  (let [page (apply build (for [_ (range 6)] (fr "Tall" 800 1400 (rect "Body"))))
        auto (select page {})]
    (t/is (= (named page "Tall") (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))
    (t/is (= [[800 1400 6]] (sizes-of auto)))))

(t/deftest a-few-exact-dialogs-inside-tall-screens-do-not-make-them-wrappers
  (let [panel (fn [] (fr "Panel" 300 300))
        tall  (fn [dialog?]
                (apply fr "Tall" 800 1400
                       (cond-> [(panel) (panel) (panel)]
                         dialog? (conj (fr "Dialog" 800 600)))))
        page  (apply build (concat (for [_ (range 3)] (tall true))
                                   (for [_ (range 5)] (tall false))))
        auto  (select page {})]
    (t/is (= (named page "Tall") (:ids auto)) "3 dialogs for 8 tall screens: under half")
    (t/is (= "standard-size" (basis-of auto)))
    (t/is (= [[800 1400 8]] (sizes-of auto)))))

(t/deftest exact-standard-size-has-no-taller-rule
  (t/is (true? (boards/exact-standard-size? 800 600)))
  (t/is (true? (boards/exact-standard-size? 600 802)))
  (t/is (false? (boards/exact-standard-size? 800 660)))
  (t/is (true? (boards/standard-size? 800 660))))

(t/deftest scrolling-phones-holding-one-phone-frame-are-the-screens
  (let [page (apply build (for [_ (range 5)] (fr "Scroll" 390 2000 (fr "Phone" 390 844))))
        auto (select page {})]
    (t/is (= (named page "Scroll") (:ids auto)) "2000 is far over 1.25 times 844")
    (t/is (= "standard-size" (basis-of auto)))))

(t/deftest tall-pages-holding-two-screens-of-their-width-are-the-screens
  (let [page (apply build (for [_ (range 4)]
                            (fr "Page" 1440 4000 (fr "A" 1440 900) (fr "B" 1440 1200))))
        auto (select page {})]
    (t/is (= (named page "Page") (:ids auto)))))

(t/deftest dialogs-in-some-tall-screens-do-not-take-the-screens-place
  (let [page (apply build (concat (for [_ (range 4)] (fr "Tall" 800 1400 (fr "Dialog" 800 600)))
                                  (for [_ (range 4)] (fr "Tall" 800 1400))))
        auto (select page {})]
    (t/is (= (named page "Tall") (:ids auto)))
    (t/is (= [[800 1400 8]] (sizes-of auto)))))

(t/deftest bare-screens-and-wrapped-screens-are-all-selected
  (let [page (apply build (concat (for [_ (range 3)] (wrapped))
                                  (for [_ (range 10)] (fr "Parent" 800 600))))
        auto (select page {})]
    (t/is (= (named page "Parent") (:ids auto)))
    (t/is (= 13 (count (:ids auto))))
    (t/is (= [[800 600 13]] (sizes-of auto)))))

(t/deftest wrappers-that-mostly-hold-no-screen-are-not-wrapper-classes
  ;; 8 frames of 800 by 660, 4 with one screen: exactly half, not more than
  ;; half. The class is a standard (taller) class, and the 4 screens inside
  ;; it go.
  (let [page (apply build (concat (for [_ (range 4)] (fr "State" 800 660 (fr "Parent" 800 600)))
                                  (for [_ (range 4)] (fr "State" 800 660))))
        auto (select page {})]
    (t/is (= (named page "State") (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))))

(t/deftest wrappers-of-wrappers-around-screens-select-the-screens
  (let [page (apply build (for [_ (range 6)]
                            (fr "Outer" 800 720 (fr "State" 800 660 (fr "Parent" 800 600)))))
        auto (select page {})]
    (t/is (= (named page "Parent") (:ids auto)))
    (t/is (= "standard-size" (basis-of auto)))))

(t/deftest a-wrapper-class-shows-in-other-sizes-with-relation-wrapper
  (let [page (apply build (for [_ (range 6)] (wrapped)))
        auto (select page {})]
    (t/is (= [{:width 800 :height 660 :boards 6 :relation "wrapper"}]
             (get-in auto [:selection :other-sizes])))))

;; --- NESTED FRAMES OF ONE SIZE

(defn- matcher
  "A `:name-match` function that accepts the shapes whose name matches `re`."
  [re]
  (fn [shape] (boolean (re-find re (:name shape)))))

(t/deftest the-outer-frame-of-a-same-size-pair-is-the-board
  (let [page (apply build
                    (concat (for [_ (range 3)]
                              (fr "Parent" 800 600 (fr "Wrapper" 800 600 (rect "Content"))))
                            (for [_ (range 3)] (fr "Parent" 800 600))))
        auto (select page {})]
    (t/is (= (named page "Parent") (:ids auto)))
    (t/is (= 3 (get-in auto [:selection :nested-same-size])))
    (t/is (= [[800 600 6]] (sizes-of auto)))))

(t/deftest no-nested-same-size-key-when-nothing-was-left-out
  (let [auto (select (apply build (for [_ (range 4)] (fr "Parent" 800 600))) {})]
    (t/is (not (contains? (:selection auto) :nested-same-size)))))

(t/deftest a-chain-of-same-size-frames-keeps-one-by-name
  (let [page (apply build (for [_ (range 4)]
                            (fr "State" 800 600 (fr "Parent" 800 600 (fr "Grid" 800 600)))))
        run  (fn [re] (select page (cond-> {:mode :auto}
                                     re (assoc :name-match (matcher re)))))]
    (t/is (= (named page "State") (:ids (run nil))) "rule 3: no bare board, the outermost")
    (t/is (= (named page "Parent") (:ids (run #"^Parent$"))))
    (t/is (= (named page "Grid") (:ids (run #"^Grid$"))))
    (t/is (= [] (:ids (run #"^Nothing$"))) "no member matches: the outermost goes in the name filter")
    (t/is (= 4 (get-in (run #"^Parent$") [:selection :nested-same-size])))
    (t/is (= 4 (get-in (run nil) [:selection :nested-same-size])))))

(t/deftest a-chain-takes-the-name-of-the-bare-screens
  (let [page (apply build (concat (for [_ (range 4)]
                                    (fr "State" 800 600 (fr "Parent" 800 600 (fr "Grid" 800 600))))
                                  (for [_ (range 3)] (fr "Parent" 800 600))))
        auto (select page {})]
    (t/is (= (named page "Parent") (:ids auto)) "rule 2: 7 Parent frames")
    (t/is (= 4 (get-in auto [:selection :nested-same-size])))
    (t/is (= (named page "Grid")
             (:ids (select page {:mode :auto :name-match (matcher #"^Grid$")})))
          "a regex comes first")))

(t/deftest a-common-inner-name-does-not-win-without-bare-screens
  (let [page (build (fr "Login" 800 600 (fr "Grid" 800 600))
                    (fr "Home" 800 600 (fr "Grid" 800 600))
                    (fr "Keys" 800 600 (fr "Grid" 800 600))
                    (fr "Admin" 800 600 (fr "Grid" 800 600)))
        auto (select page {})]
    (t/is (= (level-1 page) (:ids auto)) "rule 3: the 4 outer frames")
    (t/is (= 4 (get-in auto [:selection :nested-same-size])))))

(t/deftest a-tie-between-bare-names-keeps-the-outer-frame
  (let [page (build (fr "A" 800 600 (fr "B" 800 600)) (fr "A" 800 600) (fr "B" 800 600))
        auto (select page {})]
    (t/is (= (level-1 page) (:ids auto)))
    (t/is (= 1 (get-in auto [:selection :nested-same-size])))))

(t/deftest a-name-match-that-times-out-counts-as-no-match
  (let [page (apply build (for [_ (range 4)]
                            (fr "State" 800 600 (fr "Parent" 800 600))))
        auto (select page {:mode :auto :name-match (fn [_] :timeout)})]
    (t/is (= [] (:ids auto)))
    (t/is (true? (:timed-out? auto)))))

(t/deftest default-frame-names-do-not-pick-the-board-of-a-chain
  (doseq [inner ["Board" "Frame 3" "Board 12"]]
    (let [page (apply build (concat (for [_ (range 5)] (fr "Board" 800 600))
                                    [(fr "Login" 800 600 (fr inner 800 600))]))
          auto (select page {})]
      (t/is (= (concat (take 5 (named page "Board")) (named page "Login"))
               (filter (set (:ids auto)) (concat (take 5 (named page "Board")) (named page "Login"))))
            inner)
      (t/is (= (concat (level-1 page)) (:ids auto)) (str "Login stays over " inner))
      (t/is (= 1 (get-in auto [:selection :nested-same-size]))))))

(t/deftest sibling-frames-of-one-name-fall-back-to-the-top-of-the-chain
  (let [page (apply build (concat (for [_ (range 4)] (fr "Screen" 800 600))
                                  [(fr "Gallery" 800 600 (fr "Screen" 800 600) (fr "Screen" 800 600))]))
        auto (select page {})]
    (t/is (= (level-1 page) (:ids auto)) "4 Screen frames and Gallery")
    (t/is (= 5 (count (:ids auto))))
    (t/is (= 1 (get-in auto [:selection :nested-same-size])))))

(t/deftest a-regex-matching-two-sibling-frames-keeps-the-top-for-the-name-filter
  (let [page (apply build (concat (for [_ (range 4)] (fr "Screen" 800 600))
                                  [(fr "Gallery" 800 600 (fr "Screen" 800 600) (fr "Screen" 800 600))]))
        auto (select page {:mode :auto :name-match (matcher #"^Screen$")})]
    (t/is (= (take 4 (level-1 page)) (:ids auto))
          "Gallery stays in the chain and the name filter removes it")))
