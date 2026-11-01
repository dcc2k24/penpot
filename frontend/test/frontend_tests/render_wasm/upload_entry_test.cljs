;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.render-wasm.upload-entry-test
  "Entries for the WASM upload: the encoded bytes and small data of one shape.
   Pure: no WASM calls, the fonts DB is read but not changed."
  (:require
   [app.common.render-wasm.api.props :as props]
   [app.common.render-wasm.api.upload :as upload]
   [app.common.render-wasm.serializers :as sr]
   [app.common.render-wasm.svg-derived :as svg-derived]
   [app.common.render-wasm.text-content :as tc]
   [app.common.transit :as transit]
   [app.common.types.objects-hints :as ohints]
   [app.common.types.path :as path]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.render-wasm.api.enums]
   [app.render-wasm.api.fonts :as f]
   [app.render-wasm.upload-entry :as ue]
   [app.worker.upload :as wu]
   [cljs.test :as t :include-macros true]))

(def ^:private regular
  {:font-id "sourcesanspro" :font-variant-id "regular"
   :font-weight "400" :font-style "normal"})

(defn- span
  [text]
  (assoc regular :text text))

(defn- text-content
  "A text content with one paragraph per list of spans in `span-lists`."
  [vertical-align & span-lists]
  {:type "root"
   :vertical-align vertical-align
   :children [{:type "paragraph-set"
               :children (mapv (fn [spans]
                                 {:type "paragraph" :children spans})
                               span-lists)}]})

(defn- bytes-of
  "Returns the bytes of a typed array as a vector of numbers."
  [u8]
  (vec (js/Array.from u8)))

(def ^:private rect-shape
  (cts/setup-shape {:id (uuid/next) :type :rect :x 10 :y 20 :width 30 :height 40}))

(def ^:private path-shape
  (cts/setup-shape
   {:id (uuid/next) :type :path
    :content (path/content [{:command :move-to :params {:x 0 :y 0}}
                            {:command :line-to :params {:x 40 :y 0}}
                            {:command :line-to :params {:x 40 :y 40}}])}))

(defn- text-shape
  [content]
  (cts/setup-shape {:id (uuid/next) :type :text :x 0 :y 0 :width 120 :height 40
                    :grow-type :auto-width :content content}))

(t/deftest rect-entry-is-host-0
  (t/testing "a plain rect carries its record and no text, svg or path data"
    (let [e (ue/encode-entry rect-shape identity)]
      (t/is (= (str (:id rect-shape)) (unchecked-get e "id")))
      (t/is (= 0 (unchecked-get e "host")))
      (t/is (nil? (unchecked-get e "text")))
      (t/is (nil? (unchecked-get e "svg")))
      (t/is (nil? (unchecked-get e "path")))
      (t/is (= [] (vec (unchecked-get e "fimg"))) "a solid fill has no image id")
      (t/is (= (bytes-of (upload/encode-shape-record
                          (svg-derived/apply-svg-derived rect-shape)
                          {:include-layout? true :include-fills-strokes? true}))
               (bytes-of (unchecked-get e "rec")))))))

(t/deftest path-entry-carries-path-bytes
  (t/testing "a path shape carries the padded path bytes"
    (let [e (ue/encode-entry path-shape identity)]
      (t/is (= 0 (unchecked-get e "host")))
      (t/is (= (bytes-of (props/encode-path-content (:content path-shape)))
               (bytes-of (unchecked-get e "path")))))))

(t/deftest host-1-shapes-are-set-up-on-the-main-thread
  (t/testing "grid frames, svg-raw with markup and text without content are host 1"
    (let [grid    (cts/setup-shape {:id (uuid/next) :type :frame :layout :grid
                                    :x 0 :y 0 :width 100 :height 100})
          svg-raw (cts/setup-shape {:id (uuid/next) :type :svg-raw
                                    :x 0 :y 0 :width 10 :height 10
                                    :content "<svg></svg>"})
          no-text (cts/setup-shape {:id (uuid/next) :type :text
                                    :x 0 :y 0 :width 10 :height 10})]
      (doseq [shape [grid svg-raw no-text]
              :let [e (ue/encode-entry shape identity)]]
        (t/is (= 1 (unchecked-get e "host")))
        (t/is (nil? (unchecked-get e "text")))
        (t/is (nil? (unchecked-get e "timg")))
        (t/is (nil? (unchecked-get e "fimg")))
        (t/is (nil? (unchecked-get e "simg")))))))

(t/deftest text-entry-encodes-paragraphs-with-spans
  (t/testing "only paragraphs with spans are encoded, with their fonts and box"
    (let [spans     [(span "Hello ") (span "world")]
          paragraph {:type "paragraph" :children spans}
          content   (text-content :center spans [])
          shape     (text-shape content)
          faces     (volatile! [])
          e         (ue/encode-entry shape (fn [font]
                                             (vswap! faces conj font)
                                             font))
          text      (unchecked-get e "text")
          paras     (unchecked-get text "paras")
          opts      {:normalize-paragraph f/normalize-paragraph-font
                     :normalize-span      f/normalize-span-font}]
      (t/is (= 0 (unchecked-get e "host")))
      (t/is (= 1 (alength paras)) "the empty second paragraph is skipped")
      (t/is (= (bytes-of (tc/encode-paragraph spans paragraph "Hello world" opts))
               (bytes-of (aget paras 0))))
      (t/is (= (sr/translate-vertical-align :center) (unchecked-get text "va")))
      (t/is (= "auto-width" (unchecked-get text "grow")))
      (t/is (= 120 (unchecked-get text "w")))
      (t/is (= 40 (unchecked-get text "h")))
      (t/is (= (f/get-content-fonts content) (set (seq (unchecked-get text "fonts")))))
      (t/is (= [] (vec (seq (unchecked-get text "fallback")))) "plain text needs no fallback face")
      (t/is (= (f/get-content-fonts content) (set @faces))
            "every face goes through the intern fn"))))

