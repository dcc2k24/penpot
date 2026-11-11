;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns common-tests.mcp.operations-test
  (:require
   [app.common.files.changes :as cfc]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.helpers :as cfh]
   [app.common.geom.point :as gpt]
   [app.common.geom.shapes :as gsh]
   [app.common.logic.modifiers :as lm]
   [app.common.logic.shapes :as cls]
   [app.common.math :as mth]
   [app.common.mcp.operations :as mops]
   [app.common.mcp.operations.arrange :as f-arrange]
   [app.common.mcp.operations.components :as f-components]
   [app.common.mcp.operations.layout :as f-layout]
   [app.common.mcp.operations.library :as f-library]
   [app.common.mcp.operations.prototype :as f-prototype]
   [app.common.mcp.operations.replace-font :as f-replace-font]
   [app.common.mcp.operations.schema]
   [app.common.mcp.operations.shapes :as f-shapes]
   [app.common.mcp.operations.state]
   [app.common.mcp.operations.text :as f-text]
   [app.common.mcp.operations.tokens :as f-tokens]
   [app.common.test-helpers.compositions :as tho]
   [app.common.test-helpers.files :as thf]
   [app.common.test-helpers.ids-map :as thi]
   [app.common.test-helpers.shapes :as ths]
   [app.common.test-helpers.tokens :as tht]
   [app.common.test-helpers.variants :as thv]
   [app.common.types.component :as ctk]
   [app.common.types.container :as ctn]
   [app.common.types.file :as ctf]
   [app.common.types.modifiers :as ctm]
   [app.common.types.objects-map :as omap]
   [app.common.types.pages-list :as ctpl]
   [app.common.types.path :as path]
   [app.common.types.shape :as cts]
   [app.common.types.shape-tree :as ctst]
   [app.common.types.shape.layout :as ctl]
   [app.common.types.text :as txt]
   [app.common.types.tokens-lib :as ctob]
   [app.common.types.tokens-status :as ctos]
   [app.common.uuid :as uuid]
   [clojure.string :as str]
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

(defn- assert-selrect-box
  "Checks the selrect of `shape` and its points, which a path has in place of
  a position and a size."
  [shape x y width height]
  (let [selrect (:selrect shape)]
    (t/is (close? x (:x selrect)))
    (t/is (close? y (:y selrect)))
    (t/is (close? width (:width selrect)))
    (t/is (close? height (:height selrect))))
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

(t/deftest create-board-and-update-overflow-scroll-test
  (let [file     (thf/sample-file :file1)
        pid      (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 0 :y 0 :width 200 :height 100
                                         :props {:overflow-scroll "vertical"}}])
        board-id (created result "$tmp:b")
        data-create (thrown-data #(compile-ops file [{:op "create_board" :page-id pid :id "$tmp:c"
                                                      :x 0 :y 0 :width 200 :height 100
                                                      :props {:overflow-scroll "diagonal"}}]))
        [file'' _] (apply-ops file' [{:op "update_shape" :page-id pid :id board-id
                                      :props {:overflow-scroll "both"}}])
        data-update (thrown-data #(compile-ops file' [{:op "update_shape" :page-id pid :id board-id
                                                       :props {:overflow-scroll "sideways"}}]))]
    (t/is (= :vertical (:overflow-scroll (shape-of file' board-id))))
    (t/is (= :validation (:type data-create)))
    (t/is (= :both (:overflow-scroll (shape-of file'' board-id))))
    (t/is (= :validation (:type data-update)))))

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
    (assert-selrect-box path 0 0 100 50)))

(t/deftest create-path-with-d-and-position-moves-bounds
  (let [file   (thf/sample-file :file1)
        pid    (page-id-of file)
        [file' result] (apply-ops file [{:op "create_path" :page-id pid :id "$tmp:p"
                                         :d "M 0 0 L 100 0 L 100 50 Z"
                                         :x 30 :y 40}])
        path   (shape-of file' (created result "$tmp:p"))]
    (t/is (close? 30 (:x (:selrect path))))
    (t/is (close? 40 (:y (:selrect path))))
    (assert-selrect-box path 30 40 100 50)))

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
    (t/is (some? (re-find #":content" (str (:hint data)))))))

;; ----- Nested containers and the modifier subset

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
    file'))

(defn- full-objects-changes
  "The changes that the modifiers of the geometry `props` give the shape
  `id` when they run over all the objects of its page. These are the
  changes that `update_shape` must emit for the same geometry."
  [file page-id id props]
  (let [fdata   (:data file)
        objects (get-in fdata [:pages-index page-id :objects])
        mods    (mops/geometry-modifiers (get objects id) props)]
    (-> (pcb/empty-changes nil page-id)
        (pcb/with-file-data fdata)
        (pcb/with-library-data fdata)
        (lm/generate-apply-modifiers objects {id {:modifiers mods}} {})
        :redo-changes)))

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
        (t/is (= expected (:changes result)))))))

(defn- op-changes
  "The changes that the first op of `result` emitted, without the reflow."
  [result]
  (let [[start end] (first (:op-ranges result))]
    (subvec (:changes result) start end)))

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
                   :shape-ids ["$tmp:container"] :name "Button"}])))

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
       :sibling (created result "$tmp:sibling")})))

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
    (t/is (close? (apply max (map :y2 boxes)) (:y2 selrect)))))

