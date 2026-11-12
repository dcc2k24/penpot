;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-mcp-subtree-test
  (:require
   [app.binfile.common :as bfc]
   [app.common.geom.matrix :as gmt]
   [app.common.geom.point :as gpt]
   [app.common.geom.rect :as grc]
   [app.common.geom.shapes :as gsh]
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
   [clojure.test :as t]
   [clojure.walk :as walk]))

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

;; --- WORLD MATRIX

(def ^:private eps
  "The tolerance of the world-matrix tests: 1e-6, tighter than `mth/close?`."
  1e-6)

(defn- near?
  "Whether the numbers `a` and `b` differ by less than `eps`."
  [a b]
  (< (Math/abs (double (- a b))) eps))

(defn- corners
  "The four corners of the selrect of `shape`, mapped through its world
  matrix: top-left, top-right, bottom-right, bottom-left."
  [shape]
  (let [{:keys [x y width height]} (:selrect shape)
        m (:world-matrix shape)]
    (mapv (fn [[px py]]
            [(+ (* (:a m) px) (* (:c m) py) (:e m))
             (+ (* (:b m) px) (* (:d m) py) (:f m))])
          [[x y] [(+ x width) y] [(+ x width) (+ y height)] [x (+ y height)]])))

(defn- same-points-in-order?
  "Whether the point lists `as` and `bs` hold the same points at the same
  indexes. A mirrored shape has its points in another order, so every world
  matrix test uses this and none uses an unordered comparison."
  [as bs]
  (and (= (count as) (count bs))
       (every? (fn [[[ax ay] [bx by]]] (and (near? ax bx) (near? ay by)))
               (map vector as bs))))

(defn- point-pairs
  [shape]
  (mapv (fn [p] [(:x p) (:y p)]) (:points shape)))

(defn- matrix-values
  [m]
  [(:a m) (:b m) (:c m) (:d m) (:e m) (:f m)])

(defn- same-matrix?
  "Whether the matrices `m1` and `m2` hold the same six values within `eps`."
  [m1 m2]
  (every? true? (map near? (matrix-values m1) (matrix-values m2))))

(defn- shape-of
  "The shape `id` of the subtree walk of `root-id`, as the command replies."
  [profile file-id page-id root-id id]
  (first (filter #(= id (:id %))
                 (:shapes (:result (subtree profile file-id page-id root-id))))))

