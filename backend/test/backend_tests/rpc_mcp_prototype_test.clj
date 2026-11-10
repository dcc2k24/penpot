;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-mcp-prototype-test
  (:require
   [app.common.json :as json]
   [app.common.uuid :as uuid]
   [app.db :as db]
   [app.http.access-token :as-alias actoken]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.mcp :as mcp]
   [app.rpc.commands.mcp-prototype :as proto]
   [app.rpc.commands.profile :as profile]
   [app.util.cache :as cache]
   [backend-tests.helpers :as th]
   [clojure.data.json :as jd]
   [clojure.string :as str]
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

(defn- over-http
  "The reply `value` as the HTTP layer writes it: `app.common.json/write`
  with the camel-case key function, read back as data."
  [value]
  (let [writer (java.io.StringWriter.)]
    (json/write writer value :key-fn json/write-camel-key)
    (jd/read-str (str writer))))

(defn- current-revn
  [file-id]
  (:revn (th/db-get :file {:id file-id})))

(defn- apply-changes!
  [profile file-id changes]
  (th/update-file* {:file-id file-id
                    :profile-id (:id profile)
                    :revn (current-revn file-id)
                    :changes changes}))

(defn- apply-ops!
  "Runs `operations` through `mcp-apply-operations` and returns the ids it
  created, by handle."
  [profile file-id operations]
  (let [out (call! profile :mcp-apply-operations
                   {:file-id file-id :operations operations}
                   :perms #{"mcp:write"})]
    (t/is (nil? (:error out)))
    (:created-ids (:result out))))

(defn- create-file-with-page
  "A profile that owns a file with one empty page."
  []
  (let [profile (th/create-profile* 1 {:is-active true})
        file    (th/create-file* 1 {:profile-id (:id profile)
                                    :project-id (:default-project-id profile)})]
    {:profile (th/db-get :profile {:id (:id profile)})
     :file-id (:id file)
     :page    (get-in file [:data :pages 0])}))

(defn- set-strokes
  "Changes the strokes of the shapes `ids` on `page` to the stroke maps
  `strokes`, one stroke per shape."
  [page-id ids strokes]
  (mapv (fn [id stroke-value]
          {:type :mod-obj
           :page-id page-id
           :id id
           :operations [{:type :set :attr :strokes :val [stroke-value]}]})
        ids
        strokes))

(defn- set-attr
  "A change that sets the attribute `attr` of the shape `id` on `page` to `value`."
  [page-id id attr value]
  {:type :mod-obj
   :page-id page-id
   :id id
   :operations [{:type :set :attr attr :val value}]})

(def ^:private solid-stroke
  {:stroke-color "#000000"
   :stroke-opacity 1
   :stroke-width 2
   :stroke-alignment :center
   :stroke-style :solid})

(defn- by-name
  "The entry of `items` whose `:name` is `name`, or nil."
  [name items]
  (some #(when (= name (:name %)) %) items))

(defn- near?
  "Whether the numbers `a` and `b` differ by less than `eps`."
  ([a b]
   (near? a b 0.01))
  ([a b eps]
   (< (Math/abs (double (- a b))) eps)))

(defn- find-connectors
  "The result of `find-mcp-connectors` on `page`, with `params` added."
  [profile file-id page & {:as params}]
  (call! profile :find-mcp-connectors
         (merge {:file-id file-id :page-id page} params)))

;; --- FIXTURES

(defn- pair-fixture
  "Board A (0..200 by 0..200) and board B (400..600 by 0..200) on one page."
  []
  (let [{:keys [profile file-id page]} (create-file-with-page)
        ids (apply-ops!
             profile file-id
             [{:op "create_board" :page-id page :id "$tmp:a" :name "Board A"
               :x 0 :y 0 :width 200 :height 200}
              {:op "create_board" :page-id page :id "$tmp:b" :name "Board B"
               :x 400 :y 0 :width 200 :height 200}])]
    {:profile profile
     :file-id file-id
     :page page
     :a (get ids "$tmp:a")
     :b (get ids "$tmp:b")}))

(defn- add-path
  "Creates a path named `name` with the data `d` under `parent` (or on the
  page root), stroked when `stroke` is given. Returns its id."
  [profile file-id page name d & {:keys [parent stroke]}]
  (let [ids (apply-ops! profile file-id
                        [(cond-> {:op "create_path" :page-id page :id "$tmp:p"
                                  :name name :d d}
                           (some? parent) (assoc :parent-id parent))])
        id  (get ids "$tmp:p")]
    (when (some? stroke)
      (apply-changes! profile file-id (set-strokes page [id] [stroke])))
    id))

(defn- interactions-fixture
  "Board A holds rect 1, board B holds rect 2. A has one interaction to a
  shape that is not on the page, rect 1 one to board B, rect 2 two to A.
  Two flows: Main starts at A, Checkout at B."
  []
  (let [{:keys [profile file-id page]} (create-file-with-page)
        ids     (apply-ops!
                 profile file-id
                 [{:op "create_board" :page-id page :id "$tmp:a" :name "Board A"
                   :x 0 :y 0 :width 200 :height 200}
                  {:op "create_board" :page-id page :id "$tmp:b" :name "Board B"
                   :x 400 :y 0 :width 200 :height 200}
                  {:op "create_rect" :page-id page :id "$tmp:r1" :parent-id "$tmp:a"
                   :name "Rect 1" :x 10 :y 10 :width 50 :height 50}
                  {:op "create_rect" :page-id page :id "$tmp:r2" :parent-id "$tmp:b"
                   :name "Rect 2" :x 410 :y 10 :width 50 :height 50}])
        a       (get ids "$tmp:a")
        b       (get ids "$tmp:b")
        r1      (get ids "$tmp:r1")
        r2      (get ids "$tmp:r2")
        missing (uuid/next)]
    (apply-ops!
     profile file-id
     [{:op "add_interaction" :page-id page :id a
       :interaction {:action-type :navigate :event-type :click :destination missing}}
      {:op "add_interaction" :page-id page :id r1
       :interaction {:action-type :navigate :event-type :click :destination b}}
      {:op "add_interaction" :page-id page :id r2
       :interaction {:action-type :open-overlay :event-type :click :destination a}}
      {:op "add_interaction" :page-id page :id r2
       :interaction {:action-type :navigate :event-type :click :destination a}}
      {:op "create_flow" :page-id page :name "Main" :starting-frame a}
      {:op "create_flow" :page-id page :name "Checkout" :starting-frame b}])
    {:profile profile
     :file-id file-id
     :page page
     :a a
     :b b
     :r1 r1
     :r2 r2}))

(defn- connector-fixture
  "Board A and board B of `pair-fixture`, with these paths on the page:
  Line, a stroked line from B's left side to A's right side; Arrow, a
  stroked line from A to B with an arrow cap at its end; Outline, a closed
  filled outline wider at B; Far, a stroked line 200 px from any board;
  Loop, a stroked line whose ends both snap to A."
  []
  (let [{:keys [profile file-id page] :as fixture} (pair-fixture)
        line    (add-path profile file-id page "Line" "M 395 50 L 205 50"
                          :stroke solid-stroke)
        arrow   (add-path profile file-id page "Arrow" "M 205 100 L 395 100"
                          :stroke (assoc solid-stroke :stroke-cap-end :line-arrow))
        outline (add-path profile file-id page "Outline"
                          "M 205 95 L 395 80 L 395 120 L 205 105 Z")
        far     (add-path profile file-id page "Far" "M 800 50 L 900 50"
                          :stroke solid-stroke)
        loop    (add-path profile file-id page "Loop" "M 205 150 L 150 150"
                          :stroke solid-stroke)]
    (assoc fixture
           :line line
           :arrow arrow
           :outline outline
           :far far
           :loop loop)))

(def ^:private filler-boards
  "Boards of the big page that hold no connector."
  1989)

(def ^:private link-count
  "Connectors of the big page, at the top level."
  10)

(defn- big-page-fixture
  "A page with 2000 boards and 300 candidate paths. 1989 filler boards sit
  on a grid, each with one small path inside it (289 of them are paths
  inside filler boards, the 290th is one too). 11 boards in a row at the top
  level have ten `Link` paths between neighbours: the ten connectors."
  []
  (let [{:keys [profile file-id page]} (create-file-with-page)
        board-op (fn [i]
                   {:op "create_board" :page-id page :id (str "$tmp:f" i)
                    :name (str "Filler " i)
                    :x (* 70 (mod i 50)) :y (* 70 (quot i 50))
                    :width 60 :height 60})
        ids      (reduce (fn [acc batch]
                           (merge acc (apply-ops! profile file-id
                                                  (mapv board-op batch))))
                         {}
                         (partition-all 500 (range filler-boards)))
        ids      (merge ids
                        (apply-ops! profile file-id
                                    (mapv (fn [k]
                                            {:op "create_board" :page-id page
                                             :id (str "$tmp:l" k)
                                             :name (str "Link board " k)
                                             :x (+ 5000 (* 200 k)) :y 5000
                                             :width 100 :height 100})
                                          (range (inc link-count)))))
        path-ops (concat
                  (for [i (range 290)
                        :let [x (* 70 (mod i 50))
                              y (* 70 (quot i 50))]]
                    {:op "create_path" :page-id page :name "Small"
                     :parent-id (get ids (str "$tmp:f" i))
                     :d (str "M " (+ x 10) " " (+ y 10) " L " (+ x 20) " " (+ y 20))})
                  (for [k (range link-count)
                        :let [x (+ 5000 (* 200 k))]]
                    {:op "create_path" :page-id page :name (str "Link " k)
                     :d (str "M " (+ x 103) " 5050 L " (+ x 197) " 5050")}))]
    (apply-ops! profile file-id (vec path-ops))
    {:profile profile
     :file-id file-id
     :page page}))

;; --- GEOMETRY (HAND-MADE NUMBERS)

(t/deftest rect-distance-is-zero-inside-and-the-gap-outside
  (t/is (== 0 (proto/rect-distance 0 0 10 10 5 5)))
  (t/is (== 0 (proto/rect-distance 0 0 10 10 10 10)) "edges count as inside")
  (t/is (== 3 (proto/rect-distance 0 0 10 10 13 4)))
  (t/is (== 5 (proto/rect-distance 0 0 10 10 13 14)) "a corner: 3-4-5")
  (t/is (== 4 (proto/rect-distance 0 0 10 10 -4 5))))

(t/deftest farthest-pair-finds-the-ends-of-a-line
  (let [p {:x 0 :y 0}
        q {:x 3 :y 4}
        r {:x 1 :y 1}]
    (t/is (= [p q] (proto/farthest-pair [p q r])))
    (t/is (= [p q] (proto/farthest-pair [r p q])) "distance, not order, decides")
    (t/is (nil? (proto/farthest-pair [p])))))

(t/deftest farthest-pair-finds-the-diagonal-of-a-square
  (let [corners [{:x 0 :y 0} {:x 10 :y 0} {:x 10 :y 10} {:x 0 :y 10} {:x 5 :y 5}]
        [p q]   (proto/farthest-pair corners)]
    (t/is (= #{{:x 0 :y 0} {:x 10 :y 10}} #{p q}))))

(t/deftest sample-points-keeps-at-most-four-hundred
  (t/is (= (range 400) (proto/sample-points (vec (range 400)))))
  (t/is (= 201 (count (proto/sample-points (vec (range 401))))))
  (t/is (= 400 (count (proto/sample-points (vec (range 800))))))
  (t/is (<= (count (proto/sample-points (vec (range 100000)))) 400)))

(t/deftest band-width-measures-the-band-only
  (let [a {:x 0 :y 0}
        b {:x 10 :y 0}
        points [{:x 5 :y 3}]]
    (t/is (== 0 (proto/band-width a b points 0.0 0.2)) "t of the point is 0.5")
    (t/is (== 3 (proto/band-width a b points 0.4 0.6)))))

(t/deftest outline-head-finds-the-wide-end
  (let [a      {:x 205 :y 95}
        b      {:x 395 :y 120}
        points [{:x 205 :y 95} {:x 395 :y 80} {:x 395 :y 120} {:x 205 :y 105}]]
    (t/is (= :b (proto/outline-head a b points)))
    (t/is (= :a (proto/outline-head b a points)) "the same head with the ends swapped")
    (t/is (nil? (proto/outline-head {:x 0 :y 0} {:x 10 :y 0}
                                    [{:x 0 :y 0} {:x 10 :y 0}]))
          "a straight line has no head")))

(t/deftest find-snap-board-prefers-the-outermost-of-the-nearest
  (let [outer (proto/->Board :outer "Outer" 0.0 0.0 200.0 200.0 40000.0 1 #{})
        inner (proto/->Board :inner "Inner" 150.0 50.0 200.0 150.0 5000.0 2 #{:outer})
        far   (proto/->Board :far "Far" 400.0 0.0 600.0 200.0 40000.0 1 #{})
        away  {:x 1e9 :y 1e9}
        snap  (proto/find-snap-board [inner far outer] #{} away away {:x 205 :y 100} 64)]
    (t/is (= :outer (:id snap)))
    (t/is (== 5 (:distance snap)) "the inner board is as near, so it ties")
    (t/is (nil? (proto/find-snap-board [far] #{} away away {:x 205 :y 100} 64)))
    (t/is (nil? (proto/find-snap-board [outer] #{} away away {:x 205 :y 100} 4)))
    (t/is (nil? (proto/find-snap-board [outer] #{:outer} away away {:x 205 :y 100} 64))
          "an excluded board is not a candidate")))

(t/deftest outermost-falls-back-to-the-largest-area
  (let [small {:id :small :area 10 :ancestors #{}}
        large {:id :large :area 50 :ancestors #{}}]
    (t/is (= :large (:id (#'proto/outermost [small large]))))))

;; --- INTERACTIONS

(t/deftest interactions-list-shapes-in-walk-order
  (let [{:keys [profile file-id page a b r1 r2]} (interactions-fixture)
        out      (call! profile :get-mcp-interactions {:file-id file-id :page-id page})
        result   (:result out)
        shapes   (:shapes result)
        flows    (:flows result)]
    (t/is (nil? (:error out)))
    (t/is (= page (:page-id result)))
    (t/is (= [a r1 r2] (map :id shapes)) "walk order: board A, its rect, then rect 2")
    (t/is (= "Board A / Rect 1" (:path (second shapes))))
    (t/is (= b (:destination (first (:interactions (second shapes))))))
    (t/is (= "Board B" (:destination-name (first (:interactions (second shapes))))))
    (t/is (not (contains? (first (:interactions (first shapes))) :destination-name))
          "a destination that is not on the page has no name")
    (t/is (= 4 (:total-interactions result)))
    (t/is (= 3 (:total-shapes result)))
    (t/is (false? (:truncated result)))
    (t/is (= ["Checkout" "Main"] (map :name flows)))
    (t/is (= [b a] (map :starting-frame flows)))
    (t/is (= ["Board B" "Board A"] (map :starting-frame-name flows)))))

(t/deftest interactions-stop-at-the-limit-and-say-so
  (let [{:keys [profile file-id page a]} (interactions-fixture)
        out (call! profile :get-mcp-interactions {:file-id file-id :page-id page :limit 1})]
    (t/is (= 1 (count (:shapes (:result out)))))
    (t/is (= a (:id (first (:shapes (:result out))))))
    (t/is (true? (:truncated (:result out))))
    (t/is (= 3 (:total-shapes (:result out))) "the totals count the whole page")))

(t/deftest interactions-stop-at-the-byte-budget
  (let [{:keys [profile file-id page]} (interactions-fixture)
        out (with-redefs [mcp/response-byte-budget 1]
              (call! profile :get-mcp-interactions {:file-id file-id :page-id page}))]
    (t/is (= 1 (count (:shapes (:result out)))))
    (t/is (true? (:truncated (:result out))))))

(t/deftest interactions-of-a-page-without-any-are-empty
  (let [{:keys [profile file-id]} (create-file-with-page)
        page2 (uuid/next)
        _     (apply-changes! profile file-id [{:type :add-page :id page2 :name "Empty"}])
        out   (call! profile :get-mcp-interactions {:file-id file-id :page-id page2})]
    (t/is (nil? (:error out)))
    (t/is (= [] (:shapes (:result out))))
    (t/is (= [] (:flows (:result out))))
    (t/is (= 0 (:total-interactions (:result out))))
    (t/is (= 0 (:total-shapes (:result out))))
    (t/is (false? (:truncated (:result out))))))

(t/deftest interactions-audit-props-name-the-file-and-page
  (let [{:keys [profile file-id page]} (interactions-fixture)
        out   (call! profile :get-mcp-interactions {:file-id file-id :page-id page})
        props (:app.loggers.audit/replace-props (meta (:result out)))]
    (t/is (= "get-mcp-interactions" (:tool props)))
    (t/is (= file-id (:file-id props)))
    (t/is (= [page] (:page-ids props)))))

(t/deftest interaction-point-reaches-the-client-as-camel-case-json
  (let [{:keys [profile file-id page]} (create-file-with-page)
        ids   (apply-ops! profile file-id
                          [{:op "create_board" :page-id page :id "$tmp:a" :name "Board A"
                            :x 0 :y 0 :width 200 :height 200}
                           {:op "create_board" :page-id page :id "$tmp:b" :name "Board B"
                            :x 400 :y 0 :width 200 :height 200}
                           {:op "create_rect" :page-id page :id "$tmp:r" :parent-id "$tmp:a"
                            :name "Trigger" :x 10 :y 10 :width 50 :height 50}])
        b     (get ids "$tmp:b")
        r     (get ids "$tmp:r")
        _     (apply-ops! profile file-id
                          [{:op "add_interaction" :page-id page :id r
                            :interaction {:action-type :open-overlay
                                          :event-type :click
                                          :destination b
                                          :overlay-position {:x 10 :y 20}}}])
        out   (call! profile :get-mcp-interactions {:file-id file-id :page-id page})
        reply (over-http (:result out))
        shape (first (filter #(= "Trigger" (get % "name")) (get reply "shapes")))
        pos   (get-in shape ["interactions" 0 "overlayPosition"])]
    (t/is (nil? (:error out)))
    (t/is (some? pos) "the point survives the writer under its camel-case key")
    (t/is (== 10 (get pos "x")))
    (t/is (== 20 (get pos "y")))
    (t/is (= (str b) (get-in shape ["interactions" 0 "destination"])))
    (t/is (= "Board B" (get-in shape ["interactions" 0 "destinationName"])))))

;; --- CONNECTORS: GEOMETRY ON THE PAGE

(t/deftest connectors-find-the-lines-between-boards
  (let [{:keys [profile file-id page a b]} (connector-fixture)
        out     (find-connectors profile file-id page)
        result  (:result out)
        conns   (:connectors result)
        line    (by-name "Line" conns)
        arrow   (by-name "Arrow" conns)
        outline (by-name "Outline" conns)]
    (t/is (nil? (:error out)))
    (t/is (= #{:revn :page-id :scanned :connectors :truncated} (set (keys result))))
    (t/is (= 5 (:scanned result)) "five candidate paths were looked at")
    (t/is (false? (:truncated result)))
    (t/is (= ["Line" "Arrow" "Outline"] (map :name conns)))

    ;; a plain line: no head, the left end is `from`
    (t/is (= "none" (:direction line)))
    (t/is (= :path (:type line)))
    (t/is (== 190 (:length line)))
    (t/is (= a (get-in line [:from :board-id])))
    (t/is (= "Board A" (get-in line [:from :board-name])))
    (t/is (== 5 (get-in line [:from :distance])))
    (t/is (== 205 (get-in line [:from :x])))
    (t/is (== 50 (get-in line [:from :y])))
    (t/is (= b (get-in line [:to :board-id])))
    (t/is (== 5 (get-in line [:to :distance])))
    (t/is (== 395 (get-in line [:to :x])))

    ;; an arrow cap at the end: that end is `to`
    (t/is (= "cap" (:direction arrow)))
    (t/is (= b (get-in arrow [:to :board-id])))
    (t/is (== 395 (get-in arrow [:to :x])))
    (t/is (= a (get-in arrow [:from :board-id])))

    ;; a closed outline wider at B: B is the head
    (t/is (= "shape" (:direction outline)))
    (t/is (= b (get-in outline [:to :board-id])))
    (t/is (= a (get-in outline [:from :board-id])))
    (t/is (== 395 (get-in outline [:to :x])))
    (t/is (== 80 (get-in outline [:to :y])))
    (t/is (< 191.6 (:length outline) 191.7))))

(t/deftest connectors-use-the-true-box-of-a-rotated-board
  (let [{:keys [profile file-id page]} (pair-fixture)
        turned (get (apply-ops! profile file-id
                                [{:op "create_board" :page-id page :id "$tmp:t"
                                  :name "Turned" :x 0 :y 0 :width 400 :height 100}])
                    "$tmp:t")
        _      (apply-ops! profile file-id
                           [{:op "update_shape" :page-id page :id turned
                             :props {:rotation 90}}])
        ;; turned a quarter turn about (200, 50), the board covers x 150..250, y -150..250
        _      (add-path profile file-id page "Near" "M 200 255 L 450 100")
        _      (add-path profile file-id page "Far Corner" "M 300 -100 L 450 100")
        _      (add-path profile file-id page "Empty" "M 80 -100 L 450 100")
        out    (find-connectors profile file-id page)
        conns  (:connectors (:result out))
        near   (by-name "Near" conns)
        corner (by-name "Far Corner" conns)]
    (t/is (nil? (:error out)))
    (t/is (= turned (get-in near [:from :board-id])) "the bottom edge of the turned board")
    (t/is (near? 5 (get-in near [:from :distance])))
    (t/is (near? 200 (get-in near [:from :x])))
    (t/is (= turned (get-in corner [:from :board-id])))
    (t/is (near? 50 (get-in corner [:from :distance])) "empty canvas is not inside the board")
    (t/is (nil? (by-name "Empty" conns)) "100 px from the turned board's edge")))

(t/deftest connectors-skip-far-and-same-board-paths
  (let [{:keys [profile file-id page]} (connector-fixture)
        out   (find-connectors profile file-id page)
        names (set (map :name (:connectors (:result out))))]
    (t/is (not (contains? names "Far")) "200 px from any board")
    (t/is (not (contains? names "Loop")) "both ends snap to board A")))

(t/deftest connectors-honour-max-distance
  (let [{:keys [profile file-id page]} (connector-fixture)
        near (find-connectors profile file-id page :max-distance 4)
        wide (find-connectors profile file-id page :max-distance 6)]
    (t/is (empty? (:connectors (:result near))) "the ends are 5 px from the boards")
    (t/is (= 3 (count (:connectors (:result wide)))))))

(t/deftest connectors-stop-at-the-limit-and-say-so
  (let [{:keys [profile file-id page]} (connector-fixture)
        out (find-connectors profile file-id page :limit 1)]
    (t/is (= 1 (count (:connectors (:result out)))))
    (t/is (true? (:truncated (:result out))))))

(t/deftest connectors-stop-at-the-time-budget-and-say-so
  (let [{:keys [profile file-id page]} (connector-fixture)
        out (with-redefs [proto/search-budget-ns 0]
              (find-connectors profile file-id page))]
    (t/is (true? (:truncated (:result out))))
    (t/is (= 0 (:scanned (:result out))))))

(t/deftest connectors-are-found-inside-a-container-that-holds-both-boards
  (let [{:keys [profile file-id page]} (create-file-with-page)
        ids      (apply-ops!
                  profile file-id
                  [{:op "create_board" :page-id page :id "$tmp:c" :name "Container"
                    :x -50 :y -50 :width 700 :height 300}
                   {:op "create_board" :page-id page :id "$tmp:a" :name "Board A"
                    :parent-id "$tmp:c" :x 0 :y 0 :width 200 :height 200}
                   {:op "create_board" :page-id page :id "$tmp:b" :name "Board B"
                    :parent-id "$tmp:c" :x 400 :y 0 :width 200 :height 200}])
        a        (get ids "$tmp:a")
        b        (get ids "$tmp:b")
        _        (add-path profile file-id page "Line" "M 395 50 L 205 50"
                           :parent (get ids "$tmp:c") :stroke solid-stroke)
        out      (find-connectors profile file-id page)
        line     (by-name "Line" (:connectors (:result out)))]
    (t/is (some? line) "the container is excluded, the boards connect")
    (t/is (= a (get-in line [:from :board-id])))
    (t/is (= b (get-in line [:to :board-id])))))

(t/deftest connectors-take-the-outermost-of-nested-frames-at-one-end
  (let [{:keys [profile file-id page]} (create-file-with-page)
        _     (apply-ops!
               profile file-id
               [{:op "create_board" :page-id page :id "$tmp:outer" :name "Outer"
                 :x 0 :y 0 :width 200 :height 200}
                {:op "create_board" :page-id page :id "$tmp:inner" :name "Inner"
                 :parent-id "$tmp:outer" :x 150 :y 50 :width 50 :height 100}
                {:op "create_board" :page-id page :id "$tmp:b" :name "Board B"
                 :x 400 :y 0 :width 200 :height 200}])
        _     (add-path profile file-id page "Line" "M 205 100 L 395 100"
                        :stroke solid-stroke)
        out   (find-connectors profile file-id page)
        line  (by-name "Line" (:connectors (:result out)))]
    (t/is (some? line))
    (t/is (= "Outer" (get-in line [:from :board-name]))
          "the inner frame is 5 px away as well, the outer one wins")
    (t/is (== 5 (get-in line [:from :distance])))))

;; --- CONNECTORS: RULES

(t/deftest connectors-direction-cap-at-the-start-puts-that-end-in-to
  (let [{:keys [profile file-id page a b]} (pair-fixture)
        _     (add-path profile file-id page "Start" "M 395 50 L 205 50"
                        :stroke (assoc solid-stroke :stroke-cap-start :line-arrow))
        out   (find-connectors profile file-id page)
        conn  (by-name "Start" (:connectors (:result out)))]
    (t/is (= "cap" (:direction conn)))
    (t/is (= b (get-in conn [:to :board-id])) "the cap is on the first point, on B's side")
    (t/is (= a (get-in conn [:from :board-id])))))

(t/deftest connectors-cap-applies-to-open-paths-only
  (let [{:keys [profile file-id page]} (pair-fixture)
        _     (add-path profile file-id page "Closed"
                        "M 205 95 L 395 80 L 395 120 L 205 105 Z"
                        :stroke (assoc solid-stroke :stroke-cap-end :line-arrow))
        out   (find-connectors profile file-id page)
        conn  (by-name "Closed" (:connectors (:result out)))]
    (t/is (some? conn))
    (t/is (not= "cap" (:direction conn)) "a closed path gets no cap direction")
    (t/is (= "shape" (:direction conn)))))

(t/deftest connectors-direction-none-breaks-a-tie-on-x-by-the-upper-end
  (let [{:keys [profile file-id page a]} (pair-fixture)
        d     (apply-ops! profile file-id
                          [{:op "create_board" :page-id page :id "$tmp:d" :name "Board D"
                            :x 150 :y 300 :width 150 :height 100}])
        dd    (get d "$tmp:d")
        _     (add-path profile file-id page "Tie" "M 205 50 L 205 305"
                        :stroke solid-stroke)
        out   (find-connectors profile file-id page)
        conn  (by-name "Tie" (:connectors (:result out)))]
    (t/is (= "none" (:direction conn)))
    (t/is (= a (get-in conn [:from :board-id])) "equal x: the upper end is from")
    (t/is (== 50 (get-in conn [:from :y])))
    (t/is (= dd (get-in conn [:to :board-id])))))

(t/deftest connectors-sample-an-outline-above-the-cap
  (let [{:keys [profile file-id page a b]} (pair-fixture)
        top     (for [i (range 381)] (str "L " (+ 205 (* 0.5 i)) " 99"))
        bottom  (for [i (range 380 -1 -1)] (str "L " (+ 205 (* 0.5 i)) " 101"))
        d       (str "M 205 99 " (str/join " " (concat (rest top) bottom)) " Z")
        _       (add-path profile file-id page "Long" d)
        out     (find-connectors profile file-id page)
        conn    (by-name "Long" (:connectors (:result out)))]
    (t/is (nil? (:error out)))
    (t/is (some? conn) "762 points, more than the cap, still connect")
    (t/is (= a (get-in conn [:from :board-id])))
    (t/is (= b (get-in conn [:to :board-id])))))

(t/deftest connectors-skip-a-child-of-its-own-board-and-count-it
  (let [{:keys [profile file-id page a b]} (pair-fixture)
        child  (apply-ops! profile file-id
                           [{:op "create_path" :page-id page :id "$tmp:c" :name "Child"
                             :parent-id a :d "M 395 50 L 205 50"}])
        _      (apply-changes! profile file-id
                               (set-strokes page [(get child "$tmp:c")] [solid-stroke]))
        _      (add-path profile file-id page "Root" "M 395 50 L 205 50"
                         :stroke solid-stroke)
        inside (apply-ops! profile file-id
                           [{:op "create_path" :page-id page :id "$tmp:i" :name "Inside"
                             :parent-id a :d "M 10 10 L 190 190"}])
        _      (apply-changes! profile file-id
                               (set-strokes page [(get inside "$tmp:i")] [solid-stroke]))
        out    (find-connectors profile file-id page)
        conns  (:connectors (:result out))]
    (t/is (= ["Root"] (map :name conns)) "a child of A cannot connect A to B")
    (t/is (= 3 (:scanned (:result out))) "the skipped child still counts as scanned")
    (t/is (nil? (by-name "Inside" conns)))
    (t/is (= b (get-in (first conns) [:to :board-id])))))

(t/deftest connectors-left-out-when-hidden-or-under-a-hidden-ancestor
  (let [{:keys [profile file-id page]} (pair-fixture)
        hidden (add-path profile file-id page "Hidden" "M 205 60 L 395 60"
                         :stroke solid-stroke)
        _      (apply-changes! profile file-id [(set-attr page hidden :hidden true)])
        zone   (apply-ops! profile file-id
                           [{:op "create_board" :page-id page :id "$tmp:z" :name "Zone"
                             :x 0 :y 300 :width 200 :height 100}])
        zone-id (get zone "$tmp:z")
        _      (apply-changes! profile file-id [(set-attr page zone-id :hidden true)])
        under  (apply-ops! profile file-id
                           [{:op "create_path" :page-id page :id "$tmp:u" :name "Under"
                             :parent-id zone-id :d "M 205 150 L 395 150"}])
        _      (apply-changes! profile file-id
                               (set-strokes page [(get under "$tmp:u")] [solid-stroke]))
        shown  (add-path profile file-id page "Shown" "M 205 120 L 395 120"
                         :stroke solid-stroke)
        out    (find-connectors profile file-id page)
        conns  (:connectors (:result out))]
    (t/is (nil? (by-name "Hidden" conns)) "a hidden candidate is not a candidate")
    (t/is (nil? (by-name "Under" conns)) "a candidate under a hidden ancestor is not one")
    (t/is (some? (by-name "Shown" conns)) "the visible control connects")
    (t/is (= 1 (:scanned (:result out))) "only the visible candidate was scanned")
    (t/is (some? shown))))

(t/deftest connectors-skip-a-hidden-board-and-a-board-under-a-hidden-ancestor
  (let [{:keys [profile file-id page b]} (pair-fixture)
        _    (apply-changes! profile file-id [(set-attr page b :hidden true)])
        _    (add-path profile file-id page "Line" "M 205 50 L 395 50" :stroke solid-stroke)
        out  (find-connectors profile file-id page)]
    (t/is (empty? (:connectors (:result out))) "a hidden board does not snap")))

(t/deftest connectors-skip-a-board-whose-ancestor-is-hidden
  (let [{:keys [profile file-id page]} (create-file-with-page)
        ids   (apply-ops!
               profile file-id
               [{:op "create_board" :page-id page :id "$tmp:a" :name "Board A"
                 :x 0 :y 0 :width 200 :height 200}
                {:op "create_board" :page-id page :id "$tmp:z" :name "Zone"
                 :x 380 :y -20 :width 240 :height 240}
                {:op "create_board" :page-id page :id "$tmp:n" :name "Nested"
                 :parent-id "$tmp:z" :x 400 :y 0 :width 200 :height 200}])
        zone  (get ids "$tmp:z")
        _     (apply-changes! profile file-id [(set-attr page zone :hidden true)])
        _     (add-path profile file-id page "Line" "M 205 50 L 395 50" :stroke solid-stroke)
        out   (find-connectors profile file-id page)]
    (t/is (empty? (:connectors (:result out)))
          "the nested board is under a hidden zone, so it is no board")))

(t/deftest connectors-leave-out-the-children-of-a-boolean
  (let [{:keys [profile file-id page]} (pair-fixture)
        one    (add-path profile file-id page "Line One" "M 205 50 L 395 50"
                         :stroke solid-stroke)
        two    (add-path profile file-id page "Line Two" "M 205 60 L 395 60"
                         :stroke solid-stroke)
        _      (apply-ops! profile file-id
                           [{:op "create_boolean" :page-id page :id "$tmp:bool"
                             :name "Union" :bool-type :union
                             :child-ids [one two]}])
        out    (find-connectors profile file-id page)
        names  (map :name (:connectors (:result out)))]
    (t/is (nil? (:error out)))
    (t/is (not-any? #{"Line One" "Line Two"} names) "children of a boolean are not drawn")
    (t/is (= (count names) (count (distinct names))) "no connector is reported twice")))

(t/deftest connectors-within-id-limits-the-candidates
  (let [{:keys [profile file-id page a]} (connector-fixture)
        inside (add-path profile file-id page "Inside" "M 10 10 L 190 190"
                         :parent a :stroke solid-stroke)
        out    (find-connectors profile file-id page :within-id a)
        err    (find-connectors profile file-id page :within-id (uuid/next))]
    (t/is (nil? (:error out)))
    (t/is (= 1 (:scanned (:result out))) "only the path under A is a candidate")
    (t/is (empty? (:connectors (:result out))))
    (t/is (some? inside))
    (t/is (= :shape-not-found (th/ex-code (:error err))))))

;; --- BOTH COMMANDS

(t/deftest interactions-and-connectors-refuse-a-profile-without-access
  (let [{:keys [file-id page]} (connector-fixture)
        outsider (th/create-profile* 2 {:is-active true})]
    (doseq [method [:get-mcp-interactions :find-mcp-connectors]]
      (let [out (call! outsider method {:file-id file-id :page-id page})]
        (t/is (some? (:error out)) (str method))
        (t/is (= :not-found (th/ex-type (:error out))) (str method))))))

(t/deftest both-commands-report-a-switched-off-profile
  (let [{:keys [profile file-id page]} (connector-fixture)]
    (db/tx-run! th/*system*
                (fn [cfg]
                  (profile/update-profile-props cfg (:id profile) {:mcp-enabled false})))
    (doseq [method [:get-mcp-interactions :find-mcp-connectors]]
      (let [out (call! profile method {:file-id file-id :page-id page})]
        (t/is (= :mcp-disabled (th/ex-code (:error out))) (str method))))))

;; --- BIG PAGE: COST AND BUDGET

(t/deftest big-page-finds-the-ten-links-well-inside-the-budget
  (let [{:keys [profile file-id page]} (big-page-fixture)
        started (System/nanoTime)
        out     (find-connectors profile file-id page)
        ms      (/ (- (System/nanoTime) started) 1000000.0)
        result  (:result out)]
    (println "find-mcp-connectors on 2000 boards and 300 candidates:" ms "ms")
    (t/is (nil? (:error out)))
    (t/is (= (set (map #(str "Link " %) (range link-count)))
             (set (map :name (:connectors result)))))
    (t/is (= 300 (:scanned result)))
    (t/is (false? (:truncated result)))
    (t/is (< ms 4000.0))

    ;; a budget of two milliseconds stops the scan inside the loop
    (let [cut (with-redefs [proto/search-budget-ns 2000000]
                (find-connectors profile file-id page))]
      (t/is (true? (:truncated (:result cut))))
      (t/is (< (:scanned (:result cut)) 300)))))