(t/deftest update-shape-geometry-inside-group
  (let [{:keys [file pid child container]} (container-file :group)
        props  {:x 30 :y 40 :width 50 :height 30}
        result (compile-ops file [{:op "update_shape" :page-id pid :id child :props props}])
        file'  (thf/apply-changes file {:redo-changes (:changes result)})]
    (assert-box (shape-of file' child) 30 40 50 30)
    (assert-selrect-covers file' container (:shapes (shape-of file' container)))
    (t/is (= (full-objects-changes file pid child props) (op-changes result)))))

(t/deftest update-shape-geometry-inside-bool
  ;; The top-level x, y, width and height of a bool are not refreshed by a
  ;; resize, so the selrect carries the bounds here.
  (let [{:keys [file pid child container]} (container-file :bool)
        props  {:x 30 :y 40 :width 50 :height 30}
        result (compile-ops file [{:op "update_shape" :page-id pid :id child :props props}])
        file'  (thf/apply-changes file {:redo-changes (:changes result)})]
    (assert-box (shape-of file' child) 30 40 50 30)
    (assert-selrect-covers file' container (:shapes (shape-of file' container)))
    (t/is (= (full-objects-changes file pid child props) (op-changes result)))))

(t/deftest update-shape-geometry-inside-mask-group
  (let [{:keys [file pid child container]} (container-file :mask)
        props  {:x 30 :y 40 :width 50 :height 30}
        result (compile-ops file [{:op "update_shape" :page-id pid :id child :props props}])
        file'  (thf/apply-changes file {:redo-changes (:changes result)})]
    (assert-box (shape-of file' child) 30 40 50 30)
    (t/is (true? (:masked-group (shape-of file' container))))
    ;; The child is the mask, and the mask gives the box of the group.
    (assert-selrect-covers file' container [child])
    (t/is (= (full-objects-changes file pid child props) (op-changes result)))))

(t/deftest update-shape-geometry-inside-component-copy
  (let [{:keys [file pid child container]} (container-file :component)
        props  {:x 30 :y 40 :width 50 :height 30}
        result (compile-ops file [{:op "update_shape" :page-id pid :id child :props props}])
        file'  (thf/apply-changes file {:redo-changes (:changes result)})]
    (assert-box (shape-of file' child) 30 40 50 30)
    (t/is (ctk/in-component-copy? (shape-of file' container)))
    (t/is (= (full-objects-changes file pid child props) (op-changes result)))))

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
                  (:x (shape-of file' sibling))))))

(t/deftest update-shape-geometry-inside-flex-board
  (assert-board-resize :flex 10))

(t/deftest update-shape-geometry-inside-grid-board
  (assert-board-resize :grid 0))

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
    (into geometry attrs)))

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
             (count (two-step-changes (:file grid) (:pid grid) (:container grid) props))))))

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
                 (tho/add-group :group1)
                 (ths/add-sample-shape :mask1 :parent-label :group1
                                       :x 10 :y 20 :width 30 :height 40))
        pid  (page-id-of file)
        g1   (thi/id :group1)
        [file' _] (apply-ops file [{:op "make_mask" :page-id pid :group-id g1}])
        [file'' _] (apply-ops file' [{:op "remove_mask" :page-id pid :group-id g1}])]
    (t/is (true? (:masked-group (shape-of file' g1))))
    (t/is (not (:masked-group (shape-of file'' g1))))))

(t/deftest make-mask-takes-the-box-of-the-mask-shape
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-group :group1)
                 (ths/add-sample-shape :mask1 :parent-label :group1
                                       :x 10 :y 20 :width 30 :height 40))
        pid  (page-id-of file)
        g1   (thi/id :group1)
        [file' _] (apply-ops file [{:op "make_mask" :page-id pid :group-id g1}])
        group (shape-of file' g1)]
    (t/is (true? (:masked-group group)))
    (assert-box group 10 20 30 40)))

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

(t/deftest props-cannot-set-the-page-id-link-key
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_rect" :page-id pid
                                               :x 0 :y 0 :width 1 :height 1
                                               :props {:page-id (uuid/next)}}]))]
    (t/is (= :validation (:type data)))
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (some? (re-find #"structural key :page-id; use the page-id of the operation"
                          (str (:hint data)))))))

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

;; ----- Review fixes: names, structure, errors and sizing

(t/deftest operation-names-are-the-sorted-op-names
  (t/is (vector? mops/operation-names))
  (t/is (= (sort mops/operation-names) mops/operation-names))
  (t/is (= (count mops/operation-names) (count (set mops/operation-names))))
  (t/is (contains? (set mops/operation-names) "apply_token")))

(defn- group-chain-file
  "A group `:group1` that holds only the board `:board-a`, which holds the rect
  `:child-b`."
  []
  (-> (thf/sample-file :file1)
      (tho/add-group :group1)
      (tho/add-frame :board-a :parent-label :group1 :x 0 :y 0 :width 100 :height 100)
      (ths/add-sample-shape :child-b :parent-label :board-a :x 10 :y 10 :width 10 :height 10)))

(t/deftest move-a-shape-into-its-own-child-is-refused
  (let [file (group-chain-file)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "move_shapes" :page-id pid
                                               :ids [(thi/id :board-a)]
                                               :parent-id (thi/id :child-b)}]))]
    (t/is (= :validation (:type data)))
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"children" (:hint data)))
    ;; The file is untouched, so the group the move would have removed is there
    (t/is (some? (shape-of file (thi/id :group1))))))

(t/deftest move-under-a-rect-is-refused
  (let [file (two-rects-file)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "move_shapes" :page-id pid
                                               :ids [(thi/id :rect2)]
                                               :parent-id (thi/id :rect1)}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"cannot hold children" (:hint data)))))

(t/deftest move-out-of-a-component-copy-is-refused
  (let [{:keys [file pid child]} (container-file :component)
        data (thrown-data #(compile-ops file [{:op "move_shapes" :page-id pid
                                               :ids [child] :parent-id uuid/zero}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"component copy" (:hint data)))))

#?(:clj
   (t/deftest internal-fault-in-an-op-is-not-a-client-error
     (let [file (thf/sample-file :file1)
           pid  (page-id-of file)
           err  (with-redefs-fn {#'app.common.mcp.operations.schema/decode-op-values
                                 (fn [& _] (throw (NullPointerException. "boom")))}
                  (fn []
                    (try
                      (compile-ops file [{:op "create_rect" :page-id pid
                                          :x 0 :y 0 :width 10 :height 10}])
                      nil
                      (catch Exception e e))))
           data (ex-data err)]
       (t/is (= :internal (:type data)))
       (t/is (= :mcp-compile-failed (:code data)))
       (t/is (= 0 (:index data)))
       (t/is (= "create_rect" (:op data)))
       (t/is (instance? NullPointerException (.getCause err))))))

(t/deftest set-flex-layout-drops-the-applied-gap-token
  (let [file (file-with-token "gap8" "spacing" 8)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 0 :y 0 :width 200 :height 100}
                                        {:op "set_flex_layout" :page-id pid :id "$tmp:b"
                                         :layout-flex-dir "row"}])
        board-id (created result "$tmp:b")
        file''   (shape-with-token file' board-id "gap8" ["row-gap" "column-gap"] 8)
        _        (t/is (= "gap8" (get-in (shape-of file'' board-id) [:applied-tokens :row-gap])))
        [file3 _] (apply-ops file'' [{:op "set_flex_layout" :page-id pid :id board-id
                                      :layout-gap {:row-gap 16 :column-gap 16}}])
        board    (shape-of file3 board-id)]
    (t/is (= 16 (get-in board [:layout-gap :row-gap])))
    (t/is (not (contains? (:applied-tokens board) :row-gap)))
    (t/is (not (contains? (:applied-tokens board) :column-gap)))))

(t/deftest set-layout-child-fill-fixes-the-hug-parent
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 0 :y 0 :width 200 :height 200}
                                        {:op "set_flex_layout" :page-id pid :id "$tmp:b"
                                         :layout-flex-dir "column"
                                         :layout-item-v-sizing "auto"}
                                        {:op "create_rect" :page-id pid :id "$tmp:r"
                                         :parent-id "$tmp:b"
                                         :x 0 :y 0 :width 10 :height 10}])
        board-id (created result "$tmp:b")
        rect-id  (created result "$tmp:r")
        [file'' _] (apply-ops file' [{:op "set_layout_child" :page-id pid :id rect-id
                                      :layout-item-v-sizing "fill"}])]
    (t/is (= :auto (:layout-item-v-sizing (shape-of file' board-id))))
    (t/is (= :fix (:layout-item-v-sizing (shape-of file'' board-id))))))

(t/deftest auto-height-text-wraps-its-paragraph
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        text (apply str (repeat 400 "a"))
        [file' result] (apply-ops file [{:op "create_text" :page-id pid :id "$tmp:t"
                                         :characters text :font-size 14 :width 200
                                         :grow-type "auto-height" :x 0 :y 0}])
        shape (shape-of file' (created result "$tmp:t"))]
    ;; 400 characters of 0.6 em at 14 px in 200 px: 17 lines of 1.2 em
    (t/is (close? (* 1.2 14 17) (:height shape)))
    (t/is (close? 200 (:width shape)))))

(t/deftest resize-path-twice-ends-at-the-second-size
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_path" :page-id pid :id "$tmp:p"
                                         :d "M 0 0 L 100 0 L 100 50 Z"
                                         :x 0 :y 0 :width 100 :height 50}])
        path-id (created result "$tmp:p")
        [file'' _] (apply-ops file' [{:op "update_shape" :page-id pid :id path-id
                                      :props {:width 200}}])
        [file3 _] (apply-ops file'' [{:op "update_shape" :page-id pid :id path-id
                                      :props {:width 100}}])]
    (t/is (close? 200 (get-in (shape-of file'' path-id) [:selrect :width])))
    (t/is (close? 100 (get-in (shape-of file3 path-id) [:selrect :width])))))

