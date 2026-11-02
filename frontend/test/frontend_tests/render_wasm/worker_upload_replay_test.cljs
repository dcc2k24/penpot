;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.render-wasm.worker-upload-replay-test
  "The worker upload must make the same WASM calls, with the same bytes, as
  the main thread upload. A recording fake WASM module logs every call with
  the bytes written since the previous call, so both paths can be compared
  call by call.

  The worker path decodes the raw strings, encodes the entries, packs them
  and clones the reply as postMessage does. The main thread then replays the
  entries with `apply-entries!`."
  (:require
   [app.common.render-wasm.svg-derived :as svg-derived]
   [app.common.render-wasm.wasm :as wasm]
   [app.common.transit :as transit]
   [app.common.types.objects-hints :as ohints]
   [app.common.types.objects-map :as omap]
   [app.common.types.path :as path]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.render-wasm.api :as api]
   [app.render-wasm.api.enums]
   [app.render-wasm.api.fonts :as f]
   [app.render-wasm.page-cache :as page-cache]
   [app.render-wasm.text-editor :as text-editor]
   [app.render-wasm.upload-entry :as ue]
   [cljs.test :as t :include-macros true]
   [promesa.core :as p]))

;; --- Recording WASM module -------------------------------------------------

(def ^:private heap-bytes (* 64 1024 1024))

(def ^:private empty-font-state
  {:font-index {} :pending-faces #{}})

(defn- align-8
  [n]
  (* 8 (quot (+ n 7) 8)))

(defn- short-str
  "The start of the printed form of `x`, to keep failure messages short."
  [x]
  (let [s (pr-str x)]
    (subs s 0 (min 300 (count s)))))

(defn- bytes-of
  "The bytes of a typed array as a vector of numbers."
  [u8]
  (vec (js/Array.from u8)))

(defn- make-recorder
  "A fake WASM module over one zeroed heap. The allocator never reuses memory.
  Every call of a `_` function is logged as [name args allocs], where `allocs`
  holds the bytes of each allocation made since the previous logged call.
  Returns {:module .. :calls ..}, where `:calls` is a fn returning the log."
  []
  (let [buffer       (js/ArrayBuffer. heap-bytes)
        heap-u8      (js/Uint8Array. buffer)
        heap-u32     (js/Uint32Array. buffer)
        heap-i32     (js/Int32Array. buffer)
        heap-f32     (js/Float32Array. buffer)
        next-free    (volatile! 16)
        pending      (volatile! [])
        log          (volatile! [])
        alloc        (fn [size]
                       (let [offset @next-free
                             end    (+ offset (align-8 size))]
                         (when (> end heap-bytes)
                           (throw (js/Error. "the test WASM heap is full")))
                         (vreset! next-free end)
                         (vswap! pending conj [offset size])
                         offset))
        take-allocs! (fn []
                       (let [allocs (mapv (fn [[offset size]]
                                            (bytes-of (.slice heap-u8 offset (+ offset size))))
                                          @pending)]
                         (vreset! pending [])
                         allocs))
        record       (fn [fname]
                       (fn [& args]
                         (vswap! log conj [fname (vec args) (take-allocs!)])
                         nil))
        module       (js/Proxy.
                      #js {}
                      #js {:get (fn [_target k _receiver]
                                  (case k
                                    "HEAPU8"            heap-u8
                                    "HEAPU32"           heap-u32
                                    "HEAP32"            heap-i32
                                    "HEAPF32"           heap-f32
                                    "_alloc_bytes"      alloc
                                    "_is_image_cached"  (fn [& _] 0)
                                    "_is_font_uploaded" (fn [& _] 0)
                                    "_read_error_code"  (fn [& _] 0)
                                    "UTF8ToString"      (fn [& _] "")
                                    "stringToUTF8"      (fn [& _] nil)
                                    (if (and (string? k) (.startsWith k "_"))
                                      (record k)
                                      js/undefined)))})]
    {:module module
     ;; An allocation that no later call flushed is logged here, so it is
     ;; still compared.
     :calls  (fn []
               (let [tail (take-allocs!)]
                 (cond-> @log
                   (seq tail) (conj ["<allocations with no later call>" [] tail]))))}))

