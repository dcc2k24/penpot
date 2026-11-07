;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.http-errors-conflict-test
  (:require
   [app.common.exceptions :as ex]
   [app.http.errors :as errors]
   [clojure.test :as t]
   [yetti.response :as yres]))

(t/deftest conflict-response-strips-internal-fields
  (let [cause (try
                (ex/raise :type :conflict
                          :code :revn-conflict
                          :hint "stale revision"
                          :state {:secret "internal"}
                          :path [:file :data])
                (catch Exception e e))
        reply (errors/handle-error cause nil nil)
        body  (::yres/body reply)]
    (t/is (= 409 (::yres/status reply)))
    (t/is (= :conflict (:type body)))
    (t/is (= :revn-conflict (:code body)))
    (t/is (not (contains? body :state)))
    (t/is (not (contains? body :path)))))