(t/deftest rotate-twice-ends-at-the-second-angle
  (let [file (two-rects-file)
        pid  (page-id-of file)
        rect (thi/id :rect1)
        [file' _] (apply-ops file [{:op "update_shape" :page-id pid :id rect
                                    :props {:rotation 30}}])
        [file'' _] (apply-ops file' [{:op "update_shape" :page-id pid :id rect
                                      :props {:rotation 60}}])]
    (t/is (close? 30 (:rotation (shape-of file' rect))))
    (t/is (close? 60 (:rotation (shape-of file'' rect))))))

(defn- file-with-brand-rect
  "The file with the colour token `brand`, `#ff0000`, in `Core`, and a rect
  `:rect1` to take it."
  []
  (-> (file-with-token "brand" "color" "#ff0000")
      (ths/add-sample-shape :rect1 :x 0 :y 0 :width 10 :height 10)))

(t/deftest apply-color-token-in-hsl-warns-and-keeps-the-fill
  (let [file (file-with-brand-rect)
        pid  (page-id-of file)
        rect (thi/id :rect1)
        before (get-in (shape-of file rect) [:fills 0 :fill-color])
        [file' result] (apply-ops file [{:op "apply_token" :page-id pid :shape-ids [rect]
                                         :token-name "brand" :attributes ["fill"]
                                         :resolved-value "hsl(210 50% 40%)"}])
        shape (shape-of file' rect)]
    (t/is (= [{:code :token-not-applied :token "brand" :attributes ["fill"]}]
             (:warnings result)))
    (t/is (= before (get-in shape [:fills 0 :fill-color])))
    (t/is (not (contains? (:applied-tokens shape) :fill)))))

(t/deftest apply-color-token-with-a-colour-name-sets-the-fill
  (let [file (file-with-brand-rect)
        pid  (page-id-of file)
        rect (thi/id :rect1)
        [file' result] (apply-ops file [{:op "apply_token" :page-id pid :shape-ids [rect]
                                         :token-name "brand" :attributes ["fill"]
                                         :resolved-value "red"}])
        shape (shape-of file' rect)]
    (t/is (empty? (:warnings result)))
    (t/is (= "#ff0000" (get-in shape [:fills 0 :fill-color])))
    (t/is (= "brand" (get-in shape [:applied-tokens :fill])))))

(t/deftest update-shape-refuses-a-key-that-has-its-own-op
  (let [file (two-rects-file)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "update_shape" :page-id pid
                                               :id (thi/id :rect1)
                                               :props {:masked-group true}}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"make_mask" (:hint data)))))

(t/deftest create-rect-refuses-a-layout-attr-of-a-board
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_rect" :page-id pid
                                               :x 0 :y 0 :width 10 :height 10
                                               :props {:layout-gap {:row-gap 4 :column-gap 4}}}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    ;; The layout gap has its own op, so `props` refuses it on every type
    (t/is (re-find #"set_flex_layout" (:hint data)))))

(t/deftest props-keys-per-shape-type
  (let [keys-of mops/props-keys-of-type]
    ;; The keys that have an op of their own are in no type
    (doseq [type [:frame :rect :circle :group :bool :text :path :image :svg-raw]]
      (t/is (not (contains? (keys-of type) :layout-gap)) (str type))
      (t/is (not (contains? (keys-of type) :layout-padding)) (str type))
      (t/is (not (contains? (keys-of type) :layout-item-h-sizing)) (str type))
      ;; The structural keys are in no type
      (t/is (not (contains? (keys-of type) :layout)) (str type))
      (t/is (not (contains? (keys-of type) :masked-group)) (str type))
      (t/is (not (contains? (keys-of type) :variant-id)) (str type)))
    ;; A plain attr is in the type
    (t/is (contains? (keys-of :rect) :hide-in-viewer))))

(t/deftest create-rect-without-x-names-the-missing-field
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_rect" :page-id pid
                                               :y 0 :width 1 :height 1}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (= 0 (:index data)))
    (t/is (re-find #":x" (:hint data)))
    (t/is (some? (:details data)))))

(t/deftest group-refuses-a-repeated-child
  (let [file (two-rects-file)
        pid  (page-id-of file)
        rect (thi/id :rect1)
        data (thrown-data #(compile-ops file [{:op "create_group" :page-id pid
                                               :child-ids [rect rect]}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"more than once" (:hint data)))))

;; ----- Lookup counts on a large page
;;
;; Wall time is not a gate: it depends on the machine. These tests count the
;; lookups that the compiler makes on the objects of a page, which is what a
;; scan of the page costs.

(defn- counted-seq
  "The entries of `s`, each counted as one lookup, since a scan of the page
  reads every entry. The seq of an empty map is nil."
  [counter s]
  (when (some? s)
    (map (fn [entry] (swap! counter inc) entry) s)))

#?(:clj
   (deftype CountingMap [m counter]
     clojure.lang.ILookup
     (valAt [_ k] (swap! counter inc) (get m k))
     (valAt [_ k not-found] (swap! counter inc) (get m k not-found))

     clojure.lang.Associative
     (containsKey [_ k] (contains? m k))
     (entryAt [_ k] (swap! counter inc) (find m k))
     (assoc [_ k v] (CountingMap. (assoc m k v) counter))

     clojure.lang.IPersistentMap
     (assocEx [_ k v] (CountingMap. (.assocEx ^clojure.lang.IPersistentMap m k v) counter))
     (without [_ k] (CountingMap. (dissoc m k) counter))

     clojure.lang.IPersistentCollection
     (count [_] (count m))
     (cons [_ o] (CountingMap. (conj m o) counter))
     (empty [_] (CountingMap. (empty m) counter))
     (equiv [_ o] (= m (if (instance? CountingMap o) (.-m ^CountingMap o) o)))

     clojure.lang.Seqable
     (seq [_] (counted-seq counter (seq m)))

     clojure.lang.IFn
     (invoke [_ k] (swap! counter inc) (get m k))
     (invoke [_ k not-found] (swap! counter inc) (get m k not-found))

     java.lang.Iterable
     (iterator [this] (.iterator ^Iterable (or (seq this) ())))))

#?(:cljs
   (deftype CountingMap [m counter]
     ILookup
     (-lookup [_ k] (swap! counter inc) (get m k))
     (-lookup [_ k not-found] (swap! counter inc) (get m k not-found))

     IAssociative
     (-contains-key? [_ k] (contains? m k))
     (-assoc [_ k v] (CountingMap. (assoc m k v) counter))

     IFind
     (-find [_ k] (swap! counter inc) (find m k))

     IMap
     (-dissoc [_ k] (CountingMap. (dissoc m k) counter))

     ICounted
     (-count [_] (count m))

     ISeqable
     (-seq [_] (counted-seq counter (seq m)))

     IKVReduce
     (-kv-reduce [_ f init]
       (reduce-kv (fn [acc k v] (swap! counter inc) (f acc k v)) init m))

     IFn
     (-invoke [_ k] (swap! counter inc) (get m k))
     (-invoke [_ k not-found] (swap! counter inc) (get m k not-found))))

(defn- counting-file
  "The file `file` with the objects of its page wrapped in a counting map.
  Returns the file and the counter atom."
  [file]
  (let [counter (atom 0)
        pid     (page-id-of file)
        objects (get-in file [:data :pages-index pid :objects])]
    [(assoc-in file [:data :pages-index pid :objects] (CountingMap. objects counter))
     counter]))

