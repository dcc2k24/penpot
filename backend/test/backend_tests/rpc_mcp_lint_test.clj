;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-mcp-lint-test
  (:require
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.http.access-token :as-alias actoken]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.mcp :as mcp]
   [app.rpc.commands.mcp-lint :as mcp-lint]
   [app.util.cache :as cache]
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

(t/deftest lint-instance-only-board-names-the-component
  (let [{:keys [profile file-id page-id]} (new-file)
        cid   (uuid/next)
        board (uuid/next)
        inst  (uuid/next)
        text  (uuid/next)
        _     (apply-changes!
               profile file-id
               [(obj page-id board uuid/zero uuid/zero :frame "Only" 0 0 200 200 {:show-content false})
                (obj page-id inst board board :frame "Button" 0 0 100 50
                     (instance-attrs file-id cid))
                (obj page-id text inst board :text "Label" 10 10 80 20
                     {:content (text-content "Button")})])
        out   (lint profile file-id page-id {:rules [:instance-only-board]})
        found (findings-of out :instance-only-board)]
    (t/is (nil? (:error out)))
    (t/is (= 1 (count found)))
    (t/is (= board (:board-id (first found))))
    (t/is (= inst (:shape-id (first found))))
    (t/is (= cid (get-in (first found) [:detail :component-id])))
    (t/is (= "Button" (get-in (first found) [:detail :shape-name])))))

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
        screen   (uuid/next)
        only     (uuid/next)
        only-t   (uuid/next)
        _        (apply-changes!
                  profile file-id
                  [(obj page-id main uuid/zero uuid/zero :frame "Main" 0 0 200 200
                        (main-attrs file-id cid))
                   (obj page-id nested main main :frame "Nested" 10 10 100 50
                        (instance-attrs file-id (uuid/next)))
                   (obj page-id nested-t nested main :text "T" 20 20 50 10
                        {:content (text-content "N")})
                   (obj page-id screen uuid/zero uuid/zero :frame "Screen" 300 0 200 200
                        {:show-content false})
                   (obj page-id only screen screen :frame "Only" 310 10 100 50
                        (instance-attrs file-id cid))
                   (obj page-id only-t only screen :text "T" 320 20 50 10
                        {:content (text-content "O")})])
        out      (lint profile file-id page-id {:rules [:instance-only-board]})]
    (t/is (nil? (:error out)))
    (t/is (= [screen] (map :board-id (findings-of out :instance-only-board))))
    (t/is (= {"instance-only-board" 1} (:counts (:result out))))))

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
