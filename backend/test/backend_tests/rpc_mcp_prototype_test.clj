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
   [backend-tests.rpc-mcp-connector-geometry-test :as geom]
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

(defn- snap
  "`find-snap-board` over a grid built for `boards` and `max-distance`."
  [boards excluded a b p max-distance]
  (proto/find-snap-board (proto/build-board-index boards max-distance)
                         excluded a b p max-distance))

(t/deftest find-snap-board-prefers-the-outermost-of-the-nearest
  (let [outer (proto/->Board :outer "Outer" 0.0 0.0 200.0 200.0 40000.0 1 #{})
        inner (proto/->Board :inner "Inner" 150.0 50.0 200.0 150.0 5000.0 2 #{:outer})
        far   (proto/->Board :far "Far" 400.0 0.0 600.0 200.0 40000.0 1 #{})
        away  {:x 1e9 :y 1e9}
        found (snap [inner far outer] #{} away away {:x 205 :y 100} 64)]
    (t/is (= :outer (:id found)))
    (t/is (== 5 (:distance found)) "the inner board is as near, so it ties")
    (t/is (nil? (snap [far] #{} away away {:x 205 :y 100} 64)))
    (t/is (nil? (snap [outer] #{} away away {:x 205 :y 100} 4)))
    (t/is (nil? (snap [outer] #{:outer} away away {:x 205 :y 100} 64))
          "an excluded board is not a candidate")))

(defn- random-boards
  "`n` boards in a 6000 by 6000 area, from the generator `rnd`: sizes from 20
  to 620 px, one in 40 up to 3000 wide, one oversized (so that it is kept in
  the list of big boards), and ancestors drawn from the boards before them."
  [^java.util.Random rnd n]
  (let [ids (vec (repeatedly n uuid/next))]
    (into []
          (map (fn [i]
                 (let [x  (* 6000.0 (.nextDouble rnd))
                       y  (* 6000.0 (.nextDouble rnd))
                       w  (if (zero? (.nextInt rnd 40)) 3000.0 (+ 20.0 (* 600.0 (.nextDouble rnd))))
                       h  (+ 20.0 (* 600.0 (.nextDouble rnd)))
                       big? (= i 7)
                       x2 (if big? (+ x 90000.0) (+ x w))
                       y2 (if big? (+ y 90000.0) (+ y h))
                       up (when (and (pos? i) (zero? (.nextInt rnd 3)))
                            (nth ids (.nextInt rnd i)))]
                   (proto/->Board (nth ids i) (str "B" i) x y x2 y2
                                  (* (- x2 x) (- y2 y)) (if up 2 1)
                                  (if up #{up} #{})))))
          (range n))))

(t/deftest the-grid-chooses-the-board-the-plain-loop-chooses
  (let [rnd    (java.util.Random. 20260611)
        boards (random-boards rnd 400)
        point  (fn [] {:x (* 6000.0 (.nextDouble rnd)) :y (* 6000.0 (.nextDouble rnd))})
        pick   (fn [] (nth boards (.nextInt rnd (count boards))))]
    (doseq [md [4 64 300]]
      (let [index (proto/build-board-index boards md)
            found (atom 0)]
        (dotimes [_ 600]
          (let [a (point)
                b (point)
                p (if (zero? (.nextInt rnd 2)) a b)
                excluded (cond-> #{} (zero? (.nextInt rnd 3)) (conj (:id (pick))))
                plain (#'proto/snap-among boards excluded a b p md)
                grid  (proto/find-snap-board index excluded a b p md)]
            (when (some? plain) (swap! found inc))
            (t/is (= plain grid) (str "md " md " at " p))))
        (t/is (< 50 @found) (str "md " md ": the points find boards, so the test means something"))))))

(t/deftest the-grid-holds-boards-that-cover-many-cells-and-boards-at-the-edges
  (let [huge   (proto/->Board :huge "Huge" -50000.0 -50000.0 50000.0 50000.0 1.0e10 1 #{})
        small  (proto/->Board :small "Small" 100.0 100.0 200.0 200.0 10000.0 2 #{:huge})
        index  (proto/build-board-index [small huge] 64)
        away   {:x 1e9 :y 1e9}]
    (t/is (= 1 (count (:big index))) "the huge board is in the list of big ones")
    (t/is (= :huge (:id (proto/find-snap-board index #{} away away {:x 150 :y 150} 64)))
          "the outermost of the tied boards")
    (t/is (= :huge (:id (proto/find-snap-board index #{} away away {:x 20000 :y 20000} 64))))
    ;; a point exactly `max-distance` from the board, on a cell border
    (t/is (= :small (:id (proto/find-snap-board index #{:huge} away away {:x 264 :y 150} 64))))
    (t/is (nil? (proto/find-snap-board index #{:huge} away away {:x 264.5 :y 150} 64)))))

(t/deftest finding-the-board-of-thousands-of-ends-costs-little
  ;; 3,000 frames and 6,000 ends. The plain loop took 3.95 s here before the
  ;; grid (12,000 frames and 24,000 ends took 52 s).
  (let [boards (vec (for [i (range 3000)]
                      (let [x (* 1000.0 (mod i 30))
                            y (* 800.0 (quot i 30))]
                        (proto/->Board (uuid/next) "b" x y (+ x 800) (+ y 600) 480000.0 2 #{}))))
        rnd    (java.util.Random. 7)
        points (vec (for [_ (range 6000)]
                      {:x (* 30000.0 (.nextDouble rnd)) :y (* 80000.0 (.nextDouble rnd))}))
        t0     (System/nanoTime)
        plain  (mapv #(#'proto/snap-among boards #{} % % % 64) points)
        t1     (System/nanoTime)
        index  (proto/build-board-index boards 64)
        grid   (mapv #(proto/find-snap-board index #{} % % % 64) points)
        t2     (System/nanoTime)
        plain-ms (/ (- t1 t0) 1000000.0)
        grid-ms  (/ (- t2 t1) 1000000.0)]
    (println "snap of 6000 ends over 3000 frames: plain loop" plain-ms "ms, grid with its build" grid-ms "ms")
    (t/is (= plain grid))
    (t/is (< grid-ms 1000.0))))

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
    (t/is (= #{:revn :page-id :scanned :connectors :total :truncated :selection
               :same-screen-skipped :non-screen-ends}
             (disj (set (keys result)) :deeper-boards))
          "`deeper-boards` is not pinned: it follows `select-boards`")
    (t/is (= 0 (:same-screen-skipped result)))
    (t/is (= 0 (:non-screen-ends result)))
    (t/is (= "auto" (get-in result [:selection :mode])))
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
    (t/is (= "high" (:confidence arrow)))
    (t/is (= "none" (:confidence outline)) "no head tip, and no width test: direction none")
    (t/is (= "none" (:confidence line)))
    (t/is (= b (get-in arrow [:to :board-id])))
    (t/is (== 395 (get-in arrow [:to :x])))
    (t/is (= a (get-in arrow [:from :board-id])))

    ;; a closed outline wider at B: no head is read, so the left end is `from`
    (t/is (= "none" (:direction outline)))
    (t/is (= b (get-in outline [:to :board-id])))
    (t/is (= a (get-in outline [:from :board-id])))
    (t/is (== 395 (get-in outline [:to :x])))
    (t/is (contains? #{80.0 120.0} (double (get-in outline [:to :y]))) "one of the two corners at B")
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

(t/deftest connectors-walk-with-offset-and-limit
  (let [{:keys [profile file-id page]} (connector-fixture)
        whole (:result (find-connectors profile file-id page))
        page* (fn [offset]
                (:result (find-connectors profile file-id page :limit 2 :offset offset)))
        pages (take-while some?
                          (iterate (fn [r] (when-let [n (:next-offset r)] (page* n)))
                                   (page* 0)))]
    (t/is (= 3 (:total whole)))
    (t/is (nil? (:next-offset whole)))
    (t/is (= [2 1] (map (comp count :connectors) pages)))
    (t/is (= (map :id (:connectors whole)) (mapcat #(map :id (:connectors %)) pages))
          "each connector once, in the order of one unbounded call")
    (t/is (= [2 nil] (map :next-offset pages)))
    (t/is (= [true false] (map :truncated pages)))
    (t/is (every? #(= 3 (:total %)) pages))
    (t/is (every? #(= (:scanned whole) (:scanned %)) pages))))

(t/deftest connectors-a-time-cut-gives-no-next-offset
  (let [{:keys [profile file-id page]} (connector-fixture)
        select (requiring-resolve 'app.rpc.mcp-boards/select-boards)
        orig   @select
        out    (with-redefs-fn {select (fn [& args] (assoc (apply orig args) :timed-out? true))}
                 #(find-connectors profile file-id page :limit 1))
        result (:result out)]
    (t/is (nil? (:error out)))
    (t/is (= 1 (count (:connectors result))))
    (t/is (= 3 (:total result)))
    (t/is (true? (:truncated result)))
    (t/is (true? (:timed-out result)))
    (t/is (not (contains? result :next-offset)))))

(t/deftest connectors-offset-past-the-end-gives-an-empty-list
  (let [{:keys [profile file-id page]} (connector-fixture)
        out    (find-connectors profile file-id page :offset 40)
        result (:result out)]
    (t/is (nil? (:error out)))
    (t/is (empty? (:connectors result)))
    (t/is (= 3 (:total result)))
    (t/is (false? (:truncated result)))
    (t/is (not (contains? result :next-offset)))))

(t/deftest connectors-stop-at-the-time-budget-and-say-so
  (let [{:keys [profile file-id page]} (connector-fixture)
        out (with-redefs [proto/search-budget-ns 0]
              (find-connectors profile file-id page))]
    (t/is (true? (:truncated (:result out))))
    (t/is (true? (:timed-out (:result out))))
    (t/is (not (contains? (:result out) :next-offset)) "a time cut cannot be continued")
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
        ;; the auto selection takes only the container, so A and B would be
        ;; one screen: depth 2 selects the container and both boards
        out      (find-connectors profile file-id page :depth 2)
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
    (t/is (= "none" (:direction conn)) "no head tip, and no width test: direction none")))

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
    ;; A is an ancestor of Child, so the end at A snaps to no frame; the screen of
    ;; that end stands in for it, and Child joins A and B (since the arrow drawn
    ;; inside a screen is found). Inside has both ends in A and is left out.
    (t/is (= ["Root" "Child"] (map :name conns)))
    (t/is (= 3 (:scanned (:result out))) "the skipped child still counts as scanned")
    (t/is (nil? (by-name "Inside" conns)))
    (t/is (= b (get-in (first conns) [:to :board-id])))
    (let [c (by-name "Child" conns)]
      (t/is (= a (get-in c [:from :board-id])) "the screen A stands in for the frame")
      (t/is (= "Board A" (get-in c [:from :board-name])))
      (t/is (= b (get-in c [:to :board-id]))))))

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

;; --- CONNECTORS: SCREENS

(defn- screens-fixture
  "A section (0..3000 by 0..900) that holds three screens of 800 by 600: Screen 1
  (x 0), Screen 2 (x 900) and Screen 3 (x 1800). Screen 1 holds two nested
  frames, Header (y 0..100) and Body (y 150..550). Decision is a frame of
  the section outside any screen (x 100..250, y 650..800). The auto selection
  takes the three screens."
  []
  (let [{:keys [profile file-id page]} (create-file-with-page)
        ids (apply-ops!
             profile file-id
             [{:op "create_board" :page-id page :id "$tmp:sec" :name "Section"
               :x 0 :y 0 :width 3000 :height 900}
              {:op "create_board" :page-id page :id "$tmp:s1" :name "Screen 1"
               :parent-id "$tmp:sec" :x 0 :y 0 :width 800 :height 600}
              {:op "create_board" :page-id page :id "$tmp:s2" :name "Screen 2"
               :parent-id "$tmp:sec" :x 900 :y 0 :width 800 :height 600}
              {:op "create_board" :page-id page :id "$tmp:s3" :name "Screen 3"
               :parent-id "$tmp:sec" :x 1800 :y 0 :width 800 :height 600}
              {:op "create_board" :page-id page :id "$tmp:head" :name "Header"
               :parent-id "$tmp:s1" :x 0 :y 0 :width 800 :height 100}
              {:op "create_board" :page-id page :id "$tmp:body" :name "Body"
               :parent-id "$tmp:s1" :x 0 :y 150 :width 800 :height 400}
              {:op "create_board" :page-id page :id "$tmp:dec" :name "Decision"
               :parent-id "$tmp:sec" :x 100 :y 650 :width 150 :height 150}])]
    {:profile profile
     :file-id file-id
     :page    page
     :sec     (get ids "$tmp:sec")
     :s1      (get ids "$tmp:s1")
     :s2      (get ids "$tmp:s2")
     :s3      (get ids "$tmp:s3")
     :head    (get ids "$tmp:head")
     :body    (get ids "$tmp:body")
     :dec     (get ids "$tmp:dec")}))

(t/deftest connectors-between-two-screens-carry-the-screen-keys-and-the-selection
  (let [{:keys [profile file-id page s1 s2]} (screens-fixture)
        _      (add-path profile file-id page "Link" "M 795 300 L 905 300"
                         :stroke (assoc solid-stroke :stroke-cap-end :line-arrow))
        out    (find-connectors profile file-id page)
        result (:result out)
        link   (by-name "Link" (:connectors result))]
    (t/is (nil? (:error out)))
    (t/is (= "auto" (get-in result [:selection :mode])))
    (t/is (= "standard-size" (get-in result [:selection :basis])))
    (t/is (= 3 (get-in result [:selection :boards])))
    (t/is (= 1 (count (:connectors result))))
    (t/is (= "cap" (:direction link)))
    (t/is (= s1 (get-in link [:from :screen-id])))
    (t/is (= "Screen 1" (get-in link [:from :screen-name])))
    (t/is (= s2 (get-in link [:to :screen-id])))
    (t/is (= "Screen 2" (get-in link [:to :screen-name])))
    (t/is (= s1 (get-in link [:from :board-id])) "the frame is the outermost of the near ones, the screen")
    (t/is (not (contains? (:from link) :non-screen)))
    (t/is (not (contains? link :same-screen)))
    (t/is (not (contains? link :composed)))
    (t/is (= 0 (:same-screen-skipped result)))
    (t/is (= 0 (:non-screen-ends result)))))

(t/deftest a-divider-between-nested-frames-of-one-screen-is-skipped-and-counted
  (let [{:keys [profile file-id page s1 head body]} (screens-fixture)
        _       (add-path profile file-id page "Divider" "M 400 120 L 400 160"
                          :parent s1 :stroke solid-stroke)
        _       (add-path profile file-id page "Link" "M 795 300 L 905 300"
                          :stroke solid-stroke)
        dropped (:result (find-connectors profile file-id page))
        kept    (:result (find-connectors profile file-id page :include-same-screen true))
        divider (by-name "Divider" (:connectors kept))]
    (t/is (= ["Link"] (map :name (:connectors dropped))))
    (t/is (= 1 (:same-screen-skipped dropped)))
    (t/is (= 2 (:scanned dropped)))
    (t/is (= #{"Divider" "Link"} (set (map :name (:connectors kept)))))
    (t/is (= 0 (:same-screen-skipped kept)))
    (t/is (true? (:same-screen divider)))
    (t/is (not (contains? (by-name "Link" (:connectors kept)) :same-screen)))
    (t/is (= head (get-in divider [:from :board-id])) "the frames stay the snapped frames")
    (t/is (= body (get-in divider [:to :board-id])))
    (t/is (= s1 (get-in divider [:from :screen-id])))
    (t/is (= s1 (get-in divider [:to :screen-id])))))

(t/deftest an-arrow-to-a-decision-frame-outside-any-screen-has-a-non-screen-end
  (let [{:keys [profile file-id page s1 dec]} (screens-fixture)
        _      (add-path profile file-id page "To Decision" "M 100 590 L 175 660"
                         :stroke solid-stroke)
        out    (find-connectors profile file-id page)
        result (:result out)
        conn   (first (:connectors result))]
    (t/is (= 1 (count (:connectors result))))
    (t/is (= s1 (get-in conn [:from :screen-id])))
    (t/is (= dec (get-in conn [:to :board-id])))
    (t/is (true? (get-in conn [:to :non-screen])))
    (t/is (not (contains? (:to conn) :screen-id)))
    (t/is (not (contains? (:to conn) :screen-name)))
    (t/is (= 1 (:non-screen-ends result)))
    (t/is (= 0 (:same-screen-skipped result)))))

(t/deftest selection-parameters-change-the-screens
  (let [{:keys [profile file-id page s1 s2 head body]} (screens-fixture)
        _       (add-path profile file-id page "Divider" "M 400 120 L 400 160"
                          :parent s1 :stroke solid-stroke)
        _       (add-path profile file-id page "Link" "M 795 300 L 905 300"
                          :stroke solid-stroke)
        names   (fn [out] (set (map :name (:connectors (:result out)))))
        d2      (find-connectors profile file-id page :depth 2)
        d3      (find-connectors profile file-id page :depth 3)
        d1      (find-connectors profile file-id page :mode :depth)
        bad     (find-connectors profile file-id page :mode :auto :depth 2)
        rx      (find-connectors profile file-id page :mode :auto :board-name-regex "^Screen 1$")
        rx-link (by-name "Link" (:connectors (:result rx)))]
    (t/is (= "depth" (get-in d2 [:result :selection :mode])))
    (t/is (= 2 (get-in d2 [:result :selection :depth])))
    (t/is (= 5 (get-in d2 [:result :selection :boards])) "the section, three screens and Decision")
    (t/is (= #{"Link"} (names d2)) "Header and Body lie in Screen 1")
    (t/is (= 1 (get-in d2 [:result :same-screen-skipped])))
    (t/is (= s2 (get-in (first (:connectors (:result d2))) [:to :screen-id])))
    (t/is (= #{"Link" "Divider"} (names d3)) "at depth 3 Header and Body are screens")
    (t/is (= 0 (get-in d3 [:result :same-screen-skipped])))
    (let [divider (by-name "Divider" (:connectors (:result d3)))]
      (t/is (= head (get-in divider [:from :screen-id])))
      (t/is (= body (get-in divider [:to :screen-id]))))
    (t/is (= "depth" (get-in d1 [:result :selection :mode])))
    (t/is (= #{} (names d1)) "depth 1 is the section: everything lies in one screen")
    (t/is (= 2 (get-in d1 [:result :same-screen-skipped])))
    (t/is (= :mcp-invalid-board-selection (th/ex-code (:error bad))))
    (t/is (= 1 (get-in rx [:result :selection :boards])))
    (t/is (= s1 (get-in rx-link [:from :screen-id])))
    (t/is (true? (get-in rx-link [:to :non-screen])) "Screen 2 is not selected")
    (t/is (= 1 (get-in rx [:result :non-screen-ends])))))

(t/deftest a-shape-inside-a-frame-with-no-frame-is-left-out-and-not-counted
  (let [{:keys [profile file-id page s2]} (screens-fixture)
        leaf (get (apply-ops! profile file-id
                              [{:op "create_board" :page-id page :id "$tmp:leaf" :name "Leaf"
                                :parent-id s2 :x 1000 :y 100 :width 200 :height 100}])
                  "$tmp:leaf")
        _    (add-path profile file-id page "Inside Leaf" "M 1010 150 L 1190 150"
                       :parent leaf :stroke solid-stroke)
        out  (find-connectors profile file-id page :include-same-screen true)]
    (t/is (nil? (:error out)))
    (t/is (empty? (:connectors (:result out))))
    (t/is (= 0 (:same-screen-skipped (:result out))))
    (t/is (= 1 (:scanned (:result out))))))

(defn- margin-wrappers-fixture
  "Three wrappers of `w` by `h` (1000 by 800) at x 0, 2000 and 4000, each
  around a screen of 800 by 600 at the offset `dx` `dy`. With `overlay?` each
  wrapper also holds a panel of 480 by 460 over the right side of its screen,
  sticking out of it by 80 px. With `neighbour?` a bare screen lies at x
  `w` + 15, outside the first wrapper."
  [dx dy & {:keys [w h overlay? neighbour?] :or {w 1000 h 800}}]
  (let [{:keys [profile file-id page]} (create-file-with-page)
        board (fn [id name parent x y w h]
                (cond-> {:op "create_board" :page-id page :id (str "$tmp:" id) :name name
                         :x x :y y :width w :height h}
                  (some? parent) (assoc :parent-id (str "$tmp:" parent))))
        ids   (apply-ops!
               profile file-id
               (vec (concat (mapcat (fn [i]
                              (let [x (* i 2000)]
                                (cond-> [(board (str "w" i) (str "Wrapper " i) nil x 0 w h)
                                         (board (str "s" i) (str "Screen " i) (str "w" i)
                                                (+ x dx) dy 800 600)]
                                  overlay?
                                  (conj (board (str "o" i) "Overlay" (str "w" i)
                                               (+ x dx 400) (+ dy 100) 480 460)))))
                            (range 3))
                    (when neighbour?
                      [(board "n" "Neighbour" nil (+ w 15) dy 800 600)]))))]
    {:profile profile
     :file-id file-id
     :page    page
     :w0      (get ids "$tmp:w0")
     :s0      (get ids "$tmp:s0")
     :s1      (get ids "$tmp:s1")
     :s2      (get ids "$tmp:s2")
     :n       (get ids "$tmp:n")}))

(t/deftest an-end-on-a-wrapper-edge-snaps-to-the-screen-inside-it
  (let [{:keys [profile file-id page s0 s1 s2]} (margin-wrappers-fixture 100 100)
        _      (add-path profile file-id page "Link" "M 995 400 L 2005 400"
                         :stroke (assoc solid-stroke :stroke-cap-end :line-arrow))
        _      (add-path profile file-id page "Link 2" "M 2995 400 L 4005 400"
                         :stroke solid-stroke)
        out    (find-connectors profile file-id page)
        result (:result out)
        link   (by-name "Link" (:connectors result))
        link2  (by-name "Link 2" (:connectors result))]
    (t/is (nil? (:error out)))
    (t/is (= 3 (get-in result [:selection :boards])))
    (t/is (some #{{:width 1000 :height 800 :boards 3 :relation "wrapper"}}
                (get-in result [:selection :other-sizes])))
    (t/is (= 2 (count (:connectors result))))
    (t/is (= s0 (get-in link [:from :screen-id])))
    (t/is (= s1 (get-in link [:to :screen-id])))
    (t/is (near? 95 (get-in link [:from :distance])) "measured to the screen edge")
    (t/is (near? 95 (get-in link [:to :distance])))
    (t/is (= s0 (get-in link [:from :board-id])) "the screen stands for the wrapper")
    (t/is (not (contains? (:from link) :non-screen)))
    (t/is (= s1 (get-in link2 [:from :screen-id])))
    (t/is (= s2 (get-in link2 [:to :screen-id])))
    (t/is (= 0 (:non-screen-ends result)))))

(t/deftest an-end-far-from-a-wrapper-does-not-snap
  (let [{:keys [profile file-id page]} (margin-wrappers-fixture 100 100)
        _      (add-path profile file-id page "Lost" "M 1100 400 L 2005 400"
                         :stroke solid-stroke)
        result (:result (find-connectors profile file-id page :max-distance 64))
        lost   (by-name "Lost" (:connectors result))]
    (t/is (nil? lost) "an end 100 px from a wrapper is out of reach, so there is no connector")))

(t/deftest an-uneven-margin-does-not-make-the-frame-a-wrapper-for-the-ends
  (let [{:keys [profile file-id page]} (margin-wrappers-fixture 50 100)
        _      (add-path profile file-id page "Link" "M 995 400 L 2005 400"
                         :stroke solid-stroke)
        result (:result (find-connectors profile file-id page))
        link   (first (:connectors result))]
    (t/is (some #{{:width 1000 :height 800 :boards 3 :relation "outside"}}
                (get-in result [:selection :other-sizes])))
    (t/is (nil? (get-in link [:from :screen-id])) "wrapper edge is 95 px from the screen")))

(t/deftest an-end-snaps-through-a-wrapper-that-also-holds-an-overlay
  ;; The real Processing wrappers: 1000 by 800, the screen and a 480 by 460
  ;; panel beside it. The panel size is standard by the taller rule, so it was
  ;; a class of its own and counted as a second screen in the wrapper.
  (let [{:keys [profile file-id page s0 s1]} (margin-wrappers-fixture 100 100 :overlay? true)
        _      (add-path profile file-id page "Link" "M 995 400 L 2005 400" :stroke solid-stroke)
        result (:result (find-connectors profile file-id page))
        link   (first (:connectors result))]
    (t/is (= 3 (get-in result [:selection :boards])) "the overlays are not boards")
    (t/is (= s0 (get-in link [:from :screen-id])))
    (t/is (= s1 (get-in link [:to :screen-id])))
    (t/is (= 0 (:non-screen-ends result)))))

(t/deftest an-end-snaps-through-a-centered-wrapper-with-unequal-sides
  ;; 1480 by 1000 around 800 by 600: 340 px left and right, 200 above and below.
  (let [{:keys [profile file-id page s0 s1]} (margin-wrappers-fixture 340 200 :w 1480 :h 1000)
        _      (add-path profile file-id page "Link" "M 1475 500 L 2005 500" :stroke solid-stroke)
        result (:result (find-connectors profile file-id page))
        link   (first (:connectors result))]
    (t/is (= s0 (get-in link [:from :screen-id])))
    (t/is (= s1 (get-in link [:to :screen-id])))
    (t/is (near? 335 (get-in link [:from :distance])))))

(t/deftest an-end-prefers-the-nearer-screen-over-the-screen-of-a-large-wrapper
  ;; The end lies 5 px inside a 1480 by 1000 wrapper, 335 px from its screen,
  ;; and 20 px from a bare screen outside the wrapper.
  (let [{:keys [profile file-id page s1 n]} (margin-wrappers-fixture 340 200 :w 1480 :h 1000
                                                                     :neighbour? true)
        _      (add-path profile file-id page "Link" "M 1475 500 L 3000 500" :stroke solid-stroke)
        result (:result (find-connectors profile file-id page))
        link   (first (:connectors result))]
    (t/is (= n (get-in link [:from :screen-id])))
    (t/is (= s1 (get-in link [:to :screen-id])))))

(t/deftest an-end-on-an-overlay-belongs-to-the-screen-it-covers
  (let [{:keys [profile file-id page s0 s1]} (margin-wrappers-fixture 100 100 :overlay? true)
        _      (add-path profile file-id page "Link" "M 950 400 L 2005 400" :stroke solid-stroke)
        result (:result (find-connectors profile file-id page))
        link   (first (:connectors result))]
    (t/is (= 3 (get-in result [:selection :boards])))
    (t/is (= s0 (get-in link [:from :screen-id])) "the panel is part of the screen")
    (t/is (= s0 (get-in link [:from :board-id])))
    (t/is (near? 50 (get-in link [:from :distance])) "measured to the screen")
    (t/is (= s1 (get-in link [:to :screen-id])))
    (t/is (= 0 (:non-screen-ends result)))))

(defn- wrapper-board
  [id name x1 y1 x2 y2 ancestors]
  (proto/->Board id name (double x1) (double y1) (double x2) (double y2)
                 (double (* (- x2 x1) (- y2 y1))) 1 ancestors))

(t/deftest a-frame-holding-several-screens-is-not-a-wrapper
  (let [frames  [(wrapper-board :c "Container" 0 0 2000 800 #{})
                 (wrapper-board :a "A" 100 100 900 700 #{:c})
                 (wrapper-board :b "B" 1100 100 1900 700 #{:c})
                 (wrapper-board :d "Solo" 3000 0 4000 800 #{})
                 (wrapper-board :e "E" 3100 100 3900 700 #{:d})]
        objects {:c {:parent-id uuid/zero} :a {:parent-id :c} :b {:parent-id :c}
                 :d {:parent-id uuid/zero} :e {:parent-id :d}}]
    (t/is (= {} (#'proto/get-wrappers objects (subvec frames 0 3) #{:a :b}))
          "two screens in one frame")
    (t/is (= [:e] (keys (#'proto/get-wrappers objects frames #{:a :b :e})))
          "a screen alone in a centered frame has it as wrapper")))

(defn- journeys-fixture
  "Section A (0..1800 by 0..900) holds Screen A1 (x 50..850) with the nested
  frames Header A1 and Body A1, Screen A2 (x 900..1700) and three loose frames
  below the screens: Inside Decision, Near Decision and Tie Decision. Section B
  (x 2000..2900) holds Screen B1 (x 2050..2850). Between is a loose frame
  between the two sections (x 1820..1980). The screens are selected by name
  and depth, so the sections are not screens."
  []
  (let [{:keys [profile file-id page]} (create-file-with-page)
        board (fn [id name parent x y w h]
                (cond-> {:op "create_board" :page-id page :id (str "$tmp:" id) :name name
                         :x x :y y :width w :height h}
                  (some? parent) (assoc :parent-id (str "$tmp:" parent))))
        ids   (apply-ops!
               profile file-id
               [(board "sa" "Section A" nil 0 0 1800 900)
                (board "sb" "Section B" nil 2000 0 900 900)
                (board "a1" "Screen A1" "sa" 50 50 800 600)
                (board "a2" "Screen A2" "sa" 900 50 800 600)
                (board "b1" "Screen B1" "sb" 2050 50 800 600)
                (board "head" "Header A1" "a1" 50 50 800 100)
                (board "body" "Body A1" "a1" 50 200 800 400)
                (board "in" "Inside Decision" "sa" 100 700 150 150)
                (board "near" "Near Decision" "sa" 300 690 100 100)
                (board "tie" "Tie Decision" "sa" 700 710 100 80)
                (board "between" "Between" nil 1820 300 160 100)])]
    {:profile profile
     :file-id file-id
     :page    page
     :a1      (get ids "$tmp:a1")
     :a2      (get ids "$tmp:a2")
     :b1      (get ids "$tmp:b1")
     :between (get ids "$tmp:between")
     :in      (get ids "$tmp:in")
     :near    (get ids "$tmp:near")}))

(t/deftest an-end-finds-its-screen-by-position-not-by-the-section-it-snaps-to
  (let [{:keys [profile file-id page a1 a2 b1 between in near]} (journeys-fixture)
        cap    (assoc solid-stroke :stroke-cap-end :line-arrow)
        _      (add-path profile file-id page "Cross" "M 840 300 L 2060 300" :stroke cap)
        _      (add-path profile file-id page "Same" "M 840 500 L 910 500" :stroke cap)
        _      (add-path profile file-id page "To Between" "M 840 350 L 1900 350" :stroke cap)
        _      (add-path profile file-id page "To Inside" "M 100 600 L 175 760" :stroke cap)
        _      (add-path profile file-id page "Divider" "M 450 170 L 450 210" :stroke solid-stroke)
        _      (add-path profile file-id page "Lost" "M 880 820 L 2060 300" :stroke solid-stroke)
        _      (add-path profile file-id page "Near" "M 350 680 L 1000 500" :stroke solid-stroke)
        _      (add-path profile file-id page "Tie" "M 750 680 L 1000 400" :stroke solid-stroke)
        select {:mode :depth :depth 2 :board-name-regex "^Screen"}
        out    (apply find-connectors profile file-id page (mapcat identity select))
        result (:result out)
        conns  (:connectors result)
        wide   (apply find-connectors profile file-id page :include-same-screen true
                      (mapcat identity select))]
    (t/is (nil? (:error out)))
    (t/is (= 3 (get-in result [:selection :boards])) "the three screens, not the sections")

    (t/testing "an arrow between screens of two sections: both screens, kept, right way"
      (let [c (by-name "Cross" conns)]
        (t/is (some? c))
        (t/is (= "cap" (:direction c)))
        (t/is (= a1 (get-in c [:from :screen-id])))
        (t/is (= b1 (get-in c [:to :screen-id])))
        (t/is (= "Section A" (get-in c [:from :board-name])) "the frame snap is as it was")
        (t/is (= "Section B" (get-in c [:to :board-name])))
        (t/is (not (contains? (:from c) :non-screen)))))

    (t/testing "an arrow between two screens of one section"
      (let [c (by-name "Same" conns)]
        (t/is (= a1 (get-in c [:from :screen-id])))
        (t/is (= a2 (get-in c [:to :screen-id])))
        (t/is (= a1 (get-in c [:from :board-id])))
        (t/is (not (contains? c :same-screen)))))

    (t/testing "an arrow to a decision frame between the sections"
      (let [c (by-name "To Between" conns)]
        (t/is (= a1 (get-in c [:from :screen-id])))
        (t/is (= between (get-in c [:to :board-id])))
        (t/is (true? (get-in c [:to :non-screen])))
        (t/is (not (contains? (:to c) :screen-id)))))

    (t/testing "an arrow to a decision frame inside a section, outside any screen"
      (let [c (by-name "To Inside" conns)]
        (t/is (= a1 (get-in c [:from :screen-id])))
        (t/is (= in (get-in c [:to :board-id])))
        (t/is (true? (get-in c [:to :non-screen])))))

    (t/testing "a divider inside a screen is still a same-screen connector"
      (t/is (nil? (by-name "Divider" conns)))
      (t/is (= 1 (:same-screen-skipped result)))
      (let [c (by-name "Divider" (:connectors (:result wide)))]
        (t/is (true? (:same-screen c)))
        (t/is (= a1 (get-in c [:from :screen-id])))
        (t/is (= a1 (get-in c [:to :screen-id])))
        (t/is (= "Header A1" (get-in c [:from :board-name])))
        (t/is (= "Body A1" (get-in c [:to :board-name])))))

    (t/testing "an end 30 px from a screen and 10 px from a decision frame: the decision frame wins"
      (let [c (by-name "Near" conns)]
        (t/is (= near (get-in c [:from :board-id])))
        (t/is (true? (get-in c [:from :non-screen])))
        (t/is (= a2 (get-in c [:to :screen-id])))))

    (t/testing "an end as near a screen as a loose frame: the screen wins"
      (let [c (by-name "Tie" conns)]
        (t/is (= a1 (get-in c [:from :screen-id])))
        (t/is (not (contains? (:from c) :non-screen)))
        (t/is (= a2 (get-in c [:to :screen-id])))))

    (t/testing "an end with nothing within max-distance has no screen; the frame gate still passes it"
      (let [c (by-name "Lost" conns)]
        (t/is (some? c))
        (t/is (= "Section A" (get-in c [:from :board-name])))
        (t/is (true? (get-in c [:from :non-screen])))
        (t/is (= b1 (get-in c [:to :screen-id])))))

    (t/is (= 7 (count conns)))
    (t/is (= 4 (:non-screen-ends result)) "To Between, To Inside, Lost and Near")))

;; --- CONNECTORS: DIRECTION END TO END

(t/deftest every-arrow-style-names-the-right-screens
  (let [{:keys [profile file-id page s1 s2]} (screens-fixture)
        l       400.0
        cases   (for [style [:triangle :barbs :dot :curved :chevron]
                      k     [0 4]]
                  (let [a        (geom/place (geom/arrow style l) k)
                        tip      (:tip a)
                        tail     (:tail a)
                        dx       (- 850.0 (/ (+ (:x tip) (:x tail)) 2))
                        dy       (- 250.0 (/ (+ (:y tip) (:y tail)) 2))
                        content  (geom/map-content (fn [x y] [(+ x dx) (+ y dy)]) (:content a))]
                    {:name  (str (name style) " " k)
                     :d     (geom/content->d content)
                     :tip-x (+ (:x tip) dx)
                     :k     k}))
        _       (doseq [{:keys [name d]} cases]
                  (add-path profile file-id page name d))
        out     (find-connectors profile file-id page)
        conns   (:connectors (:result out))]
    (t/is (nil? (:error out)))
    (t/is (= (count cases) (count conns)))
    (doseq [{:keys [name tip-x k]} cases]
      (let [conn (by-name name conns)]
        (t/is (some? conn) name)
        (t/is (= "shape" (:direction conn)) name)
        (t/is (= "high" (:confidence conn)) name)
        (t/is (= (if (zero? k) s1 s2) (get-in conn [:from :screen-id])) (str name ": from"))
        (t/is (= (if (zero? k) s2 s1) (get-in conn [:to :screen-id])) (str name ": to"))
        (t/is (near? tip-x (get-in conn [:to :x]) 1.0) (str name ": the tip is the to end"))))))

(t/deftest an-arrow-drawn-as-a-group-is-one-composed-connector
  (let [{:keys [profile file-id page s1 s2]} (screens-fixture)
        east-ids (apply-ops!
                  profile file-id
                  [{:op "create_rect" :page-id page :id "$tmp:r" :name "Shaft East"
                    :x 700 :y 296 :width 170 :height 8}
                   {:op "create_path" :page-id page :id "$tmp:p" :name "Head East"
                    :d "M 870 282 L 910 300 L 870 318 Z"}])
        west-ids (apply-ops!
                  profile file-id
                  [{:op "create_rect" :page-id page :id "$tmp:r" :name "Shaft West"
                    :x 730 :y 396 :width 170 :height 8}
                   {:op "create_path" :page-id page :id "$tmp:p" :name "Head West"
                    :d "M 730 382 L 690 400 L 730 418 Z"}])
        east     (get (apply-ops! profile file-id
                                  [{:op "create_group" :page-id page :id "$tmp:g" :name "Arrow East"
                                    :child-ids [(get east-ids "$tmp:r") (get east-ids "$tmp:p")]}])
                      "$tmp:g")
        west     (get (apply-ops! profile file-id
                                  [{:op "create_group" :page-id page :id "$tmp:g" :name "Arrow West"
                                    :child-ids [(get west-ids "$tmp:r") (get west-ids "$tmp:p")]}])
                      "$tmp:g")
        out      (find-connectors profile file-id page)
        result   (:result out)
        conns    (:connectors result)
        e        (by-name "Arrow East" conns)
        w        (by-name "Arrow West" conns)]
    (t/is (nil? (:error out)))
    (t/is (= 2 (count conns)) "the shafts and the heads are not candidates of their own")
    (t/is (= 2 (:scanned result)))
    (t/is (= east (:id e)))
    (t/is (= :group (:type e)))
    (t/is (true? (:composed e)))
    (t/is (= "shape" (:direction e)))
    (t/is (= "high" (:confidence e)))
    (t/is (= s1 (get-in e [:from :screen-id])))
    (t/is (= s2 (get-in e [:to :screen-id])))
    (t/is (near? 910 (get-in e [:to :x]) 0.01))
    (t/is (= west (:id w)))
    (t/is (true? (:composed w)))
    (t/is (= s2 (get-in w [:from :screen-id])))
    (t/is (= s1 (get-in w [:to :screen-id])))
    (t/is (near? 690 (get-in w [:to :x]) 0.01))))

(defn- inside-fixture
  "Screen 1 (0..800 by 0..1000) holds the frame Footer (y 900..1000) and the
  rect Button; Screen 2 is at x 900..1700. Select the two screens with
  `:mode :depth :depth 1`."
  []
  (let [{:keys [profile file-id page]} (create-file-with-page)
        ids (apply-ops!
             profile file-id
             [{:op "create_board" :page-id page :id "$tmp:s1" :name "Screen 1"
               :x 0 :y 0 :width 800 :height 1000}
              {:op "create_board" :page-id page :id "$tmp:s2" :name "Screen 2"
               :x 900 :y 0 :width 800 :height 1000}
              {:op "create_board" :page-id page :id "$tmp:foot" :name "Footer"
               :parent-id "$tmp:s1" :x 0 :y 900 :width 800 :height 100}
              {:op "create_rect" :page-id page :id "$tmp:btn" :name "Button"
               :parent-id "$tmp:s1" :x 60 :y 270 :width 80 :height 60}])]
    {:profile profile
     :file-id file-id
     :page    page
     :s1      (get ids "$tmp:s1")
     :s2      (get ids "$tmp:s2")
     :foot    (get ids "$tmp:foot")}))

(t/deftest an-arrow-drawn-inside-a-screen-is-found-when-it-runs-to-another
  ;; The arrow is a child of Screen 1 and starts at a plain rect with no frame
  ;; near it, so its start snaps to no frame (Screen 1 is its own ancestor).
  ;; Before the fix both ends had to snap and it was dropped.
  (let [{:keys [profile file-id page s1 s2]} (inside-fixture)
        cap    (assoc solid-stroke :stroke-cap-end :line-arrow)
        _      (add-path profile file-id page "Arrow In" "M 140 300 L 905 300"
                         :parent s1 :stroke cap)
        _      (add-path profile file-id page "Inside" "M 100 400 L 700 400"
                         :parent s1 :stroke solid-stroke)
        select {:mode :depth :depth 1}
        out    (apply find-connectors profile file-id page (mapcat identity select))
        wide   (apply find-connectors profile file-id page :include-same-screen true
                      (mapcat identity select))
        result (:result out)
        c      (by-name "Arrow In" (:connectors result))]
    (t/is (nil? (:error out)))
    (t/is (= 2 (get-in result [:selection :boards])))
    (t/is (= ["Arrow In"] (map :name (:connectors result))))
    (t/is (= "cap" (:direction c)))
    (t/is (= s1 (get-in c [:from :screen-id])))
    (t/is (= s1 (get-in c [:from :board-id])) "no frame near the start: its screen stands in")
    (t/is (= "Screen 1" (get-in c [:from :board-name])))
    (t/is (= 0.0 (double (get-in c [:from :distance]))))
    (t/is (= s2 (get-in c [:to :screen-id])))
    (t/is (= s2 (get-in c [:to :board-id])))
    (t/is (= 140.0 (double (get-in c [:from :x]))))
    (t/is (= 905.0 (double (get-in c [:to :x]))) "direction right: the head is at Screen 2")
    (t/is (not (contains? c :same-screen)))
    (t/is (= 1 (:same-screen-skipped result)) "the arrow inside Screen 1 is dropped and counted")
    (t/is (= 0 (:non-screen-ends result)))
    (let [i (by-name "Inside" (:connectors (:result wide)))]
      (t/is (true? (:same-screen i)))
      (t/is (= s1 (get-in i [:from :screen-id])))
      (t/is (= s1 (get-in i [:to :screen-id])))
      (t/is (= s1 (get-in i [:from :board-id]))))))

(t/deftest two-opposite-arrows-in-one-group-are-two-connectors
  ;; Before the fix the group counted as one composed arrow and one direction
  ;; was lost.
  (let [{:keys [profile file-id page s1 s2]} (screens-fixture)
        right (add-path profile file-id page "Arrow Right"
                        "M 700 297 L 985 297 L 985 288 L 1000 300 L 985 312 L 985 303 L 700 303 Z")
        left  (add-path profile file-id page "Arrow Left"
                        "M 1000 337 L 715 337 L 715 328 L 700 340 L 715 352 L 715 343 L 1000 343 Z")
        group (get (apply-ops! profile file-id
                               [{:op "create_group" :page-id page :id "$tmp:g" :name "Both"
                                 :child-ids [right left]}])
                   "$tmp:g")
        out    (find-connectors profile file-id page)
        result (:result out)
        r      (by-name "Arrow Right" (:connectors result))
        l      (by-name "Arrow Left" (:connectors result))]
    (t/is (nil? (:error out)))
    (t/is (some? group))
    (t/is (= 2 (count (:connectors result))))
    (t/is (= 2 (:scanned result)) "the two paths, not the group")
    (t/is (not (contains? r :composed)))
    (t/is (not (contains? l :composed)))
    (t/is (= "shape" (:direction r)))
    (t/is (= "shape" (:direction l)))
    (t/is (= s1 (get-in r [:from :screen-id])))
    (t/is (= s2 (get-in r [:to :screen-id])))
    (t/is (= s2 (get-in l [:from :screen-id])))
    (t/is (= s1 (get-in l [:to :screen-id])))
    (t/is (near? 1000 (get-in r [:to :x]) 0.01))
    (t/is (near? 700 (get-in l [:to :x]) 0.01))))

(t/deftest an-end-of-an-arrow-that-snaps-to-no-frame-needs-its-own-screen
  ;; An arrow inside Screen 1 that runs to a place that is no frame and no
  ;; screen is still no connector: the end has no target.
  (let [{:keys [profile file-id page s1]} (inside-fixture)
        _   (add-path profile file-id page "Nowhere" "M 140 300 L 2500 300"
                      :parent s1 :stroke solid-stroke)
        out (apply find-connectors profile file-id page (mapcat identity {:mode :depth :depth 1}))]
    (t/is (empty? (:connectors (:result out))))
    (t/is (= 0 (:same-screen-skipped (:result out))))))

;; --- CONNECTORS: MANY CANDIDATES

(t/deftest three-thousand-candidates-stay-inside-the-time-budget
  (let [{:keys [profile file-id page]} (create-file-with-page)
        _       (apply-ops! profile file-id
                            [{:op "create_board" :page-id page :id "$tmp:a" :name "Board A"
                              :x 0 :y 0 :width 200 :height 6200}
                             {:op "create_board" :page-id page :id "$tmp:b" :name "Board B"
                              :x 400 :y 0 :width 200 :height 6200}])
        arrow-d (fn [y]
                  (str "M 205 " (+ y 8) " L 380 " (+ y 8) " L 380 " (+ y 2) " L 395 " (+ y 10)
                       " L 380 " (+ y 18) " L 380 " (+ y 12) " L 205 " (+ y 12) " Z"))
        inside  (fn [y]
                  (str "M 20 " y " L 180 " y " L 180 " (+ y 3) " L 20 " (+ y 3) " Z"))
        ops     (concat
                 (for [i (range 1500)]
                   {:op "create_path" :page-id page :name (str "Arrow " i) :d (arrow-d (* 4 i))})
                 (for [i (range 1500)]
                   {:op "create_path" :page-id page :name (str "Bar " i) :d (inside (* 4 i))}))
        _       (doseq [batch (partition-all 500 ops)]
                  (apply-ops! profile file-id (vec batch)))
        started (System/nanoTime)
        out     (find-connectors profile file-id page :limit 2000)
        ms      (/ (- (System/nanoTime) started) 1000000.0)
        result  (:result out)]
    (println "find-mcp-connectors on 3000 candidates:" ms "ms")
    (t/is (nil? (:error out)))
    (t/is (= 3000 (:scanned result)))
    (t/is (false? (:truncated result)))
    (t/is (= 1500 (count (:connectors result))))
    (t/is (every? #(= "shape" (:direction %)) (:connectors result)))
    (t/is (< ms 5000.0))))

(t/deftest three-thousand-frames-and-three-thousand-arrows-stay-inside-the-budget
  ;; 3,000 frames in 60 columns and 3,000 arrows: 2,000 in the gap beside a
  ;; frame (a connector each) and 1,000 inside a frame (same screen, counted).
  ;; The limit of the command is 2,000. With the plain loop over all frames the
  ;; matching of the ends alone took about 4 s here (see
  ;; `finding-the-board-of-thousands-of-ends-costs-little`).
  (let [{:keys [profile file-id page]} (create-file-with-page)
        frames  3000
        links   2000
        frame-x (fn [i] (* 1000 (mod i 60)))
        frame-y (fn [i] (* 800 (quot i 60)))
        _       (doseq [batch (partition-all 500 (range frames))]
                  (apply-ops! profile file-id
                              (mapv (fn [i]
                                      {:op "create_board" :page-id page :id (str "$tmp:f" i)
                                       :name (str "Frame " i)
                                       :x (frame-x i) :y (frame-y i) :width 800 :height 600})
                                    batch)))
        arrow-d (fn [i]
                  (if (< i links)
                    ;; into the gap beside the frame, or beside the one before the last
                    ;; of a row, which has no neighbour on its right
                    (let [g (if (< (mod i 60) 59) i (dec i))]
                      (str "M " (+ (frame-x g) 790) " " (+ (frame-y g) 300)
                           " L " (+ (frame-x g) 1010) " " (+ (frame-y g) 300)))
                    (str "M " (+ (frame-x i) 100) " " (+ (frame-y i) 300)
                         " L " (+ (frame-x i) 400) " " (+ (frame-y i) 300))))
        _       (doseq [batch (partition-all 500 (range frames))]
                  (apply-ops! profile file-id
                              (mapv (fn [i]
                                      {:op "create_path" :page-id page :name (str "Arrow " i)
                                       :d (arrow-d i)})
                                    batch)))
        run     (fn []
                  (let [started (System/nanoTime)
                        out     (find-connectors profile file-id page :limit 2000)]
                    [out (/ (- (System/nanoTime) started) 1000000.0)]))
        [out ms] (run)
        result  (:result out)
        ;; the same page with the plain loop over every frame, for the time
        [old-out old-ms] (with-redefs [proto/build-board-index (fn [boards _] {:all boards})
                                       proto/find-snap-board
                                       (fn [index excluded a b p md]
                                         (#'proto/snap-among (:all index) excluded a b p md))]
                           (run))]
    (println "find-mcp-connectors on 3000 frames and 3000 arrows:" ms "ms with the grid,"
             old-ms "ms with the plain loop over all frames, scanned"
             (:scanned (:result old-out)) "of 3000")
    (t/is (nil? (:error out)))
    (t/is (= 3000 (:scanned result)))
    (t/is (false? (:truncated result)))
    (t/is (= 2000 (count (:connectors result))))
    (t/is (= 1000 (:same-screen-skipped result)))
    (t/is (< ms 5000.0))))

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