(defn- with-recording-wasm
  "Calls `thunk` with the module of `rec` installed as the WASM module, and
  returns its value. The font fetch state is reset before and after the call.
  The editor fallback font loader is a no-op: it fetches fonts over the
  network, which a test must not do."
  [rec thunk]
  (let [old-module   wasm/internal-module
        old-init?    wasm/context-initialized?
        old-lost?    @wasm/context-lost?
        old-fallback f/load-fallback-fonts-for-editor!]
    (set! wasm/internal-module (:module rec))
    (set! wasm/context-initialized? true)
    (reset! wasm/context-lost? false)
    (reset! f/fetching {})
    (set! f/load-fallback-fonts-for-editor! (fn [_fonts] nil))
    (try
      (thunk)
      (finally
        (set! f/load-fallback-fonts-for-editor! old-fallback)
        (reset! f/fetching {})
        (reset! wasm/context-lost? old-lost?)
        (set! wasm/context-initialized? old-init?)
        (set! wasm/internal-module old-module)))))

(defn- recorded
  "Runs `thunk` on a fresh recorder. Returns {:result .. :calls ..}: the value
  of `thunk` and the calls it logged."
  [thunk]
  (let [rec    (make-recorder)
        result (with-recording-wasm rec thunk)]
    {:result result
     :calls  ((:calls rec))}))