(defn- lookups-of
  "The number of lookups in the page objects that the compile of `operations`
  makes on `file`."
  [file operations]
  (let [[file' counter] (counting-file file)]
    (compile-ops file' operations)
    @counter))

(defn- big-page-file
  "The file `base` with `n` rects at the root of its page. Returns the file and
  the ids of the rects, in order."
  [base n]
  (let [pid (page-id-of base)
        ids (vec (repeatedly n uuid/next))]
    [(update base :data
             (fn [fdata]
               (ctpl/update-page
                fdata pid
                (fn [page]
                  (reduce (fn [page [i id]]
                            (ctst/add-shape
                             id
                             (cts/setup-shape {:id id :type :rect :name (str "rect-" i)
                                               :x (* (mod i 200) 10)
                                               :y (* (quot i 200) 10)
                                               :width 5 :height 5})
                             page nil nil nil true))
                          page
                          (map-indexed vector ids))))))
     ids]))

(defn- now-ms
  []
  #?(:clj (/ (double (System/nanoTime)) 1e6)
     :cljs (js/Date.now)))

(defn- counter-id-fn
  "A new-id function that gives the same ids in every compile."
  []
  (let [n (atom 0)]
    (fn [] (uuid/custom 0 (swap! n inc)))))

(defn- compile-with
  "Compiles `operations` against `file` with `opts`, and returns the result."
  [file operations opts]
  (mops/compile-operations (:data file) operations opts))

(defn- modifier-input-sizes
  "The number of objects that each call of the modifiers gets while the
  `operations` compile on `file`."
  [file operations]
  (let [sizes (atom [])
        orig  lm/generate-apply-modifiers]
    (with-redefs [lm/generate-apply-modifiers
                  (fn [builder objects tree opts]
                    (swap! sizes conj (count objects))
                    (orig builder objects tree opts))]
      (compile-ops file operations))
    @sizes))

(defn- reflow-ids-of
  "The ids that the layout reflow is asked to run from, when the
  `operations` compile on `file`."
  [file operations]
  (let [seen (atom [])
        orig lm/generate-reflow]
    (with-redefs [lm/generate-reflow
                  (fn [changes objects ids opts]
                    (swap! seen into ids)
                    (orig changes objects ids opts))]
      (compile-ops file operations))
    @seen))

(defn- lookups-of-ops
  "The lookups per op that `operations` make on the large page of `file`."
  [file operations]
  (/ (lookups-of file operations) (count operations)))

;; ----- Counts on a large page: the gates

(def ^:private lookup-bound
  "The most lookups of the page objects that one op may make on a page of
  20,000 shapes. Before the scan of the names was removed, an unnamed create
  made about 20,000 of them."
  200)

(t/deftest lookups-per-op-stay-bounded-on-a-large-page
  (let [[file ids]  (big-page-file (thf/sample-file :file1) 20000)
        pid         (page-id-of file)
        [text-file text-result]
        (apply-ops file [{:op "create_text" :page-id pid :id "$tmp:t"
                          :characters "Hello" :font-size 20 :grow-type "fixed"
                          :x 0 :y 0 :width 200 :height 40}])
        text-id     (created text-result "$tmp:t")
        [token-file token-ids] (big-page-file (file-with-token "w50" "sizing" 50) 20000)
        tpid        (page-id-of token-file)
        n           50
        update-ops  (vec (for [i (range n)]
                           {:op "update_shape" :page-id pid :id (nth ids i)
                            :props {:x (+ 3000 i) :y 3000}}))
        create-ops  (vec (for [i (range n)]
                           {:op "create_rect" :page-id pid :x (* i 10) :y 5000
                            :width 5 :height 5}))
        text-ops    (vec (for [i (range n)]
                           {:op "set_text" :page-id pid :id text-id
                            :characters (str "Bye " i)}))
        token-ops   (vec (for [id (take n token-ids)]
                           {:op "apply_token" :page-id tpid :shape-ids [id]
                            :token-name "w50" :attributes ["width"]
                            :resolved-value 50}))]
    (doseq [[label f ops] [["update_shape" file update-ops]
                           ["create_rect unnamed" file create-ops]
                           ["set_text" text-file text-ops]
                           ["apply_token" token-file token-ops]]]
      (let [per-op (lookups-of-ops f ops)]
        (println "lookups per op," label ":" (double per-op))
        (t/is (<= per-op lookup-bound) (str label " makes " (double per-op) " lookups per op"))))))

;; ----- Shapes given to the modifiers: the three families of CMP-04

(t/deftest modifier-inputs-are-a-part-of-the-page
  (let [[file ids] (big-page-file (thf/sample-file :file1) 20000)
        pid        (page-id-of file)
        [text-file text-result]
        (apply-ops file [{:op "create_text" :page-id pid :id "$tmp:t"
                          :characters "Hi" :font-size 20 :grow-type "auto-width"
                          :x 0 :y 0}])
        text-id    (created text-result "$tmp:t")
        [token-file token-ids] (big-page-file (file-with-token "w50" "sizing" 50) 20000)
        tpid       (page-id-of token-file)
        align-sizes (modifier-input-sizes
                     file [{:op "align" :page-id pid
                            :ids [(nth ids 0) (nth ids 1)] :axis "hleft"}])
        text-sizes  (modifier-input-sizes
                     text-file [{:op "set_text" :page-id pid :id text-id
                                 :characters "Bye there"}])
        token-sizes (modifier-input-sizes
                     token-file [{:op "apply_token" :page-id tpid
                                  :shape-ids [(first token-ids)] :token-name "w50"
                                  :attributes ["width"] :resolved-value 50}])]
    (doseq [[label sizes] [["align" align-sizes]
                           ["set_text" text-sizes]
                           ["apply_token" token-sizes]]]
      (println "modifier inputs," label ":" sizes)
      (t/is (seq sizes) label)
      (t/is (every? #(< % 50) sizes) (str label " gives the modifiers " sizes)))))

#?(:clj
   (t/deftest modifier-input-for-the-three-families-matches-the-full-page
     ;; With the part of the page replaced by the whole page, the changes of
     ;; each family must not change.
     (let [base    (nested-containers-file)
           pid     (page-id-of base)
           [file result] (apply-ops base [{:op "create_text" :page-id pid
                                           :id "$tmp:t" :characters "Hi" :font-size 20
                                           :grow-type "auto-width" :x 0 :y 0}])
           tid     (created result "$tmp:t")
           full    (fn [f ops]
                     (with-redefs-fn {#'app.common.mcp.operations.state/modifier-objects-of (fn [objects _] objects)
                                      #'app.common.mcp.operations.state/modifier-objects (fn [objects _] objects)}
                       (fn [] (:changes (compile-ops f ops)))))
           subset  (fn [f ops] (:changes (compile-ops f ops)))
           cases   [[:align file [{:op "align" :page-id pid
                                   :ids [(thi/id :rect1) (thi/id :rect3)] :axis "hleft"}]]
                    [:set-text file [{:op "set_text" :page-id pid :id tid
                                      :characters "Bye there"}]]]]
       (doseq [[label f ops] cases]
         (let [changes (subset f ops)]
           (t/is (seq changes) (str label " changes nothing"))
           (t/is (= (full f ops) changes) (str label " differs with the full page")))))))

;; ----- The reflow

(t/deftest reflow-skips-a-shape-in-no-layout
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 0 :y 0 :width 200 :height 200}])
        board (created result "$tmp:b")
        plain (reflow-ids-of file' [{:op "create_rect" :page-id pid :parent-id board
                                     :x 10 :y 10 :width 20 :height 20}])
        [flex-file flex-result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:f"
                                                  :x 0 :y 0 :width 200 :height 200}
                                                 {:op "set_flex_layout" :page-id pid :id "$tmp:f"
                                                  :layout-flex-dir "row"}])
        flex  (created flex-result "$tmp:f")
        inside (reflow-ids-of flex-file [{:op "create_rect" :page-id pid :parent-id flex
                                          :x 10 :y 10 :width 20 :height 20}])]
    (t/is (empty? plain) "a rect in a plain board is not reflowed")
    (t/is (seq inside) "a rect in a flex board is reflowed")))

