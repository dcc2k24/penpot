;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-mcp-read-test
  (:require
   [app.binfile.common :as bfc]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.migrations :as fmg]
   [app.common.json :as json]
   [app.common.logging :as l]
   [app.common.math :as mth]
   [app.common.mcp.operations :as operations]
   [app.common.time :as ct]
   [app.common.types.shape :as cts]
   [app.common.types.shape.layout :as ctl]
   [app.common.types.tokens-lib :as ctob]
   [app.common.types.tokens-status :as ctos]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.http :as http]
   [app.http.access-token :as-alias actoken]
   [app.http.session :as session]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.access-token :as access-token]
   [app.rpc.commands.mcp :as mcp]
   [app.rpc.commands.profile :as profile]
   [app.setup :as-alias setup]
   [app.tokens :as tokens]
   [app.util.cache :as cache]
   [app.util.pointer-map :as pmap]
   [backend-tests.helpers :as th]
   [clojure.test :as t]
   [ring.core.protocols :as rcp]
   [yetti.response :as-alias yres]))

(t/use-fixtures :once (t/compose-fixtures
                       (partial th/init-config [:enable-access-tokens
                                                :enable-client-header-check-middleware])
                       th/init-system))

(defn- clear-mcp-caches
  "Empties the MCP caches between tests. Test files reuse the same file
  ids (`mk-uuid \"file\" i`), so a root cached by one test would answer
  for another test's file with the same revision."
  [f]
  (doseq [c [@#'mcp/root-cache @#'mcp/page-cache @#'mcp/outline-cache]]
    (cache/invalidate c))
  (f))

(t/use-fixtures :each th/database-reset clear-mcp-caches)

;; --- HELPERS

(defn- call!
  "Runs an MCP read command as `profile`, authenticated with an MCP token
  of `perms`. `token-id` is passed as the id of the request's token, and
  `expires-at` as the expiry the access-token middleware read for it."
  [profile method params & {:keys [perms token-id expires-at]}]
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
                  (cond-> {:headers {}
                           ::actoken/id token-id}
                    (some? expires-at)
                    (assoc ::actoken/expires-at expires-at)))))))

(defn- current-revn
  [file-id]
  (:revn (th/db-get :file {:id file-id})))

(defn- apply-changes!
  [profile file-id changes]
  (th/update-file* {:file-id file-id
                    :profile-id (:id profile)
                    :revn (current-revn file-id)
                    :changes changes}))

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

(def ^:private text-content
  {:type "root"
   :children [{:type "paragraph-set"
               :children [{:type "paragraph"
                           :children [{:text "Hello Penpot"
                                       :font-size "14"
                                       :font-family "sourcesanspro"
                                       :font-weight "400"
                                       :fills [{:fill-color "#000000"
                                                :fill-opacity 1}]}]}]}]})

(def ^:private red-fill
  [{:fill-color "#FF0000" :fill-opacity 1}])

(defn- create-fixture
  "A file with three pages. Page one holds a board with a red rect and a
  text; page two holds a board with a red rect; page three is empty."
  []
  (let [profile (th/create-profile* 1 {:is-active true})
        file    (th/create-file* 1 {:profile-id (:id profile)
                                    :project-id (:default-project-id profile)})
        page1   (get-in file [:data :pages 0])
        page2   (uuid/next)
        page3   (uuid/next)
        board1  (uuid/next)
        rect1   (uuid/next)
        text1   (uuid/next)
        board2  (uuid/next)
        rect2   (uuid/next)]
    (apply-changes!
     profile (:id file)
     [{:type :add-page :id page2 :name "Second"}
      {:type :add-page :id page3 :name "Third"}
      (add-obj page1 board1 uuid/zero uuid/zero {:type :frame :name "Board"})
      (add-obj page1 rect1 board1 board1 {:type :rect :name "Rect A" :fills red-fill})
      (add-obj page1 text1 board1 board1 {:type :text
                                          :name "Label"
                                          :x 0 :y 0 :width 100 :height 20
                                          :content text-content})
      (add-obj page2 board2 uuid/zero uuid/zero {:type :frame :name "Board"})
      (add-obj page2 rect2 board2 board2 {:type :rect :name "Rect A" :fills red-fill})])
    {:profile (th/db-get :profile {:id (:id profile)})
     :file-id (:id file)
     :page1 page1
     :page2 page2
     :page3 page3
     :board1 board1
     :rect1 rect1
     :text1 text1
     :board2 board2
     :rect2 rect2}))

;; --- WHOAMI

