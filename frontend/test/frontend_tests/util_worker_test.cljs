;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.util-worker-test
  "Tests for the web worker wrapper `app.util.worker`: each request gets
  the reply with its own sender id. Node has no `Worker`, so a fake one is
  installed for each test."
  (:require
   [app.common.uuid :as uuid]
   [app.util.worker :as uw]
   [app.worker.messages :as wm]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]))

(defn- fake-worker-class
  "Returns a stand-in for the `Worker` constructor. Each instance it makes
  is added to `instances`, records the data posted to it in `posted`, and
  keeps its `message` listener in `messageListener`."
  [instances]
  (let [ctor (fn [_path]
               (this-as this
                        (set! (.-posted ^js this) #js [])
                        (swap! instances conj this)
                        ;; `new` must answer `this`: a constructor that returns an
                        ;; object, such as the vector from `swap!`, replaces it.
                        nil))
        proto (.-prototype ^js ctor)]
    (set! (.-postMessage proto)
          (fn [data _transfer]
            (this-as this
                     (.push (.-posted ^js this) data))))
    (set! (.-addEventListener proto)
          (fn [event-name listener]
            (this-as this
                     (when (= "message" event-name)
                       (set! (.-messageListener ^js this) listener)))))
    ctor))

(defn- with-fake-worker
  "Calls `f` with the atom of fake instances, with a fake `Worker` in
  place. The real `Worker` is restored afterwards."
  [f]
  (let [original  (.-Worker js/globalThis)
        instances (atom [])]
    (set! (.-Worker js/globalThis) (fake-worker-class instances))
    (try
      (f instances)
      (finally
        (set! (.-Worker js/globalThis) original)))))

(defn- deliver-reply
  "Delivers `message` to the message listener of `instance`, as the
  worker would reply."
  [instance message]
  ((.-messageListener ^js instance) #js {:data (wm/encode message)}))

(defn- sender-ids
  "Returns the sender ids of the requests posted to `instance`, in order."
  [instance]
  (mapv #(.-senderId ^js %) (.-posted ^js instance)))

(defn- collect
  "Subscribes to `ob`, and returns an atom that collects its values."
  [ob]
  (let [got (atom [])]
    (rx/subs! #(swap! got conj %) ob)
    got))

;; Scenario: two requests wait at once, and the reply to the second arrives
;; first. Proves: each reply reaches only the request it answers.
(t/deftest replies-reach-only-their-own-request
  (with-fake-worker
    (fn [instances]
      (let [worker (uw/init "fake" (fn [_]))
            inst   (first @instances)
            got-a  (collect (uw/ask! worker {:cmd :a}))
            got-b  (collect (uw/ask! worker {:cmd :b}))
            [id-a id-b] (sender-ids inst)]
        (deliver-reply inst {:reply-to id-b :payload {:value :b}})
        (t/is (= [] @got-a) "the first request is not answered by the second reply")
        (t/is (= [{:value :b}] @got-b))
        (deliver-reply inst {:reply-to id-a :payload {:value :a}})
        (t/is (= [{:value :a}] @got-a))
        (t/is (= [{:value :b}] @got-b) "the second request gets one reply only")))))

;; Scenario: a request waits for its reply. Proves: while it waits it is the
;; only entry in the table, and once its reply arrives the table is empty.
(t/deftest the-reply-table-holds-a-request-only-while-it-waits
  (with-fake-worker
    (fn [instances]
      (let [worker (uw/init "fake" (fn [_]))
            inst   (first @instances)
            got    (collect (uw/ask! worker {:cmd :a}))
            [id]   (sender-ids inst)]
        (t/is (= 1 (.-size (:pending worker))))
        (deliver-reply inst {:reply-to id :payload {:value 1}})
        (t/is (= [{:value 1}] @got))
        (t/is (= 0 (.-size (:pending worker))))))))

;; Scenario: a request asks for many replies. Proves: every reply before the
;; one marked completed is delivered, and the marked reply ends the request.
(t/deftest ask-many-delivers-replies-until-the-completed-one
  (with-fake-worker
    (fn [instances]
      (let [worker (uw/init "fake" (fn [_]))
            inst   (first @instances)
            got    (atom [])
            _      (rx/subs! #(swap! got conj %)
                             (uw/ask-many! worker {:cmd :stream}))
            [id]   (sender-ids inst)]
        (deliver-reply inst {:reply-to id :payload {:value 1}})
        (deliver-reply inst {:reply-to id :payload {:value 2}})
        (deliver-reply inst {:reply-to id :completed true})
        (t/is (= [{:value 1} {:value 2}] @got))
        (t/is (= 0 (.-size (:pending worker))) "the request leaves the table")))))

;; Scenario: the worker drops a buffered request and says so. The message
;; codec (`app.worker.messages`) does not carry the `:dropped` flag, so the
;; notice arrives as a reply with no payload. Proves: the notice ends the
;; request and the request leaves the table.
(t/deftest a-dropped-notice-ends-the-request
  (with-fake-worker
    (fn [instances]
      (let [worker    (uw/init "fake" (fn [_]))
            inst      (first @instances)
            completed (atom false)
            _         (rx/subs! (fn [_])
                                (fn [_] (t/is false "unexpected error"))
                                (fn [] (reset! completed true))
                                (uw/ask! worker {:cmd :a}))
            [id]      (sender-ids inst)]
        (deliver-reply inst {:reply-to id :dropped true})
        (t/is (true? @completed) "the request completes")
        (t/is (= 0 (.-size (:pending worker))) "the request leaves the table")))))

;; Scenario: a reply carries an error at the top level. Proves: the error goes
;; to the handler, and no waiting request receives a value.
(t/deftest a-top-level-error-reply-goes-to-on-error-only
  (with-fake-worker
    (fn [instances]
      (let [errors (atom [])
            worker (uw/init "fake" (fn [err] (swap! errors conj err)))
            inst   (first @instances)
            got    (collect (uw/ask! worker {:cmd :a}))
            [id]   (sender-ids inst)]
        (deliver-reply inst {:reply-to id :error {:message "boom"}})
        (t/is (= [{:message "boom"}] @errors))
        (t/is (= [] @got))))))

;; Scenario: a reply arrives for a request nobody waits for. Proves: the reply
;; is dropped without an error, and a request still waiting gets nothing.
(t/deftest a-reply-with-no-waiting-request-is-dropped
  (with-fake-worker
    (fn [instances]
      (let [worker (uw/init "fake" (fn [_]))
            inst   (first @instances)
            got    (collect (uw/ask! worker {:cmd :a}))]
        (deliver-reply inst {:reply-to (str (uuid/next)) :payload {:value 1}})
        (t/is (= [] @got))
        (t/is (= 1 (.-size (:pending worker))) "the waiting request is still listed")))))