(t/deftest reflow-error-is-an-internal-error
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        ops  [{:op "create_board" :page-id pid :id "$tmp:f"
               :x 0 :y 0 :width 200 :height 200}
              {:op "set_flex_layout" :page-id pid :id "$tmp:f" :layout-flex-dir "row"}
              {:op "create_rect" :page-id pid :parent-id "$tmp:f"
               :x 10 :y 10 :width 20 :height 20}]
        data (with-redefs [lm/generate-reflow
                           (fn [& _] (throw (ex-info "boom" {})))]
               (thrown-data #(compile-ops file ops)))]
    (t/is (= :internal (:type data)))
    (t/is (= :mcp-compile-failed (:code data)))
    (t/is (nil? (:index data)))
    (t/is (= "reflow" (:op data)))))

;; ----- Names and structure

(t/deftest default-names-are-plain
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_rect" :page-id pid :id "$tmp:r1"
                                         :x 0 :y 0 :width 10 :height 10}
                                        {:op "create_rect" :page-id pid :id "$tmp:r2"
                                         :x 20 :y 0 :width 10 :height 10}
                                        {:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 0 :y 0 :width 100 :height 100}
                                        {:op "create_group" :page-id pid :id "$tmp:g"
                                         :child-ids ["$tmp:r1" "$tmp:r2"]}])]
    ;; Two rects get the same plain name, with no suffix
    (t/is (= "Rectangle" (:name (shape-of file' (created result "$tmp:r1")))))
    (t/is (= "Rectangle" (:name (shape-of file' (created result "$tmp:r2")))))
    (t/is (= "Board" (:name (shape-of file' (created result "$tmp:b")))))
    (t/is (= "Group" (:name (shape-of file' (created result "$tmp:g")))))))

(t/deftest boolean-takes-the-parent-of-its-head
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 0 :y 0 :width 200 :height 200}
                                        {:op "create_rect" :page-id pid :id "$tmp:in"
                                         :parent-id "$tmp:b" :x 10 :y 10 :width 20 :height 20}
                                        {:op "create_rect" :page-id pid :id "$tmp:out"
                                         :x 100 :y 100 :width 20 :height 20}])
        in-id    (created result "$tmp:in")
        out-id   (created result "$tmp:out")
        objects  (get-in (:data file') [:pages-index pid :objects])
        ordered  (cfh/order-by-indexed-shapes objects [in-id out-id])
        front    (first ordered)
        bottom   (last ordered)]
    ;; The children sit in two parents, and the boolean takes the parent of
    ;; its head: the front child for a union, the bottom child for a difference.
    (t/is (not= (:parent-id (get objects in-id)) (:parent-id (get objects out-id))))
    (doseq [[bool-type head] [["union" front] ["difference" bottom]]]
      (let [[file'' res] (apply-ops file' [{:op "create_boolean" :page-id pid
                                            :id "$tmp:bool" :bool-type bool-type
                                            :child-ids [in-id out-id]}])
            bool (shape-of file'' (created res "$tmp:bool"))]
        (t/is (= (:parent-id (get objects head)) (:parent-id bool))
              (str bool-type " takes the parent of its head"))))))

(t/deftest props-refuse-the-keys-that-have-an-op
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)]
    (doseq [[k hint] [[:layout-item-h-sizing "set_layout_child"]
                      [:layout-item-margin "set_layout_child"]
                      [:layout-gap "set_flex_layout"]
                      [:layout-padding "set_flex_layout or set_grid_layout"]]]
      (let [data (thrown-data #(compile-ops file [{:op "create_rect" :page-id pid
                                                   :x 0 :y 0 :width 10 :height 10
                                                   :props {k 1}}]))]
        (t/is (= :mcp-invalid-operation (:code data)) (str k))
        (t/is (re-find (re-pattern hint) (str (:hint data)))
              (str k " names " hint))))))

;; ----- Reproducible ids, and the input page

(t/deftest the-same-ops-give-equal-changes-with-a-counting-id-fn
  (let [file (nested-containers-file)
        pid  (page-id-of file)
        ops  [{:op "create_rect" :page-id pid :id "$tmp:a" :parent-id (thi/id :board)
               :x 300 :y 300 :width 10 :height 10}
              {:op "create_rect" :page-id pid :id "$tmp:b" :parent-id (thi/id :board)
               :x 320 :y 300 :width 10 :height 10}
              {:op "create_group" :page-id pid :id "$tmp:g" :child-ids ["$tmp:a" "$tmp:b"]}
              {:op "update_shape" :page-id pid :id (thi/id :rect1) :props {:x 15 :y 25}}
              {:op "align" :page-id pid :ids [(thi/id :rect1) (thi/id :rect3)] :axis "vcenter"}]
        once (compile-with file ops {:new-id-fn (counter-id-fn)})
        twice (compile-with file ops {:new-id-fn (counter-id-fn)})]
    (t/is (seq (:changes once)))
    (t/is (= (:changes once) (:changes twice)))
    (t/is (= (:created-ids once) (:created-ids twice)))))

(t/deftest a-lazy-objects-page-compiles-as-a-plain-page
  (let [file (nested-containers-file)
        pid  (page-id-of file)
        lazy (update-in file [:data :pages-index pid :objects] omap/wrap)
        ops  [{:op "update_shape" :page-id pid :id (thi/id :rect1) :props {:x 15 :y 25}}
              {:op "create_rect" :page-id pid :id "$tmp:a" :parent-id (thi/id :board)
               :x 300 :y 300 :width 10 :height 10}
              {:op "align" :page-id pid :ids [(thi/id :rect1) (thi/id :rect3)] :axis "hleft"}]
        plain-result (compile-with file ops {:new-id-fn (counter-id-fn)})
        lazy-result  (compile-with lazy ops {:new-id-fn (counter-id-fn)})]
    (t/is (seq (:changes plain-result)))
    (t/is (= (:changes plain-result) (:changes lazy-result)))))

;; ----- Libraries: the `:libraries` input

(t/deftest instantiate-component-from-a-library
  (let [[lib comp-id] (button-component-file)
        lib-id        (:id (:data lib))
        target        (thf/sample-file :file2)
        tpid          (page-id-of target)
        result        (compile-with target
                                    [{:op "instantiate_component" :page-id tpid
                                      :component-id comp-id :library-id lib-id
                                      :x 300 :y 0 :id "$tmp:copy"}]
                                    {:new-id-fn uuid/next
                                     :libraries {lib-id (:data lib)}})
        target'       (thf/apply-changes target {:redo-changes (:changes result)})
        copy          (shape-of target' (created result "$tmp:copy"))]
    (t/is (= comp-id (:component-id copy)))
    (t/is (close? 300 (:x copy)))))

(t/deftest apply-typography-from-a-library
  (let [[lib lib-result] (apply-ops (thf/sample-file :file1)
                                    [{:op "create_typography"
                                      :typography {:id "$tmp:t" :name "Body"
                                                   :font-family "sourcesanspro"
                                                   :font-size "18"}}])
        lib-id   (:id (:data lib))
        typo-id  (created lib-result "$tmp:t")
        target   (thf/sample-file :file2)
        tpid     (page-id-of target)
        result   (compile-with target
                               [{:op "create_text" :page-id tpid :id "$tmp:x"
                                 :characters "Hello" :font-size 10 :font-family "other"
                                 :grow-type "fixed" :x 0 :y 0 :width 200 :height 40}
                                {:op "apply_typography" :page-id tpid :id "$tmp:x"
                                 :typography-id typo-id :library-id lib-id}]
                               {:new-id-fn uuid/next
                                :libraries {lib-id (:data lib)}})
        target'  (thf/apply-changes target {:redo-changes (:changes result)})
        nodes    (txt/node-seq txt/is-text-node?
                               (:content (shape-of target' (created result "$tmp:x"))))]
    (t/is (seq nodes))
    (t/is (every? #(= "sourcesanspro" (:font-family %)) nodes))
    (t/is (every? #(= typo-id (:typography-ref-id %)) nodes))
    (t/is (every? #(= lib-id (:typography-ref-file %)) nodes))))

(t/deftest set-tokens-source-to-a-library
  (let [lib      (tokens-file)
        lib-id   (:id (:data lib))
        target   (thf/sample-file :file2)
        result   (compile-with target
                               [{:op "set_tokens_source" :library-id lib-id}]
                               {:new-id-fn uuid/next
                                :libraries {lib-id (:data lib)}})
        target'  (thf/apply-changes target {:redo-changes (:changes result)})]
    (t/is (= lib-id (tht/get-tokens-source target')))))

;; ----- Benchmarks: printed, not gated

(t/deftest bulk-create-300-rects-counts-the-changes
  (let [file    (thf/sample-file :file1)
        pid     (page-id-of file)
        ops     (vec (for [i (range 300)]
                       {:op "create_rect" :page-id pid :x (* i 10) :y 0
                        :width 5 :height 5}))
        start   (now-ms)
        result  (compile-ops file ops)
        elapsed (- (now-ms) start)]
    (println "bulk-create-300-rects:" elapsed "ms (not a gate)")
    (t/is (>= (count (:changes result)) 300))))

(t/deftest bench-2000-update-shape-on-20000-shapes-counts-the-changes
  (let [[file ids] (big-page-file (thf/sample-file :file1) 20000)
        pid     (page-id-of file)
        ops     (vec (for [i (range 2000)]
                       {:op "update_shape" :page-id pid :id (nth ids i)
                        :props {:x (+ 3000 (* (mod i 200) 10))
                                :y (+ 3000 (* (quot i 200) 10))}}))
        start   (now-ms)
        result  (compile-ops file ops)
        elapsed (- (now-ms) start)]
    (println "bench-2000-update-shape-on-20000-shapes:" elapsed "ms (not a gate)")
    (t/is (>= (count (:changes result)) 2000))))

(t/deftest schema-op-names-are-the-registry-names
  ;; Each op of the schema is in the registry, and each registry name is in the schema
  (t/is (= (set mops/operation-names) mops/schema-op-names)))

;; ----- Review round: nesting loops, rotation, path content, gaps, copies, faults

(t/deftest move-copy-into-its-own-main-is-refused
  (let [[file comp-id] (button-component-file)
        pid      (page-id-of file)
        main-id  (get-in (:data file) [:components comp-id :main-instance-id])
        [file' result] (apply-ops file [{:op "instantiate_component" :page-id pid
                                         :component-id comp-id :x 300 :y 0 :id "$tmp:copy"}
                                        {:op "create_group" :page-id pid :id "$tmp:g"
                                         :child-ids ["$tmp:copy"]}])
        copy-id  (created result "$tmp:copy")
        group-id (created result "$tmp:g")
        data     (thrown-data #(compile-ops file' [{:op "move_shapes" :page-id pid
                                                    :ids [copy-id] :parent-id main-id}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"nest" (str (:hint data))))
    ;; Nothing is deleted: the group and its copy are still there
    (t/is (some? (shape-of file' group-id)))
    (t/is (some? (shape-of file' copy-id)))))

(t/deftest update-shape-rotation-of-a-flipped-rect-keeps-the-flip
  (let [file    (thf/sample-file :file1)
        pid     (page-id-of file)
        id      (uuid/next)
        base    (cts/setup-shape {:type :rect :x 0 :y 0 :width 40 :height 20})
        flipped (-> (gsh/transform-shape base (-> (ctm/empty)
                                                  (ctm/resize (gpt/point -1.0 1.0)
                                                              (gsh/shape->center base))))
                    (assoc :id id :parent-id uuid/zero :frame-id uuid/zero))
        file'   (update file :data
                        (fn [fdata]
                          (ctpl/update-page fdata pid
                                            #(ctst/add-shape id flipped % nil nil nil true))))
        [file'' _] (apply-ops file' [{:op "update_shape" :page-id pid :id id
                                      :props {:rotation 0}}])
        after   (shape-of file'' id)]
    (t/is (true? (:flip-x after)))
    (doseq [[a b] (map vector (:points after) (:points flipped))]
      (t/is (close? (:x a) (:x b)))
      (t/is (close? (:y a) (:y b))))))

(t/deftest set-path-content-refits-the-box-to-the-content
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_path" :page-id pid :id "$tmp:p"
                                         :d "M 0 0 L 100 0 L 100 50 Z" :x 30 :y 40}])
        path-id (created result "$tmp:p")
        [file'' _] (apply-ops file' [{:op "set_path_content" :page-id pid :id path-id
                                      :content (path/from-string "M 0 0 L 200 0 L 200 80 Z")}])
        shape   (shape-of file'' path-id)]
    (t/is (= :path (:type shape)))
    (assert-selrect-box shape 30 40 200 80)))

(t/deftest set-path-content-refuses-a-shape-that-is-not-a-path
  (let [file (two-rects-file)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "set_path_content" :page-id pid
                                               :id (thi/id :rect1)
                                               :content (path/from-string "M 0 0 L 10 0 L 10 10 Z")}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"path shape" (str (:hint data))))))

(t/deftest create-rect-props-accept-hide-in-viewer
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_rect" :page-id pid :id "$tmp:r"
                                         :x 0 :y 0 :width 10 :height 10
                                         :props {:hide-in-viewer true}}])]
    (t/is (true? (:hide-in-viewer (shape-of file' (created result "$tmp:r")))))))

(t/deftest apply-sizing-token-records-the-width-in-applied-tokens
  (let [file (file-with-token "wide" "sizing" 50)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_rect" :page-id pid :id "$tmp:r"
                                         :x 0 :y 0 :width 10 :height 10}])
        rect-id (created result "$tmp:r")
        [file'' _] (apply-ops file' [{:op "apply_token" :page-id pid :shape-ids [rect-id]
                                      :token-name "wide" :attributes ["width"]
                                      :resolved-value 50}])
        rect    (shape-of file'' rect-id)]
    (t/is (close? 50 (:width rect)))
    (t/is (= "wide" (get-in rect [:applied-tokens :width])))))

(defn- gap-token-board
  "The file with the board `$tmp:b` in a row flex layout, whose row and column
  gaps carry the token `gap8`. Returns the file and the id of the board."
  []
  (let [file (file-with-token "gap8" "spacing" 8)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 0 :y 0 :width 200 :height 100}
                                        {:op "set_flex_layout" :page-id pid :id "$tmp:b"
                                         :layout-flex-dir "row"}])
        board-id (created result "$tmp:b")]
    [(shape-with-token file' board-id "gap8" ["row-gap" "column-gap"] 8) board-id]))

(t/deftest set-flex-layout-without-a-gap-keeps-the-gap-and-its-tokens
  (let [[file board-id] (gap-token-board)
        pid     (page-id-of file)
        [file' _] (apply-ops file [{:op "set_flex_layout" :page-id pid :id board-id
                                    :layout-flex-dir "column"}])
        board   (shape-of file' board-id)]
    (t/is (= 8 (get-in board [:layout-gap :row-gap])))
    (t/is (= 8 (get-in board [:layout-gap :column-gap])))
    (t/is (= "gap8" (get-in board [:applied-tokens :row-gap])))
    (t/is (= "gap8" (get-in board [:applied-tokens :column-gap])))))

(t/deftest set-flex-layout-unapplies-only-the-gap-side-that-changes
  (let [[file board-id] (gap-token-board)
        pid     (page-id-of file)
        [file' _] (apply-ops file [{:op "set_flex_layout" :page-id pid :id board-id
                                    :layout-gap {:row-gap 16 :column-gap 8}}])
        board   (shape-of file' board-id)]
    (t/is (= 16 (get-in board [:layout-gap :row-gap])))
    (t/is (= 8 (get-in board [:layout-gap :column-gap])))
    (t/is (not (contains? (:applied-tokens board) :row-gap)))
    (t/is (= "gap8" (get-in board [:applied-tokens :column-gap])))))

(t/deftest create-into-a-component-copy-is-refused
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-simple-component-with-copy :c1 :main :main-child :copy))
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_rect" :page-id pid
                                               :parent-id (thi/id :copy)
                                               :x 0 :y 0 :width 5 :height 5}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"component copy" (str (:hint data))))))

(t/deftest instantiate-into-a-component-copy-is-refused
  (let [file (-> (thf/sample-file :file1)
                 (tho/add-simple-component-with-copy :c1 :main :main-child :copy))
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "instantiate_component" :page-id pid
                                               :component-id (thi/id :c1)
                                               :parent-id (thi/id :copy)
                                               :x 0 :y 0}]))]
    (t/is (= :mcp-invalid-operation (:code data)))))

(t/deftest clone-of-a-shape-inside-a-copy-is-refused
  (let [file  (-> (thf/sample-file :file1)
                  (tho/add-simple-component-with-copy :c1 :main :main-child :copy))
        pid   (page-id-of file)
        inner (first (:shapes (shape-of file (thi/id :copy))))
        data  (thrown-data #(compile-ops file [{:op "clone_shape" :page-id pid :id inner}]))]
    (t/is (= :mcp-invalid-operation (:code data)))))

(t/deftest set-layout-child-margin-keeps-the-other-sides
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 0 :y 0 :width 200 :height 200}
                                        {:op "set_flex_layout" :page-id pid :id "$tmp:b"
                                         :layout-flex-dir "row"}
                                        {:op "create_rect" :page-id pid :id "$tmp:r"
                                         :parent-id "$tmp:b" :x 0 :y 0 :width 10 :height 10}])
        rect-id (created result "$tmp:r")
        [file'' _] (apply-ops file' [{:op "set_layout_child" :page-id pid :id rect-id
                                      :layout-item-margin {:m1 1 :m2 2 :m3 3 :m4 4}}
                                     {:op "set_layout_child" :page-id pid :id rect-id
                                      :layout-item-margin {:m1 9}}])]
    (t/is (= {:m1 9 :m2 2 :m3 3 :m4 4}
             (:layout-item-margin (shape-of file'' rect-id))))))

#?(:clj
   (t/deftest assertion-error-in-an-op-is-a-compile-failure
     (let [file (thf/sample-file :file1)
           pid  (page-id-of file)
           data (with-redefs-fn {#'app.common.mcp.operations.schema/decode-op-values
                                 (fn [_] (throw (AssertionError. "boom")))}
                  (fn []
                    (thrown-data #(compile-ops file [{:op "create_rect" :page-id pid
                                                      :x 0 :y 0 :width 10 :height 10}]))))]
       (t/is (= :mcp-compile-failed (:code data)))
       (t/is (= 0 (:index data)))
       (t/is (= "create_rect" (:op data))))))

