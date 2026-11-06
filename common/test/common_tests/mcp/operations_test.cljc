;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns common-tests.mcp.operations-test
  (:require
   #?@(:clj [[app.common.files.changes :as cfc]
             [app.common.files.changes-builder :as pcb]
             [app.common.files.helpers :as cfh]
             [app.common.logic.modifiers :as lm]
             [app.common.logic.shapes :as cls]
             [app.common.types.component :as ctk]
             [app.common.types.pages-list :as ctpl]
             [app.common.types.shape :as cts]
             [app.common.types.shape-tree :as ctst]])
   [app.common.mcp.operations :as mops]
   [app.common.test-helpers.compositions :as tho]
   [app.common.test-helpers.files :as thf]
   [app.common.test-helpers.ids-map :as thi]
   [app.common.test-helpers.shapes :as ths]
   [app.common.test-helpers.tokens :as tht]
   [app.common.types.file :as ctf]
   [app.common.types.shape.layout :as ctl]
   [app.common.types.text :as txt]
   [app.common.types.tokens-lib :as ctob]
   [app.common.types.tokens-status :as ctos]
   [app.common.uuid :as uuid]
   [clojure.test :as t]))

(t/use-fixtures :each thi/test-fixture)

;; ----- Helpers

(def ^:private epsilon 1e-6)

(defn- close?
  [a b]
  (< (- (max a b) (min a b)) epsilon))

(defn- page-id-of
  [file]
  (:id (thf/current-page file)))

(defn- shape-of
  [file id]
  (ths/get-shape-by-id file id))

(defn- visual-children
  "The children of the flex layout `id` in visual order, which is the reverse
  of their `:shapes` order."
  [file id]
  (vec (reverse (:shapes (shape-of file id)))))

(defn- created
  [result handle]
  (get (:created-ids result) handle))

(defn- compile-ops
  [file operations]
  (mops/compile-operations (:data file) operations {:new-id-fn uuid/next}))

(defn- apply-ops
  "Compiles `operations` against `file` and applies the changes. Returns the
  updated file and the compile result."
  [file operations]
  (let [result (compile-ops file operations)]
    [(thf/apply-changes file {:redo-changes (:changes result)}) result]))

(defn- thrown-data
  "Returns the ex-data of the error that `f` throws, or nil."
  [f]
  (try
    (f)
    nil
    (catch #?(:clj Exception :cljs :default) e
      (or (ex-data e) {:message (ex-message e)}))))

(defn- find-shape
  [file pred]
  (first (filter pred (vals (:objects (thf/current-page file))))))

(defn- assert-box
  "Checks the position and size of `shape`, and that its selrect and points
  agree with them."
  [shape x y width height]
  (t/is (close? x (:x shape)))
  (t/is (close? y (:y shape)))
  (t/is (close? width (:width shape)))
  (t/is (close? height (:height shape)))
  (let [selrect (:selrect shape)]
    (t/is (close? x (:x selrect)))
    (t/is (close? y (:y selrect)))
    (t/is (close? (+ x width) (:x2 selrect)))
    (t/is (close? (+ y height) (:y2 selrect))))
  (let [points (:points shape)]
    (t/is (= 4 (count points)))
    (t/is (close? x (:x (nth points 0))))
    (t/is (close? y (:y (nth points 0))))
    (t/is (close? (+ x width) (:x (nth points 2))))
    (t/is (close? (+ y height) (:y (nth points 2))))))

(defn- two-rects-file
  "Two root rects: `:rect1` at 10,10 (20x20) and `:rect2` at 50,40 (30x10)."
  []
  (-> (thf/sample-file :file1)
      (ths/add-sample-shape :rect1 :x 10 :y 10 :width 20 :height 20)
      (ths/add-sample-shape :rect2 :x 50 :y 40 :width 30 :height 10)))

(defn- board-with-children-file
  "A board `:board1` with three rects `:rect1`, `:rect2` and `:rect3`."
  []
  (-> (thf/sample-file :file1)
      (tho/add-frame :board1 :x 0 :y 0 :width 300 :height 100)
      (ths/add-sample-shape :rect1 :parent-label :board1 :x 0 :y 0 :width 50 :height 20)
      (ths/add-sample-shape :rect2 :parent-label :board1 :x 0 :y 0 :width 30 :height 20)
      (ths/add-sample-shape :rect3 :parent-label :board1 :x 0 :y 0 :width 10 :height 10)))

(defn- stacked-board-file
  "A board `:board1` with two rects `:rect1` and `:rect2` stacked in a column,
  with constraints, so that a layout would place them."
  []
  (-> (thf/sample-file :file1)
      (tho/add-frame :board1 :x 0 :y 0 :width 300 :height 100)
      (ths/add-sample-shape :rect1 :parent-label :board1 :x 0 :y 0 :width 50 :height 20
                            :constraints-h :right :constraints-v :bottom)
      (ths/add-sample-shape :rect2 :parent-label :board1 :x 0 :y 35 :width 50 :height 20
                            :constraints-h :right :constraints-v :bottom)))

(defn- tokens-file
  "A file with the token sets `Core` (label :set-core) and `Base` (label :set-base)."
  []
  (tht/sample-file-with-tokens
   :lib-fn #(-> %
                (ctob/add-set (ctob/make-token-set :id (thi/new-id! :set-core) :name "Core"))
                (ctob/add-set (ctob/make-token-set :id (thi/new-id! :set-base) :name "Base")))))

(defn- brand-file
  "The tokens file with a color token `brand` in `Core`, and a rect `:rect1`."
  []
  (-> (tht/sample-file-with-tokens
       :lib-fn #(-> %
                    (ctob/add-set (ctob/make-token-set :id (thi/new-id! :set-core) :name "Core"))
                    (ctob/add-token (thi/id :set-core)
                                    (ctob/make-token :id (thi/new-id! :token-brand)
                                                     :name "brand"
                                                     :type :color
                                                     :value "#ff0000"))))
      (ths/add-sample-shape :rect1 :x 0 :y 0 :width 10 :height 10)))

