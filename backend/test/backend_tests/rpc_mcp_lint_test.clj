;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-mcp-lint-test
  (:require
   [app.binfile.common :as bfc]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.http.access-token :as-alias actoken]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.mcp :as mcp]
   [app.rpc.commands.mcp-lint :as mcp-lint]
   [app.util.cache :as cache]
   [app.util.pointer-map :as pmap]
   [backend-tests.helpers :as th]
   [clojure.test :as t]))

(t/use-fixtures :once (t/compose-fixtures
                       (partial th/init-config [:enable-access-tokens
                                                :enable-client-header-check-middleware])
                       th/init-system))

(defn- clear-mcp-caches
  "Empties the MCP caches between tests. Test files reuse the same file
  ids, so a root cached by one test would answer for another test's file
  with the same revision."
  [f]
  (doseq [c [@#'mcp/root-cache @#'mcp/page-cache @#'mcp/outline-cache]]
    (cache/invalidate c))
  (f))

(t/use-fixtures :each th/database-reset clear-mcp-caches)

;; --- HELPERS

(defn- call!
  "Runs an MCP read command as `profile`, authenticated with an MCP token
  of `perms`. `token-id` is passed as the id of the request's token."
  [profile method params & {:keys [perms token-id]}]
  (let [data (merge {::th/type method
                     ::rpc/profile-id (:id profile)
                     ::rpc/auth-type :token
                     ::rpc/token-type "mcp"
                     ::rpc/token-perms (or perms #{})}
                    params)]
    (th/command!
     (cond-> data
       (some? token-id)
       (vary-meta assoc :app.http/request
                  {:headers {}
                   ::actoken/id token-id})))))

(defn- current-revn
  [file-id]
  (:revn (th/db-get :file {:id file-id})))

(defn- apply-changes!
  [profile file-id changes]
  (th/update-file* {:file-id file-id
                    :profile-id (:id profile)
                    :revn (current-revn file-id)
                    :changes (vec changes)}))

(defn- add-obj
  [page-id id parent-id frame-id attrs]
  {:type :add-obj
   :page-id page-id
   :id id
   :parent-id parent-id
   :frame-id frame-id
   :obj (cts/setup-shape (merge {:id id
                                 :parent-id parent-id
                                 :frame-id frame-id}
                                attrs))})

(defn- obj
  "An `add-obj` change of a shape of `type` named `name`, at (`x`, `y`)
  with the size `w` by `h`, under `parent` in `frame`. `attrs` are merged in."
  [page-id id parent frame type name x y w h attrs]
  (add-obj page-id id parent frame
           (merge {:type type :name name :x x :y y :width w :height h} attrs)))

(defn- text-content
  "The content tree of one paragraph that holds the characters `s`."
  [s]
  {:type "root"
   :children [{:type "paragraph-set"
               :children [{:type "paragraph"
                           :children [{:text s
                                       :font-size "14"
                                       :font-family "sourcesanspro"
                                       :font-weight "400"
                                       :fills [{:fill-color "#000000"
                                                :fill-opacity 1}]}]}]}]})

(defn- instance-attrs
  "The attributes that make a shape a component instance head."
  [file-id component-id]
  {:component-id component-id
   :component-file file-id
   :show-content true})

(defn- new-file
  "A profile and a file with one page. Returns the profile, the file id
  and the page id."
  []
  (let [profile (th/create-profile* 1 {:is-active true})
        file    (th/create-file* 1 {:profile-id (:id profile)
                                    :project-id (:default-project-id profile)})]
    {:profile profile
     :file-id (:id file)
     :page-id (get-in file [:data :pages 0])}))

(defn- lint
  "Runs `get-mcp-page-lint` on the page of a file, with `params` merged in."
  [profile file-id page-id params]
  (call! profile :get-mcp-page-lint (merge {:file-id file-id :page-id page-id} params)))

(defn- similar
  "Runs `find-mcp-similar-boards` on the page of a file, with `params` merged in."
  [profile file-id page-id params]
  (call! profile :find-mcp-similar-boards (merge {:file-id file-id :page-id page-id} params)))

(defn- findings-of
  "The findings of `rule` in the `out` reply of a lint call."
  [out rule]
  (filter #(= rule (:rule %)) (:findings (:result out))))

;; --- LINT: BOARD RULES

(t/deftest lint-empty-board-counts-visible-shapes-only
  (let [{:keys [profile file-id page-id]} (new-file)
        [b1 r1 r2 b2 hidden-rect hidden-group hg1 hg2 visible-rect b3 f1 f2 f3]
        (repeatedly 13 uuid/next)
        _       (apply-changes!
                 profile file-id
                 [(obj page-id b1 uuid/zero uuid/zero :frame "Empty" 0 0 200 200 {:show-content false})
                  (obj page-id r1 b1 b1 :rect "R1" 0 0 10 10 {})
                  (obj page-id r2 b1 b1 :rect "R2" 20 0 10 10 {})
                  (obj page-id b2 uuid/zero uuid/zero :frame "Hidden" 300 0 200 200 {:show-content false})
                  (obj page-id hidden-rect b2 b2 :rect "Hidden rect" 0 0 10 10 {:hidden true})
                  (obj page-id hidden-group b2 b2 :group "Hidden group" 0 0 50 50 {:hidden true})
                  (obj page-id hg1 hidden-group b2 :rect "In group 1" 0 0 10 10 {})
                  (obj page-id hg2 hidden-group b2 :rect "In group 2" 20 0 10 10 {})
                  (obj page-id visible-rect b2 b2 :rect "Visible" 100 0 10 10 {})
                  (obj page-id b3 uuid/zero uuid/zero :frame "Full" 600 0 200 200 {:show-content false})
                  (obj page-id f1 b3 b3 :rect "F1" 0 0 10 10 {})
                  (obj page-id f2 b3 b3 :rect "F2" 20 0 10 10 {})
                  (obj page-id f3 b3 b3 :rect "F3" 40 0 10 10 {})])
        out     (lint profile file-id page-id {:rules [:empty-board]})
        empty   (findings-of out :empty-board)]
    (t/is (nil? (:error out)))
    (t/is (= 3 (:boards (:result out))))
    (t/is (= #{b1 b2} (set (map :board-id empty))))
    (t/is (= 2 (:shape-count (:detail (first (filter #(= b1 (:board-id %)) empty))))))
    (t/is (= 1 (:shape-count (:detail (first (filter #(= b2 (:board-id %)) empty))))))
    (t/is (= {"empty-board" 2} (:counts (:result out))))
    (t/is (false? (:truncated (:result out))))))

(t/deftest lint-instance-only-board-names-the-chrome-component
  (let [{:keys [profile file-id page-id]} (new-file)
        cid    (uuid/next)
        [b1 b2 b3] (repeatedly 3 uuid/next)
        [i1 i2 i3] (repeatedly 3 uuid/next)
        [t1 t2 t3] (repeatedly 3 uuid/next)
        rect   (uuid/next)
        _      (apply-changes!
                profile file-id
                (concat
                 (mapcat (fn [b i t x]
                           [(obj page-id b uuid/zero uuid/zero :frame "Only" x 0 200 200 {:show-content false})
                            (obj page-id i b b :frame "Button" x 0 100 50 (instance-attrs file-id cid))
                            (obj page-id t i b :text "Label" (+ x 10) 10 80 20
                                 {:content (text-content "Button")})])
                         [b1 b2 b3] [i1 i2 i3] [t1 t2 t3] [0 300 600])
                 [(obj page-id rect b3 b3 :rect "Content" 100 100 50 50 {})]))
        out    (lint profile file-id page-id {:rules [:instance-only-board]})
        found  (findings-of out :instance-only-board)]
    (t/is (nil? (:error out)))
    (t/is (= [b1 b2] (map :board-id found)) "the board with content is not reported")
    (t/is (every? nil? (map :shape-id found)) "the finding is about the board")
    (t/is (= {:chrome-component-ids [cid] :content-shapes 0}
             (:detail (first found))))
    (t/is (= [{:id cid :name "Button" :boards 3}] (:chrome-components (:result out))))
    (t/is (= {"instance-only-board" 2} (:counts (:result out))))))

(t/deftest lint-clipped-invisible-and-off-board-controls
  (let [{:keys [profile file-id page-id]} (new-file)
        clip  (uuid/next)
        half  (uuid/next)
        half-t (uuid/next)
        out-c (uuid/next)
        out-t (uuid/next)
        in-c  (uuid/next)
        in-t  (uuid/next)
        no-t  (uuid/next)
        open  (uuid/next)
        off-c (uuid/next)
        off-t (uuid/next)
        cid   (uuid/next)
        _     (apply-changes!
               profile file-id
               [(obj page-id clip uuid/zero uuid/zero :frame "Clip" 0 0 200 200 {:show-content false})
                (obj page-id half clip clip :frame "Half" 150 0 100 50 (instance-attrs file-id cid))
                (obj page-id half-t half clip :text "T" 160 10 20 10 {:content (text-content "Half")})
                (obj page-id out-c clip clip :frame "Out" 300 0 50 50 (instance-attrs file-id cid))
                (obj page-id out-t out-c clip :text "T" 310 10 10 10 {:content (text-content "Out")})
                (obj page-id in-c clip clip :frame "In" 10 100 50 50 (instance-attrs file-id cid))
                (obj page-id in-t in-c clip :text "T" 20 110 10 10 {:content (text-content "In")})
                (obj page-id no-t clip clip :frame "No text" 300 150 50 50 (instance-attrs file-id cid))
                (obj page-id open uuid/zero uuid/zero :frame "Open" 400 0 200 200 {:show-content true})
                (obj page-id off-c open open :frame "Off" 550 0 131 50 (instance-attrs file-id cid))
                (obj page-id off-t off-c open :text "T" 560 10 10 10 {:content (text-content "Off")})])
        out   (lint profile file-id page-id {:rules [:clipped-control :invisible-control :off-board-control]})
        all   (:findings (:result out))
        by-id (fn [id] (filter #(= id (:shape-id %)) all))
        h     (first (by-id half))
        i     (first (by-id out-c))
        o     (first (by-id off-c))]
    (t/is (nil? (:error out)))
    (t/is (= :clipped-control (:rule h)))
    (t/is (= clip (:board-id h)))
    (t/is (== 0.5 (get-in h [:detail :visible-fraction])))
    (t/is (= clip (get-in h [:detail :clipped-by])))
    (t/is (= :invisible-control (:rule i)))
    (t/is (= clip (get-in i [:detail :clipped-by])))
    (t/is (== 0 (get-in i [:detail :visible-fraction])))
    (t/is (= :off-board-control (:rule o)))
    (t/is (== 81 (get-in o [:detail :overflow :right])))
    (t/is (== 0 (get-in o [:detail :overflow :left])))
    (t/is (== 0 (get-in o [:detail :overflow :top])))
    (t/is (== 0 (get-in o [:detail :overflow :bottom])))
    (t/is (empty? (by-id in-c)) "a control wholly inside its board is not reported")
    (t/is (empty? (by-id no-t)) "an instance without text is not a control")))

(t/deftest lint-rules-limit-the-findings-and-unknown-rules-are-refused
  (let [{:keys [profile file-id page-id]} (new-file)
        board (uuid/next)
        _     (apply-changes!
               profile file-id
               [(obj page-id board uuid/zero uuid/zero :frame "Empty" 0 0 200 200 {:show-content false})])
        only  (lint profile file-id page-id {:rules [:off-board-control]})
        bad   (lint profile file-id page-id {:rules [:nope]})]
    (t/is (nil? (:error only)))
    (t/is (empty? (:findings (:result only))))
    (t/is (= {"off-board-control" 0} (:counts (:result only))))
    (t/is (some? (:error bad)) "an unknown rule name is refused")))

(t/deftest lint-depth-reaches-nested-frames
  (let [{:keys [profile file-id page-id]} (new-file)
        outer (uuid/next)
        nest  (uuid/next)
        _     (apply-changes!
               profile file-id
               [(obj page-id outer uuid/zero uuid/zero :frame "Outer" 0 0 400 400 {:show-content true})
                (obj page-id nest outer outer :frame "Nested" 10 10 100 100 {:show-content true})])
        one   (lint profile file-id page-id {:depth 1 :rules [:empty-board]})
        two   (lint profile file-id page-id {:depth 2 :rules [:empty-board]})]
    (t/is (= 1 (:boards (:result one))))
    (t/is (not-any? #(= nest (:board-id %)) (:findings (:result one))))
    (t/is (= 2 (:boards (:result two))))
    (t/is (some #(= nest (:board-id %)) (:findings (:result two))))))

(t/deftest lint-board-name-regex-selects-boards
  (let [{:keys [profile file-id page-id]} (new-file)
        alpha (uuid/next)
        beta  (uuid/next)
        _     (apply-changes!
               profile file-id
               [(obj page-id alpha uuid/zero uuid/zero :frame "Alpha" 0 0 200 200 {:show-content false})
                (obj page-id beta uuid/zero uuid/zero :frame "Beta" 300 0 200 200 {:show-content false})])
        out   (lint profile file-id page-id {:board-name-regex "^Al" :rules [:empty-board]})
        bad   (lint profile file-id page-id {:board-name-regex "(["})]
    (t/is (= 1 (:boards (:result out))))
    (t/is (= [alpha] (map :board-id (:findings (:result out)))))
    (t/is (= :mcp-invalid-regex (th/ex-code (:error bad))))))

(t/deftest lint-stops-at-the-limit-and-the-budget
  (let [{:keys [profile file-id page-id]} (new-file)
        a     (uuid/next)
        b     (uuid/next)
        _     (apply-changes!
               profile file-id
               [(obj page-id a uuid/zero uuid/zero :frame "A" 0 0 200 200 {:show-content false})
                (obj page-id b uuid/zero uuid/zero :frame "B" 300 0 200 200 {:show-content false})])
        limited (lint profile file-id page-id {:limit 1 :rules [:empty-board]})
        budget  (with-redefs [mcp-lint/budget-ns 0]
                  (lint profile file-id page-id {:rules [:empty-board]}))]
    (t/is (= 1 (count (:findings (:result limited)))))
    (t/is (true? (:truncated (:result limited))))
    (t/is (true? (:truncated (:result budget))))
    (t/is (empty? (:findings (:result budget))))))

(t/deftest lint-refuses-a-profile-without-access
  (let [{:keys [file-id page-id]} (new-file)
        outsider (th/create-profile* 2 {:is-active true})
        out      (lint outsider file-id page-id {})]
    (t/is (= :not-found (th/ex-type (:error out))))))

(t/deftest lint-audit-props-name-the-file-and-page
  (let [{:keys [profile file-id page-id]} (new-file)
        out   (lint profile file-id page-id {:rules [:clipped-control :invisible-control :scroll-hidden-control :off-board-control]})
        props (:app.loggers.audit/replace-props (meta (:result out)))]
    (t/is (= "get-mcp-page-lint" (:tool props)))
    (t/is (= file-id (:file-id props)))
    (t/is (= [page-id] (:page-ids props)))))

(t/deftest lint-scroll-container-hides-rows-only-on-its-scrolled-axis
  (let [{:keys [profile file-id page-id]} (new-file)
        cid      (uuid/next)
        board    (uuid/next)
        list-s   (uuid/next)
        row5     (uuid/next)
        row5-t   (uuid/next)
        row6     (uuid/next)
        row6-t   (uuid/next)
        list-n   (uuid/next)
        row5n    (uuid/next)
        row5n-t  (uuid/next)
        _        (apply-changes!
                  profile file-id
                  [(obj page-id board uuid/zero uuid/zero :frame "Board" 0 0 400 600 {:show-content false})
                   (obj page-id list-s board board :frame "Scrolling list" 0 0 200 100
                        {:show-content false :overflow-scroll :vertical})
                   (obj page-id row5 list-s list-s :frame "Row 5" 0 150 200 20
                        (instance-attrs file-id cid))
                   (obj page-id row5-t row5 list-s :text "T" 10 155 50 10
                        {:content (text-content "Row 5")})
                   (obj page-id row6 list-s list-s :frame "Row 6" 150 0 100 20
                        (instance-attrs file-id cid))
                   (obj page-id row6-t row6 list-s :text "T" 160 5 20 10
                        {:content (text-content "Row 6")})
                   (obj page-id list-n board board :frame "Plain list" 0 300 200 100
                        {:show-content false})
                   (obj page-id row5n list-n list-n :frame "Row 5 plain" 0 450 200 20
                        (instance-attrs file-id cid))
                   (obj page-id row5n-t row5n list-n :text "T" 10 455 50 10
                        {:content (text-content "Row 5 plain")})])
        out      (lint profile file-id page-id {:rules [:clipped-control :invisible-control :scroll-hidden-control :off-board-control]})
        found    (fn [id] (first (filter #(= id (:shape-id %)) (:findings (:result out)))))]
    (t/is (nil? (:error out)))
    (t/is (= :scroll-hidden-control (:rule (found row5))))
    (t/is (= list-s (get-in (found row5) [:detail :scrolled-by])))
    (t/is (== 0 (get-in (found row5) [:detail :visible-fraction])))
    (t/is (= :clipped-control (:rule (found row6))) "cut on the scrolled axis stays clipped")
    (t/is (= list-s (get-in (found row6) [:detail :clipped-by])))
    (t/is (= :invisible-control (:rule (found row5n))) "without the attribute it is cut off for good")
    (t/is (contains? (:counts (:result out)) "scroll-hidden-control"))
    (t/is (= 1 (get-in (:result out) [:counts "scroll-hidden-control"])))))

;; --- LINT: COMPONENT BOARDS

(defn- main-attrs
  "The attributes of the main board of the component `component-id`."
  [file-id component-id]
  (merge (instance-attrs file-id component-id)
         {:main-instance true :component-root true}))

(defn- copy-attrs
  "The attributes of a component copy head of `component-id` whose main is
  the shape `ref`."
  [file-id component-id ref]
  (merge (instance-attrs file-id component-id)
         {:component-root true :shape-ref ref}))

(t/deftest lint-component-main-board-is-not-an-empty-board
  (let [{:keys [profile file-id page-id]} (new-file)
        cid     (uuid/next)
        main    (uuid/next)
        main-t  (uuid/next)
        plain   (uuid/next)
        plain-r (uuid/next)
        _       (apply-changes!
                 profile file-id
                 [(obj page-id main uuid/zero uuid/zero :frame "Button" 0 0 100 50
                       (main-attrs file-id cid))
                  (obj page-id main-t main main :text "Label" 10 10 80 20
                       {:content (text-content "Button")})
                  (obj page-id plain uuid/zero uuid/zero :frame "Screen" 300 0 200 200
                       {:show-content false})
                  (obj page-id plain-r plain plain :rect "R" 0 0 10 10 {})])
        out     (lint profile file-id page-id {:rules [:empty-board]})]
    (t/is (nil? (:error out)))
    (t/is (= 2 (:boards (:result out))))
    (t/is (= [plain] (map :board-id (findings-of out :empty-board))))
    (t/is (= {"empty-board" 1} (:counts (:result out))))))

(t/deftest lint-component-copy-inside-a-screen-is-not-an-empty-board
  (let [{:keys [profile file-id page-id]} (new-file)
        cid    (uuid/next)
        screen (uuid/next)
        copy   (uuid/next)
        copy-t (uuid/next)
        rects  (repeatedly 4 uuid/next)
        _      (apply-changes!
                profile file-id
                (concat [(obj page-id screen uuid/zero uuid/zero :frame "Screen" 0 0 800 800
                              {:show-content false})
                         (obj page-id copy screen screen :frame "Button copy" 10 10 100 50
                              (copy-attrs file-id cid (uuid/next)))
                         (obj page-id copy-t copy screen :text "Label" 20 20 80 20
                              {:content (text-content "Button")})]
                        (map-indexed (fn [i r]
                                       (obj page-id r screen screen :rect "Rect"
                                            (* i 20) 200 10 10 {}))
                                     rects)))
        out    (lint profile file-id page-id {:depth 2 :rules [:empty-board]})]
    (t/is (nil? (:error out)))
    (t/is (= 2 (:boards (:result out))) "the screen and the copy are both boards")
    (t/is (empty? (findings-of out :empty-board)))
    (t/is (= {"empty-board" 0} (:counts (:result out))))))

(t/deftest lint-frames-inside-a-component-copy-are-not-empty-boards
  (let [{:keys [profile file-id page-id]} (new-file)
        cid     (uuid/next)
        plain   (uuid/next)
        plain-r (uuid/next)
        copy    (uuid/next)
        copy-t  (uuid/next)
        ref-f   (uuid/next)
        ref-r   (uuid/next)
        pln-f   (uuid/next)
        pln-r   (uuid/next)
        _       (apply-changes!
                 profile file-id
                 [(obj page-id plain uuid/zero uuid/zero :frame "Screen" 300 0 200 200
                       {:show-content false})
                  (obj page-id plain-r plain plain :rect "R" 0 0 10 10 {})
                  (obj page-id copy uuid/zero uuid/zero :frame "Copy" 0 0 300 300
                       (copy-attrs file-id cid (uuid/next)))
                  (obj page-id copy-t copy copy :text "Label" 10 10 80 20
                       {:content (text-content "Copy")})
                  (obj page-id ref-f copy copy :frame "Shape-ref frame" 10 40 100 100
                       {:shape-ref (uuid/next)})
                  (obj page-id ref-r ref-f ref-f :rect "R" 0 0 10 10 {})
                  (obj page-id pln-f copy copy :frame "Plain in copy" 150 40 100 100
                       {:show-content false})
                  (obj page-id pln-r pln-f pln-f :rect "R" 0 0 10 10 {})])
        out     (lint profile file-id page-id {:depth 3 :rules [:empty-board]})]
    (t/is (nil? (:error out)))
    (t/is (= 4 (:boards (:result out))))
    (t/is (= [plain] (map :board-id (findings-of out :empty-board))))
    (t/is (= {"empty-board" 1} (:counts (:result out))))))

(t/deftest lint-component-main-with-only-an-instance-is-not-instance-only
  (let [{:keys [profile file-id page-id]} (new-file)
        cid      (uuid/next)
        main     (uuid/next)
        nested   (uuid/next)
        nested-t (uuid/next)
        screens  (repeatedly 3 uuid/next)
        _        (apply-changes!
                  profile file-id
                  (concat
                   [(obj page-id main uuid/zero uuid/zero :frame "Main" 0 0 200 200
                         (main-attrs file-id cid))
                    (obj page-id nested main main :frame "Nested" 10 10 100 50
                         (instance-attrs file-id cid))
                    (obj page-id nested-t nested main :text "T" 20 20 50 10
                         {:content (text-content "N")})]
                   (mapcat (fn [screen x]
                             (let [only (uuid/next)
                                   text (uuid/next)]
                               [(obj page-id screen uuid/zero uuid/zero :frame "Screen" x 0 200 200
                                     {:show-content false})
                                (obj page-id only screen screen :frame "Only" (+ x 10) 10 100 50
                                     (instance-attrs file-id cid))
                                (obj page-id text only screen :text "T" (+ x 20) 20 50 10
                                     {:content (text-content "O")})]))
                           screens [300 600 900])))
        out      (lint profile file-id page-id {:depth 1 :rules [:instance-only-board]})]
    (t/is (nil? (:error out)))
    (t/is (= 4 (:boards (:result out))) "the main board is checked and skipped")
    (t/is (= screens (map :board-id (findings-of out :instance-only-board))))
    (t/is (= {"instance-only-board" 3} (:counts (:result out))))))

(t/deftest lint-controls-in-a-component-board-are-still-reported
  (let [{:keys [profile file-id page-id]} (new-file)
        cid   (uuid/next)
        board (uuid/next)
        ctl   (uuid/next)
        txt   (uuid/next)
        _     (apply-changes!
               profile file-id
               [(obj page-id board uuid/zero uuid/zero :frame "Button" 0 0 200 200
                     (merge (main-attrs file-id cid) {:show-content false}))
                (obj page-id ctl board board :frame "Crosses" 150 50 100 20
                     (instance-attrs file-id (uuid/next)))
                (obj page-id txt ctl board :text "T" 155 55 20 10
                     {:content (text-content "X")})])
        out   (lint profile file-id page-id {:rules [:empty-board :instance-only-board :clipped-control]})]
    (t/is (nil? (:error out)))
    (t/is (= [:clipped-control]
             (map :rule (filter #(= ctl (:shape-id %)) (:findings (:result out))))))
    (t/is (empty? (findings-of out :empty-board)))
    (t/is (empty? (findings-of out :instance-only-board)))
    (t/is (= {"empty-board" 0 "instance-only-board" 0 "clipped-control" 1}
             (:counts (:result out))))))

;; --- SIMILAR BOARDS

(defn- texts-board
  "The changes of a board `id` named `name` at (`x`, `y`), with one text
  shape per string of `texts` stacked inside it."
  [page-id id name x y texts]
  (into [(obj page-id id uuid/zero uuid/zero :frame name x y 300 300 {:show-content false})]
        (map-indexed (fn [i s]
                       (obj page-id (uuid/next) id id :text s x (+ y (* i 20)) 80 20
                            {:content (text-content s)})))
        texts))

(defn- group-ids
  "The sets of board ids of the groups of a similar-boards reply."
  [out]
  (map #(set (map :id (:boards %))) (:groups (:result out))))

(t/deftest similar-boards-group-exact-and-near-copies
  (let [{:keys [profile file-id page-id]} (new-file)
        labels  (mapv #(str "Label " %) (range 10))
        other   (conj (vec (butlast labels)) "Other")
        pair    (mapv #(str "Pair " %) (range 10))
        unique  (mapv #(str "Unique " %) (range 10))
        [s1 s2 s3 s4 p1 p2 u1 small] (repeatedly 8 uuid/next)
        _       (apply-changes!
                 profile file-id
                 (concat (texts-board page-id s1 "Alpha" 0 0 labels)
                         (texts-board page-id s2 "Beta" 400 0 labels)
                         (texts-board page-id s3 "Gamma" 800 0 labels)
                         (texts-board page-id s4 "Delta" 1200 0 other)
                         (texts-board page-id p1 "Pair one" 0 400 pair)
                         (texts-board page-id p2 "Pair two" 400 400 pair)
                         (texts-board page-id u1 "Unique" 800 400 unique)
                         (texts-board page-id small "Small" 1200 400 ["x" "y"])))
        strict  (similar profile file-id page-id {:threshold 0.99})
        near    (similar profile file-id page-id {:threshold 0.8})
        groups  (:groups (:result strict))]
    (t/is (nil? (:error strict)))
    (t/is (= 7 (:boards (:result strict))) "a board with fewer than min-shapes is left out")
    (t/is (= [#{s1 s2 s3} #{p1 p2}] (group-ids strict)))
    (t/is (every? :exact groups))
    (t/is (every? #(== 1 (:similarity %)) groups))
    (t/is (false? (:truncated (:result strict))))
    (t/is (= [#{s1 s2 s3 s4} #{p1 p2}] (group-ids near)))
    (let [merged (first (:groups (:result near)))]
      (t/is (false? (:exact merged)))
      (t/is (< 0.81 (:similarity merged) 0.82))
      (t/is (true? (:exact (second (:groups (:result near)))))))))

(t/deftest similar-boards-limit-budget-and-cap-say-so
  (let [{:keys [profile file-id page-id]} (new-file)
        labels (mapv #(str "Label " %) (range 10))
        pairs  (mapv #(str "Pair " %) (range 10))
        [s1 s2 s3 p1 p2] (repeatedly 5 uuid/next)
        _      (apply-changes!
                profile file-id
                (concat (texts-board page-id s1 "A" 0 0 labels)
                        (texts-board page-id s2 "B" 400 0 labels)
                        (texts-board page-id s3 "C" 800 0 labels)
                        (texts-board page-id p1 "D" 0 400 pairs)
                        (texts-board page-id p2 "E" 400 400 pairs)))
        limited (similar profile file-id page-id {:limit 1})
        budget  (with-redefs [mcp-lint/budget-ns 0]
                  (similar profile file-id page-id {}))
        capped  (with-redefs [mcp-lint/max-similar-boards 2]
                  (similar profile file-id page-id {}))]
    (t/is (= 1 (count (:groups (:result limited)))))
    (t/is (true? (:truncated (:result limited))))
    (t/is (true? (:truncated (:result budget))))
    (t/is (empty? (:groups (:result budget))))
    (t/is (= 2 (:boards (:result capped))))
    (t/is (true? (:truncated (:result capped))))))

(t/deftest similar-boards-refuse-a-profile-without-access
  (let [{:keys [file-id page-id]} (new-file)
        outsider (th/create-profile* 2 {:is-active true})
        out      (similar outsider file-id page-id {})]
    (t/is (= :not-found (th/ex-type (:error out))))))

(t/deftest similar-boards-audit-props-name-the-file-and-page
  (let [{:keys [profile file-id page-id]} (new-file)
        out   (similar profile file-id page-id {})
        props (:app.loggers.audit/replace-props (meta (:result out)))]
    (t/is (= "find-mcp-similar-boards" (:tool props)))
    (t/is (= file-id (:file-id props)))
    (t/is (= [page-id] (:page-ids props)))))

;; --- PURE FUNCTIONS

(t/deftest jaccard-index-is-the-sum-of-minimums-over-maximums
  (t/is (== 0.25 (mcp-lint/jaccard-index {:a 2 :b 1} {:a 1 :c 1})))
  (t/is (== 1 (mcp-lint/jaccard-index {:a 2} {:a 2})))
  (t/is (== 0 (mcp-lint/jaccard-index {:a 1} {:b 1}))))

(t/deftest shape-token-collapses-whitespace-of-text-only
  (t/is (= [:text nil "a b"]
           (mcp-lint/get-shape-token {:type :text :content (text-content "  a \n  b ")})))
  (t/is (= [:rect "c-1" nil]
           (mcp-lint/get-shape-token {:type :rect :component-id "c-1" :content (text-content "x")}))))

(t/deftest link-components-joins-linked-nodes
  (t/is (= [[0 1] [2] [3]] (mcp-lint/link-components 4 [[0 1 0.9]])))
  (t/is (= [[0 1 2] [3]] (mcp-lint/link-components 4 [[0 1 0.9] [1 2 0.85]]))))

(t/deftest box-helpers-measure-overlap-and-overflow
  (let [a {:x0 0 :y0 0 :x1 10 :y1 10}
        b {:x0 5 :y0 5 :x1 20 :y1 20}
        c {:x0 30 :y0 30 :x1 40 :y1 40}]
    (t/is (== 25 (mcp-lint/box-area (mcp-lint/box-intersection a b))))
    (t/is (== 0 (mcp-lint/box-area (mcp-lint/box-intersection a c))))
    (t/is (= {:left 5 :top 0 :right 20 :bottom 0}
             (mcp-lint/box-overflow {:x0 0 :y0 0 :x1 100 :y1 100}
                                    {:x0 -5 :y0 10 :x1 120 :y1 50})))))

(t/deftest visible-walk-skips-hidden-subtrees-and-respects-depth
  (let [objects {uuid/zero {:id uuid/zero :shapes [:a :h]}
                 :a        {:id :a :shapes [:c]}
                 :c        {:id :c :shapes []}
                 :h        {:id :h :hidden true :shapes [:x]}
                 :x        {:id :x :shapes []}}]
    (t/is (= [[1 :a] [2 :c]] (mcp-lint/get-visible-entries objects uuid/zero 2)))
    (t/is (= [:a :c] (mcp-lint/get-visible-descendant-ids objects uuid/zero)))
    (t/is (= [:a] (mcp-lint/get-visible-child-ids objects uuid/zero)))))

(t/deftest control-needs-an-instance-head-with-visible-text
  (let [objects {:i  {:id :i :component-id (uuid/next) :shapes [:t]}
                 :t  {:id :t :type :text :shapes []}
                 :j  {:id :j :component-id (uuid/next) :shapes [:r]}
                 :r  {:id :r :type :rect :shapes []}
                 :k  {:id :k :shapes [:t]}}]
    (t/is (true? (mcp-lint/control? objects (objects :i))))
    (t/is (not (mcp-lint/control? objects (objects :j))) "no text below the instance")
    (t/is (not (mcp-lint/control? objects (objects :k))) "not an instance")))

(t/deftest clipping-frames-stop-at-the-board
  (let [board {:id :board :type :frame :show-content false :parent-id uuid/zero}
        mid   {:id :mid :type :frame :show-content true :parent-id :board}
        ctl   {:id :ctl :parent-id :mid}
        objects {:board board :mid mid :ctl ctl}]
    (t/is (= [:board] (map :id (mcp-lint/get-clipping-frames objects ctl :board))))
    (t/is (= [] (map :id (mcp-lint/get-clipping-frames
                          (assoc objects :board (assoc board :show-content true))
                          ctl :board))))))

;; --- BOXES FROM THE POINTS

(t/deftest box-of-a-shape-is-the-box-of-its-points
  (let [rotated {:x 0 :y 0 :width 10 :height 10
                 :points [{:x 50 :y 0} {:x 100 :y 50} {:x 50 :y 100} {:x 0 :y 50}]}
        plain   {:x 5 :y 6 :width 20 :height 30}]
    (t/is (= {:x0 0.0 :y0 0.0 :x1 100.0 :y1 100.0} (mcp-lint/get-box rotated)))
    (t/is (= {:x0 5 :y0 6 :x1 25 :y1 36} (mcp-lint/get-box plain)))))

(t/deftest rotated-control-inside-its-board-is-not-reported
  (let [{:keys [profile file-id page-id]} (new-file)
        cid   (uuid/next)
        board (uuid/next)
        ctl   (uuid/next)
        txt   (uuid/next)
        _     (apply-changes!
               profile file-id
               [(obj page-id board uuid/zero uuid/zero :frame "Board" 0 0 300 300 {:show-content false})
                (obj page-id ctl board board :frame "Rotated" 50 130 200 40
                     (merge (instance-attrs file-id cid) {:rotation 90}))
                (obj page-id txt ctl board :text "T" 140 140 20 10
                     {:content (text-content "Rotated")})])
        out   (lint profile file-id page-id {:rules [:clipped-control :invisible-control :off-board-control]})]
    (t/is (nil? (:error out)))
    (t/is (empty? (filter #(= ctl (:shape-id %)) (:findings (:result out)))))))

;; --- SCROLL CONTAINERS

(defn- scroll-scene
  "The changes of a clipping board of 400 by 600 with one list `list-id` at
  (`lx`, `ly`) of the size `lw` by `lh`, with the attributes `attrs`."
  [page-id board list-id lx ly lw lh attrs]
  [(obj page-id board uuid/zero uuid/zero :frame "Board" 0 0 400 600 {:show-content false})
   (obj page-id list-id board board :frame "List" lx ly lw lh attrs)])

(defn- row-changes
  "The changes of an instance row `id` with a text child, under `frame` at
  (`x`, `y`) with the size 200 by 20."
  [file-id page-id frame id x y label]
  (let [txt (uuid/next)]
    [(obj page-id id frame frame :frame label x y 200 20 (instance-attrs file-id (uuid/next)))
     (obj page-id txt id frame :text "T" (+ x 5) (+ y 5) 50 10 {:content (text-content label)})]))

(t/deftest scroll-list-in-a-clipping-board-reports-rows-as-scroll-hidden
  (let [{:keys [profile file-id page-id]} (new-file)
        board (uuid/next)
        list  (uuid/next)
        row-a (uuid/next)
        row-b (uuid/next)
        _     (apply-changes!
               profile file-id
               (concat (scroll-scene page-id board list 0 0 400 600
                                     {:show-content false :overflow-scroll :vertical})
                       (row-changes file-id page-id list row-a 10 590 "Row A")
                       (row-changes file-id page-id list row-b 10 800 "Row B")))
        out   (lint profile file-id page-id {:rules [:clipped-control :invisible-control :scroll-hidden-control]})
        found (:findings (:result out))
        fa    (first (filter #(= row-a (:shape-id %)) found))]
    (t/is (nil? (:error out)))
    (t/is (= #{row-a row-b} (set (map :shape-id found))))
    (t/is (every? #(= :scroll-hidden-control (:rule %)) found))
    (t/is (every? #(= list (get-in % [:detail :scrolled-by])) found))
    (t/is (== 0.5 (get-in fa [:detail :visible-fraction])))))

(t/deftest scroll-list-without-the-attribute-keeps-the-rest-result
  (let [{:keys [profile file-id page-id]} (new-file)
        board (uuid/next)
        list  (uuid/next)
        row-a (uuid/next)
        row-b (uuid/next)
        _     (apply-changes!
               profile file-id
               (concat (scroll-scene page-id board list 0 0 400 600 {:show-content false})
                       (row-changes file-id page-id list row-a 10 590 "Row A")
                       (row-changes file-id page-id list row-b 10 800 "Row B")))
        out   (lint profile file-id page-id {:rules [:clipped-control :invisible-control :scroll-hidden-control]})
        found (:findings (:result out))]
    (t/is (nil? (:error out)))
    (t/is (= #{:clipped-control :invisible-control}
             (set (map :rule found))))))

(t/deftest horizontal-list-reaches-rows-past-its-right-edge
  (let [{:keys [profile file-id page-id]} (new-file)
        board (uuid/next)
        list  (uuid/next)
        row   (uuid/next)
        _     (apply-changes!
               profile file-id
               (concat [(obj page-id board uuid/zero uuid/zero :frame "Board" 0 0 400 600 {:show-content false})
                        (obj page-id list board board :frame "List" 0 0 400 100
                             {:show-content false :overflow-scroll :horizontal})]
                       (row-changes file-id page-id list row 390 10 "Row past")))
        out   (lint profile file-id page-id {:rules [:clipped-control :invisible-control :scroll-hidden-control]})
        found (first (filter #(= row (:shape-id %)) (:findings (:result out))))]
    (t/is (= :scroll-hidden-control (:rule found)))
    (t/is (= list (get-in found [:detail :scrolled-by])))))

(t/deftest both-axes-list-reaches-rows-outside-it
  (let [{:keys [profile file-id page-id]} (new-file)
        board (uuid/next)
        list  (uuid/next)
        row   (uuid/next)
        _     (apply-changes!
               profile file-id
               (concat [(obj page-id board uuid/zero uuid/zero :frame "Board" 0 0 400 600 {:show-content false})
                        (obj page-id list board board :frame "List" 0 0 400 600
                             {:show-content false :overflow-scroll :both})]
                       (row-changes file-id page-id list row 390 800 "Row far")))
        out   (lint profile file-id page-id {:rules [:clipped-control :invisible-control :scroll-hidden-control]})
        found (first (filter #(= row (:shape-id %)) (:findings (:result out))))]
    (t/is (= :scroll-hidden-control (:rule found)))
    (t/is (= list (get-in found [:detail :scrolled-by])))))

(t/deftest vertical-list-row-past-its-right-edge-stays-clipped
  (let [{:keys [profile file-id page-id]} (new-file)
        board (uuid/next)
        list  (uuid/next)
        row   (uuid/next)
        _     (apply-changes!
               profile file-id
               (concat (scroll-scene page-id board list 0 0 400 600
                                     {:show-content false :overflow-scroll :vertical})
                       (row-changes file-id page-id list row 390 100 "Past right")))
        out   (lint profile file-id page-id {:rules [:clipped-control :invisible-control :scroll-hidden-control]})
        found (first (filter #(= row (:shape-id %)) (:findings (:result out))))]
    (t/is (= :clipped-control (:rule found)))))

(t/deftest scroll-list-outside-its-board-leaves-rows-invisible
  (let [{:keys [profile file-id page-id]} (new-file)
        board (uuid/next)
        list  (uuid/next)
        row   (uuid/next)
        _     (apply-changes!
               profile file-id
               (concat [(obj page-id board uuid/zero uuid/zero :frame "Board" 0 0 400 600 {:show-content false})
                        (obj page-id list board board :frame "Outside list" 500 0 200 600
                             {:show-content false :overflow-scroll :vertical})]
                       (row-changes file-id page-id list row 510 100 "Outside row")))
        out   (lint profile file-id page-id {:rules [:clipped-control :invisible-control :scroll-hidden-control]})
        found (first (filter #(= row (:shape-id %)) (:findings (:result out))))]
    (t/is (= :invisible-control (:rule found)))))

;; --- REPORTING

(t/deftest control-is-reported-once-under-its-innermost-board
  (let [{:keys [profile file-id page-id]} (new-file)
        outer (uuid/next)
        inner (uuid/next)
        ctl   (uuid/next)
        txt   (uuid/next)
        _     (apply-changes!
               profile file-id
               [(obj page-id outer uuid/zero uuid/zero :frame "Outer" 0 0 400 400 {:show-content true})
                (obj page-id inner outer outer :frame "Inner" 100 100 200 200 {:show-content false})
                (obj page-id ctl inner inner :frame "Control" 250 250 100 100
                     (instance-attrs file-id (uuid/next)))
                (obj page-id txt ctl inner :text "T" 255 255 20 10 {:content (text-content "C")})])
        out   (lint profile file-id page-id {:depth 2 :rules [:clipped-control :invisible-control :scroll-hidden-control :off-board-control]})
        found (filter #(= ctl (:shape-id %)) (:findings (:result out)))]
    (t/is (= 1 (count found)))
    (t/is (= inner (:board-id (first found))))))

(t/deftest rules-filter-reports-the-asked-rule-even-when-clipped
  (let [{:keys [profile file-id page-id]} (new-file)
        board (uuid/next)
        ctl   (uuid/next)
        txt   (uuid/next)
        _     (apply-changes!
               profile file-id
               [(obj page-id board uuid/zero uuid/zero :frame "Board" 0 0 200 200 {:show-content false})
                (obj page-id ctl board board :frame "Crosses" 150 50 100 20 (instance-attrs file-id (uuid/next)))
                (obj page-id txt ctl board :text "T" 155 55 20 10 {:content (text-content "X")})])
        only  (lint profile file-id page-id {:rules [:off-board-control]})
        all   (lint profile file-id page-id {:rules [:clipped-control :invisible-control :scroll-hidden-control :off-board-control]})]
    (t/is (= [:off-board-control]
             (map :rule (filter #(= ctl (:shape-id %)) (:findings (:result only))))))
    (t/is (= [:clipped-control]
             (map :rule (filter #(= ctl (:shape-id %)) (:findings (:result all))))))))

(t/deftest counts-total-every-finding-when-the-limit-cuts-the-list
  (let [{:keys [profile file-id page-id]} (new-file)
        boards (repeatedly 3 uuid/next)
        _      (apply-changes!
                profile file-id
                (map-indexed (fn [i b]
                               (obj page-id b uuid/zero uuid/zero :frame (str "E" i)
                                    (* i 300) 0 200 200 {:show-content false}))
                             boards))
        out    (lint profile file-id page-id {:limit 1 :rules [:empty-board]})]
    (t/is (= 1 (count (:findings (:result out)))))
    (t/is (true? (:truncated (:result out))))
    (t/is (= {"empty-board" 3} (:counts (:result out))))))

(t/deftest lint-walks-the-findings-with-offset-and-limit
  (let [{:keys [profile file-id page-id]} (new-file)
        _      (apply-changes!
                profile file-id
                (map-indexed (fn [i b]
                               (obj page-id b uuid/zero uuid/zero :frame (str "E" i)
                                    (* i 300) 0 200 200 {:show-content false}))
                             (repeatedly 5 uuid/next)))
        params {:rules [:empty-board]}
        whole  (:result (lint profile file-id page-id params))
        page   (fn [offset]
                 (:result (lint profile file-id page-id
                                (assoc params :limit 2 :offset offset))))
        pages  (take-while some?
                           (iterate (fn [r] (when-let [n (:next-offset r)] (page n)))
                                    (page 0)))]
    (t/is (= 5 (count (:findings whole))))
    (t/is (= 5 (:total whole)))
    (t/is (nil? (:next-offset whole)))
    (t/is (= [2 2 1] (map (comp count :findings) pages)))
    (t/is (= (:findings whole) (mapcat :findings pages))
          "each finding once, in the order of one unbounded call")
    (t/is (= [2 4 nil] (map :next-offset pages)))
    (t/is (= [true true false] (map :truncated pages)))
    (t/is (every? #(= 5 (:total %)) pages))
    (t/is (every? #(= {"empty-board" 5} (:counts %)) pages))))

(t/deftest lint-total-is-the-sum-of-the-counts-of-the-asked-rules
  (let [{:keys [profile file-id page-id]} (new-file)
        _      (apply-changes!
                profile file-id
                [(obj page-id (uuid/next) uuid/zero uuid/zero :frame "A" 0 0 200 200
                      {:show-content false})])
        result (:result (lint profile file-id page-id
                              {:rules [:empty-board :clipped-control]}))]
    (t/is (= 1 (:total result)))
    (t/is (= (reduce + (vals (:counts result))) (:total result)))))

(t/deftest lint-a-time-cut-gives-no-next-offset
  (let [{:keys [profile file-id page-id]} (new-file)
        _      (apply-changes!
                profile file-id
                (map-indexed (fn [i b]
                               (obj page-id b uuid/zero uuid/zero :frame (str "E" i)
                                    (* i 300) 0 200 200 {:show-content false}))
                             (repeatedly 4 uuid/next)))
        select (requiring-resolve 'app.rpc.mcp-boards/select-boards)
        orig   @select
        out    (with-redefs-fn {select (fn [& args] (assoc (apply orig args) :timed-out? true))}
                 #(lint profile file-id page-id {:rules [:empty-board] :limit 2}))
        result (:result out)]
    (t/is (nil? (:error out)))
    (t/is (= 2 (count (:findings result))))
    (t/is (< 2 (:total result)))
    (t/is (true? (:truncated result)))
    (t/is (true? (:timed-out result)))
    (t/is (not (contains? result :next-offset)) "a later page could come from another list")))

(t/deftest lint-offset-past-the-end-gives-an-empty-list
  (let [{:keys [profile file-id page-id]} (new-file)
        _      (apply-changes!
                profile file-id
                [(obj page-id (uuid/next) uuid/zero uuid/zero :frame "A" 0 0 200 200
                      {:show-content false})])
        out    (lint profile file-id page-id {:rules [:empty-board] :offset 50})
        result (:result out)]
    (t/is (nil? (:error out)))
    (t/is (empty? (:findings result)))
    (t/is (= 1 (:total result)))
    (t/is (false? (:truncated result)))
    (t/is (not (contains? result :next-offset)))))

(t/deftest bad-board-name-regex-hint-names-the-parameter
  (let [{:keys [profile file-id page-id]} (new-file)
        bad (lint profile file-id page-id {:board-name-regex "(["})]
    (t/is (= :mcp-invalid-regex (th/ex-code (:error bad))))
    (t/is (re-find #"board-name-regex" (:hint (ex-data (:error bad)))))))

(t/deftest regex-guard-stops-a-backtracking-board-name
  (let [{:keys [profile file-id page-id]} (new-file)
        name  (str (apply str (repeat 60 \a)) "!")
        board (uuid/next)
        _     (apply-changes!
               profile file-id
               [(obj page-id board uuid/zero uuid/zero :frame name 0 0 200 200 {:show-content false})])
        out   (with-redefs [mcp-lint/budget-ns 200000000]
                (lint profile file-id page-id {:board-name-regex "(a+)+\\1$" :rules [:empty-board]}))
        long  (lint profile file-id page-id {:board-name-regex (apply str (repeat 201 \a))})]
    (t/is (nil? (:error out)))
    (t/is (true? (:truncated (:result out))))
    (t/is (some? (:error long)))))

(t/deftest deep-name-regex-answers-invalid-pattern-with-the-parameter-hint
  (let [{:keys [profile file-id page-id]} (new-file)
        board (uuid/next)
        _     (apply-changes!
               profile file-id
               [(obj page-id board uuid/zero uuid/zero :frame "Board" 0 0 200 200 {:show-content false})])
        out   (with-redefs [mcp-lint/name-re-find (fn [_ _] (throw (StackOverflowError.)))]
                (lint profile file-id page-id {:board-name-regex "B"}))]
    (t/is (= :mcp-invalid-pattern (th/ex-code (:error out))))
    (t/is (re-find #"board-name-regex" (:hint (ex-data (:error out)))))))

;; --- CLIPPING: NESTED FRAMES AND SIZES

(t/deftest nested-clipping-frames-name-the-one-that-cuts-the-most
  (let [{:keys [profile file-id page-id]} (new-file)
        b1  (uuid/next)
        m1  (uuid/next)
        c1  (uuid/next)
        t1  (uuid/next)
        b2  (uuid/next)
        m2  (uuid/next)
        c2  (uuid/next)
        t2  (uuid/next)
        _   (apply-changes!
             profile file-id
             [(obj page-id b1 uuid/zero uuid/zero :frame "B1" 0 0 200 200 {:show-content false})
              (obj page-id m1 b1 b1 :frame "M1" 0 0 100 200 {:show-content false})
              (obj page-id c1 m1 m1 :frame "C1" 50 50 100 20 (instance-attrs file-id (uuid/next)))
              (obj page-id t1 c1 m1 :text "T" 55 55 20 10 {:content (text-content "1")})
              (obj page-id b2 uuid/zero uuid/zero :frame "B2" 400 0 120 200 {:show-content false})
              (obj page-id m2 b2 b2 :frame "M2" 400 0 200 200 {:show-content false})
              (obj page-id c2 m2 m2 :frame "C2" 450 50 100 20 (instance-attrs file-id (uuid/next)))
              (obj page-id t2 c2 m2 :text "T" 455 55 20 10 {:content (text-content "2")})])
        out (lint profile file-id page-id {:rules [:clipped-control]})
        f1  (first (filter #(= c1 (:shape-id %)) (:findings (:result out))))
        f2  (first (filter #(= c2 (:shape-id %)) (:findings (:result out))))]
    (t/is (= m1 (get-in f1 [:detail :clipped-by])))
    (t/is (== 0.5 (get-in f1 [:detail :visible-fraction])))
    (t/is (= b2 (get-in f2 [:detail :clipped-by])))
    (t/is (== 0.7 (get-in f2 [:detail :visible-fraction])))))

(t/deftest zero-size-control-is-not-reported
  (let [{:keys [profile file-id page-id]} (new-file)
        board (uuid/next)
        ctl   (uuid/next)
        txt   (uuid/next)
        _     (apply-changes!
               profile file-id
               [(obj page-id board uuid/zero uuid/zero :frame "Board" 0 0 200 200 {:show-content false})
                (obj page-id ctl board board :frame "Empty" 10 10 0 0 (instance-attrs file-id (uuid/next)))
                (obj page-id txt ctl board :text "T" 10 10 5 5 {:content (text-content "Z")})])
        out   (lint profile file-id page-id {:rules [:clipped-control :invisible-control :scroll-hidden-control :off-board-control]})]
    (t/is (nil? (:error out)))
    (t/is (empty? (filter #(= ctl (:shape-id %)) (:findings (:result out)))))))

(t/deftest control-larger-than-its-board-is-clipped-by-it
  (let [{:keys [profile file-id page-id]} (new-file)
        board (uuid/next)
        ctl   (uuid/next)
        txt   (uuid/next)
        _     (apply-changes!
               profile file-id
               [(obj page-id board uuid/zero uuid/zero :frame "Board" 0 0 200 200 {:show-content false})
                (obj page-id ctl board board :frame "Huge" -100 -100 400 400 (instance-attrs file-id (uuid/next)))
                (obj page-id txt ctl board :text "T" 0 0 20 10 {:content (text-content "H")})])
        out   (lint profile file-id page-id {:rules [:clipped-control]})
        f     (first (filter #(= ctl (:shape-id %)) (:findings (:result out))))]
    (t/is (= :clipped-control (:rule f)))
    (t/is (= board (get-in f [:detail :clipped-by])))
    (t/is (== 0.25 (get-in f [:detail :visible-fraction])))))

;; --- SIMILAR BOARDS: HIDDEN, DEPTH, NAME, COUNT

(t/deftest similar-boards-ignore-hidden-descendants
  (let [{:keys [profile file-id page-id]} (new-file)
        labels (mapv #(str "Row " %) (range 10))
        [h1 h2 hidden] (repeatedly 3 uuid/next)
        _      (apply-changes!
                profile file-id
                (concat (texts-board page-id h1 "H1" 0 0 labels)
                        (texts-board page-id h2 "H2" 400 0 labels)
                        [(obj page-id hidden h2 h2 :rect "Hidden" 0 0 10 10 {:hidden true})]))
        out    (similar profile file-id page-id {:threshold 0.99})]
    (t/is (= [#{h1 h2}] (group-ids out)))))

(t/deftest similar-boards-honour-depth-and-the-name-regex
  (let [{:keys [profile file-id page-id]} (new-file)
        labels (mapv #(str "Line " %) (range 10))
        a      (uuid/next)
        b      (uuid/next)
        inner  (uuid/next)
        _      (apply-changes!
                profile file-id
                (concat (texts-board page-id a "Twin A" 0 0 labels)
                        (texts-board page-id b "Twin B" 400 0 labels)
                        [(obj page-id inner a a :frame "Other inner" 0 0 200 200 {:show-content false})]
                        (map-indexed (fn [i s]
                                       (obj page-id (uuid/next) inner inner :text s 10 (* i 20) 80 20
                                            {:content (text-content s)}))
                                     labels)))
        depth1 (similar profile file-id page-id {:threshold 0.99})
        depth2 (similar profile file-id page-id {:threshold 0.99 :depth 2})
        named  (similar profile file-id page-id {:threshold 0.99 :depth 2 :board-name-regex "^Twin"})]
    (t/is (= 2 (:boards (:result depth1))))
    (t/is (= [] (:groups (:result depth1))))
    (t/is (= 3 (:boards (:result depth2))))
    (t/is (= [#{b inner}] (group-ids depth2)))
    (t/is (= 2 (:boards (:result named))))))

(t/deftest similar-boards-report-the-pairs-compared
  (let [{:keys [profile file-id page-id]} (new-file)
        [s1 s2] (repeatedly 2 uuid/next)
        _       (apply-changes!
                 profile file-id
                 (concat (texts-board page-id s1 "X" 0 0 (mapv #(str "Cell " %) (range 10)))
                         (texts-board page-id s2 "Y" 400 0 (mapv #(str "Other " %) (range 10)))))
        out     (similar profile file-id page-id {})]
    (t/is (= 1 (:compared (:result out))))))

;; --- SIMILAR BOARDS: SPEED AND CHAINS (PURE)

(defn- sig-entry
  "A board entry for the grouping tests: the int tokens `tokens`, each once,
  at walk position `index`."
  [index tokens]
  {:id        (uuid/next)
   :index     index
   :signature (frequencies tokens)})

(t/deftest similar-groups-of-1000-boards-finish-inside-the-budget
  (let [entries (vec (for [g (range 50)
                           k (range 20)]
                       (sig-entry (+ (* g 20) k) (range (* g 20) (+ (* g 20) 20)))))
        t0      (System/nanoTime)
        out     (mcp-lint/find-similar-groups entries 0.9 (+ t0 5000000000))
        ms      (/ (- (System/nanoTime) t0) 1000000.0)]
    (println "SIMILAR-1000-MS" ms "compared" (:compared out) "groups" (count (:groups out)))
    (t/is (false? (:timed-out? out)))
    (t/is (= 50 (count (:groups out))))
    (t/is (every? #(and (:exact %) (= 20 (count (:boards %)))) (:groups out)))
    (t/is (< ms 2500.0))))

(t/deftest similar-groups-merge-a-chain-by-its-lowest-linked-index
  (let [a   (sig-entry 0 (range 0 20))
        b   (sig-entry 1 (range 2 22))
        c   (sig-entry 2 (range 3 23))
        out (mcp-lint/find-similar-groups [a b c] 0.8 (+ (System/nanoTime) 5000000000))
        g   (first (:groups out))]
    (t/is (= 1 (count (:groups out))))
    (t/is (false? (:exact g)))
    (t/is (< (Math/abs (- (/ 18.0 22.0) (:similarity g))) 1e-9))
    (t/is (= #{(:id a) (:id b) (:id c)} (set (map :id (:boards g)))))))

(t/deftest similar-groups-check-the-budget-inside-the-loop
  (let [entries (vec (for [i (range 1000)]
                       (sig-entry i (range i (+ i 20)))))
        out     (mcp-lint/find-similar-groups entries 0.5 (+ (System/nanoTime) 3000000))]
    (t/is (true? (:timed-out? out)))
    (t/is (< (:compared out) 499500))))

(t/deftest lint-checks-the-budget-inside-the-loop
  (let [boards   (vec (repeatedly 5000 uuid/next))
        objects  (into {}
                       (for [b boards]
                         [b {:id b :type :frame :name "B" :parent-id uuid/zero :shapes []}]))
        deadline (+ (System/nanoTime) 3000000)
        out      (mcp-lint/get-lint-findings objects boards
                                             {:rules     #{:empty-board}
                                              :min-shapes 3
                                              :deadline  deadline
                                              :selected  (set boards)})]
    (t/is (true? (:truncated out)))
    (t/is (< (:boards out) 5000))))

;; --- LINT: EDGE TOLERANCE

(defn- add-control
  "The changes of a board of 200 by 200 at `bx`, and a control in it at
  (`x`, `y`) of `w` by `h` with a text of 10 by 10 inside. The board clips
  its content when `clip?` is true. Returns `{:board :control :changes}`."
  [page-id file-id bx clip? x y w h]
  (let [board (uuid/next)
        ctrl  (uuid/next)
        text  (uuid/next)
        cid   (uuid/next)]
    {:board   board
     :control ctrl
     :changes [(obj page-id board uuid/zero uuid/zero :frame "Board" bx 0 200 200
                    {:show-content (not clip?)})
               (obj page-id ctrl board board :frame "Control" (+ bx x) y w h
                    (instance-attrs file-id cid))
               (obj page-id text ctrl board :text "T" (+ bx x) y 10 10
                    {:content (text-content "Go")})]}))

(defn- add-controls!
  "Writes one board with one control for each entry of `specs`, a sequence of
  `[clip? x y w h]`, the boards 1000 px apart. Returns the control ids."
  [profile file-id page-id specs]
  (let [parts (vec (map-indexed (fn [i [clip? x y w h]]
                                  (add-control page-id file-id (* i 1000) clip? x y w h))
                                specs))]
    (apply-changes! profile file-id (vec (mapcat :changes parts)))
    (mapv :control parts)))

(defn- rule-of
  "The rule of the finding of the shape `id` in `out`, or nil."
  [out id]
  (:rule (first (filter #(= id (:shape-id %)) (:findings (:result out))))))

(defn- detail-of
  "The detail of the finding of the shape `id` in `out`."
  [out id]
  (:detail (first (filter #(= id (:shape-id %)) (:findings (:result out))))))

(def ^:private edge-rules [:clipped-control :invisible-control :off-board-control])

(t/deftest lint-tolerance-ignores-small-overflow-by-default
  (let [{:keys [profile file-id page-id]} (new-file)
        ;; the control sticks out of an open board by 0.00005, 0.5, 0.51 and 81 px
        ids (add-controls! profile file-id page-id
                           (for [d [0.00005 0.5 0.51 81]]
                             [false 150 0 (+ 50 d) 50]))
        out (lint profile file-id page-id {:rules edge-rules})
        raw (lint profile file-id page-id {:rules edge-rules :tolerance 0})]
    (t/is (nil? (:error out)))
    (t/is (= [nil nil :off-board-control :off-board-control]
             (mapv #(rule-of out %) ids))
          "default tolerance 0.5: only 0.51 and 81 are findings")
    (t/is (= [:off-board-control :off-board-control :off-board-control :off-board-control]
             (mapv #(rule-of raw %) ids))
          "tolerance 0: all four are findings")
    (t/testing "the detail keeps the raw overflow"
      (t/is (< (Math/abs (- 0.00005 (get-in (detail-of raw (first ids)) [:overflow :right]))) 1e-9))
      (t/is (< (Math/abs (- 0.51 (get-in (detail-of out (nth ids 2)) [:overflow :right]))) 1e-9))
      (t/is (== 81 (get-in (detail-of out (nth ids 3)) [:overflow :right]))))
    (t/testing "a tolerance of 100 keeps even the 81 px overflow out"
      (let [wide (lint profile file-id page-id {:rules edge-rules :tolerance 100})]
        (t/is (every? nil? (mapv #(rule-of wide %) ids)))))))

(t/deftest lint-tolerance-shrinks-the-box-for-clipping
  (let [{:keys [profile file-id page-id]} (new-file)
        ;; clipped by 0.3 px at the right edge, and clipped by half
        [thin half] (add-controls! profile file-id page-id
                                   [[true 150 0 50.3 50]
                                    [true 150 0 100 50]])
        out (lint profile file-id page-id {:rules edge-rules})
        raw (lint profile file-id page-id {:rules edge-rules :tolerance 0})]
    (t/is (nil? (:error out)))
    (t/is (nil? (rule-of out thin)) "cut by 0.3 px: not clipped with the default tolerance")
    (t/is (= :clipped-control (rule-of raw thin)) "cut by 0.3 px: clipped with tolerance 0")
    (t/is (= :clipped-control (rule-of out half)))
    (t/is (= :clipped-control (rule-of raw half)))
    (t/is (< (Math/abs (- 0.5 (:visible-fraction (detail-of out half)))) 1e-3))
    (t/is (< (Math/abs (- 0.5 (:visible-fraction (detail-of raw half)))) 1e-3))))

(t/deftest lint-tolerance-leaves-a-box-it-would-collapse
  (let [{:keys [profile file-id page-id]} (new-file)
        ;; 2 px wide and half cut by the board; a tolerance of 5 would collapse it
        [tiny] (add-controls! profile file-id page-id [[true 199 0 2 10]])
        out    (lint profile file-id page-id {:rules edge-rules :tolerance 5})
        found  (first (:findings (:result out)))]
    (t/is (nil? (:error out)))
    (t/is (= tiny (:shape-id found)))
    (t/is (= :clipped-control (:rule found)))
    (t/is (< (Math/abs (- 0.5 (get-in found [:detail :visible-fraction]))) 1e-3)
          "the share is taken on the real box")))

(t/deftest lint-tolerance-is-bounded
  (let [{:keys [profile file-id page-id]} (new-file)]
    (t/is (some? (:error (lint profile file-id page-id {:tolerance -1}))))
    (t/is (some? (:error (lint profile file-id page-id {:tolerance 101}))))
    (t/is (nil? (:error (lint profile file-id page-id {:tolerance 0}))))
    (t/is (nil? (:error (lint profile file-id page-id {:tolerance 100}))))
    (t/is (nil? (:error (lint profile file-id page-id {:tolerance 0.5}))))))

(defn- reference-visible-state
  "`get-visible-state` as it was before the tolerance: the share is taken on
  the whole box of the control."
  [shape entries]
  (let [box     (mcp-lint/get-box shape)
        area    (mcp-lint/box-area box)
        left    (reduce (fn [acc entry] (mcp-lint/box-intersection acc (:full entry)))
                        box
                        entries)
        visible (mcp-lint/box-area left)
        clipped (when (seq entries)
                  (:id (apply min-key
                              #(mcp-lint/box-area (mcp-lint/box-intersection box (:full %)))
                              entries)))]
    {:area       area
     :visible    visible
     :fraction   (if (pos? area) (double (/ visible area)) 1.0)
     :clipped-by clipped}))

(t/deftest lint-tolerance-zero-gives-the-strict-results
  (let [rnd  (java.util.Random. 20260611)
        pick (fn [n] (double (- (.nextInt rnd (* 2 n)) n)))]
    (dotimes [i 200]
      (let [shape   {:x (pick 100) :y (pick 100)
                     :width (double (.nextInt rnd 120)) :height (double (.nextInt rnd 120))}
            entries (vec (for [k (range (.nextInt rnd 3))]
                           {:id   k
                            :full {:x0 (pick 100) :y0 (pick 100)
                                   :x1 (+ 100 (pick 100)) :y1 (+ 100 (pick 100))}}))]
        (t/is (= (reference-visible-state shape entries)
                 (dissoc (mcp-lint/get-visible-state shape entries 0) :raw-fraction))
              (str "case " i))))))

(t/deftest lint-tolerance-zero-keeps-the-findings-of-a-page-without-noise
  (let [{:keys [profile file-id page-id]} (new-file)
        _   (add-controls! profile file-id page-id
                           [[true 150 0 100 50] [true 300 0 50 50] [false 150 0 131 50]])
        out (lint profile file-id page-id {:rules edge-rules})
        raw (lint profile file-id page-id {:rules edge-rules :tolerance 0})]
    (t/is (= [:clipped-control :invisible-control :off-board-control]
             (mapv :rule (:findings (:result raw)))))
    (t/is (= (mapv :rule (:findings (:result raw)))
             (mapv :rule (:findings (:result out)))))
    (t/is (= (:counts (:result raw)) (:counts (:result out))))))

(t/deftest shrink-box-takes-the-tolerance-off-each-side
  (let [box {:x0 0 :y0 0 :x1 10 :y1 20}]
    (t/is (= {:x0 1 :y0 1 :x1 9 :y1 19} (mcp-lint/shrink-box box 1)))
    (t/is (= box (mcp-lint/shrink-box box 0)))
    (t/is (= box (mcp-lint/shrink-box box 5)) "the width is not above twice the tolerance")
    (t/is (= box (mcp-lint/shrink-box box 10)))
    (t/is (= {:x0 4 :y0 4 :x1 6 :y1 16} (mcp-lint/shrink-box box 4)))))

;; --- BOARD SELECTION IN THE COMMANDS

(defn- section-page!
  "Writes two sections of different sizes, each with three screens of 400 by
  300 named \"Screen\". Returns the ids of the sections and of the screens in
  walk order."
  [profile file-id page-id]
  (let [[sec-a sec-b] (repeatedly 2 uuid/next)
        screens       (vec (repeatedly 6 uuid/next))]
    (apply-changes!
     profile file-id
     (concat
      [(obj page-id sec-a uuid/zero uuid/zero :frame "Section A" 0 0 1500 400 {:show-content true})]
      (map-indexed (fn [i s]
                     (obj page-id s sec-a sec-a :frame "Screen" (* i 450) 0 400 300 {:show-content false}))
                   (take 3 screens))
      [(obj page-id sec-b uuid/zero uuid/zero :frame "Section B" 0 1000 1600 500 {:show-content true})]
      (map-indexed (fn [i s]
                     (obj page-id s sec-b sec-b :frame "Screen" (* i 450) 1000 400 300 {:show-content false}))
                   (drop 3 screens))))
    {:sections [sec-a sec-b] :screens screens}))

(defn- lint-board-ids
  "The ids of the boards a lint call selected: every board is empty when
  `min-shapes` is 1000, and an empty board is reported once."
  [profile file-id page-id params]
  (let [out (lint profile file-id page-id (merge {:rules [:empty-board] :min-shapes 1000} params))]
    (mapv :board-id (:findings (:result out)))))

(defn- similar-board-ids
  "The ids of the boards a similar-boards call selected: with `min-shapes`
  1000 every board is skipped as small."
  [profile file-id page-id params]
  (let [out (similar profile file-id page-id (merge {:min-shapes 1000 :limit 500} params))]
    (:ids (:skipped-small (:result out)))))

(t/deftest both-commands-select-the-same-boards-for-the-same-arguments
  (let [{:keys [profile file-id page-id]} (new-file)
        {:keys [sections screens]} (section-page! profile file-id page-id)
        all   (vec (concat [(first sections)] (take 3 screens) [(second sections)] (drop 3 screens)))]
    (doseq [[params expected]
            [[{} screens]
             [{:mode :auto} screens]
             [{:depth 1} sections]
             [{:depth 2} all]
             [{:mode :depth} sections]
             [{:mode :auto :board-name-regex "^Screen"} screens]
             [{:board-name-regex "^Section"} sections]
             [{:mode :auto :board-name-regex "^Section"} []]]]
      (t/is (= expected (lint-board-ids profile file-id page-id params)) (str "lint " params))
      (t/is (= expected (similar-board-ids profile file-id page-id params)) (str "similar " params)))))

(t/deftest both-commands-report-the-selection-and-the-deeper-boards
  (let [{:keys [profile file-id page-id]} (new-file)
        _     (section-page! profile file-id page-id)
        lout  (:result (lint profile file-id page-id {:rules [:empty-board]}))
        sout  (:result (similar profile file-id page-id {}))
        deep  (:result (lint profile file-id page-id {:depth 1 :rules [:empty-board]}))]
    (doseq [out [lout sout]]
      (t/is (= {:mode "auto" :fallback false :basis "structure" :boards 6 :min-depth 2 :max-depth 2
                :sizes-omitted 0 :other-sizes []}
               (dissoc (:selection out) :sizes)))
      (t/is (= [[400 300 6]]
               (mapv (juxt (comp long :width) (comp long :height) :boards) (:sizes (:selection out)))))
      (t/is (not (contains? out :deeper-boards)) "mode auto has no deeper-boards"))
    (t/is (= {:mode "depth" :depth 1 :boards 2 :min-depth 1 :max-depth 1} (:selection deep)))
    (t/is (= 6 (:deeper-boards deep)) "the six screens lie below the two sections")))

(t/deftest both-commands-refuse-mode-auto-with-depth
  (let [{:keys [profile file-id page-id]} (new-file)
        l (lint profile file-id page-id {:mode :auto :depth 2})
        s (similar profile file-id page-id {:mode :auto :depth 2})]
    (t/is (= :mcp-invalid-board-selection (th/ex-code (:error l))))
    (t/is (= :mcp-invalid-board-selection (th/ex-code (:error s))))
    (t/is (= :validation (th/ex-type (:error l))))
    (t/is (some? (:error (lint profile file-id page-id {:mode :nope}))))
    (t/is (nil? (:error (lint profile file-id page-id {:depth 12}))))
    (t/is (some? (:error (lint profile file-id page-id {:depth 13}))))
    (t/is (nil? (:error (similar profile file-id page-id {:depth 12}))))
    (t/is (some? (:error (similar profile file-id page-id {:depth 13}))))))

(t/deftest the-selection-honours-the-deadline
  (let [{:keys [profile file-id page-id]} (new-file)
        _   (section-page! profile file-id page-id)
        out (with-redefs [mcp-lint/budget-ns 0]
              (lint profile file-id page-id {:rules [:empty-board]}))
        sim (with-redefs [mcp-lint/budget-ns 0]
              (similar profile file-id page-id {}))]
    (t/is (true? (:truncated (:result out))))
    (t/is (= 0 (:boards (:result out))))
    (t/is (true? (:truncated (:result sim))))))

;; --- SIMILAR BOARDS: SKIPPED SMALL

(t/deftest similar-boards-report-the-boards-skipped-for-being-small
  (let [{:keys [profile file-id page-id]} (new-file)
        [s1 s2 s3] (repeatedly 3 uuid/next)
        _   (apply-changes!
             profile file-id
             (concat (texts-board page-id s1 "Full" 0 0 ["a" "b" "c"])
                     [(obj page-id s2 uuid/zero uuid/zero :frame "Empty" 400 0 300 300 {:show-content false})]
                     (texts-board page-id s3 "One" 800 0 ["x"])))
        out (:result (similar profile file-id page-id {}))]
    (t/is (= 1 (:boards out)) "one board is compared")
    (t/is (= {:count 2 :ids [s2 s3]} (:skipped-small out)))))

(t/deftest similar-boards-list-at-most-50-skipped-ids
  (let [{:keys [profile file-id page-id]} (new-file)
        ids (vec (repeatedly 60 uuid/next))
        _   (apply-changes!
             profile file-id
             (map-indexed (fn [i id]
                            (obj page-id id uuid/zero uuid/zero :frame (str "B" i) (* i 500) 0 300 300
                                 {:show-content false}))
                          ids))
        out (:result (similar profile file-id page-id {}))]
    (t/is (= 0 (:boards out)))
    (t/is (= 60 (:count (:skipped-small out))))
    (t/is (= (subvec ids 0 50) (:ids (:skipped-small out))) "the first 50, in walk order")))

;; --- LINT: INSTANCE-ONLY BOARD ON CONTENT

(defn- header-changes
  "The changes of a header instance `id` of the component `cid` in `parent`
  at (`x`, `y`), with a text inside it. `attrs` are merged into the head."
  [file-id page-id id parent frame cid x y attrs]
  (let [text (uuid/next)]
    [(obj page-id id parent frame :frame "Header" x y 100 40
          (merge (instance-attrs file-id cid) attrs))
     (obj page-id text id frame :text "Title" (+ x 5) (+ y 5) 50 10
          {:content (text-content "Title")})]))

(defn- plain-board
  "The change of a board named `name` at `x`, 400 by 300."
  [page-id id name x]
  (obj page-id id uuid/zero uuid/zero :frame name x 0 400 300 {:show-content false}))

(t/deftest lint-instance-only-board-judges-the-content-of-six-structures
  (let [{:keys [profile file-id page-id]} (new-file)
        hdr   (uuid/next)
        tpl   (uuid/next)
        [only tpl-only wrap hidden tpl-full wrap-full blank] (repeatedly 7 uuid/next)
        [wrapper tpl-i tpl-j full-wrap] (repeatedly 4 uuid/next)
        x     (fn [i] (* i 500))
        _     (apply-changes!
               profile file-id
               (concat
                ;; 1 a board with only a header instance
                [(plain-board page-id only "Header only" (x 0))]
                (header-changes file-id page-id (uuid/next) only only hdr (x 0) 0 {})
                ;; 2 a board whose only child is a template instance that holds a header and nothing else
                [(plain-board page-id tpl-only "Template only" (x 1))
                 (obj page-id tpl-i tpl-only tpl-only :frame "Template" (x 1) 0 380 280
                      (instance-attrs file-id tpl))]
                (header-changes file-id page-id (uuid/next) tpl-i tpl-only hdr (x 1) 0 {})
                ;; 3 a wrapper frame that holds only a header
                [(plain-board page-id wrap "Wrapper only" (x 2))
                 (obj page-id wrapper wrap wrap :frame "Wrapper" (x 2) 0 380 280 {:show-content false})]
                (header-changes file-id page-id (uuid/next) wrapper wrap hdr (x 2) 0 {})
                ;; 4 a hidden header and a visible splash
                [(plain-board page-id hidden "Hidden header" (x 3))]
                (header-changes file-id page-id (uuid/next) hidden hidden hdr (x 3) 0 {:hidden true})
                [(obj page-id (uuid/next) hidden hidden :rect "Splash" (x 3) 100 100 100 {})]
                ;; 5 a template instance with a header and a content block
                [(plain-board page-id tpl-full "Template full" (x 4))
                 (obj page-id tpl-j tpl-full tpl-full :frame "Template" (x 4) 0 380 280
                      (instance-attrs file-id tpl))]
                (header-changes file-id page-id (uuid/next) tpl-j tpl-full hdr (x 4) 0 {})
                [(obj page-id (uuid/next) tpl-j tpl-full :rect "Block" (x 4) 100 100 100 {})]
                ;; 6 a wrapper with a header and a splash
                [(plain-board page-id wrap-full "Wrapper full" (x 5))
                 (obj page-id full-wrap wrap-full wrap-full :frame "Wrapper" (x 5) 0 380 280 {:show-content false})]
                (header-changes file-id page-id (uuid/next) full-wrap wrap-full hdr (x 5) 0 {})
                [(obj page-id (uuid/next) full-wrap wrap-full :rect "Splash" (x 5) 100 100 100 {})]
                ;; 7 a truly empty board
                [(plain-board page-id blank "Blank" (x 6))]))
        out   (lint profile file-id page-id {:depth 1 :rules [:instance-only-board :empty-board] :min-shapes 0})
        found (findings-of out :instance-only-board)]
    (t/is (nil? (:error out)))
    (t/is (= [only tpl-only wrap] (map :board-id found))
          "header only, template with only a header, wrapper with only a header")
    (t/is (every? #(= {:chrome-component-ids [hdr] :content-shapes 0} (:detail %)) found))
    (t/is (= [{:id hdr :name "Header" :boards 5}] (:chrome-components (:result out)))
          "the hidden header does not count for its board")
    (t/is (= {"empty-board" 0 "instance-only-board" 3} (:counts (:result out)))
          "the blank board is not instance-only, and min-shapes 0 keeps it out of empty-board")
    (t/testing "the same result with the default board selection"
      (let [auto (lint profile file-id page-id {:rules [:instance-only-board]})]
        (t/is (= [only tpl-only wrap] (map :board-id (findings-of auto :instance-only-board))))))))

(t/deftest lint-instance-only-board-tells-23-header-only-boards-from-17-content-boards
  (let [{:keys [profile file-id page-id]} (new-file)
        hdr    (uuid/next)
        boards (vec (repeatedly 40 uuid/next))
        _      (apply-changes!
                profile file-id
                (mapcat (fn [i b]
                          (concat [(plain-board page-id b (str "Screen " i) (* i 500))]
                                  (header-changes file-id page-id (uuid/next) b b hdr (* i 500) 0 {})
                                  (when (>= i 23)
                                    [(obj page-id (uuid/next) b b :text "Boot" (* i 500) 100 100 20
                                          {:content (text-content "Boot")})])))
                        (range 40) boards))]
    (doseq [params [{} {:depth 1} {:mode :auto}]]
      (let [out (lint profile file-id page-id (merge {:rules [:instance-only-board]} params))]
        (t/is (= (subvec boards 0 23) (mapv :board-id (findings-of out :instance-only-board)))
              (str params))
        (t/is (= {"instance-only-board" 23} (:counts (:result out))))
        (t/is (= [{:id hdr :name "Header" :boards 40}] (:chrome-components (:result out))))))))

(t/deftest lint-instance-only-board-needs-a-shared-header
  (let [{:keys [profile file-id page-id]} (new-file)
        [c1 c2] (repeatedly 2 uuid/next)
        [b1 b2 b3] (repeatedly 3 uuid/next)
        _     (apply-changes!
               profile file-id
               (concat [(plain-board page-id b1 "One" 0)
                        (plain-board page-id b2 "Two" 500)
                        (plain-board page-id b3 "Three" 1000)]
                       (header-changes file-id page-id (uuid/next) b1 b1 c1 0 0 {})
                       (header-changes file-id page-id (uuid/next) b2 b2 c1 500 0 {})
                       (header-changes file-id page-id (uuid/next) b3 b3 c2 1000 0 {})))
        out   (lint profile file-id page-id {:depth 1 :rules [:instance-only-board]})
        other (lint profile file-id page-id {:depth 1 :rules [:empty-board]})]
    (t/is (nil? (:error out)))
    (t/is (contains? (:result out) :chrome-components))
    (t/is (= [] (:chrome-components (:result out))) "no component is in 3 boards")
    (t/is (empty? (findings-of out :instance-only-board)))
    (t/is (= {"instance-only-board" 0} (:counts (:result out))))
    (t/is (= [] (:chrome-components (:result other))) "not looked for when the rule is not asked")))

(t/deftest lint-instance-only-board-needs-30-percent-of-the-boards
  (let [{:keys [profile file-id page-id]} (new-file)
        hdr    (uuid/next)
        boards (vec (repeatedly 11 uuid/next))
        _      (apply-changes!
                profile file-id
                (mapcat (fn [i b]
                          (concat [(plain-board page-id b (str "B" i) (* i 500))]
                                  (when (< i 3)
                                    (header-changes file-id page-id (uuid/next) b b hdr (* i 500) 0 {}))))
                        (range 11) boards))
        out    (lint profile file-id page-id {:depth 1 :rules [:instance-only-board]})]
    (t/is (= [] (:chrome-components (:result out))) "3 of 11 boards is under 30 %")
    (t/is (empty? (findings-of out :instance-only-board)))))

(t/deftest lint-instance-only-board-lists-every-chrome-component-smaller-instances-first
  (let [{:keys [profile file-id page-id]} (new-file)
        small  (uuid/next)
        big    (uuid/next)
        boards (vec (repeatedly 5 uuid/next))
        _      (apply-changes!
                profile file-id
                (mapcat (fn [i b]
                          (let [x (* i 500)]
                            (concat [(plain-board page-id b (str "B" i) x)]
                                    (when (< i 4)
                                      [(obj page-id (uuid/next) b b :frame "Big" x 100 200 100
                                            (instance-attrs file-id big))
                                       (obj page-id (uuid/next) b b :frame "Small" x 0 100 50
                                            (instance-attrs file-id small))]))))
                        (range 5) boards))
        out    (lint profile file-id page-id {:depth 1 :rules [:instance-only-board]})]
    (t/is (nil? (:error out)))
    (t/is (= [{:id small :name "Small" :boards 4} {:id big :name "Big" :boards 4}]
             (:chrome-components (:result out)))
          "both occur in 4 boards and are chrome; the smaller mean area comes first")))

(t/deftest lint-instance-only-board-lists-chrome-components-with-the-most-boards-first
  (let [{:keys [profile file-id page-id]} (new-file)
        small  (uuid/next)
        big    (uuid/next)
        boards (vec (repeatedly 5 uuid/next))
        _      (apply-changes!
                profile file-id
                (mapcat (fn [i b]
                          (let [x (* i 500)]
                            (concat [(plain-board page-id b (str "B" i) x)
                                     (obj page-id (uuid/next) b b :frame "Big" x 100 200 100
                                          (instance-attrs file-id big))]
                                    (when (< i 3)
                                      [(obj page-id (uuid/next) b b :frame "Small" x 0 100 50
                                            (instance-attrs file-id small))]))))
                        (range 5) boards))
        out    (lint profile file-id page-id {:depth 1 :rules [:instance-only-board]})]
    (t/is (= [{:id big :name "Big" :boards 5} {:id small :name "Small" :boards 3}]
             (:chrome-components (:result out))))))

(t/deftest lint-instance-only-board-skips-boards-inside-component-instances
  (let [{:keys [profile file-id page-id]} (new-file)
        hdr    (uuid/next)
        plain  (vec (repeatedly 4 uuid/next))
        [main copy] (repeatedly 2 uuid/next)
        _      (apply-changes!
                profile file-id
                (concat
                 (mapcat (fn [i b]
                           (cons (plain-board page-id b (str "Screen " i) (* i 500))
                                 (header-changes file-id page-id (uuid/next) b b hdr (* i 500) 0 {})))
                         (range 4) plain)
                 [(obj page-id main uuid/zero uuid/zero :frame "Main" 2500 0 400 300
                       (merge (main-attrs file-id (uuid/next)) {:show-content false}))]
                 (header-changes file-id page-id (uuid/next) main main hdr 2500 0 {})
                 [(obj page-id copy uuid/zero uuid/zero :frame "Copy" 3000 0 400 300
                       (merge (copy-attrs file-id (uuid/next) (uuid/next)) {:show-content false}))]
                 (header-changes file-id page-id (uuid/next) copy copy hdr 3000 0 {})))
        out    (lint profile file-id page-id {:depth 1 :rules [:instance-only-board]})]
    (t/is (nil? (:error out)))
    (t/is (= 6 (:boards (:result out))))
    (t/is (= plain (map :board-id (findings-of out :instance-only-board)))
          "the main board and the component copy are not reported")))

;; --- LINT: SCROLL CANDIDATES

(defn- clip-board
  "The change of a clipping board `id` named `name` of 200 by 200 at `x`."
  [page-id id name x attrs]
  (obj page-id id uuid/zero uuid/zero :frame name x 0 200 200 (merge {:show-content false} attrs)))

(defn- scroll-rule-of
  "The `scroll-candidate` finding of the shape `id` in `out`, or nil."
  [out id]
  (first (filter #(and (= :scroll-candidate (:rule %)) (= id (:shape-id %))) (:findings (:result out)))))

(t/deftest scroll-candidate-suggests-the-axis-of-the-overflow
  (let [{:keys [profile file-id page-id]} (new-file)
        [v h both] (repeatedly 3 uuid/next)
        _     (apply-changes!
               profile file-id
               [(clip-board page-id v "Vertical" 0 {})
                (obj page-id (uuid/next) v v :rect "Row" 0 150 50 100 {})
                (clip-board page-id h "Horizontal" 400 {})
                (obj page-id (uuid/next) h h :rect "Col" 550 0 100 50 {})
                (clip-board page-id both "Both" 800 {})
                (obj page-id (uuid/next) both both :rect "Far" 950 150 100 100 {})])
        out   (lint profile file-id page-id {:rules [:scroll-candidate]})
        fv    (scroll-rule-of out v)
        fh    (scroll-rule-of out h)
        fb    (scroll-rule-of out both)]
    (t/is (nil? (:error out)))
    (t/is (= "vertical" (get-in fv [:detail :suggested])))
    (t/is (== 50 (get-in fv [:detail :overflow :bottom])))
    (t/is (== 0 (get-in fv [:detail :overflow :right])))
    (t/is (= "horizontal" (get-in fh [:detail :suggested])))
    (t/is (== 50 (get-in fh [:detail :overflow :right])))
    (t/is (= "both" (get-in fb [:detail :suggested])))
    (t/is (== 50 (get-in fb [:detail :overflow :right])))
    (t/is (== 50 (get-in fb [:detail :overflow :bottom])))
    (t/is (every? #(false? (get-in % [:detail :in-component-copy])) [fv fh fb]))
    (t/is (= [v v] [(:board-id fv) (:shape-id fv)]) "the shape of the finding is the frame")
    (t/is (= {"scroll-candidate" 3} (:counts (:result out))))))

(t/deftest scroll-candidate-needs-the-minimum-overflow
  (let [{:keys [profile file-id page-id]} (new-file)
        [a b c] (repeatedly 3 uuid/next)
        _     (apply-changes!
               profile file-id
               [(clip-board page-id a "Seven nine" 0 {})
                (obj page-id (uuid/next) a a :rect "R" 0 0 207.9 50 {})
                (clip-board page-id b "Eight" 400 {})
                (obj page-id (uuid/next) b b :rect "R" 400 0 208 50 {})
                (clip-board page-id c "Inside" 800 {})
                (obj page-id (uuid/next) c c :rect "R" 800 0 200 50 {})])
        by    (fn [params] (lint profile file-id page-id (merge {:depth 1 :rules [:scroll-candidate]} params)))
        ids   (fn [out] (set (map :shape-id (:findings (:result out)))))]
    (t/is (= #{b} (ids (by {}))) "7.9 px is under the default of 8, 8 px is not")
    (t/is (= #{a b} (ids (by {:min-overflow 0}))) "0 reports every overflow, and none for a frame that fits")
    (t/is (= #{} (ids (by {:min-overflow 100}))))
    (t/is (= #{b} (ids (by {:min-overflow 8}))))
    (t/is (some? (:error (by {:min-overflow -1}))))
    (t/is (some? (:error (by {:min-overflow 1001}))))
    (t/is (nil? (:error (by {:min-overflow 1000}))))))

(t/deftest scroll-candidate-compares-the-minimum-overflow-per-axis
  (let [{:keys [profile file-id page-id]} (new-file)
        board (uuid/next)
        _     (apply-changes!
               profile file-id
               [(clip-board page-id board "Board" 0 {})
                (obj page-id (uuid/next) board board :rect "Past right" 150 0 100 50 {})
                (obj page-id (uuid/next) board board :rect "Past bottom" 0 190 50 70 {})])
        out   (fn [m]
                (scroll-rule-of (lint profile file-id page-id {:depth 1 :rules [:scroll-candidate] :min-overflow m})
                                board))]
    (t/is (= "both" (get-in (out 8) [:detail :suggested])) "right 50 and bottom 60")
    (t/is (= "vertical" (get-in (out 55) [:detail :suggested])) "only the bottom (60) reaches 55")
    (t/is (nil? (out 100)))))

(t/deftest scroll-candidate-ignores-frames-that-show-or-already-scroll
  (let [{:keys [profile file-id page-id]} (new-file)
        [shows vert none-set both-set] (repeatedly 4 uuid/next)
        rows  (fn [id x] (obj page-id (uuid/next) id id :rect "Row" x 150 50 100 {}))
        _     (apply-changes!
               profile file-id
               [(clip-board page-id shows "Shows content" 0 {:show-content true})
                (rows shows 0)
                (clip-board page-id vert "Already vertical" 400 {:overflow-scroll :vertical})
                (rows vert 400)
                (clip-board page-id none-set "Scroll none" 800 {:overflow-scroll :none})
                (rows none-set 800)
                (clip-board page-id both-set "Both" 1200 {:overflow-scroll :both})
                (rows both-set 1200)])
        out   (lint profile file-id page-id {:depth 1 :rules [:scroll-candidate]})]
    (t/is (= [none-set] (map :shape-id (:findings (:result out))))
          "a frame that shows its content or already scrolls is not reported; an explicit none is")))

(t/deftest scroll-candidate-flags-frames-inside-a-component-copy
  (let [{:keys [profile file-id page-id]} (new-file)
        board (uuid/next)
        [plain copy inner] (repeatedly 3 uuid/next)
        row   (fn [parent x y] (obj page-id (uuid/next) parent board :rect "Row" x y 50 100 {}))
        _     (apply-changes!
               profile file-id
               [(clip-board page-id board "Board" 0 {:show-content true})
                (obj page-id plain board board :frame "Plain" 0 0 100 100 {:show-content false})
                (row plain 0 50)
                (obj page-id copy board board :frame "Copy" 120 0 100 100
                     (merge (copy-attrs file-id (uuid/next) (uuid/next)) {:show-content false}))
                (row copy 120 50)
                (obj page-id inner copy board :frame "Inner" 120 0 80 80
                     {:show-content false})
                (row inner 120 40)])
        out   (lint profile file-id page-id {:depth 1 :rules [:scroll-candidate]})]
    (t/is (nil? (:error out)))
    (t/is (false? (get-in (scroll-rule-of out plain) [:detail :in-component-copy])))
    (t/is (true? (get-in (scroll-rule-of out copy) [:detail :in-component-copy])) "the copy head itself")
    (t/is (true? (get-in (scroll-rule-of out inner) [:detail :in-component-copy]))
          "a frame inside a copy, without a shape-ref of its own")
    (t/is (every? #(= board (:board-id %)) (:findings (:result out))))))

(t/deftest scroll-candidate-is-reported-under-the-innermost-selected-board
  (let [{:keys [profile file-id page-id]} (new-file)
        [outer inner deep] (repeatedly 3 uuid/next)
        _     (apply-changes!
               profile file-id
               [(obj page-id outer uuid/zero uuid/zero :frame "Outer" 0 0 400 400 {:show-content false})
                (obj page-id (uuid/next) outer outer :rect "Past" 350 10 100 20 {})
                (obj page-id inner outer outer :frame "Inner" 10 100 200 200 {:show-content true})
                (obj page-id deep inner inner :frame "Deep" 20 120 100 100 {:show-content false})
                (obj page-id (uuid/next) deep inner :rect "Wide" 80 130 100 10 {})])
        two   (lint profile file-id page-id {:depth 2 :rules [:scroll-candidate]})
        one   (lint profile file-id page-id {:depth 1 :rules [:scroll-candidate]})]
    (t/is (= {outer outer deep inner}
             (into {} (map (juxt :shape-id :board-id)) (:findings (:result two))))
          "with the inner board selected, Deep belongs to it, once")
    (t/is (= {"scroll-candidate" 2} (:counts (:result two))))
    (t/is (= {outer outer deep outer}
             (into {} (map (juxt :shape-id :board-id)) (:findings (:result one))))
          "with only the outer board selected, it reports both")))

(t/deftest the-default-rules-include-scroll-candidate
  (let [{:keys [profile file-id page-id]} (new-file)
        out  (lint profile file-id page-id {})
        many (lint profile file-id page-id {:rules (vec (repeat 9 :empty-board))})
        ten  (lint profile file-id page-id {:rules (vec (repeat 10 :empty-board))})]
    (t/is (= #{"empty-board" "instance-only-board" "clipped-control" "invisible-control"
               "scroll-hidden-control" "off-board-control" "scroll-candidate"}
             (set (keys (:counts (:result out))))))
    (t/is (nil? (:error many)) "up to 9 rule names are accepted")
    (t/is (some? (:error ten)))))

;; --- LINT: CHROME COMPONENTS AND CONTENT (plain page maps)

(defn- page-of
  "Page objects from the top-level specs `tops`, as plain maps: `{:objects m
  :ids [top-level ids]}`. A spec is `{:t :name :x :y :w :h :attrs :kids}`;
  positions are in page space."
  [& tops]
  (let [counter (atom 0)
        objects (atom {})
        add     (fn add [spec parent]
                  (let [id   (keyword (str "s" (swap! counter inc)))
                        kids (mapv #(add % id) (:kids spec))]
                    (swap! objects assoc id
                           (merge {:id        id
                                   :parent-id parent
                                   :type      (:t spec)
                                   :name      (:name spec)
                                   :x         (:x spec)
                                   :y         (:y spec)
                                   :width     (:w spec)
                                   :height    (:h spec)
                                   :shapes    kids}
                                  (:attrs spec)))
                    id))
        ids     (mapv #(add % uuid/zero) tops)]
    {:objects (assoc @objects uuid/zero {:id uuid/zero :type :frame :shapes ids})
     :ids     ids}))

(defn- spec
  "A shape spec of `type` named `name` at (`x`, `y`) of `w` by `h`, with the
  child specs `kids`."
  [type name x y w h & kids]
  {:t type :name name :x x :y y :w w :h h :kids (vec kids)})

(defn- spec+
  "Like `spec`, with the extra shape attributes `attrs` after the size."
  [type name x y w h attrs & kids]
  (assoc (apply spec type name x y w h kids) :attrs attrs))

(defn- inst
  "A spec of an instance head of the component `cid`."
  [cid name x y w h & kids]
  (apply spec+ :frame name x y w h {:component-id cid} kids))

(defn- screen
  "A spec of a board of 800 by 600 named `name` at (`bx`, 0)."
  [name bx & kids]
  (apply spec :frame name bx 0 800 600 kids))

(defn- chrome-scan
  "The result of `get-lint-findings` with the rule `instance-only-board` on
  the top-level boards of `page`. `opts` are merged over the options."
  ([page]
   (chrome-scan page {}))
  ([page opts]
   (mcp-lint/get-lint-findings (:objects page) (:ids page)
                               (merge {:rules      #{:instance-only-board}
                                       :min-shapes 0
                                       :deadline   (+ (System/nanoTime) 5000000000)
                                       :selected   (set (:ids page))}
                                      opts))))

(defn- scroll-scan
  "The `scroll-candidate` findings of the top-level boards of `page`."
  [page]
  (:findings
   (mcp-lint/get-lint-findings (:objects page) (:ids page)
                               {:rules      #{:scroll-candidate}
                                :min-shapes 0
                                :tolerance  0.5
                                :deadline   (+ (System/nanoTime) 5000000000)
                                :selected   (set (:ids page))})))

(defn- reported
  "The names of the boards the `instance-only-board` findings of `res` are
  about, in order."
  [res]
  (mapv :board-name (:findings res)))

(defn- chrome-names
  "The names of the chrome components of `res`."
  [res]
  (mapv :name (:chrome-components res)))

(t/deftest chrome-includes-a-logo-nested-in-the-header-and-reports-the-blank-boards
  ;; Before: the logo tied with the header and won, so nothing was reported.
  (let [hdr    (uuid/next)
        logo   (uuid/next)
        header (fn [bx]
                 (inst hdr "Header" bx 0 800 80
                       (inst logo "Logo" (+ bx 10) 10 40 40
                             (spec :path "p" (+ bx 10) 10 40 40))))
        page   (apply page-of
                      (concat (for [i (range 5)]
                                (screen (str "Blank " i) (* i 1000) (header (* i 1000))))
                              (for [i (range 5 10)]
                                (screen (str "Full " i) (* i 1000) (header (* i 1000))
                                        (spec :rect "content" (+ 100 (* i 1000)) 200 300 100)))))
        res    (chrome-scan page)]
    (t/is (= (mapv #(str "Blank " %) (range 5)) (reported res)))
    (t/is (= #{"Header" "Logo"} (set (chrome-names res))))
    (t/is (every? #(= 10 (:boards %)) (:chrome-components res)))
    (t/is (every? #(= {:chrome-component-ids [hdr logo] :content-shapes 0} (:detail %))
                  (:findings res)))))

(t/deftest chrome-includes-a-header-and-a-footer-that-are-on-every-board
  ;; Before: one of the two was the header and the other counted as content.
  (let [hdr    (uuid/next)
        ftr    (uuid/next)
        chrome (fn [bx]
                 [(inst hdr "Header" bx 0 800 80 (spec :rect "h" bx 0 800 80))
                  (inst ftr "Footer" bx 560 800 40 (spec :text "f" bx 560 100 20))])
        page   (apply page-of
                      (for [i (range 8)]
                        (apply screen (str "Board " i) (* i 1000)
                               (concat (chrome (* i 1000))
                                       (when (odd? i)
                                         [(spec :rect "content" (+ 100 (* i 1000)) 200 300 100)])))))
        res    (chrome-scan page)]
    (t/is (= ["Board 0" "Board 2" "Board 4" "Board 6"] (reported res)))
    (t/is (= #{"Header" "Footer"} (set (chrome-names res))))))

(t/deftest chrome-leaves-out-a-button-that-moves-and-repeats
  ;; Before: the button, in more boards than the header, was the header, and
  ;; the boards with only the header were not reported.
  (let [hdr    (uuid/next)
        btn    (uuid/next)
        header (fn [bx] (inst hdr "Header" bx 0 800 80 (spec :rect "h" bx 0 800 80)))
        button (fn [bx x y] (inst btn "Button" (+ bx x) y 100 40 (spec :text "t" (+ bx x) y 60 20)))
        counts [1 2 1 3 2 1 2]
        page   (apply page-of
                      (concat
                       (for [i [0 1]]
                         (screen (str "Header only " i) (* i 1000) (header (* i 1000))))
                       [(apply screen "Menu" 2000 (header 2000)
                               (for [k (range 6)] (button 2000 (+ 10 (* 130 (mod k 3))) (+ 100 (* 60 (quot k 3))))))]
                       (for [i (range 3 10)]
                         (apply screen (str "Buttons " i) (* i 1000)
                                (for [k (range (nth counts (- i 3)))]
                                  (button (* i 1000) (+ 10 (* 130 k) i) (+ 100 (* 7 i))))))))
        res    (chrome-scan page)]
    (t/is (= ["Header"] (chrome-names res)) "the button is in 8 boards but moves and repeats: it is not chrome")
    (t/is (= [3] (mapv :boards (:chrome-components res))))
    (t/is (= ["Header only 0" "Header only 1"] (reported res))
          "the menu of header and six buttons is not reported")))

(t/deftest chrome-includes-a-back-button-in-the-same-place-on-every-board
  (let [back (uuid/next)
        page (apply page-of
                    (for [i (range 6)]
                      (apply screen (str "Board " i) (* i 1000)
                             (inst back "Back" (+ 10 (* i 1000)) 10 60 30 (spec :text "t" (+ 10 (* i 1000)) 10 40 20))
                             (when (>= i 3)
                               [(spec :rect "content" (+ 100 (* i 1000)) 200 300 100)]))))
        res  (chrome-scan page)]
    (t/is (= [{:id back :name "Back" :boards 6}] (:chrome-components res)))
    (t/is (= ["Board 0" "Board 1" "Board 2"] (reported res)))))

(t/deftest chrome-needs-the-same-offset-and-one-instance-per-board
  (let [moving (uuid/next)
        twice  (uuid/next)
        page   (apply page-of
                      (for [i (range 6)]
                        (screen (str "Board " i) (* i 1000)
                                (inst moving "Banner" (* i 1000) (* 60 i) 200 40)
                                (inst twice "Twin" (* i 1000) 500 50 50)
                                (inst twice "Twin" (+ 100 (* i 1000)) 500 50 50))))
        res    (chrome-scan page)]
    (t/is (= [] (:chrome-components res)) "a banner that moves is not chrome, nor one that occurs twice")
    (t/is (= [] (:findings res)))))

(t/deftest chrome-allows-one-board-out-of-place
  (let [sticker (uuid/next)
        page    (apply page-of
                       (for [i (range 5)]
                         (screen (str "Board " i) (* i 1000)
                                 (inst sticker "Sticker" (* i 1000) (if (= i 4) 300 0) 100 40))))]
    (t/is (= [{:id sticker :name "Sticker" :boards 5}] (:chrome-components (chrome-scan page)))
          "four of five boards, 80 %, share the offset")))

(t/deftest a-full-size-template-is-not-chrome
  (let [tpl  (uuid/next)
        page (apply page-of
                    (for [i (range 6)]
                      (screen (str "Board " i) (* i 1000)
                              (inst tpl "Template" (* i 1000) 0 800 600))))
        res  (chrome-scan page)]
    (t/is (= [] (:chrome-components res)))
    (t/is (= [] (:findings res)))))

(t/deftest at-most-ten-chrome-components-are-listed
  (let [cids (vec (repeatedly 12 uuid/next))
        page (apply page-of
                    (for [i (range 4)]
                      (apply screen (str "Board " i) (* i 1000)
                             (for [[k cid] (map-indexed vector cids)]
                               (inst cid (str "C" k) (+ (* i 1000) (* 20 k)) 0 15 15)))))
        res  (chrome-scan page)]
    (t/is (= 10 (count (:chrome-components res))))
    (t/is (= 4 (count (:findings res))) "every board holds only chrome")))

(t/deftest content-includes-a-filled-frame-of-a-fair-size
  ;; Before: only the drawing types counted, so a header and one red frame
  ;; was reported as blank.
  (let [hdr  (uuid/next)
        page (apply page-of
                    (for [i (range 4)]
                      (screen (str "Splash " i) (* i 1000)
                              (inst hdr "Header" (* i 1000) 0 100 40)
                              (spec+ :frame "Panel" (+ 100 (* i 1000)) 100 400 300
                                     {:fills [{:fill-color "#ff0000" :fill-opacity 1}]}))))
        res  (chrome-scan page)]
    (t/is (= ["Header"] (chrome-names res)))
    (t/is (= [] (:findings res)))))

(t/deftest content-includes-a-small-filled-group-and-a-stroked-frame
  (let [hdr  (uuid/next)
        mk   (fn [name i child]
               (screen (str name " " i) (* i 1000)
                       (inst hdr "Header" (* i 1000) 0 100 40)
                       child))
        page (apply page-of
                    (concat
                     (for [i (range 3)]
                       (mk "Group" i (spec+ :group "G" (+ 100 (* i 1000)) 100 300 200
                                            {:fills [{:fill-color "#00ff00" :fill-opacity 1}]})))
                     (for [i (range 3 6)]
                       (mk "Stroked" i (spec+ :frame "F" (+ 100 (* i 1000)) 100 300 200
                                              {:fills []
                                               :strokes [{:stroke-color "#000000" :stroke-opacity 1 :stroke-width 2}]})))
                     (for [i (range 6 9)]
                       (mk "Clear" i (spec+ :frame "F" (+ 100 (* i 1000)) 100 300 200
                                            {:fills [{:fill-color "#ff0000" :fill-opacity 0}]})))))
        res  (chrome-scan page)]
    (t/is (= ["Clear 6" "Clear 7" "Clear 8"] (reported res))
          "a 300 by 200 group with a fill and a stroked frame are content, a fill with opacity 0 is not")))

(t/deftest content-leaves-out-a-large-filled-panel-and-a-backdrop
  (let [hdr  (uuid/next)
        mk   (fn [name i child]
               (screen (str name " " i) (* i 1000)
                       (inst hdr "Header" (* i 1000) 0 100 40)
                       child))
        fill [{:fill-color "#ff0000" :fill-opacity 1}]
        page (apply page-of
                    (concat
                     ;; an empty slot with a fill over 87 % of the board
                     (for [i (range 3)]
                       (mk "Slot" i (spec+ :frame "Slot" (* i 1000) 80 800 520 {:fills fill})))
                     ;; a rect over 90 % of the board (90.8 %) is a backdrop
                     (for [i (range 3 6)]
                       (mk "Backdrop" i (spec :rect "Bg" (* i 1000) 0 800 545)))
                     ;; a rect over 88 % of the board is content
                     (for [i (range 6 9)]
                       (mk "Image" i (spec :rect "Photo" (* i 1000) 0 800 530)))))
        res  (chrome-scan page)]
    (t/is (= ["Slot 0" "Slot 1" "Slot 2" "Backdrop 3" "Backdrop 4" "Backdrop 5"] (reported res)))))

(t/deftest content-sees-through-a-template-that-draws-its-own-background
  ;; Before: the background rect of the template counted as content, so a
  ;; board of a template, a header and an empty slot was never reported.
  (let [tpl  (uuid/next)
        hdr  (uuid/next)
        page (apply page-of
                    (for [i (range 6)]
                      (let [bx (* i 1000)]
                        (screen (str "Board " i) bx
                                (inst tpl "Template" bx 0 800 600
                                      (spec :rect "bg" bx 0 800 600)
                                      (inst hdr "Header" bx 0 800 80 (spec :rect "h" bx 0 800 80))
                                      (if (< i 3)
                                        (spec :rect "content" (+ bx 100) 200 300 100)
                                        (spec :group "Slot" (+ bx 100) 200 1 1)))))))
        res  (chrome-scan page)]
    (t/is (= ["Header"] (chrome-names res)) "the full-size template is not chrome")
    (t/is (= ["Board 3" "Board 4" "Board 5"] (reported res)))))

(t/deftest content-in-a-wrapper-frame-that-holds-only-chrome-is-not-content
  (let [hdr  (uuid/next)
        page (apply page-of
                    (for [i (range 4)]
                      (screen (str "Board " i) (* i 1000)
                              (spec+ :frame "Wrapper" (* i 1000) 0 300 100 {:fills [{:fill-color "#fff" :fill-opacity 1}]}
                                     (inst hdr "Header" (* i 1000) 0 100 40)))))
        res  (chrome-scan page)]
    (t/is (= 4 (count (:findings res))))))

(def ^:private image-fill
  "A fill that holds an image."
  [{:fill-image {:id (uuid/next) :width 10 :height 10} :fill-opacity 1}])

(t/deftest content-includes-a-full-screen-image-frame-or-image-shape
  ;; Before: a photo frame of 800 by 520 was an empty panel, and a full-screen
  ;; image shape a backdrop, so a header and a photo was reported as blank.
  (let [hdr  (uuid/next)
        mk   (fn [name i child]
               (screen (str name " " i) (* i 1000)
                       (inst hdr "Header" (* i 1000) 0 100 40)
                       child))
        page (apply page-of
                    (concat
                     (for [i (range 3)]
                       (mk "Photo frame" i (spec+ :frame "Photo" (* i 1000) 80 800 520 {:fills image-fill})))
                     (for [i (range 3 6)]
                       (mk "Image shape" i (spec :image "Photo" (* i 1000) 0 800 600)))
                     (for [i (range 6 9)]
                       (mk "Image rect" i (spec+ :rect "Photo" (* i 1000) 0 800 600 {:fills image-fill})))
                     (for [i (range 9 12)]
                       (mk "Clear image" i (spec+ :rect "Photo" (* i 1000) 0 800 600
                                                  {:fills [(assoc (first image-fill) :fill-opacity 0)]})))))
        res  (chrome-scan page)]
    (t/is (= ["Header"] (chrome-names res)))
    (t/is (= ["Clear image 9" "Clear image 10" "Clear image 11"] (reported res))
          "a full-screen image is content; an image fill with opacity 0 leaves a backdrop")))

(t/deftest an-image-inside-a-chrome-instance-is-not-content
  (let [hdr  (uuid/next)
        page (apply page-of
                    (for [i (range 4)]
                      (screen (str "Board " i) (* i 1000)
                              (inst hdr "Header" (* i 1000) 0 800 80
                                    (spec :image "Banner" (* i 1000) 0 800 80)))))
        res  (chrome-scan page)]
    (t/is (= 4 (count (:findings res))))))

(def ^:private variant-container
  "The id of the variant container of the header variants of the tests."
  (uuid/next))

(defn- variant-of
  "A `component-variant` function that puts the component ids `cids` in the
  variant set `variant-container`."
  [cids]
  (let [cids (set cids)]
    (fn [cid] (when (contains? cids cid) variant-container))))

(defn- header-variants-page
  "Twelve boards, the first four blank, each with the header variant
  `(mod i 4)` of `hv`, and the others with a content rect."
  [hv]
  (apply page-of
         (for [i (range 12)]
           (apply screen (if (< i 4) "Blank" "Full") (* i 1000)
                  (inst (hv (mod i 4)) "Header" (* i 1000) 0 800 80 (spec :rect "bg" (* i 1000) 0 800 80))
                  (when (>= i 4)
                    [(spec :rect "content" (+ 100 (* i 1000)) 200 200 200)])))))

(t/deftest chrome-groups-the-variants-of-a-header-and-reports-the-blank-boards
  ;; Before: each variant was a component of its own, in 3 of 12 boards (25 %),
  ;; so there was no chrome and the 4 blank boards were missed.
  (let [hv   (vec (repeatedly 4 uuid/next))
        page (header-variants-page hv)
        res  (chrome-scan page {:component-variant (variant-of hv)})]
    (t/is (= [{:id variant-container :name "Header" :boards 12 :variants 4}]
             (:chrome-components res)))
    (t/is (= ["Blank" "Blank" "Blank" "Blank"] (reported res)))
    (t/is (= (map vector hv) (map (comp :chrome-component-ids :detail) (:findings res)))
          "each finding lists the component id present in its board")))

(t/deftest chrome-keeps-a-plain-footer-beside-a-variant-header
  (let [hv    (vec (repeatedly 2 uuid/next))
        ftr   (uuid/next)
        page  (apply page-of
                     (for [i (range 6)]
                       (screen (str "Board " i) (* i 1000)
                               (inst (hv (mod i 2)) "Header" (* i 1000) 0 800 80)
                               (inst ftr "Footer" (* i 1000) 560 800 40))))
        res   (chrome-scan page {:component-variant (variant-of hv)})
        by-id (into {} (map (juxt :id identity)) (:chrome-components res))]
    (t/is (= 2 (count (:chrome-components res))))
    (t/is (= {:id variant-container :name "Header" :boards 6 :variants 2} (get by-id variant-container)))
    (t/is (= {:id ftr :name "Footer" :boards 6} (get by-id ftr)) "no `variants` for a plain component")))

(t/deftest chrome-falls-back-to-the-component-id-for-an-external-library
  ;; The variant function answers nil for a component that is not in this
  ;; file, so each variant stays a component of its own: 3 of 12 boards.
  (let [hv   (vec (repeatedly 4 uuid/next))
        page (header-variants-page hv)
        res  (chrome-scan page {:component-variant (constantly nil)})]
    (t/is (= [] (:chrome-components res)))
    (t/is (= [] (:findings res)))
    (t/is (= [] (:chrome-components (chrome-scan page))) "the same without the option")))

(defn- keypad-page
  "Ten boards that each hold a header; the first four also hold a keypad of
  40 % of the board in the middle, the others a content rect."
  [hdr kp]
  (apply page-of
         (for [i (range 10)]
           (let [bx (* i 1000)]
             (apply screen (if (< i 4) "Pin" "Other") bx
                    (inst hdr "Header" bx 0 800 80)
                    (if (< i 4)
                      [(inst kp "Keypad" (+ bx 160) 100 480 400 (spec :rect "k" (+ bx 160) 100 480 400))]
                      [(spec :rect "content" (+ bx 100) 200 200 200)]))))))

(t/deftest chrome-leaves-out-a-content-block-on-some-boards
  ;; Before: the keypad, at the same offset in 4 of 10 boards, was chrome, so
  ;; the four PIN screens (header and keypad) were reported as blank.
  (let [hdr (uuid/next)
        kp  (uuid/next)
        res (chrome-scan (keypad-page hdr kp))]
    (t/is (= ["Header"] (chrome-names res)) "the keypad touches no edge and is on 40 % of the boards")
    (t/is (= [] (:findings res)))))

(t/deftest chrome-includes-a-footer-and-a-side-rail-that-touch-an-edge
  (let [hdr  (uuid/next)
        ftr  (uuid/next)
        rail (uuid/next)
        page (apply page-of
                    (for [i (range 10)]
                      (let [bx (* i 1000)]
                        (apply screen (str "Board " i) bx
                               (inst hdr "Header" bx 0 800 80)
                               (when (< i 4)
                                 [(inst ftr "Footer" bx 560 800 40)
                                  (inst rail "Rail" (+ bx 2) 100 60 400)])))))
        res  (chrome-scan page)]
    (t/is (= #{"Header" "Footer" "Rail"} (set (chrome-names res)))
          "a footer on the bottom edge and a rail on the left edge are chrome in 4 of 10 boards")))

(t/deftest chrome-includes-a-component-on-most-boards-even-in-the-middle
  (let [hdr  (uuid/next)
        back (uuid/next)
        page (fn [n]
               (apply page-of
                      (for [i (range 10)]
                        (let [bx (* i 1000)]
                          (apply screen (str "Board " i) bx
                                 (inst hdr "Header" bx 0 800 80)
                                 (when (< i n)
                                   [(inst back "Back" (+ bx 380) 280 40 40)]))))))]
    (t/is (= #{"Header" "Back"} (set (chrome-names (chrome-scan (page 10))))) "on every board")
    (t/is (= #{"Header" "Back"} (set (chrome-names (chrome-scan (page 7))))) "on 70 % of the boards")
    (t/is (= ["Header"] (chrome-names (chrome-scan (page 6)))) "on 60 % of the boards")))

(t/deftest chrome-leaves-out-a-centred-logo-on-40-percent-of-the-boards
  (let [hdr  (uuid/next)
        logo (uuid/next)
        page (apply page-of
                    (for [i (range 10)]
                      (let [bx (* i 1000)]
                        (apply screen (str "Board " i) bx
                               (inst hdr "Header" bx 0 800 80)
                               (when (< i 4)
                                 [(inst logo "Logo" (+ bx 380) 280 40 40)])))))
        res  (chrome-scan page)]
    (t/is (= ["Header"] (chrome-names res)))))

(t/deftest chrome-compares-offsets-within-two-pixels
  ;; Before: the offsets 0.4 and 0.6 were rounded to 0 and 1, neither reached
  ;; 80 % of the boards, so there was no chrome.
  (let [hdr  (uuid/next)
        page (fn [offset-of]
               (apply page-of
                      (for [i (range 6)]
                        (screen (str "Blank " i) (* i 1000)
                                (inst hdr "Header" (* i 1000) (offset-of i) 800 80)))))
        res  (chrome-scan (page #(if (even? %) 0.4 0.6)))]
    (t/is (= [{:id hdr :name "Header" :boards 6}] (:chrome-components res)))
    (t/is (= 6 (count (:findings res))))
    (t/is (= [] (:chrome-components (chrome-scan (page #(if (even? %) 0 40)))))
          "offsets 0 and 40 on half the boards each are a real split")))

(t/deftest a-background-split-into-several-shapes-counts-as-content-pinned
  ;; Pins the current result: two rects of 400 by 600 are each under the
  ;; backdrop share, so a board of a header and these two is not blank.
  (let [hdr  (uuid/next)
        page (apply page-of
                    (for [i (range 6)]
                      (let [bx (* i 1000)]
                        (screen (str "Board " i) bx
                                (spec :rect "left" bx 0 400 600)
                                (spec :rect "right" (+ bx 400) 0 400 600)
                                (inst hdr "Header" bx 0 800 80)))))
        res  (chrome-scan page)]
    (t/is (= ["Header"] (chrome-names res)))
    (t/is (= [] (:findings res)))))

(t/deftest lint-groups-the-variants-of-a-component-in-a-pointer-map-file
  ;; Before: the lint loaded the file without its components, so with the
  ;; `fdata/pointer-map` feature the component lookup threw an
  ;; `UnsupportedOperationException` and the command failed.
  (let [{:keys [profile file-id page-id]} (new-file)
        [lib vc m1 m2 c1 c2] (repeatedly 6 uuid/next)
        boards (vec (repeatedly 6 uuid/next))
        x      (fn [i] (* i 1000))
        main   (fn [id cid name value]
                 (obj lib id vc vc :frame name 0 0 800 80
                      {:main-instance true
                       :component-root true
                       :component-id cid
                       :component-file file-id
                       :variant-id vc
                       :variant-name (str "Property 1=" value)}))
        _      (apply-changes!
                profile file-id
                (concat
                 [{:type :add-page :id lib :name "Library"}
                  (obj lib vc uuid/zero uuid/zero :frame "Header variants" 0 0 900 100
                       {:is-variant-container true})
                  (main m1 c1 "Header" "a")
                  (main m2 c2 "Header" "b")
                  {:type :add-component :id c1 :name "Header" :path ""
                   :main-instance-id m1 :main-instance-page lib
                   :variant-id vc :variant-properties [{:name "Property 1" :value "a"}]}
                  {:type :add-component :id c2 :name "Header" :path ""
                   :main-instance-id m2 :main-instance-page lib
                   :variant-id vc :variant-properties [{:name "Property 1" :value "b"}]}]
                 (mapcat (fn [i b]
                           (concat
                            [(obj page-id b uuid/zero uuid/zero :frame (str "Board " i) (x i) 0 800 600
                                  {:show-content false})
                             (obj page-id (uuid/next) b b :frame "Header" (x i) 0 800 80
                                  (instance-attrs file-id (if (even? i) c1 c2)))]
                            (when (>= i 3)
                              [(obj page-id (uuid/next) b b :rect "Content" (+ (x i) 100) 200 200 200 {})])))
                         (range 6) boards)))
        stored (bfc/get-file th/*system* file-id)
        out    (lint profile file-id page-id {:depth 1 :rules [:instance-only-board]})]
    (t/is (true? (pmap/pointer-map? (get-in stored [:data :components])))
          "the components of the file are stored as a pointer map")
    (t/is (nil? (:error out)))
    (t/is (= [{:id vc :name "Header" :boards 6 :variants 2}] (:chrome-components (:result out))))
    (t/is (= (subvec boards 0 3) (map :board-id (findings-of out :instance-only-board)))
          "the three boards that hold only a header variant are reported")))

(t/deftest chrome-leaves-out-a-full-width-banner-in-the-middle
  ;; Before: a full-width box touched the left and right edges, so a banner
  ;; on 4 of 10 boards was chrome and the four screens that hold a header and
  ;; this banner were reported as blank.
  (let [hdr    (uuid/next)
        banner (uuid/next)
        page   (apply page-of
                      (for [i (range 10)]
                        (let [bx (* i 1000)]
                          (apply screen (if (< i 4) "Hero" "Other") bx
                                 (inst hdr "Header" bx 0 800 80)
                                 (if (< i 4)
                                   [(inst banner "Banner" bx 200 800 200 (spec :rect "b" bx 200 800 200))]
                                   [(spec :rect "content" (+ bx 100) 200 200 200)])))))
        res    (chrome-scan page)]
    (t/is (= ["Header"] (chrome-names res)))
    (t/is (= [] (:findings res)))))

(t/deftest chrome-includes-a-full-height-side-rail-and-a-short-tab-is-not-chrome
  (let [hdr  (uuid/next)
        rail (uuid/next)
        tab  (uuid/next)
        page (fn [rail?]
               (apply page-of
                      (for [i (range 10)]
                        (let [bx (* i 1000)]
                          (apply screen (str "Board " i) bx
                                 (inst hdr "Header" bx 0 800 80)
                                 (when (< i 4)
                                   [(if rail?
                                      (inst rail "Rail" bx 0 60 600)
                                      (inst tab "Tab" (+ bx 740) 250 60 100))]))))))]
    (t/is (= #{"Header" "Rail"} (set (chrome-names (chrome-scan (page true))))) "a rail as high as the board")
    (t/is (= ["Header"] (chrome-names (chrome-scan (page false)))) "a short tab at the right edge")))

(t/deftest chrome-includes-a-narrow-floating-button-in-the-bottom-corner-by-its-bottom-edge
  ;; Kept on purpose: the button is 2 px from the bottom edge, so it touches
  ;; an edge there, whatever its width.
  (let [hdr  (uuid/next)
        fab  (uuid/next)
        page (apply page-of
                    (for [i (range 10)]
                      (let [bx (* i 1000)]
                        (apply screen (str "Board " i) bx
                               (inst hdr "Header" bx 0 800 80)
                               (when (< i 4)
                                 [(inst fab "Button" (+ bx 758) 558 40 40)])))))]
    (t/is (= #{"Header" "Button"} (set (chrome-names (chrome-scan page)))))))

(t/deftest a-header-at-the-top-on-some-boards-and-lower-on-the-rest-is-not-chrome-a-known-limit
  ;; A known limit: the rule asks for one place on 80 % of the boards that
  ;; hold the component, so blank screens that hold only such a header are
  ;; not reported.
  (let [hdr  (uuid/next)
        page (apply page-of
                    (for [i (range 10)]
                      (screen (str "Board " i) (* i 1000)
                              (inst hdr "Header" (* i 1000) (if (< i 4) 0 300) 800 80))))
        res  (chrome-scan page)]
    (t/is (= [] (:chrome-components res)))
    (t/is (= [] (:findings res)))))

(t/deftest variants-that-sit-at-different-places-are-not-chrome-a-known-limit
  ;; A known limit: the variants of a set count as one component, and that
  ;; component still has to sit in one place, so a variant at the top and
  ;; another at the bottom give no chrome.
  (let [hv   (vec (repeatedly 2 uuid/next))
        page (apply page-of
                    (for [i (range 10)]
                      (screen (str "Board " i) (* i 1000)
                              (inst (hv (mod i 2)) "Header" (* i 1000) (if (even? i) 0 400) 800 80))))
        res  (chrome-scan page {:component-variant (variant-of hv)})]
    (t/is (= [] (:chrome-components res)))
    (t/is (= [] (:findings res)))))

;; --- LINT: SCROLL, TOLERANCE AND INVISIBLE FRACTION

(t/deftest scroll-candidate-ignores-a-background-that-bleeds-past-the-frame
  ;; Before: a background 10 px larger on every side made the frame a scroll
  ;; candidate (a top-level board clips by default).
  (let [{:keys [profile file-id page-id]} (new-file)
        [bleed list-board] (repeatedly 2 uuid/next)
        _     (apply-changes!
               profile file-id
               [(clip-board page-id bleed "Bleed" 0 {})
                (obj page-id (uuid/next) bleed bleed :rect "Bg" -10 -10 220 220 {})
                (clip-board page-id list-board "List" 400 {})
                (obj page-id (uuid/next) list-board list-board :rect "Bg" 390 -10 220 220 {})
                (obj page-id (uuid/next) list-board list-board :rect "Row" 400 150 50 100 {})])
        out   (lint profile file-id page-id {:depth 1 :rules [:scroll-candidate]})
        found (scroll-rule-of out list-board)]
    (t/is (nil? (:error out)))
    (t/is (nil? (scroll-rule-of out bleed)) "the bleeding background alone is not reported")
    (t/is (= "vertical" (get-in found [:detail :suggested]))
          "the rows that start inside and run past the bottom are; the background does not add the right side")
    (t/is (== 0 (get-in found [:detail :overflow :right])))
    (t/is (== 50 (get-in found [:detail :overflow :bottom])))))

(t/deftest scroll-candidate-finds-a-single-track-that-starts-left-of-the-frame
  ;; Before: a track that starts left of the frame was dropped from the
  ;; measure, so a carousel scrolled to the middle gave no finding.
  (let [page  (page-of (screen "Screen" 0
                               (spec :frame "Carousel" 0 100 375 200
                                     (spec :frame "Track" -150 100 1200 200
                                           (spec :rect "c" -150 100 300 200)))))
        found (scroll-scan page)]
    (t/is (= ["Carousel"] (map :shape-name found)))
    (t/is (= "horizontal" (get-in (first found) [:detail :suggested])))
    (t/is (== 675 (get-in (first found) [:detail :overflow :right])))))

(t/deftest scroll-candidate-still-ignores-a-background-that-bleeds-on-all-sides
  (let [page (page-of (screen "Screen" 0
                              (spec :frame "Carousel" 0 100 375 200
                                    (spec :rect "Bg" -10 90 395 220))))]
    (t/is (= [] (scroll-scan page)))))

(t/deftest scroll-candidate-reports-a-track-that-starts-above-and-left-but-ends-inside
  (let [page  (page-of (screen "Screen" 0
                               (spec :frame "Carousel" 0 100 375 200
                                     (spec :rect "Track" -150 50 700 200))))
        found (scroll-scan page)]
    (t/is (= ["Carousel"] (map :shape-name found)))
    (t/is (= "horizontal" (get-in (first found) [:detail :suggested])))
    (t/is (== 175 (get-in (first found) [:detail :overflow :right])))
    (t/is (== 0 (get-in (first found) [:detail :overflow :bottom])))))

(t/deftest scroll-candidate-needs-an-overflow-above-the-tolerance
  ;; Before: with min-overflow 0, an overflow of 0.00005 px was a candidate.
  (let [{:keys [profile file-id page-id]} (new-file)
        [noise real] (repeatedly 2 uuid/next)
        _     (apply-changes!
               profile file-id
               [(clip-board page-id noise "Noise" 0 {})
                (obj page-id (uuid/next) noise noise :rect "R" 0 0 200.00005 50 {})
                (clip-board page-id real "Real" 400 {})
                (obj page-id (uuid/next) real real :rect "R" 400 0 200.6 50 {})])
        by    (fn [params] (set (map :shape-id (:findings (:result (lint profile file-id page-id
                                                                         (merge {:depth 1 :rules [:scroll-candidate]} params)))))))]
    (t/is (= #{real} (by {:min-overflow 0})) "0.6 px exceeds the default tolerance of 0.5, 0.00005 px does not")
    (t/is (= #{noise real} (by {:min-overflow 0 :tolerance 0})) "the strict tolerance keeps both")
    (t/is (= #{} (by {:min-overflow 0 :tolerance 1})))))

(t/deftest scroll-reachability-allows-the-tolerance-on-the-axis-that-does-not-scroll
  ;; Before: a row 0.3 px past the scroll frame on x was unreachable, so it was
  ;; reported as invisible instead of scroll-hidden.
  (let [{:keys [profile file-id page-id]} (new-file)
        board (uuid/next)
        list  (uuid/next)
        row   (uuid/next)
        _     (apply-changes!
               profile file-id
               (concat (scroll-scene page-id board list 0 0 200 100
                                     {:show-content false :overflow-scroll :vertical})
                       (row-changes file-id page-id list row 0.3 150 "Row")))
        rules [:clipped-control :invisible-control :scroll-hidden-control]
        out   (lint profile file-id page-id {:rules rules})
        raw   (lint profile file-id page-id {:rules rules :tolerance 0})]
    (t/is (nil? (:error out)))
    (t/is (= :scroll-hidden-control (rule-of out row)))
    (t/is (= :invisible-control (rule-of raw row)) "with tolerance 0 the 0.3 px counts")))

(t/deftest invisible-control-reports-a-visible-fraction-of-zero-and-the-raw-share
  ;; Before: a control judged invisible on the shrunk box reported 0.004.
  (let [{:keys [profile file-id page-id]} (new-file)
        [sliver gone] (add-controls! profile file-id page-id
                                     [[true 199.8 0 50 50]
                                      [true 300 0 50 50]])
        out   (lint profile file-id page-id {:rules edge-rules})]
    (t/is (nil? (:error out)))
    (t/is (= :invisible-control (rule-of out sliver)))
    (t/is (== 0 (:visible-fraction (detail-of out sliver))))
    (t/is (< (Math/abs (- 0.004 (:raw-visible-fraction (detail-of out sliver)))) 1e-9))
    (t/is (= :invisible-control (rule-of out gone)))
    (t/is (== 0 (:visible-fraction (detail-of out gone))))
    (t/is (not (contains? (detail-of out gone) :raw-visible-fraction)) "no share, no key")))