;; ----- Padding: merged with the current padding, and only the changed sides lose their token

(defn- padding-token-board
  "The file with the board `$tmp:b` in a row flex layout, whose four paddings
  carry the token `pad` of 12. Returns the file and the id of the board."
  []
  (let [file (file-with-token "pad" "spacing" 12)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_board" :page-id pid :id "$tmp:b"
                                         :x 0 :y 0 :width 200 :height 100}
                                        {:op "set_flex_layout" :page-id pid :id "$tmp:b"
                                         :layout-flex-dir "row"}])
        board-id (created result "$tmp:b")]
    [(shape-with-token file' board-id "pad" ["p1" "p2" "p3" "p4"] 12) board-id]))

(t/deftest set-flex-layout-without-a-padding-keeps-the-padding-and-its-tokens
  (let [[file board-id] (padding-token-board)
        pid   (page-id-of file)
        [file' _] (apply-ops file [{:op "set_flex_layout" :page-id pid :id board-id
                                    :layout-flex-dir "column"}])
        board (shape-of file' board-id)]
    (doseq [side [:p1 :p2 :p3 :p4]]
      (t/is (= 12 (get-in board [:layout-padding side])) (str side))
      (t/is (= "pad" (get-in board [:applied-tokens side])) (str side)))))

(t/deftest set-flex-layout-padding-on-one-side-unapplies-only-that-side
  (let [[file board-id] (padding-token-board)
        pid   (page-id-of file)
        [file' _] (apply-ops file [{:op "set_flex_layout" :page-id pid :id board-id
                                    :layout-padding {:p1 4}}])
        board (shape-of file' board-id)]
    (t/is (= 4 (get-in board [:layout-padding :p1])))
    (doseq [side [:p2 :p3 :p4]]
      (t/is (= 12 (get-in board [:layout-padding side])) (str side))
      (t/is (= "pad" (get-in board [:applied-tokens side])) (str side)))
    (t/is (not (contains? (:applied-tokens board) :p1)))))

(t/deftest set-grid-layout-without-a-padding-keeps-the-padding-and-its-tokens
  (let [[file board-id] (padding-token-board)
        pid   (page-id-of file)
        [file' _] (apply-ops file [{:op "set_grid_layout" :page-id pid :id board-id
                                    :layout-grid-rows [{:type "fixed" :value 50}]
                                    :layout-grid-columns [{:type "fixed" :value 50}]}])
        board (shape-of file' board-id)]
    (doseq [side [:p1 :p2 :p3 :p4]]
      (t/is (= 12 (get-in board [:layout-padding side])) (str side))
      (t/is (= "pad" (get-in board [:applied-tokens side])) (str side)))))

;; ----- The families: each op is declared once, with a schema that names it

(def ^:private family-maps
  [f-shapes/ops f-layout/ops f-text/ops f-components/ops f-library/ops
   f-tokens/ops f-prototype/ops f-arrange/ops f-replace-font/ops])

(t/deftest family-keys-are-the-op-names-of-their-schemas
  (doseq [family family-maps
          [op-name entry] family]
    (t/is (= op-name (get-in entry [:schema 1 :title])) op-name)
    (t/is (fn? (:compile entry)) op-name)))

(t/deftest the-merged-op-table-has-no-duplicate-keys
  ;; The merge of the families keeps one entry per key, so the number of
  ;; names is the sum of the families only when no op is declared twice
  (t/is (= (reduce + (map count family-maps))
           (count mops/operation-names))))

;; ----- Review round 2: paths, variants, nesting, the schema, the parser

(defn- path-file
  "The file with a path `$tmp:p` made from a `d` string at 30, 40 (100 x 50)."
  []
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_path" :page-id pid :id "$tmp:p"
                                         :d "M 0 0 L 100 0 L 100 50 Z" :x 30 :y 40}])]
    [file' pid (created result "$tmp:p")]))

(t/deftest create-path-keeps-no-position-of-its-own
  (let [[file _ path-id] (path-file)
        path (shape-of file path-id)]
    (t/is (nil? (:x path)))
    (t/is (nil? (:width path)))
    (assert-selrect-box path 30 40 100 50)))

(t/deftest set-path-content-keeps-the-position-after-a-move
  (let [[file pid path-id] (path-file)
        [file' _] (apply-ops file [{:op "update_shape" :page-id pid :id path-id
                                    :props {:x 300 :y 400}}])
        [file'' _] (apply-ops file' [{:op "set_path_content" :page-id pid :id path-id
                                      :content (path/from-string "M 0 0 L 200 0 L 200 80 Z")}])]
    (assert-selrect-box (shape-of file'' path-id) 300 400 200 80)))

