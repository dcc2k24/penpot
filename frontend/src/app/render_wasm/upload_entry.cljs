;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.render-wasm.upload-entry
  "An entry is the encoded form of one shape for the WASM upload: the bytes
  and small data that replay the upload calls for that shape. Entries are
  built in the upload web workers, and on the main thread for shapes that
  change during a load. `app.render-wasm.api` replays an entry with the same
  WASM calls as the main-thread upload, so this ns must not require it."
  (:require
   [app.common.data.macros :as dm]
   [app.common.render-wasm.api.props :as props]
   [app.common.render-wasm.api.upload :as upload]
   [app.common.render-wasm.serializers :as sr]
   [app.common.render-wasm.svg-derived :as svg-derived]
   [app.common.render-wasm.text-content :as tc]
   [app.common.types.fills :as types.fills]
   [app.common.types.objects-hints :as ohints]
   [app.common.types.shape.layout :as ctl]
   [app.render-wasm.api.fonts :as f]))

(defn stroke-image-ids
  "Returns the ids of the image fills of the visible `strokes`."
  [strokes]
  (into []
        (comp (remove :hidden)
              (keep #(get-in % [:stroke-image :id])))
        (or strokes [])))

(defn- paragraphs-of
  "Returns the paragraphs of a text `content`."
  [content]
  (get (first (get content :children)) :children))

(defn- text-image-ids
  "Returns the image id of every span fill in a text `content`, as strings.
  Uses every paragraph, also the empty ones."
  [content]
  (let [fills (->> (paragraphs-of content)
                   (mapcat :children)
                   (mapcat #(filter :fill-image (:fills %))))]
    (into-array (map #(some-> (get-in % [:fill-image :id]) str) fills))))

(defn- text-part
  "Returns the text data of a host 0 text shape `s` with `content`: the
  encoded paragraphs, the font faces, and the grow type and box size."
  [s content intern-font]
  (let [opts {:normalize-paragraph f/normalize-paragraph-font
              :normalize-span      f/normalize-span-font}
        paras (for [paragraph (paragraphs-of content)
                    :let [spans (get paragraph :children)]
                    :when (seq spans)]
                (tc/encode-paragraph spans paragraph
                                     (apply str (map :text spans))
                                     opts))]
    #js {:va       (sr/translate-vertical-align (get content :vertical-align))
         :paras    (into-array paras)
         :fonts    (into-array (map intern-font (f/get-content-fonts content)))
         :fallback (into-array (map intern-font (f/text-fallback-fonts content)))
         :grow     (some-> (:grow-type s) name)
         :w        (dm/get-in s [:selrect :width])
         :h        (dm/get-in s [:selrect :height])}))

(defn encode-entry
  "Encodes a decoded `shape` into a JS object with the bytes and small data
  that replay its upload. `shape` is not yet svg-derived: this fn derives it
  and uses the derived shape everywhere. `intern-font` maps a font face to the
  value kept in the `fonts` and `fallback` arrays. Workers pass an index into
  a reply table, the main thread passes the face itself.

  Host 1 shapes (svg-raw with content, grid layout, text without content) are
  set up on the main thread with `set-object-host-attrs`; their text, image
  and fill fields are nil."
  [shape intern-font]
  (let [s       (svg-derived/apply-svg-derived shape)
        type    (:type s)
        content (:content s)
        host1?  (or (and (= type :svg-raw) (some? content))
                    (ctl/grid-layout? s)
                    (and (= type :text) (nil? content)))
        text?   (and (not host1?) (= type :text))]
    #js {:id   (str (:id s))
         :rec  (upload/encode-shape-record s {:include-layout? true
                                              :include-fills-strokes? true})
         :svg  (when (some? (:svg-attrs s))
                 (props/svg-attrs-values (:svg-attrs s)))
         :path (when (and (contains? #{:path :bool} type) (some? content))
                 (props/encode-path-content content))
         :host (if host1? 1 0)
         :text (when text? (text-part s content intern-font))
         :timg (when text? (text-image-ids content))
         :fimg (when (and (not host1?) (seq (:fills s)))
                 (into-array (map str (types.fills/get-image-ids
                                       (types.fills/coerce (:fills s))))))
         :simg (when-not host1?
                 (into-array (map str (stroke-image-ids
                                       (if (= type :group) [] (:strokes s))))))}))

(defn- hint-object
  "Returns the hint of `shape` as a plain JS object, or nil. Plain objects
  survive a structured clone, CLJS vectors and keywords do not."
  [shape]
  (when-let [[kind data] (ohints/shape-hint shape)]
    (case kind
      :frame #js {:k "frame"
                  :b (some-> (:bounds data) into-array)
                  :g (boolean (:grid? data))}
      :text  #js {:k "text"
                  :f (into-array (:font-ids data))
                  :n (boolean (:no-position-data? data))})))

(defn shape-structure
  "Returns `#js [children hint]` for a decoded `shape`, which is not yet
  svg-derived. `children` holds the child ids as strings in order, or nil when
  the shape has no `:shapes`. `hint` is a plain JS object for a frame or text
  (see `hint->entry`), or nil."
  [shape]
  #js [(some->> (:shapes shape) (map str) (into-array))
       (hint-object shape)])

(defn hint->entry
  "Returns the shape hint `[kind data]` for a hint object `h` made by
  `shape-structure`, or nil. Reads the fields with string keys."
  [^js h]
  (when (some? h)
    (case (unchecked-get h "k")
      "frame" [:frame {:bounds (some-> (unchecked-get h "b") vec)
                       :grid?  (unchecked-get h "g")}]
      "text"  [:text {:font-ids          (vec (unchecked-get h "f"))
                      :no-position-data? (unchecked-get h "n")}]
      nil)))

(defn- align8
  "Rounds `n` up to a multiple of 8."
  [n]
  (* 8 (quot (+ n 7) 8)))

(defn- visit-fields
  "Calls `(visit owner key u8)` for every byte field of `entries`: the `rec`
  and `path` of each entry, and each paragraph of its text. `owner` and `key`
  say where the field is kept, so `visit` can replace it."
  [^js entries visit]
  (dotimes [i (alength entries)]
    (let [^js e    (aget entries i)
          rec      (unchecked-get e "rec")
          path     (unchecked-get e "path")
          ^js text (unchecked-get e "text")]
      (when (some? rec)
        (visit e "rec" rec))
      (when (some? path)
        (visit e "path" path))
      (when (some? text)
        (let [^js paras (unchecked-get text "paras")]
          (dotimes [j (alength paras)]
            (visit paras j (aget paras j))))))))

(defn pack-entries!
  "Copies the byte fields of `entries` into one new ArrayBuffer, each at an
  8-byte aligned offset, and replaces every field with a Uint8Array view on
  that buffer. Returns the buffer, so the caller can pass it as transferable."
  [^js entries]
  (let [end (volatile! 0)]
    (visit-fields entries (fn [_owner _key ^js u8]
                            (vswap! end #(+ (align8 %) (.-byteLength u8)))))
    (let [buffer (js/ArrayBuffer. @end)
          offset (volatile! 0)]
      (visit-fields entries (fn [owner key ^js u8]
                              (let [at   (align8 @offset)
                                    size (.-byteLength u8)
                                    view (js/Uint8Array. buffer at size)]
                                (.set view u8)
                                (vreset! offset (+ at size))
                                (unchecked-set owner key view))))
      buffer)))
