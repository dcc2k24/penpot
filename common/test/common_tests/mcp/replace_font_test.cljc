;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns common-tests.mcp.replace-font-test
  "The `replace_font` op: the pure helpers (faces, variant choice, skips,
  content rewrite) and the op through `compile-operations`."
  (:require
   [app.common.files.validate :as cfv]
   [app.common.fonts.builtin :as builtin]
   [app.common.fonts.variants :as fv]
   [app.common.mcp.operations :as mops]
   [app.common.mcp.operations.replace-font :as rf]
   [app.common.test-helpers.compositions :as tho]
   [app.common.test-helpers.files :as thf]
   [app.common.test-helpers.ids-map :as thi]
   [app.common.test-helpers.shapes :as ths]
   [app.common.time :as ct]
   [app.common.types.pages-list :as ctpl]
   [app.common.types.text :as txt]
   [app.common.uuid :as uuid]
   [clojure.test :as t]))

(t/use-fixtures :each thi/test-fixture)

;; ----- Fonts

(def ^:private access-sans
  "The reported case: a team font that holds only the bold face."
  {:family "Access Sans"
   :variants [{:id "normal-700" :weight "700" :style "normal"}]})

(def ^:private team-full
  {:family "Team Full"
   :variants [{:id "normal-400" :weight "400" :style "normal"}
              {:id "italic-400" :weight "400" :style "italic"}
              {:id "normal-700" :weight "700" :style "normal"}]})

(def ^:private source-sans
  {:family "sourcesanspro" :variants (:variants (first builtin/local-fonts))})

(def ^:private gfont
  {:family "Roboto"
   :variants [{:id "regular" :weight "400" :style "normal"}
              {:id "italic" :weight "400" :style "italic"}
              {:id "700" :weight "700" :style "normal"}
              {:id "700italic" :weight "700" :style "italic"}]})

(def ^:private lookup
  {"custom-access" access-sans
   "custom-full" team-full
   "sourcesanspro" source-sans
   "gfont-roboto" gfont
   "gfont-off" {:reason "google-fonts-disabled"}})

;; ----- Helpers

(defn- page-id-of
  [file]
  (:id (thf/current-page file)))

(defn- shape-of
  [file id]
  (ths/get-shape-by-id file id))

(defn- compile-ops
  ([file operations]
   (compile-ops file operations lookup))
  ([file operations font-lookup]
   (mops/compile-operations (:data file) operations
                            {:new-id-fn uuid/next :font-lookup font-lookup})))

(defn- apply-ops
  [file operations]
  (let [result (compile-ops file operations)]
    [(thf/apply-changes file {:redo-changes (:changes result)}) result]))

(defn- thrown-data
  [f]
  (try
    (f)
    nil
    (catch #?(:clj Exception :cljs :default) e
      (or (ex-data e) {:message (ex-message e)}))))

(defn- replace-op
  [file & {:as params}]
  (merge {:op "replace_font" :page-id (page-id-of file)} params))

(defn- result-of
  [result]
  (first (:op-results result)))

(defn- leaf
  [text & {:as attrs}]
  (merge {:text text :font-size "20"} attrs))

(defn- paragraph
  [leaves & {:as attrs}]
  (merge {:type "paragraph" :children (vec leaves)} attrs))

(defn- content-of
  [paragraphs & {:as attrs}]
  (merge {:type "root"
          :children [{:type "paragraph-set" :children (vec paragraphs)}]}
         attrs))

(defn- roboto-leaf
  "A leaf on the Google font at `weight` and `style`."
  [text weight style]
  (leaf text
        :font-id "gfont-roboto"
        :font-family "Roboto"
        :font-variant-id (cond
                           (and (= "400" weight) (= "normal" style)) "regular"
                           (and (= "400" weight) (= "italic" style)) "italic"
                           (= "normal" style) weight
                           :else (str weight "italic"))
        :font-weight weight
        :font-style style))

(defn- one-leaf-content
  [text-leaf]
  (content-of [(paragraph [text-leaf])]))

(def ^:private position-data
  [{:x 0 :y 0 :width 50 :height 24 :fills [] :font-family "Roboto"
    :font-size "20" :font-weight "700" :font-style "normal" :text "Hi"}])

(defn- add-text
  [file label content & {:as attrs}]
  (apply ths/add-sample-shape file label
         (mapcat identity
                 (merge {:type :text :content content :grow-type :fixed
                         :x 0 :y 0 :width 200 :height 40 :name (name label)
                         :position-data position-data}
                        attrs))))

(defn- leaves-of
  [file id]
  (txt/node-seq txt/is-text-node? (:content (shape-of file id))))

(defn- font-ids
  [file id]
  (mapv :font-id (leaves-of file id)))

;; ----- closest-variant parity

(def ^:private sample-font-variants
  (:variants (first builtin/local-fonts)))

(t/deftest closest-variant-matches-the-workspace-rule
  (let [pick (fn [variants weight style]
               (let [v (fv/closest-variant variants weight style)]
                 [(:weight v) (:style v)]))
        v300 [{:id "200italic" :weight "200" :style "italic"}
              {:id "300" :weight "300" :style "normal"}
              {:id "300italic" :weight "300" :style "italic"}]]
    (t/testing "exact weight, no style asked"
      (t/is (= ["400" "normal"] (pick sample-font-variants "400" nil))))
    (t/testing "exact weight and style"
      (t/is (= ["400" "italic"] (pick sample-font-variants "400" "italic"))))
    (t/testing "between two weights, the higher one"
      (t/is (= "400" (first (pick sample-font-variants "350" nil)))))
    (t/testing "between two weights with a style, the style at the higher weight"
      (t/is (= ["400" "italic"] (pick sample-font-variants "350" "italic"))))
    (t/testing "below the lowest weight"
      (t/is (= "200" (first (pick sample-font-variants "0" nil)))))
    (t/testing "above the highest weight"
      (t/is (= "900" (first (pick sample-font-variants "1000" nil)))))
    (t/testing "the closest weight keeps its own style when the style is absent"
      (t/is (= ["200" "italic"] (pick v300 "200" nil))))
    (t/testing "the only face is always the answer"
      (t/is (= ["700" "normal"] (pick [{:id "normal-700" :weight "700" :style "normal"}] "400" "normal"))))
    (t/testing "a weight that is not a number, and no variants, give nil"
      (t/is (nil? (fv/closest-variant sample-font-variants "bold" nil)))
      (t/is (nil? (fv/closest-variant [] "400" nil))))
    (t/testing "a variant with no numeric weight is passed over"
      (t/is (= "300" (:weight (fv/closest-variant [{:id "x" :weight "heavy" :style "normal"}
                                                   {:id "300" :weight "300" :style "normal"}]
                                                  "400" nil)))))))