(t/deftest set-path-content-reads-the-origin-of-a-path-with-no-x
  ;; A path drawn in the editor, or migrated, can have `:x` nil
  (let [[file pid path-id] (path-file)
        file' (update-in file [:data :pages-index pid :objects path-id]
                         #(assoc % :x nil :y nil))
        [file'' _] (apply-ops file' [{:op "set_path_content" :page-id pid :id path-id
                                      :content (path/from-string "M 0 0 L 200 0 L 200 80 Z")}])]
    (assert-selrect-box (shape-of file'' path-id) 30 40 200 80)))

(t/deftest set-path-content-on-a-rotated-path-keeps-its-transform
  (let [[file pid path-id] (path-file)
        [file' _] (apply-ops file [{:op "update_shape" :page-id pid :id path-id
                                    :props {:rotation 30}}])
        [file'' _] (apply-ops file' [{:op "set_path_content" :page-id pid :id path-id
                                      :content (path/from-string "M 0 0 L 200 0 L 200 80 Z")}])
        [file3 _] (apply-ops file'' [{:op "update_shape" :page-id pid :id path-id
                                      :props {:width 200}}])
        path   (shape-of file3 path-id)
        [p0 p1 p2] (:points path)
        side   (fn [a b] (let [dx (- (:x a) (:x b))
                               dy (- (:y a) (:y b))]
                           (mth/sqrt (+ (* dx dx) (* dy dy)))))]
    ;; The points stay on the rotated box: the first side is the width, the
    ;; second the height of the selrect, and the two sides are perpendicular
    (t/is (close? 200 (side p0 p1)))
    (t/is (close? (:height (:selrect path)) (side p1 p2)))
    (t/is (close? 0 (+ (* (- (:x p1) (:x p0)) (- (:x p2) (:x p1)))
                       (* (- (:y p1) (:y p0)) (- (:y p2) (:y p1))))))))

(t/deftest create-rect-into-a-variant-container-is-refused
  (let [file (thv/add-variant (thf/sample-file :file1) :variant :c1 :root1 :c2 :root2)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_rect" :page-id pid
                                               :parent-id (thi/id :variant)
                                               :x 0 :y 0 :width 5 :height 5}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"variant container" (str (:hint data))))))

(t/deftest instantiate-into-its-own-main-is-refused
  (let [[file comp-id] (button-component-file)
        pid     (page-id-of file)
        main-id (get-in (:data file) [:components comp-id :main-instance-id])
        data    (thrown-data #(compile-ops file [{:op "instantiate_component" :page-id pid
                                                  :component-id comp-id :parent-id main-id
                                                  :x 0 :y 0}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"own component" (str (:hint data))))))

