;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-mcp-write-test
  (:require
   [app.common.json :as json]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.db :as db]
   [app.http :as http]
   [app.http.access-token :as-alias actoken]
   [app.loggers.audit :as-alias audit]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.access-token :as access-token]
   [app.rpc.commands.mcp-write :as mcp-write]
   [app.storage :as sto]
   [backend-tests.helpers :as th]
   [backend-tests.storage-test :as stt]
   [clojure.string :as str]
   [clojure.test :as t]
   [yetti.response :as-alias yres]))

(t/use-fixtures :once (t/compose-fixtures
                       (partial th/init-config [:enable-access-tokens
                                                :enable-client-header-check-middleware
                                                :enable-mcp-raw-changes])
                       th/init-system))
(t/use-fixtures :each
  th/database-reset
  ;; Calls split into batches of 300 changes here, so 701
  ;; creations make three commits. The 2000 bound is tested in
  ;; the unit tests that set it.
  (fn [f] (with-redefs-fn {#'mcp-write/notify-changes 300} f)))

;; --- HELPERS

(defn- call!
  "Runs an MCP command as `profile` with an MCP token of `perms` (write
  scope by default)."
  [profile method params & {:keys [perms token-id]}]
  (let [data (merge {::th/type method
                     ::rpc/profile-id (:id profile)
                     ::rpc/auth-type :token
                     ::rpc/token-type "mcp"
                     ::rpc/token-perms (or perms #{"mcp:write"})}
                    params)]
    (th/command!
     (cond-> data
       (some? token-id)
       (vary-meta assoc :app.http/request {:headers {}
                                           ::actoken/id token-id})))))

(defn- error-code
  [out]
  (:code (ex-data (:error out))))

(defn- revn
  [file-id]
  (:revn (th/db-get :file {:id file-id})))

(defn- file-changes
  "The file change rows of `file-id`, oldest first."
  [file-id]
  (th/db-exec! ["SELECT session_id, label, created_by
                   FROM file_change
                  WHERE file_id = ?
                  ORDER BY created_at ASC, id ASC" file-id]))

(defn- create-media
  "A file media object backed by a stored object, as uploads create them."
  [file-id]
  (let [storage (-> (:app.storage/storage th/*system*)
                    (stt/configure-storage-backend))
        sobject (sto/put-object! storage
                                 {::sto/content (sto/content "<svg xmlns=\"http://www.w3.org/2000/svg\"/>")
                                  :content-type "image/svg+xml"
                                  :bucket "file-media-object"})]
    (th/create-file-media-object* {:file-id file-id
                                   :media-id (:id sobject)
                                   :name "media"
                                   :width 10 :height 10
                                   :mtype "image/svg+xml"})))

(defn- change-rows
  [file-id]
  (count (file-changes file-id)))

(defn- snapshot-labels
  [file-id]
  (into []
        (comp (map :label)
              (filter #(and (string? %) (str/starts-with? % "mcp/"))))
        (file-changes file-id)))

(defn- add-frame
  [page-id id]
  {:type :add-obj
   :page-id page-id
   :id id
   :parent-id uuid/zero
   :frame-id uuid/zero
   :obj (cts/setup-shape {:id id
                          :type :frame
                          :name "Board"
                          :parent-id uuid/zero
                          :frame-id uuid/zero
                          :x 0 :y 0 :width 500 :height 500})})

(defn- add-rect
  [page-id id parent-id & {:as attrs}]
  {:type :add-obj
   :page-id page-id
   :id id
   :parent-id parent-id
   :frame-id parent-id
   :obj (cts/setup-shape (merge {:id id
                                 :type :rect
                                 :name "Rect"
                                 :parent-id parent-id
                                 :frame-id parent-id
                                 :x 10 :y 10 :width 20 :height 20}
                                attrs))})

(defn- rename-shape
  [page-id id name]
  {:type :mod-obj
   :page-id page-id
   :id id
   :operations [{:type :set :attr :name :val name}]})

(defn- create-fixture
  "A profile that owns an empty file with one page."
  []
  (let [profile (th/create-profile* 1 {:is-active true})
        file    (th/create-file* 1 {:profile-id (:id profile)
                                    :project-id (:default-project-id profile)})]
    {:profile (th/db-get :profile {:id (:id profile)})
     :file-id (:id file)
     :page-id (get-in file [:data :pages 0])}))

(defn- create-board!
  "Commits a board through the MCP command and returns its id."
  [profile file-id page-id]
  (let [board (uuid/next)
        out   (call! profile :mcp-apply-changes
                     {:file-id file-id
                      :changes [(add-frame page-id board)]})]
    (t/is (nil? (:error out)))
    board))

(defn- op-board
  [page-id]
  {:op "create_board"
   :page-id page-id
   :id "$tmp:board"
   :name "Board"
   :x 0 :y 0 :width 2000 :height 2000})

(defn- op-rect
  [page-id handle i]
  {:op "create_rect"
   :page-id page-id
   :id handle
   :parent-id "$tmp:board"
   :name (str "Rect " i)
   :x (* 10 (mod i 100)) :y (* 10 (quot i 100))
   :width 5 :height 5})

(def ^:private svg-text
  "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"100\" viewBox=\"0 0 100 100\"><rect x=\"10\" y=\"10\" width=\"20\" height=\"20\" fill=\"red\"/><circle cx=\"60\" cy=\"60\" r=\"10\" fill=\"blue\"/></svg>")

(defn- create-token-for
  [profile]
  (db/tx-run! th/*system* access-token/create-access-token
              (:id profile) "MCP" nil "mcp"))

(defn- http-request
  "Posts `body` to the MCP method `method` with the bearer `token`."
  [token method body]
  ((#'http/router-handler (::http/router th/*system*))
   (th/make-dummy-request
    {:path (str "/api/main/methods/" method)
     :method :post
     :headers {"content-type" "application/json"
               "accept" "application/json"
               "x-client" "penpot-mcp"
               "authorization" (str "Token " token)}
     :body-bytes (json/encode body)})))

;; --- APPLY CHANGES

(t/deftest apply-changes-commits-one-revision
  (let [{:keys [profile file-id page-id]} (create-fixture)
        before  (revn file-id)
        board   (uuid/next)
        rect    (uuid/next)
        request (uuid/next)
        out     (call! profile :mcp-apply-changes
                       {:file-id file-id
                        :request-id request
                        :changes [(add-frame page-id board)
                                  (add-rect page-id rect board)]})]
    (t/is (nil? (:error out)))
    (t/is (= (inc before) (:revn (:result out))))
    (t/is (= (inc before) (revn file-id)))
    (t/is (= 1 (:commits (:result out))))
    (t/is (= {"add-obj" 2} (:change-types (:result out))))
    (t/is (= 2 (:change-count (:result out))))
    (t/is (false? (:dry-run (:result out))))
    (t/is (nil? (:snapshot-id (:result out))))
    ;; The call's own rows are not echoed back, only counted when they come
    ;; from other sessions.
    (t/is (not (contains? (:result out) :lagged)))
    (t/is (= {:ok true :checks ["affected" "schema"]}
             (:validation (:result out))))
    ;; A fresh file: the one change row of this call is the only one
    ;; without a label.
    (t/is (= 1 (count (filter (comp nil? :label) (file-changes file-id)))))))

(t/deftest apply-changes-dry-run-leaves-revn
  (let [{:keys [profile file-id page-id]} (create-fixture)
        before  (revn file-id)
        rows0   (change-rows file-id)
        board   (uuid/next)
        out     (call! profile :mcp-apply-changes
                       {:file-id file-id
                        :dry-run true
                        :changes [(add-frame page-id board)]})]
    (t/is (nil? (:error out)))
    (t/is (true? (:dry-run (:result out))))
    (t/is (= before (:revn (:result out))))
    (t/is (= before (revn file-id)))
    (t/is (= {:ok true :checks ["affected" "schema"]}
             (:validation (:result out))))
    (t/is (= rows0 (change-rows file-id)))))

(t/deftest apply-changes-refuses-change-types
  (let [{:keys [profile file-id]} (create-fixture)
        rows0 (change-rows file-id)
        out   (call! profile :mcp-apply-changes
                     {:file-id file-id
                      :changes [{:type :purge-component :id (uuid/next)}]})]
    (t/is (= :mcp-change-type-refused (error-code out)))
    (t/is (= rows0 (change-rows file-id)))))

(t/deftest apply-changes-checks-media-ownership
  (let [{:keys [profile file-id page-id]} (create-fixture)
        other      (th/create-file* 2 {:profile-id (:id profile)
                                       :project-id (:default-project-id profile)})
        foreign    (create-media (:id other))
        own        (create-media file-id)
        image-fill (fn [media]
                     [{:fill-opacity 1
                       :fill-image {:id (:id media)
                                    :width 10
                                    :height 10
                                    :mtype "image/png"
                                    :name "img"}}])
        board      (create-board! profile file-id page-id)
        bad        (call! profile :mcp-apply-changes
                          {:file-id file-id
                           :changes [(add-rect page-id (uuid/next) board
                                               :fills (image-fill foreign))]})
        good       (call! profile :mcp-apply-changes
                          {:file-id file-id
                           :changes [(add-rect page-id (uuid/next) board
                                               :fills (image-fill own))]})]
    (t/is (= :mcp-foreign-media (error-code bad)))
    (t/is (nil? (:error good)))))

(t/deftest media-ids-finds-media-at-any-depth
  (let [[fill stroke image meta-id media] (repeatedly 5 uuid/next)
        text    {:type :root
                 :children [{:type :paragraph-set
                             :children [{:type :paragraph
                                         :children [{:text "a"
                                                     :fills [{:fill-image {:id fill}}]}]}]}]}
        changes [{:type :add-obj
                  :id (uuid/next)
                  :obj {:type :text
                        :content text
                        :strokes (list {:stroke-image {:id stroke}})}}
                 {:type :add-obj
                  :id (uuid/next)
                  :obj {:type :image :metadata {:id image}}}
                 {:type :mod-obj
                  :id (uuid/next)
                  :operations [{:type :set :attr :metadata :val {:id meta-id}}]}
                 {:type :add-media :object {:id media :name "m"}}
                 {:type :mod-obj
                  :id (uuid/next)
                  :operations [{:type :set :attr :name :val "no media"}]}]]
    (t/is (= #{fill stroke image meta-id media}
             (#'mcp-write/media-ids changes)))
    (t/is (= #{} (#'mcp-write/media-ids [])))))

(t/deftest apply-changes-caps-the-change-count
  (let [{:keys [profile file-id page-id]} (create-fixture)
        board  (uuid/next)
        change (add-rect page-id (uuid/next) board)
        out    (call! profile :mcp-apply-changes
                      {:file-id file-id
                       :changes (vec (repeat 2001 change))})]
    (t/is (= :mcp-batch-too-large (error-code out)))
    (t/is (empty? (file-changes file-id)))))

(t/deftest delete-takes-one-snapshot
  (let [{:keys [profile file-id page-id]} (create-fixture)
        board   (uuid/next)
        rect    (uuid/next)
        created (call! profile :mcp-apply-changes
                       {:file-id file-id
                        :changes [(add-frame page-id board)
                                  (add-rect page-id rect board)]})
        _       (t/is (nil? (:snapshot-id (:result created))))
        _       (t/is (empty? (snapshot-labels file-id)))
        out     (call! profile :mcp-apply-changes
                       {:file-id file-id
                        :changes [{:type :del-obj :page-id page-id :id rect}]})]
    (t/is (nil? (:error out)))
    (t/is (some? (:snapshot-id (:result out))))
    (t/is (= 1 (count (snapshot-labels file-id))))
    (t/is (str/starts-with? (clojure.core/first (snapshot-labels file-id))
                            "mcp/mcp-apply-changes/"))))

(t/deftest base-revn-reports-lag-and-fails-on-overlap
  (let [{:keys [profile file-id page-id]} (create-fixture)
        board    (create-board! profile file-id page-id)
        rect     (uuid/next)
        _        (call! profile :mcp-apply-changes
                        {:file-id file-id
                         :changes [(add-rect page-id rect board)]})
        base     (revn file-id)
        ;; A concurrent commit (another client) touches the same shape.
        _        (th/update-file* {:file-id file-id
                                   :profile-id (:id profile)
                                   :revn base
                                   :changes [(rename-shape page-id rect "Other")]})
        lagged   (call! profile :mcp-apply-changes
                        {:file-id file-id
                         :base-revn base
                         :changes [(rename-shape page-id rect "Mine")]})
        warning  (first (filter #(= "revn-lag" (:kind %))
                                (:warnings (:result lagged))))
        before   (revn file-id)
        conflict (call! profile :mcp-apply-changes
                        {:file-id file-id
                         :base-revn base
                         :fail-on-conflict true
                         :changes [(rename-shape page-id rect "Mine")]})]
    (t/is (nil? (:error lagged)))
    (t/is (= base (:base-revn warning)))
    (t/is (= (inc base) (:stored-revn warning)))
    (t/is (contains? (set (:changed-shape-ids warning)) rect))
    (t/is (= :mcp-revn-conflict (error-code conflict)))
    (t/is (= before (revn file-id)))))

;; --- APPLY OPERATIONS

(t/deftest apply-operations-resolves-tmp-handles
  (let [{:keys [profile file-id page-id]} (create-fixture)
        out (call! profile :mcp-apply-operations
                   {:file-id file-id
                    :operations [(op-board page-id)
                                 (op-rect page-id "$tmp:a" 1)
                                 (op-rect page-id "$tmp:b" 2)]})
        result (:result out)]
    (t/is (nil? (:error out)))
    (t/is (= #{"$tmp:board" "$tmp:a" "$tmp:b"}
             (set (keys (:created-ids result)))))
    (t/is (every? uuid? (vals (:created-ids result))))
    ;; Three object creations and no reflow changes: the tree has no layout.
    (t/is (= {"add-obj" 3} (:change-types result)))
    (t/is (= 1 (:commits result)))
    (t/is (= (revn file-id) (:revn result)))))

(t/deftest operation-count-drives-the-snapshot
  (let [{:keys [profile file-id page-id]} (create-fixture)
        ops-of (fn [n]
                 (into [(op-board page-id)]
                       (map #(op-rect page-id (str "$tmp:r" %) %))
                       (range (dec n))))
        run    (fn [operations & {:as opts}]
                 (call! profile :mcp-apply-operations
                        (merge {:file-id file-id :operations operations} opts)))
        hundred (run (ops-of 100))
        _       (t/is (nil? (:error hundred)))
        _       (t/is (empty? (snapshot-labels file-id)))
        hundred-one (run (ops-of 101))
        _       (t/is (nil? (:error hundred-one)))
        _       (t/is (= 1 (count (snapshot-labels file-id))))
        forced  (run [(op-board page-id)] :snapshot true)]
    (t/is (nil? (:error forced)))
    (t/is (some? (:snapshot-id (:result forced))))
    (t/is (= 2 (count (snapshot-labels file-id))))))

(t/deftest allow-split-commits-in-batches
  (let [{:keys [profile file-id page-id]} (create-fixture)
        before (revn file-id)
        ops    (into [(op-board page-id)]
                     (map #(op-rect page-id (str "$tmp:r" %) %))
                     (range 700))
        out    (call! profile :mcp-apply-operations
                      {:file-id file-id
                       :allow-split true
                       :operations ops})
        result (:result out)]
    (t/is (nil? (:error out)))
    (t/is (= 3 (:commits result)))
    (t/is (= (+ before 3) (:revn result)))
    (t/is (= (+ before 3) (revn file-id)))
    (t/is (= 701 (get (:change-types result) "add-obj")))
    (t/is (some? (:snapshot-id result)))
    (t/is (= 1 (count (snapshot-labels file-id))))))

(t/deftest invalid-operation-reports-its-index
  (let [{:keys [profile file-id page-id]} (create-fixture)
        out (call! profile :mcp-apply-operations
                   {:file-id file-id
                    :operations [(op-board page-id)
                                 {:op "create_rect" :page-id page-id}]})]
    (t/is (= :mcp-invalid-operation (error-code out)))
    (t/is (= 1 (:index (ex-data (:error out)))))))

;; --- UPDATE SHAPE ON COMMITTED SHAPES

(defn- commit-board-with-rect!
  "Commits a board with one child rect in one operations call and returns
  the ids of both."
  [profile file-id page-id]
  (let [out (call! profile :mcp-apply-operations
                   {:file-id file-id
                    :operations [(op-board page-id)
                                 (op-rect page-id "$tmp:rect" 1)]})]
    (t/is (nil? (:error out)))
    {:board (get-in out [:result :created-ids "$tmp:board"])
     :rect  (get-in out [:result :created-ids "$tmp:rect"])}))

(defn- stored-shapes
  "The shapes `ids` as the file stores them now, keyed by id."
  [profile file-id page-id ids]
  (let [out (call! profile :get-mcp-shapes
                   {:file-id file-id
                    :page-id page-id
                    :ids ids}
                   :perms #{"mcp:read"})]
    (t/is (nil? (:error out)))
    (into {} (map (juxt :id identity)) (:shapes (:result out)))))

(defn- update-shape-op
  [page-id id props]
  {:op "update_shape" :page-id page-id :id id :props props})

(t/deftest update-shape-moves-committed-board-and-children
  (let [{:keys [profile file-id page-id]} (create-fixture)
        {:keys [board rect]} (commit-board-with-rect! profile file-id page-id)
        before (stored-shapes profile file-id page-id [board rect])
        out    (call! profile :mcp-apply-operations
                      {:file-id file-id
                       :operations [(update-shape-op page-id board {:x 100 :y 50})]})
        after  (stored-shapes profile file-id page-id [board rect])
        dx     (- (get-in after [board :x]) (get-in before [board :x]))
        dy     (- (get-in after [board :y]) (get-in before [board :y]))]
    (t/is (nil? (:error out)))
    (t/is (>= (get (:change-types (:result out)) "mod-obj" 0) 2))
    (t/is (== 100 (get-in after [board :x])))
    (t/is (== 50 (get-in after [board :y])))
    (t/is (== 100 dx))
    (t/is (== 50 dy))
    (t/is (== (+ (get-in before [rect :x]) dx) (get-in after [rect :x])))
    (t/is (== (+ (get-in before [rect :y]) dy) (get-in after [rect :y])))))

(t/deftest update-shape-resizes-committed-board
  (let [{:keys [profile file-id page-id]} (create-fixture)
        board (:board (commit-board-with-rect! profile file-id page-id))
        out   (call! profile :mcp-apply-operations
                     {:file-id file-id
                      :operations [(update-shape-op page-id board {:width 500})]})
        after (stored-shapes profile file-id page-id [board])]
    (t/is (nil? (:error out)))
    (t/is (>= (get (:change-types (:result out)) "mod-obj" 0) 1))
    (t/is (== 500 (get-in after [board :width])))))

(t/deftest solid-inner-stroke-and-shadow-are-stored
  (let [{:keys [profile file-id page-id]} (create-fixture)
        stroke {:stroke-style "solid"
                :stroke-alignment "inner"
                :stroke-width 2
                :stroke-color "#000000"
                :stroke-opacity 1}
        shadow {:id (str (uuid/next))
                :style "drop-shadow"
                :offset-x 2
                :offset-y 4
                :blur 4
                :spread 0
                :hidden false
                :color {:color "#000000" :opacity 0.5}}
        created (call! profile :mcp-apply-operations
                       {:file-id file-id
                        :operations [(op-board page-id)
                                     (assoc (op-rect page-id "$tmp:rect" 1)
                                            :props {:strokes [stroke]
                                                    :shadow [shadow]})]})
        rect    (get-in created [:result :created-ids "$tmp:rect"])
        made    (get (stored-shapes profile file-id page-id [rect]) rect)
        _       (t/is (nil? (:error created)))
        _       (t/is (= :solid (:stroke-style (first (:strokes made)))))
        _       (t/is (= :inner (:stroke-alignment (first (:strokes made)))))
        _       (t/is (= :drop-shadow (:style (first (:shadow made)))))
        _       (t/is (== 4 (:offset-y (first (:shadow made)))))
        updated (call! profile :mcp-apply-operations
                       {:file-id file-id
                        :operations [(update-shape-op page-id rect
                                                      {:strokes [stroke]
                                                       :shadow [(assoc shadow :offset-y 8)]})]})
        stored  (get (stored-shapes profile file-id page-id [rect]) rect)]
    (t/is (nil? (:error updated)))
    (t/is (= :solid (:stroke-style (first (:strokes stored)))))
    (t/is (== 8 (:offset-y (first (:shadow stored)))))))

;; --- PERMISSIONS AND SCOPES

(t/deftest viewer-cannot-write-but-can-dry-run
  (let [{:keys [profile file-id page-id]} (create-fixture)
        viewer (th/create-profile* 2 {:is-active true})
        team   (:team-id (th/db-get :project {:id (:default-project-id profile)}))
        _      (th/create-team-role* {:team-id team
                                      :profile-id (:id viewer)
                                      :role :viewer})
        before (revn file-id)
        out    (call! viewer :mcp-apply-changes
                      {:file-id file-id
                       :changes [(add-frame page-id (uuid/next))]})
        dry    (call! viewer :mcp-apply-changes
                      {:file-id file-id
                       :dry-run true
                       :changes [(add-frame page-id (uuid/next))]})]
    (t/is (some? (:error out)))
    (t/is (= before (revn file-id)))
    (t/is (empty? (file-changes file-id)))
    (t/is (nil? (:error dry)))
    (t/is (= before (revn file-id)))))

(t/deftest read-only-token-is-limited-over-http
  (let [{:keys [profile file-id]} (create-fixture)
        token (:token (create-token-for profile))
        write (http-request token "mcp-apply-changes"
                            {"fileId" (str file-id) "changes" []})
        dry   (http-request token "mcp-apply-changes"
                            {"fileId" (str file-id) "changes" [] "dryRun" true})]
    (t/is (= 403 (::yres/status write)))
    (t/is (= 200 (::yres/status dry)))))

;; --- SVG IMPORT

(t/deftest import-svg-adds-shapes
  (let [{:keys [profile file-id page-id]} (create-fixture)
        out    (call! profile :mcp-import-svg
                      {:file-id file-id
                       :page-id page-id
                       :svg svg-text
                       :x 100 :y 50
                       :name "Icon"})
        result (:result out)
        shapes (call! profile :get-mcp-shapes
                      {:file-id file-id
                       :page-id page-id
                       :ids (:shape-ids result)}
                      :perms #{"mcp:read"})
        types  (set (map :type (:shapes (:result shapes))))]
    (t/is (nil? (:error out)))
    (t/is (uuid? (:root-id result)))
    (t/is (contains? (set (:shape-ids result)) (:root-id result)))
    (t/is (pos? (:change-count result)))
    (t/is (nil? (:error shapes)))
    (t/is (contains? types :rect))
    (t/is (contains? types :circle))
    (t/is (contains? types :frame))))

;; --- AUDIT

(t/deftest audit-props-carry-the-histogram
  (let [{:keys [profile file-id page-id]} (create-fixture)
        board (uuid/next)
        data  {::th/type :mcp-apply-changes
               ::rpc/profile-id (:id profile)
               ::rpc/auth-type :token
               ::rpc/token-type "mcp"
               ::rpc/token-perms #{"mcp:write"}
               :file-id file-id
               :changes [(add-frame page-id board)
                         (add-rect page-id (uuid/next) board)]}
        result (th/command-raw! data)
        props  (::audit/replace-props (meta result))]
    (t/is (= "mcp-apply-changes" (:tool props)))
    (t/is (= file-id (:file-id props)))
    (t/is (= 2 (:change-count props)))
    (t/is (= {"add-obj" 2} (:change-types props)))
    (t/is (= (revn file-id) (:revn-after props)))))

(t/deftest audit-props-count-a-rename-and-one-revision
  (let [{:keys [profile file-id page-id]} (create-fixture)
        board  (create-board! profile file-id page-id)
        rect   (uuid/next)
        _      (call! profile :mcp-apply-changes
                      {:file-id file-id
                       :changes [(add-rect page-id rect board)]})
        before (revn file-id)
        data   {::th/type :mcp-apply-changes
                ::rpc/profile-id (:id profile)
                ::rpc/auth-type :token
                ::rpc/token-type "mcp"
                ::rpc/token-perms #{"mcp:write"}
                :file-id file-id
                :changes [(rename-shape page-id rect "Renamed")]}
        result (th/command-raw! data)
        props  (::audit/replace-props (meta result))]
    (t/is (= 1 (:change-count props)))
    (t/is (= {"mod-obj" 1} (:change-types props)))
    (t/is (= before (:revn-before props)))
    (t/is (= (inc before) (:revn-after props)))))

(t/deftest audit-props-carry-the-snapshot-id
  (let [{:keys [profile file-id page-id]} (create-fixture)
        data   {::th/type :mcp-apply-changes
                ::rpc/profile-id (:id profile)
                ::rpc/auth-type :token
                ::rpc/token-type "mcp"
                ::rpc/token-perms #{"mcp:write"}
                :file-id file-id
                :snapshot true
                :changes [(add-frame page-id (uuid/next))]}
        result (th/command-raw! data)
        props  (::audit/replace-props (meta result))]
    (t/is (some? (:snapshot-id result)))
    (t/is (= (:snapshot-id result) (:snapshot-id props)))))