(t/deftest text-entry-fallback-includes-emoji-face
  (t/testing "emoji text lists the same fallback faces as the font helper"
    (let [content  (text-content :top [(span (str "Hi " (js/String.fromCharCode 0xD83D 0xDE00)))])
          e        (ue/encode-entry (text-shape content) identity)
          fallback (unchecked-get (unchecked-get e "text") "fallback")]
      (t/is (some #(= "gfont-noto-color-emoji" (:font-id %))
                  (f/text-fallback-fonts content)))
      (t/is (= (vec (f/text-fallback-fonts content))
               (vec (seq fallback)))))))

(t/deftest shape-structure-lists-child-ids-and-hint
  (t/testing "a frame gives its child ids and a hint, a rect gives neither"
    (let [child-a (uuid/next)
          child-b (uuid/next)
          frame   (cts/setup-shape {:id (uuid/next) :type :frame
                                    :x 0 :y 0 :width 50 :height 50
                                    :shapes [child-a child-b]})
          s-frame (ue/shape-structure frame)
          s-rect  (ue/shape-structure rect-shape)]
      (t/is (= [(str child-a) (str child-b)] (vec (aget s-frame 0))))
      (t/is (= :frame (first (ue/hint->entry (aget s-frame 1)))))
      (t/is (nil? (aget s-rect 0)))
      (t/is (nil? (aget s-rect 1))))))

(t/deftest shape-structure-hint-is-a-plain-js-object
  (t/testing "the hint has no CLJS values, so it survives a structured clone"
    (let [frame (cts/setup-shape {:id (uuid/next) :type :frame
                                  :x 0 :y 0 :width 50 :height 50})
          h     (aget (ue/shape-structure frame) 1)]
      (t/is (not (map? h)))
      (t/is (= "frame" (unchecked-get h "k"))))))

(t/deftest shape-hint-round-trips-through-structure
  (t/testing "a frame and a text give the same hint, also after a structured clone"
    (let [grid  (cts/setup-shape {:id (uuid/next) :type :frame
                                  :x 0 :y 0 :width 50 :height 50
                                  :grids [{:display true}]})
          text  (text-shape (text-content :top [(assoc (span "Hi") :font-family "Source Sans Pro")]))
          empty (text-shape nil)]
      (doseq [s [grid text empty]]
        (let [structure (js/structuredClone (ue/shape-structure s))]
          (t/is (= (ohints/shape-hint s)
                   (ue/hint->entry (aget structure 1)))))))))

(t/deftest hint-of-a-text-keeps-its-font-ids
  (t/testing "the font ids of a text hint come back as a CLJS vector"
    (let [text (text-shape (text-content :top [(assoc (span "Hi") :font-family "Source Sans Pro")]))
          hint (ue/hint->entry (aget (ue/shape-structure text) 1))]
      (t/is (= :text (first hint)))
      (t/is (= ["sourcesanspro"] (get-in hint [1 :font-ids]))))))

(t/deftest pack-entries-copies-bytes-into-one-aligned-buffer
  (t/testing "every byte field keeps its bytes and views one 8-aligned buffer"
    (let [entries  [(ue/encode-entry rect-shape identity)
                    (ue/encode-entry path-shape identity)
                    (ue/encode-entry (text-shape (text-content :top [(span "Hello")]))
                                     identity)]
          byte-views (fn [^js e]
                       (let [text (unchecked-get e "text")]
                         (->> (cond-> [(unchecked-get e "rec") (unchecked-get e "path")]
                                (some? text) (into (vec (unchecked-get text "paras"))))
                              (remove nil?)
                              (vec))))
          before     (mapv #(mapv bytes-of (byte-views %)) entries)
          buffer     (ue/pack-entries! (into-array entries))]
      (t/is (instance? js/ArrayBuffer buffer))
      (doseq [[e expected] (map vector entries before)
              [view want]  (map vector (byte-views e) expected)]
        (t/is (instance? js/Uint8Array view))
        (t/is (identical? buffer (.-buffer view)))
        (t/is (zero? (mod (.-byteOffset view) 8)))
        (t/is (= want (bytes-of view)))))))

(t/deftest worker-job-encodes-a-shape-that-is-asked-again
  (t/testing "a shape under two parents is asked again, in one or two requests"
    (let [sid      (str (:id rect-shape))
          job      (str (uuid/next))
          _        (#'wu/handle-load #js {:job job :req 1
                                          :ids #js [sid]
                                          :strs #js [(transit/encode-str rect-shape)]})
          encode   (fn [req ids]
                     (let [[reply _] (#'wu/handle-encode #js {:job job :req req :ids ids})]
                       (mapv #(bytes-of (unchecked-get % "rec"))
                             (array-seq (unchecked-get reply "entries")))))
          once     (encode 2 #js [sid])
          again    (encode 3 #js [sid])
          twice    (encode 4 #js [sid sid])]
      (t/is (= 1 (count once)))
      (t/is (= once again) "the second request encodes the same bytes")
      (t/is (= [(first once) (first once)] twice)
            "an id listed twice in one request gives two equal entries")
      (wu/handle! #js {:op "release" :job job}))))