(t/deftest clone-of-a-copy-child-without-a-parent-is-refused
  ;; Without a parent the clone goes where the source is, inside the copy
  (let [file  (-> (thf/sample-file :file1)
                  (tho/add-simple-component-with-copy :c1 :main :main-child :copy))
        pid   (page-id-of file)
        inner (first (:shapes (shape-of file (thi/id :copy))))
        data  (thrown-data #(compile-ops file [{:op "clone_shape" :page-id pid :id inner}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (re-find #"component copy" (str (:hint data))))))

(t/deftest schema-branches-are-sorted-by-op-name
  (let [names (take-nth 2 (drop 2 mops/schema:operation))]
    (t/is (seq names))
    (t/is (= (sort names) names))))

#?(:clj
   (t/deftest a-parser-fault-is-a-compile-failure
     ;; A NullPointerException from the tokens parser is a fault, not a bad document
     (let [file (thf/sample-file :file1)
           data (with-redefs-fn {#'ctob/read-multi-set-dtcg
                                 (fn [& _] (throw (NullPointerException. "boom")))}
                  (fn []
                    (thrown-data #(compile-ops file [{:op "import_tokens_dtcg"
                                                      :json "{}" :mode "merge"}]))))]
       (t/is (= :mcp-compile-failed (:code data)))
       (t/is (= "import_tokens_dtcg" (:op data))))))

(t/deftest clone-of-a-copy-child-to-an-outside-parent-is-detached
  (let [file  (-> (thf/sample-file :file1)
                  (tho/add-simple-component-with-copy :c1 :main :main-child :copy)
                  (tho/add-frame :outside :x 500 :y 0 :width 100 :height 100))
        pid   (page-id-of file)
        inner (first (:shapes (shape-of file (thi/id :copy))))
        result (compile-ops file [{:op "clone_shape" :page-id pid :id inner
                                   :parent-id (thi/id :outside) :new-id "$tmp:clone"}])
        file'  (thf/apply-changes file {:redo-changes (:changes result)})
        clone  (shape-of file' (created result "$tmp:clone"))]
    (t/is (= (thi/id :outside) (:parent-id clone)))
    ;; Detached: the clone keeps no link to its component or its main shape
    (t/is (nil? (:shape-ref clone)))
    (t/is (nil? (:component-id clone)))
    (t/is (not (ctk/in-component-copy? clone)))))

(t/deftest nesting-level-delta-accepts-a-non-empty-list-of-heads
  ;; A shape in a copy has heads to compare with the new parent's heads: the
  ;; comparison of the two lists must not call its predicate with one argument
  (let [file  (-> (thf/sample-file :file1)
                  (tho/add-simple-component-with-copy :c1 :main :main-child :copy)
                  (tho/add-frame :outside :x 500 :y 0 :width 100 :height 100))
        objects (get-in (:data file) [:pages-index (page-id-of file) :objects])
        inner   (shape-of file (first (:shapes (shape-of file (thi/id :copy)))))]
    (t/is (integer? (ctn/get-nesting-level-delta objects inner (get objects (thi/id :outside)))))))

;; --- PROPS THAT CANNOT BE SET ALONE

(t/deftest update-shape-refuses-a-flip-on-a-rect
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)]
    (doseq [k [:flip-x :flip-y]]
      (let [data (thrown-data #(compile-ops file [{:op "update_shape" :page-id pid :id r1
                                                   :props {k true}}]))]
        (t/is (= :validation (:type data)))
        (t/is (= :mcp-invalid-operation (:code data)))
        (t/is (str/includes? (str (:hint data)) (str k)))
        (t/is (str/includes? (str (:hint data)) "a flip cannot be set through this operation"))))))

(t/deftest update-shape-refuses-a-flip-on-a-group
  (let [file (-> (two-rects-file)
                 (tho/add-group :group1))
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "update_shape" :page-id pid :id (thi/id :group1)
                                               :props {:flip-x true}}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (str/includes? (str (:hint data)) ":flip-x"))))

(t/deftest create-ops-refuse-a-flip
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)]
    (doseq [op ["create_rect" "create_ellipse" "create_board"]]
      (let [data (thrown-data #(compile-ops file [{:op op :page-id pid
                                                   :x 0 :y 0 :width 10 :height 10
                                                   :props {:flip-y true}}]))]
        (t/is (= :mcp-invalid-operation (:code data)))
        (t/is (str/includes? (str (:hint data)) ":flip-y"))))))

(t/deftest create-ops-refuse-a-rotation-in-props
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "create_rect" :page-id pid
                                               :x 0 :y 0 :width 10 :height 10
                                               :props {:rotation 45}}]))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (str/includes? (str (:hint data)) "update_shape"))))

(t/deftest geometry-key-hint-does-not-send-update-shape-to-itself
  (let [file (two-rects-file)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "update_shape" :page-id pid :id (thi/id :rect1)
                                               :props {:transform {}}}]))]
    (t/is (str/includes? (str (:hint data)) "x, y, width, height and rotation in update_shape"))))

;; --- SHADOWS WITHOUT AN ID

(def ^:private shadow-without-id
  (dissoc drop-shadow :id))

(t/deftest create-rect-fills-in-the-id-of-a-shadow
  (let [file (thf/sample-file :file1)
        pid  (page-id-of file)
        [file' result] (apply-ops file [{:op "create_rect" :page-id pid :id "$tmp:r"
                                         :x 0 :y 0 :width 40 :height 40
                                         :props {:shadow [shadow-without-id
                                                          (assoc shadow-without-id :style "inner-shadow")]}}])
        shadows (:shadow (shape-of file' (created result "$tmp:r")))]
    (t/is (= 2 (count shadows)))
    (t/is (every? uuid? (map :id shadows)))
    (t/is (= 2 (count (distinct (map :id shadows)))))
    (t/is (= [:drop-shadow :inner-shadow] (mapv :style shadows)))))

(t/deftest update-shape-fills-in-the-id-of-a-shadow-and-keeps-a-given-one
  (let [file (two-rects-file)
        pid  (page-id-of file)
        r1   (thi/id :rect1)
        given (uuid/next)
        [file' _] (apply-ops file [{:op "update_shape" :page-id pid :id r1
                                    :props {:shadow [shadow-without-id
                                                     (assoc shadow-without-id :id (str given))]}}])
        shadows (:shadow (shape-of file' r1))]
    (t/is (uuid? (:id (first shadows))))
    (t/is (not= given (:id (first shadows))))
    (t/is (= given (:id (second shadows))))))

(t/deftest the-new-id-fn-makes-the-id-of-a-shadow
  (let [file  (two-rects-file)
        pid   (page-id-of file)
        fixed (uuid/next)
        result (mops/compile-operations (:data file)
                                        [{:op "update_shape" :page-id pid :id (thi/id :rect1)
                                          :props {:shadow [shadow-without-id]}}]
                                        {:new-id-fn (constantly fixed)})
        file' (thf/apply-changes file {:redo-changes (:changes result)})]
    (t/is (= fixed (:id (first (:shadow (shape-of file' (thi/id :rect1)))))))))

(t/deftest a-wrong-shadow-gives-one-error-that-names-the-path
  (let [file (two-rects-file)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "update_shape" :page-id pid :id (thi/id :rect1)
                                               :props {:shadow [(assoc shadow-without-id
                                                                       :style "glow")]}}]))
        hint (str (:hint data))]
    (t/is (= :mcp-invalid-operation (:code data)))
    (t/is (str/includes? hint "props.shadow"))
    (t/is (str/includes? hint ":style"))
    (t/is (= 1 (count (re-seq #"props\.shadow" hint))))))

(t/deftest a-shadow-missing-a-required-key-is-named-once
  (let [file (two-rects-file)
        pid  (page-id-of file)
        data (thrown-data #(compile-ops file [{:op "update_shape" :page-id pid :id (thi/id :rect1)
                                               :props {:shadow [(dissoc shadow-without-id :blur)]}}]))
        hint (str (:hint data))]
    (t/is (str/includes? hint "props.shadow"))
    (t/is (str/includes? hint ":blur"))
    (t/is (<= (count (re-seq #"missing required key" hint)) 1))))
