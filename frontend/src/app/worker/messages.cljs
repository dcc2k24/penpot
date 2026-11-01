;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.worker.messages
  "A lightweight layer on top of webworkers api."
  (:require
   [app.common.data :as d]
   [app.common.transit :as t]
   [app.util.object :as obj]))

(defn encode
  "Serializes a worker message for `postMessage`.

  Transit cannot carry `js/Blob`. If the payload map has `:blob`, or the
  message already has a top-level `:blob`, that value is sent as a
  structured-clone field beside the Transit string — not inside it.

  The same goes for `:raw`, a JS object in a map payload (the raw entries
  of an ObjectsMap). It is sent as the `raw` field, so Transit does not
  escape its strings a second time."
  [{:keys [sender-id reply-to payload buffer? blob completed error]}]
  (let [;; Peel `:blob` out of map payloads before Transit (selection/snap
        ;; replies are vectors and other non-maps; leave them untouched).
        inline-blob (when (map? payload) (:blob payload))
        blob        (or blob inline-blob)

        ;; Peel `:raw` out of map payloads the same way.
        raw         (when (map? payload) (:raw payload))

        payload     (cond-> payload
                      (some? inline-blob)
                      (dissoc :blob)

                      (some? raw)
                      (dissoc :raw))
        obj #js {:cmd (d/name (:cmd payload))
                 :senderId (when sender-id (str sender-id))
                 :replyTo (when reply-to (str reply-to))
                 :payload (if (= :initialize-indices (:cmd payload))
                            (:file-raw payload)
                            (when (some? payload) (t/encode-str payload)))
                 :buffer (when (some? buffer?) buffer?)
                 :completed (when completed true)}]
    (when (some? blob)
      (obj/set! obj "blob" blob))
    (when (some? raw)
      (obj/set! obj "raw" raw))
    (when (some? error)
      (obj/set! obj "error" (clj->js error)))
    obj))

(defn- js->error-map
  [^js err]
  (when err
    (let [m (js->clj err :keywordize-keys true)]
      (cond-> m
        (string? (:data m))
        (assoc :data nil)))))

(defn decode [^js data]
  (let [cmd (obj/get data "cmd")
        sender-id (obj/get data "senderId")
        reply-to (obj/get data "replyTo")
        payload (obj/get data "payload")
        buffer (obj/get data "buffer")
        blob (obj/get data "blob")
        raw (obj/get data "raw")
        completed (obj/get data "completed")
        error (obj/get data "error")
        decoded
        (d/without-nils
         {:sender-id (when sender-id (uuid sender-id))
          :reply-to (when reply-to (uuid reply-to))
          :payload (if (= cmd "initialize-indices")
                     {:cmd :initialize-indices
                      :file-raw payload}
                     (when (some? payload) (t/decode-str payload)))
          :buffer? buffer
          :completed completed
          :error (js->error-map error)})]
    (cond-> decoded
      (some? blob)
      (update :payload assoc :blob blob)

      (some? raw)
      (update :payload assoc :raw raw))))