(defn- first-difference
  "Describes the first logged call where the logs `a` and `b` differ, or nil."
  [a b]
  (let [n (max (count a) (count b))
        i (first (filter #(not= (nth a % nil) (nth b % nil)) (range n)))]
    (when (some? i)
      (str "call " i ", main: " (short-str (nth a i nil))
           ", worker: " (short-str (nth b i nil))))))

;; --- Fixture page ----------------------------------------------------------

(def ^:private regular-face
  {:font-id "sourcesanspro" :font-variant-id "regular"
   :font-weight "400" :font-style "normal" :font-family "Source Sans Pro"})

(def ^:private emoji
  (js/String.fromCharCode 0xD83D 0xDE00))

(def ^:private triangle
  (path/content [{:command :move-to :params {:x 0 :y 0}}
                 {:command :line-to :params {:x 40 :y 0}}
                 {:command :line-to :params {:x 40 :y 40}}]))

(defn- span
  "A text span with `text` and the font attrs `attrs`."
  [text attrs]
  (merge regular-face {:text text} attrs))

(defn- text-content
  "A text content with one paragraph per list of spans in `span-lists`."
  [vertical-align & span-lists]
  {:type "root"
   :vertical-align vertical-align
   :children [{:type "paragraph-set"
               :children (mapv (fn [spans]
                                 {:type "paragraph" :children spans})
                               span-lists)}]})

(defn- image
  "An image asset of the file, for a fill or a stroke."
  [id image-name]
  {:id id :width 100 :height 80 :mtype "image/png" :name image-name})

(defn- node
  "A shape set up from `props`, at the origin and 100 by 50 unless given."
  [props]
  (cts/setup-shape (merge {:x 0 :y 0 :width 100 :height 50
                           :parent-id uuid/zero :frame-id uuid/zero}
                          props)))

(defn- fixture-page
  "A page under the root frame `uuid/zero` with one shape of each kind the
  upload encodes. Returns the plain map of its shapes by id."
  []
  (let [root          uuid/zero
        img-a         (uuid/next)
        img-b         (uuid/next)
        rect-id       (uuid/next)
        fx-id         (uuid/next)
        fx-child-id   (uuid/next)
        group-id      (uuid/next)
        group-kid-id  (uuid/next)
        masked-id     (uuid/next)
        mask-id       (uuid/next)
        masked-kid-id (uuid/next)
        bool-id       (uuid/next)
        path-id       (uuid/next)
        img-rect-id   (uuid/next)
        stroke-id     (uuid/next)
        text-id       (uuid/next)
        text-miss-id  (uuid/next)
        text-img-id   (uuid/next)
        grid-id       (uuid/next)
        grid-kid-id   (uuid/next)
        text-nil-id   (uuid/next)
        root-shape    (node {:id root :type :frame :width 1000 :height 1000
                             :shapes [rect-id fx-id group-id masked-id bool-id
                                      path-id img-rect-id stroke-id text-id
                                      text-miss-id text-img-id grid-id text-nil-id]})
        shapes
        [;; solid fill and stroke
         (node {:id rect-id :type :rect :parent-id root :frame-id root
                :fills [{:fill-color "#b1b2b5" :fill-opacity 1}]
                :strokes [{:stroke-style :solid :stroke-alignment :inner
                           :stroke-width 2 :stroke-color "#000000" :stroke-opacity 1}]})
         ;; clip, gradient, drop shadow, layer and background blur, flex layout
         (node {:id fx-id :type :frame :parent-id root :frame-id root
                :shapes [fx-child-id] :width 200 :height 100 :clip-content true
                :fills [{:fill-opacity 1
                         :fill-color-gradient {:type :linear :start-x 0 :start-y 0
                                               :end-x 1 :end-y 1 :width 1
                                               :stops [{:color "#000000" :opacity 1 :offset 0}
                                                       {:color "#ffffff" :opacity 1 :offset 1}]}}]
                :shadow [{:style :drop-shadow :color {:color "#000000" :opacity 0.5}
                          :offset-x 2 :offset-y 4 :blur 6 :spread 0 :hidden false}]
                :blur {:type :layer-blur :value 4 :hidden false}
                :background-blur {:type :background-blur :value 8 :hidden false}
                :layout :flex :layout-flex-dir :row :layout-gap {:row-gap 0 :column-gap 8}
                :layout-padding {:p1 4 :p2 4 :p3 4 :p4 4} :layout-align-items :start})
         ;; child of the flex frame with layout item attrs
         (node {:id fx-child-id :type :rect :parent-id fx-id :frame-id fx-id
                :width 40 :height 20
                :fills [{:fill-color "#ff0000" :fill-opacity 1}]
                :layout-item-h-sizing :fill :layout-item-v-sizing :fix
                :layout-item-margin {:m1 1 :m2 2 :m3 3 :m4 4}
                :layout-item-min-h 10 :layout-item-max-w 300 :layout-item-z-index 2
                :layout-item-align-self :center})
         ;; plain group with a child
         (node {:id group-id :type :group :parent-id root :frame-id root
                :shapes [group-kid-id] :width 30 :height 30})
         (node {:id group-kid-id :type :rect :parent-id group-id :frame-id root
                :width 10 :height 10
                :fills [{:fill-color "#00ff00" :fill-opacity 0.5}]})
         ;; masked group: the mask and the content
         (node {:id masked-id :type :group :masked-group true
                :parent-id root :frame-id root
                :shapes [mask-id masked-kid-id] :width 60 :height 60})
         (node {:id mask-id :type :rect :parent-id masked-id :frame-id root
                :width 60 :height 60})
         (node {:id masked-kid-id :type :rect :parent-id masked-id :frame-id root
                :width 30 :height 30
                :fills [{:fill-color "#0000ff" :fill-opacity 1}]})
         ;; bool and path with path content, svg attrs on the path
         (node {:id bool-id :type :bool :bool-type :union
                :parent-id root :frame-id root :content triangle})
         (node {:id path-id :type :path :parent-id root :frame-id root
                :content triangle
                :svg-attrs {:fillRule "evenodd" :strokeLinecap "round"
                            :strokeLinejoin "round"}
                :fills [{:fill-color "#abcdef" :fill-opacity 1}]})
         ;; image fill
         (node {:id img-rect-id :type :rect :parent-id root :frame-id root
                :width 100 :height 80
                :fills [{:fill-opacity 1 :fill-image (image img-a "a.png")}]})
         ;; solid stroke with per-side widths and an image stroke
         (node {:id stroke-id :type :rect :parent-id root :frame-id root
                :width 50 :height 50
                :strokes [{:stroke-style :solid :stroke-alignment :outer :stroke-width 1
                           :stroke-width-top 1 :stroke-width-right 2
                           :stroke-width-bottom 3 :stroke-width-left 4
                           :stroke-color "#00ff00" :stroke-opacity 1}
                          {:stroke-style :solid :stroke-alignment :center :stroke-width 2
                           :stroke-image (image img-b "b.png") :stroke-opacity 1}]})
         ;; two paragraphs: two spans with other weights and an emoji, then an
         ;; empty paragraph
         (node {:id text-id :type :text :parent-id root :frame-id root
                :grow-type :auto-width :width 120 :height 40
                :content (text-content :center
                                       [(span "Bold " {:font-variant-id "700" :font-weight "700"})
                                        (span (str "light " emoji)
                                              {:font-variant-id "300" :font-weight "300"})]
                                       [])})
         ;; a span with a font id that is not in the fonts DB
         (node {:id text-miss-id :type :text :parent-id root :frame-id root
                :grow-type :fixed :width 80 :height 20
                :content (text-content :top
                                       [(span "Missing" {:font-id "fake-missing-font"
                                                         :font-variant-id "regular"
                                                         :font-family "Fake Missing"})])})
         ;; a span with an image fill
         (node {:id text-img-id :type :text :parent-id root :frame-id root
                :grow-type :auto-width :width 60 :height 20
                :content (text-content :top
                                       [(span "Pic" {:fills [{:fill-opacity 1
                                                              :fill-image (image img-b "b.png")}]})])})
         ;; grid layout
         (node {:id grid-id :type :frame :layout :grid :parent-id root :frame-id root
                :shapes [grid-kid-id] :width 120 :height 80
                :layout-grid-dir :row :layout-gap {:row-gap 4 :column-gap 4}
                :layout-grid-rows [{:type :flex :value 1}]
                :layout-grid-columns [{:type :fixed :value 50}]
                :layout-grid-cells {(uuid/next) {:row 0 :row-span 1 :column 0
                                                 :column-span 1 :align-self :start
                                                 :justify-self :start
                                                 :shapes [grid-kid-id]}}})
         (node {:id grid-kid-id :type :rect :parent-id grid-id :frame-id grid-id
                :width 50 :height 20})
         ;; text without content
         (node {:id text-nil-id :type :text :parent-id root :frame-id root
                :width 10 :height 10})]]
    (into {}
          (map (juxt :id identity))
          (cons root-shape shapes))))

;; --- Worker and main thread sides -----------------------------------------

(defn- worker-reply
  "The message a worker sends for the shapes `ids`, decoded from their raw
  strings in `raw`: the entries, packed into one buffer, and the font table.
  The message is cloned, as postMessage does."
  [raw ids]
  (let [faces      (volatile! [])
        intern     (fn [face]
                     (let [index (count @faces)]
                       (vswap! faces conj face)
                       index))
        shapes     (mapv #(transit/decode-str (get raw %)) ids)
        entries    (f/call-with-batch-memo
                    (fn [] (mapv #(ue/encode-entry % intern) shapes)))
        js-entries (into-array entries)]
    (ue/pack-entries! js-entries)
    (js/structuredClone #js {:entries   js-entries
                             :fontTable (transit/encode-str @faces)})))

(defn- main-apply
  "Replays the worker `reply` on the main thread, as `set-objects-workers`
  does: the font faces of each entry, the svg-derived shapes of the host 1
  entries, then `apply-entries!`. Returns the result of `apply-entries!`."
  [reply objects]
  (let [table   (transit/decode-str (unchecked-get reply "fontTable"))
        entries (vec (array-seq (unchecked-get reply "entries")))
        hosts   (into {}
                      (comp (filter #(= 1 (unchecked-get % "host")))
                            (map (fn [e]
                                   (let [id (unchecked-get e "id")]
                                     [id (svg-derived/apply-svg-derived
                                          (get objects (uuid/uuid id)))]))))
                      entries)]
    (doseq [e entries]
      (#'api/set-font-vectors! e #(nth table %)))
    (#'api/apply-entries! entries hosts [] [] empty-font-state)))

(defn- tree-shapes
  "The shapes of `objects` in upload order, as the main thread reads them."
  [objects]
  (#'api/drain-source (#'api/tree-order-source objects)))

(defn- run-both
  "Uploads the fixture page on the main thread (today's chunk path) and on
  the worker path. Returns {:main .. :worker ..}, each a `recorded` map."
  []
  (let [;; Only the raw strings are kept, so every shape is decoded on read,
        ;; as on a loaded page.
        objects (omap/from-data (omap/raw-data (omap/wrap (fixture-page))))
        shapes  (tree-shapes objects)
        ids     (mapv :id shapes)
        raw     (omap/raw-data objects)]
    {:main   (recorded #(#'api/process-shapes-chunk shapes [] [] empty-font-state))
     :worker (recorded #(main-apply (worker-reply raw ids) objects))}))

;; --- Tests ------------------------------------------------------------------

(t/deftest worker-upload-makes-the-same-wasm-calls-as-main-thread
  (let [{:keys [main worker]} (run-both)]
    (t/is (seq (:calls main)) "the main thread path makes WASM calls")
    (t/is (= (:calls main) (:calls worker))
          (str "first differing call: "
               (first-difference (:calls main) (:calls worker))))))

(t/deftest worker-upload-reports-the-same-thumbnail-and-full-keys
  (let [{:keys [main worker]} (run-both)
        main-result   (:result main)
        worker-result (:result worker)]
    (t/is (seq (:thumbnails main-result)) "the fixture has pending thumbnail fetches")
    (t/is (= (mapv :key (:thumbnails main-result))
             (mapv :key (:thumbnails worker-result))))
    (t/is (seq (:full main-result)) "the fixture has pending full image fetches")
    (t/is (= (mapv :key (:full main-result))
             (mapv :key (:full worker-result))))))

(t/deftest worker-upload-reports-the-same-text-font-state
  (let [{:keys [main worker]} (run-both)]
    (t/is (seq (get-in main [:result :text-font-state :font-index]))
          "the fixture has text faces")
    (t/is (= (get-in main [:result :text-font-state])
             (get-in worker [:result :text-font-state])))))

(t/deftest tree-walk-over-shape-structures-matches-main-thread-order
  (let [page        (fixture-page)
        structures  (into {}
                          (map (fn [[uid shape]]
                                 [(str uid) (ue/shape-structure shape)]))
                          page)
        children-of (fn [id] (some-> (get structures id) (aget 0) array-seq))
        resolve     (fn [id] (when (contains? structures id) id))
        walked      (#'api/drain-source
                     (#'api/tree-walk-source (str uuid/zero) children-of resolve))
        expected    (mapv (comp str :id) (#'api/shapes-in-tree-order page))]
    (t/is (seq expected))
    (t/is (= expected walked))))

(defn- rect-shape
  [id fill]
  (cts/setup-shape {:id id :type :rect :x 0 :y 0 :width 10 :height 10
                    :parent-id uuid/zero :frame-id uuid/zero
                    :fills [{:fill-color fill :fill-opacity 1}]}))

(defn- rec-bytes
  [entry]
  (bytes-of (unchecked-get entry "rec")))

(defn- dirty-rule-replay
  "Replays one chunk of four shapes. `a` is clean, `b` changed on the current
  page, `c` removed from it, and `d` is kept on the main thread (owner -1).
  Returns the replayed entries and the entries the checks compare with."
  []
  (let [a-id    (uuid/next)
        b-id    (uuid/next)
        c-id    (uuid/next)
        d-id    (uuid/next)
        a       (rect-shape a-id "#111111")
        b       (rect-shape b-id "#222222")
        c       (rect-shape c-id "#333333")
        d       (rect-shape d-id "#444444")
        b-new   (rect-shape b-id "#999999")
        objects (omap/wrap {a-id a b-id b c-id c d-id d})
        raw     (omap/raw-data objects)
        current (-> objects
                    (assoc b-id b-new)
                    (dissoc c-id))
        owner   (js/Map.)
        worker  (js/Map.)
        _       (doseq [id [a-id b-id c-id]]
                  (.set owner (str id) 0))
        _       (.set owner (str d-id) -1)
        _       (doseq [s [a b c]]
                  (.set worker (str (:id s)) (ue/encode-entry s identity)))
        ids     [(str a-id) (str b-id) (str c-id) (str d-id)]
        result  (#'api/replay-chunk ids owner raw objects current worker false)]
    {:replayed     (:entries result)
     :expected-ids [(str a-id) (str b-id) (str d-id)]
     :a-entry      (.get worker (str a-id))
     :b-stale      (.get worker (str b-id))
     :b-fresh      (ue/encode-entry b-new identity)
     :d-fresh      (ue/encode-entry d identity)}))

(t/deftest dirty-rule-reuses-the-worker-entry-of-a-clean-shape
  (let [{:keys [replayed a-entry]} (dirty-rule-replay)]
    (t/is (identical? a-entry (nth replayed 0)))))

(t/deftest dirty-rule-encodes-a-changed-shape-on-the-main-thread
  (let [{:keys [replayed b-stale b-fresh]} (dirty-rule-replay)]
    (t/is (not= (rec-bytes b-stale) (rec-bytes b-fresh))
          "the change alters the record, so the stale entry would be wrong")
    (t/is (= (rec-bytes b-fresh) (rec-bytes (nth replayed 1))))))

(t/deftest dirty-rule-drops-a-removed-shape
  (let [{:keys [replayed expected-ids]} (dirty-rule-replay)]
    (t/is (= expected-ids (mapv #(unchecked-get % "id") replayed))
          "the removed shape is gone and the others keep their order")))

(t/deftest dirty-rule-encodes-a-main-owned-shape-on-the-main-thread
  (let [{:keys [replayed d-fresh]} (dirty-rule-replay)]
    (t/is (= (rec-bytes d-fresh) (rec-bytes (nth replayed 2))))))

(t/deftest frame-hint-with-a-displayed-grid-survives-a-structured-clone
  (let [frame (cts/setup-shape {:id (uuid/next) :type :frame :x 0 :y 0
                                :width 50 :height 50
                                :grids [{:type :square :display true
                                         :params {:size 10}}]})
        hint  (ue/hint->entry (aget (js/structuredClone (ue/shape-structure frame)) 1))]
    (t/is (= (ohints/shape-hint frame) hint))
    (t/is (true? (:grid? (second hint))) "the displayed grid is kept")))

(t/deftest text-hint-survives-a-structured-clone
  (let [text (cts/setup-shape {:id (uuid/next) :type :text :x 0 :y 0
                               :width 80 :height 20 :grow-type :auto-width
                               :content (text-content :top [(span "Hi" {})])})
        hint (ue/hint->entry (aget (js/structuredClone (ue/shape-structure text)) 1))]
    (t/is (= (ohints/shape-hint text) hint))
    (t/is (= ["sourcesanspro"] (:font-ids (second hint))))))

(t/deftest svg-raw-with-content-is-set-up-on-the-main-thread
  (let [svg (cts/setup-shape {:id (uuid/next) :type :svg-raw :x 0 :y 0
                              :width 10 :height 10 :content "<svg></svg>"})]
    (t/is (= 1 (unchecked-get (ue/encode-entry svg identity) "host")))))

(defn- cached-text-content
  "The content that the text editor cache holds for `id`, without the page
  fallback of `text-editor/get-cached-content`."
  [id]
  (get @@#'text-editor/shape-text-contents id))

(t/deftest worker-upload-drops-the-cached-content-of-its-texts
  (let [objects (omap/from-data (omap/raw-data (omap/wrap (fixture-page))))
        shapes  (tree-shapes objects)
        ids     (mapv :id shapes)
        raw     (omap/raw-data objects)
        texts   (into [] (comp (filter #(and (= :text (:type %)) (some? (:content %))))
                               (map :id))
                      shapes)
        stale   (text-content :top [(span "stale" {})])]
    (t/is (seq texts) "the fixture has texts with content")
    (doseq [id texts]
      (text-editor/cache-shape-text-content! id stale))
    (doseq [id texts]
      (t/is (= stale (cached-text-content id))
            "the cache holds the stale content before the upload"))
    (try
      (recorded #(main-apply (worker-reply raw ids) objects))
      (doseq [id texts]
        (t/is (nil? (cached-text-content id))
              "the stale cached content is dropped, so the editor reads the page"))
      (finally
        (doseq [id texts]
          (text-editor/drop-cached-content! id))))))

(def ^:private replay-state
  {:thumbnails [] :full [] :text-font-state empty-font-state :shapes []})

(defn- empty-replay-ctx
  "The replay context of a load with no chunks, for the load `token`."
  [token]
  {:chunks     []
   :requests   (volatile! [])
   :load-token token
   :file-id    nil
   :page-id    nil
   :raw        {}
   :objects    {}
   :owner      (js/Map.)})

(t/deftest replay-chunks-of-a-superseded-load-resolve-nil
  (t/async done
    ;; The replay resolves nil or the state at once, so both promises are made
    ;; while WASM is live.
    (let [[superseded-p current-p]
          (with-redefs [wasm/live? (constantly true)]
            [(#'api/replay-chunks (empty-replay-ctx (inc (page-cache/latest-load-token))) 0 replay-state)
             (#'api/replay-chunks (empty-replay-ctx (page-cache/latest-load-token)) 0 replay-state)])]
      (-> (p/let [superseded superseded-p
                  current    current-p]
            (t/is (nil? superseded) "a superseded load resolves nil")
            (t/is (= replay-state current) "the current load resolves its state")
            (done))
          (p/catch (fn [cause]
                     (t/is false (str cause))
                     (done)))))))

(t/deftest replay-chunks-stops-when-wasm-is-not-live
  (t/async done
    (let [result (with-redefs [wasm/live? (constantly false)]
                   (#'api/replay-chunks (empty-replay-ctx (page-cache/latest-load-token)) 0 replay-state))]
      (-> result
          (p/then (fn [value]
                    (t/is (nil? value) "a load on a renderer that is not live resolves nil")
                    (done)))
          (p/catch (fn [cause]
                     (t/is false (str cause))
                     (done)))))))

(defn- fonts-changed-replay
  "Replays a chunk of a text and a rect, both unchanged on the current page,
  with `fonts-changed?`. Returns the replayed entries and the worker entries."
  [fonts-changed?]
  (let [text-id    (uuid/next)
        rect-id    (uuid/next)
        text       (cts/setup-shape {:id text-id :type :text :x 0 :y 0
                                     :width 80 :height 20 :grow-type :auto-width
                                     :content (text-content :top [(span "Hi" {})])})
        rect       (rect-shape rect-id "#111111")
        objects    (omap/wrap {text-id text rect-id rect})
        raw        (omap/raw-data objects)
        owner      (js/Map.)
        worker     (js/Map.)
        text-entry (ue/encode-entry text identity)
        rect-entry (ue/encode-entry rect identity)
        _          (doseq [[id entry] [[text-id text-entry] [rect-id rect-entry]]]
                     (.set owner (str id) 0)
                     (.set worker (str id) entry))
        result     (#'api/replay-chunk [(str text-id) (str rect-id)]
                                       owner raw objects objects worker fonts-changed?)]
    {:replayed   (:entries result)
     :text-entry text-entry
     :rect-entry rect-entry}))

(t/deftest changed-fonts-re-encode-a-clean-text-on-the-main-thread
  (let [{:keys [replayed text-entry]} (fonts-changed-replay true)]
    (t/is (not (identical? text-entry (nth replayed 0)))
          "the text entry is encoded again")
    (t/is (= (rec-bytes text-entry) (rec-bytes (nth replayed 0))))))

(t/deftest changed-fonts-keep-a-clean-rect-entry
  (let [{:keys [replayed rect-entry]} (fonts-changed-replay true)]
    (t/is (identical? rect-entry (nth replayed 1)))))

(t/deftest unchanged-fonts-keep-a-clean-text-entry
  (let [{:keys [replayed text-entry]} (fonts-changed-replay false)]
    (t/is (identical? text-entry (nth replayed 0)))))

;; --- Resources of the worker upload ----------------------------------------

(defn- by-id
  "The resource maps of `resources`, by their id."
  [resources]
  (into {} (map (juxt :id identity)) resources))

(defn- worker-resources
  "The resources that the worker path of the fixture page gives `apply-entries!`,
  as a vector. The shapes are the decoded ones of `objects`."
  [objects shapes]
  (let [raw (omap/raw-data objects)
        ids (mapv :id shapes)]
    (:resources (:result (recorded #(main-apply (worker-reply raw ids) objects))))))

(t/deftest worker-upload-resources-match-the-decoded-shapes
  (let [objects (omap/from-data (omap/raw-data (omap/wrap (fixture-page))))
        shapes  (tree-shapes objects)
        worker  (worker-resources objects shapes)]
    (t/is (seq worker) "the fixture has shapes that need resources")
    (t/is (= (by-id (keep #'api/shape-resources shapes))
             (by-id worker)))))

(t/deftest collect-page-resources-of-worker-resources-matches-decoded-shapes
  (let [objects     (omap/from-data (omap/raw-data (omap/wrap (fixture-page))))
        shapes      (tree-shapes objects)
        worker      (worker-resources objects shapes)
        from-shapes (recorded #(#'api/collect-page-resources
                                (vec (keep #'api/shape-resources shapes))))
        from-worker (recorded #(#'api/collect-page-resources worker))
        expected    (:result from-shapes)
        actual      (:result from-worker)]
    (t/is (seq (:calls from-shapes)) "collecting the fixture makes WASM calls")
    (t/is (= (:calls from-shapes) (:calls from-worker))
          (str "first differing call: "
               (first-difference (:calls from-shapes) (:calls from-worker))))
    (t/is (= (mapv :key (:thumbnails expected)) (mapv :key (:thumbnails actual))))
    (t/is (= (mapv :key (:full expected)) (mapv :key (:full actual))))
    (t/is (= (:text-font-state expected) (:text-font-state actual)))
    (t/is (= (:image-text-ids expected) (:image-text-ids actual)))
    (t/is (= (:texts expected) (:texts actual)))))

(defn- restore-fixture
  "The fixture page, a summary made from it (as a worker upload leaves it),
  and the page after a change: a text with a new span fill image and a
  removed rect."
  []
  (let [objects  (omap/from-data (omap/raw-data (omap/wrap (fixture-page))))
        shapes   (tree-shapes objects)
        records  (into {}
                       (keep (fn [shape]
                               (when-let [r (#'api/shape-resources shape)]
                                 [(:id shape) r])))
                       shapes)
        summary  (#'api/make-summary (omap/raw-data objects) records ::fonts-db)
        text     (first (filter #(and (= :text (:type %)) (some? (:content %))) shapes))
        rect     (first (filter #(= :rect (:type %)) shapes))
        changed  (update text :content
                         (fn [content]
                           (update-in content [:children 0 :children 0 :children 0]
                                      assoc :fills [{:fill-opacity 1
                                                     :fill-image (image (uuid/next) "c.png")}])))
        current  (-> objects
                     (assoc (:id text) changed)
                     (dissoc (:id rect)))]
    {:objects objects :summary summary :current current :text text :changed changed}))

(t/deftest restore-resources-match-a-full-read-of-an-unchanged-page
  (let [{:keys [objects summary]} (restore-fixture)]
    (t/is (= (#'api/restore-resources nil objects ::fonts-db)
             (#'api/restore-resources summary objects ::fonts-db)))))

(t/deftest restore-resources-read-changed-and-removed-shapes-again
  (let [{:keys [current summary changed]} (restore-fixture)
        resources (#'api/restore-resources summary current ::fonts-db)]
    (t/is (= (#'api/restore-resources nil current ::fonts-db) resources)
          "the summary gives what reading every shape gives")
    (t/is (= 1 (count (:timg (first (filter #(= (:id changed) (:id %)) resources)))))
          "the changed text has its new span image")))

(t/deftest restore-resources-read-texts-again-when-the-fonts-db-changed
  (let [{:keys [objects summary]} (restore-fixture)
        text-id   (some (fn [[id r]] (when (:text? r) id)) (:records summary))
        resources (#'api/restore-resources summary objects ::other-db)]
    (t/is (= (#'api/restore-resources nil objects ::other-db) resources))
    (t/is (not (identical? (get-in summary [:records text-id])
                           (first (filter #(= text-id (:id %)) resources))))
          "a text record is not reused with another fonts DB")))

(t/deftest make-summary-flags-a-raw-map-with-nil-entries
  (t/is (true? (:no-nils? (#'api/make-summary {(uuid/next) "a"} {} nil))))
  (t/is (false? (:no-nils? (#'api/make-summary {(uuid/next) nil} {} nil)))))

(t/deftest restore-resources-read-a-shape-set-over-a-nil-entry
  ;; Setting an entry that is nil already keeps the raw map identical, so the
  ;; summary must not trust the raw map while it holds a nil.
  (let [objects    (omap/from-data (omap/raw-data (omap/wrap (fixture-page))))
        rect       (first (filter #(= :rect (:type %)) (tree-shapes objects)))
        rect-id    (:id rect)
        ;; The rect has no image, so it has no record.
        before     (assoc objects rect-id rect)
        records    (into {}
                         (keep (fn [shape]
                                 (when-let [r (#'api/shape-resources shape)]
                                   [(:id shape) r])))
                         (tree-shapes before))
        summary    (#'api/make-summary (omap/raw-data before) records ::fonts-db)
        image-rect (assoc rect :fills [{:fill-opacity 1
                                        :fill-image (image (uuid/next) "d.png")}])
        current    (assoc before rect-id image-rect)
        resources  (#'api/restore-resources summary current ::fonts-db)]
    (t/is (false? (:no-nils? summary)))
    (t/is (identical? (omap/raw-data before) (omap/raw-data current))
          "setting the nil entry keeps the raw map identical")
    (t/is (= (#'api/restore-resources nil current ::fonts-db) resources)
          "the summary gives what reading every shape gives")
    (t/is (= 1 (count (:fimg (get (by-id resources) rect-id))))
          "the rect with the new image fill has its image")))
