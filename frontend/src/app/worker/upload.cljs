;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.worker.upload
  "Worker side of the upload pool (see `app.render-wasm.upload-pool`).

  Messages are plain JS objects with `penpotUpload` set, never transit.
  A job keeps its decoded shapes in a map until the job is released."
  (:require
   [app.common.fonts :as cfnt]
   [app.common.logging :as log]
   [app.common.transit :as t]
   [app.main.fonts :as fonts]
   [app.render-wasm.api.fonts :as f]
   [app.render-wasm.upload-entry :as ue]))

;; job id -> js/Map (shape id string -> decoded shape)
(defonce ^:private jobs (js/Map.))

(defn- job-shapes
  "Returns the shape map of `job`, creating it on first use."
  [job]
  (or (.get jobs job)
      (let [shapes (js/Map.)]
        (.set jobs job shapes)
        shapes)))

(defn- handle-config
  "Registers the google catalog and the custom fonts sent by the main thread."
  [^js msg]
  (let [{:keys [google? custom]} (t/decode-str (unchecked-get msg "fonts"))]
    (fonts/register! :google (if google? cfnt/catalog []))
    (fonts/register! :custom custom)
    [#js {:penpotUpload true
          :req (unchecked-get msg "req")
          :ok true}
     nil]))

(defn- handle-load
  "Decodes the shapes sent with `ids` and replies with the structure of each."
  [^js msg]
  (let [^js shapes (job-shapes (unchecked-get msg "job"))
        ids        (unchecked-get msg "ids")
        strs       (unchecked-get msg "strs")
        structure  #js []]
    (dotimes [i (alength ids)]
      (let [shape (t/decode-str (aget strs i))]
        (.set shapes (aget ids i) shape)
        (.push structure (ue/shape-structure shape))))
    [#js {:penpotUpload true
          :req (unchecked-get msg "req")
          :structure structure}
     nil]))

(defn- handle-encode
  "Encodes the shapes of `ids` into upload entries packed in one buffer. The
  shapes stay in the job, as an id can be asked again: a shape under two
  parents is uploaded once per parent."
  [^js msg]
  (let [^js shapes (job-shapes (unchecked-get msg "job"))
        ids        (unchecked-get msg "ids")
        font-vec   (volatile! [])
        font-index (volatile! {})

        intern-font
        (fn [font]
          (or (get @font-index font)
              (let [idx (count @font-vec)]
                (vswap! font-vec conj font)
                (vswap! font-index assoc font idx)
                idx)))

        entries
        (f/call-with-batch-memo
         (fn []
           (let [entries #js []]
             (dotimes [i (alength ids)]
               (let [id    (aget ids i)
                     shape (.get shapes id)]
                 (when (nil? shape)
                   (throw (ex-info "shape missing from upload job" {:id id})))
                 (.push entries (ue/encode-entry shape intern-font))))
             entries)))

        buffer (ue/pack-entries! entries)]
    [#js {:penpotUpload true
          :req (unchecked-get msg "req")
          :entries entries
          :fontTable (t/encode-str @font-vec)}
     #js [buffer]]))

(defn handle!
  "Runs one raw upload message and posts its reply. A `release` message drops
  its job and posts nothing."
  [^js msg]
  (let [op  (unchecked-get msg "op")
        req (unchecked-get msg "req")]
    (if (= "release" op)
      (.delete jobs (unchecked-get msg "job"))
      (let [[reply transfer]
            (try
              (case op
                "config" (handle-config msg)
                "load"   (handle-load msg)
                "encode" (handle-encode msg)
                (throw (ex-info "unknown upload op" {:op op})))
              (catch :default e
                (log/error :hint "upload worker failed" :op op :cause e)
                [#js {:penpotUpload true
                      :req req
                      :error (or (ex-message e) (str e))}
                 nil]))]
        (.postMessage js/self reply (or transfer #js []))))))