(defn- theme-file
  "The tokens file with the theme `Light` (label :theme-light) in group `Mode`
  over the set `Core`. With `active?` the theme and the set are active."
  [& {:keys [active?]}]
  (tht/sample-file-with-tokens
   :lib-fn #(-> %
                (ctob/add-set (ctob/make-token-set :id (thi/new-id! :set-core) :name "Core"))
                (ctob/add-theme (ctob/make-token-theme :id (thi/new-id! :theme-light)
                                                       :group "Mode"
                                                       :name "Light"
                                                       :sets #{"Core"})))
   :status-fn #(cond-> %
                 active?
                 (ctos/set-tokens-status #{(thi/id :theme-light)} #{(thi/id :set-core)}))))

(def ^:private dtcg-core
  "{\"Core\": {\"gap\": {\"$type\": \"sizing\", \"$value\": 10}}}")

(def ^:private dtcg-metadata
  "A document with the sets Base and Core, the theme Mode/Light over Core, and
  $metadata that lists the set order, the active theme and the active set."
  "{\"Base\": {\"fg\": {\"$type\": \"color\", \"$value\": \"#000000\"}},
    \"Core\": {\"gap\": {\"$type\": \"sizing\", \"$value\": 10}},
    \"$themes\": [{\"name\": \"Light\", \"group\": \"Mode\", \"description\": \"\",
                  \"selectedTokenSets\": {\"Core\": \"enabled\"}}],
    \"$metadata\": {\"tokenSetOrder\": [\"Base\", \"Core\"],
                  \"activeThemes\": [\"Mode/Light\"],
                  \"activeSets\": [\"Core\"]}}")

(defn- file-with-token
  "The tokens file with a token `token-name` of `token-type` and `value` in the
  set `Core`. The token is made by an op, so that its type is the file's."
  [token-name token-type value]
  (let [[file _] (apply-ops (tokens-file)
                            [{:op "create_token" :set-id (thi/id :set-core)
                              :type token-type :name token-name :value value}])]
    file))

(defn- shape-with-token
  "Applies the token `token-name` to the shape `shape-id` of the page of `file`."
  [file shape-id token-name attributes resolved-value]
  (let [[file' _] (apply-ops file [{:op "apply_token" :page-id (page-id-of file)
                                    :shape-ids [shape-id] :token-name token-name
                                    :attributes attributes
                                    :resolved-value resolved-value}])]
    file'))

;; ----- Pages

(t/deftest create-page-with-handle-and-index
  (let [file    (thf/sample-file :file1 :page-label :page1)
        [file' result] (apply-ops file [{:op "create_page" :id "$tmp:p" :name "Second" :index 0}])
        page-id (created result "$tmp:p")
        data    (:data file')]
    (t/is (uuid? page-id))
    (t/is (= "Second" (get-in data [:pages-index page-id :name])))
    (t/is (= page-id (first (:pages data))))))

(t/deftest create-page-with-index-zero-goes-first
  (let [file (-> (thf/sample-file :file1 :page-label :page1)
                 (thf/add-sample-page :page2))
        [file' result] (apply-ops file [{:op "create_page" :id "$tmp:p" :name "First" :index 0}])
        page-id (created result "$tmp:p")]
    (t/is (= [page-id (thi/id :page1) (thi/id :page2)]
             (vec (:pages (:data file')))))))

(t/deftest update-page-renames
  (let [file    (thf/sample-file :file1 :page-label :page1)
        [file' _] (apply-ops file [{:op "update_page" :id (thi/id :page1) :name "Renamed"}])]
    (t/is (= "Renamed" (get-in (:data file') [:pages-index (thi/id :page1) :name])))))

(t/deftest move-page-changes-order
  (let [file (-> (thf/sample-file :file1 :page-label :page1)
                 (thf/add-sample-page :page2))
        [file' _] (apply-ops file [{:op "move_page" :id (thi/id :page1) :index 1}])]
    (t/is (= [(thi/id :page2) (thi/id :page1)] (vec (:pages (:data file')))))))

(t/deftest move-page-to-front
  (let [file (-> (thf/sample-file :file1 :page-label :page1)
                 (thf/add-sample-page :page2))
        [file' _] (apply-ops file [{:op "move_page" :id (thi/id :page2) :index 0}])]
    (t/is (= [(thi/id :page2) (thi/id :page1)] (vec (:pages (:data file')))))))

(t/deftest delete-page-removes-page
  (let [file (-> (thf/sample-file :file1 :page-label :page1)
                 (thf/add-sample-page :page2))
        [file' _] (apply-ops file [{:op "delete_page" :id (thi/id :page2)}])]
    (t/is (nil? (get-in (:data file') [:pages-index (thi/id :page2)])))
    (t/is (= [(thi/id :page1)] (vec (:pages (:data file')))))))

(t/deftest delete-page-refuses-the-last-page
  (let [file (thf/sample-file :file1 :page-label :page1)
        data (thrown-data #(compile-ops file [{:op "delete_page" :id (thi/id :page1)}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (= "cannot delete the last page" (:hint data)))))

(t/deftest delete-page-deletes-the-components-of-its-mains
  (let [file (-> (thf/sample-file :file1 :page-label :page1)
                 (thf/add-sample-page :page2)
                 (tho/add-simple-component :comp1 :root1 :child1))
        comp-id (thi/id :comp1)
        [file' _] (apply-ops file [{:op "delete_page" :id (thi/id :page2)}])]
    (t/is (nil? (get-in (:data file') [:pages-index (thi/id :page2)])))
    (t/is (true? (get-in (:data file') [:components comp-id :deleted])))))

;; ----- Create shapes

(t/deftest create-rect-basic
  (let [file   (thf/sample-file :file1)
        pid    (page-id-of file)
        [file' result] (apply-ops file [{:op "create_rect" :page-id pid :id "$tmp:r"
                                         :x 10 :y 20 :width 100 :height 50}])
        rect   (shape-of file' (created result "$tmp:r"))]
    (t/is (uuid? (created result "$tmp:r")))
    (t/is (= :rect (:type rect)))
    (t/is (= uuid/zero (:parent-id rect)))
    (t/is (= uuid/zero (:frame-id rect)))
    (assert-box rect 10 20 100 50)))

(t/deftest create-board-at-root
  (let [file   (thf/sample-file :file1)
        pid    (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 10 :y 20 :width 200 :height 100 :name "Hero"}])
        board  (shape-of file' (created result "$tmp:b"))]
    (t/is (= :frame (:type board)))
    (t/is (= "Hero" (:name board)))
    (t/is (= uuid/zero (:parent-id board)))
    (assert-box board 10 20 200 100)))

(t/deftest create-ellipse-is-circle
  (let [file   (thf/sample-file :file1)
        pid    (page-id-of file)
        [file' result] (apply-ops file [{:op "create_ellipse" :page-id pid :id "$tmp:e"
                                         :x 0 :y 0 :width 40 :height 40}])
        ellipse (shape-of file' (created result "$tmp:e"))]
    (t/is (= :circle (:type ellipse)))
    (assert-box ellipse 0 0 40 40)))

(t/deftest create-rect-in-board-with-index
  (let [file   (thf/sample-file :file1)
        pid    (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 0 :y 0 :width 300 :height 300}
                                        {:op "create_rect" :page-id pid :id "$tmp:r1"
                                         :parent-id "$tmp:b" :x 0 :y 0 :width 10 :height 10}
                                        {:op "create_rect" :page-id pid :id "$tmp:r2"
                                         :parent-id "$tmp:b" :index 0
                                         :x 20 :y 0 :width 10 :height 10}])
        board-id (created result "$tmp:b")
        r1-id    (created result "$tmp:r1")
        r2-id    (created result "$tmp:r2")
        board    (shape-of file' board-id)
        r1       (shape-of file' r1-id)]
    (t/is (= board-id (:parent-id r1)))
    (t/is (= board-id (:frame-id r1)))
    (t/is (= [r2-id r1-id] (vec (:shapes board))))))

(t/deftest create-children-of-flex-board-keep-creation-order
  (let [file   (thf/sample-file :file1)
        pid    (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 0 :y 0 :width 300 :height 300}
                                        {:op "set_flex_layout" :page-id pid :id "$tmp:b"}
                                        {:op "create_rect" :page-id pid :id "$tmp:r1"
                                         :parent-id "$tmp:b" :x 0 :y 0 :width 10 :height 10}
                                        {:op "create_rect" :page-id pid :id "$tmp:r2"
                                         :parent-id "$tmp:b" :x 0 :y 0 :width 10 :height 10}
                                        {:op "create_rect" :page-id pid :id "$tmp:r3"
                                         :parent-id "$tmp:b" :x 0 :y 0 :width 10 :height 10}])
        board-id (created result "$tmp:b")
        ids      (mapv #(created result %) ["$tmp:r1" "$tmp:r2" "$tmp:r3"])]
    ;; The default index puts each new child at the front of :shapes
    (t/is (= (vec (reverse ids)) (vec (:shapes (shape-of file' board-id)))))
    (t/is (= ids (visual-children file' board-id)))))

(t/deftest create-with-natural-index-in-flex-board
  (let [file   (thf/sample-file :file1)
        pid    (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 0 :y 0 :width 300 :height 300}
                                        {:op "set_flex_layout" :page-id pid :id "$tmp:b"}
                                        {:op "create_rect" :page-id pid :id "$tmp:r1"
                                         :parent-id "$tmp:b" :x 0 :y 0 :width 10 :height 10}
                                        {:op "create_rect" :page-id pid :id "$tmp:r2"
                                         :parent-id "$tmp:b" :x 0 :y 0 :width 10 :height 10}
                                        {:op "create_rect" :page-id pid :id "$tmp:r3"
                                         :parent-id "$tmp:b" :x 0 :y 0 :width 10 :height 10}
                                        {:op "create_rect" :page-id pid :id "$tmp:x"
                                         :parent-id "$tmp:b" :index 1
                                         :x 0 :y 0 :width 10 :height 10}])
        board-id (created result "$tmp:b")
        [r1 r2 r3 x] (mapv #(created result %) ["$tmp:r1" "$tmp:r2" "$tmp:r3" "$tmp:x"])]
    ;; Index 1 counts from the visual start: it lands after the first child
    (t/is (= [r1 x r2 r3] (visual-children file' board-id)))))

(t/deftest create-text-with-style
  (let [file   (thf/sample-file :file1)
        pid    (page-id-of file)
        [file' result] (apply-ops file [{:op "create_text" :page-id pid :id "$tmp:t"
                                         :characters "Hello" :font-size 24
                                         :font-family "sourcesanspro" :grow-type "fixed"
                                         :x 0 :y 0 :width 200 :height 40}])
        text   (shape-of file' (created result "$tmp:t"))
        node   (first (txt/node-seq txt/is-text-node? (:content text)))]
    (t/is (= :text (:type text)))
    (t/is (= "Hello" (txt/content->text (:content text))))
    (t/is (= "24" (:font-size node)))
    (t/is (= "sourcesanspro" (:font-family node)))
    (t/is (= [{:fill-color "#000000" :fill-opacity 1}] (:fills node)))
    (t/is (empty? (:warnings result)))
    (assert-box text 0 0 200 40)))

(t/deftest create-text-auto-width-warns-approximate-size
  (let [file   (thf/sample-file :file1)
        pid    (page-id-of file)
        [file' result] (apply-ops file [{:op "create_text" :page-id pid :id "$tmp:t"
                                         :characters "Hello world" :font-size 10
                                         :grow-type "auto-width" :x 0 :y 0}])
        text-id (created result "$tmp:t")
        text   (shape-of file' text-id)]
    (t/is (close? 66 (:width text)))
    (t/is (close? 12 (:height text)))
    (t/is (= [{:code :text-size-approximate :id text-id}] (:warnings result)))))

(t/deftest create-path-from-d-string
  (let [file   (thf/sample-file :file1)
        pid    (page-id-of file)
        [file' result] (apply-ops file [{:op "create_path" :page-id pid :id "$tmp:p"
                                         :d "M 0 0 L 100 0 L 100 50 Z"
                                         :x 0 :y 0 :width 100 :height 50}])
        path   (shape-of file' (created result "$tmp:p"))]
    (t/is (= :path (:type path)))
    (t/is (seq (:content path)))
    (assert-box path 0 0 100 50)))

(t/deftest create-path-with-d-and-position-moves-bounds
  (let [file   (thf/sample-file :file1)
        pid    (page-id-of file)
        [file' result] (apply-ops file [{:op "create_path" :page-id pid :id "$tmp:p"
                                         :d "M 0 0 L 100 0 L 100 50 Z"
                                         :x 30 :y 40}])
        path   (shape-of file' (created result "$tmp:p"))]
    (t/is (close? 30 (:x (:selrect path))))
    (t/is (close? 40 (:y (:selrect path))))
    (assert-box path 30 40 100 50)))

(t/deftest create-image-sets-media-fill
  (let [file     (thf/sample-file :file1)
        pid      (page-id-of file)
        media-id (thi/new-id! :media)
        [file' result] (apply-ops file [{:op "create_image" :page-id pid :id "$tmp:i"
                                         :media-id media-id :media-width 800 :media-height 600
                                         :media-mtype "image/png"
                                         :x 0 :y 0 :width 80 :height 60}])
        image  (shape-of file' (created result "$tmp:i"))]
    (t/is (= :image (:type image)))
    (t/is (= media-id (-> image :fills first :fill-image :id)))
    (t/is (= 800 (-> image :fills first :fill-image :width)))
    (t/is (= 600 (-> image :fills first :fill-image :height)))
    (assert-box image 0 0 80 60)))

(t/deftest create-svg-raw-keeps-content
  (let [file   (thf/sample-file :file1)
        pid    (page-id-of file)
        [file' result] (apply-ops file [{:op "create_svg_raw" :page-id pid :id "$tmp:s"
                                         :content {:tag :svg
                                                   :attrs {:viewBox "0 0 10 10"}
                                                   :content []}
                                         :x 0 :y 0 :width 10 :height 10}])
        svg    (shape-of file' (created result "$tmp:s"))]
    (t/is (= :svg-raw (:type svg)))
    (t/is (= "0 0 10 10" (get-in svg [:content :attrs :viewBox])))))

;; ----- Groups and booleans

(t/deftest create-group-over-two-rects
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        r2   (thi/id :rect2)
        [file' result] (apply-ops file [{:op "create_group" :page-id pid :id "$tmp:g"
                                         :child-ids [r1 r2]}])
        group-id (created result "$tmp:g")
        group    (shape-of file' group-id)]
    (t/is (= :group (:type group)))
    (assert-box group 10 10 70 40)
    (t/is (= group-id (:parent-id (shape-of file' r1))))
    (t/is (= group-id (:parent-id (shape-of file' r2))))))

(t/deftest create-into-group-resizes-group
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        r2   (thi/id :rect2)
        [file' result] (apply-ops file [{:op "create_group" :page-id pid :id "$tmp:g"
                                         :child-ids [r1 r2]}
                                        {:op "create_rect" :page-id pid :id "$tmp:r"
                                         :parent-id "$tmp:g" :x 100 :y 100
                                         :width 10 :height 10}])
        group-id (created result "$tmp:g")]
    (t/is (= group-id (:parent-id (shape-of file' (created result "$tmp:r")))))
    (assert-box (shape-of file' group-id) 10 10 100 100)))

(t/deftest create-boolean-keeps-bool-type
  (doseq [bool-type ["union" "difference" "intersection" "exclude"]]
    (let [file (two-rects-file)
          pid  (page-id-of file)
          r1   (thi/id :rect1)
          r2   (thi/id :rect2)
          [file' result] (apply-ops file [{:op "create_boolean" :page-id pid :id "$tmp:b"
                                           :bool-type bool-type :child-ids [r1 r2]}])
          bool-id (created result "$tmp:b")
          bool    (shape-of file' bool-id)]
      (t/is (= :bool (:type bool)))
      (t/is (= (keyword bool-type) (:bool-type bool)))
      (t/is (= bool-id (:parent-id (shape-of file' r1))))
      (t/is (= bool-id (:parent-id (shape-of file' r2)))))))

(t/deftest create-boolean-keeps-children-in-parent-order
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        r2   (thi/id :rect2)
        [file' result] (apply-ops file [{:op "create_boolean" :page-id pid :id "$tmp:b"
                                         :bool-type "union" :child-ids [r2 r1]}])
        bool (shape-of file' (created result "$tmp:b"))
        parent-order (filterv #{r1 r2} (:shapes (shape-of file uuid/zero)))]
    (t/is (= :bool (:type bool)))
    (t/is (= :union (:bool-type bool)))
    (t/is (= parent-order (:shapes bool)))))

(t/deftest create-boolean-refuses-board-child
  (let [file (-> (two-rects-file)
                 (tho/add-frame :board1 :x 0 :y 0 :width 300 :height 100))
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_boolean" :page-id pid
                                               :bool-type "union"
                                               :child-ids [(thi/id :rect1) (thi/id :board1)]}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"board" (:hint data)))))

(t/deftest create-group-takes-parent-of-first-child
  (let [file (board-with-children-file)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_group" :page-id pid :id "$tmp:g"
                                         :child-ids [(thi/id :rect1) (thi/id :rect2)]}])
        group (shape-of file' (created result "$tmp:g"))]
    (t/is (= (thi/id :board1) (:parent-id group)))))

(t/deftest create-group-refuses-children-with-different-parents
  (let [file (-> (board-with-children-file)
                 (ths/add-sample-shape :rect4 :x 0 :y 0 :width 5 :height 5))
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_group" :page-id pid
                                               :child-ids [(thi/id :rect1) (thi/id :rect4)]}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (= "children must share a parent" (:hint data)))))

(t/deftest create-group-resets-child-constraints-to-scale
  (let [file (-> (thf/sample-file :file1)
                 (ths/add-sample-shape :rect1 :x 10 :y 10 :width 20 :height 20
                                       :constraints-h :left :constraints-v :top)
                 (ths/add-sample-shape :rect2 :x 50 :y 40 :width 30 :height 10
                                       :constraints-h :right :constraints-v :bottom))
        pid  (page-id-of file)
        [file' _] (apply-ops file [{:op "create_group" :page-id pid :id "$tmp:g"
                                    :child-ids [(thi/id :rect1) (thi/id :rect2)]}])]
    (doseq [id [(thi/id :rect1) (thi/id :rect2)]]
      (let [child (shape-of file' id)]
        (t/is (= :scale (:constraints-h child)))
        (t/is (= :scale (:constraints-v child)))))))

(t/deftest create-group-in-grid-takes-front-child-cell
  (let [file (board-with-children-file)
        pid  (page-id-of file)
        board-id (thi/id :board1)
        r1 (thi/id :rect1)
        r2 (thi/id :rect2)
        [grid-file _] (apply-ops file [{:op "set_grid_layout" :page-id pid :id board-id
                                        :layout-grid-rows [{:type "flex" :value 1}
                                                           {:type "flex" :value 1}]
                                        :layout-grid-columns [{:type "flex" :value 1}
                                                              {:type "flex" :value 1}]}
                                       {:op "set_grid_cell" :page-id pid :grid-id board-id
                                        :child-id r1 :row 1 :column 1}
                                       {:op "set_grid_cell" :page-id pid :grid-id board-id
                                        :child-id r2 :row 2 :column 2}])
        [file' result] (apply-ops grid-file [{:op "create_group" :page-id pid :id "$tmp:g"
                                              :child-ids [r1 r2]}])
        group-id (created result "$tmp:g")
        ;; The front child is the later of the two in the children of the board
        front (last (filterv #{r1 r2} (:shapes (shape-of grid-file board-id))))
        front-cell (ctl/get-cell-by-shape-id (shape-of grid-file board-id) front)
        cell (ctl/get-cell-by-shape-id (shape-of file' board-id) group-id)]
    (t/is (= board-id (:parent-id (shape-of file' group-id))))
    (t/is (some? front-cell))
    (t/is (some? cell))
    (t/is (= (select-keys front-cell [:row :column])
             (select-keys cell [:row :column])))))

;; ----- Update shape

(t/deftest update-shape-moves-and-resizes-rect
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        [file' _] (apply-ops file [{:op "update_shape" :page-id pid :id r1
                                    :props {:x 50 :y 60 :width 200 :height 80}}])]
    (assert-box (shape-of file' r1) 50 60 200 80)))

(t/deftest update-shape-rotation-changes-selrect
  (let [file (-> (thf/sample-file :file1)
                 (ths/add-sample-shape :rect1 :x 0 :y 0 :width 100 :height 50))
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        [file' _] (apply-ops file [{:op "update_shape" :page-id pid :id r1
                                    :props {:rotation 90}}])
        rect (shape-of file' r1)
        xs   (map :x (:points rect))
        ys   (map :y (:points rect))]
    (t/is (close? 90 (:rotation rect)))
    (t/is (close? 25 (apply min xs)))
    (t/is (close? 75 (apply max xs)))
    (t/is (close? -25 (apply min ys)))
    (t/is (close? 75 (apply max ys)))))

(t/deftest update-shape-moves-board-children-by-same-delta
  (let [file   (board-with-children-file)
        pid    (page-id-of file)
        board  (thi/id :board1)
        labels [:rect1 :rect2 :rect3]
        before (mapv #(shape-of file (thi/id %)) labels)
        [file' _] (apply-ops file [{:op "update_shape" :page-id pid :id board
                                    :props {:x 40 :y 25}}])
        after  (mapv #(shape-of file' (thi/id %)) labels)]
    (t/is (close? 40 (:x (shape-of file' board))))
    (t/is (close? 25 (:y (shape-of file' board))))
    (doseq [[b a] (map vector before after)]
      (t/is (close? 40 (- (:x a) (:x b))))
      (t/is (close? 25 (- (:y a) (:y b)))))))

(t/deftest update-shape-moves-children-of-rotated-board-consistently
  (let [file      (board-with-children-file)
        pid       (page-id-of file)
        board     (thi/id :board1)
        children  (mapv thi/id [:rect1 :rect2 :rect3])
        min-x     (fn [s] (apply min (map :x (:points s))))
        min-y     (fn [s] (apply min (map :y (:points s))))
        [file1 _] (apply-ops file [{:op "update_shape" :page-id pid :id board
                                    :props {:rotation 90}}])
        board-before    (shape-of file1 board)
        children-before (mapv #(shape-of file1 %) children)
        [file2 _] (apply-ops file1 [{:op "update_shape" :page-id pid :id board
                                     :props {:x 40 :y 25}}])
        board-after    (shape-of file2 board)
        children-after (mapv #(shape-of file2 %) children)]
    (t/is (close? 40 (min-x board-after)))
    (t/is (close? 25 (min-y board-after)))
    (doseq [[before after] (map vector children-before children-after)]
      (t/is (close? (- (:x board-after) (:x board-before))
                    (- (:x after) (:x before))))
      (t/is (close? (- (:y board-after) (:y board-before))
                    (- (:y after) (:y before))))
      (t/is (close? (- (min-x board-after) (min-x board-before))
                    (- (min-x after) (min-x before))))
      (t/is (close? (- (min-y board-after) (min-y board-before))
                    (- (min-y after) (min-y before)))))))

(t/deftest update-shape-rotated-position-is-points-rect-corner
  (let [file (-> (thf/sample-file :file1)
                 (ths/add-sample-shape :rect1 :x 0 :y 0 :width 100 :height 50))
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        [file' _] (apply-ops file [{:op "update_shape" :page-id pid :id r1
                                    :props {:rotation 30 :x 200 :y 300}}])
        rect (shape-of file' r1)]
    (t/is (close? 30 (:rotation rect)))
    (t/is (close? 200 (apply min (map :x (:points rect)))))
    (t/is (close? 300 (apply min (map :y (:points rect)))))))

(t/deftest update-shape-plain-props
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        [file' _] (apply-ops file [{:op "update_shape" :page-id pid :id r1
                                    :props {:opacity 0.5 :hidden true}}])
        rect (shape-of file' r1)]
    (t/is (close? 0.5 (:opacity rect)))
    (t/is (true? (:hidden rect)))))

(t/deftest update-shape-refuses-geometry-keys
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        data (thrown-data #(compile-ops file [{:op "update_shape" :page-id pid :id r1
                                               :props {:x 5
                                                       :selrect {:x 999 :y 999 :width 1 :height 1
                                                                 :x1 999 :y1 999 :x2 1000 :y2 1000}
                                                       :points []}}]))]
    (t/is (= :validation (:type data)))
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (some? (re-find #"structural key :(selrect|points)" (str (:hint data)))))))

(t/deftest update-shape-that-leaves-path-without-content-is-refused
  (let [file    (thf/sample-file :file1)
        pid     (page-id-of file)
        [file' result] (apply-ops file [{:op "create_path" :page-id pid :id "$tmp:p"
                                         :d "M 0 0 L 100 0 L 100 50 Z"
                                         :x 0 :y 0 :width 100 :height 50}])
        path-id (created result "$tmp:p")
        data    (thrown-data #(compile-ops file' [{:op "update_shape" :page-id pid
                                                   :id path-id
                                                   :props {:content nil}}]))]
    (t/is (= :validation (:type data)))
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (seq (:hint data)))
    (t/is (some? (re-find #"invalid shape" (str (:hint data)))))))

;; ----- Nested containers and the modifier subset

#?(:clj
   (defn- nested-containers-file
     "A page with nested containers. The board `:board` holds the group `:outer`
  over the bool `:bool`. The bool holds the group `:inner`, over the rects
  `:rect1` and `:rect2`, and the group `:other`, over the rects `:rect3` and
  `:rect4`. The board also holds the rect `:sibling`. The flex board `:flex`
  holds the group `:fgroup` over the rect `:frect`."
     []
     (doseq [label [:board :rect1 :rect2 :inner :rect3 :rect4 :other :bool :outer
                    :sibling :flex :frect :fgroup]]
       (thi/new-id! label))
     (let [file (thf/sample-file :file1)
           pid  (page-id-of file)
           [file' _] (apply-ops file [{:op "create_board" :page-id pid :id (thi/id :board)
                                       :x 0 :y 0 :width 400 :height 400}
                                      {:op "create_rect" :page-id pid :id (thi/id :rect1)
                                       :parent-id (thi/id :board)
                                       :x 10 :y 10 :width 20 :height 20}
                                      {:op "create_rect" :page-id pid :id (thi/id :rect2)
                                       :parent-id (thi/id :board)
                                       :x 40 :y 10 :width 20 :height 20}
                                      {:op "create_group" :page-id pid :id (thi/id :inner)
                                       :child-ids [(thi/id :rect1) (thi/id :rect2)]}
                                      {:op "create_rect" :page-id pid :id (thi/id :rect3)
                                       :parent-id (thi/id :board)
                                       :x 80 :y 10 :width 20 :height 20}
                                      {:op "create_rect" :page-id pid :id (thi/id :rect4)
                                       :parent-id (thi/id :board)
                                       :x 120 :y 10 :width 20 :height 20}
                                      {:op "create_group" :page-id pid :id (thi/id :other)
                                       :child-ids [(thi/id :rect3) (thi/id :rect4)]}
                                      {:op "create_boolean" :page-id pid :id (thi/id :bool)
                                       :bool-type "union"
                                       :child-ids [(thi/id :inner) (thi/id :other)]}
                                      {:op "create_group" :page-id pid :id (thi/id :outer)
                                       :child-ids [(thi/id :bool)]}
                                      {:op "create_rect" :page-id pid :id (thi/id :sibling)
                                       :parent-id (thi/id :board)
                                       :x 200 :y 200 :width 50 :height 50}
                                      {:op "create_board" :page-id pid :id (thi/id :flex)
                                       :x 500 :y 0 :width 200 :height 200}
                                      {:op "set_flex_layout" :page-id pid :id (thi/id :flex)
                                       :layout-flex-dir "row"}
                                      {:op "create_rect" :page-id pid :id (thi/id :frect)
                                       :parent-id (thi/id :flex)
                                       :x 510 :y 10 :width 20 :height 20}
                                      {:op "create_group" :page-id pid :id (thi/id :fgroup)
                                       :child-ids [(thi/id :frect)]}])]
       file')))

#?(:clj
   (defn- full-objects-changes
     "The changes that the modifiers of the geometry `props` give the shape
     `id` when they run over all the objects of its page. These are the
     changes that `update_shape` must emit for the same geometry."
     [file page-id id props]
     (let [fdata   (:data file)
           objects (get-in fdata [:pages-index page-id :objects])
           mods    (#'mops/geometry-modifiers (get objects id) props)]
       (-> (pcb/empty-changes nil page-id)
           (pcb/with-file-data fdata)
           (pcb/with-library-data fdata)
           (lm/generate-apply-modifiers objects {id {:modifiers mods}} {})
           :redo-changes))))

#?(:clj
   (t/deftest modifier-objects-subset-matches-full-objects
     (let [file (nested-containers-file)
           pid  (page-id-of file)]
       (doseq [[label props] [[:rect1 {:x 15 :y 20 :width 30 :height 25}]
                              [:rect2 {:x 50 :y 60}]
                              [:rect3 {:width 5 :height 40}]
                              [:rect4 {:x 130 :y 20}]
                              [:sibling {:x 210 :y 190}]]]
         (let [id       (thi/id label)
               expected (full-objects-changes file pid id props)
               result   (compile-ops file [{:op "update_shape" :page-id pid
                                            :id id :props props}])]
           (t/is (seq expected))
           (t/is (= expected (:changes result))))))))

#?(:clj
   (defn- op-changes
     "The changes that the first op of `result` emitted, without the reflow."
     [result]
     (let [[start end] (first (:op-ranges result))]
       (subvec (:changes result) start end))))

#?(:clj
   (defn- container-ops
     "The ops that build the rect `$tmp:child` in the container `$tmp:container`
     of `kind`: a flex or grid board, a group, a bool, a mask group, or a
     component copy. The component copy is made later, by `container-file`."
     [pid kind]
     (let [board  {:op "create_board" :page-id pid :id "$tmp:container"
                   :x 0 :y 0 :width 200 :height 200}
           inside {:op "create_rect" :page-id pid :id "$tmp:child"
                   :parent-id "$tmp:container" :x 10 :y 10 :width 40 :height 40}
           root   {:op "create_rect" :page-id pid :id "$tmp:child"
                   :x 10 :y 10 :width 40 :height 40}
           other  {:op "create_rect" :page-id pid :id "$tmp:other"
                   :x 60 :y 10 :width 40 :height 40}
           sibling {:op "create_rect" :page-id pid :id "$tmp:sibling"
                    :parent-id "$tmp:container" :x 60 :y 10 :width 40 :height 40}]
       (case kind
         :flex [board inside sibling
                {:op "set_flex_layout" :page-id pid :id "$tmp:container"
                 :layout-flex-dir "row"}]

         :grid [board inside sibling
                {:op "set_grid_layout" :page-id pid :id "$tmp:container"
                 :layout-grid-rows [{:type "flex" :value 1}]
                 :layout-grid-columns [{:type "fixed" :value 100} {:type "flex" :value 1}]}
                {:op "set_grid_cell" :page-id pid :grid-id "$tmp:container"
                 :child-id "$tmp:child" :row 1 :column 1}
                {:op "set_grid_cell" :page-id pid :grid-id "$tmp:container"
                 :child-id "$tmp:sibling" :row 1 :column 2}]

         :group [root other
                 {:op "create_group" :page-id pid :id "$tmp:container"
                  :child-ids ["$tmp:child" "$tmp:other"]}]

         :bool [root other
                {:op "create_boolean" :page-id pid :id "$tmp:container"
                 :bool-type "union" :child-ids ["$tmp:child" "$tmp:other"]}]

         :mask [root other
                {:op "create_group" :page-id pid :id "$tmp:container"
                 :child-ids ["$tmp:child" "$tmp:other"]}
                {:op "make_mask" :page-id pid :group-id "$tmp:container"}]

         :component [board inside
                     {:op "create_component" :page-id pid :id "$tmp:comp"
                      :shape-ids ["$tmp:container"] :name "Button"}]))))

#?(:clj
   (defn- container-file
     "A file with the rect `:child` inside a container of `kind`, as made by
     `container-ops`. Returns the file with the ids of the page, the container,
     the child and the `:sibling` (none for a component copy)."
     [kind]
     (let [file (thf/sample-file :file1)
           pid  (page-id-of file)
           [file' result] (apply-ops file (container-ops pid kind))]
       (if (= :component kind)
         (let [[file'' result'] (apply-ops file' [{:op "instantiate_component" :page-id pid
                                                   :component-id (created result "$tmp:comp")
                                                   :x 300 :y 0 :id "$tmp:copy"}])
               copy-id (created result' "$tmp:copy")]
           {:file file'' :pid pid :container copy-id
            :child (first (:shapes (shape-of file'' copy-id)))})
         {:file file' :pid pid
          :container (created result "$tmp:container")
          :child (created result "$tmp:child")
          :sibling (created result "$tmp:sibling")}))))

#?(:clj
   (defn- assert-selrect-covers
     "Checks that the selrect of the container `container-id` is the box that
     covers the selrects of the shapes `shape-ids` in `file`. The selrect is
     the box that the renderer and hit testing read."
     [file container-id shape-ids]
     (let [boxes   (map #(:selrect (shape-of file %)) shape-ids)
           selrect (:selrect (shape-of file container-id))]
       (t/is (close? (apply min (map :x1 boxes)) (:x1 selrect)))
       (t/is (close? (apply min (map :y1 boxes)) (:y1 selrect)))
       (t/is (close? (apply max (map :x2 boxes)) (:x2 selrect)))
       (t/is (close? (apply max (map :y2 boxes)) (:y2 selrect))))))

#?(:clj
   (t/deftest update-shape-geometry-inside-group
     (let [{:keys [file pid child container]} (container-file :group)
           props  {:x 30 :y 40 :width 50 :height 30}
           result (compile-ops file [{:op "update_shape" :page-id pid :id child :props props}])
           file'  (thf/apply-changes file {:redo-changes (:changes result)})]
       (assert-box (shape-of file' child) 30 40 50 30)
       (assert-selrect-covers file' container (:shapes (shape-of file' container)))
       (t/is (= (full-objects-changes file pid child props) (op-changes result))))))

#?(:clj
   (t/deftest update-shape-geometry-inside-bool
     ;; The top-level x, y, width and height of a bool are not refreshed by a
     ;; resize, so the selrect carries the bounds here.
     (let [{:keys [file pid child container]} (container-file :bool)
           props  {:x 30 :y 40 :width 50 :height 30}
           result (compile-ops file [{:op "update_shape" :page-id pid :id child :props props}])
           file'  (thf/apply-changes file {:redo-changes (:changes result)})]
       (assert-box (shape-of file' child) 30 40 50 30)
       (assert-selrect-covers file' container (:shapes (shape-of file' container)))
       (t/is (= (full-objects-changes file pid child props) (op-changes result))))))

#?(:clj
   (t/deftest update-shape-geometry-inside-mask-group
     (let [{:keys [file pid child container]} (container-file :mask)
           props  {:x 30 :y 40 :width 50 :height 30}
           result (compile-ops file [{:op "update_shape" :page-id pid :id child :props props}])
           file'  (thf/apply-changes file {:redo-changes (:changes result)})]
       (assert-box (shape-of file' child) 30 40 50 30)
       (t/is (true? (:masked-group (shape-of file' container))))
       ;; The child is the mask, and the mask gives the box of the group.
       (assert-selrect-covers file' container [child])
       (t/is (= (full-objects-changes file pid child props) (op-changes result))))))

#?(:clj
   (t/deftest update-shape-geometry-inside-component-copy
     (let [{:keys [file pid child container]} (container-file :component)
           props  {:x 30 :y 40 :width 50 :height 30}
           result (compile-ops file [{:op "update_shape" :page-id pid :id child :props props}])
           file'  (thf/apply-changes file {:redo-changes (:changes result)})]
       (assert-box (shape-of file' child) 30 40 50 30)
       (t/is (ctk/in-component-copy? (shape-of file' container)))
       (t/is (= (full-objects-changes file pid child props) (op-changes result))))))

#?(:clj
   (defn- assert-board-resize
     "Checks the resize of `child` in the board of `kind`. The layout owns the
     position of the child, so only its size is checked. The sibling moves by
     `shift`, the width that the child gained in a flex row, or stays in place
     in a fixed grid track. The modifiers reflow the children of the board in
     the range of the op, so no change falls after it."
     [kind shift]
     (let [{:keys [file pid child sibling]} (container-file kind)
           props  {:x 30 :y 40 :width 50 :height 30}
           result (compile-ops file [{:op "update_shape" :page-id pid :id child :props props}])
           file'  (thf/apply-changes file {:redo-changes (:changes result)})]
       (t/is (close? 50 (:width (shape-of file' child))))
       (t/is (close? 30 (:height (shape-of file' child))))
       (t/is (= (full-objects-changes file pid child props) (op-changes result)))
       (t/is (contains? (:touched-page-ids result) pid))
       (t/is (close? (+ shift (:x (shape-of file sibling)))
                     (:x (shape-of file' sibling)))))))

#?(:clj
   (t/deftest update-shape-geometry-inside-flex-board
     (assert-board-resize :flex 10)))

#?(:clj
   (t/deftest update-shape-geometry-inside-grid-board
     (assert-board-resize :grid 0)))

#?(:clj
   (defn- two-step-changes
     "The changes of a geometry-only `update_shape` of `id` when both of its
     steps run over all the objects of the page: the modifiers, then the
     merge of no attrs with the resize of the parents. The compiler skips the
     second step when it can emit nothing, and must still emit these."
     [file page-id id props]
     (let [geometry (full-objects-changes file page-id id props)
           fdata    (cfc/process-changes (:data file) geometry)
           objects  (get-in fdata [:pages-index page-id :objects])
           attrs    (-> (pcb/empty-changes nil page-id)
                        (pcb/with-file-data fdata)
                        (pcb/with-library-data fdata)
                        (cls/generate-update-shapes [id] identity objects {})
                        (pcb/resize-parents (cfh/get-parent-ids objects id))
                        :redo-changes)]
       (into geometry attrs))))

#?(:clj
   (t/deftest update-shape-geometry-matches-two-step-changes
     (let [file    (thf/sample-file :file1)
           pid     (page-id-of file)
           [root-file root] (apply-ops file [{:op "create_rect" :page-id pid :id "$tmp:r"
                                              :x 10 :y 10 :width 40 :height 40}])
           grid    (container-file :grid)
           props   {:x 25 :y 35}
           cases   [[root-file pid (created root "$tmp:r")]
                    (let [{:keys [file pid child]} (container-file :group)] [file pid child])
                    (let [{:keys [file pid child]} (container-file :bool)] [file pid child])
                    [(:file grid) (:pid grid) (:child grid)]
                    [(:file grid) (:pid grid) (:container grid)]
                    (let [{:keys [file pid container]} (container-file :flex)]
                      [file pid container])]]
       (doseq [[file pid id] cases]
         (let [result (compile-ops file [{:op "update_shape" :page-id pid :id id
                                          :props props}])]
           (t/is (= (two-step-changes file pid id props) (op-changes result)))))
       ;; Moving the grid board itself gives the second step changes to emit
       (t/is (< (count (full-objects-changes (:file grid) (:pid grid) (:container grid) props))
                (count (two-step-changes (:file grid) (:pid grid) (:container grid) props)))))))

;; ----- Structure

(t/deftest move-shapes-into-board-at-index
  (let [file (-> (board-with-children-file)
                 (ths/add-sample-shape :rect4 :x 200 :y 0 :width 10 :height 10))
        pid  (page-id-of file)
        board-id (thi/id :board1)
        r4       (thi/id :rect4)
        [file' _] (apply-ops file [{:op "move_shapes" :page-id pid :ids [r4]
                                    :parent-id board-id :index 0}])
        board    (shape-of file' board-id)]
    (t/is (= board-id (:parent-id (shape-of file' r4))))
    (t/is (= r4 (first (:shapes board))))))

(t/deftest move-shapes-by-handle
  (let [file   (thf/sample-file :file1)
        pid    (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 0 :y 0 :width 100 :height 100}
                                        {:op "create_rect" :page-id pid :id "$tmp:r"
                                         :x 0 :y 0 :width 10 :height 10}
                                        {:op "move_shapes" :page-id pid :ids ["$tmp:r"]
                                         :parent-id "$tmp:b"}])
        board-id (created result "$tmp:b")
        rect-id  (created result "$tmp:r")]
    (t/is (= #{"$tmp:b" "$tmp:r"} (set (keys (:created-ids result)))))
    (t/is (= board-id (:parent-id (shape-of file' rect-id))))))

(t/deftest reorder-children-sets-new-order
  (let [file (board-with-children-file)
        pid  (page-id-of file)
        board-id (thi/id :board1)
        r1 (thi/id :rect1)
        r2 (thi/id :rect2)
        r3 (thi/id :rect3)
        [file' _] (apply-ops file [{:op "reorder" :page-id pid :parent-id board-id
                                    :ids [r3 r1 r2]}])]
    (t/is (= [r3 r1 r2] (vec (:shapes (shape-of file' board-id)))))))

(t/deftest reorder-rejects-partial-child-list
  (let [file (board-with-children-file)
        pid  (page-id-of file)
        board-id (thi/id :board1)
        data (thrown-data #(compile-ops file [{:op "reorder" :page-id pid :parent-id board-id
                                               :ids [(thi/id :rect1) (thi/id :rect2)]}]))]
    (t/is (= :mcp-invalid-operation (:code data)))))

(t/deftest reorder-in-flex-board-takes-visual-order
  (let [file (board-with-children-file)
        pid  (page-id-of file)
        board-id (thi/id :board1)
        r1 (thi/id :rect1)
        r2 (thi/id :rect2)
        r3 (thi/id :rect3)
        [file' _] (apply-ops file [{:op "set_flex_layout" :page-id pid :id board-id}
                                   {:op "reorder" :page-id pid :parent-id board-id
                                    :ids [r3 r1 r2]}])]
    (t/is (= [r3 r1 r2] (visual-children file' board-id)))
    (t/is (= [r2 r1 r3] (vec (:shapes (shape-of file' board-id)))))))

(t/deftest move-shapes-into-flex-board-at-natural-index
  (let [file (-> (board-with-children-file)
                 (ths/add-sample-shape :rect4 :x 200 :y 0 :width 10 :height 10))
        pid  (page-id-of file)
        board-id (thi/id :board1)
        r1 (thi/id :rect1)
        r2 (thi/id :rect2)
        r3 (thi/id :rect3)
        r4 (thi/id :rect4)
        [file' _] (apply-ops file [{:op "set_flex_layout" :page-id pid :id board-id}
                                   {:op "move_shapes" :page-id pid :ids [r4]
                                    :parent-id board-id :index 1}])]
    (t/is (= board-id (:parent-id (shape-of file' r4))))
    (t/is (= [r1 r4 r2 r3] (visual-children file' board-id)))))

(t/deftest delete-shapes-removes-shape
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        r2   (thi/id :rect2)
        [file' _] (apply-ops file [{:op "delete_shapes" :page-id pid :ids [r1]}])]
    (t/is (nil? (shape-of file' r1)))
    (t/is (some? (shape-of file' r2)))))

(t/deftest clone-shape-with-handle-used-later
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        [file' result] (apply-ops file [{:op "clone_shape" :page-id pid :id r1 :new-id "$tmp:c"}
                                        {:op "update_shape" :page-id pid :id "$tmp:c"
                                         :props {:x 100 :y 100}}])
        clone-id (created result "$tmp:c")]
    (t/is (uuid? clone-id))
    (t/is (not= r1 clone-id))
    (assert-box (shape-of file' clone-id) 100 100 20 20)
    (assert-box (shape-of file' r1) 10 10 20 20)))

(t/deftest clone-shape-of-component-copy-keeps-component
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-simple-component-with-copy :comp1 :root1 :child1 :copy1))
        pid  (page-id-of file)
        copy-id (thi/id :copy1)
        [file' result] (apply-ops file [{:op "clone_shape" :page-id pid :id copy-id
                                         :new-id "$tmp:c"}])
        clone (shape-of file' (created result "$tmp:c"))]
    (t/is (some? clone))
    (t/is (not= copy-id (:id clone)))
    (t/is (= (thi/id :comp1) (:component-id clone)))))

(t/deftest ungroup-moves-children-up
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-group :group1)
                 (ths/add-sample-shape :rect1 :parent-label :group1 :x 0 :y 0 :width 10 :height 10)
                 (ths/add-sample-shape :rect2 :parent-label :group1 :x 20 :y 0 :width 10 :height 10))
        pid  (page-id-of file)
        group-id (thi/id :group1)
        [file' _] (apply-ops file [{:op "ungroup" :page-id pid :id group-id}])]
    (t/is (nil? (shape-of file' group-id)))
    (t/is (= uuid/zero (:parent-id (shape-of file' (thi/id :rect1)))))
    (t/is (= uuid/zero (:parent-id (shape-of file' (thi/id :rect2)))))))

(t/deftest flatten-rect-to-path
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        [file' _] (apply-ops file [{:op "flatten" :page-id pid :ids [r1]}])]
    (t/is (= :path (:type (shape-of file' r1))))))

(t/deftest flatten-board-removes-its-children
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-frame :board1 :x 0 :y 0 :width 100 :height 100)
                 (ths/add-sample-shape :rect1 :parent-label :board1 :x 0 :y 0 :width 10 :height 10)
                 (ths/add-sample-shape :rect2 :parent-label :board1 :x 20 :y 0 :width 10 :height 10))
        pid  (page-id-of file)
        board-id (thi/id :board1)
        [file' _] (apply-ops file [{:op "flatten" :page-id pid :ids [board-id]}])]
    (t/is (= :path (:type (shape-of file' board-id))))
    (t/is (nil? (shape-of file' (thi/id :rect1))))
    (t/is (nil? (shape-of file' (thi/id :rect2))))))

(t/deftest flatten-skips-shape-inside-component-copy
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-simple-component-with-copy :comp1 :root1 :child1 :copy1))
        pid  (page-id-of file)
        copy-child-id (:id (find-shape file #(and (some? (:shape-ref %))
                                                  (= (thi/id :copy1) (:parent-id %)))))
        [file' _] (apply-ops file [{:op "flatten" :page-id pid :ids [copy-child-id]}])]
    (t/is (= :rect (:type (shape-of file' copy-child-id))))))

(t/deftest make-and-remove-mask
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-group :group1))
        pid  (page-id-of file)
        g1   (thi/id :group1)
        [file' _] (apply-ops file [{:op "make_mask" :page-id pid :group-id g1}])
        [file'' _] (apply-ops file' [{:op "remove_mask" :page-id pid :group-id g1}])]
    (t/is (true? (:masked-group (shape-of file' g1))))
    (t/is (not (:masked-group (shape-of file'' g1))))))

;; ----- Layout

(t/deftest set-flex-layout-spaces-children-by-gap
  (let [file (board-with-children-file)
        pid  (page-id-of file)
        board-id (thi/id :board1)
        [file' _] (apply-ops file [{:op "set_flex_layout" :page-id pid :id board-id
                                    :layout-flex-dir "row"
                                    :layout-gap {:row-gap 10 :column-gap 10}}])
        board (shape-of file' board-id)
        r1    (shape-of file' (thi/id :rect1))
        r2    (shape-of file' (thi/id :rect2))
        r3    (shape-of file' (thi/id :rect3))
        [a b c] (sort-by :x [r1 r2 r3])]
    (t/is (= :flex (:layout board)))
    (t/is (= :row (:layout-flex-dir board)))
    (t/is (close? (:x b) (+ (:x a) (:width a) 10)))
    (t/is (close? (:x c) (+ (:x b) (:width b) 10)))))

(t/deftest set-grid-layout-sets-tracks
  (let [file (board-with-children-file)
        pid  (page-id-of file)
        board-id (thi/id :board1)
        [file' _] (apply-ops file [{:op "set_grid_layout" :page-id pid :id board-id
                                    :layout-grid-rows [{:type "fixed" :value 50}
                                                       {:type "flex" :value 1}]
                                    :layout-grid-columns [{:type "flex" :value 1}
                                                          {:type "flex" :value 1}]}])
        board (shape-of file' board-id)]
    (t/is (= :grid (:layout board)))
    (t/is (= [:fixed :flex] (mapv :type (:layout-grid-rows board))))
    (t/is (= 2 (count (:layout-grid-columns board))))))

(t/deftest remove-layout-clears-container-layout
  (let [file (board-with-children-file)
        pid  (page-id-of file)
        board-id (thi/id :board1)
        [file' _] (apply-ops file [{:op "set_flex_layout" :page-id pid :id board-id
                                    :layout-flex-dir "column"}])
        [file'' _] (apply-ops file' [{:op "remove_layout" :page-id pid :id board-id}])]
    (t/is (= :flex (:layout (shape-of file' board-id))))
    (t/is (nil? (:layout (shape-of file'' board-id))))))

(t/deftest set-layout-child-sets-item-sizing
  (let [file (board-with-children-file)
        pid  (page-id-of file)
        board-id (thi/id :board1)
        r1 (thi/id :rect1)
        [file' _] (apply-ops file [{:op "set_flex_layout" :page-id pid :id board-id
                                    :layout-flex-dir "row"}
                                   {:op "set_layout_child" :page-id pid :id r1
                                    :layout-item-h-sizing "fill"}])]
    (t/is (= :fill (:layout-item-h-sizing (shape-of file' r1))))))

(t/deftest set-grid-cell-places-child-in-cell
  (let [file (board-with-children-file)
        pid  (page-id-of file)
        board-id (thi/id :board1)
        r1 (thi/id :rect1)
        [file' _] (apply-ops file [{:op "set_grid_layout" :page-id pid :id board-id
                                    :layout-grid-rows [{:type "flex" :value 1}
                                                       {:type "flex" :value 1}]
                                    :layout-grid-columns [{:type "flex" :value 1}
                                                          {:type "flex" :value 1}]}
                                   {:op "set_grid_cell" :page-id pid :grid-id board-id
                                    :child-id r1 :row 2 :column 2}])
        cell (ctl/get-cell-by-shape-id (shape-of file' board-id) r1)]
    (t/is (= 2 (:row cell)))
    (t/is (= 2 (:column cell)))))

(t/deftest set-flex-layout-sets-defaults-and-drops-child-constraints
  (let [file (stacked-board-file)
        pid  (page-id-of file)
        board-id (thi/id :board1)
        [file' _] (apply-ops file [{:op "set_flex_layout" :page-id pid :id board-id
                                    :layout-flex-dir "column"}])
        board (shape-of file' board-id)
        expected (merge ctl/initial-flex-layout {:layout-flex-dir :column})]
    (t/is (= expected (select-keys board (keys expected))))
    (doseq [id [(thi/id :rect1) (thi/id :rect2)]]
      (let [child (shape-of file' id)]
        (t/is (not (contains? child :constraints-h)))
        (t/is (not (contains? child :constraints-v)))))))

(t/deftest set-flex-layout-does-not-calculate-params-from-children
  (let [file (stacked-board-file)
        pid  (page-id-of file)
        board-id (thi/id :board1)
        [file' _] (apply-ops file [{:op "set_flex_layout" :page-id pid :id board-id}])
        board (shape-of file' board-id)]
    (t/is (= :row (:layout-flex-dir board)))
    (t/is (= {:row-gap 0 :column-gap 0} (:layout-gap board)))
    ;; The row puts both children on the top edge of the board
    (t/is (close? (:y (shape-of file' (thi/id :rect1)))
                  (:y (shape-of file' (thi/id :rect2)))))))

(t/deftest set-flex-layout-reverses-existing-children-once
  (let [file (board-with-children-file)
        pid  (page-id-of file)
        board-id (thi/id :board1)
        ids  [(thi/id :rect1) (thi/id :rect2) (thi/id :rect3)]
        [file' _] (apply-ops file [{:op "set_flex_layout" :page-id pid :id board-id}])
        ;; A board that has a layout already is not reversed again
        [file'' _] (apply-ops file' [{:op "set_flex_layout" :page-id pid :id board-id
                                      :layout-flex-dir "column"}])]
    (t/is (= (vec (reverse ids)) (vec (:shapes (shape-of file' board-id)))))
    (t/is (= ids (visual-children file' board-id)))
    (t/is (= (vec (reverse ids)) (vec (:shapes (shape-of file'' board-id)))))
    (t/is (= ids (visual-children file'' board-id)))))

(t/deftest set-grid-layout-keeps-creation-order-as-cell-order
  (let [file (board-with-children-file)
        pid  (page-id-of file)
        board-id (thi/id :board1)
        ids  [(thi/id :rect1) (thi/id :rect2) (thi/id :rect3)]
        [file' _] (apply-ops file [{:op "set_grid_layout" :page-id pid :id board-id
                                    :layout-grid-rows [{:type "flex" :value 1}
                                                       {:type "flex" :value 1}]
                                    :layout-grid-columns [{:type "flex" :value 1}
                                                          {:type "flex" :value 1}]}])
        board (shape-of file' board-id)
        cells (mapv (fn [id]
                      (let [cell (ctl/get-cell-by-shape-id board id)]
                        [(:row cell) (:column cell)]))
                    ids)]
    ;; The grid is not reversed: the cells follow the creation order, and
    ;; :shapes is the reverse of that order
    (t/is (= cells (sort cells)))
    (t/is (= (vec (reverse ids)) (vec (:shapes board))))))

;; ----- Text

(t/deftest set-text-keeps-style
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_text" :page-id pid :id "$tmp:t"
                                         :characters "Hello" :font-size 20 :grow-type "fixed"
                                         :x 0 :y 0 :width 200 :height 40}
                                        {:op "set_text" :page-id pid :id "$tmp:t"
                                         :characters "Bye"}])
        text (shape-of file' (created result "$tmp:t"))
        node (first (txt/node-seq txt/is-text-node? (:content text)))]
    (t/is (= "Bye" (txt/content->text (:content text))))
    (t/is (= "20" (:font-size node)))))

(t/deftest set-text-style-applies-to-every-node
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_text" :page-id pid :id "$tmp:t"
                                         :characters "Hello" :font-size 10 :grow-type "fixed"
                                         :x 0 :y 0 :width 200 :height 40}
                                        {:op "set_text_style" :page-id pid :id "$tmp:t"
                                         :attrs {:font-size 30}}])
        text  (shape-of file' (created result "$tmp:t"))
        nodes (txt/node-seq txt/is-text-node? (:content text))]
    (t/is (seq nodes))
    (t/is (every? #(= "30" (:font-size %)) nodes))))

(t/deftest set-text-style-puts-attrs-on-their-nodes
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_text" :page-id pid :id "$tmp:t"
                                         :characters "Hello" :font-size 10 :grow-type "fixed"
                                         :x 0 :y 0 :width 200 :height 40}
                                        {:op "set_text_style" :page-id pid :id "$tmp:t"
                                         :attrs {:text-align "center" :vertical-align "middle"}}])
        content    (:content (shape-of file' (created result "$tmp:t")))
        paragraphs (txt/node-seq txt/is-paragraph-node? content)
        leaves     (txt/node-seq txt/is-text-node? content)]
    (t/is (seq paragraphs))
    (t/is (every? #(= "center" (:text-align %)) paragraphs))
    (t/is (= "middle" (:vertical-align content)))
    (t/is (not-any? #(= "center" (:text-align %)) leaves))
    (t/is (not-any? #(contains? % :vertical-align) leaves))))

(t/deftest set-text-style-stores-numbers-as-strings
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_text" :page-id pid :id "$tmp:t"
                                         :characters "Hello" :font-size 10 :grow-type "fixed"
                                         :x 0 :y 0 :width 200 :height 40}
                                        {:op "set_text_style" :page-id pid :id "$tmp:t"
                                         :attrs {:font-size 30 :font-weight 700}}])
        nodes (txt/node-seq txt/is-text-node? (:content (shape-of file' (created result "$tmp:t"))))]
    (t/is (seq nodes))
    (t/is (every? #(string? (:font-size %)) nodes))
    (t/is (every? #(= "30" (:font-size %)) nodes))
    (t/is (every? #(= "700" (:font-weight %)) nodes))))

(t/deftest apply-typography-sets-the-text-nodes
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_typography"
                                         :typography {:id "$tmp:t" :name "Body"
                                                      :font-family "sourcesanspro"
                                                      :font-size "18"}}
                                        {:op "create_text" :page-id pid :id "$tmp:x"
                                         :characters "Hello" :font-size 10 :font-family "other"
                                         :grow-type "fixed" :x 0 :y 0 :width 200 :height 40}
                                        {:op "apply_typography" :page-id pid :id "$tmp:x"
                                         :typography-id "$tmp:t"}])
        nodes (txt/node-seq txt/is-text-node?
                            (:content (shape-of file' (created result "$tmp:x"))))]
    (t/is (seq nodes))
    (t/is (every? #(= "sourcesanspro" (:font-family %)) nodes))
    (t/is (every? #(= "18" (:font-size %)) nodes))
    (t/is (every? #(= (created result "$tmp:t") (:typography-ref-id %)) nodes))))

;; ----- Font variants

(defn- text-op
  "A create_text op on `pid` with the font attrs `attrs`."
  [pid attrs]
  (merge {:op "create_text" :page-id pid :id "$tmp:t" :characters "Hello"
          :grow-type "fixed" :x 0 :y 0 :width 200 :height 40}
         attrs))

(defn- created-text-node
  "Applies `ops` to `file` and returns the first text node of the `$tmp:t` text."
  [file ops]
  (let [[file' result] (apply-ops file ops)]
    (first (txt/node-seq txt/is-text-node?
                         (:content (shape-of file' (created result "$tmp:t")))))))

(t/deftest font-variant-create-text-weight-700-is-bold
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        node (created-text-node file [(text-op pid {:font-weight "700"})])]
    (t/is (= "bold" (:font-variant-id node)))
    (t/is (= "700" (:font-weight node)))
    (t/is (= "normal" (:font-style node)))))

(t/deftest font-variant-create-text-derives-variant-from-weight-and-style
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)]
    (t/is (= "blackitalic"
             (:font-variant-id (created-text-node file [(text-op pid {:font-weight 900 :font-style "italic"})]))))
    (t/is (= "italic"
             (:font-variant-id (created-text-node file [(text-op pid {:font-weight 400 :font-style "italic"})]))))
    (t/is (= "600"
             (:font-variant-id (created-text-node file [(text-op pid {:font-weight 600 :font-style "normal"})]))))))

(t/deftest font-variant-create-text-derives-weight-and-style-from-variant
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        node (created-text-node file [(text-op pid {:font-variant-id "bold"})])]
    (t/is (= "bold" (:font-variant-id node)))
    (t/is (= "700" (:font-weight node)))
    (t/is (= "normal" (:font-style node)))))

(t/deftest font-variant-create-text-rejects-unknown-variant-id
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [(text-op pid {:font-variant-id "700"})]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"valid font-variant-id values" (str (:hint data))))
    (t/is (re-find #"bolditalic" (str (:hint data))))))

(t/deftest font-variant-create-text-rejects-variant-that-disagrees-with-weight
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [(text-op pid {:font-variant-id "regular"
                                                            :font-weight "600"})]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"regular" (str (:hint data))))
    (t/is (re-find #"600" (str (:hint data))))))

(t/deftest font-variant-create-text-rejects-weight-style-without-variant
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [(text-op pid {:font-weight "500"
                                                            :font-style "normal"})]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"500" (str (:hint data))))))

(t/deftest font-variant-create-text-numeric-convention-for-other-fonts
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        node (created-text-node file [(text-op pid {:font-id "gfont-roboto"
                                                    :font-weight 700
                                                    :font-style "normal"})])]
    (t/is (= "700" (:font-variant-id node)))
    (t/is (= "gfont-roboto" (:font-id node)))
    (t/is (= "700" (:font-weight node)))
    (t/is (= "normal" (:font-style node)))))

(t/deftest font-variant-create-text-rejects-variant-that-disagrees-on-other-fonts
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [(text-op pid {:font-id "gfont-roboto"
                                                            :font-variant-id "regular"
                                                            :font-weight "600"})]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"regular" (str (:hint data))))
    (t/is (re-find #"600" (str (:hint data))))))

(t/deftest font-variant-set-text-style-weight-700-is-bold
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [(text-op pid {})
                                        {:op "set_text_style" :page-id pid :id "$tmp:t"
                                         :attrs {:font-weight 700}}])
        nodes (txt/node-seq txt/is-text-node?
                            (:content (shape-of file' (created result "$tmp:t"))))]
    (t/is (seq nodes))
    (t/is (every? #(= "bold" (:font-variant-id %)) nodes))
    (t/is (every? #(= "700" (:font-weight %)) nodes))
    (t/is (every? #(= "normal" (:font-style %)) nodes))))

(t/deftest font-variant-create-typography-weight-700-is-bold
  (let [file (thf/sample-file :file1)
        [file' result] (apply-ops file [{:op "create_typography"
                                         :typography {:id "$tmp:t" :name "Body"
                                                      :font-weight "700"}}])
        typo (get-in (:data file') [:typographies (created result "$tmp:t")])]
    (t/is (= "bold" (:font-variant-id typo)))
    (t/is (= "700" (:font-weight typo)))
    (t/is (= "normal" (:font-style typo)))))

(t/deftest font-variant-create-typography-rejects-variant-that-disagrees
  (let [file (thf/sample-file :file1)
        data (thrown-data #(compile-ops file [{:op "create_typography"
                                               :typography {:id "$tmp:t" :name "Body"
                                                            :font-variant-id "regular"
                                                            :font-weight "600"}}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"regular" (str (:hint data))))
    (t/is (re-find #"600" (str (:hint data))))))

(t/deftest font-variant-update-typography-weight-and-style-is-blackitalic
  (let [file (-> (thf/sample-file :file1)
                 (ths/add-sample-typography :t1 :name "Old"))
        [file' _] (apply-ops file [{:op "update_typography"
                                    :typography {:id (thi/id :t1)
                                                 :font-weight "900"
                                                 :font-style "italic"}}])
        typo (get-in (:data file') [:typographies (thi/id :t1)])]
    (t/is (= "blackitalic" (:font-variant-id typo)))
    (t/is (= "900" (:font-weight typo)))
    (t/is (= "italic" (:font-style typo)))))

(t/deftest font-variant-update-typography-rejects-unknown-variant-id
  (let [file (-> (thf/sample-file :file1)
                 (ths/add-sample-typography :t1 :name "Old"))
        data (thrown-data #(compile-ops file [{:op "update_typography"
                                               :typography {:id (thi/id :t1)
                                                            :font-variant-id "900"}}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"valid font-variant-id values" (str (:hint data))))))

;; ----- Components

(t/deftest create-component-over-board
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-frame :board1))
        pid  (page-id-of file)
        board-id (thi/id :board1)
        [file' result] (apply-ops file [{:op "create_component" :page-id pid
                                         :shape-ids [board-id] :name "Button" :id "$tmp:c"}])
        comp-id (created result "$tmp:c")
        comp    (get-in (:data file') [:components comp-id])]
    (t/is (some? comp))
    (t/is (= "Button" (:name comp)))
    (t/is (= board-id (:main-instance-id comp)))
    (t/is (true? (:main-instance (shape-of file' board-id))))))

(t/deftest instantiate-component-creates-copy
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-simple-component :comp1 :root1 :child1))
        pid  (page-id-of file)
        comp-id (thi/id :comp1)
        [file' result] (apply-ops file [{:op "instantiate_component" :page-id pid
                                         :component-id comp-id :x 300 :y 0 :id "$tmp:copy"}])
        copy (shape-of file' (created result "$tmp:copy"))]
    (t/is (some? copy))
    (t/is (= comp-id (:component-id copy)))
    (t/is (close? 300 (:x copy)))))

(defn- button-component-file
  "A file with the component `Button`. Its main root is a board with the rect
  `Bg`, the text `Label` and the group `Row` over a second rect `Bg`. Returns
  the file and the id of the component."
  []
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:button"
                                         :x 0 :y 0 :width 200 :height 80}
                                        {:op "create_rect" :page-id pid :id "$tmp:bg"
                                         :parent-id "$tmp:button" :name "Bg"
                                         :x 0 :y 0 :width 200 :height 80}
                                        {:op "create_text" :page-id pid :id "$tmp:label"
                                         :parent-id "$tmp:button" :name "Label"
                                         :characters "Hi" :x 10 :y 10 :width 60 :height 20}
                                        {:op "create_rect" :page-id pid :id "$tmp:bg2"
                                         :parent-id "$tmp:button" :name "Bg"
                                         :x 100 :y 40 :width 20 :height 20}
                                        {:op "create_group" :page-id pid :id "$tmp:row"
                                         :name "Row" :child-ids ["$tmp:bg2"]}
                                        {:op "create_component" :page-id pid
                                         :shape-ids ["$tmp:button"] :name "Button"
                                         :id "$tmp:comp"}])]
    [file' (created result "$tmp:comp")]))

(t/deftest instantiate-component-overrides-text-and-fills
  (let [[file comp-id] (button-component-file)
        pid    (page-id-of file)
        fills  [{:fill-color "#ff0000" :fill-opacity 1}]
        [file' result] (apply-ops file [{:op "instantiate_component" :page-id pid
                                         :component-id comp-id :x 300 :y 0 :id "$tmp:copy"
                                         :overrides [{:name "Label" :characters "Go"}
                                                     {:path "Bg" :props {:fills fills}}]}])
        copy-id (created result "$tmp:copy")
        child   (fn [child-name]
                  (find-shape file' #(and (= child-name (:name %))
                                          (= copy-id (:parent-id %)))))]
    (t/is (= "Go" (txt/content->text (:content (child "Label")))))
    (t/is (= "#ff0000" (-> (child "Bg") :fills first :fill-color)))))

(t/deftest instantiate-component-override-rejects-ambiguous-name
  (let [[file comp-id] (button-component-file)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "instantiate_component" :page-id pid
                                               :component-id comp-id :x 300 :y 0
                                               :overrides [{:name "Bg" :characters "X"}]}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"several" (str (:hint data))))))

(t/deftest instantiate-component-override-rejects-geometry
  (let [[file comp-id] (button-component-file)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "instantiate_component" :page-id pid
                                               :component-id comp-id :x 300 :y 0
                                               :overrides [{:path "Bg" :props {:x 5}}]}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"geometry" (str (:hint data))))))

(t/deftest detach-removes-component-ref
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-simple-component-with-copy :comp1 :root1 :child1 :copy1))
        pid  (page-id-of file)
        copy-id (thi/id :copy1)
        [file' _] (apply-ops file [{:op "detach" :page-id pid :ids [copy-id]}])]
    (t/is (nil? (:component-id (shape-of file' copy-id))))))

(t/deftest swap-component-changes-component-id
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-simple-component-with-copy :comp1 :root1 :child1 :copy1)
                 (tho/add-simple-component :comp2 :root2 :child2))
        pid  (page-id-of file)
        copy-id (thi/id :copy1)
        comp2   (thi/id :comp2)
        [file' _] (apply-ops file [{:op "swap_component" :page-id pid :id copy-id
                                    :component-id comp2}])
        swapped (find-shape file' #(and (some? (:shape-ref %))
                                        (= comp2 (:component-id %))))]
    (t/is (some? swapped))))

(t/deftest reset-overrides-restores-main-values
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-simple-component-with-copy :comp1 :root1 :child1 :copy1))
        pid  (page-id-of file)
        copy-id (thi/id :copy1)
        [file' _] (apply-ops file [{:op "update_shape" :page-id pid :id copy-id
                                    :props {:opacity 0.3}}])
        [file'' _] (apply-ops file' [{:op "reset_overrides" :page-id pid :id copy-id}])]
    (t/is (close? 0.3 (:opacity (shape-of file' copy-id))))
    (t/is (not= 0.3 (:opacity (shape-of file'' copy-id))))))

(t/deftest update-main-pushes-copy-change-to-main
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-simple-component-with-copy :comp1 :root1 :child1 :copy1))
        pid  (page-id-of file)
        copy-id (thi/id :copy1)
        main-id (thi/id :root1)
        [file' _] (apply-ops file [{:op "update_shape" :page-id pid :id copy-id
                                    :props {:opacity 0.5}}
                                   {:op "update_main" :page-id pid :id copy-id}])]
    (t/is (close? 0.5 (:opacity (shape-of file' main-id))))))

(t/deftest rename-component-changes-name
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-simple-component :comp1 :root1 :child1))
        comp-id (thi/id :comp1)
        [file' _] (apply-ops file [{:op "rename_component" :component-id comp-id
                                    :name "Renamed"}])]
    (t/is (= "Renamed" (get-in (:data file') [:components comp-id :name])))))

(t/deftest delete-and-restore-component
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-simple-component :comp1 :root1 :child1))
        comp-id (thi/id :comp1)
        [file' _] (apply-ops file [{:op "delete_component" :component-id comp-id}])
        [file'' _] (apply-ops file' [{:op "restore_component" :component-id comp-id}])]
    (t/is (true? (get-in (:data file') [:components comp-id :deleted])))
    (t/is (not (get-in (:data file'') [:components comp-id :deleted])))))

(t/deftest delete-component-deletes-its-main-root
  (let [file (-> (thf/sample-file :file1)
                 (ths/add-sample-shape :rect1 :x 0 :y 0 :width 10 :height 10))
        pid  (page-id-of file)
        rect-id (thi/id :rect1)
        [file' result] (apply-ops file [{:op "create_component" :page-id pid
                                         :shape-ids [rect-id] :name "Dot" :id "$tmp:c"}])
        comp-id (created result "$tmp:c")
        [file'' _] (apply-ops file' [{:op "delete_component" :component-id comp-id}])]
    (t/is (true? (get-in (:data file'') [:components comp-id :deleted])))
    (t/is (nil? (shape-of file'' rect-id)))))

(t/deftest sync-components-updates-copies
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-simple-component-with-copy :comp1 :root1 :child1 :copy1))
        pid  (page-id-of file)
        main-id (thi/id :root1)
        copy-id (thi/id :copy1)
        [file' _] (apply-ops file [{:op "update_shape" :page-id pid :id main-id
                                    :props {:opacity 0.5}}
                                   {:op "sync_components"}])]
    (t/is (close? 0.5 (:opacity (shape-of file' copy-id))))))

(t/deftest sync-components-without-ids-syncs-only-touched-mains
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-simple-component-with-copy :comp1 :root1 :child1 :copy1)
                 (tho/add-simple-component-with-copy :comp2 :root2 :child2 :copy2))
        pid  (page-id-of file)
        ;; Edits comp2's main in an earlier call, so its copy is out of sync.
        [file-a _] (apply-ops file [{:op "update_shape" :page-id pid :id (thi/id :root2)
                                     :props {:opacity 0.7}}])
        copy2-before (shape-of file-a (thi/id :copy2))
        [file-b _] (apply-ops file-a [{:op "update_shape" :page-id pid :id (thi/id :root1)
                                       :props {:opacity 0.5}}
                                      {:op "sync_components"}])]
    (t/is (close? 0.5 (:opacity (shape-of file-b (thi/id :copy1)))))
    (t/is (= copy2-before (shape-of file-b (thi/id :copy2))))))

;; ----- Colors and typographies

(t/deftest create-color-adds-library-color
  (let [file (thf/sample-file :file1)
        [file' result] (apply-ops file [{:op "create_color"
                                         :color {:id "$tmp:c" :name "Brand"
                                                 :color "#ff0000" :opacity 1}}])
        color-id (created result "$tmp:c")]
    (t/is (uuid? color-id))
    (t/is (= "Brand" (get-in (:data file') [:colors color-id :name])))
    (t/is (= "#ff0000" (get-in (:data file') [:colors color-id :color])))))

(t/deftest update-color-renames
  (let [file (-> (thf/sample-file :file1)
                 (ths/add-sample-library-color :c1 :name "Old"))
        [file' _] (apply-ops file [{:op "update_color"
                                    :color {:id (thi/id :c1) :name "New"}}])]
    (t/is (= "New" (get-in (:data file') [:colors (thi/id :c1) :name])))))

(t/deftest delete-color-removes-color
  (let [file (-> (thf/sample-file :file1)
                 (ths/add-sample-library-color :c1 :name "Old"))
        [file' _] (apply-ops file [{:op "delete_color" :id (thi/id :c1)}])]
    (t/is (nil? (get-in (:data file') [:colors (thi/id :c1)])))))

(t/deftest create-typography-adds-typography
  (let [file (thf/sample-file :file1)
        [file' result] (apply-ops file [{:op "create_typography"
                                         :typography {:id "$tmp:t" :name "Body"
                                                      :font-family "sourcesanspro"
                                                      :font-size "14"}}])
        typo-id (created result "$tmp:t")]
    (t/is (= "Body" (get-in (:data file') [:typographies typo-id :name])))))

(t/deftest update-typography-renames
  (let [file (-> (thf/sample-file :file1)
                 (ths/add-sample-typography :t1 :name "Old"))
        [file' _] (apply-ops file [{:op "update_typography"
                                    :typography {:id (thi/id :t1) :name "New"}}])]
    (t/is (= "New" (get-in (:data file') [:typographies (thi/id :t1) :name])))))

(t/deftest delete-typography-removes-typography
  (let [file (-> (thf/sample-file :file1)
                 (ths/add-sample-typography :t1 :name "Old"))
        [file' _] (apply-ops file [{:op "delete_typography" :id (thi/id :t1)}])]
    (t/is (nil? (get-in (:data file') [:typographies (thi/id :t1)])))))

;; ----- Tokens

(t/deftest create-token-set-adds-set
  (let [file (tokens-file)
        [file' result] (apply-ops file [{:op "create_token_set" :id "$tmp:s" :name "Extra"}])
        lib (get-in file' [:data :tokens-lib])]
    (t/is (some? (ctob/get-set lib (created result "$tmp:s"))))
    (t/is (= "Extra" (ctob/get-name (ctob/get-set-by-name lib "Extra"))))))

(t/deftest update-token-set-renames
  (let [file (tokens-file)
        [file' _] (apply-ops file [{:op "update_token_set" :id (thi/id :set-base) :name "Foundation"}])
        lib (get-in file' [:data :tokens-lib])]
    (t/is (= "Foundation" (ctob/get-name (ctob/get-set lib (thi/id :set-base)))))))

(t/deftest delete-token-set-removes-set
  (let [file (tokens-file)
        [file' _] (apply-ops file [{:op "delete_token_set" :id (thi/id :set-base)}])
        lib (get-in file' [:data :tokens-lib])]
    (t/is (nil? (ctob/get-set lib (thi/id :set-base))))))

(t/deftest move-token-set-reorders-sets
  (let [file (tokens-file)
        [file' _] (apply-ops file [{:op "move_token_set" :id (thi/id :set-base)
                                    :before-id (thi/id :set-core)}])
        lib (get-in file' [:data :tokens-lib])]
    (t/is (= ["Base" "Core"] (vec (ctob/get-set-names lib))))))

(t/deftest move-token-set-without-before-goes-to-top-level
  (let [file (tokens-file)
        [file' _] (apply-ops file [{:op "create_token_set" :id "$tmp:in" :name "Mode/Inner"}])
        [file'' _] (apply-ops file' [{:op "move_token_set" :id (thi/id :set-core)}])
        lib (get-in file'' [:data :tokens-lib])]
    (t/is (some? (ctob/get-set-by-name lib "Core")))
    (t/is (nil? (ctob/get-set-by-name lib "Mode/Core")))
    (t/is (= ["Base" "Mode/Inner" "Core"] (vec (ctob/get-set-names lib))))))

(t/deftest move-token-set-out-of-group-to-top-level
  (let [file (tokens-file)
        [file' result] (apply-ops file [{:op "create_token_set" :id "$tmp:in" :name "Mode/Inner"}])
        [file'' _] (apply-ops file' [{:op "move_token_set" :id (created result "$tmp:in")}])
        lib (get-in file'' [:data :tokens-lib])]
    (t/is (some? (ctob/get-set-by-name lib "Inner")))
    (t/is (nil? (ctob/get-set-by-name lib "Mode/Inner")))))

(t/deftest create-token-adds-token-to-set
  (let [file (tokens-file)
        [file' result] (apply-ops file [{:op "create_token" :set-id (thi/id :set-core)
                                         :id "$tmp:tok" :type "sizing" :name "gap" :value 10}])
        lib (get-in file' [:data :tokens-lib])
        tok (ctob/get-token lib (thi/id :set-core) (created result "$tmp:tok"))]
    (t/is (= "gap" (:name tok)))
    (t/is (= :sizing (:type tok)))
    (t/is (= 10 (:value tok)))))

(t/deftest update-token-changes-value
  (let [file (tokens-file)
        [file' result] (apply-ops file [{:op "create_token" :set-id (thi/id :set-core)
                                         :id "$tmp:tok" :type "sizing" :name "gap" :value 10}])
        tok-id (created result "$tmp:tok")
        [file'' _] (apply-ops file' [{:op "update_token" :set-id (thi/id :set-core)
                                      :id tok-id :value 20}])
        lib (get-in file'' [:data :tokens-lib])]
    (t/is (= 20 (:value (ctob/get-token lib (thi/id :set-core) tok-id))))))

(t/deftest delete-token-removes-token
  (let [file (tokens-file)
        [file' result] (apply-ops file [{:op "create_token" :set-id (thi/id :set-core)
                                         :id "$tmp:tok" :type "sizing" :name "gap" :value 10}])
        tok-id (created result "$tmp:tok")
        [file'' _] (apply-ops file' [{:op "delete_token" :set-id (thi/id :set-core) :id tok-id}])
        lib (get-in file'' [:data :tokens-lib])]
    (t/is (nil? (ctob/get-token lib (thi/id :set-core) tok-id)))))

(t/deftest create-theme-adds-theme
  (let [file (tokens-file)
        [file' result] (apply-ops file [{:op "create_theme" :id "$tmp:th" :group "Mode"
                                         :name "Dark" :sets ["Core"]}])
        lib   (get-in file' [:data :tokens-lib])
        theme (ctob/get-theme lib (created result "$tmp:th"))]
    (t/is (= "Dark" (:name theme)))
    (t/is (= "Mode" (:group theme)))
    (t/is (contains? (:sets theme) "Core"))))

(t/deftest update-theme-renames
  (let [file (theme-file)
        [file' _] (apply-ops file [{:op "update_theme" :id (thi/id :theme-light) :name "Bright"}])
        lib (get-in file' [:data :tokens-lib])]
    (t/is (= "Bright" (:name (ctob/get-theme lib (thi/id :theme-light)))))))

(t/deftest delete-theme-removes-theme
  (let [file (theme-file)
        [file' _] (apply-ops file [{:op "delete_theme" :id (thi/id :theme-light)}])
        lib (get-in file' [:data :tokens-lib])]
    (t/is (nil? (ctob/get-theme lib (thi/id :theme-light))))))

(t/deftest activate-theme-marks-theme-active
  (let [file (theme-file)
        [file' _] (apply-ops file [{:op "activate_theme" :id (thi/id :theme-light)}])]
    (t/is (true? (ctos/theme-active? (tht/get-tokens-status file') (thi/id :theme-light))))))

(t/deftest deactivate-theme-marks-theme-inactive
  (let [file (theme-file :active? true)
        [file' _] (apply-ops file [{:op "deactivate_theme" :id (thi/id :theme-light)}])]
    (t/is (false? (ctos/theme-active? (tht/get-tokens-status file') (thi/id :theme-light))))))

(t/deftest toggle-set-switches-set-status
  (let [file (theme-file)
        [file' _] (apply-ops file [{:op "toggle_set" :set-id (thi/id :set-core)}])]
    (t/is (true? (ctos/set-active? (tht/get-tokens-status file') (thi/id :set-core))))))

(t/deftest set-tokens-status-sets-theme-and-set
  (let [file (theme-file)
        [file' _] (apply-ops file [{:op "set_tokens_status"
                                    :theme-ids [(thi/id :theme-light)]
                                    :set-ids [(thi/id :set-core)]}])
        status (tht/get-tokens-status file')]
    (t/is (true? (ctos/theme-active? status (thi/id :theme-light))))
    (t/is (true? (ctos/set-active? status (thi/id :set-core))))))

(t/deftest set-tokens-source-to-none
  (let [file (tokens-file)
        [file' _] (apply-ops file [{:op "set_tokens_source" :library-id nil}])]
    (t/is (nil? (tht/get-tokens-source file')))))

(t/deftest import-tokens-dtcg-merge-adds-set-and-token
  (let [file (tokens-file)
        [file' _] (apply-ops file [{:op "import_tokens_dtcg" :json dtcg-core :mode "merge"}])
        lib (get-in file' [:data :tokens-lib])
        tok (ctob/get-token-by-name lib "Core" "gap")]
    (t/is (some? (ctob/get-set-by-name lib "Base")))
    (t/is (some? tok))
    (t/is (= 10 (:value tok)))))

(t/deftest import-tokens-dtcg-replace-drops-missing-sets
  (let [file (tokens-file)
        [file' _] (apply-ops file [{:op "import_tokens_dtcg" :json dtcg-core :mode "replace"}])
        lib (get-in file' [:data :tokens-lib])]
    (t/is (nil? (ctob/get-set-by-name lib "Base")))
    (t/is (some? (ctob/get-token-by-name lib "Core" "gap")))))

(t/deftest import-tokens-dtcg-metadata-sets-themes-sets-and-order
  (let [file (tokens-file)
        [file' _] (apply-ops file [{:op "import_tokens_dtcg" :json dtcg-metadata :mode "merge"}])
        lib    (get-in file' [:data :tokens-lib])
        status (tht/get-tokens-status file')
        light  (ctob/get-theme-by-name lib "Mode" "Light")]
    (t/is (= ["Base" "Core"] (vec (ctob/get-set-names lib))))
    (t/is (some? light))
    (t/is (true? (ctos/theme-active? status (ctob/get-id light))))
    (t/is (true? (ctos/set-active? status (thi/id :set-core))))
    (t/is (false? (ctos/set-active? status (thi/id :set-base))))))

(t/deftest set-base-font-size-stores-value
  (let [file (thf/sample-file :file1)
        [file' _] (apply-ops file [{:op "set_base_font_size" :value "16"}])]
    (t/is (= "16" (ctf/get-base-font-size (:data file'))))))

(t/deftest apply-token-sets-applied-token-and-value
  (let [file (brand-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        [file' _] (apply-ops file [{:op "apply_token" :page-id pid :shape-ids [r1]
                                    :token-name "brand" :attributes ["fill"]
                                    :resolved-value "#ff0000"}])
        rect (shape-of file' r1)]
    (t/is (= "brand" (get-in rect [:applied-tokens :fill])))
    (t/is (= "#ff0000" (-> rect :fills first :fill-color)))))

(t/deftest unapply-token-clears-applied-token
  (let [file (brand-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        [file' _] (apply-ops file [{:op "apply_token" :page-id pid :shape-ids [r1]
                                    :token-name "brand" :attributes ["fill"]
                                    :resolved-value "#ff0000"}])
        [file'' _] (apply-ops file' [{:op "unapply_token" :page-id pid :shape-ids [r1]
                                      :token-name "brand" :attributes ["fill"]}])]
    (t/is (nil? (get-in (shape-of file'' r1) [:applied-tokens :fill])))))

(t/deftest unapply-token-keeps-the-value
  (let [file (brand-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        file' (shape-with-token file r1 "brand" ["fill"] "#ff0000")
        [file'' _] (apply-ops file' [{:op "unapply_token" :page-id pid :shape-ids [r1]
                                      :token-name "brand" :attributes ["fill"]}])
        rect (shape-of file'' r1)]
    (t/is (nil? (get-in rect [:applied-tokens :fill])))
    (t/is (= "#ff0000" (-> rect :fills first :fill-color)))))

(t/deftest apply-token-padding-sets-layout-padding
  (let [file (file-with-token "pad" "spacing" 12)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 0 :y 0 :width 200 :height 100}
                                        {:op "set_flex_layout" :page-id pid :id "$tmp:b"
                                         :layout-flex-dir "row"}])
        board-id (created result "$tmp:b")
        board    (shape-of (shape-with-token file' board-id "pad" ["p1" "p2" "p3" "p4"] 12)
                           board-id)]
    (doseq [side [:p1 :p2 :p3 :p4]]
      (t/is (= 12 (get-in board [:layout-padding side]))))))

(t/deftest apply-token-gap-sets-layout-gap
  (let [file (file-with-token "gap8" "spacing" 8)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 0 :y 0 :width 200 :height 100}
                                        {:op "set_flex_layout" :page-id pid :id "$tmp:b"
                                         :layout-flex-dir "row"}])
        board-id (created result "$tmp:b")
        board    (shape-of (shape-with-token file' board-id "gap8" ["row-gap" "column-gap"] 8)
                           board-id)]
    (t/is (= 8 (get-in board [:layout-gap :row-gap])))
    (t/is (= 8 (get-in board [:layout-gap :column-gap])))))

(t/deftest apply-token-radius-sets-every-corner
  (let [file (file-with-token "radius" "border-radius" 8)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_rect" :page-id pid :id "$tmp:r"
                                         :x 0 :y 0 :width 40 :height 40}])
        rect-id (created result "$tmp:r")
        rect    (shape-of (shape-with-token file' rect-id "radius" ["r1" "r2" "r3" "r4"] 8)
                          rect-id)]
    (doseq [corner [:r1 :r2 :r3 :r4]]
      (t/is (= 8 (get rect corner))))))

(t/deftest apply-token-stroke-width-sets-first-stroke
  (let [file (file-with-token "stroke3" "stroke-width" 3)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_rect" :page-id pid :id "$tmp:r"
                                         :x 0 :y 0 :width 40 :height 40}])
        rect-id (created result "$tmp:r")
        rect    (shape-of (shape-with-token file' rect-id "stroke3"
                                            ["stroke-width-top" "stroke-width-right"
                                             "stroke-width-bottom" "stroke-width-left"]
                                            3)
                          rect-id)]
    (t/is (= 3 (:stroke-width (first (:strokes rect)))))))

(t/deftest apply-token-opacity-sets-opacity
  (let [file (file-with-token "half" "opacity" 0.5)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_rect" :page-id pid :id "$tmp:r"
                                         :x 0 :y 0 :width 40 :height 40}])
        rect-id (created result "$tmp:r")
        rect    (shape-of (shape-with-token file' rect-id "half" ["opacity"] 0.5) rect-id)]
    (t/is (= 0.5 (:opacity rect)))))

(t/deftest apply-token-rotation-rotates-shape
  (let [file (file-with-token "turn" "rotation" 45)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_rect" :page-id pid :id "$tmp:r"
                                         :x 0 :y 0 :width 40 :height 40}])
        rect-id (created result "$tmp:r")
        rect    (shape-of (shape-with-token file' rect-id "turn" ["rotation"] 45) rect-id)]
    (t/is (close? 45 (:rotation rect)))))

(t/deftest apply-token-sizing-resizes-width-and-keeps-selrect
  (let [file (file-with-token "wide" "sizing" 50)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_rect" :page-id pid :id "$tmp:r"
                                         :x 0 :y 0 :width 10 :height 10}])
        rect-id (created result "$tmp:r")
        rect    (shape-of (shape-with-token file' rect-id "wide" ["width"] 50) rect-id)]
    (assert-box rect 0 0 50 10)))

(t/deftest apply-token-font-size-sets-text-nodes
  (let [file (file-with-token "body" "font-size" 24)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_text" :page-id pid :id "$tmp:t"
                                         :characters "Hello" :font-size 14
                                         :font-family "sourcesanspro" :grow-type "fixed"
                                         :x 0 :y 0 :width 200 :height 40}])
        text-id (created result "$tmp:t")
        text    (shape-of (shape-with-token file' text-id "body" ["font-size"] 24) text-id)
        nodes   (txt/node-seq txt/is-text-node? (:content text))]
    (t/is (seq nodes))
    (doseq [node nodes]
      (t/is (= "24" (:font-size node))))))

(t/deftest apply-token-color-sets-stroke-color-and-opacity
  (let [file (file-with-token "edge" "color" "rgba(0, 255, 0, 0.5)")
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_rect" :page-id pid :id "$tmp:r"
                                         :x 0 :y 0 :width 40 :height 40}])
        rect-id (created result "$tmp:r")
        rect    (shape-of (shape-with-token file' rect-id "edge" ["stroke-color"]
                                            "rgba(0, 255, 0, 0.5)")
                          rect-id)
        stroke  (first (:strokes rect))]
    (t/is (= "#00ff00" (:stroke-color stroke)))
    (t/is (close? 0.5 (:stroke-opacity stroke)))))

(t/deftest create-token-with-invalid-value-is-refused
  (let [file (tokens-file)
        data (thrown-data #(compile-ops file [{:op "create_token" :set-id (thi/id :set-core)
                                               :type "opacity" :name "too-much" :value 2}]))]
    (t/is (= :mcp-invalid-operation (:code data)))))

(t/deftest create-token-with-duplicate-name-is-refused
  (let [file (tokens-file)
        [file' _] (apply-ops file [{:op "create_token" :set-id (thi/id :set-core)
                                    :type "sizing" :name "gap" :value 10}])
        create-data (thrown-data #(compile-ops file' [{:op "create_token" :set-id (thi/id :set-core)
                                                       :type "sizing" :name "gap" :value 20}]))
        [file'' result] (apply-ops file' [{:op "create_token" :set-id (thi/id :set-core)
                                           :id "$tmp:pad" :type "sizing" :name "pad" :value 4}])
        rename-data (thrown-data #(compile-ops file'' [{:op "update_token" :set-id (thi/id :set-core)
                                                        :id (created result "$tmp:pad")
                                                        :name "gap"}]))]
    (t/is (= :mcp-invalid-operation (:code create-data)))
    (t/is (= :mcp-invalid-operation (:code rename-data)))))

(t/deftest create-token-accepts-dtcg-type
  (let [file (tokens-file)
        [file' result] (apply-ops file [{:op "create_token" :set-id (thi/id :set-core)
                                         :id "$tmp:radius" :type "borderRadius"
                                         :name "corner" :value 4}
                                        {:op "create_token" :set-id (thi/id :set-core)
                                         :id "$tmp:size" :type "fontSizes"
                                         :name "body" :value 14}])
        lib (get-in file' [:data :tokens-lib])]
    (t/is (= :border-radius
             (:type (ctob/get-token lib (thi/id :set-core) (created result "$tmp:radius")))))
    (t/is (= :font-size
             (:type (ctob/get-token lib (thi/id :set-core) (created result "$tmp:size")))))))

(t/deftest create-token-rejects-unknown-type
  (let [file (tokens-file)
        data (thrown-data #(compile-ops file [{:op "create_token" :set-id (thi/id :set-core)
                                               :type "notAType" :name "x" :value 1}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"borderRadius" (str (:hint data))))
    (t/is (re-find #"sizing" (str (:hint data))))))

(t/deftest create-token-set-active-enables-set
  (let [file (tokens-file)
        [file' result] (apply-ops file [{:op "create_token_set" :id "$tmp:s"
                                         :name "Extra" :active true}])]
    (t/is (true? (ctos/set-active? (tht/get-tokens-status file')
                                   (created result "$tmp:s"))))))

;; ----- Plugin data

(t/deftest set-plugin-data-on-shape
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        [file' _] (apply-ops file [{:op "set_plugin_data" :target "shape" :id r1
                                    :page-id pid :namespace "test.ns" :key "k" :value "v"}])]
    (t/is (= "v" (get-in (shape-of file' r1) [:plugin-data (keyword "test.ns") "k"])))))

(t/deftest set-plugin-data-on-page
  (let [file (thf/sample-file :file1 :page-label :page1)
        [file' _] (apply-ops file [{:op "set_plugin_data" :target "page" :id (thi/id :page1)
                                    :namespace "test.ns" :key "k" :value "v"}])]
    (t/is (= "v" (get-in (:data file') [:pages-index (thi/id :page1)
                                        :plugin-data (keyword "test.ns") "k"])))))

(t/deftest set-plugin-data-on-file
  (let [file (thf/sample-file :file1)
        [file' _] (apply-ops file [{:op "set_plugin_data" :target "file"
                                    :namespace "test.ns" :key "k" :value "v"}])]
    (t/is (= "v" (get-in (:data file') [:plugin-data (keyword "test.ns") "k"])))))

;; ----- Interactions, flows and guides

(t/deftest add-and-remove-interaction
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        r2   (thi/id :rect2)
        [file' _] (apply-ops file [{:op "add_interaction" :page-id pid :id r1
                                    :interaction {:event-type :click
                                                  :action-type :navigate
                                                  :destination r2}}])
        [file'' _] (apply-ops file' [{:op "remove_interaction" :page-id pid :id r1 :index 0}])]
    (t/is (= 1 (count (:interactions (shape-of file' r1)))))
    (t/is (empty? (:interactions (shape-of file'' r1))))))

(t/deftest create-and-remove-flow
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-frame :board1))
        pid  (page-id-of file)
        board-id (thi/id :board1)
        [file' result] (apply-ops file [{:op "create_flow" :page-id pid :id "$tmp:f"
                                         :name "Start" :starting-frame board-id}])
        flow-id (created result "$tmp:f")
        [file'' _] (apply-ops file' [{:op "remove_flow" :page-id pid :id flow-id}])]
    (t/is (= "Start" (get-in (thf/current-page file') [:flows flow-id :name])))
    (t/is (nil? (get-in (thf/current-page file'') [:flows flow-id])))))

(t/deftest add-and-remove-ruler-guide
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "add_ruler_guide" :page-id pid :id "$tmp:g"
                                         :axis "vertical" :position 50}])
        guide-id (created result "$tmp:g")
        guide    (get-in (thf/current-page file') [:guides guide-id])
        [file'' _] (apply-ops file' [{:op "remove_ruler_guide" :page-id pid :id guide-id}])]
    (t/is (= :x (:axis guide)))
    (t/is (= 50 (:position guide)))
    (t/is (nil? (get-in (thf/current-page file'') [:guides guide-id])))))

(t/deftest set-board-grid-guides-sets-grids
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-frame :board1))
        pid  (page-id-of file)
        board-id (thi/id :board1)
        grids [{:type :column :display true
                :params {:size 10 :color {:color "#b1b2b5" :opacity 0.2}}}]
        [file' _] (apply-ops file [{:op "set_board_grid_guides" :page-id pid :id board-id
                                    :grids grids}])]
    (t/is (= grids (:grids (shape-of file' board-id))))))

;; ----- Align and distribute

(t/deftest align-hleft-two-rects
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        r2   (thi/id :rect2)
        [file' _] (apply-ops file [{:op "align" :page-id pid :ids [r1 r2] :axis "hleft"}])]
    (t/is (close? 10 (:x (shape-of file' r1))))
    (t/is (close? 10 (:x (shape-of file' r2))))))

(t/deftest distribute-horizontal-three-rects
  (let [file (-> (thf/sample-file :file1)
                 (ths/add-sample-shape :rect1 :x 0 :y 0 :width 10 :height 10)
                 (ths/add-sample-shape :rect2 :x 20 :y 0 :width 10 :height 10)
                 (ths/add-sample-shape :rect3 :x 100 :y 0 :width 10 :height 10))
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        r2   (thi/id :rect2)
        r3   (thi/id :rect3)
        [file' _] (apply-ops file [{:op "distribute" :page-id pid :ids [r1 r2 r3]
                                    :axis "horizontal"}])
        s1 (shape-of file' r1)
        s2 (shape-of file' r2)
        s3 (shape-of file' r3)
        gap1 (- (:x s2) (+ (:x s1) (:width s1)))
        gap2 (- (:x s3) (+ (:x s2) (:width s2)))]
    (t/is (close? gap1 gap2))))

(t/deftest distribute-horizontal-puts-equal-gaps-between-unequal-rects
  (let [file (-> (thf/sample-file :file1)
                 (ths/add-sample-shape :rect1 :x 0 :y 0 :width 10 :height 10)
                 (ths/add-sample-shape :rect2 :x 20 :y 0 :width 10 :height 10)
                 (ths/add-sample-shape :rect3 :x 100 :y 0 :width 10 :height 10))
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        r2   (thi/id :rect2)
        r3   (thi/id :rect3)
        [file' _] (apply-ops file [{:op "distribute" :page-id pid :ids [r1 r2 r3]
                                    :axis "horizontal"}])
        s1 (shape-of file' r1)
        s2 (shape-of file' r2)
        s3 (shape-of file' r3)
        gap1 (- (:x s2) (+ (:x s1) (:width s1)))
        gap2 (- (:x s3) (+ (:x s2) (:width s2)))]
    (t/is (close? 0 (:x s1)))
    (t/is (close? 100 (:x s3)))
    (t/is (close? 50 (:x s2)))
    (t/is (close? 40 gap1))
    (t/is (close? 40 gap2))))

(t/deftest align-hleft-moves-every-shape-to-min-x
  (let [file (-> (thf/sample-file :file1)
                 (ths/add-sample-shape :rect1 :x 10 :y 0 :width 20 :height 10)
                 (ths/add-sample-shape :rect2 :x 50 :y 20 :width 30 :height 10)
                 (ths/add-sample-shape :rect3 :x 30 :y 40 :width 10 :height 10))
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        r2   (thi/id :rect2)
        r3   (thi/id :rect3)
        [file' _] (apply-ops file [{:op "align" :page-id pid :ids [r1 r2 r3] :axis "hleft"}])]
    (t/is (close? 10 (:x (shape-of file' r1))))
    (t/is (close? 10 (:x (shape-of file' r2))))
    (t/is (close? 10 (:x (shape-of file' r3))))
    (t/is (close? 20 (:y (shape-of file' r2))))))

;; ----- Handles, summary and errors

(t/deftest create-shapes-with-handles-across-ops
  (let [file   (thf/sample-file :file1)
        pid    (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 0 :y 0 :width 100 :height 100}
                                        {:op "create_rect" :page-id pid :id "$tmp:r"
                                         :parent-id "$tmp:b" :x 10 :y 10 :width 10 :height 10}
                                        {:op "move_shapes" :page-id pid :ids ["$tmp:r"]
                                         :parent-id "$tmp:b" :index 0}])]
    (t/is (= #{"$tmp:b" "$tmp:r"} (set (keys (:created-ids result)))))
    (t/is (= (created result "$tmp:b")
             (:parent-id (shape-of file' (created result "$tmp:r")))))))

(t/deftest result-summary-counts-ops-and-changes
  (let [file   (thf/sample-file :file1)
        pid    (page-id-of file)
        result (compile-ops file [{:op "create_rect" :page-id pid :x 0 :y 0 :width 1 :height 1}
                                  {:op "create_rect" :page-id pid :x 5 :y 0 :width 1 :height 1}])]
    (t/is (= 2 (get-in result [:summary :op-count])))
    (t/is (= (count (:changes result)) (get-in result [:summary :change-count])))
    (t/is (contains? (get-in result [:summary :change-types]) :add-obj))
    (t/is (= #{pid} (:touched-page-ids result)))))

(t/deftest unknown-handle-is-rejected
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_rect" :page-id pid
                                               :parent-id "$tmp:nope"
                                               :x 0 :y 0 :width 1 :height 1}]))]
    (t/is (= :mcp-unknown-id (:code data)))
    (t/is (= 0 (:index data)))))

(t/deftest unknown-real-id-is-rejected
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "update_shape" :page-id pid
                                               :id (uuid/next) :props {:opacity 0.5}}]))]
    (t/is (= :mcp-unknown-id (:code data)))))

(t/deftest missing-required-param-is-rejected
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_rect" :page-id pid
                                               :y 0 :width 1 :height 1}]))]
    (t/is (= :mcp-invalid-operation (:code data)))))

(t/deftest unknown-op-name-is-rejected
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_foo" :page-id pid}]))]
    (t/is (= :mcp-invalid-operation (:code data)))))

(t/deftest duplicate-handle-is-rejected
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_rect" :page-id pid :id "$tmp:r"
                                               :x 0 :y 0 :width 1 :height 1}
                                              {:op "create_rect" :page-id pid :id "$tmp:r"
                                               :x 0 :y 0 :width 1 :height 1}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (= 1 (:index data)))))

(t/deftest create-with-existing-literal-id-is-rejected
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        data (thrown-data #(compile-ops file [{:op "create_rect" :page-id pid :id r1
                                               :x 0 :y 0 :width 1 :height 1}]))]
    (t/is (= :validation (:type data)))
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (some? (re-find #"already exists" (str (:hint data)))))))

(t/deftest unknown-id-error-carries-index-and-op
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_rect" :page-id pid
                                               :x 0 :y 0 :width 1 :height 1}
                                              {:op "update_shape" :page-id pid
                                               :id (uuid/next) :props {:opacity 0.5}}]))]
    (t/is (= :validation (:type data)))
    (t/is (= :mcp-unknown-id (:code data)))
    (t/is (= 1 (:index data)))
    (t/is (= "update_shape" (:op data)))))

(t/deftest invalid-operation-reports-its-index
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_rect" :page-id pid
                                               :x 0 :y 0 :width 1 :height 1}
                                              {:op "create_rect"}]))]
    (t/is (= :validation (:type data)))
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (= 1 (:index data)))
    (t/is (= "create_rect" (:op data)))))

(t/deftest compile-operations-reports-op-ranges
  (let [file   (thf/sample-file :file1)
        pid    (page-id-of file)
        result (compile-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                   :x 0 :y 0 :width 300 :height 300}
                                  {:op "create_rect" :page-id pid :id "$tmp:r"
                                   :parent-id "$tmp:b" :x 10 :y 10 :width 20 :height 20}
                                  {:op "update_shape" :page-id pid :id "$tmp:r"
                                   :props {:x 50 :y 60}}])
        changes (:changes result)
        ranges  (:op-ranges result)
        [board-range rect-range move-range] ranges
        board-id (created result "$tmp:b")
        rect-id  (created result "$tmp:r")]
    (t/is (= 3 (count ranges)))
    (t/is (= 0 (first board-range)))
    (t/is (= (second board-range) (first rect-range)))
    (t/is (= (second rect-range) (first move-range)))
    (t/is (<= (second move-range) (count changes)))
    (t/is (some #(and (= :add-obj (:type %)) (= board-id (:id %)))
                (subvec changes (first board-range) (second board-range))))
    (t/is (some #(and (= :add-obj (:type %)) (= rect-id (:id %)))
                (subvec changes (first rect-range) (second rect-range))))
    (t/is (some #(and (= :mod-obj (:type %)) (= rect-id (:id %)))
                (subvec changes (first move-range) (second move-range))))))

;; ----- Map params and value checks

(t/deftest create-props-with-structural-key-is-refused
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_rect" :page-id pid
                                               :x 0 :y 0 :width 1 :height 1
                                               :props {:id (uuid/next)}}]))]
    (t/is (= :validation (:type data)))
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (some? (re-find #"structural key :id" (str (:hint data)))))))

(t/deftest create-props-with-invalid-value-is-refused
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_rect" :page-id pid
                                               :x 0 :y 0 :width 1 :height 1
                                               :props {:opacity "abc"}}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (= 0 (:index data)))))

(t/deftest update-shape-decodes-blend-mode-enum
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        [file' _] (apply-ops file [{:op "update_shape" :page-id pid :id r1
                                    :props {:blend-mode "multiply"}}])]
    (t/is (= :multiply (:blend-mode (shape-of file' r1))))))

(t/deftest add-interaction-decodes-enums
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        r2   (thi/id :rect2)
        [file' _] (apply-ops file [{:op "add_interaction" :page-id pid :id r1
                                    :interaction {:event-type "click"
                                                  :action-type "navigate"
                                                  :destination r2}}])
        interaction (first (:interactions (shape-of file' r1)))]
    (t/is (= :click (:event-type interaction)))
    (t/is (= :navigate (:action-type interaction)))))

(t/deftest update-shape-decodes-stroke-enums
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        [file' _] (apply-ops file [{:op "update_shape" :page-id pid :id r1
                                    :props {:strokes [{:stroke-style "dashed"
                                                       :stroke-alignment "inner"
                                                       :stroke-width 2
                                                       :stroke-color "#000000"
                                                       :stroke-opacity 1}]}}])
        stroke (first (:strokes (shape-of file' r1)))]
    (t/is (= :dashed (:stroke-style stroke)))
    (t/is (= :inner (:stroke-alignment stroke)))))

(def ^:private solid-inner-stroke
  {:stroke-style "solid"
   :stroke-alignment "inner"
   :stroke-width 2
   :stroke-color "#000000"
   :stroke-opacity 1})

(def ^:private drop-shadow
  {:id (str (uuid/next))
   :style "drop-shadow"
   :offset-x 2
   :offset-y 4
   :blur 4
   :spread 0
   :hidden false
   :color {:color "#000000" :opacity 0.5}})

(t/deftest create-rect-props-decode-solid-inner-stroke
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_rect" :page-id pid :id "$tmp:r"
                                         :x 0 :y 0 :width 40 :height 40
                                         :props {:strokes [solid-inner-stroke]}}])
        rect-id (created result "$tmp:r")
        stroke  (first (:strokes (shape-of file' rect-id)))]
    (t/is (= :solid (:stroke-style stroke)))
    (t/is (= :inner (:stroke-alignment stroke)))))

(t/deftest update-shape-decodes-solid-inner-stroke
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        [file' _] (apply-ops file [{:op "update_shape" :page-id pid :id r1
                                    :props {:strokes [solid-inner-stroke]}}])
        stroke (first (:strokes (shape-of file' r1)))]
    (t/is (= :solid (:stroke-style stroke)))
    (t/is (= :inner (:stroke-alignment stroke)))))

(t/deftest create-rect-props-decode-shadow
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_rect" :page-id pid :id "$tmp:r"
                                         :x 0 :y 0 :width 40 :height 40
                                         :props {:shadow [drop-shadow]}}])
        rect-id (created result "$tmp:r")
        shadow  (first (:shadow (shape-of file' rect-id)))]
    (t/is (= :drop-shadow (:style shadow)))
    (t/is (= 4 (:offset-y shadow)))
    (t/is (= "#000000" (get-in shadow [:color :color])))))

(t/deftest update-shape-decodes-shadow
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        [file' _] (apply-ops file [{:op "update_shape" :page-id pid :id r1
                                    :props {:shadow [drop-shadow]}}])
        shadow (first (:shadow (shape-of file' r1)))]
    (t/is (= :drop-shadow (:style shadow)))
    (t/is (= 4 (:offset-y shadow)))))

(t/deftest set-grid-layout-zero-flex-track-is-refused
  (let [file (board-with-children-file)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "set_grid_layout" :page-id pid
                                               :id (thi/id :board1)
                                               :layout-grid-rows [{:type "flex" :value 0}]}]))]
    (t/is (= :mcp-invalid-operation (:code data)))))

(t/deftest set-grid-layout-percent-track-without-value-is-refused
  (let [file (board-with-children-file)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "set_grid_layout" :page-id pid
                                               :id (thi/id :board1)
                                               :layout-grid-columns [{:type "percent"}]}]))]
    (t/is (= :mcp-invalid-operation (:code data)))))

(t/deftest set-grid-layout-auto-track-without-children
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-frame :board1 :x 0 :y 0 :width 300 :height 100))
        pid  (page-id-of file)
        bid  (thi/id :board1)
        ops  [{:op "set_grid_layout" :page-id pid :id bid
               :layout-grid-columns [{:type "auto"}]}
              {:op "set_grid_layout" :page-id pid :id bid
               :layout-grid-rows [{:type "flex" :value 1}]
               :layout-grid-columns [{:type "auto"}]}
              {:op "set_grid_layout" :page-id pid :id bid
               :layout-grid-columns [{:type "percent" :value 50}]}
              {:op "set_grid_layout" :page-id pid :id bid
               :layout-grid-columns [{:type "fixed" :value 100}]}]]
    (doseq [op ops]
      (t/is (nil? (thrown-data #(compile-ops file [op])))))
    (let [[file' _] (apply-ops file [(first ops)])
          board (shape-of file' bid)]
      (t/is (= :grid (:layout board)))
      (t/is (= [:auto] (mapv :type (:layout-grid-columns board)))))))

(t/deftest set-grid-layout-auto-track-with-children
  (let [file (stacked-board-file)
        pid  (page-id-of file)
        bid  (thi/id :board1)
        r1   (thi/id :rect1)
        r2   (thi/id :rect2)
        [file' _] (apply-ops file [{:op "set_grid_layout" :page-id pid :id bid
                                    :layout-grid-rows [{:type "flex" :value 1}
                                                       {:type "flex" :value 1}]
                                    :layout-grid-columns [{:type "auto"}]}
                                   {:op "set_grid_cell" :page-id pid :grid-id bid
                                    :child-id r1 :row 1 :column 1}
                                   {:op "set_grid_cell" :page-id pid :grid-id bid
                                    :child-id r2 :row 2 :column 1}])
        board (shape-of file' bid)
        cell1 (ctl/get-cell-by-shape-id board r1)
        cell2 (ctl/get-cell-by-shape-id board r2)]
    (t/is (= [:auto] (mapv :type (:layout-grid-columns board))))
    (t/is (= [1 1] [(:row cell1) (:column cell1)]))
    (t/is (= [2 1] [(:row cell2) (:column cell2)]))))

(t/deftest create-image-zero-media-width-is-refused
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_image" :page-id pid
                                               :x 0 :y 0 :width 10 :height 10
                                               :media-id (uuid/next)
                                               :media-width 0 :media-height 10}]))]
    (t/is (= :mcp-invalid-operation (:code data)))))

(t/deftest set-plugin-data-refuses-non-string-value
  (let [file (thf/sample-file :file1)
        data (thrown-data #(compile-ops file [{:op "set_plugin_data" :target "file"
                                               :namespace "test.ns" :key "k" :value 5}]))]
    (t/is (= :mcp-invalid-operation (:code data)))))

#?(:clj
   (t/deftest bulk-create-300-rects-under-two-seconds
     (let [file    (thf/sample-file :file1)
           pid     (page-id-of file)
           ops     (vec (for [i (range 300)]
                          {:op "create_rect" :page-id pid :x (* i 10) :y 0
                           :width 5 :height 5}))
           start   (System/nanoTime)
           result  (compile-ops file ops)
           elapsed (/ (double (- (System/nanoTime) start)) 1e6)]
       (t/is (< elapsed 2000))
       (t/is (>= (count (:changes result)) 300)))))

#?(:clj
   (t/deftest bench-2000-update-shape-on-20000-shapes
     (let [file0   (thf/sample-file :file1)
           pid     (page-id-of file0)
           ids     (vec (repeatedly 20000 uuid/next))
           file    (update file0 :data
                           (fn [fdata]
                             (ctpl/update-page
                              fdata pid
                              (fn [page]
                                (reduce (fn [page [i id]]
                                          (ctst/add-shape
                                           id
                                           (cts/setup-shape
                                            {:id id :type :rect :name (str "rect-" i)
                                             :x (* (mod i 200) 10)
                                             :y (* (quot i 200) 10)
                                             :width 5 :height 5})
                                           page nil nil nil true))
                                        page
                                        (map-indexed vector ids))))))
           ops     (vec (for [i (range 2000)]
                          {:op "update_shape" :page-id pid :id (nth ids i)
                           :props {:x (+ 3000 (* (mod i 200) 10))
                                   :y (+ 3000 (* (quot i 200) 10))}}))
           start   (System/nanoTime)
           result  (compile-ops file ops)
           elapsed (/ (double (- (System/nanoTime) start)) 1e6)]
       (println "bench-2000-update-shape-on-20000-shapes:" elapsed "ms")
       ;; An idle run takes about 2 s. The limit is the 5 s target of the
       ;; plan, which leaves room for a run that shares the CPU with other
       ;; suites
       (t/is (< elapsed 5000))
       (t/is (>= (count (:changes result)) 2000)))))