;; ----- Faces

(t/deftest variant-id-names-a-face
  (t/is (= ["400" "normal"] (rf/variant-id->face "regular")))
  (t/is (= ["400" "italic"] (rf/variant-id->face "italic")))
  (t/is (= ["700" "normal"] (rf/variant-id->face "700")))
  (t/is (= ["700" "italic"] (rf/variant-id->face "700italic")))
  (t/is (= ["700" "normal"] (rf/variant-id->face "normal-700")))
  (t/is (= ["400" "italic"] (rf/variant-id->face "italic-400")))
  (t/is (= ["700" "normal"] (rf/variant-id->face "bold")))
  (t/is (= ["900" "italic"] (rf/variant-id->face "blackitalic")))
  (t/is (nil? (rf/variant-id->face "mystery")))
  (t/is (nil? (rf/variant-id->face nil))))

(t/deftest node-face-reads-weight-style-and-variant
  (t/testing "weight and style as strings, or a number"
    (t/is (= ["700" "italic"] (rf/node-face {:font-weight "700" :font-style "italic"})))
    (t/is (= ["700" "normal"] (rf/node-face {:font-weight 700}))))
  (t/testing "a run with only a variant id"
    (t/is (= ["700" "italic"] (rf/node-face {:font-variant-id "700italic"})))
    (t/is (= ["700" "normal"] (rf/node-face {:font-variant-id "normal-700"}))))
  (t/testing "the weight attr wins over the variant id"
    (t/is (= ["600" "normal"] (rf/node-face {:font-weight "600" :font-variant-id "700"}))))
  (t/testing "nothing at all is 400 normal"
    (t/is (= ["400" "normal"] (rf/node-face {})))))

;; ----- Which nodes use the font

(t/deftest uses-font-by-node-kind
  (t/testing "a leaf that names the font"
    (t/is (true? (rf/uses-font? "gfont-roboto" {:text "a" :font-id "gfont-roboto"})))
    (t/is (false? (rf/uses-font? "gfont-roboto" {:text "a" :font-id "gfont-other"}))))
  (t/testing "a leaf with no font id uses the default font only"
    (t/is (true? (rf/uses-font? "sourcesanspro" {:text "a"})))
    (t/is (false? (rf/uses-font? "gfont-roboto" {:text "a"}))))
  (t/testing "a paragraph, a paragraph set and the root count by their own id"
    (t/is (true? (rf/uses-font? "gfont-roboto" {:type "paragraph" :font-id "gfont-roboto"})))
    (t/is (true? (rf/uses-font? "gfont-roboto" {:type "root" :font-id "gfont-roboto"})))
    (t/is (true? (rf/uses-font? "gfont-roboto" {:type "paragraph-set" :font-id "gfont-roboto"}))))
  (t/testing "a paragraph with no font id is no use of the default font"
    (t/is (false? (rf/uses-font? "sourcesanspro" {:type "paragraph"})))
    (t/is (false? (rf/uses-font? "sourcesanspro" {:type "root"})))))