(t/deftest whoami-reports-token-scopes
  (let [{:keys [profile]} (create-fixture)
        token-id          (uuid/next)
        read-only         (call! profile :mcp-whoami {} :token-id token-id)
        writer            (call! profile :mcp-whoami {} :perms #{"mcp:write"})]
    (t/is (nil? (:error read-only)))
    (t/is (= (:id profile) (:profile-id (:result read-only))))
    (t/is (= (:email profile) (:email (:result read-only))))
    (t/is (= ["mcp:read"] (:scopes (:result read-only))))
    (t/is (= token-id (:token-id (:result read-only))))
    (t/is (nil? (:expires-at (:result read-only))))
    (t/is (contains? (set (:features (:result read-only))) "fdata/pointer-map"))
    (t/is (string? (get-in (:result read-only) [:version :full])))
    (t/is (= ["mcp:read" "mcp:write"] (:scopes (:result writer))))
    (t/is (nil? (:token-id (:result writer))))))

(t/deftest whoami-rejects-blocked-and-inactive-profiles
  (doseq [[changes code] [[{:is-blocked true} :profile-blocked]
                          [{:is-active false} :profile-not-active]]]
    (let [profile (th/create-profile* (uuid/next) {:is-active true})]
      (db/update! th/*system* :profile changes {:id (:id profile)})
      (let [out (call! profile :mcp-whoami {})]
        (t/is (= code (th/ex-code (:error out))))))))

;; --- OUTLINE

(t/deftest outline-summarises-pages-and-counts
  (let [{:keys [profile file-id page1 page2 page3]} (create-fixture)
        out     (call! profile :get-mcp-file-outline {:file-id file-id})
        outline (:result out)
        pages   (:pages outline)]
    (t/is (nil? (:error out)))
    (t/is (= file-id (:id outline)))
    (t/is (= 3 (count pages)))
    (t/is (= [0 1 2] (map :index pages)))
    (t/is (= [page1 page2 page3] (map :id pages)))
    (t/is (= "Second" (:name (second pages))))
    (t/is (= 3 (:shape-count (first pages))))
    (t/is (= 1 (:root-child-count (first pages))))
    (t/is (= 0 (:shape-count (nth pages 2))))
    (t/is (= [] (:libraries outline)))
    (t/is (= 0 (:components outline)))
    (t/is (= 0 (:media outline)))
    (t/is (nil? (:tokens outline)))
    (t/is (boolean? (:pointer-map outline)))
    (t/is (= (:revn outline) (current-revn file-id)))

    ;; the audit props name the file and its pages, never the content
    (let [props (:app.loggers.audit/replace-props (meta (:result out)))]
      (t/is (= "get-mcp-file-outline" (:tool props)))
      (t/is (= file-id (:file-id props)))
      (t/is (= [page1 page2 page3] (:page-ids props))))

    ;; a second call on the same revision is served from the cache
    (t/is (= pages (:pages (:result (call! profile :get-mcp-file-outline {:file-id file-id})))))))

(t/deftest outline-builds-a-page-summary-only-when-its-page-changes
  (let [{:keys [profile file-id page2 board2]} (create-fixture)
        builds   (atom 0)
        original @#'mcp/page-summary
        outline  #(call! profile :get-mcp-file-outline {:file-id file-id})]
    (with-redefs [mcp/page-summary (fn [& args]
                                     (swap! builds inc)
                                     (apply original args))]
      (t/is (true? (:pointer-map (:result (outline)))))
      (t/is (= 3 @builds))

      ;; an unchanged file builds nothing again
      (outline)
      (t/is (= 3 @builds))

      ;; a change on one page rebuilds that page only
      (apply-changes! profile file-id
                      [(add-obj page2 (uuid/next) board2 board2 {:type :rect :name "Late"})])
      (outline)
      (t/is (= 4 @builds)))))

;; --- PAGE TREE

(t/deftest page-tree-honours-depth
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        shallow (call! profile :get-mcp-page-tree {:file-id file-id :page-id page1 :depth 1})
        deep    (call! profile :get-mcp-page-tree {:file-id file-id :page-id page1 :depth 3})
        root    (:root (:result shallow))
        board   (-> (:root (:result deep)) :children first)]
    (t/is (nil? (:error shallow)))
    (t/is (= 1 (:child-count root)))
    (t/is (= [] (:children root)))
    (t/is (= board1 (:id board)))
    (t/is (= 2 (count (:children board))))
    (t/is (= [] (:children (first (:children board)))))
    (t/is (= 0 (:child-count (first (:children board)))))
    (t/is (= :text (:type (second (:children board)))))
    (t/is (= "approximate"
             (:text-layout-state (second (:children board)))))
    (t/is (false? (:truncated (:result deep))))))

(defn- create-board-with-rects!
  "Creates a board with three rects, created in that order, through the MCP
  operations. The board gets a flex layout first when `layout?`. Returns the
  ids of the board and of the rects."
  [profile file-id page-id layout?]
  (let [layout-ops (when layout?
                     [{:op "set_flex_layout" :page-id page-id :id "$tmp:board"}])
        rect-ops   (mapv (fn [handle]
                           {:op "create_rect" :page-id page-id :id handle
                            :parent-id "$tmp:board"
                            :x 0 :y 0 :width 10 :height 10})
                         ["$tmp:r1" "$tmp:r2" "$tmp:r3"])
        out        (call! profile :mcp-apply-operations
                          {:file-id file-id
                           :operations (-> [{:op "create_board" :page-id page-id
                                             :id "$tmp:board"
                                             :x 0 :y 0 :width 300 :height 300}]
                                           (into layout-ops)
                                           (into rect-ops))}
                          :perms #{"mcp:write"})
        ids        (:created-ids (:result out))]
    (t/is (nil? (:error out)))
    {:board (get ids "$tmp:board")
     :rects (mapv #(get ids %) ["$tmp:r1" "$tmp:r2" "$tmp:r3"])}))

(defn- tree-child-ids
  "The ids of the children of `board`, in the order the page tree lists them."
  [profile file-id page-id board]
  (let [out (call! profile :get-mcp-page-tree {:file-id file-id
                                               :page-id page-id
                                               :root-id board
                                               :depth 2})]
    (t/is (nil? (:error out)))
    (mapv :id (:children (:root (:result out))))))

(t/deftest page-tree-lists-flex-children-in-creation-order
  (let [{:keys [profile file-id page1]} (create-fixture)
        {:keys [board rects]} (create-board-with-rects! profile file-id page1 true)]
    (t/is (= rects (tree-child-ids profile file-id page1 board)))))

(t/deftest page-tree-keeps-stored-order-of-plain-boards
  (let [{:keys [profile file-id page1]} (create-fixture)
        {:keys [board rects]} (create-board-with-rects! profile file-id page1 false)]
    (t/is (= rects (tree-child-ids profile file-id page1 board)))))

(t/deftest page-tree-pages-through-a-cursor
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        first-page (call! profile :get-mcp-page-tree {:file-id file-id
                                                      :page-id page1
                                                      :depth 3
                                                      :limit 2})
        result     (:result first-page)
        cursor     (:next-cursor result)]
    (t/is (true? (:truncated result)))
    (t/is (string? cursor))
    (let [second-page (call! profile :get-mcp-page-tree {:file-id file-id
                                                         :page-id page1
                                                         :depth 3
                                                         :limit 2
                                                         :cursor cursor})
          rest-result (:result second-page)
          board       (-> rest-result :root :children first)]
      (t/is (nil? (:error second-page)))
      (t/is (false? (:truncated rest-result)))
      (t/is (nil? (:next-cursor rest-result)))
      (t/is (= board1 (:id board)))
      (t/is (= 2 (count (:children board)))))))

(t/deftest page-tree-refuses-stale-and-invalid-cursors
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        first-page (call! profile :get-mcp-page-tree {:file-id file-id
                                                      :page-id page1
                                                      :limit 1})
        cursor     (get-in first-page [:result :next-cursor])]
    (t/is (string? cursor))
    (t/is (= :mcp-invalid-cursor
             (th/ex-code (:error (call! profile :get-mcp-page-tree
                                        {:file-id file-id :page-id page1
                                         :cursor "not-a-cursor"})))))

    ;; any change moves the revision, which makes the cursor stale
    (apply-changes! profile file-id
                    [(add-obj page1 (uuid/next) board1 board1
                              {:type :rect :name "Late"})])
    (t/is (= :mcp-stale-cursor
             (th/ex-code (:error (call! profile :get-mcp-page-tree
                                        {:file-id file-id :page-id page1
                                         :limit 1 :cursor cursor})))))))

(t/deftest page-tree-refuses-a-cursor-of-another-depth
  (let [{:keys [profile file-id page1]} (create-fixture)
        first-page (call! profile :get-mcp-page-tree {:file-id file-id
                                                      :page-id page1
                                                      :depth 3
                                                      :limit 1})
        cursor     (get-in first-page [:result :next-cursor])]
    (t/is (string? cursor))
    (t/is (= :mcp-invalid-cursor
             (th/ex-code (:error (call! profile :get-mcp-page-tree
                                        {:file-id file-id :page-id page1
                                         :depth 2 :limit 1 :cursor cursor})))))
    (t/is (nil? (:error (call! profile :get-mcp-page-tree
                               {:file-id file-id :page-id page1
                                :depth 3 :limit 1 :cursor cursor}))))))

;; --- FILE DATA AND CACHES

(t/deftest page-is-decoded-once-per-revision
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        decodes  (atom 0)
        original @#'mcp/load-page
        read!    #(call! profile :get-mcp-page-tree {:file-id file-id :page-id page1})]
    (with-redefs [mcp/load-page (fn [& args]
                                  (swap! decodes inc)
                                  (apply original args))]
      (read!)
      (read!)
      (t/is (= 1 @decodes))

      ;; a new revision decodes the page again
      (apply-changes! profile file-id
                      [(add-obj page1 (uuid/next) board1 board1 {:type :rect :name "Late"})])
      (read!)
      (t/is (= 2 @decodes)))))

(t/deftest file-needing-migration-is-persisted-once
  (let [{:keys [profile file-id page1]} (create-fixture)
        migrations (atom 0)
        original   fmg/migrate-file
        read!      #(call! profile :get-mcp-page-tree {:file-id file-id :page-id page1})]
    (db/update! th/*system* :file {:version (dec fmg/version)} {:id file-id})
    (with-redefs [fmg/migrate-file (fn [& args]
                                     (swap! migrations inc)
                                     (apply original args))]
      (t/is (nil? (:error (read!))))
      (t/is (= 1 @migrations))
      (t/is (= fmg/version (:version (th/db-get :file {:id file-id}))))

      (t/is (nil? (:error (read!))))
      (t/is (= 1 @migrations)))))

;; --- SHAPES

(t/deftest shapes-return-full-shapes-missing-ids-and-children
  (let [{:keys [profile file-id page1 board1 rect1 text1]} (create-fixture)
        missing (uuid/next)
        out     (call! profile :get-mcp-shapes {:file-id file-id
                                                :page-id page1
                                                :ids [rect1 missing]})
        shapes  (:shapes (:result out))
        text    (:result (call! profile :get-mcp-shapes {:file-id file-id
                                                         :page-id page1
                                                         :ids [text1]}))]
    (t/is (nil? (:error out)))
    (t/is (= [rect1] (map :id shapes)))
    (t/is (= [missing] (:missing (:result out))))
    (t/is (contains? (first shapes) :fills))
    (t/is (not (contains? (first shapes) :thumbnail)))
    (t/is (= "Hello Penpot" (:characters (first (:shapes text)))))
    (t/is (= "approximate" (:text-layout-state (first (:shapes text)))))

    (let [tree (:shapes (:result (call! profile :get-mcp-shapes {:file-id file-id
                                                                 :page-id page1
                                                                 :ids [board1]
                                                                 :include-children true})))]
      (t/is (= 3 (count tree)))
      (t/is (= board1 (:id (first tree)))))

    (let [narrow (:shapes (:result (call! profile :get-mcp-shapes {:file-id file-id
                                                                   :page-id page1
                                                                   :ids [rect1]
                                                                   :fields [:name]})))]
      (t/is (= #{:id :type :name} (set (keys (first narrow))))))))

(t/deftest shapes-refuse-the-root-with-its-children
  (let [{:keys [profile file-id page1]} (create-fixture)
        out (call! profile :get-mcp-shapes {:file-id file-id
                                            :page-id page1
                                            :ids [uuid/zero]
                                            :include-children true})]
    (t/is (= :mcp-root-children-not-allowed (th/ex-code (:error out))))))

(t/deftest shapes-stop-at-the-cap-and-say-so
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        params {:file-id file-id :page-id page1 :ids [board1] :include-children true}
        whole  (:result (call! profile :get-mcp-shapes params))
        capped (with-redefs [mcp/shapes-cap 2]
                 (:result (call! profile :get-mcp-shapes params)))]
    (t/is (= 3 (count (:shapes whole))))
    (t/is (false? (:truncated whole)))
    (t/is (= 2 (count (:shapes capped))))
    (t/is (true? (:truncated capped)))))

(defn- apply-ops!
  "Runs `operations` through `mcp-apply-operations` and returns the ids it
  created, by handle."
  [profile file-id operations]
  (let [out (call! profile :mcp-apply-operations
                   {:file-id file-id :operations operations}
                   :perms #{"mcp:write"})]
    (t/is (nil? (:error out)))
    (:created-ids (:result out))))

(defn- stored-shape
  "The shape `id` as the file stores it."
  [file-id page-id id]
  (get-in (bfc/get-file th/*system* file-id :realize? true)
          [:data :pages-index page-id :objects id]))

(defn- read-shape
  "The shape `id` as `get-mcp-shapes` returns it."
  [profile file-id page-id id & {:as params}]
  (let [out (call! profile :get-mcp-shapes (merge {:file-id file-id
                                                   :page-id page-id
                                                   :ids [id]}
                                                  params))]
    (t/is (nil? (:error out)))
    (first (:shapes (:result out)))))

(defn- tree-root
  "The node of `id` as `get-mcp-page-tree` returns it."
  [profile file-id page-id id]
  (let [out (call! profile :get-mcp-page-tree {:file-id file-id
                                               :page-id page-id
                                               :root-id id
                                               :depth 1})]
    (t/is (nil? (:error out)))
    (:root (:result out))))

(defn- box
  [shape]
  (mapv #(get shape %) [:x :y :width :height]))

(defn- close-box?
  [expected actual]
  (every? true? (map mth/close? expected actual)))

(t/deftest reads-report-the-points-box-of-a-rotated-shape
  (let [{:keys [profile file-id page1]} (create-fixture)
        rect (-> (apply-ops! profile file-id
                             [{:op "create_rect" :page-id page1 :id "$tmp:r"
                               :x 0 :y 0 :width 100 :height 50}])
                 (get "$tmp:r"))
        _    (apply-ops! profile file-id
                         [{:op "update_shape" :page-id page1 :id rect
                           :props {:rotation 45}}])
        ;; The corner of the rectangle around the points of a 100x50 rect
        ;; turned 45 degrees about its center (50, 25); the size is the one
        ;; before rotation, as the plugin API gives.
        half     (/ (* 150 (Math/cos (/ Math/PI 4))) 2)
        expected [(- 50 half) (- 25 half) 100 50]
        stored   (stored-shape file-id page1 rect)]
    (t/is (mth/close? 0 (:x stored)))
    (t/is (close-box? expected (box (read-shape profile file-id page1 rect))))
    (t/is (close-box? expected (box (read-shape profile file-id page1 rect
                                                :fields [:x :y :width :height]))))
    (t/is (close-box? expected (box (tree-root profile file-id page1 rect))))
    (t/is (mth/close? 45 (:rotation (read-shape profile file-id page1 rect))))))

(t/deftest reads-report-the-covering-box-of-a-bool-whose-child-moved
  (let [{:keys [profile file-id page1]} (create-fixture)
        ids  (apply-ops! profile file-id
                         [{:op "create_rect" :page-id page1 :id "$tmp:a"
                           :x 0 :y 0 :width 10 :height 10}
                          {:op "create_rect" :page-id page1 :id "$tmp:b"
                           :x 20 :y 0 :width 10 :height 10}
                          {:op "create_boolean" :page-id page1 :id "$tmp:bool"
                           :bool-type :union :child-ids ["$tmp:a" "$tmp:b"]}])
        bool (get ids "$tmp:bool")
        _    (apply-ops! profile file-id
                         [{:op "update_shape" :page-id page1 :id (get ids "$tmp:b")
                           :props {:x 50}}])
        stored (stored-shape file-id page1 bool)]
    (t/is (close-box? [0 0 60 10] (box (:selrect stored))))
    (t/is (not (close-box? [0 0 60 10] (map #(or % 0) (box stored)))))
    (t/is (close-box? [0 0 60 10] (box (read-shape profile file-id page1 bool))))
    (t/is (close-box? [0 0 60 10] (box (tree-root profile file-id page1 bool))))))

(t/deftest shapes-report-the-defaults-penpot-assumes
  (let [{:keys [profile file-id page1 rect1]} (create-fixture)
        flex   (uuid/next)
        child  (uuid/next)
        stroke (uuid/next)
        _      (apply-changes!
                profile file-id
                [(add-obj page1 flex uuid/zero uuid/zero
                          (merge {:type :frame :name "Flex"} ctl/initial-flex-layout))
                 (add-obj page1 child flex flex {:type :rect :name "Child"})
                 (add-obj page1 stroke uuid/zero uuid/zero
                          {:type :rect
                           :name "Stroked"
                           :strokes [{:stroke-style :solid
                                      :stroke-color "#000000"
                                      :stroke-opacity 1
                                      :stroke-width 1}]})])
        rect   (read-shape profile file-id page1 rect1)
        stored (stored-shape file-id page1 child)]
    (t/is (not (contains? stored :layout-item-h-sizing)))
    (t/is (not (contains? stored :opacity)))
    (t/is (false? (:hidden rect)))
    (t/is (false? (:blocked rect)))
    (t/is (= 1 (:opacity rect)))
    (t/is (not (contains? rect :layout-item-h-sizing)))
    (t/is (= {:id rect1 :type :rect :opacity 1}
             (read-shape profile file-id page1 rect1 :fields [:opacity])))
    (let [child (read-shape profile file-id page1 child)]
      (t/is (= :fix (:layout-item-h-sizing child)))
      (t/is (= :fix (:layout-item-v-sizing child))))
    (t/is (= :center (-> (read-shape profile file-id page1 stroke)
                         :strokes first :stroke-alignment)))))

(t/deftest shapes-flag-an-estimated-text-size
  (let [{:keys [profile file-id page1 text1]} (create-fixture)
        text (-> (apply-ops! profile file-id
                             [{:op "create_text" :page-id page1 :id "$tmp:t"
                               :x 0 :y 0 :characters "Hello"
                               :grow-type :auto-width}])
                 (get "$tmp:t"))
        read (read-shape profile file-id page1 text :fields [:name])]
    (t/is (true? (:text-size-approximate read)))
    (t/is (= "approximate" (:text-layout-state read)))
    (t/is (not (contains? (read-shape profile file-id page1 text1)
                          :text-size-approximate)))))

;; --- SEARCH

(t/deftest find-searches-one-or-all-pages
  (let [{:keys [profile file-id page1 page2 board1 rect1]} (create-fixture)
        everywhere (call! profile :find-mcp-shapes {:file-id file-id :type :rect})
        matches    (:matches (:result everywhere))
        one-page   (call! profile :find-mcp-shapes {:file-id file-id
                                                    :page-id page1
                                                    :name-regex "^Rect"})
        within     (call! profile :find-mcp-shapes {:file-id file-id
                                                    :page-id page1
                                                    :within-id board1
                                                    :type :rect})
        limited    (call! profile :find-mcp-shapes {:file-id file-id
                                                    :type :rect
                                                    :limit 1})]
    (t/is (nil? (:error everywhere)))
    (t/is (= 2 (count matches)))
    (t/is (= #{page1 page2} (set (map :page-id matches))))
    (t/is (every? #(= "Board / Rect A" (:path %)) matches))
    (t/is (= [rect1] (map :id (:matches (:result one-page)))))
    (t/is (= [rect1] (map :id (:matches (:result within)))))
    (t/is (= 1 (count (:matches (:result limited)))))
    (t/is (true? (:truncated (:result limited))))
    (t/is (false? (:truncated (:result everywhere))))))

(t/deftest find-name-is-exact-and-name-regex-is-a-regex
  (let [{:keys [profile file-id page1 rect1]} (create-fixture)
        exact   (call! profile :find-mcp-shapes {:file-id file-id
                                                 :page-id page1
                                                 :name "Rect A"})
        lower   (call! profile :find-mcp-shapes {:file-id file-id
                                                 :page-id page1
                                                 :name "rect a"})
        prefix  (call! profile :find-mcp-shapes {:file-id file-id
                                                 :page-id page1
                                                 :name "Rect"})
        partial (call! profile :find-mcp-shapes {:file-id file-id
                                                 :page-id page1
                                                 :name-regex "Rect"})]
    (t/is (= [rect1] (map :id (:matches (:result exact)))))
    (t/is (empty? (:matches (:result lower))))
    (t/is (empty? (:matches (:result prefix))))
    (t/is (= [rect1] (map :id (:matches (:result partial)))))))

(t/deftest find-matches-text-colors-and-rejects-bad-regex
  (let [{:keys [profile file-id page1 text1]} (create-fixture)
        text   (call! profile :find-mcp-shapes {:file-id file-id
                                                :page-id page1
                                                :text-contains "PENPOT"})
        red    (call! profile :find-mcp-shapes {:file-id file-id
                                                :page-id page1
                                                :colors ["#ff0000"]})
        broken (call! profile :find-mcp-shapes {:file-id file-id
                                                :page-id page1
                                                :name-regex "(["})]
    (t/is (= [text1] (map :id (:matches (:result text)))))
    (t/is (= 1 (count (:matches (:result red)))))
    (t/is (= :mcp-invalid-regex (th/ex-code (:error broken))))))

(t/deftest find-stops-a-backtracking-regex-at-the-deadline
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        name     (str (apply str (repeat 60 \a)) "!")
        _        (apply-changes! profile file-id
                                 [(add-obj page1 (uuid/next) board1 board1
                                           {:type :rect :name name})])
        out      (call! profile :find-mcp-shapes {:file-id file-id
                                                  :page-id page1
                                                  :name-regex "(a+)+\\1$"})
        too-long (call! profile :find-mcp-shapes {:file-id file-id
                                                  :page-id page1
                                                  :name-regex (apply str (repeat 201 \a))})]
    (t/is (nil? (:error out)))
    (t/is (true? (:truncated (:result out))))
    (t/is (some? (:error too-long)))))

;; --- AUDIT

(defn- wait-for
  "The first truthy value of `f`, polled for two seconds."
  [f]
  (loop [n 0]
    (or (f)
        (when (< n 100)
          (Thread/sleep 20)
          (recur (inc n))))))

(defn- tool-lines
  "The audit log lines of the MCP `tool` captured in `records`."
  [records tool]
  (->> @records
       (keep ::l/props)
       (filter #(and (= "mcp-tool" (:hint %))
                     (= tool (:tool %))))))

(t/deftest tool-calls-log-one-audit-line
  (let [{:keys [profile file-id]} (create-fixture)
        outsider (th/create-profile* 2 {:is-active true})
        records  (atom [])
        token-id (uuid/next)]
    (add-watch l/log-record ::capture
               (fn [_ _ _ record] (swap! records conj record)))
    (try
      (call! profile :get-mcp-file-outline {:file-id file-id} :token-id token-id)
      (call! outsider :get-mcp-file-outline {:file-id file-id})
      (let [ok    (first (wait-for #(seq (tool-lines records "get-mcp-file-outline"))))
            error (wait-for #(first (filter (fn [line] (= "error" (:outcome line)))
                                            (tool-lines records "get-mcp-file-outline"))))]
        (t/is (= "ok" (:outcome ok)))
        (t/is (= (:id profile) (:profile-id ok)))
        (t/is (= file-id (:file-id ok)))
        (t/is (= 8 (count (:token-fp ok))))
        (t/is (number? (:duration-ms ok)))
        (t/is (some? (:code error)))
        (t/is (nil? (:token-fp error))))
      (finally
        (remove-watch l/log-record ::capture)))))

;; --- LIBRARY AND TOKENS

(t/deftest library-lists-components-and-filters-kinds
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        component-id (uuid/next)
        _ (apply-changes! profile file-id
                          [{:type :add-component
                            :path ""
                            :name "Board"
                            :main-instance-id board1
                            :main-instance-page page1
                            :id component-id
                            :anotation nil}])
        out      (call! profile :get-mcp-library {:file-id file-id})
        library  (:result out)
        only     (:result (call! profile :get-mcp-library {:file-id file-id
                                                           :kinds ["colors"]}))]
    (t/is (nil? (:error out)))
    (t/is (= [component-id] (map :id (:components library))))
    (t/is (= "Board" (:name (first (:components library)))))
    (t/is (= board1 (:main-instance-id (first (:components library)))))
    (t/is (false? (:deleted (first (:components library)))))
    (t/is (= [] (:components only)))
    (t/is (= [] (:media library)))))

(t/deftest tokens-report-sets-themes-and-dtcg
  (let [{:keys [profile file-id]} (create-fixture)
        set-id   (uuid/next)
        theme-id (uuid/next)
        tokens   (-> (ctob/make-tokens-lib)
                     (ctob/add-set (ctob/make-token-set :id set-id :name "test-set"))
                     (ctob/add-theme (ctob/make-token-theme :id theme-id
                                                            :name "test-theme"
                                                            :sets #{"test-set"}))
                     (ctob/add-token set-id (ctob/make-token :name "token-radius"
                                                             :type :border-radius
                                                             :value 10)))
        status   (ctos/make-tokens-status :active-theme-ids #{theme-id}
                                          :active-set-ids #{set-id})]
    (th/update-file*
     {:file-id file-id
      :profile-id (:id profile)
      :revn (current-revn file-id)
      :changes (-> (pcb/empty-changes nil)
                   (pcb/with-library-data (:data (bfc/get-file th/*system* file-id)))
                   (pcb/set-tokens-lib tokens)
                   (pcb/set-tokens-status status)
                   (:redo-changes))})

    (let [out     (call! profile :get-mcp-tokens {:file-id file-id})
          result  (:result out)
          outline (:result (call! profile :get-mcp-file-outline {:file-id file-id}))]
      (t/is (nil? (:error out)))
      (t/is (= ["test-set"] (map :name (:sets result))))
      (t/is (true? (:active (first (:sets result)))))
      (t/is (= 1 (:token-count (first (:sets result)))))
      (t/is (= ["test-theme"] (map :name (:themes result))))
      (t/is (true? (:active (first (:themes result)))))
      (t/is (= ["token-radius"] (map :name (:tokens result))))
      (t/is (= 10 (:value (first (:tokens result)))))
      (t/is (nil? (:dtcg result)) "the flat list is the default, the DTCG form is not sent too")

      (let [dtcg (:result (call! profile :get-mcp-tokens {:file-id file-id :format "dtcg"}))]
        (t/is (some? (:dtcg dtcg)))
        (t/is (nil? (:tokens dtcg))))
      (t/is (= {:sets 1 :themes 1 :tokens 1}
               (select-keys (:tokens outline) [:sets :themes :tokens]))))))

;; --- PERMISSIONS

(t/deftest files-of-other-teams-are-not-found
  (let [{:keys [file-id]} (create-fixture)
        outsider (th/create-profile* 2 {:is-active true})]
    (doseq [[method params] [[:get-mcp-file-outline {:file-id file-id}]
                             [:get-mcp-page-tree {:file-id file-id :page-id uuid/zero}]
                             [:get-mcp-shapes {:file-id file-id :page-id uuid/zero
                                               :ids [uuid/zero]}]
                             [:get-mcp-tokens {:file-id file-id}]
                             [:create-mcp-render-session {:file-id file-id}]]]
      (let [out (call! outsider method params)]
        (t/is (some? (:error out)) (str method " must refuse a file of another team"))
        (t/is (= :not-found (th/ex-type (:error out))) (str method))))))

;; --- RENDER SESSION

(t/deftest render-session-mints-a-verifiable-cookie-token
  (let [{:keys [profile file-id]} (create-fixture)
        out     (call! profile :create-mcp-render-session {:file-id file-id})
        result  (:result out)
        token   (:token result)
        claims  (session/decode-token th/*system* token)
        now     (java.time.Instant/now)
        expires (:expires-at result)]
    (t/is (nil? (:error out)))
    (t/is (string? token))
    (t/is (= (str (:id profile)) (str (:uid claims))))
    (t/is (some? (:sid claims)))
    (t/is (.isAfter ^java.time.Instant expires now))
    (t/is (.isBefore ^java.time.Instant expires (.plusSeconds now 660)))

    ;; the exporter presents the token as the auth cookie
    (let [response ((#'http/router-handler (::http/router th/*system*))
                    (th/make-dummy-request
                     {:path "/api/main/methods/get-profile"
                      :method :post
                      :headers {"content-type" "application/json"
                                "accept" "application/json"
                                "x-client" "penpot-mcp"}
                      :cookies {(cf/get :auth-token-cookie-name "auth-token") token}
                      :body-bytes (json/encode {})}))]
      (t/is (= 200 (::yres/status response))))))

;; --- RENDER SESSION RESTRICTION

(defn- http-call
  "Sends `command` as the JSON body `params` over HTTP, authenticated with
  the render token `token` as the auth cookie, or as a bearer token."
  [command token params & {:keys [bearer?]}]
  ((#'http/router-handler (::http/router th/*system*))
   (th/make-dummy-request
    (cond-> {:path (str "/api/main/methods/" command)
             :method :post
             :headers {"content-type" "application/json"
                       "accept" "application/json"
                       "x-client" "penpot-mcp"}
             :body-bytes (json/encode params)}
      bearer?
      (assoc-in [:headers "authorization"] (str "Bearer " token))

      (not bearer?)
      (assoc :cookies {(cf/get :auth-token-cookie-name "auth-token") token})))))

(defn- reply-code
  "The `code` of an error reply, read from its JSON body."
  [reply]
  (let [out (java.io.ByteArrayOutputStream.)]
    (rcp/write-body-to-stream (::yres/body reply) nil out)
    (get (json/decode (str out)) "code")))

(defn- render-token
  "The token of a render session for `file-id`, minted as the exporter does.
  The session is bound to a live MCP access token row, as a real call is:
  a render session without one fails closed."
  [profile file-id]
  (let [token (db/tx-run! th/*system* access-token/create-access-token
                          (:id profile) "MCP" nil "mcp")]
    (:token (:result (call! profile :create-mcp-render-session {:file-id file-id}
                            :token-id (:id token))))))

(t/deftest render-session-reads-its-file
  (let [{:keys [profile file-id page1]} (create-fixture)
        token (render-token profile file-id)]
    (t/is (= 200 (::yres/status (http-call "get-profile" token {}))))
    (t/is (= 200 (::yres/status (http-call "get-page" token {:fileId (str file-id)
                                                             :pageId (str page1)}))))))

(t/deftest render-session-refuses-other-commands
  (let [{:keys [profile file-id]} (create-fixture)
        token (render-token profile file-id)]
    (doseq [[command params] [["update-file" {:id (str file-id)
                                              :sessionId (str (uuid/next))
                                              :revn 0
                                              :vern 0}]
                              ["create-access-token" {:name "token"}]
                              ["get-teams" {}]]]
      (let [reply (http-call command token params)]
        (t/is (= 403 (::yres/status reply)) command)
        (t/is (= "session-restricted" (reply-code reply)) command)))))

(t/deftest render-session-refuses-other-files
  (let [{:keys [profile file-id]} (create-fixture)
        other   (th/create-file* 2 {:profile-id (:id profile)
                                    :project-id (:default-project-id profile)})
        token   (render-token profile file-id)
        reply   (http-call "get-page" token {:fileId (str (:id other))
                                             :pageId (str (get-in other [:data :pages 0]))})]
    (t/is (= 403 (::yres/status reply)))
    (t/is (= "session-restricted" (reply-code reply)))))

(t/deftest render-session-as-bearer-token-is-restricted-alike
  (let [{:keys [profile file-id page1]} (create-fixture)
        token (render-token profile file-id)]
    (t/is (= 200 (::yres/status (http-call "get-profile" token {} :bearer? true))))
    (t/is (= 200 (::yres/status (http-call "get-page" token {:fileId (str file-id)
                                                             :pageId (str page1)}
                                           :bearer? true))))
    (t/is (= 403 (::yres/status (http-call "update-file" token
                                           {:id (str file-id)
                                            :sessionId (str (uuid/next))
                                            :revn 0
                                            :vern 0}
                                           :bearer? true))))))

(defn- upload-tempfile-call
  "Calls the management `upload-tempfile` method with an empty body, as the
  exporter does. `shared-key` is the value of the `x-shared-key` header and
  `token` the bearer token. A header is left out when its value is nil."
  [shared-key token]
  ((#'http/router-handler (::http/router th/*system*))
   (th/make-dummy-request
    {:path "/api/management/methods/upload-tempfile"
     :method :post
     :headers (cond-> {"content-type" "application/json"
                       "accept" "application/json"
                       "x-client" "penpot-mcp"}
                (some? shared-key)
                (assoc "x-shared-key" shared-key)

                (some? token)
                (assoc "authorization" (str "Bearer " token)))
     :body-bytes (json/encode {})})))

(t/deftest render-session-shared-key-test
  (let [{:keys [profile file-id]} (create-fixture)
        token  (render-token profile file-id)
        key    (get (::setup/shared-keys th/*system*) :exporter)
        keyed  (upload-tempfile-call (str "exporter " key) token)
        plain  (upload-tempfile-call nil token)]
    (t/is (string? key))
    ;; With the exporter's shared key the render restriction is not applied,
    ;; so the call reaches its params check and fails there.
    (t/is (not= 403 (::yres/status keyed)))
    (t/is (not= "session-restricted" (reply-code keyed)))
    ;; Without the key the management gate answers first with a bare 403.
    (t/is (= 403 (::yres/status plain)))))

(t/deftest render-token-past-its-expiry-does-not-authenticate
  (let [{:keys [profile file-id page1]} (create-fixture)
        manager (::session/manager th/*system*)
        session (session/create-session manager
                                        {:profile-id (:id profile)
                                         :user-agent "penpot-mcp-exporter"
                                         :props {:mcp-render {:file-ids #{file-id}}}})
        token   (tokens/generate th/*system*
                                 {:iss "authentication"
                                  :aud "penpot"
                                  :sid (:id session)
                                  :uid (:id profile)
                                  :exp (ct/minus (ct/now) (ct/duration {:minutes 1}))
                                  :mcp-render true}
                                 {:kid 1 :ver 1})
        profile-reply (http-call "get-profile" token {})
        page-reply    (http-call "get-page" token {:fileId (str file-id)
                                                   :pageId (str page1)})]
    ;; get-profile is anonymous without a session: it answers the empty profile
    (t/is (not= (:id profile) (:id (::yres/body profile-reply))))
    (t/is (= 401 (::yres/status page-reply)))))

(t/deftest render-session-older-than-its-max-age-does-not-authenticate
  (let [{:keys [profile file-id page1]} (create-fixture)
        token (render-token profile file-id)
        sid   (:sid (session/decode-token th/*system* token))]
    (db/update! th/*system* :http-session-v2
                {:created-at (ct/minus (ct/now) (ct/duration {:minutes 11}))}
                {:id sid})
    (t/is (= 401 (::yres/status (http-call "get-page" token {:fileId (str file-id)
                                                             :pageId (str page1)}))))))

;; --- WRITE-SIZED REPLIES, FIELDS AND FILTERS

(t/deftest page-cache-keeps-a-pointer-page-across-revisions
  (let [{:keys [profile file-id page1 page2 board2]} (create-fixture)
        decodes  (atom 0)
        original @#'mcp/load-page
        read!    #(call! profile :get-mcp-shapes {:file-id file-id
                                                  :page-id page1
                                                  :ids [uuid/zero]})]
    (with-redefs [mcp/load-page (fn [& args]
                                  (swap! decodes inc)
                                  (apply original args))]
      (read!)
      (t/is (= 1 @decodes))

      ;; a write to page two moves the revision, not the pointer of page one
      (apply-changes! profile file-id
                      [(add-obj page2 (uuid/next) board2 board2 {:type :rect :name "Late"})])
      (read!)
      (t/is (= 1 @decodes) "page one is served from the cache at the new revision")

      ;; page two has a new pointer, so it is decoded again
      (call! profile :get-mcp-shapes {:file-id file-id :page-id page2 :ids [uuid/zero]})
      (t/is (= 2 @decodes)))))

(t/deftest page-tree-cursor-survives-a-write-to-another-page
  (let [{:keys [profile file-id page1 page2 board2]} (create-fixture)
        first-page (call! profile :get-mcp-page-tree {:file-id file-id
                                                      :page-id page1
                                                      :depth 3
                                                      :limit 2})
        cursor     (get-in first-page [:result :next-cursor])]
    (t/is (string? cursor))
    (apply-changes! profile file-id
                    [(add-obj page2 (uuid/next) board2 board2 {:type :rect :name "Late"})])
    (let [out (call! profile :get-mcp-page-tree {:file-id file-id
                                                 :page-id page1
                                                 :depth 3
                                                 :limit 2
                                                 :cursor cursor})]
      (t/is (nil? (:error out)))
      (t/is (= page1 (:page-id (:result out)))))))

(t/deftest shapes-reply-stops-at-the-byte-budget
  (let [{:keys [profile file-id page1 board1 rect1 text1]} (create-fixture)
        out (with-redefs [mcp/response-byte-budget 1]
              (call! profile :get-mcp-shapes {:file-id file-id
                                              :page-id page1
                                              :ids [board1 rect1 text1]}))]
    (t/is (nil? (:error out)))
    (t/is (true? (:truncated (:result out))))
    (t/is (= [board1] (map :id (:shapes (:result out)))))))

(t/deftest page-tree-stops-at-the-byte-budget-and-walks-on
  (let [{:keys [profile file-id page1]} (create-fixture)]
    (with-redefs [mcp/response-byte-budget 1]
      (loop [cursor nil
             calls  0]
        (let [params (cond-> {:file-id file-id :page-id page1 :depth 3 :limit 500}
                       (some? cursor) (assoc :cursor cursor))
              out    (call! profile :get-mcp-page-tree params)
              result (:result out)]
          (t/is (nil? (:error out)))
          (when (zero? calls)
            (t/is (true? (:truncated result)))
            (t/is (string? (:next-cursor result))))
          (if (or (not (:truncated result)) (>= calls 20))
            (t/is (false? (:truncated result)) "the walk ends within 20 replies")
            (recur (:next-cursor result) (inc calls))))))))

(t/deftest tree-refuses-heavy-fields-and-shapes-return-them-by-name
  (let [{:keys [profile file-id page1 text1]} (create-fixture)
        refused (call! profile :get-mcp-page-tree {:file-id file-id
                                                   :page-id page1
                                                   :fields [:content]})
        plain   (read-shape profile file-id page1 text1)
        named   (read-shape profile file-id page1 text1 :fields [:content])]
    (t/is (some? (:error refused)))
    (t/is (not (contains? plain :content)))
    (t/is (not (contains? plain :position-data)))
    (t/is (= "Hello Penpot" (:characters plain)))
    (t/is (contains? named :content))))

(t/deftest shapes-refuse-attributes-outside-the-enum
  (let [{:keys [profile file-id page1 rect1]} (create-fixture)
        out (call! profile :get-mcp-shapes {:file-id file-id
                                            :page-id page1
                                            :ids [rect1]
                                            :fields [:not-an-attribute]})]
    (t/is (some? (:error out)))))

(t/deftest tokens-filter-by-set
  (let [{:keys [profile file-id]} (create-fixture)
        set-a  (uuid/next)
        set-b  (uuid/next)
        tokens (-> (ctob/make-tokens-lib)
                   (ctob/add-set (ctob/make-token-set :id set-a :name "set-a"))
                   (ctob/add-set (ctob/make-token-set :id set-b :name "set-b"))
                   (ctob/add-token set-a (ctob/make-token :name "radius-a"
                                                          :type :border-radius
                                                          :value 1))
                   (ctob/add-token set-b (ctob/make-token :name "radius-b"
                                                          :type :border-radius
                                                          :value 2)))]
    (th/update-file*
     {:file-id file-id
      :profile-id (:id profile)
      :revn (current-revn file-id)
      :changes (-> (pcb/empty-changes nil)
                   (pcb/with-library-data (:data (bfc/get-file th/*system* file-id)))
                   (pcb/set-tokens-lib tokens)
                   (pcb/set-tokens-status (ctos/make-tokens-status))
                   (:redo-changes))})
    (let [only-a (:result (call! profile :get-mcp-tokens {:file-id file-id :set-id set-a}))
          absent (call! profile :get-mcp-tokens {:file-id file-id :set-id (uuid/next)})]
      (t/is (= ["set-a"] (map :name (:sets only-a))))
      (t/is (= ["radius-a"] (map :name (:tokens only-a))))
      (t/is (= :token-set-not-found (th/ex-code (:error absent)))))))

(t/deftest library-reports-totals-and-truncation
  (let [{:keys [profile file-id page1 board1 page2 board2]} (create-fixture)]
    (apply-changes! profile file-id
                    [{:type :add-component :path "" :name "Board"
                      :main-instance-id board1 :main-instance-page page1
                      :id (uuid/next) :anotation nil}
                     {:type :add-component :path "" :name "Board 2"
                      :main-instance-id board2 :main-instance-page page2
                      :id (uuid/next) :anotation nil}])
    (let [cut  (:result (call! profile :get-mcp-library {:file-id file-id :limit 1}))
          full (:result (call! profile :get-mcp-library {:file-id file-id}))]
      (t/is (= 1 (count (:components cut))))
      (t/is (= 2 (get-in cut [:totals :components])))
      (t/is (true? (:truncated cut)))
      (t/is (false? (:truncated full))))))

(t/deftest find-refuses-a-type-outside-the-shape-types
  (let [{:keys [profile file-id page1]} (create-fixture)
        out (call! profile :find-mcp-shapes {:file-id file-id
                                             :page-id page1
                                             :type :rectangle})
        ok  (call! profile :find-mcp-shapes {:file-id file-id
                                             :page-id page1
                                             :type :rect})]
    (t/is (some? (:error out)))
    (t/is (nil? (:error ok)))
    (t/is (= ["Rect A"] (map :name (:matches (:result ok)))))))

(t/deftest find-maps-a-stack-overflow-to-an-invalid-pattern
  (let [{:keys [profile file-id page1]} (create-fixture)
        out (with-redefs [mcp/match-predicate
                          (fn [& _] (fn [_] (throw (StackOverflowError.))))]
              (call! profile :find-mcp-shapes {:file-id file-id :page-id page1}))]
    (t/is (= :mcp-invalid-pattern (th/ex-code (:error out))))))

(t/deftest whoami-reports-the-contract-and-the-write-limits
  (let [{:keys [profile]} (create-fixture)
        result (:result (call! profile :mcp-whoami {}))]
    (t/is (= 1 (:contract-version result)))
    (t/is (= operations/operation-names (:operations result)))
    (t/is (= 2000 (get-in result [:limits :max-operations])))
    (t/is (pos? (get-in result [:limits :max-payload-bytes])))
    (t/is (pos? (get-in result [:limits :max-compiled-changes])))))

(t/deftest whoami-reports-the-token-expiry-from-the-request
  (let [{:keys [profile]} (create-fixture)
        expires (ct/plus (ct/now) (ct/duration 3600000))
        result  (:result (call! profile :mcp-whoami {}
                                :token-id (uuid/next)
                                :expires-at expires))]
    (t/is (= expires (:expires-at result)))))

(t/deftest mcp-refuses-a-profile-that-switched-mcp-off
  (let [{:keys [profile file-id]} (create-fixture)
        set-props! (fn [props]
                     (db/tx-run! th/*system*
                                 (fn [cfg]
                                   (profile/update-profile-props cfg (:id profile) props))))]
    (set-props! {:mcp-enabled false})
    (let [whoami  (call! profile :mcp-whoami {})
          outline (call! profile :get-mcp-file-outline {:file-id file-id})]
      (t/is (= :mcp-disabled (th/ex-code (:error whoami))))
      (t/is (= :restriction (th/ex-type (:error whoami))))
      (t/is (= :mcp-disabled (th/ex-code (:error outline)))))
    (set-props! {:mcp-enabled true})
    (t/is (nil? (:error (call! profile :mcp-whoami {}))))))

(t/deftest render-session-stores-the-token-id
  (let [{:keys [profile file-id]} (create-fixture)
        token-id (uuid/next)
        out      (call! profile :create-mcp-render-session {:file-id file-id}
                        :token-id token-id)
        sid      (:sid (session/decode-token th/*system* (:token (:result out))))
        row      (th/db-get :http-session-v2 {:id sid})
        props    (db/decode-transit-pgobject (:props row))]
    (t/is (nil? (:error out)))
    (t/is (= token-id (:token-id props)))))

(t/deftest reads-share-the-decoded-root-of-a-pointer-file
  (let [{:keys [profile file-id page1]} (create-fixture)
        loads    (atom 0)
        original bfc/get-file
        read!    #(call! profile :get-mcp-page-tree {:file-id file-id :page-id page1})]
    (with-redefs [bfc/get-file (fn [& args]
                                 (swap! loads inc)
                                 (apply original args))]
      (read!)
      (read!)
      (t/is (= 1 @loads)))))

(t/deftest tool-calls-carry-the-request-id
  (let [{:keys [profile file-id]} (create-fixture)
        request-id (uuid/next)
        out        (call! profile :get-mcp-file-outline {:file-id file-id
                                                         ::rpc/request-id request-id})
        props      (:app.loggers.audit/replace-props (meta (:result out)))]
    (t/is (= request-id (:request-id props)))))

;; --- REVIEW FIXES: CACHED ROOT, FIELDS FROM THE SCHEMA

(t/deftest pages-of-the-cached-root-stay-unloaded
  (let [{:keys [profile file-id page1]} (create-fixture)
        _    (call! profile :get-mcp-page-tree {:file-id file-id :page-id page1})
        row  (th/db-get :file {:id file-id})
        root (cache/get @#'mcp/root-cache [file-id (:revn row) (:vern row)])
        pages (vals (get-in root [:data :pages-index]))]
    (t/is (some? root) "the root of the file is cached after a read")
    (t/is (seq pages))
    (t/is (every? #(not (pmap/loaded? %)) pages)
          "a page read must not load the pointers held by the cached root")
    ;; a second read still works from the unloaded root
    (let [out (call! profile :get-mcp-page-tree {:file-id file-id :page-id page1})]
      (t/is (nil? (:error out)))
      (t/is (= page1 (:page-id (:result out)))))))

(t/deftest fields-enum-follows-the-shape-schema
  (let [{:keys [profile file-id page1 rect1]} (create-fixture)
        shapes (call! profile :get-mcp-shapes {:file-id file-id
                                               :page-id page1
                                               :ids [rect1]
                                               :fields [:svg-attrs :svg-viewbox :variant-name]})
        tree   (call! profile :get-mcp-page-tree {:file-id file-id
                                                  :page-id page1
                                                  :fields [:svg-viewbox :variant-id]})]
    (t/is (nil? (:error shapes)) "svg and variant attributes are listed")
    (t/is (nil? (:error tree)) "the tree accepts the same attributes, minus the heavy ones")))

;; --- REVIEW FIXES ROUND 2: FRESH PAGES AND STALE ROOTS

(t/deftest pages-created-by-apply-operations-are-read
  (let [{:keys [profile file-id page1]} (create-fixture)
        _    (call! profile :get-mcp-page-tree {:file-id file-id :page-id page1})
        out  (call! profile :mcp-apply-operations
                    {:file-id file-id
                     :operations [{:op "create_page" :id "$tmp:new" :name "Fresh"}]}
                    :perms #{"mcp:write"})
        new-page (get-in out [:result :created-ids "$tmp:new"])
        shapes   (call! profile :get-mcp-shapes {:file-id file-id
                                                 :page-id new-page
                                                 :ids [uuid/zero]})
        tree     (call! profile :get-mcp-page-tree {:file-id file-id :page-id new-page})]
    (t/is (nil? (:error out)))
    (t/is (uuid? new-page))
    (t/is (nil? (:error shapes)) "the page made by a write is found at once")
    (t/is (nil? (:error tree)))
    (t/is (= new-page (:page-id (:result tree))))))

(t/deftest a-stale-cached-root-without-the-page-is-reloaded
  (let [{:keys [profile file-id page1]} (create-fixture)
        _    (call! profile :get-mcp-page-tree {:file-id file-id :page-id page1})
        row  (th/db-get :file {:id file-id})
        key  [file-id (:revn row) (:vern row)]
        root (cache/get @#'mcp/root-cache key)]
    (t/is (some? root))
    ;; a root of another file answers for this key: it has no pages
    (cache/put @#'mcp/root-cache key (assoc-in root [:data :pages-index] {}))
    (let [out (call! profile :get-mcp-page-tree {:file-id file-id :page-id page1})]
      (t/is (nil? (:error out)))
      (t/is (= page1 (:page-id (:result out)))))))

;; --- NAMED FIELDS ARE ALWAYS PRESENT

(t/deftest tree-returns-every-named-field-on-every-node
  (let [{:keys [profile file-id page1]} (create-fixture)
        out   (call! profile :get-mcp-page-tree {:file-id file-id
                                                 :page-id page1
                                                 :depth 3
                                                 :fields [:hidden :blocked :opacity
                                                          :component-id]})
        nodes (tree-seq (comp seq :children) :children (:root (:result out)))]
    (t/is (nil? (:error out)))
    (t/is (= 4 (count nodes)))
    (doseq [node nodes]
      (t/is (contains? node :hidden) (str "hidden on " (:id node)))
      (t/is (contains? node :blocked) (str "blocked on " (:id node)))
      (t/is (contains? node :opacity) (str "opacity on " (:id node)))
      (t/is (contains? node :component-id) (str "component-id on " (:id node)))
      (t/is (false? (:hidden node)))
      (t/is (false? (:blocked node)))
      (t/is (= 1 (:opacity node))))))

(t/deftest tree-omits-the-attributes-nobody-named
  (let [{:keys [profile file-id page1]} (create-fixture)
        out   (call! profile :get-mcp-page-tree {:file-id file-id
                                                 :page-id page1
                                                 :depth 3})
        nodes (tree-seq (comp seq :children) :children (:root (:result out)))]
    (t/is (seq nodes))
    (doseq [node nodes]
      (t/is (not (contains? node :opacity)) "the default tree does not name opacity")
      (t/is (not (contains? node :fills))))))

(t/deftest shapes-return-every-named-field
  (let [{:keys [profile file-id page1 rect1]} (create-fixture)
        shape (read-shape profile file-id page1 rect1
                          :fields [:hidden :blocked :opacity :component-id])]
    (t/is (false? (:hidden shape)))
    (t/is (false? (:blocked shape)))
    (t/is (= 1 (:opacity shape)))
    (t/is (contains? shape :component-id) "an absent attribute named by the caller is nil")
    (t/is (nil? (:component-id shape)))))
