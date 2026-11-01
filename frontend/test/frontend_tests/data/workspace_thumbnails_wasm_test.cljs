;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.workspace-thumbnails-wasm-test
  (:require
   [app.main.data.workspace.thumbnails-wasm :as thumbnails-wasm]
   [app.render-wasm.api :as wasm.api]
   [app.util.timers :as timers]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [frontend-tests.helpers.async :as async]
   [frontend-tests.helpers.mock :as mock]
   [promesa.core :as p]))

(defn- reset-turn-chain!
  "Starts a test from an empty turn chain, so a turn an earlier test left
  unreleased cannot hold this test back."
  []
  (reset! @#'thumbnails-wasm/idle-turn* (p/resolved nil)))

(defn- idle-fake
  "Stands in for `timers/schedule-on-idle`. Queues the callback instead of
  running it. Disposing the request removes its callback from the queue, as
  cancelling a real idle request does."
  [queue]
  (mock/stub
   (fn [f]
     (swap! queue conj f)
     (reify rx/IDisposable
       (-dispose [_]
         (swap! queue (fn [q] (vec (remove #(identical? % f) q)))))))))

(defn- deadline-fake
  "Stands in for `timers/schedule`. Queues `[ms f]` instead of running it.
  Disposing the request removes its entry from the queue, as cancelling a
  real timeout does."
  [queue]
  (mock/stub
   (fn [ms f]
     (let [entry [ms f]]
       (swap! queue conj entry)
       (reify rx/IDisposable
         (-dispose [_]
           (swap! queue (fn [q] (vec (remove #(identical? % entry) q))))))))))

(defn- run-next-idle!
  "Removes the oldest queued idle callback and runs it."
  [queue]
  (let [f (first @queue)]
    (t/is (some? f) "an idle callback is queued")
    (swap! queue (fn [q] (vec (rest q))))
    (when (some? f)
      (f))))

(defn- run-next-deadline!
  "Removes the oldest queued deadline and runs its callback."
  [queue]
  (let [[_ f] (first @queue)]
    (t/is (some? f) "a deadline is queued")
    (swap! queue (fn [q] (vec (rest q))))
    (when (some? f)
      (f))))

(defn- subscribe-turn
  "Subscribes to the private `wait-idle-turn`. Records emitted values and
  errors in `seen`, and appends `label` to `log` when the turn emits."
  [label log]
  (let [seen (atom {:values [] :errors [] :completed? false})
        sub  (rx/subscribe
              (#'thumbnails-wasm/wait-idle-turn)
              (fn [v]
                (swap! seen update :values conj v)
                (swap! log conj label))
              (fn [e]
                (swap! seen update :errors conj e))
              (fn []
                (swap! seen assoc :completed? true)))]
    {:sub sub :seen seen}))

(t/deftest ^:async turn-waits-for-pending-canvas-render
  (reset-turn-chain!)
  (let [queue     (atom [])
        log       (atom [])
        pending?  (atom true)
        deadlines (atom [])]
    (await
     (mock/with-mocks*
       {timers/schedule-on-idle  (idle-fake queue)
        timers/schedule          (deadline-fake deadlines)
        wasm.api/render-pending? (fn [] @pending?)}
       (let [turn (subscribe-turn :turn log)]
         (await (async/wait-for #(= 1 (count @queue)) "turn callback queued"))
         ;; Canvas render still pending: the callback re-schedules, no emit.
         (run-next-idle! queue)
         (t/is (empty? (:values @(:seen turn))))
         (t/is (= 1 (count @queue)))
         ;; Canvas render done: the re-scheduled callback emits once and completes.
         (reset! pending? false)
         (run-next-idle! queue)
         (t/is (= [nil] (:values @(:seen turn))))
         (t/is (true? (:completed? @(:seen turn))))
         (t/is (= 0 (count @queue))))))))

(t/deftest ^:async turns-run-in-request-order
  (reset-turn-chain!)
  (let [queue     (atom [])
        log       (atom [])
        deadlines (atom [])]
    (await
     (mock/with-mocks*
       {timers/schedule-on-idle  (idle-fake queue)
        timers/schedule          (deadline-fake deadlines)
        wasm.api/render-pending? (fn [] false)}
       (let [turn-a (subscribe-turn :a log)
             turn-b (subscribe-turn :b log)]
         (await (async/wait-for #(= 1 (count @queue)) "turn A queued"))
         (await (async/settle))
         ;; Turn B waits for turn A: only A has an idle callback.
         (t/is (= 1 (count @queue)))
         (run-next-idle! queue)
         (t/is (= [:a] @log))
         (await (async/wait-for #(= 1 (count @queue)) "turn B queued"))
         (t/is (empty? (:values @(:seen turn-b))))
         (run-next-idle! queue)
         (t/is (= [:a :b] @log))
         (t/is (= [nil] (:values @(:seen turn-a))))
         (t/is (= [nil] (:values @(:seen turn-b)))))))))

(t/deftest ^:async disposed-turn-releases-the-next-one
  (reset-turn-chain!)
  (let [queue     (atom [])
        log       (atom [])
        deadlines (atom [])]
    (await
     (mock/with-mocks*
       {timers/schedule-on-idle  (idle-fake queue)
        timers/schedule          (deadline-fake deadlines)
        wasm.api/render-pending? (fn [] false)}
       (let [turn-a (subscribe-turn :a log)
             turn-b (subscribe-turn :b log)]
         (await (async/wait-for #(= 1 (count @queue)) "turn A queued"))
         (await (async/settle))
         (t/is (= 1 (count @queue)))
         ;; Dispose A before its idle callback runs: its callback is cancelled
         ;; and turn B proceeds.
         (rx/dispose! (:sub turn-a))
         (await (async/wait-for #(= 1 (count @queue)) "turn B queued"))
         (t/is (empty? @log))
         (run-next-idle! queue)
         (t/is (= [:b] @log))
         (t/is (empty? (:values @(:seen turn-a))))
         (t/is (= [nil] (:values @(:seen turn-b)))))))))

(t/deftest ^:async disposed-middle-turn-keeps-the-order
  (reset-turn-chain!)
  (let [queue     (atom [])
        log       (atom [])
        deadlines (atom [])]
    (await
     (mock/with-mocks*
       {timers/schedule-on-idle  (idle-fake queue)
        timers/schedule          (deadline-fake deadlines)
        wasm.api/render-pending? (fn [] false)}
       (let [turn-a (subscribe-turn :a log)
             turn-b (subscribe-turn :b log)
             turn-c (subscribe-turn :c log)]
         (await (async/wait-for #(= 1 (count @queue)) "turn A queued"))
         (await (async/settle))
         ;; Dispose B before its turn: B and C both wait for A, so only A has
         ;; an idle callback. Disposing B must not start C early.
         (rx/dispose! (:sub turn-b))
         (await (async/settle))
         (t/is (= 1 (count @queue)))
         (run-next-idle! queue)
         (t/is (= [:a] @log))
         ;; C is granted its turn after A, and B never emits.
         (await (async/wait-for #(= 1 (count @queue)) "turn C queued"))
         (t/is (empty? (:values @(:seen turn-b))))
         (run-next-idle! queue)
         (t/is (= [:a :c] @log))
         (t/is (= [nil] (:values @(:seen turn-c)))))))))

(t/deftest ^:async deadline-grants-the-turn-while-a-render-is-pending
  (reset-turn-chain!)
  (let [queue     (atom [])
        deadlines (atom [])
        log       (atom [])]
    (await
     (mock/with-mocks*
       {timers/schedule-on-idle  (idle-fake queue)
        timers/schedule          (deadline-fake deadlines)
        wasm.api/render-pending? (fn [] true)}
       (let [turn (subscribe-turn :turn log)]
         (await (async/wait-for #(= 1 (count @queue)) "turn callback queued"))
         (await (async/wait-for #(= 1 (count @deadlines)) "turn deadline queued"))
         ;; Canvas render still pending: the idle callback only re-queues itself.
         (run-next-idle! queue)
         (t/is (empty? (:values @(:seen turn))))
         (t/is (= 1 (count @queue)))
         ;; The deadline grants the turn whatever render-pending? says.
         (run-next-deadline! deadlines)
         (t/is (= [nil] (:values @(:seen turn))))
         (t/is (true? (:completed? @(:seen turn))))
         (t/is (= 0 (count @queue)))
         (t/is (= 0 (count @deadlines))))))))

(t/deftest ^:async grant-disposes-the-deadline
  (reset-turn-chain!)
  (let [queue     (atom [])
        deadlines (atom [])
        log       (atom [])]
    (await
     (mock/with-mocks*
       {timers/schedule-on-idle  (idle-fake queue)
        timers/schedule          (deadline-fake deadlines)
        wasm.api/render-pending? (fn [] false)}
       (let [turn (subscribe-turn :turn log)]
         (await (async/wait-for #(= 1 (count @queue)) "turn callback queued"))
         (await (async/wait-for #(= 1 (count @deadlines)) "turn deadline queued"))
         (run-next-idle! queue)
         (t/is (= [nil] (:values @(:seen turn))))
         (t/is (true? (:completed? @(:seen turn))))
         ;; The grant disposes the deadline: its entry leaves the queue.
         (t/is (= 0 (count @deadlines))))))))

(t/deftest ^:async turn-deadline-is-3000-ms
  (reset-turn-chain!)
  (let [queue     (atom [])
        deadlines (atom [])
        log       (atom [])]
    (await
     (mock/with-mocks*
       {timers/schedule-on-idle  (idle-fake queue)
        timers/schedule          (deadline-fake deadlines)
        wasm.api/render-pending? (fn [] true)}
       (let [turn (subscribe-turn :turn log)]
         (await (async/wait-for #(= 1 (count @deadlines)) "turn deadline queued"))
         (let [[ms _] (first @deadlines)]
           (t/is (= 3000 ms)))
         ;; Disposing the turn cancels both tasks, so nothing leaks into later tests.
         (rx/dispose! (:sub turn)))))))
