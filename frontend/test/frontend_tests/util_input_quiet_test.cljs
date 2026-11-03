;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.util-input-quiet-test
  (:require
   [app.main.data.changes :as dch]
   [app.util.input-quiet :as iq]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]))

(t/deftest wait-ms-test
  (t/testing "no input seen yet"
    (t/is (= 0 (iq/wait-ms 1000 nil 2000))))

  (t/testing "input 500 ms ago, pause 2000 ms"
    (t/is (= 1500 (iq/wait-ms 1000 500 2000))))

  (t/testing "input 2500 ms ago, pause 2000 ms"
    (t/is (= 0 (iq/wait-ms 5000 2500 2000))))

  (t/testing "input exactly one pause ago"
    (t/is (= 0 (iq/wait-ms 4000 2000 2000)))))

(defn- fake-schedule
  "Returns a scheduler that records each step fn in `steps`."
  [steps]
  (fn [step]
    (vswap! steps conj step)
    (reify rx/IDisposable
      (-dispose [_] nil))))

(t/deftest warm-up-checks-schedule-test
  (let [steps  (volatile! [])
        cancel (dch/warm-up-checks! (fake-schedule steps))]
    (t/is (fn? cancel))
    (t/is (= 1 (count @steps)))

    ;; Each run of a step schedules the next one, until the four check
    ;; fns have run.
    (dotimes [i 3]
      ((nth @steps i))
      (t/is (= (+ i 2) (count @steps))))

    ((nth @steps 3))
    (t/is (= 4 (count @steps)))))

(t/deftest warm-up-checks-cancel-test
  (let [steps  (volatile! [])
        cancel (dch/warm-up-checks! (fake-schedule steps))]
    (t/is (= 1 (count @steps)))

    (cancel)
    ((first @steps))
    (t/is (= 1 (count @steps)))))
