;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.util.worker
  "A lightweight layer on top of webworkers api. Each request waits for
  its own reply, found by the sender id."
  (:require
   [app.common.uuid :as uuid]
   [app.util.object :as obj]
   [app.worker.messages :as wm]
   [beicon.v2.core :as rx]))

(declare handle-response)
(defrecord Worker [instance pending])

(defn- get-replies
  "Returns an observable of the replies to the request `sender-id`.
  Subscribing adds the subscriber to the waiting set for that id in
  `pending`. Unsubscribing removes it, and removes the id once no
  subscriber waits for it."
  [^js pending sender-id]
  (let [id (str sender-id)]
    (rx/create
     (fn [subscriber]
       (let [subs (or (.get pending id)
                      (let [subs (js/Set.)]
                        (.set pending id subs)
                        subs))]
         (.add subs subscriber)
         (fn []
           (.delete subs subscriber)
           (when (zero? (.-size subs))
             (.delete pending id))))))))

(defn- send-message!
  ([worker message]
   (send-message! worker message nil))

  ([worker {sender-id :sender-id :as message} {:keys [many? ignore-response?] :or {many? false ignore-response? false}}]
   (let [take-messages
         (fn [ob]
           (if many?
             (rx/take-while #(not (:completed %)) ob)
             (rx/take 1 ob)))

         transfer (:transfer message)
         data (cond-> (wm/encode (dissoc message :transfer))
                (some? transfer)
                (obj/set! "transfer" transfer))
         instance (:instance worker)]

     (if (some? instance)
       (do (.postMessage instance data transfer)
           (if (not ignore-response?)
             (->> (get-replies (:pending worker) sender-id)
                  (take-messages)
                  (rx/filter (complement :dropped))
                  (rx/map handle-response))
             (rx/empty)))
       (rx/empty)))))

(defn ask!
  ([worker message]
   (ask! worker message nil))
  ([worker message transfer]
   (send-message!
    worker
    {:sender-id (uuid/next)
     :payload message
     :transfer transfer})))

(defn emit!
  ([worker message]
   (emit! worker message nil))
  ([worker message transfer]
   (send-message!
    worker
    {:sender-id (uuid/next)
     :payload message
     :transfer transfer}
    {:ignore-response? true})))

(defn ask-many!
  ([worker message]
   (ask-many! worker message nil))
  ([worker message transfer]
   (send-message!
    worker
    {:sender-id (uuid/next)
     :payload message
     :transfer transfer}
    {:many? true})))

(defn ask-buffered!
  ([worker message]
   (ask-buffered! worker message nil))
  ([worker message transfer]
   (send-message!
    worker
    {:sender-id (uuid/next)
     :payload message
     :buffer? true
     :transfer transfer})))

(defn init
  "Return a initialized webworker instance. Replies go to the waiting
  subscribers of their request; a reply nobody waits for is dropped."
  [path on-error]
  (let [instance (js/Worker. path)
        pending  (js/Map.)
        worker   (Worker. instance pending)

        handle-message
        (fn [event]
          (let [message (wm/decode (.-data event))]
            (if (:error message)
              (on-error (:error message))
              (when-let [subs (.get ^js pending (str (:reply-to message)))]
                (doseq [subscriber (js/Array.from subs)]
                  (rx/push! subscriber message))))))

        handle-error
        (fn [event]
          (on-error worker (.-data event)))]

    (.addEventListener instance "message" handle-message)
    (.addEventListener instance "error" handle-error)

    worker))

(defn- handle-response
  [{:keys [payload error]}]
  (if-let [{:keys [data message]} error]
    (throw (ex-info message data))
    payload))

