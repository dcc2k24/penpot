;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.util.input-quiet
  (:require
   [app.common.math :as mth]
   [app.util.timers :as tm]
   [beicon.v2.core :as rx]))

;; Input pause that deferred background work waits for.
(def quiet-ms 2000)

(def ^:private input-events
  #js ["pointerdown" "pointermove" "keydown" "wheel"])

;; `performance.now()` of the last input seen, nil before any.
(defonce ^:private last-input* (atom nil))

(defonce ^:private listening?* (atom false))

(defn- note-input
  [_]
  (reset! last-input* (js/performance.now)))

;; Stable identity, so the same listener is used for the page lifetime.
(defonce ^:private input-listener
  (fn [event] (note-input event)))

(defn wait-ms
  "Returns the milliseconds left before input has been quiet for
  `pause-ms`, given the time `now` and the time of the last input
  `last-input` (nil when none). Returns 0 when input is already quiet."
  [now last-input pause-ms]
  (if (nil? last-input)
    0
    (mth/max 0 (- (+ last-input pause-ms) now))))

(defn- ensure-listening
  []
  (when (and (exists? js/document) (not @listening?*))
    (doseq [event input-events]
      (.addEventListener js/document event input-listener
                         #js {:capture true :passive true}))
    (reset! listening?* true)
    ;; Input before this point is unknown, so the first wait counts
    ;; from now.
    (reset! last-input* (js/performance.now))))

(defn schedule-on-idle-after-input
  "Runs `f` in a browser idle period once user input has paused for
  `quiet-ms`. Re-checks the pause when the idle period comes, since input
  may arrive meanwhile. Returns a disposable that cancels it."
  [f]
  (ensure-listening)
  (let [task      (volatile! nil)
        disposed? (volatile! false)
        step      (fn step []
                    (when-not @disposed?
                      (let [wait (wait-ms (js/performance.now) @last-input* quiet-ms)]
                        (if (pos? wait)
                          (vreset! task (tm/schedule wait step))
                          (vreset! task
                                   (tm/schedule-on-idle
                                    (fn []
                                      (when-not @disposed?
                                        (if (pos? (wait-ms (js/performance.now) @last-input* quiet-ms))
                                          (step)
                                          (f))))))))))]
    (step)
    (reify rx/IDisposable
      (-dispose [_]
        (vreset! disposed? true)
        (some-> @task rx/dispose!)))))