(t/deftest scan-content-finds-faces-and-runs
  (let [content (content-of
                 [(paragraph [(roboto-leaf "Bold" "700" "normal")
                              (roboto-leaf "" "700" "normal")
                              (roboto-leaf "Reg" "400" "normal")
                              (leaf "Other" :font-id "gfont-other" :font-weight "300")])])
        found   (rf/scan-content "gfont-roboto" content)]
    (t/is (= #{["700" "normal"] ["400" "normal"]} (:faces found)))
    (t/testing "an empty leaf is no run"
      (t/is (= 2 (:runs found)))))
  (t/testing "no use gives nil"
    (t/is (nil? (rf/scan-content "gfont-roboto" (one-leaf-content (leaf "x" :font-id "gfont-other")))))
    (t/is (nil? (rf/scan-content "gfont-roboto" nil))))
  (t/testing "a paragraph that names no face asks for none"
    (let [content (content-of [(paragraph [(leaf "x" :font-id "gfont-other")] :font-id "gfont-roboto")])]
      (t/is (= #{} (:faces (rf/scan-content "gfont-roboto" content)))))))

;; ----- Variant choice

(t/deftest pick-variant-per-source
  (t/testing "bundled: the table ids"
    (t/is (= "bold" (-> (rf/pick-variant :exact (:variants source-sans) ["700" "normal"]) :variant :id)))
    (t/is (= "600italic" (-> (rf/pick-variant :exact (:variants source-sans) ["600" "italic"]) :variant :id)))
    (t/is (= "regular" (-> (rf/pick-variant :exact (:variants source-sans) ["400" "normal"]) :variant :id))))
  (t/testing "google: regular, italic, weight, weight and italic"
    (t/is (= "regular" (-> (rf/pick-variant :exact (:variants gfont) ["400" "normal"]) :variant :id)))
    (t/is (= "italic" (-> (rf/pick-variant :exact (:variants gfont) ["400" "italic"]) :variant :id)))
    (t/is (= "700italic" (-> (rf/pick-variant :exact (:variants gfont) ["700" "italic"]) :variant :id))))
  (t/testing "team: style-weight"
    (t/is (= "normal-700" (-> (rf/pick-variant :exact (:variants team-full) ["700" "normal"]) :variant :id)))
    (t/is (= "italic-400" (-> (rf/pick-variant :exact (:variants team-full) ["400" "italic"]) :variant :id))))
  (t/testing "exact marks the pick exact, and finds nothing for a gap"
    (t/is (true? (:exact (rf/pick-variant :exact (:variants team-full) ["400" "normal"]))))
    (t/is (nil? (rf/pick-variant :exact (:variants access-sans) ["400" "normal"]))))
  (t/testing "nearest takes the closest and says so"
    (let [pick (rf/pick-variant :nearest (:variants access-sans) ["400" "normal"])]
      (t/is (= "normal-700" (-> pick :variant :id)))
      (t/is (false? (:exact pick))))))

(t/deftest choose-variants-refuses-a-gap-in-exact-mode
  (let [data (thrown-data #(rf/choose-variants :exact "custom-access" (:variants access-sans)
                                               #{["400" "normal"] ["700" "normal"] ["600" "italic"]}))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/testing "the hint names each missing pair, the variants and the way out"
      (t/is (re-find #"400 normal, 600 italic" (:hint data)))
      (t/is (re-find #"normal-700" (:hint data)))
      (t/is (re-find #"nearest" (:hint data)))))
  (t/testing "nearest never refuses on a gap"
    (t/is (= "normal-700"
             (-> (rf/choose-variants :nearest "custom-access" (:variants access-sans) #{["400" "normal"]})
                 (get ["400" "normal"]) :variant :id)))))

;; ----- Content rewrite

(t/deftest rewrite-content-changes-only-the-runs-on-the-source-font
  (let [other    (leaf "Other" :font-id "gfont-other" :font-family "Other" :font-weight "300"
                       :font-variant-id "300" :font-style "normal")
        content  (content-of [(paragraph [(roboto-leaf "Bold" "700" "normal") other])])
        picks    (rf/choose-variants :exact "custom-access" (:variants access-sans) #{["700" "normal"]})
        content' (rf/rewrite-content content "gfont-roboto" "custom-access" "Access Sans" picks)
        [a b]    (txt/node-seq txt/is-text-node? content')]
    (t/is (= "custom-access" (:font-id a)))
    (t/is (= "Access Sans" (:font-family a)))
    (t/is (= "normal-700" (:font-variant-id a)))
    (t/is (= "700" (:font-weight a)))
    (t/is (= "normal" (:font-style a)))
    (t/testing "size and text stay"
      (t/is (= "20" (:font-size a)))
      (t/is (= "Bold" (:text a))))
    (t/testing "the other run is byte-identical"
      (t/is (= other b)))))

(t/deftest rewrite-content-bundled-target-writes-the-family-not-the-name
  (let [content  (one-leaf-content (roboto-leaf "x" "700" "normal"))
        picks    (rf/choose-variants :exact "sourcesanspro" (:variants source-sans) #{["700" "normal"]})
        content' (rf/rewrite-content content "gfont-roboto" "sourcesanspro" "sourcesanspro" picks)
        node     (first (txt/node-seq txt/is-text-node? content'))]
    (t/is (= "sourcesanspro" (:font-family node)))
    (t/is (= "bold" (:font-variant-id node)))))

(t/deftest rewrite-content-handles-each-node-level
  (let [content  {:type "root"
                  :font-id "gfont-roboto"
                  :children [{:type "paragraph-set"
                              :children [{:type "paragraph"
                                          :font-id "gfont-roboto"
                                          :font-weight "700"
                                          :children [(roboto-leaf "x" "700" "normal")]}]}]}
        picks    (rf/choose-variants :exact "custom-access" (:variants access-sans) #{["700" "normal"]})
        content' (rf/rewrite-content content "gfont-roboto" "custom-access" "Access Sans" picks)
        para     (first (txt/node-seq txt/is-paragraph-node? content'))]
    (t/is (= "custom-access" (:font-id content')))
    (t/testing "a root that names no face gets no face"
      (t/is (not (contains? content' :font-variant-id))))
    (t/is (= "custom-access" (:font-id para)))
    (t/is (= "normal-700" (:font-variant-id para)))
    (t/is (= "custom-access" (:font-id (first (txt/node-seq txt/is-text-node? content')))))))

;; ----- The op

(t/deftest reported-case-bold-runs-move-to-a-team-font
  (let [content (content-of [(paragraph [(roboto-leaf "Hello " "700" "normal")
                                         (roboto-leaf "world" "700" "normal")])])
        file    (-> (thf/sample-file :file1)
                    (add-text :t1 content))
        [file' result] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                    :to-font-id "custom-access")])
        res     (result-of result)
        nodes   (leaves-of file' (thi/id :t1))]
    (t/is (= 1 (:texts-changed res)))
    (t/is (= 2 (:runs-changed res)))
    (t/is (every? #(= "custom-access" (:font-id %)) nodes))
    (t/is (every? #(= "Access Sans" (:font-family %)) nodes))
    (t/is (every? #(= "normal-700" (:font-variant-id %)) nodes))
    (t/is (every? #(= "700" (:font-weight %)) nodes))
    (t/is (every? #(= "normal" (:font-style %)) nodes))
    (t/is (= [(thi/id :t1)] (:changed-ids res)))
    (t/is (= [{:from {:weight "700" :style "normal"}
               :to {:variant-id "normal-700" :weight "700" :style "normal"}
               :exact true}]
             (:variants-used res)))
    (t/is (= "Access Sans" (:to-family res)))
    (t/is (true? (:snapshot-hint result)))))

(t/deftest mixed-runs-change-only-the-source-font
  (let [other   (leaf "Other" :font-id "gfont-other" :font-family "Other" :font-weight "300"
                      :font-variant-id "300" :font-style "normal")
        file    (-> (thf/sample-file :file1)
                    (add-text :t1 (content-of [(paragraph [(roboto-leaf "A" "700" "normal") other])])))
        [file' result] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                    :to-font-id "custom-access")])
        [a b]   (leaves-of file' (thi/id :t1))]
    (t/is (= 1 (:runs-changed (result-of result))))
    (t/is (= "custom-access" (:font-id a)))
    (t/is (= other b))))

(t/deftest a-leaf-with-no-font-id-is-the-default-font
  (let [file (-> (thf/sample-file :file1)
                 (add-text :t1 (one-leaf-content (leaf "plain")))
                 (add-text :t2 (one-leaf-content (leaf "other" :font-id "gfont-roboto"))))
        [file' result] (apply-ops file [(replace-op file :from-font-id "sourcesanspro"
                                                    :to-font-id "gfont-roboto"
                                                    :variant-match :exact)])
        node (first (leaves-of file' (thi/id :t1)))]
    (t/is (= 1 (:texts-changed (result-of result))))
    (t/is (= "gfont-roboto" (:font-id node)))
    (t/is (= "Roboto" (:font-family node)))
    (t/is (= "regular" (:font-variant-id node)))
    (t/testing "a leaf with no font id is not the source when the source is another font"
      (let [[_ result] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                    :to-font-id "custom-full")])]
        (t/is (= 1 (:texts-changed (result-of result))))))))

(t/deftest root-paragraph-and-leaf-font-ids-all-change
  (let [content {:type "root"
                 :font-id "gfont-roboto"
                 :children [{:type "paragraph-set"
                             :children [{:type "paragraph"
                                         :font-id "gfont-roboto"
                                         :font-weight "400"
                                         :children [(roboto-leaf "x" "400" "normal")]}]}]}
        file    (-> (thf/sample-file :file1) (add-text :t1 content))
        [file' _] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                               :to-font-id "custom-full")])
        c       (:content (shape-of file' (thi/id :t1)))
        para    (first (txt/node-seq txt/is-paragraph-node? c))]
    (t/is (= "custom-full" (:font-id c)))
    (t/is (= "custom-full" (:font-id para)))
    (t/is (= "normal-400" (:font-variant-id para)))
    (t/is (= "normal-400" (:font-variant-id (first (leaves-of file' (thi/id :t1))))))))

(t/deftest exact-mode-refuses-a-missing-face-and-writes-nothing
  (let [file (-> (thf/sample-file :file1)
                 (add-text :t1 (one-leaf-content (roboto-leaf "x" "700" "normal")))
                 (add-text :t2 (one-leaf-content (roboto-leaf "y" "400" "italic"))))
        data (thrown-data #(compile-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                          :to-font-id "custom-access")]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"400 italic" (:hint data)))
    (t/is (not (re-find #"700 normal," (:hint data))))))

(t/deftest nearest-mode-takes-the-closest-face
  (let [file (-> (thf/sample-file :file1)
                 (add-text :t1 (one-leaf-content (roboto-leaf "x" "400" "normal")))
                 (add-text :t2 (one-leaf-content (roboto-leaf "y" "700" "italic"))))
        [file' result] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                    :to-font-id "custom-access"
                                                    :variant-match :nearest)])
        res   (result-of result)]
    (t/is (= "normal-700" (:font-variant-id (first (leaves-of file' (thi/id :t1))))))
    (t/is (= "normal-700" (:font-variant-id (first (leaves-of file' (thi/id :t2))))))
    (t/testing "every non-exact pick shows in the reply"
      (t/is (= [{:weight "400" :style "normal" :exact false}
                {:weight "700" :style "italic" :exact false}]
               (mapv (fn [v] (assoc (:from v) :exact (:exact v)))
                     (sort-by #(get-in % [:from :weight]) (:variants-used res))))))))

(t/deftest the-font-weight-stays-when-the-target-has-it
  (let [file (-> (thf/sample-file :file1)
                 (add-text :t1 (one-leaf-content (roboto-leaf "x" "400" "italic"))))
        [file' _] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                               :to-font-id "custom-full")])
        node (first (leaves-of file' (thi/id :t1)))]
    (t/is (= "italic-400" (:font-variant-id node)))
    (t/is (= "400" (:font-weight node)))
    (t/is (= "italic" (:font-style node)))))

(t/deftest position-data-drops-only-on-changed-texts
  (let [file (-> (thf/sample-file :file1)
                 (add-text :t1 (one-leaf-content (roboto-leaf "x" "700" "normal")))
                 (add-text :t2 (one-leaf-content (leaf "y" :font-id "gfont-other")))
                 (add-text :t3 (one-leaf-content (roboto-leaf "z" "700" "normal")) :position-data nil)
                 (ths/add-sample-shape :r1 :type :rect :x 0 :y 0 :width 10 :height 10))
        before (into {} (map (juxt identity #(shape-of file (thi/id %)))) [:t2 :r1])
        [file' result] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                    :to-font-id "custom-access")])
        res    (result-of result)]
    (t/is (nil? (:position-data (shape-of file' (thi/id :t1)))))
    (t/is (nil? (:position-data (shape-of file' (thi/id :t3)))))
    (t/testing "only a text that had layout counts as dropped"
      (t/is (= 2 (:texts-changed res)))
      (t/is (= 1 (:layout-dropped res)))
      (t/is (= [(thi/id :t1)] (:layout-dropped-ids res))))
    (t/testing "shapes the op does not change are byte-identical"
      (t/is (= (:t2 before) (shape-of file' (thi/id :t2))))
      (t/is (= (:r1 before) (shape-of file' (thi/id :r1)))))
    (t/testing "the geometry of a changed text stays"
      (let [t1 (shape-of file (thi/id :t1))
            t1' (shape-of file' (thi/id :t1))]
        (t/is (= (select-keys t1 [:x :y :width :height :selrect :points :grow-type])
                 (select-keys t1' [:x :y :width :height :selrect :points :grow-type])))))
    (t/testing "one mod-obj per changed text, and nothing else"
      (t/is (= 2 (count (:changes result))))
      (t/is (every? #(= :mod-obj (:type %)) (:changes result)))
      (t/is (= #{(thi/id :t1) (thi/id :t3)} (set (map :id (:changes result)))))
      (t/is (every? (fn [change]
                      (every? #(contains? #{:content :position-data} (:attr %))
                              (:operations change)))
                    (:changes result))))))

(t/deftest root-ids-limit-the-scope
  (let [file (-> (thf/sample-file :file1)
                 (ths/add-sample-shape :board :type :frame :x 0 :y 0 :width 400 :height 400)
                 (add-text :inside (one-leaf-content (roboto-leaf "a" "700" "normal")) :parent-label :board)
                 (add-text :outside (one-leaf-content (roboto-leaf "b" "700" "normal"))))
        [file' result] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                    :to-font-id "custom-access"
                                                    :root-ids [(thi/id :board)])])]
    (t/is (= 1 (:texts-changed (result-of result))))
    (t/is (= ["custom-access"] (font-ids file' (thi/id :inside))))
    (t/is (= ["gfont-roboto"] (font-ids file' (thi/id :outside))))
    (t/testing "a root that is a text itself is walked"
      (let [[_ result] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                    :to-font-id "custom-access"
                                                    :root-ids [(thi/id :outside)])])]
        (t/is (= [(thi/id :outside)] (:changed-ids (result-of result))))))
    (t/testing "a root that is not on the page refuses the op"
      (let [data (thrown-data #(compile-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                              :to-font-id "custom-access"
                                                              :root-ids [(uuid/next)])]))]
        (t/is (= :mcp-unknown-id (:code data)))))))

(t/deftest max-texts-refuses-when-more-texts-match
  (let [file (reduce (fn [file n]
                       (add-text file (keyword (str "t" n))
                                 (one-leaf-content (roboto-leaf "x" "700" "normal"))))
                     (thf/sample-file :file1)
                     (range 5))
        op   (fn [& {:as params}]
               (replace-op file :from-font-id "gfont-roboto" :to-font-id "custom-access" params))
        data (thrown-data #(compile-ops file [(op :max-texts 2)]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"change 5 texts" (:hint data)))
    (t/is (re-find #"rootIds" (:hint data)))
    (t/testing "raising the limit lets it through"
      (t/is (= 5 (:texts-changed (result-of (compile-ops file [(op :max-texts 5)]))))))
    (t/testing "the bounds are checked by the schema"
      (t/is (= :mcp-invalid-operation (:code (thrown-data #(compile-ops file [(op :max-texts 0)])))))
      (t/is (= :mcp-invalid-operation (:code (thrown-data #(compile-ops file [(op :max-texts 2001)])))))
      (t/is (= 5 (:texts-changed (result-of (compile-ops file [(op :max-texts 2000)]))))))))

(t/deftest the-op-refuses-what-it-cannot-do
  (let [file (-> (thf/sample-file :file1)
                 (add-text :t1 (one-leaf-content (roboto-leaf "x" "700" "normal"))))
        run  (fn [& {:as params}]
               (thrown-data #(compile-ops file [(replace-op file params)])))]
    (t/testing "the same font"
      (t/is (= :mcp-invalid-operation
               (:code (run :from-font-id "gfont-roboto" :to-font-id "gfont-roboto")))))
    (t/testing "a target the lookup does not know"
      (let [data (run :from-font-id "gfont-roboto" :to-font-id "custom-unknown")]
        (t/is (= :mcp-invalid-operation (:code data)))
        (t/is (re-find #"custom-unknown" (:hint data)))))
    (t/testing "a target with a reason, as a Google font with the flag off"
      (let [data (run :from-font-id "sourcesanspro" :to-font-id "gfont-off")]
        (t/is (re-find #"google-fonts-disabled" (:hint data)))))
    (t/testing "an unknown page"
      (let [data (thrown-data #(compile-ops file [{:op "replace_font" :page-id (uuid/next)
                                                   :from-font-id "gfont-roboto"
                                                   :to-font-id "custom-access"}]))]
        (t/is (= :mcp-unknown-id (:code data)))))
    (t/testing "a variantMatch that is neither exact nor nearest"
      (t/is (= :mcp-invalid-operation
               (:code (run :from-font-id "gfont-roboto" :to-font-id "custom-full"
                           :variant-match "closest")))))
    (t/testing "a missing target"
      (t/is (= :mcp-invalid-operation
               (:code (thrown-data #(compile-ops file [{:op "replace_font" :page-id (page-id-of file)
                                                        :from-font-id "gfont-roboto"}]))))))
    (t/testing "a compile with no font lookup"
      (let [data (thrown-data #(compile-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                              :to-font-id "custom-full")]
                                            nil))]
        (t/is (= :mcp-invalid-operation (:code data)))))))

(t/deftest no-match-is-not-an-error
  (let [file (-> (thf/sample-file :file1)
                 (add-text :t1 (one-leaf-content (leaf "x" :font-id "gfont-other"))))
        result (compile-ops file [(replace-op file :from-font-id "gfont-roboto"
                                              :to-font-id "custom-full")])
        res    (result-of result)]
    (t/is (empty? (:changes result)))
    (t/is (= 0 (:texts-changed res)))
    (t/is (= 0 (:texts-matched res)))
    (t/is (= 1 (:texts-scanned res)))
    (t/is (= 0 (get-in res [:skipped :total])))
    (t/is (false? (:snapshot-hint result)))))

;; ----- Skips

(t/deftest skip-reasons
  (let [typography-id (uuid/next)
        file (-> (thf/sample-file :file1)
                 (add-text :typo (one-leaf-content (roboto-leaf "t" "700" "normal")))
                 (add-text :family (one-leaf-content (roboto-leaf "f" "700" "normal"))
                           :applied-tokens {:font-family "brand"})
                 (add-text :weight (one-leaf-content (roboto-leaf "w" "700" "normal"))
                           :applied-tokens {:font-weight "bold"})
                 (add-text :style (one-leaf-content (roboto-leaf "s" "700" "normal"))
                           :applied-tokens {:typography "body"})
                 (add-text :plain (one-leaf-content (roboto-leaf "p" "700" "normal")))
                 (ths/update-shape-text :typo :typography-ref-id typography-id))
        before (into {} (map (fn [k] [k (shape-of file (thi/id k))])) [:typo :family :weight :style])
        [file' result] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                    :to-font-id "custom-access")])
        res    (result-of result)
        skips  (into {} (map (juxt :id identity)) (get-in res [:skipped :items]))]
    (t/is (= 5 (:texts-matched res)))
    (t/is (= 1 (:texts-changed res)))
    (t/is (= [(thi/id :plain)] (:changed-ids res)))
    (t/is (= 4 (get-in res [:skipped :total])))
    (t/is (= [{:reason "typography-ref" :count 1} {:reason "font-token" :count 3}]
             (get-in res [:skipped :by-reason])))
    (t/is (= "typography-ref" (:reason (get skips (thi/id :typo)))))
    (t/is (= typography-id (get-in skips [(thi/id :typo) :detail :typography-id])))
    (t/is (= {:tokens ["font-family"]} (:detail (get skips (thi/id :family)))))
    (t/is (= {:tokens ["font-weight"]} (:detail (get skips (thi/id :weight)))))
    (t/is (= {:tokens ["typography"]} (:detail (get skips (thi/id :style)))))
    (t/testing "a skipped text is byte-identical, tokens included"
      (doseq [k [:typo :family :weight :style]]
        (t/is (= (get before k) (shape-of file' (thi/id k))))))))

(t/deftest the-skipped-text-does-not-count-toward-max-texts
  (let [file (-> (thf/sample-file :file1)
                 (add-text :a (one-leaf-content (roboto-leaf "a" "700" "normal")) :applied-tokens {:font-family "x"})
                 (add-text :b (one-leaf-content (roboto-leaf "b" "700" "normal"))))
        result (compile-ops file [(replace-op file :from-font-id "gfont-roboto"
                                              :to-font-id "custom-access" :max-texts 1)])]
    (t/is (= 1 (:texts-changed (result-of result))))))

(defn- text-copy-file
  "A main with one text, and a copy of it. Returns the file, with labels
  `:root1` (main), `:child1` (main text) and `:copy1` (copy)."
  []
  (-> (thf/sample-file :file1)
      (tho/add-simple-component-with-copy
       :comp1 :root1 :child1 :copy1
       :main-child-params {:type :text :grow-type :fixed :x 0 :y 0 :width 100 :height 20
                           :name "label" :position-data position-data
                           :content (one-leaf-content (roboto-leaf "Hi" "700" "normal"))})))

(defn- copy-text-id
  [file]
  (first (:shapes (shape-of file (thi/id :copy1)))))

(t/deftest a-main-text-changes-and-its-copy-is-left-alone
  (let [file    (text-copy-file)
        copy-id (copy-text-id file)
        comp-id (:component-id (shape-of file (thi/id :root1)))
        copy-before (shape-of file copy-id)
        [file' result] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                    :to-font-id "custom-access")])
        res     (result-of result)]
    (t/is (some? (:shape-ref copy-before)))
    (t/is (= ["custom-access"] (font-ids file' (thi/id :child1))))
    (t/is (= [(thi/id :child1)] (:changed-ids res)))
    (t/is (= [comp-id] (:mains-changed res)))
    (t/testing "the copy is skipped, named, and not written or marked overridden"
      (t/is (= 1 (get-in res [:skipped :total])))
      (let [item (first (get-in res [:skipped :items]))]
        (t/is (= copy-id (:id item)))
        (t/is (= "component-copy" (:reason item)))
        (t/is (= comp-id (get-in item [:detail :component-id])))
        (t/is (true? (get-in item [:detail :main-in-this-file]))))
      (t/is (= copy-before (shape-of file' copy-id)))
      (t/is (nil? (:touched (shape-of file' copy-id)))))
    (t/testing "sync_components in the same call carries the change to the copy"
      (let [[file'' _] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                    :to-font-id "custom-access")
                                        {:op "sync_components"}])
            node (first (leaves-of file'' copy-id))]
        (t/is (= "custom-access" (:font-id node)))
        (t/is (= "normal-700" (:font-variant-id node)))))))

(t/deftest sync-keeps-the-font-a-user-set-on-a-copy
  (let [file    (text-copy-file)
        copy-id (copy-text-id file)
        file    (update file :data
                        (fn [data]
                          (ctpl/update-page data (page-id-of file)
                                            #(update-in % [:objects copy-id] assoc
                                                        :touched #{:content-group :text-content-attribute}))))
        [file' _] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                               :to-font-id "custom-access")
                                   {:op "sync_components"}])]
    (t/is (= ["custom-access"] (font-ids file' (thi/id :child1))))
    (t/is (= ["gfont-roboto"] (font-ids file' copy-id)))))

(t/deftest a-copy-alone-is-skipped-with-its-component-in-the-detail
  (let [file    (text-copy-file)
        copy-id (copy-text-id file)
        result  (compile-ops file [(replace-op file :from-font-id "gfont-roboto"
                                               :to-font-id "custom-access"
                                               :root-ids [(thi/id :copy1)])])
        res     (result-of result)]
    (t/is (empty? (:changes result)))
    (t/is (= 0 (:texts-changed res)))
    (t/is (= [] (:mains-changed res)))
    (t/is (= [copy-id] (mapv :id (get-in res [:skipped :items]))))))

;; ----- The result

(t/deftest op-results-line-up-with-the-ops
  (let [file (-> (thf/sample-file :file1)
                 (add-text :t1 (one-leaf-content (roboto-leaf "x" "700" "normal")))
                 (ths/add-sample-shape :r1 :type :rect :x 0 :y 0 :width 10 :height 10))
        result (compile-ops file [{:op "update_shape" :page-id (page-id-of file) :id (thi/id :r1)
                                   :props {:opacity 0.5}}
                                  (replace-op file :from-font-id "gfont-roboto"
                                              :to-font-id "custom-access")])]
    (t/is (= 2 (count (:op-results result))))
    (t/is (nil? (first (:op-results result))))
    (t/is (= "replace_font" (:op (second (:op-results result)))))
    (t/is (= (count (:op-ranges result)) (count (:op-results result))))))

(t/deftest the-reply-lists-are-capped
  (let [file   (reduce (fn [file n]
                         (add-text file (keyword (str "t" n))
                                   (one-leaf-content (roboto-leaf "x" "700" "normal"))))
                       (thf/sample-file :file1)
                       (range 120))
        res    (result-of (compile-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                         :to-font-id "custom-access")]))]
    (t/is (= 120 (:texts-changed res)))
    (t/is (= 100 (count (:changed-ids res))))
    (t/is (true? (:changed-ids-truncated res)))
    (t/is (= 120 (:layout-dropped res)))
    (t/is (= 100 (count (:layout-dropped-ids res))))
    (t/is (true? (:layout-dropped-ids-truncated res)))))

(t/deftest other-ops-take-no-snapshot-hint
  (let [file (-> (thf/sample-file :file1)
                 (ths/add-sample-shape :r1 :type :rect :x 0 :y 0 :width 10 :height 10))
        result (compile-ops file [{:op "update_shape" :page-id (page-id-of file) :id (thi/id :r1)
                                   :props {:opacity 0.5}}])]
    (t/is (false? (:snapshot-hint result)))
    (t/is (= [nil] (:op-results result)))))

(t/deftest the-op-is-in-the-op-table
  (t/is (contains? mops/schema-op-names "replace_font"))
  (t/is (some #{"replace_font"} mops/operation-names)))

;; ----- Review fixes

(defn- override-copy-text
  "`file` with the text of the copy `copy-id` marked as the editor marks a
  text whose style a user changed (`:text-content-attribute`), and `attrs`
  merged into each of its leaves."
  [file copy-id attrs]
  (update file :data
          (fn [data]
            (ctpl/update-page data (page-id-of file)
                              (fn [page]
                                (update-in page [:objects copy-id]
                                           (fn [shape]
                                             (-> shape
                                                 (assoc :touched #{:content-group :text-content-attribute})
                                                 (update :content
                                                         #(txt/transform-nodes txt/is-text-node?
                                                                               (fn [node] (merge node attrs))
                                                                               %))))))))))

(t/deftest sync-keeps-the-old-font-on-a-copy-with-any-text-override
  (let [file    (text-copy-file)
        copy-id (copy-text-id file)
        file    (override-copy-text file copy-id {:fills [{:fill-color "#ff0000" :fill-opacity 1}]})
        [file' result] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                    :to-font-id "custom-access")
                                        {:op "sync_components"}])
        node    (first (leaves-of file' copy-id))]
    (t/is (= ["custom-access"] (font-ids file' (thi/id :child1))))
    (t/testing "a copy with only a colour override keeps the old font after the sync"
      (t/is (= "gfont-roboto" (:font-id node)))
      (t/is (= [{:fill-color "#ff0000" :fill-opacity 1}] (:fills node))))
    (t/testing "the op reports the copy as skipped, as it can not write it"
      (t/is (= ["component-copy"] (mapv :reason (get-in (result-of result) [:skipped :items])))))))

(t/deftest the-op-stamps-the-component-of-a-changed-main
  (let [file     (text-copy-file)
        comp-id  (:component-id (shape-of file (thi/id :root1)))
        before   (ct/inst 1000)
        file     (assoc-in file [:data :components comp-id :modified-at] before)
        result   (compile-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                :to-font-id "custom-access")])
        file'    (thf/apply-changes file {:redo-changes (:changes result)})
        after    (get-in file' [:data :components comp-id :modified-at])]
    (t/is (= [comp-id] (:mains-changed (result-of result))))
    (t/is (= 1 (count (filter #(= :mod-component (:type %)) (:changes result)))))
    (t/is (some? after))
    (t/is (ct/is-after? after before))
    (t/testing "the file is still valid"
      (t/is (empty? (cfv/validate-file file' {}))))
    (t/testing "a call that changes no main emits no change"
      (let [result (compile-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                  :to-font-id "custom-access"
                                                  :root-ids [(thi/id :copy1)])])]
        (t/is (empty? (:changes result)))))
    (t/testing "a text outside any main emits no component change"
      (let [file   (-> (thf/sample-file :file1)
                       (add-text :t1 (one-leaf-content (roboto-leaf "x" "700" "normal"))))
            result (compile-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                  :to-font-id "custom-access")])]
        (t/is (every? #(= :mod-obj (:type %)) (:changes result)))))))

(t/deftest a-copy-nested-in-a-main-is-skipped-and-not-written
  (let [file    (-> (thf/sample-file :file1)
                    (tho/add-nested-component
                     :comp1 :main1 :child1
                     :comp2 :main2 :nested
                     :main1-child-params {:type :text :grow-type :fixed :x 0 :y 0 :width 100 :height 20
                                          :name "label" :position-data position-data
                                          :content (one-leaf-content (roboto-leaf "Hi" "700" "normal"))}))
        nested-text (first (:shapes (shape-of file (thi/id :nested))))
        before  (shape-of file nested-text)
        comp1   (:component-id (shape-of file (thi/id :main1)))
        [file' result] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                    :to-font-id "custom-access")])
        res     (result-of result)]
    (t/is (some? (:shape-ref before)))
    (t/is (= [(thi/id :child1)] (:changed-ids res)))
    (t/is (= [comp1] (:mains-changed res)))
    (t/is (= [nested-text] (mapv :id (get-in res [:skipped :items]))))
    (t/is (= "component-copy" (:reason (first (get-in res [:skipped :items])))))
    (t/is (= before (shape-of file' nested-text)))
    (t/is (empty? (cfv/validate-file file' {})))))

(t/deftest a-refusal-in-a-call-with-several-operations-writes-nothing
  (let [file (-> (thf/sample-file :file1)
                 (add-text :t1 (one-leaf-content (roboto-leaf "x" "700" "normal")))
                 (add-text :t2 (one-leaf-content (leaf "y" :font-id "gfont-other" :font-weight "300"))))
        ops  [(replace-op file :from-font-id "gfont-roboto" :to-font-id "custom-access")
              (replace-op file :from-font-id "gfont-other" :to-font-id "custom-access")]
        data (thrown-data #(compile-ops file ops))]
    (t/testing "the first op alone is fine"
      (t/is (= 1 (:texts-changed (result-of (compile-ops file (subvec ops 0 1)))))))
    (t/testing "the second refuses, naming itself, and the call returns no changes"
      (t/is (= :mcp-invalid-operation (:code data)))
      (t/is (= 1 (:index data)))
      (t/is (re-find #"300 normal" (:hint data))))))

;; Faces that nodes inherit

(defn- faces-of
  [font-id content]
  (:faces (rf/scan-content font-id content)))

(defn- set-of
  "A content whose paragraph set holds `paragraphs`, with `root-attrs` on the
  root and `set-attrs` on the set."
  [root-attrs set-attrs paragraphs]
  (merge {:type "root"
          :children [(merge {:type "paragraph-set" :children (vec paragraphs)} set-attrs)]}
         root-attrs))

(t/deftest a-run-with-no-weight-keeps-the-weight-of-its-paragraph
  (let [content (content-of [(paragraph [(leaf "Hi" :font-id "gfont-roboto" :font-family "Roboto")]
                                        :font-id "gfont-roboto" :font-weight "700")])
        file    (-> (thf/sample-file :file1) (add-text :t1 content))
        [file' result] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                    :to-font-id "custom-full")])
        c       (:content (shape-of file' (thi/id :t1)))
        node    (first (txt/node-seq txt/is-text-node? c))
        para    (first (txt/node-seq txt/is-paragraph-node? c))]
    (t/is (= "normal-700" (:font-variant-id node)))
    (t/is (= "700" (:font-weight node)))
    (t/is (= "normal-700" (:font-variant-id para)))
    (t/is (= 1 (count (:variants-used (result-of result)))))))

(t/deftest a-run-that-names-its-weight-wins-over-its-paragraph
  (let [content (content-of [(paragraph [(leaf "Hi" :font-id "gfont-roboto" :font-family "Roboto"
                                               :font-weight "400")]
                                        :font-id "gfont-roboto" :font-weight "700")])
        file    (-> (thf/sample-file :file1) (add-text :t1 content))
        [file' _] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                               :to-font-id "custom-full")])
        c       (:content (shape-of file' (thi/id :t1)))]
    (t/is (= "normal-400" (:font-variant-id (first (txt/node-seq txt/is-text-node? c)))))
    (t/is (= "normal-700" (:font-variant-id (first (txt/node-seq txt/is-paragraph-node? c)))))))

(t/deftest a-run-takes-a-missing-weight-from-its-paragraph-only
  (let [leaf* (leaf "Hi" :font-id "gfont-roboto")]
    (t/testing "the paragraph gives it"
      (t/is (= #{["300" "normal"]}
               (faces-of "gfont-roboto" (set-of {:font-weight "700"} {:font-weight "400"}
                                                [(paragraph [leaf*] :font-weight "300")])))))
    (t/testing "the root does not give it: the run is 400"
      (t/is (= #{["400" "normal"]}
               (faces-of "gfont-roboto" (set-of {:font-weight "700"} nil [(paragraph [leaf*])])))))
    (t/testing "the paragraph set does not give it either"
      (t/is (= #{["400" "normal"]}
               (faces-of "gfont-roboto" (set-of nil {:font-weight "700"} [(paragraph [leaf*])])))))
    (t/testing "nor do the root and the set, against the variant id of the run"
      (t/is (= #{["400" "normal"]}
               (faces-of "gfont-roboto"
                         (set-of {:font-weight "700"} {:font-weight "700"}
                                 [(paragraph [(assoc leaf* :font-variant-id "regular")])])))))
    (t/testing "a paragraph weight wins over the variant id of the run"
      (t/is (= #{["700" "normal"]}
               (faces-of "gfont-roboto"
                         (content-of [(paragraph [(assoc leaf* :font-variant-id "regular")]
                                                 :font-weight "700")])))))
    (t/testing "a run that names nothing, under nothing, is 400 normal"
      (t/is (= #{["400" "normal"]} (faces-of "gfont-roboto" (content-of [(paragraph [leaf*])])))))))

(t/deftest a-root-weight-does-not-turn-a-run-bold
  (let [content (set-of {:font-weight "700"} nil
                        [(paragraph [(leaf "Hi" :font-id "gfont-roboto" :font-family "Roboto")])])
        file    (-> (thf/sample-file :file1) (add-text :t1 content))
        [file' _] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                               :to-font-id "custom-full")])
        c       (:content (shape-of file' (thi/id :t1)))
        node    (first (txt/node-seq txt/is-text-node? c))]
    (t/testing "the run was 400 before, and is written 400"
      (t/is (= "normal-400" (:font-variant-id node)))
      (t/is (= "400" (:font-weight node))))
    (t/testing "the root is not touched"
      (t/is (= "700" (:font-weight c)))
      (t/is (not (contains? c :font-id))))))

(t/deftest style-is-inherited-apart-from-weight
  (t/is (= #{["700" "italic"]}
           (faces-of "gfont-roboto"
                     (content-of [(paragraph [(leaf "x" :font-id "gfont-roboto" :font-weight "700")]
                                             :font-style "italic")]))))
  (t/is (= #{["700" "italic"]}
           (faces-of "gfont-roboto"
                     (content-of [(paragraph [(leaf "x" :font-id "gfont-roboto" :font-style "italic")]
                                             :font-weight "700")]))))
  (t/testing "the written face of such a run keeps both"
    (let [content  (content-of [(paragraph [(leaf "x" :font-id "gfont-roboto")]
                                           :font-weight "700" :font-style "italic")])
          picks    (rf/choose-variants :exact "gfont-roboto" (:variants gfont) #{["700" "italic"]})
          content' (rf/rewrite-content content "gfont-roboto" "gfont-roboto" "Roboto" picks)
          node     (first (txt/node-seq txt/is-text-node? content'))]
      (t/is (= "700italic" (:font-variant-id node)))
      (t/is (= "italic" (:font-style node))))))

;; Auto-sized texts

(t/deftest the-reply-counts-auto-sized-texts
  (let [file (-> (thf/sample-file :file1)
                 (add-text :w (one-leaf-content (roboto-leaf "w" "700" "normal")) :grow-type :auto-width)
                 (add-text :h (one-leaf-content (roboto-leaf "h" "700" "normal")) :grow-type :auto-height)
                 (add-text :f (one-leaf-content (roboto-leaf "f" "700" "normal")) :grow-type :fixed)
                 (add-text :other (one-leaf-content (leaf "o" :font-id "gfont-other")) :grow-type :auto-width))
        res  (result-of (compile-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                       :to-font-id "custom-access")]))]
    (t/is (= 3 (:texts-changed res)))
    (t/is (= 2 (:auto-size-texts res)))
    (t/is (= #{(thi/id :w) (thi/id :h)} (set (:auto-size-ids res))))
    (t/is (false? (:auto-size-ids-truncated res)))))

;; Word weights

(t/deftest word-weights-count-as-the-numbers-the-renderer-gives
  (t/is (= ["700" "normal"] (rf/node-face {:font-weight "bold"})))
  (t/testing "the words are case-sensitive, as in the renderer: `Bold` reads as 400"
    (t/is (= ["400" "normal"] (rf/node-face {:font-weight "Bold"}))))
  (t/testing "a variant id that names a face wins over a word weight"
    (t/is (= ["400" "normal"] (rf/node-face {:font-weight "bold" :font-variant-id "regular"})))
    (t/is (= ["700" "normal"] (rf/node-face {:font-weight "bold"})))
    (t/is (= ["400" "normal"] (rf/node-face {:font-weight "Bold" :font-variant-id "regular"})))
    (t/is (= ["400" "italic"] (rf/node-face {:font-weight "bold" :font-variant-id "italic"}))))
  (t/testing "a number is not given way to the variant id"
    (t/is (= ["700" "normal"] (rf/node-face {:font-weight "700" :font-variant-id "regular"}))))
  (t/testing "a word of a paragraph gives way to the variant id of the run too"
    (t/is (= ["400" "normal"] (rf/node-face {:font-variant-id "regular"} {:weight "bold"})))
    (t/is (= ["700" "normal"] (rf/node-face {} {:weight "bold"}))))
  (t/testing "semibold and extrabold are not mapped: the op refuses them as a missing face"
    (t/is (= ["semibold" "normal"] (rf/node-face {:font-weight "semibold"}))))
  (t/is (= ["400" "normal"] (rf/node-face {:font-weight "normal"})))
  (t/is (= ["300" "normal"] (rf/node-face {:font-weight "light"})))
  (t/is (= ["900" "normal"] (rf/node-face {:font-weight "black"})))
  (let [file (-> (thf/sample-file :file1)
                 (add-text :t1 (one-leaf-content (leaf "x" :font-id "gfont-roboto" :font-family "Roboto"
                                                       :font-weight "bold" :font-style "normal"))))
        [file' result] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                    :to-font-id "custom-full")])
        node (first (leaves-of file' (thi/id :t1)))]
    (t/testing "exact mode finds the 700 face for a run with `bold`"
      (t/is (= "normal-700" (:font-variant-id node)))
      (t/is (= "700" (:font-weight node)))
      (t/is (= [{:from {:weight "700" :style "normal"}
                 :to {:variant-id "normal-700" :weight "700" :style "normal"}
                 :exact true}]
               (:variants-used (result-of result)))))))

(t/deftest the-main-cases-leave-a-valid-file
  (let [file (text-copy-file)
        [file' _] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                               :to-font-id "custom-access")
                                   {:op "sync_components"}])]
    (t/is (empty? (cfv/validate-file file' {})))))

(t/deftest a-paragraph-that-names-only-a-style-gets-no-weight
  (let [content (content-of [(paragraph [(leaf "Hi" :font-id "gfont-roboto" :font-family "Roboto"
                                               :font-weight "400" :font-style "normal")]
                                        :font-id "gfont-roboto" :font-style "normal")])
        file    (-> (thf/sample-file :file1) (add-text :t1 content))
        [file' _] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                               :to-font-id "custom-full")])
        c       (:content (shape-of file' (thi/id :t1)))
        para    (first (txt/node-seq txt/is-paragraph-node? c))]
    (t/is (= "custom-full" (:font-id para)))
    (t/is (= "normal-400" (:font-variant-id para)))
    (t/is (= "normal" (:font-style para)))
    (t/is (not (contains? para :font-weight)))))

(t/deftest a-paragraph-keeps-its-weight-in-nearest-mode
  (let [other   (leaf "Other" :font-id "gfont-other" :font-family "Other")
        content (content-of [(paragraph [(leaf "Hi" :font-id "gfont-roboto" :font-family "Roboto")
                                         other]
                                        :font-id "gfont-roboto" :font-weight "300")])
        file    (-> (thf/sample-file :file1) (add-text :t1 content))
        [file' result] (apply-ops file [(replace-op file :from-font-id "gfont-roboto"
                                                    :to-font-id "custom-access"
                                                    :variant-match :nearest)])
        c       (:content (shape-of file' (thi/id :t1)))
        para    (first (txt/node-seq txt/is-paragraph-node? c))
        [run other'] (txt/node-seq txt/is-text-node? c)]
    (t/testing "the paragraph names 300 before and after, so the other font's run, with no weight, renders 300 both times"
      (t/is (= "300" (:font-weight para)))
      (t/is (= other other')))
    (t/testing "the paragraph gets the variant of its font, the run gets the whole face"
      (t/is (= "normal-700" (:font-variant-id para)))
      (t/is (= ["normal-700" "700"] ((juxt :font-variant-id :font-weight) run))))
    (t/is (false? (:exact (first (:variants-used (result-of result))))))))
