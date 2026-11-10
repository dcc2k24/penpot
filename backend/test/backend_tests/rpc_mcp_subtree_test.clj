;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-mcp-subtree-test
  (:require
   [app.binfile.common :as bfc]
   [app.common.geom.matrix :as gmt]
   [app.common.json :as json]
   [app.common.math :as mth]
   [app.common.types.path :as path]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.http.access-token :as-alias actoken]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.mcp :as mcp]
   [app.rpc.commands.mcp-subtree :as subtree]
   [app.util.cache :as cache]
   [backend-tests.helpers :as th]
   [clojure.data.json :as jd]
   [clojure.test :as t]))

(t/use-fixtures :once (t/compose-fixtures
                       (partial th/init-config [:enable-access-tokens
                                                :enable-client-header-check-middleware])
                       th/init-system))

(defn- clear-mcp-caches
  "Empties the MCP caches between tests. Test files reuse the same file
  ids (`mk-uuid \"file\" i`), so a root cached by one test would answer
  for another test's file with the same revision."
  [f]
  (doseq [c [@#'mcp/root-cache @#'mcp/page-cache @#'mcp/outline-cache @#'subtree/walk-cache]]
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

(def ^:private path-content
  [{:command :move-to :params {:x 0 :y 0}}
   {:command :line-to :params {:x 40 :y 0}}
   {:command :line-to :params {:x 40 :y 30}}
   {:command :close-path :params {}}])

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

(defn- apply-ops!
  "Runs `operations` through `mcp-apply-operations` and returns the ids it
  created, by handle."
  [profile file-id operations]
  (let [out (call! profile :mcp-apply-operations
                   {:file-id file-id :operations operations}
                   :perms #{"mcp:write"})]
    (t/is (nil? (:error out)))
    (:created-ids (:result out))))

(defn- subtree
  "The reply of `get-mcp-subtree` for the walk of `root-id` on `page-id`,
  with the params `extra` merged in."
  [profile file-id page-id root-id & {:as extra}]
  (call! profile :get-mcp-subtree (merge {:file-id file-id
                                          :page-id page-id
                                          :root-id root-id}
                                         extra)))

(defn- read-all
  "Every window of the walk of `root-id` on `page-id`, read with the params
  `extra`, in order. Returns the list of the replies' results."
  [profile file-id page-id root-id & {:as extra}]
  (loop [cursor  nil
         replies []]
    (let [out    (subtree profile file-id page-id root-id
                          (cond-> extra
                            (some? cursor) (assoc :cursor cursor)))
          result (:result out)
          replies (conj replies result)]
      (t/is (nil? (:error out)))
      (if (and (:truncated result) (< (count replies) 50))
        (recur (:next-cursor result) replies)
        replies))))

(defn- shape-ids
  "The ids of the shapes of `replies`, in order."
  [replies]
  (vec (mapcat (fn [result] (map :id (:shapes result))) replies)))

(defn- close-matrix?
  "Whether the world matrix `matrix` holds the values `[a b c d e f]`."
  [matrix [a b c d e f]]
  (and (mth/close? a (:a matrix))
       (mth/close? b (:b matrix))
       (mth/close? c (:c matrix))
       (mth/close? d (:d matrix))
       (mth/close? e (:e matrix))
       (mth/close? f (:f matrix))))

;; --- REPLY SHAPE AND WALK ORDER

(t/deftest subtree-reply-holds-the-walk-from-the-root
  (let [{:keys [profile file-id page1 board1 rect1 text1]} (create-fixture)
        out    (subtree profile file-id page1 board1)
        result (:result out)
        shapes (:shapes result)]
    (t/is (nil? (:error out)))
    (t/is (= #{:revn :page-id :root-id :total :shapes :truncated}
             (set (keys result))))
    (t/is (= page1 (:page-id result)))
    (t/is (= board1 (:root-id result)))
    (t/is (= 3 (:total result)))
    (t/is (false? (:truncated result)))
    (t/is (nil? (:next-cursor result)))
    (t/is (= [board1 rect1 text1] (map :id shapes)))
    (t/is (= [0 1 1] (map :depth shapes)))
    (t/is (= [0 1 2] (map :index shapes)))))

(t/deftest subtree-of-the-page-root-skips-the-root
  (let [{:keys [profile file-id page1 page2 board1 rect1 text1 board2 rect2]} (create-fixture)
        out    (subtree profile file-id page1 uuid/zero)
        result (:result out)
        shapes (:shapes result)
        other  (:result (subtree profile file-id page2 uuid/zero))]
    (t/is (nil? (:error out)))
    (t/is (= uuid/zero (:root-id result)))
    (t/is (= 3 (:total result)))
    (t/is (= [board1 rect1 text1] (map :id shapes)))
    (t/is (= [0 1 1] (map :depth shapes)))
    (t/is (= [0 1 2] (map :index shapes)))

    (t/is (= 2 (:total other)))
    (t/is (= [board2 rect2] (map :id (:shapes other))))
    (t/is (= [0 1] (map :depth (:shapes other))))))

(t/deftest subtree-refuses-a-missing-root
  (let [{:keys [profile file-id page1]} (create-fixture)
        out (subtree profile file-id page1 (uuid/next))]
    (t/is (= :shape-not-found (th/ex-code (:error out))))))

(t/deftest subtree-refuses-a-profile-without-access
  (let [{:keys [file-id page1]} (create-fixture)
        outsider (th/create-profile* 2 {:is-active true})
        out      (subtree outsider file-id page1 uuid/zero)]
    (t/is (some? (:error out)))
    (t/is (= :not-found (th/ex-type (:error out))))))

;; --- ATTRIBUTES

(t/deftest subtree-text-carries-content-position-data-and-characters
  (let [{:keys [profile file-id page1 board1 text1]} (create-fixture)
        position [{:x 0 :y 0 :width 100 :height 20
                   :fills red-fill}]
        text2    (uuid/next)
        _        (apply-changes! profile file-id
                                 [(add-obj page1 text2 board1 board1
                                           {:type :text
                                            :name "Measured"
                                            :x 0 :y 0 :width 100 :height 20
                                            :content text-content
                                            :position-data position})])
        shapes   (:shapes (:result (subtree profile file-id page1 board1)))
        by-id    (into {} (map (juxt :id identity)) shapes)
        plain    (get by-id text1)
        measured (get by-id text2)]
    (t/is (= text-content (:content plain)))
    (t/is (= "Hello Penpot" (:characters plain)))
    (t/is (not (contains? plain :position-data)))
    (t/is (= text-content (:content measured)))
    (t/is (= "Hello Penpot" (:characters measured)))
    (t/is (some? (:position-data measured)))))

(t/deftest subtree-path-carries-its-content
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        path-id (uuid/next)
        _       (apply-changes! profile file-id
                                [(add-obj page1 path-id board1 board1
                                          {:type :path
                                           :name "Triangle"
                                           :content path-content
                                           :fills red-fill})])
        shapes  (:shapes (:result (subtree profile file-id page1 board1)))
        path    (first (filter #(= path-id (:id %)) shapes))]
    (t/is (some? path))
    (t/is (= (str (path/from-plain path-content)) (str (:content path))))
    (t/is (not (contains? path :thumbnail)))))

(t/deftest subtree-world-matrix-of-an-unrotated-shape-is-the-identity
  (let [{:keys [profile file-id page1 board1 rect1]} (create-fixture)
        shapes (:shapes (:result (subtree profile file-id page1 board1)))
        rect   (first (filter #(= rect1 (:id %)) shapes))
        matrix (:world-matrix rect)]
    (t/is (= #{:a :b :c :d :e :f} (set (keys matrix))))
    (t/is (close-matrix? matrix [1 0 0 1 0 0]))))

(t/deftest subtree-world-matrix-of-a-rotated-shape-turns-about-its-centre
  (let [{:keys [profile file-id page1]} (create-fixture)
        ids    (apply-ops! profile file-id
                           [{:op "create_rect" :page-id page1 :id "$tmp:r"
                             :x 0 :y 0 :width 100 :height 50}])
        rect   (get ids "$tmp:r")
        _      (apply-ops! profile file-id
                           [{:op "update_shape" :page-id page1 :id rect
                             :props {:rotation 45}}])
        shapes (:shapes (:result (subtree profile file-id page1 uuid/zero)))
        matrix (:world-matrix (first (filter #(= rect (:id %)) shapes)))
        cos45  (Math/cos (/ Math/PI 4))
        sin45  (Math/sin (/ Math/PI 4))
        ;; the centre of the selrect (50, 25) maps to itself
        cx     (+ (:e matrix) (* (:a matrix) 50) (* (:c matrix) 25))
        cy     (+ (:f matrix) (* (:b matrix) 50) (* (:d matrix) 25))]
    (t/is (mth/close? 50 cx))
    (t/is (mth/close? 25 cy))
    (t/is (mth/close? cos45 (Math/abs (double (:a matrix)))))
    (t/is (mth/close? sin45 (Math/abs (double (:b matrix)))))
    (t/is (not (close-matrix? matrix [1 0 0 1 0 0])))))

;; --- WINDOWS AND CURSORS

(t/deftest subtree-pages-five-shapes-two-at-a-time
  (let [{:keys [profile file-id page1 board1 rect1 text1]} (create-fixture)
        rect3   (uuid/next)
        rect4   (uuid/next)
        _       (apply-changes! profile file-id
                                [(add-obj page1 rect3 board1 board1 {:type :rect :name "R3"})
                                 (add-obj page1 rect4 board1 board1 {:type :rect :name "R4"})])
        replies (read-all profile file-id page1 uuid/zero :limit 2)]
    (t/is (= [board1 rect1 text1 rect3 rect4] (shape-ids replies)))
    (t/is (= 3 (count replies)))
    (t/is (every? #(= 5 (:total %)) replies))
    (t/is (= [true true false] (map :truncated replies)))
    (t/is (every? some? (map :next-cursor (butlast replies))))
    (t/is (nil? (:next-cursor (last replies))))
    (t/is (= [2 2 1] (map (comp count :shapes) replies)))
    (t/is (= [0 1 2 3 4] (map :index (mapcat :shapes replies))))))

(t/deftest subtree-holds-one-shape-per-window-when-a-shape-exceeds-the-budget
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        _       (apply-changes! profile file-id
                                [(add-obj page1 (uuid/next) board1 board1 {:type :rect :name "R3"})
                                 (add-obj page1 (uuid/next) board1 board1 {:type :rect :name "R4"})])
        replies (with-redefs [mcp/encoded-size (fn [_] 5000000)]
                  (read-all profile file-id page1 uuid/zero :max-bytes 1000))]
    (t/is (= 5 (count replies)))
    (t/is (every? #(= 1 (count (:shapes %))) replies))
    (t/is (= 5 (count (distinct (shape-ids replies)))))))

(t/deftest subtree-windows-fit-the-byte-budget
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        _       (apply-changes! profile file-id
                                [(add-obj page1 (uuid/next) board1 board1 {:type :rect :name "R3"})
                                 (add-obj page1 (uuid/next) board1 board1 {:type :rect :name "R4"})])
        replies (read-all profile file-id page1 uuid/zero :max-bytes 1000)
        ids     (shape-ids replies)]
    (t/is (= 5 (count ids)))
    (t/is (= 5 (count (distinct ids))))
    (t/is (every? (fn [result]
                    (or (= 1 (count (:shapes result)))
                        (<= (reduce + (map mcp/encoded-size (:shapes result))) 1000)))
                  replies))))

(t/deftest subtree-refuses-cursors-of-another-page-root-or-version
  (let [{:keys [profile file-id page1 page2 board1]} (create-fixture)
        first-page (:result (subtree profile file-id page1 uuid/zero :limit 1))
        cursor     (:next-cursor first-page)]
    (t/is (string? cursor))

    (t/is (= :mcp-invalid-cursor
             (th/ex-code (:error (subtree profile file-id page1 uuid/zero
                                          :cursor "not-a-cursor")))))
    (t/is (= :mcp-invalid-cursor
             (th/ex-code (:error (subtree profile file-id page1 board1
                                          :limit 1 :cursor cursor)))))
    (t/is (= :mcp-invalid-cursor
             (th/ex-code (:error (subtree profile file-id page2 uuid/zero
                                          :limit 1 :cursor cursor)))))

    (t/is (nil? (:error (subtree profile file-id page1 uuid/zero
                                 :limit 1 :cursor cursor))))

    ;; a write to the page moves its version: the cursor is stale
    (apply-changes! profile file-id
                    [(add-obj page1 (uuid/next) board1 board1 {:type :rect :name "Late"})])
    (t/is (= :mcp-stale-cursor
             (th/ex-code (:error (subtree profile file-id page1 uuid/zero
                                          :limit 1 :cursor cursor)))))))

(t/deftest subtree-refuses-an-index-past-the-end
  (let [{:keys [profile file-id page1]} (create-fixture)
        cursor (:next-cursor (:result (subtree profile file-id page1 uuid/zero :limit 1)))
        value  (mcp/parse-cursor cursor)
        past   (mcp/encode-cursor (assoc value 2 999))]
    (t/is (= :mcp-invalid-cursor
             (th/ex-code (:error (subtree profile file-id page1 uuid/zero
                                          :limit 1 :cursor past)))))))

;; --- AUDIT

(t/deftest subtree-audit-props-name-the-file-and-the-page
  (let [{:keys [profile file-id page1]} (create-fixture)
        token-id (uuid/next)
        out      (call! profile :get-mcp-subtree {:file-id file-id
                                                  :page-id page1
                                                  :root-id uuid/zero}
                        :token-id token-id)
        props    (:app.loggers.audit/replace-props (meta (:result out)))]
    (t/is (nil? (:error out)))
    (t/is (= "get-mcp-subtree" (:tool props)))
    (t/is (= file-id (:file-id props)))
    (t/is (= [page1] (:page-ids props)))
    (t/is (= token-id (:token-id props)))))

;; --- CURSORS THAT ARE NOT CURSORS

(t/deftest subtree-refuses-malformed-cursors-as-invalid
  (let [{:keys [profile file-id page1]} (create-fixture)
        cursor  (:next-cursor (:result (subtree profile file-id page1 uuid/zero :limit 1)))
        version (second (mcp/parse-cursor cursor))]
    (doseq [value [[page1 version "x" uuid/zero 0]
                   [page1 version -1 uuid/zero 0]
                   [page1 version 0 uuid/zero "x"]
                   [page1]]]
      (let [out (subtree profile file-id page1 uuid/zero
                         :cursor (mcp/encode-cursor value))]
        (t/is (= :mcp-invalid-cursor (th/ex-code (:error out)))
              (pr-str value))))
    (t/is (= :mcp-invalid-cursor
             (th/ex-code (:error (subtree profile file-id page1 uuid/zero
                                          :cursor "!!! not base64")))))))

;; --- THE HTTP JSON WRITER

(defn- over-http
  "The reply `value` as the HTTP layer writes it: `app.common.json/write`
  with the camel-case key function, read back as data."
  [value]
  (let [writer (java.io.StringWriter.)]
    (json/write writer value :key-fn json/write-camel-key)
    (jd/read-str (str writer))))

(t/deftest subtree-reply-reaches-the-client-as-camel-case-json
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        path-id (uuid/next)
        text2   (uuid/next)
        _       (apply-changes!
                 profile file-id
                 [(add-obj page1 path-id board1 board1
                           {:type :path :name "Triangle"
                            :content path-content :fills red-fill})
                  (add-obj page1 text2 board1 board1
                           {:type :text :name "Measured"
                            :x 0 :y 0 :width 100 :height 20
                            :content text-content
                            :position-data [{:x 0 :y 0 :width 100 :height 20
                                             :fills red-fill}]})])
        ids     (apply-ops! profile file-id
                            [{:op "create_rect" :page-id page1 :id "$tmp:r"
                              :x 0 :y 0 :width 100 :height 50}])
        rect    (get ids "$tmp:r")
        _       (apply-ops! profile file-id
                            [{:op "update_shape" :page-id page1 :id rect
                              :props {:rotation 45}}])
        out     (subtree profile file-id page1 uuid/zero)
        reply   (over-http (:result out))
        by-id   (into {} (map (juxt #(get % "id") identity)) (get reply "shapes"))
        path    (get by-id (str path-id))
        measure (get by-id (str text2))
        turned  (get by-id (str rect))]
    (t/is (nil? (:error out)))
    (t/is (= (str page1) (get reply "pageId")))
    (t/is (= (str uuid/zero) (get reply "rootId")))
    (t/is (every? #(contains? reply %) ["revn" "total" "truncated" "shapes"]))
    (t/is (not (contains? reply "nextCursor")))
    (t/is (every? #(and (contains? % "depth") (contains? % "index"))
                  (get reply "shapes")))

    ;; a path carries its SVG path string: absolute commands in page space
    (let [content (get path "content")]
      (println "path content:" (pr-str content))
      (t/is (string? content))
      (t/is (= "M0.0,0.0L40.0,0.0L40.0,30.0Z" content))
      (t/is (.startsWith ^String content "M"))
      (t/is (.endsWith ^String content "Z"))
      (t/is (re-matches #"[MLCZ0-9.,\-]+" content)))

    ;; the world matrix is an object of numbers a to f
    (let [matrix (get turned "worldMatrix")]
      (println "worldMatrix:" (pr-str matrix))
      (t/is (= #{"a" "b" "c" "d" "e" "f"} (set (keys matrix))))
      (t/is (every? number? (vals matrix))))

    ;; position data is an array of boxes
    (let [positions (get measure "positionData")]
      (t/is (vector? positions))
      (t/is (seq positions))
      (t/is (every? #(every? (set (keys %)) ["x" "y" "width" "height"]) positions)))))

;; --- EMPTY PAGES, LONE ROOTS, STORED ORDER

(t/deftest subtree-of-an-empty-page-is-empty
  (let [{:keys [profile file-id page3]} (create-fixture)
        out    (subtree profile file-id page3 uuid/zero)
        result (:result out)]
    (t/is (nil? (:error out)))
    (t/is (= 0 (:total result)))
    (t/is (= [] (:shapes result)))
    (t/is (false? (:truncated result)))
    (t/is (nil? (:next-cursor result)))))

(t/deftest subtree-of-a-root-without-children-is-one-shape
  (let [{:keys [profile file-id page3]} (create-fixture)
        lonely (uuid/next)
        _      (apply-changes! profile file-id
                               [(add-obj page3 lonely uuid/zero uuid/zero
                                         {:type :frame :name "Lonely"})])
        result (:result (subtree profile file-id page3 lonely))]
    (t/is (= 1 (:total result)))
    (t/is (= [lonely] (map :id (:shapes result))))
    (t/is (= [0] (map :depth (:shapes result))))
    (t/is (false? (:truncated result)))))

(t/deftest subtree-follows-stored-order-on-a-flex-layout
  (let [{:keys [profile file-id page3]} (create-fixture)
        flex   (uuid/next)
        first' (uuid/next)
        second' (uuid/next)
        _      (apply-changes! profile file-id
                               [(add-obj page3 flex uuid/zero uuid/zero
                                         {:type :frame :name "Flex"
                                          :layout :flex :layout-flex-dir :row})
                                (add-obj page3 first' flex flex {:type :rect :name "First"})
                                (add-obj page3 second' flex flex {:type :rect :name "Second"})])
        stored (get-in (bfc/get-file th/*system* file-id :realize? true)
                       [:data :pages-index page3 :objects flex :shapes])
        result (:result (subtree profile file-id page3 flex))
        ids    (vec (map :id (rest (:shapes result))))]
    (t/is (= [first' second'] ids))
    (t/is (= (vec stored) ids))))

;; --- WORLD MATRIX SIGNS

(defn- corners
  "The four corners of the selrect of `shape`, mapped through its world
  matrix: the rectangle the matrix draws."
  [shape]
  (let [{:keys [x y width height]} (:selrect shape)
        m (:world-matrix shape)]
    (mapv (fn [[px py]]
            [(+ (* (:a m) px) (* (:c m) py) (:e m))
             (+ (* (:b m) px) (* (:d m) py) (:f m))])
          [[x y] [(+ x width) y] [(+ x width) (+ y height)] [x (+ y height)]])))

(defn- same-points?
  "Whether the point lists `as` and `bs` hold the same points, in any order."
  [as bs]
  (and (= (count as) (count bs))
       (every? (fn [[ax ay]]
                 (some (fn [[bx by]]
                         (and (mth/close? ax bx) (mth/close? ay by)))
                       bs))
               as)))

(defn- point-pairs
  [shape]
  (mapv (fn [p] [(:x p) (:y p)]) (:points shape)))

(t/deftest subtree-world-matrix-of-a-flipped-shape-draws-its-points
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        flipped (uuid/next)
        _       (apply-changes! profile file-id
                                [(add-obj page1 flipped board1 board1
                                          {:type :rect :name "Flipped"
                                           :x 10 :y 20 :width 100 :height 50
                                           :flip-x true
                                           :transform (gmt/matrix -1 0 0 1 0 0)
                                           :transform-inverse (gmt/matrix -1 0 0 1 0 0)})])
        shape   (first (filter #(= flipped (:id %))
                               (:shapes (:result (subtree profile file-id page1 board1)))))
        matrix  (:world-matrix shape)]
    (t/is (neg? (:a matrix)))
    (t/is (same-points? (corners shape) (point-pairs shape)))))

(t/deftest subtree-world-matrix-of-a-rotated-shape-draws-its-points
  (let [{:keys [profile file-id page1]} (create-fixture)
        ids    (apply-ops! profile file-id
                           [{:op "create_rect" :page-id page1 :id "$tmp:r"
                             :x 0 :y 0 :width 100 :height 50}])
        rect   (get ids "$tmp:r")
        _      (apply-ops! profile file-id
                           [{:op "update_shape" :page-id page1 :id rect
                             :props {:rotation 45}}])
        shape  (first (filter #(= rect (:id %))
                              (:shapes (:result (subtree profile file-id page1 uuid/zero)))))]
    (t/is (same-points? (corners shape) (point-pairs shape)))))

;; --- PAGES

(t/deftest subtree-refuses-an-unknown-page
  (let [{:keys [profile file-id]} (create-fixture)
        out (subtree profile file-id (uuid/next) uuid/zero)]
    (t/is (= :page-not-found (th/ex-code (:error out))))))

;; --- THE WALK CACHE AND THE VISITED GUARD

(t/deftest subtree-walks-a-page-once-for-all-its-windows
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        _        (apply-changes! profile file-id
                                 [(add-obj page1 (uuid/next) board1 board1 {:type :rect :name "R3"})
                                  (add-obj page1 (uuid/next) board1 board1 {:type :rect :name "R4"})])
        walks    (atom 0)
        original @#'subtree/get-walk-entries]
    (with-redefs [subtree/get-walk-entries (fn [& args]
                                             (swap! walks inc)
                                             (apply original args))]
      (let [replies (read-all profile file-id page1 uuid/zero :limit 2)]
        (t/is (= 3 (count replies)))
        (t/is (= 1 @walks))

        ;; a write moves the version: the next walk builds the walk again
        (apply-changes! profile file-id
                        [(add-obj page1 (uuid/next) board1 board1 {:type :rect :name "R5"})])
        (read-all profile file-id page1 uuid/zero :limit 2)
        (t/is (= 2 @walks))))))

(t/deftest subtree-walk-lists-a-cycle-once
  (let [root (uuid/next)
        a    (uuid/next)
        b    (uuid/next)
        objects {root {:id root :shapes [a]}
                 a    {:id a :shapes [b]}
                 b    {:id b :shapes [a root]}}]
    (t/is (= [[0 root] [1 a] [2 b]]
             (@#'subtree/get-walk-entries objects root)))))