(defn- stored-shape
  "The shape `id` as the page stores it."
  [file-id page-id id]
  (get-in (bfc/get-file th/*system* file-id :realize? true)
          [:data :pages-index page-id :objects id]))

(defn- check-agrees!
  "Asserts, for a shape whose transform agrees with its points, that the
  reply's world matrix equals the matrix of the stored transform and maps
  the selrect corners onto the points in order."
  [file-id page-id shape]
  (let [stored (stored-shape file-id page-id (:id shape))]
    (t/is (same-matrix? (:world-matrix shape) (gsh/transform-matrix stored)))
    (t/is (same-points-in-order? (corners shape) (point-pairs shape)))))

(t/deftest subtree-world-matrix-of-a-plain-shape-equals-the-transform-matrix
  (let [{:keys [profile file-id page1 board1 rect1]} (create-fixture)
        shape (shape-of profile file-id page1 board1 rect1)]
    (check-agrees! file-id page1 shape)
    (t/is (same-matrix? (:world-matrix shape) (gmt/matrix)))))

(t/deftest subtree-world-matrix-of-a-flipped-rect-equals-the-transform-matrix
  (let [{:keys [profile file-id page1 board1]} (create-fixture)]
    (doseq [[flip-x flip-y matrix] [[true false (gmt/matrix -1 0 0 1 0 0)]
                                    [false true (gmt/matrix 1 0 0 -1 0 0)]
                                    [true true (gmt/matrix -1 0 0 -1 0 0)]]]
      (let [id    (uuid/next)
            _     (apply-changes! profile file-id
                                  [(add-obj page1 id board1 board1
                                            {:type :rect :name "Flipped"
                                             :x 10 :y 20 :width 100 :height 50
                                             :flip-x flip-x :flip-y flip-y
                                             :transform matrix
                                             :transform-inverse matrix})])
            shape (shape-of profile file-id page1 board1 id)]
        (check-agrees! file-id page1 shape)
        ;; the mirrored points do not start at the top-left corner
        (t/is (not (same-points-in-order?
                    (point-pairs shape)
                    [[10 20] [110 20] [110 70] [10 70]])))))))

(t/deftest subtree-world-matrix-of-a-rotated-rect-equals-the-transform-matrix
  (let [{:keys [profile file-id page1]} (create-fixture)
        ids    (apply-ops! profile file-id
                           [{:op "create_rect" :page-id page1 :id "$tmp:r"
                             :x 5 :y 7 :width 120 :height 40}])
        rect   (get ids "$tmp:r")
        _      (apply-ops! profile file-id
                           [{:op "update_shape" :page-id page1 :id rect
                             :props {:rotation 30}}])
        shape  (shape-of profile file-id page1 uuid/zero rect)]
    (check-agrees! file-id page1 shape)
    (t/is (not (same-matrix? (:world-matrix shape) (gmt/matrix))))))

(def ^:private flipped-group-cases
  "A group of the box `x 10, y 20, 100 by 50` flipped on x, on y and on both:
  the flip flags and the page corners of its first to fourth point."
  [[true false [[110 20] [10 20] [10 70] [110 70]]]
   [false true [[10 70] [110 70] [110 20] [10 20]]]
   [true true [[110 70] [10 70] [10 20] [110 20]]]])

(defn- add-flipped-group!
  "Writes, through raw changes, a group that came from an import: its
  `:transform` and `:transform-inverse` are the identity while its `:points`
  are mirrored. `apply_operations` cannot write this state, because Penpot
  recomputes the transform of a group from its points. The group holds one
  rect child at 30,30 of 20 by 20. Returns the ids `{:group :child}`."
  [profile file-id page-id board-id flip-x flip-y corners-in]
  (let [group (uuid/next)
        child (uuid/next)]
    (apply-changes! profile file-id
                    [(add-obj page-id group board-id board-id
                              {:type :group :name "Imported group"
                               :x 10 :y 20 :width 100 :height 50
                               :flip-x flip-x :flip-y flip-y
                               :selrect (grc/make-rect 10 20 100 50)
                               :points (mapv (fn [[x y]] (gpt/point x y)) corners-in)
                               :transform (gmt/matrix)
                               :transform-inverse (gmt/matrix)})
                     (add-obj page-id child group board-id
                              {:type :rect :name "Child"
                               :x 30 :y 30 :width 20 :height 20})])
    {:group group :child child}))

(t/deftest subtree-world-matrix-of-a-flipped-group-draws-its-points-in-order
  (let [{:keys [profile file-id page1 board1]} (create-fixture)]
    (doseq [[flip-x flip-y corners-in] flipped-group-cases]
      (let [{:keys [group]} (add-flipped-group! profile file-id page1 board1 flip-x flip-y corners-in)
            stored (stored-shape file-id page1 group)
            shape  (shape-of profile file-id page1 board1 group)]
        ;; the stored state is the faulty one: identity transform, mirrored points
        (t/is (same-matrix? (gsh/transform-matrix stored) (gmt/matrix)))
        (t/is (same-points-in-order? (point-pairs stored) corners-in))
        ;; the world matrix follows the points, and the old one did not
        (t/is (same-points-in-order? (corners shape) (point-pairs shape)))
        (t/is (not (same-points-in-order?
                    (corners (assoc shape :world-matrix (gsh/transform-matrix stored)))
                    (point-pairs shape))))))))

(defn- apply-affine
  "The point `[x y]` mapped through the matrix `m`."
  [m [x y]]
  [(+ (* (:a m) x) (* (:c m) y) (:e m))
   (+ (* (:b m) x) (* (:d m) y) (:f m))])

(defn- compose-affine
  "The matrix of `m1` applied after `m2`."
  [m1 m2]
  (gmt/matrix (+ (* (:a m1) (:a m2)) (* (:c m1) (:b m2)))
              (+ (* (:b m1) (:a m2)) (* (:d m1) (:b m2)))
              (+ (* (:a m1) (:c m2)) (* (:c m1) (:d m2)))
              (+ (* (:b m1) (:c m2)) (* (:d m1) (:d m2)))
              (+ (* (:a m1) (:e m2)) (* (:c m1) (:f m2)) (:e m1))
              (+ (* (:b m1) (:e m2)) (* (:d m1) (:f m2)) (:f m1))))

(defn- invert-affine
  "The inverse of the matrix `m`."
  [m]
  (let [det (- (* (:a m) (:d m)) (* (:b m) (:c m)))
        a   (/ (:d m) det)
        b   (/ (- (:b m)) det)
        c   (/ (- (:c m)) det)
        d   (/ (:a m) det)]
    (gmt/matrix a b c d
                (- (+ (* a (:e m)) (* c (:f m))))
                (- (+ (* b (:e m)) (* d (:f m)))))))

(t/deftest subtree-child-of-a-flipped-group-lands-on-its-own-points
  (let [{:keys [profile file-id page1 board1]} (create-fixture)]
    (doseq [[flip-x flip-y corners-in] flipped-group-cases]
      (let [{:keys [group child]} (add-flipped-group! profile file-id page1 board1 flip-x flip-y corners-in)
            walk   (:shapes (:result (subtree profile file-id page1 group)))
            parent (first (filter #(= group (:id %)) walk))
            kid    (first (filter #(= child (:id %)) walk))
            wp     (:world-matrix parent)
            ;; the matrix a generator writes for the child inside the group
            local  (compose-affine (invert-affine wp) (:world-matrix kid))
            {:keys [x y width height]} (:selrect kid)
            sel    [[x y] [(+ x width) y] [(+ x width) (+ y height)] [x (+ y height)]]
            placed (mapv #(apply-affine wp (apply-affine local %)) sel)]
        (t/is (some? kid))
        (t/is (same-points-in-order? placed (point-pairs kid)))
        (t/is (same-points-in-order? (corners kid) (point-pairs kid)))))))

(t/deftest subtree-world-matrix-of-a-flat-path-draws-its-points-without-error
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        id    (uuid/next)
        _     (apply-changes! profile file-id
                              [(add-obj page1 id board1 board1
                                        {:type :path :name "Line"
                                         :content [{:command :move-to :params {:x 10 :y 20}}
                                                   {:command :line-to :params {:x 110 :y 20}}]
                                         :fills red-fill})])
        out   (subtree profile file-id page1 board1)
        shape (first (filter #(= id (:id %)) (:shapes (:result out))))
        saved (stored-shape file-id page1 id)]
    (t/is (nil? (:error out)))
    (t/is (some? shape))
    ;; Penpot keeps a path box at 0.01 at least, so this one is not a
    ;; zero box: the zero box is covered by the pure test below
    (t/is (pos? (:height (:selrect saved))))
    (t/is (same-points-in-order? (corners shape) (point-pairs shape)))))

(t/deftest get-world-matrix-falls-back-to-the-stored-transform
  (let [selrect   (grc/make-rect 10 20 100 50)
        transform (gmt/matrix 0 1 -1 0 0 0)
        base      {:selrect selrect :transform transform}
        old       (gsh/transform-matrix base)
        four      (mapv (fn [[x y]] (gpt/point x y))
                        [[110 20] [10 20] [10 70] [110 70]])]
    (t/testing "no points"
      (t/is (same-matrix? old (subtree/get-world-matrix base))))
    (t/testing "not four points"
      (t/is (same-matrix? old (subtree/get-world-matrix (assoc base :points (vec (take 3 four)))))))
    ;; `grc/make-rect` keeps a size of 0.01 at least, so these selrects are
    ;; built from the record directly, as a file can store them
    (t/testing "a box of zero height"
      (let [flat {:selrect (grc/map->Rect {:x 10 :y 20 :width 100 :height 0 :x1 10 :y1 20 :x2 110 :y2 20})
                  :transform transform :points four}]
        (t/is (same-matrix? (gsh/transform-matrix flat) (subtree/get-world-matrix flat)))))
    (t/testing "a box of zero width"
      (let [flat {:selrect (grc/map->Rect {:x 10 :y 20 :width 0 :height 50 :x1 10 :y1 20 :x2 10 :y2 70})
                  :transform transform :points four}]
        (t/is (same-matrix? (gsh/transform-matrix flat) (subtree/get-world-matrix flat)))))
    (t/testing "degenerate points give a singular matrix: the stored transform is used"
      (doseq [[label corners-in] [["all four points coincide" [[10 20] [10 20] [10 20] [10 20]]]
                                  ["two points coincide" [[10 20] [10 20] [10 70] [110 70]]]
                                  ["all points on one line" [[10 20] [60 20] [110 20] [160 20]]]]]
        (let [shape (assoc base :points (mapv (fn [[x y]] (gpt/point x y)) corners-in))
              m     (subtree/get-world-matrix shape)]
          (t/is (same-matrix? old m) label)
          (t/is (> (Math/abs (- (* (:a m) (:d m)) (* (:b m) (:c m)))) 1e-9) label))))
    (t/testing "points given: the matrix follows them, not the transform"
      (let [m (subtree/get-world-matrix (assoc base :points four))]
        (t/is (not (same-matrix? old m)))
        (t/is (same-points-in-order?
               (map #(apply-affine m %) [[10 20] [110 20] [110 70] [10 70]])
               [[110 20] [10 20] [10 70] [110 70]]))))))

(defn- map-rect
  "A selrect of exactly `w` by `h`, zero allowed: `grc/make-rect` would raise
  a zero side to 0.01, and a file can store the zero."
  [x y w h]
  (grc/map->Rect {:x x :y y :width w :height h :x1 x :y1 y :x2 (+ x w) :y2 (+ y h)}))

(defn- selrect-points
  "The four corners of the box `x y w h` as points, mapped by `f`."
  [x y w h f]
  (mapv (fn [[px py]] (let [[qx qy] (f px py)] (gpt/point qx qy)))
        [[x y] [(+ x w) y] [(+ x w) (+ y h)] [x (+ y h)]]))

(defn- bounds
  "The selrect of the points `pts`, as the bounding box."
  [pts]
  (let [xs (map :x pts) ys (map :y pts)
        x  (apply min xs) y (apply min ys)]
    (map-rect x y (- (apply max xs) x) (- (apply max ys) y))))

(t/deftest get-world-matrix-of-degenerate-boxes-maps-the-selrect-onto-the-points
  (doseq [[w h] [[0 1] [1 0] [0 0.01] [300 0.01] [0.01 300]]
          [x y] [[-75820 -57769] [-55998 -58148.1429] [10 20]]
          rot?  [false true]]
    (let [c  (gmt/matrix 1 0 0 1 0 0)
          tm (if rot? (gmt/matrix 0 1 -1 0 0 0) c)
          cx (+ x (/ w 2.0)) cy (+ y (/ h 2.0))
          f  (fn [px py] [(+ cx (* (:a tm) (- px cx)) (* (:c tm) (- py cy)))
                          (+ cy (* (:b tm) (- px cx)) (* (:d tm) (- py cy)))])
          pts (selrect-points x y w h f)
          shape {:selrect (map-rect x y w h) :points pts :transform tm}
          m  (subtree/get-world-matrix shape)
          msg (pr-str [w h x y rot?])]
      (t/is (same-points-in-order?
             (map (fn [[px py]] (apply-affine m [px py]))
                  [[x y] [(+ x w) y] [(+ x w) (+ y h)] [x (+ y h)]])
             (point-pairs shape))
            msg)
      (when-not rot?
        ;; a plain shape is exactly the identity, with no float noise
        (t/is (same-matrix? m (gmt/matrix)) msg)))))

(t/deftest get-world-matrix-of-a-plain-shape-at-large-coordinates-is-exact
  (doseq [[x y w h] [[-55998 -58148.1429 319 0.01] [-55998 -58073.2857 319 0.01]
                     [-56000 -56000 100 50] [-75820 -57769 0 1]]]
    (let [shape {:selrect (map-rect x y w h)
                 :points (selrect-points x y w h (fn [px py] [px py]))
                 :transform (gmt/matrix)}
          m (subtree/get-world-matrix shape)]
      (t/is (same-matrix? m (gmt/matrix)) (pr-str [x y w h])))))

(t/deftest subtree-world-matrix-of-flat-children-in-flipped-and-plain-groups
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        plain [[10 20] [110 20] [110 70] [10 70]]]
    (doseq [[flip-x flip-y corners-in] (cons [false false plain] flipped-group-cases)
            kind [:frame :path]
            [w h] [[0 1] [1 0]]
            honest? [true false]]
      (let [{:keys [group]} (add-flipped-group! profile file-id page1 board1 flip-x flip-y corners-in)
            sx  (if flip-x -1 1)
            sy  (if flip-y -1 1)
            ;; the flip of the group about its centre (60, 45)
            f   (fn [px py] [(+ 60 (* sx (- px 60))) (+ 45 (* sy (- py 45)))])
            pts (selrect-points 30 30 w h f)
            tm  (if honest? (gmt/matrix sx 0 0 sy 0 0) (gmt/matrix))
            id  (uuid/next)
            _   (apply-changes!
                 profile file-id
                 [(add-obj page1 id group board1
                           (cond-> {:type kind :name "Flat" :selrect (bounds pts)
                                    :points pts :transform tm :transform-inverse tm}
                             (= kind :frame) (assoc :x 30 :y 30 :width w :height h)
                             (= kind :path) (assoc :content path-content)))])
            shape (shape-of profile file-id page1 group id)
            msg   (pr-str [kind w h flip-x flip-y honest?])]
        (t/is (some? shape) msg)
        (t/is (same-points-in-order? (corners shape) (point-pairs shape)) msg)))))

(defn- pts
  [coords]
  (mapv (fn [[x y]] (gpt/point x y)) coords))

(t/deftest get-world-matrix-of-the-real-divider-shapes-is-the-identity
  ;; read from the real page (file 346a1245, page c54dcb4e): selrect and
  ;; points of a plain, unrotated shape, in page coordinates near -56000 and
  ;; -76000. The first one came out 2.18 px off, the others 0.01 px off.
  (doseq [[label x y w h]
          [["VerticalDivider frame, 0.01 x 1" -75820 -57769 0.01 1]
           ["VerticalDivider path, 0.01 x 88" -76330.3359375 -57927 0.01 88]
           ["Horizontal Divider frame, 319 x 0.01" -55998 -58148.1429 319 0.01]]]
    (let [shape {:selrect   (map-rect x y w h)
                 :points    (pts [[x y] [(+ x w) y] [(+ x w) (+ y h)] [x (+ y h)]])
                 :transform (gmt/matrix)
                 :rotation  0}
          m     (subtree/get-world-matrix shape)]
      (t/is (same-matrix? m (gmt/matrix)) label)
      (t/is (same-points-in-order?
             (map #(apply-affine m %) [[x y] [(+ x w) y] [(+ x w) (+ y h)] [x (+ y h)]])
             (point-pairs shape))
            label))))

(t/deftest get-world-matrix-is-never-worse-than-the-fit-or-the-stored-matrix
  (t/testing "a solid box mirrored on x, one point 0.02 px off, identity transform"
    (let [mirrored [[110 20] [10 20] [10.02 70] [110 70]]
          shape    {:selrect (map-rect 10 20 100 50)
                    :points (pts mirrored)
                    :transform (gmt/matrix)}
          m        (subtree/get-world-matrix shape)]
      (doseq [[[x y] [tx ty]] (map vector [[10 20] [110 20] [110 70] [10 70]] mirrored)]
        (let [[mx my] (apply-affine m [x y])]
          (t/is (< (Math/hypot (- mx tx) (- my ty)) 0.05)))))))

(t/deftest get-world-matrix-reads-a-selrect-with-only-x1-y1-x2-y2
  (let [sel   (grc/map->Rect {:x1 10 :y1 20 :x2 110 :y2 70})
        bare  {:x1 10 :y1 20 :x2 110 :y2 70}
        four  (pts [[10 20] [110 20] [110 70] [10 70]])]
    (doseq [s [bare (into {} sel)]]
      (t/is (same-matrix? (gmt/matrix)
                          (subtree/get-world-matrix {:selrect s :points four
                                                     :transform (gmt/matrix)}))))
    (t/is (same-matrix? (gmt/matrix)
                        (subtree/get-world-matrix
                         {:selrect {:x1 10 :y1 20 :x2 10.01 :y2 21}
                          :points (pts [[10 20] [10.01 20] [10.01 21] [10 21]])
                          :transform (gmt/matrix)})))))

(def ^:private property-cases
  "How many random shapes the property test draws."
  300)

(t/deftest get-world-matrix-maps-the-selrect-corners-onto-the-points
  ;; fixed seed: a failure names its case, and the same run replays it
  (let [rnd  (java.util.Random. 20260611)
        pick (fn [lo hi] (+ lo (* 0.25 (.nextInt rnd (int (* 4 (- hi lo)))))))]
    (dotimes [i property-cases]
      (let [x       (pick -500 500)
            y       (pick -500 500)
            w       (pick 1 400)
            h       (pick 1 400)
            deg     (.nextInt rnd 360)
            fx      (if (.nextBoolean rnd) -1 1)
            fy      (if (.nextBoolean rnd) -1 1)
            true-t? (.nextBoolean rnd)
            rad     (Math/toRadians deg)
            cos     (Math/cos rad)
            sin     (Math/sin rad)
            cx      (+ x (/ w 2.0))
            cy      (+ y (/ h 2.0))
            ;; the transform Penpot stores: the flip, then the rotation
            tm      (gmt/matrix (* cos fx) (* sin fx) (- (* sin fy)) (* cos fy) 0 0)
            src     [[x y] [(+ x w) y] [(+ x w) (+ y h)] [x (+ y h)]]
            points  (mapv (fn [[px py]]
                            (let [dx (- px cx) dy (- py cy)]
                              (gpt/point (+ cx (* (:a tm) dx) (* (:c tm) dy))
                                         (+ cy (* (:b tm) dx) (* (:d tm) dy)))))
                          src)
            shape   (cond-> {:selrect (grc/make-rect x y w h)
                             :points points
                             :transform (gmt/matrix)}
                      true-t? (assoc :transform tm))
            m       (subtree/get-world-matrix shape)
            msg     (str "case " i " " (pr-str [x y w h deg fx fy true-t?]))]
        (t/is (same-points-in-order?
               (map #(apply-affine m %) src)
               (map (fn [p] [(:x p) (:y p)]) points))
              msg)
        (when true-t?
          (t/is (same-matrix? m (gsh/transform-matrix shape)) msg))))))

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

;; --- JSON BYTE BUDGET

(defn- json-bytes
  "Bytes of the JSON text of `value` as the HTTP layer writes it: the same
  encoder and the camel-case key function. The text is ASCII."
  [value]
  (let [writer (java.io.StringWriter.)]
    (json/write writer value :key-fn json/write-camel-key)
    (.length (.getBuffer writer))))

(defn- array-bytes
  "Bytes of the JSON array of `shapes` as the client receives it."
  [shapes]
  (json-bytes (vec shapes)))

(defn- add-rects!
  "Adds `n` rects, each with a stroke, to the board `board1` of page one."
  [profile file-id page1 board1 n]
  (apply-changes! profile file-id
                  (vec (for [i (range n)]
                         (add-obj page1 (uuid/next) board1 board1
                                  {:type :rect :name (str "Extra " i)
                                   :strokes [{:stroke-color "#000000" :stroke-width 1}]})))))

(t/deftest subtree-max-json-bytes-is-measured-in-the-json-the-client-receives
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        _       (add-rects! profile file-id page1 board1 6)
        all     (:shapes (:result (subtree profile file-id page1 uuid/zero)))
        budget  (array-bytes (take 3 all))
        replies (read-all profile file-id page1 uuid/zero :max-json-bytes budget)]
    (t/is (= 9 (count all)))
    (t/is (every? #(> (json-bytes %) 100) all))
    ;; the budget is exactly the array of the first three shapes
    (t/is (= 3 (count (:shapes (first replies)))))
    (t/is (= (map :id all) (shape-ids replies)))
    (t/is (> (count replies) 1))
    ;; every window with more than one shape is within the budget as sent
    (t/is (every? (fn [result]
                    (or (= 1 (count (:shapes result)))
                        (<= (array-bytes (:shapes result)) budget)))
                  replies))
    ;; one byte less leaves the third shape for the next window
    (let [tight (read-all profile file-id page1 uuid/zero :max-json-bytes (dec budget))]
      (t/is (= 2 (count (:shapes (first tight)))))
      (t/is (= (map :id all) (shape-ids tight))))))

(t/deftest subtree-json-windows-hold-at-least-one-shape
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        long-name (apply str (repeat 1500 "n"))
        _       (apply-changes! profile file-id
                                [(add-obj page1 (uuid/next) board1 board1 {:type :rect :name long-name})
                                 (add-obj page1 (uuid/next) board1 board1 {:type :rect :name long-name})])
        all     (:shapes (:result (subtree profile file-id page1 uuid/zero)))
        big     (filter #(> (json-bytes %) 1000) all)
        replies (read-all profile file-id page1 uuid/zero :max-json-bytes 1000)]
    ;; the two long shapes are each above the smallest budget by themselves
    (t/is (<= 2 (count big)))
    (t/is (= (map :id all) (shape-ids replies)))
    ;; each of them is alone in its window, and every window has a shape
    (t/is (every? (fn [shape]
                    (some #(and (= 1 (count (:shapes %)))
                                (= (:id shape) (:id (first (:shapes %)))))
                          replies))
                  big))
    (t/is (every? #(seq (:shapes %)) replies))
    (t/is (every? (fn [result]
                    (or (= 1 (count (:shapes result)))
                        (<= (array-bytes (:shapes result)) 1000)))
                  replies))))

(t/deftest subtree-without-max-json-bytes-keeps-the-windows-of-today
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        _       (add-rects! profile file-id page1 board1 2)
        plain   (:result (subtree profile file-id page1 uuid/zero))
        by-size (read-all profile file-id page1 uuid/zero :max-bytes 1000)
        shapes  (:shapes plain)
        budget  (reduce + (map mcp/encoded-size (take 2 shapes)))
        two     (read-all profile file-id page1 uuid/zero :max-bytes budget)]
    (t/is (= 5 (count shapes)))
    (t/is (false? (:truncated plain)))
    (t/is (= #{:revn :page-id :root-id :total :shapes :truncated} (set (keys plain))))
    ;; max-bytes counts transit text, as before
    (t/is (every? #(= 1 (count (:shapes %))) by-size))
    (t/is (= 2 (count (:shapes (first two)))))
    (t/is (= (map :id shapes) (shape-ids two)))))

(t/deftest subtree-refuses-both-budgets-and-values-out-of-range
  (let [{:keys [profile file-id page1]} (create-fixture)]
    (t/is (= :mcp-invalid-window
             (th/ex-code (:error (subtree profile file-id page1 uuid/zero
                                          :max-bytes 2000 :max-json-bytes 2000)))))
    (doseq [value [999 4000001 0]]
      (t/is (some? (:error (subtree profile file-id page1 uuid/zero
                                    :max-json-bytes value)))
            (str "max-json-bytes " value)))
    ;; the hard maximum is accepted
    (t/is (nil? (:error (subtree profile file-id page1 uuid/zero
                                 :max-json-bytes subtree/max-json-bytes))))
    (t/is (= 4000000 subtree/max-json-bytes))))

(t/deftest subtree-cursors-of-json-windows-bind-to-the-page-version
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        first-window (:result (subtree profile file-id page1 uuid/zero :max-json-bytes 1000))
        cursor       (:next-cursor first-window)]
    (t/is (string? cursor))
    (t/is (= 1 (count (:shapes first-window))))
    ;; the cursor is the same whichever unit the next window is measured in
    (t/is (nil? (:error (subtree profile file-id page1 uuid/zero
                                 :max-json-bytes 1000 :cursor cursor))))
    (t/is (nil? (:error (subtree profile file-id page1 uuid/zero
                                 :max-bytes 1000 :cursor cursor))))
    (apply-changes! profile file-id
                    [(add-obj page1 (uuid/next) board1 board1 {:type :rect :name "Late"})])
    (t/is (= :mcp-stale-cursor
             (th/ex-code (:error (subtree profile file-id page1 uuid/zero
                                          :max-json-bytes 1000 :cursor cursor)))))))

;; --- COMPACT SHAPES

(defn- create-typed-page!
  "Adds to the empty page three of the fixture a shape of every type the
  tests can create, with strokes, a hidden shape, a half transparent one
  and a flex layout with a child."
  [profile file-id page3]
  (let [flex  (uuid/next)
        group (uuid/next)
        board (uuid/next)]
    (apply-changes!
     profile file-id
     [(add-obj page3 board uuid/zero uuid/zero {:type :frame :name "Board"})
      (add-obj page3 (uuid/next) board board
               {:type :rect :name "Stroked" :fills red-fill
                :strokes [{:stroke-color "#000000" :stroke-width 2}
                          {:stroke-color "#FF0000" :stroke-width 1 :stroke-alignment :inner}]})
      (add-obj page3 (uuid/next) board board
               {:type :rect :name "Hidden" :hidden true :opacity 0.5 :blocked true})
      (add-obj page3 (uuid/next) board board {:type :circle :name "Round"})
      (add-obj page3 (uuid/next) board board
               {:type :text :name "Label" :x 0 :y 0 :width 100 :height 20
                :content text-content})
      (add-obj page3 (uuid/next) board board
               {:type :path :name "Triangle" :content path-content :fills red-fill})
      (add-obj page3 (uuid/next) board board
               {:type :image :name "Picture"
                :metadata {:id (uuid/next) :width 10 :height 10 :mtype "image/png"}})
      (add-obj page3 group board board {:type :group :name "Group"})
      (add-obj page3 (uuid/next) group board {:type :rect :name "Grouped"})
      (add-obj page3 flex board board
               {:type :frame :name "Flex" :layout :flex :layout-flex-dir :row})
      (add-obj page3 (uuid/next) flex flex {:type :rect :name "Item"})])
    flex))

(defn- remove-nils
  "`m` without the keys whose value is nil."
  [m]
  (into {} (remove (comp nil? val)) m))

(defn- numbers-as-doubles
  "`value` with every number turned into a double, so that `1` and `1.0`
  compare equal, as they do in the JSON the client parses."
  [value]
  (walk/postwalk (fn [x] (if (number? x) (double x) x)) value))

(defn- restore-shape
  "The full shape of the compact JSON shape `shape`: the defaults the reply
  lists are put back under the keys it does not carry, and the default
  stroke alignment into each stroke."
  [defaults shape]
  (let [stroke-defaults (get defaults "strokes")
        base            (dissoc defaults "strokes")]
    (cond-> (merge base shape)
      (seq (get shape "strokes"))
      (update "strokes" (partial mapv (partial merge stroke-defaults))))))

(t/deftest subtree-compact-shapes-restore-to-the-full-shapes
  (let [{:keys [profile file-id page3]} (create-fixture)
        _        (create-typed-page! profile file-id page3)
        full     (over-http (:result (subtree profile file-id page3 uuid/zero)))
        compact  (over-http (:result (subtree profile file-id page3 uuid/zero :compact true)))
        defaults (get compact "defaults")
        types    (set (map #(get % "type") (get full "shapes")))]
    (t/is (= #{"frame" "rect" "circle" "text" "path" "image" "group"} types))
    (t/is (= 11 (count (get full "shapes"))))
    (t/is (= {"hidden" false "blocked" false "opacity" 1 "strokes" {"strokeAlignment" "center"}}
             defaults))
    (t/is (true? (get compact "compact")))
    (t/is (not (contains? full "compact")))
    (t/is (not (contains? full "defaults")))
    (t/is (= (count (get full "shapes")) (count (get compact "shapes"))))
    (doseq [[f c] (map vector (get full "shapes") (get compact "shapes"))]
      ;; restoring gives the full shape, but for its nil keys
      (t/is (= (numbers-as-doubles (remove-nils f))
               (numbers-as-doubles (restore-shape defaults c)))
            (str (get f "name")))
      ;; names and types are the plain form's
      (t/is (= (get f "type") (get c "type")))
      (t/is (= (get f "name") (get c "name")))
      (t/is (every? #(contains? f %) (keys c)))
      (t/is (not-any? nil? (vals c))))
    ;; a compact reply is smaller
    (t/is (< (json-bytes (get compact "shapes")) (json-bytes (get full "shapes"))))))

(t/deftest subtree-compact-keeps-what-is-not-a-default
  (let [{:keys [profile file-id page3]} (create-fixture)
        _        (create-typed-page! profile file-id page3)
        shapes   (over-http (:result (subtree profile file-id page3 uuid/zero :compact true)))
        by-name  (into {} (map (juxt #(get % "name") identity)) (get shapes "shapes"))
        hidden   (get by-name "Hidden")
        stroked  (get by-name "Stroked")
        item     (get by-name "Item")
        plain    (get by-name "Grouped")]
    ;; a value that differs from the default stays
    (t/is (= true (get hidden "hidden")))
    (t/is (= true (get hidden "blocked")))
    (t/is (= 0.5 (get hidden "opacity")))
    ;; a value that is the default goes
    (t/is (not (contains? plain "hidden")))
    (t/is (not (contains? plain "blocked")))
    (t/is (not (contains? plain "opacity")))
    ;; the first stroke has the default alignment, the second does not
    (t/is (= [false true]
             (mapv #(contains? % "strokeAlignment") (get stroked "strokes"))))
    (t/is (= "inner" (get-in stroked ["strokes" 1 "strokeAlignment"])))
    ;; the sizing of a layout item depends on its parent, so it stays
    (t/is (= "fix" (get item "layoutItemHSizing")))
    (t/is (= "fix" (get item "layoutItemVSizing")))))

(t/deftest subtree-compact-defaults-are-the-ones-with-defaults-adds
  (let [shape   (mcp/with-defaults {} {:id (uuid/next) :type :rect})
        stroked (mcp/with-defaults {} {:id (uuid/next) :type :rect :strokes [{:stroke-width 1}]})]
    (t/is (= (select-keys subtree/compact-defaults [:hidden :blocked :opacity])
             (select-keys shape [:hidden :blocked :opacity])))
    (t/is (= (get-in subtree/compact-defaults [:strokes :stroke-alignment])
             (get-in stroked [:strokes 0 :stroke-alignment])))))

(t/deftest subtree-compact-windows-are-measured-compact
  (let [{:keys [profile file-id page1 board1]} (create-fixture)
        _       (add-rects! profile file-id page1 board1 6)
        all     (:shapes (:result (subtree profile file-id page1 uuid/zero :compact true)))
        budget  (array-bytes (take 4 all))
        replies (read-all profile file-id page1 uuid/zero :max-json-bytes budget :compact true)]
    (t/is (= 4 (count (:shapes (first replies)))))
    (t/is (= (map :id all) (shape-ids replies)))
    (t/is (every? #(true? (:compact %)) replies))
    (t/is (every? #(= subtree/compact-defaults (:defaults %)) replies))
    (t/is (every? (fn [result]
                    (or (= 1 (count (:shapes result)))
                        (<= (array-bytes (:shapes result)) budget)))
                  replies))))
