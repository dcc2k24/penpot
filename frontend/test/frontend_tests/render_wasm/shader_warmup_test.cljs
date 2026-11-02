;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.render-wasm.shader-warmup-test
  "The shader warm-up waits for a pause in user input."
  (:require
   [app.common.render-wasm.wasm :as wasm]
   [app.render-wasm.api :as api]
   [app.util.timers :as timers]
   [cljs.test :as t :include-macros true]))

(def ^:private wait-ms #'api/shader-warmup-input-wait-ms)
(def ^:private schedule-step! #'api/schedule-shader-warmup-step!)
(def ^:private epoch #'api/shader-warmup-epoch*)
(def ^:private last-input #'api/shader-warmup-last-input*)

(t/deftest no-input-yet-lets-a-step-run
  (t/is (= 0 (wait-ms 5000 nil))))

(t/deftest recent-input-delays-the-step-until-the-pause
  (t/is (= 2000 (wait-ms 1000 1000)))
  (t/is (= 1500 (wait-ms 1500 1000)))
  (t/is (= 1 (wait-ms 2999 1000))))

(t/deftest an-old-input-lets-a-step-run
  (t/is (= 0 (wait-ms 3000 1000)))
  (t/is (= 0 (wait-ms 60000 1000))))

(t/deftest input-is-recorded
  (let [last-input #'api/shader-warmup-last-input*]
    (reset! @last-input nil)
    (#'api/note-shader-warmup-input! nil)
    (t/is (number? @@last-input))
    (t/is (pos? (wait-ms (js/performance.now) @@last-input)))
    (reset! @last-input nil)))

(defn- restore-property!
  "Sets property `k` of `target` back to `saved`, or removes it when undefined."
  [target k saved]
  (if (undefined? saved)
    (js-delete target k)
    (unchecked-set target k saved)))

(defn- with-fake-env
  "Calls `f` with a map of :idle (queued idle callbacks), :steps (warm-up steps
  run) and :timers (scheduled [ms fn] pairs). Idle callbacks run only when a
  test drains them. Restores every global and the WASM export afterwards."
  [f]
  (let [idle          (atom [])
        steps         (atom [])
        scheduled     (atom [])
        saved-request (unchecked-get js/globalThis "requestIdleCallback")
        saved-cancel  (unchecked-get js/globalThis "cancelIdleCallback")
        saved-warm-up (unchecked-get wasm/internal-module "_warm_up_shaders")
        fake-step     (fn [step]
                        (swap! steps conj step)
                        (if (< step 2) (inc step) 0))]
    (unchecked-set js/globalThis "requestIdleCallback"
                   (fn [cb]
                     (swap! idle conj cb)
                     (count @idle)))
    (unchecked-set js/globalThis "cancelIdleCallback" (fn [_] nil))
    (unchecked-set wasm/internal-module "_warm_up_shaders" fake-step)
    (reset! @last-input nil)
    (try
      (with-redefs [api/shader-warmup-busy? (constantly false)
                    ;; Multi-arity: `api` calls the arity-2 entry point.
                    timers/schedule         (fn
                                              ([g] (swap! scheduled conj [0 g]) nil)
                                              ([ms g] (swap! scheduled conj [ms g]) nil))]
        (f {:idle idle :steps steps :timers scheduled}))
      (finally
        (restore-property! js/globalThis "requestIdleCallback" saved-request)
        (restore-property! js/globalThis "cancelIdleCallback" saved-cancel)
        (restore-property! wasm/internal-module "_warm_up_shaders" saved-warm-up)
        (reset! @last-input nil)))))

(defn- drain-idle!
  "Runs queued idle callbacks, oldest first, until none are left (at most 100)."
  [idle]
  (loop [n 0]
    (when (and (seq @idle) (< n 100))
      (let [cb (first @idle)]
        (swap! idle #(vec (rest %)))
        (cb #js {:timeRemaining (fn [] 50)})
        (recur (inc n))))))

(t/deftest steps-run-in-idle-time-without-input
  (with-fake-env
    (fn [{:keys [idle steps] scheduled :timers}]
      (schedule-step! @@epoch 0)
      (drain-idle! idle)
      (t/is (= [0 1 2] @steps))
      (t/is (empty? @scheduled)))))

(t/deftest recent-input-waits-for-a-pause-then-runs
  (with-fake-env
    (fn [{:keys [idle steps] scheduled :timers}]
      (#'api/note-shader-warmup-input! nil)
      (schedule-step! @@epoch 0)
      (t/is (empty? @steps))
      (t/is (empty? @idle))
      (t/is (= 1 (count @scheduled)))
      (let [[ms _] (first @scheduled)]
        (t/is (> ms 0))
        (t/is (<= ms 2000)))
      (reset! @last-input (- (js/performance.now) 5000))
      ((second (first @scheduled)))
      (drain-idle! idle)
      (t/is (= [0 1 2] @steps)))))

(t/deftest input-before-the-idle-callback-defers-the-step
  (with-fake-env
    (fn [{:keys [idle steps] scheduled :timers}]
      (schedule-step! @@epoch 0)
      (t/is (= 1 (count @idle)))
      (#'api/note-shader-warmup-input! nil)
      (drain-idle! idle)
      (t/is (empty? @steps))
      (t/is (= 1 (count @scheduled))))))

(t/deftest a-cancelled-warm-up-ignores-its-pending-timer
  (with-fake-env
    (fn [{:keys [idle steps] scheduled :timers}]
      (#'api/note-shader-warmup-input! nil)
      (schedule-step! @@epoch 0)
      (t/is (= 1 (count @scheduled)))
      (swap! @epoch inc)
      (reset! @last-input (- (js/performance.now) 5000))
      ((second (first @scheduled)))
      (drain-idle! idle)
      (t/is (empty? @steps))
      (t/is (empty? @idle)))))

(t/deftest a-busy-renderer-defers-the-step
  (with-fake-env
    (fn [{:keys [idle steps]}]
      (with-redefs [api/shader-warmup-busy? (constantly true)]
        (schedule-step! @@epoch 0)
        (let [cb (first @idle)]
          (swap! idle #(vec (rest %)))
          (cb #js {:timeRemaining (fn [] 50)}))
        (t/is (empty? @steps))
        (t/is (= 1 (count @idle)))))))
